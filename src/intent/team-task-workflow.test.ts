/**
 * Phase 4 test suite for `src/intent/team-task-workflow.ts` — the team-task
 * workflow (project 14, test-plan §4).
 *
 * Written TEST-FIRST — RED until `team-task-workflow.ts` lands in a later `/work`
 * run.
 *
 * The workflow runs ONE selected task through the role gates — QA-first, tech-lead
 * test review, coder, independent-provider reviewer (+ tech lead), designer when
 * the sizing flag requires it, objection-class gates, round cap → PM wrap-up — and
 * returns STRUCTURED EVIDENCE. It does NOT mark `tasks.md`, write `context.md`, or
 * merge: Jarvis owns closeout. Every role seam is injected so the whole flow runs
 * on fixtures with no live model call.
 *
 * See: docs/projects/14-product-team-agents/test-plan.md §4
 */

import { describe, it, expect } from 'vitest';

import {
  runTeamTaskWorkflow,
  type TeamTaskDeps,
  type ReviewerVerdict,
  type ObjectionFinding,
  type GateRejectionFeedback,
} from './team-task-workflow.js';
import type { SizedTask } from './planning-roles.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const codeTask: SizedTask = {
  id: 'p1-core',
  text: 'Implement the streak-count pure core',
  testStrategy: 'code-tests-required',
  designerNeeded: false,
  roles: ['qa', 'coder', 'reviewer', 'tech-lead'],
};

const docsTask: SizedTask = {
  id: 'p3-docs',
  text: 'Document the streak API',
  testStrategy: 'docs-or-config-only',
  designerNeeded: false,
  roles: ['qa', 'coder', 'tech-lead'],
};

const frontEndTask: SizedTask = {
  id: 'p2-card',
  text: 'Render the streak on the home card',
  testStrategy: 'code-tests-required',
  designerNeeded: true,
  roles: ['qa', 'coder', 'reviewer', 'tech-lead', 'designer'],
};

const cleanVerdict: ReviewerVerdict = { pass: true, objections: [] };

function makeDeps(over: Partial<TeamTaskDeps> = {}): TeamTaskDeps {
  return {
    qaWriteTests: async () => ({ kind: 'tests-written', testIds: ['t1'] }),
    techLeadReviewTests: async () => ({ approved: true }),
    coder: async () => ({ diff: 'diff --git a/x b/x', handoffNotes: ['wired the core'] }),
    reviewer: async () => cleanVerdict,
    techLeadReviewDiff: async () => ({ pass: true }),
    designer: async () => ({ pass: true }),
    pmWrapup: async () => ({ resolved: true }),
    resolveReviewerProvider: () => 'openai',
    ...over,
  };
}

const INPUT = {
  spec: 'spec body',
  contextMd: '## Current State\n\nx',
  coderProvider: 'anthropic' as const,
  cap: 2,
};

// ---------------------------------------------------------------------------
// QA-first
// ---------------------------------------------------------------------------

