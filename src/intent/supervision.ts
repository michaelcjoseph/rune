/**
 * Supervision — Layer 3 of the intent layer's execution engine. Long-running runs (a
 * `/work --auto` sweep) are dispatched in the background; supervision provides the
 * **visibility surface** — which runs are active and which are blocked on a human — and
 * **heartbeat** staleness detection so a run that has gone quiet is flagged, not left
 * silently stalled.
 *
 * This module is the deterministic core of that surface: the run record, the active/blocked
 * queries, heartbeat staleness, the crash → terminal transition, and restart recovery. The
 * background dispatch itself (spawning and watching `/work --auto`) is orchestration that
 * builds on `work-runner.ts`; what is pinned here is the bookkeeping that never lets a run
 * be lost or stuck.
 *
 * STATUS: implemented. The visibility-surface core — `isStalled`, `getVisibility`,
 * `markCrashed`, `recoverRun` — is live; the contract is pinned by the test suite in
 * `supervision.test.ts` (test-plan.md §10). The background dispatch itself is the existing
 * work-runner; this module is the surface bookkeeping built around it.
 *
 * See docs/projects/08-intent-layer/{spec.md (§"Layer 3"), test-plan.md (§10)}.
 */

/**
 * Status of a supervised run. `running` / `blocked-on-human` are in-progress; `completed` /
 * `failed` are terminal; `unknown` is a run whose state could not be determined after a
 * restart (in-flight at the time, no longer observable).
 */
export type SupervisedRunStatus =
  | 'running'
  | 'blocked-on-human'
  | 'completed'
  | 'failed'
  | 'unknown';

/** One long-running run tracked by the supervision visibility surface. */
export interface SupervisedRun {
  /** Stable run id. */
  id: string;
  /** The product the run is for. */
  product: string;
  /** The project slug the run is executing. */
  project: string;
  status: SupervisedRunStatus;
  /** ISO-8601 timestamp the run started. */
  startedAt: string;
  /**
   * ISO-8601 timestamp of the most recent observed Claude `output` event —
   * an LLM-activity signal. Goes stale during multi-minute LLM calls that
   * produce no stdout, even when the underlying child is healthy. Use
   * {@link lastChildAliveAt} as the truer liveness signal when present.
   */
  lastHeartbeatAt: string;
  /**
   * ISO-8601 timestamp of the most recent in-runner liveness tick —
   * advances on a 30s setInterval owned by the applier while the child
   * process is alive, independent of LLM output. Optional for back-compat
   * with on-disk entries written before this field existed; `isStalled`
   * falls back to `lastHeartbeatAt` when absent.
   */
  lastChildAliveAt?: string;
  /**
   * ISO-8601 timestamp of the most recent observed Claude `output` event,
   * tracked DISTINCTLY from {@link lastHeartbeatAt} for the quiet-run nudge
   * (project 11, Phase 4): a run can be child-alive (keep-alive ticking) yet
   * produce no LLM output for minutes. {@link isQuietRun} measures quiet from
   * this (falling back to {@link startedAt} before the first output). Optional
   * for back-compat with entries written before the field existed.
   */
  lastOutputAt?: string;
  /**
   * ISO-8601 timestamp the quiet-run nudge was sent, or absent if never. Bounds
   * the nudge to at most once per run (project 11, requirement 23).
   */
  quietNudgedAt?: string;
}

/** The visibility surface — the picture the cockpit and Telegram report from. */
export interface VisibilitySurface {
  /** In-progress runs — `running` or `blocked-on-human`. */
  active: SupervisedRun[];
  /** Runs blocked on a human decision (a subset of `active`). */
  blocked: SupervisedRun[];
  /** `running` runs that have gone quiet past the heartbeat interval. */
  stalled: SupervisedRun[];
}

/**
 * Whether a run has gone quiet: it is `running` but its last heartbeat is older than
 * `heartbeatIntervalMs` relative to `now` (epoch ms). Pure and cheap — no I/O, no logging,
 * so it is safe to call on a frequent timer. A terminal or blocked run is never `stalled`.
 */
export function isStalled(
  run: SupervisedRun,
  heartbeatIntervalMs: number,
  now: number,
): boolean {
  if (run.status !== 'running') return false;
  // Prefer the in-runner liveness signal when it's been populated. The LLM
  // output heartbeat goes stale during long quiet calls even when the child
  // is alive; `lastChildAliveAt` is the truer liveness signal. Fall back to
  // `lastHeartbeatAt` for back-compat with on-disk entries written before
  // `lastChildAliveAt` existed (otherwise every legacy entry would read
  // stalled with no recourse).
  const liveness = run.lastChildAliveAt ?? run.lastHeartbeatAt;
  const parsed = Date.parse(liveness);
  // A corrupt or unparseable timestamp is treated as stalled — supervision fails toward
  // visibility, never silently hiding a run that may be stuck.
  if (Number.isNaN(parsed)) return true;
  return now - parsed > heartbeatIntervalMs;
}

