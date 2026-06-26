/**
 * Failing tests for `src/utils/observation-log.ts` (project 08-intent-layer
 * Phase 6 B1.1). The module is the writer for the observation loop's
 * interaction sensor — mirrors `src/utils/intent-log.ts` exactly in shape,
 * with `InteractionLogRecord` (from `src/intent/observation-sensor.ts`)
 * as the entry type.
 *
 * Written test-first; the module does not exist yet — every test must
 * fail with a missing-module or missing-export error.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpLogsDir = join(tmpdir(), `rune-observation-log-test-${Date.now()}`);

vi.mock('../config.js', () => ({
  default: {
    LOGS_DIR: tmpLogsDir,
    TIMEZONE: 'America/Chicago',
  },
}));

const { appendInteraction, observationLogPath, OBSERVATION_LOG_FILENAME } = await import('./observation-log.js');

import type { InteractionLogRecord } from '../intent/observation-sensor.js';

function makeRecord(overrides: Partial<InteractionLogRecord> = {}): InteractionLogRecord {
  return {
    ts: new Date().toISOString(),
    kind: 'tg-message',
    outcome: 'success',
    detail: 'route=journal conf=0.9',
    ...overrides,
  };
}

describe('observation-log', () => {
  beforeEach(() => {
    if (existsSync(tmpLogsDir)) {
      rmSync(tmpLogsDir, { recursive: true, force: true });
    }
  });

  it('observationLogPath() returns LOGS_DIR + filename', () => {
    expect(observationLogPath()).toBe(join(tmpLogsDir, OBSERVATION_LOG_FILENAME));
  });

  it('OBSERVATION_LOG_FILENAME is observation-interactions.jsonl', () => {
    expect(OBSERVATION_LOG_FILENAME).toBe('observation-interactions.jsonl');
  });

  it('happy path — one call writes one JSONL line that round-trips via JSON.parse', () => {
    const record = makeRecord({
      kind: 'agent-call',
      outcome: 'success',
      detail: 'agent=wiki-compiler durMs=420',
    });
    appendInteraction(record);

    const raw = readFileSync(observationLogPath(), 'utf-8');
    const lines = raw.trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual(record);
  });

  it('all four kinds and three outcomes round-trip without coercion', () => {
    const records: InteractionLogRecord[] = [
      makeRecord({ kind: 'tg-message', outcome: 'success', detail: 'route=journal' }),
      makeRecord({ kind: 'agent-call', outcome: 'failure', detail: 'agent=wiki-compiler err=timeout' }),
      makeRecord({ kind: 'command', outcome: 'cancelled', detail: 'cmd=workout result=cancelled' }),
      makeRecord({ kind: 'webview', outcome: 'success', detail: 'action=start-work slug=08-intent-layer' }),
      makeRecord({ kind: 'other', outcome: 'success', detail: 'startup' }),
    ];

    for (const r of records) appendInteraction(r);

    const raw = readFileSync(observationLogPath(), 'utf-8');
    const lines = raw.trim().split('\n');
    expect(lines).toHaveLength(records.length);
    for (let i = 0; i < records.length; i++) {
      expect(JSON.parse(lines[i]!)).toEqual(records[i]);
    }
  });

  it('creates the logs directory if it does not exist (fresh-clone case)', () => {
    expect(existsSync(tmpLogsDir)).toBe(false);
    appendInteraction(makeRecord());
    expect(existsSync(tmpLogsDir)).toBe(true);
    expect(existsSync(observationLogPath())).toBe(true);
  });

  it('JSON escaping — detail with quotes, newlines, and backslashes remains valid JSONL', () => {
    // The JSDoc invariant says callers must not put raw user text in detail,
    // but the writer itself must not corrupt anything a future caller passes.
    const tricky = 'kind="agent" status=err\nfile=/var/log/foo \\ bar';
    const record = makeRecord({ detail: tricky });
    appendInteraction(record);

    const raw = readFileSync(observationLogPath(), 'utf-8');
    const lines = raw.split('\n').filter(l => l.length > 0);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!).detail).toBe(tricky);
  });

  it('tight-loop writes — 20 rapid appends all land as valid JSON lines', async () => {
    const count = 20;
    const records = Array.from({ length: count }, (_, i) =>
      makeRecord({ kind: 'agent-call', detail: `agent=test-${i} durMs=${i}` }),
    );

    await Promise.all(records.map(r => Promise.resolve(appendInteraction(r))));

    const raw = readFileSync(observationLogPath(), 'utf-8');
    const lines = raw.split('\n').filter(l => l.length > 0);
    expect(lines).toHaveLength(count);

    const parsed = lines.map(l => JSON.parse(l));
    const details = new Set(parsed.map((p: InteractionLogRecord) => p.detail));
    for (let i = 0; i < count; i++) {
      expect(details.has(`agent=test-${i} durMs=${i}`)).toBe(true);
    }
  });

  it('every line ends with a newline so jq -c and tail -f stream cleanly', () => {
    appendInteraction(makeRecord({ detail: 'first' }));
    appendInteraction(makeRecord({ detail: 'second' }));

    const raw = readFileSync(observationLogPath(), 'utf-8');
    expect(raw.endsWith('\n')).toBe(true);
    // Splitting on '\n' yields exactly N+1 elements (the trailing empty after final '\n').
    expect(raw.split('\n')).toHaveLength(3);
  });
});
