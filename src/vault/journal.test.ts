import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpDir = join(tmpdir(), `rune-journal-test-${Date.now()}`);
const journalDir = join(tmpDir, 'journals');
const journalFile = join(journalDir, '2026_04_07.md');
mkdirSync(journalDir, { recursive: true });

vi.mock('../config.js', () => ({
  default: { VAULT_DIR: tmpDir, TIMEZONE: 'America/Chicago' },
}));

vi.mock('../utils/time.js', () => ({
  getTodayFilename: () => '2026_04_07.md',
}));

const { appendToJournal, writeMorningPrep, parseTag, parseWeeklyGoals, splitJournalAtReview } = await import('./journal.js');

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

describe('parseWeeklyGoals', () => {
  it('extracts a numbered list following the header', () => {
    const content = `**Reflection:** Some week.

**Next Week's Goals:**
1. Ship Aura
2. Complete syllabus week 1
3. Build shelves`;
    expect(parseWeeklyGoals(content)).toBe('1. Ship Aura\n2. Complete syllabus week 1\n3. Build shelves');
  });

  it('returns null when the header is absent', () => {
    const content = `## Week in Review

**Reflection:** Just a weekly recap with no goals header.`;
    expect(parseWeeklyGoals(content)).toBeNull();
  });

  it('returns empty string when header is present but body is empty', () => {
    const content = `**Next Week's Goals:**

## Notes`;
    expect(parseWeeklyGoals(content)).toBe('');
  });

  it('stops at the next **bold** section header', () => {
    const content = `**Next Week's Goals:**
1. First goal
2. Second goal
**Reflection:** Should not be captured`;
    expect(parseWeeklyGoals(content)).toBe('1. First goal\n2. Second goal');
  });

  it('stops at a markdown heading', () => {
    const content = `**Next Week's Goals:**
1. Goal one
2. Goal two
## Notes
- Belongs to next section`;
    expect(parseWeeklyGoals(content)).toBe('1. Goal one\n2. Goal two');
  });

  it('stops at an --- separator', () => {
    const content = `**Next Week's Goals:**
1. Build it
2. Ship it
---
More content here`;
    expect(parseWeeklyGoals(content)).toBe('1. Build it\n2. Ship it');
  });

  it('captures goals when they sit at EOF (no trailing terminator)', () => {
    const content = `**Reflection:** Wrapped up.

**Next Week's Goals:**
1. Goal A
2. Goal B`;
    expect(parseWeeklyGoals(content)).toBe('1. Goal A\n2. Goal B');
  });

  it('matches the header without trailing colon, defensively', () => {
    const content = `**Next Week's Goals**
1. Defensive match
2. Still works`;
    expect(parseWeeklyGoals(content)).toBe('1. Defensive match\n2. Still works');
  });

  it('matches case-insensitively', () => {
    const content = `**next week's goals:**
1. Lowercase header still parsed`;
    expect(parseWeeklyGoals(content)).toBe('1. Lowercase header still parsed');
  });

  it('matches the header with a curly U+2019 apostrophe (Obsidian Smart Quotes default)', () => {
    // Use the actual Unicode right-single-quotation-mark character, not a JS escape
    // for a straight quote. Obsidian's Smart Quotes setting emits this by default.
    const content = `**Next Week’s Goals:**
1. Curly-quote variant
2. Still parsed`;
    expect(parseWeeklyGoals(content)).toBe('1. Curly-quote variant\n2. Still parsed');
  });

  it('matches the header with a straight ASCII apostrophe', () => {
    const content = `**Next Week's Goals:**
1. Straight-quote variant`;
    expect(parseWeeklyGoals(content)).toBe('1. Straight-quote variant');
  });

  it('does not terminate scan on a non-section bold line like **Stretch goal**', () => {
    // Bold without a trailing colon is body content (e.g. emphasized goal label),
    // not a section divider — it must not stop collection.
    const content = `**Next Week's Goals:**
1. Primary goal
**Stretch goal**
2. Stretch target
3. Final target`;
    expect(parseWeeklyGoals(content)).toBe('1. Primary goal\n**Stretch goal**\n2. Stretch target\n3. Final target');
  });

  it('still terminates scan on a true bold section header like **Reflection:**', () => {
    const content = `**Next Week's Goals:**
1. Goal one
**Reflection:** Should not be captured
- Some reflection`;
    expect(parseWeeklyGoals(content)).toBe('1. Goal one');
  });
});

