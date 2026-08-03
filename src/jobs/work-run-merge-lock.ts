/**
 * Per-repository / per-base-branch merge lock (project 15, P1.5) — the serialization
 * primitive the gated-merge finalizer holds while it mutates a shared base branch.
 *
 * WHY per-repository/per-base-branch and NOT per-product: different products can
 * share a single repository and `main` (`config.ts` allows concurrent runs, and the
 * supervision store assumes a single writer). If two `branch-complete`
 * finalizers for two projects in the SAME repository both ran their
 * merge → push → branch-delete sequence against that one `main` at once, they
 * would race the working tree / ref and corrupt each other's merge. A per-project
 * lock would not prevent this — the lock MUST key on the base branch they share.
 *
 * The lock is an in-process async mutex keyed on `<repoId>:<baseBranch>` (the
 * same shape as `withFileLock` in src/intent/backlog-write-lock.ts). It guards
 * only Rune's OWN finalize sequence; the `/work` child is a separate actor.
 * Because Rune is a single local daemon (the single-writer assumption), an
 * in-process mutex is sufficient — there is no second Rune process contending
 * for the same `main`.
 *
 * The same single-writer assumption is documented in
 * `src/jobs/supervision-store.ts` (one Rune process per machine is the v1
 * trust model).
 *
 * IMPL NOTE (P1.5): do NOT re-implement the tail-chaining queue — reuse the
 * existing `withFileLock` mutex in `src/intent/backlog-write-lock.ts` (already
 * imported by `src/jobs/scaffold-approval.ts`, so the jobs→intent crossing is
 * in-tree), which already handles lock-table pruning and release-on-throw. Keep
 * the lock domain separate from the backlog file-path keys (delegate with a
 * `merge:`-prefixed key, or a module-local locks Map) so a repository id can
 * never collide with a backlog file path. `withBaseBranchLock` then becomes a
 * thin wrapper: `withFileLock(baseBranchLockKey(repoId, baseBranch), fn)`.
 *
 * The repository identity and contention contract is pinned by
 * `work-run-merge-lock.test.ts` (test-plan §6 "Concurrency + durability").
 */

import { execFile as execFileCb } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { withFileLock } from '../intent/backlog-write-lock.js';
import { createLogger } from '../utils/logger.js';

const execFile = promisify(execFileCb);
const log = createLogger('work-run-merge-lock');

type BaseBranchRunHandle = {
  descriptor: {
    id: string;
    kind: string;
    status: string;
    payload: unknown;
  };
};

export interface BaseBranchTarget {
  repoPath: string;
  baseBranch: string;
}

/**
 * Resolve the stable identity shared by every checkout and worktree belonging
 * to one repository. A non-git directory still receives a deterministic local
 * identity, which keeps callers fail-safe while repositories are being
 * initialized or repaired.
 */
export async function canonicalRepoId(repoPath: string): Promise<string> {
  try {
    const { stdout } = await execFile('git', ['rev-parse', '--git-common-dir'], {
      cwd: repoPath,
      encoding: 'utf8',
      timeout: 30_000,
    });
    const commonDir = stdout.trim();
    if (commonDir) return await realpath(resolve(repoPath, commonDir));
    log.warn('canonical repository identity degraded: git common directory was empty', {
      repoPath,
    });
  } catch (err) {
    log.warn('canonical repository identity degraded: git common directory unavailable', {
      repoPath,
      error: (err as Error).message,
    });
  }

  try {
    return await realpath(repoPath);
  } catch (err) {
    const fallback = resolve(repoPath);
    log.warn('canonical repository identity degraded: repository path cannot be realpathed', {
      repoPath,
      fallback,
      error: (err as Error).message,
    });
    return fallback;
  }
}

/**
 * Whether another live run can mutate the same repository base branch.
 * Product labels are resolved at the edge because multiple products may point
 * at one repository (and a product path may itself be a linked worktree).
 */
export async function hasConcurrentBaseBranchRun(
  runs: Iterable<BaseBranchRunHandle>,
  currentRunId: string,
  repoId: string,
  baseBranch: string,
  includedKinds: ReadonlySet<string>,
  resolveTarget: (product: string) => BaseBranchTarget,
): Promise<boolean> {
  for (const handle of runs) {
    const { descriptor } = handle;
    if (
      descriptor.id === currentRunId ||
      descriptor.status !== 'running' ||
      !includedKinds.has(descriptor.kind)
    ) {
      continue;
    }
    const payload = descriptor.payload as { product?: string };
    const candidateProduct = payload.product ?? 'rune';
    try {
      const target = resolveTarget(candidateProduct);
      if (
        target.baseBranch === baseBranch &&
        await canonicalRepoId(target.repoPath) === repoId
      ) {
        return true;
      }
    } catch (err) {
      // A stale or unreadable candidate cannot safely be proven distinct. Keep
      // the gate HOLD-safe instead of turning the concurrent-run fact into an
      // unrelated exception or allowing a possibly contending merge through.
      log.warn('concurrent base-branch candidate could not be resolved; treating as contending', {
        runId: descriptor.id,
        product: candidateProduct,
        error: (err as Error).message,
      });
      return true;
    }
  }
  return false;
}

/**
 * The lock key for a run landing on `baseBranch` of `repoId`. Per-repository AND
 * per-base-branch: two products in the same repository targeting the same base
 * branch share a key (they serialize); a different base branch (or repository) is a
 * different key (they don't block each other). The `:` delimiter guards against
 * a delimiter-less format letting (`jar`,`vis/main`) collide with
 * (`rune`,`/main`). Takes no project arg — that is the whole point.
 */
export function baseBranchLockKey(repoId: string, baseBranch: string): string {
  return `${repoId}:${baseBranch}`;
}

/**
 * Run `fn` exclusively for the `<repoId>:<baseBranch>` lock: it starts only
 * after the previously-queued finalize for the same repository+base branch has
 * settled. Different keys never block each other, and the lock is released even
 * when `fn` throws (so one failed finalize never deadlocks the next run on that
 * base branch).
 *
 * Delegates to `withFileLock` (the in-process per-key async mutex in
 * `src/intent/backlog-write-lock.ts`, which already prunes the lock table and
 * releases on throw) rather than re-implementing the tail-chaining queue. The
 * key is `merge:`-prefixed so this lock domain can never collide with
 * `withFileLock`'s backlog file-path keys.
 */
export function withBaseBranchLock<T>(
  repoId: string,
  baseBranch: string,
  fn: () => Promise<T> | T,
): Promise<T> {
  return withFileLock(`merge:${baseBranchLockKey(repoId, baseBranch)}`, fn);
}
