/**
 * Durable promotion job (09-expand-cockpit, Phase 4).
 *
 * A "promotion" drives one backlog item from a Plan click through the
 * `planning-started → scaffolded → marked-source` chain, persisting every transition to an
 * append-only JSONL log so the chain survives a Jarvis restart. The state machine is pure; the only
 * I/O is the append-only log (`config.PROMOTIONS_FILE`, default `logs/promotions.jsonl`).
 *
 * State model:
 * - `planning-started`   — session opened, awaiting approval (non-terminal)
 * - `scaffolded`         — project files created, slug captured (non-terminal; restart-resumable)
 * - `marked-source`      — source bullet rewritten — terminal success
 * - `planning-abandoned` — session abandoned (/clear, /fresh, expiry) — terminal
 * - `scaffold-error`     — scaffold agent failed or returned no slug — terminal
 * - `mark-source-error`  — scaffold succeeded but the source rewrite failed — retryable (capped)
 *
 * Restart replay: a promotion stuck at `scaffolded` (scaffold succeeded, mark-source didn't run) is
 * auto-resumable. A `mark-source-error` is NOT auto-resumed — it is driven by an explicit retry
 * endpoint/button so a transient failure doesn't loop unattended. {@link resumablePromotions} is
 * the helper; the index.ts startup wiring that re-drives the selected promotions lands with the
 * approval-path "drive the promotion job" task (it needs the scaffold/mark-source drivers).
 *
 * Placement: this lives in `intent/` (not `jobs/`) per spec — the promotion is an intent-layer
 * concept and a sibling to the other `backlog-*` modules, mirroring `backlog-write-lock.ts`'s
 * precedent of an `intent/` module that owns its own file I/O.
 *
 * Contract pinned by `promotions.test.ts`.
 */

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createLogger } from '../utils/logger.js';

const log = createLogger('promotions');

/** Lifecycle of a promotion job. */
export type PromotionState =
  | 'planning-started'
  | 'scaffolded'
  | 'marked-source'
  | 'planning-abandoned'
  | 'scaffold-error'
  | 'mark-source-error';

/** A durable promotion job — one per Plan click. */
export interface Promotion {
  /** Stable job id (also the planning session's `promotionId` link). */
  id: string;
  /** Product the backlog item belongs to. */
  product: string;
  /** Product-local backlog item id this promotion was started from. */
  backlogItemId: string;
  /** The raw source line at start time — used for snapshot match at mark-source. PRIVACY: this is
   *  personal backlog text; it lives only in the gitignored log and must NOT be forwarded to any
   *  client surface (WebSocket, API response) without omission/truncation at the boundary. */
  snapshotRaw: string;
  /** The planning session driving this promotion. */
  planningSessionId: string;
  /** Project slug — populated at `scaffolded`. */
  slug?: string;
  /** Current lifecycle state. */
  state: PromotionState;
  /** Number of mark-source attempts made (bumped on each `mark-source-error`). */
  attempts: number;
  /** Human-readable error reasons accumulated across failed transitions. Callers MUST pass short,
   *  redacted messages (e.g. `(err as Error).message` run through `redactSecrets`) — never raw
   *  agent stdout/stderr or stack traces, which can carry vault paths or credentials. */
  errors: string[];
  /** ISO-8601 creation timestamp. */
  createdAt: string;
  /** ISO-8601 timestamp of the most recent transition. */
  updatedAt: string;
}

/** Max mark-source attempts before retry is refused. A module constant so tests reference it
 *  directly rather than hard-coding a number. */
export const MAX_MARK_SOURCE_ATTEMPTS = 3;

/** Legal forward edges per state — the single registry of all promotion states and their
 *  transitions. A state is terminal iff its edge list is empty (see {@link isTerminalPromotion}),
 *  and the own-key set doubles as the valid-state set for replay validation (see
 *  {@link isPromotionShape}), so there is no second list to keep in sync. */
const LEGAL_EDGES: Record<PromotionState, PromotionState[]> = {
  'planning-started': ['scaffolded', 'planning-abandoned', 'scaffold-error'],
  'scaffolded': ['marked-source', 'mark-source-error'],
  'mark-source-error': ['marked-source', 'mark-source-error'],
  'marked-source': [],
  'planning-abandoned': [],
  'scaffold-error': [],
};

/** Whether a state is terminal (never transitions out) — derived from `LEGAL_EDGES` so it can't
 *  drift from the edge map. */
export function isTerminalPromotion(state: PromotionState): boolean {
  return LEGAL_EDGES[state].length === 0;
}

/** Input to {@link createPromotion}. */
export interface CreatePromotionInput {
  id: string;
  product: string;
  backlogItemId: string;
  snapshotRaw: string;
  planningSessionId: string;
  /** ISO-8601 timestamp (injected for deterministic tests). */
  now: string;
}

/** Create a fresh promotion in `planning-started` with zero attempts and no slug. */
export function createPromotion(input: CreatePromotionInput): Promotion {
  return {
    id: input.id,
    product: input.product,
    backlogItemId: input.backlogItemId,
    snapshotRaw: input.snapshotRaw,
    planningSessionId: input.planningSessionId,
    state: 'planning-started',
    attempts: 0,
    errors: [],
    createdAt: input.now,
    updatedAt: input.now,
  };
}

/** Options for a transition — `slug` is required for `scaffolded`, `error` is recorded when given. */
export interface TransitionOpts {
  slug?: string;
  error?: string;
  /** ISO-8601 timestamp for `updatedAt` (injected for deterministic tests). */
  now: string;
}

