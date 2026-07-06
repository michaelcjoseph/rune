/**
 * MCP watchdog — pure alert-evaluation core (MCP monitoring redesign).
 *
 * Evaluates one watchdog tick: daemon reachability/degradation streaks and
 * trailing-window error/tool-failure rates → active-alert lifecycle + the
 * Telegram notification texts to emit (per-key 6h cooldown, one-time recovery
 * notices). Pure by design — no I/O, no Date.now(); everything comes from
 * `input` so the rule matrix is exhaustively unit-testable. Runs in the MAIN
 * process (the daemon has no Telegram/scheduler); state persists to
 * config.MCP_WATCHDOG_STATE_FILE via mcp-watchdog-store.ts, driven by
 * mcp-watchdog-runner.ts.
 *
 * INVARIANT: notification texts reach Telegram — they must never contain
 * absolute paths (the runner also scrubs defensively via scrubAbsolutePaths).
 */

import type { DeltaPoint } from '../mcp/metrics-history.js';

/** Consecutive unreachable ticks before `daemon-down` fires — one-tick blips
 *  from daemon restarts must not alert. */
const DOWN_TICKS_THRESHOLD = 2;
/** Consecutive reachable-but-not-ok ticks before `daemon-degraded` fires. */
const DEGRADED_TICKS_THRESHOLD = 3;
/** `error-spike` needs BOTH: at least this many errors in the window… */
const ERROR_SPIKE_MIN_ERRORS = 5;
/** …and at least this error rate (errors/calls) over the same window. */
const ERROR_SPIKE_MIN_RATE = 0.25;
/** `tool-failures` fires per tool at this many errors in the window. */
const TOOL_FAILURE_MIN_ERRORS = 3;
/** Per-alert-key re-notification cooldown while a condition persists. */
export const NOTIFY_COOLDOWN_MS = 6 * 60 * 60 * 1000;

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

/** A condition that fires this tick — becomes/updates an active McpAlert. */
type FiringCondition = {
  kind: McpAlertKind;
  key: string;
  message: string;
  /** Short "what" for the one-time "✅ recovered: <what>" notice. */
  recoveredWhat: string;
};

/**
 * Evaluate one watchdog tick.
 *
 * Alert lifecycle: a condition entering `active` sets `firstDetectedAt`; while
 * it persists, `lastDetectedAt` (and the message counts) are refreshed each
 * tick. A firing condition notifies unless its key was notified within
 * {@link NOTIFY_COOLDOWN_MS}; persisting past the cooldown re-notifies once
 * and refreshes the cooldown. A condition that stops firing is removed from
 * `active`, emits ONE "✅ recovered: <what>" notice, and its cooldown entry is
 * DELETED so an immediate re-fire re-alerts right away.
 */
