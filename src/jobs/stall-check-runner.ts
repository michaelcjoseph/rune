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
import { readAllRuns } from './supervision-store.js';
import {
  checkStalledRuns,
  formatStallNudge,
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
      nudged = checkStalledRuns({
        readRuns: () => readAllRuns(config.SUPERVISED_RUNS_FILE),
        now: Date.now(),
        stallThresholdMs: STALL_THRESHOLD_MS,
        alreadyNudged: nudged,
        sendNudge: (run) => {
          bus.publish({
            kind: 'message',
            userId: config.TELEGRAM_USER_ID,
            text: formatStallNudge(run, Date.now()),
          });
        },
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
