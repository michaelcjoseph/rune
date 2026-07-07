/**
 * Multi-task project orchestrator loop (project 14, Phase 5).
 *
 * Rune owns the project loop. It ties the Phase 3/4 substrate together:
 *
 *   while an unchecked task remains:
 *     select the first unchecked task            (orch-task-select)
 *     assemble bounded context                   (orch-context-assembly)
 *     run the team-task workflow                  (team-task-workflow)
 *     on ready-for-closeout, perform Rune-owned CLOSEOUT:
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
 * A failed closeout CHECK is the one repairable stop: the failing validation
 * output feeds back to the coder as gate feedback for up to CLOSEOUT_REPAIR_CAP
 * whole-workflow re-runs; exhaustion WIP-commits the worktree and holds
 * (branch + worktree preserved) instead of failing destructively.
 *
 * Pure over its INJECTED effects: it reads/writes project state, runs the
 * workflow, commits, and finalizes only through `OrchestrationDeps`, so the whole
 * loop runs on an in-memory fixture with no git, disk, or live model call. The
 * runtime wiring (real git/fs effects, the mutation applier, the cockpit trigger)
 * is the remaining Phase 5 integration.
 */

import { selectNextTask, type SelectedTask } from './orch-task-select.js';
import { assembleTaskContext } from './orch-context-assembly.js';
import { applyContextUpdate, type ContextUpdate } from './context-curator.js';
import { markSelectedTaskComplete } from './orch-closeout.js';
import { buildTaskRunRecord, type TaskRunRecord } from './orch-run-record.js';
import {
  buildFinalizerHandoff,
  runFinalizerHandoff,
  type FinalizerAdapter,
  type FinalizerHandoff,
} from './finalizer-handoff.js';
import {
  buildGateRejectionFeedback,
  type FindingSourceGate,
  type GateRejectionFeedback,
  type ObjectionFinding,
  type ObjectionSeverity,
  type TaskEvidence,
} from './team-task-workflow.js';
import type { CancelReason } from '../transport/mutations.js';

export type OrchestrationActivityEvent = {
  kind: 'activity' | 'output' | 'progress';
  data?: unknown;
};

export interface CloseoutCommit {
  sha: string;
  subject: string;
}

/** Repair re-runs after the initial attempt when closeout checks fail (total
 *  workflow attempts per task = 1 + CLOSEOUT_REPAIR_CAP). */
export const CLOSEOUT_REPAIR_CAP = 2;

/** The failing closeout-validation facts, scrubbed by the runner adapter before
 *  they reach the orchestrator (safe for the cross-provider coder prompt). */
export interface CloseoutCheckFailure {
  command: string;
  exitCode: number | null;
  timedOut: boolean;
  outputTail: string;
}

export type CloseoutCheckResult =
  | { ok: true }
  | { ok: false; failure: CloseoutCheckFailure };

export interface OrchestrationRunCursor {
  runId: string;
  product: string;
  project: string;
  branch: string;
  baseBranch: string;
  worktreePath: string;
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
  /** Optional live activity sink for appliers that need supervision heartbeats. */
  emit?: (event: OrchestrationActivityEvent) => void;
  /** Cooperative cancellation readers. Omitted in fixtures that do not model
   *  cancellation; default behavior is no cancellation. */
  cancel?: () => boolean;
  cancelReason?: () => CancelReason | null;
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
  /** `rejectionFeedback` is set only on closeout-repair re-runs — the failing
   *  validation output threaded back to the coder as gate feedback. */
  runTaskWorkflow: (
    task: SelectedTask,
    ctx: { handoff: string; contextMd: string; rejectionFeedback?: GateRejectionFeedback },
  ) => Promise<TaskEvidence>;

