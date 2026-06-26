/**
 * Project 15 P2.7 test suite for the max-runtime-ceiling decision core,
 * `planMaxRuntimeKills` (src/intent/supervision.ts). test-plan.md §5
 * "Max-runtime ceiling".
 *
 * Written TEST-FIRST: `planMaxRuntimeKills` is a notImplemented scaffold, so
 * every test here is RED until the P2.7 actuator implementation lands. Expected
 * failure mode: a `... not implemented` throw or a clean assertion — NEVER a
 * module-resolution / syntax error.
 *
 * The headline contract: the ceiling is the HARD backstop. It keys on
 * `startedAt`, not on any liveness signal — a run with a fresh keep-alive ticker
 * (`lastChildAliveAt` kept current, so `isStalled` says it's healthy) is STILL
 * group-killed once it exceeds the ceiling. Liveness cannot defeat the ceiling.
 */

import { describe, it, expect } from 'vitest';
import {
  planMaxRuntimeKills,
  isStalled,
  type SupervisedRun,
} from './supervision.js';

const NOW = 1_700_000_000_000;
// Equals config.WORK_RUN_MAX_RUNTIME_MS (7_200_000 ms / 2h). Inlined because
// the constant isn't exported yet; the impl task should export it and switch
// this to an import.
const MAX_RUNTIME_MS = 2 * 60 * 60 * 1000;
const HEARTBEAT_MS = 5 * 60 * 1000;

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function run(overrides: Partial<SupervisedRun> = {}): SupervisedRun {
  return {
    id: 'mut-mr-1',
    product: 'rune',
    project: '15-work-run-finalizer',
    status: 'running',
    startedAt: iso(NOW - 3 * 60 * 60 * 1000), // 3h ago — past the 2h ceiling
    lastHeartbeatAt: iso(NOW),
    ...overrides,
  };
}

describe('planMaxRuntimeKills — hard ceiling (P2.7)', () => {
  it('kills a run past the ceiling EVEN with a fresh keep-alive ticker (liveness cannot defeat it)', () => {
    // Started 3h ago (> 2h ceiling) but lastChildAliveAt is NOW — the keep-alive
    // ticker is current, so isStalled reports it healthy. The ceiling kills it anyway.
    const r = run({ startedAt: iso(NOW - 3 * 60 * 60 * 1000), lastChildAliveAt: iso(NOW) });
    expect(isStalled(r, HEARTBEAT_MS, NOW)).toBe(false); // not stalled — fresh liveness
    const plan = planMaxRuntimeKills([r], MAX_RUNTIME_MS, NOW);
    expect(plan.toKill.map((x) => x.id)).toEqual(['mut-mr-1']);
  });

  it('does NOT kill a run still within the ceiling', () => {
    const r = run({ startedAt: iso(NOW - 60 * 60 * 1000) }); // 1h ago, under 2h
    expect(planMaxRuntimeKills([r], MAX_RUNTIME_MS, NOW).toKill).toEqual([]);
  });

  it('does NOT kill a non-running run even if it started long ago', () => {
    for (const status of ['completed', 'failed', 'blocked-on-human', 'unknown'] as const) {
      const r = run({ status, startedAt: iso(NOW - 5 * 60 * 60 * 1000) });
      expect(planMaxRuntimeKills([r], MAX_RUNTIME_MS, NOW).toKill).toEqual([]);
    }
  });

  it('FAILS TOWARD KILL on an unparseable startedAt (the ceiling is the last backstop — a corrupt record must not evade it)', () => {
    // A corrupt startedAt with a fresh keep-alive would otherwise evade EVERY
    // backstop (not stalled, no quiet baseline). The ceiling kills it; the
    // finalizer then preserves the branch's committed work via classification.
    const r = run({ startedAt: 'not-a-timestamp', lastChildAliveAt: iso(NOW) });
    expect(planMaxRuntimeKills([r], MAX_RUNTIME_MS, NOW).toKill.map((x) => x.id)).toEqual(['mut-mr-1']);
  });

  it('selects only the over-ceiling runs from a mixed set', () => {
    const over = run({ id: 'over', startedAt: iso(NOW - 3 * 60 * 60 * 1000) });
    const under = run({ id: 'under', startedAt: iso(NOW - 30 * 60 * 1000) });
    const plan = planMaxRuntimeKills([over, under], MAX_RUNTIME_MS, NOW);
    expect(plan.toKill.map((x) => x.id)).toEqual(['over']);
  });

  it('never mutates its inputs', () => {
    const r = run();
    const snapshot = { ...r };
    planMaxRuntimeKills([r], MAX_RUNTIME_MS, NOW);
    expect(r).toEqual(snapshot);
  });
});
