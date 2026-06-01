/**
 * Phase 4 test suite for the quiet-run predicate (project 11
 * work-run-observability, test-plan §4). Covers `isQuietRun` + `planQuietNudges`
 * (src/intent/supervision.ts) and `formatQuietNudge` (src/jobs/stall-check.ts).
 *
 * Written TEST-FIRST: those three are notImplemented scaffolds, so every test
 * here is RED until the Phase 4 implementation task lands. Expected failure
 * mode: assertion failure or a `... not implemented` throw — NEVER a
 * module-resolution / syntax error.
 *
 * The headline contract: a quiet run is DISTINCT from a stalled run. `isStalled`
 * keys on child liveness (`lastChildAliveAt`); `isQuietRun` keys on LLM output
 * (`lastOutputAt`). A child-alive run mid-long-LLM-call is NOT stalled but IS
 * quiet.
 *
 * See: docs/projects/11-work-run-observability/test-plan.md §4
 */

import { describe, it, expect } from 'vitest';

import { isQuietRun, planQuietNudges, isStalled, type SupervisedRun } from './supervision.js';
import { formatQuietNudge } from '../jobs/stall-check.js';

const NOW = 1_700_000_000_000;
const QUIET_MS = 5 * 60 * 1000; // 5min
const SIX_MIN_AGO = new Date(NOW - 6 * 60 * 1000).toISOString();
const ONE_MIN_AGO = new Date(NOW - 60 * 1000).toISOString();
const NOW_ISO = new Date(NOW).toISOString();

function run(overrides: Partial<SupervisedRun> = {}): SupervisedRun {
  return {
    id: 'mut-quiet-1',
    product: 'jarvis',
    project: '11-work-run-observability',
    status: 'running',
    startedAt: SIX_MIN_AGO,
    lastHeartbeatAt: SIX_MIN_AGO,
    ...overrides,
  };
}

describe('isQuietRun', () => {
  it('running + no output for > threshold + not yet nudged → quiet', () => {
    expect(isQuietRun(run({ lastOutputAt: SIX_MIN_AGO }), QUIET_MS, NOW)).toBe(true);
  });

  it('running + recent output → not quiet', () => {
    expect(isQuietRun(run({ lastOutputAt: ONE_MIN_AGO }), QUIET_MS, NOW)).toBe(false);
  });

  it('already quiet-nudged → not quiet (at most once)', () => {
    expect(
      isQuietRun(run({ lastOutputAt: SIX_MIN_AGO, quietNudgedAt: ONE_MIN_AGO }), QUIET_MS, NOW),
    ).toBe(false);
  });

  it('no lastOutputAt yet → measured from startedAt (a run silent since start is quiet)', () => {
    expect(isQuietRun(run({ startedAt: SIX_MIN_AGO, lastOutputAt: undefined }), QUIET_MS, NOW)).toBe(true);
  });

  it('a non-running run is never quiet', () => {
    for (const status of ['completed', 'failed', 'blocked-on-human', 'unknown'] as const) {
      expect(isQuietRun(run({ status, lastOutputAt: SIX_MIN_AGO }), QUIET_MS, NOW)).toBe(false);
    }
  });

  it('an unparseable lastOutputAt does not fire a spurious nudge (soft signal → false)', () => {
    expect(isQuietRun(run({ lastOutputAt: 'not-a-date' }), QUIET_MS, NOW)).toBe(false);
  });

  it('an unparseable startedAt in the fallback path also does not fire a nudge', () => {
    expect(isQuietRun(run({ startedAt: 'not-a-date', lastOutputAt: undefined }), QUIET_MS, NOW)).toBe(false);
  });

  it('is DISTINCT from isStalled: child-alive but output-quiet → stalled false, quiet true', () => {
    const r = run({ lastChildAliveAt: NOW_ISO, lastHeartbeatAt: NOW_ISO, lastOutputAt: SIX_MIN_AGO });
    // Child is alive (keep-alive fresh) → not stalled…
    expect(isStalled(r, QUIET_MS, NOW)).toBe(false);
    // …but no LLM output for 6min → quiet.
    expect(isQuietRun(r, QUIET_MS, NOW)).toBe(true);
  });
});

describe('planQuietNudges', () => {
  it('returns only the quiet runs and stamps quietNudgedAt=now on the copies', () => {
    const runs = [
      run({ id: 'quiet', lastOutputAt: SIX_MIN_AGO }),
      run({ id: 'busy', lastOutputAt: ONE_MIN_AGO }),
      run({ id: 'done', status: 'completed', lastOutputAt: SIX_MIN_AGO }),
    ];
    const plan = planQuietNudges(runs, QUIET_MS, NOW);

    expect(plan.toNudge.map(r => r.id)).toEqual(['quiet']);
    expect(plan.updated).toHaveLength(1);
    expect(plan.updated[0]!.id).toBe('quiet');
    expect(plan.updated[0]!.quietNudgedAt).toBe(NOW_ISO);
    // The original run object is not mutated.
    expect(runs[0]!.quietNudgedAt).toBeUndefined();
  });

  it('does not re-nudge a run already marked quietNudgedAt', () => {
    const runs = [run({ id: 'already', lastOutputAt: SIX_MIN_AGO, quietNudgedAt: ONE_MIN_AGO })];
    const plan = planQuietNudges(runs, QUIET_MS, NOW);
    expect(plan.toNudge).toHaveLength(0);
  });
});

describe('formatQuietNudge', () => {
  it('renders a quiet-distinct message naming the run (not a "stalled" message)', () => {
    const msg = formatQuietNudge(run({ lastOutputAt: SIX_MIN_AGO }), NOW);
    expect(msg.toLowerCase()).toContain('quiet');
    // Distinct from the stall nudge — must not read as a child-dead "stalled".
    expect(msg.toLowerCase()).not.toContain('stalled');
    expect(msg).toContain('jarvis/11-work-run-observability');
  });
});
