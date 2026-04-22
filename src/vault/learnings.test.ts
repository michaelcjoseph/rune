import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdirSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Isolated temp dir — must be created before mocking so learningsPath() sees it.
const tmpDir = join(tmpdir(), `jarvis-learnings-test-${Date.now()}`);
mkdirSync(tmpDir, { recursive: true });

vi.mock('../config.js', () => ({
  default: { VAULT_DIR: tmpDir, TIMEZONE: 'America/Chicago', TELEGRAM_USER_ID: 12345 },
}));

const {
  LEARNINGS_FILENAME,
  LEARNINGS_PROMPT_CHAR_BUDGET,
  buildLearningsPrompt,
  recentLearnings,
} = await import('./learnings.js');

const learningsFile = join(tmpDir, LEARNINGS_FILENAME);

// ─── helpers ────────────────────────────────────────────────────────────────

function clearFile() {
  if (existsSync(learningsFile)) unlinkSync(learningsFile);
}

function makeEntry(ts: string, text: string) {
  return { ts, text };
}

function writeLearningsFile(entries: Array<{ ts: string; text: string }>) {
  writeFileSync(learningsFile, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
}

// ─── buildLearningsPrompt ────────────────────────────────────────────────────

describe('buildLearningsPrompt', () => {
  it('returns empty string for empty entries array', () => {
    const result = buildLearningsPrompt([]);
    expect(result).toBe('');
  });

  it('renders a complete block with ## Learnings header for a single entry', () => {
    const entries = [makeEntry('2025-01-01T00:00:00.000Z', 'prefer terse answers')];
    const result = buildLearningsPrompt(entries);

    expect(result).toContain('## Learnings');
    expect(result).toContain('User-authored guidance to apply');
    expect(result).toContain('- prefer terse answers');
    // Block should end with double newline
    expect(result.endsWith('\n\n')).toBe(true);
  });

  it('renders exactly one bullet per entry', () => {
    const entries = [makeEntry('2025-01-01T00:00:00.000Z', 'only entry')];
    const result = buildLearningsPrompt(entries);

    const bullets = result.match(/^- /gm);
    expect(bullets).toHaveLength(1);
  });

  it('preserves entry order oldest-first (as provided)', () => {
    const entries = [
      makeEntry('2025-01-01T00:00:00.000Z', 'oldest entry'),
      makeEntry('2025-01-02T00:00:00.000Z', 'middle entry'),
      makeEntry('2025-01-03T00:00:00.000Z', 'newest entry'),
    ];
    const result = buildLearningsPrompt(entries);

    const oldestPos = result.indexOf('oldest entry');
    const middlePos = result.indexOf('middle entry');
    const newestPos = result.indexOf('newest entry');

    expect(oldestPos).toBeLessThan(middlePos);
    expect(middlePos).toBeLessThan(newestPos);
  });

  it('renders all entries as bullet points', () => {
    const entries = [
      makeEntry('2025-01-01T00:00:00.000Z', 'alpha'),
      makeEntry('2025-01-02T00:00:00.000Z', 'beta'),
      makeEntry('2025-01-03T00:00:00.000Z', 'gamma'),
    ];
    const result = buildLearningsPrompt(entries);

    expect(result).toContain('- alpha');
    expect(result).toContain('- beta');
    expect(result).toContain('- gamma');
  });

  it('drops oldest entries when block exceeds char budget', () => {
    // Create 5 entries. Budget is tight enough to fit only the 3 newest.
    const entries = [
      makeEntry('2025-01-01T00:00:00.000Z', 'entry one'),
      makeEntry('2025-01-02T00:00:00.000Z', 'entry two'),
      makeEntry('2025-01-03T00:00:00.000Z', 'entry three'),
      makeEntry('2025-01-04T00:00:00.000Z', 'entry four'),
      makeEntry('2025-01-05T00:00:00.000Z', 'entry five'),
    ];

    // Calculate what a 3-entry block would look like
    const threeEntryBlock = buildLearningsPrompt(entries.slice(2));
    const budget = threeEntryBlock.length; // exactly fits 3 entries

    const result = buildLearningsPrompt(entries, budget);

    // Should not contain the two oldest
    expect(result).not.toContain('entry one');
    expect(result).not.toContain('entry two');
    // Should contain the three newest
    expect(result).toContain('entry three');
    expect(result).toContain('entry four');
    expect(result).toContain('entry five');
    expect(result.length).toBeLessThanOrEqual(budget);
  });

  it('drops until only 1 entry remains when budget is very tight', () => {
    const entries = [
      makeEntry('2025-01-01T00:00:00.000Z', 'old entry'),
      makeEntry('2025-01-02T00:00:00.000Z', 'newest entry'),
    ];

    // Budget that cannot fit even 2 entries but can fit 1
    const oneEntryBlock = buildLearningsPrompt([entries[1]!]);
    const budget = oneEntryBlock.length; // exactly fits newest entry alone

    const result = buildLearningsPrompt(entries, budget);

    expect(result).not.toContain('old entry');
    expect(result).toContain('newest entry');
  });

  it('returns the single-entry block even when it exceeds char budget (never drops to empty)', () => {
    const hugeText = 'x'.repeat(10_000);
    const entries = [makeEntry('2025-01-01T00:00:00.000Z', hugeText)];

    // Budget far smaller than the single entry
    const result = buildLearningsPrompt(entries, 100);

    // Must not return empty — user's single intent wins
    expect(result).not.toBe('');
    expect(result).toContain('## Learnings');
    expect(result).toContain(`- ${hugeText}`);
  });

  it('with multiple entries only last entry survives when budget allows only one', () => {
    const hugeText = 'y'.repeat(5_000);
    const entries = [
      makeEntry('2025-01-01T00:00:00.000Z', 'will be dropped'),
      makeEntry('2025-01-02T00:00:00.000Z', 'also dropped'),
      makeEntry('2025-01-03T00:00:00.000Z', hugeText),
    ];

    // Budget: can fit a 1-entry block with hugeText, but not 2 entries
    const oneEntryBlock = buildLearningsPrompt([entries[2]!]);
    const budget = oneEntryBlock.length; // just enough for the single huge entry

    const result = buildLearningsPrompt(entries, budget);

    expect(result).not.toContain('will be dropped');
    expect(result).not.toContain('also dropped');
    expect(result).toContain(hugeText);
  });

  it('does not modify the entries array (pure function)', () => {
    const entries = [
      makeEntry('2025-01-01T00:00:00.000Z', 'first'),
      makeEntry('2025-01-02T00:00:00.000Z', 'second'),
    ];
    const originalLength = entries.length;
    buildLearningsPrompt(entries, 10); // tiny budget forces drops
    expect(entries).toHaveLength(originalLength);
  });

  it('uses default LEARNINGS_PROMPT_CHAR_BUDGET (4000) when no budget is provided', () => {
    expect(LEARNINGS_PROMPT_CHAR_BUDGET).toBe(4000);
    // Build a small block — should easily fit default budget
    const entries = [makeEntry('2025-01-01T00:00:00.000Z', 'fits easily')];
    const result = buildLearningsPrompt(entries);
    expect(result.length).toBeLessThanOrEqual(LEARNINGS_PROMPT_CHAR_BUDGET);
  });
});

// ─── buildLearningsPrompt — reads from disk via recentLearnings() when no entries arg ──

describe('buildLearningsPrompt (disk read via recentLearnings)', () => {
  beforeEach(clearFile);

  it('returns empty string when learnings file does not exist', () => {
    expect(existsSync(learningsFile)).toBe(false);
    const result = buildLearningsPrompt();
    expect(result).toBe('');
  });

  it('reads from disk and builds block when file contains entries', () => {
    writeLearningsFile([
      { ts: '2025-01-01T00:00:00.000Z', text: 'disk entry alpha' },
      { ts: '2025-01-02T00:00:00.000Z', text: 'disk entry beta' },
    ]);

    const result = buildLearningsPrompt();

    expect(result).toContain('## Learnings');
    expect(result).toContain('- disk entry alpha');
    expect(result).toContain('- disk entry beta');
  });

  it('returns the last 20 entries (DEFAULT_LEARNINGS_LIMIT) from disk', () => {
    // Write 25 entries
    const all = Array.from({ length: 25 }, (_, i) => ({
      ts: `2025-01-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`,
      text: `entry ${i + 1}`,
    }));
    writeLearningsFile(all);

    const result = buildLearningsPrompt();

    // entries 1-5 should be dropped by recentLearnings (limit 20)
    expect(result).not.toContain('entry 1\n');
    expect(result).not.toContain('- entry 5');
    expect(result).toContain('- entry 6');
    expect(result).toContain('- entry 25');
  });
});

// ─── LEARNINGS_PROMPT_CHAR_BUDGET constant ──────────────────────────────────

describe('LEARNINGS_PROMPT_CHAR_BUDGET', () => {
  it('is 4000', () => {
    expect(LEARNINGS_PROMPT_CHAR_BUDGET).toBe(4000);
  });
});
