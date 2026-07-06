/**
 * Tests for src/mcp/metrics-history.ts — the daemon-side JSONL metrics
 * persistence layer (MCP monitoring redesign, Wave 0).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getBootId,
  startMcpMetricsFlush,
  type McpMetricsHistoryRecord,
} from './metrics-history.js';
import type { McpMetricsSnapshot } from './metrics.js';

const tempDirs: string[] = [];
const handles: Array<{ stop(): void }> = [];

function tempFile(name = 'history.jsonl'): string {
  const dir = mkdtempSync(join(tmpdir(), 'rune-mcp-metrics-history-'));
  tempDirs.push(dir);
  return join(dir, name);
}

function fakeSnapshot(overrides: Partial<McpMetricsSnapshot> = {}): McpMetricsSnapshot {
  return {
    totals: { calls: 7, errors: 2, timeouts: 1 },
    tools: {
      kb_query: {
        calls: 7,
        errors: 2,
        timeouts: 1,
        latencyMs: { p50: 12, p95: 80, p99: 200, sampleCount: 7, windowSize: 1024 },
      },
    },
    ...overrides,
  };
}

function readRecords(file: string): McpMetricsHistoryRecord[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as McpMetricsHistoryRecord);
}

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(() => {
  for (const handle of handles.splice(0)) handle.stop();
  vi.useRealTimers();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('startMcpMetricsFlush', () => {
  it('writes one record per flush with the pinned shape', () => {
    const file = tempFile();
    const handle = startMcpMetricsFlush({
      file,
      getSnapshot: () => fakeSnapshot(),
      getActiveSessionCount: () => 3,
      intervalMs: 60_000,
    });
    handles.push(handle);

    handle.flushNow();

    const records = readRecords(file);
    expect(records).toHaveLength(1);
    const record = records[0]!;
    expect(record).toEqual({
      ts: expect.any(String),
      bootId: getBootId(),
      uptimeSec: expect.any(Number),
      activeSessions: 3,
      totals: { calls: 7, errors: 2, timeouts: 1 },
      tools: {
        kb_query: { calls: 7, errors: 2, timeouts: 1, p50: 12, p95: 80, p99: 200 },
      },
    });
    expect(Number.isFinite(Date.parse(record.ts))).toBe(true);
    expect(record.uptimeSec).toBeGreaterThanOrEqual(0);
  });

  it('stop() performs a final flush and clears the timer', () => {
    const file = tempFile();
    const getSnapshot = vi.fn(() => fakeSnapshot());
    const handle = startMcpMetricsFlush({
      file,
      getSnapshot,
      getActiveSessionCount: () => 0,
      intervalMs: 60_000,
    });

    expect(readRecords(file)).toHaveLength(0);
    handle.stop();
    expect(readRecords(file)).toHaveLength(1);

    // Idempotent: a second stop neither throws nor double-flushes.
    handle.stop();
    expect(readRecords(file)).toHaveLength(1);
  });

  it('idle ticks still write a record (timeline gaps must mean daemon-down)', () => {
    vi.useFakeTimers();
    const file = tempFile();
    const idleSnapshot: McpMetricsSnapshot = { totals: { calls: 0, errors: 0, timeouts: 0 }, tools: {} };
    const handle = startMcpMetricsFlush({
      file,
      getSnapshot: () => idleSnapshot,
      getActiveSessionCount: () => 0,
      intervalMs: 1_000,
    });
    handles.push(handle);

    vi.advanceTimersByTime(3_000);

    const records = readRecords(file);
    expect(records).toHaveLength(3);
    for (const record of records) {
      expect(record.totals).toEqual({ calls: 0, errors: 0, timeouts: 0 });
      expect(record.tools).toEqual({});
    }
  });

  it('compaction on start drops old records, keeps recent ones, and skips corrupt lines', () => {
    const file = tempFile();
    const oldRecord = {
      ts: new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString(),
      bootId: 'old-boot',
      uptimeSec: 1,
      activeSessions: 0,
      totals: { calls: 1, errors: 0, timeouts: 0 },
      tools: {},
    };
    const recentRecord = {
      ts: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      bootId: 'recent-boot',
      uptimeSec: 2,
      activeSessions: 0,
      totals: { calls: 2, errors: 0, timeouts: 0 },
      tools: {},
    };
    writeFileSync(file, [
      JSON.stringify(oldRecord),
      'this is not json {{{',
      JSON.stringify(recentRecord),
    ].join('\n') + '\n');

    const handle = startMcpMetricsFlush({
      file,
      getSnapshot: () => fakeSnapshot(),
      getActiveSessionCount: () => 0,
      intervalMs: 60_000,
      retentionDays: 14,
    });
    handles.push(handle);

    const records = readRecords(file);
    expect(records).toHaveLength(1);
    expect(records[0]!.bootId).toBe('recent-boot');
  });

  it('bootId is stable within the process and matches getBootId()', () => {
    const file = tempFile();
    const handle = startMcpMetricsFlush({
      file,
      getSnapshot: () => fakeSnapshot(),
      getActiveSessionCount: () => 0,
      intervalMs: 60_000,
    });
    handles.push(handle);

    handle.flushNow();
    handle.flushNow();

    const records = readRecords(file);
    expect(records).toHaveLength(2);
    expect(records[0]!.bootId).toBe(records[1]!.bootId);
    expect(records[0]!.bootId).toBe(getBootId());
    expect(getBootId()).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('append into a nonexistent directory is fail-safe — never throws', () => {
    const file = join(tmpdir(), `rune-mcp-metrics-missing-${Date.now()}`, 'nested', 'history.jsonl');
    let handle: { stop(): void; flushNow(): void } | undefined;
    expect(() => {
      handle = startMcpMetricsFlush({
        file,
        getSnapshot: () => fakeSnapshot(),
        getActiveSessionCount: () => 0,
        intervalMs: 60_000,
      });
      handle.flushNow();
      handle.stop();
    }).not.toThrow();
    expect(existsSync(file)).toBe(false);
  });
});
