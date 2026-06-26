import { describe, it, expect, beforeEach } from 'vitest';
import { vi } from 'vitest';
import { readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Use a unique temp dir per run so tests are isolated.
const tmpLogsDir = join(tmpdir(), `rune-intent-log-test-${Date.now()}`);

vi.mock('../config.js', () => ({
  default: {
    LOGS_DIR: tmpLogsDir,
    TIMEZONE: 'America/Chicago',
  },
}));

const { appendIntent, intentLogPath, INTENT_LOG_FILENAME } = await import('./intent-log.js');

import type { IntentLogEntry, IntentOutcome } from './intent-log.js';

function makeEntry(overrides: Partial<IntentLogEntry> = {}): IntentLogEntry {
  return {
    ts: new Date().toISOString(),
    intent: 'test message',
    args: '',
    confidence: 0.9,
    outcome: 'routed' as IntentOutcome,
    skill_invoked: 'some-skill',
    ...overrides,
  };
}

describe('intent-log', () => {
  beforeEach(() => {
    // Remove the logs dir before each test so we get a clean slate.
    if (existsSync(tmpLogsDir)) {
      rmSync(tmpLogsDir, { recursive: true, force: true });
    }
  });

  it('intentLogPath() returns LOGS_DIR + filename', () => {
    expect(intentLogPath()).toBe(join(tmpLogsDir, INTENT_LOG_FILENAME));
  });

  it('happy path — one call writes one JSONL line that round-trips via JSON.parse', () => {
    const entry = makeEntry({ intent: 'book a flight', skill_invoked: 'travel', confidence: 0.85 });
    appendIntent(entry);

    const raw = readFileSync(intentLogPath(), 'utf-8');
    const lines = raw.trim().split('\n');
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!);
    expect(parsed).toEqual(entry);
  });

  it('multiple appends produce one entry per line with no truncation', () => {
    const entries = [
      makeEntry({ intent: 'first', skill_invoked: 'skill-a' }),
      makeEntry({ intent: 'second', skill_invoked: 'skill-b' }),
      makeEntry({ intent: 'third', skill_invoked: 'skill-c' }),
    ];

    for (const e of entries) {
      appendIntent(e);
    }

    const raw = readFileSync(intentLogPath(), 'utf-8');
    const lines = raw.trim().split('\n');
    expect(lines).toHaveLength(3);

    for (let i = 0; i < lines.length; i++) {
      const parsed = JSON.parse(lines[i]!);
      expect(parsed.intent).toBe(entries[i]!.intent);
      expect(parsed.skill_invoked).toBe(entries[i]!.skill_invoked);
    }
  });

  it('creates the logs directory if it does not exist (fresh-clone case)', () => {
    // beforeEach already removed tmpLogsDir, so it does not exist.
    expect(existsSync(tmpLogsDir)).toBe(false);

    appendIntent(makeEntry());

    expect(existsSync(tmpLogsDir)).toBe(true);
    expect(existsSync(intentLogPath())).toBe(true);
  });

  it('JSON escaping — intent with quotes, newlines, and backslashes remains valid JSONL', () => {
    const tricky = 'she said "hello"\nand then \\ escaped';
    const entry = makeEntry({ intent: tricky });
    appendIntent(entry);

    const raw = readFileSync(intentLogPath(), 'utf-8');
    const lines = raw.split('\n').filter(l => l.length > 0);
    expect(lines).toHaveLength(1);

    // Must parse without throwing.
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.intent).toBe(tricky);
  });

  it('skill_invoked: null serializes as JSON null (not the string "null")', () => {
    const entry = makeEntry({ skill_invoked: null, outcome: 'low_confidence' });
    appendIntent(entry);

    const raw = readFileSync(intentLogPath(), 'utf-8');
    const parsed = JSON.parse(raw.trim());
    expect(parsed.skill_invoked).toBeNull();
    expect(typeof parsed.skill_invoked).not.toBe('string');
  });

  it('tight-loop writes — 20 rapid appends all land as valid JSON lines', async () => {
    // Because appendIntent is synchronous, wrapping each call in Promise.resolve
    // does not actually yield — all 20 calls serialize in the same microtask
    // batch. This matches Rune's single-process event-loop model: concurrent
    // TG handlers are serialized by the event loop, so true OS-level concurrency
    // doesn't happen here. This test verifies that serial tight-loop writes
    // preserve every entry without truncation or corruption.
    const count = 20;
    const entries = Array.from({ length: count }, (_, i) =>
      makeEntry({ intent: `message-${i}`, args: String(i), skill_invoked: `skill-${i}` })
    );

    await Promise.all(entries.map(e => Promise.resolve(appendIntent(e))));

    const raw = readFileSync(intentLogPath(), 'utf-8');
    // The file must end with a newline so the last split element is empty; filter it.
    const lines = raw.split('\n').filter(l => l.length > 0);

    expect(lines).toHaveLength(count);

    // Every line must be independently parseable.
    const parsed = lines.map(l => JSON.parse(l));

    // All 20 intents must be present (any order).
    const intents = new Set(parsed.map((p: IntentLogEntry) => p.intent));
    for (let i = 0; i < count; i++) {
      expect(intents.has(`message-${i}`)).toBe(true);
    }
  });
});
