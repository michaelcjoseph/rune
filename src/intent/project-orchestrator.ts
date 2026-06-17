/**
 * Multi-task project orchestrator loop (project 14, Phase 5).
 *
 * Jarvis owns the project loop. It ties the Phase 3/4 substrate together:
 *
 *   while an unchecked task remains:
 *     select the first unchecked task            (orch-task-select)
 *     assemble bounded context                   (orch-context-assembly)
 *     run the team-task workflow, retrying within the attempt cap
 *                                                 (team-task-workflow + orch-attempt-cap)
 *     on ready-for-closeout, perform Jarvis-owned CLOSEOUT:
 *       update context.md                        (context-curator)
 *       mark EXACTLY the selected task complete  (orch-closeout)
 *       run closeout checks
 *       record the closeout commit
 *       verify the worktree is clean
 *     advance
 *   when no unchecked tasks remain:
 *     hand branch/run facts to the finalizer     (finalizer-handoff)
 *
 * A blocked/failed/objection-open task stops the run durably — it is never
 * skipped. An unavailable finalizer holds (records the payload, no self-merge).
 *
 * Pure over its INJECTED effects: it reads/writes project state, runs the
 * workflow, commits, and finalizes only through `OrchestrationDeps`, so the whole
 * loop runs on an in-memory fixture with no git, disk, or live model call. The
 * runtime wiring (real git/fs effects, the mutation applier, the cockpit trigger)
 * is the remaining Phase 5 integration.
 */

import { selectNextTask, type SelectedTask } from './orch-task-select.js';
import { assembleTaskContext } from './orch-context-assembly.js';
import { decideAttemptOutcome } from './orch-attempt-cap.js';
import { applyContextUpdate, type ContextUpdate } from './context-curator.js';
import { markSelectedTaskComplete } from './orch-closeout.js';
import { buildTaskRunRecord, type TaskRunRecord } from './orch-run-record.js';
import {
  buildFinalizerHandoff,
  runFinalizerHandoff,
  type FinalizerAdapter,
  type FinalizerHandoff,
} from './finalizer-handoff.js';
import type { GateRejectionFeedback, TaskEvidence } from './team-task-workflow.js';

export type OrchestrationActivityEvent = {
  kind: 'activity' | 'output';
  data?: unknown;
};

/** Everything the orchestrator needs, all injected so the loop is fixture-testable. */
export interface OrchestrationDeps {
  runId: string;
  project: string;
  product: string;
  /** Work branch handed to the finalizer. */
  branch: string;
  /** Operator-visible worktree path for parked blocked-on-human runs. */
  worktreePath?: string;
  /** Base branch a gated merge would land on. */
  baseBranch?: string;
  /** Per-task attempt cap. */
  attemptCap: number;
  /** Optional live activity sink for appliers that need supervision heartbeats. */
  emit?: (event: OrchestrationActivityEvent) => void;

  // --- state reads (re-read each iteration so restart/reconstruction is safe) ---
  readTasksMd: () => Promise<string>;
  readContextMd: () => Promise<string>;
  readSpec: () => Promise<string>;

  // --- per-task workflow (wraps team-task-workflow in production) ---
  runTaskWorkflow: (
    task: SelectedTask,
    ctx: { handoff: string; contextMd: string; rejectionFeedback?: GateRejectionFeedback },
  ) => Promise<TaskEvidence>;

  // --- closeout effects ---
  /** Derive the context update the curator should apply from the task evidence. */
  curateContext: (current: string, evidence: TaskEvidence) => ContextUpdate;
  writeContextMd: (content: string) => Promise<void>;
  writeTasksMd: (content: string) => Promise<void>;
  runCloseoutChecks: (task: SelectedTask) => Promise<boolean>;
  commitCloseout: (task: SelectedTask) => Promise<string>;
  verifyCleanWorktree: () => Promise<boolean>;

  // --- finalizer ---
  finalize: FinalizerAdapter;
}

export type OrchestrationResult =
  | { kind: 'finalized'; outcome: string }
  | { kind: 'held'; handoff: FinalizerHandoff }
  | { kind: 'blocked'; reason: string; task: SelectedTask; parked?: ParkedTaskRun };

