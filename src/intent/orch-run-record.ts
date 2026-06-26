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

import type { ObjectionFinding, PmAcceptance } from './team-task-workflow.js';

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
    contextOutcome: input.contextOutcome,
    gates: { ...input.gates },
    outcome: input.outcome,
  };
}
