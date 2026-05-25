/**
 * setInterval glue around `findExpiredPlanningSessions` — wires it to the
 * planning-session store. Split from `planning-expiry.ts` so the pure core
 * stays test-importable without triggering the runtime config bootstrap.
 *
 * Called from `src/index.ts` after `startStallCheck`; torn down in
 * `shutdown()`.
 *
 * Reads live in-memory state via `getAllPlanningSessions` (not the persisted
 * file on disk like stall-check does). This is deliberate: the planning
 * store's persistence is write-through (every mutation calls
 * `persistPlanningSessions`), so the in-memory map is always the source of
 * truth. `deletePlanningSession` mutates the same map and persists, so
 * cleanup is naturally consistent with what the next read will see.
 */

import {
  deletePlanningSession,
  getAllPlanningSessions,
} from '../reviews/planning.js';
import { createLogger } from '../utils/logger.js';
import {
  findExpiredPlanningSessions,
  PLANNING_EXPIRY_TICK_INTERVAL_MS,
  PLANNING_EXPIRY_TTL_MS,
} from './planning-expiry.js';

const log = createLogger('planning-expiry-runner');

let timer: ReturnType<typeof setInterval> | null = null;

/**
 * Start the periodic planning-session expiry sweep. Idempotent — calling
 * twice clears the existing timer first. Timer is unref()'d so it doesn't
 * keep the process alive on shutdown.
 */
export function startPlanningExpiry(): void {
  if (timer) stopPlanningExpiry();

  const tick = (): void => {
    // findExpiredPlanningSessions has its own try/catch around readSessions;
    // this outer guard catches the unexpected-throw case (OOM, future
    // refactor) so an uncaught setInterval-callback exception doesn't crash
    // the process via process.uncaughtException.
    try {
      const expired = findExpiredPlanningSessions({
        readSessions: getAllPlanningSessions,
        now: Date.now(),
        ttlMs: PLANNING_EXPIRY_TTL_MS,
      });
      if (expired.length === 0) return;
      let deleted = 0;
      // Per-item try/catch so one bad delete (e.g. Claude cleanup or persist
      // failure) doesn't skip the remaining sessions in this tick.
      for (const chatId of expired) {
        try {
          deletePlanningSession(chatId);
          deleted++;
        } catch (err) {
          log.warn('Failed to delete expired planning session', {
            chatId,
            error: (err as Error).message,
          });
        }
      }
      // chatIds dropped from the payload — count alone is enough operationally
      // and avoids logging the owner's Telegram numeric id in single-user
      // deployments.
      log.info('Expired planning sessions cleaned up', {
        deleted,
        attempted: expired.length,
      });
    } catch (err) {
      log.warn('planning-expiry tick failed', { error: (err as Error).message });
    }
  };

  timer = setInterval(tick, PLANNING_EXPIRY_TICK_INTERVAL_MS);
  timer.unref();
  log.info('Planning-expiry sweep started', {
    intervalMs: PLANNING_EXPIRY_TICK_INTERVAL_MS,
    ttlMs: PLANNING_EXPIRY_TTL_MS,
  });
}

export function stopPlanningExpiry(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
  log.info('Planning-expiry sweep stopped');
}
