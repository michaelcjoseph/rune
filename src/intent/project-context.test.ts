/**
 * Phase 2/3 test suite for `src/intent/project-context.ts` — the `context.md`
 * section schema and the planning-time seed (project 14, test-plan §2 + §3).
 *
 * Written TEST-FIRST. Until `project-context.ts` lands, the import fails and
 * every test here is RED.
 *
 * `context.md` is Rune-owned orchestration state, NOT role memory and NOT a
 * seventh role. Phase 2 seeds it at planning completion; Phase 3 adds the
 * update/validation helpers. The five required sections are the contract both
 * phases hold.
 *
 * See: docs/projects/14-product-team-agents/test-plan.md §2 (context-seed) and
 * §3 (`context.md` required sections).
 */

import { describe, it, expect } from 'vitest';

import {
  CONTEXT_SECTIONS,
  seedProjectContext,
  hasRequiredSections,
  type ContextSeedInput,
} from './project-context.js';

const BASE_SEED: ContextSeedInput = {
  product: 'aura',
  projectTitle: 'Add streak tracking',
  specSummary: 'Track daily streaks and surface them on the home card.',
  assumptions: ['Streaks reset at local midnight', 'No backfill for historical days'],
  interfaces: 'GET /api/streak returns {current, longest}.',
  risks: ['Timezone edge cases at midnight'],
  firstTaskHandoff: 'Start with the streak-count pure core before the API route.',
};

describe('project-context — section schema', () => {
  it('enumerates the five required sections in canonical order', () => {
    expect([...CONTEXT_SECTIONS]).toEqual([
      'Current State',
      'Key Decisions',
      'Interfaces & Contracts',
      'Known Risks',
      'Next Task Handoff',
    ]);
  });
});

describe('project-context — seed', () => {
  it('produces all five required section headers', () => {
    const md = seedProjectContext(BASE_SEED);
    for (const section of CONTEXT_SECTIONS) {
      expect(md).toContain(`## ${section}`);
    }
  });

  it('hasRequiredSections accepts a freshly-seeded context', () => {
    expect(hasRequiredSections(seedProjectContext(BASE_SEED))).toBe(true);
  });

  it('names the product and project title in the seed', () => {
    const md = seedProjectContext(BASE_SEED);
    expect(md).toContain('aura');
    expect(md).toContain('Add streak tracking');
  });

  it('carries assumptions into Key Decisions', () => {
    const md = seedProjectContext(BASE_SEED);
    expect(md).toContain('Streaks reset at local midnight');
  });

  it('carries the first-task handoff into Next Task Handoff', () => {
    const md = seedProjectContext(BASE_SEED);
    const handoffIdx = md.indexOf('## Next Task Handoff');
    expect(md.slice(handoffIdx)).toContain('streak-count pure core');
  });

  it('still emits every required section when optional fields are omitted', () => {
    const md = seedProjectContext({ product: 'relay', projectTitle: 'Bare project' });
    expect(hasRequiredSections(md)).toBe(true);
    // Empty sections get an explicit placeholder, never a missing header.
    for (const section of CONTEXT_SECTIONS) {
      expect(md).toContain(`## ${section}`);
    }
  });
});

describe('project-context — hasRequiredSections', () => {
  it('rejects content missing a required section', () => {
    const missingRisks = [
      '# Project Context',
      '## Current State',
      'x',
      '## Key Decisions',
      'y',
      '## Interfaces & Contracts',
      'z',
      '## Next Task Handoff',
      'w',
    ].join('\n');
    expect(hasRequiredSections(missingRisks)).toBe(false);
  });

  it('rejects an empty string', () => {
    expect(hasRequiredSections('')).toBe(false);
  });
});
