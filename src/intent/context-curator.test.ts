/**
 * Phase 3 test suite for `src/intent/context-curator.ts` — the Jarvis-owned
 * post-task `context.md` update + validation (project 14, test-plan §3
 * "context.md").
 *
 * Written TEST-FIRST. Until `context-curator.ts` lands, the import fails and
 * every test is RED. The suite stays red until the Phase 3 implementation task
 * lands in a later `/work` run — red is the success condition for the
 * Tests-write-first task.
 *
 * Contract: the context curator is the ONLY writer of `context.md`. Roles emit
 * handoff notes; the curator decides what reaches the file. It preserves the
 * five required sections, rejects transcript-style dumps, and gates contract /
 * product-intent changes on the right role's validation.
 *
 * See: docs/projects/14-product-team-agents/test-plan.md §3
 */

import { describe, it, expect } from 'vitest';

import {
  applyContextUpdate,
  CONTEXT_UPDATE_MAX_CHARS,
  type ContextUpdate,
} from './context-curator.js';
import { seedProjectContext, hasRequiredSections } from './project-context.js';

const SEED = seedProjectContext({
  product: 'aura',
  projectTitle: 'Streaks',
  specSummary: 'Track daily streaks.',
  assumptions: ['Reset at local midnight'],
});

function neutralUpdate(over: Partial<ContextUpdate> = {}): ContextUpdate {
  return {
    kind: 'neutral',
    sections: { 'Current State': 'Streak pure core landed; API route next.' },
    ...over,
  };
}

describe('context-curator — section preservation', () => {
  it('a neutral update preserves all five required sections', () => {
    const res = applyContextUpdate(SEED, neutralUpdate());
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(hasRequiredSections(res.content)).toBe(true);
      expect(res.content).toContain('Streak pure core landed');
    }
  });

  it('an update that would drop a required section is rejected', () => {
    // A malformed update whose section map somehow nukes a header must not pass.
    // We model that as a base content that is already missing a section.
    const broken = SEED.replace('## Known Risks', '## Renamed Risks');
    const res = applyContextUpdate(broken, neutralUpdate());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('missing-section');
  });
});

describe('context-curator — transcript-dump rejection', () => {
  it('rejects an over-budget update body', () => {
    const huge = 'x'.repeat(CONTEXT_UPDATE_MAX_CHARS + 1000);
    const res = applyContextUpdate(SEED, neutralUpdate({ sections: { 'Current State': huge } }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('over-budget');
  });

  it('rejects a transcript-style dump (many speaker-tagged lines)', () => {
    const transcript = Array.from({ length: 40 }, (_, i) =>
      i % 2 === 0 ? `User: do the thing ${i}` : `Assistant: okay ${i}`,
    ).join('\n');
    const res = applyContextUpdate(SEED, neutralUpdate({ sections: { 'Key Decisions': transcript } }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('transcript-dump');
  });

  it('accepts a concise decision-oriented update', () => {
    const res = applyContextUpdate(
      SEED,
      neutralUpdate({ sections: { 'Key Decisions': '- Chose UTC storage, local-tz display.' } }),
    );
    expect(res.ok).toBe(true);
  });

  it('rejects a body that embeds a required-section header (would fork the doc)', () => {
    const res = applyContextUpdate(
      SEED,
      neutralUpdate({ sections: { 'Current State': 'Done.\n\n## Known Risks\n\ninjected' } }),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('embedded-section-header');
  });
});

describe('context-curator — validation gates', () => {
  it('a technical contract change requires tech-lead validation', () => {
    const res = applyContextUpdate(
      SEED,
      neutralUpdate({
        kind: 'technical',
        validated: false,
        sections: { 'Interfaces & Contracts': 'GET /api/streak now returns {current,longest,today}.' },
      }),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('needs-tech-lead-validation');
  });

  it('a validated technical contract change is applied', () => {
    const res = applyContextUpdate(
      SEED,
      neutralUpdate({
        kind: 'technical',
        validated: true,
        sections: { 'Interfaces & Contracts': 'GET /api/streak now returns {current,longest,today}.' },
      }),
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.content).toContain('today}');
  });

  it('a flagged product-intent change requires PM validation', () => {
    const res = applyContextUpdate(
      SEED,
      neutralUpdate({
        kind: 'product',
        productIntentFlagged: true,
        validated: false,
        sections: { 'Key Decisions': 'Drop the longest-streak feature from scope.' },
      }),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('needs-pm-validation');
  });

  it('a validated product-intent change is applied', () => {
    const res = applyContextUpdate(
      SEED,
      neutralUpdate({
        kind: 'product',
        productIntentFlagged: true,
        validated: true,
        sections: { 'Key Decisions': 'Drop the longest-streak feature from scope.' },
      }),
    );
    expect(res.ok).toBe(true);
  });
});

describe('context-curator — handoff notes are curator input, not direct writes', () => {
  it('threads role handoff notes into Next Task Handoff', () => {
    const res = applyContextUpdate(
      SEED,
      neutralUpdate({ handoffNotes: ['Watch the midnight rollover in the API route.'], sections: {} }),
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      const idx = res.content.indexOf('## Next Task Handoff');
      expect(res.content.slice(idx)).toContain('midnight rollover');
    }
  });
});
