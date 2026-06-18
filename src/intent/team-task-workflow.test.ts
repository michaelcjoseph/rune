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
 * merge: Jarvis owns closeout. Every role seam is injected so the whole flow runs
 * on fixtures with no live model call.
 *
 * See: docs/projects/14-product-team-agents/test-plan.md §4
 */

import { describe, it, expect } from 'vitest';

import * as teamTaskWorkflow from './team-task-workflow.js';
import {
  runTeamTaskWorkflow,
  type TeamTaskDeps,
  type ReviewerVerdict,
  type ObjectionFinding,
  type ObjectionSeverity,
  type ReviewerOutcome,
  type GateOutcome,
  type GateVerdict,
  type GateRejectionFeedback,
  type FindingsLedgerEntry,
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
      pmWrapup: async () => ({
        resolved: true,
        rationale: 'The finding remains in the verdict ledger for the severity loop.',
      }),
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
      pmWrapup: async () => ({
        resolved: true,
        rationale: 'PM records the high outbound finding for terminal severity handling.',
      }),
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

    expect(ev.outcome).toBe('blocked');
    expect(ev.blockedReason).toMatch(/operational|malformed class|unsupported class/i);
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

  it('fails closed to an operational block on an unknown reviewer outcome without spending a coder correction round', async () => {
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

    expect(ev.outcome).toBe('blocked');
    expect(ev.objectionOpen).toBe(false);
    expect(ev.blockedReason).toMatch(/operational|unknown outcome|unsupported outcome/i);
    expect(ev.reviewerVerdict?.outcome).toBe('fail');
    expect(coderInputs).toHaveLength(1);
    expect(coderInputs[0]?.rejectionFeedback).toBeUndefined();
  });

  it('normalizes a legacy reviewer block payload to public fail evidence without block residue', async () => {
    const ev = await runTeamTaskWorkflow(
      codeTask,
      { ...INPUT, cap: 1 },
      makeDeps({
        reviewer: async () => ({
          outcome: 'block',
          findings: [],
          notes: 'legacy hard block residue',
        } as unknown as ReviewerVerdict),
      }),
    );

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
          pmWrapup: async () => ({
            resolved: true,
            rationale: 'PM accepts the non-objection disagreement for this severity-mapping case.',
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
          pmWrapup: async () => ({
            resolved: true,
            rationale: 'PM accepts the non-objection disagreement for this strictest-outcome case.',
          }),
        }),
      );

      expect(ev.reviewerVerdict?.outcome, c.name).toBe(c.expectedOutcome);
      expect(ev.outcome, c.name).toBe(c.expectedWorkflowOutcome);
      expect(ev.objectionOpen, c.name).toBe(c.expectedObjectionOpen);
    }
  });

  it('does not let a low-severity finding enter the block-correction path even when the reviewer labels it block', async () => {
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
            outcome: 'block',
            findings: [lowFinding],
            notes: 'reviewer tried to block on a low-severity follow-up',
          } as unknown as ReviewerVerdict;
        },
        pmWrapup: async () => {
          pmCalled = true;
          return { resolved: true, rationale: 'PM should not be needed for a warning.' };
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

  it('does not let a medium-severity finding consume the dedicated block-correction round', async () => {
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
          outcome: 'block',
          findings: [mediumFinding],
          notes: 'reviewer tried to block on a medium-severity fixable finding',
        } as unknown as ReviewerVerdict),
        pmWrapup: async () => {
          pmCalled = true;
          return {
            resolved: true,
            rationale: 'Legacy PM acceptance should not be consulted.',
          };
        },
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

  it('fails safe to an operational block when reviewer severity is malformed, without spending a coder correction round', async () => {
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

    expect(ev.outcome).toBe('blocked');
    expect(ev.objectionOpen).toBe(false);
    expect(ev.blockedReason).toMatch(/operational|malformed severity/i);
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

  it('normalizes a reviewer-produced block with a high finding to fail without a block-correction round', async () => {
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
          outcome: 'block',
          objections: [reviewerObjection],
          notes: `blocking security finding still open after review ${reviewerCalls}`,
        };
      },
      pmWrapup: async () => {
        pmCalled = true;
        return {
          resolved: true,
          rationale: 'Legacy PM acceptance should not be consulted.',
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
        pmWrapup: async () => {
          pmCalled = true;
          return {
            resolved: true,
            rationale: 'Legacy PM acceptance should not be consulted.',
          };
        },
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
        outcome: 'block',
        findings: [blockingFinding],
        notes: 'blocking security finding remains open',
      }),
      pmWrapup: async () => {
        pmCalled = true;
        return {
          resolved: true,
          rationale: 'Legacy PM acceptance should not be consulted.',
        };
      },
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
        outcome: 'block',
        findings: [blockingFinding],
      }),
      pmWrapup: async () => {
        pmCalled = true;
        return {
          resolved: true,
          rationale: 'Legacy PM acceptance should not be consulted.',
        };
      },
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
          pmWrapup: async () => ({ resolved: false }),
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
// Round cap → bounded severity convergence, no human terminal
// ---------------------------------------------------------------------------

describe('team-task-workflow — round cap', () => {
  function forbidPmWrapup(): TeamTaskDeps['pmWrapup'] {
    return async () => {
      throw new Error('PM wrap-up must not be consulted for per-task terminal handling');
    };
  }

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
        pmWrapup: forbidPmWrapup(),
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
        pmWrapup: async () => {
          pmCalled = true;
          return { resolved: true, rationale: 'PM must not be consulted for all-low exit.' };
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
      pmWrapup: async () => {
        pmCalled = true;
        return { resolved: true };
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
      pmWrapup: async () => {
        pmCalled = true;
        return { resolved: false };
      },
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
      pmWrapup: async () => {
        pmCalled = true;
        return {
          resolved: true,
          rationale: 'Legacy PM acceptance should not be consulted.',
        };
      },
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
      pmWrapup: async () => {
        pmCalled = true;
        return {
          resolved: true,
          rationale: 'Legacy PM acceptance should not be consulted.',
        };
      },
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
      pmWrapup: async () => {
        pmCalled = true;
        return {
          resolved: true,
          rationale: 'Legacy PM acceptance should not be consulted.',
        };
      },
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
      pmWrapup: forbidPmWrapup(),
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
        pmWrapup: async () => {
          pmCalled = true;
          return {
            resolved: true,
            rationale: 'PM must not be consulted for severity-loop terminal handling.',
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
        pmWrapup: async () => {
          pmCalled = true;
          return {
            resolved: true,
            rationale: 'PM must not be consulted while a severity loop is converging.',
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
        pmWrapup: async () => {
          pmCalled = true;
          return {
            resolved: true,
            rationale: 'PM must not be consulted for hard-budget terminal handling.',
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

  it('a still-open cap terminal does not enter blocked-on-human or mention PM in the block reason', async () => {
    const deps = makeDeps({
      reviewer: async () => ({ pass: false, objections: [] }),
      pmWrapup: forbidPmWrapup(),
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
      pmWrapup: async () => ({ resolved: true, rationale: 'Legacy PM acceptance should not be consulted.' }),
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
      { role: 'reviewer', stage: 'review' },
      { role: 'designer', stage: 'design' },
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
      pmWrapup: async () => ({ resolved: true, rationale: 'Legacy PM acceptance should not be consulted.' }),
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
    ]);
    expect(transitions.map((event) => event.data?.['transition'])).toEqual([
      'qa-tests',
      'tech-lead-test-review',
      'coder-implementation',
      'reviewer-review',
      'designer-review',
    ]);
    expect(transitions.map((event) => event.data?.['fromRole'])).toEqual([
      undefined,
      'qa',
      'tech-lead',
      'coder',
      'reviewer',
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
      pmWrapup: async () => ({ resolved: true, rationale: 'Legacy PM acceptance should not be consulted.' }),
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
    ]);
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
      pmWrapup: async () => ({
        resolved: true,
        rationale: 'PM keeps this high-severity finding in the convergence ledger.',
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
