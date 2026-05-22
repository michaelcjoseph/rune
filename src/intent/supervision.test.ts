import { describe, it, expect } from 'vitest';

/*
 * Test-first suite for test-plan.md §10 — supervision, Layer 3 (08-intent-layer, Phase 3).
 *
 * Written BEFORE the implementation. `src/intent/supervision.ts` ships as a contract stub
 * whose functions throw 'not implemented', so every test here is RED. That is the intended,
 * correct state: this is a "Tests (write first)" task — the suite goes green when a Phase 3
 * supervision implementation task lands. Do not implement supervision to make these pass;
 * that is a separate task.
 *
 * Scope note: §10's "/work --auto remains directly invokable by Michael with unchanged
 * behavior" is a regression property of the existing work-runner — it is covered by
 * work-runner.ts's own test suite staying green, not by this surface-bookkeeping suite.
 */

import {
  isStalled,
  getVisibility,
  markCrashed,
  recoverRun,
  recordHeartbeat,
  type SupervisedRun,
} from './supervision.js';

// --- Fixtures ---

const HEARTBEAT_MS = 60_000;
/** A fixed "now" — epoch ms for 2026-01-15T00:10:00Z. */
const NOW = Date.parse('2026-01-15T00:10:00.000Z');

/** A supervised run; override any field per test. */
function run(overrides: Partial<SupervisedRun> = {}): SupervisedRun {
  return {
    id: 'run-1',
    product: 'aura',
    project: '02-growth',
    status: 'running',
    startedAt: '2026-01-15T00:00:00.000Z',
    // Default: a fresh heartbeat 30s ago (within the 60s interval).
    lastHeartbeatAt: '2026-01-15T00:09:30.000Z',
    ...overrides,
  };
}

describe('supervision — heartbeat staleness (test-plan §10)', () => {
  it('flags a running run whose last heartbeat is older than the interval', () => {
    const quiet = run({ lastHeartbeatAt: '2026-01-15T00:05:00.000Z' }); // 5 min ago
    expect(isStalled(quiet, HEARTBEAT_MS, NOW)).toBe(true);
  });

  it('does not flag a running run with a recent heartbeat', () => {
    expect(isStalled(run(), HEARTBEAT_MS, NOW)).toBe(false);
  });

  it('never flags a terminal run as stalled — only running runs can stall', () => {
    const staleHb = '2026-01-15T00:00:00.000Z'; // 10 min ago — well past the 60s interval
    expect(isStalled(run({ status: 'completed', lastHeartbeatAt: staleHb }), HEARTBEAT_MS, NOW)).toBe(false);
    expect(isStalled(run({ status: 'failed', lastHeartbeatAt: staleHb }), HEARTBEAT_MS, NOW)).toBe(false);
  });

  it('treats a running run with a corrupt heartbeat as stalled — fails toward visibility', () => {
    expect(isStalled(run({ lastHeartbeatAt: 'not-a-timestamp' }), HEARTBEAT_MS, NOW)).toBe(true);
  });

  it('keys staleness off the passed-in `now`, not a captured clock', () => {
    // Heartbeat at 00:09:00 — fresh at 00:09:30 (30s later), stale at 00:11:00 (2m later).
    // An implementation that read Date.now() instead of the `now` argument would fail this.
    const r = run({ lastHeartbeatAt: '2026-01-15T00:09:00.000Z' });
    expect(isStalled(r, HEARTBEAT_MS, Date.parse('2026-01-15T00:09:30.000Z'))).toBe(false);
    expect(isStalled(r, HEARTBEAT_MS, Date.parse('2026-01-15T00:11:00.000Z'))).toBe(true);
  });
});

describe('supervision — heartbeat check-ins (test-plan §10)', () => {
  it('a heartbeat check-in refreshes lastHeartbeatAt to the check-in time', () => {
    const after = recordHeartbeat(run({ lastHeartbeatAt: '2026-01-15T00:00:00.000Z' }), NOW);
    expect(Date.parse(after.lastHeartbeatAt)).toBe(NOW);
  });

  it('a heartbeat check-in clears a stalled run — it is no longer flagged', () => {
    const stale = run({ lastHeartbeatAt: '2026-01-15T00:00:00.000Z' });
    expect(isStalled(stale, HEARTBEAT_MS, NOW)).toBe(true);
    expect(isStalled(recordHeartbeat(stale, NOW), HEARTBEAT_MS, NOW)).toBe(false);
  });
});

describe('supervision — visibility surface (test-plan §10)', () => {
  it('reports running and blocked-on-human runs as active, terminal runs excluded', () => {
    const runs = [
      run({ id: 'a', status: 'running' }),
      run({ id: 'b', status: 'blocked-on-human' }),
      run({ id: 'c', status: 'completed' }),
      run({ id: 'd', status: 'failed' }),
    ];
    const surface = getVisibility(runs, HEARTBEAT_MS, NOW);
    expect(surface.active.map((r) => r.id).sort()).toEqual(['a', 'b']);
  });

  it('reports blocked-on-human runs distinctly so the cockpit can surface them', () => {
    const runs = [run({ id: 'a', status: 'running' }), run({ id: 'b', status: 'blocked-on-human' })];
    const surface = getVisibility(runs, HEARTBEAT_MS, NOW);
    expect(surface.blocked.map((r) => r.id)).toEqual(['b']);
  });

  it('flags a quiet running run in the stalled list rather than leaving it silently stuck', () => {
    const runs = [
      run({ id: 'fresh', lastHeartbeatAt: '2026-01-15T00:09:30.000Z' }),
      run({ id: 'quiet', lastHeartbeatAt: '2026-01-15T00:02:00.000Z' }),
    ];
    const surface = getVisibility(runs, HEARTBEAT_MS, NOW);
    expect(surface.stalled.map((r) => r.id)).toEqual(['quiet']);
  });
});

describe('supervision — crashed runs (test-plan §10)', () => {
  it('transitions a crashed run to a terminal failed state — never stuck running', () => {
    const crashed = markCrashed(run({ status: 'running' }));
    expect(crashed.status).toBe('failed');
    // A crashed run is no longer active in the visibility surface.
    expect(getVisibility([crashed], HEARTBEAT_MS, NOW).active).toEqual([]);
  });

  it('is idempotent — crashing an already-failed run leaves it failed', () => {
    expect(markCrashed(run({ status: 'failed' })).status).toBe('failed');
  });

  it('never overwrites a completed run — markCrashed leaves a completion record intact', () => {
    const completed = run({ status: 'completed' });
    expect(markCrashed(completed)).toEqual(completed);
  });
});

describe('supervision — restart recovery (test-plan §10)', () => {
  it('marks a run that was running at restart as unknown — not falsely running forever', () => {
    expect(recoverRun(run({ status: 'running' })).status).toBe('unknown');
  });

  it('leaves a run in a terminal or blocked state unchanged across a restart', () => {
    // completed/failed are terminal; blocked-on-human is durable — still waiting on a human.
    for (const status of ['completed', 'failed', 'blocked-on-human'] as const) {
      const r = run({ status });
      expect(recoverRun(r)).toEqual(r);
    }
  });
});
