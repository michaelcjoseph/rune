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
 *     → cap reached: designer gate unmet ⇒ block; else PM wrap-up
 *         → PM resolves ⇒ ready-for-closeout; unresolved ⇒ blocked-on-human
 *
 * It does NOT mark `tasks.md`, write `context.md`, or merge — Jarvis owns
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
  | 'irreversibility'
  | 'cost-perf';

export type ObjectionSeverity = 'low' | 'medium' | 'high' | 'critical';

/** The machine-readable objection payload the reviewer role emits and the
 *  orchestrator gates on — distinct from a bare pass/fail. */
export interface ObjectionFinding {
  class: ObjectionClass;
  severity: ObjectionSeverity;
  location: string;
  rationale: string;
}

export type ReviewerOutcome = 'pass' | 'pass-with-warnings' | 'fail' | 'block';

export interface GateVerdict {
  outcome: ReviewerOutcome;
  findings: ObjectionFinding[];
  notes?: string;
}

/** The normalized reviewer's structured verdict carried in workflow evidence. */
export interface NormalizedReviewerVerdict extends GateVerdict {
  /** Legacy reviewer-evidence field retained for existing run-record consumers. */
  objections: ObjectionFinding[];
  /** Set when the reviewer payload itself is malformed and must fail closed operationally. */
  operationalBlockReason?: string;
}

/** The reviewer role boundary accepts legacy boolean verdicts while production
 *  seams migrate; workflow evidence is normalized to `NormalizedReviewerVerdict`
 *  before any gate or caller observes it. */
export interface ReviewerVerdict {
  outcome?: ReviewerOutcome;
  pass?: boolean;
  findings?: ObjectionFinding[];
  objections?: ObjectionFinding[];
  /** Optional notes for non-objection failures; finding details live in `findings`. */
  notes?: string;
}

export type GateReviewVerdict = GateVerdict | { pass: boolean; notes?: string };

