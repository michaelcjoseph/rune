/**
 * Work-run parent-side commit poll (project 11, Phase 4 — "Alerts").
 *
 * While a `/work --auto` run streams, the PARENT polls the run branch for new
 * commits (`baseSha..branch`) and emits a THROTTLED progress ping carrying the
 * newest commit subject + a running task tally — never one ping per task
 * (spec requirement 22). `planCommitProgress` is the pure decision core: given
 * the poll state (last-seen SHA + last ping time), the current commit list, and
 * a task tally, it decides whether to ping this tick and returns the state to
 * carry forward. The runtime glue (the interval, the git `rev-list` + tasks.md
 * read, the bus publish) lives in `work-runner` and feeds this core.
 *
 * SCAFFOLD: signatures/types settled here for the Phase 4 test suite to pin
 * test-first; the body is unimplemented until the Phase 4 implementation task.
 */

/** Poll state carried between ticks. */
export interface CommitPollState {
  /** SHA of the newest commit observed on the last ping (null = none yet). */
  lastSeenSha: string | null;
  /** Epoch ms of the last emitted progress ping (0 = never pinged). */
  lastPingAt: number;
}

/** One commit on the run branch. */
export interface CommitInfo {
  sha: string;
  /** First line of the commit message. */
  subject: string;
}

/** Running task tally surfaced in the progress message. */
export interface TaskTally {
  done: number;
  total: number;
}

export interface PlanCommitProgressOpts {
  state: CommitPollState;
  /** Commits on `baseSha..branch`, NEWEST FIRST (`git rev-list` order). */
  commits: CommitInfo[];
  /** Task tally for the message (X/Y). */
  taskTally: TaskTally;
  /** Epoch ms now. */
  now: number;
  /** Minimum gap between pings — throttles bursts so it's never one per task. */
  throttleMs: number;
}

/** Discriminated on `ping` so `message` is present exactly when a ping fires —
 *  a caller can't read an `undefined` message off a no-ping result. */
export type CommitPollResult =
  | { ping: true; message: string; nextState: CommitPollState }
  | { ping: false; nextState: CommitPollState };

function notImplemented(fn: string): never {
  throw new Error(`work-run-commit-poll: ${fn} not implemented (project 11 Phase 4 pending)`);
}

/**
 * Decide whether to emit a commit-driven progress ping. A new commit (newest
 * SHA differs from `state.lastSeenSha`) pings only when at least `throttleMs`
 * has elapsed since the last ping — otherwise the ping is suppressed and the
 * state is left UNCHANGED so the commit is still "new" and pings once the
 * throttle window clears (one ping per window with the latest subject, never one
 * per task). No new commit → no ping, state unchanged.
 */
export function planCommitProgress(_opts: PlanCommitProgressOpts): CommitPollResult {
  notImplemented('planCommitProgress');
}
