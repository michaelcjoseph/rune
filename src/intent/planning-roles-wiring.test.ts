/**
 * Test for `src/intent/planning-roles-wiring.ts` — proves the planner-role
 * prompt builders actually load the Phase 1 PM / tech-lead charters from disk
 * and carry SOUL on the system channel (project 14, test-plan §2).
 *
 * Reads the real on-disk `agents/pm/SOUL.md` and `agents/tech-lead/SOUL.md`.
 */

import { describe, it, expect } from 'vitest';

import { buildPmRolePrompt, buildTechLeadRolePrompt } from './planning-roles-wiring.js';

const BASE = 'BASE-PLANNER-INSTRUCTIONS — scope the brief.';

describe('planning-roles-wiring — PM prompt', () => {
  it('loads the PM charter onto the system channel with the base instructions', () => {
    const ctx = buildPmRolePrompt(BASE);
    expect(ctx.systemInstructions).toContain(BASE);
    // The PM SOUL charter is on the system (authority) channel.
    expect(ctx.systemInstructions.toLowerCase()).toContain('product manager');
  });
});

describe('planning-roles-wiring — tech-lead prompt', () => {
  it('loads the tech-lead charter onto the system channel with the base instructions', () => {
    const ctx = buildTechLeadRolePrompt(BASE);
    expect(ctx.systemInstructions).toContain(BASE);
    expect(ctx.systemInstructions.toLowerCase()).toContain('tech lead');
  });

  it('starts cold — empty role memory yields an empty reference channel', () => {
    // The six role memory.md files ship empty (cold start), so the reference
    // channel is empty until the learning loop populates them.
    expect(buildTechLeadRolePrompt(BASE).referenceContext).toBe('');
  });
});
