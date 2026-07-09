/**
 * Team-task workflow (project 14, Phase 4).
 *
 * Runs ONE selected task through the role gates and returns STRUCTURED EVIDENCE.
 * The gate order encodes the spec's invariants:
 *
 *   reviewer independence resolved (fail-closed)
 *     → QA writes tests / records a no-code-test rationale
 *     → tech lead reviews test intent  (BEFORE the coder)
 *     → [round loop, bounded by cap]
 *         coder implements
 *         → independent-provider reviewer reviews diff/spec/tests/task/context
 *         → open objection-class finding ⇒ hard block (PM can't clear it)
 *         → tech lead reviews the diff
 *         → designer reviews IFF the sizing flagged front-end/designer-needed
 *         → all gates green ⇒ ready-for-closeout
 *     → cap reached: return machine terminal evidence; never PM wrap-up /
 *       blocked-on-human from a per-task path
 *
 * It does NOT mark `tasks.md`, write `context.md`, or merge — Rune owns
 * closeout. Every role is an injected seam, so the whole flow runs on fixtures
 * with no live model call.
 */

import type { SizedTask } from './planning-roles.js';
import type { DispatchProvider } from './dispatch.js';
import type { RoleName } from '../roles/loader.js';

/** Objection classes — defects normal usage won't surface until they matter.
 *  An open finding in any class is a hard gate. */
export type ObjectionClass =
  | 'security'
  | 'privacy'
  | 'data-integrity'
  | 'concurrency'
  | 'outbound'
  | 'cost-perf';

export type ObjectionSeverity = 'low' | 'medium' | 'high' | 'critical';

/** The machine-readable objection payload the reviewer role emits and the
 *  orchestrator gates on — distinct from a bare pass/fail. */
export interface ObjectionFinding {
  class: ObjectionClass;
  severity: ObjectionSeverity;
  location: string;
  rationale: string;
  /** Concrete role-authored guidance for the counterpart to clear this finding. */
  suggestedChange?: string;
  /** Phase 14: whether a plain git revert fully undoes the effect. */
  reversible?: boolean;
}

export type GateOutcome = 'pass' | 'pass-with-warnings' | 'fail';
export type ReviewerOutcome = GateOutcome;

export interface GateVerdict {
  outcome: GateOutcome;
  findings: ObjectionFinding[];
  notes?: string;
  /** Concrete guidance for verdict-level failures that do not have findings. */
  suggestedChange?: string;
}

/** The normalized reviewer's structured verdict carried in workflow evidence. */
export interface NormalizedReviewerVerdict extends GateVerdict {
  /** Legacy reviewer-evidence field retained for existing run-record consumers. */
  objections: ObjectionFinding[];
  /** Explicit reviewer verification of prior open ledger findings. */
  verifiedFindings?: FindingVerification[];
  /** Set when the reviewer payload itself is malformed and must fail closed operationally. */
  operationalFailureReason?: string;
}

/** The reviewer role boundary accepts legacy boolean verdicts while production
 *  seams migrate; workflow evidence is normalized to `NormalizedReviewerVerdict`
 *  before any gate or caller observes it. */
export interface ReviewerVerdict {
  outcome?: ReviewerOutcome;
  pass?: boolean;
  findings?: ObjectionFinding[];
  objections?: ObjectionFinding[];
  verifiedFindings?: FindingVerification[];
  /** Optional notes for non-objection failures; finding details live in `findings`. */
  notes?: string;
  /** Concrete guidance for non-finding reviewer failures. */
  suggestedChange?: string;
}

export type GateReviewVerdict = GateVerdict | {
  pass: boolean;
  notes?: string;
  suggestedChange?: string;
};

export interface WorkflowGateVerdicts {
  reviewer?: GateVerdict;
  techLeadDiff?: GateVerdict;
  designer?: GateVerdict;
}

export type FindingSourceGate = 'reviewer' | 'tech-lead' | 'designer';
export type FindingStatus = 'open' | 'resolved' | 'regressed';
export type LoopExitReason = 'all-low' | 'stagnation' | 'hard-budget' | 'operational';

export interface FindingVerification {
  id: string;
  status: FindingStatus;
  notes: string;
}

export interface FindingsLedgerEntry extends ObjectionFinding {
  id: string;
  sourceGate: FindingSourceGate;
  reversible: boolean;
  raisedRound: number;
  status: FindingStatus;
}

export type ReviewerEvidence =
  | NormalizedReviewerVerdict
  | (ReviewerVerdict & { objections: ObjectionFinding[] });

export type AcceptanceActor = 'pm' | 'human';

export interface PmAcceptance {
  actor: AcceptanceActor;
  decision: 'accepted-with-rationale';
  rationale: string;
}

export interface AcceptWithRationaleInput {
  task: SizedTask;
  reason: string;
  reviewerVerdict: GateVerdict;
  rejectionFeedback: GateRejectionFeedback;
}

export interface AcceptWithRationaleResult {
  accepted: boolean;
  actor: AcceptanceActor;
  rationale?: string;
}

/** Machine-readable feedback from a role gate rejection. This is the object
 *  future retries and gate-time learning consume; `blockedReason` remains the
 *  human-readable summary. */
export interface GateRejectionFeedback {
  rejectingRole: RoleName;
  counterpartRole: RoleName;
  rejectedRole: RoleName;
  artifact: GateRejectedArtifact;
  rejectedArtifact: GateRejectedArtifact;
  reason: string;
  whatFailed: string;
  notes: string[];
  actionableNotes: string[];
}

export type GateRejectedArtifact =
  | 'test-intent'
  | 'reviewer-verdict'
  | 'implementation-diff'
  | 'design-review';

/** QA's output for a task — code tests, or a reviewed no-code-test rationale. */
export type QaResult =
  | { kind: 'tests-written'; testIds: string[] }
  | { kind: 'no-code-test-rationale'; rationale: string };

/** Outcome of the post-repair confirm-red run: the patched tests must still be
 *  red against the not-yet-written implementation, or the repair is vacuous. */
export type TestRepairRedCheck =
  | { kind: 'red'; command: string; exitCode: number | null; outputTail: string }
  | { kind: 'skipped'; reason: string };

/** The tech-lead's test-intent repair result. `not-repaired` is a soft outcome
 *  (falls back to the QA bounce), never a task-fatal error. */
export type TechLeadTestRepairResult =
  | { kind: 'repaired'; testIds: string[]; redCheck: TestRepairRedCheck }
  | { kind: 'not-repaired'; reason: string };

/** The coder's output — the diff + factual handoff notes. NO hidden reasoning:
 *  what the reviewer sees is the artifact, not the coder's chain of thought. */
export interface CoderResult {
  diff: string;
  handoffNotes: string[];
}

/** What the reviewer receives — artifacts only, never coder hidden reasoning. */
export interface ReviewerInput {
  diff: string;
  spec: string;
  tests: string[] | string;
  task: SizedTask;
  context: string;
  reviewerProvider: DispatchProvider;
  findingsLedger?: FindingsLedgerEntry[];
  /** The coder's factual handoff notes for THIS round — part of the artifact
   *  (facts, never hidden reasoning); carries the TEST-REMOVED justifications
   *  the test-deletion guardrail keys on. */
  coderHandoffNotes?: string[];
}

export type WorkflowActivityEvent = {
  kind: 'activity' | 'output';
  data?: Record<string, unknown>;
};

/** The injected role seams. Tests pass fixtures; production wraps real role
 *  invocations (charter loader + model-policy dispatch). */
