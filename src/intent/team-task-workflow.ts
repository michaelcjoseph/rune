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
 *         → reviewer/tech-lead/(conditional) designer/security judge concurrently
 *         → verdicts/findings merge in stable role order
 *         → open objection-class finding ⇒ hard block (PM can't clear it)
 *         → all gates green ⇒ ready-for-closeout
 *     → cap reached: adjudicate an eligible reviewer/tech-lead split, or let
 *       the PM settle an eligible findings-free disagreement with rationale
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
  sanitizeExecutionDiagnostic,
  type ArtifactAttemptEvidence,
  type ExecutionFailure,
} from './execution-failure.js';
import {
  REVIEW_BATCH_MAX_ATTEMPTS,
  ReviewBatchResumeError,
  resumeReviewBatchState,
  type ReviewBatchBinding,
  type ReviewBatchCancellationReason,
  type ReviewBatchEligibleRole,
  type ReviewBatchFailureCategory,
  type ReviewBatchRole,
  type ReviewBatchState,
} from './review-batch-state.js';
import type { RelatedTestDiagnostic } from './related-test-diagnostic.js';
import type {
  DurableValidationReceipt,
  FullSuiteAttestation,
} from './full-suite-attestation.js';
import type { PreCloseoutValidationEvidence } from './pre-closeout-validation.js';
import { isGitObjectId } from './git-object-id.js';
import {
  describeEvidenceGaps,
  evidenceGapsForFinding,
  findingSignature,
  type EvidenceGap,
} from './finding-evidence.js';
export { isGitObjectId } from './git-object-id.js';
import {
  scrubAbsolutePaths,
  scrubGenericAbsolutePaths,
} from '../utils/sanitize-paths.js';
import { redactSecrets } from '../utils/redact-secrets.js';
import {
  InvariantReviewFailureError,
  type InvariantChecklistEvidence,
  type InvariantReviewDraft,
  type InvariantReviewFailure,
} from './invariant-review.js';
export {
  InvariantReviewFailureError,
  type InvariantChecklistEvidence,
  type InvariantReviewFailure,
} from './invariant-review.js';

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

function operationCancellation(cancellation: RoleCancellation): OperationCancellation {
  return {
    operationId: cancellation.operationId,
    source: cancellation.source,
    requestedAt: cancellation.requestedAt,
  };
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
  security?: GateVerdict;
}

/** A tie-break ruling on a reviewer-vs-tech-lead split. Decisive for the round. */
export interface AdjudicationRuling {
  /** Which side of the split the artifacts support. */
  upholds: 'pass' | 'fail';
  /** Why, in the adjudicator's words. Required — an unexplained ruling is not
   *  admissible and fails closed to the block. */
  rationale: string;
  /** Present when upholding a fail: the objection restated so the blocked task
   *  and any later repair have an exact change target. */
  finding?: ObjectionFinding;
  /** Trusted executor identity attached by the production seam after parsing;
   * never accepted from the model-authored adjudication JSON. */
  execution?: {
    modelAlias: string;
    provider: DispatchProvider;
  };
}

/** The single source of truth for attempt-level adjudication diagnostics: the
 * type below is derived from it, and `work-run-store` validates persisted
 * summaries against it, so a code can never exist in one and not the other. */
export const ADJUDICATION_DIAGNOSTIC_CODES = [
  'missing-fence',
  'invalid-fence',
  'invalid-json',
  'unsupported-verdict',
  'blank-rationale',
  'missing-finding',
  'malformed-finding',
  'incomplete-finding-evidence',
  'provider-failure',
] as const;

export type AdjudicationDiagnosticCode = typeof ADJUDICATION_DIAGNOSTIC_CODES[number];

export interface AdjudicationAttemptDiagnostic {
  attempt: 1 | 2;
  code: AdjudicationDiagnosticCode;
}

/** Typed operational evidence for an adjudication that never produced an
 * admissible ruling. Raw model/provider output is deliberately absent. */
export interface AdjudicationFailure {
  code: 'adjudication-output-invalid';
  cause: 'invalid-artifact' | 'provider-failure' | 'unavailable';
  attempts: AdjudicationAttemptDiagnostic[];
  executedModelAlias?: string;
  executedProvider?: DispatchProvider;
}

export type AdjudicationResult =
  | (AdjudicationRuling & { status?: 'ruling' })
  | { status: 'operational-failure'; failure: AdjudicationFailure };

/** One recorded adjudication, kept on the task evidence so Cockpit inspection
 *  can show who disagreed, what was ruled, and on which model. */
interface AdjudicationRecordBase {
  round: number;
  /** The role whose fail was in dispute, and the role that passed. */
  dissentingRole: FindingSourceGate;
  concurringRole: FindingSourceGate;
  /** Stable identity of the disputed objection, used to detect a repeat. */
  signature: string;
  /** True when this signature survived an earlier round and the alternate
   *  binding was requested. `executedModelAlias` proves a call completed. */
  escalated: boolean;
  /** Trusted binding that produced the parsed ruling. Absent when no role was
   *  wired, the executor threw, or on historical records. */
  executedModelAlias?: string;
  executedProvider?: DispatchProvider;
}

export type AdjudicationRecord = AdjudicationRecordBase & (
  | {
      /** Optional only while reading historical records written before the
       * discriminator existed; durable normalization writes it explicitly. */
      status?: 'ruling';
      upheld: 'pass' | 'fail';
      rationale: string;
      failClosedReason?: never;
      failure?: never;
    }
  | {
      status: 'operational-failure';
      failure: AdjudicationFailure;
      upheld?: never;
      rationale?: never;
      failClosedReason?: never;
    }
);

/** A blocking finding that failed its class evidence contract and was demoted to
 *  a non-blocking observation. Recorded, and filed as a follow-up — never
 *  silently dropped. */
export interface DowngradedFinding {
  finding: ObjectionFinding;
  sourceGate: FindingSourceGate;
  round: number;
  gaps: EvidenceGap[];
  /** Human-readable statement of what the role was asked for and did not supply. */
  reason: string;
  /** Whether the role was given its one bounded chance to supply the evidence. */
  rePrompted: boolean;
}

export type FindingSourceGate = 'reviewer' | 'tech-lead' | 'designer' | 'security';
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
  /** Optional only for historical persisted records written before this field existed. */
  dissentingRole?: FindingSourceGate;
  /** The exact role verdict the PM overrode, not a reviewer-only proxy. */
  overriddenVerdict?: GateVerdict;
}

export interface AcceptWithRationaleInput {
  task: SizedTask;
  spec: string;
  reason: string;
  dissentingRole: FindingSourceGate;
  dissentingVerdict: GateVerdict;
  rejectionFeedback: GateRejectionFeedback;
  findingsLedger: FindingsLedgerEntry[];
  judgmentContext?: JudgmentContext;
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
  | 'design-review'
  | 'security-review';

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
  invariantChecklistBlock?: string;
  judgmentAttempt?: number;
  judgmentBinding?: ReviewBatchBinding;
}

/** The roles that judge the coder's diff. QA is deliberately absent: QA authors
 *  the tests and stops when the coder starts. Its former `diff-revalidation`
 *  stage read the same artifact the reviewer and tech lead read, returned a bare
 *  boolean with no room for a file or a failing test name, and ran on the
 *  coder's own provider family — the one gate that violated the distinct-provider
 *  review rule. The test-integrity questions it nominally owned are now part of
 *  the tech lead's diff review, which already reads the test files. */
export type JudgmentRole = 'reviewer' | 'tech-lead' | 'designer' | 'security';

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

export interface ReviewQuorumRoleEvidence {
  status: 'pending' | 'running' | 'pass' | 'reject' | 'operational-failure' | 'cancelled';
  attemptsConsumed: number;
  retryEligible: boolean;
  durationMs?: number;
  failureCategory?: ReviewBatchFailureCategory;
  diagnostic?: string;
}

export interface ReviewQuorumEvidence {
  status: 'pending' | 'satisfied' | 'objected' | 'failed';
  satisfyingRole?: ReviewBatchEligibleRole;
  objectingRole?: ReviewBatchRole;
  roles: Partial<Record<ReviewBatchRole, ReviewQuorumRoleEvidence>>;
}

export interface ReviewQuorumFailure {
  category: 'review-paths-exhausted' | 'required-designer-unavailable' |
    'review-surface-drift' | 'review-checkpoint-failure';
  failedRoles: ReviewBatchRole[];
  diagnostic: string;
}

export type WorkflowActivityEvent = {
  kind: 'activity' | 'output';
  data?: Record<string, unknown>;
};

/** The injected role seams. Tests pass fixtures; production wraps real role
 *  invocations (charter loader + model-policy dispatch). */
