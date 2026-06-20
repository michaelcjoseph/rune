import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupervisedRun } from '../intent/supervision.js';
import type { BusEvent, NotificationBus } from '../transport/notification-bus.js';

const store = vi.hoisted(() => ({
  readAllRuns: vi.fn(),
  upsertRun: vi.fn(),
}));

const mutations = vi.hoisted(() => ({
  activeRuns: new Map<string, unknown>(),
  cancelMutation: vi.fn(() => ({ ok: false, reason: 'not-found' })),
}));

vi.mock('../utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../config.js', () => ({
  default: {
    TELEGRAM_USER_ID: 4242,
    SUPERVISED_RUNS_FILE: '/test/logs/supervised-runs.json',
    PARKED_RUN_NUDGE_AFTER_MS: 60 * 60 * 1000,
    WORK_RUN_QUIET_CANCEL_AFTER_MS: 60 * 60 * 1000,
    WORK_RUN_MAX_RUNTIME_MS: 24 * 60 * 60 * 1000,
  },
}));

vi.mock('./supervision-store.js', () => ({
  readAllRuns: store.readAllRuns,
  upsertRun: store.upsertRun,
}));

vi.mock('../transport/mutations.js', () => ({
  activeRuns: mutations.activeRuns,
  cancelMutation: mutations.cancelMutation,
}));

const { startStallCheck, stopStallCheck } = await import('./stall-check-runner.js');

const NOW = Date.parse('2026-06-19T12:00:00.000Z');

function run(id: string, overrides: Partial<SupervisedRun> = {}): SupervisedRun {
  return {
    id,
    product: 'store-source',
    project: '15-stall-check',
    status: 'running',
    startedAt: new Date(NOW - 60_000).toISOString(),
    lastHeartbeatAt: new Date(NOW - 10 * 60_000).toISOString(),
    ...overrides,
  };
}

function installIntervalCapture(): { fireTick: () => void } {
  let tick: (() => void) | undefined;
  vi.spyOn(globalThis, 'setInterval').mockImplementation(((handler: Parameters<typeof setInterval>[0]) => {
    tick = handler as () => void;
    return { unref: vi.fn() } as unknown as ReturnType<typeof setInterval>;
  }) as typeof setInterval);
  vi.spyOn(globalThis, 'clearInterval').mockImplementation(() => undefined);

  return {
    fireTick: () => {
      expect(tick, 'startStallCheck must install a periodic tick').toBeDefined();
      tick!();
    },
  };
}

function collectBusEvents(): { publish: (event: BusEvent) => void; events: BusEvent[] } {
  const events: BusEvent[] = [];
  return {
    events,
    publish: (event) => {
      events.push(event);
    },
  };
}

describe('startStallCheck — supervised-store source of truth', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    store.readAllRuns.mockReset();
    store.upsertRun.mockReset();
    mutations.cancelMutation.mockClear();
    mutations.activeRuns.clear();
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
  });

  afterEach(() => {
    stopStallCheck();
    vi.restoreAllMocks();
  });

  it('nudges a stalled run read from the persisted supervised store even when activeRuns is empty', () => {
    const { fireTick } = installIntervalCapture();
    const bus = collectBusEvents();
    store.readAllRuns.mockReturnValue([
      run('persisted-stalled-0001', {
        project: 'persisted-only',
      }),
    ]);

    startStallCheck(bus as unknown as NotificationBus);
    fireTick();

    expect(store.readAllRuns).toHaveBeenCalledWith('/test/logs/supervised-runs.json');
    expect(mutations.activeRuns.size).toBe(0);
    expect(bus.events).toEqual([
      expect.objectContaining({
        kind: 'message',
        userId: 4242,
        text: expect.stringContaining('store-source/persisted-only'),
      }),
    ]);
  });

  it('does not nudge a stale in-memory-only run when the persisted supervised store is empty', () => {
    const { fireTick } = installIntervalCapture();
    const bus = collectBusEvents();
    store.readAllRuns.mockReturnValue([]);
    mutations.activeRuns.set('memory-only-stalled-0001', {
      descriptor: { id: 'memory-only-stalled-0001' },
      run: run('memory-only-stalled-0001', { project: 'memory-only' }),
    });

    startStallCheck(bus as unknown as NotificationBus);
    fireTick();

    expect(store.readAllRuns).toHaveBeenCalledWith('/test/logs/supervised-runs.json');
    expect(bus.events.filter((event) => event.kind === 'message')).toEqual([]);
  });
});