export interface TeamTaskDeps {
  qaWriteTests: (input: {
    task: SizedTask;
    spec: string;
    rejectionFeedback?: GateRejectionFeedback;
  }) => Promise<QaResult>;
  techLeadReviewTests: (input: {
    task: SizedTask;
    qa: QaResult;
  }) => Promise<{
    approved: boolean;
    notes?: string;
    suggestedChange?: string;
    /** false ⇒ the tests need structural rework or expose a spec ambiguity the
     *  tech-lead cannot resolve alone — skip the repair, bounce straight to QA.
     *  Absent ⇒ attempt the repair (a failed repair falls back to the bounce). */
    repairable?: boolean;
  }>;
  /** Optional corrective action for a test-intent rejection: the tech-lead
   *  patches the QA test files directly (add/adjust assertions), guarded to
   *  test paths, then the workflow re-reviews. Attempted once per task. */
  techLeadRepairTests?: (input: {
    task: SizedTask;
    spec: string;
    qa: Extract<QaResult, { kind: 'tests-written' }>;
    rejection: { reason: string; suggestedChange?: string };
  }) => Promise<TechLeadTestRepairResult>;
  coder: (input: {
    task: SizedTask;
    spec: string;
    context: string;
    tests: string[] | string;
    rejectionFeedback?: GateRejectionFeedback[];
    findingsLedger?: FindingsLedgerEntry[];
  }) => Promise<CoderResult>;
  coderSelfReview?: (input: {
    task: SizedTask;
    artifact: CoderResult;
    spec: string;
    context: string;
    tests: string[] | string;
  }) => Promise<{ artifact: CoderResult; revised: boolean }>;
  qaRevalidateDiff?: (input: {
    task: SizedTask;
    qa: QaResult;
    diff: string;
    spec: string;
    context: string;
  }) => Promise<{ approved: boolean; notes?: string }>;
  reviewer: (input: ReviewerInput) => Promise<ReviewerVerdict>;
  techLeadReviewDiff: (input: {
    task: SizedTask;
    diff: string;
    spec?: string;
    context?: string;
    findingsLedger?: FindingsLedgerEntry[];
    /** Coder handoff notes for THIS round — carries the TEST-REMOVED
     *  justifications the test-deletion guardrail keys on. */
    coderHandoffNotes?: string[];
  }) => Promise<GateReviewVerdict>;
  designer: (input: {
    task: SizedTask;
    diff: string;
    findingsLedger?: FindingsLedgerEntry[];
  }) => Promise<GateReviewVerdict>;
  pmWrapup: (input: { task: SizedTask; reason: string }) => Promise<{
    resolved: boolean;
    rationale?: string;
  }>;
  /** Optional core override seam for tests/operator surfaces. A high/critical
   *  reviewer block still gets the normal coder correction first; only a
   *  surviving block reaches this seam, and acceptance requires a non-empty
   *  rationale recorded in the evidence. */
  acceptWithRationale?: (
    input: AcceptWithRationaleInput,
  ) => Promise<AcceptWithRationaleResult>;
  /** Optional gate-time learning hook. Awaited before a corrective retry so a
   *  written lesson can load into the counterpart role's next invocation. */
  onGateRejection?: (feedback: GateRejectionFeedback) => Promise<void>;
  /** Resolve a reviewer provider distinct from the coder's, or null when none is
   *  available (executor down). Null ⇒ the task blocks — independence is
   *  fail-closed, never a silent same-provider review. */
  resolveReviewerProvider: (coderProvider: DispatchProvider) => DispatchProvider | null;
}

export interface TeamTaskRunInput {
  spec: string;
  contextMd: string;
  coderProvider: DispatchProvider;
  /** Feedback carried from a previous whole-task attempt. */
  rejectionFeedback?: GateRejectionFeedback | GateRejectionFeedback[];
  /** Optional live activity sink for appliers that need role-stage visibility. */
  emit?: (event: WorkflowActivityEvent) => void;
  /** Per-task round cap. */
  cap: number;
}

export type WorkflowOutcome = 'ready-for-closeout' | 'blocked' | 'failed';

/** The structured evidence the workflow returns — data only. It carries no
 *  writer/commit/merge handle: marking `tasks.md`, writing `context.md`, and
 *  merging are Rune's closeout, not the workflow's. */
export interface TaskEvidence {
  taskId: string;
  outcome: WorkflowOutcome;
  /** The distinct roles that participated, in first-invocation order. This is a
   *  role-PRESENCE list (deduplicated), not a per-invocation count — a role that
   *  reviews twice (tech-lead: test intent then diff) appears once. */
  rolesInvoked: string[];
  reviewerVerdict?: ReviewerEvidence;
  gateVerdicts?: WorkflowGateVerdicts;
  findingsLedger: FindingsLedgerEntry[];
  loopExitReason: LoopExitReason;
  objectionOpen: boolean;
  handoffNotes: string[];
  noCodeTestRationale?: string;
  /** Set on a `blocked` outcome. */
  blockedReason?: string;
  /** Structured role-gate feedback for corrective retries / learning. */
  rejectionFeedback?: GateRejectionFeedback;
  /** Set on a `failed` outcome — the structured reason a role seam rejected
   *  (for the Phase 5 retry / model-swap decision). */
  failureReason?: string;
  /** Human/PM acceptance evidence when non-objection disagreement is cleared. */
  acceptance?: PmAcceptance;
  /** Set when the tech-lead attempted a test-intent repair this task. */
  testIntentRepair?: {
    outcome: 'repaired' | 'not-repaired';
    reason?: string;
    testIds?: string[];
  };
}

/** Run the team-task workflow for one selected task. */
export async function runTeamTaskWorkflow(
  task: SizedTask,
  input: TeamTaskRunInput,
  deps: TeamTaskDeps,
): Promise<TaskEvidence> {
  // A zero/negative cap would skip the round loop yet still reach terminal
  // evidence with a reason no round produced — reject it loudly,
  // matching gen-eval-loop's `maxEvaluatorRounds` guard.
  if (input.cap < 1) {
    throw new RangeError(`runTeamTaskWorkflow: cap must be >= 1 (got ${input.cap})`);
  }

  const roles = new RoleLog();
  const handoffNotes: string[] = [];
  // Mutable collector (same pattern as roles/handoffNotes) so the repair
  // outcome reaches every terminal — including the outer-catch `failed` path —
  // from one decoration point.
  const repairEvidence: { testIntentRepair?: TaskEvidence['testIntentRepair'] } = {};

  try {
    const evidence = await runGated(task, input, deps, roles, handoffNotes, repairEvidence);
    return {
      ...evidence,
      ...(repairEvidence.testIntentRepair !== undefined
        ? { testIntentRepair: repairEvidence.testIntentRepair }
        : {}),
    };
  } catch (err) {
    // A role seam rejected — surface it as structured `failed` evidence rather
    // than an unhandled rejection, so the Phase 5 loop can decide retry/model-swap.
    return {
      taskId: task.id,
      outcome: 'failed',
      rolesInvoked: roles.list(),
      objectionOpen: false,
      handoffNotes,
      failureReason: (err as Error).message,
      findingsLedger: [],
      loopExitReason: 'operational',
      ...(repairEvidence.testIntentRepair !== undefined
        ? { testIntentRepair: repairEvidence.testIntentRepair }
        : {}),
    };
  }
}

