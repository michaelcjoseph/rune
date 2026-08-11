import { describe, expect, it, vi } from 'vitest';

import {
  RoleCancellationError,
  runTeamTaskWorkflow,
  type CoderResult,
  type GateReviewVerdict,
  type ReviewerVerdict,
  type TeamTaskDeps,
} from './team-task-workflow.js';
import type { SizedTask } from './planning-roles.js';
import { buildInvariantChecklistEvidence } from './invariant-review.js';
import { parseReviewBatchState, type ReviewBatchState } from './review-batch-state.js';

const CODE_TASK: SizedTask = {
  id: 'quorum-core',
  text: 'Keep independent reviews alive after a transport failure',
  testStrategy: 'code-tests-required',
  designerNeeded: false,
  roles: ['qa', 'coder', 'reviewer', 'tech-lead'],
};

const DESIGN_TASK: SizedTask = {
  ...CODE_TASK,
  id: 'quorum-design',
  designerNeeded: true,
  roles: ['qa', 'coder', 'reviewer', 'tech-lead', 'designer'],
};

const SECURITY_TASK: SizedTask = {
  ...CODE_TASK,
  id: 'quorum-security',
  securityNeeded: true,
  roles: ['qa', 'coder', 'reviewer', 'tech-lead', 'security'],
};

const INPUT = {
  spec: 'One independent non-blocking review satisfies quorum.',
  contextMd: '## Current State\n\nPost-coder review is ready.',
  coderProvider: 'anthropic' as const,
  cap: 1,
};

const PASS: ReviewerVerdict = { outcome: 'pass', findings: [] };
const invariantDraft = {
  items: [{
    id: 'D1' as const,
    category: 'ownership-and-containment' as const,
    invariant: 'Keep changes inside the reviewed tree.',
    evidence: [{ path: 'src/intent/team-task-workflow.ts', anchor: 'runTeamTaskWorkflow' }],
  }],
};
const invariantChecklist = buildInvariantChecklistEvidence([{
  ...invariantDraft.items[0]!,
  id: 'I1',
  draftIds: ['D1'],
}]);

function deps(over: Partial<TeamTaskDeps> = {}): TeamTaskDeps {
  const artifact: CoderResult = {
    diff: 'diff --git a/src/review.ts b/src/review.ts',
    handoffNotes: ['review wave ready'],
  };
  return {
    techLeadDraftInvariants: async () => invariantDraft,
    securityRatifyInvariants: async () => invariantChecklist,
    qaWriteTests: async () => ({ kind: 'tests-written', testIds: ['quorum-contract'] }),
    techLeadReviewTests: async () => ({ approved: true }),
    coder: async () => artifact,
    coderSelfReview: async () => ({
      outcome: 'confirmed',
      notes: 'canonical review surface captured',
      reviewState: {
        diff: artifact.diff,
        hash: 'canonical-review-hash',
        baseTree: '1111111111111111111111111111111111111111',
        currentTree: '2222222222222222222222222222222222222222',
        changedPaths: ['src/review.ts'],
      },
    }),
    reviewer: async () => PASS,
    techLeadReviewDiff: async () => ({ outcome: 'pass', findings: [] }),
    designer: async () => ({ outcome: 'pass', findings: [] }),
    security: async () => ({ outcome: 'pass', findings: [] }),
    resolveReviewerProvider: () => 'openai',
    ...over,
  };
}

function quorumEvidence(value: unknown): Record<string, unknown> | undefined {
  return (value as { reviewQuorum?: Record<string, unknown> }).reviewQuorum;
}

