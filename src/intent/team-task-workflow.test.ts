/**
 * Phase 4 test suite for `src/intent/team-task-workflow.ts` — the team-task
 * workflow (project 14, test-plan §4).
 *
 * Written TEST-FIRST — RED until `team-task-workflow.ts` lands in a later `/work`
 * run.
 *
 * The workflow runs ONE selected task through the role gates — QA-first, tech-lead
 * test review, coder, independent-provider reviewer (+ tech lead), designer when
 * the sizing flag requires it, objection-class gates, bounded severity convergence — and
 * returns STRUCTURED EVIDENCE. It does NOT mark `tasks.md`, write `context.md`, or
 * merge: Rune owns closeout. Every role seam is injected so the whole flow runs
 * on fixtures with no live model call.
 *
 * See: docs/projects/14-product-team-agents/test-plan.md §4
 */

import { describe, it, expect, vi } from 'vitest';

import * as teamTaskWorkflow from './team-task-workflow.js';
import {
  runTeamTaskWorkflow,
  RoleCancellationError,
  ValidationProfileUnavailableError,
  type TeamTaskDeps,
  type ReviewerVerdict,
  type ObjectionFinding,
  type ObjectionSeverity,
  type ReviewerOutcome,
  type GateOutcome,
  type GateVerdict,
  type GateRejectionFeedback,
  type FindingsLedgerEntry,
  type ObjectionClass,
  type LoopExitReason,
  type TaskEvidence,
  type CoderResult,
  type CoderSelfReviewResult,
  type QaResult,
  type TechLeadTestRepairResult,
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

const securityTask: SizedTask = {
  ...codeTask,
  id: 'p1-security',
  text: 'Enforce execution-profile isolation',
  securityNeeded: true,
};

const cleanVerdict: ReviewerVerdict = { pass: true, objections: [] };

function makeDeps(over: Partial<TeamTaskDeps> = {}): TeamTaskDeps {
  return {
    qaWriteTests: async () => ({ kind: 'tests-written', testIds: ['t1'] }),
    techLeadReviewTests: async () => ({ approved: true }),
    coder: async () => ({ diff: 'diff --git a/x b/x', handoffNotes: ['wired the core'] }),
    coderSelfReview: async ({ artifact }) => ({
      outcome: 'confirmed',
      notes: 'Canonical worktree is ready for review.',
      reviewState: {
        diff: artifact.diff,
        hash: 'canonical-hash',
        baseTree: '1111111111111111111111111111111111111111',
        currentTree: '2222222222222222222222222222222222222222',
        changedPaths: ['x'],
      },
    }),
    reviewer: async () => cleanVerdict,
    techLeadReviewDiff: async () => ({ pass: true }),
    designer: async () => ({ pass: true }),
    resolveReviewerProvider: () => 'openai',
    ...over,
  };
}

type CoderSelfReviewDeps = {
  coderSelfReview: (input: {
    task: SizedTask;
    artifact: CoderResult;
    spec: string;
    context: string;
    tests: string[] | string;
    qa: QaResult;
    rejectionFeedback?: GateRejectionFeedback[];
    findingsLedger?: FindingsLedgerEntry[];
  }) => Promise<CoderSelfReviewResult>;
};

function makeCoderSelfReviewDeps(
  over: Partial<TeamTaskDeps> & Partial<CoderSelfReviewDeps> = {},
): TeamTaskDeps & CoderSelfReviewDeps {
  return makeDeps(over) as TeamTaskDeps & CoderSelfReviewDeps;
}

const INPUT = {
  spec: 'spec body',
  contextMd: '## Current State\n\nx',
  coderProvider: 'anthropic' as const,
  cap: 2,
};

const CANCELLATION = {
  operationId: '12345678-1234-1234-1234-123456789abc',
  source: 'cockpit' as const,
  requestedAt: '2026-07-13T12:34:56.000Z',
};

const REVIEW_OUTCOMES = ['pass', 'pass-with-warnings', 'fail'] as const;
type GateVerdictRecord = {
  outcome?: unknown;
  findings?: unknown;
  notes?: unknown;
  pass?: unknown;
  objections?: unknown;
};

type TypeEqual<A, B> = (
  (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2) ? true : false
);
type IsNever<T> = [T] extends [never] ? true : false;
type Assert<T extends true> = T;
type ReviewerOutcomeMatchesGateOutcome = Assert<TypeEqual<ReviewerOutcome, GateOutcome>>;
type ReviewerOutcomeHasNoBlock = Assert<IsNever<Extract<ReviewerOutcome, 'block'>>>;
type GateVerdictOutcomeHasNoBlock = Assert<IsNever<Extract<GateVerdict['outcome'], 'block'>>>;
type ExpectedPhase14ObjectionClass =
  | 'security'
  | 'privacy'
  | 'data-integrity'
  | 'concurrency'
  | 'outbound'
  | 'cost-perf';
type ObjectionClassMatchesPhase14Taxonomy = Assert<
  TypeEqual<ObjectionClass, ExpectedPhase14ObjectionClass>
>;
type ObjectionClassIncludesOutbound = Assert<Extract<ObjectionClass, 'outbound'> extends 'outbound'
  ? true
  : false>;
type ObjectionClassRetiresIrreversibility = Assert<
  IsNever<Extract<ObjectionClass, 'irreversibility'>>
>;
type ExpectedLoopExitReason = 'all-low' | 'stagnation' | 'hard-budget' | 'operational';
type LoopExitReasonMatchesPhase14Reasons = Assert<
  TypeEqual<LoopExitReason, ExpectedLoopExitReason>
>;
type TaskEvidenceRequiresFindingsLedger = Assert<
  undefined extends TaskEvidence['findingsLedger'] ? false : true
>;
type TaskEvidenceRequiresLoopExitReason = Assert<
  undefined extends TaskEvidence['loopExitReason'] ? false : true
>;

// ---------------------------------------------------------------------------
// QA-first
// ---------------------------------------------------------------------------

describe('team-task-workflow — structured role cancellation', () => {
  it.each(['qa', 'tech-lead', 'coder', 'reviewer'] as const)(
    'returns cancelled evidence when %s is cancelled',
    async (role) => {
      const cancelled = async () => {
        throw new RoleCancellationError(role, CANCELLATION);
      };
      const deps = makeDeps({
        ...(role === 'qa' ? { qaWriteTests: cancelled } : {}),
        ...(role === 'tech-lead' ? { techLeadReviewTests: cancelled } : {}),
        ...(role === 'coder' ? { coder: cancelled } : {}),
        ...(role === 'reviewer' ? { reviewer: cancelled } : {}),
      });

      const evidence = await runTeamTaskWorkflow(codeTask, INPUT, deps);

      expect(evidence).toMatchObject({
        outcome: 'cancelled',
        cancellation: { role, ...CANCELLATION },
        loopExitReason: 'operational',
      });
      expect(evidence.failureReason).toBeUndefined();
      expect(evidence.blockedReason).toBeUndefined();
    },
  );

  it('retains the full-task base/current tree and hash evidence when a downstream role is cancelled after self-review', async () => {
    // The reviewer runs AFTER coder self-review has already captured the
    // canonical review state — a cancellation here must not discard that
    // already-durable task-base/current-tree/hash evidence.
    const deps = makeDeps({
      reviewer: async () => {
        throw new RoleCancellationError('reviewer', CANCELLATION);
      },
    });

    const evidence = await runTeamTaskWorkflow(codeTask, INPUT, deps);

    expect(evidence).toMatchObject({
      outcome: 'cancelled',
      cancellation: { role: 'reviewer', ...CANCELLATION },
      taskBaseTree: '1111111111111111111111111111111111111111',
      currentReviewTree: '2222222222222222222222222222222222222222',
      fullTaskReviewHash: 'canonical-hash',
      reviewSurfaceHash: 'canonical-hash',
    });
  });
});

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

  it('passes tech-lead test-intent suggested changes to the QA retry', async () => {
    const qaInputs: Array<{ rejectionFeedback?: GateRejectionFeedback }> = [];
    let techLeadReviews = 0;
    const deps = makeDeps({
      qaWriteTests: async (input) => {
        qaInputs.push(input as { rejectionFeedback?: GateRejectionFeedback });
        return { kind: 'tests-written', testIds: [`t${qaInputs.length}`] };
      },
      techLeadReviewTests: async () => {
        techLeadReviews += 1;
        return techLeadReviews === 1
          ? {
              approved: false,
              notes: 'test intent misses the retry contract',
              suggestedChange: 'Add a failing test for retrying after a rejected gate.',
            }
          : { approved: true };
      },
    });

    const ev = await runTeamTaskWorkflow(codeTask, INPUT, deps);

    expect(ev.outcome).toBe('ready-for-closeout');
    expect(qaInputs[1]?.rejectionFeedback).toMatchObject({
      whatFailed: 'test intent misses the retry contract',
      notes: ['test intent misses the retry contract'],
      actionableNotes: ['Add a failing test for retrying after a rejected gate.'],
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
// Test-intent repair — the tech-lead patches QA's tests on first rejection
// instead of bouncing an unfixable state back to the same QA agent.
// ---------------------------------------------------------------------------

describe('team-task-workflow — test-intent repair', () => {
  const repaired: TechLeadTestRepairResult = {
    kind: 'repaired',
    testIds: ['t1', 't1-negative'],
    redCheck: { kind: 'red', command: 'npm test', exitCode: 1, outputTail: '1 failed' },
  };

  it('repairs on first rejection: tech-lead patch + approving re-review reach the coder without a QA retry', async () => {
    let qaCalls = 0;
    let reviewCalls = 0;
    let coderTests: string[] | string | undefined;
    const repairInputs: unknown[] = [];
    const deps = makeDeps({
      qaWriteTests: async () => {
        qaCalls += 1;
        return { kind: 'tests-written', testIds: ['t1'] };
      },
      techLeadReviewTests: async () => {
        reviewCalls += 1;
        return reviewCalls === 1
          ? {
              approved: false,
              notes: 'tests never assert the foreground-suppression case',
              suggestedChange: 'Assert no cue is raised for the currently-viewed product.',
            }
          : { approved: true };
      },
      techLeadRepairTests: async (input) => {
        repairInputs.push(input);
        return repaired;
      },
      coder: async ({ tests }) => {
        coderTests = tests;
        return { diff: 'd', handoffNotes: [] };
      },
    });

    const ev = await runTeamTaskWorkflow(codeTask, INPUT, deps);

    expect(ev.outcome).toBe('ready-for-closeout');
    expect(qaCalls).toBe(1);
    expect(reviewCalls).toBe(2);
    expect(repairInputs).toHaveLength(1);
    expect(repairInputs[0]).toMatchObject({
      spec: INPUT.spec,
      qa: { kind: 'tests-written', testIds: ['t1'] },
      rejection: {
        reason: 'tests never assert the foreground-suppression case',
        suggestedChange: 'Assert no cue is raised for the currently-viewed product.',
      },
    });
    expect(coderTests).toEqual(['t1', 't1-negative']);
    expect(ev.testIntentRepair).toEqual({
      outcome: 'repaired',
      testIds: ['t1', 't1-negative'],
    });
  });

  it('bounces to QA with the repair reason in actionableNotes when the repair is not applied', async () => {
    const qaInputs: Array<{ rejectionFeedback?: GateRejectionFeedback }> = [];
    let reviewCalls = 0;
    const deps = makeDeps({
      qaWriteTests: async (input) => {
        qaInputs.push(input as { rejectionFeedback?: GateRejectionFeedback });
        return { kind: 'tests-written', testIds: [`t${qaInputs.length}`] };
      },
      techLeadReviewTests: async () => {
        reviewCalls += 1;
        return reviewCalls === 1
          ? { approved: false, notes: 'missing negative assertion', suggestedChange: 'add it' }
          : { approved: true };
      },
      techLeadRepairTests: async () => ({
        kind: 'not-repaired',
        reason: 'patched tests pass with no implementation — vacuous',
      }),
    });

    const ev = await runTeamTaskWorkflow(codeTask, INPUT, deps);

    expect(ev.outcome).toBe('ready-for-closeout');
    expect(qaInputs).toHaveLength(2);
    expect(qaInputs[1]?.rejectionFeedback?.actionableNotes).toEqual([
      'add it',
      'tech-lead repair attempted but not applied: patched tests pass with no implementation — vacuous',
    ]);
    expect(ev.testIntentRepair).toEqual({
      outcome: 'not-repaired',
      reason: 'patched tests pass with no implementation — vacuous',
    });
  });

  it('bounces to QA on the re-review reason when the tech-lead rejects its own patch', async () => {
    const qaInputs: Array<{ rejectionFeedback?: GateRejectionFeedback }> = [];
    let reviewCalls = 0;
    const deps = makeDeps({
      qaWriteTests: async (input) => {
        qaInputs.push(input as { rejectionFeedback?: GateRejectionFeedback });
        return { kind: 'tests-written', testIds: [`t${qaInputs.length}`] };
      },
      techLeadReviewTests: async () => {
        reviewCalls += 1;
        if (reviewCalls === 1) return { approved: false, notes: 'missing negative assertion' };
        if (reviewCalls === 2) return { approved: false, notes: 'patch still misses the async path' };
        return { approved: true };
      },
      techLeadRepairTests: async () => repaired,
    });

    const ev = await runTeamTaskWorkflow(codeTask, INPUT, deps);

    expect(ev.outcome).toBe('ready-for-closeout');
    expect(qaInputs).toHaveLength(2);
    expect(qaInputs[1]?.rejectionFeedback).toMatchObject({
      reason: 'patch still misses the async path',
      actionableNotes: ['tech-lead patched the tests but rejected them on re-review'],
    });
  });

  it('skips the repair entirely when the rejection is marked repairable: false', async () => {
    let repairCalled = false;
    let reviewCalls = 0;
    const deps = makeDeps({
      techLeadReviewTests: async () => {
        reviewCalls += 1;
        return reviewCalls === 1
          ? { approved: false, notes: 'tests need structural rework', repairable: false }
          : { approved: true };
      },
      techLeadRepairTests: async () => {
        repairCalled = true;
        return repaired;
      },
    });

    const ev = await runTeamTaskWorkflow(codeTask, INPUT, deps);

    expect(ev.outcome).toBe('ready-for-closeout');
    expect(repairCalled).toBe(false);
    expect(ev.testIntentRepair).toBeUndefined();
  });

  it('never attempts a repair on a no-code-test rationale', async () => {
    let repairCalled = false;
    let reviewCalls = 0;
    const deps = makeDeps({
      qaWriteTests: async () => ({ kind: 'no-code-test-rationale', rationale: 'docs only' }),
      techLeadReviewTests: async () => {
        reviewCalls += 1;
        return reviewCalls === 1
          ? { approved: false, notes: 'rationale too thin' }
          : { approved: true };
      },
      techLeadRepairTests: async () => {
        repairCalled = true;
        return repaired;
      },
    });

    await runTeamTaskWorkflow(docsTask, INPUT, deps);

    expect(repairCalled).toBe(false);
  });

  it('attempts the repair exactly once across repeated rejections', async () => {
    let repairCalls = 0;
    let reviewCalls = 0;
    const deps = makeDeps({
      techLeadReviewTests: async () => {
        reviewCalls += 1;
        // Reject the first review AND the post-repair re-review AND the retry
        // review; approve only on the final attempt's review.
        return reviewCalls >= 4 ? { approved: true } : { approved: false, notes: 'still missing' };
      },
      techLeadRepairTests: async () => {
        repairCalls += 1;
        return repaired;
      },
    });

    const ev = await runTeamTaskWorkflow(codeTask, { ...INPUT, cap: 3 }, deps);

    expect(ev.outcome).toBe('ready-for-closeout');
    expect(repairCalls).toBe(1);
  });

  it('treats a throwing repair dep as not-repaired instead of failing the task', async () => {
    const qaInputs: Array<{ rejectionFeedback?: GateRejectionFeedback }> = [];
    let reviewCalls = 0;
    const deps = makeDeps({
      qaWriteTests: async (input) => {
        qaInputs.push(input as { rejectionFeedback?: GateRejectionFeedback });
        return { kind: 'tests-written', testIds: ['t1'] };
      },
      techLeadReviewTests: async () => {
        reviewCalls += 1;
        return reviewCalls === 1
          ? { approved: false, notes: 'missing case' }
          : { approved: true };
      },
      techLeadRepairTests: async () => {
        throw new Error('executor unavailable');
      },
    });

    const ev = await runTeamTaskWorkflow(codeTask, INPUT, deps);

    expect(ev.outcome).toBe('ready-for-closeout');
    expect(qaInputs).toHaveLength(2);
    expect(qaInputs[1]?.rejectionFeedback?.actionableNotes).toContain(
      'tech-lead repair attempted but not applied: executor unavailable',
    );
    expect(ev.testIntentRepair).toEqual({
      outcome: 'not-repaired',
      reason: 'executor unavailable',
    });
  });

  it('preserves WIP as an operational hold when confirm-red loses its profile', async () => {
    const deps = makeDeps({
      qaWriteTests: async () => ({ kind: 'tests-written', testIds: ['t1'] }),
      techLeadReviewTests: async () => ({ approved: false, notes: 'missing case' }),
      techLeadRepairTests: async () => {
        throw new ValidationProfileUnavailableError({
          kind: 'profile-unavailable',
          command: 'npm test',
          prerequisite: 'sandbox-integration',
          exitCode: null,
          timedOut: false,
          diagnostics: 'required validation capability became unavailable during confirm-red',
        });
      },
    });

    const ev = await runTeamTaskWorkflow(codeTask, INPUT, deps);

    expect(ev).toMatchObject({
      outcome: 'blocked',
      loopExitReason: 'operational',
      blockedReason: expect.stringContaining('preserving work in progress'),
      taskValidationFailure: {
        kind: 'profile-unavailable',
        prerequisite: 'sandbox-integration',
      },
    });
  });

  it('keeps the round-cap backstop when every review rejects and repair never lands', async () => {
    let qaCalls = 0;
    const deps = makeDeps({
      qaWriteTests: async () => {
        qaCalls += 1;
        return { kind: 'tests-written', testIds: ['t1'] };
      },
      techLeadReviewTests: async () => ({ approved: false, notes: 'still wrong' }),
      techLeadRepairTests: async () => ({ kind: 'not-repaired', reason: 'no delta' }),
    });

    const ev = await runTeamTaskWorkflow(codeTask, { ...INPUT, cap: 3 }, deps);

    expect(ev.outcome).toBe('blocked');
    expect(ev.loopExitReason).toBe('hard-budget');
    expect(qaCalls).toBe(3);
    expect(ev.testIntentRepair).toEqual({ outcome: 'not-repaired', reason: 'no delta' });
  });

  it('emits a test-repair activity event and a second test-intent verdict for the re-review', async () => {
    const events: Array<Record<string, unknown>> = [];
    let reviewCalls = 0;
    const deps = makeDeps({
      techLeadReviewTests: async () => {
        reviewCalls += 1;
        return reviewCalls === 1
          ? { approved: false, notes: 'missing negative assertion' }
          : { approved: true, notes: 'repaired tests pin the contract' };
      },
      techLeadRepairTests: async () => repaired,
    });

    await runTeamTaskWorkflow(codeTask, {
      ...INPUT,
      emit: (event) => {
        if (event.data !== undefined) events.push(event.data);
      },
    }, deps);

    const repairEvents = events.filter((data) => data['event'] === 'test-repair');
    expect(repairEvents).toHaveLength(1);
    expect(repairEvents[0]).toMatchObject({
      role: 'tech-lead',
      gate: 'test-intent',
      outcome: 'repaired',
    });
    expect(typeof repairEvents[0]?.['line']).toBe('string');
    expect(repairEvents[0]?.['line']).not.toBe('');

    const testIntentVerdicts = events.filter(
      (data) => data['event'] === 'role-verdict' && data['gate'] === 'test-intent',
    );
    expect(testIntentVerdicts.map((data) => data['verdict'])).toEqual(['fail', 'pass']);
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
    let techLeadDiffInput: Record<string, unknown> | undefined;
    const deps = makeDeps({
      coder: async () => ({
        diff: 'THE-DIFF',
        handoffNotes: ['TEST-REMOVED: src/live.test.ts — external live dependency'],
        // A coder seam must not surface hidden reasoning to the reviewer; even if
        // present on the coder result, it must never reach the reviewer input.
      }),
      reviewer: async (input) => {
        reviewerInput = input as unknown as Record<string, unknown>;
        return cleanVerdict;
      },
      techLeadReviewDiff: async (input) => {
        techLeadDiffInput = input as unknown as Record<string, unknown>;
        return { outcome: 'pass', findings: [] };
      },
    });
    await runTeamTaskWorkflow(codeTask, INPUT, deps);
    expect(reviewerInput?.['diff']).toBe('THE-DIFF');
    expect(reviewerInput?.['spec']).toBe('spec body');
    expect(reviewerInput).toHaveProperty('tests');
    expect(reviewerInput).toHaveProperty('task');
    expect(reviewerInput).toHaveProperty('context');
    // Handoff notes ARE the artifact channel (the test-deletion guardrail reads
    // TEST-REMOVED justifications from them) — reasoning stays excluded.
    expect(reviewerInput?.['coderHandoffNotes']).toEqual([
      'TEST-REMOVED: src/live.test.ts — external live dependency',
    ]);
    expect(techLeadDiffInput?.['coderHandoffNotes']).toEqual([
      'TEST-REMOVED: src/live.test.ts — external live dependency',
    ]);
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

// A blocking finding in a high-stakes class must carry the evidence its class
// demands, or it stops blocking. The cheapest possible objection had exactly the
// same stopping power as a rigorous one, which biased the whole loop toward
// stalling (run 815bdec6: one unanchored sentence outvoted two grounded
// approvals).
describe('team-task-workflow — finding evidence contract', () => {
  const unanchored: ObjectionFinding = {
    class: 'concurrency',
    severity: 'high',
    location: '',
    rationale: 'withLease releases on holder abort while work may still run, ' +
      'allowing a later waiter into the same critical section',
  };
  const anchored: ObjectionFinding = {
    ...unanchored,
    location: 'src/lease.ts:42',
  };

  it('an unevidenced finding does not block, and is recorded as downgraded with its reason', async () => {
    const ev = await runTeamTaskWorkflow(codeTask, { ...INPUT, cap: 1 }, makeDeps({
      reviewer: async () => ({ outcome: 'fail', findings: [unanchored] }),
      techLeadReviewDiff: async () => ({ pass: true }),
    }));

    expect(ev.outcome).toBe('ready-for-closeout');
    expect(ev.reviewerVerdict?.findings).toEqual([]);
    expect(ev.findingsLedger).toEqual([]);
    expect(ev.downgradedFindings).toHaveLength(1);
    expect(ev.downgradedFindings?.[0]).toMatchObject({
      sourceGate: 'reviewer',
      round: 1,
      gaps: ['location'],
      rePrompted: false,
    });
    expect(ev.downgradedFindings?.[0]?.reason).toContain('concrete location');
  });

  it('the same finding WITH a location blocks exactly as before', async () => {
    const ev = await runTeamTaskWorkflow(codeTask, { ...INPUT, cap: 1 }, makeDeps({
      reviewer: async () => ({ outcome: 'fail', findings: [anchored] }),
      techLeadReviewDiff: async () => ({ pass: true }),
    }));

    expect(ev.reviewerVerdict?.outcome).toBe('fail');
    expect(ev.reviewerVerdict?.findings).toEqual([anchored]);
    expect(ev.findingsLedger).toHaveLength(1);
    expect(ev).not.toHaveProperty('downgradedFindings');
  });

  it('gives the role exactly one re-prompt, and honors evidence it supplies', async () => {
    let rePrompts = 0;
    const ev = await runTeamTaskWorkflow(codeTask, { ...INPUT, cap: 1 }, makeDeps({
      reviewer: async () => ({ outcome: 'fail', findings: [unanchored] }),
      techLeadReviewDiff: async () => ({ pass: true }),
      requestFindingEvidence: async ({ role, gaps }) => {
        rePrompts += 1;
        expect(role).toBe('reviewer');
        expect(gaps).toHaveLength(1);
        expect(gaps[0]?.ask).toContain('concrete location');
        return [anchored];
      },
    }));

    expect(rePrompts).toBe(1);
    expect(ev.reviewerVerdict?.findings).toEqual([anchored]);
    expect(ev).not.toHaveProperty('downgradedFindings');
  });

  it('downgrades when the re-prompt fails to supply the evidence', async () => {
    let rePrompts = 0;
    const ev = await runTeamTaskWorkflow(codeTask, { ...INPUT, cap: 1 }, makeDeps({
      reviewer: async () => ({ outcome: 'fail', findings: [unanchored] }),
      techLeadReviewDiff: async () => ({ pass: true }),
      requestFindingEvidence: async () => {
        rePrompts += 1;
        return [{ ...unanchored, location: 'various' }];
      },
    }));

    expect(rePrompts).toBe(1);
    expect(ev.downgradedFindings).toHaveLength(1);
    expect(ev.downgradedFindings?.[0]?.rePrompted).toBe(true);
  });

  it('a re-prompt cannot raise severity — that would be a second bite at the gate', async () => {
    const ev = await runTeamTaskWorkflow(codeTask, { ...INPUT, cap: 1 }, makeDeps({
      reviewer: async () => ({
        outcome: 'fail',
        findings: [{ ...unanchored, severity: 'medium' }],
      }),
      techLeadReviewDiff: async () => ({ pass: true }),
      requestFindingEvidence: async () => [{ ...anchored, severity: 'critical' }],
    }));

    // The escalated replacement is refused, so the original medium finding is
    // still the one held to the contract — and it still has no location.
    expect(ev.downgradedFindings).toHaveLength(1);
    expect(ev.downgradedFindings?.[0]?.finding.severity).toBe('medium');
  });

  it('applies supplied evidence only to the same finding when a role raises two findings in one class', async () => {
    const grounded: ObjectionFinding = {
      class: 'security',
      severity: 'high',
      location: 'src/auth.ts:18',
      rationale: 'the retry path skips authorization and exposes another user\'s record',
    };
    const missingAnchor: ObjectionFinding = {
      class: 'security',
      severity: 'high',
      location: '',
      rationale: 'the export path interpolates an untrusted filename into the shell command',
    };
    const supplemented: ObjectionFinding = {
      ...missingAnchor,
      location: 'src/export.ts:44',
    };

    const ev = await runTeamTaskWorkflow(codeTask, { ...INPUT, cap: 1 }, makeDeps({
      reviewer: async () => ({ outcome: 'fail', findings: [grounded, missingAnchor] }),
      techLeadReviewDiff: async () => ({ pass: true }),
      requestFindingEvidence: async ({ gaps }) => {
        expect(gaps.map(({ finding }) => finding)).toEqual([missingAnchor]);
        return [supplemented];
      },
    }));

    expect(ev.reviewerVerdict?.findings).toEqual([grounded, supplemented]);
  });

  it('never downgrades a finding backed by a reproducible failure', async () => {
    const reproducible: ObjectionFinding = {
      ...unanchored,
      location: 'unknown',
      rationale: 'src/lease.test.ts "releases once" fails against this diff',
    };
    const ev = await runTeamTaskWorkflow(codeTask, { ...INPUT, cap: 1 }, makeDeps({
      reviewer: async () => ({ outcome: 'fail', findings: [reproducible] }),
      techLeadReviewDiff: async () => ({ pass: true }),
      requestFindingEvidence: async () => {
        throw new Error('a reproducible failure must never be re-prompted');
      },
    }));

    expect(ev.reviewerVerdict?.findings).toEqual([reproducible]);
    expect(ev).not.toHaveProperty('downgradedFindings');
  });

  it('a re-prompt that throws does not fail the task', async () => {
    const ev = await runTeamTaskWorkflow(codeTask, { ...INPUT, cap: 1 }, makeDeps({
      reviewer: async () => ({ outcome: 'fail', findings: [unanchored] }),
      techLeadReviewDiff: async () => ({ pass: true }),
      requestFindingEvidence: async () => {
        throw new Error('provider down');
      },
    }));

    expect(ev.outcome).toBe('ready-for-closeout');
    expect(ev.downgradedFindings).toHaveLength(1);
  });

  it('leaves a bare fail with no findings alone — that is ordinary disagreement', async () => {
    const ev = await runTeamTaskWorkflow(codeTask, { ...INPUT, cap: 1 }, makeDeps({
      reviewer: async () => ({
        outcome: 'fail',
        findings: [],
        notes: 'the helper should be extracted before this lands',
      }),
      techLeadReviewDiff: async () => ({ pass: true }),
    }));

    expect(ev.outcome).toBe('blocked');
    expect(ev).not.toHaveProperty('downgradedFindings');
  });
});

// agents/pm/SOUL.md has always promised this: "Wrap up at the cap. When a task
// exhausts its retry budget on non-objection disagreement, you make the wrap-up
// call." Until now the charter promised something no code path invoked, so every
// surviving block parked and one dissenting verdict could stop a 45-task project.
describe('team-task-workflow — PM acceptance at the cap', () => {
  /** Non-objection disagreement at the cap: the terminal that used to park. */
  function capDeps(over: Partial<TeamTaskDeps> = {}): TeamTaskDeps {
    return makeDeps({
      reviewer: async () => ({
        outcome: 'fail',
        findings: [],
        notes: 'I would extract the helper before this lands',
      }),
      techLeadReviewDiff: async () => ({ pass: true }),
      ...over,
    });
  }

  const accept = async () => ({
    accepted: true,
    actor: 'pm' as const,
    rationale: 'The helper shape is a style preference; the user-visible behavior is correct.',
  });

  it('closes out with a recorded rationale instead of parking', async () => {
    const ev = await runTeamTaskWorkflow(codeTask, { ...INPUT, cap: 1 }, capDeps({
      acceptWithRationale: accept,
    }));

    expect(ev.outcome).toBe('ready-for-closeout');
    expect(ev.acceptance).toEqual({
      actor: 'pm',
      decision: 'accepted-with-rationale',
      rationale: 'The helper shape is a style preference; the user-visible behavior is correct.',
      dissentingRole: 'reviewer',
      overriddenVerdict: expect.objectContaining({
        outcome: 'fail',
        notes: 'I would extract the helper before this lands',
      }),
    });
    expect(ev.rolesInvoked).toContain('pm');
  });

  it('gives PM the actual dissenting verdict plus the complete review context', async () => {
    let seen: Parameters<NonNullable<TeamTaskDeps['acceptWithRationale']>>[0] | undefined;
    const ev = await runTeamTaskWorkflow(codeTask, { ...INPUT, cap: 1 }, makeDeps({
      reviewer: async () => ({ outcome: 'pass', findings: [] }),
      techLeadReviewDiff: async () => ({
        pass: false,
        notes: 'the implementation still misses the retry contract',
      }),
      acceptWithRationale: async (input) => {
        seen = input;
        return accept();
      },
    }));

    expect(ev.outcome).toBe('ready-for-closeout');
    expect(seen).toMatchObject({
      spec: INPUT.spec,
      rejectionFeedback: { rejectingRole: 'tech-lead' },
      dissentingVerdict: {
        outcome: 'fail',
        notes: 'the implementation still misses the retry contract',
      },
      judgmentContext: {
        spec: INPUT.spec,
        diff: expect.stringContaining('diff --git'),
        tests: expect.anything(),
      },
    });
    expect(seen?.findingsLedger).toEqual([]);
    expect(ev.acceptance).toMatchObject({
      dissentingRole: 'tech-lead',
      overriddenVerdict: {
        outcome: 'fail',
        notes: 'the implementation still misses the retry contract',
      },
    });
  });

  it('parks when no acceptance seam is wired — the pre-existing behavior', async () => {
    const ev = await runTeamTaskWorkflow(codeTask, { ...INPUT, cap: 1 }, capDeps());
    expect(ev.outcome).toBe('blocked');
    expect(ev).not.toHaveProperty('acceptance');
  });

  it('requires a non-empty rationale', async () => {
    for (const result of [
      { accepted: true, actor: 'pm' as const },
      { accepted: true, actor: 'pm' as const, rationale: '   ' },
      { accepted: false, actor: 'pm' as const, rationale: 'this needs a human' },
    ]) {
      const ev = await runTeamTaskWorkflow(codeTask, { ...INPUT, cap: 1 }, capDeps({
        acceptWithRationale: async () => result,
      }));
      expect(ev.outcome, JSON.stringify(result)).toBe('blocked');
      expect(ev).not.toHaveProperty('acceptance');
    }
  });

  it('a throwing acceptance seam leaves the block intact', async () => {
    const ev = await runTeamTaskWorkflow(codeTask, { ...INPUT, cap: 1 }, capDeps({
      acceptWithRationale: async () => {
        throw new Error('pm provider down');
      },
    }));
    expect(ev.outcome).toBe('blocked');
  });

  it('is never consulted for an at-threshold finding', async () => {
    let called = false;
    const ev = await runTeamTaskWorkflow(codeTask, { ...INPUT, cap: 1 }, makeDeps({
      reviewer: async () => ({
        outcome: 'fail',
        findings: [{
          class: 'security',
          severity: 'medium',
          location: 'src/auth.ts:12',
          rationale: 'the retry path skips the allow-list check on the second attempt',
          reversible: true,
        }],
      }),
      techLeadReviewDiff: async () => ({ pass: true }),
      acceptWithRationale: async () => {
        called = true;
        return { accepted: true, actor: 'pm', rationale: 'must not be consulted' };
      },
    }));

    expect(called).toBe(false);
    expect(ev).not.toHaveProperty('acceptance');
  });

  it('is never consulted for an irreversible finding', async () => {
    let called = false;
    await runTeamTaskWorkflow(codeTask, { ...INPUT, cap: 1 }, makeDeps({
      reviewer: async () => ({
        outcome: 'fail',
        findings: [{
          class: 'data-integrity',
          severity: 'low',
          location: 'src/store.ts:88',
          rationale: 'the migration drops a column that a revert cannot restore',
          reversible: false,
        }],
      }),
      techLeadReviewDiff: async () => ({ pass: true }),
      acceptWithRationale: async () => {
        called = true;
        return { accepted: true, actor: 'pm', rationale: 'must not be consulted' };
      },
    }));

    expect(called).toBe(false);
  });

  it('announces the override on the activity stream', async () => {
    const events: WorkflowActivityEvent[] = [];
    const ev = await runTeamTaskWorkflow(
      codeTask,
      { ...INPUT, cap: 1, emit: (event) => events.push(event) },
      capDeps({ acceptWithRationale: accept }),
    );

    expect(ev.outcome).toBe('ready-for-closeout');
    const announcement = events.find((event) => event.data?.['event'] === 'pm-acceptance');
    expect(announcement?.data?.['rationale']).toContain('style preference');
    expect(announcement?.data?.['overriddenRole']).toBe('reviewer');
    const verdict = events.find(
      (event) => event.data?.['event'] === 'role-verdict' && event.data?.['role'] === 'pm',
    );
    expect(verdict?.data?.['summary']).toContain('accepted over dissent');
  });

  // The PM only ever sees findings-free disagreement: any open finding is at
  // least `medium` (a `low` one maps to pass-with-warnings and never blocks), and
  // `PM_ACCEPTANCE_MAX_SEVERITY` refuses medium-and-above. That is the charter's
  // boundary expressed in code — "your authority does not extend to clearing
  // objection-class findings" — and it means a findings-backed block still parks
  // unless the pre-existing severity loop resolves it on its own.
  it('never accepts while ANY objection-class finding is open', async () => {
    for (const severity of ['medium', 'high', 'critical'] as const) {
      let called = false;
      await runTeamTaskWorkflow(codeTask, { ...INPUT, cap: 1 }, makeDeps({
        reviewer: async () => ({
          outcome: 'fail',
          findings: [{
            class: 'security',
            severity,
            location: 'src/auth.ts:12',
            rationale: 'the retry path skips the allow-list check on the second attempt',
            reversible: true,
          }],
        }),
        techLeadReviewDiff: async () => ({ pass: true }),
        acceptWithRationale: async () => {
          called = true;
          return { accepted: true, actor: 'pm', rationale: 'must not be consulted' };
        },
      }));
      expect(called, severity).toBe(false);
    }
  });
});

// The closeout gate is unanimous-AND, so a reviewer-vs-tech-lead disagreement is
// modeled as failure and nothing ever compares the two arguments — the run parks
// and waits for a human. One tie-breaker with fresh context resolves it.
describe('team-task-workflow — split adjudication', () => {
  const disputed: ObjectionFinding = {
    class: 'concurrency',
    severity: 'medium',
    location: 'src/lease.ts:42',
    rationale: 'withLease releases on holder abort while work may still run, ' +
      'allowing a later waiter into the same critical section',
    reversible: true,
  };

  /** The true 1-1 tie: the reviewer withholds a pass with reasoning but no
   *  objection-class finding, the tech lead passes. Nothing in the pre-existing
   *  gate can break this — `hasOnlySeverityDerivedFailures` is false, so the cap
   *  falls through to the final block. That makes it the right fixture for
   *  fail-closed assertions: today's behavior here IS a block, so "falls back to
   *  today's behavior" is observable. */
  function splitDeps(over: Partial<TeamTaskDeps> = {}): TeamTaskDeps {
    return makeDeps({
      reviewer: async () => ({
        outcome: 'fail',
        findings: [],
        notes: 'the lease release ordering still reads wrong to me',
      }),
      techLeadReviewDiff: async () => ({ pass: true }),
      ...over,
    });
  }

  /** A split over a concrete finding, for ledger/follow-up assertions. */
  function findingSplitDeps(over: Partial<TeamTaskDeps> = {}): TeamTaskDeps {
    return makeDeps({
      reviewer: async () => ({ outcome: 'fail', findings: [disputed] }),
      techLeadReviewDiff: async () => ({ pass: true }),
      ...over,
    });
  }

  it('a split at the cap dispatches exactly one adjudicator and resolves without a human', async () => {
    const calls: unknown[] = [];
    const ev = await runTeamTaskWorkflow(codeTask, { ...INPUT, cap: 1 }, splitDeps({
      adjudicateSplit: async (input) => {
        calls.push(input);
        return { upholds: 'pass', rationale: 'releaseOnHolderAbort is threaded through acquireWithPolicy' };
      },
    }));

    expect(calls).toHaveLength(1);
    expect(ev.outcome).toBe('ready-for-closeout');
    expect(ev.adjudications).toHaveLength(1);
    expect(ev.adjudications?.[0]).toMatchObject({
      round: 1,
      dissentingRole: 'reviewer',
      concurringRole: 'tech-lead',
      upheld: 'pass',
      escalated: false,
    });
  });

  it('gives the adjudicator both verdicts and the artifacts, never the coder handoff', async () => {
    let seen: Record<string, any> | undefined;
    await runTeamTaskWorkflow(codeTask, { ...INPUT, cap: 1 }, findingSplitDeps({
      adjudicateSplit: async (input) => {
        seen = input as Record<string, any>;
        return { upholds: 'pass', rationale: 'the guard answers it' };
      },
    }));

    expect(seen?.['dissentingVerdict']?.findings?.[0]).toMatchObject({ location: 'src/lease.ts:42' });
    expect(seen?.['concurringVerdict']?.outcome).toBe('pass');
    expect(seen?.['judgmentContext']?.diff).toBeDefined();
    expect(seen?.['judgmentContext']?.spec).toBe(INPUT.spec);
    expect(seen?.['judgmentContext']?.tests).toBeDefined();
  });

  it('unanimity dispatches no adjudicator', async () => {
    let called = false;
    const ev = await runTeamTaskWorkflow(codeTask, { ...INPUT, cap: 1 }, makeDeps({
      adjudicateSplit: async () => {
        called = true;
        return { upholds: 'pass', rationale: 'unreachable' };
      },
    }));

    expect(called).toBe(false);
    expect(ev.outcome).toBe('ready-for-closeout');
    expect(ev).not.toHaveProperty('adjudications');
  });

  it('never lets adjudication override the required designer gate', async () => {
    let called = false;
    const ev = await runTeamTaskWorkflow(frontEndTask, { ...INPUT, cap: 1 }, makeDeps({
      reviewer: async () => ({ outcome: 'pass', findings: [] }),
      techLeadReviewDiff: async () => ({ pass: true }),
      designer: async () => ({
        pass: false,
        findings: [{
          class: 'cost-perf',
          severity: 'medium',
          location: 'src/card.css:18',
          rationale: 'the compact viewport hides the primary action below the fold',
        }],
      }),
      adjudicateSplit: async () => {
        called = true;
        return { upholds: 'pass', rationale: 'must not be consulted' };
      },
    }));

    expect(called).toBe(false);
    expect(ev.outcome).toBe('blocked');
    expect(ev.blockedReason).toContain('designer review failed');
  });

  it.each([
    { severity: 'high' as const, reversible: true },
    { severity: 'critical' as const, reversible: true },
    { severity: 'medium' as const, reversible: false },
  ])('keeps $severity reversible=$reversible findings with a human instead of adjudicating', async ({ severity, reversible }) => {
    let called = false;
    const finding: ObjectionFinding = {
      ...disputed,
      severity,
      reversible,
    };
    const ev = await runTeamTaskWorkflow(codeTask, { ...INPUT, cap: 1 }, makeDeps({
      reviewer: async () => ({ outcome: 'fail', findings: [finding] }),
      techLeadReviewDiff: async () => ({ pass: true }),
      adjudicateSplit: async () => {
        called = true;
        return { upholds: 'pass', rationale: 'must not be consulted' };
      },
    }));

    expect(called).toBe(false);
    expect(ev.outcome).toBe('blocked');
  });

  it('cannot adjudicate away a protected finding left open by an earlier round', async () => {
    let round = 0;
    let adjudicatorCalls = 0;
    const protectedFinding: ObjectionFinding = {
      class: 'security',
      severity: 'high',
      location: 'src/auth.ts:41',
      rationale: 'a retry after token expiry bypasses the allow-list and reaches the protected route',
      reversible: true,
    };
    const laterDispute: ObjectionFinding = {
      ...disputed,
      location: 'src/lease.ts:87',
    };
    const ev = await runTeamTaskWorkflow(codeTask, { ...INPUT, cap: 2 }, makeDeps({
      coder: async () => {
        round += 1;
        return { diff: `diff ${round}`, handoffNotes: [] };
      },
      reviewer: async () => round === 1
        ? { outcome: 'fail', findings: [protectedFinding] }
        : { outcome: 'pass', findings: [], verifiedFindings: [] },
      techLeadReviewDiff: async () => round === 1
        ? { pass: true }
        : { pass: false, findings: [laterDispute] },
      adjudicateSplit: async () => {
        adjudicatorCalls += 1;
        return { upholds: 'pass', rationale: 'the later lease concern is acceptable' };
      },
    }));

    expect(adjudicatorCalls).toBe(0);
    expect(ev.outcome).toBe('blocked');
    expect(ev.blockedReason).toContain('human-owned high security');
    expect(ev.findingsLedger).toEqual(expect.arrayContaining([
      expect.objectContaining({
        class: 'security',
        severity: 'high',
        status: 'open',
      }),
    ]));
  });

  it('resolves only the current disputed findings, not older findings from the same role', async () => {
    let round = 0;
    const olderFinding: ObjectionFinding = {
      ...disputed,
      location: 'src/lease.ts:21',
      rationale: 'the first waiter can retain a stale holder after cancellation completes',
    };
    const currentFinding: ObjectionFinding = {
      ...disputed,
      location: 'src/lease.ts:87',
      rationale: 'the next waiter can enter before the released work has settled',
    };
    const ev = await runTeamTaskWorkflow(codeTask, { ...INPUT, cap: 2 }, makeDeps({
      coder: async () => {
        round += 1;
        return { diff: `diff ${round}`, handoffNotes: [] };
      },
      reviewer: async () => ({
        outcome: 'fail',
        findings: [round === 1 ? olderFinding : currentFinding],
      }),
      techLeadReviewDiff: async () => ({ pass: true }),
      adjudicateSplit: async () => ({
        upholds: 'pass',
        rationale: 'the current waiter transition is guarded',
      }),
    }));

    expect(ev.outcome).toBe('blocked');
    expect(ev.blockedReason).toContain('another blocking concurrency finding remains open');
    expect(ev.findingsLedger).toEqual(expect.arrayContaining([
      expect.objectContaining({ location: olderFinding.location, status: 'open' }),
      expect.objectContaining({ location: currentFinding.location, status: 'resolved' }),
    ]));
    expect(ev.downgradedFindings?.map((entry) => entry.finding.location)).toEqual([
      currentFinding.location,
    ]);
  });

  it('keeps explicit irreversibility sticky when a later verdict omits the flag', async () => {
    let round = 0;
    let adjudicatorCalls = 0;
    const irreversible: ObjectionFinding = {
      ...disputed,
      reversible: false,
    };
    const { reversible: _omitted, ...withoutReversibility } = irreversible;
    const ev = await runTeamTaskWorkflow(codeTask, { ...INPUT, cap: 2 }, makeDeps({
      coder: async () => {
        round += 1;
        return { diff: `diff ${round}`, handoffNotes: [] };
      },
      reviewer: async () => ({
        outcome: 'fail',
        findings: [round === 1
          ? irreversible
          : withoutReversibility],
      }),
      techLeadReviewDiff: async () => ({ pass: true }),
      adjudicateSplit: async () => {
        adjudicatorCalls += 1;
        return { upholds: 'pass', rationale: 'must not be consulted' };
      },
    }));

    expect(adjudicatorCalls).toBe(0);
    expect(ev.outcome).toBe('blocked');
    expect(ev.blockedReason).toContain('human-owned non-reversible medium');
  });

  it('does not adjudicate a first-round split while coder rounds remain', async () => {
    let calls = 0;
    let round = 0;
    await runTeamTaskWorkflow(codeTask, { ...INPUT, cap: 2 }, makeDeps({
      coder: async () => {
        round += 1;
        return { diff: `diff ${round}`, handoffNotes: [] };
      },
      // Round 1 splits; round 2 is unanimous — the coder fixed it, and no
      // adjudication was ever paid for.
      reviewer: async () => round === 1
        ? { outcome: 'fail', findings: [disputed] }
        : { outcome: 'pass', findings: [], verifiedFindings: [] },
      techLeadReviewDiff: async () => ({ pass: true }),
      adjudicateSplit: async () => {
        calls += 1;
        return { upholds: 'pass', rationale: 'should not run in round 1' };
      },
    }));

    expect(calls).toBe(0);
  });

  it('upholding the fail keeps the objection open and blocks', async () => {
    const ev = await runTeamTaskWorkflow(codeTask, { ...INPUT, cap: 1 }, splitDeps({
      adjudicateSplit: async () => ({
        upholds: 'fail',
        rationale: 'the finally releases on abort before in-flight work settles',
        finding: disputed,
      }),
    }));

    expect(ev.outcome).toBe('blocked');
    expect(ev.adjudications?.[0]?.upheld).toBe('fail');
    // Typed, so downstream surfaces never have to pattern-match the prose.
    expect(ev.adjudicationUpheldFail).toBe(true);
    expect(ev.adjudicationFailure).toBeUndefined();
    // The ruling's finding survives as concrete blocking evidence.
    expect(ev.findingsLedger.some(
      (entry) => entry.status === 'open' && entry.location === disputed.location,
    )).toBe(true);
  });

  // The two terminal adjudication states are mutually exclusive: an operational
  // hold must never masquerade as an adjudicated product failure downstream.
  it('an operational adjudication failure never sets the upheld-fail marker', async () => {
    const ev = await runTeamTaskWorkflow(codeTask, { ...INPUT, cap: 1 }, splitDeps({
      adjudicateSplit: async () => ({ upholds: 'fail', rationale: '   ', finding: disputed }),
    }));

    expect(ev.adjudicationUpheldFail).toBeUndefined();
    expect(ev.adjudicationFailure?.code).toBe('adjudication-output-invalid');
  });

  it('upholding the pass files the dissent as a follow-up rather than dropping it', async () => {
    const ev = await runTeamTaskWorkflow(codeTask, { ...INPUT, cap: 1 }, findingSplitDeps({
      adjudicateSplit: async () => ({
        upholds: 'pass',
        rationale: 'the abort path is guarded at src/lease.ts:114',
      }),
    }));

    expect(ev.outcome).toBe('ready-for-closeout');
    expect(ev.downgradedFindings).toHaveLength(1);
    expect(ev.downgradedFindings?.[0]?.finding).toEqual(disputed);
    expect(ev.downgradedFindings?.[0]?.reason).toContain('adjudicator upheld');
    expect(ev.findingsLedger.every((entry) => entry.status === 'resolved')).toBe(true);
  });

  it('escalates when the same objection is adjudicated a second time', async () => {
    const escalations: boolean[] = [];
    let round = 0;
    await runTeamTaskWorkflow(codeTask, { ...INPUT, cap: 2 }, makeDeps({
      coder: async () => {
        round += 1;
        return { diff: `diff ${round}`, handoffNotes: [] };
      },
      // The same objection survives the coder round, so round 2 is a repeat.
      reviewer: async () => ({ outcome: 'fail', findings: [disputed] }),
      techLeadReviewDiff: async () => ({ pass: true }),
      adjudicateSplit: async ({ escalate }) => {
        escalations.push(escalate);
        return {
          upholds: 'fail',
          rationale: 'still unresolved',
          finding: disputed,
        };
      },
    }));

    // Round 1 records the split without spending an adjudication. When the
    // same objection survives the coder retry, round 2 uses the alternate.
    expect(escalations).toEqual([true]);
  });

  it('retains the optional legacy fallback when no adjudication seam is wired', async () => {
    const events: WorkflowActivityEvent[] = [];
    const ev = await runTeamTaskWorkflow(
      codeTask,
      { ...INPUT, cap: 1, emit: (event) => events.push(event) },
      splitDeps(),
    );

    expect(ev.outcome).toBe('blocked');
    expect(ev).not.toHaveProperty('adjudications');
    expect(ev).not.toHaveProperty('adjudicationFailure');
    expect(ev.rolesInvoked).not.toContain('adjudicator');
    expect(events.some((event) => event.data?.['role'] === 'adjudicator')).toBe(false);
  });

  it('retains the legacy severity-loop fallback for a findings-backed split without a seam', async () => {
    const ev = await runTeamTaskWorkflow(codeTask, { ...INPUT, cap: 1 }, makeDeps({
      reviewer: async () => ({
        outcome: 'fail',
        findings: [{ ...disputed, severity: 'medium', reversible: true }],
      }),
      techLeadReviewDiff: async () => ({ pass: true }),
    }));

    expect(ev.outcome).toBe('ready-for-closeout');
    expect(ev).not.toHaveProperty('adjudications');
  });

  it('returns a typed operational failure when the adjudicator throws', async () => {
    const ev = await runTeamTaskWorkflow(codeTask, { ...INPUT, cap: 1 }, splitDeps({
      adjudicateSplit: async () => {
        throw new Error('provider unavailable');
      },
    }));

    expect(ev.outcome).toBe('failed');
    expect(ev.loopExitReason).toBe('operational');
    expect(ev.adjudicationFailure).toMatchObject({
      code: 'adjudication-output-invalid',
      cause: 'provider-failure',
      attempts: [{ attempt: 1, code: 'provider-failure' }],
    });
    expect(JSON.stringify(ev)).not.toContain('provider unavailable');
    expect(ev.adjudications?.[0]).not.toHaveProperty('upheld');
  });

  it('returns a typed operational failure when the adjudicator reports unavailable', async () => {
    const ev = await runTeamTaskWorkflow(codeTask, { ...INPUT, cap: 1 }, splitDeps({
      adjudicateSplit: async () => ({
        status: 'operational-failure',
        failure: {
          code: 'adjudication-output-invalid',
          cause: 'unavailable',
          attempts: [],
        },
      }),
    }));

    expect(ev).toMatchObject({
      outcome: 'failed',
      loopExitReason: 'operational',
      adjudicationFailure: { cause: 'unavailable' },
      failureReason: expect.stringContaining('Adjudication operational hold'),
    });
    expect(ev.adjudications?.[0]).not.toHaveProperty('upheld');
    expect(ev).not.toHaveProperty('rejectionFeedback');
  });

  it('records unusable legacy seam rulings as operational failures, never substantive fails', async () => {
    for (const ruling of [
      { upholds: 'pass' as const, rationale: '   ' },
      { upholds: 'fail' as const, rationale: 'it is broken' }, // upheld fail, no finding
      { upholds: 'unresolved' as unknown as 'pass', rationale: 'cannot tell from the diff' },
    ]) {
      const ev = await runTeamTaskWorkflow(codeTask, { ...INPUT, cap: 1 }, splitDeps({
        adjudicateSplit: async () => ruling,
      }));
      expect(ev.outcome, JSON.stringify(ruling)).toBe('failed');
      expect(ev.loopExitReason).toBe('operational');
      expect(ev.adjudicationFailure?.code).toBe('adjudication-output-invalid');
      expect(ev.adjudications?.[0]).not.toHaveProperty('upheld');
      expect(ev.findingsLedger).toEqual([]);
      expect(ev).not.toHaveProperty('rejectionFeedback');
    }
  });

  // The adjudicator is the one role nothing downstream reviews, so an upheld
  // finding must clear the same class evidence contract every other blocking
  // finding does — otherwise the ruling blocks with exactly the ungrounded
  // assertion the contract exists to catch, and with more authority.
  it('fails closed when the upheld finding misses its class evidence contract', async () => {
    for (const finding of [
      // Evidence-required class, placeholder location.
      {
        class: 'concurrency' as const,
        severity: 'high' as const,
        location: 'various',
        rationale: 'there is a race somewhere in the lease acquisition path',
      },
      // Evidence-required class, bare restatement for a rationale.
      {
        class: 'security' as const,
        severity: 'high' as const,
        location: 'src/lease.ts:42',
        rationale: 'security issue',
      },
    ]) {
      const ev = await runTeamTaskWorkflow(codeTask, { ...INPUT, cap: 1 }, splitDeps({
        adjudicateSplit: async () => ({
          upholds: 'fail' as const,
          rationale: 'the dissent is right',
          finding,
        }),
      }));

      expect(ev.outcome, JSON.stringify(finding)).toBe('failed');
      expect(ev.adjudicationFailure).toMatchObject({
        cause: 'invalid-artifact',
        attempts: [{ code: 'incomplete-finding-evidence' }],
      });
      expect(ev.adjudications?.[0]).not.toHaveProperty('upheld');
      // The ungrounded finding never reaches the ledger or the coder feedback.
      expect(ev.findingsLedger.some((entry) => entry.location === finding.location)).toBe(false);
    }
  });

  it('admits an upheld finding outside the evidence-required classes', async () => {
    const ev = await runTeamTaskWorkflow(codeTask, { ...INPUT, cap: 1 }, splitDeps({
      adjudicateSplit: async () => ({
        upholds: 'fail' as const,
        rationale: 'the dissent is right',
        // `outbound` is not an evidence-required class, so the contract is a
        // no-op here and the ruling stands on the adjudicator's own judgment.
        finding: {
          class: 'outbound' as const,
          severity: 'high' as const,
          location: 'various',
          rationale: 'egress',
        },
      }),
    }));

    expect(ev.outcome).toBe('blocked');
    expect(ev.adjudications?.[0]?.failClosedReason).toBeUndefined();
    expect(ev.findingsLedger.some((entry) => entry.class === 'outbound')).toBe(true);
  });
});

describe('team-task-workflow — objection gate', () => {
  const objection: ObjectionFinding = {
    class: 'security',
    severity: 'high',
    location: 'src/x.ts:10',
    rationale: 'unsanitized shell interpolation',
  };

  const phase14Finding = {
    class: 'outbound',
    severity: 'high',
    location: 'src/egress.ts:27',
    rationale: 'unapproved network egress can leave the sandbox',
    reversible: true,
  };

  it('maps a high objection-class finding to fail, not block', async () => {
    const deps = makeDeps({ reviewer: async () => ({ pass: false, objections: [objection] }) });
    const ev = await runTeamTaskWorkflow(codeTask, INPUT, deps);
    expect(ev.outcome).toBe('ready-for-closeout');
    expect(ev.reviewerVerdict?.outcome).toBe('fail');
    expect(ev.objectionOpen).toBe(false);
  });

  it('does not expose a high severity finding as an open human block', async () => {
    const deps = makeDeps({
      reviewer: async () => ({ pass: false, objections: [objection] }),
    });
    const ev = await runTeamTaskWorkflow(codeTask, INPUT, deps);
    expect(ev.outcome).toBe('ready-for-closeout');
    expect(ev.reviewerVerdict?.outcome).toBe('fail');
    expect(ev.objectionOpen).toBe(false);
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

  it('normalizes reviewer findings to the Phase 14 shape including outbound class and reversible', async () => {
    const deps = makeDeps({
      reviewer: async () => ({
        outcome: 'fail',
        findings: [phase14Finding],
      } as unknown as ReviewerVerdict),
    });

    const ev = await runTeamTaskWorkflow(codeTask, { ...INPUT, cap: 1 }, deps);

    expect(ev.outcome).toBe('ready-for-closeout');
    expect(ev.reviewerVerdict?.findings).toEqual([phase14Finding]);
    expect(ev.gateVerdicts?.reviewer?.findings).toEqual([phase14Finding]);
  });

  it('normalizes tech-lead and designer review findings to the same Phase 14 shape', async () => {
    const techLeadFinding = {
      class: 'concurrency',
      severity: 'low',
      location: 'src/queue.ts:61',
      rationale: 'duplicate starts can race but are harmless after retry',
      reversible: false,
    };
    const designerFinding = {
      class: 'cost-perf',
      severity: 'low',
      location: 'src/server/static/app.js:114',
      rationale: 'extra repaint is visible on slow devices',
      reversible: true,
    };
    const deps = makeDeps({
      reviewer: async () => ({
        outcome: 'pass-with-warnings',
        findings: [{ ...phase14Finding, severity: 'low' }],
      } as unknown as ReviewerVerdict),
      techLeadReviewDiff: async () => ({
        outcome: 'pass-with-warnings',
        findings: [techLeadFinding],
      } as unknown as { pass: boolean; notes?: string }),
      designer: async () => ({
        outcome: 'pass-with-warnings',
        findings: [designerFinding],
      } as unknown as { pass: boolean; notes?: string }),
    });

    const ev = await runTeamTaskWorkflow(frontEndTask, { ...INPUT, cap: 1 }, deps);

    expect(ev.outcome).toBe('ready-for-closeout');
    expect(ev.gateVerdicts?.reviewer?.findings).toEqual([
      { ...phase14Finding, severity: 'low' },
    ]);
    expect(ev.gateVerdicts?.techLeadDiff?.findings).toEqual([techLeadFinding]);
    expect(ev.gateVerdicts?.designer?.findings).toEqual([designerFinding]);
  });

  it('defaults omitted or malformed reversible flags to false without dropping findings from any review gate', async () => {
    const reviewerFinding = {
      class: 'outbound',
      severity: 'high',
      location: 'src/egress.ts:27',
      rationale: 'unapproved network egress can leave the sandbox',
    };
    const techLeadFinding = {
      class: 'data-integrity',
      severity: 'medium',
      location: 'src/state.ts:91',
      rationale: 'checkpoint write can leave a partial cursor',
      reversible: 'unknown',
    };
    const designerFinding = {
      class: 'cost-perf',
      severity: 'critical',
      location: 'src/server/static/app.js:114',
      rationale: 'render loop can freeze the cockpit during active review',
      reversible: null,
    };

    const ev = await runTeamTaskWorkflow(
      frontEndTask,
      { ...INPUT, cap: 1 },
      makeDeps({
        reviewer: async () => ({
          outcome: 'fail',
          findings: [reviewerFinding],
        } as unknown as ReviewerVerdict),
        techLeadReviewDiff: async () => ({
          outcome: 'fail',
          findings: [techLeadFinding],
        } as unknown as { pass: boolean; notes?: string }),
        designer: async () => ({
          outcome: 'fail',
          findings: [designerFinding],
        } as unknown as { pass: boolean; notes?: string }),
      }),
    );

    expect(ev.gateVerdicts?.reviewer?.findings).toEqual([
      { ...reviewerFinding, reversible: false },
    ]);
    expect(ev.gateVerdicts?.techLeadDiff?.findings).toEqual([
      {
        class: 'data-integrity',
        severity: 'medium',
        location: 'src/state.ts:91',
        rationale: 'checkpoint write can leave a partial cursor',
        reversible: false,
      },
    ]);
    expect(ev.gateVerdicts?.designer?.findings).toEqual([
      {
        class: 'cost-perf',
        severity: 'critical',
        location: 'src/server/static/app.js:114',
        rationale: 'render loop can freeze the cockpit during active review',
        reversible: false,
      },
    ]);
  });

  it('rejects the retired irreversibility class as malformed review-gate output', async () => {
    const deps = makeDeps({
      reviewer: async () => ({
        outcome: 'fail',
        findings: [{
          class: 'irreversibility',
          severity: 'high',
          location: 'src/delete.ts:12',
          rationale: 'the old class name must not survive Phase 14',
          reversible: false,
        }],
      } as unknown as ReviewerVerdict),
    });

    const ev = await runTeamTaskWorkflow(codeTask, { ...INPUT, cap: 2 }, deps);

    expect(ev.outcome).toBe('failed');
    expect(ev.loopExitReason).toBe('operational');
    expect(ev.failureReason).toMatch(/operational|malformed class|unsupported class/i);
    expect(ev).not.toHaveProperty('blockedReason');
    expect(ev.rejectionFeedback).toMatchObject({
      rejectingRole: 'reviewer',
      rejectedRole: 'coder',
      rejectedArtifact: 'reviewer-verdict',
      reason: expect.stringMatching(/irreversibility|malformed class|unsupported class/i),
    });
  });
});

// ---------------------------------------------------------------------------
// Outcome gating — shared reviewing verdict contract (Phase 13)
// ---------------------------------------------------------------------------

describe('team-task-workflow — reviewing verdict outcome enum', () => {
  it('does not admit legacy block in ReviewerOutcome or GateVerdict.outcome', () => {
    const publicOutcomes = [...REVIEW_OUTCOMES];

    expect(publicOutcomes).toEqual(['pass', 'pass-with-warnings', 'fail']);
    expect(publicOutcomes).not.toContain('block');
  });

  it('exports one severity-to-outcome mapper as the shared source of truth', () => {
    const mapSeverity = (
      teamTaskWorkflow as typeof teamTaskWorkflow & {
        mapObjectionSeverityToOutcome?: (severity: ObjectionSeverity) => ReviewerOutcome;
      }
    ).mapObjectionSeverityToOutcome;

    expect(typeof mapSeverity).toBe('function');
    if (typeof mapSeverity !== 'function') {
      throw new Error('mapObjectionSeverityToOutcome must be exported');
    }
    expect(mapSeverity('critical')).toBe('fail');
    expect(mapSeverity('high')).toBe('fail');
    expect(mapSeverity('medium')).toBe('fail');
    expect(mapSeverity('low')).toBe('pass-with-warnings');
  });

  it('returns the reviewer verdict with exactly one structured outcome enum, not a bare pass boolean', async () => {
    const ev = await runTeamTaskWorkflow(codeTask, INPUT, makeDeps());
    const verdict = ev.reviewerVerdict as Record<string, unknown> | undefined;

    expect(verdict).toBeDefined();
    expect(verdict).toHaveProperty('outcome');
    expect(REVIEW_OUTCOMES).toContain(verdict?.['outcome'] as (typeof REVIEW_OUTCOMES)[number]);
    expect(verdict).not.toHaveProperty('pass');
  });

  it('normalizes reviewer, tech-lead diff, and designer gates to one shared GateVerdict shape', async () => {
    const warningFinding: ObjectionFinding = {
      class: 'cost-perf',
      severity: 'low',
      location: 'src/cache.ts:44',
      rationale: 'follow-up can reduce duplicate reads; correctness is unaffected',
    };
    const ev = await runTeamTaskWorkflow(
      frontEndTask,
      { ...INPUT, cap: 1 },
      makeDeps({
        reviewer: async () => ({
          outcome: 'pass-with-warnings',
          findings: [warningFinding],
          notes: 'non-blocking performance follow-up',
        } as unknown as ReviewerVerdict),
        techLeadReviewDiff: async () => ({
          outcome: 'pass',
          findings: [],
          notes: 'implementation is coherent',
        } as unknown as { pass: boolean; notes?: string }),
        designer: async () => ({
          outcome: 'pass',
          findings: [],
          notes: 'UI is consistent',
        } as unknown as { pass: boolean; notes?: string }),
      }),
    );
    const gateVerdicts = (ev as unknown as {
      gateVerdicts?: Record<string, GateVerdictRecord>;
    }).gateVerdicts;

    expect(ev.outcome).toBe('ready-for-closeout');
    expect(gateVerdicts).toMatchObject({
      reviewer: {
        outcome: 'pass-with-warnings',
        findings: [warningFinding],
        notes: 'non-blocking performance follow-up',
      },
      techLeadDiff: { outcome: 'pass', findings: [], notes: 'implementation is coherent' },
      designer: { outcome: 'pass', findings: [], notes: 'UI is consistent' },
    });
    for (const verdict of Object.values(gateVerdicts ?? {})) {
      expect(REVIEW_OUTCOMES).toContain(verdict['outcome'] as (typeof REVIEW_OUTCOMES)[number]);
      expect(verdict).toHaveProperty('findings');
      expect(verdict).not.toHaveProperty('pass');
      expect(verdict).not.toHaveProperty('objections');
    }
  });

  it('fails closed to operational failed evidence on an unknown reviewer outcome without spending a coder correction round', async () => {
    const coderInputs: Array<{ rejectionFeedback?: GateRejectionFeedback[] }> = [];
    const deps = makeDeps({
      coder: async (input) => {
        coderInputs.push(input as { rejectionFeedback?: GateRejectionFeedback[] });
        return { diff: `diff-${coderInputs.length}`, handoffNotes: [] };
      },
      reviewer: async () => ({
        outcome: 'ship-it',
        objections: [],
        notes: 'unsupported outcome should never pass a gate',
      } as unknown as ReviewerVerdict),
    });

    const ev = await runTeamTaskWorkflow(codeTask, { ...INPUT, cap: 2 }, deps);

    expect(ev.outcome).toBe('failed');
    expect(ev.loopExitReason).toBe('operational');
    expect(ev.objectionOpen).toBe(false);
    expect(ev.failureReason).toMatch(/operational|unknown outcome|unsupported outcome/i);
    expect(ev).not.toHaveProperty('blockedReason');
    expect(ev.reviewerVerdict?.outcome).toBe('fail');
    expect(coderInputs).toHaveLength(1);
    expect(coderInputs[0]?.rejectionFeedback).toBeUndefined();
  });

  it('fails closed on an unsupported reviewer outcome without public block residue or a blocked task outcome', async () => {
    const ev = await runTeamTaskWorkflow(
      codeTask,
      { ...INPUT, cap: 1 },
      makeDeps({
        reviewer: async () => ({
          outcome: 'retired-block',
          findings: [],
          notes: 'unsupported outcome residue',
        } as unknown as ReviewerVerdict),
      }),
    );

    expect(ev.outcome).toBe('failed');
    expect(ev.loopExitReason).toBe('operational');
    expect(ev.failureReason).toMatch(/unsupported outcome/i);
    expect(ev).not.toHaveProperty('blockedReason');
    expect(ev.reviewerVerdict?.outcome).toBe('fail');
    expect(ev.gateVerdicts?.reviewer?.outcome).toBe('fail');
    expect(ev.reviewerVerdict?.outcome).not.toBe('block');
    expect(ev.gateVerdicts?.reviewer?.outcome).not.toBe('block');
    expect(REVIEW_OUTCOMES).toContain(
      ev.reviewerVerdict?.outcome as (typeof REVIEW_OUTCOMES)[number],
    );
    expect(REVIEW_OUTCOMES).toContain(
      ev.gateVerdicts?.reviewer?.outcome as (typeof REVIEW_OUTCOMES)[number],
    );
  });

  function objectionWithSeverity(severity: ObjectionSeverity): ObjectionFinding {
    return {
      class: 'security',
      severity,
      location: `src/x.ts:${severity.length}`,
      rationale: `${severity} severity finding`,
    };
  }

  it('maps objection severity to reviewer outcomes: critical/high/medium fail, low passes with warnings', async () => {
    const cases: Array<{
      severity: ObjectionSeverity;
      expectedOutcome: ReviewerOutcome;
      expectedWorkflowOutcome: 'ready-for-closeout' | 'blocked';
      expectedObjectionOpen: boolean;
    }> = [
      {
        severity: 'critical',
        expectedOutcome: 'fail',
        expectedWorkflowOutcome: 'ready-for-closeout',
        expectedObjectionOpen: false,
      },
      {
        severity: 'high',
        expectedOutcome: 'fail',
        expectedWorkflowOutcome: 'ready-for-closeout',
        expectedObjectionOpen: false,
      },
      {
        severity: 'medium',
        expectedOutcome: 'fail',
        expectedWorkflowOutcome: 'ready-for-closeout',
        expectedObjectionOpen: false,
      },
      {
        severity: 'low',
        expectedOutcome: 'pass-with-warnings',
        expectedWorkflowOutcome: 'ready-for-closeout',
        expectedObjectionOpen: false,
      },
    ];

    for (const c of cases) {
      const ev = await runTeamTaskWorkflow(
        codeTask,
        { ...INPUT, cap: 1 },
        makeDeps({
          reviewer: async () => ({
            objections: [objectionWithSeverity(c.severity)],
          }),
        }),
      );

      expect(ev.reviewerVerdict?.outcome, c.severity).toBe(c.expectedOutcome);
      expect(ev.outcome, c.severity).toBe(c.expectedWorkflowOutcome);
      expect(ev.objectionOpen, c.severity).toBe(c.expectedObjectionOpen);
      expect(ev.reviewerVerdict?.outcome, c.severity).not.toBe('block');
    }
  });

  it('resolves multiple objection severities to the strictest mapped outcome', async () => {
    const cases: Array<{
      name: string;
      severities: ObjectionSeverity[];
      expectedOutcome: ReviewerOutcome;
      expectedWorkflowOutcome: 'ready-for-closeout' | 'blocked';
      expectedObjectionOpen: boolean;
    }> = [
      {
        name: 'low + medium',
        severities: ['low', 'medium'],
        expectedOutcome: 'fail',
        expectedWorkflowOutcome: 'ready-for-closeout',
        expectedObjectionOpen: false,
      },
      {
        name: 'low + critical',
        severities: ['low', 'critical'],
        expectedOutcome: 'fail',
        expectedWorkflowOutcome: 'ready-for-closeout',
        expectedObjectionOpen: false,
      },
    ];

    for (const c of cases) {
      const ev = await runTeamTaskWorkflow(
        codeTask,
        { ...INPUT, cap: 1 },
        makeDeps({
          reviewer: async () => ({
            objections: c.severities.map(objectionWithSeverity),
          }),
        }),
      );

      expect(ev.reviewerVerdict?.outcome, c.name).toBe(c.expectedOutcome);
      expect(ev.outcome, c.name).toBe(c.expectedWorkflowOutcome);
      expect(ev.objectionOpen, c.name).toBe(c.expectedObjectionOpen);
    }
  });

  it('does not let a low-severity finding enter the correction path', async () => {
    const coderInputs: Array<{ rejectionFeedback?: GateRejectionFeedback[] }> = [];
    let reviewerCalls = 0;
    let pmCalled = false;
    const lowFinding = objectionWithSeverity('low');
    const ev = await runTeamTaskWorkflow(
      codeTask,
      { ...INPUT, cap: 1 },
      makeDeps({
        coder: async (input) => {
          coderInputs.push(input as { rejectionFeedback?: GateRejectionFeedback[] });
          return { diff: `diff-${coderInputs.length}`, handoffNotes: [] };
        },
        reviewer: async () => {
          reviewerCalls += 1;
          return {
            outcome: 'pass-with-warnings',
            findings: [lowFinding],
            notes: 'reviewer raised a low-severity follow-up',
          } as unknown as ReviewerVerdict;
        },
      }),
    );

    expect(ev.outcome).toBe('ready-for-closeout');
    expect(ev.reviewerVerdict?.outcome).toBe('pass-with-warnings');
    expect(ev.reviewerVerdict?.findings).toEqual([lowFinding]);
    expect(ev.objectionOpen).toBe(false);
    expect(coderInputs).toHaveLength(1);
    expect(coderInputs[0]?.rejectionFeedback).toBeUndefined();
    expect(reviewerCalls).toBe(1);
    expect(pmCalled).toBe(false);
  });

  it('does not let a medium-severity finding consume a dedicated block-correction round', async () => {
    const coderInputs: Array<{ rejectionFeedback?: GateRejectionFeedback[] }> = [];
    let pmCalled = false;
    const mediumFinding = objectionWithSeverity('medium');
    const ev = await runTeamTaskWorkflow(
      codeTask,
      { ...INPUT, cap: 1 },
      makeDeps({
        coder: async (input) => {
          coderInputs.push(input as { rejectionFeedback?: GateRejectionFeedback[] });
          return { diff: `diff-${coderInputs.length}`, handoffNotes: [] };
        },
        reviewer: async () => ({
          outcome: 'fail',
          findings: [mediumFinding],
          notes: 'reviewer raised a medium-severity fixable finding',
        } as unknown as ReviewerVerdict),
      }),
    );

    expect(ev.reviewerVerdict?.outcome).toBe('fail');
    expect(ev.reviewerVerdict?.findings).toEqual([mediumFinding]);
    expect(ev.objectionOpen).toBe(false);
    expect(coderInputs).toHaveLength(1);
    expect(coderInputs[0]?.rejectionFeedback).toBeUndefined();
    expect(pmCalled).toBe(false);
    expect(ev.rolesInvoked).not.toContain('pm');
    expect(ev).not.toHaveProperty('acceptance');
  });

  it('fails safe to operational failed evidence when reviewer severity is malformed, without spending a coder correction round', async () => {
    const coderInputs: Array<{ rejectionFeedback?: GateRejectionFeedback[] }> = [];
    const malformedFinding = {
      class: 'security',
      severity: 'severe',
      location: 'src/auth.ts:42',
      rationale: 'severity was not one of the supported outcome-gating values',
    } as unknown as ObjectionFinding;
    const deps = makeDeps({
      coder: async (input) => {
        coderInputs.push(input as { rejectionFeedback?: GateRejectionFeedback[] });
        return { diff: `diff-${coderInputs.length}`, handoffNotes: [] };
      },
      reviewer: async () => ({
        objections: [malformedFinding],
      }),
    });

    const ev = await runTeamTaskWorkflow(codeTask, { ...INPUT, cap: 2 }, deps);

    expect(ev.outcome).toBe('failed');
    expect(ev.loopExitReason).toBe('operational');
    expect(ev.objectionOpen).toBe(false);
    expect(ev.failureReason).toMatch(/operational|malformed severity/i);
    expect(ev).not.toHaveProperty('blockedReason');
    expect(ev.rejectionFeedback).toMatchObject({
      rejectingRole: 'reviewer',
      rejectedRole: 'coder',
      rejectedArtifact: 'reviewer-verdict',
      reason: expect.stringMatching(/malformed severity|unsupported severity/i),
    });
    expect(ev.reviewerVerdict?.outcome).toBe('fail');
    expect(coderInputs).toHaveLength(1);
    expect(coderInputs[0]?.rejectionFeedback).toBeUndefined();
  });

  it('normalizes a reviewer-produced high finding to fail without a block-correction round', async () => {
    const coderInputs: Array<{ rejectionFeedback?: GateRejectionFeedback[] }> = [];
    const reviewerObjection: ObjectionFinding = {
      class: 'security',
      severity: 'high',
      location: 'src/auth.ts:42',
      rationale: 'token comparison leaks timing information',
    };
    let reviewerCalls = 0;
    let pmCalled = false;
    const deps = makeDeps({
      coder: async (input) => {
        coderInputs.push(input as { rejectionFeedback?: GateRejectionFeedback[] });
        return { diff: `diff-${coderInputs.length}`, handoffNotes: [] };
      },
      reviewer: async () => {
        reviewerCalls += 1;
        return {
          outcome: 'fail',
          objections: [reviewerObjection],
          notes: `security finding still open after review ${reviewerCalls}`,
        };
      },
    });

    const ev = await runTeamTaskWorkflow(codeTask, { ...INPUT, cap: 1 }, deps);

    expect(ev.objectionOpen).toBe(false);
    expect(ev.reviewerVerdict?.outcome).toBe('fail');
    expect(pmCalled).toBe(false);
    expect(ev.rolesInvoked).not.toContain('pm');
    expect(ev).not.toHaveProperty('acceptance');
    expect(reviewerCalls).toBe(1);
    expect(coderInputs).toHaveLength(1);
    expect(coderInputs[0]?.rejectionFeedback).toBeUndefined();
  });

  it('does not use PM accept-with-rationale to resume a non-objection fail', async () => {
    let pmCalled = false;
    const ev = await runTeamTaskWorkflow(
      codeTask,
      { ...INPUT, cap: 1 },
      makeDeps({
        reviewer: async () => ({
          outcome: 'fail',
          objections: [],
          notes: 'copy polish remains outside the hard task contract',
        }),
      }),
    );

    expect(pmCalled).toBe(false);
    expect(ev.rolesInvoked).not.toContain('pm');
    expect(ev).not.toHaveProperty('acceptance');
    expect(ev.objectionOpen).toBe(false);
  });

  it('does not route a severity-derived high fail through accept-with-rationale override', async () => {
    const coderInputs: Array<{ rejectionFeedback?: GateRejectionFeedback[] }> = [];
    const overrideInputs: unknown[] = [];
    const blockingFinding: ObjectionFinding = {
      class: 'security',
      severity: 'high',
      location: 'src/internal-route.ts:27',
      rationale: 'internal route lacks the final allow-list guard',
    };
    let pmCalled = false;
    const deps = makeDeps({
      coder: async (input) => {
        coderInputs.push(input as { rejectionFeedback?: GateRejectionFeedback[] });
        return { diff: `diff-${coderInputs.length}`, handoffNotes: [] };
      },
      reviewer: async () => ({
        outcome: 'fail',
        findings: [blockingFinding],
        notes: 'security finding remains open',
      }),
      ...({
        acceptWithRationale: async (input: unknown) => {
          overrideInputs.push(input);
          return {
            accepted: true,
            actor: 'human',
            rationale: 'Human accepts this known deployment risk.',
          };
        },
      } as Partial<TeamTaskDeps>),
    });

    const ev = await runTeamTaskWorkflow(codeTask, { ...INPUT, cap: 1 }, deps);

    expect(coderInputs).toHaveLength(1);
    expect(overrideInputs).toHaveLength(0);
    expect(pmCalled).toBe(false);
    expect(ev.objectionOpen).toBe(false);
    expect(ev.reviewerVerdict?.outcome).toBe('fail');
    expect(ev.reviewerVerdict?.findings).toEqual([blockingFinding]);
    expect(ev.rolesInvoked).not.toContain('pm');
    expect(ev).not.toHaveProperty('acceptance');
  });

  it('does not invoke accept-with-rationale override for a severity-derived critical fail', async () => {
    const overrideInputs: unknown[] = [];
    const blockingFinding: ObjectionFinding = {
      class: 'data-integrity',
      severity: 'critical',
      location: 'src/state-store.ts:88',
      rationale: 'accepted write can corrupt persisted project state',
    };
    let pmCalled = false;
    const deps = makeDeps({
      reviewer: async () => ({
        outcome: 'fail',
        findings: [blockingFinding],
      }),
      ...({
        acceptWithRationale: async (input: unknown) => {
          overrideInputs.push(input);
          return {
            accepted: true,
            actor: 'human',
            rationale: '   ',
          };
        },
      } as Partial<TeamTaskDeps>),
    });

    const ev = await runTeamTaskWorkflow(codeTask, { ...INPUT, cap: 1 }, deps);

    expect(overrideInputs).toHaveLength(0);
    expect(pmCalled).toBe(false);
    expect(ev.objectionOpen).toBe(false);
    expect(ev.reviewerVerdict?.outcome).toBe('fail');
    expect(ev.rolesInvoked).not.toContain('pm');
    expect(ev).not.toHaveProperty('acceptance');
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

  it('emits the structured gate-rejection activity record at every blocking gate', async () => {
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
          rejectedArtifact: 'test-intent',
        },
      },
      {
        name: 'tech-lead implementation diff at PM-unresolved cap',
        task: codeTask,
        input: { ...INPUT, cap: 1 },
        deps: {
          techLeadReviewDiff: async () => ({
            pass: false,
            notes: 'implementation does not wire the empty-state guard',
          }),
        },
        expected: {
          rejectingRole: 'tech-lead',
          counterpartRole: 'coder',
          rejectedRole: 'coder',
          rejectedArtifact: 'implementation-diff',
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
          rejectedArtifact: 'design-review',
        },
      },
    ];

    for (const c of cases) {
      const events: WorkflowActivityEvent[] = [];
      const ev = await runTeamTaskWorkflow(
        c.task,
        {
          ...(c.input ?? INPUT),
          emit: (event: WorkflowActivityEvent) => {
            events.push(event);
          },
        },
        makeDeps(c.deps),
      );

      expect(ev.outcome, c.name).toBe('blocked');
      expectStructuredGateRejection(ev.rejectionFeedback, c.expected);
      const rejectionEvents = events.filter(
        (event) => event.data?.['event'] === 'gate-rejection',
      );
      expect(rejectionEvents, c.name).toHaveLength(1);
      expect(rejectionEvents[0]?.kind, c.name).toBe('activity');
      expect(rejectionEvents[0]?.data?.['rejection'], c.name).toEqual(ev.rejectionFeedback);
      expect(rejectionEvents[0]?.data, c.name).toMatchObject({
        gate: ev.rejectionFeedback?.rejectedArtifact,
        rejectingRole: ev.rejectionFeedback?.rejectingRole,
        rejectedRole: ev.rejectionFeedback?.rejectedRole,
        summary: ev.rejectionFeedback?.whatFailed,
      });
      expect(String(rejectionEvents[0]?.data?.['line']).trim(), c.name).not.toBe('');
    }
  });

  it('records fail-closed reviewer-independence rejection through the gate-rejection hook', async () => {
    const recorded: GateRejectionFeedback[] = [];
    const ev = await runTeamTaskWorkflow(
      codeTask,
      INPUT,
      makeDeps({
        resolveReviewerProvider: () => null,
        onGateRejection: async (feedback) => {
          recorded.push(feedback);
        },
      }),
    );

    expect(ev.outcome).toBe('blocked');
    expect(recorded).toEqual([ev.rejectionFeedback]);
    expect(recorded[0]).toMatchObject({
      rejectingRole: 'reviewer',
      counterpartRole: 'coder',
      rejectedRole: 'coder',
      rejectedArtifact: 'reviewer-verdict',
      reason: 'reviewer independence: no distinct-provider reviewer available',
    });
  });
});

// ---------------------------------------------------------------------------
// Coder diff self-review
// ---------------------------------------------------------------------------

describe('team-task-workflow — worktree coder self-review', () => {
  it('self-reviews every coder round before downstream roles consume canonical Git state', async () => {
    const order: string[] = [];
    const selfReviewInputs: CoderResult[] = [];
    const reviewerDiffs: string[] = [];
    const activities: Array<Record<string, unknown>> = [];
    let reviewerCalls = 0;
    let coderCalls = 0;

    const ev = await runTeamTaskWorkflow(
      frontEndTask,
      {
        ...INPUT,
        cap: 2,
        emit: (event) => {
          if (event.kind === 'activity' && event.data !== undefined) {
            activities.push(event.data);
          }
        },
      },
      makeCoderSelfReviewDeps({
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
          coderCalls += 1;
          return {
            diff: coderCalls === 1 ? 'diff --git a/app.ts b/app.ts\nBUGGY' : 'diff retry',
            handoffNotes: [],
          };
        },
        coderSelfReview: async ({ artifact }) => {
          order.push('coder-self-review');
          selfReviewInputs.push(artifact);
          const round = selfReviewInputs.length;
          return {
            outcome: round === 1 ? 'revised' : 'confirmed',
            notes: round === 1 ? 'Fixed the missing guard.' : 'Retry is internally consistent.',
            artifactAttempts: [{
              attempt: 1,
              status: 'parsed' as const,
              provider: 'openai' as const,
              progressCount: round,
              candidateCount: 1,
              diagnostic: 'terminal artifact parsed',
            }],
            reviewState: {
              diff: round === 1
                ? 'diff --git a/app.ts b/app.ts\nFIXED-BY-SELF-REVIEW'
                : 'diff --git a/app.ts b/app.ts\nFIXED-IN-ROUND-TWO',
              hash: `hash-${round}`,
              baseTree: '1111111111111111111111111111111111111111',
              currentTree: '2222222222222222222222222222222222222222',
              changedPaths: ['app.ts'],
            },
          };
        },
        reviewer: async ({ diff }) => {
          order.push('reviewer');
          reviewerDiffs.push(diff);
          reviewerCalls += 1;
          return reviewerCalls === 1
            ? { outcome: 'fail', objections: [], notes: 'force one coder revision round' }
            : { outcome: 'pass', objections: [] };
        },
        techLeadReviewDiff: async ({ diff }) => {
          order.push('tech-lead-diff');
          return { pass: true };
        },
        designer: async ({ diff }) => {
          order.push('designer');
          expect(diff).toContain('FIXED');
          return { pass: true };
        },
      }),
    );

    expect(ev.outcome).toBe('ready-for-closeout');
    expect(selfReviewInputs).toEqual([
      { diff: 'diff --git a/app.ts b/app.ts\nBUGGY', handoffNotes: [] },
      { diff: 'diff retry', handoffNotes: [] },
    ]);
    expect(reviewerDiffs).toEqual([
      'diff --git a/app.ts b/app.ts\nFIXED-BY-SELF-REVIEW',
      'diff --git a/app.ts b/app.ts\nFIXED-IN-ROUND-TWO',
    ]);
    expect(order).toEqual([
      'qa',
      'tl-tests',
      'coder',
      'coder-self-review',
      'reviewer',
      'tech-lead-diff',
      'designer',
      'coder',
      'coder-self-review',
      'reviewer',
      'tech-lead-diff',
      'designer',
    ]);
    expect(ev.coderSelfReviews).toEqual([
      {
        round: 1,
        outcome: 'revised',
        notes: 'Fixed the missing guard.',
        canonicalHash: 'hash-1',
        taskBaseTree: '1111111111111111111111111111111111111111',
        currentReviewTree: '2222222222222222222222222222222222222222',
        changedPaths: ['app.ts'],
        artifactAttempts: [{
          attempt: 1,
          status: 'parsed',
          provider: 'openai',
          progressCount: 1,
          candidateCount: 1,
          diagnostic: 'terminal artifact parsed',
        }],
      },
      {
        round: 2,
        outcome: 'confirmed',
        notes: 'Retry is internally consistent.',
        canonicalHash: 'hash-2',
        taskBaseTree: '1111111111111111111111111111111111111111',
        currentReviewTree: '2222222222222222222222222222222222222222',
        changedPaths: ['app.ts'],
        artifactAttempts: [{
          attempt: 1,
          status: 'parsed',
          provider: 'openai',
          progressCount: 2,
          candidateCount: 1,
          diagnostic: 'terminal artifact parsed',
        }],
      },
    ]);
    expect(activities.filter((event) => event['event'] === 'coder-self-review')).toEqual([
      expect.objectContaining({
        round: 1,
        outcome: 'revised',
        canonicalHash: 'hash-1',
        changedPaths: ['app.ts'],
        artifactAttempts: [expect.objectContaining({
          attempt: 1,
          status: 'parsed',
          progressCount: 1,
        })],
      }),
      expect.objectContaining({
        round: 2,
        outcome: 'confirmed',
        canonicalHash: 'hash-2',
        changedPaths: ['app.ts'],
        artifactAttempts: [expect.objectContaining({
          attempt: 1,
          status: 'parsed',
          progressCount: 2,
        })],
      }),
    ]);
  });

  it('gives reviewer/tech-lead/designer the revised self-reviewed diff, not the pre-self-review one', async () => {
    const order: string[] = [];
    const reviewerDiffs: string[] = [];
    const techLeadDiffs: string[] = [];
    const designerDiffs: string[] = [];
    let qaWriteCalls = 0;
    let techLeadTestReviewCalls = 0;

    const ev = await runTeamTaskWorkflow(
      frontEndTask,
      { ...INPUT, cap: 1 },
      makeCoderSelfReviewDeps({
        qaWriteTests: async () => {
          order.push('qa');
          qaWriteCalls += 1;
          return { kind: 'tests-written', testIds: ['test/self-reviewed-diff.test.ts'] };
        },
        techLeadReviewTests: async () => {
          order.push('tl-tests');
          techLeadTestReviewCalls += 1;
          return { approved: true };
        },
        coder: async () => {
          order.push('coder');
          return { diff: 'diff before self-review', handoffNotes: [] };
        },
        coderSelfReview: async () => {
          order.push('coder-self-review');
          return {
            outcome: 'revised',
            notes: 'Added a behavior-preserving guard.',
            reviewState: {
              diff: 'diff after self-review with behavior-preserving guard',
              hash: 'revised-hash',
              baseTree: '1111111111111111111111111111111111111111',
              currentTree: '2222222222222222222222222222222222222222',
              changedPaths: ['src/guard.ts'],
            },
          };
        },
        reviewer: async ({ diff }) => {
          order.push('reviewer');
          reviewerDiffs.push(diff);
          return cleanVerdict;
        },
        techLeadReviewDiff: async ({ diff }) => {
          order.push('tech-lead-diff');
          techLeadDiffs.push(diff);
          return { pass: true };
        },
        designer: async ({ diff }) => {
          order.push('designer');
          designerDiffs.push(diff);
          return { pass: true };
        },
      }),
    );

    expect(ev.outcome).toBe('ready-for-closeout');
    expect(qaWriteCalls).toBe(1);
    expect(techLeadTestReviewCalls).toBe(1);
    expect(reviewerDiffs).toEqual(['diff after self-review with behavior-preserving guard']);
    expect(techLeadDiffs).toEqual(['diff after self-review with behavior-preserving guard']);
    expect(designerDiffs).toEqual(['diff after self-review with behavior-preserving guard']);
    expect(order).toEqual([
      'qa',
      'tl-tests',
      'coder',
      'coder-self-review',
      'reviewer',
      'tech-lead-diff',
      'designer',
    ]);
  });

  it('gives every judgment role the canonical diff when self-review confirms it unchanged', async () => {
    const order: string[] = [];
    const reviewerDiffs: string[] = [];
    const techLeadDiffs: string[] = [];
    const designerDiffs: string[] = [];

    const ev = await runTeamTaskWorkflow(
      frontEndTask,
      { ...INPUT, cap: 1 },
      makeCoderSelfReviewDeps({
        qaWriteTests: async () => {
          order.push('qa');
          return { kind: 'tests-written', testIds: ['test/coder-diff.test.ts'] };
        },
        techLeadReviewTests: async () => {
          order.push('tl-tests');
          return { approved: true };
        },
        coder: async () => {
          order.push('coder');
          return { diff: 'diff confirmed by self-review', handoffNotes: ['ready'] };
        },
        coderSelfReview: async ({ artifact }) => {
          order.push('coder-self-review');
          return {
            outcome: 'confirmed',
            notes: 'No changes were needed.',
            reviewState: {
              diff: artifact.diff,
              hash: 'confirmed-hash',
              baseTree: '1111111111111111111111111111111111111111',
              currentTree: '2222222222222222222222222222222222222222',
              changedPaths: ['src/coder.ts'],
            },
          };
        },
        reviewer: async ({ diff }) => {
          order.push('reviewer');
          reviewerDiffs.push(diff);
          return cleanVerdict;
        },
        techLeadReviewDiff: async ({ diff }) => {
          order.push('tech-lead-diff');
          techLeadDiffs.push(diff);
          return { pass: true };
        },
        designer: async ({ diff }) => {
          order.push('designer');
          designerDiffs.push(diff);
          return { pass: true };
        },
      }),
    );

    expect(ev.outcome).toBe('ready-for-closeout');
    expect(ev.reviewSurfaceHash).toBe('confirmed-hash');
    expect(ev.coderSelfReviews).toEqual([{
      round: 1,
      outcome: 'confirmed',
      notes: 'No changes were needed.',
      canonicalHash: 'confirmed-hash',
      taskBaseTree: '1111111111111111111111111111111111111111',
      currentReviewTree: '2222222222222222222222222222222222222222',
      changedPaths: ['src/coder.ts'],
    }]);
    expect(reviewerDiffs).toEqual(['diff confirmed by self-review']);
    expect(techLeadDiffs).toEqual(['diff confirmed by self-review']);
    expect(designerDiffs).toEqual(['diff confirmed by self-review']);
    expect(order).toEqual([
      'qa',
      'tl-tests',
      'coder',
      'coder-self-review',
      'reviewer',
      'tech-lead-diff',
      'designer',
    ]);
  });

  it('retains canonical tree/hash evidence when a judgment role rejects fail-closed', async () => {
    const evidence = await runTeamTaskWorkflow(
      codeTask,
      { ...INPUT, cap: 1 },
      makeDeps({
        techLeadReviewDiff: async () => ({
          pass: false,
          notes: 'tech-lead verdict was malformed and cannot approve the artifact.',
        }),
      }),
    );

    expect(evidence).toMatchObject({
      outcome: 'blocked',
      blockedReason: expect.stringContaining('malformed'),
      taskBaseTree: '1111111111111111111111111111111111111111',
      currentReviewTree: '2222222222222222222222222222222222222222',
      fullTaskReviewHash: 'canonical-hash',
      reviewSurfaceHash: 'canonical-hash',
    });
    expect(JSON.stringify(evidence)).not.toContain('diff --git');
  });

  // A `revised` self-review edits the worktree AFTER the coder handed off, so
  // the coder's own notes no longer describe the diff under review. The
  // self-review notes are the only channel explaining what changed — including
  // a justified test removal, which reviewer and tech lead look for in the
  // handoff notes.
  it('gives downstream roles the self-review notes as coder handoff notes when the pass revised the worktree', async () => {
    const reviewerNotes: Array<string[] | undefined> = [];
    const techLeadNotes: Array<string[] | undefined> = [];

    const ev = await runTeamTaskWorkflow(
      frontEndTask,
      { ...INPUT, cap: 1 },
      makeCoderSelfReviewDeps({
        qaWriteTests: async () => ({
          kind: 'tests-written',
          testIds: ['test/coder-diff.test.ts'],
        }),
        techLeadReviewTests: async () => ({ approved: true }),
        coder: async () => ({
          diff: 'diff before self-review',
          handoffNotes: ['implemented the guard'],
        }),
        coderSelfReview: async () => ({
          outcome: 'revised',
          notes: 'TEST-REMOVED: test/live-only.test.ts — needs a live endpoint this sandbox denies.',
          reviewState: {
            diff: 'diff after self-review',
            hash: 'revised-hash',
            baseTree: '1111111111111111111111111111111111111111',
            currentTree: '2222222222222222222222222222222222222222',
            changedPaths: ['src/coder.ts'],
          },
        }),
        reviewer: async ({ coderHandoffNotes }) => {
          reviewerNotes.push(coderHandoffNotes);
          return cleanVerdict;
        },
        techLeadReviewDiff: async ({ coderHandoffNotes }) => {
          techLeadNotes.push(coderHandoffNotes);
          return { pass: true };
        },
        designer: async () => ({ pass: true }),
      }),
    );

    expect(ev.outcome).toBe('ready-for-closeout');
    const expected = [
      'implemented the guard',
      'coder self-review (revised): TEST-REMOVED: test/live-only.test.ts — needs a live endpoint this sandbox denies.',
    ];
    expect(reviewerNotes).toEqual([expected]);
    expect(techLeadNotes).toEqual([expected]);
    expect(ev.handoffNotes).toEqual(expected);
  });

  it('leaves coder handoff notes untouched when self-review confirms the worktree unchanged', async () => {
    const reviewerNotes: Array<string[] | undefined> = [];

    await runTeamTaskWorkflow(
      frontEndTask,
      { ...INPUT, cap: 1 },
      makeCoderSelfReviewDeps({
        qaWriteTests: async () => ({
          kind: 'tests-written',
          testIds: ['test/coder-diff.test.ts'],
        }),
        techLeadReviewTests: async () => ({ approved: true }),
        coder: async () => ({
          diff: 'diff confirmed by self-review',
          handoffNotes: ['implemented the guard'],
        }),
        coderSelfReview: async ({ artifact }) => ({
          outcome: 'confirmed',
          notes: 'No changes were needed.',
          reviewState: {
            diff: artifact.diff,
            hash: 'confirmed-hash',
            baseTree: '1111111111111111111111111111111111111111',
            currentTree: '2222222222222222222222222222222222222222',
            changedPaths: ['src/coder.ts'],
          },
        }),
        reviewer: async ({ coderHandoffNotes }) => {
          reviewerNotes.push(coderHandoffNotes);
          return cleanVerdict;
        },
        techLeadReviewDiff: async () => ({ pass: true }),
        designer: async () => ({ pass: true }),
      }),
    );

    expect(reviewerNotes).toEqual([['implemented the guard']]);
  });

  it('fails the task run when coder self-review fails, before downstream diff review sees the unreviewed diff', async () => {
    let reviewerCalled = false;
    let techLeadDiffCalled = false;
    let designerCalled = false;

    const ev = await runTeamTaskWorkflow(
      frontEndTask,
      { ...INPUT, cap: 1 },
      makeCoderSelfReviewDeps({
        coder: async () => ({ diff: 'diff that still needs self-review', handoffNotes: [] }),
        coderSelfReview: async () => {
          throw new Error(
            'coder self-review failed: coder-self-review fence is malformed',
          );
        },
        reviewer: async () => {
          reviewerCalled = true;
          return cleanVerdict;
        },
        techLeadReviewDiff: async () => {
          techLeadDiffCalled = true;
          return { pass: true };
        },
        designer: async () => {
          designerCalled = true;
          return { pass: true };
        },
      }),
    );

    expect(ev.outcome).toBe('failed');
    expect(ev.failureReason).toMatch(/coder self-review failed/i);
    expect(reviewerCalled).toBe(false);
    expect(techLeadDiffCalled).toBe(false);
    expect(designerCalled).toBe(false);
  });

  it('gives only the post-self-review canonical state to every downstream review', async () => {
    const completeDiff = [
      'diff --git a/src/tracked.ts b/src/tracked.ts',
      '+tracked change',
      'diff --git a/src/new-untracked.ts b/src/new-untracked.ts',
      'new file mode 100644',
      '+untracked change',
    ].join('\n');
    const reviewerDiffs: string[] = [];
    const techLeadDiffs: string[] = [];
    const designerDiffs: string[] = [];
    const roleStates: unknown[] = [];
    const deps = makeDeps({
      coder: async () => ({ diff: 'model-returned candidate must be ignored', handoffNotes: [] }),
      coderSelfReview: async () => ({
        outcome: 'revised',
        notes: 'Canonicalized tracked and untracked edits.',
        reviewState: {
          diff: completeDiff,
          hash: 'complete-hash',
          baseTree: '1111111111111111111111111111111111111111',
          currentTree: '2222222222222222222222222222222222222222',
          changedPaths: ['src/tracked.ts', 'src/new-untracked.ts'],
        },
      }),
      reviewer: async ({ diff, reviewState, judgmentContext }) => {
        reviewerDiffs.push(diff);
        roleStates.push({
          role: 'reviewer',
          reviewState,
          artifactPass: judgmentContext?.artifactPass,
        });
        return cleanVerdict;
      },
      techLeadReviewDiff: async ({ diff, reviewState }) => {
        techLeadDiffs.push(diff);
        roleStates.push({ role: 'tech-lead', reviewState });
        return { pass: true };
      },
      designer: async ({ diff, reviewState }) => {
        designerDiffs.push(diff);
        roleStates.push({ role: 'designer', reviewState });
        return { pass: true };
      },
    });

    const evidence = await runTeamTaskWorkflow(frontEndTask, { ...INPUT, cap: 1 }, deps);

    expect(evidence.outcome).toBe('ready-for-closeout');
    expect(evidence.reviewSurfaceHash).toBe('complete-hash');
    expect(evidence).toMatchObject({
      taskBaseTree: '1111111111111111111111111111111111111111',
      currentReviewTree: '2222222222222222222222222222222222222222',
      fullTaskReviewHash: 'complete-hash',
    });
    for (const [role, diffs] of [
      ['reviewer', reviewerDiffs],
      ['tech-lead', techLeadDiffs],
      ['designer', designerDiffs],
    ] as const) {
      expect(diffs, `${role} must receive the canonical diff`).toEqual([completeDiff]);
      expect(diffs[0]).toContain('src/tracked.ts');
      expect(diffs[0]).toContain('src/new-untracked.ts');
    }
    expect(roleStates).toEqual([
      {
        role: 'reviewer',
        artifactPass: 'first-pass',
        reviewState: {
          hash: 'complete-hash',
          baseTree: '1111111111111111111111111111111111111111',
          currentTree: '2222222222222222222222222222222222222222',
          changedPaths: ['src/tracked.ts', 'src/new-untracked.ts'],
        },
      },
      expect.objectContaining({
        role: 'tech-lead',
        reviewState: expect.objectContaining({ hash: 'complete-hash' }),
      }),
      expect.objectContaining({
        role: 'designer',
        reviewState: expect.objectContaining({ hash: 'complete-hash' }),
      }),
    ]);
    expect(JSON.stringify(evidence)).not.toContain('model-returned candidate');
  });

  it('keeps an earlier-round helper in the complete artifact shown on a later coder retry', async () => {
    const secondRoundDiff = [
      'diff --git a/src/helper.ts b/src/helper.ts',
      'new file mode 100644',
      '+export const durableHelper = true;',
      'diff --git a/src/consumer.ts b/src/consumer.ts',
      '+import { durableHelper } from "./helper.js";',
    ].join('\n');
    const judgedArtifacts: Array<{ diff: string; pass?: string }> = [];
    let round = 0;
    const deps = makeDeps({
      coderSelfReview: async () => {
        round += 1;
        return {
          outcome: 'confirmed',
          notes: `Round ${round} is canonical.`,
          reviewState: {
            diff: round === 1
              ? 'diff --git a/src/helper.ts b/src/helper.ts\n+export const durableHelper = true;'
              : secondRoundDiff,
            hash: `hash-${round}`,
            baseTree: '1111111111111111111111111111111111111111',
            currentTree: round === 1
              ? '2222222222222222222222222222222222222222'
              : '3333333333333333333333333333333333333333',
            changedPaths: round === 1
              ? ['src/helper.ts']
              : ['src/helper.ts', 'src/consumer.ts'],
          },
        };
      },
      reviewer: async ({ diff, judgmentContext }) => {
        judgedArtifacts.push({ diff, pass: judgmentContext?.artifactPass });
        return round === 1
          ? { outcome: 'fail', findings: [], notes: 'wire the helper into the consumer' }
          : cleanVerdict;
      },
      techLeadReviewDiff: async () => ({ pass: true }),
    });

    const evidence = await runTeamTaskWorkflow(codeTask, { ...INPUT, cap: 2 }, deps);

    expect(evidence.outcome).toBe('ready-for-closeout');
    expect(judgedArtifacts).toHaveLength(2);
    expect(judgedArtifacts[1]).toMatchObject({ pass: 'coder-retry' });
    expect(judgedArtifacts[1]?.diff).toContain('durableHelper');
    expect(judgedArtifacts[1]?.diff).toContain('src/helper.ts');
    expect(evidence).toMatchObject({
      taskBaseTree: '1111111111111111111111111111111111111111',
      currentReviewTree: '3333333333333333333333333333333333333333',
      fullTaskReviewHash: 'hash-2',
    });
  });
});

// ---------------------------------------------------------------------------
// Round cap → bounded severity convergence, no human terminal
// ---------------------------------------------------------------------------

describe('team-task-workflow — round cap', () => {
  it('passes every open finding to the next coder round sorted by severity', async () => {
    type CoderInputWithLedger = {
      rejectionFeedback?: GateRejectionFeedback[];
      findingsLedger?: FindingsLedgerEntry[];
    };

    const coderInputs: CoderInputWithLedger[] = [];
    let reviewerCalls = 0;
    let techLeadCalls = 0;
    let designerCalls = 0;
    const reviewerFinding: ObjectionFinding = {
      class: 'outbound',
      severity: 'medium',
      location: 'src/egress.ts:27',
      rationale: 'egress allow-list misses the retry path',
      reversible: true,
    };
    const techLeadFinding: ObjectionFinding = {
      class: 'data-integrity',
      severity: 'critical',
      location: 'src/ledger.ts:12',
      rationale: 'task ledger writes can drop an accepted finding',
      reversible: true,
    };
    const designerFinding: ObjectionFinding = {
      class: 'privacy',
      severity: 'high',
      location: 'src/server/static/app.js:82',
      rationale: 'review surface exposes private branch metadata',
      reversible: true,
    };

    const ev = await runTeamTaskWorkflow(
      frontEndTask,
      { ...INPUT, cap: 2 },
      makeDeps({
        coder: async (input) => {
          coderInputs.push(input as CoderInputWithLedger);
          return { diff: `diff-${coderInputs.length}`, handoffNotes: [] };
        },
        reviewer: async () => {
          reviewerCalls += 1;
          return reviewerCalls === 1
            ? {
                outcome: 'fail',
                findings: [reviewerFinding],
                notes: 'reviewer found an above-low open finding',
              }
            : cleanVerdict;
        },
        techLeadReviewDiff: async () => {
          techLeadCalls += 1;
          return techLeadCalls === 1
            ? {
                outcome: 'fail',
                findings: [techLeadFinding],
                notes: 'tech lead found an above-low open finding',
              }
            : { pass: true };
        },
        designer: async () => {
          designerCalls += 1;
          return designerCalls === 1
            ? {
                outcome: 'fail',
                findings: [designerFinding],
                notes: 'designer found an above-low open finding',
              }
            : { pass: true };
        },
      }),
    );

    expect(ev.outcome).toBe('ready-for-closeout');
    expect(coderInputs).toHaveLength(2);
    expect(coderInputs[1]?.findingsLedger?.map((entry) => ({
      sourceGate: entry.sourceGate,
      severity: entry.severity,
      location: entry.location,
      status: entry.status,
    }))).toEqual([
      {
        sourceGate: 'tech-lead',
        severity: 'critical',
        location: 'src/ledger.ts:12',
        status: 'open',
      },
      {
        sourceGate: 'designer',
        severity: 'high',
        location: 'src/server/static/app.js:82',
        status: 'open',
      },
      {
        sourceGate: 'reviewer',
        severity: 'medium',
        location: 'src/egress.ts:27',
        status: 'open',
      },
    ]);
    expect(coderInputs[1]?.findingsLedger?.map((entry) => entry.location).sort()).toEqual(
      [
        'src/egress.ts:27',
        'src/ledger.ts:12',
        'src/server/static/app.js:82',
      ].sort(),
    );
  });

  it('keeps tech-lead diff and designer gates in the convergence loop with shared ledger context', async () => {
    type GateInputWithLedger = {
      task: SizedTask;
      diff: string;
      findingsLedger?: FindingsLedgerEntry[];
    };
    type ReviewerVerdictWithVerification = ReviewerVerdict & {
      verifiedFindings?: Array<{
        id: string;
        status: 'resolved' | 'open' | 'regressed';
        notes: string;
      }>;
    };

    const techLeadInputs: GateInputWithLedger[] = [];
    const designerInputs: GateInputWithLedger[] = [];
    let reviewerCalls = 0;
    let techLeadCalls = 0;
    let designerCalls = 0;
    const reviewerFinding: ObjectionFinding = {
      class: 'outbound',
      severity: 'medium',
      location: 'src/sync.ts:18',
      rationale: 'retry path can call the external API after cancellation',
      reversible: true,
    };
    const techLeadFinding: ObjectionFinding = {
      class: 'data-integrity',
      severity: 'high',
      location: 'src/ledger.ts:12',
      rationale: 'task ledger writes can drop an accepted finding',
      reversible: true,
    };
    const designerFinding: ObjectionFinding = {
      class: 'privacy',
      severity: 'medium',
      location: 'src/server/static/app.js:82',
      rationale: 'review surface exposes private branch metadata',
      reversible: true,
    };

    const ev = await runTeamTaskWorkflow(
      frontEndTask,
      { ...INPUT, cap: 2 },
      makeDeps({
        coder: async () => ({ diff: `diff-${reviewerCalls + 1}`, handoffNotes: [] }),
        reviewer: async (input) => {
          reviewerCalls += 1;
          if (reviewerCalls === 1) {
            return {
              outcome: 'fail',
              findings: [reviewerFinding],
              notes: 'first review found an above-low outbound finding',
            };
          }
          return {
            outcome: 'pass',
            findings: [],
            verifiedFindings: (input.findingsLedger ?? []).map((finding) => ({
              id: finding.id,
              status: 'resolved',
              notes: `reviewer verified ${finding.sourceGate} finding ${finding.id}`,
            })),
          } as ReviewerVerdictWithVerification;
        },
        techLeadReviewDiff: async (input) => {
          techLeadCalls += 1;
          techLeadInputs.push(input as GateInputWithLedger);
          return techLeadCalls === 1
            ? {
                outcome: 'fail',
                findings: [techLeadFinding],
                notes: 'tech lead found an above-low data integrity finding',
              }
            : { outcome: 'pass', findings: [], notes: 'tech lead verified prior findings' };
        },
        designer: async (input) => {
          designerCalls += 1;
          designerInputs.push(input as GateInputWithLedger);
          return designerCalls === 1
            ? {
                outcome: 'fail',
                findings: [designerFinding],
                notes: 'designer found an above-low privacy finding',
              }
            : { outcome: 'pass', findings: [], notes: 'designer verified prior findings' };
        },
      }),
    );

    expect(ev.outcome).toBe('ready-for-closeout');
    expect(techLeadInputs).toHaveLength(2);
    expect(designerInputs).toHaveLength(2);
    expect(techLeadInputs[1]?.findingsLedger?.map((entry) => ({
      sourceGate: entry.sourceGate,
      severity: entry.severity,
      location: entry.location,
      status: entry.status,
    }))).toEqual([
      {
        sourceGate: 'tech-lead',
        severity: 'high',
        location: 'src/ledger.ts:12',
        status: 'open',
      },
      {
        sourceGate: 'reviewer',
        severity: 'medium',
        location: 'src/sync.ts:18',
        status: 'open',
      },
      {
        sourceGate: 'designer',
        severity: 'medium',
        location: 'src/server/static/app.js:82',
        status: 'open',
      },
    ]);
    expect(designerInputs[1]?.findingsLedger?.map((entry) => ({
      sourceGate: entry.sourceGate,
      severity: entry.severity,
      location: entry.location,
      status: entry.status,
    }))).toEqual([
      {
        sourceGate: 'tech-lead',
        severity: 'high',
        location: 'src/ledger.ts:12',
        status: 'open',
      },
      {
        sourceGate: 'reviewer',
        severity: 'medium',
        location: 'src/sync.ts:18',
        status: 'open',
      },
      {
        sourceGate: 'designer',
        severity: 'medium',
        location: 'src/server/static/app.js:82',
        status: 'open',
      },
    ]);
    expect(ev.findingsLedger).toEqual([
      expect.objectContaining({
        sourceGate: 'reviewer',
        location: 'src/sync.ts:18',
        status: 'resolved',
      }),
      expect.objectContaining({
        sourceGate: 'tech-lead',
        location: 'src/ledger.ts:12',
        status: 'resolved',
      }),
      expect.objectContaining({
        sourceGate: 'designer',
        location: 'src/server/static/app.js:82',
        status: 'resolved',
      }),
    ]);
  });

  it('passes every open prior finding to the reviewer on re-review and requires explicit verification', async () => {
    type ReviewerInputWithLedger = Parameters<TeamTaskDeps['reviewer']>[0] & {
      findingsLedger?: FindingsLedgerEntry[];
    };
    type ReviewerVerdictWithVerification = ReviewerVerdict & {
      verifiedFindings?: Array<{
        id: string;
        status: 'resolved' | 'open' | 'regressed';
        notes: string;
      }>;
    };

    const reviewerInputs: ReviewerInputWithLedger[] = [];
    let reviewerCalls = 0;
    const firstRoundFindings: ObjectionFinding[] = [
      {
        class: 'security',
        severity: 'high',
        location: 'src/auth.ts:42',
        rationale: 'token comparison leaks timing information',
        reversible: true,
      },
      {
        class: 'outbound',
        severity: 'medium',
        location: 'src/sync.ts:18',
        rationale: 'retry path can call the external API after cancellation',
        reversible: true,
      },
    ];

    const ev = await runTeamTaskWorkflow(
      codeTask,
      { ...INPUT, cap: 2 },
      makeDeps({
        coder: async () => ({ diff: `diff-${reviewerCalls + 1}`, handoffNotes: [] }),
        reviewer: async (input) => {
          reviewerInputs.push(input as ReviewerInputWithLedger);
          reviewerCalls += 1;
          if (reviewerCalls === 1) {
            return {
              outcome: 'fail',
              findings: firstRoundFindings,
              notes: 'first pass found two above-low findings',
            };
          }

          const priorFindings = reviewerInputs[1]?.findingsLedger ?? [];
          return {
            outcome: 'pass',
            findings: [],
            verifiedFindings: priorFindings.map((finding) => ({
              id: finding.id,
              status: 'resolved',
              notes: `verified fixed: ${finding.id} at ${finding.location}`,
            })),
          } as ReviewerVerdictWithVerification;
        },
      }),
    );

    expect(reviewerInputs).toHaveLength(2);
    expect(reviewerInputs[0]?.findingsLedger).toBeUndefined();
    expect(reviewerInputs[1]?.findingsLedger?.map((entry) => ({
      sourceGate: entry.sourceGate,
      class: entry.class,
      severity: entry.severity,
      location: entry.location,
      rationale: entry.rationale,
      status: entry.status,
      raisedRound: entry.raisedRound,
    }))).toEqual([
      {
        sourceGate: 'reviewer',
        class: 'security',
        severity: 'high',
        location: 'src/auth.ts:42',
        rationale: 'token comparison leaks timing information',
        status: 'open',
        raisedRound: 1,
      },
      {
        sourceGate: 'reviewer',
        class: 'outbound',
        severity: 'medium',
        location: 'src/sync.ts:18',
        rationale: 'retry path can call the external API after cancellation',
        status: 'open',
        raisedRound: 1,
      },
    ]);
    expect(ev.outcome).toBe('ready-for-closeout');
    expect(ev.findingsLedger?.map((entry) => ({
      id: entry.id,
      status: entry.status,
    }))).toEqual(
      reviewerInputs[1]?.findingsLedger?.map((entry) => ({
        id: entry.id,
        status: 'resolved',
      })),
    );
  });

  it('uses a stable finding id to update a repeated sighting instead of appending a duplicate row', async () => {
    type ReviewerInputWithLedger = Parameters<TeamTaskDeps['reviewer']>[0] & {
      findingsLedger?: FindingsLedgerEntry[];
    };

    const reviewerInputs: ReviewerInputWithLedger[] = [];
    let reviewerCalls = 0;
    const firstSighting: ObjectionFinding = {
      class: 'security',
      severity: 'high',
      location: 'src/auth.ts:42',
      rationale: 'token comparison leaks timing information',
      reversible: true,
    };
    const repeatedSighting: ObjectionFinding = {
      class: 'security',
      severity: 'critical',
      location: 'src/auth.ts:42',
      rationale: 'timing side channel remains exploitable after the retry change',
      reversible: false,
    };

    const ev = await runTeamTaskWorkflow(
      codeTask,
      { ...INPUT, cap: 2 },
      makeDeps({
        reviewer: async (input) => {
          reviewerInputs.push(input as ReviewerInputWithLedger);
          reviewerCalls += 1;
          return {
            outcome: 'fail',
            findings: [reviewerCalls === 1 ? firstSighting : repeatedSighting],
            notes: `review pass ${reviewerCalls} still sees the same auth timing finding`,
          };
        },
      }),
    );

    const stableId = reviewerInputs[1]?.findingsLedger?.[0]?.id;
    expect(stableId).toEqual(expect.stringMatching(/^finding-/));
    expect(ev.findingsLedger).toEqual([
      expect.objectContaining({
        id: stableId,
        sourceGate: 'reviewer',
        class: 'security',
        severity: 'critical',
        location: 'src/auth.ts:42',
        rationale: 'timing side channel remains exploitable after the retry change',
        reversible: false,
        raisedRound: 1,
        status: 'open',
      }),
    ]);
    expect(ev.findingsLedger?.map((entry) => entry.id)).toEqual([stableId]);
  });

  it('does not close out when the reviewer omits explicit verification for prior open ledger findings', async () => {
    type ReviewerInputWithLedger = Parameters<TeamTaskDeps['reviewer']>[0] & {
      findingsLedger?: FindingsLedgerEntry[];
    };
    type ReviewerVerdictWithVerification = ReviewerVerdict & {
      verifiedFindings?: Array<{
        id: string;
        status: 'resolved' | 'open' | 'regressed';
        notes: string;
      }>;
    };

    const coderInputs: Array<{ findingsLedger?: FindingsLedgerEntry[] }> = [];
    const reviewerInputs: ReviewerInputWithLedger[] = [];
    let reviewerCalls = 0;
    const priorFinding: ObjectionFinding = {
      class: 'security',
      severity: 'high',
      location: 'src/auth.ts:42',
      rationale: 'token comparison leaks timing information',
      reversible: true,
    };

    const ev = await runTeamTaskWorkflow(
      codeTask,
      { ...INPUT, cap: 3 },
      makeDeps({
        coder: async (input) => {
          coderInputs.push(input as { findingsLedger?: FindingsLedgerEntry[] });
          return { diff: `diff-${coderInputs.length}`, handoffNotes: [] };
        },
        reviewer: async (input) => {
          reviewerInputs.push(input as ReviewerInputWithLedger);
          reviewerCalls += 1;
          if (reviewerCalls === 1) {
            return {
              outcome: 'fail',
              findings: [priorFinding],
              notes: 'first pass found a high-severity security finding',
            };
          }
          if (reviewerCalls === 2) {
            return {
              outcome: 'pass',
              findings: [],
              notes: 'reviewer forgot to cite the prior finding verification',
            };
          }
          return {
            outcome: 'pass',
            findings: [],
            verifiedFindings: (input.findingsLedger ?? []).map((finding) => ({
              id: finding.id,
              status: 'resolved',
              notes: `verified resolved: ${finding.id}`,
            })),
          } as ReviewerVerdictWithVerification;
        },
      }),
    );

    expect(ev.outcome).toBe('ready-for-closeout');
    expect(reviewerInputs).toHaveLength(3);
    expect(coderInputs).toHaveLength(3);
    expect(reviewerInputs[1]?.findingsLedger?.map((entry) => entry.id)).toEqual([
      reviewerInputs[2]?.findingsLedger?.[0]?.id,
    ]);
    expect(coderInputs[2]?.findingsLedger).toEqual([
      expect.objectContaining({
        sourceGate: 'reviewer',
        class: 'security',
        severity: 'high',
        location: 'src/auth.ts:42',
        rationale: 'token comparison leaks timing information',
        status: 'open',
      }),
    ]);
    expect(ev.findingsLedger).toEqual([
      expect.objectContaining({
        id: reviewerInputs[1]?.findingsLedger?.[0]?.id,
        sourceGate: 'reviewer',
        status: 'resolved',
      }),
    ]);
  });

  it('marks a previously resolved finding as regressed when it reappears with the same stable id', async () => {
    type ReviewerInputWithLedger = Parameters<TeamTaskDeps['reviewer']>[0] & {
      findingsLedger?: FindingsLedgerEntry[];
    };
    type ReviewerVerdictWithVerification = ReviewerVerdict & {
      verifiedFindings?: Array<{
        id: string;
        status: 'resolved' | 'open' | 'regressed';
        notes: string;
      }>;
    };

    const reviewerInputs: ReviewerInputWithLedger[] = [];
    let reviewerCalls = 0;
    let techLeadCalls = 0;
    let firstFindingId: string | undefined;
    const recurringFinding: ObjectionFinding = {
      class: 'security',
      severity: 'high',
      location: 'src/auth.ts:42',
      rationale: 'token comparison leaks timing information',
      reversible: true,
    };
    const bridgeFinding: ObjectionFinding = {
      class: 'data-integrity',
      severity: 'high',
      location: 'src/ledger.ts:12',
      rationale: 'task ledger writes can drop an accepted finding',
      reversible: true,
    };

    const ev = await runTeamTaskWorkflow(
      codeTask,
      { ...INPUT, cap: 3 },
      makeDeps({
        reviewer: async (input) => {
          reviewerInputs.push(input as ReviewerInputWithLedger);
          reviewerCalls += 1;
          if (reviewerCalls === 1) {
            return {
              outcome: 'fail',
              findings: [recurringFinding],
              notes: 'first pass found a high-severity security finding',
            };
          }
          if (reviewerCalls === 2) {
            firstFindingId = input.findingsLedger?.[0]?.id;
            return {
              outcome: 'pass',
              findings: [],
              verifiedFindings: (input.findingsLedger ?? []).map((finding) => ({
                id: finding.id,
                status: 'resolved',
                notes: `verified resolved: ${finding.id}`,
              })),
            } as ReviewerVerdictWithVerification;
          }
          return {
            outcome: 'fail',
            findings: [recurringFinding],
            verifiedFindings: (input.findingsLedger ?? []).map((finding) => ({
              id: finding.id,
              status: 'resolved',
              notes: `verified bridge finding resolved: ${finding.id}`,
            })),
            notes: 'the previously resolved finding regressed',
          } as ReviewerVerdictWithVerification;
        },
        techLeadReviewDiff: async () => {
          techLeadCalls += 1;
          return techLeadCalls === 2
            ? {
                outcome: 'fail',
                findings: [bridgeFinding],
                notes: 'keep the loop alive after the first finding is resolved',
              }
            : { outcome: 'pass', findings: [] };
        },
      }),
    );

    expect(firstFindingId).toEqual(expect.stringMatching(/^finding-/));
    expect(ev.loopExitReason).toBe('stagnation');
    expect(ev.findingsLedger?.filter((entry) => entry.id === firstFindingId)).toEqual([
      expect.objectContaining({
        id: firstFindingId,
        sourceGate: 'reviewer',
        class: 'security',
        severity: 'high',
        location: 'src/auth.ts:42',
        rationale: 'token comparison leaks timing information',
        status: 'regressed',
        reversible: true,
      }),
    ]);
  });

  it('primary-exits to closeout after one all-low round and records lows in the ledger', async () => {
    const coderInputs: Array<{ rejectionFeedback?: GateRejectionFeedback[] }> = [];
    let reviewerCalls = 0;
    let techLeadDiffCalls = 0;
    let designerCalls = 0;
    let pmCalled = false;
    const reviewerWarning: ObjectionFinding = {
      class: 'cost-perf',
      severity: 'low',
      location: 'src/cache.ts:44',
      rationale: 'follow-up can reduce duplicate reads; correctness is unaffected',
      reversible: true,
    };
    const techLeadWarning: ObjectionFinding = {
      class: 'concurrency',
      severity: 'low',
      location: 'src/queue.ts:61',
      rationale: 'duplicate starts can race but retry makes them harmless',
      reversible: true,
    };
    const designerWarning: ObjectionFinding = {
      class: 'cost-perf',
      severity: 'low',
      location: 'src/server/static/app.js:114',
      rationale: 'extra repaint is visible on slow devices',
      reversible: true,
    };

    const ev = await runTeamTaskWorkflow(
      frontEndTask,
      { ...INPUT, cap: 4 },
      makeDeps({
        coder: async (input) => {
          coderInputs.push(input as { rejectionFeedback?: GateRejectionFeedback[] });
          return { diff: `diff-${coderInputs.length}`, handoffNotes: [] };
        },
        reviewer: async () => {
          reviewerCalls += 1;
          return {
            outcome: 'pass-with-warnings',
            findings: [reviewerWarning],
          };
        },
        techLeadReviewDiff: async () => {
          techLeadDiffCalls += 1;
          return {
            outcome: 'pass-with-warnings',
            findings: [techLeadWarning],
          };
        },
        designer: async () => {
          designerCalls += 1;
          return {
            outcome: 'pass-with-warnings',
            findings: [designerWarning],
          };
        },
      }),
    );

    expect(ev.outcome).toBe('ready-for-closeout');
    expect(ev.loopExitReason).toBe('all-low');
    expect(ev.objectionOpen).toBe(false);
    expect(coderInputs).toHaveLength(1);
    expect(coderInputs[0]?.rejectionFeedback).toBeUndefined();
    expect(reviewerCalls).toBe(1);
    expect(techLeadDiffCalls).toBe(1);
    expect(designerCalls).toBe(1);
    expect(pmCalled).toBe(false);
    expect(ev.findingsLedger).toEqual([
      expect.objectContaining({
        sourceGate: 'reviewer',
        severity: 'low',
        location: 'src/cache.ts:44',
        status: 'open',
      }),
      expect.objectContaining({
        sourceGate: 'tech-lead',
        severity: 'low',
        location: 'src/queue.ts:61',
        status: 'open',
      }),
      expect.objectContaining({
        sourceGate: 'designer',
        severity: 'low',
        location: 'src/server/static/app.js:114',
        status: 'open',
      }),
    ]);
    expect(ev.rejectionFeedback).toBeUndefined();
  });

  it('runs coder then every review gate as one complete ordered round before starting the next coder round', async () => {
    const order: string[] = [];
    let reviewerCalls = 0;
    let techLeadCalls = 0;
    let designerCalls = 0;
    const firstRoundReviewerFinding: ObjectionFinding = {
      class: 'security',
      severity: 'medium',
      location: 'src/auth.ts:42',
      rationale: 'auth retry still bypasses the allow-list',
      reversible: true,
    };
    const firstRoundTechLeadFinding: ObjectionFinding = {
      class: 'data-integrity',
      severity: 'medium',
      location: 'src/state.ts:55',
      rationale: 'state checkpoint still misses failed-review evidence',
      reversible: true,
    };
    const firstRoundDesignerFinding: ObjectionFinding = {
      class: 'privacy',
      severity: 'medium',
      location: 'src/server/static/app.js:88',
      rationale: 'review panel still exposes private branch metadata',
      reversible: true,
    };

    const ev = await runTeamTaskWorkflow(
      frontEndTask,
      { ...INPUT, cap: 2 },
      makeDeps({
        coder: async () => {
          order.push('coder');
          return {
            diff: `diff-${order.filter((item) => item === 'coder').length}`,
            handoffNotes: [],
          };
        },
        reviewer: async () => {
          order.push('reviewer');
          reviewerCalls += 1;
          return reviewerCalls === 1
            ? { outcome: 'fail', findings: [firstRoundReviewerFinding] }
            : { outcome: 'pass', findings: [] };
        },
        techLeadReviewDiff: async () => {
          order.push('tech-lead-diff');
          techLeadCalls += 1;
          return techLeadCalls === 1
            ? { outcome: 'fail', findings: [firstRoundTechLeadFinding] }
            : { outcome: 'pass', findings: [] };
        },
        designer: async () => {
          order.push('designer');
          designerCalls += 1;
          return designerCalls === 1
            ? { outcome: 'fail', findings: [firstRoundDesignerFinding] }
            : { outcome: 'pass', findings: [] };
        },
      }),
    );

    expect(ev.outcome).toBe('ready-for-closeout');
    expect(order).toEqual([
      'coder',
      'reviewer',
      'tech-lead-diff',
      'designer',
      'coder',
      'reviewer',
      'tech-lead-diff',
      'designer',
    ]);
  });

  it('retries a structured reviewer fail with feedback threaded into the next coder round', async () => {
    const coderInputs: Array<{ rejectionFeedback?: GateRejectionFeedback[] }> = [];
    let reviewerCalls = 0;
    let pmCalled = false;
    const deps = makeDeps({
      coder: async (input) => {
        coderInputs.push(input as { rejectionFeedback?: GateRejectionFeedback[] });
        return { diff: `diff-${coderInputs.length}`, handoffNotes: [] };
      },
      reviewer: async () => {
        reviewerCalls += 1;
        return reviewerCalls === 1
          ? {
              outcome: 'fail',
              objections: [],
              notes: 'reviewer needs the empty-state branch covered before this can pass',
            }
          : { outcome: 'pass', objections: [] };
      },
    });

    const ev = await runTeamTaskWorkflow(codeTask, { ...INPUT, cap: 2 }, deps);

    expect(ev.outcome).toBe('ready-for-closeout');
    expect(pmCalled).toBe(false);
    expect(coderInputs).toHaveLength(2);
    expect(coderInputs[0]?.rejectionFeedback).toBeUndefined();
    expect(coderInputs[1]?.rejectionFeedback).toEqual([
      expect.objectContaining({
        rejectingRole: 'reviewer',
        counterpartRole: 'coder',
        rejectedRole: 'coder',
        rejectedArtifact: 'reviewer-verdict',
        reason: 'reviewer needs the empty-state branch covered before this can pass',
        actionableNotes: ['reviewer needs the empty-state branch covered before this can pass'],
      }),
    ]);
  });

  it('does not route a non-cleared structured reviewer fail to PM wrap-up at the cap', async () => {
    const coderInputs: Array<{ rejectionFeedback?: GateRejectionFeedback[] }> = [];
    let pmCalled = false;
    const deps = makeDeps({
      coder: async (input) => {
        coderInputs.push(input as { rejectionFeedback?: GateRejectionFeedback[] });
        return { diff: `diff-${coderInputs.length}`, handoffNotes: [] };
      },
      reviewer: async () => ({
        outcome: 'fail',
        objections: [],
        notes: 'reviewer still sees the contract violation after retry',
      }),
    });

    const ev = await runTeamTaskWorkflow(codeTask, { ...INPUT, cap: 2 }, deps);

    expect(pmCalled).toBe(false);
    expect(ev.rolesInvoked).not.toContain('pm');
    expect(ev).not.toHaveProperty('acceptance');
    expect(coderInputs).toHaveLength(2);
    expect(coderInputs[1]?.rejectionFeedback).toEqual([
      expect.objectContaining({
        rejectingRole: 'reviewer',
        rejectedRole: 'coder',
        rejectedArtifact: 'reviewer-verdict',
        reason: 'reviewer still sees the contract violation after retry',
      }),
    ]);
    expect(ev.rejectionFeedback).toMatchObject({
      rejectingRole: 'reviewer',
      rejectedRole: 'coder',
      rejectedArtifact: 'reviewer-verdict',
      reason: 'reviewer still sees the contract violation after retry',
    });
  });

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

  it('keeps reviewer diagnostic rationale separate from suggested coder changes', async () => {
    const coderInputs: Array<{ rejectionFeedback?: GateRejectionFeedback[] }> = [];
    let reviewerCalls = 0;
    const finding: ObjectionFinding = {
      class: 'data-integrity',
      severity: 'medium',
      location: 'src/streak.ts:42',
      rationale: 'The diff increments the streak before validating the date boundary.',
      suggestedChange: 'Move the date-boundary validation before the streak increment.',
      reversible: true,
    };
    const deps = makeDeps({
      coder: async (input) => {
        coderInputs.push(input as { rejectionFeedback?: GateRejectionFeedback[] });
        return { diff: `diff-${coderInputs.length}`, handoffNotes: [] };
      },
      reviewer: async () => {
        reviewerCalls += 1;
        return reviewerCalls === 1
          ? { outcome: 'fail', findings: [finding], notes: 'date-boundary bug' }
          : cleanVerdict;
      },
    });

    const ev = await runTeamTaskWorkflow(codeTask, INPUT, deps);

    expect(ev.outcome).toBe('ready-for-closeout');
    expect(coderInputs[1]?.rejectionFeedback).toEqual([
      expect.objectContaining({
        rejectingRole: 'reviewer',
        rejectedRole: 'coder',
        rejectedArtifact: 'reviewer-verdict',
        whatFailed:
          'data-integrity/medium at src/streak.ts:42: The diff increments the streak before validating the date boundary.',
        notes: [
          'data-integrity/medium at src/streak.ts:42: The diff increments the streak before validating the date boundary.',
        ],
        actionableNotes: ['Move the date-boundary validation before the streak increment.'],
      }),
    ]);
  });

  it('uses tech-lead diff findings and suggested changes in coder retry feedback', async () => {
    const coderInputs: Array<{ rejectionFeedback?: GateRejectionFeedback[] }> = [];
    let techLeadCalls = 0;
    const finding: ObjectionFinding = {
      class: 'concurrency',
      severity: 'medium',
      location: 'src/jobs/runner.ts:88',
      rationale: 'The run status is read and written without holding the existing lock.',
      suggestedChange: 'Wrap the status read/write in the existing run lock.',
      reversible: true,
    };
    const deps = makeDeps({
      coder: async (input) => {
        coderInputs.push(input as { rejectionFeedback?: GateRejectionFeedback[] });
        return { diff: `diff-${coderInputs.length}`, handoffNotes: [] };
      },
      techLeadReviewDiff: async () => {
        techLeadCalls += 1;
        return techLeadCalls === 1
          ? {
              outcome: 'fail',
              findings: [finding],
              notes: 'locking issue',
            }
          : { outcome: 'pass', findings: [] };
      },
    });

    const ev = await runTeamTaskWorkflow(codeTask, INPUT, deps);

    expect(ev.outcome).toBe('ready-for-closeout');
    expect(coderInputs[1]?.rejectionFeedback).toEqual([
      expect.objectContaining({
        rejectingRole: 'tech-lead',
        rejectedRole: 'coder',
        rejectedArtifact: 'implementation-diff',
        whatFailed:
          'concurrency/medium at src/jobs/runner.ts:88: The run status is read and written without holding the existing lock.',
        actionableNotes: ['Wrap the status read/write in the existing run lock.'],
      }),
    ]);
  });

  it('keeps legacy rejections without suggested changes actionable', async () => {
    const coderInputs: Array<{ rejectionFeedback?: GateRejectionFeedback[] }> = [];
    let techLeadCalls = 0;
    const deps = makeDeps({
      coder: async (input) => {
        coderInputs.push(input as { rejectionFeedback?: GateRejectionFeedback[] });
        return { diff: `diff-${coderInputs.length}`, handoffNotes: [] };
      },
      techLeadReviewDiff: async () => {
        techLeadCalls += 1;
        return techLeadCalls === 1
          ? { pass: false, notes: 'legacy note without a suggestedChange' }
          : { pass: true };
      },
    });

    const ev = await runTeamTaskWorkflow(codeTask, INPUT, deps);

    expect(ev.outcome).toBe('ready-for-closeout');
    expect(coderInputs[1]?.rejectionFeedback?.[0]).toMatchObject({
      whatFailed: 'legacy note without a suggestedChange',
      actionableNotes: ['legacy note without a suggestedChange'],
    });
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

  it('does not consult PM wrap-up for non-objection disagreement at the cap', async () => {
    let pmCalled = false;
    const deps = makeDeps({
      reviewer: async () => ({ pass: false, objections: [] }), // non-objection fail
    });
    const ev = await runTeamTaskWorkflow(codeTask, { ...INPUT, cap: 1 }, deps);
    expect(pmCalled).toBe(false);
    expect(ev.rolesInvoked).not.toContain('pm');
    expect(ev).not.toHaveProperty('acceptance');
  });

  it('does not require a PM acceptance rationale because the per-task loop must not consult PM', async () => {
    let pmCalled = false;
    const deps = makeDeps({
      reviewer: async () => ({
        outcome: 'fail',
        objections: [],
        notes: 'reviewer still wants the empty-state branch covered',
      }),
    });

    const ev = await runTeamTaskWorkflow(codeTask, { ...INPUT, cap: 1 }, deps);

    expect(pmCalled).toBe(false);
    expect(ev.rolesInvoked).not.toContain('pm');
    expect(ev).not.toHaveProperty('acceptance');
  });

  it('records terminal evidence without PM acceptance when non-objection disagreement remains at the cap', async () => {
    const events: Array<{ kind: 'activity' | 'output'; data?: Record<string, unknown> }> = [];
    const finding: ObjectionFinding = {
      class: 'outbound',
      severity: 'medium',
      location: 'src/egress.ts:27',
      rationale: 'egress allow-list is incomplete',
      reversible: true,
    };
    let pmCalled = false;
    const deps = makeDeps({
      reviewer: async () => ({
        outcome: 'fail',
        objections: [finding],
        notes: 'reviewer still wants the egress guard tightened',
      }),
    });

    const ev = await runTeamTaskWorkflow(
      codeTask,
      {
        ...INPUT,
        cap: 1,
        emit: (event) => {
          events.push(event);
        },
      },
      deps,
    );

    expect(pmCalled).toBe(false);
    expect(ev.outcome).toBe('ready-for-closeout');
    expect(ev.reviewerVerdict?.findings).toEqual([finding]);
    expect(events).toContainEqual(expect.objectContaining({
      kind: 'activity',
      data: expect.objectContaining({
        event: 'objection',
        gate: 'reviewer-verdict',
        objection: finding,
        summary: expect.stringContaining('egress allow-list is incomplete'),
      }),
    }));
    expect(ev).not.toHaveProperty('acceptance');
  });

  it('carries the terminal findings ledger and loop-exit reason on TaskEvidence', async () => {
    const terminalFinding: ObjectionFinding = {
      class: 'outbound',
      severity: 'medium',
      location: 'src/egress.ts:27',
      rationale: 'egress allow-list is incomplete',
      reversible: true,
    };
    const deps = makeDeps({
      reviewer: async () => ({
        outcome: 'fail',
        objections: [terminalFinding],
        notes: 'reviewer still wants the egress guard tightened',
      }),
    });

    const ev = await runTeamTaskWorkflow(codeTask, { ...INPUT, cap: 1 }, deps);

    expect(ev).toMatchObject({
      loopExitReason: 'hard-budget',
      findingsLedger: [
        {
          id: expect.any(String),
          sourceGate: 'reviewer',
          class: 'outbound',
          severity: 'medium',
          location: 'src/egress.ts:27',
          rationale: 'egress allow-list is incomplete',
          reversible: true,
          raisedRound: 1,
          status: 'open',
        },
      ],
    });
    expect((ev as { findingsLedger?: Array<{ id: string }> }).findingsLedger?.[0]?.id.trim())
      .not.toBe('');
  });

  it('stops on stagnation when max open severity is flat for 3 consecutive rounds before the 4-round hard budget', async () => {
    const coderInputs: Array<{ rejectionFeedback?: GateRejectionFeedback[] }> = [];
    const roundFindings: ObjectionFinding[] = [1, 2, 3, 4].map((round) => ({
      class: 'security',
      severity: 'high',
      location: `src/auth.ts:${40 + round}`,
      rationale: `round ${round} still leaves a reversible high-risk auth gap`,
      reversible: true,
    }));
    let reviewerCalls = 0;
    let pmCalled = false;

    const ev = await runTeamTaskWorkflow(
      codeTask,
      { ...INPUT, cap: 4 },
      makeDeps({
        coder: async (input) => {
          coderInputs.push(input as { rejectionFeedback?: GateRejectionFeedback[] });
          return { diff: `diff-${coderInputs.length}`, handoffNotes: [] };
        },
        reviewer: async () => {
          const finding = roundFindings[reviewerCalls];
          reviewerCalls += 1;
          return {
            outcome: 'fail',
            findings: finding === undefined ? [] : [finding],
            notes: 'reviewer still sees high severity residue',
          };
        },
      }),
    );

    expect(ev.outcome).toBe('ready-for-closeout');
    expect(ev.loopExitReason).toBe('stagnation');
    expect(ev.objectionOpen).toBe(false);
    expect(pmCalled).toBe(false);
    expect(ev.rolesInvoked).not.toContain('pm');
    expect(coderInputs).toHaveLength(3);
    expect(reviewerCalls).toBe(3);
    expect(ev.reviewerVerdict).toMatchObject({
      outcome: 'fail',
      findings: [roundFindings[2]],
    });
    expect(ev.findingsLedger?.map((entry) => ({
      severity: entry.severity,
      raisedRound: entry.raisedRound,
      status: entry.status,
    }))).toEqual([
      { severity: 'high', raisedRound: 1, status: 'open' },
      { severity: 'high', raisedRound: 2, status: 'open' },
      { severity: 'high', raisedRound: 3, status: 'open' },
    ]);
    expect(ev.blockedReason ?? '').not.toMatch(/PM|human|blocked-on-human|wrap-up/i);
  });

  it('converges when max open severity strictly drops critical to high to medium to low, ignoring the legacy outer cap', async () => {
    const coderInputs: Array<{ rejectionFeedback?: GateRejectionFeedback[] }> = [];
    const severities: ObjectionSeverity[] = ['critical', 'high', 'medium', 'low'];
    const roundFindings: ObjectionFinding[] = severities.map((severity) => ({
      class: 'security',
      severity,
      location: 'src/auth.ts:88',
      rationale: 'the same reversible auth guard finding is being reduced each round',
      reversible: true,
    }));
    let reviewerCalls = 0;
    let pmCalled = false;

    const ev = await runTeamTaskWorkflow(
      codeTask,
      { ...INPUT, cap: 2 },
      makeDeps({
        coder: async (input) => {
          coderInputs.push(input as { rejectionFeedback?: GateRejectionFeedback[] });
          return { diff: `diff-${coderInputs.length}`, handoffNotes: [] };
        },
        reviewer: async () => {
          const finding = roundFindings[reviewerCalls];
          reviewerCalls += 1;
          return {
            outcome: finding?.severity === 'low' ? 'pass-with-warnings' : 'fail',
            findings: finding === undefined ? [] : [finding],
            notes: `round ${reviewerCalls} max severity is ${finding?.severity ?? 'none'}`,
          };
        },
      }),
    );

    expect(ev.outcome).toBe('ready-for-closeout');
    expect(ev.loopExitReason).toBe('all-low');
    expect(ev.objectionOpen).toBe(false);
    expect(pmCalled).toBe(false);
    expect(ev.rolesInvoked).not.toContain('pm');
    expect(coderInputs).toHaveLength(4);
    expect(reviewerCalls).toBe(4);
    expect(coderInputs[1]?.rejectionFeedback).toEqual([
      expect.objectContaining({
        rejectingRole: 'reviewer',
        rejectedRole: 'coder',
        rejectedArtifact: 'reviewer-verdict',
        reason: expect.stringContaining('security/critical'),
      }),
    ]);
    expect(coderInputs[2]?.rejectionFeedback).toEqual([
      expect.objectContaining({
        rejectingRole: 'reviewer',
        rejectedRole: 'coder',
        rejectedArtifact: 'reviewer-verdict',
        reason: expect.stringContaining('security/high'),
      }),
    ]);
    expect(coderInputs[3]?.rejectionFeedback).toEqual([
      expect.objectContaining({
        rejectingRole: 'reviewer',
        rejectedRole: 'coder',
        rejectedArtifact: 'reviewer-verdict',
        reason: expect.stringContaining('security/medium'),
      }),
    ]);
    expect(ev.reviewerVerdict).toMatchObject({
      outcome: 'pass-with-warnings',
      findings: [roundFindings[3]],
    });
    expect(ev.findingsLedger).toEqual([
      expect.objectContaining({
        sourceGate: 'reviewer',
        class: 'security',
        severity: 'low',
        location: 'src/auth.ts:88',
        raisedRound: 1,
        status: 'open',
      }),
    ]);
    expect(ev.blockedReason ?? '').not.toMatch(/PM|human|blocked-on-human|wrap-up/i);
  });

  it('stops at the 4-round hard budget when findings are still above low and emits terminal handling evidence', async () => {
    const events: Array<{ kind: 'activity' | 'output'; data?: Record<string, unknown> }> = [];
    const coderInputs: Array<{ rejectionFeedback?: GateRejectionFeedback[] }> = [];
    const severities: ObjectionSeverity[] = ['medium', 'high', 'medium', 'critical'];
    const roundFindings: ObjectionFinding[] = severities.map((severity) => ({
      class: 'security',
      severity,
      location: 'src/auth.ts:88',
      rationale: 'the authorization guard can still be bypassed on retry',
      reversible: true,
    }));
    let reviewerCalls = 0;
    let pmCalled = false;

    const ev = await runTeamTaskWorkflow(
      codeTask,
      {
        ...INPUT,
        cap: 4,
        emit: (event) => {
          events.push(event);
        },
      },
      makeDeps({
        coder: async (input) => {
          coderInputs.push(input as { rejectionFeedback?: GateRejectionFeedback[] });
          return { diff: `diff-${coderInputs.length}`, handoffNotes: [] };
        },
        reviewer: async () => {
          const finding = roundFindings[reviewerCalls];
          reviewerCalls += 1;
          return {
            outcome: 'fail',
            findings: finding === undefined ? [] : [finding],
            notes: `round ${reviewerCalls} still leaves above-low residue`,
          };
        },
      }),
    );

    expect(ev.outcome).toBe('ready-for-closeout');
    expect(ev.loopExitReason).toBe('hard-budget');
    expect(ev.objectionOpen).toBe(false);
    expect(pmCalled).toBe(false);
    expect(ev.rolesInvoked).not.toContain('pm');
    expect(coderInputs).toHaveLength(4);
    expect(reviewerCalls).toBe(4);
    expect(coderInputs[3]?.rejectionFeedback).toEqual([
      expect.objectContaining({
        rejectingRole: 'reviewer',
        rejectedRole: 'coder',
        rejectedArtifact: 'reviewer-verdict',
        reason: expect.stringContaining('security/medium'),
      }),
    ]);
    expect(ev.reviewerVerdict).toMatchObject({
      outcome: 'fail',
      findings: [roundFindings[3]],
    });
    expect(ev.findingsLedger).toEqual([
      expect.objectContaining({
        severity: 'critical',
        raisedRound: 1,
        status: 'open',
      }),
    ]);
    expect(events).toContainEqual(expect.objectContaining({
      kind: 'activity',
      data: expect.objectContaining({
        event: 'objection',
        gate: 'reviewer-verdict',
        objection: roundFindings[3],
        summary: expect.stringContaining('critical'),
      }),
    }));
    expect(ev.blockedReason ?? '').not.toMatch(/PM|human|blocked-on-human|wrap-up/i);
  });

  it('holds when hard-budget terminal residue includes a non-reversible high or critical finding', async () => {
    for (const severity of ['high', 'critical'] satisfies ObjectionSeverity[]) {
      const events: Array<{ kind: 'activity' | 'output'; data?: Record<string, unknown> }> = [];
      const coderInputs: Array<{ rejectionFeedback?: GateRejectionFeedback[] }> = [];
      const nonReversibleFinding: ObjectionFinding = {
        class: 'data-integrity',
        severity,
        location: `src/state-store.ts:${severity === 'critical' ? 88 : 89}`,
        rationale: `accepted write can leave ${severity} persisted project-state damage after release`,
        reversible: false,
      };
      let reviewerCalls = 0;
      let pmCalled = false;

      const ev = await runTeamTaskWorkflow(
        codeTask,
        {
          ...INPUT,
          cap: 4,
          emit: (event) => {
            events.push(event);
          },
        },
        makeDeps({
          coder: async (input) => {
            coderInputs.push(input as { rejectionFeedback?: GateRejectionFeedback[] });
            return { diff: `diff-${coderInputs.length}`, handoffNotes: [] };
          },
          reviewer: async () => {
            reviewerCalls += 1;
            return {
              outcome: 'fail',
              findings: [nonReversibleFinding],
              notes: `round ${reviewerCalls} still leaves non-reversible ${severity} residue`,
            };
          },
        }),
      );

      expect(ev.outcome, severity).toBe('blocked');
      expect(ev.loopExitReason, severity).toBe('hard-budget');
      expect(ev.objectionOpen, severity).toBe(false);
      expect(pmCalled, severity).toBe(false);
      expect(ev.rolesInvoked, severity).not.toContain('pm');
      expect(coderInputs, severity).toHaveLength(4);
      expect(reviewerCalls, severity).toBe(4);
      expect(ev.blockedReason, severity).toMatch(new RegExp(`non-reversible|${severity}|hold`, 'i'));
      expect(ev.blockedReason ?? '', severity).not.toMatch(/PM|human|blocked-on-human|wrap-up/i);
      expect(ev.reviewerVerdict, severity).toMatchObject({
        outcome: 'fail',
        findings: [nonReversibleFinding],
      });
      expect(ev.findingsLedger, severity).toEqual([
        expect.objectContaining({
          sourceGate: 'reviewer',
          class: 'data-integrity',
          severity,
          location: nonReversibleFinding.location,
          rationale: nonReversibleFinding.rationale,
          reversible: false,
          raisedRound: 1,
          status: 'open',
        }),
      ]);
      expect(events, severity).toContainEqual(expect.objectContaining({
        kind: 'activity',
        data: expect.objectContaining({
          event: 'objection',
          gate: 'reviewer-verdict',
          objection: nonReversibleFinding,
          summary: expect.stringContaining(severity),
        }),
      }));
    }
  });

  it('a still-open terminal does not enter blocked-on-human or mention PM in the hold reason', async () => {
    const deps = makeDeps({
      reviewer: async () => ({ pass: false, objections: [] }),
    });
    const ev = await runTeamTaskWorkflow(codeTask, { ...INPUT, cap: 1 }, deps);
    expect(ev.rolesInvoked).not.toContain('pm');
    expect(ev.blockedReason ?? '').not.toMatch(/PM|human|blocked-on-human|wrap-up/i);
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
// Security review routing
// ---------------------------------------------------------------------------

describe('team-task-workflow — security routing', () => {
  it('invokes security review for a task explicitly flagged by planning', async () => {
    let securityCalled = false;
    const deps = makeDeps() as TeamTaskDeps & { security: TeamTaskDeps['designer'] };
    deps.security = async () => {
      securityCalled = true;
      return { pass: true };
    };

    await runTeamTaskWorkflow(securityTask, INPUT, deps);
    expect(securityCalled).toBe(true);
  });

  it('does not invoke security review for an unflagged task', async () => {
    let securityCalled = false;
    const deps = makeDeps() as TeamTaskDeps & { security: TeamTaskDeps['designer'] };
    deps.security = async () => {
      securityCalled = true;
      return { pass: true };
    };

    await runTeamTaskWorkflow(codeTask, INPUT, deps);
    expect(securityCalled).toBe(false);
  });

  it('treats a failing security review as a closeout-blocking gate', async () => {
    const deps = makeDeps() as TeamTaskDeps & { security: TeamTaskDeps['designer'] };
    deps.security = async () => ({ pass: false, notes: 'untrusted network path remains' });

    const evidence = await runTeamTaskWorkflow(securityTask, { ...INPUT, cap: 1 }, deps);
    expect(evidence.outcome).toBe('blocked');
    expect(evidence.blockedReason).toMatch(/security review/i);
  });

  it('keeps a failed security gate authoritative after non-final split adjudication', async () => {
    let adjudicatorCalls = 0;
    const deps = makeDeps({
      reviewer: async () => ({
        outcome: 'fail',
        findings: [],
        notes: 'the lease release ordering still reads wrong to me',
      }),
      techLeadReviewDiff: async () => ({ pass: true }),
      adjudicateSplit: async () => {
        adjudicatorCalls += 1;
        return {
          upholds: 'pass',
          rationale: 'the guarded release path answers the reviewer dispute',
        };
      },
    }) as TeamTaskDeps & { security: TeamTaskDeps['designer'] };
    deps.security = async () => ({
      pass: false,
      notes: 'untrusted network path remains',
    });

    const evidence = await runTeamTaskWorkflow(securityTask, { ...INPUT, cap: 3 }, deps);

    expect(adjudicatorCalls).toBe(1);
    expect(evidence.outcome).toBe('blocked');
    expect(evidence.blockedReason).toMatch(/security review/i);
  });

  it('never lets a persistently failing security gate close through stagnation', async () => {
    let securityCalls = 0;
    const deps = makeDeps() as TeamTaskDeps & { security: TeamTaskDeps['designer'] };
    deps.security = async () => {
      securityCalls += 1;
      return {
        outcome: 'fail',
        findings: [{
          class: 'security',
          severity: 'medium',
          location: 'src/security.ts:12',
          rationale: 'the execution boundary remains bypassable',
          reversible: true,
        }],
      };
    };

    const evidence = await runTeamTaskWorkflow(securityTask, { ...INPUT, cap: 4 }, deps);

    expect(evidence.outcome).toBe('blocked');
    expect(evidence.loopExitReason).toBe('hard-budget');
    expect(evidence.loopExitReason).not.toBe('stagnation');
    expect(securityCalls).toBe(4);
  });
});

describe('team-task-workflow — parallel judgment batch', () => {
  it('starts every eligible role before any result settles and shares one canonical context', async () => {
    const starts: string[] = [];
    const contexts: unknown[] = [];
    const batchIds: string[] = [];
    const releases = new Map<string, (value: unknown) => void>();
    const waitFor = <T>(role: string, input: {
      judgmentContext?: unknown;
      judgmentBatchId?: string;
    }): Promise<T> => {
      starts.push(role);
      contexts.push(input.judgmentContext);
      batchIds.push(input.judgmentBatchId ?? '');
      return new Promise<T>((resolve) => {
        releases.set(role, resolve as (value: unknown) => void);
      });
    };
    const deps = makeDeps({
      reviewer: async (input) => waitFor('reviewer', input),
      techLeadReviewDiff: async (input) => waitFor('tech-lead', input),
      designer: async (input) => waitFor('designer', input),
    });

    const pending = runTeamTaskWorkflow(frontEndTask, { ...INPUT, cap: 1 }, deps);
    await vi.waitFor(() => {
      expect(starts).toEqual(['reviewer', 'tech-lead', 'designer']);
    });
    expect(new Set(contexts).size).toBe(1);
    expect(Object.isFrozen(contexts[0])).toBe(true);
    expect(Object.isFrozen(
      (contexts[0] as { reviewState: unknown }).reviewState,
    )).toBe(true);
    expect(new Set(batchIds).size).toBe(1);
    expect(batchIds[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(contexts[0]).toMatchObject({
      spec: INPUT.spec,
      projectContext: INPUT.contextMd,
      diff: 'diff --git a/x b/x',
      artifactPass: 'first-pass',
      reviewState: { hash: 'canonical-hash' },
      coderHandoffNotes: ['wired the core'],
    });

    releases.get('designer')?.({ pass: true });
    releases.get('tech-lead')?.({ pass: true });
    releases.get('reviewer')?.(cleanVerdict);
    await expect(pending).resolves.toMatchObject({
      outcome: 'ready-for-closeout',
      judgmentOutcomes: [
        { role: 'reviewer', status: 'pass' },
        { role: 'tech-lead', status: 'pass' },
        { role: 'designer', status: 'pass' },
      ],
    });
  });

  it('deep-freezes prior-round finding entries shared with concurrent judgments', async () => {
    let round = 0;
    let secondRoundContext: unknown;
    const finding: ObjectionFinding = {
      class: 'data-integrity',
      severity: 'medium',
      location: 'src/store.ts:10',
      rationale: 'prior-round finding',
    };
    const deps = makeDeps({
      coder: async () => {
        round += 1;
        return { diff: `round ${round}`, handoffNotes: [] };
      },
      techLeadReviewDiff: async (input) => {
        if (round === 2) secondRoundContext = input.judgmentContext;
        return { pass: true };
      },
      reviewer: async (input) => round === 1
        ? { outcome: 'fail', findings: [finding] }
        : {
            outcome: 'pass',
            findings: [],
            verifiedFindings: (input.findingsLedger ?? []).map((entry) => ({
              id: entry.id,
              status: 'resolved' as const,
              notes: 'verified in the second round',
            })),
          },
    });

    await runTeamTaskWorkflow(codeTask, { ...INPUT, cap: 2 }, deps);

    const ledger = (secondRoundContext as {
      findingsLedger: ReadonlyArray<FindingsLedgerEntry>;
    }).findingsLedger;
    expect(Object.isFrozen(ledger)).toBe(true);
    expect(ledger).toHaveLength(1);
    expect(Object.isFrozen(ledger[0])).toBe(true);
  });

  it('omits designer entirely when sizing does not require it', async () => {
    const starts: string[] = [];
    const deps = makeDeps({
      reviewer: async () => {
        starts.push('reviewer');
        return cleanVerdict;
      },
      techLeadReviewDiff: async () => {
        starts.push('tech-lead');
        return { pass: true };
      },
      designer: async () => {
        starts.push('designer');
        return { pass: true };
      },
    });

    const evidence = await runTeamTaskWorkflow(codeTask, { ...INPUT, cap: 1 }, deps);

    expect(starts).toEqual(['reviewer', 'tech-lead']);
    expect(evidence.judgmentOutcomes?.map(({ role }) => role)).toEqual([
      'reviewer',
      'tech-lead',
    ]);
  });

  it('combines reviewer, tech-lead, and designer rejections in stable coder-feedback order', async () => {
    let round = 0;
    const coderFeedback: Array<GateRejectionFeedback[] | undefined> = [];
    const deps = makeDeps({
      coder: async ({ rejectionFeedback }) => {
        round += 1;
        coderFeedback.push(rejectionFeedback);
        return { diff: `diff round ${round}`, handoffNotes: [] };
      },
      reviewer: async () =>
        round === 1
          ? { outcome: 'fail', findings: [], notes: 'reviewer correction' }
          : cleanVerdict,
      techLeadReviewDiff: async () =>
        round === 1 ? { pass: false, notes: 'tech-lead correction' } : { pass: true },
      designer: async () =>
        round === 1 ? { pass: false, notes: 'designer correction' } : { pass: true },
    });

    const evidence = await runTeamTaskWorkflow(frontEndTask, { ...INPUT, cap: 2 }, deps);

    expect(evidence.outcome).toBe('ready-for-closeout');
    expect(coderFeedback[1]?.map(({ rejectingRole }) => rejectingRole)).toEqual([
      'reviewer',
      'tech-lead',
      'designer',
    ]);
  });

  // Regression for run 815bdec6, which parked on task 2 of 45. QA's boolean was
  // the ONLY thing standing between that run and closeout: the reviewer's finding
  // was reversible and sub-threshold and the tech lead passed, so the hard-budget
  // branch would have closed the task out — except all three of its gate
  // conditions were `&&`-guarded on QA's approval. With QA's diff gate removed,
  // the two structured gates decide, and the run keeps moving.
  it('closes at the hard budget on a reversible sub-threshold finding the structured gates accept', async () => {
    const reviewerFinding: ObjectionFinding = {
      class: 'concurrency',
      severity: 'medium',
      location: 'src/example.ts:1',
      rationale: 'reversible reviewer concern',
      reversible: true,
    };
    const deps = makeDeps({
      reviewer: async () => ({
        outcome: 'fail',
        findings: [reviewerFinding],
      }),
      techLeadReviewDiff: async () => ({ pass: true }),
    });

    const evidence = await runTeamTaskWorkflow(codeTask, { ...INPUT, cap: 1 }, deps);

    expect(evidence).toMatchObject({
      outcome: 'ready-for-closeout',
      loopExitReason: 'hard-budget',
      judgmentOutcomes: [
        { role: 'reviewer', status: 'reject' },
        { role: 'tech-lead', status: 'pass' },
      ],
    });
  });

  it('still holds at the hard budget for a non-reversible high finding', async () => {
    const irreversible: ObjectionFinding = {
      class: 'data-integrity',
      severity: 'high',
      location: 'src/store.ts:42',
      rationale: 'a dropped column cannot be recovered by reverting the commit',
      reversible: false,
    };
    const deps = makeDeps({
      reviewer: async () => ({ outcome: 'fail', findings: [irreversible] }),
      techLeadReviewDiff: async () => ({ pass: true }),
    });

    const evidence = await runTeamTaskWorkflow(codeTask, { ...INPUT, cap: 1 }, deps);

    expect(evidence).toMatchObject({
      outcome: 'blocked',
      loopExitReason: 'hard-budget',
      blockedReason: expect.stringContaining('non-reversible'),
    });
  });

  it('preserves the user-targeted role when induced sibling cancellations are internal', async () => {
    const requestedAt = '2026-07-29T12:00:00.000Z';
    const deps = makeDeps({
      reviewer: async () => {
        throw new RoleCancellationError('reviewer', {
          operationId: 'reviewer-operation',
          source: 'cockpit',
          requestedAt,
        });
      },
      techLeadReviewDiff: async () => {
        throw new RoleCancellationError('tech-lead', {
          operationId: 'reviewer-operation',
          source: 'internal',
          requestedAt,
        });
      },
    });

    const evidence = await runTeamTaskWorkflow(codeTask, { ...INPUT, cap: 1 }, deps);

    expect(evidence).toMatchObject({
      outcome: 'cancelled',
      cancellation: {
        role: 'reviewer',
        operationId: 'reviewer-operation',
        source: 'cockpit',
      },
    });
  });

  it('forces and bounds sibling cleanup when a cancelled judgment never settles', async () => {
    vi.useFakeTimers();
    try {
      const forceCancelJudgmentBatch = vi.fn();
      const finishJudgmentBatch = vi.fn();
      const never = new Promise<{ pass: boolean }>(() => {});
      const deps = makeDeps({
        reviewer: async () => {
          throw new Error('reviewer provider failed');
        },
        techLeadReviewDiff: async () => never,
        forceCancelJudgmentBatch,
        finishJudgmentBatch,
      });

      const pending = runTeamTaskWorkflow(codeTask, { ...INPUT, cap: 1 }, deps);
      await vi.advanceTimersByTimeAsync(
        teamTaskWorkflow.JUDGMENT_CANCEL_GRACE_MS +
        teamTaskWorkflow.JUDGMENT_FORCE_SETTLE_GRACE_MS,
      );

      await expect(pending).resolves.toMatchObject({
        outcome: 'failed',
        failureReason: 'reviewer provider failed',
        judgmentOutcomes: [
          { role: 'reviewer', status: 'failed' },
          { role: 'tech-lead', status: 'cancelled' },
        ],
      });
      expect(forceCancelJudgmentBatch).toHaveBeenCalledOnce();
      expect(finishJudgmentBatch).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the stable primary failure while awaiting internally-cancelled siblings', async () => {
    const internalCancellation = {
      operationId: 'internal-batch-member',
      source: 'internal' as const,
      requestedAt: '2026-07-29T12:00:00.000Z',
    };
    let cancelBatchCalls = 0;
    let cancelTechLead: (() => void) | undefined;
    const techLeadPending = new Promise<{ pass: boolean }>((_resolve, reject) => {
      cancelTechLead = () =>
        reject(new RoleCancellationError('tech-lead', internalCancellation));
    });
    const deps = makeDeps({
      reviewer: async () => {
        throw new Error('reviewer provider failed');
      },
      techLeadReviewDiff: async () => techLeadPending,
      cancelJudgmentBatch: () => {
        cancelBatchCalls += 1;
        cancelTechLead?.();
      },
    });

    const evidence = await runTeamTaskWorkflow(codeTask, { ...INPUT, cap: 1 }, deps);

    expect(evidence).toMatchObject({
      outcome: 'failed',
      failureReason: 'reviewer provider failed',
      judgmentOutcomes: [
        { role: 'reviewer', status: 'failed' },
        { role: 'tech-lead', status: 'cancelled' },
      ],
    });
    expect(cancelBatchCalls).toBeGreaterThan(0);
  });

  it('selects the primary operational failure by role order, not completion order', async () => {
    const deps = makeDeps({
      // The reviewer is FIRST in canonical role order but LAST to settle, so a
      // completion-ordered implementation would surface the tech lead's failure.
      reviewer: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        throw new Error('reviewer operational failure');
      },
      techLeadReviewDiff: async () => {
        throw new Error('tech-lead operational failure');
      },
    });

    const evidence = await runTeamTaskWorkflow(codeTask, { ...INPUT, cap: 1 }, deps);

    expect(evidence.outcome).toBe('failed');
    expect(evidence.failureReason).toBe('reviewer operational failure');
    expect(evidence.judgmentOutcomes).toEqual([
      { role: 'reviewer', status: 'failed', summary: 'reviewer operational failure' },
      { role: 'tech-lead', status: 'failed', summary: 'tech-lead operational failure' },
    ]);
  });

  it('produces identical findings, feedback evidence, and public events across completion orders', async () => {
    const reviewerFinding: ObjectionFinding = {
      class: 'security',
      severity: 'medium',
      location: 'src/reviewer.ts:1',
      rationale: 'reviewer finding',
    };
    const techLeadFinding: ObjectionFinding = {
      class: 'data-integrity',
      severity: 'medium',
      location: 'src/tech-lead.ts:2',
      rationale: 'tech-lead finding',
    };
    const designerFinding: ObjectionFinding = {
      class: 'cost-perf',
      severity: 'low',
      location: 'src/designer.ts:3',
      rationale: 'designer finding',
    };
    const runWithDelays = async (delays: Record<string, number>) => {
      const events: WorkflowActivityEvent[] = [];
      const pause = (role: string) =>
        new Promise((resolve) => setTimeout(resolve, delays[role] ?? 0));
      const evidence = await runTeamTaskWorkflow(
        frontEndTask,
        { ...INPUT, cap: 1, emit: (event) => events.push(event) },
        makeDeps({
          reviewer: async () => {
            await pause('reviewer');
            return { outcome: 'fail', findings: [reviewerFinding] };
          },
          techLeadReviewDiff: async () => {
            await pause('tech-lead');
            return { outcome: 'fail', findings: [techLeadFinding] };
          },
          designer: async () => {
            await pause('designer');
            return { outcome: 'pass-with-warnings', findings: [designerFinding] };
          },
        }),
      );
      return { evidence, events };
    };

    const forward = await runWithDelays({ reviewer: 2, 'tech-lead': 3, designer: 4 });
    const reverse = await runWithDelays({ reviewer: 3, 'tech-lead': 2, designer: 1 });

    expect(reverse.evidence).toEqual(forward.evidence);
    expect(reverse.events).toEqual(forward.events);
    expect(forward.evidence.findingsLedger.map(({ sourceGate }) => sourceGate)).toEqual([
      'reviewer',
      'tech-lead',
      'designer',
    ]);
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
      adjudicateSplit: async () => ({
        upholds: 'fail',
        rationale: 'the requested assertion remains necessary',
        finding: {
          class: 'concurrency',
          severity: 'medium',
          location: 'src/example.ts:12',
          rationale: 'the untested branch returns the wrong state after a retry',
          reversible: true,
        },
      }),
    });

    await runTeamTaskWorkflow(frontEndTask, inputWithEmitter, deps);

    const transitions = events.filter(
      (event) => event.data?.['event'] === 'role-stage',
    );
    const observedStages = transitions.map((event) => ({
      role: event.data?.['role'],
      stage: event.data?.['stage'],
    }));

    expect(observedStages).toEqual([
      { role: 'qa', stage: 'test' },
      { role: 'tech-lead', stage: 'test-review' },
      { role: 'coder', stage: 'implementation' },
      { role: 'coder', stage: 'self-review' },
      { role: 'reviewer', stage: 'review' },
      { role: 'tech-lead', stage: 'diff-review' },
      { role: 'designer', stage: 'design' },
      // The reviewer failed while the tech lead and designer passed — a split,
      // at cap 1, so the wired tie-breaker is dispatched.
      { role: 'adjudicator', stage: 'split-adjudication' },
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
      adjudicateSplit: async () => ({
        upholds: 'fail',
        rationale: 'the requested assertion remains necessary',
        finding: {
          class: 'concurrency',
          severity: 'medium',
          location: 'src/example.ts:12',
          rationale: 'the untested branch returns the wrong state after a retry',
          reversible: true,
        },
      }),
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
      'tech-lead',
      'designer',
    ]);
    expect(transitions.map((event) => event.data?.['transition'])).toEqual([
      'qa-tests',
      'tech-lead-test-review',
      'coder-implementation',
      'reviewer-review',
      'tech-lead-diff-review',
      'designer-review',
    ]);
    expect(transitions.map((event) => event.data?.['fromRole'])).toEqual([
      undefined,
      'qa',
      'tech-lead',
      'coder',
      'reviewer',
      'tech-lead',
    ]);
    expect(transitions.every((event) => event.kind === 'activity')).toBe(true);
    expect(transitions.every((event) => String(event.data?.['label']).trim().length > 0)).toBe(true);
    expect(transitions.every((event) => String(event.data?.['line']).trim().length > 0)).toBe(true);
  });

  it('emits role-verdict events summarizing reviewer, tech-lead, and designer gates without PM wrap-up', async () => {
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
      adjudicateSplit: async () => ({
        upholds: 'fail',
        rationale: 'the requested assertion remains necessary',
        finding: {
          class: 'concurrency',
          severity: 'medium',
          location: 'src/example.ts:12',
          rationale: 'the untested branch returns the wrong state after a retry',
          reversible: true,
        },
      }),
    });

    await runTeamTaskWorkflow(frontEndTask, inputWithEmitter, deps);

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
      // Split at the cap with an adjudicator that upholds the failure.
      { role: 'adjudicator', verdict: 'fail', gate: 'implementation-diff' },
    ]);
    expect(verdicts.at(-1)?.data?.['summary']).toContain('requested assertion remains necessary');
    expect(verdicts.every((event) => String(event.data?.['summary']).trim().length > 0)).toBe(true);
    expect(verdicts.every((event) => String(event.data?.['line']).trim().length > 0)).toBe(true);
  });

  it('emits a failing reviewer verdict for severity findings without opening a human block', async () => {
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
    });

    const ev = await runTeamTaskWorkflow(codeTask, inputWithEmitter, deps);

    expect(ev.outcome).toBe('ready-for-closeout');
    expect(ev.reviewerVerdict?.outcome).toBe('fail');
    expect(ev.objectionOpen).toBe(false);
    const reviewerVerdictIndex = events.findIndex(
      (event) =>
        event.data?.['event'] === 'role-verdict' &&
        event.data?.['role'] === 'reviewer' &&
        event.data?.['verdict'] === 'fail',
    );
    expect(reviewerVerdictIndex).toBeGreaterThanOrEqual(0);
    expect(events[reviewerVerdictIndex]?.data).toMatchObject({
      role: 'reviewer',
      gate: 'reviewer-verdict',
      verdict: 'fail',
    });
    expect(String(events[reviewerVerdictIndex]?.data?.['summary'])).toContain('security/high');
    expect(String(events[reviewerVerdictIndex]?.data?.['summary'])).toContain('src/auth.ts:42');
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
