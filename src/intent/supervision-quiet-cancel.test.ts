/**
 * Project 15 P2.7 test suite for the quiet→cancel ESCALATION decision core,
 * `planQuietCancel` (src/intent/supervision.ts). test-plan.md §5
 * "Quiet→cancel actuator".
 *
 * Written TEST-FIRST: `planQuietCancel` is a notImplemented scaffold, so every
 * test here is RED until the P2.7 actuator implementation lands. Expected
 * failure mode: a `... not implemented` throw or a clean assertion — NEVER a
 * module-resolution / syntax error.
 *
 * The headline contract: the quiet nudge (planQuietNudges) is the gentle first
 * step; the loop must NOT nudge a never-recovering run forever. Once a run stays
 * quiet `WORK_RUN_QUIET_CANCEL_AFTER_MS` past its one-time nudge, the actuator
 * escalates it to cancel/reap/finalize instead of nudging again.
 */

import { describe, it, expect } from 'vitest';
import {
  planQuietCancel,
  planQuietNudges,
  type SupervisedRun,
} from './supervision.js';

const NOW = 1_700_000_000_000;
const QUIET_MS = 5 * 60 * 1000; // first (nudge) threshold
// The longer escalation threshold — matches config.WORK_RUN_QUIET_CANCEL_AFTER_MS
// (1_200_000 ms / 20 min), which the stall-check-runner actuator reads. Inlined
// here because this is a pure-core test; the threshold lives in config, not in
// supervision.ts.
const CANCEL_AFTER_MS = 20 * 60 * 1000;

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function run(overrides: Partial<SupervisedRun> = {}): SupervisedRun {
  return {
    id: 'mut-qc-1',
    product: 'rune',
    project: '15-work-run-finalizer',
    status: 'running',
    startedAt: iso(NOW - 60 * 60 * 1000),
    lastHeartbeatAt: iso(NOW - 60 * 60 * 1000),
    ...overrides,
  };
}

describe('planQuietCancel — escalation decision (P2.7)', () => {
  it('escalates a running run whose quiet persisted past the cancel threshold after a nudge', () => {
    // Nudged 21 min ago — past the 20 min cancel threshold.
    const r = run({ quietNudgedAt: iso(NOW - 21 * 60 * 1000) });
    const plan = planQuietCancel([r], CANCEL_AFTER_MS, NOW);
    expect(plan.toCancel.map((x) => x.id)).toEqual(['mut-qc-1']);
  });

  it('does NOT escalate a run still within the cancel threshold (nudged recently)', () => {
    // Nudged 5 min ago — well within the 20 min cancel threshold.
    const r = run({ quietNudgedAt: iso(NOW - 5 * 60 * 1000) });
    expect(planQuietCancel([r], CANCEL_AFTER_MS, NOW).toCancel).toEqual([]);
  });

  it('does NOT escalate a run that was never quiet-nudged (the nudge is the first step)', () => {
    const r = run({ quietNudgedAt: undefined, lastOutputAt: iso(NOW - 60 * 60 * 1000) });
    expect(planQuietCancel([r], CANCEL_AFTER_MS, NOW).toCancel).toEqual([]);
  });

  it('does NOT escalate a non-running run even if its stale nudge is old', () => {
    for (const status of ['completed', 'failed', 'blocked-on-human', 'unknown'] as const) {
      const r = run({ status, quietNudgedAt: iso(NOW - 60 * 60 * 1000) });
      expect(planQuietCancel([r], CANCEL_AFTER_MS, NOW).toCancel).toEqual([]);
    }
  });

  it('soft-fails on an unparseable quietNudgedAt (no spurious escalation)', () => {
    const r = run({ quietNudgedAt: 'not-a-timestamp' });
    expect(planQuietCancel([r], CANCEL_AFTER_MS, NOW).toCancel).toEqual([]);
  });

  it('never mutates its inputs', () => {
    const r = run({ quietNudgedAt: iso(NOW - 21 * 60 * 1000) });
    const snapshot = { ...r };
    planQuietCancel([r], CANCEL_AFTER_MS, NOW);
    expect(r).toEqual(snapshot);
  });

  it('notifies once then escalates: a nudged run is not re-nudged, and is escalated past the longer threshold', () => {
    // A run quiet since long ago, nudged 21 min ago.
    const nudgedAt = NOW - 21 * 60 * 1000;
    const r = run({ lastOutputAt: iso(NOW - 60 * 60 * 1000), quietNudgedAt: iso(nudgedAt) });

    // planQuietNudges must NOT re-nudge it (the once-only guard holds).
    expect(planQuietNudges([r], QUIET_MS, NOW).toNudge).toEqual([]);
    // planQuietCancel escalates it instead of nudging again.
    expect(planQuietCancel([r], CANCEL_AFTER_MS, NOW).toCancel.map((x) => x.id)).toEqual(['mut-qc-1']);
  });
});
