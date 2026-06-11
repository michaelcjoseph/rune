/**
 * Test for `src/intent/planning-roles-wiring.ts` — proves the planner-role
 * prompt builders actually load the Phase 1 PM / tech-lead charters from disk
 * and carry SOUL on the system channel (project 14, test-plan §2).
 *
 * Reads the real on-disk `agents/pm/SOUL.md` and `agents/tech-lead/SOUL.md`.
 */

import { describe, it, expect } from 'vitest';

import {
  buildPmRolePrompt,
  buildTechLeadRolePrompt,
  defaultPlanningRoleDeps,
  type RoleModelCall,
} from './planning-roles-wiring.js';

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

// ---------------------------------------------------------------------------
// Production seams — defaultPlanningRoleDeps over an injected model call
// ---------------------------------------------------------------------------

/** A model-call stub keyed by role, so each seam gets its canned reply with no
 *  live model call. Captures the last system prompt seen per role for the
 *  independence assertion. */
function stubModelCall(replies: { pm?: string[]; 'tech-lead'?: string }): {
  call: RoleModelCall;
  seenSystem: Record<string, string>;
} {
  const seenSystem: Record<string, string> = {};
  const pmQueue = [...(replies.pm ?? [])];
  const call: RoleModelCall = async ({ role, systemPrompt }) => {
    seenSystem[role] = systemPrompt;
    if (role === 'pm') return pmQueue.shift() ?? '';
    if (role === 'tech-lead') return replies['tech-lead'] ?? '';
    return '';
  };
  return { call, seenSystem };
}

const SPECIFIED_REPLY = [
  'Here is the spec.',
  '```pm-assessment',
  JSON.stringify({
    specifiedEnough: true,
    title: 'Streak tracker',
    spec: 'Track daily streaks for the home screen.',
    assumptions: ['Streaks reset at local midnight'],
  }),
  '```',
].join('\n');

const BREAKDOWN_REPLY = [
  '```tech-breakdown',
  JSON.stringify({
    techSpec: 'Pure core + REST route + card.',
    tasks: [
      { id: 'p1-core', text: 'Streak core', phase: 'Phase 1 - Core', testStrategy: 'code-tests-required', designerNeeded: false, roles: ['qa', 'coder'] },
      { id: 'p2-card', text: 'Home card', phase: 'Phase 2 - UI', testStrategy: 'bogus-strategy', designerNeeded: true, roles: ['designer'] },
    ],
  }),
  '```',
].join('\n');

// A spec body carrying the two things that corrupt inline JSON: unescaped
// double-quotes and a nested ``` code fence. In the split format these ride a
// ```pm-spec sibling fence, so they never have to survive JSON-escaping — the
// exact failure mode that made long cockpit specs block-loop the PM seam.
const HAZARDOUS_SPEC = [
  '# Cockpit Redesign',
  '',
  'Today the view is ~90% chat. Success is "felt, not shipped".',
  '',
  '```ts',
  'type Run = { id: string; status: "active" | "done" };',
  '```',
  '',
  '## Definition of done',
  '- Per-product views exist.',
].join('\n');

const SPLIT_SPECIFIED_REPLY = [
  '```pm-assessment',
  JSON.stringify({
    specifiedEnough: true,
    title: 'Cockpit redesign',
    assumptions: ['Chat moves to the Claude App'],
  }),
  '```',
  '```pm-spec',
  HAZARDOUS_SPEC,
  '```',
].join('\n');

const HAZARDOUS_TECH_SPEC = [
  '# Tech spec',
  '',
  'Reuse the existing run shape — note the "active" literal:',
  '',
  '```ts',
  'interface Run { id: string; label: "active" | "idle"; }',
  '```',
].join('\n');

const SPLIT_BREAKDOWN_REPLY = [
  '```tech-breakdown',
  JSON.stringify({
    tasks: [
      { id: 'p1-core', text: 'Run model', phase: 'Phase 1 - Core', testStrategy: 'code-tests-required', designerNeeded: false, roles: ['coder'] },
    ],
  }),
  '```',
  '```tech-spec',
  HAZARDOUS_TECH_SPEC,
  '```',
].join('\n');