export interface WorkflowGateVerdicts {
  reviewer?: GateVerdict;
  techLeadDiff?: GateVerdict;
  designer?: GateVerdict;
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
  }) => Promise<{ approved: boolean; notes?: string }>;
  coder: (input: {
    task: SizedTask;
    spec: string;
    context: string;
    tests: string[] | string;
    rejectionFeedback?: GateRejectionFeedback[];
  }) => Promise<CoderResult>;
  reviewer: (input: ReviewerInput) => Promise<ReviewerVerdict>;
  techLeadReviewDiff: (input: {
    task: SizedTask;
    diff: string;
  }) => Promise<GateReviewVerdict>;
  designer: (input: {
    task: SizedTask;
    diff: string;
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
 *  merging are Jarvis's closeout, not the workflow's. */
export interface TaskEvidence {
  taskId: string;
  outcome: WorkflowOutcome;
  /** The distinct roles that participated, in first-invocation order. This is a
   *  role-PRESENCE list (deduplicated), not a per-invocation count — a role that
   *  reviews twice (tech-lead: test intent then diff) appears once. */
  rolesInvoked: string[];
  reviewerVerdict?: ReviewerEvidence;
  gateVerdicts?: WorkflowGateVerdicts;
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
}

/** Run the team-task workflow for one selected task. */
export async function runTeamTaskWorkflow(
  task: SizedTask,
  input: TeamTaskRunInput,
  deps: TeamTaskDeps,
): Promise<TaskEvidence> {
  // A zero/negative cap would skip the round loop yet still reach PM wrap-up with
  // a "disagreement at the cap" reason no round produced — reject it loudly,
  // matching gen-eval-loop's `maxEvaluatorRounds` guard.
  if (input.cap < 1) {
    throw new RangeError(`runTeamTaskWorkflow: cap must be >= 1 (got ${input.cap})`);
  }

  const roles = new RoleLog();
  const handoffNotes: string[] = [];

  try {
    return await runGated(task, input, deps, roles, handoffNotes);
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
    };
  }
}

async function runGated(
  task: SizedTask,
  input: TeamTaskRunInput,
  deps: TeamTaskDeps,
  roles: RoleLog,
  handoffNotes: string[],
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
    const tlTests = await deps.techLeadReviewTests({ task, qa });
    emitRoleVerdict(input, {
      role: 'tech-lead',
      gate: 'test-intent',
      verdict: tlTests.approved ? 'pass' : 'fail',
      summary: tlTests.notes?.trim() || (tlTests.approved
        ? 'tech-lead approved test intent'
        : 'tech-lead rejected test intent'),
    });
    if (tlTests.approved) break;

    const reason = tlTests.notes?.trim() || 'tech-lead rejected test intent';
    qaFeedback = buildGateRejectionFeedback({
      rejectingRole: 'tech-lead',
      counterpartRole: 'qa',
      artifact: 'test-intent',
      reason,
    });
    await recordGateRejection(deps, qaFeedback);
    if (qaAttempt === input.cap - 1) {
      emitGateRejection(input, qaFeedback);
      return block(task, roles, handoffNotes, {
        blockedReason: reason,
        rejectionFeedback: qaFeedback,
        noCodeTestRationale,
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
    });
  }

  // Round loop — coder → reviewer → tech-lead diff → designer, bounded by cap.
  let lastReviewer: NormalizedReviewerVerdict | undefined;
  let lastTechLeadDiff: GateVerdict | undefined;
  let lastDesigner: GateVerdict | undefined;
  let lastRejectionFeedback: GateRejectionFeedback | undefined;
  let reviewerBlockCorrectionUsed = false;
  let coderAttemptsRemaining = input.cap;
  while (coderAttemptsRemaining > 0) {
    coderAttemptsRemaining -= 1;
    roles.add('coder');
    previousRole = emitRoleTransition(
      input,
      previousRole,
      'coder',
      'implementation',
      'coder-implementation',
    );
    const coder = await deps.coder({
      task,
      spec: input.spec,
      context: input.contextMd,
      tests,
      ...(coderFeedback.length > 0 ? { rejectionFeedback: coderFeedback } : {}),
    });
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
    lastReviewer = normalizeReviewerVerdict(await deps.reviewer({
      diff: coder.diff,
      spec: input.spec,
      tests,
      task,
      context: input.contextMd,
      reviewerProvider,
    }));
    emitRoleVerdict(input, {
      role: 'reviewer',
      gate: 'reviewer-verdict',
      verdict: isReviewerPass(lastReviewer) ? 'pass' : 'fail',
      summary: summarizeReviewerVerdict(lastReviewer),
    });
    if (lastReviewer.operationalBlockReason !== undefined) {
      const feedback = buildGateRejectionFeedback({
        rejectingRole: 'reviewer',
        counterpartRole: 'coder',
        artifact: 'reviewer-verdict',
        reason: lastReviewer.operationalBlockReason,
      });
      await recordGateRejection(deps, feedback);
      emitGateRejection(input, feedback);
      return block(task, roles, handoffNotes, {
        blockedReason: lastReviewer.operationalBlockReason,
        rejectionFeedback: feedback,
        reviewerVerdict: lastReviewer,
        gateVerdicts: buildWorkflowGateVerdicts(lastReviewer, undefined, undefined),
        objectionOpen: false,
        noCodeTestRationale,
      });
    }

    // Hard gate: an open objection-class finding gets one feedback-threaded
    // coder correction, then parks if the reviewer still blocks. PM wrap-up
    // authority does not extend here.
    if (isReviewerBlock(lastReviewer)) {
      const feedback = buildGateRejectionFeedback({
        rejectingRole: 'reviewer',
        counterpartRole: 'coder',
        artifact: 'reviewer-verdict',
        reason: summarizeReviewerVerdict(lastReviewer),
      });
      await recordGateRejection(deps, feedback);
      lastRejectionFeedback = feedback;
      if (!reviewerBlockCorrectionUsed) {
        reviewerBlockCorrectionUsed = true;
        coderFeedback = [feedback];
        coderAttemptsRemaining += 1;
        continue;
      }
      const acceptance = await maybeAcceptWithRationale(deps, {
        task,
        reason: feedback.whatFailed,
        reviewerVerdict: lastReviewer,
        rejectionFeedback: feedback,
      });
      if (acceptance === null) {
        emitGateRejection(input, feedback);
        return block(task, roles, handoffNotes, {
          blockedReason: 'accept-with-rationale override requires a non-empty rationale',
          rejectionFeedback: feedback,
          reviewerVerdict: lastReviewer,
          gateVerdicts: buildWorkflowGateVerdicts(lastReviewer, undefined, undefined),
          objectionOpen: true,
          noCodeTestRationale,
        });
      }
      if (acceptance !== undefined) {
        const acceptedReviewer = reviewerAcceptedWithWarnings(lastReviewer);
        return {
          taskId: task.id,
          outcome: 'ready-for-closeout',
          rolesInvoked: roles.list(),
          reviewerVerdict: acceptedReviewer,
          gateVerdicts: buildWorkflowGateVerdicts(acceptedReviewer, undefined, undefined),
          objectionOpen: false,
          handoffNotes,
          ...(noCodeTestRationale !== undefined ? { noCodeTestRationale } : {}),
          acceptance,
        };
      }
      for (const objection of lastReviewer.objections) {
        emitObjection(input, objection);
      }
      emitGateRejection(input, feedback);
      return block(task, roles, handoffNotes, {
        blockedReason: 'open objection-class finding',
        rejectionFeedback: feedback,
        reviewerVerdict: lastReviewer,
        gateVerdicts: buildWorkflowGateVerdicts(lastReviewer, undefined, undefined),
        objectionOpen: true,
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
      });
      await recordGateRejection(deps, feedback);
      lastRejectionFeedback = feedback;
      roundFeedback.push(feedback);
    }

    lastTechLeadDiff = normalizeGateVerdict(await deps.techLeadReviewDiff({ task, diff: coder.diff }));
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
        reason: lastTechLeadDiff.notes ?? 'tech-lead did not pass the implementation diff',
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
      lastDesigner = normalizeGateVerdict(await deps.designer({ task, diff: coder.diff }));
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
          reason: lastDesigner.notes ?? 'designer review failed',
        });
        await recordGateRejection(deps, feedback);
        lastRejectionFeedback = feedback;
        roundFeedback.push(feedback);
      }
    }

    if (isReviewerPass(lastReviewer) && isGatePass(lastTechLeadDiff) && isGatePass(lastDesigner)) {
      return {
        taskId: task.id,
        outcome: 'ready-for-closeout',
        rolesInvoked: roles.list(),
        reviewerVerdict: lastReviewer,
        gateVerdicts: buildWorkflowGateVerdicts(lastReviewer, lastTechLeadDiff, lastDesigner),
        objectionOpen: false,
        handoffNotes,
        ...(noCodeTestRationale !== undefined ? { noCodeTestRationale } : {}),
      };
    }
    // Non-objection disagreement → retry within the cap.
    if (roundFeedback.length > 0) {
      coderFeedback = roundFeedback;
    }
  }

  // Cap reached. A failed designer gate blocks (a UX defect is not PM-clearable);
  // otherwise non-objection disagreement routes to PM wrap-up.
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
      noCodeTestRationale,
    });
  }

  roles.add('pm');
  previousRole = emitRoleTransition(input, previousRole, 'pm', 'pm-wrapup', 'pm-wrapup');
  const pmReason = lastRejectionFeedback === undefined
    ? 'non-objection disagreement at the round cap'
    : `non-objection disagreement at the round cap: ${lastRejectionFeedback.whatFailed}`;
  const pm = await deps.pmWrapup({ task, reason: pmReason });
  emitRoleVerdict(input, {
    role: 'pm',
    gate: 'pm-wrapup',
    verdict: pm.resolved ? 'resolved' : 'unresolved',
    summary: pm.resolved
      ? 'PM resolved non-objection disagreement at the round cap'
      : 'PM left non-objection disagreement unresolved at the round cap',
  });
  if (pm.resolved) {
    const acceptance = acceptanceFromPmWrapup(pm);
    if (acceptance === null) {
      return block(task, roles, handoffNotes, {
        blockedReason: 'PM acceptance requires a non-empty rationale',
        ...(lastRejectionFeedback !== undefined
          ? { rejectionFeedback: lastRejectionFeedback }
          : {}),
        reviewerVerdict: lastReviewer,
        gateVerdicts: buildWorkflowGateVerdicts(lastReviewer, lastTechLeadDiff, lastDesigner),
        noCodeTestRationale,
      });
    }
    const acceptedReviewer = acceptance !== undefined
      ? reviewerAcceptedWithWarnings(lastReviewer)
      : lastReviewer;
    return {
      taskId: task.id,
      outcome: 'ready-for-closeout',
      rolesInvoked: roles.list(),
      reviewerVerdict: acceptedReviewer,
      gateVerdicts: buildWorkflowGateVerdicts(acceptedReviewer, lastTechLeadDiff, lastDesigner),
      objectionOpen: false,
      handoffNotes,
      ...(noCodeTestRationale !== undefined ? { noCodeTestRationale } : {}),
      ...(acceptance !== undefined ? { acceptance } : {}),
    };
  }
  if (lastRejectionFeedback !== undefined) {
    emitGateRejection(input, lastRejectionFeedback);
  }
  return block(task, roles, handoffNotes, {
    blockedReason: 'PM decision unresolved at the round cap',
    ...(lastRejectionFeedback !== undefined
      ? { rejectionFeedback: lastRejectionFeedback }
      : {}),
    reviewerVerdict: lastReviewer,
    gateVerdicts: buildWorkflowGateVerdicts(lastReviewer, lastTechLeadDiff, lastDesigner),
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
    ...(extra.noCodeTestRationale !== undefined
      ? { noCodeTestRationale: extra.noCodeTestRationale }
      : {}),
  };
}