export interface ParkedTaskRun {
  status: 'blocked-on-human';
  branch: string;
  worktreePath: string;
  preserveBranch: true;
  preserveWorktree: true;
}

/** Run the whole project loop to a terminal result. */
export async function runProjectOrchestration(
  deps: OrchestrationDeps,
): Promise<OrchestrationResult> {
  const taskRecords: TaskRunRecord[] = [];

  // Bound the loop by the task count so a closeout that fails to tick can never
  // spin forever (a corrupt closeout would otherwise re-select the same task).
  // The orchestrator exclusively owns its worktree for the run, so the task list
  // is immutable for its duration — this initial count bounds every iteration.
  const maxIterations = countTasks(await deps.readTasksMd()) + 1;

  for (let iteration = 0; iteration <= maxIterations; iteration++) {
    const tasksMd = await deps.readTasksMd();
    const selection = selectNextTask(tasksMd);

    if (selection.kind === 'all-complete') {
      const handoff = buildFinalizerHandoff({
        runId: deps.runId,
        project: deps.project,
        product: deps.product,
        branch: deps.branch,
        ...(deps.baseBranch !== undefined ? { baseBranch: deps.baseBranch } : {}),
        taskRecords,
      });
      const res = await runFinalizerHandoff(handoff, deps.finalize);
      return res.kind === 'finalized'
        ? { kind: 'finalized', outcome: res.outcome }
        : { kind: 'held', handoff: res.handoff };
    }

    const task = selection.task;
    const contextMd = await deps.readContextMd();
    const spec = await deps.readSpec();
    const assembled = assembleTaskContext({ task, contextMd, spec });

    // Run the workflow, retrying within the attempt cap on non-objection failures.
    const evidence = await runTaskWithRetries(deps, task, assembled.handoff, contextMd);
    if (evidence.outcome !== 'ready-for-closeout') {
      const parked = maybeParkedRun(deps, evidence);
      return {
        kind: 'blocked',
        reason: evidence.blockedReason ?? evidence.failureReason ?? 'task did not reach closeout',
        task,
        ...(parked !== undefined ? { parked } : {}),
      };
    }

    // --- Jarvis-owned closeout ---
    const closeout = await performCloseout(deps, task, tasksMd, contextMd, evidence);
    if (closeout.kind === 'blocked') {
      return { kind: 'blocked', reason: closeout.reason, task };
    }

    taskRecords.push(
      buildTaskRunRecord({
        taskId: task.id,
        taskText: task.text,
        attemptId: `${deps.runId}-${task.id}`,
        rolesInvoked: evidence.rolesInvoked,
        transcriptIds: [],
        modelChoices: {},
        commitSha: closeout.commitSha,
        verdicts: evidence.reviewerVerdict ? { reviewer: evidence.reviewerVerdict.pass ? 'pass' : 'fail' } : {},
        contextOutcome: 'updated',
        gates: { objectionOpen: evidence.objectionOpen },
        outcome: 'ready-for-closeout',
      }),
    );
    // Loop re-reads tasks.md → the now-ticked task is skipped, the next selected.
  }

  // Defensive: the iteration bound was exceeded without reaching all-complete —
  // a closeout silently failed to advance. Block rather than spin.
  return {
    kind: 'blocked',
    reason: 'orchestration did not converge (a closeout failed to advance the task list)',
    task: { id: 'unknown', text: 'unknown', section: '' },
  };
}

/** Run one task through the workflow, retrying within the cap on non-objection
 *  failures. Returns the final attempt's evidence.
 *
 *  NOTE: the team-task-workflow already runs its own internal round cap + PM
 *  wrap-up, so by the time it returns `blocked`/`failed` the PM decision (if any)
 *  has happened INSIDE it. This outer loop is the per-task ATTEMPT cap — how many
 *  times to re-invoke the whole workflow. So `decideAttemptOutcome`'s `pm-wrapup`
 *  vs `blocked-on-human` distinction is intentionally flattened to "stop" here:
 *  both mean don't re-run, return the evidence, and let the caller block. Only an
 *  objection short-circuits a retry below the cap. */