async function runGated(
  task: SizedTask,
  input: TeamTaskRunInput,
  deps: TeamTaskDeps,
  roles: RoleLog,
  handoffNotes: string[],
  repairEvidence: { testIntentRepair?: TaskEvidence['testIntentRepair'] },
): Promise<TaskEvidence> {
  // Gate 0: reviewer independence, resolved up-front and fail-closed — block
  // before any coder work rather than risk a same-provider review later.
  const reviewerProvider = deps.resolveReviewerProvider(input.coderProvider);
  if (reviewerProvider === null) {
    const feedback = buildGateRejectionFeedback({
      rejectingRole: 'reviewer',
      counterpartRole: 'coder',
      artifact: 'reviewer-verdict',
      reason: 'reviewer independence: no distinct-provider reviewer available',
    });
    await recordGateRejection(deps, feedback);
    emitGateRejection(input, feedback);
    return block(task, roles, handoffNotes, {
      blockedReason: 'reviewer independence: no distinct-provider reviewer available',
      rejectionFeedback: feedback,
      findingsLedger: [],
      loopExitReason: 'operational',
    });
  }

  // Gate 1: QA-first — tests (or a no-code-test rationale) before the coder.
  const carriedFeedback = normalizeFeedback(input.rejectionFeedback);
  let qaFeedback = carriedFeedback.find((feedback) => feedback.rejectedRole === 'qa');
  let coderFeedback = carriedFeedback.filter((feedback) => feedback.rejectedRole === 'coder');
  let previousRole: RoleName | undefined;
  let qa: QaResult | undefined;
  let noCodeTestRationale: string | undefined;
  let tests: string[] | string | undefined;
  let repairAttempted = false;
  for (let qaAttempt = 0; qaAttempt < input.cap; qaAttempt++) {
    roles.add('qa');
    previousRole = emitRoleTransition(input, previousRole, 'qa', 'test', 'qa-tests');
    qa = await deps.qaWriteTests({
      task,
      spec: input.spec,
      ...(qaFeedback !== undefined ? { rejectionFeedback: qaFeedback } : {}),
    });
    noCodeTestRationale =
      qa.kind === 'no-code-test-rationale' ? qa.rationale : undefined;
    tests = qa.kind === 'tests-written' ? qa.testIds : qa.rationale;

    // Gate 2: tech lead reviews the test intent BEFORE the coder starts.
    roles.add('tech-lead');
    previousRole = emitRoleTransition(
      input,
      previousRole,
      'tech-lead',
      'test-review',
      'tech-lead-test-review',
    );
    let tlTests = await deps.techLeadReviewTests({ task, qa });
    emitRoleVerdict(input, {
      role: 'tech-lead',
      gate: 'test-intent',
      verdict: tlTests.approved ? 'pass' : 'fail',
      summary: tlTests.notes?.trim() || (tlTests.approved
        ? 'tech-lead approved test intent'
        : 'tech-lead rejected test intent'),
    });
    if (tlTests.approved) break;

    // Corrective action before the QA bounce: on the first rejection the
    // tech-lead patches the tests itself (bounded gaps — add/adjust
    // assertions), then re-reviews. The bounce remains for structural rework
    // or spec ambiguity (`repairable: false`) and for a failed repair — the
    // gate must terminate in approve or approve-after-patch, never in
    // "reject an unfixed state N times".
    let repairNote: string | undefined;
    if (
      !repairAttempted &&
      deps.techLeadRepairTests !== undefined &&
      qa.kind === 'tests-written' &&
      tlTests.repairable !== false
    ) {
      repairAttempted = true;
      emitRoleStage(input, 'tech-lead', 'test-repair');
      const rejectionReason = tlTests.notes?.trim() || 'tech-lead rejected test intent';
      let repair: TechLeadTestRepairResult;
      try {
        repair = await deps.techLeadRepairTests({
          task,
          spec: input.spec,
          qa,
          rejection: {
            reason: rejectionReason,
            ...(tlTests.suggestedChange !== undefined
              ? { suggestedChange: tlTests.suggestedChange }
              : {}),
          },
        });
      } catch (err) {
        // The repair is best-effort by contract — an internal throw degrades
        // to the QA bounce, never to a task-fatal `failed`.
        repair = { kind: 'not-repaired', reason: (err as Error).message };
      }
      emitTestRepair(input, repair);
      if (repair.kind === 'repaired') {
        qa = { kind: 'tests-written', testIds: repair.testIds };
        tests = repair.testIds;
        repairEvidence.testIntentRepair = {
          outcome: 'repaired',
          testIds: repair.testIds,
        };
        handoffNotes.push(
          `tech-lead repaired test intent: ${repair.testIds.join(', ')}`,
        );
        const reReview = await deps.techLeadReviewTests({ task, qa });
        emitRoleVerdict(input, {
          role: 'tech-lead',
          gate: 'test-intent',
          verdict: reReview.approved ? 'pass' : 'fail',
          summary: reReview.notes?.trim() || (reReview.approved
            ? 'tech-lead approved repaired test intent'
            : 'tech-lead rejected repaired test intent'),
        });
        if (reReview.approved) break;
        tlTests = reReview;
        repairNote = 'tech-lead patched the tests but rejected them on re-review';
      } else {
        repairEvidence.testIntentRepair = {
          outcome: 'not-repaired',
          reason: repair.reason,
        };
        repairNote = `tech-lead repair attempted but not applied: ${repair.reason}`;
      }
    }

    const reason = tlTests.notes?.trim() || 'tech-lead rejected test intent';
    qaFeedback = buildGateRejectionFeedback({
      rejectingRole: 'tech-lead',
      counterpartRole: 'qa',
      artifact: 'test-intent',
      reason,
      actionableNotes: [
        ...suggestedChangeNotes(tlTests.suggestedChange),
        ...(repairNote !== undefined ? [repairNote] : []),
      ],
    });
    await recordGateRejection(deps, qaFeedback);
    if (qaAttempt === input.cap - 1) {
      emitGateRejection(input, qaFeedback);
      return block(task, roles, handoffNotes, {
        blockedReason: reason,
        rejectionFeedback: qaFeedback,
        noCodeTestRationale,
        findingsLedger: [],
        loopExitReason: 'hard-budget',
      });
    }
  }
  if (qa === undefined || tests === undefined) {
    const feedback = buildGateRejectionFeedback({
      rejectingRole: 'tech-lead',
      counterpartRole: 'qa',
      artifact: 'test-intent',
      reason: 'QA test intent was not produced',
    });
    await recordGateRejection(deps, feedback);
    emitGateRejection(input, feedback);
    return block(task, roles, handoffNotes, {
      blockedReason: 'QA test intent was not produced',
      rejectionFeedback: feedback,
      findingsLedger: [],
      loopExitReason: 'operational',
    });
  }

  // Round loop — coder → reviewer → tech-lead diff → designer, bounded by cap.
  let lastReviewer: NormalizedReviewerVerdict | undefined;
  let lastTechLeadDiff: GateVerdict | undefined;
  let lastDesigner: GateVerdict | undefined;
  let lastRejectionFeedback: GateRejectionFeedback | undefined;
  const configuredRoundBudget = Math.min(input.cap, SEVERITY_LOOP_HARD_BUDGET);
  let round = 0;
  let previousMaxOpenSeverity: ObjectionSeverity | undefined;
  let flatMaxOpenSeverityRounds = 0;
  let continueConvergingPastConfiguredCap = false;
  let coderSelfReviewDone = false;
  const findingsLedger: FindingsLedgerEntry[] = [];
  const explicitNonReversibleFindingIds = new Set<string>();
  while (round < configuredRoundBudget || continueConvergingPastConfiguredCap) {
    continueConvergingPastConfiguredCap = false;
    round += 1;
    roles.add('coder');
    previousRole = emitRoleTransition(
      input,
      previousRole,
      'coder',
      'implementation',
      'coder-implementation',
    );
    let coder = await deps.coder({
      task,
      spec: input.spec,
      context: input.contextMd,
      tests,
      ...(coderFeedback.length > 0 ? { rejectionFeedback: coderFeedback } : {}),
      ...coderFindingsLedger(findingsLedger),
    });
    if (!coderSelfReviewDone) {
      coderSelfReviewDone = true;
      const reviewed = await runCoderSelfReview(deps, {
        task,
        artifact: coder,
        spec: input.spec,
        context: input.contextMd,
        tests,
      });
      if (reviewed.revised && diffBehaviorChanged(coder.diff, reviewed.artifact.diff)) {
        const qaDiffReview = await revalidateQaDiff(deps, {
          task,
          qa,
          diff: reviewed.artifact.diff,
          spec: input.spec,
          context: input.contextMd,
        });
        if (!qaDiffReview.approved) {
          const reason = qaDiffReview.notes?.trim() ||
            'QA test intent no longer matches the self-reviewed implementation diff';
          const feedback = buildGateRejectionFeedback({
            rejectingRole: 'qa',
            counterpartRole: 'coder',
            artifact: 'implementation-diff',
            reason,
          });
          await recordGateRejection(deps, feedback);
          emitGateRejection(input, feedback);
          return block(task, roles, handoffNotes, {
            blockedReason: reason,
            rejectionFeedback: feedback,
            findingsLedger,
            loopExitReason: 'operational',
            noCodeTestRationale,
          });
        }
      }
      coder = reviewed.artifact;
    }
    handoffNotes.push(...coder.handoffNotes);
    const roundFeedback: GateRejectionFeedback[] = [];

    roles.add('reviewer');
    previousRole = emitRoleTransition(
      input,
      previousRole,
      'reviewer',
      'review',
      'reviewer-review',
    );
    const roundFindingsLedger = openFindingsLedger(findingsLedger);
    const rawReviewerVerdict = await deps.reviewer({
      diff: coder.diff,
      spec: input.spec,
      tests,
      task,
      context: input.contextMd,
      reviewerProvider,
      ...(roundFindingsLedger.length > 0
        ? { findingsLedger: roundFindingsLedger }
        : {}),
      ...(coder.handoffNotes.length > 0
        ? { coderHandoffNotes: coder.handoffNotes }
        : {}),
    });
    lastReviewer = normalizeReviewerVerdict(rawReviewerVerdict);
    mergeFindingsIntoLedger(
      findingsLedger,
      explicitNonReversibleFindingIds,
      'reviewer',
      lastReviewer.findings,
      round,
    );
    applyFindingVerifications(findingsLedger, lastReviewer.verifiedFindings ?? []);
    emitRoleVerdict(input, {
      role: 'reviewer',
      gate: 'reviewer-verdict',
      verdict: isReviewerPass(lastReviewer) ? 'pass' : 'fail',
      summary: summarizeReviewerVerdict(lastReviewer),
    });
    if (lastReviewer.operationalFailureReason !== undefined) {
      const feedback = buildGateRejectionFeedback({
        rejectingRole: 'reviewer',
        counterpartRole: 'coder',
        artifact: 'reviewer-verdict',
        reason: lastReviewer.operationalFailureReason,
      });
      await recordGateRejection(deps, feedback);
      emitGateRejection(input, feedback);
      return fail(task, roles, handoffNotes, {
        failureReason: lastReviewer.operationalFailureReason,
        rejectionFeedback: feedback,
        reviewerVerdict: lastReviewer,
        gateVerdicts: buildWorkflowGateVerdicts(lastReviewer, undefined, undefined),
        findingsLedger,
        loopExitReason: 'operational',
        objectionOpen: false,
        noCodeTestRationale,
      });
    }

    if (!isReviewerPass(lastReviewer)) {
      const feedback = buildGateRejectionFeedback({
        rejectingRole: 'reviewer',
        counterpartRole: 'coder',
        artifact: 'reviewer-verdict',
        reason: lastReviewer.findings.length > 0
          ? summarizeReviewerVerdict(lastReviewer)
          : lastReviewer.notes?.trim() || 'reviewer did not pass the implementation diff',
        actionableNotes: suggestedChangesFromVerdict(lastReviewer),
      });
      await recordGateRejection(deps, feedback);
      lastRejectionFeedback = feedback;
      roundFeedback.push(feedback);
    }

    lastTechLeadDiff = normalizeGateVerdict(await deps.techLeadReviewDiff({
      task,
      diff: coder.diff,
      spec: input.spec,
      context: input.contextMd,
      ...(roundFindingsLedger.length > 0
        ? { findingsLedger: roundFindingsLedger }
        : {}),
      ...(coder.handoffNotes.length > 0
        ? { coderHandoffNotes: coder.handoffNotes }
        : {}),
    }));
    mergeFindingsIntoLedger(
      findingsLedger,
      explicitNonReversibleFindingIds,
      'tech-lead',
      lastTechLeadDiff.findings,
      round,
    );
    emitRoleVerdict(input, {
      role: 'tech-lead',
      gate: 'implementation-diff',
      verdict: isGatePass(lastTechLeadDiff) ? 'pass' : 'fail',
      summary: lastTechLeadDiff.notes?.trim() || (isGatePass(lastTechLeadDiff)
        ? 'tech-lead approved implementation diff'
        : 'tech-lead rejected implementation diff'),
    });
    if (!isGatePass(lastTechLeadDiff)) {
      const feedback = buildGateRejectionFeedback({
        rejectingRole: 'tech-lead',
        counterpartRole: 'coder',
        artifact: 'implementation-diff',
        reason: lastTechLeadDiff.findings.length > 0
          ? summarizeObjections(lastTechLeadDiff.findings)
          : lastTechLeadDiff.notes ?? 'tech-lead did not pass the implementation diff',
        actionableNotes: suggestedChangesFromVerdict(lastTechLeadDiff),
      });
      await recordGateRejection(deps, feedback);
      lastRejectionFeedback = feedback;
      roundFeedback.push(feedback);
    }

    lastDesigner = undefined;
    if (task.designerNeeded) {
      roles.add('designer');
      previousRole = emitRoleTransition(
        input,
        previousRole,
        'designer',
        'design',
        'designer-review',
      );
      lastDesigner = normalizeGateVerdict(await deps.designer({
        task,
        diff: coder.diff,
        ...(roundFindingsLedger.length > 0
          ? { findingsLedger: roundFindingsLedger }
          : {}),
      }));
      mergeFindingsIntoLedger(
        findingsLedger,
        explicitNonReversibleFindingIds,
        'designer',
        lastDesigner.findings,
        round,
      );
      emitRoleVerdict(input, {
        role: 'designer',
        gate: 'design-review',
        verdict: isGatePass(lastDesigner) ? 'pass' : 'fail',
        summary: lastDesigner.notes?.trim() || (isGatePass(lastDesigner)
          ? 'designer approved implementation diff'
          : 'designer rejected implementation diff'),
      });
      if (!isGatePass(lastDesigner)) {
        const feedback = buildGateRejectionFeedback({
          rejectingRole: 'designer',
          counterpartRole: 'coder',
          artifact: 'design-review',
          reason: lastDesigner.findings.length > 0
            ? summarizeObjections(lastDesigner.findings)
            : lastDesigner.notes ?? 'designer review failed',
          actionableNotes: suggestedChangesFromVerdict(lastDesigner),
        });
        await recordGateRejection(deps, feedback);
        lastRejectionFeedback = feedback;
        roundFeedback.push(feedback);
      }
    }

    if (
      isReviewerPass(lastReviewer) &&
      isGatePass(lastTechLeadDiff) &&
      isGatePass(lastDesigner) &&
      reviewerVerificationAllowsCloseout(
        roundFindingsLedger,
        lastReviewer.verifiedFindings,
        findingsLedger,
        round < configuredRoundBudget,
      )
    ) {
      return {
        taskId: task.id,
        outcome: 'ready-for-closeout',
        rolesInvoked: roles.list(),
        reviewerVerdict: lastReviewer,
        gateVerdicts: buildWorkflowGateVerdicts(lastReviewer, lastTechLeadDiff, lastDesigner),
        findingsLedger,
        loopExitReason: 'all-low',
        objectionOpen: false,
        handoffNotes,
        ...(noCodeTestRationale !== undefined ? { noCodeTestRationale } : {}),
      };
    }

    const maxOpenSeverity = maxOpenFindingSeverity(findingsLedger);
    if (
      maxOpenSeverity !== undefined &&
      severityRank[maxOpenSeverity] > severityRank.low &&
      hasOnlySeverityDerivedFailures(lastReviewer, lastTechLeadDiff, lastDesigner)
    ) {
      const strictSeverityDrop =
        previousMaxOpenSeverity !== undefined &&
        severityRank[maxOpenSeverity] < severityRank[previousMaxOpenSeverity];
      if (maxOpenSeverity === previousMaxOpenSeverity) {
        flatMaxOpenSeverityRounds += 1;
      } else {
        previousMaxOpenSeverity = maxOpenSeverity;
        flatMaxOpenSeverityRounds = 1;
      }
      if (
        flatMaxOpenSeverityRounds >= 3 &&
        firstNonReversibleHighSeverityFinding(
          findingsLedger,
          explicitNonReversibleFindingIds,
        ) === undefined
      ) {
        emitTerminalObjections(input, lastReviewer, lastTechLeadDiff, lastDesigner);
        return {
          taskId: task.id,
          outcome: 'ready-for-closeout',
          rolesInvoked: roles.list(),
          reviewerVerdict: lastReviewer,
          gateVerdicts: buildWorkflowGateVerdicts(lastReviewer, lastTechLeadDiff, lastDesigner),
          findingsLedger,
          loopExitReason: 'stagnation',
          objectionOpen: false,
          handoffNotes,
          ...(noCodeTestRationale !== undefined ? { noCodeTestRationale } : {}),
        };
      }
      continueConvergingPastConfiguredCap =
        strictSeverityDrop &&
        round >= configuredRoundBudget &&
        round < SEVERITY_LOOP_HARD_BUDGET;
    } else {
      previousMaxOpenSeverity = maxOpenSeverity;
      flatMaxOpenSeverityRounds = 0;
    }
    // Non-objection disagreement → retry within the cap.
    if (roundFeedback.length > 0) {
      coderFeedback = roundFeedback;
    }
  }

  // Cap reached. Per-task terminal handling is machine-owned: preserve the
  // structured verdicts/feedback, but do not route to PM wrap-up or a human
  // blocked state.
  if (
    hasOnlySeverityDerivedFailures(lastReviewer, lastTechLeadDiff, lastDesigner) &&
    maxOpenFindingSeverity(findingsLedger) !== undefined
  ) {
    emitTerminalObjections(input, lastReviewer, lastTechLeadDiff, lastDesigner);
    const holdFinding = firstNonReversibleHighSeverityFinding(
      findingsLedger,
      explicitNonReversibleFindingIds,
    );
    if (holdFinding !== undefined) {
      return block(task, roles, handoffNotes, {
        blockedReason: terminalHoldReason(holdFinding),
        reviewerVerdict: lastReviewer,
        gateVerdicts: buildWorkflowGateVerdicts(lastReviewer, lastTechLeadDiff, lastDesigner),
        findingsLedger,
        loopExitReason: 'hard-budget',
        objectionOpen: false,
        noCodeTestRationale,
      });
    }
    return {
      taskId: task.id,
      outcome: 'ready-for-closeout',
      rolesInvoked: roles.list(),
      reviewerVerdict: lastReviewer,
      gateVerdicts: buildWorkflowGateVerdicts(lastReviewer, lastTechLeadDiff, lastDesigner),
      findingsLedger,
      loopExitReason: 'hard-budget',
      objectionOpen: false,
      handoffNotes,
      ...(noCodeTestRationale !== undefined ? { noCodeTestRationale } : {}),
    };
  }

  if (task.designerNeeded && !isGatePass(lastDesigner)) {
    if (lastRejectionFeedback !== undefined) {
      emitGateRejection(input, lastRejectionFeedback);
    }
    return block(task, roles, handoffNotes, {
      blockedReason: 'designer review failed at the round cap',
      ...(lastRejectionFeedback !== undefined
        ? { rejectionFeedback: lastRejectionFeedback }
        : {}),
      reviewerVerdict: lastReviewer,
      gateVerdicts: buildWorkflowGateVerdicts(lastReviewer, lastTechLeadDiff, lastDesigner),
      findingsLedger,
      loopExitReason: 'hard-budget',
      noCodeTestRationale,
    });
  }

  if (lastRejectionFeedback !== undefined) {
    emitGateRejection(input, lastRejectionFeedback);
  }
  return block(task, roles, handoffNotes, {
    blockedReason: lastRejectionFeedback === undefined
      ? 'round cap reached with unresolved task feedback'
      : `round cap reached with unresolved task feedback: ${lastRejectionFeedback.whatFailed}`,
    ...(lastRejectionFeedback !== undefined
      ? { rejectionFeedback: lastRejectionFeedback }
      : {}),
    reviewerVerdict: lastReviewer,
    gateVerdicts: buildWorkflowGateVerdicts(lastReviewer, lastTechLeadDiff, lastDesigner),
    findingsLedger,
    loopExitReason: 'hard-budget',
    noCodeTestRationale,
  });
}

