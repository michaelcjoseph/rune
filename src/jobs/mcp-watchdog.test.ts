/**
 * Tests for src/jobs/mcp-watchdog.ts — the pure alert-evaluation core.
 *
 * Full rule matrix with boundary values, per-key 6h notify cooldown, recovery
 * notices, and state transitions. The core is pure (no I/O, no Date.now()),
 * so no mocks are needed.
 */

import { describe, expect, it } from 'vitest';
import type { DeltaPoint } from '../mcp/metrics-history.js';
import {
  NOTIFY_COOLDOWN_MS,
  defaultWatchdogState,
  evaluateMcpWatchdog,
  type McpWatchdogState,
} from './mcp-watchdog.js';

const NOW = Date.parse('2026-07-06T12:00:00.000Z');
const TICK_MS = 60_000;

const UP = { reachable: true, status: 'ok' };
const DOWN = { reachable: false };
const DEGRADED = { reachable: true, status: 'degraded' };

function delta(overrides: Partial<DeltaPoint> = {}): DeltaPoint {
  return {
    ts: new Date(NOW).toISOString(),
    intervalMs: TICK_MS,
    calls: 0,
    errors: 0,
    timeouts: 0,
    tools: {},
    ...overrides,
  };
}

function evalTick(
  prev: McpWatchdogState,
  opts: {
    now?: number;
    health?: { reachable: boolean; status?: string };
    deltas?: DeltaPoint[];
  } = {},
): ReturnType<typeof evaluateMcpWatchdog> {
  return evaluateMcpWatchdog({
    now: opts.now ?? NOW,
    health: opts.health ?? UP,
    windowDeltas: opts.deltas ?? [],
    prev,
  });
}

/** Run `count` consecutive ticks with the same inputs, threading state. */
function evalTicks(
  count: number,
  opts: { health?: { reachable: boolean; status?: string }; deltas?: DeltaPoint[] },
  start: McpWatchdogState = defaultWatchdogState(),
): { state: McpWatchdogState; notifications: string[]; all: string[][] } {
  let state = start;
  let notifications: string[] = [];
  const all: string[][] = [];
  for (let i = 0; i < count; i++) {
    ({ state, notifications } = evalTick(state, { ...opts, now: NOW + i * TICK_MS }));
    all.push(notifications);
  }
  return { state, notifications, all };
}

describe('daemon-down rule', () => {
  it('does not alert on a single unreachable tick (restart blip)', () => {
    const { state, notifications } = evalTick(defaultWatchdogState(), { health: DOWN });
    expect(state.consecutiveDownTicks).toBe(1);
    expect(state.active).toEqual([]);
    expect(notifications).toEqual([]);
  });

  it('alerts on the 2nd consecutive unreachable tick', () => {
    const { state, notifications } = evalTicks(2, { health: DOWN });
    expect(state.consecutiveDownTicks).toBe(2);
    expect(state.active).toEqual([
      expect.objectContaining({ kind: 'daemon-down', key: 'daemon-down' }),
    ]);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toContain('unreachable');
    expect(state.lastNotifiedAt['daemon-down']).toBe(NOW + TICK_MS);
  });

  it('a reachable tick between blips resets the streak', () => {
    const first = evalTick(defaultWatchdogState(), { health: DOWN });
    const second = evalTick(first.state, { health: UP, now: NOW + TICK_MS });
    expect(second.state.consecutiveDownTicks).toBe(0);
    const third = evalTick(second.state, { health: DOWN, now: NOW + 2 * TICK_MS });
    expect(third.state.consecutiveDownTicks).toBe(1);
    expect(third.state.active).toEqual([]);
    expect(third.notifications).toEqual([]);
  });
});

describe('daemon-degraded rule', () => {
  it('does not alert on 2 consecutive degraded ticks', () => {
    const { state, notifications } = evalTicks(2, { health: DEGRADED });
    expect(state.consecutiveDegradedTicks).toBe(2);
    expect(state.active).toEqual([]);
    expect(notifications).toEqual([]);
  });

  it('alerts on the 3rd consecutive degraded tick', () => {
    const { state, notifications } = evalTicks(3, { health: DEGRADED });
    expect(state.active).toEqual([
      expect.objectContaining({ kind: 'daemon-degraded', key: 'daemon-degraded' }),
    ]);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toContain('degraded');
  });

  it('a reachable status with no parsable status counts as degraded', () => {
    const { state } = evalTick(defaultWatchdogState(), { health: { reachable: true } });
    expect(state.consecutiveDegradedTicks).toBe(1);
  });

  it('an unreachable tick breaks the degraded streak', () => {
    const two = evalTicks(2, { health: DEGRADED });
    const down = evalTick(two.state, { health: DOWN, now: NOW + 2 * TICK_MS });
    expect(down.state.consecutiveDegradedTicks).toBe(0);
    const degradedAgain = evalTick(down.state, { health: DEGRADED, now: NOW + 3 * TICK_MS });
    expect(degradedAgain.state.consecutiveDegradedTicks).toBe(1);
    expect(degradedAgain.state.active).toEqual([]);
  });
});