/** Result of {@link transitionPromotion}. */
export type TransitionResult =
  | { ok: true; promotion: Promotion }
  | { ok: false; reason: 'terminal-state' | 'invalid-transition' | 'missing-slug' | 'cap-exceeded' };

/**
 * Apply a state transition, returning the new promotion or a typed refusal. Pure — never mutates
 * the input. Guard order (first failure wins):
 * 1. `terminal-state`     — the current state is terminal.
 * 2. `invalid-transition` — `to` is not a legal edge from the current state.
 * 3. `missing-slug`       — a `scaffolded` transition with no slug.
 * 4. `cap-exceeded`       — a `mark-source-error` transition once attempts have reached the cap
 *                           (the cap is ENFORCED here, not merely advisory).
 */
export function transitionPromotion(
  promotion: Promotion,
  to: PromotionState,
  opts: TransitionOpts,
): TransitionResult {
  if (isTerminalPromotion(promotion.state)) return { ok: false, reason: 'terminal-state' };
  if (!LEGAL_EDGES[promotion.state].includes(to)) return { ok: false, reason: 'invalid-transition' };
  // `.trim()` so a blank/whitespace-only slug is rejected at the boundary rather than producing a
  // promotion whose slug fails VALID_SLUG only later downstream.
  if (to === 'scaffolded' && !opts.slug?.trim()) return { ok: false, reason: 'missing-slug' };
  if (to === 'mark-source-error' && promotion.attempts >= MAX_MARK_SOURCE_ATTEMPTS) {
    return { ok: false, reason: 'cap-exceeded' };
  }

  const next: Promotion = {
    ...promotion,
    state: to,
    updatedAt: opts.now,
    ...(to === 'scaffolded' && opts.slug ? { slug: opts.slug } : {}),
    ...(to === 'mark-source-error' ? { attempts: promotion.attempts + 1 } : {}),
    ...(opts.error ? { errors: [...promotion.errors, opts.error] } : {}),
  };
  return { ok: true, promotion: next };
}

/** Whether a `mark-source-error` promotion may be retried — error state and under the attempt cap. */
export function canRetryMarkSource(promotion: Promotion): boolean {
  return promotion.state === 'mark-source-error' && promotion.attempts < MAX_MARK_SOURCE_ATTEMPTS;
}

// ---------------------------------------------------------------------------
// Persistence — append-only JSONL, last-write-wins replay
// ---------------------------------------------------------------------------

/** Append one promotion record to the log as a single JSON line. Append-only (`appendFileSync`
 *  opens with `O_APPEND`, one `write`) so a concurrent reader never observes a torn record. Mkdirs
 *  the containing dir on first write. `logPath` must be a trusted config-derived path
 *  (`config.PROMOTIONS_FILE`) — never request/user input.
 *
 *  Unlike the best-effort audit logs (`mutations-log.ts`), this log IS the restart-replay source of
 *  truth: it THROWS on a disk failure rather than swallowing it, so a caller that loses a durable
 *  transition learns about it instead of silently dropping a resumable promotion. */
export function appendPromotion(logPath: string, promotion: Promotion): void {
  mkdirSync(dirname(logPath), { recursive: true });
  appendFileSync(logPath, JSON.stringify(promotion) + '\n', 'utf8');
}

/** Whether `state` is a known promotion state — an OWN key of `LEGAL_EDGES`. `hasOwnProperty` (not
 *  the `in` operator) so inherited keys like `'toString'`/`'constructor'` from a corrupt log line
 *  are rejected rather than matching a prototype property. An unknown state would otherwise make
 *  `LEGAL_EDGES[state]` resolve to undefined (or an inherited function) and throw downstream. */
function isKnownState(state: string): state is PromotionState {
  return Object.prototype.hasOwnProperty.call(LEGAL_EDGES, state);
}

/** A parsed value carries the promotion shape we replay on: a string id, a KNOWN state, a numeric
 *  attempts, and an errors array. A stricter guard than a bare id/state check so a corrupt or
 *  schema-drifted line can't enter the live map with fields that throw downstream. */
function isPromotionShape(value: unknown): value is Promotion {
  if (typeof value !== 'object' || value === null) return false;
  const p = value as Record<string, unknown>;
  return (
    typeof p['id'] === 'string' &&
    typeof p['state'] === 'string' &&
    isKnownState(p['state']) &&
    typeof p['attempts'] === 'number' &&
    Array.isArray(p['errors'])
  );
}

/**
 * Replay the append-only log into the latest state per id (last line wins). Missing file → empty
 * map. Torn or unparseable lines are skipped with a warning so one bad line can't lose the rest.
 * Startup-only: this reads the whole log synchronously — call it at boot (restart replay), not on a
 * request hot path.
 */
export function loadPromotions(logPath: string): Map<string, Promotion> {
  let raw: string;
  try {
    raw = readFileSync(logPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return new Map();
    throw err;
  }
  const out = new Map<string, Promotion>();
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      log.warn('loadPromotions: skipping unparseable log line');
      continue;
    }
    if (!isPromotionShape(parsed)) {
      log.warn('loadPromotions: skipping log line that is not a promotion');
      continue;
    }
    out.set(parsed.id, parsed);
  }
  return out;
}

/**
 * The promotions to auto-resume on restart: those stuck at `scaffolded` (scaffold succeeded but
 * mark-source never ran). `mark-source-error` is deliberately excluded — it is driven by an
 * explicit retry, not by restart replay.
 */
export function resumablePromotions(promotions: Map<string, Promotion>): Promotion[] {
  return [...promotions.values()].filter((p) => p.state === 'scaffolded');
}