/** Ordered, de-duplicated role-invocation log. */
class RoleLog {
  private readonly seen = new Set<string>();
  private readonly order: string[] = [];
  add(role: string): void {
    if (!this.seen.has(role)) {
      this.seen.add(role);
      this.order.push(role);
    }
  }
  list(): string[] {
    return [...this.order];
  }
}

function block(
  task: SizedTask,
  roles: RoleLog,
  handoffNotes: string[],
  extra: {
    blockedReason: string;
    rejectionFeedback?: GateRejectionFeedback;
    reviewerVerdict?: ReviewerEvidence;
    gateVerdicts?: WorkflowGateVerdicts;
    findingsLedger: FindingsLedgerEntry[];
    loopExitReason: LoopExitReason;
    objectionOpen?: boolean;
    noCodeTestRationale?: string;
  },
): TaskEvidence {
  return {
    taskId: task.id,
    outcome: 'blocked',
    rolesInvoked: roles.list(),
    objectionOpen: extra.objectionOpen ?? false,
    handoffNotes,
    blockedReason: extra.blockedReason,
    ...(extra.rejectionFeedback !== undefined
      ? { rejectionFeedback: extra.rejectionFeedback }
      : {}),
    ...(extra.reviewerVerdict !== undefined ? { reviewerVerdict: extra.reviewerVerdict } : {}),
    ...(extra.gateVerdicts !== undefined ? { gateVerdicts: extra.gateVerdicts } : {}),
    findingsLedger: extra.findingsLedger,
    loopExitReason: extra.loopExitReason,
    ...(extra.noCodeTestRationale !== undefined
      ? { noCodeTestRationale: extra.noCodeTestRationale }
      : {}),
  };
}

