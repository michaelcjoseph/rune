/**
 * Supervision startup recovery — walk every persisted SupervisedRun and apply
 * `recoverRun` (flipping stale `'running'` entries to `'unknown'` since they
 * can't be observed across a Jarvis restart). Mirrors `reconcileOrphans()`
 * in `mutations-log.ts` for the supervision store.
 *
 * Idempotent: terminal entries (`completed` / `failed`) and durable states
 * (`blocked-on-human`, `unknown`) are unchanged. Skips the disk write when
 * no entry transitioned to avoid needless I/O on a clean boot.
 *
 * Called from `src/index.ts` at startup, paired with `reconcileOrphans`.
 *
 * See spec.md §"Layer 3", tasks.md Phase 6 A2.3.
 */

import { recoverRun } from '../intent/supervision.js';
import type { SupervisedRun } from '../intent/supervision.js';
import { readAllRuns, writeAllRuns } from './supervision-store.js';
import type { FinalizerSupervisionStatus } from './work-run-finalizer.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('supervision-recovery');

function notImplemented(fn: string): never {
  throw new Error(`supervision-recovery: ${fn} not implemented (project 15 Phase 1 P0.4 pending)`);
}

export interface RecoveryResult {
  /** Number of runs whose status was changed by `recoverRun` (today: the
   *  count of `'running'` entries that became `'unknown'`). */
  transitioned: number;
  /** Total number of persisted runs walked. */
  total: number;
}

/**
 * Run the startup recovery pass. Reads `filePath`, applies `recoverRun` to
 * each entry, and writes the result back if anything actually changed.
 * A missing file is treated as an empty store — returns `{0, 0}` with no
 * throw, so a fresh install or a wiped log dir doesn't gate startup.
 */
export function recoverSupervisedRuns(filePath: string): RecoveryResult {
  const runs = readAllRuns(filePath);
  if (runs.length === 0) return { transitioned: 0, total: 0 };

  let transitioned = 0;
  const next = runs.map((run) => {
    const recovered = recoverRun(run);
    if (recovered.status !== run.status) transitioned++;
    return recovered;
  });

  // Safe only because recoverRun is identity except for 'running' → 'unknown'.
  // If it's ever extended to mutate other fields, this guard becomes too
  // aggressive and needs to compare more than just status.
  if (transitioned === 0) {
    return { transitioned: 0, total: runs.length };
  }

  writeAllRuns(next, filePath);
  log.info('Recovered supervised runs', { transitioned, total: runs.length, path: filePath });

  return { transitioned, total: runs.length };
}

// ---------------------------------------------------------------------------
// P0.4 (project 15) — recovery FINALIZES stale runs instead of only relabeling.
// SCAFFOLD (test-first): `recoverAndFinalizeStaleRuns` throws until P0.4 fills
// it in; pinned by supervision-recovery.test.ts (test-plan §4 "Startup
// recovery"). Wired into index.ts (awaited) BEFORE the orphan-worktree sweep
// (index.ts:84) so the sweep cannot race away the worktree the finalizer needs.
// ---------------------------------------------------------------------------

export interface RecoverAndFinalizeDeps {
  /** Read all persisted supervised runs (prod: `() => readAllRuns(filePath)`). */
  readRuns: () => SupervisedRun[];
  /** Persist the updated runs (prod: `(runs) => writeAllRuns(runs, filePath)`). */
  writeRuns: (runs: SupervisedRun[]) => void;
  /**
   * Drive ONE stale `running` run through the finalizer in HOLD mode: compute
   * work product over its (still-present) worktree → classify → terminal writes,
   * NO merge/push. Returns the terminal supervision status the run reached.
   * Called only for `running` entries; never for terminal/blocked/unknown ones.
   *
   * MAY reject (git failure, worktree gone). A rejection is isolated per run —
   * the run is counted in `failedToFinalize` and left as-is, and the remaining
   * stale runs are still finalized (a single bad run never aborts the pass).
   */
  finalizeStaleRun: (run: SupervisedRun) => Promise<FinalizerSupervisionStatus>;
}

export interface RecoverFinalizeResult {
  /** Stale `running` runs driven to a real terminal state via the finalizer. */
  finalized: number;
  /** Stale `running` runs whose `finalizeStaleRun` rejected — left untouched,
   *  logged, but did NOT abort the pass (per-run fault isolation). */
  failedToFinalize: number;
  /** Total persisted runs walked. */
  total: number;
}

/**
 * Startup recovery that FINALIZES stale runs rather than only relabeling them
 * `unknown`: for each persisted `running` run, drive it through the finalizer in
 * HOLD mode so it reaches a correct terminal state (classified on work product),
 * with the worktree still intact. Awaited in `index.ts` BEFORE the
 * orphan-worktree sweep so the sweep can't delete a worktree mid-finalize.
 *
 * Stale runs are finalized SERIALLY (one at a time) — startup is not
 * perf-critical, and serial keeps the worktree lifecycle simple. A per-run
 * `finalizeStaleRun` rejection is isolated (counted, logged, run left as-is) so
 * one bad run never strands the rest as `running` for the sweep to delete.
 *
 * WIRING OBLIGATION (P0.4): when this replaces the sync `recoverSupervisedRuns`
 * call in index.ts, that old call MUST be removed — left in place it would flip
 * `running` → `unknown` first, pre-empting the finalizer's classification.
 * SCAFFOLD — throws until P0.4.
 */
export async function recoverAndFinalizeStaleRuns(
  _deps: RecoverAndFinalizeDeps,
): Promise<RecoverFinalizeResult> {
  return notImplemented('recoverAndFinalizeStaleRuns');
}
