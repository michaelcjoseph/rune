import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpDir = join(tmpdir(), `jarvis-journal-test-${Date.now()}`);
const journalDir = join(tmpDir, 'journals');
const journalFile = join(journalDir, '2026_04_07.md');
mkdirSync(journalDir, { recursive: true });

vi.mock('../config.js', () => ({
  default: { VAULT_DIR: tmpDir, TIMEZONE: 'America/Chicago' },
}));

vi.mock('../utils/time.js', () => ({
  getTodayFilename: () => '2026_04_07.md',
}));

const { appendToJournal } = await import('./journal.js');

describe('appendToJournal', () => {
  beforeEach(() => {
    if (existsSync(journalFile)) unlinkSync(journalFile);
  });

  it('creates journal file if it does not exist', () => {
    const filepath = appendToJournal('first entry');
    expect(existsSync(filepath)).toBe(true);
    expect(readFileSync(filepath, 'utf8')).toBe('first entry\n');
  });

  it('appends multiple entries', () => {
    appendToJournal('entry one');
    appendToJournal('entry two');
    expect(readFileSync(journalFile, 'utf8')).toBe('entry one\nentry two\n');
  });

  it('adds newline prefix when existing content lacks trailing newline', () => {
    writeFileSync(journalFile, 'no newline at end');
    appendToJournal('appended');
    expect(readFileSync(journalFile, 'utf8')).toBe('no newline at end\nappended\n');
  });

  it('returns the journal file path', () => {
    expect(appendToJournal('test')).toBe(journalFile);
  });
});