function fail(
  task: SizedTask,
  roles: RoleLog,
  handoffNotes: string[],
  extra: {
    failureReason: string;
    rejectionFeedback?: GateRejectionFeedback;
    reviewerVerdict?: ReviewerEvidence;
    gateVerdicts?: WorkflowGateVerdicts;
    findingsLedger: FindingsLedgerEntry[];
    loopExitReason: LoopExitReason;
    objectionOpen?: boolean;
    noCodeTestRationale?: string;
  },
): TaskEvidence {
  return {
    taskId: task.id,
    outcome: 'failed',
    rolesInvoked: roles.list(),
    objectionOpen: extra.objectionOpen ?? false,
    handoffNotes,
    failureReason: extra.failureReason,
    ...(extra.rejectionFeedback !== undefined
      ? { rejectionFeedback: extra.rejectionFeedback }
      : {}),
    ...(extra.reviewerVerdict !== undefined ? { reviewerVerdict: extra.reviewerVerdict } : {}),
    ...(extra.gateVerdicts !== undefined ? { gateVerdicts: extra.gateVerdicts } : {}),
    findingsLedger: extra.findingsLedger,
    loopExitReason: extra.loopExitReason,
    ...(extra.noCodeTestRationale !== undefined
      ? { noCodeTestRationale: extra.noCodeTestRationale }
      : {}),
  };
}

async function runCoderSelfReview(
  deps: TeamTaskDeps,
  input: {
    task: SizedTask;
    artifact: CoderResult;
    spec: string;
    context: string;
    tests: string[] | string;
  },
): Promise<{ artifact: CoderResult; revised: boolean }> {
  if (deps.coderSelfReview === undefined) {
    return { artifact: input.artifact, revised: false };
  }
  return deps.coderSelfReview(input);
}

