/**
 * Per-user planning conversation store (project 08 Phase 6 A4.1). Wraps the
 * pure lifecycle state from `src/intent/planner.ts` with chatId-keyed
 * persistence, mirroring `src/reviews/session.ts` for review sessions.
 *
 * Storage shape: one `StoredPlanningSession` per chatId, persisted as JSON
 * to `config.PLANNING_SESSIONS_FILE`. Atomic temp-then-rename writes
 * (matching review-session); restore on startup brings the in-memory map
 * back from disk so a Jarvis restart doesn't lose an in-flight planning
 * conversation.
 *
 * The orchestration that drives the Planner's questions, surfaces
 * assumptions, and proposes the `SpecArtifact` is A4.2 — this module is
 * the storage layer the orchestration mutates.
 */

import { randomUUID } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { cleanupSession } from '../ai/claude.js';
import config from '../config.js';
import {
  approvePlan,
  startPlanning,
  type PlanningSession,
  type PlanningStatus,
  type PlanningSurface,
  type SpecArtifact,
} from '../intent/planner.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('planning-session');

/** One stored planning session — the lifecycle state plus the per-user
 *  metadata the bot/webview needs to route turns. */
export interface StoredPlanningSession {
  /** Stable id of this stored session. */
  id: string;
  /** Telegram chat / cockpit user id. */
  chatId: number;
  /** Claude CLI session id — kept in sync with `ai/claude.js`'s session
   *  tracking so cleanup-on-delete works the same way as review sessions. */
  claudeSessionId: string;
  /** The pure planning lifecycle state from `src/intent/planner.ts`. */
  planning: PlanningSession;
  /** ISO timestamp the session was created. */
  createdAt: string;
  /** ISO timestamp of the most recent state mutation. */
  lastActivity: string;
  /** Links this session to a durable {@link Promotion} (09-expand-cockpit) when the session was
   *  opened from a backlog Plan click. The approval path advances the linked promotion to
   *  `scaffolded`/`marked-source`; abandonment (/clear, /fresh, webview abandon, expiry) advances a
   *  linked `planning-started` promotion to `planning-abandoned`. Absent for plain `/plan` sessions.
   *  Round-trips through persist/restore as part of the stored session object. */
  promotionId?: string;
}

const sessions = new Map<number, StoredPlanningSession>();

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export function getPlanningSession(chatId: number): StoredPlanningSession | null {
  return sessions.get(chatId) ?? null;
}

/** An "in-flight" planning session — `scoping` or `spec-proposed`. Approved
 *  sessions are terminal (next step is scaffolding via the
 *  project-setup-writer agent, which the bot handler triggers explicitly);
 *  abandoned sessions are dead. Neither counts as active for the routing
 *  question the bot asks ("does this chat have a planning conversation
 *  awaiting my next reply?"). */
export function getActivePlanningSession(chatId: number): StoredPlanningSession | null {
  const session = sessions.get(chatId);
  if (!session) return null;
  if (session.planning.status === 'approved' || session.planning.status === 'abandoned') {
    return null;
  }
  return session;
}

