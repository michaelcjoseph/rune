/**
 * Phase 4 test suite for `src/jobs/work-run-commit-poll.ts` — the parent-side
 * commit-poll throttle core (test-plan §4, project 11 work-run-observability).
 *
 * Written TEST-FIRST: `planCommitProgress` throws `notImplemented(...)`, so every
 * test here is RED until the Phase 4 implementation task lands. Expected failure
 * mode: assertion failure or the `work-run-commit-poll: ... not implemented`
 * throw — NEVER a module-resolution / syntax error.
 *
 * Pure core — no I/O, fixtures only.
 *
 * See: docs/projects/11-work-run-observability/test-plan.md §4 (commit-poll
 * progress throttle).
 */

import { describe, it, expect } from 'vitest';

import { planCommitProgress } from './work-run-commit-poll.js';
import type { CommitInfo, CommitPollResult, CommitPollState } from './work-run-commit-poll.js';

const THROTTLE = 10_000; // 10s
const TALLY = { done: 1, total: 3 };

function commit(sha: string, subject = `work on ${sha}`): CommitInfo {
  return { sha, subject };
}

/** Narrow a result to the ping:true branch (so `.message` is typed) and fail
 *  loudly otherwise. */
function expectPing(r: CommitPollResult): asserts r is Extract<CommitPollResult, { ping: true }> {
  expect(r.ping).toBe(true);
}

describe('planCommitProgress', () => {
  it('pings on the first observed commit (no prior SHA), carrying subject + tally', () => {
    const state: CommitPollState = { lastSeenSha: null, lastPingAt: 0 };
    const result = planCommitProgress({
      state,
      commits: [commit('abc123', 'add the thing')],
      taskTally: TALLY,
      now: 1_000_000,
      throttleMs: THROTTLE,
    });

    expectPing(result);
    expect(result.message).toContain('add the thing');
    expect(result.message).toMatch(/1\s*\/\s*3/); // task tally X/Y
    // State advances: newest SHA seen + ping timestamp recorded.
    expect(result.nextState.lastSeenSha).toBe('abc123');
    expect(result.nextState.lastPingAt).toBe(1_000_000);
  });

  it('does not ping when there is no new commit (newest SHA unchanged)', () => {
    const state: CommitPollState = { lastSeenSha: 'abc123', lastPingAt: 500_000 };
    const result = planCommitProgress({
      state,
      commits: [commit('abc123')],
      taskTally: TALLY,
      now: 1_000_000,
      throttleMs: THROTTLE,
    });

    expect(result.ping).toBe(false);
    expect(result.nextState).toEqual(state); // unchanged
  });

  it('does not ping for an empty commit list (no commits yet)', () => {
    const state: CommitPollState = { lastSeenSha: null, lastPingAt: 0 };
    const result = planCommitProgress({
      state,
      commits: [],
      taskTally: TALLY,
      now: 1_000_000,
      throttleMs: THROTTLE,
    });
    expect(result.ping).toBe(false);
  });

  it('does not ping (and leaves state unchanged) on an empty list when a SHA was already seen (transient git error)', () => {
    // A mid-run `git rev-list` hiccup returns []; the poll must not interpret
    // that as "commits disappeared" and must not advance/reset state.
    const state: CommitPollState = { lastSeenSha: 'abc123', lastPingAt: 1_000_000 };
    const result = planCommitProgress({
      state,
      commits: [],
      taskTally: TALLY,
      now: 1_050_000,
      throttleMs: THROTTLE,
    });
    expect(result.ping).toBe(false);
    expect(result.nextState).toEqual(state);
  });

  it('suppresses a new commit within the throttle window, keeping lastSeenSha so it pings later', () => {
    // Pinged at t=1_000_000; a new commit shows up 3s later (< 10s throttle).
    const state: CommitPollState = { lastSeenSha: 'abc123', lastPingAt: 1_000_000 };
    const result = planCommitProgress({
      state,
      commits: [commit('def456'), commit('abc123')], // newest first
      taskTally: TALLY,
      now: 1_003_000,
      throttleMs: THROTTLE,
    });

    expect(result.ping).toBe(false);
    // lastSeenSha must NOT advance to def456 — otherwise the commit is lost and
    // never pings; it stays so the next post-throttle poll still sees it as new.
    expect(result.nextState.lastSeenSha).toBe('abc123');
    expect(result.nextState.lastPingAt).toBe(1_000_000);
  });

  it('pings a new commit once the throttle window has elapsed', () => {
    const state: CommitPollState = { lastSeenSha: 'abc123', lastPingAt: 1_000_000 };
    const result = planCommitProgress({
      state,
      commits: [commit('def456', 'second commit'), commit('abc123')],
      taskTally: { done: 2, total: 3 },
      now: 1_011_000, // 11s later > 10s throttle
      throttleMs: THROTTLE,
    });

    expectPing(result);
    expect(result.message).toContain('second commit');
    expect(result.nextState.lastSeenSha).toBe('def456');
    expect(result.nextState.lastPingAt).toBe(1_011_000);
  });

  it('emits at most one ping per throttle window across a burst of commits (never one per task)', () => {
    // Simulate: ping at t0, then three commits land within the window, polled
    // each tick. Only the post-throttle poll should ping — once, with the latest.
    let state: CommitPollState = { lastSeenSha: 'c0', lastPingAt: 1_000_000 };
    let pings = 0;

    // Three in-window polls, each with a newer head commit.
    for (const [sha, t] of [['c1', 1_002_000], ['c2', 1_004_000], ['c3', 1_006_000]] as Array<[string, number]>) {
      const r = planCommitProgress({
        state,
        commits: [commit(sha), commit('c0')],
        taskTally: TALLY,
        now: t,
        throttleMs: THROTTLE,
      });
      if (r.ping) pings += 1;
      state = r.nextState;
    }
    expect(pings).toBe(0); // all suppressed within the window

    // Post-throttle poll: the latest head (c3) pings once.
    const after = planCommitProgress({
      state,
      commits: [commit('c3', 'latest'), commit('c0')],
      taskTally: TALLY,
      now: 1_011_000,
      throttleMs: THROTTLE,
    });
    expectPing(after);
    expect(after.message).toContain('latest');
    expect(after.nextState.lastSeenSha).toBe('c3');
  });
});