function resumableBatch(
  reviewerStatus: 'verdict' | 'running' = 'verdict',
): ReviewBatchState {
  const running = reviewerStatus === 'running';
  return {
    version: 1,
    batchId: 'durable-review-batch',
    taskId: CODE_TASK.id,
    taskBaseTree: '1111111111111111111111111111111111111111',
    currentReviewTree: '2222222222222222222222222222222222222222',
    canonicalHash: 'canonical-review-hash',
    round: 1,
    workflowAttempt: 1,
    createdAt: '2026-08-10T12:00:00.000Z',
    updatedAt: '2026-08-10T12:01:00.000Z',
    quorum: { status: 'pending' },
    roles: [{
      role: 'reviewer',
      quorumEligible: true,
      required: false,
      status: reviewerStatus,
      attemptsConsumed: 1,
      retryEligible: running,
      attempts: [{
        attemptId: 'reviewer-1',
        attempt: 1,
        status: reviewerStatus,
        startedAt: '2026-08-10T12:00:00.000Z',
        ...(running ? {} : {
          endedAt: '2026-08-10T12:00:30.000Z',
          durationMs: 30_000,
          verdict: { outcome: 'pass', findingCount: 0 },
        }),
        model: 'reviewer-base',
        provider: 'openai',
        retryEligible: running,
      }],
    }, {
      role: 'tech-lead',
      quorumEligible: true,
      required: false,
      status: 'pending',
      attemptsConsumed: 0,
      retryEligible: true,
      attempts: [],
    }],
    resumeContext: {
      artifactPass: 'first-pass',
      tests: ['quorum-contract'],
      qa: { kind: 'tests-written', testIds: ['quorum-contract'] },
      coderHandoffNotes: ['review wave ready'],
      coderSelfReviews: [{
        round: 1,
        outcome: 'confirmed',
        notes: 'canonical review surface captured',
        canonicalHash: 'canonical-review-hash',
        taskBaseTree: '1111111111111111111111111111111111111111',
        currentReviewTree: '2222222222222222222222222222222222222222',
        changedPaths: ['src/review.ts'],
      }],
    },
  };
}

