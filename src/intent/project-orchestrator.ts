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
import type {
  FindingSourceGate,
  ObjectionFinding,
  ObjectionSeverity,
  GateRejectionFeedback,
  TaskEvidence,
} from './team-task-workflow.js';

export type OrchestrationActivityEvent = {
  kind: 'activity' | 'output';
  data?: unknown;
};

export interface OrchestrationRunCursor {
  runId: string;
  product: string;
  project: string;
  branch: string;
  baseBranch: string;
  worktreePath: string;
  attemptCap: number;
  resumeMarker: 'resumable';
  cursor: {
    completedTaskIds: string[];
    currentTaskId: string | null;
    nextTaskId: string | null;
  };
}

export interface OrchestrationTerminalBugEntry {
  runId: string;
  taskId: string;
  findingId: string;
  sourceGate: FindingSourceGate;
  class: ObjectionFinding['class'];
  severity: Exclude<ObjectionSeverity, 'low'>;
  location: string;
  rationale: string;
  reversible: boolean;
}

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
  /** Optional durable run-record sink used by restart reconstruction. */
  appendTaskRunRecord?: (record: TaskRunRecord) => Promise<void>;
  /** Optional durable cursor sink used to resume a still-running mutation. */
  writeRunCursor?: (cursor: OrchestrationRunCursor) => Promise<void>;
  /** Optional durable bug sink for unresolved terminal findings. */
  appendTerminalBugEntries?: (entries: OrchestrationTerminalBugEntry[]) => Promise<void>;

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
  | {
      kind: 'held';
      reason?: string;
      handoff: FinalizerHandoff;
      branch?: string;
      worktreePath?: string;
      preserveBranch?: true;
      preserveWorktree?: true;
    }
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
        : { kind: 'held', reason: res.reason, handoff: res.handoff };
    }

    const task = selection.task;
    emitTaskSelected(deps, task);
    const contextMd = await deps.readContextMd();
    const spec = await deps.readSpec();
    const assembled = assembleTaskContext({ task, contextMd, spec });

    // Run the workflow, retrying within the attempt cap on non-objection failures.
    const evidence = await runTaskWithRetries(deps, task, assembled.handoff, contextMd);
    if (evidence.outcome !== 'ready-for-closeout') {
      if (isOperationalTerminal(evidence)) {
        return buildOperationalHold(
          deps,
          evidence.blockedReason ?? evidence.failureReason ?? 'operational task failure',
          taskRecords,
        );
      }
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
      return buildOperationalHold(deps, closeout.reason, taskRecords);
    }

    const taskRecord = buildTaskRunRecord({
      taskId: task.id,
      taskText: task.text,
      attemptId: `${deps.runId}-${task.id}`,
      rolesInvoked: evidence.rolesInvoked,
      transcriptIds: [],
      modelChoices: {},
      commitSha: closeout.commitSha,
      verdicts: evidence.reviewerVerdict
        ? { reviewer: reviewerOutcome(evidence.reviewerVerdict) }
        : {},
      ...warningsField(evidence),
      ...acceptanceField(evidence),
      contextOutcome: 'updated',
      gates: { objectionOpen: evidence.objectionOpen },
      outcome: 'ready-for-closeout',
    });
    taskRecords.push(taskRecord);
    const checkpoint = await persistRunCheckpoint(
      deps,
      taskRecords,
      taskRecord,
      closeout.tasksMd,
    );
    if (checkpoint.kind === 'blocked') {
      return buildOperationalHold(deps, checkpoint.reason, taskRecords);
    }
    const terminalBugRecording = await recordTerminalBugs(deps, evidence);
    if (terminalBugRecording.kind === 'blocked') {
      return buildOperationalHold(deps, terminalBugRecording.reason, taskRecords);
    }
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
 *  NOTE: the team-task-workflow already runs its own internal round cap and
 *  returns terminal task evidence. This outer loop is the per-task ATTEMPT cap:
 *  how many times to re-invoke the whole workflow. `decideAttemptOutcome`
 *  returns `stop` for non-retry terminals, so this loop returns the evidence and
 *  lets the caller block. Only an objection short-circuits a retry below the cap. */
