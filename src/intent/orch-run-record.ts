/**
 * Orchestrated task run record (project 14, Phase 3).
 *
 * One record per task attempt — the durable, truthful evidence Rune keeps for
 * each task it drives. It is what restart reconstruction reads and what the
 * finalizer handoff carries. The field set is fixed by test-plan §3: a record
 * that drops a field can't be the audit source of truth.
 *
 * Pure types + a normalizing builder. Persistence (the JSONL store) is the
 * runtime layer's job.
 */

import {
  CANONICAL_CHANGED_PATHS_MAX,
  JUDGMENT_SUMMARY_MAX_CHARS,
  SELF_REVIEW_NOTE_MAX_CHARS,
  SEVERITY_LOOP_HARD_BUDGET,
  type CoderSelfReviewRecord,
  type JudgmentOutcomeEvidence,
  type ObjectionFinding,
  type PmAcceptance,
} from './team-task-workflow.js';
import type { RelatedTestDiagnostic } from './related-test-diagnostic.js';
import {
  durableArtifactAttempts,
  durableExecutionFailure,
} from './execution-failure.js';
import type { ExecutionFailure } from './execution-failure.js';
import {
  parseDurableValidationReceipt,
  parseFullSuiteAttestation,
  type DurableValidationReceipt,
  type FullSuiteAttestation,
} from './full-suite-attestation.js';

/** Outcome the team-task workflow returned for this attempt. */
export type TaskWorkflowOutcome = 'ready-for-closeout' | 'blocked' | 'failed';

/** What the context curator did with this task's proposed context update. */
export type TaskContextOutcome = 'updated' | 'unchanged' | 'rejected';

export interface TaskRunRecord {
  /** Stable task id (slug of the task text). */
  taskId: string;
  /** The task text as it appeared in `tasks.md`. */
  taskText: string;
  /** This attempt's id — a task may be retried with a new attempt id. */
  attemptId: string;
  /** Roles convened for this attempt. */
  rolesInvoked: string[];
  /** Durable transcript ids for the role invocations. */
  transcriptIds: string[];
  /** Role → model/provider chosen for it (e.g. coder: 'claude', reviewer: 'codex'). */
  modelChoices: Record<string, string>;
  /** The closeout commit sha, or null if the attempt didn't reach a commit. */
  commitSha: string | null;
  /** Role → verdict (e.g. reviewer: 'pass'). */
  verdicts: Record<string, string>;
  /** Accepted low-severity findings from pass-with-warnings reviews. */
  warnings?: ObjectionFinding[];
  /** Human/PM rationale for accepting non-objection disagreement. */
  acceptance?: PmAcceptance;
  /** Successful worktree coder self-reviews. Optional for historical JSONL. */
  coderSelfReviews?: CoderSelfReviewRecord[];
  /** Typed executor failure. Optional for successful and historical records. */
  executionFailure?: ExecutionFailure;
  /** Related-test fallback evidence. Optional for historical JSONL. */
  relatedTestDiagnostic?: RelatedTestDiagnostic;
  /** Rune-owned canonical suite evidence. Optional for legacy records. */
  fullSuiteAttestation?: FullSuiteAttestation;
  /** Bounded validation provenance projected to operator surfaces. */
  validationReceipt?: DurableValidationReceipt;
  /** Stable, bounded post-coder fan-in outcomes. Optional for historical JSONL. */
  judgmentOutcomes?: JudgmentOutcomeEvidence[];
  /** Stable pre-mutation task tree. Optional for historical JSONL. */
  taskBaseTree?: string;
  /** Exact tree judged by QA and downstream reviewers. */
  currentReviewTree?: string;
  /** Hash of the full-task diff between the two review trees. */
  fullTaskReviewHash?: string;
  /** What happened to `context.md` on this attempt. */
  contextOutcome: TaskContextOutcome;
  /** Gate decisions the orchestrator made. */
  gates: { objectionOpen: boolean };
  /** The workflow outcome that produced this record. */
  outcome: TaskWorkflowOutcome;
}

/**
 * Normalize a task run record — defensive copies of the array/object fields so a
 * stored record can't be mutated through the caller's references. Returns a
 * record carrying exactly the required field set.
 */
export function buildTaskRunRecord(input: TaskRunRecord): TaskRunRecord {
  const fullSuiteAttestation = parseFullSuiteAttestation(input.fullSuiteAttestation);
  const validationReceipt = parseDurableValidationReceipt(input.validationReceipt);
  return {
    taskId: input.taskId,
    taskText: input.taskText,
    attemptId: input.attemptId,
    rolesInvoked: [...input.rolesInvoked],
    transcriptIds: [...input.transcriptIds],
    modelChoices: { ...input.modelChoices },
    commitSha: input.commitSha,
    verdicts: { ...input.verdicts },
    ...(input.warnings !== undefined
      ? { warnings: input.warnings.map((warning) => ({ ...warning })) }
      : {}),
    ...(input.acceptance !== undefined
      ? { acceptance: { ...input.acceptance } }
      : {}),
    ...(input.coderSelfReviews !== undefined
      ? {
          coderSelfReviews: input.coderSelfReviews
            .slice(0, SEVERITY_LOOP_HARD_BUDGET)
            .map((review) => {
              const artifactAttempts = durableArtifactAttempts(review.artifactAttempts);
              return {
                ...review,
                notes: review.notes.slice(0, SELF_REVIEW_NOTE_MAX_CHARS),
                changedPaths: review.changedPaths.slice(
                  0,
                  CANONICAL_CHANGED_PATHS_MAX,
                ),
                ...(artifactAttempts !== undefined ? { artifactAttempts } : {}),
              };
            }),
        }
      : {}),
    ...(input.executionFailure !== undefined
      ? { executionFailure: durableExecutionFailure(input.executionFailure) }
      : {}),
    ...(input.relatedTestDiagnostic !== undefined
      ? { relatedTestDiagnostic: structuredClone(input.relatedTestDiagnostic) }
      : {}),
    ...(fullSuiteAttestation !== undefined
      ? { fullSuiteAttestation }
      : {}),
    ...(validationReceipt !== undefined
      ? { validationReceipt }
      : {}),
    ...(input.judgmentOutcomes !== undefined
      ? {
          judgmentOutcomes: input.judgmentOutcomes.slice(0, 4).map((outcome) => ({
            role: outcome.role,
            status: outcome.status,
            ...(outcome.summary !== undefined
              ? { summary: outcome.summary.slice(0, JUDGMENT_SUMMARY_MAX_CHARS) }
              : {}),
          })),
        }
      : {}),
    ...(input.taskBaseTree !== undefined
      ? { taskBaseTree: input.taskBaseTree }
      : {}),
    ...(input.currentReviewTree !== undefined
      ? { currentReviewTree: input.currentReviewTree }
      : {}),
    ...(input.fullTaskReviewHash !== undefined
      ? { fullTaskReviewHash: input.fullTaskReviewHash }
      : {}),
    contextOutcome: input.contextOutcome,
    gates: { ...input.gates },
    outcome: input.outcome,
  };
}