async function runTaskWithRetries(
  deps: OrchestrationDeps,
  task: SelectedTask,
  handoff: string,
  contextMd: string,
): Promise<TaskEvidence> {
  let evidence = await deps.runTaskWorkflow(task, { handoff, contextMd });
  for (let attempt = 1; attempt < deps.attemptCap; attempt++) {
    if (evidence.outcome === 'ready-for-closeout') return evidence;
    const decision = decideAttemptOutcome({
      attempts: attempt,
      cap: deps.attemptCap,
      outcome: evidence.outcome === 'failed' ? 'failed' : 'blocked',
      objectionOpen: evidence.objectionOpen,
    });
    if (decision.action !== 'retry') return evidence;
    evidence = await deps.runTaskWorkflow(task, {
      handoff,
      contextMd,
      ...(evidence.rejectionFeedback !== undefined
        ? { rejectionFeedback: evidence.rejectionFeedback }
        : {}),
    });
  }
  return evidence;
}

type CloseoutResult =
  | { kind: 'ok'; commitSha: string }
  | { kind: 'blocked'; reason: string };

/** Perform the closeout sequence for one passed task. The order keeps the branch
 *  finalizer-ready: context update → tick exactly this task → closeout checks →
 *  commit → clean-worktree verify. Any failure blocks durably. */
async function performCloseout(
  deps: OrchestrationDeps,
  task: SelectedTask,
  tasksMd: string,
  contextMd: string,
  evidence: TaskEvidence,
): Promise<CloseoutResult> {
  // 1. Compute BOTH the context update and the checkbox tick before writing
  //    either — so a tick failure can't leave a half-advanced closeout (context
  //    written, task still unchecked) that a retry would then double-apply.
  const update = deps.curateContext(contextMd, evidence);
  const ctxResult = applyContextUpdate(contextMd, update);
  if (!ctxResult.ok) {
    return { kind: 'blocked', reason: `context update rejected: ${ctxResult.reason}` };
  }
  const tick = markSelectedTaskComplete(tasksMd, task);
  if (!tick.ok) {
    return { kind: 'blocked', reason: `closeout checkbox tick failed: ${tick.reason}` };
  }

  // Both transforms succeeded → persist them together (context first, then the
  // tick that marks the task done).
  await deps.writeContextMd(ctxResult.content);
  await deps.writeTasksMd(tick.content);

  // 3. Task-scoped closeout checks.
  if (!(await deps.runCloseoutChecks(task))) {
    return { kind: 'blocked', reason: 'closeout checks failed' };
  }

  // 4. Record the closeout commit.
  const commitSha = await deps.commitCloseout(task);

  // 5. Verify the worktree is clean (finalizer-ready).
  if (!(await deps.verifyCleanWorktree())) {
    return { kind: 'blocked', reason: 'worktree not clean after closeout' };
  }

  return { kind: 'ok', commitSha };
}

function countTasks(tasksMd: string): number {
  return (tasksMd.match(/^\s*-\s*\[[ xX]\]/gm) ?? []).length;
}

function maybeParkedRun(
  deps: OrchestrationDeps,
  evidence: TaskEvidence,
): ParkedTaskRun | undefined {
  if (evidence.outcome !== 'blocked' || deps.worktreePath === undefined) {
    return undefined;
  }
  if (hasHighCriticalObjection(evidence)) {
    return {
      status: 'blocked-on-human',
      branch: deps.branch,
      worktreePath: deps.worktreePath,
      preserveBranch: true,
      preserveWorktree: true,
    };
  }
  const reason = evidence.blockedReason ?? '';
  const exhaustedFeedbackRetry =
    evidence.rejectionFeedback !== undefined ||
    /feedback retry cap|round cap/i.test(reason);
  if (!exhaustedFeedbackRetry) return undefined;
  return {
    status: 'blocked-on-human',
    branch: deps.branch,
    worktreePath: deps.worktreePath,
    preserveBranch: true,
    preserveWorktree: true,
  };
}

function hasHighCriticalObjection(evidence: TaskEvidence): boolean {
  if (!evidence.objectionOpen) return false;
  return (evidence.reviewerVerdict?.objections ?? []).some(
    (objection) => objection.severity === 'high' || objection.severity === 'critical',
  );
}