async function runTaskWithRetries(
  deps: OrchestrationDeps,
  task: SelectedTask,
  handoff: string,
  contextMd: string,
): Promise<TaskEvidence> {
  let attempt = 1;
  let rejectionFeedback: GateRejectionFeedback | undefined;

  for (;;) {
    emitAttemptStart(deps, task, attempt);
    const evidence = await deps.runTaskWorkflow(task, {
      handoff,
      contextMd,
      ...(rejectionFeedback !== undefined ? { rejectionFeedback } : {}),
    });
    if (evidence.outcome === 'ready-for-closeout') return evidence;
    if (isOperationalTerminal(evidence)) return evidence;
    const decision = decideAttemptOutcome({
      attempts: attempt,
      cap: deps.attemptCap,
      outcome: evidence.outcome === 'failed' ? 'failed' : 'blocked',
      objectionOpen: evidence.objectionOpen,
    });
    if (decision.action !== 'retry') return evidence;
    emitAttemptRetry(deps, task, attempt, attempt + 1, evidence);
    rejectionFeedback = evidence.rejectionFeedback;
    attempt += 1;
  }
}

type CloseoutResult =
  | { kind: 'ok'; commitSha: string; tasksMd: string }
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
  emitCloseoutStart(deps, task);

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

  emitCloseoutComplete(deps, task, commitSha);
  return { kind: 'ok', commitSha, tasksMd: tick.content };
}

type CheckpointResult = { kind: 'ok' } | { kind: 'blocked'; reason: string };

async function persistRunCheckpoint(
  deps: OrchestrationDeps,
  taskRecords: TaskRunRecord[],
  taskRecord: TaskRunRecord,
  tasksMd: string,
): Promise<CheckpointResult> {
  try {
    await deps.appendTaskRunRecord?.(taskRecord);
    await deps.writeRunCursor?.(buildRunCursor(deps, taskRecords, tasksMd));
    return { kind: 'ok' };
  } catch (err) {
    const message = (err as Error).message.trim() || 'unknown checkpoint write failure';
    return { kind: 'blocked', reason: `operational recording failure: ${message}` };
  }
}

async function recordTerminalBugs(
  deps: OrchestrationDeps,
  evidence: TaskEvidence,
): Promise<CheckpointResult> {
  const entries = terminalBugEntries(deps.runId, evidence);
  if (entries.length === 0) return { kind: 'ok' };
  if (deps.appendTerminalBugEntries === undefined) {
    return {
      kind: 'blocked',
      reason: 'operational terminal bug recording failure: writer not configured',
    };
  }

  try {
    await deps.appendTerminalBugEntries(entries);
    return { kind: 'ok' };
  } catch (err) {
    const message = (err as Error).message.trim() || 'unknown terminal bug write failure';
    return { kind: 'blocked', reason: `operational terminal bug recording failure: ${message}` };
  }
}

function terminalBugEntries(
  runId: string,
  evidence: TaskEvidence,
): OrchestrationTerminalBugEntry[] {
  const seen = new Set<string>();
  const entries: OrchestrationTerminalBugEntry[] = [];
  for (const finding of evidence.findingsLedger ?? []) {
    if (finding.status !== 'open' && finding.status !== 'regressed') continue;
    if (finding.severity === 'low') continue;
    if (seen.has(finding.id)) continue;
    seen.add(finding.id);
    entries.push({
      runId,
      taskId: evidence.taskId,
      findingId: finding.id,
      sourceGate: finding.sourceGate,
      class: finding.class,
      severity: finding.severity,
      location: finding.location,
      rationale: finding.rationale,
      reversible: finding.reversible,
    });
  }
  return entries;
}

function buildRunCursor(
  deps: OrchestrationDeps,
  taskRecords: TaskRunRecord[],
  tasksMd: string,
): OrchestrationRunCursor {
  const next = selectNextTask(tasksMd);
  return {
    runId: deps.runId,
    product: deps.product,
    project: deps.project,
    branch: deps.branch,
    baseBranch: deps.baseBranch ?? '',
    worktreePath: deps.worktreePath ?? '',
    attemptCap: deps.attemptCap,
    resumeMarker: 'resumable',
    cursor: {
      completedTaskIds: taskRecords
        .filter((record) => record.outcome === 'ready-for-closeout')
        .map((record) => record.taskId),
      currentTaskId: null,
      nextTaskId: next.kind === 'task' ? next.task.id : null,
    },
  };
}

function emitTaskSelected(deps: OrchestrationDeps, task: SelectedTask): void {
  deps.emit?.({
    kind: 'activity',
    data: {
      event: 'task-selected',
      taskId: task.id,
      taskText: task.text,
      section: task.section,
      line: `selected task: ${task.text}`,
    },
  });
}

function emitAttemptStart(deps: OrchestrationDeps, task: SelectedTask, attemptNumber: number): void {
  deps.emit?.({
    kind: 'activity',
    data: {
      event: 'attempt-start',
      taskId: task.id,
      attemptNumber,
      attemptId: attemptId(deps, task, attemptNumber),
      line: `starting attempt ${attemptNumber} for ${task.text}`,
    },
  });
}