export function getAllPlanningSessions(): Array<[number, StoredPlanningSession]> {
  return [...sessions.entries()];
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

export function createPlanningSession(
  chatId: number,
  idea: string,
  surface: PlanningSurface,
  product: string,
): StoredPlanningSession {
  const existing = getActivePlanningSession(chatId);
  if (existing) {
    log.info('Cancelling active planning session to start new one', {
      chatId,
      oldId: existing.id,
      oldStatus: existing.planning.status,
    });
    cleanupSession(existing.claudeSessionId);
  }
  const now = new Date().toISOString();
  const session: StoredPlanningSession = {
    id: randomUUID(),
    chatId,
    claudeSessionId: randomUUID(),
    planning: startPlanning(idea, surface, product),
    createdAt: now,
    lastActivity: now,
  };
  sessions.set(chatId, session);
  persistPlanningSessions();
  return session;
}

/**
 * Apply an updater function to the session for `chatId`. The function takes
 * the current stored session and returns the next one — callers pass any
 * shape change (status transition via `proposeSpec`/`approvePlan`,
 * artifact update, etc.). `lastActivity` is refreshed automatically.
 * A no-op when the chatId has no session.
 */
export function updatePlanningSession(
  chatId: number,
  updater: (sess: StoredPlanningSession) => StoredPlanningSession,
): void {
  const current = sessions.get(chatId);
  if (!current) return;
  const prevArtifact = current.planning.artifact;
  const next: StoredPlanningSession = {
    ...updater(current),
    lastActivity: new Date().toISOString(),
  };
  sessions.set(chatId, next);
  // Snapshot the artifact whenever its content changes. Fires on the
  // initial proposeSpec transition (undefined → defined) and on every
  // subsequent revision the planner produces during the conversation.
  // The full evolution trail is the only off-process recovery path if
  // /approve later deletes the session before the scaffolder lands the
  // files on disk — see `docs/projects/08-intent-layer/agent-lessons.md`
  // for the incident that motivated this.
  const nextArtifact = next.planning.artifact;
  if (nextArtifact && !artifactsEqual(prevArtifact, nextArtifact)) {
    snapshotArtifact(next, nextArtifact);
  }
  persistPlanningSessions();
}

function artifactsEqual(
  a: SpecArtifact | undefined,
  b: SpecArtifact | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Write a single artifact revision to its own JSON file under
 *  PLANNING_ARTIFACTS_DIR. Atomic temp-then-rename. Errors logged, never
 *  thrown — a snapshot failure must not break the planning conversation. */
function snapshotArtifact(
  session: StoredPlanningSession,
  artifact: SpecArtifact,
): void {
  const dir = config.PLANNING_ARTIFACTS_DIR;
  const ts = new Date().toISOString();
  const safeTs = ts.replace(/[:.]/g, '-');
  const filePath = join(dir, `${session.id}-${safeTs}.json`);
  const payload = {
    sessionId: session.id,
    chatId: session.chatId,
    timestamp: ts,
    status: session.planning.status,
    artifact,
  };
  try {
    mkdirSync(dir, { recursive: true });
    const tmp = `${filePath}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
    renameSync(tmp, filePath);
  } catch (err) {
    log.error('snapshotArtifact failed', {
      path: filePath,
      sessionId: session.id,
      error: (err as Error).message,
    });
  }
}

export function deletePlanningSession(chatId: number): void {
  const session = sessions.get(chatId);
  if (!session) return;
  cleanupSession(session.claudeSessionId);
  sessions.delete(chatId);
  persistPlanningSessions();
}

/** Result of attempting to approve an active planning session. The
 *  discriminated union lets callers tailor the user-facing reply per path:
 *  no session, wrong status, or the approved session ready to scaffold. */
export type ApproveResult =
  | { ok: true; session: StoredPlanningSession }
  | { ok: false; reason: 'no-session' }
  | { ok: false; reason: 'wrong-status'; status: PlanningStatus };

/**
 * Approve an active planning session in `spec-proposed` — transitions the
 * lifecycle via the pure state machine (`approvePlan`), persists the new
 * status, and returns the approved session for the caller to feed into
 * scaffolding (project-setup-writer). The session is **not** deleted here —
 * callers delete on scaffold success, or leave the session alive in
 * `approved` state so the user can retry on agent failure (see the
 * `getPlanningSession`-based retry path in `handleApprove`).
 *
 * Returns a discriminated union so callers handle the three states without
 * a thrown exception: no session, wrong status, or success.
 */
export function approveActivePlanningSession(chatId: number): ApproveResult {
  const session = getActivePlanningSession(chatId);
  if (!session) return { ok: false, reason: 'no-session' };
  if (session.planning.status !== 'spec-proposed') {
    return { ok: false, reason: 'wrong-status', status: session.planning.status };
  }
  // approvePlan validates the spec-proposed precondition again and throws
  // on a state-machine violation. Catching here would swallow a logic bug —
  // we let it propagate so the caller surfaces a clear error.
  const approved: StoredPlanningSession = {
    ...session,
    planning: approvePlan(session.planning),
    lastActivity: new Date().toISOString(),
  };
  sessions.set(chatId, approved);
  persistPlanningSessions();
  return { ok: true, session: approved };
}

/**
 * Abandon any active planning session for `chatId` — removes the stored
 * session and cleans up the Claude session id. A no-op when the chat has no
 * active planning session, or when the session is already in a terminal
 * state (`getActivePlanningSession` filters those out).
 *
 * Used by `/clear`, `/fresh`, and `/plan` (when starting a new session) so
 * the escape hatches the spec promises are honored consistently. Returns
 * `true` when something was abandoned, `false` otherwise — callers use the
 * boolean to tailor their reply ("planning session abandoned" vs. nothing
 * to clear).
 *
 * The pure `abandonPlan` lifecycle transition is intentionally skipped here:
 * the abandoned state never reaches an observer (a synchronous delete follows
 * immediately, and no recovery path reads abandoned sessions). Driving the
 * transition would write the abandoned state to disk for zero microseconds
 * before the delete overwrites it.
 */
export function abandonActivePlanningSession(chatId: number): boolean {
  const session = getActivePlanningSession(chatId);
  if (!session) return false;
  deletePlanningSession(chatId);
  return true;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export function persistPlanningSessions(): void {
  const filePath = config.PLANNING_SESSIONS_FILE;
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    const tmp = `${filePath}.${process.pid}.tmp`;
    const payload = [...sessions.entries()].map(([chatId, sess]) => ({ chatId, sess }));
    writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
    renameSync(tmp, filePath);
  } catch (err) {
    log.error('persistPlanningSessions failed', {
      path: filePath,
      error: (err as Error).message,
    });
  }
}

export function restorePlanningSessions(): void {
  sessions.clear();
  let raw: string;
  try {
    raw = readFileSync(config.PLANNING_SESSIONS_FILE, 'utf8');
  } catch {
    return; // missing file — fresh install
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    log.warn('restorePlanningSessions: malformed file; starting empty', {
      error: (err as Error).message,
    });
    return;
  }
  if (!Array.isArray(parsed)) {
    log.warn('restorePlanningSessions: root is not an array; starting empty');
    return;
  }
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as { chatId?: unknown; sess?: unknown };
    if (typeof e.chatId !== 'number' || !e.sess || typeof e.sess !== 'object') continue;
    sessions.set(e.chatId, e.sess as StoredPlanningSession);
  }
}
