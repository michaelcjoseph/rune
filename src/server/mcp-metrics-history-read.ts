/**
 * Webview-side read layer over the shared MCP metrics history (MCP
 * monitoring redesign). The daemon writes `logs/rune-mcp-metrics-history.jsonl`
 * once a minute; the cockpit polls every few seconds — so reads go through an
 * mtime+size cache, and the bucketing helpers turn restart-aware
 * {@link DeltaPoint} series into chart-ready hourly/daily/per-tool rollups.
 *
 * Parsing and delta math live in `src/mcp/metrics-history.ts` (the shared
 * contract with the daemon and the watchdog) — this module never reimplements
 * them. Everything here is pure/deterministic given (deltas, nowMs) so it is
 * directly unit-testable.
 */

import { statSync } from 'node:fs';
import {
  readMcpMetricsHistory,
  type DeltaPoint,
  type McpMetricsHistoryRecord,
} from '../mcp/metrics-history.js';
import { toChicagoDate } from '../utils/time.js';

const HOUR_MS = 60 * 60 * 1000;

export type HourlyBucket = {
  /** ISO timestamp of the bucket's start (UTC hour boundary). */
  ts: string;
  calls: number;
  errors: number;
  timeouts: number;
};

export type DailyBucket = {
  /** Chicago-local calendar date, YYYY-MM-DD. */
  date: string;
  calls: number;
  errors: number;
};

type CacheEntry = {
  mtimeMs: number;
  size: number;
  records: McpMetricsHistoryRecord[];
};

const historyCache = new Map<string, CacheEntry>();

/** Test seam — drop all cached parses. */
export function clearHistoryReadCache(): void {
  historyCache.clear();
}

/**
 * Read history records with an mtime+size cache: the file changes once per
 * flush tick (~60s), so a 5s cockpit poll re-parses only when the file
 * actually changed. The full file is parsed and cached; `sinceMs` filters the
 * cached records per call (cheap), so different windows share one parse.
 * Missing/unreadable file → `[]` (and the stale cache entry is dropped).
 */
export function readHistoryCached(
  file: string,
  opts?: { sinceMs?: number },
): McpMetricsHistoryRecord[] {
  let mtimeMs: number;
  let size: number;
  try {
    const stats = statSync(file);
    mtimeMs = stats.mtimeMs;
    size = stats.size;
  } catch {
    historyCache.delete(file);
    return [];
  }
  let entry = historyCache.get(file);
  if (!entry || entry.mtimeMs !== mtimeMs || entry.size !== size) {
    entry = { mtimeMs, size, records: readMcpMetricsHistory(file) };
    historyCache.set(file, entry);
  }
  const sinceMs = opts?.sinceMs;
  if (sinceMs === undefined) return entry.records;
  return entry.records.filter((record) => {
    const tsMs = Date.parse(record.ts);
    return Number.isFinite(tsMs) && tsMs >= sinceMs;
  });
}

/**
 * Roll deltas into one zero-filled bucket per hour for the trailing `hours`
 * hours (UTC hour boundaries — Chicago is a whole-hour offset, so hour edges
 * coincide). The last bucket is the hour containing `nowMs`; deltas outside
 * the window are dropped.
 */
export function bucketHourly(deltas: DeltaPoint[], nowMs: number, hours: number): HourlyBucket[] {
  const currentHourStart = Math.floor(nowMs / HOUR_MS) * HOUR_MS;
  const buckets: HourlyBucket[] = [];
  const byStart = new Map<number, HourlyBucket>();
  for (let i = hours - 1; i >= 0; i--) {
    const start = currentHourStart - i * HOUR_MS;
    const bucket: HourlyBucket = {
      ts: new Date(start).toISOString(),
      calls: 0,
      errors: 0,
      timeouts: 0,
    };
    buckets.push(bucket);
    byStart.set(start, bucket);
  }
  for (const delta of deltas) {
    const tsMs = Date.parse(delta.ts);
    if (!Number.isFinite(tsMs)) continue;
    const bucket = byStart.get(Math.floor(tsMs / HOUR_MS) * HOUR_MS);
    if (!bucket) continue;
    bucket.calls += delta.calls;
    bucket.errors += delta.errors;
    bucket.timeouts += delta.timeouts;
  }
  return buckets;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * Roll deltas into one zero-filled bucket per America/Chicago calendar day
 * for the trailing `days` days, ending with the Chicago date of `nowMs`.
 * Each delta is assigned to the Chicago-local date of its timestamp; day
 * enumeration uses pure calendar arithmetic (UTC-anchored) so DST
 * transitions can never skip or duplicate a date.
 */
export function bucketDaily(deltas: DeltaPoint[], nowMs: number, days: number): DailyBucket[] {
  const today = toChicagoDate(new Date(nowMs));
  const [year, month, day] = today.split('-').map(Number) as [number, number, number];
  const buckets: DailyBucket[] = [];
  const byDate = new Map<string, DailyBucket>();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(year, month - 1, day - i));
    const date = `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
    const bucket: DailyBucket = { date, calls: 0, errors: 0 };
    buckets.push(bucket);
    byDate.set(date, bucket);
  }
  for (const delta of deltas) {
    const tsMs = Date.parse(delta.ts);
    if (!Number.isFinite(tsMs)) continue;
    const bucket = byDate.get(toChicagoDate(new Date(tsMs)));
    if (!bucket) continue;
    bucket.calls += delta.calls;
    bucket.errors += delta.errors;
  }
  return buckets;
}

/**
 * Per-tool call/error totals across the trailing window
 * `[nowMs - windowMs, nowMs]`. Deltas outside the window (including
 * future-dated ones) are dropped.
 */
export function perToolWindow(
  deltas: DeltaPoint[],
  nowMs: number,
  windowMs: number,
): Record<string, { calls: number; errors: number }> {
  const cutoff = nowMs - windowMs;
  const out: Record<string, { calls: number; errors: number }> = {};
  for (const delta of deltas) {
    const tsMs = Date.parse(delta.ts);
    if (!Number.isFinite(tsMs) || tsMs < cutoff || tsMs > nowMs) continue;
    for (const [name, tool] of Object.entries(delta.tools)) {
      const agg = out[name] ?? { calls: 0, errors: 0 };
      agg.calls += tool.calls;
      agg.errors += tool.errors;
      out[name] = agg;
    }
  }
  return out;
}