describe('team-task-workflow — QA-first', () => {
  it('runs QA tests + tech-lead test review BEFORE the coder on a code-tests-required task', async () => {
    const order: string[] = [];
    const deps = makeDeps({
      qaWriteTests: async () => {
        order.push('qa');
        return { kind: 'tests-written', testIds: ['t1'] };
      },
      techLeadReviewTests: async () => {
        order.push('tl-tests');
        return { approved: true };
      },
      coder: async () => {
        order.push('coder');
        return { diff: 'd', handoffNotes: [] };
      },
    });
    await runTeamTaskWorkflow(codeTask, INPUT, deps);
    expect(order).toEqual(['qa', 'tl-tests', 'coder']);
  });

  it('blocks before the coder when tech lead rejects the test intent', async () => {
    let coderCalled = false;
    const deps = makeDeps({
      techLeadReviewTests: async () => ({ approved: false, notes: 'tests miss the rollover case' }),
      coder: async () => {
        coderCalled = true;
        return { diff: 'd', handoffNotes: [] };
      },
    });
    const ev = await runTeamTaskWorkflow(codeTask, INPUT, deps);
    expect(coderCalled).toBe(false);
    expect(ev.outcome).toBe('blocked');
    expect(ev.rejectionFeedback).toMatchObject({
      rejectingRole: 'tech-lead',
      counterpartRole: 'qa',
      rejectedRole: 'qa',
      artifact: 'test-intent',
      rejectedArtifact: 'test-intent',
      reason: 'tests miss the rollover case',
      whatFailed: 'tests miss the rollover case',
      notes: ['tests miss the rollover case'],
      actionableNotes: ['tests miss the rollover case'],
    });
  });

  it('re-invokes QA with tech-lead feedback before escalating a rejected test intent', async () => {
    const qaInputs: Array<{ rejectionFeedback?: unknown }> = [];
    const techLeadReviews: string[] = [];
    let coderCalled = false;
    const deps = makeDeps({
      qaWriteTests: async (input) => {
        qaInputs.push(input as { rejectionFeedback?: unknown });
        return { kind: 'tests-written', testIds: [`t${qaInputs.length}`] };
      },
      techLeadReviewTests: async ({ qa }) => {
        techLeadReviews.push(qa.kind === 'tests-written' ? qa.testIds.join(',') : qa.rationale);
        return techLeadReviews.length === 1
          ? { approved: false, notes: 'add a rollover assertion before coding' }
          : { approved: true };
      },
      coder: async () => {
        coderCalled = true;
        return { diff: 'd', handoffNotes: [] };
      },
    });

    const ev = await runTeamTaskWorkflow(codeTask, INPUT, deps);

    expect(ev.outcome).toBe('ready-for-closeout');
    expect(coderCalled).toBe(true);
    expect(qaInputs).toHaveLength(2);
    expect(techLeadReviews).toEqual(['t1', 't2']);
    expect(qaInputs[1]?.rejectionFeedback).toMatchObject({
      rejectingRole: 'tech-lead',
      rejectedRole: 'qa',
      rejectedArtifact: 'test-intent',
      actionableNotes: ['add a rollover assertion before coding'],
    });
  });

  it('continues the corrective QA retry when gate-time learning fails', async () => {
    const qaInputs: Array<{ rejectionFeedback?: unknown }> = [];
    let techLeadReviews = 0;
    let coderCalled = false;
    const deps = makeDeps({
      qaWriteTests: async (input) => {
        qaInputs.push(input as { rejectionFeedback?: unknown });
        return { kind: 'tests-written', testIds: [`t${qaInputs.length}`] };
      },
      techLeadReviewTests: async () => {
        techLeadReviews += 1;
        return techLeadReviews === 1
          ? { approved: false, notes: 'add the raw secret absence assertion' }
          : { approved: true };
      },
      onGateRejection: async () => {
        throw new Error('learning write failed');
      },
      coder: async () => {
        coderCalled = true;
        return { diff: 'd', handoffNotes: [] };
      },
    });

    const ev = await runTeamTaskWorkflow(codeTask, INPUT, deps);

    expect(ev.outcome).toBe('ready-for-closeout');
    expect(coderCalled).toBe(true);
    expect(qaInputs).toHaveLength(2);
    expect(qaInputs[1]?.rejectionFeedback).toMatchObject({
      rejectingRole: 'tech-lead',
      rejectedRole: 'qa',
      rejectedArtifact: 'test-intent',
      actionableNotes: ['add the raw secret absence assertion'],
    });
  });
});

// ---------------------------------------------------------------------------
// No-code-test rationale path
// ---------------------------------------------------------------------------

describe('team-task-workflow — docs/config-only', () => {
  it('records a QA no-code-test rationale reviewed by tech lead before the coder', async () => {
    const order: string[] = [];
    const deps = makeDeps({
      qaWriteTests: async () => {
        order.push('qa-rationale');
        return { kind: 'no-code-test-rationale', rationale: 'docs only; nothing to assert' };
      },
      techLeadReviewTests: async () => {
        order.push('tl-tests');
        return { approved: true };
      },
      coder: async () => {
        order.push('coder');
        return { diff: 'd', handoffNotes: [] };
      },
    });
    const ev = await runTeamTaskWorkflow(docsTask, INPUT, deps);
    expect(order).toEqual(['qa-rationale', 'tl-tests', 'coder']);
    expect(ev.noCodeTestRationale).toBe('docs only; nothing to assert');
  });
});

// ---------------------------------------------------------------------------
// Reviewer independence — distinct provider, no coder hidden reasoning
// ---------------------------------------------------------------------------

