/**
 * Persistent store for the MCP watchdog's {@link McpWatchdogState} — current
 * state only (streak counters, active alerts, per-key notify cooldowns), not
 * an event history. One JSON file at config.MCP_WATCHDOG_STATE_FILE, written
 * once per watchdog tick by mcp-watchdog-runner.ts.
 *
 * Tolerant by design on BOTH sides: a missing/corrupt/wrong-shape file loads
 * as `defaultWatchdogState()` (worst case the watchdog re-counts a streak and
 * maybe re-notifies once), and a failed save is logged, never thrown —
 * persistence failures must never break the watchdog tick.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { createLogger } from '../utils/logger.js';
import {
  defaultWatchdogState,
  type McpAlert,
  type McpAlertKind,
  type McpWatchdogState,
} from './mcp-watchdog.js';

const log = createLogger('mcp-watchdog-store');

const VALID_KINDS: ReadonlySet<McpAlertKind> = new Set<McpAlertKind>([
  'daemon-down',
  'daemon-degraded',
  'error-spike',
  'tool-failures',
]);

/**
 * Load the persisted watchdog state. Missing file, malformed JSON, or a value
 * that doesn't match the {@link McpWatchdogState} shape all return
 * `defaultWatchdogState()` — never throws.
 */
export function loadWatchdogState(file: string): McpWatchdogState {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return defaultWatchdogState();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    log.warn('loadWatchdogState: malformed JSON; starting fresh', { error: (err as Error).message });
    return defaultWatchdogState();
  }

  if (!isWatchdogState(parsed)) {
    log.warn('loadWatchdogState: unexpected shape; starting fresh');
    return defaultWatchdogState();
  }
  return parsed;
}

/**
 * Persist the watchdog state. Write failures are logged and swallowed — the
 * watchdog tick must survive a full disk / missing logs dir; the in-memory
 * evaluation already happened and the next tick will retry the write.
 */
export function saveWatchdogState(file: string, state: McpWatchdogState): void {
  try {
    writeFileSync(file, JSON.stringify(state, null, 2), 'utf8');
  } catch (err) {
    log.error('saveWatchdogState: failed to persist state', { error: (err as Error).message });
  }
}

function isWatchdogState(value: unknown): value is McpWatchdogState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (typeof v['consecutiveDownTicks'] !== 'number') return false;
  if (typeof v['consecutiveDegradedTicks'] !== 'number') return false;
  if (!Array.isArray(v['active']) || !v['active'].every(isAlert)) return false;
  const notified = v['lastNotifiedAt'];
  if (!notified || typeof notified !== 'object' || Array.isArray(notified)) return false;
  if (!Object.values(notified).every((ms) => typeof ms === 'number')) return false;
  return true;
}

function isAlert(value: unknown): value is McpAlert {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v['kind'] === 'string' &&
    VALID_KINDS.has(v['kind'] as McpAlertKind) &&
    typeof v['key'] === 'string' &&
    typeof v['message'] === 'string' &&
    typeof v['firstDetectedAt'] === 'string' &&
    typeof v['lastDetectedAt'] === 'string'
  );
}
