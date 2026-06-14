/**
 * Phase 9 test suite — the planning critique pass (project 14, test-plan §9 /
 * spec.md §"Planning critique pass", requirements 8a–8c).
 *
 * Written TEST-FIRST. Until `planning-critique.ts` lands (and `runPlannerRoles`
 * grows a `critiquePlan` seam + `codexCritiqueSkipped` outcome flag), the import
 * fails / the integration assertions fail — every test here is RED.
 *
 * The critique is a Jarvis-owned NEUTRAL step (not a seventh role): a pure
 * orchestration over injected per-model seams — Claude (Opus 4.8) critiques and
 * revises first, then Codex (GPT-5.5) critiques and revises Claude's output —
 * one pass each, no looping, degrade-to-Claude when Codex is unavailable. These
 * tests inject the model seams so the flow runs with NO live call.
 */

import { describe, it, expect, vi } from 'vitest';

import {
  runPlanningCritique,
  type PlanCritique,
  type PlanningCritiqueDeps,
} from './planning-critique.js';
import {
  runPlannerRoles,
  type PlanningRoleDeps,
  type PmSpecResult,
  type TechLeadResult,
  type SpecMatchResult,
  type SizedTask,
} from './planning-roles.js';
import {
  parseCritiqueReply,
  buildProductionCritiquePlan,
} from './planning-roles-wiring.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TASKS: SizedTask[] = [
  {
    id: 'p1-core',
    text: 'Implement the pure core',
    testStrategy: 'code-tests-required',
    designerNeeded: false,
    roles: ['qa', 'coder', 'reviewer'],
  },
];

const BASE_PLAN: PlanCritique = {
  spec: 'Original spec.\n\n## Assumptions\n\n- a',
  techSpec: 'Original tech spec.',
  tasks: TASKS,
};

/** A distinct revised plan so "was the critique applied?" is observable. */
function revise(plan: PlanCritique, tag: string): PlanCritique {
  return {
    spec: `${plan.spec}\n\n<!-- ${tag} -->`,
    techSpec: `${plan.techSpec}\n\n<!-- ${tag} -->`,
    tasks: [...plan.tasks, {
      id: `extra-${tag}`,
      text: `task added by ${tag}`,
      testStrategy: 'code-tests-required',
      designerNeeded: false,
      roles: ['qa', 'coder'],
    }],
  };
}