describe('team-task-workflow — reviewer independence', () => {
  it('resolves the reviewer to a different provider than the coder', async () => {
    let reviewerProvider: string | undefined;
    const deps = makeDeps({
      resolveReviewerProvider: (coderProvider) => {
        const p = coderProvider === 'anthropic' ? 'openai' : 'anthropic';
        reviewerProvider = p;
        return p;
      },
    });
    await runTeamTaskWorkflow(codeTask, INPUT, deps);
    expect(reviewerProvider).toBe('openai');
  });

  it('passes diff/spec/tests/task/context to the reviewer, NOT coder hidden reasoning', async () => {
    let reviewerInput: Record<string, unknown> | undefined;
    const deps = makeDeps({
      coder: async () => ({
        diff: 'THE-DIFF',
        handoffNotes: ['note'],
        // A coder seam must not surface hidden reasoning to the reviewer; even if
        // present on the coder result, it must never reach the reviewer input.
      }),
      reviewer: async (input) => {
        reviewerInput = input as unknown as Record<string, unknown>;
        return cleanVerdict;
      },
    });
    await runTeamTaskWorkflow(codeTask, INPUT, deps);
    expect(reviewerInput?.['diff']).toBe('THE-DIFF');
    expect(reviewerInput?.['spec']).toBe('spec body');
    expect(reviewerInput).toHaveProperty('tests');
    expect(reviewerInput).toHaveProperty('task');
    expect(reviewerInput).toHaveProperty('context');
    expect(reviewerInput).not.toHaveProperty('coderReasoning');
    expect(reviewerInput).not.toHaveProperty('hiddenReasoning');
  });

  it('BLOCKS fail-closed when no distinct-provider reviewer can be resolved', async () => {
    let reviewerCalled = false;
    const deps = makeDeps({
      resolveReviewerProvider: () => null, // executor unavailable
      reviewer: async () => {
        reviewerCalled = true;
        return cleanVerdict;
      },
    });
    const ev = await runTeamTaskWorkflow(codeTask, INPUT, deps);
    expect(ev.outcome).toBe('blocked');
    expect(ev.blockedReason).toContain('independ');
    // Never a same-provider review.
    expect(reviewerCalled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Objection-class gate
// ---------------------------------------------------------------------------

describe('team-task-workflow — objection gate', () => {
  const objection: ObjectionFinding = {
    class: 'security',
    severity: 'high',
    location: 'src/x.ts:10',
    rationale: 'unsanitized shell interpolation',
  };

  it('an open objection-class finding blocks task completion', async () => {
    const deps = makeDeps({ reviewer: async () => ({ pass: false, objections: [objection] }) });
    const ev = await runTeamTaskWorkflow(codeTask, INPUT, deps);
    expect(ev.outcome).toBe('blocked');
    expect(ev.objectionOpen).toBe(true);
  });

  it('PM wrap-up cannot clear an open objection-class finding', async () => {
    const deps = makeDeps({
      reviewer: async () => ({ pass: false, objections: [objection] }),
      pmWrapup: async () => ({ resolved: true }), // PM says resolved...
    });
    const ev = await runTeamTaskWorkflow(codeTask, INPUT, deps);
    // ...but the objection still blocks; PM authority does not extend here.
    expect(ev.outcome).toBe('blocked');
    expect(ev.objectionOpen).toBe(true);
  });

  it('surfaces the structured objection payload (class/severity/location/rationale)', async () => {
    const deps = makeDeps({ reviewer: async () => ({ pass: false, objections: [objection] }) });
    const ev = await runTeamTaskWorkflow(codeTask, INPUT, deps);
    expect(ev.reviewerVerdict?.objections[0]).toMatchObject({
      class: 'security',
      severity: 'high',
      location: 'src/x.ts:10',
    });
  });
});

// ---------------------------------------------------------------------------
// Gate records — every blocking gate returns structured rejection feedback
// ---------------------------------------------------------------------------

describe('team-task-workflow — gate rejection records', () => {
  function expectStructuredGateRejection(
    feedback: GateRejectionFeedback | undefined,
    expected: Partial<GateRejectionFeedback>,
  ): void {
    expect(feedback).toMatchObject({
      rejectingRole: expect.any(String),
      counterpartRole: expect.any(String),
      rejectedRole: expect.any(String),
      artifact: expect.any(String),
      rejectedArtifact: expect.any(String),
      reason: expect.any(String),
      whatFailed: expect.any(String),
      notes: expect.arrayContaining([expect.any(String)]),
      actionableNotes: expect.arrayContaining([expect.any(String)]),
      ...expected,
    });
    expect(feedback?.reason.trim()).not.toBe('');
    expect(feedback?.whatFailed.trim()).not.toBe('');
    expect(feedback?.notes.every((note) => note.trim().length > 0)).toBe(true);
    expect(feedback?.actionableNotes.every((note) => note.trim().length > 0)).toBe(true);
  }

  it('emits a structured rejection for every blocking role gate', async () => {
    const objection: ObjectionFinding = {
      class: 'security',
      severity: 'high',
      location: 'src/x.ts:10',
      rationale: 'unsanitized shell interpolation',
    };
    const cases: Array<{
      name: string;
      task: SizedTask;
      input?: typeof INPUT;
      deps: Partial<TeamTaskDeps>;
      expected: Partial<GateRejectionFeedback>;
    }> = [
      {
        name: 'reviewer independence',
        task: codeTask,
        deps: { resolveReviewerProvider: () => null },
        expected: {
          rejectingRole: 'reviewer',
          counterpartRole: 'coder',
          rejectedRole: 'coder',
          artifact: 'reviewer-verdict',
          rejectedArtifact: 'reviewer-verdict',
        },
      },
      {
        name: 'tech-lead test intent',
        task: codeTask,
        deps: {
          techLeadReviewTests: async () => ({
            approved: false,
            notes: 'tests miss the rollover case',
          }),
        },
        expected: {
          rejectingRole: 'tech-lead',
          counterpartRole: 'qa',
          rejectedRole: 'qa',
          artifact: 'test-intent',
          rejectedArtifact: 'test-intent',
        },
      },
      {
        name: 'reviewer objection',
        task: codeTask,
        deps: {
          reviewer: async () => ({ pass: false, objections: [objection] }),
        },
        expected: {
          rejectingRole: 'reviewer',
          counterpartRole: 'coder',
          rejectedRole: 'coder',
          artifact: 'reviewer-verdict',
          rejectedArtifact: 'reviewer-verdict',
        },
      },
      {
        name: 'designer review at cap',
        task: frontEndTask,
        input: { ...INPUT, cap: 1 },
        deps: {
          designer: async () => ({ pass: false, notes: 'control not reachable' }),
        },
        expected: {
          rejectingRole: 'designer',
          counterpartRole: 'coder',
          rejectedRole: 'coder',
          artifact: 'design-review',
          rejectedArtifact: 'design-review',
        },
      },
      {
        name: 'PM-unresolved cap after reviewer rejection',
        task: codeTask,
        input: { ...INPUT, cap: 1 },
        deps: {
          reviewer: async () => ({
            pass: false,
            objections: [],
            notes: 'reviewer wants the empty-state branch covered',
          }),
          pmWrapup: async () => ({ resolved: false }),
        },
        expected: {
          rejectingRole: 'reviewer',
          counterpartRole: 'coder',
          rejectedRole: 'coder',
          artifact: 'reviewer-verdict',
          rejectedArtifact: 'reviewer-verdict',
        },
      },
    ];

    for (const c of cases) {
      const ev = await runTeamTaskWorkflow(
        c.task,
        c.input ?? INPUT,
        makeDeps(c.deps),
      );
      expect(ev.outcome, c.name).toBe('blocked');
      expectStructuredGateRejection(ev.rejectionFeedback, c.expected);
    }
  });
});

// ---------------------------------------------------------------------------
// Round cap → PM wrap-up → blocked-on-human
// ---------------------------------------------------------------------------

describe('team-task-workflow — round cap', () => {
  it('re-invokes the coder with reviewer and tech-lead feedback from the failed round', async () => {
    const coderInputs: Array<{ rejectionFeedback?: GateRejectionFeedback[] }> = [];
    let reviewerCalls = 0;
    let techLeadDiffCalls = 0;
    const reviewerRejection = {
      pass: false,
      objections: [],
      notes: 'reviewer wants the empty-state branch covered',
    } as ReviewerVerdict & { notes: string };
    const deps = makeDeps({
      coder: async (input) => {
        coderInputs.push(input as { rejectionFeedback?: GateRejectionFeedback[] });
        return { diff: `diff-${coderInputs.length}`, handoffNotes: [] };
      },
      reviewer: async () => {
        reviewerCalls += 1;
        return reviewerCalls === 1 ? reviewerRejection : cleanVerdict;
      },
      techLeadReviewDiff: async () => {
        techLeadDiffCalls += 1;
        return techLeadDiffCalls === 1
          ? { pass: false, notes: 'tech lead wants an explicit empty-state guard' }
          : { pass: true };
      },
    });

    const ev = await runTeamTaskWorkflow(codeTask, INPUT, deps);

    expect(ev.outcome).toBe('ready-for-closeout');
    expect(coderInputs).toHaveLength(2);
    expect(coderInputs[1]?.rejectionFeedback).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          rejectingRole: 'reviewer',
          rejectedRole: 'coder',
          rejectedArtifact: 'reviewer-verdict',
          actionableNotes: ['reviewer wants the empty-state branch covered'],
        }),
        expect.objectContaining({
          rejectingRole: 'tech-lead',
          rejectedRole: 'coder',
          rejectedArtifact: 'implementation-diff',
          actionableNotes: ['tech lead wants an explicit empty-state guard'],
        }),
      ]),
    );
  });

  it('does not blindly redo a retryable role with identical inputs and no feedback', async () => {
    const coderInputs: Array<{
      task: SizedTask;
      spec: string;
      context: string;
      tests: string[] | string;
      rejectionFeedback?: GateRejectionFeedback[];
    }> = [];
    let reviewerCalls = 0;
    const deps = makeDeps({
      coder: async (input) => {
        coderInputs.push(
          input as {
            task: SizedTask;
            spec: string;
            context: string;
            tests: string[] | string;
            rejectionFeedback?: GateRejectionFeedback[];
          },
        );
        return { diff: `diff-${coderInputs.length}`, handoffNotes: [] };
      },
      reviewer: async () => {
        reviewerCalls += 1;
        return reviewerCalls === 1 ? { pass: false, objections: [] } : cleanVerdict;
      },
    });

    const ev = await runTeamTaskWorkflow(codeTask, INPUT, deps);

    const retryPayloads = coderInputs.map((input) => ({
      taskId: input.task.id,
      spec: input.spec,
      context: input.context,
      tests: input.tests,
      rejectionFeedback: input.rejectionFeedback ?? null,
    }));
    expect(ev.outcome).toBe('ready-for-closeout');
    expect(retryPayloads).toHaveLength(2);
    expect(retryPayloads[1]).not.toEqual(retryPayloads[0]);
    expect(retryPayloads[1]?.rejectionFeedback).not.toBeNull();
  });

  it('routes non-objection disagreement at the cap to PM wrap-up', async () => {
    let pmCalled = false;
    const deps = makeDeps({
      reviewer: async () => ({ pass: false, objections: [] }), // non-objection fail
      pmWrapup: async () => {
        pmCalled = true;
        return { resolved: true };
      },
    });
    const ev = await runTeamTaskWorkflow(codeTask, { ...INPUT, cap: 1 }, deps);
    expect(pmCalled).toBe(true);
    // PM resolved → ready-for-closeout.
    expect(ev.outcome).toBe('ready-for-closeout');
  });

  it('an unresolved PM decision at the cap enters blocked-on-human', async () => {
    const deps = makeDeps({
      reviewer: async () => ({ pass: false, objections: [] }),
      pmWrapup: async () => ({ resolved: false }),
    });
    const ev = await runTeamTaskWorkflow(codeTask, { ...INPUT, cap: 1 }, deps);
    expect(ev.outcome).toBe('blocked');
    expect(ev.blockedReason).toContain('PM');
  });
});

