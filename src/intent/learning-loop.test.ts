/**
 * Phase 6 test suite for `src/intent/learning-loop.ts` — the vault-driven
 * nightly learning loop that reads feedback records, runs a Jarvis-owned
 * post-mortem, and writes attributed lessons into role memory
 * (project 14, test-plan §6.1, §6.5, §6.6, §6.8).
 *
 * TEST-FIRST / RED-BY-DESIGN. The module under test (`./learning-loop.ts`)
 * does NOT exist yet. Every test in this file is expected to fail RED on
 * module-not-found until the Phase 6 implementation lands.
 *
 * Expected failure mode: import resolution error on `./learning-loop.js`.
 * Do NOT create `src/intent/learning-loop.ts` before the Phase 6 red
 * confirmation is recorded.
 *
 * The `./feedback-record.js` import is ALSO a new (not-yet-existing) module.
 * All deps are injected — no real file/vault/git/LLM access.
 *
 * See: docs/projects/14-product-team-agents/test-plan.md §6
 */

import { describe, it, expect, vi } from 'vitest';

import {
  runLearningLoop,
  type LearningLoopDeps,
  type PostMortemLesson,
  type PostMortemNoLesson,
} from './learning-loop.js';
import type { FeedbackRecord } from './feedback-record.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A fully-valid FeedbackRecord fixture ready to inject via readFeedback. */
function validRecord(overrides: Partial<FeedbackRecord> = {}): FeedbackRecord {
  return {
    projectSlug: 'my-project',
    source: 'telegram',
    createdAt: '2026-06-08T10:00:00.000Z',
    issueSummary: 'Reviewer accepted a broken test.',
    evidence: 'The test at src/foo.test.ts returned undefined but was marked passing.',
    ...overrides,
  };
}

