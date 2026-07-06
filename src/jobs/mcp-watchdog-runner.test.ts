/**
 * Tests for src/jobs/mcp-watchdog-runner.ts — the setInterval glue. All I/O
 * seams (probe, clock, store, history reader) are injected; the interval is
 * captured so ticks fire deterministically without timers or network.
 */

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { BusEvent, NotificationBus } from '../transport/notification-bus.js';
import { defaultWatchdogState, type McpWatchdogState } from './mcp-watchdog.js';

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
    MCP_WATCHDOG_STATE_FILE: '/test/logs/mcp-watchdog-state.json',
    RUNE_MCP_METRICS_HISTORY_FILE: '/test/logs/rune-mcp-metrics-history.jsonl',
    RUNE_MCP_HOST: '127.0.0.1',
    RUNE_MCP_PORT: 3848,
    VAULT_DIR: '/test/vault',
    WORKSPACE_DIR: '/test/workspace',
  },
  PROJECT_ROOT: '/test/project',
}));

const { startMcpWatchdog, stopMcpWatchdog } = await import('./mcp-watchdog-runner.js');

const NOW = Date.parse('2026-07-06T12:00:00.000Z');

function installIntervalCapture(): {
  fireTick: () => Promise<void>;
  setIntervalSpy: MockInstance;
  clearIntervalSpy: MockInstance;
} {
  let tick: (() => unknown) | undefined;
  const setIntervalSpy = vi
    .spyOn(globalThis, 'setInterval')
    .mockImplementation(((handler: Parameters<typeof setInterval>[0]) => {
      tick = handler as () => unknown;
      return { unref: vi.fn() } as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval);
  const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval').mockImplementation(() => undefined);

  return {
    setIntervalSpy,
    clearIntervalSpy,
    fireTick: async () => {
      expect(tick, 'startMcpWatchdog must install a periodic tick').toBeDefined();
      await tick!();
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

function makeDeps(overrides: {
  probe?: () => Promise<{ reachable: boolean; status?: string }>;
  loadState?: (file: string) => McpWatchdogState;
  saveState?: ReturnType<typeof vi.fn>;
  readHistory?: ReturnType<typeof vi.fn>;
} = {}) {
  const saveState = overrides.saveState ?? vi.fn();
  const readHistory = overrides.readHistory ?? vi.fn(() => []);
  return {
    deps: {
      probe: overrides.probe ?? (async () => ({ reachable: true, status: 'ok' })),
      now: () => NOW,
      loadState: overrides.loadState ?? (() => defaultWatchdogState()),
      saveState: saveState as (file: string, state: McpWatchdogState) => void,
      readHistory: readHistory as never,
    },
    saveState,
    readHistory,
  };
}

describe('startMcpWatchdog', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    stopMcpWatchdog();
    vi.restoreAllMocks();
  });

  it('start is idempotent — restarting clears the previous timer, stop is a no-op when idle', () => {
    const { setIntervalSpy, clearIntervalSpy } = installIntervalCapture();
    const bus = collectBusEvents();

    startMcpWatchdog(bus as unknown as NotificationBus, makeDeps().deps);
    startMcpWatchdog(bus as unknown as NotificationBus, makeDeps().deps);
    expect(setIntervalSpy).toHaveBeenCalledTimes(2);
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);

    stopMcpWatchdog();
    expect(clearIntervalSpy).toHaveBeenCalledTimes(2);
    stopMcpWatchdog();
    expect(clearIntervalSpy).toHaveBeenCalledTimes(2);
  });

  it('a throwing probe does not kill the interval — the next tick still runs', async () => {
    const { fireTick } = installIntervalCapture();
    const bus = collectBusEvents();
    const probe = vi
      .fn<() => Promise<{ reachable: boolean; status?: string }>>()
      .mockRejectedValueOnce(new Error('connect ECONNREFUSED'))
      .mockResolvedValue({ reachable: true, status: 'ok' });
    const { deps, saveState } = makeDeps({ probe });

    startMcpWatchdog(bus as unknown as NotificationBus, deps);

    await expect(fireTick()).resolves.toBeUndefined();
    expect(saveState).not.toHaveBeenCalled(); // failed tick short-circuits

    await fireTick();
    expect(probe).toHaveBeenCalledTimes(2);
    expect(saveState).toHaveBeenCalledTimes(1); // recovered tick completes
  });

  it('a throwing saveState does not suppress the tick notifications', async () => {
    const { fireTick } = installIntervalCapture();
    const bus = collectBusEvents();
    const { deps } = makeDeps({
      probe: async () => ({ reachable: false }),
      loadState: () => ({ ...defaultWatchdogState(), consecutiveDownTicks: 1 }),
      saveState: vi.fn(() => {
        throw new Error('disk full');
      }),
    });

    startMcpWatchdog(bus as unknown as NotificationBus, deps);
    await fireTick();

    expect(bus.events).toHaveLength(1);
  });

  it('publishes each notification through the injected bus as a Telegram message', async () => {
    const { fireTick } = installIntervalCapture();
    const bus = collectBusEvents();
    const { deps } = makeDeps({
      probe: async () => ({ reachable: false }),
      // Second consecutive down tick → daemon-down alerts on THIS tick.
      loadState: () => ({ ...defaultWatchdogState(), consecutiveDownTicks: 1 }),
    });

    startMcpWatchdog(bus as unknown as NotificationBus, deps);
    await fireTick();

    expect(bus.events).toEqual([
      expect.objectContaining({
        kind: 'message',
        userId: 4242,
        text: expect.stringContaining('unreachable'),
      }),
    ]);
  });

  it('scrubs absolute paths from notification text before publishing', async () => {
    const { fireTick } = installIntervalCapture();
    const bus = collectBusEvents();
    const { deps } = makeDeps({
      // A hostile /health status that embeds a host path; the degraded alert
      // interpolates it into the message.
      probe: async () => ({ reachable: true, status: 'broken: /test/vault/secrets' }),
      loadState: () => ({ ...defaultWatchdogState(), consecutiveDegradedTicks: 2 }),
    });

    startMcpWatchdog(bus as unknown as NotificationBus, deps);
    await fireTick();

    expect(bus.events).toHaveLength(1);
    const text = (bus.events[0] as { text: string }).text;
    expect(text).not.toContain('/test/vault');
    expect(text).toContain('<vault>');
  });

  it('reads the metrics history with a ~16 min window and saves state every tick', async () => {
    const { fireTick } = installIntervalCapture();
    const bus = collectBusEvents();
    const { deps, saveState, readHistory } = makeDeps();

    startMcpWatchdog(bus as unknown as NotificationBus, deps);
    await fireTick();
    await fireTick();

    expect(readHistory).toHaveBeenCalledWith('/test/logs/rune-mcp-metrics-history.jsonl', {
      sinceMs: NOW - 16 * 60_000,
    });
    expect(saveState).toHaveBeenCalledTimes(2);
    expect(saveState).toHaveBeenCalledWith(
      '/test/logs/mcp-watchdog-state.json',
      expect.objectContaining({ consecutiveDownTicks: 0, active: [] }),
    );
    expect(bus.events).toEqual([]); // healthy ticks publish nothing
  });
});
