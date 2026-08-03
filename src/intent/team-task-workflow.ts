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
 *         → coder self-review + canonical Git capture
 *         → QA/reviewer/tech-lead/(conditional) designer judge concurrently
 *         → verdicts/findings merge in stable role order
 *         → open objection-class finding ⇒ hard block (PM can't clear it)
 *         → all gates green ⇒ ready-for-closeout
 *     → cap reached: return machine terminal evidence; never PM wrap-up /
 *       blocked-on-human from a per-task path
 *
 * It does NOT mark `tasks.md`, write `context.md`, or merge — Rune owns
 * closeout. Every role is an injected seam, so the whole flow runs on fixtures
 * with no live model call.
 */

import { randomUUID } from 'node:crypto';
import type { SizedTask } from './planning-roles.js';
import type { TaskValidationFailure } from './task-validation.js';
import type { DispatchProvider } from './dispatch.js';
import type { RoleName } from '../roles/loader.js';
import type { OperationCancellation } from '../cancellation.js';
import type { ExecutionPreflightFailure } from './execution-preflight.js';
import {
  executionFailureSummary,
  type ArtifactAttemptEvidence,
  type ExecutionFailure,
} from './execution-failure.js';
import type { RelatedTestDiagnostic } from './related-test-diagnostic.js';
import type {
  DurableValidationReceipt,
  FullSuiteAttestation,
} from './full-suite-attestation.js';
import { isGitObjectId } from './git-object-id.js';
export { isGitObjectId } from './git-object-id.js';
import { scrubAbsolutePaths } from '../utils/sanitize-paths.js';

export interface RoleCancellation extends OperationCancellation {
  role: RoleName;
}

/** Typed control-flow error used only at role/executor boundaries. Ordinary
 * role failures remain normal errors and retain the existing blocked path. */
export class RoleCancellationError extends Error {
  readonly cancellation: RoleCancellation;

  constructor(role: RoleName, cancellation: OperationCancellation) {
    super(`${role} cancelled`);
    this.name = 'RoleCancellationError';
    this.cancellation = { role, ...cancellation };
  }
}

export class ExecutionFailureError extends Error {
  readonly failure: ExecutionFailure;

  constructor(failure: ExecutionFailure) {
    super(executionFailureSummary(failure));
    this.name = 'ExecutionFailureError';
    this.failure = failure;
  }
}

/** Operational hold raised when a previously admitted validation capability
 * becomes unavailable while work-in-progress is being repaired. */
export class ValidationProfileUnavailableError extends Error {
  readonly failure: TaskValidationFailure;

  constructor(failure: TaskValidationFailure) {
    super(failure.diagnostics);
    this.name = 'ValidationProfileUnavailableError';
    this.failure = failure;
  }
}

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

export type CoderSelfReviewOutcome = 'confirmed' | 'revised';

/** Bounds on durable coder-self-review evidence. The parser that admits a
 * self-review reply (`jobs/team-task-deps`), the in-flight record built below,
 * and the durable task record (`orch-run-record`) all bound the same fields —
 * they share these constants so a change in one layer cannot silently truncate
 * evidence in another. */
export const SELF_REVIEW_NOTE_MAX_CHARS = 2_000;
/** Changed paths carried alongside any canonical review state — the capture
 * itself (`jobs/canonical-git`), the self-review record, and the durable task
 * record. */
export const CANONICAL_CHANGED_PATHS_MAX = 200;

/** One successful worktree-editing coder self-review. The canonical diff stays
 * transient; only this bounded metadata is persisted with task evidence. */
export interface CoderSelfReviewRecord {
  round: number;
  outcome: CoderSelfReviewOutcome;
  notes: string;
  canonicalHash: string;
  /** Optional for historical records written before full-task review capture. */
  taskBaseTree?: string;
  /** Optional for historical records written before full-task review capture. */
  currentReviewTree?: string;
  changedPaths: string[];
  /** Bounded terminal-artifact attempts; optional for historical records. */
  artifactAttempts?: ArtifactAttemptEvidence[];
}

/** Git object-id shape (SHA-1, or SHA-256 for a repo using that hash). Declared
 * here, beside `CanonicalReviewState`, because every consumer of a tree/commit
 * OID in that contract must agree on the shape: the capture boundary
 * (`jobs/canonical-git`, which re-exports this), the orchestrator's cursor
 * guard, the durable cursor store, and the Cockpit diagnostics projection. A
 * second copy could silently widen or narrow what one of them accepts. This
 * module holds it rather than `jobs/canonical-git` so `intent/` consumers keep
 * their no-import-from-`jobs/` purity boundary. */
/** The worktree state captured with canonical Git after a coder self-review. */
export interface CanonicalReviewState {
  diff: string;
  hash: string;
  /** Stable tree captured before any mutation for this task. */
  baseTree: string;
  /** Staged tree whose full-task diff was presented to every judgment role. */
  currentTree: string;
  changedPaths: string[];
}

export interface CoderSelfReviewResult {
  outcome: CoderSelfReviewOutcome;
  notes: string;
  reviewState: CanonicalReviewState;
  artifactAttempts?: ArtifactAttemptEvidence[];
}

/** Evidence that a later mechanical gate changed the canonical surface that
 * downstream roles approved. Raw diffs never enter durable failure records. */
export interface ReviewSurfaceFailure {
  kind: 'candidate-mismatch';
  canonicalHash: string;
  candidateHash: string;
  taskBaseTree?: string;
  canonicalTree?: string;
  candidateTree?: string;
  changedPaths: string[];
}

/** What the reviewer receives — artifacts only, never coder hidden reasoning. */
export interface ReviewerInput {
  diff: string;
  reviewState?: Omit<CanonicalReviewState, 'diff'>;
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
  judgmentContext?: JudgmentContext;
  judgmentBatchId?: string;
}

/** The roles that judge the coder's diff. QA is deliberately absent: QA authors
 *  the tests and stops when the coder starts. Its former `diff-revalidation`
 *  stage read the same artifact the reviewer and tech lead read, returned a bare
 *  boolean with no room for a file or a failing test name, and ran on the
 *  coder's own provider family — the one gate that violated the distinct-provider
 *  review rule. The test-integrity questions it nominally owned are now part of
 *  the tech lead's diff review, which already reads the test files. */
export type JudgmentRole = 'reviewer' | 'tech-lead' | 'designer';

/** One immutable canonical snapshot shared by every eligible post-coder
 * judgment in a round. Role-specific legacy fields remain on each input for
 * compatibility, but this object is the fan-out source of truth. */
export interface JudgmentContext {
  readonly task: SizedTask;
  readonly spec: string;
  readonly projectContext: string;
  readonly tests: string[] | string;
  readonly qa: QaResult;
  readonly diff: string;
  readonly reviewState: Omit<CanonicalReviewState, 'diff'>;
  readonly findingsLedger: readonly FindingsLedgerEntry[];
  readonly coderHandoffNotes: readonly string[];
  readonly artifactPass: 'first-pass' | 'coder-retry' | 'closeout-retry';
}

export interface JudgmentOutcomeEvidence {
  role: JudgmentRole;
  status: 'pass' | 'reject' | 'failed' | 'cancelled';
  /** Bounded, scrubbed by the role/provider boundary before it reaches here. */
  summary?: string;
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
    reviewState?: Omit<CanonicalReviewState, 'diff'>;
    judgmentContext?: JudgmentContext;
    judgmentBatchId?: string;
  }) => Promise<GateReviewVerdict>;
  designer: (input: {
    task: SizedTask;
    diff: string;
    findingsLedger?: FindingsLedgerEntry[];
    reviewState?: Omit<CanonicalReviewState, 'diff'>;
    spec?: string;
    context?: string;
    tests?: string[] | string;
    qa?: QaResult;
    coderHandoffNotes?: string[];
    judgmentContext?: JudgmentContext;
    judgmentBatchId?: string;
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
  /** Best-effort internal cleanup for a failed judgment batch. */
  cancelJudgmentBatch?: (batchId: string) => void;
  /** Escalate a SIGTERM-ignoring judgment batch to process-group SIGKILL. */
  forceCancelJudgmentBatch?: (batchId: string) => void;
  /** Release internal cancellation correlation after every member settles. */
  finishJudgmentBatch?: (batchId: string) => void | Promise<void>;
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
  /** Whole-workflow attempt number: 1 initially, >1 for closeout repair. */
  workflowAttempt?: number;
}

export type WorkflowOutcome = 'ready-for-closeout' | 'blocked' | 'failed' | 'cancelled';

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
  /** Present only for a fail-closed executor prerequisite block. Ordinary
   * post-preflight role failures continue to use `failureReason`. */
  executionPreflight?: ExecutionPreflightFailure;
  /** Typed durable failure from a role executor or its orchestration boundary. */
  executionFailure?: ExecutionFailure;
  /** Missing/unusable/failed mechanical validation evidence. */
  taskValidationFailure?: TaskValidationFailure;
  /** Typed `vitest related` closeout result. Optional for historical evidence. */
  relatedTestDiagnostic?: RelatedTestDiagnostic;
  /** Rune-owned full-suite evidence, absent on legacy or unsupported runners. */
  fullSuiteAttestation?: FullSuiteAttestation;
  /** Compact closeout provenance safe for transcripts and Cockpit. */
  validationReceipt?: DurableValidationReceipt;
  /** Fail-closed review-surface mismatch; never carries raw diff content. */
  reviewSurfaceFailure?: ReviewSurfaceFailure;
  /** Scrubbed canonical review-surface hash approved by downstream roles.
   *
   * Deliberately separate from `fullTaskReviewHash` below even though the two
   * currently always hold the same value. They answer different questions and
   * are populated from different scopes: this one is the *approval* identity —
   * set only where the gates actually cleared (`approvedReviewSurfaceHash` on
   * the `ready-for-closeout` terminals), and it is what closeout re-verifies
   * before committing. `fullTaskReviewHash` is *evidence* — recorded from the
   * per-round collector onto every terminal, including cancelled and failed
   * ones that never produced an approval. Collapsing them would make an
   * unapproved terminal's evidence hash indistinguishable from an approval and
   * silently weaken the closeout gate. */
  reviewSurfaceHash?: string;
  /** Stable task-start tree. Optional so historical evidence remains readable. */
  taskBaseTree?: string;
  /** Exact staged tree judged by downstream roles. */
  currentReviewTree?: string;
  /** Hash of the complete implementation diff relative to task base. Evidence
   * on every terminal — see `reviewSurfaceHash` for why the two are distinct. */
  fullTaskReviewHash?: string;
  /** Successful coder self-reviews, one per implementation round. Optional so
   * historical persisted records remain readable. */
  coderSelfReviews?: CoderSelfReviewRecord[];
  /** Structured role-gate feedback for corrective retries / learning. */
  rejectionFeedback?: GateRejectionFeedback;
  /** Set on a `failed` outcome — the structured reason a role seam rejected
   *  (for the Phase 5 retry / model-swap decision). */
  failureReason?: string;
  /** Present only when a live role child was explicitly cancelled. */
  cancellation?: RoleCancellation;
  /** Human/PM acceptance evidence when non-objection disagreement is cleared. */
  acceptance?: PmAcceptance;
  /** Set when the tech-lead attempted a test-intent repair this task. */
  testIntentRepair?: {
    outcome: 'repaired' | 'not-repaired';
    reason?: string;
    testIds?: string[];
  };
  /** Latest post-coder batch outcomes in stable role order. Optional for
   * historical evidence written before judgment fan-out. */
  judgmentOutcomes?: JudgmentOutcomeEvidence[];
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
  const coderSelfReviews: CoderSelfReviewRecord[] = [];
  const reviewEvidence: Pick<
    TaskEvidence,
    'taskBaseTree' | 'currentReviewTree' | 'fullTaskReviewHash' | 'reviewSurfaceHash'
  > = {};
  const findingsEvidence: FindingsLedgerEntry[] = [];
  const judgmentOutcomes: JudgmentOutcomeEvidence[] = [];

  try {
    const evidence = await runGated(
      task,
      input,
      deps,
      roles,
      handoffNotes,
      repairEvidence,
      coderSelfReviews,
      reviewEvidence,
      findingsEvidence,
      judgmentOutcomes,
    );
    return {
      ...evidence,
      ...reviewEvidence,
      coderSelfReviews: [...coderSelfReviews],
      ...(judgmentOutcomes.length > 0
        ? { judgmentOutcomes: [...judgmentOutcomes] }
        : {}),
      ...(repairEvidence.testIntentRepair !== undefined
        ? { testIntentRepair: repairEvidence.testIntentRepair }
        : {}),
    };
  } catch (err) {
    if (err instanceof RoleCancellationError) {
      return {
        taskId: task.id,
        outcome: 'cancelled',
        rolesInvoked: roles.list(),
        objectionOpen: false,
        handoffNotes,
        cancellation: err.cancellation,
        findingsLedger: [...findingsEvidence],
        loopExitReason: 'operational',
        ...reviewEvidence,
        coderSelfReviews: [...coderSelfReviews],
        ...(judgmentOutcomes.length > 0
          ? { judgmentOutcomes: [...judgmentOutcomes] }
          : {}),
        ...(repairEvidence.testIntentRepair !== undefined
          ? { testIntentRepair: repairEvidence.testIntentRepair }
          : {}),
      };
    }
    if (err instanceof ValidationProfileUnavailableError) {
      return {
        taskId: task.id,
        outcome: 'blocked',
        rolesInvoked: roles.list(),
        objectionOpen: false,
        handoffNotes,
        blockedReason: 'validation capability profile became unavailable; preserving work in progress',
        taskValidationFailure: err.failure,
        findingsLedger: [...findingsEvidence],
        loopExitReason: 'operational',
        ...reviewEvidence,
        coderSelfReviews: [...coderSelfReviews],
        ...(judgmentOutcomes.length > 0
          ? { judgmentOutcomes: [...judgmentOutcomes] }
          : {}),
        ...(repairEvidence.testIntentRepair !== undefined
          ? { testIntentRepair: repairEvidence.testIntentRepair }
          : {}),
      };
    }
    if (err instanceof ExecutionFailureError) {
      return {
        taskId: task.id,
        outcome: 'failed',
        rolesInvoked: roles.list(),
        objectionOpen: false,
        handoffNotes,
        executionFailure: err.failure,
        failureReason: executionFailureSummary(err.failure),
        findingsLedger: [...findingsEvidence],
        loopExitReason: 'operational',
        ...reviewEvidence,
        coderSelfReviews: [...coderSelfReviews],
        ...(judgmentOutcomes.length > 0
          ? { judgmentOutcomes: [...judgmentOutcomes] }
          : {}),
        ...(repairEvidence.testIntentRepair !== undefined
          ? { testIntentRepair: repairEvidence.testIntentRepair }
          : {}),
      };
    }
    // A role seam rejected — surface it as structured `failed` evidence rather
    // than an unhandled rejection, so the Phase 5 loop can decide retry/model-swap.
    return {
      taskId: task.id,
      outcome: 'failed',
      rolesInvoked: roles.list(),
      objectionOpen: false,
      handoffNotes,
      failureReason: (err as Error).message,
      findingsLedger: [...findingsEvidence],
      loopExitReason: 'operational',
      ...reviewEvidence,
      coderSelfReviews: [...coderSelfReviews],
      ...(judgmentOutcomes.length > 0
        ? { judgmentOutcomes: [...judgmentOutcomes] }
        : {}),
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
  coderSelfReviews: CoderSelfReviewRecord[],
  reviewEvidence: Pick<
    TaskEvidence,
    'taskBaseTree' | 'currentReviewTree' | 'fullTaskReviewHash' | 'reviewSurfaceHash'
  >,
  findingsLedger: FindingsLedgerEntry[],
  judgmentOutcomes: JudgmentOutcomeEvidence[],
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
        if (
          err instanceof RoleCancellationError ||
          err instanceof ValidationProfileUnavailableError
        ) throw err;
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
  let approvedReviewSurfaceHash: string | undefined;
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
    const coder = await deps.coder({
      task,
      spec: input.spec,
      context: input.contextMd,
      tests,
      ...(coderFeedback.length > 0 ? { rejectionFeedback: coderFeedback } : {}),
      ...coderFindingsLedger(findingsLedger),
    });
    emitRoleStage(input, 'coder', 'self-review');
    const reviewed = await deps.coderSelfReview({
      task,
      artifact: coder,
      spec: input.spec,
      context: input.contextMd,
      tests,
      qa,
      ...(coderFeedback.length > 0 ? { rejectionFeedback: coderFeedback } : {}),
      ...coderFindingsLedger(findingsLedger),
    });
    const selfReviewRecord: CoderSelfReviewRecord = {
      round,
      outcome: reviewed.outcome,
      notes: reviewed.notes,
      canonicalHash: reviewed.reviewState.hash,
      taskBaseTree: reviewed.reviewState.baseTree,
      currentReviewTree: reviewed.reviewState.currentTree,
      changedPaths: reviewed.reviewState.changedPaths.slice(
        0,
        CANONICAL_CHANGED_PATHS_MAX,
      ),
      ...(reviewed.artifactAttempts !== undefined
        ? {
            artifactAttempts: reviewed.artifactAttempts.map((attempt) => ({
              ...attempt,
            })),
          }
        : {}),
    };
    coderSelfReviews.push(selfReviewRecord);
    emitCoderSelfReview(input, selfReviewRecord);
    // A `revised` self-review edited the worktree after the coder handed off,
    // so the canonical diff downstream roles judge is no longer the one the
    // coder's own notes describe. The self-review notes are the only channel
    // explaining what changed and why — including a justified test removal,
    // which the reviewer and tech lead look for in the handoff notes — so they
    // join the coder's notes rather than staying evidence-only. Already
    // scrubbed by the self-review parser.
    const canonicalCoder = {
      ...coder,
      diff: reviewed.reviewState.diff,
      handoffNotes:
        reviewed.outcome === 'revised'
          ? [...coder.handoffNotes, `coder self-review (revised): ${reviewed.notes}`]
          : coder.handoffNotes,
    };
    // Same value, three destinations, on purpose: `approvedReviewSurfaceHash`
    // reaches only the ready-for-closeout terminals (the approval identity
    // closeout re-verifies), while the `reviewEvidence` collector reaches every
    // terminal — including cancelled/failed — so a run that never approved
    // still carries the trees and hash it was judged on. See `TaskEvidence`.
    approvedReviewSurfaceHash = reviewed.reviewState.hash;
    reviewEvidence.taskBaseTree = reviewed.reviewState.baseTree;
    reviewEvidence.currentReviewTree = reviewed.reviewState.currentTree;
    reviewEvidence.fullTaskReviewHash = reviewed.reviewState.hash;
    reviewEvidence.reviewSurfaceHash = reviewed.reviewState.hash;
    const reviewState = {
      hash: reviewed.reviewState.hash,
      baseTree: reviewed.reviewState.baseTree,
      currentTree: reviewed.reviewState.currentTree,
      changedPaths: reviewed.reviewState.changedPaths,
    };

    handoffNotes.push(...canonicalCoder.handoffNotes);
    const roundFeedback: GateRejectionFeedback[] = [];
    const roundFindingsLedger = openFindingsLedger(findingsLedger);
    const artifactPass: JudgmentContext['artifactPass'] =
      (input.workflowAttempt ?? 1) > 1
        ? 'closeout-retry'
        : round > 1
          ? 'coder-retry'
          : 'first-pass';
    const judgmentTask = Object.freeze({
      ...task,
      roles: Object.freeze([...task.roles]) as unknown as SizedTask['roles'],
    });
    const judgmentQa: QaResult = qa.kind === 'tests-written'
      ? Object.freeze({
          kind: 'tests-written',
          testIds: Object.freeze([...qa.testIds]) as unknown as string[],
        })
      : Object.freeze({ ...qa });
    const judgmentTests = Array.isArray(tests)
      ? Object.freeze([...tests]) as unknown as string[]
      : tests;
    const judgmentReviewState = Object.freeze({
      ...reviewState,
      changedPaths: Object.freeze([...reviewState.changedPaths]) as unknown as string[],
    });
    const judgmentContext: JudgmentContext = Object.freeze({
      task: judgmentTask,
      spec: input.spec,
      projectContext: input.contextMd,
      tests: judgmentTests,
      qa: judgmentQa,
      diff: canonicalCoder.diff,
      reviewState: judgmentReviewState,
      findingsLedger: Object.freeze(
        roundFindingsLedger.map((finding) => Object.freeze({ ...finding })),
      ),
      coderHandoffNotes: Object.freeze([...canonicalCoder.handoffNotes]),
      artifactPass,
    });
    const judgmentBatchId = randomUUID();

    // Publish starts in canonical order before invoking any role. Completion
    // order is deliberately invisible; verdict processing below uses this same
    // order after every child has settled.
    roles.add('reviewer');
    previousRole = emitRoleTransition(
      input,
      previousRole,
      'reviewer',
      'review',
      'reviewer-review',
    );
    previousRole = emitRoleTransition(
      input,
      previousRole,
      'tech-lead',
      'diff-review',
      'tech-lead-diff-review',
    );
    if (task.designerNeeded) {
      roles.add('designer');
      previousRole = emitRoleTransition(
        input,
        previousRole,
        'designer',
        'design',
        'designer-review',
      );
    }

    let cleanupRequested = false;
    let cleanupRequestedAt = '';
    let releaseCleanupRequest: (() => void) | undefined;
    const cleanupRequest = new Promise<void>((resolve) => {
      releaseCleanupRequest = resolve;
    });
    const requestCleanup = (): void => {
      if (cleanupRequested) return;
      cleanupRequested = true;
      cleanupRequestedAt = new Date().toISOString();
      deps.cancelJudgmentBatch?.(judgmentBatchId);
      releaseCleanupRequest?.();
    };
    const startJudgment = <T>(
      call: () => Promise<T>,
    ): Promise<T> => Promise.resolve().then(call).catch((err) => {
      requestCleanup();
      throw err;
    });
    const judgmentCalls: Array<{
      role: JudgmentRole;
      promise: Promise<unknown>;
    }> = [
      {
        role: 'reviewer',
        promise: startJudgment(() => deps.reviewer({
          diff: judgmentContext.diff,
          spec: judgmentContext.spec,
          tests: judgmentContext.tests,
          task: judgmentContext.task,
          context: judgmentContext.projectContext,
          reviewerProvider,
          reviewState: judgmentContext.reviewState,
          judgmentContext,
          judgmentBatchId,
          ...(roundFindingsLedger.length > 0
            ? { findingsLedger: [...judgmentContext.findingsLedger] }
            : {}),
          ...(canonicalCoder.handoffNotes.length > 0
            ? { coderHandoffNotes: [...judgmentContext.coderHandoffNotes] }
            : {}),
        })),
      },
      {
        role: 'tech-lead',
        promise: startJudgment(() => deps.techLeadReviewDiff({
          task: judgmentContext.task,
          diff: judgmentContext.diff,
          spec: judgmentContext.spec,
          context: judgmentContext.projectContext,
          reviewState: judgmentContext.reviewState,
          judgmentContext,
          judgmentBatchId,
          ...(roundFindingsLedger.length > 0
            ? { findingsLedger: [...judgmentContext.findingsLedger] }
            : {}),
          ...(canonicalCoder.handoffNotes.length > 0
            ? { coderHandoffNotes: [...judgmentContext.coderHandoffNotes] }
            : {}),
        })),
      },
      ...(task.designerNeeded
        ? [{
            role: 'designer' as const,
            promise: startJudgment(() => deps.designer({
              task: judgmentContext.task,
              diff: judgmentContext.diff,
              spec: judgmentContext.spec,
              context: judgmentContext.projectContext,
              tests: judgmentContext.tests,
              qa: judgmentContext.qa,
              reviewState: judgmentContext.reviewState,
              coderHandoffNotes: [...judgmentContext.coderHandoffNotes],
              judgmentContext,
              judgmentBatchId,
              ...(roundFindingsLedger.length > 0
                ? { findingsLedger: [...judgmentContext.findingsLedger] }
                : {}),
            })),
          }]
        : []),
    ];
    const partiallySettled = new Map<
      JudgmentRole,
      PromiseSettledResult<unknown>
    >();
    const allSettled = Promise.all(judgmentCalls.map(async ({ role, promise }) => {
      let result: PromiseSettledResult<unknown>;
      try {
        result = { status: 'fulfilled', value: await promise };
      } catch (reason) {
        result = { status: 'rejected', reason };
      }
      partiallySettled.set(role, result);
      return result;
    }));
    let cancelGraceTimer: ReturnType<typeof setTimeout> | undefined;
    let forceSettleTimer: ReturnType<typeof setTimeout> | undefined;
    let finishFailure: unknown;
    const cleanupDeadline = new Promise<'deadline'>((resolve) => {
      void cleanupRequest.then(() => {
        cancelGraceTimer = setTimeout(() => {
          deps.forceCancelJudgmentBatch?.(judgmentBatchId);
          forceSettleTimer = setTimeout(
            () => resolve('deadline'),
            JUDGMENT_FORCE_SETTLE_GRACE_MS,
          );
        }, JUDGMENT_CANCEL_GRACE_MS);
      });
    });
    let settled: PromiseSettledResult<unknown>[];
    try {
      const completion = await Promise.race([
        allSettled.then((results) => ({ kind: 'settled' as const, results })),
        cleanupDeadline.then(() => ({ kind: 'deadline' as const })),
      ]);
      settled = completion.kind === 'settled'
        ? completion.results
        : judgmentCalls.map(({ role }) => partiallySettled.get(role) ?? {
            status: 'rejected',
            reason: new RoleCancellationError(role, {
              operationId: judgmentBatchId,
              source: 'internal',
              requestedAt: cleanupRequestedAt,
            }),
          });
    } finally {
      if (cancelGraceTimer !== undefined) clearTimeout(cancelGraceTimer);
      if (forceSettleTimer !== undefined) clearTimeout(forceSettleTimer);
      try {
        await deps.finishJudgmentBatch?.(judgmentBatchId);
      } catch (err) {
        finishFailure = err;
      }
    }
    if (
      finishFailure !== undefined &&
      !settled.some((result) => result.status === 'rejected')
    ) {
      throw finishFailure;
    }
    const settledByRole = new Map(
      judgmentCalls.map((call, index) => [call.role, settled[index]!] as const),
    );
    const rejected = judgmentCalls.flatMap(({ role }, index) => {
      const result = settled[index]!;
      return result.status === 'rejected' ? [{ role, reason: result.reason }] : [];
    });
    const externalCancellation = rejected.find(
      ({ reason }) =>
        reason instanceof RoleCancellationError &&
        reason.cancellation.source !== 'internal',
    );
    const primaryFailure = externalCancellation ??
      rejected.find(({ reason }) => !(reason instanceof RoleCancellationError)) ??
      rejected[0];

    const reviewerSettled = settledByRole.get('reviewer');
    const techLeadSettled = settledByRole.get('tech-lead');
    const designerSettled = settledByRole.get('designer');
    const rawReviewerVerdict = reviewerSettled?.status === 'fulfilled'
      ? reviewerSettled.value as ReviewerVerdict
      : undefined;
    lastReviewer = rawReviewerVerdict === undefined
      ? undefined
      : normalizeReviewerVerdict(rawReviewerVerdict);
    lastTechLeadDiff = techLeadSettled?.status === 'fulfilled'
      ? normalizeGateVerdict(techLeadSettled.value as GateReviewVerdict)
      : undefined;
    lastDesigner = designerSettled?.status === 'fulfilled'
      ? normalizeGateVerdict(designerSettled.value as GateReviewVerdict)
      : undefined;

    judgmentOutcomes.splice(0, judgmentOutcomes.length, ...judgmentCalls.map(({ role }, index) => {
      const result = settled[index]!;
      if (result.status === 'rejected') {
        const cancelled = result.reason instanceof RoleCancellationError;
        return {
          role,
          status: cancelled ? 'cancelled' : 'failed',
          summary: boundedJudgmentSummary((result.reason as Error).message),
        } satisfies JudgmentOutcomeEvidence;
      }
      const verdict = role === 'reviewer'
        ? lastReviewer
        : role === 'tech-lead'
          ? lastTechLeadDiff
          : lastDesigner;
      if (role === 'reviewer' && lastReviewer?.operationalFailureReason !== undefined) {
        return {
          role,
          status: 'failed',
          summary: boundedJudgmentSummary(lastReviewer.operationalFailureReason),
        } satisfies JudgmentOutcomeEvidence;
      }
      return {
        role,
        status: isGatePass(verdict) ? 'pass' : 'reject',
        ...(verdict?.notes ? { summary: boundedJudgmentSummary(verdict.notes) } : {}),
      } satisfies JudgmentOutcomeEvidence;
    }));

    // Consume completed results before surfacing the stable primary operational
    // failure so bounded sibling outcomes and findings remain durable.
    let reviewerOperationalFeedback: GateRejectionFeedback | undefined;
    if (lastReviewer !== undefined) {
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
        reviewerOperationalFeedback = buildGateRejectionFeedback({
          rejectingRole: 'reviewer',
          counterpartRole: 'coder',
          artifact: 'reviewer-verdict',
          reason: lastReviewer.operationalFailureReason,
        });
        await recordGateRejection(deps, reviewerOperationalFeedback);
        emitGateRejection(input, reviewerOperationalFeedback);
      } else if (!isReviewerPass(lastReviewer)) {
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
        emitGateRejection(input, feedback);
        lastRejectionFeedback = feedback;
        roundFeedback.push(feedback);
      }
    }
    if (lastTechLeadDiff !== undefined) {
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
        emitGateRejection(input, feedback);
        lastRejectionFeedback = feedback;
        roundFeedback.push(feedback);
      }
    }
    if (lastDesigner !== undefined) {
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
        emitGateRejection(input, feedback);
        lastRejectionFeedback = feedback;
        roundFeedback.push(feedback);
      }
    }
    if (primaryFailure !== undefined) {
      throw primaryFailure.reason;
    }
    if (reviewerOperationalFeedback !== undefined && lastReviewer !== undefined) {
      return fail(task, roles, handoffNotes, {
        failureReason: lastReviewer.operationalFailureReason!,
        rejectionFeedback: reviewerOperationalFeedback,
        reviewerVerdict: lastReviewer,
        gateVerdicts: buildWorkflowGateVerdicts(
          lastReviewer,
          lastTechLeadDiff,
          lastDesigner,
        ),
        findingsLedger,
        loopExitReason: 'operational',
        objectionOpen: false,
        noCodeTestRationale,
      });
    }

    if (
      lastReviewer !== undefined &&
      isReviewerPass(lastReviewer) &&
      isGatePass(lastTechLeadDiff) &&
      isGatePass(lastDesigner) &&
      reviewerVerificationAllowsCloseout(
        roundFindingsLedger,
        lastReviewer?.verifiedFindings,
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
        ...(approvedReviewSurfaceHash !== undefined
          ? { reviewSurfaceHash: approvedReviewSurfaceHash }
          : {}),
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
          ...(approvedReviewSurfaceHash !== undefined
            ? { reviewSurfaceHash: approvedReviewSurfaceHash }
            : {}),
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
      ...(approvedReviewSurfaceHash !== undefined
        ? { reviewSurfaceHash: approvedReviewSurfaceHash }
        : {}),
      ...(noCodeTestRationale !== undefined ? { noCodeTestRationale } : {}),
    };
  }

  if (task.designerNeeded && !isGatePass(lastDesigner)) {
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

export const JUDGMENT_CANCEL_GRACE_MS = 1_000;
export const JUDGMENT_FORCE_SETTLE_GRACE_MS = 1_000;
export const JUDGMENT_SUMMARY_MAX_CHARS = 500;

function boundedJudgmentSummary(value: string): string {
  return scrubAbsolutePaths(value)
    .replace(/[\r\n\t]+/g, ' ')
    .trim()
    .slice(0, JUDGMENT_SUMMARY_MAX_CHARS);
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

/** Hard ceiling on coder rounds, and therefore on coder self-reviews (exactly
 * one per round). `orch-run-record` bounds durable self-review evidence by the
 * same constant, so raising it here widens both together. */
export const SEVERITY_LOOP_HARD_BUDGET = 4;

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
  } catch (err) {
    if (err instanceof RoleCancellationError) throw err;
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

function emitCoderSelfReview(
  input: TeamTaskRunInput,
  review: CoderSelfReviewRecord,
): void {
  if (input.emit === undefined) return;
  try {
    input.emit({
      kind: 'activity',
      data: {
        event: 'coder-self-review',
        role: 'coder',
        stage: 'self-review',
        round: review.round,
        outcome: review.outcome,
        notes: review.notes,
        canonicalHash: review.canonicalHash,
        ...(review.taskBaseTree !== undefined
          ? { taskBaseTree: review.taskBaseTree }
          : {}),
        ...(review.currentReviewTree !== undefined
          ? { currentReviewTree: review.currentReviewTree }
          : {}),
        changedPaths: review.changedPaths,
        ...(review.artifactAttempts !== undefined
          ? {
              artifactAttempts: review.artifactAttempts.map((attempt) => ({
                ...attempt,
              })),
            }
          : {}),
        line: `coder-self-review: ${review.outcome} - ${review.notes}`,
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