export interface TeamTaskDeps {
  /** Read-only repository inspection used only for security-sized tasks. */
  techLeadDraftInvariants?: (input: {
    task: SizedTask;
    spec: string;
    context: string;
  }) => Promise<InvariantReviewDraft>;
  /** Independent read-only ratification into the one authoritative checklist. */
  securityRatifyInvariants?: (input: {
    task: SizedTask;
    spec: string;
    context: string;
    draft: InvariantReviewDraft;
  }) => Promise<InvariantChecklistEvidence>;
  qaWriteTests: (input: {
    task: SizedTask;
    spec: string;
    rejectionFeedback?: GateRejectionFeedback;
    invariantChecklistBlock?: string;
  }) => Promise<QaResult>;
  techLeadReviewTests: (input: {
    task: SizedTask;
    qa: QaResult;
    invariantChecklistBlock?: string;
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
    invariantChecklistBlock?: string;
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
    invariantChecklistBlock?: string;
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
    invariantChecklistBlock?: string;
    judgmentAttempt?: number;
    judgmentBinding?: ReviewBatchBinding;
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
    invariantChecklistBlock?: string;
    judgmentAttempt?: number;
    judgmentBinding?: ReviewBatchBinding;
  }) => Promise<GateReviewVerdict>;
  security?: (input: {
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
    invariantChecklistBlock?: string;
    judgmentAttempt?: number;
    judgmentBinding?: ReviewBatchBinding;
  }) => Promise<GateReviewVerdict>;
  /** Last-resort wrap-up call at the round cap, per `agents/pm/SOUL.md`. Only a
   *  block that survived every coder round reaches this seam, and only when no
   *  open finding is irreversible or at/above `PM_ACCEPTANCE_MAX_SEVERITY`.
   *  Acceptance requires a non-empty rationale, which is recorded in the task
   *  evidence and filed as a follow-up. Absent, throwing, or refusing all leave
   *  the block exactly as it was. */
  acceptWithRationale?: (
    input: AcceptWithRationaleInput,
  ) => Promise<AcceptWithRationaleResult>;
  /** One bounded chance for a role to supply the evidence its blocking finding
   *  is missing, before the finding is downgraded to a non-blocking
   *  observation. Called at most once per verdict per round, and only when a
   *  finding fails its class evidence contract. Absent ⇒ no re-prompt; the
   *  contract itself is enforced either way, so a fixture cannot smuggle an
   *  unevidenced finding through by omitting this seam. */
  requestFindingEvidence?: (input: {
    role: FindingSourceGate;
    task: SizedTask;
    /** Only the findings that failed the contract, with what each is missing. */
    gaps: Array<{ finding: ObjectionFinding; gaps: EvidenceGap[]; ask: string }>;
    judgmentContext?: JudgmentContext;
  }) => Promise<ObjectionFinding[]>;
  /** Break a reviewer-vs-tech-lead split that would otherwise end the task.
   *  Receives the diff, spec, tests, and both verdict texts — never the coder's
   *  reasoning or prior-round scratch context. Throwing or returning an unusable
   *  ruling both fail CLOSED, now as a typed `AdjudicationFailure` operational
   *  hold rather than a fabricated upheld fail.
   *
   *  Optional ONLY for the pure-workflow seam: `buildProductionTeamTaskDeps`
   *  always wires it (an unresolvable model binding yields an operational hold
   *  before the workflow runs), so production never reaches the absent branch.
   *  When it IS absent the split falls through to the ordinary block below with
   *  NO adjudication record — a direct caller of the exported
   *  `runTeamTaskWorkflow` that omits this seam gets today's blocking behavior
   *  but no adjudication evidence to inspect. */
  adjudicateSplit?: (input: {
    task: SizedTask;
    dissentingRole: FindingSourceGate;
    concurringRole: FindingSourceGate;
    dissentingVerdict: GateVerdict;
    concurringVerdict: GateVerdict;
    /** True when this same objection survived an earlier round of this task —
     *  the caller escalates to the separately declared model. */
    escalate: boolean;
    judgmentContext?: JudgmentContext;
  }) => Promise<AdjudicationResult>;
  /** Optional gate-time learning hook. Awaited before a corrective retry so a
   *  written lesson can load into the counterpart role's next invocation. */
  onGateRejection?: (feedback: GateRejectionFeedback) => Promise<void>;
  /** Resolve a reviewer provider distinct from the coder's, or null when that
   * independent quorum path is unavailable. Never silently reuse the coder. */
  resolveReviewerProvider: (coderProvider: DispatchProvider) => DispatchProvider | null;
  /** Best-effort internal cleanup after quorum, objection, or external cancellation. */
  cancelJudgmentBatch?: (
    batchId: string,
    reason?: ReviewBatchCancellationReason,
    roles?: ReviewBatchRole[],
  ) => void;
  /** Escalate a SIGTERM-ignoring judgment batch to process-group SIGKILL. */
  forceCancelJudgmentBatch?: (batchId: string, roles?: ReviewBatchRole[]) => void;
  /** Release internal cancellation correlation after every member settles. */
  finishJudgmentBatch?: (batchId: string) => void | Promise<void>;
  /** Durable serialized checkpoint for every review-role transition. */
  persistReviewBatch?: (state: ReviewBatchState) => Promise<void>;
  /** Production binding metadata, including declared attempt-2 escalation. */
  resolveReviewRoleBinding?: (role: ReviewBatchRole, attempt: number) => ReviewBatchBinding;
  /** Explicit attempt-2 replacement. When absent, the coordinator freezes the
   * prior durable binding so a restart or policy reload cannot change it. */
  resolveReviewRoleEscalation?: (role: ReviewBatchEligibleRole) => ReviewBatchBinding | undefined;
  /** Re-capture the canonical Git review surface before resuming a durable
   * post-coder wave. No role is invoked by this read-only check. */
  captureReviewStateForResume?: (baseTree: string) => Promise<CanonicalReviewState>;
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
  /** Exact-tree post-coder review wave recovered from the run cursor. */
  resumeReviewBatch?: ReviewBatchState;
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
  /** Accepted, canonical pre-coder checklist for security-sized tasks. */
  invariantChecklist?: InvariantChecklistEvidence;
  /** Typed operational hold metadata; raw role output is never retained. */
  invariantReviewFailure?: InvariantReviewFailure;
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
  /** Rune-owned post-review validation timing and reuse decision. */
  preCloseoutValidation?: PreCloseoutValidationEvidence;
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
  /** Blocking findings demoted to non-blocking observations because they failed
   *  their class evidence contract. Present only when at least one was
   *  downgraded; each is filed as a follow-up at terminal. */
  downgradedFindings?: DowngradedFinding[];
  /** Tie-break rulings on reviewer-vs-tech-lead splits, in round order. */
  adjudications?: AdjudicationRecord[];
  /** Present only when the task stopped because adjudication never produced an
   * admissible ruling. */
  adjudicationFailure?: AdjudicationFailure;
  /** Set only when an ADMISSIBLE ruling upheld the dissenting fail and that is
   * what blocked the task — the substantive counterpart to
   * `adjudicationFailure`. Carried as typed state so downstream surfaces can
   * tell an adjudicated product failure from an operational hold without
   * pattern-matching the human-readable reason. */
  adjudicationUpheldFail?: true;
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
  /** Quorum status is distinct from the status of any individual role call. */
  reviewQuorum?: ReviewQuorumEvidence;
  /** Typed operational hold after every eligible review path is exhausted. */
  reviewQuorumFailure?: ReviewQuorumFailure;
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
  const invariantEvidence: Pick<
    TaskEvidence,
    'invariantChecklist' | 'invariantReviewFailure'
  > = {};
  const quorumEvidence: Pick<TaskEvidence, 'reviewQuorum' | 'reviewQuorumFailure'> = {};

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
      invariantEvidence,
      quorumEvidence,
    );
    return {
      ...evidence,
      ...reviewEvidence,
      ...invariantEvidence,
      ...quorumEvidence,
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
        ...invariantEvidence,
        ...quorumEvidence,
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
        ...invariantEvidence,
        ...quorumEvidence,
        coderSelfReviews: [...coderSelfReviews],
        ...(judgmentOutcomes.length > 0
          ? { judgmentOutcomes: [...judgmentOutcomes] }
          : {}),
        ...(repairEvidence.testIntentRepair !== undefined
          ? { testIntentRepair: repairEvidence.testIntentRepair }
          : {}),
      };
    }
    if (err instanceof InvariantReviewFailureError) {
      invariantEvidence.invariantReviewFailure = err.failure;
      return {
        taskId: task.id,
        outcome: 'blocked',
        rolesInvoked: roles.list(),
        objectionOpen: false,
        handoffNotes,
        blockedReason: 'pre-coder invariant review failed; preserving clean worktree for retry',
        invariantReviewFailure: err.failure,
        findingsLedger: [...findingsEvidence],
        loopExitReason: 'operational',
        ...reviewEvidence,
        ...quorumEvidence,
        coderSelfReviews: [...coderSelfReviews],
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
        ...invariantEvidence,
        ...quorumEvidence,
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
      ...invariantEvidence,
      ...quorumEvidence,
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
  invariantEvidence: Pick<TaskEvidence, 'invariantChecklist' | 'invariantReviewFailure'>,
  quorumEvidence: Pick<TaskEvidence, 'reviewQuorum' | 'reviewQuorumFailure'>,
): Promise<TaskEvidence> {
  // Reviewer independence is resolved up front, but an unavailable independent
  // reviewer is now one operationally unavailable quorum path. It must never
  // fall back to the coder's provider, and it must not suppress independent
  // tech-lead/security paths that can still satisfy quorum.
  const reviewerProvider = deps.resolveReviewerProvider(input.coderProvider);

  const resumeBatch = input.resumeReviewBatch;
  const resumeContext = resumeBatch?.resumeContext;
  let resumedReviewState: CanonicalReviewState | undefined;
  if (resumeBatch !== undefined) {
    const resumeFailure = (diagnostic: string): TaskEvidence => {
      const failure: ReviewQuorumFailure = {
        category: 'review-surface-drift',
        failedRoles: [],
        diagnostic: sanitizeExecutionDiagnostic(diagnostic),
      };
      const evidence = reviewQuorumEvidence({
        ...resumeBatch,
        quorum: { status: 'failed' },
      });
      quorumEvidence.reviewQuorum = evidence;
      quorumEvidence.reviewQuorumFailure = failure;
      return fail(task, roles, handoffNotes, {
        failureReason: failure.diagnostic,
        reviewQuorum: evidence,
        reviewQuorumFailure: failure,
        findingsLedger,
        loopExitReason: 'operational',
        objectionOpen: false,
      });
    };
    if (resumeContext === undefined || deps.captureReviewStateForResume === undefined) {
      return resumeFailure('Review quorum operational hold: durable review resume context is unavailable');
    }
    try {
      resumedReviewState = await deps.captureReviewStateForResume(resumeBatch.taskBaseTree);
      resumeReviewBatchState(resumeBatch, {
        taskId: task.id,
        baseTree: resumedReviewState.baseTree,
        currentTree: resumedReviewState.currentTree,
        canonicalHash: resumedReviewState.hash,
        interruptedAt: new Date().toISOString(),
      });
    } catch (err) {
      return resumeFailure(
        `Review quorum operational hold: ${(err as Error).message}`,
      );
    }
    for (const role of ['qa', 'tech-lead', 'coder', 'reviewer'] as const) roles.add(role);
    if (task.designerNeeded) roles.add('designer');
    if (task.securityNeeded) roles.add('security');
    if (resumeContext.findingsLedger !== undefined) {
      findingsLedger.push(...structuredClone(
        resumeContext.findingsLedger,
      ) as unknown as FindingsLedgerEntry[]);
    }
    if (resumeContext.coderSelfReviews !== undefined) {
      coderSelfReviews.push(...structuredClone(
        resumeContext.coderSelfReviews,
      ) as unknown as CoderSelfReviewRecord[]);
    }
    if (resumeContext.accumulatedHandoffNotes !== undefined) {
      handoffNotes.push(...resumeContext.accumulatedHandoffNotes);
    }
    if (resumeContext.testIntentRepair !== undefined) {
      repairEvidence.testIntentRepair = structuredClone(resumeContext.testIntentRepair);
    }
    if (resumeContext.adjudications !== undefined && resumeContext.adjudications.length > 0) {
      roles.add('adjudicator');
    }
    reviewEvidence.taskBaseTree = resumedReviewState.baseTree;
    reviewEvidence.currentReviewTree = resumedReviewState.currentTree;
    reviewEvidence.fullTaskReviewHash = resumedReviewState.hash;
    reviewEvidence.reviewSurfaceHash = resumedReviewState.hash;
  }

  let previousRole: RoleName | undefined;
  let invariantChecklistBlock: string | undefined = resumeContext?.invariantChecklistBlock;
  if (resumeContext?.invariantChecklist !== undefined) {
    invariantEvidence.invariantChecklist = structuredClone(resumeContext.invariantChecklist);
  }
  if (task.securityNeeded && resumeContext === undefined) {
    if (deps.techLeadDraftInvariants === undefined) {
      throw new InvariantReviewFailureError({
        stage: 'tech-lead-draft',
        cause: 'provider',
        diagnostic: 'tech-lead invariant-review provider is not configured',
      });
    }
    roles.add('tech-lead');
    previousRole = emitRoleTransition(
      input,
      previousRole,
      'tech-lead',
      'invariant-review-draft',
      'pre-coder-invariant-draft',
    );
    const draft = await deps.techLeadDraftInvariants({
      task,
      spec: input.spec,
      context: input.contextMd,
    });
    if (deps.securityRatifyInvariants === undefined) {
      throw new InvariantReviewFailureError({
        stage: 'security-ratification',
        cause: 'provider',
        diagnostic: 'security invariant-review provider is not configured',
      });
    }
    roles.add('security');
    previousRole = emitRoleTransition(
      input,
      previousRole,
      'security',
      'invariant-review',
      'pre-coder-invariant-ratification',
    );
    const checklist = await deps.securityRatifyInvariants({
      task,
      spec: input.spec,
      context: input.contextMd,
      draft,
    });
    invariantEvidence.invariantChecklist = checklist;
    invariantChecklistBlock = checklist.canonicalBlock;
    emitInvariantChecklist(input, checklist);
  }

  // Gate 1: QA-first — tests (or a no-code-test rationale) before the coder.
  const carriedFeedback = normalizeFeedback(input.rejectionFeedback);
  let qaFeedback = carriedFeedback.find((feedback) => feedback.rejectedRole === 'qa');
  let coderFeedback = carriedFeedback.filter((feedback) => feedback.rejectedRole === 'coder');
  let qa: QaResult | undefined;
  let noCodeTestRationale: string | undefined;
  let tests: string[] | string | undefined;
  let repairAttempted = false;
  if (resumeContext !== undefined) {
    qa = structuredClone(resumeContext.qa);
    tests = Array.isArray(resumeContext.tests)
      ? [...resumeContext.tests]
      : resumeContext.tests;
    noCodeTestRationale = qa.kind === 'no-code-test-rationale' ? qa.rationale : undefined;
  } else for (let qaAttempt = 0; qaAttempt < input.cap; qaAttempt++) {
    roles.add('qa');
    previousRole = emitRoleTransition(input, previousRole, 'qa', 'test', 'qa-tests');
    qa = await deps.qaWriteTests({
      task,
      spec: input.spec,
      ...(qaFeedback !== undefined ? { rejectionFeedback: qaFeedback } : {}),
      ...(invariantChecklistBlock !== undefined ? { invariantChecklistBlock } : {}),
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
    let tlTests = await deps.techLeadReviewTests({
      task,
      qa,
      ...(invariantChecklistBlock !== undefined ? { invariantChecklistBlock } : {}),
    });
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
        const reReview = await deps.techLeadReviewTests({
          task,
          qa,
          ...(invariantChecklistBlock !== undefined ? { invariantChecklistBlock } : {}),
        });
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

  // Round loop — coder → reviewer → tech-lead diff → conditional specialist gates.
  let lastReviewer: NormalizedReviewerVerdict | undefined;
  let lastTechLeadDiff: GateVerdict | undefined;
  let lastDesigner: GateVerdict | undefined;
  let lastSecurity: GateVerdict | undefined;
  let lastRejectionFeedback: GateRejectionFeedback | undefined;
  let lastJudgmentContext: JudgmentContext | undefined;
  // Accumulated across rounds: a finding downgraded in round 1 stays visible in
  // the terminal record even if the role never raises it again.
  const downgradedFindings: DowngradedFinding[] = resumeContext?.downgradedFindings === undefined
    ? []
    : structuredClone(resumeContext.downgradedFindings) as unknown as DowngradedFinding[];
  const adjudications: AdjudicationRecord[] = resumeContext?.adjudications === undefined
    ? []
    : structuredClone(resumeContext.adjudications) as unknown as AdjudicationRecord[];
  /** Disputed-objection signatures seen in an earlier round. A repeat means the
   *  coder round did not settle it, so the ruling escalates. */
  const seenSplitSignatures = new Set(resumeContext?.seenSplitSignatures ?? []);
  const configuredRoundBudget = Math.min(input.cap, SEVERITY_LOOP_HARD_BUDGET);
  let round = resumeBatch !== undefined ? resumeBatch.round - 1 : 0;
  let resumeCurrentRound = resumedReviewState !== undefined;
  let previousMaxOpenSeverity: ObjectionSeverity | undefined =
    resumeContext?.previousMaxOpenSeverity;
  let flatMaxOpenSeverityRounds = resumeContext?.flatMaxOpenSeverityRounds ?? 0;
  let continueConvergingPastConfiguredCap = false;
  let approvedReviewSurfaceHash: string | undefined;
  const explicitNonReversibleFindingIds = new Set(
    resumeContext?.explicitNonReversibleFindingIds ?? [],
  );
  while (round < configuredRoundBudget || continueConvergingPastConfiguredCap) {
    continueConvergingPastConfiguredCap = false;
    round += 1;
    let canonicalCoder: CoderResult;
    let reviewState: Omit<CanonicalReviewState, 'diff'>;
    const resumedThisRound = resumeCurrentRound && resumedReviewState !== undefined &&
      resumeContext !== undefined;
    if (resumedThisRound && resumedReviewState !== undefined && resumeContext !== undefined) {
      canonicalCoder = {
        diff: resumedReviewState.diff,
        handoffNotes: [...resumeContext.coderHandoffNotes],
      };
      reviewState = {
        hash: resumedReviewState.hash,
        baseTree: resumedReviewState.baseTree,
        currentTree: resumedReviewState.currentTree,
        changedPaths: [...resumedReviewState.changedPaths],
      };
      resumeCurrentRound = false;
    } else {
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
        ...(invariantChecklistBlock !== undefined ? { invariantChecklistBlock } : {}),
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
        ...(invariantChecklistBlock !== undefined ? { invariantChecklistBlock } : {}),
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
      canonicalCoder = {
        ...coder,
        diff: reviewed.reviewState.diff,
        handoffNotes:
          reviewed.outcome === 'revised'
            ? [...coder.handoffNotes, `coder self-review (revised): ${reviewed.notes}`]
            : coder.handoffNotes,
      };
      reviewState = {
        hash: reviewed.reviewState.hash,
        baseTree: reviewed.reviewState.baseTree,
        currentTree: reviewed.reviewState.currentTree,
        changedPaths: reviewed.reviewState.changedPaths,
      };
    }
    // Same value, three destinations, on purpose: `approvedReviewSurfaceHash`
    // reaches only the ready-for-closeout terminals (the approval identity
    // closeout re-verifies), while the `reviewEvidence` collector reaches every
    // terminal — including cancelled/failed — so a run that never approved
    // still carries the trees and hash it was judged on. See `TaskEvidence`.
    approvedReviewSurfaceHash = reviewState.hash;
    reviewEvidence.taskBaseTree = reviewState.baseTree;
    reviewEvidence.currentReviewTree = reviewState.currentTree;
    reviewEvidence.fullTaskReviewHash = reviewState.hash;
    reviewEvidence.reviewSurfaceHash = reviewState.hash;

    if (!resumedThisRound || resumeContext?.accumulatedHandoffNotes === undefined) {
      handoffNotes.push(...canonicalCoder.handoffNotes);
    }
    const roundFeedback: GateRejectionFeedback[] = [];
    const roundFindingsLedger = openFindingsLedger(findingsLedger);
    const artifactPass: JudgmentContext['artifactPass'] =
      resumeBatch?.round === round && resumeContext !== undefined
        ? resumeContext.artifactPass
        : (input.workflowAttempt ?? 1) > 1
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
    lastJudgmentContext = judgmentContext;
    const resumeBatchForRound = resumeBatch?.round === round ? resumeBatch : undefined;
    const judgmentBatchId = resumeBatchForRound?.batchId ?? randomUUID();

    // Publish starts in canonical order before invoking any role. The quorum
    // coordinator drains already-settled results, then processing below maps
    // the durable outcomes back into this stable role order.
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
    if (task.securityNeeded) {
      roles.add('security');
      previousRole = emitRoleTransition(
        input,
        previousRole,
        'security',
        'security',
        'security-review',
      );
    }

    const contractReviewVerdict = async (
      role: JudgmentRole,
      rawVerdict: unknown,
    ): Promise<GateVerdict | NormalizedReviewerVerdict> => {
      if (role === 'reviewer') {
        const reviewerVerdict = normalizeReviewerVerdict(rawVerdict as ReviewerVerdict);
        if (reviewerVerdict.operationalFailureReason !== undefined) return reviewerVerdict;
        const contracted = await applyEvidenceContract(
          deps, task, role, reviewerVerdict, round, judgmentContext, downgradedFindings,
        );
        return {
          ...reviewerVerdict,
          outcome: contracted.outcome,
          findings: contracted.findings,
          objections: contracted.findings,
        };
      }
      return applyEvidenceContract(
        deps,
        task,
        role,
        normalizeGateVerdict(rawVerdict as GateReviewVerdict),
        round,
        judgmentContext,
        downgradedFindings,
      );
    };

    const judgmentCalls: Array<{
      role: JudgmentRole;
      call: (attempt: number, binding: ReviewBatchBinding) => Promise<unknown>;
    }> = [
      {
        role: 'reviewer',
        call: (attempt, binding) => {
          if (binding.model === 'unavailable' ||
              (reviewerProvider === null && deps.resolveReviewRoleBinding === undefined)) {
            throw new Error('reviewer independence: no distinct-provider reviewer available');
          }
          return deps.reviewer({
          diff: judgmentContext.diff,
          spec: judgmentContext.spec,
          tests: judgmentContext.tests,
          task: judgmentContext.task,
          context: judgmentContext.projectContext,
          reviewerProvider: binding.provider,
          reviewState: judgmentContext.reviewState,
          judgmentContext,
          judgmentBatchId,
          judgmentAttempt: attempt,
          judgmentBinding: binding,
          ...(invariantChecklistBlock !== undefined ? { invariantChecklistBlock } : {}),
          ...(roundFindingsLedger.length > 0
            ? { findingsLedger: [...judgmentContext.findingsLedger] }
            : {}),
          ...(canonicalCoder.handoffNotes.length > 0
            ? { coderHandoffNotes: [...judgmentContext.coderHandoffNotes] }
            : {}),
          });
        },
      },
      {
        role: 'tech-lead',
        call: (attempt, binding) => deps.techLeadReviewDiff({
          task: judgmentContext.task,
          diff: judgmentContext.diff,
          spec: judgmentContext.spec,
          context: judgmentContext.projectContext,
          reviewState: judgmentContext.reviewState,
          judgmentContext,
          judgmentBatchId,
          judgmentAttempt: attempt,
          judgmentBinding: binding,
          ...(invariantChecklistBlock !== undefined ? { invariantChecklistBlock } : {}),
          ...(roundFindingsLedger.length > 0
            ? { findingsLedger: [...judgmentContext.findingsLedger] }
            : {}),
          ...(canonicalCoder.handoffNotes.length > 0
            ? { coderHandoffNotes: [...judgmentContext.coderHandoffNotes] }
            : {}),
        }),
      },
      ...(task.designerNeeded
        ? [{
            role: 'designer' as const,
            call: (attempt: number, binding: ReviewBatchBinding) => deps.designer({
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
              judgmentAttempt: attempt,
              judgmentBinding: binding,
              ...(invariantChecklistBlock !== undefined ? { invariantChecklistBlock } : {}),
              ...(roundFindingsLedger.length > 0
                ? { findingsLedger: [...judgmentContext.findingsLedger] }
                : {}),
            }),
          }]
        : []),
      ...(task.securityNeeded
        ? [{
            role: 'security' as const,
            call: async (attempt: number, binding: ReviewBatchBinding) => {
              if (deps.security === undefined) {
                throw new Error('security review gate is not configured');
              }
              return deps.security({
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
                judgmentAttempt: attempt,
                judgmentBinding: binding,
                ...(invariantChecklistBlock !== undefined ? { invariantChecklistBlock } : {}),
                ...(roundFindingsLedger.length > 0
                  ? { findingsLedger: [...judgmentContext.findingsLedger] }
                  : {}),
              });
            },
          }]
        : []),
    ];
    // Cleanup guarantee for the *unanticipated* throw. Every expected failure
    // inside the coordinator routes to its own finishBatch() before returning,
    // but an unexpected exception would escape to runProjectOrchestration's
    // outer handler, which knows nothing about this batch — orphaning a
    // tombstone in in-flight.ts's process-lifetime correlation maps, which have
    // no reaper. finishJudgmentBatch is idempotent (pure map deletes), so the
    // normal paths make this a no-op.
    let coordinated: CoordinatedReviewBatch;
    try {
      coordinated = await coordinateReviewBatch({
        task,
        input,
        deps,
        round,
        judgmentBatchId,
        reviewState,
        judgmentContext,
        invariantChecklistBlock,
        invariantChecklist: invariantEvidence.invariantChecklist,
        findingsLedger,
        coderSelfReviews,
        downgradedFindings,
        handoffNotes,
        testIntentRepair: repairEvidence.testIntentRepair,
        adjudications,
        seenSplitSignatures,
        explicitNonReversibleFindingIds,
        previousMaxOpenSeverity,
        flatMaxOpenSeverityRounds,
        finalizeVerdict: contractReviewVerdict,
        resumeState: resumeBatchForRound,
        calls: judgmentCalls,
      });
    } catch (err) {
      try {
        await deps.finishJudgmentBatch?.(judgmentBatchId);
      } catch {
        // Cleanup is best-effort; the original failure is what matters.
      }
      throw err;
    }
    const settled = judgmentCalls.map(({ role }) => coordinated.settled.get(role) ?? {
      status: 'rejected' as const,
      reason: new Error(`${role} review did not produce a terminal outcome`),
    });
    quorumEvidence.reviewQuorum = coordinated.evidence;
    if (coordinated.failure !== undefined) {
      quorumEvidence.reviewQuorumFailure = coordinated.failure;
    }
    const settledByRole = new Map(
      judgmentCalls.map((call, index) => [call.role, settled[index]!] as const),
    );
    const rejected = judgmentCalls.flatMap(({ role }, index) => {
      const result = settled[index]!;
      return result.status === 'rejected' ? [{ role, reason: result.reason }] : [];
    });
    const externalCancellation = coordinated.cancellation ?? rejected.find(
      ({ reason }) =>
        reason instanceof RoleCancellationError &&
        reason.cancellation.source !== 'internal',
    )?.reason;

    const reviewerSettled = settledByRole.get('reviewer');
    const techLeadSettled = settledByRole.get('tech-lead');
    const designerSettled = settledByRole.get('designer');
    const securitySettled = settledByRole.get('security');
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
    lastSecurity = securitySettled?.status === 'fulfilled'
      ? normalizeGateVerdict(securitySettled.value as GateReviewVerdict)
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
          : role === 'designer'
            ? lastDesigner
            : lastSecurity;
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
    if (externalCancellation !== undefined) throw externalCancellation;

    // Consume completed results before surfacing the stable primary operational
    // failure so bounded sibling outcomes and findings remain durable.
    if (lastReviewer !== undefined) {
      if (lastReviewer.operationalFailureReason !== undefined) {
        emitReviewQuorumProgress(input, {
          event: 'review-role-operational-failure',
          role: 'reviewer',
          failureCategory: 'invalid-verdict',
          line: `Reviewer unavailable: ${boundedJudgmentSummary(lastReviewer.operationalFailureReason)}. ` +
            'Other independent reviews continue toward quorum.',
        });
      } else {
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
          emitGateRejection(input, feedback);
          lastRejectionFeedback = feedback;
          roundFeedback.push(feedback);
        }
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
    if (lastSecurity !== undefined) {
      mergeFindingsIntoLedger(
        findingsLedger,
        explicitNonReversibleFindingIds,
        'security',
        lastSecurity.findings,
        round,
      );
      emitRoleVerdict(input, {
        role: 'security',
        gate: 'security-review',
        verdict: isGatePass(lastSecurity) ? 'pass' : 'fail',
        summary: lastSecurity.notes?.trim() || (isGatePass(lastSecurity)
          ? 'security approved implementation diff'
          : 'security rejected implementation diff'),
      });
      if (!isGatePass(lastSecurity)) {
        const feedback = buildGateRejectionFeedback({
          rejectingRole: 'security',
          counterpartRole: 'coder',
          artifact: 'security-review',
          reason: lastSecurity.findings.length > 0
            ? summarizeObjections(lastSecurity.findings)
            : lastSecurity.notes ?? 'security review failed',
          actionableNotes: suggestedChangesFromVerdict(lastSecurity),
        });
        await recordGateRejection(deps, feedback);
        emitGateRejection(input, feedback);
        lastRejectionFeedback = feedback;
        roundFeedback.push(feedback);
      }
    }
    if (coordinated.failure !== undefined) {
      return fail(task, roles, handoffNotes, {
        failureReason: coordinated.failure.diagnostic,
        reviewQuorum: coordinated.evidence,
        reviewQuorumFailure: coordinated.failure,
        gateVerdicts: buildWorkflowGateVerdicts(
          lastReviewer,
          lastTechLeadDiff,
          lastDesigner,
          lastSecurity,
        ),
        findingsLedger,
        loopExitReason: 'operational',
        objectionOpen: false,
        downgradedFindings,
        adjudications,
        noCodeTestRationale,
      });
    }
    if (coordinated.evidence.status === 'satisfied' &&
        coordinated.evidence.satisfyingRole !== 'reviewer') {
      resolveQuorumReviewedFindings(findingsLedger, roundFindingsLedger);
    }
    if (
      coordinated.evidence.status === 'satisfied' &&
      isGatePass(lastDesigner) &&
      (coordinated.evidence.satisfyingRole !== 'reviewer' ||
        reviewerVerificationAllowsCloseout(
          roundFindingsLedger,
          lastReviewer?.verifiedFindings,
          findingsLedger,
          round < configuredRoundBudget,
        ))
    ) {
      return {
        taskId: task.id,
        outcome: 'ready-for-closeout',
        rolesInvoked: roles.list(),
        reviewerVerdict: lastReviewer,
        gateVerdicts: buildWorkflowGateVerdicts(lastReviewer, lastTechLeadDiff, lastDesigner, lastSecurity),
        findingsLedger,
        loopExitReason: 'all-low',
        objectionOpen: false,
        handoffNotes,
        ...(adjudications.length > 0 ? { adjudications } : {}),
        ...(downgradedFindings.length > 0 ? { downgradedFindings } : {}),
        ...(approvedReviewSurfaceHash !== undefined
          ? { reviewSurfaceHash: approvedReviewSurfaceHash }
          : {}),
        ...(noCodeTestRationale !== undefined ? { noCodeTestRationale } : {}),
        reviewQuorum: coordinated.evidence,
      };
    }

    const lastRound = round >= configuredRoundBudget;

    // Conditional gates are never ties to delegate. At the terminal round they
    // remain direct blocks, regardless of severity-loop or adjudication escape
    // hatches.
    const roundConditionalGateFailure = conditionalGateBlockReason(
      task,
      lastDesigner,
    );
    if (lastRound && roundConditionalGateFailure !== undefined) {
      emitTerminalObjections(input, lastReviewer, lastTechLeadDiff, lastDesigner, lastSecurity);
      return block(task, roles, handoffNotes, {
        blockedReason: `${roundConditionalGateFailure} at the round cap`,
        ...(lastRejectionFeedback !== undefined
          ? { rejectionFeedback: lastRejectionFeedback }
          : {}),
        reviewerVerdict: lastReviewer,
        gateVerdicts: buildWorkflowGateVerdicts(
          lastReviewer,
          lastTechLeadDiff,
          lastDesigner,
          lastSecurity,
        ),
        findingsLedger,
        loopExitReason: 'hard-budget',
        downgradedFindings,
        adjudications,
        noCodeTestRationale,
      });
    }

    // Split adjudication. The contract is specifically reviewer-vs-tech-lead;
    // designer is an independent required gate and never enters this pairing.
    // disagreement is modeled as failure and nothing ever compares the two
    // arguments — the run parks and waits for a human. One tie-breaker with
    // fresh context resolves it.
    //
    // NOT every split: a round-1 finding the coder can simply fix should not
    // cost an adjudication. This fires only when the split would otherwise end
    // the task — the disputed objection already survived a coder retry, or the
    // round cap is next.
    const split = detectSplit(lastReviewer, lastTechLeadDiff);
    if (split !== undefined) {
      const dissenting = split.dissentingVerdict;
      const concurring = split.concurringVerdict;
      const signature = splitSignature(dissenting);
      const repeat = seenSplitSignatures.has(signature);
      seenSplitSignatures.add(signature);

      if (repeat || lastRound) {
        const humanBlocker = deps.adjudicateSplit === undefined
          ? undefined
          : adjudicationLedgerHumanBlocker(
              findingsLedger,
              explicitNonReversibleFindingIds,
            ) ?? adjudicationHumanBlocker(dissenting);
        if (humanBlocker !== undefined) {
          emitTerminalObjections(input, lastReviewer, lastTechLeadDiff, lastDesigner, lastSecurity);
          return block(task, roles, handoffNotes, {
            blockedReason: humanBlocker,
            ...(lastRejectionFeedback !== undefined
              ? { rejectionFeedback: lastRejectionFeedback }
              : {}),
            reviewerVerdict: lastReviewer,
            gateVerdicts: buildWorkflowGateVerdicts(lastReviewer, lastTechLeadDiff, lastDesigner, lastSecurity),
            findingsLedger,
            loopExitReason: 'hard-budget',
            downgradedFindings,
            adjudications,
            noCodeTestRationale,
          });
        }
        if (deps.adjudicateSplit !== undefined) {
          roles.add('adjudicator');
          // One adjudicator model, so there is no binding to name. What is still
          // worth surfacing is WHY this adjudication fired.
          emitRoleStage(input, 'adjudicator', 'split-adjudication', {
            trigger: repeat ? 'repeat-objection' : 'round-cap',
          });
          let result: AdjudicationResult;
          try {
            result = await deps.adjudicateSplit({
              task,
              dissentingRole: split.dissentingRole,
              concurringRole: split.concurringRole,
              dissentingVerdict: toPublicGateVerdict(dissenting),
              concurringVerdict: toPublicGateVerdict(concurring),
              escalate: repeat,
              judgmentContext,
            });
          } catch (err) {
            if (err instanceof RoleCancellationError) throw err;
            result = {
              status: 'operational-failure',
              failure: {
                code: 'adjudication-output-invalid',
                cause: 'provider-failure',
                attempts: [{ attempt: 1, code: 'provider-failure' }],
              },
            };
          }
          const ruling = result.status === 'operational-failure' ? undefined : result;
          const invalidRulingReason = ruling === undefined ? undefined : rulingFailure(ruling);
          const adjudicationFailure = result.status === 'operational-failure'
            ? result.failure
            : invalidRulingReason === undefined
              ? undefined
              : failureForInvalidRuling(ruling!);

          if (adjudicationFailure !== undefined) {
            const record: AdjudicationRecord = {
              status: 'operational-failure',
              round,
              dissentingRole: split.dissentingRole,
              concurringRole: split.concurringRole,
              signature,
              escalated: repeat,
              failure: adjudicationFailure,
              ...(adjudicationFailure.executedModelAlias !== undefined
                ? { executedModelAlias: adjudicationFailure.executedModelAlias }
                : {}),
              ...(adjudicationFailure.executedProvider !== undefined
                ? { executedProvider: adjudicationFailure.executedProvider }
                : {}),
            };
            adjudications.push(record);
            emitTerminalObjections(input, lastReviewer, lastTechLeadDiff, lastDesigner, lastSecurity);
            return fail(task, roles, handoffNotes, {
              failureReason: adjudicationOperationalReason(adjudicationFailure),
              reviewerVerdict: lastReviewer,
              gateVerdicts: buildWorkflowGateVerdicts(
                lastReviewer,
                lastTechLeadDiff,
                lastDesigner,
                lastSecurity,
              ),
              findingsLedger,
              loopExitReason: 'operational',
              objectionOpen: openFindingsLedger(findingsLedger).some(
                (entry) => severityRank[entry.severity] > severityRank.low,
              ),
              downgradedFindings,
              adjudications,
              adjudicationFailure,
              noCodeTestRationale,
            });
          }

          adjudications.push({
            status: 'ruling',
            round,
            dissentingRole: split.dissentingRole,
            concurringRole: split.concurringRole,
            signature,
            upheld: ruling!.upholds,
            rationale: ruling!.rationale,
            escalated: repeat,
            ...(ruling!.execution !== undefined
              ? {
                  executedModelAlias: ruling!.execution.modelAlias,
                  executedProvider: ruling!.execution.provider,
                }
              : {}),
          });
          emitRoleVerdict(input, {
            role: 'adjudicator',
            gate: 'implementation-diff',
            verdict: ruling!.upholds === 'pass' ? 'pass' : 'fail',
            summary: `upheld the ${ruling!.upholds} of ${
              ruling!.upholds === 'fail' ? split.dissentingRole : split.concurringRole
            }: ${ruling!.rationale}`,
          });

          // A ruling for the pass is decisive for the round: the task closes
          // out, and the dissent becomes a follow-up rather than vanishing.
          if (ruling!.upholds === 'pass') {
            const protectedFinding = adjudicationLedgerHumanBlocker(
              findingsLedger,
              explicitNonReversibleFindingIds,
            );
            if (protectedFinding !== undefined) {
              emitTerminalObjections(input, lastReviewer, lastTechLeadDiff, lastDesigner, lastSecurity);
              return block(task, roles, handoffNotes, {
                blockedReason: protectedFinding,
                ...(lastRejectionFeedback !== undefined
                  ? { rejectionFeedback: lastRejectionFeedback }
                  : {}),
                reviewerVerdict: lastReviewer,
                gateVerdicts: buildWorkflowGateVerdicts(
                  lastReviewer,
                  lastTechLeadDiff,
                  lastDesigner,
                  lastSecurity,
                ),
                findingsLedger,
                loopExitReason: 'hard-budget',
                objectionOpen: true,
                downgradedFindings,
                adjudications,
                noCodeTestRationale,
              });
            }
            for (const finding of dissenting.findings) {
              downgradedFindings.push({
                finding,
                sourceGate: split.dissentingRole,
                round,
                gaps: [],
                reason: `adjudicator upheld ${split.concurringRole}'s pass over ` +
                  `${split.dissentingRole}'s fail: ${ruling!.rationale}`,
                rePrompted: false,
              });
            }
            resolveAdjudicatedFindings(
              findingsLedger,
              split.dissentingRole,
              dissenting.findings,
            );
            const remainingBlockingFinding = openFindingsLedger(findingsLedger).find(
              (entry) => severityRank[entry.severity] > severityRank.low,
            );
            if (remainingBlockingFinding !== undefined) {
              emitTerminalObjections(input, lastReviewer, lastTechLeadDiff, lastDesigner, lastSecurity);
              return block(task, roles, handoffNotes, {
                blockedReason: 'adjudicator settled the current split, but another blocking ' +
                  `${remainingBlockingFinding.class} finding remains open at ` +
                  remainingBlockingFinding.location,
                ...(lastRejectionFeedback !== undefined
                  ? { rejectionFeedback: lastRejectionFeedback }
                  : {}),
                reviewerVerdict: lastReviewer,
                gateVerdicts: buildWorkflowGateVerdicts(
                  lastReviewer,
                  lastTechLeadDiff,
                  lastDesigner,
                  lastSecurity,
                ),
                findingsLedger,
                loopExitReason: 'hard-budget',
                objectionOpen: true,
                downgradedFindings,
                adjudications,
                noCodeTestRationale,
              });
            }
            const conditionalGateFailure = conditionalGateBlockReason(
              task,
              lastDesigner,
            );
            if (conditionalGateFailure !== undefined) {
              emitTerminalObjections(input, lastReviewer, lastTechLeadDiff, lastDesigner, lastSecurity);
              return block(task, roles, handoffNotes, {
                blockedReason: conditionalGateFailure,
                ...(lastRejectionFeedback !== undefined
                  ? { rejectionFeedback: lastRejectionFeedback }
                  : {}),
                reviewerVerdict: lastReviewer,
                gateVerdicts: buildWorkflowGateVerdicts(
                  lastReviewer,
                  lastTechLeadDiff,
                  lastDesigner,
                  lastSecurity,
                ),
                findingsLedger,
                loopExitReason: 'hard-budget',
                objectionOpen: false,
                downgradedFindings,
                adjudications,
                noCodeTestRationale,
              });
            }
            // Adjudication settles only the reviewer/tech-lead split. A
            // separately completed security dissent remains ordinary coder
            // feedback and cannot be erased by that ruling.
            if (!isGatePass(lastSecurity)) {
              if (!lastRound) {
                coderFeedback = roundFeedback;
                continue;
              }
              emitTerminalObjections(input, lastReviewer, lastTechLeadDiff, lastDesigner, lastSecurity);
              return block(task, roles, handoffNotes, {
                blockedReason: 'security review failed at the round cap',
                ...(lastRejectionFeedback !== undefined
                  ? { rejectionFeedback: lastRejectionFeedback }
                  : {}),
                reviewerVerdict: lastReviewer,
                gateVerdicts: buildWorkflowGateVerdicts(
                  lastReviewer,
                  lastTechLeadDiff,
                  lastDesigner,
                  lastSecurity,
                ),
                findingsLedger,
                loopExitReason: 'hard-budget',
                objectionOpen: false,
                downgradedFindings,
                adjudications,
                noCodeTestRationale,
                reviewQuorum: coordinated.evidence,
              });
            }
            emitTerminalObjections(input, lastReviewer, lastTechLeadDiff, lastDesigner, lastSecurity);
            return {
              taskId: task.id,
              outcome: 'ready-for-closeout',
              rolesInvoked: roles.list(),
              reviewerVerdict: lastReviewer,
              gateVerdicts: buildWorkflowGateVerdicts(
                lastReviewer,
                lastTechLeadDiff,
                lastDesigner,
                lastSecurity,
              ),
              findingsLedger,
              loopExitReason: 'all-low',
              objectionOpen: false,
              handoffNotes,
              adjudications,
              ...(downgradedFindings.length > 0 ? { downgradedFindings } : {}),
              ...(approvedReviewSurfaceHash !== undefined
                ? { reviewSurfaceHash: approvedReviewSurfaceHash }
                : {}),
              ...(noCodeTestRationale !== undefined ? { noCodeTestRationale } : {}),
            };
          }

          // Strict parsing already held an upheld finding to its class evidence
          // contract, so an admitted fail carries a concrete repair target.
          if (ruling!.finding !== undefined) {
            mergeFindingsIntoLedger(
              findingsLedger,
              explicitNonReversibleFindingIds,
              split.dissentingRole,
              [ruling!.finding],
              round,
            );
          }
          emitTerminalObjections(input, lastReviewer, lastTechLeadDiff, lastDesigner, lastSecurity);
          return block(task, roles, handoffNotes, {
            blockedReason: `adjudicator upheld ${split.dissentingRole}'s fail: ${ruling!.rationale}`,
            adjudicationUpheldFail: true,
            ...(lastRejectionFeedback !== undefined
              ? { rejectionFeedback: lastRejectionFeedback }
              : {}),
            reviewerVerdict: lastReviewer,
            gateVerdicts: buildWorkflowGateVerdicts(lastReviewer, lastTechLeadDiff, lastDesigner, lastSecurity),
            findingsLedger,
            loopExitReason: 'hard-budget',
            objectionOpen: false,
            downgradedFindings,
            adjudications,
            noCodeTestRationale,
          });
        }
      }
    }

    const maxOpenSeverity = maxOpenFindingSeverity(findingsLedger);
    if (
      maxOpenSeverity !== undefined &&
      severityRank[maxOpenSeverity] > severityRank.low &&
      hasOnlySeverityDerivedFailures(lastReviewer, lastTechLeadDiff, lastDesigner, lastSecurity)
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
        const conditionalGateFailure = conditionalGateBlockReason(
          task,
          lastDesigner,
        );
        if (conditionalGateFailure !== undefined) {
          emitTerminalObjections(input, lastReviewer, lastTechLeadDiff, lastDesigner, lastSecurity);
          return block(task, roles, handoffNotes, {
            blockedReason: conditionalGateFailure,
            ...(lastRejectionFeedback !== undefined
              ? { rejectionFeedback: lastRejectionFeedback }
              : {}),
            reviewerVerdict: lastReviewer,
            gateVerdicts: buildWorkflowGateVerdicts(
              lastReviewer,
              lastTechLeadDiff,
              lastDesigner,
              lastSecurity,
            ),
            findingsLedger,
            loopExitReason: 'stagnation',
            objectionOpen: false,
            downgradedFindings,
            adjudications,
            noCodeTestRationale,
          });
        }
        emitTerminalObjections(input, lastReviewer, lastTechLeadDiff, lastDesigner, lastSecurity);
        return {
          taskId: task.id,
          outcome: 'ready-for-closeout',
          rolesInvoked: roles.list(),
          reviewerVerdict: lastReviewer,
          gateVerdicts: buildWorkflowGateVerdicts(lastReviewer, lastTechLeadDiff, lastDesigner, lastSecurity),
          findingsLedger,
          loopExitReason: 'stagnation',
          objectionOpen: false,
          handoffNotes,
          ...(adjudications.length > 0 ? { adjudications } : {}),
          ...(downgradedFindings.length > 0 ? { downgradedFindings } : {}),
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
    hasOnlySeverityDerivedFailures(lastReviewer, lastTechLeadDiff, lastDesigner, lastSecurity) &&
    maxOpenFindingSeverity(findingsLedger) !== undefined
  ) {
    emitTerminalObjections(input, lastReviewer, lastTechLeadDiff, lastDesigner, lastSecurity);
    const conditionalGateFailure = conditionalGateBlockReason(
      task,
      lastDesigner,
    );
    if (conditionalGateFailure !== undefined) {
      return block(task, roles, handoffNotes, {
        blockedReason: conditionalGateFailure,
        ...(lastRejectionFeedback !== undefined
          ? { rejectionFeedback: lastRejectionFeedback }
          : {}),
        reviewerVerdict: lastReviewer,
        gateVerdicts: buildWorkflowGateVerdicts(
          lastReviewer,
          lastTechLeadDiff,
          lastDesigner,
          lastSecurity,
        ),
        findingsLedger,
        loopExitReason: 'hard-budget',
        objectionOpen: false,
        downgradedFindings,
        adjudications,
        noCodeTestRationale,
      });
    }
    const holdFinding = firstNonReversibleHighSeverityFinding(
      findingsLedger,
      explicitNonReversibleFindingIds,
    );
    if (holdFinding !== undefined) {
      return block(task, roles, handoffNotes, {
        blockedReason: terminalHoldReason(holdFinding),
        reviewerVerdict: lastReviewer,
        gateVerdicts: buildWorkflowGateVerdicts(lastReviewer, lastTechLeadDiff, lastDesigner, lastSecurity),
        findingsLedger,
        loopExitReason: 'hard-budget',
        objectionOpen: false,
        downgradedFindings,
        adjudications,
        noCodeTestRationale,
      });
    }
    return {
      taskId: task.id,
      outcome: 'ready-for-closeout',
      rolesInvoked: roles.list(),
      reviewerVerdict: lastReviewer,
      gateVerdicts: buildWorkflowGateVerdicts(lastReviewer, lastTechLeadDiff, lastDesigner, lastSecurity),
      findingsLedger,
      loopExitReason: 'hard-budget',
      objectionOpen: false,
      handoffNotes,
      ...(adjudications.length > 0 ? { adjudications } : {}),
      ...(downgradedFindings.length > 0 ? { downgradedFindings } : {}),
      ...(approvedReviewSurfaceHash !== undefined
        ? { reviewSurfaceHash: approvedReviewSurfaceHash }
        : {}),
      ...(noCodeTestRationale !== undefined ? { noCodeTestRationale } : {}),
    };
  }

  // Last resort before a human: non-objection disagreement at the cap is
  // exactly what `agents/pm/SOUL.md` already claims the PM owns — "Wrap up at
  // the cap. When a task exhausts its retry budget on non-objection
  // disagreement, you make the wrap-up call." Until now the charter promised
  // something no code path ever invoked, and every surviving block parked.
  //
  // The PM's authority stops where the charter says it stops: a non-reversible
  // or at/above-threshold finding is not the PM's to clear, and acceptance
  // requires a rationale. Both refusals leave the block untouched.
  const conditionalGateFailure = conditionalGateBlockReason(
    task,
    lastDesigner,
  );
  if (conditionalGateFailure !== undefined) {
    emitTerminalObjections(input, lastReviewer, lastTechLeadDiff, lastDesigner, lastSecurity);
    return block(task, roles, handoffNotes, {
      blockedReason: conditionalGateFailure,
      ...(lastRejectionFeedback !== undefined
        ? { rejectionFeedback: lastRejectionFeedback }
        : {}),
      reviewerVerdict: lastReviewer,
      gateVerdicts: buildWorkflowGateVerdicts(
        lastReviewer,
        lastTechLeadDiff,
        lastDesigner,
        lastSecurity,
      ),
      findingsLedger,
      loopExitReason: 'hard-budget',
      objectionOpen: false,
      downgradedFindings,
      adjudications,
      noCodeTestRationale,
    });
  }

  const acceptanceBlocker = pmAcceptanceBlocker(
    findingsLedger,
    explicitNonReversibleFindingIds,
  );
  if (deps.acceptWithRationale !== undefined && acceptanceBlocker === undefined) {
    roles.add('pm');
    emitRoleStage(input, 'pm', 'cap-acceptance');
    let acceptance: AcceptWithRationaleResult | undefined;
    const rejectionFeedback = lastRejectionFeedback ?? buildGateRejectionFeedback({
      rejectingRole: 'reviewer',
      counterpartRole: 'coder',
      artifact: 'implementation-diff',
      reason: 'round cap reached with unresolved task feedback',
    });
    const dissentingRole = isFindingSourceGate(rejectionFeedback.rejectingRole)
      ? rejectionFeedback.rejectingRole
      : 'reviewer';
    const dissentingVerdict = verdictForGate(
      dissentingRole,
      lastReviewer,
      lastTechLeadDiff,
      lastDesigner,
      lastSecurity,
    ) ?? { outcome: 'fail', findings: [] };
    try {
      acceptance = await deps.acceptWithRationale({
        task,
        spec: input.spec,
        reason: lastRejectionFeedback?.whatFailed ??
          'round cap reached with unresolved task feedback',
        dissentingRole,
        dissentingVerdict: toPublicGateVerdict(dissentingVerdict),
        rejectionFeedback,
        findingsLedger: findingsLedger.map((finding) => ({ ...finding })),
        ...(lastJudgmentContext !== undefined
          ? { judgmentContext: lastJudgmentContext }
          : {}),
      });
    } catch {
      /* Acceptance is an escape hatch; its failure must leave the block intact. */
    }
    const rationale = acceptance?.rationale?.trim() ?? '';
    if (acceptance?.accepted === true && rationale !== '') {
      const record: PmAcceptance = {
        actor: acceptance.actor,
        decision: 'accepted-with-rationale',
        rationale,
        dissentingRole,
        overriddenVerdict: toPublicGateVerdict(dissentingVerdict),
      };
      // The overridden dissent is filed, never dropped: it leaves as a
      // follow-up so the concern survives closeout.
      for (const finding of openFindingsLedger(findingsLedger)) {
        downgradedFindings.push({
          finding,
          sourceGate: finding.sourceGate,
          round,
          gaps: [],
          reason: `${record.actor} accepted over ${finding.sourceGate}'s dissent: ${rationale}`,
          rePrompted: false,
        });
      }
      emitRoleVerdict(input, {
        role: 'pm',
        gate: 'implementation-diff',
        verdict: 'pass',
        summary: `accepted over dissent: ${rationale}`,
      });
      emitPmAcceptance(input, task, record, rejectionFeedback);
      emitTerminalObjections(input, lastReviewer, lastTechLeadDiff, lastDesigner, lastSecurity);
      return {
        taskId: task.id,
        outcome: 'ready-for-closeout',
        rolesInvoked: roles.list(),
        reviewerVerdict: lastReviewer,
        gateVerdicts: buildWorkflowGateVerdicts(lastReviewer, lastTechLeadDiff, lastDesigner, lastSecurity),
        findingsLedger,
        loopExitReason: 'hard-budget',
        objectionOpen: false,
        handoffNotes,
        acceptance: record,
        ...(adjudications.length > 0 ? { adjudications } : {}),
        ...(downgradedFindings.length > 0 ? { downgradedFindings } : {}),
        ...(approvedReviewSurfaceHash !== undefined
          ? { reviewSurfaceHash: approvedReviewSurfaceHash }
          : {}),
        ...(noCodeTestRationale !== undefined ? { noCodeTestRationale } : {}),
      };
    }
  }

  return block(task, roles, handoffNotes, {
    blockedReason: lastRejectionFeedback === undefined
      ? 'round cap reached with unresolved task feedback'
      : `round cap reached with unresolved task feedback: ${lastRejectionFeedback.whatFailed}`,
    ...(lastRejectionFeedback !== undefined
      ? { rejectionFeedback: lastRejectionFeedback }
      : {}),
    reviewerVerdict: lastReviewer,
    gateVerdicts: buildWorkflowGateVerdicts(lastReviewer, lastTechLeadDiff, lastDesigner, lastSecurity),
    findingsLedger,
    loopExitReason: 'hard-budget',
    downgradedFindings,
    adjudications,
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
    downgradedFindings?: DowngradedFinding[];
    adjudications?: AdjudicationRecord[];
    adjudicationFailure?: AdjudicationFailure;
    reviewQuorum?: ReviewQuorumEvidence;
    reviewQuorumFailure?: ReviewQuorumFailure;
    adjudicationUpheldFail?: true;
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
    ...(extra.adjudications !== undefined && extra.adjudications.length > 0
      ? { adjudications: extra.adjudications }
      : {}),
    ...(extra.adjudicationFailure !== undefined
      ? { adjudicationFailure: extra.adjudicationFailure }
      : {}),
    ...(extra.reviewQuorum !== undefined ? { reviewQuorum: extra.reviewQuorum } : {}),
    ...(extra.reviewQuorumFailure !== undefined
      ? { reviewQuorumFailure: extra.reviewQuorumFailure }
      : {}),
    ...(extra.adjudicationUpheldFail === true ? { adjudicationUpheldFail: true as const } : {}),
    ...(extra.downgradedFindings !== undefined && extra.downgradedFindings.length > 0
      ? { downgradedFindings: extra.downgradedFindings }
      : {}),
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
    downgradedFindings?: DowngradedFinding[];
    adjudications?: AdjudicationRecord[];
    adjudicationFailure?: AdjudicationFailure;
    reviewQuorum?: ReviewQuorumEvidence;
    reviewQuorumFailure?: ReviewQuorumFailure;
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
    ...(extra.adjudications !== undefined && extra.adjudications.length > 0
      ? { adjudications: extra.adjudications }
      : {}),
    ...(extra.adjudicationFailure !== undefined
      ? { adjudicationFailure: extra.adjudicationFailure }
      : {}),
    ...(extra.reviewQuorum !== undefined ? { reviewQuorum: extra.reviewQuorum } : {}),
    ...(extra.reviewQuorumFailure !== undefined
      ? { reviewQuorumFailure: extra.reviewQuorumFailure }
      : {}),
    ...(extra.downgradedFindings !== undefined && extra.downgradedFindings.length > 0
      ? { downgradedFindings: extra.downgradedFindings }
      : {}),
    ...(extra.noCodeTestRationale !== undefined
      ? { noCodeTestRationale: extra.noCodeTestRationale }
      : {}),
  };
}

/** Enforce the per-class evidence contract on one role's findings.
 *
 *  A blocking finding in a high-stakes class that carries neither a concrete
 *  location nor a concrete failure scenario gets the role exactly ONE bounded
 *  re-prompt to supply what is missing. What still fails afterwards is removed
 *  from the verdict and recorded as downgraded, so the cheapest possible
 *  objection stops having the same stopping power as a rigorous one.
 *
 *  The returned verdict's outcome is recomputed from the SURVIVING findings.
 *  That is sound because a verdict carrying findings always derives its outcome
 *  from them (both normalizers discard the role's own `outcome` field in that
 *  case) — so if every finding is downgraded, the verdict had no other reason to
 *  fail and becomes a pass.
 *
 *  A re-prompt that throws is swallowed: it is an evidence-gathering
 *  convenience, and its failure must not convert a role verdict into a task
 *  failure. The contract still applies to whatever the role originally said. */
async function applyEvidenceContract(
  deps: TeamTaskDeps,
  task: SizedTask,
  sourceGate: FindingSourceGate,
  verdict: GateVerdict,
  round: number,
  judgmentContext: JudgmentContext | undefined,
  downgraded: DowngradedFinding[],
): Promise<GateVerdict> {
  if (verdict.findings.length === 0) return verdict;

  const gapsBySignature = new Map<string, EvidenceGap[]>();
  for (const finding of verdict.findings) {
    const gaps = evidenceGapsForFinding(finding);
    if (gaps.length > 0) gapsBySignature.set(findingSignature(finding), gaps);
  }
  if (gapsBySignature.size === 0) return verdict;

  let findings = verdict.findings;
  let rePrompted = false;
  if (deps.requestFindingEvidence !== undefined) {
    rePrompted = true;
    try {
      const supplemented = await deps.requestFindingEvidence({
        role: sourceGate,
        task,
        gaps: verdict.findings.flatMap((finding) => {
          const gaps = gapsBySignature.get(findingSignature(finding));
          return gaps === undefined
            ? []
            : [{ finding, gaps, ask: describeEvidenceGaps(gaps) }];
        }),
        ...(judgmentContext !== undefined ? { judgmentContext } : {}),
      });
      // A re-prompt may only strengthen the SAME objections; it can neither add
      // new findings nor raise severity, or "supply evidence" would become a
      // second bite at the gate.
      if (supplemented.length > 0) {
        const usedSupplements = new Set<number>();
        findings = verdict.findings.map((original) => {
          const originalGaps = gapsBySignature.get(findingSignature(original));
          if (originalGaps === undefined) return original;
          const replacementIndex = supplemented.findIndex(
            (candidate, index) =>
              !usedSupplements.has(index) &&
              candidate.class === original.class &&
              candidate.severity === original.severity &&
              (originalGaps.includes('location') || candidate.location === original.location) &&
              (originalGaps.includes('failure-scenario') || candidate.rationale === original.rationale),
          );
          if (replacementIndex < 0) return original;
          usedSupplements.add(replacementIndex);
          return supplemented[replacementIndex]!;
        });
      }
    } catch {
      /* Evidence gathering is best-effort; the contract below still applies. */
    }
  }

  const surviving: ObjectionFinding[] = [];
  for (const finding of findings) {
    const gaps = evidenceGapsForFinding(finding);
    if (gaps.length === 0) {
      surviving.push(finding);
      continue;
    }
    downgraded.push({
      finding,
      sourceGate,
      round,
      gaps,
      reason: `downgraded to a non-blocking observation: a blocking ${finding.class} ` +
        `finding requires ${describeEvidenceGaps(gaps)}`,
      rePrompted,
    });
  }

  if (surviving.length === findings.length) {
    return { ...verdict, findings };
  }
  return {
    ...verdict,
    findings: surviving,
    outcome: surviving.length > 0 ? outcomeForObjectionSeverities(surviving) : 'pass',
  };
}

/** Severity at or above which a finding is never the PM's to accept. Sits beside
 *  `SEVERITY_LOOP_HARD_BUDGET` because both bound the same escape hatch: how far
 *  the machine may go before a human is required. */
export const PM_ACCEPTANCE_MAX_SEVERITY: ObjectionSeverity = 'medium';

/** Why the PM may NOT accept, or undefined when acceptance is permitted. Mirrors
 *  `agents/pm/SOUL.md`: the PM's authority does not extend to clearing
 *  objection-class findings, and irreversibility is never negotiable. */
function pmAcceptanceBlocker(
  ledger: FindingsLedgerEntry[],
  explicitNonReversibleFindingIds: Set<string>,
): string | undefined {
  for (const entry of openFindingsLedger(ledger)) {
    if (
      entry.reversible === false ||
      explicitNonReversibleFindingIds.has(entry.id)
    ) {
      return `non-reversible ${entry.class} finding at ${entry.location}`;
    }
    if (severityRank[entry.severity] >= severityRank[PM_ACCEPTANCE_MAX_SEVERITY]) {
      return `${entry.severity} ${entry.class} finding at ${entry.location}`;
    }
  }
  return undefined;
}

/** The gate is unanimous-AND, so a disagreement is modeled as failure and the
 *  run parks with nobody having compared the arguments. This detects the split:
 *  at least one dispatched role failed and at least one passed. */
function detectSplit(
  reviewer: GateVerdict | undefined,
  techLead: GateVerdict | undefined,
): {
  dissentingRole: Extract<FindingSourceGate, 'reviewer' | 'tech-lead'>;
  concurringRole: Extract<FindingSourceGate, 'reviewer' | 'tech-lead'>;
  dissentingVerdict: GateVerdict;
  concurringVerdict: GateVerdict;
} | undefined {
  if (reviewer === undefined || techLead === undefined) return undefined;
  const reviewerPasses = isGatePass(reviewer);
  const techLeadPasses = isGatePass(techLead);
  if (reviewerPasses === techLeadPasses) return undefined;
  return reviewerPasses
    ? {
        dissentingRole: 'tech-lead',
        concurringRole: 'reviewer',
        dissentingVerdict: techLead,
        concurringVerdict: reviewer,
      }
    : {
        dissentingRole: 'reviewer',
        concurringRole: 'tech-lead',
        dissentingVerdict: reviewer,
        concurringVerdict: techLead,
      };
}

function isFindingSourceGate(role: RoleName): role is FindingSourceGate {
  return role === 'reviewer' || role === 'tech-lead' || role === 'designer' || role === 'security';
}

function verdictForGate(
  role: FindingSourceGate,
  reviewer: GateVerdict | undefined,
  techLead: GateVerdict | undefined,
  designer: GateVerdict | undefined,
  security: GateVerdict | undefined,
): GateVerdict | undefined {
  if (role === 'reviewer') return reviewer;
  if (role === 'tech-lead') return techLead;
  if (role === 'designer') return designer;
  return security;
}

/** High/critical or explicitly irreversible objections are human-owned. */
function adjudicationHumanBlocker(verdict: GateVerdict): string | undefined {
  const finding = verdict.findings.find(
    (candidate) =>
      candidate.reversible === false ||
      severityRank[candidate.severity] >= severityRank.high,
  );
  if (finding === undefined) return undefined;
  return `human-owned ${finding.severity} ${finding.class} finding at ${finding.location}`;
}

/** Adjudication may settle only the current reviewer/tech-lead split. It must
 *  never erase a protected finding that remains open from another gate or an
 *  earlier round. Explicit irreversibility is tracked separately because the
 *  public ledger conservatively normalizes an omitted reversible flag to
 *  false, while only an explicit `false` transfers ownership to a human. */
function adjudicationLedgerHumanBlocker(
  ledger: FindingsLedgerEntry[],
  explicitNonReversibleFindingIds: Set<string>,
): string | undefined {
  const finding = openFindingsLedger(ledger).find((entry) =>
    explicitNonReversibleFindingIds.has(entry.id) ||
    severityRank[entry.severity] >= severityRank.high);
  if (finding === undefined) return undefined;
  const protectedKind = explicitNonReversibleFindingIds.has(finding.id)
    ? `non-reversible ${finding.severity}`
    : finding.severity;
  return `human-owned ${protectedKind} ${finding.class} finding at ${finding.location}`;
}

/** Identity of the disputed objection, so a repeat across rounds is detectable.
 *  A findings-free fail is identified by its notes instead. */
function splitSignature(verdict: GateVerdict): string {
  if (verdict.findings.length > 0) {
    return verdict.findings.map(findingSignature).sort().join(' | ');
  }
  return `notes: ${(verdict.notes ?? '').replace(/\s+/g, ' ').trim()}`;
}

/** An adjudication ruling is admissible only when it is complete. An empty
 *  rationale, or a fail upheld with no concrete finding for the blocked task
 *  record, is not a decision — it fails closed to the block.
 *
 *  An upheld finding must also satisfy the same class evidence contract every
 *  other blocking finding does. The adjudicator is the one role whose output
 *  nothing downstream reviews — its ruling is decisive for the round — so an
 *  unanchored assertion here would block a task with exactly the confident-but-
 *  ungrounded objection the contract exists to catch, and would do it with more
 *  authority than the reviewer's. Unlike a role gate there is no re-prompt and
 *  no downgrade: a gap makes the ruling inadmissible, which fails closed to the
 *  block and keeps the ungrounded finding out of the ledger, the coder feedback,
 *  and any later escalation. */
function rulingFailure(ruling: AdjudicationRuling | undefined): string | undefined {
  if (ruling === undefined) return 'adjudicator returned no ruling';
  if (ruling.upholds !== 'pass' && ruling.upholds !== 'fail') {
    return `adjudicator returned an unusable verdict "${String(ruling.upholds)}"`;
  }
  if (ruling.rationale.trim() === '') return 'adjudicator gave no rationale';
  if (ruling.upholds === 'fail') {
    if (ruling.finding === undefined) {
      return 'adjudicator upheld the fail without a finding for the coder';
    }
    const gaps = evidenceGapsForFinding(ruling.finding);
    if (gaps.length > 0) {
      return `adjudicator upheld the fail with a ${ruling.finding.class} finding that lacks ` +
        describeEvidenceGaps(gaps);
    }
  }
  return undefined;
}

/** Defense-in-depth classifier for a non-conforming ruling that reached the gate
 *  without passing the production parser (an alternate `adjudicateSplit`, a test
 *  double). Deliberately mirrors `rulingFailure`'s check ORDER so the same
 *  malformed ruling gets the same diagnostic on both paths, and re-derives the
 *  evidence gap from the finding rather than sniffing `rulingFailure`'s prose. */
function failureForInvalidRuling(ruling: AdjudicationRuling): AdjudicationFailure {
  const code: AdjudicationDiagnosticCode =
    ruling.upholds !== 'pass' && ruling.upholds !== 'fail'
      ? 'unsupported-verdict'
      : ruling.rationale.trim() === ''
        ? 'blank-rationale'
        : ruling.upholds === 'fail' && ruling.finding === undefined
          ? 'missing-finding'
          : ruling.finding !== undefined && evidenceGapsForFinding(ruling.finding).length > 0
            ? 'incomplete-finding-evidence'
            : 'malformed-finding';
  return {
    code: 'adjudication-output-invalid',
    cause: 'invalid-artifact',
    attempts: [{ attempt: 1, code }],
    ...(ruling.execution !== undefined
      ? {
          executedModelAlias: ruling.execution.modelAlias,
          executedProvider: ruling.execution.provider,
        }
      : {}),
  };
}

/** The single formatter for an operational-hold reason line. Exported so every
 *  producer of an `AdjudicationFailure` renders the same text from the same
 *  typed input instead of hardcoding a copy that can drift. */
export function adjudicationOperationalReason(failure: AdjudicationFailure): string {
  const diagnostic = failure.cause === 'unavailable'
    ? 'adjudicator unavailable'
    : failure.cause === 'provider-failure'
      ? 'provider or executor failure'
      : `invalid output after ${failure.attempts.length} attempt${failure.attempts.length === 1 ? '' : 's'}`;
  return `Adjudication operational hold: ${failure.code} (${diagnostic})`;
}

export const JUDGMENT_CANCEL_GRACE_MS = 1_000;
export const JUDGMENT_FORCE_SETTLE_GRACE_MS = 1_000;
export const JUDGMENT_SUMMARY_MAX_CHARS = 500;

function boundedJudgmentSummary(value: string): string {
  return scrubGenericAbsolutePaths(scrubAbsolutePaths(value))
    .replace(/[\r\n\t]+/g, ' ')
    .trim()
    .slice(0, JUDGMENT_SUMMARY_MAX_CHARS);
}

/** Backward-compatible parser for durable/API projections. Legacy records
 * simply omit this field; malformed new evidence is dropped fail-closed. */
export function parseReviewQuorumEvidence(value: unknown): ReviewQuorumEvidence | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  if (!['pending', 'satisfied', 'objected', 'failed'].includes(String(source['status'])) ||
      !source['roles'] || typeof source['roles'] !== 'object' || Array.isArray(source['roles'])) {
    return undefined;
  }
  const satisfyingRole = source['satisfyingRole'];
  const objectingRole = source['objectingRole'];
  if ((satisfyingRole !== undefined && !isEligibleReviewRole(satisfyingRole)) ||
      (objectingRole !== undefined && !isReviewRole(objectingRole))) return undefined;
  const status = source['status'];
  if (
    (status === 'satisfied' && (satisfyingRole === undefined || objectingRole !== undefined)) ||
    (status === 'objected' && (objectingRole === undefined || satisfyingRole !== undefined)) ||
    ((status === 'pending' || status === 'failed') &&
      (satisfyingRole !== undefined || objectingRole !== undefined))
  ) return undefined;
  const roles: ReviewQuorumEvidence['roles'] = {};
  for (const [key, raw] of Object.entries(source['roles'] as Record<string, unknown>)) {
    if (!isReviewRole(key) || !raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
    const role = raw as Record<string, unknown>;
    if (!['pending', 'running', 'pass', 'reject', 'operational-failure', 'cancelled']
      .includes(String(role['status'])) || !Number.isSafeInteger(role['attemptsConsumed']) ||
      Number(role['attemptsConsumed']) < 0 || Number(role['attemptsConsumed']) > REVIEW_BATCH_MAX_ATTEMPTS ||
      typeof role['retryEligible'] !== 'boolean' ||
      (role['durationMs'] !== undefined && (!Number.isSafeInteger(role['durationMs']) || Number(role['durationMs']) < 0)) ||
      (role['failureCategory'] !== undefined && !isReviewFailureCategory(role['failureCategory'])) ||
      (role['diagnostic'] !== undefined && typeof role['diagnostic'] !== 'string')) return undefined;
    roles[key] = {
      status: role['status'] as ReviewQuorumRoleEvidence['status'],
      attemptsConsumed: role['attemptsConsumed'] as number,
      retryEligible: role['retryEligible'] as boolean,
      ...(role['durationMs'] !== undefined ? { durationMs: role['durationMs'] as number } : {}),
      ...(role['failureCategory'] !== undefined
        ? { failureCategory: role['failureCategory'] as ReviewBatchFailureCategory }
        : {}),
      ...(role['diagnostic'] !== undefined
        ? { diagnostic: boundedJudgmentSummary(role['diagnostic'] as string) }
        : {}),
    };
  }
  if (satisfyingRole !== undefined && roles[satisfyingRole]?.status !== 'pass') return undefined;
  if (objectingRole !== undefined && roles[objectingRole]?.status !== 'reject') return undefined;
  return {
    status: status as ReviewQuorumEvidence['status'],
    ...(satisfyingRole !== undefined ? { satisfyingRole } : {}),
    ...(objectingRole !== undefined ? { objectingRole } : {}),
    roles,
  };
}

export function parseReviewQuorumFailure(value: unknown): ReviewQuorumFailure | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  if (!['review-paths-exhausted', 'required-designer-unavailable', 'review-surface-drift',
    'review-checkpoint-failure']
    .includes(String(source['category'])) || !Array.isArray(source['failedRoles']) ||
    !source['failedRoles'].every(isReviewRole) || typeof source['diagnostic'] !== 'string') {
    return undefined;
  }
  return {
    category: source['category'] as ReviewQuorumFailure['category'],
    failedRoles: [...source['failedRoles']] as ReviewBatchRole[],
    diagnostic: boundedJudgmentSummary(source['diagnostic']),
  };
}

function isReviewRole(value: unknown): value is ReviewBatchRole {
  return value === 'reviewer' || value === 'tech-lead' || value === 'designer' || value === 'security';
}

function isEligibleReviewRole(value: unknown): value is ReviewBatchEligibleRole {
  return value === 'reviewer' || value === 'tech-lead' || value === 'security';
}

function isReviewFailureCategory(value: unknown): value is ReviewBatchFailureCategory {
  return value === 'interrupted' || value === 'provider' || value === 'timeout' ||
    value === 'executor-exit' || value === 'checkpoint' || value === 'invalid-verdict' ||
    value === 'unknown';
}

interface ReviewBatchCall {
  role: JudgmentRole;
  call: (attempt: number, binding: ReviewBatchBinding) => Promise<unknown>;
}

interface CoordinatedReviewBatch {
  settled: Map<JudgmentRole, PromiseSettledResult<unknown>>;
  evidence: ReviewQuorumEvidence;
  failure?: ReviewQuorumFailure;
  cancellation?: RoleCancellationError;
}

async function coordinateReviewBatch(args: {
  task: SizedTask;
  input: TeamTaskRunInput;
  deps: TeamTaskDeps;
  round: number;
  judgmentBatchId: string;
  reviewState: Omit<CanonicalReviewState, 'diff'>;
  judgmentContext: JudgmentContext;
  invariantChecklistBlock?: string;
  invariantChecklist?: InvariantChecklistEvidence;
  findingsLedger: FindingsLedgerEntry[];
  coderSelfReviews: CoderSelfReviewRecord[];
  downgradedFindings: DowngradedFinding[];
  handoffNotes: string[];
  testIntentRepair?: TaskEvidence['testIntentRepair'];
  adjudications: AdjudicationRecord[];
  seenSplitSignatures: Set<string>;
  explicitNonReversibleFindingIds: Set<string>;
  previousMaxOpenSeverity?: ObjectionSeverity;
  flatMaxOpenSeverityRounds: number;
  finalizeVerdict?: (role: JudgmentRole, rawVerdict: unknown) => Promise<unknown>;
  resumeState?: ReviewBatchState;
  calls: ReviewBatchCall[];
}): Promise<CoordinatedReviewBatch> {
  const now = new Date().toISOString();
  const roleStates = args.calls.map(({ role }) => ({
    role,
    quorumEligible: role !== 'designer',
    required: role === 'designer',
    status: 'pending' as const,
    attemptsConsumed: 0,
    retryEligible: role !== 'designer',
    attempts: [],
  }));
  const freshState: ReviewBatchState = {
    version: 1,
    batchId: args.judgmentBatchId,
    taskId: args.task.id,
    taskBaseTree: args.reviewState.baseTree,
    currentReviewTree: args.reviewState.currentTree,
    canonicalHash: args.reviewState.hash,
    round: args.round,
    workflowAttempt: args.input.workflowAttempt ?? 1,
    createdAt: now,
    updatedAt: now,
    quorum: { status: 'pending' },
    roles: roleStates,
    resumeContext: {
      artifactPass: args.judgmentContext.artifactPass,
      tests: Array.isArray(args.judgmentContext.tests)
        ? [...args.judgmentContext.tests]
        : args.judgmentContext.tests,
      qa: args.judgmentContext.qa.kind === 'tests-written'
        ? { kind: 'tests-written', testIds: [...args.judgmentContext.qa.testIds] }
        : { ...args.judgmentContext.qa },
      coderHandoffNotes: [...args.judgmentContext.coderHandoffNotes],
      accumulatedHandoffNotes: [...args.handoffNotes],
      ...(args.testIntentRepair !== undefined
        ? { testIntentRepair: structuredClone(args.testIntentRepair) }
        : {}),
      ...(args.adjudications.length > 0
        ? {
            adjudications: structuredClone(args.adjudications) as unknown as Array<Record<string, unknown>>,
          }
        : {}),
      ...(args.invariantChecklistBlock !== undefined
        ? { invariantChecklistBlock: args.invariantChecklistBlock }
        : {}),
      ...(args.invariantChecklist !== undefined
        ? { invariantChecklist: structuredClone(args.invariantChecklist) }
        : {}),
      ...(args.findingsLedger.length > 0
        ? {
            findingsLedger: structuredClone(args.findingsLedger) as unknown as Array<Record<string, unknown>>,
          }
        : {}),
      ...(args.coderSelfReviews.length > 0
        ? {
            coderSelfReviews: structuredClone(args.coderSelfReviews) as unknown as Array<Record<string, unknown>>,
          }
        : {}),
      ...(args.downgradedFindings.length > 0
        ? {
            downgradedFindings: structuredClone(args.downgradedFindings) as unknown as Array<Record<string, unknown>>,
          }
        : {}),
      ...(args.seenSplitSignatures.size > 0
        ? { seenSplitSignatures: [...args.seenSplitSignatures] }
        : {}),
      ...(args.explicitNonReversibleFindingIds.size > 0
        ? { explicitNonReversibleFindingIds: [...args.explicitNonReversibleFindingIds] }
        : {}),
      ...(args.previousMaxOpenSeverity !== undefined
        ? { previousMaxOpenSeverity: args.previousMaxOpenSeverity }
        : {}),
      ...(args.flatMaxOpenSeverityRounds > 0
        ? { flatMaxOpenSeverityRounds: args.flatMaxOpenSeverityRounds }
        : {}),
    },
  };
  let resumeFailure: ReviewQuorumFailure | undefined;
  let state = freshState;
  if (args.resumeState !== undefined) {
    try {
      state = resumeReviewBatchState(args.resumeState, {
        taskId: args.task.id,
        baseTree: args.reviewState.baseTree,
        currentTree: args.reviewState.currentTree,
        canonicalHash: args.reviewState.hash,
        interruptedAt: now,
      });
    } catch (err) {
      if (!(err instanceof ReviewBatchResumeError)) throw err;
      resumeFailure = {
        category: 'review-surface-drift',
        failedRoles: [],
        diagnostic: sanitizeExecutionDiagnostic(
          `Review quorum operational hold: ${err.category}; ${err.message}`,
        ),
      };
      state = { ...freshState, quorum: { status: 'failed' } };
    }
  }
  if (resumeFailure === undefined && args.resumeState !== undefined) {
    const expectedRoles = args.calls.map(({ role }) => role).sort();
    const durableRoles = state.roles.map(({ role }) => role).sort();
    if (JSON.stringify(expectedRoles) !== JSON.stringify(durableRoles)) {
      resumeFailure = {
        category: 'review-surface-drift',
        failedRoles: [],
        diagnostic: 'Review quorum operational hold: durable review role set changed',
      };
      state = { ...state, quorum: { status: 'failed' } };
    }
  }
  let checkpointChain = Promise.resolve();
  const persist = async (): Promise<void> => {
    checkpointChain = checkpointChain
      .catch(() => undefined)
      .then(() => {
        const resumeContext = state.resumeContext === undefined
          ? undefined
          : {
              ...state.resumeContext,
              ...(args.downgradedFindings.length > 0
                ? {
                    downgradedFindings: structuredClone(args.downgradedFindings) as unknown as Array<Record<string, unknown>>,
                  }
                : {}),
            };
        state = {
          ...state,
          updatedAt: new Date().toISOString(),
          ...(resumeContext !== undefined ? { resumeContext } : {}),
        };
        return args.deps.persistReviewBatch?.(structuredClone(state));
      });
    await checkpointChain;
  };
  const finishBatch = async (): Promise<Error | undefined> => {
    try {
      await args.deps.finishJudgmentBatch?.(args.judgmentBatchId);
      return undefined;
    } catch (err) {
      return err instanceof Error ? err : new Error(String(err));
    }
  };
  try {
    await persist();
  } catch (err) {
    state = { ...state, quorum: { status: 'failed' } };
    const failure: ReviewQuorumFailure = {
      category: 'review-checkpoint-failure',
      failedRoles: [],
      diagnostic: sanitizeExecutionDiagnostic(
        `Review quorum operational hold: checkpoint write failed; ${(err as Error).message}`,
      ),
    };
    const finishError = await finishBatch();
    if (finishError !== undefined) {
      failure.diagnostic = sanitizeExecutionDiagnostic(
        `${failure.diagnostic}; batch cleanup failed: ${finishError.message}`,
      );
    }
    return { settled: new Map(), evidence: reviewQuorumEvidence(state), failure };
  }

  if (resumeFailure !== undefined) {
    const evidence = reviewQuorumEvidence(state);
    const finishError = await finishBatch();
    if (finishError !== undefined) {
      resumeFailure.diagnostic = sanitizeExecutionDiagnostic(
        `${resumeFailure.diagnostic}; batch cleanup failed: ${finishError.message}`,
      );
    }
    return { settled: new Map(), evidence, failure: resumeFailure };
  }

  const latest = new Map<JudgmentRole, PromiseSettledResult<unknown>>();
  const active = new Map<JudgmentRole, Promise<void>>();
  const rawSettledFinalizing = new Set<JudgmentRole>();
  const cancelledAtDecision = new Set<JudgmentRole>();
  const attemptStarted = new Map<JudgmentRole, number>();
  let suppressLateSettlements = false;
  let completionSignal: (() => void) | undefined;
  let queuedCompletions = 0;
  const nextCompletion = (): Promise<void> => {
    if (queuedCompletions > 0) {
      queuedCompletions -= 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => { completionSignal = resolve; });
  };
  const completeRole = (role: JudgmentRole): void => {
    active.delete(role);
    if (completionSignal !== undefined) {
      completionSignal();
      completionSignal = undefined;
    } else {
      queuedCompletions += 1;
    }
  };

  const bindingFor = (role: JudgmentRole, attempt: number): ReviewBatchBinding => {
    try {
      if (attempt > 1 && role !== 'designer') {
        const escalation = args.deps.resolveReviewRoleEscalation?.(role);
        if (escalation !== undefined) return escalation;
        const prior = state.roles.find((item) => item.role === role)?.attempts.at(-1);
        if (prior !== undefined) {
          return {
            model: prior.model,
            provider: prior.provider,
            ...(prior.format !== undefined ? { format: prior.format } : {}),
          };
        }
      }
      return args.deps.resolveReviewRoleBinding?.(role, attempt) ?? {
        model: 'unspecified',
        provider: role === 'reviewer' ? 'openai' : args.input.coderProvider,
      };
    } catch {
      return {
        model: 'unavailable',
        provider: role === 'reviewer'
          ? (args.input.coderProvider === 'anthropic' ? 'openai' : 'anthropic')
          : args.input.coderProvider,
      };
    }
  };
  const roleState = (role: JudgmentRole) => state.roles.find((item) => item.role === role)!;
  const replaceRole = (next: ReviewBatchState['roles'][number]): void => {
    state = { ...state, roles: state.roles.map((item) => item.role === next.role ? next : item) };
  };
  const launch = async (spec: ReviewBatchCall, attempt: number): Promise<void> => {
    const startedAt = new Date().toISOString();
    const binding = bindingFor(spec.role, attempt);
    const attemptCanRetry = spec.role !== 'designer' && attempt < REVIEW_BATCH_MAX_ATTEMPTS;
    const previous = roleState(spec.role);
    replaceRole({
      ...previous,
      status: 'running',
      attemptsConsumed: attempt,
      retryEligible: attemptCanRetry,
      attempts: [...previous.attempts, {
        attemptId: randomUUID(),
        attempt,
        status: 'running',
        startedAt,
        ...binding,
        retryEligible: attemptCanRetry,
      }],
    });
    attemptStarted.set(spec.role, Date.now());
    try {
      await persist();
    } catch (err) {
      const endedAt = new Date().toISOString();
      const diagnostic = sanitizeExecutionDiagnostic(
        `review running checkpoint write failed: ${(err as Error).message}`,
      );
      const failedRole = roleState(spec.role);
      const failedAttempt = failedRole.attempts.at(-1)!;
      replaceRole({
        ...failedRole,
        status: 'operational-failure',
        retryEligible: attemptCanRetry,
        attempts: [
          ...failedRole.attempts.slice(0, -1),
          {
            ...failedAttempt,
            status: 'operational-failure',
            endedAt,
            durationMs: Math.max(0, Date.now() - (attemptStarted.get(spec.role) ?? Date.now())),
            failureCategory: 'checkpoint',
            diagnostic,
            retryEligible: attemptCanRetry,
          },
        ],
      });
      latest.set(spec.role, { status: 'rejected', reason: new Error(diagnostic) });
      return;
    }
    const pending = Promise.resolve()
      .then(() => spec.call(attempt, binding))
      .then(async (value) => {
        if (suppressLateSettlements || cancelledAtDecision.has(spec.role)) return value;
        rawSettledFinalizing.add(spec.role);
        return args.finalizeVerdict === undefined
          ? value
          : args.finalizeVerdict(spec.role, value);
      })
      .then(
        (value) => {
          if (!cancelledAtDecision.has(spec.role)) {
            latest.set(spec.role, { status: 'fulfilled', value });
          }
          rawSettledFinalizing.delete(spec.role);
        },
        (reason) => {
          rawSettledFinalizing.delete(spec.role);
          if (!cancelledAtDecision.has(spec.role)) {
            latest.set(spec.role, { status: 'rejected', reason });
          }
        },
      )
      .then(async () => {
        if (suppressLateSettlements || cancelledAtDecision.has(spec.role)) {
          completeRole(spec.role);
          return;
        }
        const result = latest.get(spec.role)!;
        const endedAt = new Date().toISOString();
        const durationMs = Math.max(0, Date.now() - (attemptStarted.get(spec.role) ?? Date.now()));
        const previousState = roleState(spec.role);
        const previousAttempt = previousState.attempts.at(-1)!;
        const classified = classifyReviewSettlement(spec.role, result);
        const cancellation = result.status === 'rejected' &&
          result.reason instanceof RoleCancellationError
          ? operationCancellation(result.reason.cancellation)
          : undefined;
        const nextAttempt = {
          ...previousAttempt,
          status: classified.stateStatus,
          endedAt,
          durationMs,
          retryEligible: classified.stateStatus === 'operational-failure' &&
            attemptCanRetry,
          ...(classified.failureCategory !== undefined
            ? { failureCategory: classified.failureCategory }
            : {}),
          ...(classified.diagnostic !== undefined
            ? { diagnostic: classified.diagnostic }
            : {}),
          ...(classified.verdict !== undefined ? { verdict: classified.verdict } : {}),
          ...(classified.kind === 'cancelled'
            ? {
                cancellationReason: 'external' as const,
                ...(cancellation !== undefined ? { cancellation: { ...cancellation } } : {}),
              }
            : {}),
        };
        replaceRole({
          ...previousState,
          status: classified.stateStatus,
          retryEligible: nextAttempt.retryEligible,
          attempts: [...previousState.attempts.slice(0, -1), nextAttempt],
        });
        try {
          await persist();
        } catch (err) {
          const diagnostic = sanitizeExecutionDiagnostic(
            `review checkpoint write failed: ${(err as Error).message}`,
          );
          latest.set(spec.role, { status: 'rejected', reason: new Error(diagnostic) });
          const failedRole = roleState(spec.role);
          const failedAttempt = failedRole.attempts.at(-1)!;
          replaceRole({
            ...failedRole,
            status: 'operational-failure',
            retryEligible: attemptCanRetry,
            attempts: [
              ...failedRole.attempts.slice(0, -1),
              {
                ...failedAttempt,
                status: 'operational-failure',
                failureCategory: 'checkpoint',
                diagnostic,
                retryEligible: attemptCanRetry,
                verdict: undefined,
              },
            ],
          });
        } finally {
          completeRole(spec.role);
        }
      });
    active.set(spec.role, pending);
  };

  for (const role of state.roles) {
    const verdict = role.attempts.at(-1)?.verdict;
    if (role.status === 'verdict' && verdict !== undefined) {
      const normalized = verdict.normalizedVerdict;
      if (normalized !== undefined) {
        latest.set(role.role, { status: 'fulfilled', value: structuredClone(normalized) });
      } else if (verdict.findingCount === 0) {
        latest.set(role.role, {
          status: 'fulfilled',
          value: { outcome: verdict.outcome, findings: [], notes: verdict.summary },
        });
      }
    } else if (role.status === 'operational-failure') {
      latest.set(role.role, {
        status: 'rejected',
        reason: new Error(role.attempts.at(-1)?.diagnostic ?? `${role.role} review interrupted`),
      });
    } else if (role.status === 'cancelled') {
      const attempt = role.attempts.at(-1);
      const cancellation = attempt?.cancellation;
      if (attempt?.cancellationReason !== 'external') cancelledAtDecision.add(role.role);
      latest.set(role.role, {
        status: 'rejected',
        reason: new RoleCancellationError(role.role, {
          operationId: cancellation?.operationId ?? state.batchId,
          source: cancellation?.source ?? 'internal',
          requestedAt: cancellation?.requestedAt ?? attempt?.endedAt ?? state.updatedAt,
        }),
      });
    }
  }

  let decision: ReviewBatchCancellationReason | undefined;
  let satisfyingRole: ReviewBatchEligibleRole | undefined;
  let objectingRole: ReviewBatchRole | undefined;
  let externalCancellation: RoleCancellationError | undefined;
  let terminalCheckpointError: Error | undefined;
  let eligibleQuorumCheckpointed = state.quorum.status === 'satisfied';

  const evaluate = (): void => {
    // A role whose model call already completed is no longer an unresolved
    // sibling: drain its bounded evidence-contract finalization before either
    // a completed objection or a pass is allowed to cancel it.
    if (rawSettledFinalizing.size > 0) return;
    if (args.calls.some(({ role }) =>
      active.has(role) && latest.has(role) && !cancelledAtDecision.has(role))) return;
    for (const { role } of args.calls) {
      if (active.has(role)) continue;
      const result = latest.get(role);
      if (result === undefined) continue;
      const classified = classifyReviewSettlement(role, result);
      if (classified.kind === 'reject') {
        objectingRole = role;
        decision = 'objection';
        return;
      }
    }
    const cancellations = args.calls.flatMap(({ role }) => {
      if (active.has(role) || cancelledAtDecision.has(role)) return [];
      const result = latest.get(role);
      return result?.status === 'rejected' && result.reason instanceof RoleCancellationError
        ? [result.reason]
        : [];
    });
    if (cancellations.length > 0) {
      externalCancellation = cancellations.find(
        (item) => item.cancellation.source !== 'internal',
      ) ?? cancellations[0];
      decision = 'external';
      return;
    }
    if (satisfyingRole === undefined) {
      for (const role of ['reviewer', 'tech-lead', 'security'] as const) {
        if (active.has(role)) continue;
        if (classifyReviewSettlement(role, latest.get(role)).kind === 'pass') {
          satisfyingRole = role;
          break;
        }
      }
    }
    const designerPassed = !args.task.designerNeeded ||
      (!active.has('designer') &&
        classifyReviewSettlement('designer', latest.get('designer')).kind === 'pass');
    if (satisfyingRole !== undefined && designerPassed) {
      decision = 'quorum-satisfied';
    }
  };

  const cancelRoles = async (
    roles: ReviewBatchRole[],
    reason: ReviewBatchCancellationReason,
    cancellation?: OperationCancellation,
  ): Promise<void> => {
    if (roles.length === 0) return;
    const requestedAt = new Date().toISOString();
    args.deps.cancelJudgmentBatch?.(args.judgmentBatchId, reason, roles);
    for (const role of roles) {
      cancelledAtDecision.add(role);
      const previous = roleState(role);
      const attempts = previous.attempts.length === 0
        ? [{
            attemptId: randomUUID(),
            attempt: 1,
            status: 'cancelled' as const,
            startedAt: requestedAt,
            endedAt: requestedAt,
            durationMs: 0,
            ...bindingFor(role, 1),
            retryEligible: false,
            cancellationReason: reason,
            ...(reason === 'external' && cancellation !== undefined
              ? { cancellation: { ...cancellation } }
              : {}),
          }]
        : previous.attempts.map((attempt, index) => index === previous.attempts.length - 1
            ? {
                ...attempt,
                status: 'cancelled' as const,
                endedAt: requestedAt,
                durationMs: Math.max(0, Date.now() - (attemptStarted.get(role) ?? Date.now())),
                retryEligible: false,
                cancellationReason: reason,
                ...(reason === 'external' && cancellation !== undefined
                  ? { cancellation: { ...cancellation } }
                  : {}),
              }
            : attempt);
      replaceRole({
        ...previous,
        status: 'cancelled',
        attemptsConsumed: attempts.length,
        retryEligible: false,
        attempts,
      });
      latest.set(role, {
        status: 'rejected',
        reason: new RoleCancellationError(role, {
          operationId: args.judgmentBatchId,
          source: 'internal',
          requestedAt,
        }),
      });
    }
    try {
      await persist();
    } catch (err) {
      terminalCheckpointError = err instanceof Error ? err : new Error(String(err));
    }
  };

  const checkpointEligibleQuorum = async (): Promise<void> => {
    if (satisfyingRole === undefined || eligibleQuorumCheckpointed) return;
    eligibleQuorumCheckpointed = true;
    state = { ...state, quorum: { status: 'satisfied', satisfyingRole } };
    const unresolvedEligible = state.roles
      .filter((role) => role.quorumEligible &&
        (role.status === 'pending' || role.status === 'running') && !latest.has(role.role))
      .map(({ role }) => role);
    await cancelRoles(unresolvedEligible, 'quorum-satisfied');
    if (unresolvedEligible.length === 0) {
      try {
        await persist();
      } catch (err) {
        terminalCheckpointError = err instanceof Error ? err : new Error(String(err));
      }
    }
    const evidence = reviewQuorumEvidence(state);
    emitReviewQuorumProgress(args.input, {
      event: 'review-quorum-satisfied',
      line: `${satisfyingRole} satisfied independent review quorum; ${reviewRoleProgressLine(evidence)}.`,
      satisfyingRole,
      roles: evidence.roles,
    });
  };

  evaluate();
  await checkpointEligibleQuorum();
  evaluate();
  if (decision === undefined) {
    const pendingCalls = args.calls.filter(({ role }) => roleState(role).status === 'pending' &&
      !(satisfyingRole !== undefined && role !== 'designer'));
    for (const spec of pendingCalls) {
      await launch(spec, roleState(spec.role).attemptsConsumed + 1);
    }
    await drainReviewSettlementQueue();
    evaluate();
    await checkpointEligibleQuorum();
    evaluate();
  }
  while (active.size > 0 && decision === undefined) {
    const signal = nextCompletion();
    await signal;
    // Drain settlements already queued in this turn before a pass is allowed
    // to cancel siblings; a completed objection always wins this comparison.
    await drainReviewSettlementQueue();
    evaluate();
    await checkpointEligibleQuorum();
    evaluate();
  }

  if (decision === undefined) {
    const designerUnavailable = args.task.designerNeeded &&
      classifyReviewSettlement('designer', latest.get('designer')).kind === 'operational-failure';
    const eligiblePassCompleted = (['reviewer', 'tech-lead', 'security'] as const).some((role) =>
      classifyReviewSettlement(role, latest.get(role)).kind === 'pass');
    const retryCalls = designerUnavailable || eligiblePassCompleted ? [] : args.calls.filter(({ role }) => {
      const classified = classifyReviewSettlement(role, latest.get(role));
      return role !== 'designer' && classified.kind === 'operational-failure' &&
        roleState(role).attemptsConsumed < REVIEW_BATCH_MAX_ATTEMPTS;
    });
    if (retryCalls.length > 0) {
      emitReviewQuorumProgress(args.input, {
        event: 'review-quorum-retry',
        line: `Review quorum is still pending; retrying ${retryCalls.map(({ role }) => {
          const attempt = roleState(role).attempts.at(-1);
          return `${role} (${attempt?.failureCategory ?? 'unknown'}, ${attempt?.durationMs ?? 0}ms)`;
        }).join(' and ')} once; each retry is the final eligible attempt.`,
        retryingRoles: retryCalls.map(({ role }) => role),
      });
      for (const spec of retryCalls) {
        await launch(spec, roleState(spec.role).attemptsConsumed + 1);
      }
      if (active.size === 0) {
        evaluate();
        await checkpointEligibleQuorum();
        evaluate();
      }
      while (active.size > 0 && decision === undefined) {
        const signal = nextCompletion();
        await signal;
        await drainReviewSettlementQueue();
        evaluate();
        await checkpointEligibleQuorum();
        evaluate();
      }
    }
  }

  const unresolvedAtDecision = decision === undefined
    ? []
    : state.roles
        .filter((role) => (role.status === 'pending' || role.status === 'running') && !latest.has(role.role))
        .map(({ role }) => role);
  if (decision !== undefined) {
    if (unresolvedAtDecision.length > 0) {
      await cancelRoles(
        unresolvedAtDecision,
        decision,
        decision === 'external' && externalCancellation !== undefined
          ? operationCancellation(externalCancellation.cancellation)
          : undefined,
      );
    }
    if (decision === 'quorum-satisfied') {
      state = { ...state, quorum: { status: 'satisfied', satisfyingRole } };
    } else if (decision === 'objection') {
      state = { ...state, quorum: { status: 'objected', objectingRole } };
    }
    try {
      await persist();
    } catch (err) {
      terminalCheckpointError = err instanceof Error ? err : new Error(String(err));
    }
  }

  let exhaustedFailure: ReviewQuorumFailure | undefined;
  if (decision === undefined && terminalCheckpointError === undefined) {
    const failedRoles = state.roles
      .filter((role) => role.status === 'operational-failure')
      .map(({ role }) => role);
    const designerFailed = args.task.designerNeeded &&
      roleState('designer').status === 'operational-failure';
    const checkpointFailed = failedRoles.some((role) =>
      roleState(role).attempts.at(-1)?.failureCategory === 'checkpoint');
    exhaustedFailure = {
      category: checkpointFailed
        ? 'review-checkpoint-failure'
        : designerFailed ? 'required-designer-unavailable' : 'review-paths-exhausted',
      failedRoles,
      diagnostic: sanitizeExecutionDiagnostic(
        `Review quorum operational hold: ${failedRoles.map((role) => {
          const item = roleState(role).attempts.at(-1);
          return `${role} ${item?.failureCategory ?? 'unknown'} after ${item?.durationMs ?? 0}ms` +
            (item?.diagnostic === undefined ? '' : `: ${item.diagnostic}`);
        }).join('; ') || 'no independent review verdict completed'}`,
      ),
    };
    state = { ...state, quorum: { status: 'failed' } };
    try {
      await persist();
    } catch (err) {
      terminalCheckpointError = err instanceof Error ? err : new Error(String(err));
    }
  }

  if (active.size > 0 && decision !== undefined) {
    await waitForReviewCleanup(args.deps, args.judgmentBatchId, active);
  }
  suppressLateSettlements = true;
  const finishError = await finishBatch();
  terminalCheckpointError ??= finishError;
  if (externalCancellation !== undefined) {
    return {
      settled: latest,
      evidence: reviewQuorumEvidence(state),
      cancellation: externalCancellation,
    };
  }

  if (terminalCheckpointError !== undefined) {
    state = { ...state, quorum: { status: 'failed' } };
    const failedRoles = state.roles
      .filter((role) => role.status === 'operational-failure')
      .map(({ role }) => role);
    const failure: ReviewQuorumFailure = {
      category: 'review-checkpoint-failure',
      failedRoles,
      diagnostic: sanitizeExecutionDiagnostic(
        `Review quorum operational hold: checkpoint write failed; ${terminalCheckpointError.message}`,
      ),
    };
    const failedEvidence = reviewQuorumEvidence(state);
    emitReviewQuorumProgress(args.input, {
      event: 'review-quorum-hold',
      line: failure.diagnostic,
      failureCategory: failure.category,
      failedRoles,
      roles: failedEvidence.roles,
    });
    return { settled: latest, evidence: failedEvidence, failure };
  }

  const evidence = reviewQuorumEvidence(state);
  if (decision === 'quorum-satisfied' || decision === 'objection') {
    emitReviewQuorumProgress(args.input, {
      event: decision === 'quorum-satisfied' ? 'review-quorum-satisfied' : 'review-quorum-objection',
      line: decision === 'quorum-satisfied'
        ? `${satisfyingRole} satisfied independent review quorum; ${reviewRoleProgressLine(evidence)}.`
        : `${objectingRole} completed an objection; ${reviewRoleProgressLine(evidence)}.`,
      ...(satisfyingRole !== undefined ? { satisfyingRole } : {}),
      ...(objectingRole !== undefined ? { objectingRole } : {}),
      roles: evidence.roles,
    });
    return { settled: latest, evidence };
  }

  const failure = exhaustedFailure ?? {
    category: 'review-paths-exhausted' as const,
    failedRoles: [],
    diagnostic: 'Review quorum operational hold: no independent review verdict completed',
  };
  const failedEvidence = reviewQuorumEvidence(state);
  emitReviewQuorumProgress(args.input, {
    event: 'review-quorum-hold',
    line: failure.diagnostic,
    failureCategory: failure.category,
    failedRoles: failure.failedRoles,
    roles: failedEvidence.roles,
  });
  return { settled: latest, evidence: failedEvidence, failure };
}

function reviewRoleProgressLine(evidence: ReviewQuorumEvidence): string {
  return Object.entries(evidence.roles).map(([role, state]) => {
    const duration = state?.durationMs === undefined ? '' : ` in ${state.durationMs}ms`;
    const failure = state?.failureCategory === undefined ? '' : ` (${state.failureCategory})`;
    const retry = state?.retryEligible ? ', retry remains' : ', retry exhausted/not applicable';
    return `${role} ${state?.status ?? 'pending'}${duration}${failure}${retry}`;
  }).join('; ');
}

async function drainReviewSettlementQueue(): Promise<void> {
  // A role call and its durable settlement span several promise reactions
  // (invoke → classify → checkpoint). Drain the finite chain without waiting
  // on genuinely unresolved siblings or introducing a timer dependency.
  for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
}

function classifyReviewSettlement(
  role: JudgmentRole,
  result: PromiseSettledResult<unknown> | undefined,
): {
  kind: 'pending' | 'pass' | 'reject' | 'operational-failure' | 'cancelled';
  stateStatus: ReviewBatchState['roles'][number]['status'];
  failureCategory?: ReviewBatchFailureCategory;
  diagnostic?: string;
  verdict?: {
    outcome: GateOutcome;
    findingCount: number;
    summary?: string;
    normalizedVerdict?: Record<string, unknown>;
  };
} {
  if (result === undefined) return { kind: 'pending', stateStatus: 'pending' };
  if (result.status === 'rejected') {
    if (result.reason instanceof RoleCancellationError) {
      return { kind: 'cancelled', stateStatus: 'cancelled' };
    }
    const diagnostic = sanitizeExecutionDiagnostic(result.reason);
    return {
      kind: 'operational-failure',
      stateStatus: 'operational-failure',
      failureCategory: reviewFailureCategory(result.reason),
      diagnostic,
    };
  }
  if (role === 'reviewer' && result.value && typeof result.value === 'object' &&
      !Array.isArray(result.value) &&
      typeof (result.value as Record<string, unknown>)['operationalFailureReason'] === 'string') {
    return {
      kind: 'operational-failure',
      stateStatus: 'operational-failure',
      failureCategory: 'invalid-verdict',
      diagnostic: sanitizeExecutionDiagnostic(
        (result.value as Record<string, unknown>)['operationalFailureReason'],
      ),
    };
  }
  const verdict = role === 'reviewer'
    ? normalizeReviewerVerdict(result.value as ReviewerVerdict)
    : normalizeGateVerdict(result.value as GateReviewVerdict);
  if (role === 'reviewer' && 'operationalFailureReason' in verdict &&
      verdict.operationalFailureReason !== undefined) {
    return {
      kind: 'operational-failure',
      stateStatus: 'operational-failure',
      failureCategory: 'invalid-verdict',
      diagnostic: sanitizeExecutionDiagnostic(verdict.operationalFailureReason),
    };
  }
  const pass = role === 'reviewer'
    ? isReviewerPass(verdict as NormalizedReviewerVerdict)
    : isGatePass(verdict);
  return {
    kind: pass ? 'pass' : 'reject',
    stateStatus: 'verdict',
    verdict: {
      outcome: verdict.outcome,
      findingCount: verdict.findings.length,
      ...(verdict.notes ? { summary: boundedJudgmentSummary(verdict.notes) } : {}),
      normalizedVerdict: structuredClone(verdict) as unknown as Record<string, unknown>,
    },
  };
}

function reviewFailureCategory(reason: unknown): ReviewBatchFailureCategory {
  if (reason instanceof ExecutionFailureError) {
    if (reason.failure.failureStage === 'timeout') return 'timeout';
    if (reason.failure.failureStage === 'executor-exit') return 'executor-exit';
    if (reason.failure.failureStage === 'orchestration-adjacent' &&
        /checkpoint/i.test(reason.failure.diagnostic)) return 'checkpoint';
    return 'provider';
  }
  const message = String((reason as Error)?.message ?? reason).toLowerCase();
  if (message.includes('checkpoint')) return 'checkpoint';
  if (message.includes('timed out') || message.includes('timeout')) return 'timeout';
  if (message.includes('exited') || message.includes('aborted_streaming')) return 'executor-exit';
  return 'provider';
}

function reviewQuorumEvidence(state: ReviewBatchState): ReviewQuorumEvidence {
  return {
    status: state.quorum.status,
    ...(state.quorum.satisfyingRole !== undefined
      ? { satisfyingRole: state.quorum.satisfyingRole }
      : {}),
    ...(state.quorum.objectingRole !== undefined
      ? { objectingRole: state.quorum.objectingRole }
      : {}),
    roles: Object.fromEntries(state.roles.map((role) => {
      const latest = role.attempts.at(-1);
      const status: ReviewQuorumRoleEvidence['status'] = role.status === 'verdict'
        ? latest?.verdict?.outcome === 'fail' ? 'reject' : 'pass'
        : role.status;
      return [role.role, {
        status,
        attemptsConsumed: role.attemptsConsumed,
        retryEligible: role.retryEligible,
        ...(latest?.durationMs !== undefined ? { durationMs: latest.durationMs } : {}),
        ...(latest?.failureCategory !== undefined
          ? { failureCategory: latest.failureCategory }
          : {}),
        ...(latest?.diagnostic !== undefined ? { diagnostic: latest.diagnostic } : {}),
      }];
    })),
  };
}

async function waitForReviewCleanup(
  deps: TeamTaskDeps,
  batchId: string,
  active: Map<JudgmentRole, Promise<void>>,
): Promise<void> {
  let forceTimer: ReturnType<typeof setTimeout> | undefined;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.allSettled([...active.values()]),
      new Promise<void>((resolve) => {
        forceTimer = setTimeout(() => {
          deps.forceCancelJudgmentBatch?.(batchId, [...active.keys()]);
          deadlineTimer = setTimeout(resolve, JUDGMENT_FORCE_SETTLE_GRACE_MS);
        }, JUDGMENT_CANCEL_GRACE_MS);
      }),
    ]);
  } finally {
    if (forceTimer !== undefined) clearTimeout(forceTimer);
    if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
  }
}

function emitReviewQuorumProgress(
  input: TeamTaskRunInput,
  data: Record<string, unknown>,
): void {
  try {
    input.emit?.({ kind: 'activity', data });
  } catch {
    // Observability cannot change review coordination.
  }
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

function conditionalGateBlockReason(
  task: SizedTask,
  designer: GateVerdict | undefined,
): string | undefined {
  if (task.designerNeeded && !isGatePass(designer)) return 'designer review failed';
  return undefined;
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
  security: 3,
};

function hasOnlySeverityDerivedFailures(
  reviewer: NormalizedReviewerVerdict | undefined,
  techLeadDiff: GateVerdict | undefined,
  designer: GateVerdict | undefined,
  security: GateVerdict | undefined,
): boolean {
  // The conditional security gate is not a severity-loop disagreement: while
  // it remains red, neither stagnation nor the cap's severity escape hatch may
  // authorize closeout. The explicit round-cap guard reports the terminal block.
  if (security !== undefined && !isGatePass(security)) return false;
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
  security: GateVerdict | undefined,
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
  for (const finding of security?.findings ?? []) {
    if (finding.severity !== 'low') {
      emitObjection(input, toPublicFinding(finding), 'security', 'security-review');
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
  security: GateVerdict | undefined,
): WorkflowGateVerdicts | undefined {
  const verdicts: WorkflowGateVerdicts = {};
  if (reviewer !== undefined && reviewer.operationalFailureReason === undefined) {
    verdicts.reviewer = toPublicGateVerdict(reviewer);
  }
  if (techLeadDiff !== undefined) verdicts.techLeadDiff = toPublicGateVerdict(techLeadDiff);
  if (designer !== undefined) verdicts.designer = toPublicGateVerdict(designer);
  if (security !== undefined) verdicts.security = toPublicGateVerdict(security);
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
    } else if (finding.reversible === true) {
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

/** Close exactly the findings included in the verdict the adjudicator saw.
 * Older findings from the same gate remain open: a ruling on one claim has no
 * authority over a different claim, and only the adjudicated findings are
 * separately recorded as follow-ups. */
function resolveAdjudicatedFindings(
  ledger: FindingsLedgerEntry[],
  sourceGate: FindingSourceGate,
  findings: ObjectionFinding[],
): void {
  const adjudicatedIds = new Set(findings.map((finding) =>
    buildFindingId(sourceGate, toPublicFinding(finding))));
  for (const entry of ledger) {
    if (
      entry.sourceGate === sourceGate &&
      adjudicatedIds.has(entry.id) &&
      isUnresolvedFinding(entry)
    ) {
      entry.status = 'resolved';
    }
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

function resolveQuorumReviewedFindings(
  ledger: FindingsLedgerEntry[],
  reviewedFindings: FindingsLedgerEntry[],
): void {
  const reviewedIds = new Set(reviewedFindings.map(({ id }) => id));
  for (const entry of ledger) {
    if (reviewedIds.has(entry.id) && isUnresolvedFinding(entry)) entry.status = 'resolved';
  }
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

function emitRoleStage(
  input: TeamTaskRunInput,
  role: RoleName,
  stage: string,
  details: Record<string, unknown> = {},
): void {
  if (input.emit === undefined) return;
  const label = `${role}: ${stage}`;
  try {
    input.emit({
      kind: 'activity',
      data: {
        event: 'role-stage',
        role,
        stage,
        ...details,
        label,
        line: label,
      },
    });
  } catch {
    /* activity sinks are observability-only; they must not fail the task. */
  }
}

function emitInvariantChecklist(
  input: TeamTaskRunInput,
  checklist: InvariantChecklistEvidence,
): void {
  if (input.emit === undefined) return;
  try {
    input.emit({
      kind: 'activity',
      data: {
        event: 'pre-coder-invariant',
        stage: 'accepted',
        contentHash: checklist.contentHash,
        itemCount: checklist.items.length,
        line: `pre-coder invariants: accepted ${checklist.items.length} items · ${checklist.contentHash.slice(0, 12)}`,
      },
    });
  } catch {
    /* activity sinks are observability-only; they must not fail the task. */
  }
}

/** Record an acceptance-over-dissent on the run's activity stream. The operator
 *  NOTIFICATION is raised a layer up, in `project-orchestrator`, which owns the
 *  progress-event channel that reaches Telegram and the cockpit. */
function emitPmAcceptance(
  input: TeamTaskRunInput,
  task: SizedTask,
  acceptance: PmAcceptance,
  rejectionFeedback: GateRejectionFeedback | undefined,
): void {
  if (input.emit === undefined) return;
  const overriddenRole = rejectionFeedback?.rejectingRole ?? 'reviewer';
  const taskText = scrubActivityText(task.text);
  const rationale = scrubActivityText(acceptance.rationale);
  try {
    input.emit({
      kind: 'activity',
      data: {
        event: 'pm-acceptance',
        taskId: task.id,
        taskText,
        actor: acceptance.actor,
        overriddenRole,
        rationale,
        line: `${acceptance.actor} accepted "${taskText}" over ${overriddenRole}'s dissent · ` +
          rationale,
      },
    });
  } catch {
    /* activity sinks are observability-only; they must not fail the task. */
  }
}

function scrubActivityText(value: string): string {
  return redactSecrets(scrubGenericAbsolutePaths(scrubAbsolutePaths(value)));
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