// ---------------------------------------------------------------------------
// Designer routing
// ---------------------------------------------------------------------------

describe('team-task-workflow — designer routing', () => {
  it('invokes the designer when the sizing flags front-end/designer-needed', async () => {
    let designerCalled = false;
    const deps = makeDeps({
      designer: async () => {
        designerCalled = true;
        return { pass: true };
      },
    });
    await runTeamTaskWorkflow(frontEndTask, INPUT, deps);
    expect(designerCalled).toBe(true);
  });

  it('does NOT invoke the designer for a non-flagged task', async () => {
    let designerCalled = false;
    const deps = makeDeps({
      designer: async () => {
        designerCalled = true;
        return { pass: true };
      },
    });
    await runTeamTaskWorkflow(codeTask, INPUT, deps);
    expect(designerCalled).toBe(false);
  });

  it('blocks when the designer fails a flagged task', async () => {
    const deps = makeDeps({ designer: async () => ({ pass: false, notes: 'control not reachable' }) });
    const ev = await runTeamTaskWorkflow(frontEndTask, INPUT, deps);
    expect(ev.outcome).toBe('blocked');
  });
});

// ---------------------------------------------------------------------------
// No closeout — workflow returns evidence, never mutates project state
// ---------------------------------------------------------------------------

describe('team-task-workflow — returns evidence, owns no closeout', () => {
  it('returns ready-for-closeout with handoff notes on the happy path', async () => {
    const ev = await runTeamTaskWorkflow(codeTask, INPUT, makeDeps());
    expect(ev.outcome).toBe('ready-for-closeout');
    expect(ev.handoffNotes).toContain('wired the core');
    expect(ev.rolesInvoked).toContain('reviewer');
  });

  it('exposes no tasks.md / context.md / merge side-effect surface on the evidence', async () => {
    const ev = await runTeamTaskWorkflow(codeTask, INPUT, makeDeps());
    // The evidence is data only — it carries no writer/commit/merge handles.
    expect(ev).not.toHaveProperty('tasksMd');
    expect(ev).not.toHaveProperty('contextWritten');
    expect(ev).not.toHaveProperty('merged');
  });
});