function emitAttemptRetry(
  deps: OrchestrationDeps,
  task: SelectedTask,
  previousAttemptNumber: number,
  nextAttemptNumber: number,
  evidence: TaskEvidence,
): void {
  const reason =
    evidence.blockedReason ??
    evidence.failureReason ??
    evidence.rejectionFeedback?.reason ??
    'task attempt did not reach closeout';
  deps.emit?.({
    kind: 'activity',
    data: {
      event: 'attempt-retry',
      taskId: task.id,
      previousAttemptNumber,
      nextAttemptNumber,
      previousOutcome: evidence.outcome,
      reason,
      line: `retrying ${task.text}: attempt ${previousAttemptNumber} ${evidence.outcome}; attempt ${nextAttemptNumber} next (${reason})`,
    },
  });
}

function emitCloseoutStart(deps: OrchestrationDeps, task: SelectedTask): void {
  deps.emit?.({
    kind: 'activity',
    data: {
      event: 'closeout-start',
      taskId: task.id,
      line: `starting closeout for ${task.text}`,
    },
  });
}

function emitCloseoutComplete(deps: OrchestrationDeps, task: SelectedTask, commitSha: string): void {
  deps.emit?.({
    kind: 'activity',
    data: {
      event: 'closeout-complete',
      taskId: task.id,
      commitSha,
      line: `closeout complete for ${task.text}: ${commitSha}`,
    },
  });
}

function attemptId(deps: OrchestrationDeps, task: SelectedTask, attemptNumber: number): string {
  return `${deps.runId}-${task.id}-attempt-${attemptNumber}`;
}

function countTasks(tasksMd: string): number {
  return (tasksMd.match(/^\s*-\s*\[[ xX]\]/gm) ?? []).length;
}

function reviewerOutcome(verdict: NonNullable<TaskEvidence['reviewerVerdict']>): string {
  if (verdict.outcome !== undefined) return verdict.outcome;
  return verdict.pass === true ? 'pass' : 'fail';
}

function warningsField(
  evidence: TaskEvidence,
): Pick<TaskRunRecord, 'warnings'> | Record<string, never> {
  const ledgerWarnings = evidence.findingsLedger
    ?.filter((finding) => finding.status === 'open' && finding.severity === 'low')
    .map(({
      id: _id,
      sourceGate: _sourceGate,
      raisedRound: _raisedRound,
      status: _status,
      ...warning
    }) => warning);
  if (evidence.loopExitReason === 'all-low' && ledgerWarnings !== undefined) {
    return ledgerWarnings.length > 0 ? { warnings: ledgerWarnings } : {};
  }

  const verdict = evidence.reviewerVerdict;
  const warnings = reviewerFindings(verdict);
  if (verdict?.outcome !== 'pass-with-warnings' || warnings.length === 0) {
    return {};
  }
  return { warnings };
}

function acceptanceField(
  evidence: TaskEvidence,
): Pick<TaskRunRecord, 'acceptance'> | Record<string, never> {
  if (evidence.acceptance === undefined) return {};
  return { acceptance: evidence.acceptance };
}

function isOperationalTerminal(evidence: TaskEvidence): boolean {
  const reason = evidence.blockedReason ?? evidence.failureReason ?? '';
  return /\boperational\b|malformed|unparseable/i.test(reason);
}

function buildOperationalHold(
  deps: OrchestrationDeps,
  reason: string,
  taskRecords: TaskRunRecord[],
): Extract<OrchestrationResult, { kind: 'held' }> {
  const handoff = buildFinalizerHandoff({
    runId: deps.runId,
    project: deps.project,
    product: deps.product,
    branch: deps.branch,
    ...(deps.baseBranch !== undefined ? { baseBranch: deps.baseBranch } : {}),
    taskRecords,
  });
  return {
    kind: 'held',
    reason,
    handoff,
    branch: deps.branch,
    ...(deps.worktreePath !== undefined ? { worktreePath: deps.worktreePath } : {}),
    preserveBranch: true,
    preserveWorktree: true,
  };
}

function maybeParkedRun(
  deps: OrchestrationDeps,
  evidence: TaskEvidence,
): ParkedTaskRun | undefined {
  void deps;
  void evidence;
  // Phase 14 removes the per-task human park. A task that does not reach
  // closeout still stops the run, but it is no longer converted into a
  // supervision `blocked-on-human` row from task evidence.
  return undefined;
}

function reviewerFindings(
  verdict: TaskEvidence['reviewerVerdict'],
): NonNullable<TaskEvidence['reviewerVerdict']>['objections'] {
  if (verdict === undefined) return [];
  return 'findings' in verdict && verdict.findings !== undefined
    ? verdict.findings
    : verdict.objections;
}