describe('error-spike rule', () => {
  it('does not fire at 4 errors even at a 100% error rate', () => {
    const { state, notifications } = evalTick(defaultWatchdogState(), {
      deltas: [delta({ calls: 4, errors: 4 })],
    });
    expect(state.active).toEqual([]);
    expect(notifications).toEqual([]);
  });

  it('fires at 5 errors when the rate is at/above 0.25', () => {
    const { state, notifications } = evalTick(defaultWatchdogState(), {
      deltas: [delta({ calls: 20, errors: 5 })],
    });
    expect(state.active).toEqual([
      expect.objectContaining({ kind: 'error-spike', key: 'error-spike' }),
    ]);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toContain('5 errors');
  });

  it('does not fire at a 0.24 error rate', () => {
    const { state } = evalTick(defaultWatchdogState(), {
      deltas: [delta({ calls: 100, errors: 24 })],
    });
    expect(state.active).toEqual([]);
  });

  it('fires at exactly a 0.25 error rate', () => {
    const { state } = evalTick(defaultWatchdogState(), {
      deltas: [delta({ calls: 100, errors: 25 })],
    });
    expect(state.active).toEqual([
      expect.objectContaining({ kind: 'error-spike' }),
    ]);
  });

  it('sums errors and calls across the whole window', () => {
    const { state } = evalTick(defaultWatchdogState(), {
      deltas: [
        delta({ calls: 10, errors: 3 }),
        delta({ calls: 6, errors: 2 }),
      ],
    });
    // 5 errors / 16 calls = 0.3125 ≥ 0.25 → fires.
    expect(state.active).toEqual([
      expect.objectContaining({ kind: 'error-spike' }),
    ]);
  });
});

describe('tool-failures rule', () => {
  it('does not fire at 2 errors for a tool', () => {
    const { state } = evalTick(defaultWatchdogState(), {
      deltas: [delta({ calls: 2, errors: 2, tools: { kb_query: { calls: 2, errors: 2 } } })],
    });
    expect(state.active).toEqual([]);
  });

  it('fires at 3 errors for a single tool, keyed per tool', () => {
    const { state, notifications } = evalTick(defaultWatchdogState(), {
      deltas: [delta({ calls: 3, errors: 3, tools: { kb_query: { calls: 3, errors: 3 } } })],
    });
    expect(state.active).toEqual([
      expect.objectContaining({ kind: 'tool-failures', key: 'tool-failures:kb_query' }),
    ]);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toContain('kb_query');
  });

  it('aggregates per-tool errors across the window', () => {
    const { state } = evalTick(defaultWatchdogState(), {
      deltas: [
        delta({ calls: 2, errors: 2, tools: { vault_search: { calls: 2, errors: 2 } } }),
        delta({ calls: 1, errors: 1, tools: { vault_search: { calls: 1, errors: 1 } } }),
      ],
    });
    expect(state.active).toEqual([
      expect.objectContaining({ key: 'tool-failures:vault_search' }),
    ]);
  });

  it('only alerts on the tools over the threshold', () => {
    const { state } = evalTick(defaultWatchdogState(), {
      deltas: [delta({
        calls: 5,
        errors: 4,
        tools: {
          kb_query: { calls: 3, errors: 3 },
          vault_search: { calls: 2, errors: 1 },
        },
      })],
    });
    expect(state.active.map((a) => a.key)).toEqual(['tool-failures:kb_query']);
  });
});

describe('notification cooldown', () => {
  it('suppresses re-notification while the condition persists inside the cooldown', () => {
    const first = evalTicks(2, { health: DOWN });
    expect(first.notifications).toHaveLength(1);

    const third = evalTick(first.state, { health: DOWN, now: NOW + 2 * TICK_MS });
    expect(third.notifications).toEqual([]);
    expect(third.state.active).toHaveLength(1);
    // Cooldown timestamp unchanged while suppressed.
    expect(third.state.lastNotifiedAt['daemon-down']).toBe(NOW + TICK_MS);
  });

  it('re-notifies once when the condition persists past the cooldown, refreshing it', () => {
    const first = evalTicks(2, { health: DOWN });
    const notifiedAt = first.state.lastNotifiedAt['daemon-down']!;

    const later = notifiedAt + NOTIFY_COOLDOWN_MS;
    const renotify = evalTick(first.state, { health: DOWN, now: later });
    expect(renotify.notifications).toHaveLength(1);
    expect(renotify.state.lastNotifiedAt['daemon-down']).toBe(later);

    // And the tick after that is suppressed again.
    const after = evalTick(renotify.state, { health: DOWN, now: later + TICK_MS });
    expect(after.notifications).toEqual([]);
  });

  it('one tick short of the cooldown still suppresses', () => {
    const first = evalTicks(2, { health: DOWN });
    const notifiedAt = first.state.lastNotifiedAt['daemon-down']!;
    const almost = evalTick(first.state, { health: DOWN, now: notifiedAt + NOTIFY_COOLDOWN_MS - 1 });
    expect(almost.notifications).toEqual([]);
  });
});

