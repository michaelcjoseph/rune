/**
 * Phase 2 test suite for `src/intent/planning-roles.ts` — the PM + tech-lead
 * planning orchestration (project 14, test-plan §2).
 *
 * Written TEST-FIRST. Until `planning-roles.ts` lands, the import fails and
 * every test here is RED.
 *
 * The orchestration is pure over INJECTED role seams — `pmAssessAndSpec`,
 * `techLeadBreakdown`, `pmReviewMatch` — so these tests use deterministic
 * fixtures and require NO live model call. That mirrors the spec: "Automated
 * tests use fixtures: one specified-enough path for loop closure and one
 * underspecified path that asserts Rune blocks rather than fabricating a spec."
 *
 * See: docs/projects/14-product-team-agents/test-plan.md §2
 */

import { beforeEach, describe, it, expect, vi } from 'vitest';

const { mockRunSelfReview, mockPlanningLog } = vi.hoisted(() => ({
  mockRunSelfReview: vi.fn(),
  mockPlanningLog: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('./self-review.js', () => ({
  runSelfReview: mockRunSelfReview,
}));

vi.mock('../utils/logger.js', () => ({
  createLogger: () => mockPlanningLog,
}));

import {
  runPlannerRoles,
  withAssumptionsSection,
  type PlanningRoleDeps,
  type PlanningProgress,
  type PmSpecResult,
  type TechLeadResult,
  type SpecMatchResult,
  type SizedTask,
} from './planning-roles.js';
import type { PmSpecApprovalArtifact } from './planner.js';
import { hasRequiredSections } from './project-context.js';

// ---------------------------------------------------------------------------
// Fixture role seams
// ---------------------------------------------------------------------------

const SIZED_TASKS: SizedTask[] = [
  {
    id: 'p1-core',
    text: 'Implement the streak-count pure core',
    testStrategy: 'code-tests-required',
    designerNeeded: false,
    roles: ['qa', 'coder', 'reviewer', 'tech-lead'],
  },
  {
    id: 'p2-card',
    text: 'Render the streak on the home card',
    testStrategy: 'code-tests-required',
    designerNeeded: true,
    roles: ['qa', 'coder', 'reviewer', 'tech-lead', 'designer'],
  },
  {
    id: 'p3-docs',
    text: 'Document the streak API in README',
    testStrategy: 'docs-or-config-only',
    designerNeeded: false,
    roles: ['qa', 'coder', 'tech-lead'],
  },
];

type PmSpecifiedResult = Extract<PmSpecResult, { specifiedEnough: true }>;

function specifiedPm(overrides: Partial<Omit<PmSpecifiedResult, 'specifiedEnough'>> = {}): PmSpecResult {
  return {
    specifiedEnough: true,
    title: 'Add streak tracking',
    spec: 'Track daily streaks.\n\n## Assumptions\n\n- Streaks reset at local midnight.',
    assumptions: ['Streaks reset at local midnight'],
    ...overrides,
  };
}

function makeDeps(over: Partial<PlanningRoleDeps> = {}): PlanningRoleDeps {
  return {
    pmAssessAndSpec: async () => specifiedPm(),
    techLeadBreakdown: async (): Promise<TechLeadResult> => ({
      techSpec: 'Pure core + REST route + card component.',
      tasks: SIZED_TASKS,
    }),
    pmReviewMatch: async (): Promise<SpecMatchResult> => ({ match: true, mismatches: [] }),
    ...over,
  };
}

const INPUT = { brief: 'Add a streak tracker to the home screen.', product: 'aura' };

beforeEach(() => {
  vi.clearAllMocks();
  mockRunSelfReview.mockReset();
  mockRunSelfReview.mockImplementation(async ({ artifact }: { artifact: TechLeadResult }) => ({
    artifact,
    revised: false,
  }));
});

// ---------------------------------------------------------------------------
// Interview gate — underspecified brief blocks, never fabricates a spec
// ---------------------------------------------------------------------------

describe('planning-roles — interview gate', () => {
  it('blocks for interview when PM judges the brief underspecified', async () => {
    const deps = makeDeps({
      pmAssessAndSpec: async () => ({
        specifiedEnough: false,
        interviewNeeds: ['What platform?', 'What is the success metric?'],
      }),
    });
    const outcome = await runPlannerRoles(INPUT, deps);
    expect(outcome.kind).toBe('blocked-for-interview');
    if (outcome.kind === 'blocked-for-interview') {
      expect(outcome.interviewNeeds).toContain('What platform?');
    }
  });

  it('does NOT call the tech lead when the PM blocks for interview', async () => {
    let techLeadCalled = false;
    const deps = makeDeps({
      pmAssessAndSpec: async () => ({ specifiedEnough: false, interviewNeeds: ['x'] }),
      techLeadBreakdown: async () => {
        techLeadCalled = true;
        return { techSpec: '', tasks: [] };
      },
    });
    await runPlannerRoles(INPUT, deps);
    expect(techLeadCalled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Assumptions — a specified-enough spec carries an Assumptions section
// ---------------------------------------------------------------------------

describe('planning-roles — assumptions', () => {
  it('planned spec contains an Assumptions section enumerating PM calls', async () => {
    const outcome = await runPlannerRoles(INPUT, makeDeps());
    expect(outcome.kind).toBe('planned');
    if (outcome.kind === 'planned') {
      // We always emit the section in title case.
      expect(outcome.spec).toContain('## Assumptions');
      expect(outcome.spec).toContain('Streaks reset at local midnight');
    }
  });

  it('injects an Assumptions section when the PM listed assumptions but omitted the heading', async () => {
    const outcome = await runPlannerRoles(
      INPUT,
      makeDeps({
        pmAssessAndSpec: async () =>
          specifiedPm({
            spec: 'Track daily streaks. (no assumptions heading here)',
            assumptions: ['Streaks reset at local midnight', 'No historical backfill'],
          }),
      }),
    );
    if (outcome.kind === 'planned') {
      expect(outcome.spec).toContain('## Assumptions');
      expect(outcome.spec).toContain('No historical backfill');
    } else {
      throw new Error(`expected planned, got ${outcome.kind}`);
    }
  });

  it('withAssumptionsSection is idempotent when the heading already exists', () => {
    const spec = 'Body.\n\n## Assumptions\n\n- a\n';
    const out = withAssumptionsSection(spec, ['a']);
    // Exactly one Assumptions heading — it does not double-append.
    const count = (out.match(/## Assumptions/gi) ?? []).length;
    expect(count).toBe(1);
  });

  it('withAssumptionsSection leaves a spec untouched when there are no assumptions', () => {
    const spec = 'Body with no assumptions.';
    expect(withAssumptionsSection(spec, [])).toBe(spec);
  });
});

// ---------------------------------------------------------------------------
// Spec-match review — PM flags tech-spec drift, does not pass it
// ---------------------------------------------------------------------------

describe('planning-roles — spec/tech-spec match', () => {
  it('flags a mismatch when PM review fails', async () => {
    const deps = makeDeps({
      pmReviewMatch: async () => ({
        match: false,
        mismatches: ['Tech spec drops the home-card surface the product spec promised'],
      }),
    });
    const outcome = await runPlannerRoles(INPUT, deps);
    expect(outcome.kind).toBe('spec-mismatch');
    if (outcome.kind === 'spec-mismatch') {
      expect(outcome.mismatches[0]).toContain('home-card surface');
    }
  });

  it('passes through to planned when PM review confirms the match', async () => {
    const outcome = await runPlannerRoles(INPUT, makeDeps());
    expect(outcome.kind).toBe('planned');
  });

  it('does NOT seed context on a mismatch (planning did not complete)', async () => {
    const outcome = await runPlannerRoles(
      INPUT,
      makeDeps({ pmReviewMatch: async () => ({ match: false, mismatches: ['drift'] }) }),
    );
    expect(outcome.kind).toBe('spec-mismatch');
    expect('context' in outcome).toBe(false);
  });

  it('continues with PM-repaired tech spec and tasks when a mismatch is repairable', async () => {
    const repairedTasks: SizedTask[] = [
      {
        id: 'live-release-gate',
        text: 'Operator verifies the streak card in a live browser before release',
        phase: 'Phase 2 - Release',
        testStrategy: 'manual-live-gate',
        designerNeeded: false,
        roles: ['human'],
      },
    ];
    const critiquePlan = vi.fn(async (
      plan: Parameters<NonNullable<PlanningRoleDeps['critiquePlan']>>[0],
    ) => ({ plan, codexSkipped: false }));
    const outcome = await runPlannerRoles(
      INPUT,
      makeDeps({
        pmReviewMatch: async () => ({
          match: false,
          mismatches: ['The Definition of Done requires live browser verification.'],
          repairedTechSpec: 'Repaired tech spec includes a live release gate.',
          repairedTasks,
          repairSummary: 'Added the missing manual/live gate.',
        }),
        critiquePlan,
      }),
    );

    expect(outcome.kind).toBe('planned');
    if (outcome.kind !== 'planned') throw new Error(`expected planned, got ${outcome.kind}`);
    expect(outcome.techSpec).toContain('live release gate');
    expect(outcome.tasks).toEqual(repairedTasks);
    expect(critiquePlan).toHaveBeenCalledWith(expect.objectContaining({
      techSpec: 'Repaired tech spec includes a live release gate.',
      tasks: repairedTasks,
    }));
    expect(outcome.context).toContain('Operator verifies');
  });
});

// ---------------------------------------------------------------------------
// Sizing — tech-lead tasks carry test strategy + designer flag
// ---------------------------------------------------------------------------

describe('planning-roles — task sizing', () => {
  it('planned outcome carries the tech-lead task breakdown with sizing metadata', async () => {
    const outcome = await runPlannerRoles(INPUT, makeDeps());
    if (outcome.kind !== 'planned') throw new Error(`expected planned, got ${outcome.kind}`);

    expect(outcome.tasks).toHaveLength(3);
    // Every task carries a test strategy and an explicit designer-needed flag.
    for (const task of outcome.tasks) {
      expect(['code-tests-required', 'docs-or-config-only', 'tests-as-deliverable', 'manual-live-gate']).toContain(
        task.testStrategy,
      );
      expect(typeof task.designerNeeded).toBe('boolean');
    }
    // The front-end task is flagged designer-needed; the others are not.
    expect(outcome.tasks.find((t) => t.id === 'p2-card')?.designerNeeded).toBe(true);
    expect(outcome.tasks.find((t) => t.id === 'p1-core')?.designerNeeded).toBe(false);
  });

  it('preserves the docs-or-config-only test strategy for a non-code task', async () => {
    const outcome = await runPlannerRoles(INPUT, makeDeps());
    if (outcome.kind !== 'planned') throw new Error('expected planned');
    expect(outcome.tasks.find((t) => t.id === 'p3-docs')?.testStrategy).toBe('docs-or-config-only');
  });

  it('planned outcome carries tech-lead per-project exemplars for role context loading', async () => {
    const qaExemplar = [
      '# QA exemplar for Aura',
      '',
      'Write redaction tests with a raw secret-shaped fixture and assert the raw value is absent.',
    ].join('\n');
    const outcome = await runPlannerRoles(
      INPUT,
      makeDeps({
        techLeadBreakdown: async () =>
          ({
            techSpec: 'Pure core + REST route + card component.',
            tasks: SIZED_TASKS,
            perProjectExemplars: { qa: qaExemplar },
          }) as TechLeadResult,
      }),
    );

    if (outcome.kind !== 'planned') throw new Error('expected planned');
    expect((outcome as any).perProjectExemplars).toMatchObject({ qa: qaExemplar });
  });
});

// ---------------------------------------------------------------------------
// Context seed — completed planning produces a valid context.md
// ---------------------------------------------------------------------------

describe('planning-roles — context seed', () => {
  it('planned outcome seeds a context.md with all required sections', async () => {
    const outcome = await runPlannerRoles(INPUT, makeDeps());
    if (outcome.kind !== 'planned') throw new Error('expected planned');
    expect(hasRequiredSections(outcome.context)).toBe(true);
    expect(outcome.context).toContain('aura');
  });

  it('threads assumptions into the seeded context', async () => {
    const outcome = await runPlannerRoles(INPUT, makeDeps());
    if (outcome.kind !== 'planned') throw new Error('expected planned');
    expect(outcome.context).toContain('Streaks reset at local midnight');
  });
});

// ---------------------------------------------------------------------------
// Project 20: downstream split after the single PM-spec approval gate
// ---------------------------------------------------------------------------

const PM_SPEC_APPROVAL = {
  version: 2,
  kind: 'pm-spec',
  product: 'aura',
  title: 'PM-authored streak spec',
  spec: 'PM-authored spec from the interview.\n\n## Assumptions\n\n- Local midnight resets.',
  assumptions: ['Local midnight resets.'],
  selfReview: { revised: false, summary: 'Spec is internally consistent.' },
} satisfies PmSpecApprovalArtifact;

async function runDownstreamPlanForTest(
  deps: PlanningRoleDeps,
): Promise<{
  product: string;
  title: string;
  spec: string;
  tasks: string;
  testPlan: string;
  techSpec?: string;
  context?: string;
  assumptions?: string[];
}> {
  const planningRoles = await import('./planning-roles.js') as Record<string, unknown>;
  expect(planningRoles.runDownstreamPlan).toBeTypeOf('function');
  return (planningRoles.runDownstreamPlan as (
    approvedSpec: PmSpecApprovalArtifact,
    options: { deps: PlanningRoleDeps },
  ) => Promise<{
    product: string;
    title: string;
    spec: string;
    tasks: string;
    testPlan: string;
    techSpec?: string;
    context?: string;
    assumptions?: string[];
  }>)(PM_SPEC_APPROVAL, { deps });
}

describe('planning-roles — runDownstreamPlan approval split (project 20 test-plan §1)', () => {
  it('starts from the approved PM spec and returns the full scaffold artifact without re-running PM specified-enough assessment', async () => {
    const calls: string[] = [];
    const pmAssessAndSpec = vi.fn(async (): Promise<PmSpecResult> => {
      throw new Error('the retired specified-enough gate must not run post-approval');
    });
    const techLeadBreakdown = vi.fn(async ({
      product,
      spec,
    }: Parameters<PlanningRoleDeps['techLeadBreakdown']>[0]) => {
      calls.push('tech-lead-breakdown');
      expect(product).toBe('aura');
      expect(spec).toContain('PM-authored spec from the interview');
      return {
        techSpec: 'Tech spec from approved PM spec.',
        tasks: SIZED_TASKS.slice(0, 1),
      };
    });
    const pmReviewMatch = vi.fn(async () => {
      calls.push('pm-review-match');
      return { match: true, mismatches: [] };
    });
    const critiquePlan = vi.fn(async (
      plan: Parameters<NonNullable<PlanningRoleDeps['critiquePlan']>>[0],
    ) => {
      calls.push('critique');
      return {
        plan: {
          ...plan,
          techSpec: `${plan.techSpec}\n\nCritiqued before context seed.`,
        },
        codexSkipped: false,
      };
    });

    const artifact = await runDownstreamPlanForTest({
      pmAssessAndSpec,
      techLeadBreakdown,
      pmReviewMatch,
      critiquePlan,
    });

    expect(pmAssessAndSpec).not.toHaveBeenCalled();
    expect(calls).toEqual(['tech-lead-breakdown', 'pm-review-match', 'critique']);
    expect(artifact).toMatchObject({
      product: 'aura',
      title: 'PM-authored streak spec',
      assumptions: ['Local midnight resets.'],
    });
    expect(artifact.spec).toContain('PM-authored spec from the interview');
    expect(artifact.techSpec).toContain('Critiqued before context seed');
    expect(artifact.tasks).toContain('Test strategy: `code-tests-required`');
    expect(artifact.testPlan).toContain('p1-core');
    expect(artifact.context).toContain('PM-authored streak spec');
  });

  it('keeps pmReviewMatch automated and fail-closed before critique or scaffold artifacts are produced', async () => {
    const critiquePlan = vi.fn(async (
      plan: Parameters<NonNullable<PlanningRoleDeps['critiquePlan']>>[0],
    ) => ({ plan, codexSkipped: false }));
    const deps = makeDeps({
      pmAssessAndSpec: vi.fn(async (): Promise<PmSpecResult> => {
        throw new Error('the retired specified-enough gate must not run post-approval');
      }),
      pmReviewMatch: vi.fn(async () => ({
        match: false,
        mismatches: ['Tech spec dropped the approved home-card scope'],
      })),
      critiquePlan,
    });

    await expect(runDownstreamPlanForTest(deps)).rejects.toMatchObject({
      stage: 'pm-review-match',
      retryable: false,
      mismatches: ['Tech spec dropped the approved home-card scope'],
    });
    expect(deps.pmAssessAndSpec).not.toHaveBeenCalled();
    expect(deps.pmReviewMatch).toHaveBeenCalledOnce();
    expect(critiquePlan).not.toHaveBeenCalled();
  });

  it('uses PM-repaired artifacts after a downstream review mismatch and preserves manual-live-gate tasks', async () => {
    const repairedTasks: SizedTask[] = [
      {
        id: 'live-release-gate',
        text: 'Operator verifies the approved streak workflow against a live browser session',
        phase: 'Phase 3 - Release',
        testStrategy: 'manual-live-gate',
        designerNeeded: false,
        roles: ['human'],
      },
    ];
    const critiquePlan = vi.fn(async (
      plan: Parameters<NonNullable<PlanningRoleDeps['critiquePlan']>>[0],
    ) => ({ plan, codexSkipped: false }));

    const artifact = await runDownstreamPlanForTest(makeDeps({
      pmAssessAndSpec: vi.fn(async (): Promise<PmSpecResult> => {
        throw new Error('the retired specified-enough gate must not run post-approval');
      }),
      pmReviewMatch: vi.fn(async () => ({
        match: false,
        mismatches: ['Approved DoD requires live operator evidence.'],
        repairedTechSpec: 'Repaired downstream tech spec with release evidence gate.',
        repairedTasks,
        repairSummary: 'Added manual/live release gate.',
      })),
      critiquePlan,
    }));

    expect(artifact.techSpec).toContain('release evidence gate');
    expect(artifact.tasks).toContain('manual/live - not automatable');
    expect(artifact.tasks).toContain('Test strategy: `manual-live-gate`');
    expect(artifact.testPlan).toContain('Manual/live release gates');
    expect(critiquePlan).toHaveBeenCalledWith(expect.objectContaining({
      techSpec: 'Repaired downstream tech spec with release evidence gate.',
      tasks: repairedTasks,
    }));
  });
});

describe('planning-roles — runDownstreamPlan progress events (project 20 test-plan §2)', () => {
  it('emits each downstream planning stage exactly once, in order, and warns non-terminally on Codex skip', async () => {
    const progress: PlanningProgress[] = [];
    const artifact = await (await import('./planning-roles.js')).runDownstreamPlan(PM_SPEC_APPROVAL, {
      deps: makeDeps({
        pmAssessAndSpec: vi.fn(async (): Promise<PmSpecResult> => {
          throw new Error('the retired specified-enough gate must not run post-approval');
        }),
        critiquePlan: vi.fn(async (plan: Parameters<NonNullable<PlanningRoleDeps['critiquePlan']>>[0]) => ({
          plan: {
            ...plan,
            techSpec: `${plan.techSpec}\n\nKept the last coherent plan after Codex skipped.`,
          },
          codexSkipped: true,
        })),
      }),
      progress: (event) => {
        progress.push(event);
      },
    });

    expect(progress.filter((event) => event.stage).map((event) => event.stage)).toEqual([
      'tech-lead-breakdown',
      'pm-review-match',
      'claude-critique',
      'codex-critique',
      'context-seed',
    ]);
    expect(
      progress.map((event) => event.stage ? `stage:${event.stage}` : event.warning ? 'warning' : 'other'),
    ).toEqual([
      'stage:tech-lead-breakdown',
      'stage:pm-review-match',
      'stage:claude-critique',
      'stage:codex-critique',
      'warning',
      'stage:context-seed',
    ]);
    for (const stage of ['tech-lead-breakdown', 'pm-review-match', 'claude-critique', 'codex-critique', 'context-seed']) {
      expect(progress.filter((event) => event.stage === stage)).toHaveLength(1);
    }
    const warning = progress.find((event) => event.warning);
    expect(warning?.warning).toMatch(/codex.*skipped|last coherent plan/i);
    expect(progress.some((event) => event.terminal || event.success)).toBe(false);
    expect(artifact.techSpec).toContain('last coherent plan');
  });

  it('emits a terminal progress event before stopping on pmReviewMatch mismatch', async () => {
    const progress: PlanningProgress[] = [];
    const deps = makeDeps({
      pmAssessAndSpec: vi.fn(async (): Promise<PmSpecResult> => {
        throw new Error('the retired specified-enough gate must not run post-approval');
      }),
      pmReviewMatch: vi.fn(async () => ({
        match: false,
        mismatches: ['Tech spec dropped the approved dashboard scope'],
      })),
      critiquePlan: vi.fn(async (plan: Parameters<NonNullable<PlanningRoleDeps['critiquePlan']>>[0]) => ({
        plan,
        codexSkipped: false,
      })),
    });

    await expect(
      (await import('./planning-roles.js')).runDownstreamPlan(PM_SPEC_APPROVAL, {
        deps,
        progress: (event) => {
          progress.push(event);
        },
      }),
    ).rejects.toMatchObject({
      stage: 'pm-review-match',
      retryable: false,
      mismatches: ['Tech spec dropped the approved dashboard scope'],
    });

    expect(progress.filter((event) => event.stage).map((event) => event.stage)).toEqual([
      'tech-lead-breakdown',
      'pm-review-match',
    ]);
    const terminal = progress.find((event) => event.terminal);
    expect(terminal).toBeDefined();
    expect(terminal!.terminal).toMatch(/pm review|mismatch|dashboard scope/i);
    expect(progress.some((event) => event.stage === 'claude-critique')).toBe(false);
    expect(progress.some((event) => event.success)).toBe(false);
    expect(mockPlanningLog.info).toHaveBeenCalledWith('downstream planning stage started', {
      product: PM_SPEC_APPROVAL.product,
      stage: 'tech-lead-breakdown',
    });
    expect(mockPlanningLog.info).toHaveBeenCalledWith('downstream planning stage started', {
      product: PM_SPEC_APPROVAL.product,
      stage: 'pm-review-match',
    });
    expect(mockPlanningLog.error).toHaveBeenCalledWith('downstream planning failed', {
      product: PM_SPEC_APPROVAL.product,
      stage: 'pm-review-match',
      reason: 'PM review mismatch: Tech spec dropped the approved dashboard scope',
      retryable: false,
      mismatches: ['Tech spec dropped the approved dashboard scope'],
    });
  });

  it('emits a terminal progress event when context seed fails after the context-seed stage starts', async () => {
    const progress: PlanningProgress[] = [];
    const invalidProductSpec = {
      ...PM_SPEC_APPROVAL,
      product: 'not a valid product slug',
    } satisfies PmSpecApprovalArtifact;

    await expect(
      (await import('./planning-roles.js')).runDownstreamPlan(invalidProductSpec, {
        deps: makeDeps({
          pmAssessAndSpec: vi.fn(async (): Promise<PmSpecResult> => {
            throw new Error('the retired specified-enough gate must not run post-approval');
          }),
          critiquePlan: vi.fn(async (plan: Parameters<NonNullable<PlanningRoleDeps['critiquePlan']>>[0]) => ({
            plan,
            codexSkipped: false,
          })),
        }),
        progress: (event) => {
          progress.push(event);
        },
      }),
    ).rejects.toThrow(/context|product slug/i);

    expect(progress.filter((event) => event.stage).map((event) => event.stage)).toEqual([
      'tech-lead-breakdown',
      'pm-review-match',
      'claude-critique',
      'codex-critique',
      'context-seed',
    ]);
    const terminal = progress.find((event) => event.terminal);
    expect(terminal).toBeDefined();
    expect(terminal!.terminal).toMatch(/context seed|product slug/i);
    expect(progress.some((event) => event.success)).toBe(false);
  });
});

describe('planning-roles — tech-lead self-review in runDownstreamPlan (project 20 test-plan §3)', () => {
  it('runs tech-lead self-review after breakdown and before PM review, and hands the revised artifact downstream', async () => {
    const calls: string[] = [];
    const reviewedTasks: SizedTask[] = [
      {
        ...SIZED_TASKS[0]!,
        text: 'Implement the reviewed streak-count pure core with the missing timezone edge case covered.',
      },
    ];
    mockRunSelfReview.mockImplementationOnce(async (input: {
      role: string;
      artifact: TechLeadResult;
      render?: (artifact: TechLeadResult) => string;
      parse?: (reply: string) => TechLeadResult;
    }) => {
      calls.push('self-review');
      expect(input.role).toBe('tech-lead');
      expect(input).toMatchObject({
        model: 'opus',
        provider: 'anthropic',
      });
      expect(input.artifact).toMatchObject({
        techSpec: 'Initial tech spec missing the timezone edge case.',
        tasks: SIZED_TASKS.slice(0, 1),
      });
      expect(input.render).toBeTypeOf('function');
      expect(input.parse).toBeTypeOf('function');
      return {
        artifact: {
          techSpec: 'Reviewed tech spec adds the timezone edge case before downstream checks.',
          tasks: reviewedTasks,
        },
        revised: true,
      };
    });

    let pmReviewInput: Parameters<PlanningRoleDeps['pmReviewMatch']>[0] | undefined;
    let critiqueInput: Parameters<NonNullable<PlanningRoleDeps['critiquePlan']>>[0] | undefined;
    const progress: PlanningProgress[] = [];

    const artifact = await (await import('./planning-roles.js')).runDownstreamPlan(PM_SPEC_APPROVAL, {
      deps: makeDeps({
        techLeadBreakdown: vi.fn(async () => {
          calls.push('tech-lead-breakdown');
          return {
            techSpec: 'Initial tech spec missing the timezone edge case.',
            tasks: SIZED_TASKS.slice(0, 1),
          };
        }),
        pmReviewMatch: vi.fn(async (input) => {
          calls.push('pm-review-match');
          pmReviewInput = input;
          return { match: true, mismatches: [] };
        }),
        critiquePlan: vi.fn(async (plan) => {
          calls.push('critique');
          critiqueInput = plan;
          return { plan, codexSkipped: false };
        }),
      }),
      progress: (event) => {
        progress.push(event);
        if (event.stage) calls.push(`progress:${event.stage}`);
      },
    });

    expect(calls).toEqual([
      'progress:tech-lead-breakdown',
      'tech-lead-breakdown',
      'self-review',
      'progress:pm-review-match',
      'pm-review-match',
      'progress:claude-critique',
      'progress:codex-critique',
      'critique',
      'progress:context-seed',
    ]);
    expect(mockRunSelfReview).toHaveBeenCalledOnce();
    expect(pmReviewInput?.techSpec).toContain('Reviewed tech spec');
    expect(pmReviewInput?.tasks).toEqual(reviewedTasks);
    expect(critiqueInput?.techSpec).toContain('Reviewed tech spec');
    expect(critiqueInput?.tasks).toEqual(reviewedTasks);
    expect(artifact.techSpec).toContain('Reviewed tech spec');
    expect(artifact.tasks).toContain('missing timezone edge case covered');
  });

  it('accepts an explicitly-confirmed unchanged tech-spec and tasks before downstream checks', async () => {
    const originalTechLead: TechLeadResult = {
      techSpec: 'Confirmed tech spec already covers the approved scope.',
      tasks: SIZED_TASKS.slice(0, 1),
    };
    mockRunSelfReview.mockImplementationOnce(async (input: {
      role: string;
      artifact: TechLeadResult;
    }) => {
      expect(input.role).toBe('tech-lead');
      expect(input.artifact).toEqual(originalTechLead);
      return {
        artifact: originalTechLead,
        revised: false,
      };
    });

    let pmReviewInput: Parameters<PlanningRoleDeps['pmReviewMatch']>[0] | undefined;
    const artifact = await (await import('./planning-roles.js')).runDownstreamPlan(PM_SPEC_APPROVAL, {
      deps: makeDeps({
        techLeadBreakdown: vi.fn(async () => originalTechLead),
        pmReviewMatch: vi.fn(async (input) => {
          pmReviewInput = input;
          return { match: true, mismatches: [] };
        }),
        critiquePlan: vi.fn(async (plan) => ({ plan, codexSkipped: false })),
      }),
    });

    expect(mockRunSelfReview).toHaveBeenCalledOnce();
    expect(pmReviewInput).toMatchObject({
      techSpec: originalTechLead.techSpec,
      tasks: originalTechLead.tasks,
    });
    expect(artifact.techSpec).toBe(originalTechLead.techSpec);
    expect(artifact.tasks).toContain('Implement the streak-count pure core');
  });

  it('surfaces tech-lead self-review failure as a terminal post-approval outcome before PM review or critique', async () => {
    const progress: PlanningProgress[] = [];
    const pmReviewMatch = vi.fn(async (): Promise<SpecMatchResult> => ({ match: true, mismatches: [] }));
    const critiquePlan = vi.fn(async (
      plan: Parameters<NonNullable<PlanningRoleDeps['critiquePlan']>>[0],
    ) => ({ plan, codexSkipped: false }));
    mockRunSelfReview.mockRejectedValueOnce(
      new Error('self-review failed: missing self-review-artifact fence'),
    );

    await expect(
      (await import('./planning-roles.js')).runDownstreamPlan(PM_SPEC_APPROVAL, {
        deps: makeDeps({
          techLeadBreakdown: vi.fn(async () => ({
            techSpec: 'Initial tech spec.',
            tasks: SIZED_TASKS.slice(0, 1),
          })),
          pmReviewMatch,
          critiquePlan,
        }),
        progress: (event) => {
          progress.push(event);
        },
      }),
    ).rejects.toThrow(/self-review|tech-lead/i);

    expect(mockRunSelfReview).toHaveBeenCalledOnce();
    expect(progress.filter((event) => event.stage).map((event) => event.stage)).toEqual([
      'tech-lead-breakdown',
    ]);
    const terminal = progress.find((event) => event.terminal);
    expect(terminal).toBeDefined();
    expect(terminal!.terminal).toMatch(/tech-lead self-review|missing self-review-artifact fence/i);
    expect(pmReviewMatch).not.toHaveBeenCalled();
    expect(critiquePlan).not.toHaveBeenCalled();
  });
});
