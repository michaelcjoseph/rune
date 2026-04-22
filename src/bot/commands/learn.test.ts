import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdirSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpDir = join(tmpdir(), `jarvis-learn-test-${Date.now()}`);
mkdirSync(tmpDir, { recursive: true });

vi.mock('../../config.js', () => ({
  default: { VAULT_DIR: tmpDir, TIMEZONE: 'America/Chicago', TELEGRAM_USER_ID: 12345 },
}));

const { LEARNINGS_FILENAME, appendLearning } = await import('../../vault/learnings.js');
const { handleLearn } = await import('./learn.js');

const learningsFile = join(tmpDir, LEARNINGS_FILENAME);

describe('LEARNINGS_FILENAME', () => {
  it('is learnings.jsonl', () => {
    expect(LEARNINGS_FILENAME).toBe('learnings.jsonl');
  });
});

describe('appendLearning', () => {
  beforeEach(() => {
    if (existsSync(learningsFile)) unlinkSync(learningsFile);
  });

  it('creates the file if it does not exist', () => {
    expect(existsSync(learningsFile)).toBe(false);
    appendLearning('hello world', new Date('2025-01-01T12:00:00.000Z'));
    expect(existsSync(learningsFile)).toBe(true);
  });

  it('writes a well-formed JSON line', () => {
    const now = new Date('2025-06-15T09:30:00.000Z');
    appendLearning('prefer terse answers', now);
    const content = readFileSync(learningsFile, 'utf8');
    const parsed = JSON.parse(content.trim());
    expect(parsed.ts).toBe('2025-06-15T09:30:00.000Z');
    expect(parsed.text).toBe('prefer terse answers');
  });

  it('uses the injected now parameter for the ISO timestamp', () => {
    const now = new Date('2024-03-20T18:45:00.000Z');
    const entry = appendLearning('deterministic test', now);
    expect(entry.ts).toBe('2024-03-20T18:45:00.000Z');
    const content = readFileSync(learningsFile, 'utf8');
    expect(JSON.parse(content.trim()).ts).toBe('2024-03-20T18:45:00.000Z');
  });

  it('multiple appends produce one entry per line', () => {
    const t1 = new Date('2025-01-01T00:00:00.000Z');
    const t2 = new Date('2025-01-02T00:00:00.000Z');
    const t3 = new Date('2025-01-03T00:00:00.000Z');
    appendLearning('first', t1);
    appendLearning('second', t2);
    appendLearning('third', t3);
    const lines = readFileSync(learningsFile, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0]!).text).toBe('first');
    expect(JSON.parse(lines[1]!).text).toBe('second');
    expect(JSON.parse(lines[2]!).text).toBe('third');
  });

  it('preserves prior content when appending', () => {
    const t1 = new Date('2025-01-01T00:00:00.000Z');
    const t2 = new Date('2025-01-02T00:00:00.000Z');
    appendLearning('original entry', t1);
    appendLearning('new entry', t2);
    const content = readFileSync(learningsFile, 'utf8');
    expect(content).toContain('original entry');
    expect(content).toContain('new entry');
  });

  it('returns the entry object with ts and text', () => {
    const now = new Date('2025-05-10T14:00:00.000Z');
    const entry = appendLearning('check return value', now);
    expect(entry).toEqual({ ts: '2025-05-10T14:00:00.000Z', text: 'check return value' });
  });

  it('correctly escapes text containing double quotes', () => {
    const now = new Date('2025-01-01T00:00:00.000Z');
    const text = 'say "hello world" always';
    appendLearning(text, now);
    const content = readFileSync(learningsFile, 'utf8').trim();
    const parsed = JSON.parse(content);
    expect(parsed.text).toBe(text);
  });

  it('correctly escapes text containing newlines', () => {
    const now = new Date('2025-01-01T00:00:00.000Z');
    const text = 'line one\nline two';
    appendLearning(text, now);
    const content = readFileSync(learningsFile, 'utf8').trim();
    const parsed = JSON.parse(content);
    expect(parsed.text).toBe(text);
  });

  it('correctly escapes text containing backslashes', () => {
    const now = new Date('2025-01-01T00:00:00.000Z');
    const text = 'path is C:\\Users\\foo\\bar';
    appendLearning(text, now);
    const content = readFileSync(learningsFile, 'utf8').trim();
    const parsed = JSON.parse(content);
    expect(parsed.text).toBe(text);
  });
});

describe('handleLearn', () => {
  function makeBotMock() {
    return { sendMessage: vi.fn().mockResolvedValue(undefined) } as any;
  }

  beforeEach(() => {
    if (existsSync(learningsFile)) unlinkSync(learningsFile);
  });

  it('sends usage hint and does not write file when text is empty', async () => {
    const bot = makeBotMock();
    await handleLearn(bot, 123, '');
    expect(bot.sendMessage).toHaveBeenCalledOnce();
    const msg: string = bot.sendMessage.mock.calls[0][1];
    expect(msg).toMatch(/usage/i);
    expect(existsSync(learningsFile)).toBe(false);
  });

  it('sends usage hint and does not write file when text is whitespace-only', async () => {
    const bot = makeBotMock();
    await handleLearn(bot, 123, '   \t\n  ');
    expect(bot.sendMessage).toHaveBeenCalledOnce();
    const msg: string = bot.sendMessage.mock.calls[0][1];
    expect(msg).toMatch(/usage/i);
    expect(existsSync(learningsFile)).toBe(false);
  });

  it('with real text writes to file and sends confirmation', async () => {
    const bot = makeBotMock();
    await handleLearn(bot, 456, 'prefer short answers');
    expect(existsSync(learningsFile)).toBe(true);
    const content = readFileSync(learningsFile, 'utf8').trim();
    const parsed = JSON.parse(content);
    expect(parsed.text).toBe('prefer short answers');
    expect(bot.sendMessage).toHaveBeenCalledOnce();
    const msg: string = bot.sendMessage.mock.calls[0][1];
    expect(msg).toMatch(/logged/i);
  });

  it('sends to the correct chatId', async () => {
    const bot = makeBotMock();
    await handleLearn(bot, 789, 'some learning');
    expect(bot.sendMessage.mock.calls[0][0]).toBe(789);
  });

  it('trims surrounding whitespace before writing', async () => {
    const bot = makeBotMock();
    await handleLearn(bot, 123, '  trimmed text  ');
    const content = readFileSync(learningsFile, 'utf8').trim();
    const parsed = JSON.parse(content);
    expect(parsed.text).toBe('trimmed text');
  });
});
