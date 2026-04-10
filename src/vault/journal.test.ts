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

const { appendToJournal, writeMorningPrep, parseTag } = await import('./journal.js');

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

describe('writeMorningPrep', () => {
  beforeEach(() => {
    if (existsSync(journalFile)) unlinkSync(journalFile);
  });

  it('writes morning prep to empty journal', () => {
    const result = writeMorningPrep('- Wake up\n- Coffee');
    expect(result.written).toBe(true);
    expect(readFileSync(journalFile, 'utf8')).toBe(
      '## Morning Prep\n\n- Wake up\n- Coffee\n'
    );
  });

  it('writes morning prep to journal with existing content', () => {
    writeFileSync(journalFile, '# 2026-04-07\n\nSome notes\n');
    const result = writeMorningPrep('- Task A\n- Task B');
    expect(result.written).toBe(true);
    expect(readFileSync(journalFile, 'utf8')).toBe(
      '# 2026-04-07\n\nSome notes\n\n## Morning Prep\n\n- Task A\n- Task B\n'
    );
  });

  it('is idempotent: second call returns written false and does not duplicate', () => {
    writeMorningPrep('- First run');
    const second = writeMorningPrep('- Second run');
    expect(second.written).toBe(false);
    const content = readFileSync(journalFile, 'utf8');
    expect(content).toBe('## Morning Prep\n\n- First run\n');
    expect(content.match(/## Morning Prep/g)?.length).toBe(1);
  });

  it('creates journal file if it does not exist', () => {
    expect(existsSync(journalFile)).toBe(false);
    writeMorningPrep('- New day');
    expect(existsSync(journalFile)).toBe(true);
  });

  it('returns the correct filepath', () => {
    const result = writeMorningPrep('- Check');
    expect(result.filepath).toBe(journalFile);
  });
});

describe('parseTag', () => {
  it('returns content lines after the tag', () => {
    const content = `Some intro
#priorities
- Fix the bug
- Ship the feature`;
    expect(parseTag(content, 'priorities')).toBe('- Fix the bug\n- Ship the feature');
  });

  it('returns null when the tag is not found', () => {
    const content = `Just some notes
Nothing tagged here`;
    expect(parseTag(content, 'priorities')).toBeNull();
  });

  it('extracts only the requested tag when multiple tags exist', () => {
    const content = `#priorities
- Ship v2
- Review PR
#wins
- Landed the deal
- Got feedback`;
    expect(parseTag(content, 'priorities')).toBe('- Ship v2\n- Review PR');
    expect(parseTag(content, 'wins')).toBe('- Landed the deal\n- Got feedback');
  });

  it('returns empty string when tag is at EOF with no content after', () => {
    const content = `Some notes
#priorities`;
    expect(parseTag(content, 'priorities')).toBe('');
  });

  it('returns remaining content when tag is the last tag before EOF', () => {
    const content = `#priorities
- Final thoughts
- Wrap up`;
    expect(parseTag(content, 'priorities')).toBe('- Final thoughts\n- Wrap up');
  });

  it('does not match partial tag names', () => {
    const content = `#prioritiesExtra
- This belongs to a different tag
#priorities
- Real content`;
    expect(parseTag(content, 'priorities')).toBe('- Real content');
  });

  it('stops collecting at the next ## heading', () => {
    const content = `#priorities
- Task A
- Task B
## Evening Review
Some review notes`;
    expect(parseTag(content, 'priorities')).toBe('- Task A\n- Task B');
  });

  it('stops collecting at the next #tag', () => {
    const content = `#priorities
- Do the thing
#blockers
- Waiting on infra`;
    expect(parseTag(content, 'priorities')).toBe('- Do the thing');
  });

  it('does not stop at an inline tag mid-line', () => {
    const content = `#priorities
- Had coffee. #good-start
- Reviewed the deck
#blockers
- Waiting on infra`;
    expect(parseTag(content, 'priorities')).toBe('- Had coffee. #good-start\n- Reviewed the deck');
  });

  it('stops collecting at a level-1 heading', () => {
    const content = `#priorities
- Task A
# Daily Log
Went for a walk`;
    expect(parseTag(content, 'priorities')).toBe('- Task A');
  });

  it('matches tag appearing mid-line', () => {
    const content = `14:30 - logged #priorities
- Call the client
- Review deck`;
    expect(parseTag(content, 'priorities')).toBe('- Call the client\n- Review deck');
  });
});