export function evaluateMcpWatchdog(input: {
  now: number;
  health: { reachable: boolean; status?: string };
  windowDeltas: DeltaPoint[];
  prev: McpWatchdogState;
}): { state: McpWatchdogState; notifications: string[] } {
  const { now, health, windowDeltas, prev } = input;
  const nowIso = new Date(now).toISOString();

  // --- Streak counters -----------------------------------------------------
  const consecutiveDownTicks = health.reachable ? 0 : prev.consecutiveDownTicks + 1;
  const degradedThisTick = health.reachable && health.status !== 'ok';
  const consecutiveDegradedTicks = degradedThisTick ? prev.consecutiveDegradedTicks + 1 : 0;

  // --- Window aggregates ---------------------------------------------------
  let totalCalls = 0;
  let totalErrors = 0;
  const toolErrors = new Map<string, number>();
  for (const point of windowDeltas) {
    totalCalls += point.calls;
    totalErrors += point.errors;
    for (const [name, tool] of Object.entries(point.tools)) {
      if (tool.errors > 0) toolErrors.set(name, (toolErrors.get(name) ?? 0) + tool.errors);
    }
  }

  // --- Which conditions fire this tick (deterministic order) ----------------
  const firing: FiringCondition[] = [];

  if (consecutiveDownTicks >= DOWN_TICKS_THRESHOLD) {
    firing.push({
      kind: 'daemon-down',
      key: 'daemon-down',
      message: `🚨 MCP daemon unreachable for ${consecutiveDownTicks}+ minutes — check \`npm run mcp:start\` / launchd.`,
      recoveredWhat: 'MCP daemon reachable again',
    });
  }

  if (consecutiveDegradedTicks >= DEGRADED_TICKS_THRESHOLD) {
    const statusLabel = health.status ?? 'unknown';
    firing.push({
      kind: 'daemon-degraded',
      key: 'daemon-degraded',
      message: `⚠️ MCP daemon degraded (status "${statusLabel}") for ${consecutiveDegradedTicks}+ minutes — check the daemon /health output and logs.`,
      recoveredWhat: 'MCP daemon status back to ok',
    });
  }

  // Integer-safe rate check: errors/calls >= RATE ⇔ errors >= RATE * calls.
  // Also fires when calls is 0 but errors accrued (rate is effectively 1).
  if (totalErrors >= ERROR_SPIKE_MIN_ERRORS && totalErrors >= ERROR_SPIKE_MIN_RATE * totalCalls) {
    const pct = totalCalls > 0 ? Math.round((totalErrors / totalCalls) * 100) : 100;
    firing.push({
      kind: 'error-spike',
      key: 'error-spike',
      message: `⚠️ MCP error spike: ${totalErrors} errors across ${totalCalls} calls (${pct}%) in the last 15 min — check the daemon logs.`,
      recoveredWhat: 'MCP error rate back to normal',
    });
  }

  for (const [tool, errors] of [...toolErrors.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (errors < TOOL_FAILURE_MIN_ERRORS) continue;
    firing.push({
      kind: 'tool-failures',
      key: `tool-failures:${tool}`,
      message: `⚠️ MCP tool "${tool}" failing: ${errors} errors in the last 15 min — check the tool handler and daemon logs.`,
      recoveredWhat: `MCP tool "${tool}" no longer failing`,
    });
  }

  // --- Alert lifecycle + notifications --------------------------------------
  const prevByKey = new Map(prev.active.map((alert) => [alert.key, alert]));
  const lastNotifiedAt: Record<string, number> = { ...prev.lastNotifiedAt };
  const active: McpAlert[] = [];
  const notifications: string[] = [];

  for (const condition of firing) {
    const existing = prevByKey.get(condition.key);
    active.push({
      kind: condition.kind,
      key: condition.key,
      message: condition.message,
      firstDetectedAt: existing?.firstDetectedAt ?? nowIso,
      lastDetectedAt: nowIso,
    });

    const notifiedAt = lastNotifiedAt[condition.key];
    if (notifiedAt === undefined || now - notifiedAt >= NOTIFY_COOLDOWN_MS) {
      notifications.push(condition.message);
      lastNotifiedAt[condition.key] = now;
    }
  }

  // Recoveries: previously-active alerts whose condition stopped firing.
  const firingKeys = new Set(firing.map((c) => c.key));
  for (const alert of prev.active) {
    if (firingKeys.has(alert.key)) continue;
    notifications.push(`✅ recovered: ${recoveredWhatFor(alert)}`);
    delete lastNotifiedAt[alert.key];
  }

  return {
    state: { consecutiveDownTicks, consecutiveDegradedTicks, active, lastNotifiedAt },
    notifications,
  };
}

/** Recovery "what" derived from the ALERT (the condition no longer fires, so
 *  there is no FiringCondition to read it from). */
function recoveredWhatFor(alert: McpAlert): string {
  switch (alert.kind) {
    case 'daemon-down':
      return 'MCP daemon reachable again';
    case 'daemon-degraded':
      return 'MCP daemon status back to ok';
    case 'error-spike':
      return 'MCP error rate back to normal';
    case 'tool-failures':
      return `MCP tool "${alert.key.slice('tool-failures:'.length)}" no longer failing`;
  }
}
