import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// config.ts hard-requires TELEGRAM_BOT_TOKEN etc. at import; this module only
// needs TIMEZONE (via utils/time.ts), so mock it minimally.
vi.mock('../config.js', () => ({
  default: { TIMEZONE: 'America/Chicago' },
  PROJECT_ROOT: '/test/project',
}));

vi.mock('../utils/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));

const {
  readHistoryCached,
  clearHistoryReadCache,
  bucketHourly,
  bucketDaily,
  perToolWindow,
} = await import('./mcp-metrics-history-read.js');

const tmpRoot = mkdtempSync(join(tmpdir(), 'mcp-history-read-'));
afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));

const HOUR_MS = 60 * 60 * 1000;

function delta(ts: string, overrides: Partial<{
  calls: number;
  errors: number;
  timeouts: number;
  tools: Record<string, { calls: number; errors: number }>;
}> = {}) {
  return {
    ts,
    intervalMs: 60_000,
    calls: overrides.calls ?? 0,
    errors: overrides.errors ?? 0,
    timeouts: overrides.timeouts ?? 0,
    tools: overrides.tools ?? {},
  };
}

function historyLine(ts: string, calls: number): string {
  return JSON.stringify({
    ts,
    bootId: 'boot-1',
    uptimeSec: 10,
    activeSessions: 1,
    totals: { calls, errors: 0, timeouts: 0 },
    tools: {},
  });
}

describe('bucketHourly', () => {
  // Fixed anchor: 2026-07-06T15:20:00Z.
  const nowMs = Date.parse('2026-07-06T15:20:00.000Z');

  it('zero-fills one bucket per hour and sums deltas into the right hour', () => {
    const deltas = [
      delta('2026-07-06T13:05:00.000Z', { calls: 3, errors: 1, timeouts: 0 }),
      delta('2026-07-06T13:59:59.000Z', { calls: 2, errors: 0, timeouts: 1 }),
      delta('2026-07-06T15:01:00.000Z', { calls: 7, errors: 2, timeouts: 0 }),
    ];
    const buckets = bucketHourly(deltas, nowMs, 24);

    expect(buckets).toHaveLength(24);
    // Last bucket is the hour containing nowMs.
    expect(buckets[23]!.ts).toBe('2026-07-06T15:00:00.000Z');
    expect(buckets[0]!.ts).toBe('2026-07-05T16:00:00.000Z');

    const byTs = new Map(buckets.map((b) => [b.ts, b]));
    expect(byTs.get('2026-07-06T13:00:00.000Z')).toMatchObject({ calls: 5, errors: 1, timeouts: 1 });
    expect(byTs.get('2026-07-06T15:00:00.000Z')).toMatchObject({ calls: 7, errors: 2, timeouts: 0 });
    // All other buckets are zero-filled.
    expect(byTs.get('2026-07-06T14:00:00.000Z')).toMatchObject({ calls: 0, errors: 0, timeouts: 0 });
    const total = buckets.reduce((sum, b) => sum + b.calls, 0);
    expect(total).toBe(12);
  });

  it('drops deltas outside the window (too old or future-dated)', () => {
    const deltas = [
      delta('2026-07-05T14:59:00.000Z', { calls: 100 }), // > 24h before the last bucket's hour
      delta('2026-07-06T16:00:00.000Z', { calls: 50 }),  // next hour — future bucket
      delta('2026-07-06T15:10:00.000Z', { calls: 1 }),
    ];
    const buckets = bucketHourly(deltas, nowMs, 24);
    expect(buckets.reduce((sum, b) => sum + b.calls, 0)).toBe(1);
  });
});

