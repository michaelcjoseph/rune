/**
 * Supervision startup recovery — walk every persisted SupervisedRun and apply
 * `recoverRun` (flipping stale `'running'` entries to `'unknown'` since they
 * can't be observed across a Rune restart). Mirrors `reconcileOrphans()`
 * in `mutations-log.ts` for the supervision store.
 *
 * Idempotent: terminal entries (`completed` / `failed`) and durable statuses
 * (`blocked-on-human`, `unknown`) are unchanged, while stale process-local
 * lease diagnostics are removed from every status. Skips the disk write when
 * neither a status nor waiting metadata changed.
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
  let clearedWaiting = 0;
  const next = runs.map((run) => {
    let recovered = recoverRun(run);
    if (recovered.status !== run.status) transitioned++;
    // Lease ownership is process-local, so no persisted waiter can remain
    // authoritative at process start. This also covers parked release runs,
    // which may have queued while their durable status stayed blocked-on-human.
    if (recovered.waitingOn !== undefined) {
      recovered = { ...recovered };
      delete recovered.waitingOn;
      clearedWaiting++;
    }
    return recovered;
  });

  if (transitioned === 0 && clearedWaiting === 0) {
    return { transitioned: 0, total: runs.length };
  }

  writeAllRuns(next, filePath);
  log.info('Recovered supervised runs', {
    transitioned,
    clearedWaiting,
    total: runs.length,
    path: filePath,
  });

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
  /** Clear only durable lease diagnostics without replacing newer run fields. */
  writeRunLeaseState: (run: SupervisedRun) => void;
  /** Release any process-local lease state after this run's recovery attempt. */
  releaseRunLease: (runId: string) => void;
  /** Status-less Phase 1 action report; the blocked status union lands separately. */
  reportBlockedEnvironment: (input: {
    runId: string;
    resource: NonNullable<SupervisedRun['waitingOn']>['resource'];
    remediation: string;
  }) => void;
  /**
   * Drive ONE stale `running` run through the finalizer in HOLD mode: compute
   * work product over its (still-present) worktree → classify → terminal writes,
   * NO merge/push. Returns the terminal supervision status the run reached.
   * Called only for `running` entries; never for terminal/blocked/unknown ones.
   *
   * MAY reject (git failure, worktree gone). A rejection is isolated per run —
   * the run is counted in `failedToFinalize`; stale lease diagnostics are
   * cleared and reported for remediation, and the remaining runs continue.
   */
  finalizeStaleRun: (run: SupervisedRun) => Promise<FinalizerSupervisionStatus>;
}

export interface RecoverFinalizeResult {
  /** Stale `running` runs driven to a real terminal state via the finalizer. */
  finalized: number;
  /** Stale `running` runs whose `finalizeStaleRun` rejected — logged, with any
   * stale waiting metadata cleared, but without aborting the recovery pass. */
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
 * `finalizeStaleRun` rejection is isolated (counted and logged, with stale
 * waiting state cleared) so
 * one bad run never strands the rest as `running` for the sweep to delete.
 *
 * WIRING (P0.4, index.ts): this is awaited via `runRecoveryFinalize()` FIRST,
 * then the legacy `recoverSupervisedRuns` runs as the fallback. Order matters —
 * this only mutates the runs it successfully finalizes (to `completed`/`failed`),
 * so the subsequent `recoverSupervisedRuns` flips only the runs that COULDN'T be
 * finalized (still `running`) to `unknown`. Running the legacy call first would
 * pre-empt the finalizer by flipping `running` → `unknown` before classification,
 * so the finalize MUST precede it.
 */
export async function recoverAndFinalizeStaleRuns(
  deps: RecoverAndFinalizeDeps,
): Promise<RecoverFinalizeResult> {
  const runs = deps.readRuns();
  const next = [...runs];
  let finalized = 0;
  let failedToFinalize = 0;

  // Persisted waiters retain their pre-restart FIFO order. Ownership itself is
  // never restored from disk: each finalizer below submits a fresh lease
  // acquisition through the process-local scheduler.
  const processingOrder = next.map((run, index) => ({ run, index })).sort((a, b) => {
    const aWait = a.run.waitingOn?.waitingSince;
    const bWait = b.run.waitingOn?.waitingSince;
    if (aWait === undefined && bWait === undefined) return a.index - b.index;
    if (aWait === undefined) return 1;
    if (bWait === undefined) return -1;
    const aTime = Date.parse(aWait);
    const bTime = Date.parse(bWait);
    if (Number.isNaN(aTime) && Number.isNaN(bTime)) return a.index - b.index;
    if (Number.isNaN(aTime)) return 1;
    if (Number.isNaN(bTime)) return -1;
    return aTime - bTime || a.index - b.index;
  });

  // Serial — one worktree finalized at a time (startup is not perf-critical and
  // serial keeps the worktree lifecycle simple). Per-run fault isolation: a
  // single rejecting run is counted and left as-is, never aborting the rest.
  for (const { run, index } of processingOrder) {
    if (run.status !== 'running') continue;
    try {
      const status = await deps.finalizeStaleRun(run);
      const terminal = { ...run, status };
      delete terminal.waitingOn;
      next[index] = terminal;
      finalized++;
    } catch (err) {
      failedToFinalize++;
      if (run.waitingOn) {
        const cleared = { ...run };
        delete cleared.waitingOn;
        next[index] = cleared;
        try {
          deps.writeRunLeaseState(cleared);
        } catch (writeErr) {
          log.warn('recoverAndFinalizeStaleRuns: failed to clear stale lease metadata', {
            id: run.id,
            error: (writeErr as Error).message,
          });
        }
        deps.reportBlockedEnvironment({
          runId: run.id,
          resource: { ...run.waitingOn.resource },
          remediation: `Verify the ${run.waitingOn.resource.type.replaceAll('-', ' ')} resource exists, then retry the run.`,
        });
      }
      log.warn('recoverAndFinalizeStaleRuns: finalize failed; leaving run for the unknown-relabel fallback', {
        id: run.id,
        error: (err as Error).message,
      });
    } finally {
      deps.releaseRunLease(run.id);
    }
  }

  // Persist only when a run actually transitioned (failed runs are unchanged).
  if (finalized > 0) {
    deps.writeRuns(next);
    log.info('Recovered + finalized stale supervised runs', { finalized, failedToFinalize, total: runs.length });
  }

  return { finalized, failedToFinalize, total: runs.length };
}
