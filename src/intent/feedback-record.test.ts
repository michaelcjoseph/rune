/**
 * Phase 6 test suite for `src/intent/feedback-record.ts` — machine-readable
 * feedback record schema and validator for the vault-driven learning loop
 * (project 14, test-plan §6.2, §6.3).
 *
 * TEST-FIRST / RED-BY-DESIGN. The module under test (`./feedback-record.ts`)
 * does NOT exist yet. Every test in this file is expected to fail RED on
 * module-not-found until the Phase 6 implementation lands.
 *
 * Expected failure mode: import resolution error on `./feedback-record.js`.
 * Do NOT create `src/intent/feedback-record.ts` before the Phase 6 red
 * confirmation is recorded.
 *
 * See: docs/projects/14-product-team-agents/test-plan.md §6
 */

import { describe, it, expect } from 'vitest';

import {
  parseFeedbackRecord,
  type FeedbackRecord,
  type FeedbackSkipReason,
} from './feedback-record.js';
import { VALID_SLUG } from './sandbox.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A fully-populated valid raw record (all required + all optional fields). */
function fullRaw(): Record<string, unknown> {
  return {
    projectSlug: 'my-project',
    source: 'telegram',
    createdAt: '2026-06-08T10:00:00.000Z',
    issueSummary: 'Reviewer accepted a broken test.',
    evidence: 'The test file at src/foo.test.ts passed despite returning undefined.',
    expectedBehavior: 'Reviewer should have flagged the test as vacuous.',
    actualBehavior: 'Reviewer issued a PASS verdict.',
    runId: 'abc123',
    taskId: 'task-001',
    reporterStage: 'review' as const,
  };
}

/** A minimal valid raw record (only the 5 required fields). */
function minimalRaw(): Record<string, unknown> {
  return {
    projectSlug: 'some-slug',
    source: 'manual',
    createdAt: '2026-06-08T10:00:00.000Z',
    issueSummary: 'Coder introduced a regression.',
    evidence: 'Commit abc broke the existing test in foo.test.ts.',
  };
}

// ---------------------------------------------------------------------------
// parseFeedbackRecord — valid inputs
// ---------------------------------------------------------------------------

describe('feedback-record — parseFeedbackRecord (valid)', () => {
  it('accepts a fully-populated record and preserves all fields', () => {
    const result = parseFeedbackRecord(fullRaw());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const r = result.record as FeedbackRecord;
    expect(r.projectSlug).toBe('my-project');
    expect(r.source).toBe('telegram');
    expect(r.createdAt).toBe('2026-06-08T10:00:00.000Z');
    expect(r.issueSummary).toBe('Reviewer accepted a broken test.');
    expect(r.evidence).toBe(
      'The test file at src/foo.test.ts passed despite returning undefined.',
    );
    expect(r.expectedBehavior).toBe('Reviewer should have flagged the test as vacuous.');
    expect(r.actualBehavior).toBe('Reviewer issued a PASS verdict.');
    expect(r.runId).toBe('abc123');
    expect(r.taskId).toBe('task-001');
    expect(r.reporterStage).toBe('review');
  });

  it('accepts a minimal record with only the 5 required fields', () => {
    const result = parseFeedbackRecord(minimalRaw());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.record.projectSlug).toBe('some-slug');
    expect(result.record.issueSummary).toBe('Coder introduced a regression.');
    // Optional fields should be absent (or undefined)
    expect(result.record.expectedBehavior).toBeUndefined();
    expect(result.record.reporterStage).toBeUndefined();
  });

  it('projectSlug must satisfy VALID_SLUG — valid slug passes', () => {
    const result = parseFeedbackRecord({ ...minimalRaw(), projectSlug: 'jarvis-14' });
    expect(result.ok).toBe(true);
    // Sanity: the same slug must satisfy the shared regex
    expect(VALID_SLUG.test('jarvis-14')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// parseFeedbackRecord — non-object inputs → 'not-an-object'
// ---------------------------------------------------------------------------

describe('feedback-record — parseFeedbackRecord (non-object inputs)', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'not an object'],
    ['a number', 42],
    ['an array', ['a', 'b']],
  ])('rejects %s with reason not-an-object', (_label, value) => {
    const result = parseFeedbackRecord(value);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('not-an-object');
  });
});

// ---------------------------------------------------------------------------
// parseFeedbackRecord — missing / invalid required fields
// ---------------------------------------------------------------------------

describe('feedback-record — parseFeedbackRecord (missing required fields)', () => {
  it('missing projectSlug → missing-project-slug', () => {
    const { projectSlug: _omit, ...rest } = fullRaw();
    const result = parseFeedbackRecord(rest);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('missing-project-slug');
  });

  it('empty string projectSlug → missing-project-slug', () => {
    const result = parseFeedbackRecord({ ...fullRaw(), projectSlug: '' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('missing-project-slug');
  });

  it('projectSlug with uppercase / spaces → invalid-project-slug', () => {
    const result = parseFeedbackRecord({ ...fullRaw(), projectSlug: 'Bad Slug!' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('invalid-project-slug');
  });

  it('path-traversal projectSlug → invalid-project-slug', () => {
    const result = parseFeedbackRecord({ ...fullRaw(), projectSlug: '../escape' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('invalid-project-slug');
  });

  it('missing source → missing-source', () => {
    const { source: _omit, ...rest } = fullRaw();
    const result = parseFeedbackRecord(rest);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('missing-source');
  });

  it('empty string source → missing-source', () => {
    const result = parseFeedbackRecord({ ...fullRaw(), source: '' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('missing-source');
  });

  it('missing createdAt → missing-created-at', () => {
    const { createdAt: _omit, ...rest } = fullRaw();
    const result = parseFeedbackRecord(rest);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('missing-created-at');
  });

  it('empty string createdAt → missing-created-at', () => {
    const result = parseFeedbackRecord({ ...fullRaw(), createdAt: '' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('missing-created-at');
  });

  it('missing issueSummary → missing-issue-summary', () => {
    const { issueSummary: _omit, ...rest } = fullRaw();
    const result = parseFeedbackRecord(rest);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('missing-issue-summary');
  });

  it('missing evidence → missing-evidence', () => {
    const { evidence: _omit, ...rest } = fullRaw();
    const result = parseFeedbackRecord(rest);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('missing-evidence');
  });

  it('empty string evidence → missing-evidence', () => {
    const result = parseFeedbackRecord({ ...fullRaw(), evidence: '' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('missing-evidence');
  });

  it('first-failure-wins: a record missing several fields returns one of the expected durable reasons', () => {
    // Missing both source and evidence — returns whichever required check fires first.
    const { source: _s, evidence: _e, ...rest } = fullRaw();
    const result = parseFeedbackRecord(rest);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const VALID_REASONS: FeedbackSkipReason[] = [
      'not-an-object',
      'missing-project-slug',
      'invalid-project-slug',
      'missing-source',
      'missing-created-at',
      'missing-issue-summary',
      'missing-evidence',
    ];
    expect(VALID_REASONS).toContain(result.reason);
  });
});
