import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdirSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MessageSender } from '../../transport/sender.js';

// Isolated temp dir — must be created before mocking so learningsPath() sees it.
const tmpDir = join(tmpdir(), `jarvis-learn-list-test-${Date.now()}`);
mkdirSync(tmpDir, { recursive: true });

vi.mock('../../config.js', () => ({
  default: { VAULT_DIR: tmpDir, TIMEZONE: 'America/Chicago', TELEGRAM_USER_ID: 12345 },
}));

const { LEARNINGS_FILENAME, readLearnings, recentLearnings, DEFAULT_LEARNINGS_LIMIT } =
  await import('../../vault/learnings.js');

const { formatLearningsList, handleLearnList } = await import('./learn-list.js');

const learningsFile = join(tmpDir, LEARNINGS_FILENAME);

// ─── helpers ────────────────────────────────────────────────────────────────

function clearFile() {
  if (existsSync(learningsFile)) unlinkSync(learningsFile);
}

function writeLines(lines: string[]) {
  writeFileSync(learningsFile, lines.join('\n'));
}

function makeSender(): MessageSender {
  return {
    name: 'telegram' as const,
    send: vi.fn().mockResolvedValue(undefined),
    startTyping: vi.fn(),
    stopTyping: vi.fn(),
  };
}

function makeEntry(ts: string, text: string) {
  return JSON.stringify({ ts, text });
}

// ─── readLearnings ───────────────────────────────────────────────────────────

describe('readLearnings', () => {
  beforeEach(clearFile);

  it('returns [] when file does not exist', () => {
    expect(existsSync(learningsFile)).toBe(false);
    expect(readLearnings()).toEqual([]);
  });

  it('parses well-formed entries', () => {
    writeLines([
      makeEntry('2025-01-01T00:00:00.000Z', 'first'),
      makeEntry('2025-01-02T00:00:00.000Z', 'second'),
    ]);
    const entries = readLearnings();
    expect(entries).toHaveLength(2);
    expect(entries[0]!).toEqual({ ts: '2025-01-01T00:00:00.000Z', text: 'first' });
    expect(entries[1]!).toEqual({ ts: '2025-01-02T00:00:00.000Z', text: 'second' });
  });

  it('skips malformed JSON lines and preserves valid entries before and after', () => {
    writeLines([
      makeEntry('2025-01-01T00:00:00.000Z', 'before bad'),
      'NOT_VALID_JSON{{{{',
      makeEntry('2025-01-03T00:00:00.000Z', 'after bad'),
    ]);
    const entries = readLearnings();
    expect(entries).toHaveLength(2);
    expect(entries[0]!.text).toBe('before bad');
    expect(entries[1]!.text).toBe('after bad');
  });

  it('skips JSON with wrong shape — missing text field', () => {
    writeLines([
      JSON.stringify({ ts: '2025-01-01T00:00:00.000Z' }),           // no text
      JSON.stringify({ text: 'missing ts' }),                         // no ts
      JSON.stringify({ ts: 123, text: 'ts is not a string' }),        // ts wrong type
      JSON.stringify({ ts: '2025-01-04T00:00:00.000Z', text: true }), // text wrong type
      makeEntry('2025-01-05T00:00:00.000Z', 'valid'),
    ]);
    const entries = readLearnings();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.text).toBe('valid');
  });

  it('ignores empty and whitespace-only lines', () => {
    writeLines([
      makeEntry('2025-01-01T00:00:00.000Z', 'real entry'),
      '',
      '   ',
      '\t',
    ]);
    const entries = readLearnings();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.text).toBe('real entry');
  });
});

// ─── recentLearnings ─────────────────────────────────────────────────────────

