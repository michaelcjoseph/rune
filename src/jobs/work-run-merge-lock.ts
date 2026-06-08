/**
 * Per-product / per-base-branch merge lock (project 15, P1.5) — the serialization
 * primitive the gated-merge finalizer holds while it mutates a shared base branch.
 *
 * WHY per-product/per-base-branch and NOT per-project: different projects in one
 * product share a single `main` (`config.ts` allows concurrent runs, and the
 * supervision store assumes a single writer). If two `branch-complete`
 * finalizers for two projects of the SAME product both ran their
 * merge → push → branch-delete sequence against that one `main` at once, they
 * would race the working tree / ref and corrupt each other's merge. A per-project
 * lock would not prevent this — the lock MUST key on the base branch they share.
 *
 * The lock is an in-process async mutex keyed on `<product>:<baseBranch>` (the
 * same shape as `withFileLock` in src/intent/backlog-write-lock.ts). It guards
 * only Jarvis's OWN finalize sequence; the `/work` child is a separate actor.
 * Because Jarvis is a single local daemon (the single-writer assumption), an
 * in-process mutex is sufficient — there is no second Jarvis process contending
 * for the same `main`.
 *
 * The same single-writer assumption is documented in
 * `src/jobs/supervision-store.ts` (one Jarvis process per machine is the v1
 * trust model).
 *
 * IMPL NOTE (P1.5): do NOT re-implement the tail-chaining queue — reuse the
 * existing `withFileLock` mutex in `src/intent/backlog-write-lock.ts` (already
 * imported by `src/jobs/scaffold-approval.ts`, so the jobs→intent crossing is
 * in-tree), which already handles lock-table pruning and release-on-throw. Keep
 * the lock domain separate from the backlog file-path keys (delegate with a
 * `merge:`-prefixed key, or a module-local locks Map) so a product name can
 * never collide with a backlog file path. `withBaseBranchLock` then becomes a
 * thin wrapper: `withFileLock(baseBranchLockKey(product, baseBranch), fn)`.
 *
 * SCAFFOLD — both exports throw until the P1.5 implementation task
 * ("Per-product / per-base-branch lock"). The contract is pinned test-first by
 * `work-run-merge-lock.test.ts` (test-plan §6 "Concurrency + durability").
 */

import { withFileLock } from '../intent/backlog-write-lock.js';

/**
 * The lock key for a run landing on `baseBranch` of `product`. Per-product AND
 * per-base-branch: two projects of the same product targeting the same base
 * branch share a key (they serialize); a different base branch (or product) is a
 * different key (they don't block each other). The `:` delimiter guards against
 * a delimiter-less format letting (`jar`,`vis/main`) collide with
 * (`jarvis`,`/main`). Takes no project arg — that is the whole point.
 */
export function baseBranchLockKey(product: string, baseBranch: string): string {
  return `${product}:${baseBranch}`;
}

/**
 * Run `fn` exclusively for the `<product>:<baseBranch>` lock: it starts only
 * after the previously-queued finalize for the same product+base branch has
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
  product: string,
  baseBranch: string,
  fn: () => Promise<T> | T,
): Promise<T> {
  return withFileLock(`merge:${baseBranchLockKey(product, baseBranch)}`, fn);
}
