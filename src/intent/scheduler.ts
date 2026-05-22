/**
 * Concurrency scheduler — Phase 4 of the intent layer. Autonomous project runs are bounded
 * by two caps: a **global cap** of N concurrent projects across all products, and a
 * **per-product cap of one** — a product never has two of its projects running at once. A
 * project that cannot start under those caps is **queued**, never dropped, and starts when
 * a slot frees.
 *
 * This module is the deterministic core: one pure scheduling pass that, given what is
 * running and what is waiting, decides which queued projects start now and which stay
 * queued. It generalizes the work-runner's `WORK_RUN_GLOBAL_CAP` and tightens its
 * per-project cap into a per-product cap of one — it is not a parallel concurrency model.
 *
 * STATUS: contract stub. The type surface and signature below are the contract pinned by
 * the test-first suite in `scheduler.test.ts` (test-plan.md §15). The function body is
 * intentionally unimplemented — a Phase 4 concurrency task fills it in. Until then the
 * suite is RED by design.
 *
 * See docs/projects/08-intent-layer/{spec.md (§"Concurrency"), test-plan.md (§15)}.
 */

/** A project that is running or wants to run, identified by its product and slug. */
export interface ScheduledProject {
  /** The product the project belongs to. */
  product: string;
  /** The project slug. */
  project: string;
}

/** The outcome of one scheduling pass. */
export interface ScheduleResult {
  /** Queued projects that start now, this pass. */
  started: ScheduledProject[];
  /** Every running project after this pass — the prior running set plus `started`. */
  running: ScheduledProject[];
  /** Projects still waiting — queued in their original order, never dropped. */
  queued: ScheduledProject[];
}

const NOT_IMPLEMENTED =
  'scheduler: not implemented — a Phase 4 concurrency task (docs/projects/08-intent-layer) fills this in';

/**
 * Run one scheduling pass. A queued project starts only when both caps allow it: the global
 * running count is below `globalCap`, and no project for the same product is already
 * running (the per-product cap of one). The `queue` is walked in order, so an earlier
 * queued project takes a freed slot before a later one; whatever cannot start stays in
 * `queued` — an (N+1)th project waits, it is never dropped. `globalCap` must be `>= 1`.
 */
export function schedule(
  _running: ScheduledProject[],
  _queue: ScheduledProject[],
  _globalCap: number,
): ScheduleResult {
  throw new Error(NOT_IMPLEMENTED);
}
