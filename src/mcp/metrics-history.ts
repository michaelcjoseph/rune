/**
 * Daemon-side MCP metrics persistence (MCP monitoring redesign).
 *
 * The MCP daemon is the SOLE writer of `logs/rune-mcp-metrics-history.jsonl`:
 * one JSONL record per flush tick (default 60s), written even when idle so
 * timeline gaps reliably mean "daemon down". Counters are CUMULATIVE since
 * boot; readers compute deltas, treating a bootId change or counter
 * regression as a restart boundary.
 *
 * Fail-safe by design: append and compaction errors are logged, never
 * thrown — metrics persistence must never take down the daemon.
 */

import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createLogger } from '../utils/logger.js';
import type { McpMetricsSnapshot } from './metrics.js';

const log = createLogger('mcp-metrics-history');

const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_RETENTION_DAYS = 14;
const COMPACTION_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** ONE boot id per process: every history record this process writes carries
 *  it, and the daemon /health reports the same value (via {@link getBootId})
 *  so readers can correlate the two. */
const BOOT_ID = randomUUID();

/** The process-wide boot id — stable for the lifetime of this process. */
export function getBootId(): string {
  return BOOT_ID;
}

/** One flush-tick record. Counters are cumulative since boot. */
export type McpMetricsHistoryRecord = {
  ts: string;                // ISO
  bootId: string;            // randomUUID() per process
  uptimeSec: number;
  activeSessions: number;
  totals: { calls: number; errors: number; timeouts: number };
  tools: Record<string, {
    calls: number;
    errors: number;
    timeouts: number;
    p50: number | null;
    p95: number | null;
    p99: number | null;
  }>;
};

/** Restart-aware per-interval delta — the shared contract between the
 *  webview history reader (which computes these from consecutive records)
 *  and the watchdog (which consumes a trailing window of them). Defined HERE
 *  so both sides can import it in parallel. */
export type DeltaPoint = {
  ts: string;
  intervalMs: number;
  calls: number;
  errors: number;
  timeouts: number;
  tools: Record<string, { calls: number; errors: number }>;
};

export interface StartMcpMetricsFlushOpts {
  file: string;
  getSnapshot: () => McpMetricsSnapshot;
  getActiveSessionCount: () => number;
  /** Flush cadence — default 60_000ms. */
  intervalMs?: number;
  /** Compaction retention — default 14 days. */
  retentionDays?: number;
}

export interface McpMetricsFlushHandle {
  /** Final flush + clear the timers (idempotent). */
  stop(): void;
  /** Append one record immediately (same fail-safe path as the timer). */
  flushNow(): void;
}

/**
 * Start the periodic metrics flusher. Compacts the history file immediately
 * (dropping records older than the retention window) and then appends one
 * record per tick. Timers are unref'd — they never keep the process alive;
 * `stop()` performs a final flush so shutdown is always recorded.
 */
export function startMcpMetricsFlush(opts: StartMcpMetricsFlushOpts): McpMetricsFlushHandle {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const retentionDays = opts.retentionDays ?? DEFAULT_RETENTION_DAYS;

  function flushNow(): void {
    try {
      const snapshot = opts.getSnapshot();
      const record: McpMetricsHistoryRecord = {
        ts: new Date().toISOString(),
        bootId: BOOT_ID,
        uptimeSec: Math.round(process.uptime()),
        activeSessions: opts.getActiveSessionCount(),
        totals: {
          calls: snapshot.totals.calls,
          errors: snapshot.totals.errors,
          timeouts: snapshot.totals.timeouts,
        },
        tools: Object.fromEntries(
          Object.entries(snapshot.tools).map(([name, tool]) => [name, {
            calls: tool.calls,
            errors: tool.errors,
            timeouts: tool.timeouts,
            p50: tool.latencyMs.p50,
            p95: tool.latencyMs.p95,
            p99: tool.latencyMs.p99,
          }]),
        ),
      };
      appendFileSync(opts.file, `${JSON.stringify(record)}\n`);
    } catch (err) {
      // Fail-safe: metrics persistence must never throw into the daemon.
      log.error('MCP metrics history append failed', { error: (err as Error).message });
    }
  }

  function compact(): void {
    try {
      if (!existsSync(opts.file)) return;
      const cutoffMs = Date.now() - retentionDays * DAY_MS;
      const kept: string[] = [];
      for (const line of readFileSync(opts.file, 'utf8').split('\n')) {
        const trimmed = line.trim();
        if (trimmed === '') continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          continue; // corrupt line — drop it
        }
        const ts = (parsed as { ts?: unknown }).ts;
        if (typeof ts !== 'string') continue;
        const tsMs = Date.parse(ts);
        if (!Number.isFinite(tsMs) || tsMs < cutoffMs) continue;
        kept.push(trimmed);
      }
      // Atomic temp-then-rename (mcp-oauth-store.ts pattern) so a crash
      // mid-compaction can never truncate the live history file.
      const tmp = `${opts.file}.tmp`;
      writeFileSync(tmp, kept.length > 0 ? `${kept.join('\n')}\n` : '');
      renameSync(tmp, opts.file);
    } catch (err) {
      log.error('MCP metrics history compaction failed', { error: (err as Error).message });
    }
  }

  compact();

  const flushTimer = setInterval(flushNow, intervalMs);
  flushTimer.unref();
  const compactionTimer = setInterval(compact, COMPACTION_INTERVAL_MS);
  compactionTimer.unref();

  let stopped = false;
  return {
    flushNow,
    stop(): void {
      if (stopped) return;
      stopped = true;
      clearInterval(flushTimer);
      clearInterval(compactionTimer);
      flushNow();
    },
  };
}
