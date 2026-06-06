/**
 * Phase 2 test suite for `src/writer/capture.ts` — TS-owned lesson capture
 * (project 12, test-plan §2: candidate-parse, capture, no-feedback gate, dedup,
 * privacy filter).
 *
 * Written TEST-FIRST. The scaffold bodies throw
 * `writer/capture: <fn> not implemented (...)`, so every test here is RED until
 * the Phase 2 capture implementation lands.
 *
 * Expected failure mode: the "not implemented" throw or a clean assertion
 * failure — never a module-resolution or syntax error.
 *
 * The capture core is exercised through injected deps (readMemory / appendLine /
 * commit doubles) so no test touches the real `memory.md` or git. `captureLessons`
 * and its `commit` seam are async (matching the git-helper convention).
 *
 * See: docs/projects/12-writer-memory/test-plan.md §2
 */

import { describe, it, expect, vi } from 'vitest';

import {
  parseCandidateBlock,
  isLessonPrivacySafe,
  captureLessons,
  SOURCE_SLUG_RE,
  CANDIDATE_FENCE,
  type CaptureLessonsInput,
} from './capture.js';
import { PROVENANCE_RE } from './seed.js';

// --- Fixtures ---

function fencedBlock(obj: unknown): string {
  return ['```' + CANDIDATE_FENCE, JSON.stringify(obj, null, 2), '```'].join('\n');
}