  // --- closeout effects ---
  /** Derive the context update the curator should apply from the task evidence. */
  curateContext: (current: string, evidence: TaskEvidence) => ContextUpdate;
  writeContextMd: (content: string) => Promise<void>;
  writeTasksMd: (content: string) => Promise<void>;
  runCloseoutChecks: (task: SelectedTask) => Promise<CloseoutCheckResult>;
  commitCloseout: (task: SelectedTask) => Promise<CloseoutCommit>;
  /** Optional best-effort WIP preservation commit when closeout repair exhausts.
   *  Returns null when there is nothing to commit or the commit fails. */
  commitWip?: (task: SelectedTask) => Promise<CloseoutCommit | null>;
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
  | { kind: 'blocked'; reason: string; task: SelectedTask; parked?: ParkedTaskRun }
  | { kind: 'cancelled'; reason: CancelReason; task?: SelectedTask };

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
    const cancelledBeforeSelection = cancellationResult(deps);
    if (cancelledBeforeSelection) return cancelledBeforeSelection;

    const tasksMd = await deps.readTasksMd();
    const selection = selectNextTask(tasksMd);

    if (selection.kind === 'all-complete') {
      const cancelledBeforeFinalizer = cancellationResult(deps);
      if (cancelledBeforeFinalizer) return cancelledBeforeFinalizer;

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
    let evidence = await runTaskWorkflow(deps, task, assembled.handoff, contextMd, 1);
    // Sentinel only for definite assignment — every loop path assigns or returns.
    let closeout: CloseoutResult = { kind: 'blocked', reason: 'closeout not attempted' };
    for (let attempt = 1; attempt <= 1 + CLOSEOUT_REPAIR_CAP; attempt++) {
      const cancelledAfterWorkflow = cancellationResult(deps, task);
      if (cancelledAfterWorkflow) return cancelledAfterWorkflow;

      if (evidence.outcome !== 'ready-for-closeout') {
        return resolveNonCloseoutEvidence(deps, task, evidence, taskRecords);
      }

      // --- Rune-owned closeout ---
      closeout = await performCloseout(deps, task, tasksMd, contextMd, evidence);
      if (closeout.kind === 'ok' || closeout.closeoutFailure === undefined) break;
      if (attempt === 1 + CLOSEOUT_REPAIR_CAP) break; // repair budget exhausted
      // Bounded coder repair: a failed check persists nothing (the check runs
      // before the context/tick writes), so re-running the workflow with the
      // failing validation output as gate feedback and re-entering closeout
      // fresh needs no rollback.
      evidence = await runTaskWorkflow(
        deps,
        task,
        assembled.handoff,
        contextMd,
        attempt + 1,
        buildCloseoutRepairFeedback(closeout.closeoutFailure),
      );
    }
    if (closeout.kind === 'blocked') {
      if (closeout.closeoutFailure !== undefined) {
        // Preserve the work BEFORE the terminal: a held run keeps branch and
        // worktree, and the WIP commit survives even a later manual worktree
        // cleanup — the resume path checks the branch tip back out.
        const wip = await commitWipSafely(deps, task);
        const attempts = 1 + CLOSEOUT_REPAIR_CAP;
        return buildOperationalHold(
          deps,
          wip === null
            ? `closeout checks failed after ${attempts} attempts`
            : `closeout checks failed after ${attempts} attempts; WIP preserved as ${wip.sha.slice(0, 7)}`,
          taskRecords,
        );
      }
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
    // The task already committed; recording any open objection-class finding to
    // the bug backlog is best-effort. The terminal-bug writer is an optional dep
    // not yet wired in production, and a missing writer must NOT fail-close the
    // whole run after a clean closeout — that would halt the loop the first time
    // any task carries an open finding (matching the tolerant non-reversible
    // path above). A genuine writer FAILURE (writer present but throws) still
    // blocks. The finding stays durable in the task record + run transcript.
    const terminalBugRecording = await recordTerminalBugs(deps, evidence, {
      missingWriter: 'ok',
    });
    if (terminalBugRecording.kind === 'blocked') {
      return buildOperationalHold(deps, terminalBugRecording.reason, taskRecords);
    }
    const cancelledAfterCloseout = cancellationResult(deps, task);
    if (cancelledAfterCloseout) return cancelledAfterCloseout;
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

function cancellationResult(
  deps: OrchestrationDeps,
  task?: SelectedTask,
): Extract<OrchestrationResult, { kind: 'cancelled' }> | null {
  if (deps.cancel?.() !== true) return null;
  return {
    kind: 'cancelled',
    reason: deps.cancelReason?.() ?? 'user',
    ...(task !== undefined ? { task } : {}),
  };
}

/** Run one task through the workflow. The workflow owns the per-task
 * convergence loop internally; the orchestrator re-invokes the whole workflow
 * ONLY for closeout-check repair (bounded by CLOSEOUT_REPAIR_CAP), threading
 * the failing validation output back as gate feedback. */
async function runTaskWorkflow(
  deps: OrchestrationDeps,
  task: SelectedTask,
  handoff: string,
  contextMd: string,
  attemptNumber: number,
  rejectionFeedback?: GateRejectionFeedback,
): Promise<TaskEvidence> {
  emitAttemptStart(deps, task, attemptNumber);
  return deps.runTaskWorkflow(task, { handoff, contextMd, rejectionFeedback });
}

type CloseoutResult =
  | { kind: 'ok'; commitSha: string; tasksMd: string }
  | { kind: 'blocked'; reason: string; closeoutFailure?: CloseoutCheckFailure };

/** Perform the closeout sequence for one passed task. The order keeps the branch
 *  finalizer-ready: compute context/tick → closeout checks → persist context
 *  and tick exactly this task → commit → clean-worktree verify. Any failure
 *  blocks durably. */
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

  // 3. Task-scoped closeout checks. Run these before persisting the tick so a
  // validation failure leaves the task visibly unchecked in the live worktree.
  const checks = await deps.runCloseoutChecks(task);
  if (!checks.ok) {
    return { kind: 'blocked', reason: 'closeout checks failed', closeoutFailure: checks.failure };
  }

  // Both transforms succeeded and validation passed → persist them together
  // (context first, then the tick that marks the task done).
  await deps.writeContextMd(ctxResult.content);
  await deps.writeTasksMd(tick.content);

  // 4. Record the closeout commit.
  const commit = await deps.commitCloseout(task);
  emitCloseoutCommit(deps, task, commit, tick.content);

  // 5. Verify the worktree is clean (finalizer-ready).
  if (!(await deps.verifyCleanWorktree())) {
    return { kind: 'blocked', reason: 'worktree not clean after closeout' };
  }

  emitCloseoutComplete(deps, task, commit.sha);
  return { kind: 'ok', commitSha: commit.sha, tasksMd: tick.content };
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
  opts: { missingWriter: 'blocked' | 'ok' } = { missingWriter: 'blocked' },
): Promise<CheckpointResult> {
  const entries = terminalBugEntries(deps.runId, evidence);
  if (entries.length === 0) return { kind: 'ok' };
  if (deps.appendTerminalBugEntries === undefined) {
    if (opts.missingWriter === 'ok') return { kind: 'ok' };
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
  const entriesById = new Map<string, OrchestrationTerminalBugEntry>();
  for (const finding of evidence.findingsLedger ?? []) {
    const key = `${runId}|${evidence.taskId}|${finding.id}`;
    if (
      (finding.status !== 'open' && finding.status !== 'regressed') ||
      finding.severity === 'low'
    ) {
      entriesById.delete(key);
      continue;
    }
    entriesById.set(key, {
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
  return [...entriesById.values()];
}

function hasNonReversibleSevereTerminalFinding(evidence: TaskEvidence): boolean {
  return terminalBugEntries('', evidence).some(
    (entry) =>
      entry.reversible === false &&
      (entry.severity === 'high' || entry.severity === 'critical'),
  );
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

function emitCloseoutCommit(
  deps: OrchestrationDeps,
  task: SelectedTask,
  commit: CloseoutCommit,
  tasksMd: string,
): void {
  const progress = countTaskProgress(tasksMd);
  if (progress.tasksTotal <= 1) return;
  const shortSha = commit.sha.slice(0, 7);
  deps.emit?.({
    kind: 'progress',
    data: {
      event: 'closeout-commit',
      projectSlug: deps.project,
      product: deps.product,
      taskId: task.id,
      taskText: task.text,
      commitSha: commit.sha,
      shortSha,
      commitSubject: commit.subject,
      ...progress,
      line: `${task.text} committed ${shortSha} · ${progress.tasksDone}/${progress.tasksTotal} done · ${progress.tasksRemaining} remaining`,
    },
  });
}

function attemptId(deps: OrchestrationDeps, task: SelectedTask, attemptNumber: number): string {
  return `${deps.runId}-${task.id}-attempt-${attemptNumber}`;
}

function countTasks(tasksMd: string): number {
  return (tasksMd.match(/^\s*-\s*\[[ xX]\]/gm) ?? []).length;
}

function countTaskProgress(tasksMd: string): {
  tasksDone: number;
  tasksTotal: number;
  tasksRemaining: number;
} {
  let tasksDone = 0;
  let tasksRemaining = 0;
  for (const line of tasksMd.split('\n')) {
    if (/^\s*-\s*\[[xX]\]/.test(line)) {
      tasksDone += 1;
    } else if (/^\s*-\s*\[\s\]/.test(line)) {
      tasksRemaining += 1;
    }
  }
  return {
    tasksDone,
    tasksTotal: tasksDone + tasksRemaining,
    tasksRemaining,
  };
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

/** Terminal routing for task evidence that did not reach ready-for-closeout:
 *  non-reversible severe finding → finding hold; operational failure →
 *  operational hold; anything else → plain blocked (no per-task park). */
async function resolveNonCloseoutEvidence(
  deps: OrchestrationDeps,
  task: SelectedTask,
  evidence: TaskEvidence,
  taskRecords: TaskRunRecord[],
): Promise<OrchestrationResult> {
  if (hasNonReversibleSevereTerminalFinding(evidence)) {
    const terminalBugRecording = await recordTerminalBugs(deps, evidence, {
      missingWriter: 'ok',
    });
    if (terminalBugRecording.kind === 'blocked') {
      return buildOperationalHold(deps, terminalBugRecording.reason, taskRecords);
    }
    return buildFindingHold(
      deps,
      evidence.blockedReason ??
        evidence.failureReason ??
        'non-reversible high/critical terminal finding must hold the branch',
      taskRecords,
    );
  }
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

/** Included prompt tail is bounded; the FULL tail is already persisted to
 *  closeout-validation-failure.txt by the runner adapter. Keep-the-end. */
const CLOSEOUT_FEEDBACK_TAIL_CHARS = 4_000;

/** The closeout gate is the product validation suite — QA's artifact domain —
 *  so the repair feedback is qa-attributed; the reason self-describes as
 *  closeout validation so it cannot read as an AI-role verdict. Routed to the
 *  coder via rejectedRole = counterpartRole. */
function buildCloseoutRepairFeedback(failure: CloseoutCheckFailure): GateRejectionFeedback {
  const outcome = failure.timedOut ? 'timed out' : `exited ${failure.exitCode ?? 'unknown'}`;
  const tail = failure.outputTail.slice(-CLOSEOUT_FEEDBACK_TAIL_CHARS).trim();
  return buildGateRejectionFeedback({
    rejectingRole: 'qa',
    counterpartRole: 'coder',
    artifact: 'implementation-diff',
    reason:
      `closeout validation failed: \`${failure.command}\` ${outcome}.` +
      (tail !== '' ? `\nFailing output tail:\n${tail}` : ''),
    actionableNotes: [
      `Re-run \`${failure.command}\` from the worktree root and drive it green before handing back.`,
      'Fix the implementation — do not delete or weaken a failing test without a TEST-REMOVED justification.',
    ],
  });
}

async function commitWipSafely(
  deps: OrchestrationDeps,
  task: SelectedTask,
): Promise<CloseoutCommit | null> {
  if (deps.commitWip === undefined) return null;
  try {
    return await deps.commitWip(task);
  } catch {
    return null; // preservation is best-effort; the hold itself must land
  }
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

function buildFindingHold(
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
