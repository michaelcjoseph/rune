/**
 * Phase 2 test suite for `src/writer/sentinel.ts` — the writer completion
 * sentinel (project 12, test-plan §2: final-line sentinel hygiene).
 *
 * Written TEST-FIRST. The scaffold body throws
 * `writer/sentinel: detectCompletionSentinel not implemented (...)`, so every
 * test here is RED until the Phase 2 sentinel implementation lands.
 *
 * Expected failure mode: the "not implemented" throw or a clean assertion
 * failure — never a module-resolution or syntax error.
 *
 * See: docs/projects/12-writer-memory/test-plan.md §2
 */

import { describe, it, expect } from 'vitest';

import { detectCompletionSentinel, WRITER_COMPLETION_SENTINEL } from './sentinel.js';

const S = WRITER_COMPLETION_SENTINEL;

describe('writer/sentinel — detectCompletionSentinel', () => {
  it('detects the sentinel on the final line and strips it from cleaned', () => {
    const text = `Here is your draft. I think the hook lands.\n\n${S}`;
    const out = detectCompletionSentinel(text);
    expect(out.complete).toBe(true);
    expect(out.cleaned).not.toContain(S);
    expect(out.cleaned).toContain('Here is your draft.');
  });

  it('counts a final-line sentinel even with trailing blank lines after it', () => {
    const text = `Final revision below.\n${S}\n\n`;
    const out = detectCompletionSentinel(text);
    expect(out.complete).toBe(true);
    expect(out.cleaned).not.toContain(S);
  });

  it('does NOT count a sentinel that appears only earlier in the prose', () => {
    const text = `I will emit ${S} when we are done, but we are not done yet.\n\nWhat do you think of the intro?`;
    const out = detectCompletionSentinel(text);
    expect(out.complete).toBe(false);
    // Non-final sentinel is left untouched — it's just prose.
    expect(out.cleaned).toBe(text);
  });

  it('returns complete=false and unchanged text when no sentinel is present', () => {
    const text = 'Just a normal turn with a question at the end?';
    const out = detectCompletionSentinel(text);
    expect(out.complete).toBe(false);
    expect(out.cleaned).toBe(text);
  });

  it('handles text that is only the sentinel → complete, empty cleaned', () => {
    const out = detectCompletionSentinel(S);
    expect(out.complete).toBe(true);
    expect(out.cleaned.trim()).toBe('');
  });

  it('still counts an incidentally-indented final-line sentinel (trim leniency)', () => {
    // Deliberate: a missed real sentinel forces a manual /done, worse than the
    // near-impossible false positive of an unintended indented final-line sentinel.
    const out = detectCompletionSentinel(`Draft done.\n\n   ${S}`);
    expect(out.complete).toBe(true);
    expect(out.cleaned).toBe('Draft done.');
  });
});
