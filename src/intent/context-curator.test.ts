/**
 * Phase 3 test suite for `src/intent/context-curator.ts` — the Rune-owned
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
import {
  CONTEXT_SECTIONS,
  seedProjectContext,
  hasRequiredSections,
} from './project-context.js';

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

  it('migrates the exact legacy Canonical Interfaces heading in place without losing its body', () => {
    const legacy = SEED.replace(
      '## Interfaces & Contracts\n\n_None yet._',
      '## Canonical Interfaces\n\nPOST /v1/assays accepts a signed manifest.',
    );

    const res = applyContextUpdate(legacy, neutralUpdate({ sections: {} }));

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.content).toContain(
        '## Interfaces & Contracts\n\nPOST /v1/assays accepts a signed manifest.',
      );
      expect(res.content).not.toContain('## Canonical Interfaces');
      for (const section of CONTEXT_SECTIONS) {
        expect(res.content.match(new RegExp(`^## ${section.replace(/[&]/g, '\\&')}$`, 'gm')))
          .toHaveLength(1);
      }
    }
  });

  it('upserts every absent canonical section with the explicit placeholder', () => {
    const partial = [
      '# Project Context: Assay',
      '',
      '## Current State',
      '',
      'Reviewed implementation is ready for closeout.',
      '',
    ].join('\n');

    const res = applyContextUpdate(partial, neutralUpdate({ sections: {} }));

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.content).toContain('Reviewed implementation is ready for closeout.');
      for (const section of CONTEXT_SECTIONS) {
        expect(res.content.match(new RegExp(`^## ${section.replace(/[&]/g, '\\&')}$`, 'gm')))
          .toHaveLength(1);
      }
      expect(res.content.match(/^_None yet\._$/gm)).toHaveLength(4);
    }
  });

  it('rejects a duplicate canonical heading with actionable structured diagnostics', () => {
    const duplicate = `${SEED.trimEnd()}\n\n## Known Risks\n\nA second competing body.\n`;

    const res = applyContextUpdate(duplicate, neutralUpdate({ sections: {} }));

    expect(res).toMatchObject({
      ok: false,
      reason: 'duplicate-managed-section',
      canonicalHeading: '## Known Risks',
      conflictingHeadings: ['## Known Risks', '## Known Risks'],
      proposedRepair: expect.stringMatching(/keep exactly one|merge.*one/i),
    });
    if (!res.ok) {
      expect(String((res as unknown as Record<string, unknown>)['proposedRepair']).length)
        .toBeLessThanOrEqual(500);
    }
  });

  it('bounds duplicate diagnostics while preserving the total conflicting-heading count', () => {
    const duplicateBodies = Array.from(
      { length: 10 },
      (_, index) => `## Known Risks\n\nCompeting body ${index + 2}.`,
    ).join('\n\n');

    const res = applyContextUpdate(
      `${SEED.trimEnd()}\n\n${duplicateBodies}\n`,
      neutralUpdate({ sections: {} }),
    );

    expect(res).toMatchObject({
      ok: false,
      reason: 'duplicate-managed-section',
      canonicalHeading: '## Known Risks',
      conflictingHeadingCount: 11,
      conflictingHeadings: Array.from({ length: 10 }, () => '## Known Risks'),
    });
  });

  it('rejects a legacy/canonical collision instead of guessing how to merge the bodies', () => {
    const collision = `${SEED.trimEnd()}\n\n## Canonical Interfaces\n\nLegacy competing body.\n`;

    const res = applyContextUpdate(collision, neutralUpdate({ sections: {} }));

    expect(res).toMatchObject({
      ok: false,
      reason: 'managed-heading-collision',
      canonicalHeading: '## Interfaces & Contracts',
      conflictingHeadings: ['## Interfaces & Contracts', '## Canonical Interfaces'],
      proposedRepair: expect.stringMatching(/merge|remove|keep/i),
    });
    if (!res.ok) {
      expect(String((res as unknown as Record<string, unknown>)['proposedRepair']).length)
        .toBeLessThanOrEqual(500);
    }
  });

  it.each([
    {
      name: 'duplicate canonical plus legacy',
      extra: [
        '## Interfaces & Contracts',
        '',
        'Second canonical body.',
        '',
        '## Canonical Interfaces',
        '',
        'Legacy body.',
      ].join('\n'),
      conflicts: [
        '## Interfaces & Contracts',
        '## Interfaces & Contracts',
        '## Canonical Interfaces',
      ],
    },
    {
      name: 'canonical plus duplicate legacy',
      extra: [
        '## Canonical Interfaces',
        '',
        'First legacy body.',
        '',
        '## Canonical Interfaces',
        '',
        'Second legacy body.',
      ].join('\n'),
      conflicts: [
        '## Interfaces & Contracts',
        '## Canonical Interfaces',
        '## Canonical Interfaces',
      ],
    },
  ])('reports every competing occurrence for $name', ({ extra, conflicts }) => {
    const res = applyContextUpdate(
      `${SEED.trimEnd()}\n\n${extra}\n`,
      neutralUpdate({ sections: {} }),
    );

    expect(res).toMatchObject({
      ok: false,
      reason: 'managed-heading-collision',
      canonicalHeading: '## Interfaces & Contracts',
      conflictingHeadings: conflicts,
      proposedRepair: expect.stringMatching(/all competing bodies.*exactly one/i),
    });
  });

  it('upserts a true canonical heading when malformed text splits the heading across lines', () => {
    const malformed = SEED.replace(
      '## Interfaces & Contracts',
      '##\nInterfaces & Contracts',
    );
    const res = applyContextUpdate(malformed, neutralUpdate({ sections: {} }));

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.content.match(/^## Interfaces & Contracts$/gm)).toHaveLength(1);
      expect(res.content).toContain('##\nInterfaces & Contracts');
    }
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
    expect(res).toMatchObject({
      ok: false,
      reason: 'embedded-section-header',
      canonicalHeading: '## Known Risks',
      conflictingHeadings: ['## Known Risks'],
      proposedRepair: expect.stringMatching(/remove.*heading|body/i),
    });
  });

  it('rejects a body that embeds the legacy managed heading', () => {
    const res = applyContextUpdate(
      SEED,
      neutralUpdate({
        sections: {
          'Next Task Handoff': 'Continue the rollout.\n\n## Canonical Interfaces\n\ninjected',
        },
      }),
    );

    expect(res).toMatchObject({
      ok: false,
      reason: 'embedded-section-header',
      canonicalHeading: '## Interfaces & Contracts',
      conflictingHeadings: ['## Canonical Interfaces'],
      proposedRepair: expect.stringMatching(/remove.*heading|body/i),
    });
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
