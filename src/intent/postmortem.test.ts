/**
 * Phase 6 test suite for `src/intent/postmortem.ts` — the Rune-owned post-mortem
 * that turns one feedback record into an attribution decision (project 14,
 * test-plan §6.4, §6.5, §6.6).
 *
 * TEST-FIRST. The module under test does not exist yet; until it lands these tests
 * fail RED on module-not-found.
 *
 * The post-mortem is RUNE-owned, not a role: a neutral LLM call (injected `ask`
 * seam) proposes a structured attribution that this module parses and validates
 * deterministically. Parsing is FAIL-SAFE — an unparseable / invalid / empty
 * post-mortem output yields `no-lesson`, never a fabricated lesson, so a broken
 * post-mortem can never write garbage into role memory.
 *
 * See: docs/projects/14-product-team-agents/test-plan.md §6
 */

import { describe, it, expect, vi } from 'vitest';

import {
  parsePostMortemResult,
  buildPostMortemPrompt,
  runPostMortem,
  POSTMORTEM_FENCE,
} from './postmortem.js';
import type { FeedbackRecord } from './feedback-record.js';

function fenced(obj: unknown): string {
  return ['```' + POSTMORTEM_FENCE, JSON.stringify(obj, null, 2), '```'].join('\n');
}

function record(overrides: Partial<FeedbackRecord> = {}): FeedbackRecord {
  return {
    projectSlug: 'my-project',
    source: 'telegram',
    createdAt: '2026-06-08T10:00:00.000Z',
    issueSummary: 'Reviewer accepted a vacuous test.',
    evidence: 'src/foo.test.ts asserted nothing yet passed.',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// parsePostMortemResult
// ---------------------------------------------------------------------------

describe('postmortem — parsePostMortemResult', () => {
  it('parses a valid lesson attribution', () => {
    const text = `Here is the post-mortem.\n\n${fenced({
      kind: 'lesson',
      stage: 'review',
      role: 'reviewer',
      lesson: 'Reject a test that asserts nothing as a vacuous pass.',
    })}`;
    expect(parsePostMortemResult(text)).toEqual({
      kind: 'lesson',
      stage: 'review',
      role: 'reviewer',
      lesson: 'Reject a test that asserts nothing as a vacuous pass.',
    });
  });

  it('parses a valid no-lesson attribution', () => {
    const text = fenced({ kind: 'no-lesson', rationale: 'External flaky dependency, uncatchable.' });
    expect(parsePostMortemResult(text)).toEqual({
      kind: 'no-lesson',
      rationale: 'External flaky dependency, uncatchable.',
    });
  });

  it('returns null when there is no fenced postmortem block', () => {
    expect(parsePostMortemResult('just prose, no block')).toBeNull();
  });

  it('returns null for invalid JSON inside the block', () => {
    const text = ['```' + POSTMORTEM_FENCE, '{ not json', '```'].join('\n');
    expect(parsePostMortemResult(text)).toBeNull();
  });

  it('returns null for an unknown kind', () => {
    expect(parsePostMortemResult(fenced({ kind: 'maybe', rationale: 'x' }))).toBeNull();
  });

  it('returns null for a lesson with a role outside the role roster', () => {
    expect(
      parsePostMortemResult(fenced({ kind: 'lesson', stage: 'review', role: 'ceo', lesson: 'x' })),
    ).toBeNull();
  });

  it('returns null for a lesson with a stage outside the stage list', () => {
    expect(
      parsePostMortemResult(fenced({ kind: 'lesson', stage: 'deployment', role: 'reviewer', lesson: 'x' })),
    ).toBeNull();
  });

  it('returns null for a lesson with an empty lesson body', () => {
    expect(
      parsePostMortemResult(fenced({ kind: 'lesson', stage: 'review', role: 'reviewer', lesson: '   ' })),
    ).toBeNull();
  });

  it('returns null for a no-lesson with an empty rationale', () => {
    expect(parsePostMortemResult(fenced({ kind: 'no-lesson', rationale: '' }))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// buildPostMortemPrompt
// ---------------------------------------------------------------------------

describe('postmortem — buildPostMortemPrompt', () => {
  it('includes the feedback record fields and the role roster', () => {
    const prompt = buildPostMortemPrompt(record());
    expect(prompt).toContain('Reviewer accepted a vacuous test.');
    expect(prompt).toContain('src/foo.test.ts asserted nothing yet passed.');
    expect(prompt).toContain('my-project');
    // The six roles must be presented as the attribution targets.
    for (const role of ['pm', 'tech-lead', 'qa', 'coder', 'reviewer', 'designer']) {
      expect(prompt).toContain(role);
    }
    // The required output fence is described.
    expect(prompt).toContain(POSTMORTEM_FENCE);
  });
});

// ---------------------------------------------------------------------------
// runPostMortem — injected ask seam, fail-safe to no-lesson
// ---------------------------------------------------------------------------

describe('postmortem — runPostMortem', () => {
  it('returns the parsed lesson attribution when the model emits a valid block', async () => {
    const ask = vi.fn().mockResolvedValue({
      text: fenced({ kind: 'lesson', stage: 'test', role: 'qa', lesson: 'Add an empty-input case.' }),
      error: null,
    });
    const result = await runPostMortem(record(), { ask });
    expect(result).toEqual({ kind: 'lesson', stage: 'test', role: 'qa', lesson: 'Add an empty-input case.' });
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it('returns the parsed no-lesson attribution', async () => {
    const ask = vi.fn().mockResolvedValue({
      text: fenced({ kind: 'no-lesson', rationale: 'Not catchable at any stage.' }),
      error: null,
    });
    const result = await runPostMortem(record(), { ask });
    expect(result.kind).toBe('no-lesson');
  });

  it('fails safe to no-lesson when the model returns no text', async () => {
    const ask = vi.fn().mockResolvedValue({ text: null, error: 'timeout' });
    const result = await runPostMortem(record(), { ask });
    expect(result.kind).toBe('no-lesson');
  });

  it('fails safe to no-lesson when the model output is unparseable', async () => {
    const ask = vi.fn().mockResolvedValue({ text: 'no fenced block here', error: null });
    const result = await runPostMortem(record(), { ask });
    expect(result.kind).toBe('no-lesson');
  });

  it('never fabricates a lesson from a malformed block (fail-closed)', async () => {
    const ask = vi.fn().mockResolvedValue({
      text: fenced({ kind: 'lesson', stage: 'review', role: 'ceo', lesson: 'x' }), // bad role
      error: null,
    });
    const result = await runPostMortem(record(), { ask });
    expect(result.kind).toBe('no-lesson');
  });
});