// ---------------------------------------------------------------------------
// Execution observability — role-stage transition events
// ---------------------------------------------------------------------------

type WorkflowActivityEvent = {
  kind: 'activity' | 'output';
  data?: Record<string, unknown>;
};

describe('team-task-workflow — execution observability', () => {
  it('emits a labeled event for each role-stage transition', async () => {
    const events: WorkflowActivityEvent[] = [];
    const inputWithEmitter = {
      ...INPUT,
      cap: 1,
      emit: (event: WorkflowActivityEvent) => {
        events.push(event);
      },
    };
    const deps = makeDeps({
      reviewer: async () => ({
        pass: false,
        objections: [],
        notes: 'reviewer wants one more assertion',
      }),
      pmWrapup: async () => ({ resolved: true }),
    });

    const ev = await runTeamTaskWorkflow(frontEndTask, inputWithEmitter, deps);

    const transitions = events.filter(
      (event) => event.data?.['event'] === 'role-stage',
    );
    const observedStages = transitions.map((event) => ({
      role: event.data?.['role'],
      stage: event.data?.['stage'],
    }));

    expect(ev.outcome).toBe('ready-for-closeout');
    expect(observedStages).toEqual([
      { role: 'qa', stage: 'test' },
      { role: 'tech-lead', stage: 'test-review' },
      { role: 'coder', stage: 'implementation' },
      { role: 'reviewer', stage: 'review' },
      { role: 'designer', stage: 'design' },
      { role: 'pm', stage: 'pm-wrapup' },
    ]);
    expect(transitions.every((event) => typeof event.data?.['label'] === 'string')).toBe(true);
    expect(transitions.every((event) => String(event.data?.['label']).trim().length > 0)).toBe(true);
  });

  it('emits explicit role-transition events for every stage in workflow order', async () => {
    const events: WorkflowActivityEvent[] = [];
    const inputWithEmitter = {
      ...INPUT,
      cap: 1,
      emit: (event: WorkflowActivityEvent) => {
        events.push(event);
      },
    };
    const deps = makeDeps({
      reviewer: async () => ({
        pass: false,
        objections: [],
        notes: 'reviewer wants one more assertion',
      }),
      pmWrapup: async () => ({ resolved: true }),
    });

    await runTeamTaskWorkflow(frontEndTask, inputWithEmitter, deps);

    const transitions = events.filter(
      (event) => event.data?.['event'] === 'role-transition',
    );
    expect(transitions.map((event) => event.data?.['role'])).toEqual([
      'qa',
      'tech-lead',
      'coder',
      'reviewer',
      'designer',
      'pm',
    ]);
    expect(transitions.map((event) => event.data?.['transition'])).toEqual([
      'qa-tests',
      'tech-lead-test-review',
      'coder-implementation',
      'reviewer-review',
      'designer-review',
      'pm-wrapup',
    ]);
    expect(transitions.map((event) => event.data?.['fromRole'])).toEqual([
      undefined,
      'qa',
      'tech-lead',
      'coder',
      'reviewer',
      'designer',
    ]);
    expect(transitions.every((event) => event.kind === 'activity')).toBe(true);
    expect(transitions.every((event) => String(event.data?.['label']).trim().length > 0)).toBe(true);
    expect(transitions.every((event) => String(event.data?.['line']).trim().length > 0)).toBe(true);
  });

  it('emits role-verdict events summarizing reviewer, tech-lead, designer, and PM gates', async () => {
    const events: WorkflowActivityEvent[] = [];
    const inputWithEmitter = {
      ...INPUT,
      cap: 1,
      emit: (event: WorkflowActivityEvent) => {
        events.push(event);
      },
    };
    const deps = makeDeps({
      reviewer: async () => ({
        pass: false,
        objections: [],
        notes: 'reviewer wants one more assertion',
      }),
      pmWrapup: async () => ({ resolved: true }),
    });

    const ev = await runTeamTaskWorkflow(frontEndTask, inputWithEmitter, deps);

    expect(ev.outcome).toBe('ready-for-closeout');
    const verdicts = events.filter((event) => event.data?.['event'] === 'role-verdict');
    expect(verdicts.map((event) => ({
      role: event.data?.['role'],
      verdict: event.data?.['verdict'],
      gate: event.data?.['gate'],
    }))).toEqual([
      { role: 'tech-lead', verdict: 'pass', gate: 'test-intent' },
      { role: 'reviewer', verdict: 'fail', gate: 'reviewer-verdict' },
      { role: 'tech-lead', verdict: 'pass', gate: 'implementation-diff' },
      { role: 'designer', verdict: 'pass', gate: 'design-review' },
      { role: 'pm', verdict: 'resolved', gate: 'pm-wrapup' },
    ]);
    expect(verdicts.every((event) => String(event.data?.['summary']).trim().length > 0)).toBe(true);
    expect(verdicts.every((event) => String(event.data?.['line']).trim().length > 0)).toBe(true);
  });

  it('emits structured objection events before blocking on objection-class findings', async () => {
    const events: WorkflowActivityEvent[] = [];
    const objection: ObjectionFinding = {
      class: 'security',
      severity: 'high',
      location: 'src/auth.ts:42',
      rationale: 'token comparison leaks timing information',
    };
    const inputWithEmitter = {
      ...INPUT,
      emit: (event: WorkflowActivityEvent) => {
        events.push(event);
      },
    };
    const deps = makeDeps({
      reviewer: async () => ({
        pass: false,
        objections: [objection],
      }),
      pmWrapup: async () => {
        throw new Error('PM must not run for objection-class findings');
      },
    });

    const ev = await runTeamTaskWorkflow(codeTask, inputWithEmitter, deps);

    expect(ev.outcome).toBe('blocked');
    expect(ev.objectionOpen).toBe(true);
    const objectionEvents = events.filter((event) => event.data?.['event'] === 'objection');
    expect(objectionEvents).toHaveLength(1);
    expect(objectionEvents[0]?.data).toMatchObject({
      role: 'reviewer',
      gate: 'reviewer-verdict',
      objection,
    });
    expect(String(objectionEvents[0]?.data?.['line'])).toContain('security/high');
    expect(String(objectionEvents[0]?.data?.['line'])).toContain('src/auth.ts:42');

    const reviewerVerdictIndex = events.findIndex(
      (event) =>
        event.data?.['event'] === 'role-verdict' &&
        event.data?.['role'] === 'reviewer' &&
        event.data?.['verdict'] === 'fail',
    );
    const objectionIndex = events.findIndex((event) => event.data?.['event'] === 'objection');
    expect(reviewerVerdictIndex).toBeGreaterThanOrEqual(0);
    expect(objectionIndex).toBeGreaterThan(reviewerVerdictIndex);
  });
});

// ---------------------------------------------------------------------------
// Robustness — role rejection → structured failed; bad cap → loud throw
// ---------------------------------------------------------------------------

describe('team-task-workflow — robustness', () => {
  it('returns structured failed evidence when a role seam rejects', async () => {
    const deps = makeDeps({
      coder: async () => {
        throw new Error('executor crashed mid-run');
      },
    });
    const ev = await runTeamTaskWorkflow(codeTask, INPUT, deps);
    expect(ev.outcome).toBe('failed');
    expect(ev.failureReason).toContain('executor crashed');
  });

  it('throws on a non-positive cap rather than running a zero-round workflow', async () => {
    await expect(runTeamTaskWorkflow(codeTask, { ...INPUT, cap: 0 }, makeDeps())).rejects.toThrow(
      /cap must be >= 1/,
    );
  });
});