/** Returns a minimal set of injected deps — all no-ops / stubs. */
function makeDeps(overrides: Partial<LearningLoopDeps> = {}): LearningLoopDeps {
  return {
    readFeedback: () => [],
    attribute: vi.fn(),
    writeLesson: vi.fn().mockResolvedValue({ committed: false }),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// §6.1 — No feedback → no post-mortem, no write
// ---------------------------------------------------------------------------

describe('learning-loop — no feedback (§6.1)', () => {
  it('returns zero totals and never calls attribute or writeLesson', async () => {
    const attribute = vi.fn();
    const writeLesson = vi.fn();

    const result = await runLearningLoop({
      readFeedback: () => [],
      attribute,
      writeLesson,
    });

    expect(result.total).toBe(0);
    expect(result.processed).toBe(0);
    expect(result.lessonsWritten).toBe(0);
    expect(result.noLessonOutcomes).toBe(0);
    expect(result.skipped).toHaveLength(0);

    expect(attribute).not.toHaveBeenCalled();
    expect(writeLesson).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// §6.2 / §6.5 / §6.4 — Valid record → attribution → lesson written
// ---------------------------------------------------------------------------

describe('learning-loop — valid record produces a lesson write (§6.2/§6.5)', () => {
  it('calls attribute once for the valid record and writeLesson once when lesson attributed', async () => {
    const record = validRecord();

    const lessonAttribution: PostMortemLesson = {
      kind: 'lesson',
      stage: 'review',
      role: 'reviewer',
      lesson: 'Check for the off-by-one in pagination bounds.',
    };

    const attribute = vi.fn().mockResolvedValue(lessonAttribution);
    const writeLesson = vi
      .fn()
      .mockResolvedValue({ committed: true, captured: '- [2026-06-08 · source: project-14] Check for the off-by-one in pagination bounds.' });

    const result = await runLearningLoop({
      readFeedback: () => [record],
      attribute,
      writeLesson,
    });

    expect(result.total).toBe(1);
    expect(result.processed).toBe(1);
    expect(result.lessonsWritten).toBe(1);
    expect(result.noLessonOutcomes).toBe(0);
    expect(result.skipped).toHaveLength(0);

    // attribute called with the valid FeedbackRecord
    expect(attribute).toHaveBeenCalledTimes(1);
    expect(attribute).toHaveBeenCalledWith(record);

    // writeLesson called with (role, lesson text, record)
    expect(writeLesson).toHaveBeenCalledTimes(1);
    expect(writeLesson).toHaveBeenCalledWith('reviewer', lessonAttribution.lesson, record);
  });
});

// ---------------------------------------------------------------------------
// §6.3 — Malformed record → skipped with durable reason
// ---------------------------------------------------------------------------

describe('learning-loop — malformed record skipped with durable reason (§6.3)', () => {
  it('skips a malformed record and does not call attribute for it; valid record still processed', async () => {
    const goodRecord = validRecord({ projectSlug: 'good-project' });
    // Malformed: missing evidence field (raw object, not a FeedbackRecord)
    const badRaw = {
      projectSlug: 'other-project',
      source: 'manual',
      createdAt: '2026-06-08T10:00:00.000Z',
      issueSummary: 'Something broke.',
      // evidence intentionally omitted
    };

    const lessonAttribution: PostMortemLesson = {
      kind: 'lesson',
      stage: 'implementation',
      role: 'coder',
      lesson: 'Validate all required fields before accepting input.',
    };

    const attribute = vi.fn().mockResolvedValue(lessonAttribution);
    const writeLesson = vi.fn().mockResolvedValue({ committed: true, captured: '- [2026-06-08 · source: x] lesson' });

    // readFeedback returns raw objects — the loop parses them
    const result = await runLearningLoop({
      readFeedback: () => [goodRecord, badRaw],
      attribute,
      writeLesson,
    });

    // total = raw records read (both)
    expect(result.total).toBe(2);
    // processed = only the valid record
    expect(result.processed).toBe(1);
    // bad record appears in skipped with its specific reason
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.reason).toBe('missing-evidence');

    // attribute only called for the valid record (once)
    expect(attribute).toHaveBeenCalledTimes(1);
    expect(attribute).toHaveBeenCalledWith(goodRecord);

    // writeLesson called for the valid record's attribution
    expect(writeLesson).toHaveBeenCalledTimes(1);
    expect(result.lessonsWritten).toBe(1);
  });

  it('does not call writeLesson for the malformed record', async () => {
    const badRaw = {
      // Missing source and evidence
      projectSlug: 'some-project',
      createdAt: '2026-06-08T10:00:00.000Z',
      issueSummary: 'Something.',
    };

    const attribute = vi.fn();
    const writeLesson = vi.fn();

    const result = await runLearningLoop({
      readFeedback: () => [badRaw],
      attribute,
      writeLesson,
    });

    expect(result.total).toBe(1);
    expect(result.processed).toBe(0);
    expect(result.skipped).toHaveLength(1);

    expect(attribute).not.toHaveBeenCalled();
    expect(writeLesson).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// §6.6 — No lesson warranted → writeLesson NOT called
// ---------------------------------------------------------------------------

describe('learning-loop — no-lesson attribution (§6.6)', () => {
  it('increments noLessonOutcomes and does not call writeLesson when miss is uncatchable', async () => {
    const record = validRecord();

    const noLessonAttribution: PostMortemNoLesson = {
      kind: 'no-lesson',
      rationale: 'The failure was due to an external flaky dependency, uncatchable at any stage.',
    };

    const attribute = vi.fn().mockResolvedValue(noLessonAttribution);
    const writeLesson = vi.fn();

    const result = await runLearningLoop({
      readFeedback: () => [record],
      attribute,
      writeLesson,
    });

    expect(result.total).toBe(1);
    expect(result.processed).toBe(1);
    expect(result.noLessonOutcomes).toBe(1);
    expect(result.lessonsWritten).toBe(0);

    expect(attribute).toHaveBeenCalledTimes(1);
    expect(writeLesson).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Lesson attributed but declined at the write boundary (privacy-filter / dedup)
// — counts as lessonsFiltered, never silently dropped from the invariant.
// ---------------------------------------------------------------------------

describe('learning-loop — lesson attributed but write declined', () => {
  it('counts lessonsFiltered (not lessonsWritten / noLessonOutcomes) when writeLesson does not commit', async () => {
    const record = validRecord();

    const lessonAttribution: PostMortemLesson = {
      kind: 'lesson',
      stage: 'review',
      role: 'reviewer',
      lesson: 'A lesson the memory writer will reject as a duplicate.',
    };

    const attribute = vi.fn().mockResolvedValue(lessonAttribution);
    // The memory writer declined the write (privacy-filtered / duplicate / empty).
    const writeLesson = vi.fn().mockResolvedValue({ committed: false });

    const result = await runLearningLoop({
      readFeedback: () => [record],
      attribute,
      writeLesson,
    });

    expect(result.processed).toBe(1);
    expect(result.lessonsWritten).toBe(0);
    expect(result.lessonsFiltered).toBe(1);
    expect(result.noLessonOutcomes).toBe(0);

    expect(writeLesson).toHaveBeenCalledTimes(1);

    // The per-pass invariant holds: every processed record lands in exactly one bucket.
    expect(result.lessonsWritten + result.lessonsFiltered + result.noLessonOutcomes).toBe(
      result.processed,
    );
  });
});

// ---------------------------------------------------------------------------
// §6.8 — Fixture-only; multiple records each produce attribution + write
// ---------------------------------------------------------------------------

describe('learning-loop — multiple records each produce attribution + write (§6.8)', () => {
  it('two valid records → attribute called twice, writeLesson called twice', async () => {
    const record1 = validRecord({
      projectSlug: 'project-alpha',
      issueSummary: 'QA missed the edge case.',
      evidence: 'Test suite did not cover the empty-input path.',
    });
    const record2 = validRecord({
      projectSlug: 'project-beta',
      issueSummary: 'Reviewer approved a naming inconsistency.',
      evidence: 'Variable names differed across the module boundary.',
    });

    const attribution1: PostMortemLesson = {
      kind: 'lesson',
      stage: 'test',
      role: 'qa',
      lesson: 'Always add an empty-input test case to the QA suite.',
    };
    const attribution2: PostMortemLesson = {
      kind: 'lesson',
      stage: 'review',
      role: 'reviewer',
      lesson: 'Flag naming inconsistencies across module boundaries as objections.',
    };

    const attribute = vi
      .fn()
      .mockResolvedValueOnce(attribution1)
      .mockResolvedValueOnce(attribution2);

    const writeLesson = vi.fn().mockResolvedValue({ committed: true, captured: '- [2026-06-08 · source: x] lesson' });

    const result = await runLearningLoop({
      readFeedback: () => [record1, record2],
      attribute,
      writeLesson,
    });

    expect(result.total).toBe(2);
    expect(result.processed).toBe(2);
    expect(result.lessonsWritten).toBe(2);
    expect(result.skipped).toHaveLength(0);

    expect(attribute).toHaveBeenCalledTimes(2);

    expect(writeLesson).toHaveBeenCalledTimes(2);
    expect(writeLesson).toHaveBeenNthCalledWith(1, 'qa', attribution1.lesson, record1);
    expect(writeLesson).toHaveBeenNthCalledWith(2, 'reviewer', attribution2.lesson, record2);
  });

  it('uses only injected deps — no real file/vault/git/LLM access required', async () => {
    // This test documents the fixture-only contract. All deps are in-memory.
    // If this passes without touching the filesystem, the seam is correct.
    const deps = makeDeps({
      readFeedback: () => [],
    });

    // Should complete without throwing (no real I/O)
    const result = await runLearningLoop(deps);
    expect(result.total).toBe(0);
  });
});