describe('recovery', () => {
  it('emits one recovery notice, clears the alert, and deletes the cooldown', () => {
    const alerting = evalTicks(2, { health: DOWN });
    const recovered = evalTick(alerting.state, { health: UP, now: NOW + 2 * TICK_MS });

    expect(recovered.state.active).toEqual([]);
    expect(recovered.notifications).toHaveLength(1);
    expect(recovered.notifications[0]).toMatch(/^✅ recovered: /);
    expect(recovered.state.lastNotifiedAt['daemon-down']).toBeUndefined();

    // Next healthy tick: no repeat of the recovery notice.
    const quiet = evalTick(recovered.state, { health: UP, now: NOW + 3 * TICK_MS });
    expect(quiet.notifications).toEqual([]);
  });

  it('names the recovered tool in a tool-failures recovery', () => {
    const failing = evalTick(defaultWatchdogState(), {
      deltas: [delta({ calls: 3, errors: 3, tools: { kb_query: { calls: 3, errors: 3 } } })],
    });
    const recovered = evalTick(failing.state, { deltas: [], now: NOW + TICK_MS });
    expect(recovered.notifications).toEqual(['✅ recovered: MCP tool "kb_query" no longer failing']);
  });

  it('re-alerts immediately when a recovered condition re-fires (cooldown reset)', () => {
    const spike = [delta({ calls: 10, errors: 5 })];
    const firing = evalTick(defaultWatchdogState(), { deltas: spike });
    expect(firing.notifications).toHaveLength(1);

    const recovered = evalTick(firing.state, { deltas: [], now: NOW + TICK_MS });
    expect(recovered.notifications[0]).toMatch(/^✅ recovered: /);

    // Two minutes after the original notification — far inside what the 6h
    // cooldown would have been had recovery not deleted it.
    const refire = evalTick(recovered.state, { deltas: spike, now: NOW + 2 * TICK_MS });
    expect(refire.notifications).toHaveLength(1);
    expect(refire.notifications[0]).toContain('error spike');
    expect(refire.state.lastNotifiedAt['error-spike']).toBe(NOW + 2 * TICK_MS);
    // A fresh alert entry — firstDetectedAt is the re-fire time, not the original.
    expect(refire.state.active[0]?.firstDetectedAt).toBe(new Date(NOW + 2 * TICK_MS).toISOString());
  });
});

describe('state transitions', () => {
  it('preserves firstDetectedAt and bumps lastDetectedAt while a condition persists', () => {
    const first = evalTicks(2, { health: DOWN });
    const alert = first.state.active[0]!;
    expect(alert.firstDetectedAt).toBe(new Date(NOW + TICK_MS).toISOString());
    expect(alert.lastDetectedAt).toBe(new Date(NOW + TICK_MS).toISOString());

    const next = evalTick(first.state, { health: DOWN, now: NOW + 2 * TICK_MS });
    const persisted = next.state.active[0]!;
    expect(persisted.firstDetectedAt).toBe(new Date(NOW + TICK_MS).toISOString());
    expect(persisted.lastDetectedAt).toBe(new Date(NOW + 2 * TICK_MS).toISOString());
  });

  it('tracks independent alerts with independent cooldowns', () => {
    const deltas = [delta({
      calls: 10,
      errors: 5,
      tools: { kb_query: { calls: 5, errors: 3 } },
    })];
    const both = evalTick(defaultWatchdogState(), { deltas });
    expect(both.state.active.map((a) => a.key).sort()).toEqual([
      'error-spike',
      'tool-failures:kb_query',
    ]);
    expect(both.notifications).toHaveLength(2);

    // The tool recovers; the spike persists → exactly one recovery notice,
    // spike stays active and suppressed.
    const toolRecovers = evalTick(both.state, {
      deltas: [delta({ calls: 10, errors: 5 })],
      now: NOW + TICK_MS,
    });
    expect(toolRecovers.state.active.map((a) => a.key)).toEqual(['error-spike']);
    expect(toolRecovers.notifications).toEqual(['✅ recovered: MCP tool "kb_query" no longer failing']);
    expect(toolRecovers.state.lastNotifiedAt['error-spike']).toBe(NOW);
    expect(toolRecovers.state.lastNotifiedAt['tool-failures:kb_query']).toBeUndefined();
  });

  it('does not mutate the previous state (pure function)', () => {
    const prev = evalTicks(2, { health: DOWN }).state;
    const snapshot = structuredClone(prev);
    evalTick(prev, { health: UP, now: NOW + 2 * TICK_MS });
    evalTick(prev, { health: DOWN, now: NOW + 2 * TICK_MS });
    expect(prev).toEqual(snapshot);
  });

  it('emits no alerts and no notifications on a fully healthy tick', () => {
    const { state, notifications } = evalTick(defaultWatchdogState(), {
      deltas: [delta({ calls: 50, errors: 1, tools: { kb_query: { calls: 50, errors: 1 } } })],
    });
    expect(state).toEqual(defaultWatchdogState());
    expect(notifications).toEqual([]);
  });
});