/**
 * Whether a run is QUIET: `running`, has produced no `output` event for longer
 * than `quietThresholdMs` (measured from {@link SupervisedRun.lastOutputAt}, or
 * {@link SupervisedRun.startedAt} before the first output), and has not already
 * been quiet-nudged ({@link SupervisedRun.quietNudgedAt} unset). Evaluated
 * ALONGSIDE {@link isStalled}, NOT folded into it (project 11, requirement 23):
 * `isStalled` keys on child liveness (`lastChildAliveAt`), so a child-alive run
 * mid-long-LLM-call is never `stalled` — but it IS quiet. Pure, no I/O.
 *
 * Unlike `isStalled` (which fails toward visibility on a bad timestamp), a
 * quiet nudge is a soft prod: an unparseable baseline returns `false` rather
 * than firing a spurious nudge.
 */
export function isQuietRun(
  run: SupervisedRun,
  quietThresholdMs: number,
  now: number,
): boolean {
  if (run.status !== 'running') return false;
  if (run.quietNudgedAt) return false; // already nudged once
  // Measure from the last output, or from the run start before any output.
  const baseline = run.lastOutputAt ?? run.startedAt;
  const parsed = Date.parse(baseline);
  // Soft signal: an unparseable baseline does NOT fire a nudge (unlike
  // isStalled, which fails toward visibility on a bad timestamp).
  if (Number.isNaN(parsed)) return false;
  return now - parsed > quietThresholdMs;
}

/** A quiet-nudge plan: the runs to nudge, plus those same runs with
 *  `quietNudgedAt` stamped to `now` so the persistence layer can write the
 *  once-only marker. */
export interface QuietNudgePlan {
  toNudge: SupervisedRun[];
  /** Each `toNudge` run with `quietNudgedAt` set to `now`. */
  updated: SupervisedRun[];
}

/**
 * Plan the quiet-run nudges over a set of runs: the subset that {@link isQuietRun}
 * flags, plus stamped copies (`quietNudgedAt = now`) for the persistence layer.
 * Pure — the runner sends the nudges and persists `updated`. `toNudge[i]` and
 * `updated[i]` are the same run (1:1, stamped) — the runner pairs them by index.
 */
export function planQuietNudges(
  runs: SupervisedRun[],
  quietThresholdMs: number,
  now: number,
): QuietNudgePlan {
  const toNudge = runs.filter((r) => isQuietRun(r, quietThresholdMs, now));
  const stamp = new Date(now).toISOString();
  // Stamp copies (never mutate the inputs) so the runner persists the once-only
  // marker.
  const updated = toNudge.map((r) => ({ ...r, quietNudgedAt: stamp }));
  return { toNudge, updated };
}

/**
 * Build the visibility surface from the tracked runs: `active` (running or blocked),
 * `blocked` (blocked-on-human only), and `stalled` (running but quiet past the heartbeat
 * interval). Pure over `(runs, heartbeatIntervalMs, now)`.
 */
export function getVisibility(
  runs: SupervisedRun[],
  heartbeatIntervalMs: number,
  now: number,
): VisibilitySurface {
  return {
    active: runs.filter((r) => r.status === 'running' || r.status === 'blocked-on-human'),
    blocked: runs.filter((r) => r.status === 'blocked-on-human'),
    stalled: runs.filter((r) => isStalled(r, heartbeatIntervalMs, now)),
  };
}

/**
 * Transition a crashed or killed run to the terminal `failed` state. A run that died is
 * never left stuck reporting `running` — the surface always reflects a terminal state. A
 * run already in a terminal state is returned unchanged: idempotent on `failed`, and never
 * overwriting a `completed` run (that would destroy a real completion record).
 */
export function markCrashed(run: SupervisedRun): SupervisedRun {
  if (run.status === 'completed' || run.status === 'failed') return run;
  return { ...run, status: 'failed' };
}

/**
 * Recover a run after a Jarvis restart. A run that was `running` cannot be observed across
 * a restart, so it is marked `unknown` rather than left falsely `running` forever. A run
 * already in a terminal or blocked state is returned unchanged — those states are durable.
 */
export function recoverRun(run: SupervisedRun): SupervisedRun {
  return run.status === 'running' ? { ...run, status: 'unknown' } : run;
}

/**
 * Record a heartbeat check-in — refresh `lastHeartbeatAt` to `now` (epoch ms). Called as a
 * run reports progress (e.g. each output line of a `/work --auto` sweep), so a run that is
 * genuinely working is never mistaken for stalled by {@link isStalled}.
 */
export function recordHeartbeat(run: SupervisedRun, now: number): SupervisedRun {
  return { ...run, lastHeartbeatAt: new Date(now).toISOString() };
}