function buildGateRejectionFeedback(input: {
  rejectingRole: RoleName;
  counterpartRole: RoleName;
  artifact: GateRejectedArtifact;
  reason: string;
}): GateRejectionFeedback {
  const reason = input.reason.trim() || `${input.rejectingRole} rejected ${input.artifact}`;
  return {
    rejectingRole: input.rejectingRole,
    counterpartRole: input.counterpartRole,
    rejectedRole: input.counterpartRole,
    artifact: input.artifact,
    rejectedArtifact: input.artifact,
    reason,
    whatFailed: reason,
    notes: [reason],
    actionableNotes: [reason],
  };
}

function summarizeObjections(objections: ObjectionFinding[]): string {
  return objections
    .map((o) => `${o.class}/${o.severity} at ${o.location}: ${o.rationale}`)
    .join('; ');
}

function normalizeReviewerVerdict(verdict: ReviewerVerdict): NormalizedReviewerVerdict {
  const raw = verdict as Record<string, unknown>;
  const findings = findingsFromVerdict(raw);
  const malformedSeverity = findings.find((finding) => !isObjectionSeverity(finding.severity));
  if (malformedSeverity !== undefined) {
    const reason =
      `operational block: reviewer-verdict contained malformed severity ` +
      `"${String(malformedSeverity.severity)}" at ${malformedSeverity.location}`;
    return {
      outcome: 'block',
      findings,
      objections: findings,
      notes: reason,
      operationalBlockReason: reason,
    };
  }
  const rawOutcome = raw['outcome'];
  if (rawOutcome !== undefined && !isReviewerOutcome(rawOutcome)) {
    const reason = `operational block: reviewer-verdict contained unsupported outcome "${String(rawOutcome)}"`;
    return {
      outcome: 'block',
      findings,
      objections: findings,
      notes: reason,
      operationalBlockReason: reason,
    };
  }
  const outcomes: ReviewerOutcome[] = [];
  if (findings.length > 0) {
    outcomes.push(outcomeForObjectionSeverities(findings));
  } else if (isReviewerOutcome(rawOutcome)) {
    outcomes.push(rawOutcome);
  } else {
    outcomes.push(raw['pass'] === true ? 'pass' : 'fail');
  }
  const outcome = strictestReviewerOutcome(outcomes);
  return {
    outcome,
    findings,
    objections: findings,
    ...(verdict.notes !== undefined ? { notes: verdict.notes } : {}),
  };
}

