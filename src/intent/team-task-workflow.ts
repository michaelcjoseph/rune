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

/** The reviewer's structured verdict. */
export interface ReviewerVerdict {
  pass: boolean;
  objections: ObjectionFinding[];
  /** Optional notes for non-objection failures; objection details live in `objections`. */
  notes?: string;
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
  }) => Promise<{ pass: boolean; notes?: string }>;
  designer: (input: {
    task: SizedTask;
    diff: string;
  }) => Promise<{ pass: boolean; notes?: string }>;
  pmWrapup: (input: { task: SizedTask; reason: string }) => Promise<{ resolved: boolean }>;
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
  reviewerVerdict?: ReviewerVerdict;
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
    return block(task, roles, handoffNotes, {
      blockedReason: 'reviewer independence: no distinct-provider reviewer available',
    });
  }

  // Gate 1: QA-first — tests (or a no-code-test rationale) before the coder.
  const carriedFeedback = normalizeFeedback(input.rejectionFeedback);
  let qaFeedback = carriedFeedback.find((feedback) => feedback.rejectedRole === 'qa');
  let coderFeedback = carriedFeedback.filter((feedback) => feedback.rejectedRole === 'coder');
  let qa: QaResult | undefined;
  let noCodeTestRationale: string | undefined;
  let tests: string[] | string | undefined;
  for (let qaAttempt = 0; qaAttempt < input.cap; qaAttempt++) {
    roles.add('qa');
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
    const tlTests = await deps.techLeadReviewTests({ task, qa });
    if (tlTests.approved) break;

    const reason = tlTests.notes?.trim() || 'tech-lead rejected test intent';
    qaFeedback = buildGateRejectionFeedback({
      rejectingRole: 'tech-lead',
      counterpartRole: 'qa',
      artifact: 'test-intent',
      reason,
    });
    if (qaAttempt === input.cap - 1) {
      return block(task, roles, handoffNotes, {
        blockedReason: reason,
        rejectionFeedback: qaFeedback,
        noCodeTestRationale,
      });
    }
  }
  if (qa === undefined || tests === undefined) {
    return block(task, roles, handoffNotes, {
      blockedReason: 'QA test intent was not produced',
    });
  }

  // Round loop — coder → reviewer → tech-lead diff → designer, bounded by cap.
  let lastReviewer: ReviewerVerdict | undefined;
  let lastDesignerPass = true;
  let lastRejectionFeedback: GateRejectionFeedback | undefined;
  for (let attempt = 0; attempt < input.cap; attempt++) {
    roles.add('coder');
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
    lastReviewer = await deps.reviewer({
      diff: coder.diff,
      spec: input.spec,
      tests,
      task,
      context: input.contextMd,
      reviewerProvider,
    });

    // Hard gate: an open objection-class finding blocks immediately. PM wrap-up
    // authority does not extend here.
    if (lastReviewer.objections.length > 0) {
      const feedback = buildGateRejectionFeedback({
        rejectingRole: 'reviewer',
        counterpartRole: 'coder',
        artifact: 'reviewer-verdict',
        reason: summarizeObjections(lastReviewer.objections),
      });
      return block(task, roles, handoffNotes, {
        blockedReason: 'open objection-class finding',
        rejectionFeedback: feedback,
        reviewerVerdict: lastReviewer,
        objectionOpen: true,
        noCodeTestRationale,
      });
    }
    if (!lastReviewer.pass) {
      const feedback = buildGateRejectionFeedback({
        rejectingRole: 'reviewer',
        counterpartRole: 'coder',
        artifact: 'reviewer-verdict',
        reason:
          lastReviewer.notes?.trim() || 'reviewer did not pass the implementation diff',
      });
      lastRejectionFeedback = feedback;
      roundFeedback.push(feedback);
    }

    const tlDiff = await deps.techLeadReviewDiff({ task, diff: coder.diff });
    if (!tlDiff.pass) {
      const feedback = buildGateRejectionFeedback({
        rejectingRole: 'tech-lead',
        counterpartRole: 'coder',
        artifact: 'implementation-diff',
        reason: tlDiff.notes ?? 'tech-lead did not pass the implementation diff',
      });
      lastRejectionFeedback = feedback;
      roundFeedback.push(feedback);
    }

    lastDesignerPass = true;
    if (task.designerNeeded) {
      roles.add('designer');
      const designer = await deps.designer({ task, diff: coder.diff });
      lastDesignerPass = designer.pass;
      if (!designer.pass) {
        const feedback = buildGateRejectionFeedback({
          rejectingRole: 'designer',
          counterpartRole: 'coder',
          artifact: 'design-review',
          reason: designer.notes ?? 'designer review failed',
        });
        lastRejectionFeedback = feedback;
        roundFeedback.push(feedback);
      }
    }

    if (lastReviewer.pass && tlDiff.pass && lastDesignerPass) {
      return {
        taskId: task.id,
        outcome: 'ready-for-closeout',
        rolesInvoked: roles.list(),
        reviewerVerdict: lastReviewer,
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
  if (task.designerNeeded && !lastDesignerPass) {
    return block(task, roles, handoffNotes, {
      blockedReason: 'designer review failed at the round cap',
      ...(lastRejectionFeedback !== undefined
        ? { rejectionFeedback: lastRejectionFeedback }
        : {}),
      reviewerVerdict: lastReviewer,
      noCodeTestRationale,
    });
  }

  roles.add('pm');
  const pm = await deps.pmWrapup({ task, reason: 'non-objection disagreement at the round cap' });
  if (pm.resolved) {
    return {
      taskId: task.id,
      outcome: 'ready-for-closeout',
      rolesInvoked: roles.list(),
      reviewerVerdict: lastReviewer,
      objectionOpen: false,
      handoffNotes,
      ...(noCodeTestRationale !== undefined ? { noCodeTestRationale } : {}),
    };
  }
  return block(task, roles, handoffNotes, {
    blockedReason: 'PM decision unresolved at the round cap',
    ...(lastRejectionFeedback !== undefined
      ? { rejectionFeedback: lastRejectionFeedback }
      : {}),
    reviewerVerdict: lastReviewer,
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
    reviewerVerdict?: ReviewerVerdict;
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

function normalizeFeedback(
  feedback: GateRejectionFeedback | GateRejectionFeedback[] | undefined,
): GateRejectionFeedback[] {
  if (feedback === undefined) return [];
  return Array.isArray(feedback) ? feedback : [feedback];
}
