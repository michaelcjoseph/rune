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

import { describe, it, expect } from 'vitest';

import {
  runPlannerRoles,
  withAssumptionsSection,
  type PlanningRoleDeps,
  type PmSpecResult,
  type TechLeadResult,
  type SpecMatchResult,
  type SizedTask,
} from './planning-roles.js';
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
      expect(['code-tests-required', 'docs-or-config-only', 'tests-as-deliverable']).toContain(
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