async function revalidateQaDiff(
  deps: TeamTaskDeps,
  input: {
    task: SizedTask;
    qa: QaResult;
    diff: string;
    spec: string;
    context: string;
  },
): Promise<{ approved: boolean; notes?: string }> {
  if (deps.qaRevalidateDiff === undefined) {
    return { approved: true };
  }
  return deps.qaRevalidateDiff(input);
}

function diffBehaviorChanged(before: string, after: string): boolean {
  return normalizeDiffForBehavior(before) !== normalizeDiffForBehavior(after);
}

function normalizeDiffForBehavior(diff: string): string {
  return diff.replace(/\r\n?/g, '\n').trim();
}

export function buildGateRejectionFeedback(input: {
  rejectingRole: RoleName;
  counterpartRole: RoleName;
  artifact: GateRejectedArtifact;
  reason: string;
  actionableNotes?: string[];
}): GateRejectionFeedback {
  const reason = input.reason.trim() || `${input.rejectingRole} rejected ${input.artifact}`;
  const actionableNotes = input.actionableNotes?.map((note) => note.trim()).filter(Boolean);
  return {
    rejectingRole: input.rejectingRole,
    counterpartRole: input.counterpartRole,
    rejectedRole: input.counterpartRole,
    artifact: input.artifact,
    rejectedArtifact: input.artifact,
    reason,
    whatFailed: reason,
    notes: [reason],
    actionableNotes: actionableNotes !== undefined && actionableNotes.length > 0
      ? actionableNotes
      : [reason],
  };
}

function summarizeObjections(objections: ObjectionFinding[]): string {
  return objections
    .map((o) => `${o.class}/${o.severity} at ${o.location}: ${o.rationale}`)
    .join('; ');
}

function suggestedChangesFromVerdict(verdict: GateVerdict): string[] {
  const findingSuggestions = verdict.findings.flatMap((finding) =>
    suggestedChangeNotes(finding.suggestedChange));
  if (findingSuggestions.length > 0) return findingSuggestions;
  return suggestedChangeNotes(verdict.suggestedChange);
}

function suggestedChangeNotes(suggestedChange: string | undefined): string[] {
  const trimmed = suggestedChange?.trim();
  return trimmed ? [trimmed] : [];
}

function normalizeReviewerVerdict(verdict: ReviewerVerdict): NormalizedReviewerVerdict {
  const raw = verdict as Record<string, unknown>;
  const findings = findingsFromVerdict(raw);
  const verifiedFindings = findingVerificationsFromVerdict(raw);
  const hasVerifiedFindings = Array.isArray(raw['verifiedFindings']);
  const suggestedChange = typeof raw['suggestedChange'] === 'string'
    ? raw['suggestedChange']
    : undefined;
  const malformedClass = findings.find((finding) => !isObjectionClass(finding.class));
  if (malformedClass !== undefined) {
    const reason =
      `operational failure: reviewer-verdict contained unsupported class ` +
      `"${String(malformedClass.class)}" at ${malformedClass.location}`;
    return {
      outcome: 'fail',
      findings,
      objections: findings,
      notes: reason,
      ...(suggestedChange !== undefined ? { suggestedChange } : {}),
      ...(hasVerifiedFindings ? { verifiedFindings } : {}),
      operationalFailureReason: reason,
    };
  }
  const malformedSeverity = findings.find((finding) => !isObjectionSeverity(finding.severity));
  if (malformedSeverity !== undefined) {
    const reason =
      `operational failure: reviewer-verdict contained malformed severity ` +
      `"${String(malformedSeverity.severity)}" at ${malformedSeverity.location}`;
    return {
      outcome: 'fail',
      findings,
      objections: findings,
      notes: reason,
      ...(suggestedChange !== undefined ? { suggestedChange } : {}),
      ...(hasVerifiedFindings ? { verifiedFindings } : {}),
      operationalFailureReason: reason,
    };
  }
  const rawOutcome = raw['outcome'];
  if (rawOutcome !== undefined && !isReviewerOutcome(rawOutcome)) {
    const reason = `operational failure: reviewer-verdict contained unsupported outcome "${String(rawOutcome)}"`;
    return {
      outcome: 'fail',
      findings,
      objections: findings,
      notes: reason,
      ...(suggestedChange !== undefined ? { suggestedChange } : {}),
      ...(hasVerifiedFindings ? { verifiedFindings } : {}),
      operationalFailureReason: reason,
    };
  }
  const outcome = findings.length > 0
    ? outcomeForObjectionSeverities(findings)
    : isGateOutcome(rawOutcome)
      ? rawOutcome
      : raw['pass'] === true ? 'pass' : 'fail';
  return {
    outcome,
    findings,
    objections: findings,
    ...(hasVerifiedFindings ? { verifiedFindings } : {}),
    ...(verdict.notes !== undefined ? { notes: verdict.notes } : {}),
    ...(suggestedChange !== undefined ? { suggestedChange } : {}),
  };
}

function normalizeGateVerdict(verdict: GateReviewVerdict | undefined): GateVerdict {
  if (verdict === undefined) {
    return { outcome: 'fail', findings: [], notes: 'missing gate verdict — failing closed' };
  }
  const raw = verdict as Record<string, unknown>;
  const findings = findingsFromVerdict(raw);
  const suggestedChange = typeof raw['suggestedChange'] === 'string'
    ? raw['suggestedChange']
    : undefined;
  const malformedClass = findings.find((finding) => !isObjectionClass(finding.class));
  if (malformedClass !== undefined) {
    return {
      outcome: 'fail',
      findings,
      notes: `unsupported finding class "${String(malformedClass.class)}" at ${malformedClass.location}`,
      ...(suggestedChange !== undefined ? { suggestedChange } : {}),
    };
  }
  const malformedSeverity = findings.find((finding) => !isObjectionSeverity(finding.severity));
  if (malformedSeverity !== undefined) {
    return {
      outcome: 'fail',
      findings,
      notes: `unsupported finding severity "${String(malformedSeverity.severity)}" at ${malformedSeverity.location}`,
      ...(suggestedChange !== undefined ? { suggestedChange } : {}),
    };
  }
  const rawOutcome = raw['outcome'];
  const outcome = findings.length > 0
    ? outcomeForObjectionSeverities(findings)
    : isGateOutcome(rawOutcome)
      ? rawOutcome
      : raw['pass'] === true ? 'pass' : 'fail';
  const notes = typeof raw['notes'] === 'string' ? raw['notes'] : undefined;
  return {
    outcome,
    findings,
    ...(notes !== undefined ? { notes } : {}),
    ...(suggestedChange !== undefined ? { suggestedChange } : {}),
  };
}

function findingsFromVerdict(raw: Record<string, unknown>): ObjectionFinding[] {
  const source = Array.isArray(raw['findings'])
    ? raw['findings']
    : Array.isArray(raw['objections'])
      ? raw['objections']
      : [];
  return source.flatMap((item): ObjectionFinding[] => {
    if (!item || typeof item !== 'object') return [];
    const finding = item as Record<string, unknown>;
    if (
      typeof finding['class'] !== 'string' ||
      typeof finding['severity'] !== 'string' ||
      typeof finding['location'] !== 'string' ||
      typeof finding['rationale'] !== 'string'
    ) {
      return [];
    }
    return [{
      class: finding['class'] as ObjectionClass,
      severity: finding['severity'] as ObjectionSeverity,
      location: finding['location'],
      rationale: finding['rationale'],
      ...(typeof finding['suggestedChange'] === 'string'
        ? { suggestedChange: finding['suggestedChange'] }
        : {}),
      ...(typeof finding['reversible'] === 'boolean'
        ? { reversible: finding['reversible'] }
        : {}),
    }];
  });
}

function findingVerificationsFromVerdict(raw: Record<string, unknown>): FindingVerification[] {
  const source = Array.isArray(raw['verifiedFindings']) ? raw['verifiedFindings'] : [];
  return source.flatMap((item): FindingVerification[] => {
    if (!item || typeof item !== 'object') return [];
    const verification = item as Record<string, unknown>;
    if (
      typeof verification['id'] !== 'string' ||
      !isFindingStatus(verification['status']) ||
      typeof verification['notes'] !== 'string'
    ) {
      return [];
    }
    return [{
      id: verification['id'],
      status: verification['status'],
      notes: verification['notes'],
    }];
  });
}