describe('planning-roles-wiring — PM assessment seam', () => {
  it('parses a specified-enough reply into title/spec/assumptions', async () => {
    const { call, seenSystem } = stubModelCall({ pm: [SPECIFIED_REPLY] });
    const deps = defaultPlanningRoleDeps(call);
    const result = await deps.pmAssessAndSpec({ brief: 'streaks', product: 'aura' });
    expect(result.specifiedEnough).toBe(true);
    if (result.specifiedEnough) {
      expect(result.title).toBe('Streak tracker');
      expect(result.assumptions).toContain('Streaks reset at local midnight');
    }
    // SOUL (system-prompt authority) carried the PM charter — role independence.
    expect(seenSystem['pm']?.toLowerCase()).toContain('product manager');
  });

  it('split format: spec markdown with unescaped quotes + a nested code fence survives verbatim', async () => {
    const { call } = stubModelCall({ pm: [SPLIT_SPECIFIED_REPLY] });
    const result = await defaultPlanningRoleDeps(call).pmAssessAndSpec({ brief: 'cockpit', product: 'jarvis' });
    expect(result.specifiedEnough).toBe(true);
    if (result.specifiedEnough) {
      expect(result.title).toBe('Cockpit redesign');
      // The exact characters that corrupt inline JSON are preserved.
      expect(result.spec).toContain('"felt, not shipped"');
      expect(result.spec).toContain('```ts');
      expect(result.spec).toContain('status: "active" | "done"');
      expect(result.spec).toContain('## Definition of done');
      expect(result.assumptions).toContain('Chat moves to the Claude App');
    }
  });

  it('parses an underspecified reply into interview needs', async () => {
    const reply = ['```pm-assessment', JSON.stringify({ specifiedEnough: false, interviewNeeds: ['What platform?'] }), '```'].join('\n');
    const { call } = stubModelCall({ pm: [reply] });
    const result = await defaultPlanningRoleDeps(call).pmAssessAndSpec({ brief: 'x', product: 'aura' });
    expect(result.specifiedEnough).toBe(false);
    if (!result.specifiedEnough) expect(result.interviewNeeds).toContain('What platform?');
  });

  it('FAIL-CLOSED: an unparseable reply blocks for interview, never fabricates a spec', async () => {
    const { call } = stubModelCall({ pm: ['no fenced block here, just prose'] });
    const result = await defaultPlanningRoleDeps(call).pmAssessAndSpec({ brief: 'x', product: 'aura' });
    expect(result.specifiedEnough).toBe(false);
  });

  it('FAIL-CLOSED: claims specified-enough but omits the spec body → blocks', async () => {
    const reply = ['```pm-assessment', JSON.stringify({ specifiedEnough: true, title: 'T' }), '```'].join('\n');
    const { call } = stubModelCall({ pm: [reply] });
    const result = await defaultPlanningRoleDeps(call).pmAssessAndSpec({ brief: 'x', product: 'aura' });
    expect(result.specifiedEnough).toBe(false);
  });
});

describe('planning-roles-wiring — tech-lead breakdown seam', () => {
  it('parses tasks with test strategy + designer flag + phase', async () => {
    const { call } = stubModelCall({ 'tech-lead': BREAKDOWN_REPLY });
    const result = await defaultPlanningRoleDeps(call).techLeadBreakdown({ brief: 'x', product: 'aura', spec: 's' });
    expect(result.tasks).toHaveLength(2);
    expect(result.tasks.find((t) => t.id === 'p2-card')?.designerNeeded).toBe(true);
    expect(result.tasks.find((t) => t.id === 'p1-core')?.phase).toBe('Phase 1 - Core');
    expect(result.tasks.find((t) => t.id === 'p2-card')?.phase).toBe('Phase 2 - UI');
  });

  it('split format: tech spec markdown with a nested code fence survives, tasks still parse', async () => {
    const { call } = stubModelCall({ 'tech-lead': SPLIT_BREAKDOWN_REPLY });
    const result = await defaultPlanningRoleDeps(call).techLeadBreakdown({ brief: 'x', product: 'jarvis', spec: 's' });
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]?.id).toBe('p1-core');
    expect(result.techSpec).toContain('```ts');
    expect(result.techSpec).toContain('interface Run');
    expect(result.techSpec).toContain('"active" | "idle"');
  });

  it('defaults an invalid testStrategy to code-tests-required', async () => {
    const { call } = stubModelCall({ 'tech-lead': BREAKDOWN_REPLY });
    const result = await defaultPlanningRoleDeps(call).techLeadBreakdown({ brief: 'x', product: 'aura', spec: 's' });
    expect(result.tasks.find((t) => t.id === 'p2-card')?.testStrategy).toBe('code-tests-required');
  });

  it('THROWS on an unparseable breakdown — an empty plan must never reach scaffolding', async () => {
    const { call } = stubModelCall({ 'tech-lead': 'no breakdown block' });
    await expect(
      defaultPlanningRoleDeps(call).techLeadBreakdown({ brief: 'x', product: 'aura', spec: 's' }),
    ).rejects.toThrow();
  });
});

describe('planning-roles-wiring — PM review seam', () => {
  it('parses a clean match', async () => {
    const reply = ['```pm-review', JSON.stringify({ match: true, mismatches: [] }), '```'].join('\n');
    const { call } = stubModelCall({ pm: [reply] });
    const result = await defaultPlanningRoleDeps(call).pmReviewMatch({ spec: 's', techSpec: 't', tasks: [] });
    expect(result.match).toBe(true);
  });

  it('FAIL-CLOSED: an unparseable review reports a mismatch, never a silent pass', async () => {
    const { call } = stubModelCall({ pm: ['prose, no fence'] });
    const result = await defaultPlanningRoleDeps(call).pmReviewMatch({ spec: 's', techSpec: 't', tasks: [] });
    expect(result.match).toBe(false);
    expect(result.mismatches.length).toBeGreaterThan(0);
  });
});