function makeCritiqueDeps(over: Partial<PlanningCritiqueDeps> = {}): PlanningCritiqueDeps {
  return {
    critiqueWithClaude: async (plan) => revise(plan, 'claude'),
    critiqueWithCodex: async (plan) => revise(plan, 'codex'),
    isCodexAvailable: async () => true,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Sequential, cross-model — Claude first, then Codex over Claude's output
// ---------------------------------------------------------------------------

describe('planning-critique — sequential cross-model order', () => {
  it('runs Claude first, then Codex over the Claude-revised artifacts', async () => {
    const seen: { codexInput?: PlanCritique } = {};
    const claudeOut = revise(BASE_PLAN, 'claude');
    const deps = makeCritiqueDeps({
      critiqueWithClaude: async () => claudeOut,
      critiqueWithCodex: async (plan) => {
        seen.codexInput = plan;
        return revise(plan, 'codex');
      },
    });

    const result = await runPlanningCritique(BASE_PLAN, deps);

    // Codex received Claude's revised output, NOT the original plan.
    expect(seen.codexInput).toEqual(claudeOut);
    // The final plan carries both passes' marks (codex ran over claude's).
    expect(result.plan.spec).toContain('<!-- claude -->');
    expect(result.plan.spec).toContain('<!-- codex -->');
  });

  it('invokes each model exactly once — the pass does not loop to convergence', async () => {
    const claude = vi.fn(async (plan: PlanCritique) => revise(plan, 'claude'));
    const codex = vi.fn(async (plan: PlanCritique) => revise(plan, 'codex'));
    const deps = makeCritiqueDeps({ critiqueWithClaude: claude, critiqueWithCodex: codex });

    await runPlanningCritique(BASE_PLAN, deps);

    expect(claude).toHaveBeenCalledTimes(1);
    expect(codex).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Codex-degrade — Claude alone when Codex is unavailable, never blocks
// ---------------------------------------------------------------------------

describe('planning-critique — Codex degrade', () => {
  it('runs the Claude pass alone and records the skip when Codex is unavailable', async () => {
    const codex = vi.fn(async (plan: PlanCritique) => revise(plan, 'codex'));
    const deps = makeCritiqueDeps({
      critiqueWithCodex: codex,
      isCodexAvailable: async () => false,
    });

    const result = await runPlanningCritique(BASE_PLAN, deps);

    expect(codex).not.toHaveBeenCalled();
    expect(result.codexSkipped).toBe(true);
    // The Claude-revised plan still comes through — never blocks on the 2nd model.
    expect(result.plan.spec).toContain('<!-- claude -->');
    expect(result.plan.spec).not.toContain('<!-- codex -->');
  });

  it('marks codexSkipped false when Codex ran', async () => {
    const result = await runPlanningCritique(BASE_PLAN, makeCritiqueDeps());
    expect(result.codexSkipped).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// No-op + fail-closed — never drops content
// ---------------------------------------------------------------------------

describe('planning-critique — no-op and fail-closed', () => {
  it('returns the plan unchanged when both passes make no change (no-op is not an error)', async () => {
    const deps = makeCritiqueDeps({
      critiqueWithClaude: async (plan) => plan,
      critiqueWithCodex: async (plan) => plan,
    });

    const result = await runPlanningCritique(BASE_PLAN, deps);

    expect(result.plan).toEqual(BASE_PLAN);
  });

  it('falls back to the pre-critique plan when the Claude reply is unparseable (null)', async () => {
    const codex = vi.fn(async (plan: PlanCritique) => plan);
    const deps = makeCritiqueDeps({
      critiqueWithClaude: async () => null, // unparseable
      critiqueWithCodex: codex,
    });

    const result = await runPlanningCritique(BASE_PLAN, deps);

    // Codex still runs, but over the ORIGINAL plan (Claude's pass was dropped).
    expect(codex).toHaveBeenCalledWith(BASE_PLAN);
    expect(result.plan).toEqual(BASE_PLAN);
  });

  it('keeps the Claude-revised plan when the Codex reply is unparseable (null)', async () => {
    const claudeOut = revise(BASE_PLAN, 'claude');
    const deps = makeCritiqueDeps({
      critiqueWithClaude: async () => claudeOut,
      critiqueWithCodex: async () => null, // unparseable
    });

    const result = await runPlanningCritique(BASE_PLAN, deps);

    expect(result.plan).toEqual(claudeOut);
  });

  it('returns the original plan when Claude is unparseable AND Codex is unavailable', async () => {
    const deps = makeCritiqueDeps({
      critiqueWithClaude: async () => null,
      isCodexAvailable: async () => false,
    });

    const result = await runPlanningCritique(BASE_PLAN, deps);

    expect(result.plan).toEqual(BASE_PLAN);
    expect(result.codexSkipped).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Integration with runPlannerRoles — gate position + approval surface
// ---------------------------------------------------------------------------

const SIZED: SizedTask[] = [
  {
    id: 'p1',
    text: 'do the thing',
    testStrategy: 'code-tests-required',
    designerNeeded: false,
    roles: ['qa', 'coder', 'reviewer'],
  },
];

function specifiedPm(): PmSpecResult {
  return {
    specifiedEnough: true,
    title: 'A project',
    spec: 'Build it.\n\n## Assumptions\n\n- x',
    assumptions: ['x'],
  };
}

function makeRoleDeps(over: Partial<PlanningRoleDeps> = {}): PlanningRoleDeps {
  return {
    pmAssessAndSpec: async () => specifiedPm(),
    techLeadBreakdown: async (): Promise<TechLeadResult> => ({
      techSpec: 'tech spec',
      tasks: SIZED,
    }),
    pmReviewMatch: async (): Promise<SpecMatchResult> => ({ match: true, mismatches: [] }),
    ...over,
  };
}

const ROLE_INPUT = { brief: 'a brief', product: 'aura' };

describe('planning-critique — runPlannerRoles integration', () => {
  it('runs the critique AFTER the spec/tech-spec match gate and feeds its revision into the planned outcome (approval surface)', async () => {
    const critiquePlan = vi.fn(async (plan: PlanCritique) => ({
      plan: {
        spec: `${plan.spec}\n\n<!-- critiqued -->`,
        techSpec: `${plan.techSpec}\n\n<!-- critiqued -->`,
        tasks: plan.tasks,
      },
      codexSkipped: false,
    }));
    const deps = makeRoleDeps({ critiquePlan } as Partial<PlanningRoleDeps>);

    const outcome = await runPlannerRoles(ROLE_INPUT, deps);

    expect(critiquePlan).toHaveBeenCalledTimes(1);
    expect(outcome.kind).toBe('planned');
    if (outcome.kind === 'planned') {
      // The approval-surface artifacts carry the critique-introduced change.
      expect(outcome.spec).toContain('<!-- critiqued -->');
      expect(outcome.techSpec).toContain('<!-- critiqued -->');
      // The seeded context derives from the revised spec.
      expect(outcome.context.length).toBeGreaterThan(0);
    }
  });

  it('does NOT run the critique when the PM blocks for interview (gate 1)', async () => {
    const critiquePlan = vi.fn(async (plan: PlanCritique) => ({ plan, codexSkipped: false }));
    const deps = makeRoleDeps({
      pmAssessAndSpec: async () => ({ specifiedEnough: false, interviewNeeds: ['?'] }),
      critiquePlan,
    } as Partial<PlanningRoleDeps>);

    const outcome = await runPlannerRoles(ROLE_INPUT, deps);

    expect(outcome.kind).toBe('blocked-for-interview');
    expect(critiquePlan).not.toHaveBeenCalled();
  });

  it('does NOT run the critique when the PM flags a spec/tech-spec mismatch (gate 2)', async () => {
    const critiquePlan = vi.fn(async (plan: PlanCritique) => ({ plan, codexSkipped: false }));
    const deps = makeRoleDeps({
      pmReviewMatch: async () => ({ match: false, mismatches: ['drift'] }),
      critiquePlan,
    } as Partial<PlanningRoleDeps>);

    const outcome = await runPlannerRoles(ROLE_INPUT, deps);

    expect(outcome.kind).toBe('spec-mismatch');
    expect(critiquePlan).not.toHaveBeenCalled();
  });

  it('records codexCritiqueSkipped on the planned outcome when the critique skipped Codex', async () => {
    const critiquePlan = vi.fn(async (plan: PlanCritique) => ({ plan, codexSkipped: true }));
    const deps = makeRoleDeps({ critiquePlan } as Partial<PlanningRoleDeps>);

    const outcome = await runPlannerRoles(ROLE_INPUT, deps);

    expect(outcome.kind).toBe('planned');
    if (outcome.kind === 'planned') {
      expect(outcome.codexCritiqueSkipped).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Production binding — parser + buildProductionCritiquePlan over injected seams
// ---------------------------------------------------------------------------

function critiqueReply(specMark: string, taskId: string): string {
  return [
    'Here is my critique.',
    '```critique-tasks',
    `{"tasks": [{"id": "${taskId}", "text": "revised task", "testStrategy": "code-tests-required", "designerNeeded": false, "roles": ["qa", "coder"]}]}`,
    '```',
    '```critique-spec',
    `Revised spec ${specMark}`,
    '```',
    '```critique-tech-spec',
    `Revised tech spec ${specMark}`,
    '```',
  ].join('\n');
}

describe('planning-critique — production parser', () => {
  it('parses a well-formed reply into a revised plan with NO block bleed-through', () => {
    const out = parseCritiqueReply(critiqueReply('X', 'r1'), BASE_PLAN);
    expect(out).not.toBeNull();
    // Strict equality (not toContain) so a future regression where the tech-spec
    // block bleeds into the spec field is caught.
    expect(out!.spec).toBe('Revised spec X');
    expect(out!.spec).not.toContain('critique-tech-spec');
    expect(out!.techSpec).toBe('Revised tech spec X');
    expect(out!.tasks).toHaveLength(1);
    expect(out!.tasks[0]!.id).toBe('r1');
  });

  it('handles nested ``` code fences inside a spec block without truncating', () => {
    const reply = [
      '```critique-tasks',
      '{"tasks": []}',
      '```',
      '```critique-spec',
      'Spec with code:\n```ts\nconst x = 1;\n```\nmore spec',
      '```',
      '```critique-tech-spec',
      'Tech spec body',
      '```',
    ].join('\n');
    const out = parseCritiqueReply(reply, BASE_PLAN);
    expect(out).not.toBeNull();
    expect(out!.spec).toContain('const x = 1;');
    expect(out!.spec).toContain('more spec');
    expect(out!.techSpec).toBe('Tech spec body');
  });

  it('returns null when no recognizable critique block is present (unparseable → keep prior)', () => {
    expect(parseCritiqueReply('no fenced blocks here', BASE_PLAN)).toBeNull();
  });

  it('keeps the fallback artifacts for blocks that are missing (never drops content)', () => {
    const partial = ['```critique-spec', 'Only the spec changed', '```'].join('\n');
    const out = parseCritiqueReply(partial, BASE_PLAN);
    expect(out).not.toBeNull();
    expect(out!.spec).toBe('Only the spec changed');
    // tech spec + tasks fall back to the input plan.
    expect(out!.techSpec).toBe(BASE_PLAN.techSpec);
    expect(out!.tasks).toEqual(BASE_PLAN.tasks);
  });
});

describe('planning-critique — buildProductionCritiquePlan wiring', () => {
  it('runs Claude then Codex over Claude\'s parsed output, returning the final revision', async () => {
    let codexSawClaudeSpec = false;
    const critiquePlan = buildProductionCritiquePlan({
      claudeCall: async () => critiqueReply('FROM-CLAUDE', 'claude-task'),
      codexCall: async (message) => {
        // Codex's prompt must carry Claude's revised spec (sequential compounding).
        codexSawClaudeSpec = message.includes('Revised spec FROM-CLAUDE');
        return critiqueReply('FROM-CODEX', 'codex-task');
      },
      isCodexAvailable: async () => true,
    });

    const result = await critiquePlan(BASE_PLAN);

    expect(codexSawClaudeSpec).toBe(true);
    expect(result.codexSkipped).toBe(false);
    expect(result.plan.spec).toContain('Revised spec FROM-CODEX');
    expect(result.plan.tasks[0]!.id).toBe('codex-task');
  });

  it('degrades to the Claude pass alone when Codex is unavailable', async () => {
    const codexCall = vi.fn(async () => critiqueReply('FROM-CODEX', 'codex-task'));
    const critiquePlan = buildProductionCritiquePlan({
      claudeCall: async () => critiqueReply('FROM-CLAUDE', 'claude-task'),
      codexCall,
      isCodexAvailable: async () => false,
    });

    const result = await critiquePlan(BASE_PLAN);

    expect(codexCall).not.toHaveBeenCalled();
    expect(result.codexSkipped).toBe(true);
    expect(result.plan.spec).toContain('Revised spec FROM-CLAUDE');
  });

  it('keeps the Claude-revised plan when the Codex executor fails (null reply)', async () => {
    const critiquePlan = buildProductionCritiquePlan({
      claudeCall: async () => critiqueReply('FROM-CLAUDE', 'claude-task'),
      codexCall: async () => null, // executor failure → fail-closed
      isCodexAvailable: async () => true,
    });

    const result = await critiquePlan(BASE_PLAN);

    expect(result.plan.spec).toContain('Revised spec FROM-CLAUDE');
    expect(result.plan.tasks[0]!.id).toBe('claude-task');
  });
});
