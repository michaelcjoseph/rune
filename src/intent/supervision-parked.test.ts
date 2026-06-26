/**
 * Project 13 Phase 1b — the PARKED-run staleness nudge predicate
 * (`isParkedRun` + `planParkedNudges` in src/intent/supervision.ts), test-plan §2.
 *
 * Written TEST-FIRST: both are stub scaffolds (false / empty), so the
 * "fires once" cases are RED until the implementation task lands; the
 * "does not fire" cases pass as guards. Expected failure mode: a clean
 * assertion failure — never a module-resolution / syntax error.
 *
 * Headline contract: a parked run is DISTINCT from a quiet run. `isQuietRun`
 * early-returns on any non-`running` status; a parked run is `blocked-on-human`,
 * so the quiet predicate NEVER fires on it. `isParkedRun` is the net-new
 * predicate, keyed on `blocked-on-human` + its own `parkedNudgedAt` marker, and
 * it never auto-releases — only nudges.
 */

import { describe, it, expect } from 'vitest';

import {
  isParkedRun,
  planParkedNudges,
  isQuietRun,
  planQuietNudges,
  type SupervisedRun,
} from './supervision.js';

const NOW = 1_700_000_000_000;
const PARKED_MS = 24 * 60 * 60 * 1000; // 24h default
const TWENTY_FIVE_H_AGO = new Date(NOW - 25 * 60 * 60 * 1000).toISOString();
const ONE_H_AGO = new Date(NOW - 60 * 60 * 1000).toISOString();
const NOW_ISO = new Date(NOW).toISOString();

/** A parked (blocked-on-human) run. Baseline for the nudge age is the park time
 *  = `lastHeartbeatAt` (written when the parked record lands), falling back to
 *  `startedAt`. Defaults to "parked 25h ago". */
function parked(overrides: Partial<SupervisedRun> = {}): SupervisedRun {
  return {
    id: 'mut-parked-1',
    product: 'rune',
    project: '13-work-run-monitoring',
    status: 'blocked-on-human',
    startedAt: TWENTY_FIVE_H_AGO,
    lastHeartbeatAt: TWENTY_FIVE_H_AGO,
    ...overrides,
  };
}

describe('isParkedRun (RED until impl)', () => {
  it('blocked-on-human + parked past threshold + not yet nudged → due', () => {
    expect(isParkedRun(parked(), PARKED_MS, NOW)).toBe(true);
  });

  it('falls back to startedAt as the park-time baseline when lastHeartbeatAt is absent', () => {
    // Older on-disk records (or a parked write that didn't stamp lastHeartbeatAt)
    // must still age from startedAt — not silently never-nudge.
    expect(
      isParkedRun(parked({ lastHeartbeatAt: undefined, startedAt: TWENTY_FIVE_H_AGO }), PARKED_MS, NOW),
    ).toBe(true);
  });
});

describe('isParkedRun — guards (green pre-impl)', () => {
  it('parked only recently (< threshold) → not due', () => {
    expect(isParkedRun(parked({ lastHeartbeatAt: ONE_H_AGO, startedAt: ONE_H_AGO }), PARKED_MS, NOW)).toBe(false);
  });

  it('ages from PARK time (lastHeartbeatAt), not run start — a recently-parked long-running run is not due', () => {
    // The baseline is when the run PARKED (lastHeartbeatAt, set on the parked
    // write), not when the run first started. A run that ran for a day then
    // parked an hour ago is NOT a stale park.
    expect(
      isParkedRun(parked({ lastHeartbeatAt: ONE_H_AGO, startedAt: TWENTY_FIVE_H_AGO }), PARKED_MS, NOW),
    ).toBe(false);
  });

  it('already nudged once → not due again (parkedNudgedAt set)', () => {
    expect(isParkedRun(parked({ parkedNudgedAt: ONE_H_AGO }), PARKED_MS, NOW)).toBe(false);
  });

  it('a running run is NEVER parked-nudged (that is the quiet predicate\'s domain)', () => {
    expect(isParkedRun(parked({ status: 'running' }), PARKED_MS, NOW)).toBe(false);
  });

  it('a terminal run (completed/failed/unknown) is never parked-nudged', () => {
    expect(isParkedRun(parked({ status: 'completed' }), PARKED_MS, NOW)).toBe(false);
    expect(isParkedRun(parked({ status: 'failed' }), PARKED_MS, NOW)).toBe(false);
    expect(isParkedRun(parked({ status: 'unknown' }), PARKED_MS, NOW)).toBe(false);
  });

  it('soft-fails on an unparseable baseline (no spurious nudge)', () => {
    expect(isParkedRun(parked({ lastHeartbeatAt: 'not-a-date', startedAt: 'also-bad' }), PARKED_MS, NOW)).toBe(false);
  });
});

describe('planParkedNudges (RED until impl)', () => {
  it('returns only the aged parked runs and stamps parkedNudgedAt = now on copies', () => {
    const runs = [
      parked({ id: 'aged' }),
      parked({ id: 'fresh', lastHeartbeatAt: ONE_H_AGO, startedAt: ONE_H_AGO }),
      parked({ id: 'running', status: 'running' }),
      parked({ id: 'done', status: 'completed' }),
    ];
    const plan = planParkedNudges(runs, PARKED_MS, NOW);

    expect(plan.toNudge.map((r) => r.id)).toEqual(['aged']);
    expect(plan.updated).toHaveLength(1);
    expect(plan.updated[0]!.id).toBe('aged');
    expect(plan.updated[0]!.parkedNudgedAt).toBe(NOW_ISO);
    // Inputs are never mutated.
    expect(runs[0]!.parkedNudgedAt).toBeUndefined();
  });
});

describe('planParkedNudges — guards (green pre-impl)', () => {
  it('does not re-nudge a run already marked parkedNudgedAt', () => {
    const plan = planParkedNudges([parked({ parkedNudgedAt: ONE_H_AGO })], PARKED_MS, NOW);
    expect(plan.toNudge).toHaveLength(0);
  });

  it('empty input → empty plan', () => {
    expect(planParkedNudges([], PARKED_MS, NOW)).toEqual({ toNudge: [], updated: [] });
  });
});

// CRITICAL cross-check (verify-not-implement): the EXISTING quiet predicates
// must NOT fire on a parked (blocked-on-human) run — the parked nudge is a
// separate channel and the quiet→cancel / max-runtime actuators must never see
// a parked run as a `running` candidate. These assert current behavior and are
// green today; they guard against a future widening of `isQuietRun` to
// non-`running` statuses.
describe('quiet predicates never touch a parked run', () => {
  it('isQuietRun is false for a blocked-on-human run no matter how old', () => {
    expect(isQuietRun(parked({ lastOutputAt: TWENTY_FIVE_H_AGO }), 5 * 60 * 1000, NOW)).toBe(false);
  });

  it('planQuietNudges yields nothing for a set of only blocked-on-human runs', () => {
    const plan = planQuietNudges([parked(), parked({ id: 'p2' })], 5 * 60 * 1000, NOW);
    expect(plan.toNudge).toHaveLength(0);
  });
});
