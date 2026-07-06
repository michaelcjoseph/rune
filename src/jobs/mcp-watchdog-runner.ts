/**
 * setInterval glue around `evaluateMcpWatchdog` — probes the MCP daemon's
 * /health endpoint, reads the trailing metrics-history window, evaluates the
 * alert rules, persists state, and publishes notifications to the Telegram
 * bus. Split from `mcp-watchdog.ts` so the pure core stays test-importable
 * without the runtime config bootstrap (which requires TELEGRAM_BOT_TOKEN,
 * VAULT_DIR, …).
 *
 * Runs in the MAIN process (the daemon has no Telegram/scheduler). Called
 * from `src/index.ts` after `startStallCheck`; torn down in `shutdown()`.
 */

import config from '../config.js';
import { createLogger } from '../utils/logger.js';
import type { NotificationBus } from '../transport/notification-bus.js';
import { scrubAbsolutePaths } from '../utils/sanitize-paths.js';
import { deltaSeries, readMcpMetricsHistory } from '../mcp/metrics-history.js';
import { evaluateMcpWatchdog, type McpWatchdogState } from './mcp-watchdog.js';
import { loadWatchdogState, saveWatchdogState } from './mcp-watchdog-store.js';

const log = createLogger('mcp-watchdog-runner');

export const TICK_INTERVAL_MS = 60_000;
/** /health probe timeout — well under the tick interval. */
const HEALTH_TIMEOUT_MS = 2_000;
/** Trailing metrics window: the ~15 min the rules evaluate, widened by one
 *  flush interval because deltaSeries treats the first record as baseline-only. */
const METRICS_WINDOW_MS = 16 * 60_000;

export type McpHealthProbe = () => Promise<{ reachable: boolean; status?: string }>;

/** Injectable seams so tests need no network, timers, or filesystem. */
export interface McpWatchdogDeps {
  probe?: McpHealthProbe;
  now?: () => number;
  loadState?: (file: string) => McpWatchdogState;
  saveState?: (file: string, state: McpWatchdogState) => void;
  readHistory?: typeof readMcpMetricsHistory;
}

let timer: ReturnType<typeof setInterval> | null = null;

/**
 * Probe the daemon's /health. Any HTTP response counts as reachable (the
 * degraded rule handles a non-ok `status`); a network error or a >2s hang is
 * unreachable. `status` is parsed from the JSON body when present.
 */
async function probeDaemonHealth(): Promise<{ reachable: boolean; status?: string }> {
  try {
    const res = await fetch(`http://${config.RUNE_MCP_HOST}:${config.RUNE_MCP_PORT}/health`, {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    let status: string | undefined;
    try {
      const body = (await res.json()) as { status?: unknown };
      if (typeof body?.status === 'string') status = body.status;
    } catch {
      // Unparseable body — reachable, but status stays undefined (degraded).
    }
    return { reachable: true, ...(status !== undefined ? { status } : {}) };
  } catch {
    return { reachable: false };
  }
}

/**
 * Start the periodic MCP watchdog. Idempotent — calling twice clears the
 * existing timer first. Timer is unref()'d so it doesn't keep the process
 * alive on shutdown.
 */
export function startMcpWatchdog(bus: NotificationBus, deps: McpWatchdogDeps = {}): void {
  if (timer) stopMcpWatchdog();

  const probe = deps.probe ?? probeDaemonHealth;
  const nowFn = deps.now ?? Date.now;
  const loadState = deps.loadState ?? loadWatchdogState;
  const saveState = deps.saveState ?? saveWatchdogState;
  const readHistory = deps.readHistory ?? readMcpMetricsHistory;

  // The whole tick is guarded: the store load/save and bus.publish are
  // internally fail-safe, but an unexpected throw (probe bug, OOM, a future
  // refactor) from a setInterval callback would otherwise hit
  // process.uncaughtException / unhandledRejection and crash the server.
  // Better to log and skip a tick. The try/catch covers the awaits too, so
  // the promise this async tick returns can never reject.
  const tick = async (): Promise<void> => {
    try {
      const now = nowFn();
      const health = await probe();
      const records = readHistory(config.RUNE_MCP_METRICS_HISTORY_FILE, {
        sinceMs: now - METRICS_WINDOW_MS,
      });
      const { state, notifications } = evaluateMcpWatchdog({
        now,
        health,
        windowDeltas: deltaSeries(records),
        prev: loadState(config.MCP_WATCHDOG_STATE_FILE),
      });
      saveWatchdogStateSafe(saveState, state);
      for (const text of notifications) {
        // Defensive scrub — alert texts are built path-free, but they reach
        // Telegram, so never trust that invariant alone.
        bus.publish({
          kind: 'message',
          userId: config.TELEGRAM_USER_ID,
          text: scrubAbsolutePaths(text),
        });
      }
    } catch (err) {
      log.warn('mcp-watchdog tick failed', { error: (err as Error).message });
    }
  };

  timer = setInterval(tick, TICK_INTERVAL_MS);
  timer.unref();
  log.info('MCP watchdog started', { intervalMs: TICK_INTERVAL_MS });
}

/** Persistence is fail-safe in the default store already; this guards an
 *  injected saveState so a test double (or future store) throwing cannot
 *  suppress the tick's notifications. */
function saveWatchdogStateSafe(
  saveState: (file: string, state: McpWatchdogState) => void,
  state: McpWatchdogState,
): void {
  try {
    saveState(config.MCP_WATCHDOG_STATE_FILE, state);
  } catch (err) {
    log.warn('mcp-watchdog state save failed', { error: (err as Error).message });
  }
}

export function stopMcpWatchdog(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
  log.info('MCP watchdog stopped');
}