describe('team-task-workflow review quorum', () => {
  it('continues after reviewer transport failure when the tech lead supplies quorum', async () => {
    const evidence = await runTeamTaskWorkflow(CODE_TASK, INPUT, deps({
      reviewer: async () => {
        throw new Error('reviewer transport aborted_streaming');
      },
      techLeadReviewDiff: async () => ({ outcome: 'pass', findings: [] }),
    }));

    expect(evidence.outcome).toBe('ready-for-closeout');
    expect(quorumEvidence(evidence)).toMatchObject({
      status: 'satisfied',
      satisfyingRole: 'tech-lead',
    });
    expect(evidence.judgmentOutcomes).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'reviewer', status: 'failed' }),
      expect.objectContaining({ role: 'tech-lead', status: 'pass' }),
    ]));
  });

  it('lets a non-reviewer quorum pass verify prior findings after reviewer transport failure', async () => {
    let reviewerCalls = 0;
    const evidence = await runTeamTaskWorkflow(CODE_TASK, {
      ...INPUT,
      cap: 2,
    }, deps({
      reviewer: async () => {
        reviewerCalls += 1;
        if (reviewerCalls === 1) {
          return {
            outcome: 'fail',
            findings: [{
              class: 'data-integrity',
              severity: 'high',
              location: 'src/review.ts:42',
              rationale: 'the first implementation can lose a committed review transition',
              reversible: true,
            }],
          };
        }
        throw new Error('reviewer transport aborted_streaming');
      },
      techLeadReviewDiff: async () => ({ outcome: 'pass', findings: [] }),
    }));

    expect(evidence).toMatchObject({
      outcome: 'ready-for-closeout',
      reviewQuorum: { status: 'satisfied', satisfyingRole: 'tech-lead' },
    });
    expect(evidence.findingsLedger).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceGate: 'reviewer', status: 'resolved' }),
    ]));
  });

  it('continues after security transport failure when reviewer already supplies quorum', async () => {
    const evidence = await runTeamTaskWorkflow(SECURITY_TASK, INPUT, deps({
      security: async () => {
        throw new Error('security provider unavailable');
      },
    }));

    expect(evidence.outcome).toBe('ready-for-closeout');
    expect(quorumEvidence(evidence)).toMatchObject({
      status: 'satisfied',
      satisfyingRole: 'reviewer',
    });
    expect(evidence.judgmentOutcomes).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'security', status: 'failed' }),
    ]));
  });

  it('waits for the required designer gate even after an eligible role satisfies quorum', async () => {
    let releaseDesigner: ((verdict: GateReviewVerdict) => void) | undefined;
    const designerPending = new Promise<GateReviewVerdict>((resolve) => {
      releaseDesigner = resolve;
    });
    let settled = false;
    const pending = runTeamTaskWorkflow(DESIGN_TASK, INPUT, deps({
      reviewer: async () => PASS,
      techLeadReviewDiff: async () => {
        throw new Error('tech-lead transport failed');
      },
      designer: async () => designerPending,
    })).then((evidence) => {
      settled = true;
      return evidence;
    });

    await vi.waitFor(() => expect(settled).toBe(false));
    releaseDesigner?.({ outcome: 'pass', findings: [] });

    await expect(pending).resolves.toMatchObject({ outcome: 'ready-for-closeout' });
  });

  it('cancels unresolved eligible siblings as soon as quorum settles while preserving the designer gate', async () => {
    let releaseDesigner: ((verdict: GateReviewVerdict) => void) | undefined;
    let releaseTechLead: ((verdict: GateReviewVerdict) => void) | undefined;
    const designerPending = new Promise<GateReviewVerdict>((resolve) => {
      releaseDesigner = resolve;
    });
    const techLeadPending = new Promise<GateReviewVerdict>((resolve) => {
      releaseTechLead = resolve;
    });
    const cancelJudgmentBatch = vi.fn((
      _batchId: string,
      reason?: string,
      roles?: string[],
    ) => {
      if (reason === 'quorum-satisfied' && roles?.includes('tech-lead')) {
        releaseTechLead?.({ outcome: 'pass', findings: [] });
      }
    });
    const workflow = runTeamTaskWorkflow(DESIGN_TASK, INPUT, deps({
      reviewer: async () => PASS,
      techLeadReviewDiff: async () => techLeadPending,
      designer: async () => designerPending,
      cancelJudgmentBatch: cancelJudgmentBatch as TeamTaskDeps['cancelJudgmentBatch'],
    }));

    let earlyCancellationError: unknown;
    try {
      await vi.waitFor(() => expect(cancelJudgmentBatch).toHaveBeenCalledWith(
        expect.any(String),
        'quorum-satisfied',
        ['tech-lead'],
      ));
    } catch (err) {
      earlyCancellationError = err;
    } finally {
      releaseTechLead?.({ outcome: 'pass', findings: [] });
      releaseDesigner?.({ outcome: 'pass', findings: [] });
      await workflow;
    }
    if (earlyCancellationError !== undefined) throw earlyCancellationError;
  });

  it('does not let a passing designer satisfy quorum when every eligible path fails', async () => {
    const evidence = await runTeamTaskWorkflow(DESIGN_TASK, INPUT, deps({
      reviewer: async () => {
        throw new Error('reviewer unavailable');
      },
      techLeadReviewDiff: async () => {
        throw new Error('tech-lead unavailable');
      },
      designer: async () => ({ outcome: 'pass', findings: [] }),
    }));

    expect(evidence.outcome).toBe('failed');
    expect(evidence).toMatchObject({
      reviewQuorumFailure: {
        category: 'review-paths-exhausted',
        failedRoles: ['reviewer', 'tech-lead'],
      },
    });
    expect(quorumEvidence(evidence)).not.toMatchObject({ status: 'satisfied' });
  });

  it('does not retry an operationally failed required designer gate', async () => {
    const designer = vi.fn(async () => {
      throw new Error('designer provider unavailable');
    });
    const evidence = await runTeamTaskWorkflow(DESIGN_TASK, INPUT, deps({ designer }));

    expect(designer).toHaveBeenCalledOnce();
    expect(evidence).toMatchObject({
      outcome: 'failed',
      reviewQuorumFailure: {
        category: 'required-designer-unavailable',
        failedRoles: ['designer'],
      },
      reviewQuorum: {
        status: 'failed',
        roles: {
          designer: {
            status: 'operational-failure',
            attemptsConsumed: 1,
            retryEligible: false,
          },
        },
      },
    });
  });

  it('gives each exhausted eligible role exactly one retry and records consumed attempts', async () => {
    let reviewerCalls = 0;
    let techLeadCalls = 0;
    const evidence = await runTeamTaskWorkflow(CODE_TASK, INPUT, deps({
      reviewer: async () => {
        reviewerCalls += 1;
        if (reviewerCalls === 1) throw new Error('reviewer first transport failure');
        return PASS;
      },
      techLeadReviewDiff: async () => {
        techLeadCalls += 1;
        if (techLeadCalls === 1) throw new Error('tech-lead first transport failure');
        return { outcome: 'pass', findings: [] };
      },
    }));

    expect(evidence.outcome).toBe('ready-for-closeout');
    expect(reviewerCalls).toBe(2);
    expect(techLeadCalls).toBe(2);
    expect(quorumEvidence(evidence)).toMatchObject({
      status: 'satisfied',
      roles: {
        reviewer: { attemptsConsumed: 2, retryEligible: false },
        'tech-lead': { attemptsConsumed: 2, retryEligible: false },
      },
    });
  });

  it('drains an already-settled hard objection before acting on a sibling pass', async () => {
    const cancellationReasons: unknown[] = [];
    const evidence = await runTeamTaskWorkflow(CODE_TASK, INPUT, deps({
      reviewer: async () => PASS,
      techLeadReviewDiff: async () => ({
        outcome: 'fail',
        findings: [{
          class: 'data-integrity',
          severity: 'high',
          location: 'src/review.ts:42',
          rationale: 'settled evidence shows an irreversible write can be lost',
          reversible: false,
        }],
      }),
      cancelJudgmentBatch: ((...args: unknown[]) => {
        cancellationReasons.push(args[1]);
      }) as TeamTaskDeps['cancelJudgmentBatch'],
    }));

    expect(evidence.outcome).toBe('blocked');
    expect(evidence.findingsLedger).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceGate: 'tech-lead', status: 'open' }),
    ]));
    expect(evidence).toMatchObject({
      reviewQuorum: { objectingRole: 'tech-lead' },
    });
    expect(cancellationReasons).not.toContain('quorum-satisfied');
  });

  it('prefers an already-settled objection over a sibling cancellation', async () => {
    const evidence = await runTeamTaskWorkflow(CODE_TASK, INPUT, deps({
      reviewer: async () => ({
        outcome: 'fail',
        findings: [{
          class: 'data-integrity',
          severity: 'high',
          location: 'src/review.ts:57',
          rationale: 'settled evidence shows an irreversible accepted write can be lost',
          reversible: false,
        }],
      }),
      techLeadReviewDiff: async () => {
        throw new RoleCancellationError('tech-lead', {
          operationId: 'shutdown-tech-lead',
          source: 'internal',
          requestedAt: '2026-08-10T10:00:00.000Z',
        });
      },
    }));

    expect(evidence).toMatchObject({
      outcome: 'blocked',
      reviewQuorum: { status: 'objected', objectingRole: 'reviewer' },
    });
    expect(evidence.findingsLedger).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceGate: 'reviewer', status: 'open' }),
    ]));
  });

  it('cancels only unresolved siblings after quorum and records quorum-satisfied distinctly', async () => {
    const cancelJudgmentBatch = vi.fn();
    const evidence = await runTeamTaskWorkflow(SECURITY_TASK, INPUT, deps({
      reviewer: async () => PASS,
      techLeadReviewDiff: async () => new Promise<GateReviewVerdict>((resolve) => {
        setTimeout(() => resolve({ outcome: 'pass', findings: [] }), 15);
      }),
      security: async () => new Promise<GateReviewVerdict>((resolve) => {
        setTimeout(() => resolve({ outcome: 'pass', findings: [] }), 15);
      }),
      cancelJudgmentBatch: cancelJudgmentBatch as TeamTaskDeps['cancelJudgmentBatch'],
    }));

    expect(evidence.outcome).toBe('ready-for-closeout');
    expect(cancelJudgmentBatch).toHaveBeenCalledWith(
      expect.any(String),
      'quorum-satisfied',
      ['tech-lead', 'security'],
    );
    expect(evidence.judgmentOutcomes).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'reviewer', status: 'pass' }),
      expect.objectContaining({ role: 'tech-lead', status: 'cancelled' }),
      expect.objectContaining({ role: 'security', status: 'cancelled' }),
    ]));
  });

  it('keeps an external user cancellation distinct from quorum cleanup', async () => {
    const requestedAt = '2026-08-10T10:00:00.000Z';
    const evidence = await runTeamTaskWorkflow(CODE_TASK, INPUT, deps({
      reviewer: async () => {
        throw new RoleCancellationError('reviewer', {
          operationId: 'user-cancelled-reviewer',
          source: 'cockpit',
          requestedAt,
        });
      },
    }));

    expect(evidence).toMatchObject({
      outcome: 'cancelled',
      cancellation: {
        source: 'cockpit',
      },
      reviewQuorum: {
        status: 'pending',
        roles: {
          reviewer: expect.objectContaining({ status: 'cancelled' }),
        },
      },
    });
    expect(evidence.judgmentOutcomes).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'reviewer', status: 'cancelled' }),
    ]));
    expect(evidence.judgmentOutcomes).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: 'reviewer',
        summary: expect.stringContaining('quorum-satisfied'),
      }),
    ]));
  });

  it('terminates the wave for a Rune-internal cancellation that was not coordinator-induced', async () => {
    const evidence = await runTeamTaskWorkflow(CODE_TASK, INPUT, deps({
      reviewer: async () => {
        throw new RoleCancellationError('reviewer', {
          operationId: 'shutdown-reviewer',
          source: 'internal',
          requestedAt: '2026-08-10T10:00:00.000Z',
        });
      },
    }));

    expect(evidence).toMatchObject({
      outcome: 'cancelled',
      cancellation: { source: 'internal' },
      reviewQuorum: { status: 'pending' },
    });
  });

  it('keeps every external-cancellation checkpoint readable as durable review state', async () => {
    const snapshots: ReviewBatchState[] = [];
    const evidence = await runTeamTaskWorkflow(CODE_TASK, INPUT, deps({
      reviewer: async () => {
        throw new RoleCancellationError('reviewer', {
          operationId: 'durable-user-cancel',
          source: 'cockpit',
          requestedAt: '2026-08-10T10:00:00.000Z',
        });
      },
      persistReviewBatch: async (state) => { snapshots.push(structuredClone(state)); },
    }));

    expect(evidence.outcome).toBe('cancelled');
    expect(snapshots.length).toBeGreaterThan(1);
    const parsed = snapshots.map(parseReviewBatchState);
    expect(
      parsed,
      JSON.stringify(snapshots[parsed.findIndex((item) => item === undefined)], null, 2),
    ).not.toContain(undefined);
  });

  it('resumes an exact-tree wave without rerunning QA, coder, self-review, or a completed review', async () => {
    const qaWriteTests = vi.fn();
    const coder = vi.fn();
    const coderSelfReview = vi.fn();
    const reviewer = vi.fn();
    const techLeadReviewDiff = vi.fn();
    const evidence = await runTeamTaskWorkflow(CODE_TASK, {
      ...INPUT,
      resumeReviewBatch: resumableBatch(),
    }, deps({
      qaWriteTests,
      coder,
      coderSelfReview,
      reviewer,
      techLeadReviewDiff,
      captureReviewStateForResume: async () => ({
        diff: 'diff --git a/src/review.ts b/src/review.ts',
        hash: 'canonical-review-hash',
        baseTree: '1111111111111111111111111111111111111111',
        currentTree: '2222222222222222222222222222222222222222',
        changedPaths: ['src/review.ts'],
      }),
    }));

    expect(evidence).toMatchObject({
      outcome: 'ready-for-closeout',
      reviewQuorum: { status: 'satisfied', satisfyingRole: 'reviewer' },
    });
    expect(qaWriteTests).not.toHaveBeenCalled();
    expect(coder).not.toHaveBeenCalled();
    expect(coderSelfReview).not.toHaveBeenCalled();
    expect(reviewer).not.toHaveBeenCalled();
    expect(techLeadReviewDiff).not.toHaveBeenCalled();
    expect(evidence.coderSelfReviews).toHaveLength(1);
  });

  it('reuses quorum-cancelled siblings on resume and continues only the required designer', async () => {
    const batch = resumableBatch();
    batch.taskId = DESIGN_TASK.id;
    batch.quorum = { status: 'satisfied', satisfyingRole: 'reviewer' };
    batch.roles[1] = {
      role: 'tech-lead',
      quorumEligible: true,
      required: false,
      status: 'cancelled',
      attemptsConsumed: 1,
      retryEligible: false,
      attempts: [{
        attemptId: 'tech-lead-cancelled-after-quorum',
        attempt: 1,
        status: 'cancelled',
        startedAt: '2026-08-10T12:00:00.000Z',
        endedAt: '2026-08-10T12:00:30.000Z',
        durationMs: 30_000,
        model: 'tech-lead-base',
        provider: 'anthropic',
        retryEligible: false,
        cancellationReason: 'quorum-satisfied',
      }],
    };
    batch.roles.push({
      role: 'designer',
      quorumEligible: false,
      required: true,
      status: 'pending',
      attemptsConsumed: 0,
      retryEligible: false,
      attempts: [],
    });
    const techLeadReviewDiff = vi.fn();
    const designer = vi.fn(async () => ({ outcome: 'pass' as const, findings: [] }));

    const evidence = await runTeamTaskWorkflow(DESIGN_TASK, {
      ...INPUT,
      resumeReviewBatch: batch,
    }, deps({
      techLeadReviewDiff,
      designer,
      captureReviewStateForResume: async () => ({
        diff: 'diff --git a/src/review.ts b/src/review.ts',
        hash: 'canonical-review-hash',
        baseTree: '1111111111111111111111111111111111111111',
        currentTree: '2222222222222222222222222222222222222222',
        changedPaths: ['src/review.ts'],
      }),
    }));

    expect(evidence.outcome).toBe('ready-for-closeout');
    expect(techLeadReviewDiff).not.toHaveBeenCalled();
    expect(designer).toHaveBeenCalledOnce();
  });

  it('converts a prior-process running attempt and launches only the remaining pending path', async () => {
    const reviewer = vi.fn();
    const techLeadReviewDiff = vi.fn(async () => ({ outcome: 'pass' as const, findings: [] }));
    const snapshots: ReviewBatchState[] = [];
    const evidence = await runTeamTaskWorkflow(CODE_TASK, {
      ...INPUT,
      resumeReviewBatch: resumableBatch('running'),
    }, deps({
      reviewer,
      techLeadReviewDiff,
      persistReviewBatch: async (state) => { snapshots.push(structuredClone(state)); },
      captureReviewStateForResume: async () => ({
        diff: 'diff --git a/src/review.ts b/src/review.ts',
        hash: 'canonical-review-hash',
        baseTree: '1111111111111111111111111111111111111111',
        currentTree: '2222222222222222222222222222222222222222',
        changedPaths: ['src/review.ts'],
      }),
    }));

    expect(evidence.outcome).toBe('ready-for-closeout');
    expect(reviewer).not.toHaveBeenCalled();
    expect(techLeadReviewDiff).toHaveBeenCalledOnce();
    expect(snapshots.some((state) => state.roles.some((role) =>
      role.role === 'reviewer' && role.attempts[0]?.failureCategory === 'interrupted'))).toBe(true);
  });

  it('freezes a resumed retry to the prior durable binding when no escalation is declared', async () => {
    const batch = resumableBatch();
    batch.roles[0] = {
      role: 'reviewer',
      quorumEligible: true,
      required: false,
      status: 'operational-failure',
      attemptsConsumed: 1,
      retryEligible: true,
      attempts: [{
        attemptId: 'reviewer-old-policy-1',
        attempt: 1,
        status: 'operational-failure',
        startedAt: '2026-08-10T12:00:00.000Z',
        endedAt: '2026-08-10T12:00:30.000Z',
        durationMs: 30_000,
        failureCategory: 'provider',
        diagnostic: 'reviewer operational failure',
        model: 'reviewer-old-policy',
        provider: 'openai',
        format: 'codex',
        retryEligible: true,
      }],
    };
    batch.roles[1] = {
      role: 'tech-lead',
      quorumEligible: true,
      required: false,
      status: 'operational-failure',
      attemptsConsumed: 2,
      retryEligible: false,
      attempts: [1, 2].map((attempt) => ({
        attemptId: `tech-lead-exhausted-${attempt}`,
        attempt,
        status: 'operational-failure' as const,
        startedAt: `2026-08-10T12:0${attempt}:00.000Z`,
        endedAt: `2026-08-10T12:0${attempt}:30.000Z`,
        durationMs: 30_000,
        failureCategory: 'provider' as const,
        diagnostic: 'tech-lead operational failure',
        model: 'tech-lead-old-policy',
        provider: 'anthropic' as const,
        format: 'claude' as const,
        retryEligible: attempt === 1,
      })),
    };
    let executedBinding: unknown;
    const snapshots: ReviewBatchState[] = [];

    const evidence = await runTeamTaskWorkflow(CODE_TASK, {
      ...INPUT,
      resumeReviewBatch: batch,
    }, deps({
      reviewer: async (input) => {
        executedBinding = input.judgmentBinding;
        return PASS;
      },
      techLeadReviewDiff: vi.fn(),
      resolveReviewRoleBinding: () => ({
        model: 'reviewer-new-policy',
        provider: 'anthropic',
        format: 'claude',
      }),
      persistReviewBatch: async (state) => { snapshots.push(structuredClone(state)); },
      captureReviewStateForResume: async () => ({
        diff: 'diff --git a/src/review.ts b/src/review.ts',
        hash: 'canonical-review-hash',
        baseTree: '1111111111111111111111111111111111111111',
        currentTree: '2222222222222222222222222222222222222222',
        changedPaths: ['src/review.ts'],
      }),
    }));

    expect(evidence.outcome).toBe('ready-for-closeout');
    expect(executedBinding).toEqual({
      model: 'reviewer-old-policy',
      provider: 'openai',
      format: 'codex',
    });
    expect(snapshots.at(-1)?.roles[0]?.attempts[1]).toMatchObject({
      model: 'reviewer-old-policy',
      provider: 'openai',
      format: 'codex',
      status: 'verdict',
    });
  });

  it('surfaces review-surface drift before replaying any role', async () => {
    const qaWriteTests = vi.fn();
    const coder = vi.fn();
    const reviewer = vi.fn();
    const evidence = await runTeamTaskWorkflow(CODE_TASK, {
      ...INPUT,
      resumeReviewBatch: resumableBatch(),
    }, deps({
      qaWriteTests,
      coder,
      reviewer,
      captureReviewStateForResume: async () => ({
        diff: 'drifted',
        hash: 'different-hash',
        baseTree: '1111111111111111111111111111111111111111',
        currentTree: '3333333333333333333333333333333333333333',
        changedPaths: ['src/review.ts'],
      }),
    }));

    expect(evidence).toMatchObject({
      outcome: 'failed',
      reviewQuorumFailure: { category: 'review-surface-drift' },
    });
    expect(qaWriteTests).not.toHaveBeenCalled();
    expect(coder).not.toHaveBeenCalled();
    expect(reviewer).not.toHaveBeenCalled();
  });

  it('does not hang when a role-settlement checkpoint write fails', async () => {
    const checkpointFailure = new Error('review verdict checkpoint unavailable');
    const workflow = runTeamTaskWorkflow(CODE_TASK, INPUT, deps({
      persistReviewBatch: async (state) => {
        if (state.roles.some((role) => role.status === 'verdict')) {
          throw checkpointFailure;
        }
      },
    }));

    const result = await Promise.race([
      workflow,
      new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 100)),
    ]);

    expect(result, 'settlement checkpoint failure left review coordinator pending').not.toBe('hung');
    expect(result).toMatchObject({
      outcome: 'failed',
      loopExitReason: 'operational',
      failureReason: expect.stringMatching(/checkpoint unavailable/i),
    });
  });

  it('does not invoke a role whose running transition was not durable, while a sibling can satisfy quorum', async () => {
    let checkpointWrites = 0;
    const reviewer = vi.fn(async () => PASS);
    const techLeadReviewDiff = vi.fn(async () => ({ outcome: 'pass' as const, findings: [] }));
    const evidence = await runTeamTaskWorkflow(CODE_TASK, INPUT, deps({
      reviewer,
      techLeadReviewDiff,
      persistReviewBatch: async () => {
        checkpointWrites += 1;
        if (checkpointWrites === 2) throw new Error('running transition unavailable');
      },
    }));

    expect(reviewer).not.toHaveBeenCalled();
    expect(techLeadReviewDiff).toHaveBeenCalledOnce();
    expect(evidence).toMatchObject({
      outcome: 'ready-for-closeout',
      reviewQuorum: {
        status: 'satisfied',
        satisfyingRole: 'tech-lead',
        roles: { reviewer: { status: 'operational-failure', failureCategory: 'checkpoint' } },
      },
    });
  });

  it('turns a terminal quorum checkpoint failure into an operational hold and still finishes the batch', async () => {
    const finishJudgmentBatch = vi.fn();
    const evidence = await runTeamTaskWorkflow(CODE_TASK, INPUT, deps({
      finishJudgmentBatch,
      persistReviewBatch: async (state) => {
        if (state.quorum.status === 'satisfied') {
          throw new Error('terminal quorum checkpoint unavailable');
        }
      },
    }));

    expect(finishJudgmentBatch).toHaveBeenCalledOnce();
    expect(evidence).toMatchObject({
      outcome: 'failed',
      loopExitReason: 'operational',
      reviewQuorum: { status: 'failed' },
      reviewQuorumFailure: {
        category: 'review-checkpoint-failure',
        diagnostic: expect.stringContaining('terminal quorum checkpoint unavailable'),
      },
    });
  });

  it('persists the evidence-contracted pass before making the quorum decision', async () => {
    const snapshots: ReviewBatchState[] = [];
    const evidence = await runTeamTaskWorkflow(CODE_TASK, INPUT, deps({
      reviewer: async () => ({
        outcome: 'fail',
        findings: [{
          class: 'data-integrity',
          severity: 'medium',
          location: '',
          rationale: 'claim lacks a concrete location and failure scenario',
        }],
      }),
      persistReviewBatch: async (state) => { snapshots.push(structuredClone(state)); },
    }));

    const terminal = snapshots.at(-1)!;
    expect(evidence.outcome).toBe('ready-for-closeout');
    expect(parseReviewBatchState(terminal), JSON.stringify(terminal, null, 2)).toBeDefined();
    expect(terminal.quorum).toEqual({ status: 'satisfied', satisfyingRole: 'reviewer' });
    expect(terminal.roles.find(({ role }) => role === 'reviewer')).toMatchObject({
      status: 'verdict',
      attempts: [expect.objectContaining({
        verdict: expect.objectContaining({ outcome: 'pass', findingCount: 0 }),
      })],
    });
  });

  it('waits for raw settled evidence finalization before cancelling or deciding', async () => {
    let releaseEvidence: (() => void) | undefined;
    const evidenceReady = new Promise<void>((resolve) => { releaseEvidence = resolve; });
    const cancelJudgmentBatch = vi.fn();
    let workflowSettled = false;
    const workflow = runTeamTaskWorkflow(CODE_TASK, INPUT, deps({
      reviewer: async () => ({
        outcome: 'fail',
        findings: [{
          class: 'data-integrity',
          severity: 'medium',
          location: '',
          rationale: 'raw result requires evidence finalization before it can influence quorum',
        }],
      }),
      requestFindingEvidence: async () => {
        await evidenceReady;
        return [];
      },
      cancelJudgmentBatch: cancelJudgmentBatch as TeamTaskDeps['cancelJudgmentBatch'],
    })).finally(() => { workflowSettled = true; });

    await vi.waitFor(() => expect(releaseEvidence).toBeTypeOf('function'));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(workflowSettled).toBe(false);
    expect(cancelJudgmentBatch).not.toHaveBeenCalled();

    releaseEvidence?.();
    const evidence = await workflow;
    expect(evidence).toMatchObject({
      outcome: 'ready-for-closeout',
      reviewQuorum: { status: 'satisfied', satisfyingRole: 'reviewer' },
    });
  });

  it('restores and re-persists convergence state for an interrupted later review wave', async () => {
    const batch = resumableBatch();
    batch.resumeContext = {
      ...batch.resumeContext!,
      downgradedFindings: [{
        sourceGate: 'reviewer',
        finding: {
          class: 'data-integrity',
          severity: 'medium',
          location: 'src/review.ts:12',
          rationale: 'prior unevidenced claim',
        },
        reason: 'missing reproducible evidence',
        gaps: ['failure-scenario'],
        round: 1,
        rePrompted: true,
      }],
      accumulatedHandoffNotes: [
        'tech-lead repaired test intent: quorum-contract',
        'round-one coder handoff',
      ],
      testIntentRepair: {
        outcome: 'repaired',
        testIds: ['quorum-contract'],
      },
      adjudications: [{
        status: 'ruling',
        round: 1,
        dissentingRole: 'reviewer',
        concurringRole: 'tech-lead',
        signature: 'reviewer|data-integrity|src/review.ts:12',
        escalated: false,
        upheld: 'pass',
        rationale: 'the complete artifact supports the tech-lead pass',
        executedModelAlias: 'adjudicator-base',
        executedProvider: 'openai',
      }],
      seenSplitSignatures: ['reviewer|data-integrity|src/review.ts:12'],
      explicitNonReversibleFindingIds: ['finding-1'],
      previousMaxOpenSeverity: 'high',
      flatMaxOpenSeverityRounds: 2,
    };
    expect(parseReviewBatchState(batch), JSON.stringify(batch, null, 2)).toBeDefined();
    const snapshots: ReviewBatchState[] = [];
    const evidence = await runTeamTaskWorkflow(CODE_TASK, {
      ...INPUT,
      resumeReviewBatch: batch,
    }, deps({
      persistReviewBatch: async (state) => { snapshots.push(structuredClone(state)); },
      captureReviewStateForResume: async () => ({
        diff: 'diff --git a/src/review.ts b/src/review.ts',
        hash: 'canonical-review-hash',
        baseTree: '1111111111111111111111111111111111111111',
        currentTree: '2222222222222222222222222222222222222222',
        changedPaths: ['src/review.ts'],
      }),
    }));

    expect(evidence.downgradedFindings).toHaveLength(1);
    expect(evidence.testIntentRepair).toEqual({
      outcome: 'repaired',
      testIds: ['quorum-contract'],
    });
    expect(evidence.adjudications).toEqual([
      expect.objectContaining({
        status: 'ruling',
        executedModelAlias: 'adjudicator-base',
      }),
    ]);
    expect(evidence.rolesInvoked).toContain('adjudicator');
    expect(evidence.handoffNotes).toEqual([
      'tech-lead repaired test intent: quorum-contract',
      'round-one coder handoff',
    ]);
    expect(snapshots[0]?.resumeContext).toMatchObject({
      seenSplitSignatures: ['reviewer|data-integrity|src/review.ts:12'],
      explicitNonReversibleFindingIds: ['finding-1'],
      previousMaxOpenSeverity: 'high',
      flatMaxOpenSeverityRounds: 2,
      downgradedFindings: [expect.objectContaining({ reason: 'missing reproducible evidence' })],
      testIntentRepair: { outcome: 'repaired', testIds: ['quorum-contract'] },
      adjudications: [expect.objectContaining({ executedModelAlias: 'adjudicator-base' })],
      accumulatedHandoffNotes: [
        'tech-lead repaired test intent: quorum-contract',
        'round-one coder handoff',
      ],
    });
  });
});
