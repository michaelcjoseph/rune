/**
 * MCP watchdog — pure alert-evaluation core (MCP monitoring redesign).
 *
 * Wave 0 TYPES-ONLY stub: the exported types and signatures are the FINAL
 * contract; Wave 1f implements {@link evaluateMcpWatchdog} (rule matrix,
 * per-key 6h notify cooldown, recovery notices) plus the companion
 * mcp-watchdog-store.ts / mcp-watchdog-runner.ts modules. Runs in the MAIN
 * process (the daemon has no Telegram/scheduler); state persists to
 * config.MCP_WATCHDOG_STATE_FILE.
 */

import type { DeltaPoint } from '../mcp/metrics-history.js';

export type McpAlertKind = 'daemon-down' | 'daemon-degraded' | 'error-spike' | 'tool-failures';

export type McpAlert = {
  kind: McpAlertKind;
  /** Dedupe/cooldown key — the kind, plus the tool name for tool-failures. */
  key: string;
  message: string;
  firstDetectedAt: string;
  lastDetectedAt: string;
};

export type McpWatchdogState = {
  consecutiveDownTicks: number;
  consecutiveDegradedTicks: number;
  active: McpAlert[];
  /** Per-alert-key ms-epoch of the last Telegram notification (cooldown). */
  lastNotifiedAt: Record<string, number>;
};

export function defaultWatchdogState(): McpWatchdogState {
  return {
    consecutiveDownTicks: 0,
    consecutiveDegradedTicks: 0,
    active: [],
    lastNotifiedAt: {},
  };
}

/**
 * Evaluate one watchdog tick. Wave 1f implements the rules; this Wave 0 stub
 * is a no-op that passes the previous state through and never notifies.
 */
export function evaluateMcpWatchdog(input: {
  now: number;
  health: { reachable: boolean; status?: string };
  windowDeltas: DeltaPoint[];
  prev: McpWatchdogState;
}): { state: McpWatchdogState; notifications: string[] } {
  return { state: input.prev, notifications: [] };
}