function isFindingStatus(status: unknown): status is FindingStatus {
  return status === 'open' || status === 'resolved' || status === 'regressed';
}

function outcomeForObjectionSeverities(objections: ObjectionFinding[]): GateOutcome {
  return strictestReviewerOutcome(objections.map((objection) =>
    mapObjectionSeverityToOutcome(objection.severity)));
}

export function mapObjectionSeverityToOutcome(severity: ObjectionSeverity): GateOutcome {
  switch (severity) {
    case 'critical':
    case 'high':
    case 'medium':
      return 'fail';
    case 'low':
      return 'pass-with-warnings';
  }
}

function isObjectionSeverity(severity: unknown): severity is ObjectionSeverity {
  return (
    severity === 'low' ||
    severity === 'medium' ||
    severity === 'high' ||
    severity === 'critical'
  );
}

function isObjectionClass(objectionClass: unknown): objectionClass is ObjectionClass {
  return (
    objectionClass === 'security' ||
    objectionClass === 'privacy' ||
    objectionClass === 'data-integrity' ||
    objectionClass === 'concurrency' ||
    objectionClass === 'outbound' ||
    objectionClass === 'cost-perf'
  );
}

function isReviewerOutcome(outcome: unknown): outcome is ReviewerOutcome {
  return isGateOutcome(outcome);
}

function isGateOutcome(outcome: unknown): outcome is GateOutcome {
  return (
    outcome === 'pass' ||
    outcome === 'pass-with-warnings' ||
    outcome === 'fail'
  );
}

function strictestReviewerOutcome(outcomes: GateOutcome[]): GateOutcome {
  return outcomes.reduce(
    (strictest, outcome) =>
      reviewerOutcomeRank[outcome] > reviewerOutcomeRank[strictest] ? outcome : strictest,
    'pass',
  );
}

const reviewerOutcomeRank: Record<GateOutcome, number> = {
  pass: 0,
  'pass-with-warnings': 1,
  fail: 2,
};

function isReviewerPass(verdict: NormalizedReviewerVerdict): boolean {
  return verdict.outcome === 'pass' || verdict.outcome === 'pass-with-warnings';
}

function isGatePass(verdict: GateVerdict | undefined): boolean {
  return verdict === undefined ||
    verdict.outcome === 'pass' ||
    verdict.outcome === 'pass-with-warnings';
}

const severityRank: Record<ObjectionSeverity, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

const SEVERITY_LOOP_HARD_BUDGET = 4;

function maxOpenFindingSeverity(
  ledger: FindingsLedgerEntry[],
): ObjectionSeverity | undefined {
  return ledger
    .filter(isUnresolvedFinding)
    .map((entry) => entry.severity)
    .reduce<ObjectionSeverity | undefined>(
      (max, severity) =>
        max === undefined || severityRank[severity] > severityRank[max]
          ? severity
          : max,
      undefined,
    );
}

function firstNonReversibleHighSeverityFinding(
  ledger: FindingsLedgerEntry[],
  explicitNonReversibleFindingIds: Set<string>,
): FindingsLedgerEntry | undefined {
  return openFindingsLedger(ledger).find((entry) =>
    explicitNonReversibleFindingIds.has(entry.id) &&
    entry.reversible === false &&
    severityRank[entry.severity] >= severityRank.high);
}

function terminalHoldReason(finding: FindingsLedgerEntry): string {
  return `hold: non-reversible ${finding.severity} finding remains at terminal severity loop: ` +
    `${finding.class} at ${finding.location}: ${finding.rationale}`;
}

function coderFindingsLedger(
  ledger: FindingsLedgerEntry[],
): { findingsLedger?: FindingsLedgerEntry[] } {
  const open = openFindingsLedger(ledger);
  return open.length > 0 ? { findingsLedger: open } : {};
}

function openFindingsLedger(ledger: FindingsLedgerEntry[]): FindingsLedgerEntry[] {
  return ledger
    .filter(isUnresolvedFinding)
    .sort(compareFindingsForCoder)
    .map((entry) => ({ ...entry }));
}

function isUnresolvedFinding(entry: FindingsLedgerEntry): boolean {
  return entry.status === 'open' || entry.status === 'regressed';
}

function compareFindingsForCoder(
  a: FindingsLedgerEntry,
  b: FindingsLedgerEntry,
): number {
  const bySeverity = severityRank[b.severity] - severityRank[a.severity];
  if (bySeverity !== 0) return bySeverity;
  const byRound = a.raisedRound - b.raisedRound;
  if (byRound !== 0) return byRound;
  const byGate = sourceGateRank[a.sourceGate] - sourceGateRank[b.sourceGate];
  if (byGate !== 0) return byGate;
  return a.id.localeCompare(b.id);
}

const sourceGateRank: Record<FindingSourceGate, number> = {
  reviewer: 0,
  'tech-lead': 1,
  designer: 2,
};

function hasOnlySeverityDerivedFailures(
  reviewer: NormalizedReviewerVerdict | undefined,
  techLeadDiff: GateVerdict | undefined,
  designer: GateVerdict | undefined,
): boolean {
  const failureHasFindings: boolean[] = [];
  if (reviewer !== undefined && !isReviewerPass(reviewer)) {
    failureHasFindings.push(reviewer.findings.length > 0);
  }
  if (techLeadDiff !== undefined && !isGatePass(techLeadDiff)) {
    failureHasFindings.push(techLeadDiff.findings.length > 0);
  }
  if (designer !== undefined && !isGatePass(designer)) {
    failureHasFindings.push(designer.findings.length > 0);
  }
  return failureHasFindings.length > 0 && failureHasFindings.every(Boolean);
}

function emitTerminalObjections(
  input: TeamTaskRunInput,
  reviewer: NormalizedReviewerVerdict | undefined,
  techLeadDiff: GateVerdict | undefined,
  designer: GateVerdict | undefined,
): void {
  for (const finding of reviewer?.findings ?? []) {
    if (finding.severity !== 'low') {
      emitObjection(input, toPublicFinding(finding), 'reviewer', 'reviewer-verdict');
    }
  }
  for (const finding of techLeadDiff?.findings ?? []) {
    if (finding.severity !== 'low') {
      emitObjection(input, toPublicFinding(finding), 'tech-lead', 'implementation-diff');
    }
  }
  for (const finding of designer?.findings ?? []) {
    if (finding.severity !== 'low') {
      emitObjection(input, toPublicFinding(finding), 'designer', 'design-review');
    }
  }
}

function summarizeReviewerVerdict(verdict: NormalizedReviewerVerdict): string {
  if (verdict.findings.length > 0) {
    return summarizeObjections(verdict.findings);
  }
  if (verdict.notes?.trim()) {
    return verdict.notes.trim();
  }
  switch (verdict.outcome) {
    case 'pass':
      return 'reviewer passed implementation diff';
    case 'pass-with-warnings':
      return 'reviewer passed implementation diff with warnings';
    case 'fail':
      return 'reviewer rejected implementation diff';
  }
}

function buildWorkflowGateVerdicts(
  reviewer: NormalizedReviewerVerdict | undefined,
  techLeadDiff: GateVerdict | undefined,
  designer: GateVerdict | undefined,
): WorkflowGateVerdicts | undefined {
  const verdicts: WorkflowGateVerdicts = {};
  if (reviewer !== undefined) verdicts.reviewer = toPublicGateVerdict(reviewer);
  if (techLeadDiff !== undefined) verdicts.techLeadDiff = toPublicGateVerdict(techLeadDiff);
  if (designer !== undefined) verdicts.designer = toPublicGateVerdict(designer);
  return Object.keys(verdicts).length > 0 ? verdicts : undefined;
}

