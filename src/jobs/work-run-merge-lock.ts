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
 * The lock is an in-process FIFO resource lease keyed on
 * `<repoId>:<baseBranch>`. It guards only Rune's OWN finalize sequence; the
 * `/work` child is a separate actor.
 * Because Rune is a single local daemon (the single-writer assumption), an
 * in-process mutex is sufficient — there is no second Rune process contending
 * for the same `main`.
 *
 * The same single-writer assumption is documented in
 * `src/jobs/supervision-store.ts` (one Rune process per machine is the v1
 * trust model).
 *
 * The repository identity and contention contract is pinned by
 * `work-run-merge-lock.test.ts` (test-plan §6 "Concurrency + durability").
 */

import { execFile as execFileCb } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { createLogger } from '../utils/logger.js';
import {
  createResourceLeaseScheduler,
  type LeaseParty,
  type LeaseSnapshot,
} from './resource-lease.js';

const execFile = promisify(execFileCb);
const log = createLogger('work-run-merge-lock');
const baseBranchLeases = createResourceLeaseScheduler();
let anonymousLeaseSequence = 0;

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

export interface BaseBranchLeaseOptions {
  holder: LeaseParty;
  signal?: AbortSignal;
  waitTimeoutMs?: number;
}

/** Read-only process-local state for the canonical base-branch lease. */
export function baseBranchLeaseSnapshot(
  repoId: string,
  baseBranch: string,
): LeaseSnapshot | undefined {
  return baseBranchLeases.snapshot('base-branch', baseBranchLockKey(repoId, baseBranch));
}

/**
 * Run `fn` exclusively for the `<repoId>:<baseBranch>` lock: it starts only
 * after the previously-queued finalize for the same repository+base branch has
 * settled. Different keys never block each other, and the lock is released even
 * when `fn` throws (so one failed finalize never deadlocks the next run on that
 * base branch).
 *
 * Existing callers may omit lease identity until lifecycle integration supplies
 * their run cancellation context. The generated identity remains unique and
 * observable in the meantime.
 */
export function withBaseBranchLock<T>(
  repoId: string,
  baseBranch: string,
  fn: () => Promise<T> | T,
  options?: BaseBranchLeaseOptions,
): Promise<T> {
  const holder = options?.holder ?? {
    runId: 'base-branch',
    operationId: `anonymous-${++anonymousLeaseSequence}`,
  };
  return baseBranchLeases.withLease(
    {
      type: 'base-branch',
      key: baseBranchLockKey(repoId, baseBranch),
      holder,
      signal: options?.signal ?? new AbortController().signal,
      ...(options?.waitTimeoutMs !== undefined
        ? { waitTimeoutMs: options.waitTimeoutMs }
        : {}),
    },
    fn,
  );
}