function normalizeGateVerdict(verdict: GateReviewVerdict | undefined): GateVerdict {
  if (verdict === undefined) {
    return { outcome: 'fail', findings: [], notes: 'missing gate verdict — failing closed' };
  }
  const raw = verdict as Record<string, unknown>;
  const findings = findingsFromVerdict(raw);
  const rawOutcome = raw['outcome'];
  const outcome = isReviewerOutcome(rawOutcome)
    ? rawOutcome
    : raw['pass'] === true
      ? 'pass'
      : 'fail';
  const notes = typeof raw['notes'] === 'string' ? raw['notes'] : undefined;
  return {
    outcome: strictestReviewerOutcome([
      outcome,
      ...(findings.length > 0 ? [outcomeForObjectionSeverities(findings)] : []),
    ]),
    findings,
    ...(notes !== undefined ? { notes } : {}),
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
    }];
  });
}

function outcomeForObjectionSeverities(objections: ObjectionFinding[]): ReviewerOutcome {
  return strictestReviewerOutcome(objections.map((objection) =>
    mapObjectionSeverityToOutcome(objection.severity)));
}

export function mapObjectionSeverityToOutcome(severity: ObjectionSeverity): ReviewerOutcome {
  switch (severity) {
    case 'critical':
    case 'high':
      return 'block';
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

function isReviewerOutcome(outcome: unknown): outcome is ReviewerOutcome {
  return (
    outcome === 'pass' ||
    outcome === 'pass-with-warnings' ||
    outcome === 'fail' ||
    outcome === 'block'
  );
}

function strictestReviewerOutcome(outcomes: ReviewerOutcome[]): ReviewerOutcome {
  return outcomes.reduce(
    (strictest, outcome) =>
      reviewerOutcomeRank[outcome] > reviewerOutcomeRank[strictest] ? outcome : strictest,
    'pass',
  );
}

const reviewerOutcomeRank: Record<ReviewerOutcome, number> = {
  pass: 0,
  'pass-with-warnings': 1,
  fail: 2,
  block: 3,
};

function isReviewerPass(verdict: NormalizedReviewerVerdict): boolean {
  return verdict.outcome === 'pass' || verdict.outcome === 'pass-with-warnings';
}

function isGatePass(verdict: GateVerdict | undefined): boolean {
  return verdict === undefined ||
    verdict.outcome === 'pass' ||
    verdict.outcome === 'pass-with-warnings';
}

function isReviewerBlock(verdict: NormalizedReviewerVerdict): boolean {
  return verdict.outcome === 'block';
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
    case 'block':
      return 'reviewer blocked implementation diff';
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
    findings: verdict.findings.map((finding) => ({ ...finding })),
    ...(verdict.notes !== undefined ? { notes: verdict.notes } : {}),
  };
}

function reviewerAcceptedWithWarnings(
  verdict: NormalizedReviewerVerdict | undefined,
): NormalizedReviewerVerdict | undefined {
  if (
    verdict === undefined ||
    (verdict.outcome !== 'block' && (verdict.outcome !== 'fail' || verdict.findings.length > 0))
  ) {
    return verdict;
  }
  return {
    ...verdict,
    outcome: 'pass-with-warnings',
  };
}

function normalizeFeedback(
  feedback: GateRejectionFeedback | GateRejectionFeedback[] | undefined,
): GateRejectionFeedback[] {
  if (feedback === undefined) return [];
  return Array.isArray(feedback) ? feedback : [feedback];
}

function acceptanceFromPmWrapup(pm: {
  resolved: boolean;
  rationale?: string;
}): PmAcceptance | undefined | null {
  if (!Object.hasOwn(pm, 'rationale')) return undefined;
  const rationale = pm.rationale?.trim() ?? '';
  if (rationale.length === 0) return null;
  return {
    actor: 'pm',
    decision: 'accepted-with-rationale',
    rationale,
  };
}

async function maybeAcceptWithRationale(
  deps: TeamTaskDeps,
  input: AcceptWithRationaleInput,
): Promise<PmAcceptance | undefined | null> {
  if (deps.acceptWithRationale === undefined) return undefined;
  const result = await deps.acceptWithRationale(input);
  if (!result.accepted) return undefined;
  const rationale = result.rationale?.trim() ?? '';
  if (rationale.length === 0) return null;
  return {
    actor: result.actor,
    decision: 'accepted-with-rationale',
    rationale,
  };
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
    gate: GateRejectedArtifact | 'pm-wrapup';
    verdict: 'pass' | 'fail' | 'resolved' | 'unresolved';
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

function emitObjection(input: TeamTaskRunInput, objection: ObjectionFinding): void {
  if (input.emit === undefined) return;
  const summary =
    `${objection.class}/${objection.severity} at ${objection.location}: ${objection.rationale}`;
  try {
    input.emit({
      kind: 'activity',
      data: {
        event: 'objection',
        role: 'reviewer',
        gate: 'reviewer-verdict',
        objection,
        summary,
        line: `reviewer objection: ${summary}`,
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