function toPublicGateVerdict(verdict: GateVerdict): GateVerdict {
  return {
    outcome: verdict.outcome,
    findings: verdict.findings.map(toPublicFinding),
    ...(verdict.notes !== undefined ? { notes: verdict.notes } : {}),
    ...(verdict.suggestedChange !== undefined ? { suggestedChange: verdict.suggestedChange } : {}),
  };
}

function toPublicFinding(finding: ObjectionFinding): ObjectionFinding {
  return {
    ...finding,
    reversible: typeof finding.reversible === 'boolean' ? finding.reversible : false,
  };
}

function mergeFindingsIntoLedger(
  ledger: FindingsLedgerEntry[],
  explicitNonReversibleFindingIds: Set<string>,
  sourceGate: FindingSourceGate,
  findings: ObjectionFinding[],
  round: number,
): void {
  for (const finding of findings) {
    const normalized = toPublicFinding(finding) as ObjectionFinding & { reversible: boolean };
    const id = buildFindingId(sourceGate, normalized);
    if (finding.reversible === false) {
      explicitNonReversibleFindingIds.add(id);
    } else {
      explicitNonReversibleFindingIds.delete(id);
    }
    const existing = ledger.find((entry) => entry.id === id);
    if (existing !== undefined) {
      const wasResolved = existing.status === 'resolved';
      existing.class = normalized.class;
      existing.severity = normalized.severity;
      existing.location = normalized.location;
      existing.rationale = normalized.rationale;
      if (normalized.suggestedChange !== undefined) {
        existing.suggestedChange = normalized.suggestedChange;
      } else {
        delete existing.suggestedChange;
      }
      existing.reversible = normalized.reversible;
      existing.status = wasResolved ? 'regressed' : 'open';
      continue;
    }
    ledger.push({
      id,
      sourceGate,
      class: normalized.class,
      severity: normalized.severity,
      location: normalized.location,
      rationale: normalized.rationale,
      ...(normalized.suggestedChange !== undefined
        ? { suggestedChange: normalized.suggestedChange }
        : {}),
      reversible: normalized.reversible,
      raisedRound: round,
      status: 'open',
    });
  }
}

function applyFindingVerifications(
  ledger: FindingsLedgerEntry[],
  verifications: FindingVerification[],
): void {
  for (const verification of verifications) {
    const existing = ledger.find((entry) => entry.id === verification.id);
    if (existing === undefined) continue;
    existing.status = verification.status;
  }
}

function reviewerVerificationAllowsCloseout(
  priorFindings: FindingsLedgerEntry[],
  verifications: FindingVerification[] | undefined,
  ledger: FindingsLedgerEntry[],
  hasRemainingConfiguredRound: boolean,
): boolean {
  if (priorFindings.length === 0) return true;
  if (verifications === undefined) {
    const maxSeverity = maxOpenFindingSeverity(ledger);
    return maxSeverity === undefined ||
      severityRank[maxSeverity] <= severityRank.low ||
      !hasRemainingConfiguredRound;
  }
  const verifiedIds = new Set(verifications.map((verification) => verification.id));
  if (!priorFindings.every((finding) => verifiedIds.has(finding.id))) {
    return false;
  }
  const maxSeverity = maxOpenFindingSeverity(ledger);
  return maxSeverity === undefined || severityRank[maxSeverity] <= severityRank.low;
}

function buildFindingId(
  sourceGate: FindingSourceGate,
  finding: ObjectionFinding,
): string {
  const seed = [
    sourceGate,
    finding.class,
    finding.location.trim(),
  ].join('|');
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `finding-${(hash >>> 0).toString(36)}`;
}

function normalizeFeedback(
  feedback: GateRejectionFeedback | GateRejectionFeedback[] | undefined,
): GateRejectionFeedback[] {
  if (feedback === undefined) return [];
  return Array.isArray(feedback) ? feedback : [feedback];
}

async function recordGateRejection(
  deps: TeamTaskDeps,
  feedback: GateRejectionFeedback,
): Promise<void> {
  try {
    await deps.onGateRejection?.(feedback);
  } catch {
    // Gate-time learning is best-effort. The structured feedback still drives
    // the corrective retry/block path even if lesson drafting or memory I/O fails.
  }
}

function emitRoleTransition(
  input: TeamTaskRunInput,
  fromRole: RoleName | undefined,
  role: RoleName,
  stage: string,
  transition: string,
): RoleName {
  emitRoleStage(input, role, stage);
  if (input.emit === undefined) return role;
  const label = `${role}: ${stage}`;
  try {
    input.emit({
      kind: 'activity',
      data: {
        event: 'role-transition',
        role,
        ...(fromRole !== undefined ? { fromRole } : {}),
        stage,
        transition,
        label,
        line: label,
      },
    });
  } catch {
    /* activity sinks are observability-only; they must not fail the task. */
  }
  return role;
}

function emitRoleStage(input: TeamTaskRunInput, role: RoleName, stage: string): void {
  if (input.emit === undefined) return;
  const label = `${role}: ${stage}`;
  try {
    input.emit({
      kind: 'activity',
      data: {
        event: 'role-stage',
        role,
        stage,
        label,
        line: label,
      },
    });
  } catch {
    /* activity sinks are observability-only; they must not fail the task. */
  }
}

function emitRoleVerdict(
  input: TeamTaskRunInput,
  event: {
    role: RoleName;
    gate: GateRejectedArtifact;
    verdict: 'pass' | 'fail';
    summary: string;
  },
): void {
  if (input.emit === undefined) return;
  const summary = event.summary.trim() || `${event.role} ${event.verdict}`;
  try {
    input.emit({
      kind: 'activity',
      data: {
        event: 'role-verdict',
        role: event.role,
        gate: event.gate,
        verdict: event.verdict,
        summary,
        line: `${event.role}: ${event.gate} ${event.verdict} - ${summary}`,
      },
    });
  } catch {
    /* activity sinks are observability-only; they must not fail the task. */
  }
}

function emitTestRepair(
  input: TeamTaskRunInput,
  repair: TechLeadTestRepairResult,
): void {
  if (input.emit === undefined) return;
  const summary = repair.kind === 'repaired'
    ? `patched ${repair.testIds.join(', ')}`
    : repair.reason;
  try {
    input.emit({
      kind: 'activity',
      data: {
        event: 'test-repair',
        role: 'tech-lead',
        gate: 'test-intent',
        outcome: repair.kind,
        summary,
        line: `tech-lead: test-intent repair ${repair.kind} - ${summary}`,
      },
    });
  } catch {
    /* activity sinks are observability-only; they must not fail the task. */
  }
}

function emitObjection(
  input: TeamTaskRunInput,
  objection: ObjectionFinding,
  role: RoleName,
  gate: GateRejectedArtifact,
): void {
  if (input.emit === undefined) return;
  const summary =
    `${objection.class}/${objection.severity} at ${objection.location}: ${objection.rationale}`;
  try {
    input.emit({
      kind: 'activity',
      data: {
        event: 'objection',
        role,
        gate,
        objection,
        summary,
        line: `${role} objection: ${summary}`,
      },
    });
  } catch {
    /* activity sinks are observability-only; they must not fail the task. */
  }
}

function emitGateRejection(
  input: TeamTaskRunInput,
  feedback: GateRejectionFeedback,
): void {
  if (input.emit === undefined) return;
  const summary = feedback.whatFailed.trim() || feedback.reason.trim();
  const line =
    `${feedback.rejectingRole}: ${feedback.rejectedArtifact} rejected ` +
    `${feedback.rejectedRole} - ${summary}`;
  try {
    input.emit({
      kind: 'activity',
      data: {
        event: 'gate-rejection',
        gate: feedback.rejectedArtifact,
        rejectingRole: feedback.rejectingRole,
        rejectedRole: feedback.rejectedRole,
        counterpartRole: feedback.counterpartRole,
        rejection: feedback,
        summary,
        line,
      },
    });
  } catch {
    /* activity sinks are observability-only; they must not fail the task. */
  }
}