describe('bucketDaily', () => {
  // 2026-07-06T18:00Z = 13:00 Chicago (CDT, UTC-5).
  const nowMs = Date.parse('2026-07-06T18:00:00.000Z');

  it('assigns deltas by America/Chicago day boundary, not UTC', () => {
    const deltas = [
      // 2026-07-06T04:30Z = 2026-07-05 23:30 Chicago — previous Chicago day.
      delta('2026-07-06T04:30:00.000Z', { calls: 4, errors: 1 }),
      // 2026-07-06T05:30Z = 2026-07-06 00:30 Chicago — today's Chicago day.
      delta('2026-07-06T05:30:00.000Z', { calls: 6, errors: 0 }),
    ];
    const buckets = bucketDaily(deltas, nowMs, 14);

    expect(buckets).toHaveLength(14);
    expect(buckets[13]!.date).toBe('2026-07-06');
    expect(buckets[0]!.date).toBe('2026-06-23');

    const byDate = new Map(buckets.map((b) => [b.date, b]));
    expect(byDate.get('2026-07-05')).toMatchObject({ calls: 4, errors: 1 });
    expect(byDate.get('2026-07-06')).toMatchObject({ calls: 6, errors: 0 });
    expect(byDate.get('2026-07-04')).toMatchObject({ calls: 0, errors: 0 });
  });

  it('zero-fills every day and drops deltas older than the window', () => {
    const deltas = [delta('2026-06-01T12:00:00.000Z', { calls: 9 })];
    const buckets = bucketDaily(deltas, nowMs, 7);
    expect(buckets).toHaveLength(7);
    expect(buckets.every((b) => b.calls === 0 && b.errors === 0)).toBe(true);
  });
});

describe('perToolWindow', () => {
  const nowMs = Date.parse('2026-07-06T18:00:00.000Z');

  it('sums per-tool calls/errors across the window and drops deltas outside it', () => {
    const deltas = [
      delta('2026-07-06T17:00:00.000Z', { tools: { kb_query: { calls: 5, errors: 1 } } }),
      delta('2026-07-06T17:30:00.000Z', {
        tools: { kb_query: { calls: 3, errors: 0 }, log_idea: { calls: 2, errors: 2 } },
      }),
      // Older than the 24h window.
      delta('2026-07-05T17:00:00.000Z', { tools: { kb_query: { calls: 100, errors: 100 } } }),
      // Future-dated — dropped.
      delta('2026-07-06T19:00:00.000Z', { tools: { kb_query: { calls: 50, errors: 0 } } }),
    ];
    const perTool = perToolWindow(deltas, nowMs, 24 * HOUR_MS);
    expect(perTool).toEqual({
      kb_query: { calls: 8, errors: 1 },
      log_idea: { calls: 2, errors: 2 },
    });
  });
});

describe('readHistoryCached', () => {
  beforeEach(() => {
    clearHistoryReadCache();
  });

  it('returns [] for a missing file', () => {
    expect(readHistoryCached(join(tmpRoot, 'does-not-exist.jsonl'))).toEqual([]);
  });

  it('parses records and serves the cache while mtime+size are unchanged, re-parsing on mtime change', () => {
    const file = join(tmpRoot, 'history.jsonl');
    // Two same-length variants so a content swap keeps the size identical —
    // isolating the mtime part of the cache key.
    const v1 = `${historyLine('2026-07-06T12:00:00.000Z', 1)}\n`;
    const v2 = `${historyLine('2026-07-06T12:00:00.000Z', 2)}\n`;
    expect(v1.length).toBe(v2.length);

    // Pin the mtime explicitly (ms precision) so the swap below can reproduce
    // it exactly — a natural write stamps sub-ms mtimes utimesSync can't restore.
    const pinned = new Date('2026-07-06T12:00:00.000Z');
    writeFileSync(file, v1);
    utimesSync(file, pinned, pinned);
    const first = readHistoryCached(file);
    expect(first).toHaveLength(1);
    expect(first[0]!.totals.calls).toBe(1);

    // Swap content but re-pin the same mtime: cache hit — stale data served.
    writeFileSync(file, v2);
    utimesSync(file, pinned, pinned);
    const cached = readHistoryCached(file);
    expect(cached[0]!.totals.calls).toBe(1);

    // Bump the mtime: cache invalidated — the new content is parsed.
    const bumped = new Date(pinned.getTime() + 5_000);
    utimesSync(file, bumped, bumped);
    const reread = readHistoryCached(file);
    expect(reread[0]!.totals.calls).toBe(2);
  });

  it('applies sinceMs to cached records without re-parsing', () => {
    const file = join(tmpRoot, 'history-since.jsonl');
    writeFileSync(file, [
      historyLine('2026-07-06T10:00:00.000Z', 1),
      historyLine('2026-07-06T12:00:00.000Z', 2),
    ].join('\n') + '\n');

    const all = readHistoryCached(file);
    expect(all).toHaveLength(2);

    const windowed = readHistoryCached(file, { sinceMs: Date.parse('2026-07-06T11:00:00.000Z') });
    expect(windowed).toHaveLength(1);
    expect(windowed[0]!.ts).toBe('2026-07-06T12:00:00.000Z');
  });
});