describe('splitJournalAtReview', () => {
  it('splits at ## Week in Review (weekly)', () => {
    const content = `# 2026-04-24

Some morning notes.

#priorities
- Ship Aura

## Week in Review

**Last Week's Goals:** done
**Reflection:** good week`;
    const { journal, review } = splitJournalAtReview(content);
    expect(review).not.toBeNull();
    expect(review?.type).toBe('weekly');
    expect(review?.content.startsWith('## Week in Review')).toBe(true);
    expect(review?.content).toContain("**Reflection:** good week");
    expect(journal).toBe(`# 2026-04-24

Some morning notes.

#priorities
- Ship Aura`);
  });

  it('splits at # April 2026 Review (monthly)', () => {
    const content = `Daily prose here.

# April 2026 Review

## Last Month's Goals
- Did the things`;
    const { journal, review } = splitJournalAtReview(content);
    expect(review?.type).toBe('monthly');
    expect(review?.content.startsWith('# April 2026 Review')).toBe(true);
    expect(journal).toBe('Daily prose here.');
  });

  it('splits at # Q2 2026 Review (quarterly)', () => {
    const content = `Notes.

# Q2 2026 Review

## Theme Assessment`;
    const { journal, review } = splitJournalAtReview(content);
    expect(review?.type).toBe('quarterly');
    expect(review?.content.startsWith('# Q2 2026 Review')).toBe(true);
  });

  it('splits at # 2026 Yearly Review (yearly)', () => {
    const content = `Notes.

# 2026 Yearly Review

## Q4 Patterns`;
    const { journal, review } = splitJournalAtReview(content);
    expect(review?.type).toBe('yearly');
    expect(review?.content.startsWith('# 2026 Yearly Review')).toBe(true);
  });

  it('returns review null when no review heading present', () => {
    const content = `# 2026-04-22

Just journal prose.

#priorities
- Do the work`;
    const { journal, review } = splitJournalAtReview(content);
    expect(review).toBeNull();
    expect(journal).toBe(content);
  });

  it('does not match a review-shaped phrase mid-line', () => {
    // The heading must be line-leading. Inline mentions (e.g. in a sentence)
    // must not trigger a split.
    const content = `Just talking about the ## Week in Review yesterday.

#priorities
- nothing`;
    const { review } = splitJournalAtReview(content);
    expect(review).toBeNull();
  });

  it('does not match a review-shaped phrase nested under another heading level', () => {
    // ### Week in Review is a sub-heading, not the structured ## marker
    // review-writer emits.
    const content = `Notes.

### Week in Review

Sub-section, not a real review.`;
    const { review } = splitJournalAtReview(content);
    expect(review).toBeNull();
  });

  it('captures only the FIRST review heading; secondary review-shaped headings stay inside review.content', () => {
    // Same-day weekly + monthly is rare but possible (e.g. last Friday of month).
    const content = `Notes.

## Week in Review

**Reflection:** weekly stuff

# April 2026 Review

## Last Month's Goals
- April things`;
    const { journal, review } = splitJournalAtReview(content);
    expect(review?.type).toBe('weekly');
    expect(journal).toBe('Notes.');
    expect(review?.content).toContain('# April 2026 Review');
    expect(review?.content).toContain('weekly stuff');
  });

  it('preserves pre-review content exactly (no off-by-one)', () => {
    const content = `line A
line B
line C
## Week in Review
review body`;
    const { journal } = splitJournalAtReview(content);
    expect(journal).toBe('line A\nline B\nline C');
  });

  it('strips trailing whitespace/newlines from the journal portion', () => {
    const content = `prose


## Week in Review
body`;
    const { journal } = splitJournalAtReview(content);
    expect(journal).toBe('prose');
  });

  it('returns content unchanged as journal when there is no heading', () => {
    const content = '   leading whitespace and trailing too   \n\n';
    const { journal, review } = splitJournalAtReview(content);
    expect(review).toBeNull();
    expect(journal).toBe(content);
  });

  it('does not match a malformed monthly heading like "# april 2026 review" (lowercase)', () => {
    // review-writer always emits TitleCase. Lowercase variants are unlikely
    // and we don't want to treat them as section dividers.
    const content = `Notes.

# april 2026 review

Body`;
    const { review } = splitJournalAtReview(content);
    expect(review).toBeNull();
  });

  it('does not match a daily-shaped heading like "## Day in Review"', () => {
    // Daily reviews don't go through review-writer and don't append a structured
    // section. If the daily handler ever starts emitting one, this test fails
    // loudly and forces a contract update before silent regression.
    const content = `Notes.

## Day in Review

Body`;
    const { review } = splitJournalAtReview(content);
    expect(review).toBeNull();
  });

  it('returns empty journal when review heading is at line 0', () => {
    // Edge case: journal file opens with the review heading. Pre-review
    // portion is empty; ingest skips writing raw/journals/ in this case.
    const content = `## Week in Review

**Reflection:** wrote nothing else today`;
    const { journal, review } = splitJournalAtReview(content);
    expect(journal).toBe('');
    expect(review?.type).toBe('weekly');
    expect(review?.content).toBe(content);
  });
});
