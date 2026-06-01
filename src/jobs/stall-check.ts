/**
 * Periodic stall check — every 30s, scan the persisted SupervisedRuns for
 * entries that have gone quiet past the stall threshold and emit a Telegram
 * nudge for **newly** stalled ones. A stall that's already been nudged is
 * tracked in-process so subsequent ticks don't spam the user; if the run
 * recovers (fresh heartbeat) or terminates, it's removed from the tracking
 * set so a future re-stall re-fires.
 *
 * Module split: `checkStalledRuns` is the pure core (deps injected) tested
 * in `stall-check.test.ts`; `startStallCheck` / `stopStallCheck` are the
 * setInterval glue called from `src/index.ts`.
 *
 * See spec.md §"Layer 3", tasks.md Phase 6 A2.4.
 */

import { getVisibility, type SupervisedRun } from '../intent/supervision.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('stall-check');

export const TICK_INTERVAL_MS = 30 * 1000;
export const STALL_THRESHOLD_MS = 5 * 60 * 1000; // 5min — well above the 30s heartbeat throttle
/** Quiet-run threshold (project 11, requirement 23): a run producing no `output`
 *  for this long gets a one-time quiet nudge. Same 5min as the stall threshold,
 *  but measured on `lastOutputAt` (LLM activity), distinct from child liveness. */
export const QUIET_THRESHOLD_MS = 5 * 60 * 1000;

export interface CheckStalledRunsDeps {
  /** Read the current persisted SupervisedRun[]. Tests inject a fixture
   *  reader; production uses `readAllRuns(config.SUPERVISED_RUNS_FILE)`. */
  readRuns: () => SupervisedRun[];
  /** Epoch ms — `Date.now()` in production; fixed in tests. */
  now: number;
  /** Stall threshold passed to `getVisibility`. */
  stallThresholdMs: number;
  /** Set of run ids already nudged in a prior pass. Mutated in-process; this
   *  function returns the next-tick set so callers can swap atomically. */
  alreadyNudged: Set<string>;
  /** Callback invoked for each newly-stalled run. Production wraps a
   *  Telegram bus publish; tests use a vi.fn(). Failures here are caught
   *  so one bad send doesn't skip the rest of the pass. */
  sendNudge: (run: SupervisedRun) => void;
}

/**
 * Pure check core. Returns the new "already-nudged" set for the next tick:
 *
 * - A run that is still-stalled and already in the set stays in the set.
 * - A newly-stalled run is added (and `sendNudge` is invoked).
 * - A run that's no longer stalled (recovered or terminated) is removed,
 *   so a future re-stall triggers a fresh nudge.
 *
 * Defensive: a `readRuns` throw returns `alreadyNudged` unchanged; a
 * `sendNudge` throw is caught per-run so the rest of the pass continues
 * and the id is still tracked (avoids storms of retries on a transient
 * send failure).
 */
export function checkStalledRuns(deps: CheckStalledRunsDeps): Set<string> {
  let runs: SupervisedRun[];
  try {
    runs = deps.readRuns();
  } catch (err) {
    log.warn('checkStalledRuns: readRuns failed; preserving nudged set', {
      error: (err as Error).message,
    });
    return deps.alreadyNudged;
  }

  const visibility = getVisibility(runs, deps.stallThresholdMs, deps.now);
  const stalledIds = new Set(visibility.stalled.map((r) => r.id));

  const next = new Set<string>();
  // Carry forward any id that's still stalled.
  for (const id of deps.alreadyNudged) {
    if (stalledIds.has(id)) next.add(id);
  }

  // Fire nudges for newly-stalled runs.
  for (const run of visibility.stalled) {
    if (next.has(run.id)) continue; // already nudged + still stalled — skip
    try {
      deps.sendNudge(run);
    } catch (err) {
      log.warn('checkStalledRuns: sendNudge failed', {
        runId: run.id,
        error: (err as Error).message,
      });
    }
    // Track the id even if sendNudge threw — re-trying every 30s would
    // make a transient failure into a recurring annoyance.
    next.add(run.id);
  }

  return next;
}

/**
 * Format a stalled-run nudge as a short Telegram-friendly string. Kept
 * deliberately minimal — the operator wants to know what stalled, not a
 * full status dump. Exported so the timer-glue module can build the
 * Telegram message without duplicating the format rule.
 */
export function formatStallNudge(run: SupervisedRun, now: number): string {
  const rawAge = now - new Date(run.lastHeartbeatAt).getTime();
  // A corrupt or unparseable lastHeartbeatAt reaches here because isStalled
  // treats it as stalled (fail toward visibility). Guard against NaN in the
  // user-visible string.
  const ageLabel = Number.isFinite(rawAge) ? `${Math.round(rawAge / 60_000)}min` : '?';
  return (
    `⚠️ Run stalled: ${run.product}/${run.project} ` +
    `(no heartbeat for ${ageLabel}). id=${run.id.slice(0, 8)}`
  );
}

/**
 * Format a quiet-run nudge — a run that is alive but producing no LLM output.
 * Distinct wording from {@link formatStallNudge} so the operator can tell a
 * child-dead stall ("stalled") from a quiet-but-alive run ("quiet").
 *
 * SCAFFOLD: pinned test-first; body lands in the Phase 4 implementation task.
 */
export function formatQuietNudge(_run: SupervisedRun, _now: number): string {
  throw new Error('stall-check: formatQuietNudge not implemented (project 11 Phase 4 pending)');
}
