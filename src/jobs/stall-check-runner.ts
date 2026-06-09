/**
 * setInterval glue around `checkStalledRuns` — wires it to `config`,
 * `readAllRuns`, and the Telegram bus. Split from `stall-check.ts` so the
 * pure core stays test-importable without triggering the runtime config
 * bootstrap (which requires TELEGRAM_BOT_TOKEN, VAULT_DIR, …).
 *
 * Called from `src/index.ts` after `startScheduler`; torn down in
 * `shutdown()`.
 */

import config from '../config.js';
import { createLogger } from '../utils/logger.js';
import type { NotificationBus } from '../transport/notification-bus.js';
import { planQuietNudges, planQuietCancel, planMaxRuntimeKills } from '../intent/supervision.js';
import { cancelMutation } from '../transport/mutations.js';
import { readAllRuns, upsertRun } from './supervision-store.js';
import {
  checkStalledRuns,
  formatStallNudge,
  formatQuietNudge,
  QUIET_THRESHOLD_MS,
  STALL_THRESHOLD_MS,
  TICK_INTERVAL_MS,
} from './stall-check.js';

const log = createLogger('stall-check-runner');

let timer: ReturnType<typeof setInterval> | null = null;
let nudged: Set<string> = new Set();

/**
 * Start the periodic stall check. Idempotent — calling twice clears the
 * existing timer first. Timer is unref()'d so it doesn't keep the process
 * alive on shutdown.
 */
export function startStallCheck(bus: NotificationBus): void {
  if (timer) stopStallCheck();
  nudged = new Set();

  const tick = (): void => {
    // `checkStalledRuns` and `bus.publish` both have internal try/catch
    // (the core swallows readRuns + sendNudge throws; the bus wraps each
    // subscriber). This outer guard exists for the unexpected-throw case
    // (OOM, type error in a future refactor) — an uncaught exception from
    // a setInterval callback would otherwise hit process.uncaughtException
    // and crash the server. Better to log and skip a tick.
    try {
      const now = Date.now();
      const runs = readAllRuns(config.SUPERVISED_RUNS_FILE);

      nudged = checkStalledRuns({
        readRuns: () => runs,
        now,
        stallThresholdMs: STALL_THRESHOLD_MS,
        alreadyNudged: nudged,
        sendNudge: (run) => {
          bus.publish({
            kind: 'message',
            userId: config.TELEGRAM_USER_ID,
            text: formatStallNudge(run, now),
          });
        },
      });

      // Quiet-run nudge — evaluated ALONGSIDE the stall check (req 23), on the
      // same snapshot. A child-DEAD run is already handled by the stall path, so
      // exclude the just-nudged stalled set (`nudged` carries every currently-
      // stalled id): a quiet nudge is the "alive but no LLM output" case.
      // Once-only is durable via persisted `quietNudgedAt` (unlike the in-process
      // stall `nudged` set), so it survives ticks AND restarts.
      const quietPlan = planQuietNudges(
        runs.filter((r) => !nudged.has(r.id)),
        QUIET_THRESHOLD_MS,
        now,
      );
      quietPlan.toNudge.forEach((run, i) => {
        // Per-run isolation (mirrors the stall path): a send failure must not
        // skip the rest, and quietNudgedAt is persisted regardless so a
        // transient send error doesn't become a recurring nudge.
        try {
          bus.publish({ kind: 'message', userId: config.TELEGRAM_USER_ID, text: formatQuietNudge(run, now) });
        } catch (err) {
          log.warn('quiet-nudge send failed', { id: run.id, error: (err as Error).message });
        }
        try {
          upsertRun(quietPlan.updated[i]!, config.SUPERVISED_RUNS_FILE);
        } catch (err) {
          log.warn('quiet-nudge persist failed', { id: run.id, error: (err as Error).message });
        }
      });

      // Quiet→cancel escalation (project 15, P2.7): a run that stays quiet past
      // the LONGER cancel threshold after its one-time nudge is escalated —
      // cancelMutation SIGTERMs the child, and the existing work-runner teardown
      // reaps + finalizes it. This stops the loop from nudging a never-recovering
      // run forever. Excludes the just-stalled set (`nudged`) — like the quiet
      // nudge, this is the alive-but-no-output case, distinct from a child-dead
      // stall. Per-run isolated.
      const quietCancelPlan = planQuietCancel(
        runs.filter((r) => !nudged.has(r.id)),
        config.WORK_RUN_QUIET_CANCEL_AFTER_MS,
        now,
      );
      quietCancelPlan.toCancel.forEach((run) => {
        try {
          // 'system': a backstop reap, NOT a user cancel — so the classifier
          // reads the run on its work product, not as a cancel the user made.
          const result = cancelMutation(run.id, 'system');
          log.info('quiet→cancel escalation', {
            id: run.id,
            product: run.product,
            project: run.project,
            cancelled: result.ok,
            ...(result.ok ? {} : { reason: result.reason }),
          });
        } catch (err) {
          log.warn('quiet→cancel escalation failed', { id: run.id, error: (err as Error).message });
        }
      });

      // Hard max-runtime ceiling (project 15, P2.7): group-kill + finalize ANY
      // running run past WORK_RUN_MAX_RUNTIME_MS, regardless of apparent liveness
      // — a fresh keep-alive ticker cannot defeat it (planMaxRuntimeKills keys on
      // startedAt). Runs over the full snapshot (the ceiling is the backstop for
      // every run, including stalled/quiet ones); cancelMutation is idempotent,
      // so a run also selected above is harmlessly re-cancelled. Per-run isolated.
      planMaxRuntimeKills(runs, config.WORK_RUN_MAX_RUNTIME_MS, now).toKill.forEach((run) => {
        try {
          // 'system': a backstop reap, NOT a user cancel (see quiet→cancel above).
          const result = cancelMutation(run.id, 'system');
          log.info('max-runtime ceiling kill', {
            id: run.id,
            product: run.product,
            project: run.project,
            cancelled: result.ok,
            ...(result.ok ? {} : { reason: result.reason }),
          });
        } catch (err) {
          log.warn('max-runtime ceiling kill failed', { id: run.id, error: (err as Error).message });
        }
      });
    } catch (err) {
      log.warn('stall-check tick failed', { error: (err as Error).message });
    }
  };

  timer = setInterval(tick, TICK_INTERVAL_MS);
  timer.unref();
  log.info('Stall check started', {
    intervalMs: TICK_INTERVAL_MS,
    thresholdMs: STALL_THRESHOLD_MS,
  });
}

export function stopStallCheck(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
  nudged.clear();
  log.info('Stall check stopped');
}
