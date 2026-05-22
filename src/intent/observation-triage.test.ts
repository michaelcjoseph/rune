import { describe, it, expect } from 'vitest';

/*
 * Test suite for the triage formatter (08-intent-layer, Phase 5). The triage decision
 * itself is the LLM callback `runObservationLoop` takes; this module is the deterministic
 * formatter that turns the loop's filed outcomes into the markdown lines that get appended
 * to `docs/projects/ideas.md`. Discarded, duplicate, and quiet outcomes produce no
 * markdown — they have no entry to file.
 */

import { formatIdeasMarkdown } from './observation-triage.js';
import type { LoopOutcome, ProjectIdea } from './observation-loop.js';

function idea(overrides: Partial<ProjectIdea> = {}): ProjectIdea {
  return { title: 'Fix the friction', friction: 'the friction', id: 'fix-friction', ...overrides };
}

describe('observation triage — formatIdeasMarkdown', () => {
  it('returns an empty string when there is nothing to file', () => {
    const outcomes: LoopOutcome[] = [
      { kind: 'quiet' },
      { kind: 'discarded', reason: 'not worth a project' },
      { kind: 'duplicate', existingId: 'x' },
    ];
    expect(formatIdeasMarkdown(outcomes)).toBe('');
  });

  it('formats a single filed outcome as one markdown bullet', () => {
    const out = formatIdeasMarkdown([{ kind: 'filed', idea: idea() }]);
    expect(out).toContain('Fix the friction');
    expect(out).toContain('the friction');
    expect(out).toMatch(/^- /m); // bullet line
  });

  it('formats multiple filed outcomes as multiple lines in input order', () => {
    const out = formatIdeasMarkdown([
      { kind: 'filed', idea: idea({ title: 'First', friction: 'a', id: 'a' }) },
      { kind: 'filed', idea: idea({ title: 'Second', friction: 'b', id: 'b' }) },
    ]);
    const firstAt = out.indexOf('First');
    const secondAt = out.indexOf('Second');
    expect(firstAt).toBeGreaterThanOrEqual(0);
    expect(secondAt).toBeGreaterThan(firstAt);
  });

  it('skips non-filed outcomes when mixed with filed ones', () => {
    const out = formatIdeasMarkdown([
      { kind: 'discarded', reason: 'noise' },
      { kind: 'filed', idea: idea({ title: 'Real', friction: 'a real one', id: 'r' }) },
      { kind: 'duplicate', existingId: 'r' },
      { kind: 'quiet' },
    ]);
    expect(out).toContain('Real');
    expect(out).not.toContain('noise');
    expect(out).not.toContain('quiet');
  });

  it('ends with a trailing newline so appending to ideas.md is well-formed', () => {
    const out = formatIdeasMarkdown([{ kind: 'filed', idea: idea() }]);
    expect(out.endsWith('\n')).toBe(true);
  });
});
