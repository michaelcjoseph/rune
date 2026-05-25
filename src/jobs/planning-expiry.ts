/**
 * Periodic planning-session expiry — every hour, scan the in-memory planning
 * sessions and return the chatIds whose `lastActivity` is older than the TTL.
 * Project 08-intent-layer Phase 6 A4.5 (the session-expiry half of the
 * `abandonPlan on /clear or session expiry` task; `/clear` was wired in A4.3).
 *
 * Cleanup is a state-machine transition (the spec note for A4.5): scoping
 * wrote no files, so deleting a stale session strands nothing on disk. The
 * runner deletes via `deletePlanningSession` directly — not
 * `abandonActivePlanningSession`, which filters terminal states — so a
 * stranded `approved` session (e.g. project-setup-writer crashed and the
 * user never retried) is also cleaned up.
 *
 * Module split: `findExpiredPlanningSessions` is the pure core (deps
 * injected) tested in `planning-expiry.test.ts`; `startPlanningExpiry` /
 * `stopPlanningExpiry` are the setInterval glue called from `src/index.ts`.
 *
 * See spec.md §"Layer 1", tasks.md Phase 6 A4.5.
 */

import type { StoredPlanningSession } from '../reviews/planning.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('planning-expiry');

/** Tick interval — planning expiry doesn't need tight clocks. */
export const PLANNING_EXPIRY_TICK_INTERVAL_MS = 60 * 60 * 1000;

/** Inactivity threshold — 7 days. Planning may span multi-day scoping; a
 *  shorter TTL would catch a returning user mid-thought. */
export const PLANNING_EXPIRY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface FindExpiredPlanningSessionsDeps {
  /** Read all currently-stored planning sessions. Tests inject a fixture
   *  reader; production uses `getAllPlanningSessions()`. */
  readSessions: () => Array<[number, StoredPlanningSession]>;
  /** Epoch ms — `Date.now()` in production; fixed in tests. */
  now: number;
  /** Inactivity threshold in ms past which a session is expired. */
  ttlMs: number;
}

/**
 * Pure expiry detector. Returns chatIds whose `lastActivity` is strictly
 * older than `now - ttlMs`, in the order they appear from `readSessions`
 * (deterministic, no in-place sort).
 *
 * Defensive:
 * - `readSessions` throwing returns `[]` rather than propagating — the
 *   runner's interval callback can't crash on a transient read failure.
 * - A missing or unparseable `lastActivity` is treated as expired
 *   (fail-toward-cleanup, mirrors stall-check's fail-toward-visibility
 *   posture for the same reason: a corrupt entry that can't be inspected
 *   should not pin memory indefinitely).
 * - Status is intentionally not a filter — `scoping`, `spec-proposed`,
 *   `approved`, and `abandoned` are all subject to expiry so the
 *   stranded-approved retry slot doesn't accumulate either.
 */
export function findExpiredPlanningSessions(
  deps: FindExpiredPlanningSessionsDeps,
): number[] {
  let entries: Array<[number, StoredPlanningSession]>;
  try {
    entries = deps.readSessions();
  } catch (err) {
    log.warn('findExpiredPlanningSessions: readSessions failed; returning []', {
      error: (err as Error).message,
    });
    return [];
  }

  const cutoff = deps.now - deps.ttlMs;
  const expired: number[] = [];
  for (const [chatId, session] of entries) {
    const ts = Date.parse(session.lastActivity ?? '');
    // NaN propagates through both branches — Number.isFinite(NaN) is false.
    // Treat unparseable / missing timestamps as expired (conservative).
    if (!Number.isFinite(ts) || ts < cutoff) {
      expired.push(chatId);
    }
  }
  return expired;
}