function validInput(overrides: Partial<CaptureLessonsInput> = {}): CaptureLessonsInput {
  const appendLine = vi.fn();
  const commit = vi.fn().mockResolvedValue({ committed: true, sha: 'abc1234' });
  return {
    assistantText: `Thanks for the feedback — revised.\n\n${fencedBlock({
      sourceSlug: 'blog-2026-06-05-testing',
      feedbackSeen: true,
      lessons: ['Open on the sharpest claim, not the setup.'],
    })}`,
    date: '2026-06-05',
    privateNames: [],
    readMemory: () => '',
    appendLine,
    commit,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// parseCandidateBlock — accept only a well-formed fenced block (sync)
// ---------------------------------------------------------------------------

describe('writer/capture — parseCandidateBlock', () => {
  it('parses a well-formed writer-memory-candidates block', () => {
    const block = fencedBlock({ sourceSlug: 'blog-x', feedbackSeen: true, lessons: ['A lesson.'] });
    const parsed = parseCandidateBlock(`prose\n\n${block}`);
    expect(parsed).toEqual({ sourceSlug: 'blog-x', feedbackSeen: true, lessons: ['A lesson.'] });
  });

  it('returns null when there is no fenced candidate block', () => {
    expect(parseCandidateBlock('just prose, no block')).toBeNull();
  });

  it('returns null for a malformed block (missing required fields)', () => {
    const block = ['```' + CANDIDATE_FENCE, '{ "lessons": ["x"] }', '```'].join('\n');
    expect(parseCandidateBlock(block)).toBeNull();
  });

  it('returns null for a block with invalid JSON', () => {
    const block = ['```' + CANDIDATE_FENCE, '{ not json', '```'].join('\n');
    expect(parseCandidateBlock(block)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// captureLessons — happy path emits a provenance-stamped lesson
// ---------------------------------------------------------------------------

describe('writer/capture — captureLessons', () => {
  it('emits ≥1 provenance-stamped lesson and commits on a valid feedback payload', async () => {
    const input = validInput();
    const result = await captureLessons(input);

    expect(result.captured.length).toBeGreaterThanOrEqual(1);
    expect(result.captured[0]).toMatch(PROVENANCE_RE);
    expect(result.committed).toBe(true);
    expect(input.appendLine).toHaveBeenCalled();
    expect(input.commit).toHaveBeenCalledTimes(1);
  });

  it('stamps with an opaque slug matching SOURCE_SLUG_RE', async () => {
    const result = await captureLessons(validInput());
    const slug = result.captured[0]?.match(/source: ([^\]]+)\]/)?.[1] ?? '';
    expect(slug).toMatch(SOURCE_SLUG_RE);
  });

  it('derives a fallback opaque slug when the candidate slug is invalid', async () => {
    const input = validInput({
      assistantText: fencedBlock({
        sourceSlug: 'Not A Valid Slug!',
        feedbackSeen: true,
        lessons: ['Cut the throat-clearing first paragraph.'],
      }),
      fallbackTopic: 'why testing matters',
    });
    const result = await captureLessons(input);
    const slug = result.captured[0]?.match(/source: ([^\]]+)\]/)?.[1] ?? '';
    expect(slug).toMatch(SOURCE_SLUG_RE);
  });

  // No-phantom-writes gate
  it('writes nothing when feedbackSeen is false', async () => {
    const input = validInput({
      assistantText: fencedBlock({
        sourceSlug: 'blog-x',
        feedbackSeen: false,
        lessons: ['Should never be stored.'],
      }),
    });
    const result = await captureLessons(input);
    expect(result.captured).toHaveLength(0);
    expect(result.committed).toBe(false);
    expect(result.skipReason).toBe('no-feedback');
    expect(input.appendLine).not.toHaveBeenCalled();
    expect(input.commit).not.toHaveBeenCalled();
  });

  it('writes nothing when there is no candidate block', async () => {
    const input = validInput({ assistantText: 'A normal closing message, no block.' });
    const result = await captureLessons(input);
    expect(result.captured).toHaveLength(0);
    expect(result.committed).toBe(false);
    expect(result.skipReason).toBe('no-block');
    expect(input.commit).not.toHaveBeenCalled();
  });

  it('writes nothing when the lessons array is empty', async () => {
    const input = validInput({
      assistantText: fencedBlock({ sourceSlug: 'blog-x', feedbackSeen: true, lessons: [] }),
    });
    const result = await captureLessons(input);
    expect(result.captured).toHaveLength(0);
    expect(result.committed).toBe(false);
  });

  // Dedup
  it('drops a candidate whose lesson already exists in memory', async () => {
    // Same lesson text in both the existing memory and the new candidate, so the
    // test stays tight regardless of validInput()'s default lesson.
    const dupLesson = 'Open on the sharpest claim, not the setup.';
    const input = validInput({
      readMemory: () => `- [2026-01-01 · source: seed-x] ${dupLesson}`,
      assistantText: fencedBlock({ sourceSlug: 'blog-dup', feedbackSeen: true, lessons: [dupLesson] }),
    });
    const result = await captureLessons(input);
    // The only candidate duplicates an existing lesson → nothing new captured.
    expect(result.captured).toHaveLength(0);
    expect(input.commit).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// isLessonPrivacySafe — deterministic TS privacy gate (sync)
// ---------------------------------------------------------------------------

describe('writer/capture — isLessonPrivacySafe', () => {
  it('accepts an abstract craft lesson with no private content', () => {
    expect(isLessonPrivacySafe('Lead with the takeaway, then earn it.', ['Alice', 'Bob'])).toBe(true);
  });

  it('rejects a lesson naming a configured private name', () => {
    expect(isLessonPrivacySafe('Alice said the intro was too long.', ['Alice', 'Bob'])).toBe(false);
  });

  it('rejects a lesson containing a markdown link', () => {
    expect(isLessonPrivacySafe('Mirror the structure of [this post](https://x.com/p).', [])).toBe(false);
  });

  it('rejects a lesson containing a wikilink', () => {
    expect(isLessonPrivacySafe('See [[private-note]] for the example.', [])).toBe(false);
  });

  it('rejects a lesson containing an email address', () => {
    expect(isLessonPrivacySafe('Credit the source at jane@example.com.', [])).toBe(false);
  });

  it('rejects a lesson carrying a long raw quoted excerpt', () => {
    const longQuote =
      '"the cook follows the recipe while the chef reasons from first principles every single time"';
    expect(isLessonPrivacySafe(`Echo ${longQuote} in the close.`, [])).toBe(false);
  });
});

describe('writer/capture — captureLessons privacy integration', () => {
  it('blocks a candidate carrying a private name and writes nothing when all are filtered', async () => {
    const input = validInput({
      privateNames: ['Alice'],
      assistantText: fencedBlock({
        sourceSlug: 'blog-x',
        feedbackSeen: true,
        lessons: ['Alice wanted the ending punchier.'],
      }),
    });
    const result = await captureLessons(input);
    expect(result.captured).toHaveLength(0);
    expect(result.skipReason).toBe('all-filtered');
    expect(input.commit).not.toHaveBeenCalled();
  });
});