describe('recentLearnings', () => {
  beforeEach(clearFile);

  it('returns last N entries when total > limit', () => {
    const lines: string[] = [];
    for (let i = 1; i <= 5; i++) {
      lines.push(makeEntry(`2025-01-0${i}T00:00:00.000Z`, `entry ${i}`));
    }
    writeLines(lines);

    const recent = recentLearnings(3);
    expect(recent).toHaveLength(3);
    // slice(-3) gives the last 3 — entries 3, 4, 5
    expect(recent[0]!.text).toBe('entry 3');
    expect(recent[1]!.text).toBe('entry 4');
    expect(recent[2]!.text).toBe('entry 5');
  });

  it('returns all entries when total <= limit', () => {
    writeLines([
      makeEntry('2025-01-01T00:00:00.000Z', 'a'),
      makeEntry('2025-01-02T00:00:00.000Z', 'b'),
    ]);
    const recent = recentLearnings(10);
    expect(recent).toHaveLength(2);
  });

  it('uses DEFAULT_LEARNINGS_LIMIT (20) when no limit is provided', () => {
    // Write 25 entries
    const lines: string[] = [];
    for (let i = 1; i <= 25; i++) {
      const day = String(i).padStart(2, '0');
      lines.push(makeEntry(`2025-01-${day}T00:00:00.000Z`, `entry ${i}`));
    }
    writeLines(lines);

    const recent = recentLearnings();
    expect(DEFAULT_LEARNINGS_LIMIT).toBe(20);
    expect(recent).toHaveLength(20);
    // Should be the last 20 — entries 6..25
    expect(recent[0]!.text).toBe('entry 6');
    expect(recent[19]!.text).toBe('entry 25');
  });

  it('returns [] when limit is 0 (guards against slice(-0) == full array)', () => {
    writeLines([
      makeEntry('2025-01-01T00:00:00.000Z', 'one'),
      makeEntry('2025-01-02T00:00:00.000Z', 'two'),
    ]);
    expect(recentLearnings(0)).toEqual([]);
  });

  it('returns [] when limit is negative', () => {
    writeLines([makeEntry('2025-01-01T00:00:00.000Z', 'one')]);
    expect(recentLearnings(-5)).toEqual([]);
  });
});

// ─── formatLearningsList ─────────────────────────────────────────────────────

describe('formatLearningsList', () => {
  it('returns no-learnings message for empty array', () => {
    const result = formatLearningsList([]);
    expect(result).toBe('No learnings yet. Use /learn <text> to add one.');
  });

  it('uses singular "learning" for a single entry', () => {
    const entries = [{ ts: '2025-03-10T12:00:00.000Z', text: 'only one' }];
    const result = formatLearningsList(entries);
    expect(result).toContain('1 most recent learning ');
    expect(result).not.toContain('learnings ');
  });

  it('uses plural "learnings" for multiple entries', () => {
    const entries = [
      { ts: '2025-03-10T12:00:00.000Z', text: 'first' },
      { ts: '2025-03-11T12:00:00.000Z', text: 'second' },
    ];
    const result = formatLearningsList(entries);
    expect(result).toContain('2 most recent learnings');
  });

  it('includes YYYY-MM-DD date extracted from ISO timestamp', () => {
    const entries = [{ ts: '2025-06-15T09:30:00.000Z', text: 'some text' }];
    const result = formatLearningsList(entries);
    expect(result).toContain('[2025-06-15]');
    expect(result).toContain('some text');
    expect(result).toContain('• [2025-06-15] some text');
  });

  it('shows the limit in the header', () => {
    const entries = [{ ts: '2025-01-01T00:00:00.000Z', text: 'x' }];
    const result = formatLearningsList(entries, 5);
    expect(result).toContain('(limit 5)');
  });

  it('uses DEFAULT_LEARNINGS_LIMIT in header when no limit provided', () => {
    const entries = [{ ts: '2025-01-01T00:00:00.000Z', text: 'x' }];
    const result = formatLearningsList(entries);
    expect(result).toContain(`(limit ${DEFAULT_LEARNINGS_LIMIT})`);
  });
});

// ─── handleLearnList ─────────────────────────────────────────────────────────

describe('handleLearnList', () => {
  beforeEach(clearFile);

  it('calls sender.send with the formatted string and correct chatId', async () => {
    writeLines([
      makeEntry('2025-04-01T08:00:00.000Z', 'alpha'),
      makeEntry('2025-04-02T08:00:00.000Z', 'beta'),
    ]);
    const sender = makeSender();
    await handleLearnList(sender, 42);

    expect(sender.send).toHaveBeenCalledOnce();
    const [calledChatId, calledMsg] = vi.mocked(sender.send).mock.calls[0]! as [number, string];
    expect(calledChatId).toBe(42);
    expect(calledMsg).toContain('[2025-04-01]');
    expect(calledMsg).toContain('alpha');
    expect(calledMsg).toContain('[2025-04-02]');
    expect(calledMsg).toContain('beta');
  });

  it('sends no-learnings message when file is missing', async () => {
    const sender = makeSender();
    await handleLearnList(sender, 99);

    expect(sender.send).toHaveBeenCalledOnce();
    const msg: string = vi.mocked(sender.send).mock.calls[0]![1]!;
    expect(msg).toBe('No learnings yet. Use /learn <text> to add one.');
  });

  it('uses the correct chatId for the send call', async () => {
    const sender = makeSender();
    await handleLearnList(sender, 777);
    expect(vi.mocked(sender.send).mock.calls[0]![0]).toBe(777);
  });
});
