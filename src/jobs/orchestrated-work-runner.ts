/**
 * Orchestrated-work mutation applier (project 14, Phase 5).
 *
 * The Rune-owned multi-task orchestration loop dispatched through the existing
 * mutation pipeline. The cockpit Start action routes here (instead of the legacy
 * `/work --auto` `work-run` applier) when the orchestrated-work toggle selects
 * orchestrated mode — see `src/jobs/work-dispatch.ts`. The legacy applier stays
 * reachable as the recorded fallback.
 *
 * apply() creates a sandboxed worktree, drives `runProjectOrchestration`
 * (src/intent/project-orchestrator.ts) over real fs/git effects, and maps the
 * terminal `OrchestrationResult` onto a single MutationEvent:
 *   - finalized → completed (the Project 15 finalizer landed the branch)
 *   - held      → completed, flagged `held` (finalizer unavailable: the run
 *                 stops branch-complete with the handoff recorded, NEVER a
 *                 self-merge — spec req 17)
 *   - parked blocked → completed, flagged `parked` with the operator worktree
 *                 path; supervision remains blocked-on-human until release
 *   - blocked   → failed, carrying the durable block reason (spec req 13/14)
 *
 * Every effect is injected through `OrchestratedRuntimeDeps` so the apply→event
 * mapping + worktree lifecycle run on fixtures with no git, fs, or live model
 * call. The orchestration loop itself is already fixture-proven in
 * `project-orchestrator.test.ts`.
 *
 * Phase 8 (live execution binding): the production per-task workflow is LIVE —
 * `createProductionTaskWorkflowRunner` (src/jobs/team-task-deps.ts) drives
 * `runTeamTaskWorkflow` with the real role seams (execution-agent artifact
 * sessions + charter-composed judgment calls, models resolved through the
 * model policy with fail-closed reviewer independence). The runner factory is
 * part of the injected runtime seam so fixtures can swap it; the no-stub
 * regression in team-task-deps.test.ts pins the production binding.
 */

import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import config, { PROJECT_ROOT } from '../config.js';
import {
  createWorktree as defaultCreateWorktree,
  destroyWorktree as defaultDestroyWorktree,
  defaultRunGit,
  getProductConfig,
  verifyWorktreeProvisioning,
  worktreeProvisioningTerminalReason,
  type CloseoutValidationStrategy,
  type GitRunner,
} from './sandbox-runtime.js';
import {
  runProjectOrchestration,
  type CloseoutCommit,
  type OrchestrationActivityEvent,
  type OrchestrationDeps,
  type OrchestrationRunCursor,
  type OrchestrationResult,
  type OrchestrationTerminalBugEntry,
} from '../intent/project-orchestrator.js';
import type {
  ContextCloseoutFailure,
  WipCheckpointResult,
} from '../intent/context-closeout.js';
import { reconstructRun, type RunReconstruction } from '../intent/orch-reconstruct.js';
import {
  withFileLock,
  writeFileAtomic,
  assertBacklogWriteAllowed,
  appendBacklogMutationLog,
} from '../intent/backlog-write-lock.js';
import { appendTerminalBugsToBacklog } from '../intent/terminal-bug-backlog.js';
import { createProductionTaskWorkflowRunner } from './team-task-deps.js';
import type { ContextUpdate } from '../intent/context-curator.js';
import type { TaskRunRecord } from '../intent/orch-run-record.js';
import type { ReviewSurfaceFailure, TaskEvidence } from '../intent/team-task-workflow.js';
import type { TaskValidationFailure } from '../intent/task-validation.js';
import type { SelectedTask } from '../intent/orch-task-select.js';
import type { FinalizerAdapter } from '../intent/finalizer-handoff.js';
import { workBranchName } from './work-runner.js';
import {
  VALID_SLUG,
  worktreePathFor,
  type SandboxSpec,
} from '../intent/sandbox.js';
import {
  assertManagedWorktreeFile,
  readManagedWorktreeFile,
  writeManagedWorktreeFile,
} from './managed-worktree-fs.js';
import { scrubPathsInText } from '../ai/tool-labels.js';
import { scrubAbsolutePaths } from '../utils/sanitize-paths.js';
import {
  activeRuns,
  redispatchMutation,
  writeRecoveredTerminalMutation,
  isMutationShutdownInProgress,
  isMutationRecoveryHandoff,
  preserveMutationForRecoveryHandoff,
  releaseMutationRecoveryHandoff,
  claimMutationTerminalTeardown,
  releaseMutationTerminalTeardown,
} from '../transport/mutations.js';
import { runTargetFromDescriptor, type WorkRunTarget } from '../intent/run-target.js';
import { createLogger } from '../utils/logger.js';
import { appendMutationLine } from './mutations-log.js';
import { upsertRun } from './supervision-store.js';
import { createTranscriptSink, redactSecrets, type TranscriptSink } from './work-run-transcript.js';
import {
  appendOrchestratedTaskRunRecord,
  readOrchestratedTaskRunRecords,
} from './task-run-record-store.js';
export {
  appendOrchestratedTaskRunRecord,
  readOrchestratedTaskRunRecords,
} from './task-run-record-store.js';
import {
  writeSummary,
  appendIndexRow,
  recordWorkRunPhase,
  readLastWorkRunPhase,
  writeGateValidationReceipt,
  parseWorkRunCancellation,
  type WorkRunSummary,
  type WorkRunCancellation,
  type WorkRunIndexRow,
} from './work-run-store.js';
import {
  classifyOutcome,
  computeWorkProduct,
  finalizeWorkRun,
  applyOutcomeToDescriptor,
  type ExitFacts,
  type WorkOutcome,
  type WorkProductFacts,
} from './work-run-classify.js';
import type {
  MutationApplier,
  MutationDescriptor,
  MutationEvent,
  ApplyContext,
  CancelReason,
  MutationCancellationSource,
  RevocableMutationCancellationSource,
  RunHandle,
} from '../transport/mutations.js';
import { buildRunAgentsEventFromTaskRecords } from '../transport/notification-bus.js';
import {
  markProjectDoneOnBranch,
  runFinalizer,
  readOutcome,
  type FinalizerEffects,
  type FinalizerPhase,
  type GateFailReason,
} from './work-run-finalizer.js';
import { isGateValidationReceipt } from './work-run-gate.js';
import {
  collectTaskChangedPaths,
  taskChangesRequireFullValidation,
  runGate as defaultRunGate,
  runFullSuiteValidation as defaultRunFullSuiteValidation,
  productionFullSuiteProfileIO,
  runProfiledVitestSelection,
  runTrustedVitestObserver,
  runValidationCommandArgv as defaultRunValidationCommandArgv,
  runValidationCommands as defaultRunValidationCommands,
  type FullSuiteValidationResult,
  type ValidationCommandListResult,
} from './work-run-gate-runtime.js';
import {
  durableValidationReceipt,
  type CompactValidationReceipt,
  type DurableValidationReceipt,
  type FullSuiteAttestation,
  type ValidationAdapter,
} from '../intent/full-suite-attestation.js';
import type { ValidationCommandProfile } from '../intent/validation-profiles.js';
import {
  diagnoseRelatedTestFallback,
  diagnoseRelatedTestResult,
  formatRelatedTestStructuredErrors,
  type RelatedTestDiagnostic,
} from './related-test-diagnostic.js';
import {
  collectRelatedTestTaskDiagnostics,
  isRelatedTestDiagnostic,
  isRelatedTestTaskDiagnosticList,
  relatedTestInvocationSelectionFits,
  RELATED_TEST_TASK_ID_MAX_CHARS,
  type RelatedTestTaskDiagnostic,
} from '../intent/related-test-diagnostic.js';
import {
  taskValidationCommandFailure,
  validateTaskValidationAdmission,
} from './task-validation.js';
import {
  captureCleanTaskBaseTree,
  captureCanonicalChangedPaths,
  captureCanonicalReviewState,
  defaultRunCanonicalGit,
  treeForCommit,
  verifyTaskBaseTree,
} from './canonical-git.js';
import { withBaseBranchLock } from './work-run-merge-lock.js';
import type { SupervisedRun } from '../intent/supervision.js';
import { rebuildRegistry } from './registry-rebuild.js';
import { resolveLiveWorkProject } from './work-project.js';
import {
  invalidateOrchestratedRunCursor,
  readOrchestratedRunCursor,
  writeOrchestratedRunCursor,
} from './orchestrated-run-store.js';
import { invalidateCursorThenRemoveWorktree } from './terminal-worktree-cleanup.js';
import {
  adjacentExecutionFailure,
  executionFailureSummary,
  isExecutionFailure,
  isExecutionTerminalDisposition,
  isExecutionTerminalTrigger,
  type ExecutionFailure,
  type ExecutionTerminalDisposition,
  type ExecutionTerminalTrigger,
  sanitizeExecutionDiagnostic,
} from '../intent/execution-failure.js';

export function selectReusableFullSuiteEvidence(
  result: FullSuiteValidationResult,
): {
  attestation: FullSuiteAttestation;
  receipt: CompactValidationReceipt;
} | undefined {
  if (!result.ok || result.coverageComplete !== true) return undefined;
  const attestation = result.attestations
    .find((entry) => entry.coverage.status === 'complete');
  const receipt = result.receipts
    .find((entry) => entry.coverage === 'complete');
  return attestation !== undefined && receipt !== undefined
    ? { attestation, receipt }
    : undefined;
}

export function fullSuiteFailureAllowsCloseoutFallback(
  result: FullSuiteValidationResult,
): boolean {
  if (result.ok) return false;
  return result.result.exitCode === 0 &&
    !result.result.timedOut &&
    !result.result.cancelled &&
    result.validationReceipt.outcome === 'failed' &&
    result.validationReceipt.commands.length > 0 &&
    result.validationReceipt.commands.every((entry) => entry.outcome === 'passed') &&
    result.validationReceipt.commands.some((entry) => entry.coverage === 'invalid');
}

export {
  invalidateOrchestratedRunCursor,
  readOrchestratedRunCursor,
  writeOrchestratedRunCursor,
} from './orchestrated-run-store.js';

const log = createLogger('orchestrated-work-runner');

/** Per-task round cap (coder → review rounds inside one workflow run). */
const ORCHESTRATED_ROUND_CAP = 3;

type OrchestratedWorkPayload = {
  projectSlug: string;
  product?: string;
};

export interface OrchestratedRecoveryRedispatch {
  branch: string;
  baseBranch: string;
  worktreePath: string;
  reconstruction: RunReconstruction;
  resumeFromTaskId: string | null;
  existingBranch: true;
}

export interface OrchestratedWorkRecoveryDeps {
  readRunningOrchestratedMutations: () => Promise<MutationDescriptor<OrchestratedWorkPayload>[]>;
  acquireRecoveryLease?: (runId: string) => Promise<boolean>;
  releaseRecoveryLease?: (runId: string) => Promise<void>;
  preflightRecovery: (mutation: MutationDescriptor<OrchestratedWorkPayload>) => Promise<OrchestratedRecoveryPreflightResult>;
  redispatchOrchestratedMutation: (
    mutation: MutationDescriptor<OrchestratedWorkPayload>,
    options: OrchestratedRecoveryRedispatch,
  ) => Promise<void>;
  markOrphaned: (mutation: MutationDescriptor<OrchestratedWorkPayload>, reason: string) => Promise<void>;
  writeTerminal: (mutation: MutationDescriptor<OrchestratedWorkPayload>, event: MutationEvent) => Promise<void>;
}

export interface OrchestratedWorkRecoveryResult {
  resumed: string[];
  orphaned: string[];
  skipped: string[];
}

export type OrchestratedRunRecoveryRequestResult =
  | { kind: 'recovered'; runId: string }
  | { kind: 'not-active'; reason: string }
  | { kind: 'not-orchestrated'; reason: string }
  | { kind: 'not-resumable'; reason: string }
  | { kind: 'error'; reason: string };

export interface OrchestratedRunRecoveryRequestDeps {
  preflightRecovery: (mutation: MutationDescriptor<OrchestratedWorkPayload>) => Promise<OrchestratedRecoveryPreflightResult>;
  redispatchOrchestratedMutation: (
    mutation: MutationDescriptor<OrchestratedWorkPayload>,
    options: OrchestratedRecoveryRedispatch,
  ) => { ok: true } | { ok: false; reason: string };
  activeRun: (runId: string) => RunHandle | null;
  preserveForHandoff: (runId: string) => boolean;
  releaseHandoff: (runId: string) => void;
}

export type OrchestratedRecoveryPreflightResult =
  | { kind: 'recoverable'; cursor: OrchestrationRunCursor; reconstruction: RunReconstruction }
  | { kind: 'not-resumable'; reason: string };

export interface OrchestratedRecoveryPreflightDeps {
  readRunCursor: (runId: string) => Promise<OrchestrationRunCursor | null>;
  readTaskRunRecords: (runId: string) => Promise<TaskRunRecord[]>;
  readTasksMd: (cursor: OrchestrationRunCursor) => Promise<string>;
  writeRunCursor?: (cursor: OrchestrationRunCursor) => Promise<void>;
  worktreeExists: (path: string) => boolean;
  runGit: GitRunner;
  runCanonicalGit?: GitRunner;
  resolveProduct: (product: string) => { repoPath: string; baseBranch: string };
  resolveWorktreePath: (product: string, project: string) => string;
}

const recoveryRedispatchOptions = new WeakMap<
  MutationDescriptor<OrchestratedWorkPayload>,
  OrchestratedRecoveryRedispatch
>();

export function redispatchRecoveredOrchestratedMutation(
  mutation: MutationDescriptor<OrchestratedWorkPayload>,
  options: OrchestratedRecoveryRedispatch,
): { ok: true } | { ok: false; reason: string } {
  recoveryRedispatchOptions.set(mutation, options);
  const result = redispatchMutation(mutation as MutationDescriptor);
  if (!result.ok) {
    recoveryRedispatchOptions.delete(mutation);
  }
  return result;
}

export async function readTasksMdForRecoveredCursor(cursor: OrchestrationRunCursor): Promise<string> {
  const projectsDir = join(cursor.worktreePath, 'docs', 'projects');
  const names = readdirSync(projectsDir);
  for (const name of names) {
    const dir = join(projectsDir, name);
    if (name !== cursor.project && !name.endsWith(`-${cursor.project}`)) continue;
    if (statSync(dir).isDirectory()) {
      return readFileSync(join(dir, 'tasks.md'), 'utf8');
    }
  }
  throw new Error(`tasks.md not found for recovered orchestrated project: ${cursor.project}`);
}

function defaultRecoveryPreflightDeps(): OrchestratedRecoveryPreflightDeps {
  return {
    readRunCursor: async (runId) => readOrchestratedRunCursor(config.WORK_RUNS_DIR, runId),
    readTaskRunRecords: async (runId) => readOrchestratedTaskRunRecords(config.WORK_RUNS_DIR, runId),
    readTasksMd: readTasksMdForRecoveredCursor,
    writeRunCursor: async (cursor) =>
      writeOrchestratedRunCursor(config.WORK_RUNS_DIR, cursor.runId, cursor),
    worktreeExists: existsSync,
    runGit: defaultRunGit,
    resolveProduct: (product) => {
      const resolved = getProductConfig(product, config.PRODUCTS_CONFIG_FILE);
      return { repoPath: resolved.repoPath, baseBranch: resolved.baseBranch };
    },
    resolveWorktreePath: (product, project) => worktreePathFor(product, project, config.WORKTREE_ROOT),
  };
}

function registeredWorktreeBranch(porcelain: string, exactPath: string): string | null {
  for (const record of porcelain.split(/\n\s*\n/)) {
    const lines = record.split('\n');
    if (lines[0] !== `worktree ${exactPath}`) continue;
    const branch = lines.find((line) => line.startsWith('branch refs/heads/'));
    return branch ? branch.slice('branch refs/heads/'.length) : null;
  }
  return null;
}

/**
 * One fail-closed eligibility decision shared by boot recovery, operator
 * recovery, shutdown preservation, and cockpit projection.
 */
export async function preflightOrchestratedRecovery(
  mutation: MutationDescriptor<OrchestratedWorkPayload>,
  deps: OrchestratedRecoveryPreflightDeps = defaultRecoveryPreflightDeps(),
): Promise<OrchestratedRecoveryPreflightResult> {
  if (mutation.kind !== 'orchestrated-work' || mutation.status !== 'running') {
    return { kind: 'not-resumable', reason: 'run is not an active orchestrated-work mutation' };
  }
  const product = mutation.payload.product ?? 'rune';
  const project = mutation.payload.projectSlug;
  let cursor: OrchestrationRunCursor | null;
  try {
    cursor = await deps.readRunCursor(mutation.id);
  } catch {
    return { kind: 'not-resumable', reason: 'resumable cursor could not be read' };
  }
  if (!cursor || cursor.resumeMarker !== 'resumable') {
    return { kind: 'not-resumable', reason: 'missing resumable orchestrated cursor' };
  }
  if (cursor.runId !== mutation.id || cursor.product !== product || cursor.project !== project) {
    return { kind: 'not-resumable', reason: 'run and resumable cursor identity do not agree' };
  }

  let expectedPath: string;
  let repoPath: string;
  let expectedBaseBranch: string;
  try {
    expectedPath = deps.resolveWorktreePath(product, project);
    const resolved = deps.resolveProduct(product);
    repoPath = resolved.repoPath;
    expectedBaseBranch = resolved.baseBranch;
  } catch {
    return { kind: 'not-resumable', reason: 'product recovery configuration is unavailable' };
  }
  const expectedBranch = workBranchName(project);
  if (cursor.worktreePath !== expectedPath || cursor.branch !== expectedBranch || cursor.baseBranch !== expectedBaseBranch) {
    return { kind: 'not-resumable', reason: 'resumable cursor does not match the expected worktree and branch' };
  }
  try {
    if (!deps.worktreeExists(expectedPath) || !statSync(expectedPath).isDirectory()) {
      return { kind: 'not-resumable', reason: 'worktree no longer exists; this run cannot be recovered' };
    }
  } catch {
    return { kind: 'not-resumable', reason: 'worktree no longer exists; this run cannot be recovered' };
  }

  let registeredBranch: string | null;
  try {
    const { stdout } = await deps.runGit(['worktree', 'list', '--porcelain'], { cwd: repoPath });
    registeredBranch = registeredWorktreeBranch(stdout, expectedPath);
  } catch {
    return { kind: 'not-resumable', reason: 'Git worktree registration could not be verified' };
  }
  if (registeredBranch === null) {
    return { kind: 'not-resumable', reason: 'worktree is not registered on the expected branch' };
  }
  if (registeredBranch !== expectedBranch) {
    return { kind: 'not-resumable', reason: 'worktree is registered on a different branch' };
  }

  try {
    const [records, tasksMd] = await Promise.all([
      deps.readTaskRunRecords(mutation.id),
      deps.readTasksMd(cursor),
    ]);
    const reconstruction = reconstructRun({ tasksMd, records });
    if (reconstruction.drift) {
      return { kind: 'not-resumable', reason: 'completed task records disagree with tasks.md' };
    }
    let recoveredCursor = cursor;
    const currentTaskId = cursor.cursor.currentTaskId;
    if (currentTaskId === null) {
      if (cursor.taskBase !== undefined) {
        return {
          kind: 'not-resumable',
          reason: 'between-task cursor unexpectedly retains an in-progress task base',
        };
      }
    } else {
      if (reconstruction.nextTask?.id !== currentTaskId) {
        return {
          kind: 'not-resumable',
          reason: 'in-progress cursor task disagrees with reconstructed next task',
        };
      }
      const canonicalGit = deps.runCanonicalGit ?? deps.runGit;
      let treeOid: string;
      if (cursor.taskBase !== undefined) {
        if (cursor.taskBase.taskId !== currentTaskId) {
          return {
            kind: 'not-resumable',
            reason: 'durable task base belongs to a different task',
          };
        }
        treeOid = await verifyTaskBaseTree(
          canonicalGit,
          expectedPath,
          cursor.taskBase.treeOid,
        );
      } else {
        const preceding = [...records]
          .reverse()
          .find((record) =>
            record.outcome === 'ready-for-closeout' &&
            record.commitSha !== null
          );
        if (preceding?.commitSha === undefined || preceding.commitSha === null) {
          return {
            kind: 'not-resumable',
            reason:
              'legacy interrupted-task cursor has no authoritative preceding closeout commit',
          };
        }
        if (deps.writeRunCursor === undefined) {
          return {
            kind: 'not-resumable',
            reason: 'derived task base could not be persisted',
          };
        }
        treeOid = await treeForCommit(
          canonicalGit,
          expectedPath,
          preceding.commitSha,
        );
        recoveredCursor = {
          ...cursor,
          taskBase: { taskId: currentTaskId, treeOid },
        };
        await deps.writeRunCursor(recoveredCursor);
      }
    }
    return { kind: 'recoverable', cursor: recoveredCursor, reconstruction };
  } catch {
    return { kind: 'not-resumable', reason: 'project tasks and durable task records could not be reconstructed' };
  }
}

export function defaultOrchestratedRunRecoveryRequestDeps(): OrchestratedRunRecoveryRequestDeps {
  return {
    preflightRecovery: preflightOrchestratedRecovery,
    redispatchOrchestratedMutation: redispatchRecoveredOrchestratedMutation,
    activeRun: (runId) => activeRuns.get(runId) ?? null,
    preserveForHandoff: preserveMutationForRecoveryHandoff,
    releaseHandoff: releaseMutationRecoveryHandoff,
  };
}

export async function requestOrchestratedRunRecovery(
  runId: string,
  deps: OrchestratedRunRecoveryRequestDeps = defaultOrchestratedRunRecoveryRequestDeps(),
): Promise<OrchestratedRunRecoveryRequestResult> {
  const handle = deps.activeRun(runId);
  if (!handle) {
    return { kind: 'not-active', reason: 'run is not active' };
  }
  if (handle.descriptor.kind !== 'orchestrated-work') {
    return { kind: 'not-orchestrated', reason: 'run is not an orchestrated-work mutation' };
  }
  if (handle.descriptor.status !== 'running') {
    return { kind: 'not-active', reason: `run is ${handle.descriptor.status}` };
  }

  const mutation = handle.descriptor as MutationDescriptor<OrchestratedWorkPayload>;
  let handoffMarked = false;
  try {
    const initialPreflight = await deps.preflightRecovery(mutation);
    if (initialPreflight.kind === 'not-resumable') return initialPreflight;
    handoffMarked = deps.preserveForHandoff(runId);
    if (!handoffMarked) {
      return { kind: 'not-active', reason: 'run recovery is already in progress' };
    }

    const stillActive = deps.activeRun(runId);
    if (stillActive !== handle || stillActive.descriptor.status !== 'running') {
      return { kind: 'not-active', reason: 'run settled before recovery preservation was acquired' };
    }

    const protectedPreflight = await deps.preflightRecovery(mutation);
    if (protectedPreflight.kind === 'not-resumable') return protectedPreflight;
    if (deps.activeRun(runId) !== handle || handle.descriptor.status !== 'running') {
      return { kind: 'not-active', reason: 'run settled while recovery eligibility was being verified' };
    }

    handle.cancel('system', 'recovery');
    await handle.settled;

    // The old invocation may have completed a task and advanced its durable
    // records between the initial eligibility check and cancellation. The
    // handoff claim is still armed, so teardown cannot remove the worktree
    // while this final reconstruction is captured.
    const settledPreflight = await deps.preflightRecovery(mutation);
    if (settledPreflight.kind === 'not-resumable') return settledPreflight;
    const { cursor, reconstruction } = settledPreflight;
    const result = deps.redispatchOrchestratedMutation(mutation, {
      branch: cursor.branch,
      baseBranch: cursor.baseBranch,
      worktreePath: cursor.worktreePath,
      reconstruction,
      resumeFromTaskId: reconstruction.nextTask?.id ?? null,
      existingBranch: true,
    });
    if (!result.ok) {
      return { kind: 'error', reason: result.reason };
    }
    return { kind: 'recovered', runId };
  } catch (err) {
    return { kind: 'error', reason: (err as Error).message };
  } finally {
    if (handoffMarked) deps.releaseHandoff(runId);
  }
}

// ---------------------------------------------------------------------------
// Shutdown park (docs/projects/bugs.md — orchestrated-run restart safety 1/2)
// ---------------------------------------------------------------------------

export interface ShutdownParkDeps {
  listActiveRuns: () => RunHandle[];
  preflightRecovery: (mutation: MutationDescriptor<OrchestratedWorkPayload>) => Promise<OrchestratedRecoveryPreflightResult>;
  runGit: GitRunner;
  worktreeExists: (path: string) => boolean;
  writeTerminal: (descriptor: MutationDescriptor, event: MutationEvent) => void;
  resolveBaseBranch: (product: string) => string;
  resolveWorktreePath: (product: string, project: string) => string;
}

export interface ShutdownParkResult {
  parked: string[];
  resumable: string[];
  skipped: string[];
}

export function defaultShutdownParkDeps(): ShutdownParkDeps {
  return {
    listActiveRuns: () => [...activeRuns.values()],
    preflightRecovery: preflightOrchestratedRecovery,
    runGit: defaultRunGit,
    worktreeExists: existsSync,
    writeTerminal: writeRecoveredTerminalMutation,
    resolveBaseBranch: (product) => {
      try {
        return getProductConfig(product, config.PRODUCTS_CONFIG_FILE).baseBranch;
      } catch {
        return 'main';
      }
    },
    resolveWorktreePath: (product, project) => worktreePathFor(product, project, config.WORKTREE_ROOT),
  };
}

/**
 * Park in-flight orchestrated runs that next-boot recovery could NOT resume.
 *
 * Called by shutdown() AFTER killActiveProcesses()/waitForActiveProcesses()
 * (children dead → stable worktrees) and after setMutationShutdownInProgress()
 * armed the applier-side suppression, so nothing races these writes.
 *
 * - A run that PASSES the shared recovery preflight is left `running` on disk:
 *   boot recovery re-dispatches it automatically — parking it would degrade a
 *   routine deploy restart from hands-off resume to a human-gated release.
 * - A run that FAILS preflight (mid-first-task or invalid worktree state;
 *   recovery would orphan it and discard the diff) is parked: best-effort WIP
 *   commit onto the run
 *   branch, then a completed+parked:true terminal + blocked-on-human
 *   supervision row via writeRecoveredTerminalMutation, so the run survives
 *   the restart visible-and-releasable in the approvals surfaces.
 * - A run whose worktree does not exist on disk is skipped — there is nothing
 *   to preserve, and boot orphaning loses nothing.
 */
export async function parkInFlightOrchestratedRuns(
  deps: ShutdownParkDeps = defaultShutdownParkDeps(),
): Promise<ShutdownParkResult> {
  const result: ShutdownParkResult = { parked: [], resumable: [], skipped: [] };
  for (const handle of deps.listActiveRuns()) {
    const descriptor = handle.descriptor;
    if (descriptor.kind !== 'orchestrated-work' || descriptor.status !== 'running') continue;
    try {
      handle.cancel('system', 'shutdown');
      const preflight = await deps.preflightRecovery(descriptor as MutationDescriptor<OrchestratedWorkPayload>);
      if (preflight.kind === 'recoverable') {
        result.resumable.push(descriptor.id);
        continue;
      }

      const payload = descriptor.payload as OrchestratedWorkPayload;
      const projectSlug = payload.projectSlug;
      const product = payload.product ?? 'rune';
      const branch = workBranchName(projectSlug);
      const baseBranch = deps.resolveBaseBranch(product);
      const worktreePath = deps.resolveWorktreePath(product, projectSlug);
      if (!deps.worktreeExists(worktreePath)) {
        log.warn('orchestrated-work-runner: shutdown park skipped — worktree missing', {
          id: descriptor.id,
          project: projectSlug,
        });
        result.skipped.push(descriptor.id);
        continue;
      }

      const wipSha = await commitWorktreeWip(deps.runGit, worktreePath, {
        message: `rune(${product}): WIP — shutdown park — ${projectSlug}`,
        logLabel: 'shutdown WIP commit',
        product,
        projectSlug,
      });
      const reason =
        wipSha === null
          ? 'parked at shutdown: process restart interrupted task execution'
          : `parked at shutdown: process restart interrupted task execution; WIP preserved as ${wipSha.slice(0, 7)}`;
      deps.writeTerminal(
        descriptor,
        term(descriptor.id, 'completed', {
          projectSlug,
          product,
          parked: true,
          reason,
          cancelReason: 'system',
          cancelSource: 'shutdown',
          disposition: {
            kind: 'parked',
            reason: 'worktree parked for shutdown recovery',
            ...(wipSha !== null ? { wipSha } : {}),
          },
          operatorWorktreePath: worktreePath,
          branch,
          baseBranch,
          preserveBranch: true,
          preserveWorktree: true,
        }),
      );
      result.parked.push(descriptor.id);
      log.info('orchestrated-work-runner: parked in-flight run at shutdown', {
        id: descriptor.id,
        project: projectSlug,
        wip: wipSha ?? 'clean',
      });
    } catch (err) {
      // One bad run must not abort parking the rest (or the shutdown itself).
      log.warn('orchestrated-work-runner: shutdown park failed for run', {
        id: descriptor.id,
        error: (err as Error).message,
      });
      result.skipped.push(descriptor.id);
    }
  }
  return result;
}

/** Best-effort WIP commit of a dirty worktree for shutdown/recovery flows.
 *  Returns the commit sha; intentionally collapses a clean tree and git failure
 *  to null because these callers must park/resume regardless. Closeout uses the
 *  distinct discriminated `WipCheckpointResult`. */
async function commitWorktreeWip(
  runGit: GitRunner,
  cwd: string,
  args: { message: string; logLabel: string; product: string; projectSlug: string; knownDirty?: boolean },
): Promise<string | null> {
  const message = args.message.slice(0, 200);
  try {
    if (args.knownDirty !== true) {
      const { stdout } = await runGit(['status', '--porcelain'], { cwd });
      if (stdout.trim() === '') return null;
    }
    await runGit(['add', '-A'], { cwd });
    await runGit(['commit', '-m', message], { cwd });
    const { stdout: sha } = await runGit(['rev-parse', 'HEAD'], { cwd });
    return sha.trim();
  } catch (err) {
    log.warn(`orchestrated-work-runner: ${args.logLabel} failed`, {
      product: args.product,
      project: args.projectSlug,
      error: (err as Error).message,
    });
    return null;
  }
}

function withTerminalDisposition(
  terminal: MutationEvent,
  disposition: ExecutionTerminalDisposition,
  sandbox?: SandboxSpec,
  branch?: string,
  baseBranch?: string,
): MutationEvent {
  const triggered = withTerminalTrigger(terminal);
  const data = { ...((triggered.data ?? {}) as Record<string, unknown>) };
  const durable: ExecutionTerminalDisposition = {
    kind: disposition.kind,
    reason: sanitizeExecutionDiagnostic(disposition.reason),
    ...(disposition.wipSha ? { wipSha: disposition.wipSha } : {}),
  };
  data['disposition'] = durable;
  if (disposition.kind === 'parked' && sandbox !== undefined) {
    data['parked'] = true;
    data['operatorWorktreePath'] = sandbox.worktree;
    if (branch !== undefined) data['branch'] = branch;
    if (baseBranch !== undefined) data['baseBranch'] = baseBranch;
    data['preserveBranch'] = true;
    data['preserveWorktree'] = true;
  } else if (disposition.kind === 'removed') {
    delete data['parked'];
    delete data['operatorWorktreePath'];
    delete data['preserveBranch'];
    delete data['preserveWorktree'];
  }
  return { ...triggered, data };
}

function withTerminalTrigger(terminal: MutationEvent): MutationEvent {
  const data = { ...((terminal.data ?? {}) as Record<string, unknown>) };
  if (isExecutionTerminalTrigger(data['trigger'])) return { ...terminal, data };
  const reason = typeof data['reason'] === 'string'
    ? sanitizeExecutionDiagnostic(data['reason'])
    : terminal.kind === 'completed' ? 'completed' : 'failed';
  const executionFailure = isExecutionFailure(data['executionFailure'])
    ? data['executionFailure']
    : undefined;
  const cancellation = workRunCancellation(data['cancellation']);
  const cancellationSource = typeof data['cancelSource'] === 'string'
    ? data['cancelSource'] as ExecutionTerminalTrigger['cancellationSource']
    : data['cancelReason'] as ExecutionTerminalTrigger['cancellationSource'];
  const trigger: ExecutionTerminalTrigger = data['cancelReason'] === 'user' || data['cancelReason'] === 'system'
    ? {
        kind: 'cancellation',
        reason,
        ...(cancellationSource !== undefined ? { cancellationSource } : {}),
        ...(cancellation !== undefined ? { cancellation } : {}),
      }
    : terminal.kind === 'failed'
      ? { kind: 'failure', reason, ...(executionFailure !== undefined ? { executionFailure } : {}) }
      : { kind: 'success', reason };
  return { ...terminal, data: { ...data, reason, trigger } };
}

function parkedDisposition(reason: string, wipSha?: string): ExecutionTerminalDisposition {
  return {
    kind: 'parked',
    reason: sanitizeExecutionDiagnostic(reason),
    ...(wipSha ? { wipSha } : {}),
  };
}

type TerminalizationPhase =
  | 'active'
  | 'disposition-resolved'
  | 'transcript-flushed'
  | 'terminal-persisted';

class TerminalizationCoordinator {
  phase: TerminalizationPhase = 'active';
  preserveWorktree = false;
  finalizerOwnsTeardown = false;
  private dispositionDone = false;

  get dispositionResolved(): boolean {
    return this.dispositionDone;
  }

  requestPreservation(): void {
    this.preserveWorktree = true;
  }

  markFinalizerTeardown(): void {
    this.finalizerOwnsTeardown = true;
  }

  markDispositionResolved(disposition?: ExecutionTerminalDisposition): void {
    if (disposition?.kind !== 'removed') this.requestPreservation();
    this.dispositionDone = true;
    this.phase = 'disposition-resolved';
  }

  markTranscriptFlushed(): void {
    this.phase = 'transcript-flushed';
  }

  markTerminalPersisted(): void {
    this.phase = 'terminal-persisted';
  }
}

/**
 * Fail-closed terminal cleanup. A worktree is removed only after Git proves it
 * clean and the cursor has been atomically invalidated. Dirty or uncertain
 * state is preserved as a parked run.
 */
async function disposeTerminalWorktree(args: {
  deps: OrchestratedRuntimeDeps;
  descriptor: MutationDescriptor<OrchestratedWorkPayload>;
  sandbox: SandboxSpec;
  branch: string;
  baseBranch: string;
}): Promise<ExecutionTerminalDisposition> {
  const { deps, descriptor, sandbox, branch, baseBranch } = args;
  if (!claimMutationTerminalTeardown(descriptor.id)) {
    return { kind: 'preserved', reason: 'terminal cleanup already claimed' };
  }
  try {
    let dirty: boolean;
    try {
      dirty = (await deps.inspectWorktreeStatus(sandbox.worktree)).trim() !== '';
    } catch {
      return parkedDisposition(
        'parked during terminal cleanup: Git status could not be verified',
      );
    }

    if (dirty) {
      const runningMutation = { ...descriptor, status: 'running' as const };
      let preflight: OrchestratedRecoveryPreflightResult;
      try {
        preflight = await deps.preflightRecovery(runningMutation);
      } catch {
        return parkedDisposition(
          'parked during terminal cleanup: resumable cursor could not be verified',
        );
      }
      let reason = 'parked during terminal cleanup: uncommitted work was preserved';
      let wipSha: string | undefined;
      if (preflight.kind === 'recoverable') {
        const sha = await commitWorktreeWip(deps.runGit, sandbox.worktree, {
          message: `rune(${descriptor.payload.product ?? 'rune'}): WIP — terminal park — ${descriptor.payload.projectSlug}`,
          logLabel: 'terminal WIP commit',
          product: descriptor.payload.product ?? 'rune',
          projectSlug: descriptor.payload.projectSlug,
          knownDirty: true,
        });
        if (sha === null) {
          reason = 'parked during terminal cleanup: WIP commit could not be verified';
        } else {
          wipSha = sha;
          reason = `parked during terminal cleanup: WIP preserved as ${sha.slice(0, 7)}`;
        }
      } else {
        reason = `parked during terminal cleanup: ${preflight.reason}; uncommitted work was preserved`;
      }
      return parkedDisposition(reason, wipSha);
    }

    try {
      await invalidateCursorThenRemoveWorktree({
        runId: descriptor.id,
        reason: 'terminal worktree cleanup',
        invalidateCursor: deps.invalidateRunCursor,
        removeWorktree: async () => deps.destroyWorktree(sandbox, {
          productsConfigPath: config.PRODUCTS_CONFIG_FILE,
          worktreeRoot: config.WORKTREE_ROOT,
        }),
      });
      return { kind: 'removed', reason: 'clean terminal worktree removed' };
    } catch (err) {
      log.warn('orchestrated-work-runner: terminal worktree cleanup failed', {
        sandbox: sandbox.worktree,
        error: (err as Error).message,
      });
      return parkedDisposition(
        'parked during terminal cleanup: cursor invalidation or worktree removal failed',
      );
    }
  } finally {
    releaseMutationTerminalTeardown(descriptor.id);
  }
}

// ---------------------------------------------------------------------------
// Runtime seam (injected so the apply→event mapping is fixture-testable)
// ---------------------------------------------------------------------------

export interface OrchestratedRuntimeDeps {
  createWorktree: typeof defaultCreateWorktree;
  destroyWorktree: typeof defaultDestroyWorktree;
  /** Run the orchestration loop. Defaults to `runProjectOrchestration`; tests
   *  inject a canned result so the loop's deps are never exercised. */
  runOrchestration: (deps: OrchestrationDeps) => Promise<OrchestrationResult>;
  runGit: GitRunner;
  runCanonicalGit: GitRunner;
  captureTaskBaseTree: (runGit: GitRunner, cwd: string) => Promise<string>;
  verifyWorktree: typeof verifyWorktreeProvisioning;
  /** Isolated teardown status seam; avoids coupling classification Git probes to cleanup. */
  inspectWorktreeStatus: (worktreePath: string) => Promise<string>;
  /** Build the per-task workflow runner (Phase 8). Production is the LIVE
   *  role-spawn binding from team-task-deps.ts — the no-stub regression test
   *  identity-asserts this default. */
  createTaskWorkflowRunner: typeof createProductionTaskWorkflowRunner;
  /** Base dir for per-run artifacts (`<workRunsDir>/<id>/{transcript,summary}`). */
  workRunsDir: string;
  /** Rolling recent-runs index file (`logs/work-runs/index.jsonl`). */
  workRunsIndexFile: string;
  /** Build the per-run durable transcript sink. */
  createSink: (runId: string, baseDir: string) => TranscriptSink | null;
  /** Atomically write the run's `summary.json` into its per-run dir. */
  writeSummary: (dir: string, summary: WorkRunSummary) => void;
  /** Append one torn-line-tolerant row to the rolling index. */
  appendIndexRow: (filePath: string, row: WorkRunIndexRow) => void;
  /** Durable per-run finalize-phase store for gated-merge crash resume. */
  recordWorkRunPhase?: (runId: string, phase: FinalizerPhase) => void;
  readLastWorkRunPhase?: (runId: string) => FinalizerPhase | null;
  /** Run the hard merge gate in its throwaway integration worktree. */
  runGate: typeof defaultRunGate;
  /** Task-scoped validation seams, including the compatible related-test rerun. */
  runFullSuiteValidation: typeof defaultRunFullSuiteValidation;
  runValidationCommandArgv: typeof defaultRunValidationCommandArgv;
  runValidationCommands: typeof defaultRunValidationCommands;
  /** Build the throwaway integration worktree path used by the gate runtime. */
  integrationWorktree: (product: string, runId: string) => string;
  /** Refresh the rebuildable product/project registry after a branch lands on
   *  the product's base branch. Best-effort at the call site. */
  refreshRegistry: () => void;
  /** Invalidate resumability before any terminal worktree removal. */
  invalidateRunCursor: (runId: string, reason: string) => void;
  /** Persist a fail-closed parked disposition discovered during teardown. */
  writeRecoveredTerminal: (descriptor: MutationDescriptor, event: MutationEvent) => void;
  /** Shared recovery invariant used to decide whether dirty work is resumable. */
  preflightRecovery: (mutation: MutationDescriptor<OrchestratedWorkPayload>) => Promise<OrchestratedRecoveryPreflightResult>;
}

function productionRuntimeDeps(): OrchestratedRuntimeDeps {
  return {
    createWorktree: defaultCreateWorktree,
    destroyWorktree: defaultDestroyWorktree,
    runOrchestration: runProjectOrchestration,
    runGit: defaultRunGit,
    runCanonicalGit: defaultRunCanonicalGit,
    captureTaskBaseTree: captureCleanTaskBaseTree,
    verifyWorktree: verifyWorktreeProvisioning,
    inspectWorktreeStatus: async (worktreePath) =>
      (await defaultRunGit(['status', '--porcelain'], { cwd: worktreePath })).stdout,
    createTaskWorkflowRunner: createProductionTaskWorkflowRunner,
    workRunsDir: config.WORK_RUNS_DIR,
    workRunsIndexFile: config.WORK_RUNS_INDEX_FILE,
    createSink: createOrchestratedTranscriptSink,
    writeSummary,
    appendIndexRow,
    recordWorkRunPhase: (runId, phase) => recordWorkRunPhase(config.WORK_RUNS_DIR, runId, phase),
    readLastWorkRunPhase: (runId) => readLastWorkRunPhase(config.WORK_RUNS_DIR, runId),
    runGate: defaultRunGate,
    runFullSuiteValidation: defaultRunFullSuiteValidation,
    runValidationCommandArgv: defaultRunValidationCommandArgv,
    runValidationCommands: defaultRunValidationCommands,
    integrationWorktree: (product, runId) => join(config.WORKTREE_ROOT, `gate-${product}-${runId}`),
    refreshRegistry: () => { rebuildRegistry(); },
    invalidateRunCursor: (runId, reason) => invalidateOrchestratedRunCursor(config.WORK_RUNS_DIR, runId, reason),
    writeRecoveredTerminal: (descriptor, event) => writeRecoveredTerminalMutation(descriptor, event),
    preflightRecovery: preflightOrchestratedRecovery,
  };
}

let runtimeDeps: OrchestratedRuntimeDeps = productionRuntimeDeps();

/** Test-only: override part of the runtime seam. */
export function __setOrchestratedRuntimeForTest(partial: Partial<OrchestratedRuntimeDeps>): void {
  runtimeDeps = { ...runtimeDeps, ...partial };
}

/** Test-only: restore the production seam. */
export function __resetOrchestratedRuntimeForTest(): void {
  runtimeDeps = productionRuntimeDeps();
}

/** Test-only: read the current runtime seam (the no-stub regression test
 *  asserts the production `createTaskWorkflowRunner` binding). */
export function __getRuntimeDepsForTest(): OrchestratedRuntimeDeps {
  return runtimeDeps;
}

function refreshRegistryAfterLanding(
  deps: OrchestratedRuntimeDeps,
  context: { runId: string; projectSlug: string; product: string },
): void {
  try {
    deps.refreshRegistry();
  } catch (err) {
    log.warn('orchestrated-work-runner: registry refresh failed after branch landing', {
      id: context.runId,
      projectSlug: context.projectSlug,
      product: context.product,
      error: (err as Error).message,
    });
  }
}

// ---------------------------------------------------------------------------
// Production OrchestrationDeps wiring (real fs/git/finalizer effects)
// ---------------------------------------------------------------------------

/** Build the real-effect OrchestrationDeps for a run against its worktree.
 *  Pure-loop logic lives in project-orchestrator.ts; this binds the I/O. */
export async function commitReviewedCloseoutTree(input: {
  cwd: string;
  branch: string;
  reviewedTreeOid: string;
  contextPath: string;
  contextContent: string;
  tasksPath: string;
  tasksContent: string;
  message: string;
  runGit: GitRunner;
}): Promise<string> {
  const isolatedDir = mkdtempSync(join(tmpdir(), 'rune-closeout-index-'));
  const isolatedIndex = join(isolatedDir, 'index');
  const preparedContext = join(isolatedDir, 'context.md');
  const preparedTasks = join(isolatedDir, 'tasks.md');
  writeFileSync(preparedContext, input.contextContent, { encoding: 'utf8', mode: 0o600 });
  writeFileSync(preparedTasks, input.tasksContent, { encoding: 'utf8', mode: 0o600 });
  const isolatedOpts = {
    cwd: input.cwd,
    env: { GIT_INDEX_FILE: isolatedIndex },
  };
  let closeoutTree: string;
  try {
    await input.runGit(['read-tree', input.reviewedTreeOid], isolatedOpts);
    for (const [path, prepared] of [
      [input.contextPath, preparedContext],
      [input.tasksPath, preparedTasks],
    ] as const) {
      const { stdout: blobOut } = await input.runGit(
        ['hash-object', '-w', prepared],
        { cwd: input.cwd },
      );
      const blob = blobOut.trim();
      if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(blob)) {
        throw new Error('closeout managed blob could not be verified');
      }
      await input.runGit(
        ['update-index', '--add', '--cacheinfo', `100644,${blob},${path}`],
        isolatedOpts,
      );
    }
    const { stdout: treeOut } = await input.runGit(['write-tree'], isolatedOpts);
    closeoutTree = treeOut.trim();
  } finally {
    rmSync(isolatedDir, { recursive: true, force: true });
  }
  const { stdout: changedOut } = await input.runGit([
    'diff-tree',
    '--no-commit-id',
    '--name-only',
    '-r',
    input.reviewedTreeOid,
    closeoutTree,
  ], { cwd: input.cwd });
  const allowed = new Set([input.contextPath, input.tasksPath]);
  const unexpected = changedOut
    .split('\n')
    .map((path) => path.trim())
    .filter(Boolean)
    .filter((path) => !allowed.has(path));
  if (unexpected.length > 0) {
    throw new Error('closeout staged tree diverged from the reviewed tree');
  }
  const { stdout: parentOut } = await input.runGit(['rev-parse', 'HEAD'], { cwd: input.cwd });
  const parent = parentOut.trim();
  const branchRef = `refs/heads/${input.branch}`;
  if (!/^refs\/heads\/[A-Za-z0-9._/-]+$/.test(branchRef)) {
    throw new Error('closeout branch ref could not be verified');
  }
  const { stdout: commitOut } = await input.runGit([
    'commit-tree',
    closeoutTree,
    '-p',
    parent,
    '-m',
    input.message,
  ], { cwd: input.cwd });
  const sha = commitOut.trim();
  await input.runGit(['update-ref', branchRef, sha, parent], { cwd: input.cwd });
  await input.runGit(['read-tree', closeoutTree], { cwd: input.cwd });
  return sha;
}

function buildOrchestrationDeps(args: {
  descriptor: MutationDescriptor<OrchestratedWorkPayload>;
  sandbox: SandboxSpec;
  projectDir: string;
  product: string;
  projectSlug: string;
  branch: string;
  baseBranch: string;
  validationCommands: string[];
  validationCommandProfiles: ValidationCommandProfile[];
  validationAdapters: ValidationAdapter[];
  validationCwd?: string;
  closeoutValidationStrategy: CloseoutValidationStrategy;
  workRunsDir: string;
  runGit: GitRunner;
  runCanonicalGit?: GitRunner;
  captureTaskBaseTree: (runGit: GitRunner, cwd: string) => Promise<string>;
  runValidationCommandArgv: typeof defaultRunValidationCommandArgv;
  runValidationCommands: typeof defaultRunValidationCommands;
  runFullSuiteValidation: typeof defaultRunFullSuiteValidation;
  createTaskWorkflowRunner: typeof createProductionTaskWorkflowRunner;
  emit?: (event: OrchestrationActivityEvent) => void;
  cancel?: () => boolean;
  cancelReason?: () => CancelReason | null;
  cancelSource?: () => MutationCancellationSource | null;
  supersedeSystemCancellation?: () => RevocableMutationCancellationSource | null;
  publishAgents?: (records: TaskRunRecord[]) => void;
  finalize: FinalizerAdapter;
}): OrchestrationDeps {
  const { descriptor, sandbox, projectDir, product, projectSlug, branch, baseBranch, runGit } = args;
  const specPath = join(projectDir, 'spec.md');
  const tasksPath = join(projectDir, 'tasks.md');
  const contextPath = join(projectDir, 'context.md');
  const cwd = sandbox.worktree;
  const canonicalGit = args.runCanonicalGit ?? runGit;
  const relativeContextFile = relative(cwd, contextPath).replaceAll('\\', '/');
  const contextFile = relativeContextFile === '..' ||
      relativeContextFile.startsWith('../') ||
      relativeContextFile.startsWith('/')
    ? 'context.md'
    : redactSecrets(
        scrubAbsolutePaths(
          scrubPathsInText(relativeContextFile),
        ),
      );
  let pendingCloseoutContext: string | undefined;
  let pendingCloseoutTasks: string | undefined;
  let pendingReviewedTreeOid: string | undefined;
  const taskWorkflowRunner = args.createTaskWorkflowRunner({
    sandbox,
    productsConfigPath: config.PRODUCTS_CONFIG_FILE,
    modelPolicyPath: config.MODEL_POLICY_FILE,
    validationCommands: args.validationCommands,
    validationCommandProfiles: args.validationCommandProfiles,
    validationAdapters: args.validationAdapters,
    ...(args.validationCwd !== undefined ? { validationCwd: args.validationCwd } : {}),
    cap: ORCHESTRATED_ROUND_CAP,
    persistExecutionCheckpoint: async (executionCheckpoint) => {
      const cursor = readOrchestratedRunCursor(args.workRunsDir, descriptor.id);
      if (cursor === null) throw new Error('resumable orchestration cursor is unavailable');
      writeOrchestratedRunCursor(args.workRunsDir, descriptor.id, {
        ...cursor,
        executionCheckpoint,
      });
    },
    persistTaskValidationFailure: async (failure) => {
      appendDurableValidationFailure(
        args.workRunsDir,
        descriptor.id,
        'task-validation-failures.jsonl',
        failure,
      );
    },
    ...(args.cancel !== undefined ? {
      cancellationDuringBackoff: () => args.cancel?.()
        ? {
            operationId: descriptor.id,
            source: 'internal' as const,
            requestedAt: new Date().toISOString(),
          }
        : undefined,
    } : {}),
    ...(args.emit !== undefined ? { emit: args.emit } : {}),
  });

  return {
    runId: descriptor.id,
    project: projectSlug,
    product,
    branch,
    worktreePath: sandbox.worktree,
    contextFile,
    baseBranch,
    ...(args.emit !== undefined ? { emit: args.emit } : {}),
    ...(args.cancel !== undefined ? { cancel: args.cancel } : {}),
    ...(args.cancelReason !== undefined ? { cancelReason: args.cancelReason } : {}),
    ...(args.cancelSource !== undefined ? { cancelSource: args.cancelSource } : {}),
    ...(args.supersedeSystemCancellation !== undefined
      ? { supersedeSystemCancellation: args.supersedeSystemCancellation }
      : {}),
    appendTaskRunRecord: async (record) => {
      appendOrchestratedTaskRunRecord(args.workRunsDir, descriptor.id, record);
      const records = readOrchestratedTaskRunRecords(args.workRunsDir, descriptor.id);
      args.publishAgents?.(records.length > 0 ? records : [record]);
    },
    writeRunCursor: async (cursor) => writeOrchestratedRunCursor(args.workRunsDir, descriptor.id, cursor),
    currentExecutionCheckpoint: () =>
      readOrchestratedRunCursor(args.workRunsDir, descriptor.id)?.executionCheckpoint,
    appendTerminalBugEntries: async (entries) => {
      // File to the CANONICAL product repo's bugs.md, NEVER the throwaway
      // worktree: a non-merge run (hold/partial/parked) GCs its branch, and an
      // in-loop worktree write would also dirty the tree against closeout's
      // clean-tree invariant. The cockpit drawer reads this canonical file, so
      // the bug surfaces immediately regardless of the run's outcome.
      await fileTerminalBugsToBacklog({
        repoPath: getProductConfig(product, config.PRODUCTS_CONFIG_FILE).repoPath,
        product,
        entries,
        runGit,
        mutationsLogFile: config.BACKLOG_MUTATIONS_FILE,
      });
    },

    readTasksMd: async () => readManagedWorktreeFile(cwd, tasksPath, false),
    readContextMd: async () => readManagedWorktreeFile(cwd, contextPath, true),
    readSpec: async () => readManagedWorktreeFile(cwd, specPath, false),
    captureTaskBase: async (task) => {
      const durable = sandbox.resumed === true
        ? readOrchestratedRunCursor(
            args.workRunsDir,
            descriptor.id,
          )?.taskBase
        : undefined;
      if (durable !== undefined) {
        if (durable.taskId !== task.id) {
          throw new Error('durable task base belongs to a different task');
        }
        const treeOid = await verifyTaskBaseTree(
          canonicalGit,
          sandbox.worktree,
          durable.treeOid,
        );
        return { taskId: task.id, treeOid };
      }
      const treeOid = await args.captureTaskBaseTree(
        canonicalGit,
        sandbox.worktree,
      );
      return { taskId: task.id, treeOid };
    },

    // Phase 8: the LIVE per-task role-spawn binding — runTeamTaskWorkflow over
    // the production TeamTaskDeps (execution-agent artifact sessions, charter
    // judgment calls, policy-resolved models, fail-closed reviewer
    // independence). Resolution failures surface as durable blocked evidence.
    runTaskWorkflow: async (task, ctx) => taskWorkflowRunner(task, {
      ...ctx,
      contextMd: await appendBranchTreeStateEvidence(ctx.contextMd, {
        runGit,
        cwd,
        baseBranch,
        baseSha: sandbox.baseSha,
      }),
    }),

    // Derive a neutral context update from the task evidence. Real role-authored
    // updates arrive with the live workflow; until then the curator only threads
    // the workflow's handoff notes (kept neutral so no validation gate trips).
    curateContext: (_current: string, evidence: TaskEvidence): ContextUpdate => ({
      kind: 'neutral',
      sections: {},
      ...(evidence.handoffNotes.length > 0 ? { handoffNotes: evidence.handoffNotes } : {}),
    }),
    writeContextMd: async (content: string) => {
      assertCloseoutManagedPaths(cwd, tasksPath, contextPath);
      writeManagedWorktreeFile(cwd, contextPath, content, true);
      pendingCloseoutContext = content;
    },
    writeTasksMd: async (content: string) => {
      assertCloseoutManagedPaths(cwd, tasksPath, contextPath);
      writeManagedWorktreeFile(cwd, tasksPath, content, false);
      pendingCloseoutTasks = content;
    },

    // Task-scoped closeout checks use the product policy's short-budget
    // strategy. The project-level finalizer independently owns the full gate.
    runCloseoutChecks: async (task, evidence) => {
      pendingReviewedTreeOid = evidence.currentReviewTree;
      const runDir = join(args.workRunsDir, descriptor.id);
      const diagnosticDir = join(runDir, 'validation-diagnostics');
      const scrub = (text: string): string =>
        redactSecrets(scrubAbsolutePaths(scrubPathsInText(text)));
      const validationCwdLabel = scrub(args.validationCwd?.trim() || '.');
      const admission = validateTaskValidationAdmission({
        policy: task.validationPolicy ?? 'required',
        commands: args.validationCommands,
        worktree: sandbox.worktree,
        ...(args.validationCwd !== undefined ? { validationCwd: args.validationCwd } : {}),
      });
      if (!admission.ok) {
        appendDurableValidationFailure(
          args.workRunsDir,
          descriptor.id,
          'task-validation-failures.jsonl',
          admission.failure,
        );
        return {
          ok: false,
          failure: {
            command: admission.failure.command,
            exitCode: null,
            timedOut: false,
            outputTail: admission.failure.diagnostics,
            validationCwd: validationCwdLabel,
            validationFailure: admission.failure,
          },
        };
      }
      let validation: ValidationCommandListResult | undefined;
      let relatedTestDiagnostic: RelatedTestDiagnostic | undefined;
      let relatedRan = false;
      let fullSuiteAttestation: FullSuiteAttestation | undefined;
      let validationReceipt: DurableValidationReceipt | undefined;
      if (task.validationPolicy === 'reviewed-no-validation') {
        validation = { ok: true };
      } else {
        let ownedValidationHandled = false;
        if (
          evidence.currentReviewTree !== undefined &&
          evidence.fullTaskReviewHash !== undefined
        ) {
          const fullResult = await args.runFullSuiteValidation({
            commands: args.validationCommands,
            commandProfiles: args.validationCommandProfiles,
            adapters: args.validationAdapters,
            worktree: sandbox.worktree,
            cwd: admission.cwd,
            validationCwd: args.validationCwd?.trim() || '.',
            expectedTreeOid: evidence.currentReviewTree,
            fullTaskReviewHash: evidence.fullTaskReviewHash,
            timeoutMs: config.WORK_RUN_CLOSEOUT_COMMAND_TIMEOUT_MS,
            diagnosticDir,
            ...(args.cancel !== undefined ? { cancelled: args.cancel } : {}),
          }, {
            runGit: canonicalGit,
            runCommand: (_command, argv, commandCwd, timeoutMs, commandDiagnosticDir, options) =>
              args.runValidationCommandArgv(
                argv,
                commandCwd,
                timeoutMs,
                commandDiagnosticDir,
                options,
              ),
            ...(args.runValidationCommandArgv === defaultRunValidationCommandArgv
              ? {
                  runTrustedVitestObserver,
                  ...productionFullSuiteProfileIO(),
                }
              : {}),
          });
          if (!fullResult.ok && !fullSuiteFailureAllowsCloseoutFallback(fullResult)) {
            validation = fullResult;
            ownedValidationHandled = true;
          } else if (fullResult.ok) {
            const reusableEvidence = selectReusableFullSuiteEvidence(fullResult);
            fullSuiteAttestation = reusableEvidence?.attestation;
            if (reusableEvidence !== undefined) {
              validationReceipt =
                durableValidationReceipt(reusableEvidence.receipt, 'full-suite-reused');
              validation = { ok: true };
              ownedValidationHandled = true;
            } else if (
              args.closeoutValidationStrategy === 'product-commands' &&
              fullResult.validationReceipt.outcome === 'passed'
            ) {
              const compactAny = fullResult.receipts[0];
              validationReceipt = compactAny !== undefined
                ? durableValidationReceipt(compactAny, 'full-suite-ran')
                : undefined;
              validation = { ok: true };
              ownedValidationHandled = true;
            }
          }
        }
        if (!ownedValidationHandled) {
          if (args.closeoutValidationStrategy === 'vitest-related') {
            const changedPaths = evidence.taskBaseTree !== undefined
              ? await captureCanonicalChangedPaths(
                  canonicalGit,
                  sandbox.worktree,
                  evidence.taskBaseTree,
                )
              : await collectTaskChangedPaths(sandbox.worktree, runGit);
            if (await taskChangesRequireFullValidation(sandbox.worktree, changedPaths, runGit)) {
              validation = await args.runValidationCommands(
                args.validationCommands,
                admission.cwd,
                config.WORK_RUN_CLOSEOUT_COMMAND_TIMEOUT_MS,
                undefined,
                diagnosticDir,
                {
                  commandProfiles: args.validationCommandProfiles,
                  adapters: args.validationAdapters,
                },
              );
            } else {
              // Paths from Git are worktree-relative, while Vitest runs from the
              // validated product directory. Rebase them before argv construction.
              // Vitest related has no `--` terminator, so prefix a leading dash.
              const pathArgs = changedPaths
                .map((path) => relative(admission.cwd, resolve(sandbox.worktree, path)).replaceAll('\\', '/'))
                .map((path) => path.startsWith('-') ? `./${path}` : path);
              const argv = ['npx', 'vitest', 'related', '--run', '--passWithNoTests', ...pathArgs];
              if (!relatedTestInvocationSelectionFits(pathArgs, argv)) {
                validation = await args.runValidationCommands(
                  args.validationCommands,
                  admission.cwd,
                  config.WORK_RUN_CLOSEOUT_COMMAND_TIMEOUT_MS,
                  undefined,
                  diagnosticDir,
                  {
                    commandProfiles: args.validationCommandProfiles,
                    adapters: args.validationAdapters,
                  },
                );
              } else {
                const related = await runRelatedTestCloseout({
                  task,
                  selectedPaths: pathArgs,
                  argv,
                  cwd: admission.cwd,
                  validationCwd: validationCwdLabel,
                  timeoutMs: config.WORK_RUN_CLOSEOUT_COMMAND_TIMEOUT_MS,
                  diagnosticDir,
                  workRunsDir: args.workRunsDir,
                  runId: descriptor.id,
                  runValidationCommandArgv: args.runValidationCommandArgv,
                  strictProfileSelection: args.validationAdapters.some(
                    (adapter) => adapter.profileSelection === 'strict-tags-v1',
                  ),
                  emit: args.emit,
                });
                validation = related.validation;
                relatedTestDiagnostic = related.diagnostic;
                relatedRan = true;
              }
            }
          } else {
            validation = await args.runValidationCommands(
              args.validationCommands,
              admission.cwd,
              config.WORK_RUN_CLOSEOUT_COMMAND_TIMEOUT_MS,
              undefined,
              diagnosticDir,
              {
                commandProfiles: args.validationCommandProfiles,
                adapters: args.validationAdapters,
              },
            );
          }
        }
      }
      if (validation === undefined) {
        throw new Error('closeout validation did not produce a result');
      }
      if (validation.ok) {
        if (
          validationReceipt === undefined &&
          relatedRan &&
          evidence.currentReviewTree !== undefined
        ) {
          validationReceipt = {
            provenance: 'related-ran',
            command: 'npx vitest related',
            treeOid: evidence.currentReviewTree,
            outcome: 'passed',
            coverage: 'unsupported',
          };
        }
        if (validationReceipt !== undefined) {
          args.emit?.({
            kind: 'activity',
            data: {
              event: 'closeout-validation',
              taskId: task.id,
              provenance: validationReceipt.provenance,
              treeOid: validationReceipt.treeOid,
              validationReceipt,
              line: validationReceipt.provenance === 'full-suite-reused'
                ? `closeout reused Rune-owned full-suite validation for ${task.id}`
                : `closeout recorded ${validationReceipt.provenance} validation for ${task.id}`,
            },
          });
        }
        const approvedHash = evidence.reviewSurfaceHash;
        if (approvedHash === undefined) {
          return {
            ok: true,
            ...(relatedTestDiagnostic !== undefined ? { relatedTestDiagnostic } : {}),
            ...(fullSuiteAttestation !== undefined ? { fullSuiteAttestation } : {}),
            ...(validationReceipt !== undefined ? { validationReceipt } : {}),
          };
        }
        if (
          evidence.taskBaseTree === undefined ||
          evidence.currentReviewTree === undefined ||
          evidence.fullTaskReviewHash === undefined
        ) {
          const reviewSurfaceFailure: ReviewSurfaceFailure = {
            kind: 'candidate-mismatch',
            canonicalHash: 'missing',
            candidateHash: approvedHash,
            changedPaths: [],
          };
          return {
            ok: false,
            failure: {
              command: 'full-task review-surface verification',
              exitCode: null,
              timedOut: false,
              outputTail: 'canonical review tree identities are missing',
              validationCwd: validationCwdLabel,
              reviewSurfaceFailure,
              ...(relatedTestDiagnostic !== undefined ? { relatedTestDiagnostic } : {}),
            },
          };
        }
        const canonical = await captureCanonicalReviewState(
          canonicalGit,
          sandbox.worktree,
          evidence.taskBaseTree,
        );
        if (
          canonical.hash === evidence.fullTaskReviewHash &&
          canonical.hash === approvedHash &&
          canonical.currentTree === evidence.currentReviewTree
        ) {
          return {
            ok: true,
            ...(relatedTestDiagnostic !== undefined ? { relatedTestDiagnostic } : {}),
            ...(fullSuiteAttestation !== undefined ? { fullSuiteAttestation } : {}),
            ...(validationReceipt !== undefined ? { validationReceipt } : {}),
          };
        }
        const reviewSurfaceFailure: ReviewSurfaceFailure = {
          kind: 'candidate-mismatch',
          canonicalHash: canonical.hash,
          candidateHash: approvedHash,
          taskBaseTree: canonical.baseTree,
          canonicalTree: canonical.currentTree,
          candidateTree: evidence.currentReviewTree,
          changedPaths: canonical.changedPaths,
        };
        appendDurableValidationFailure(
          args.workRunsDir,
          descriptor.id,
          'review-surface-failures.jsonl',
          reviewSurfaceFailure,
        );
        return {
          ok: false,
          failure: {
            command: 'full-task review-surface verification',
            exitCode: null,
            timedOut: false,
            outputTail: reviewSurfaceFailure.changedPaths.join('\n').slice(-8_000),
            validationCwd: validationCwdLabel,
            reviewSurfaceFailure,
            ...(relatedTestDiagnostic !== undefined ? { relatedTestDiagnostic } : {}),
          },
        };
      }
      const command = scrub(validation.command);
      const outputHead = scrub(validation.result.outputHead ?? '');
      const structuredDetails = formatRelatedTestStructuredErrors(validation.result);
      const outputTail = scrub(
        [validation.result.outputTail, structuredDetails].filter(Boolean).join('\n'),
      ).slice(-8_000);
      const diagnosticArtifacts = validation.result.diagnosticArtifacts ?? [];
      const outcome = validation.result.timedOut ? 'timed out' : `exit ${validation.result.exitCode}`;
      const validationFailure = taskValidationCommandFailure(
        command,
        validation.result,
        [outputHead, outputTail].filter(Boolean).join('\n').slice(-8_000),
        validation.argv,
      );
      appendDurableValidationFailure(
        args.workRunsDir,
        descriptor.id,
        'task-validation-failures.jsonl',
        validationFailure,
      );
      // Durable artifact in the run dir — the worktree (and with it the diff
      // that caused the red suite) is GC'd, so this file is the only place the
      // failing output survives. Best-effort: never blocks the red verdict.
      try {
        mkdirSync(runDir, { recursive: true });
        appendFileSync(
          join(runDir, CLOSEOUT_VALIDATION_FAILURE_FILE),
          `=== closeout validation failure @ ${new Date().toISOString()} ===\n` +
            `task: ${task.id} — ${task.text}\n` +
            `command: ${command}\n` +
            `outcome: ${outcome}\n\n` +
            `diagnostics: ${diagnosticArtifacts.length > 0 ? diagnosticArtifacts.map((name) => `validation-diagnostics/${name}`).join(', ') : '(none)'}\n\n` +
            `=== output head ===\n${outputHead || '(no output captured)'}\n\n` +
            `=== output tail ===\n${outputTail || '(no output captured)'}\n\n`,
          'utf8',
        );
      } catch (err) {
        log.error('orchestrated-work-runner: closeout validation artifact write failed', {
          id: descriptor.id,
          error: (err as Error).message,
        });
      }
      log.warn('orchestrated-work-runner: closeout validation command failed', {
        id: descriptor.id,
        projectSlug,
        product,
        command,
        exitCode: validation.result.exitCode,
        timedOut: validation.result.timedOut,
        diagnosticArtifacts,
        outputHead: outputHead.slice(0, CLOSEOUT_LOG_TAIL_CHARS),
        outputTail: outputTail.slice(-CLOSEOUT_LOG_TAIL_CHARS),
      });
      args.emit?.({
        kind: 'activity',
        data: {
          event: 'closeout-validation-failed',
          taskId: task.id,
          command,
          exitCode: validation.result.exitCode,
          timedOut: validation.result.timedOut,
          line: `closeout validation failed: ${command} (${outcome}) — output head/tail saved to ${CLOSEOUT_VALIDATION_FAILURE_FILE}`,
        },
      });
      // Already-scrubbed payload — the orchestrator threads it into the coder
      // repair prompt (cross-provider) and the exhaustion hold reason.
      return {
        ok: false,
        failure: {
          command,
          exitCode: validation.result.exitCode,
          timedOut: validation.result.timedOut,
          outputTail,
          validationCwd: validationCwdLabel,
          validationFailure,
          ...(relatedTestDiagnostic !== undefined ? { relatedTestDiagnostic } : {}),
        },
      };
    },

    commitCloseout: async (task: SelectedTask): Promise<CloseoutCommit> => {
      const message = `rune(${product}): closeout — ${task.text}`.slice(0, 200);
      if (pendingCloseoutContext === undefined || pendingCloseoutTasks === undefined) {
        throw new Error('closeout managed content was not prepared');
      }
      if (
        readManagedWorktreeFile(cwd, contextPath, true) !== pendingCloseoutContext ||
        readManagedWorktreeFile(cwd, tasksPath, false) !== pendingCloseoutTasks
      ) {
        throw new Error('closeout managed content changed before commit');
      }
      // The canonical post-validation capture left the reviewed task tree in
      // the index. Stage only Rune's two deterministic closeout mutations;
      // never `add -A` here, because a late validation descendant could mutate
      // the worktree after review and otherwise smuggle that mutation into the
      // commit.
      const closeoutContextPath = relative(cwd, contextPath).replaceAll('\\', '/');
      const closeoutTasksPath = relative(cwd, tasksPath).replaceAll('\\', '/');
      let sha: string;
      if (pendingReviewedTreeOid !== undefined) {
        sha = await commitReviewedCloseoutTree({
          cwd,
          branch,
          reviewedTreeOid: pendingReviewedTreeOid,
          contextPath: closeoutContextPath,
          contextContent: pendingCloseoutContext,
          tasksPath: closeoutTasksPath,
          tasksContent: pendingCloseoutTasks,
          message,
          runGit,
        });
      } else {
        // Legacy task evidence predating canonical review trees remains
        // compatible, but current role workflows always take the exact-tree
        // commit path above.
        await runGit(['add', '--', closeoutContextPath, closeoutTasksPath], { cwd });
        await runGit(['commit', '-m', message], { cwd });
        const { stdout } = await runGit(['rev-parse', 'HEAD'], { cwd });
        sha = stdout.trim();
      }
      pendingCloseoutContext = undefined;
      pendingCloseoutTasks = undefined;
      pendingReviewedTreeOid = undefined;
      return { sha, subject: message };
    },
    // WIP preservation checkpoint before a closeout terminal. The
    // discriminated result keeps "already clean" distinct from a failed git
    // operation so terminal evidence never implies a checkpoint that did not
    // actually land.
    commitWip: async (task: SelectedTask): Promise<WipCheckpointResult> => {
      const safeTaskText = sanitizeExecutionDiagnostic(task.text);
      const message = `rune(${product}): WIP — closeout blocked — ${safeTaskText}`.slice(0, 200);
      try {
        const { stdout } = await runGit(['status', '--porcelain'], { cwd });
        if (stdout.trim() === '') return { kind: 'already-clean' };
        await runGit(['add', '-A'], { cwd });
        await runGit(['commit', '-m', message], { cwd });
        const { stdout: sha } = await runGit(['rev-parse', 'HEAD'], { cwd });
        args.emit?.({
          kind: 'activity',
          data: {
            event: 'closeout-wip-commit',
            taskId: task.id,
            commitSha: sha.trim(),
            line: `WIP preserved for ${safeTaskText}: ${sha.trim().slice(0, 7)}`,
          },
        });
        return { kind: 'committed', sha: sha.trim() };
      } catch (err) {
        const diagnostic = sanitizeExecutionDiagnostic(err);
        log.warn('orchestrated-work-runner: WIP commit failed', {
          id: descriptor.id,
          error: diagnostic,
        });
        return { kind: 'failed', diagnostic };
      }
    },
    verifyCleanWorktree: async (): Promise<boolean> => {
      const { stdout } = await runGit(['status', '--porcelain'], { cwd });
      return stdout.trim() === '';
    },

    finalize: args.finalize,
  };
}

function assertCloseoutManagedPaths(
  worktree: string,
  tasksPath: string,
  contextPath: string,
): void {
  assertManagedWorktreeFile(worktree, tasksPath, false);
  assertManagedWorktreeFile(worktree, contextPath, true);
}

/** Best-effort reader for non-authoritative diagnostics and canonical backlog I/O. */
function readFileSafe(path: string): string {
  try {
    return existsSync(path) ? readFileSync(path, 'utf8') : '';
  } catch {
    return '';
  }
}

const TREE_STATE_FILES_MAX_CHARS = 8_000;
const TREE_STATE_STAT_MAX_CHARS = 8_000;
const TREE_STATE_DIFF_MAX_CHARS = 20_000;

interface RelatedTestCloseoutArgs {
  task: SelectedTask;
  selectedPaths: string[];
  argv: string[];
  cwd: string;
  validationCwd: string;
  timeoutMs: number;
  diagnosticDir: string;
  workRunsDir: string;
  runId: string;
  runValidationCommandArgv: typeof defaultRunValidationCommandArgv;
  strictProfileSelection?: boolean;
  emit?: (event: OrchestrationActivityEvent) => void;
}

async function runRelatedTestCloseout(
  args: RelatedTestCloseoutArgs,
): Promise<{
  validation: ValidationCommandListResult;
  diagnostic?: RelatedTestDiagnostic;
}> {
  if (args.strictProfileSelection === true) {
    return {
      validation: await runProfiledVitestSelection({
        command: 'npx vitest related',
        argv: args.argv,
        cwd: args.cwd,
        timeoutMs: args.timeoutMs,
        diagnosticDir: args.diagnosticDir,
        runCommandArgv: args.runValidationCommandArgv,
      }),
    };
  }
  const initialResult = await args.runValidationCommandArgv(
    args.argv,
    args.cwd,
    args.timeoutMs,
    args.diagnosticDir,
  );
  if (!initialResult.timedOut && initialResult.exitCode === 0) {
    return { validation: { ok: true } };
  }

  const initialDiagnostic = diagnoseRelatedTestResult({
    selectedPaths: args.selectedPaths,
    argv: args.argv,
    validationCwd: args.validationCwd,
    result: initialResult,
  });
  appendRelatedTestDiagnostic(
    args.workRunsDir,
    args.runId,
    args.task.id,
    initialDiagnostic,
  );
  if (initialDiagnostic.state !== 'related-validation-host-conflict') {
    return {
      validation: {
        ok: false,
        command: initialDiagnostic.initial.command,
        argv: args.argv,
        result: initialResult,
      },
      diagnostic: initialDiagnostic,
    };
  }

  args.emit?.({
    kind: 'activity',
    data: {
      event: 'related-validation-host-conflict',
      taskId: args.task.id,
      state: initialDiagnostic.state,
      conflictKinds: initialDiagnostic.conflictEvidence.map((item) => item.kind),
      line: 'related-test validation hit a host capability conflict; running the policy-preserving compatible confirmation',
    },
  });
  const fallbackResult = await args.runValidationCommandArgv(
    args.argv,
    args.cwd,
    args.timeoutMs,
    args.diagnosticDir,
    { compatibleFallback: true },
  );
  const diagnostic = diagnoseRelatedTestFallback(initialDiagnostic, {
    selectedPaths: args.selectedPaths,
    argv: args.argv,
    validationCwd: args.validationCwd,
    result: fallbackResult,
  });
  appendRelatedTestDiagnostic(
    args.workRunsDir,
    args.runId,
    args.task.id,
    diagnostic,
  );
  args.emit?.({
    kind: 'activity',
    data: {
      event: diagnostic.state,
      taskId: args.task.id,
      state: diagnostic.state,
      line: diagnostic.state === 'related-fallback-passed'
        ? 'related-test compatible confirmation passed under the inherited validation confinement'
        : 'related-test compatible confirmation failed; preserving WIP on an operational validation hold',
    },
  });
  return {
    validation: diagnostic.state === 'related-fallback-passed'
      ? { ok: true }
      : {
          ok: false,
          command: diagnostic.fallback.command,
          argv: args.argv,
          result: fallbackResult,
        },
    diagnostic,
  };
}

function appendDurableValidationFailure(
  workRunsDir: string,
  runId: string,
  file: string,
  failure: TaskValidationFailure | ReviewSurfaceFailure,
): void {
  const runDir = join(workRunsDir, runId);
  mkdirSync(runDir, { recursive: true });
  const scrubbed = redactSecrets(
    scrubAbsolutePaths(scrubPathsInText(JSON.stringify({
      recordedAt: new Date().toISOString(),
      ...failure,
    }))),
  );
  appendFileSync(join(runDir, file), scrubbed + '\n', 'utf8');
}

function appendRelatedTestDiagnostic(
  workRunsDir: string,
  runId: string,
  taskId: string,
  diagnostic: RelatedTestDiagnostic,
): void {
  const runDir = join(workRunsDir, runId);
  mkdirSync(runDir, { recursive: true });
  const scrubbed = redactSecrets(
    scrubAbsolutePaths(scrubPathsInText(JSON.stringify({
      recordedAt: new Date().toISOString(),
      taskId: sanitizeExecutionDiagnostic(taskId)
        .slice(0, RELATED_TEST_TASK_ID_MAX_CHARS),
      ...diagnostic,
    }))),
  );
  appendFileSync(
    join(runDir, RELATED_TEST_DIAGNOSTICS_FILE),
    scrubbed + '\n',
    'utf8',
  );
}

async function appendBranchTreeStateEvidence(
  contextMd: string,
  args: {
    runGit: GitRunner;
    cwd: string;
    baseBranch: string;
    baseSha?: string;
  },
): Promise<string> {
  const evidence = await readBranchTreeStateEvidence(args);
  if (evidence === '') return contextMd;
  return [
    contextMd.trimEnd(),
    '',
    '## Branch Tree-State Evidence',
    '',
    evidence,
  ].join('\n');
}

async function readBranchTreeStateEvidence(args: {
  runGit: GitRunner;
  cwd: string;
  baseBranch: string;
  baseSha?: string;
}): Promise<string> {
  if (args.runGit === defaultRunGit && !existsSync(join(args.cwd, '.git'))) return '';

  const baseRefs = [
    `${args.baseBranch}...HEAD`,
    ...(args.baseSha !== undefined && args.baseSha.trim() !== '' ? [`${args.baseSha}..HEAD`] : []),
  ];

  for (const baseRef of baseRefs) {
    const evidence = await tryReadBranchTreeStateEvidence({ ...args, baseRef });
    if (evidence !== '') return evidence;
  }
  return '';
}

async function tryReadBranchTreeStateEvidence(args: {
  runGit: GitRunner;
  cwd: string;
  baseRef: string;
}): Promise<string> {
  const [nameOnly, stat, diff] = await Promise.all([
    readTreeStateGit(args, ['diff', '--name-only', args.baseRef]),
    readTreeStateGit(args, ['diff', '--stat', args.baseRef]),
    readTreeStateGit(args, ['diff', '--unified=3', args.baseRef]),
  ]);
  const changedFiles = truncateTreeStateSection(nameOnly.trim(), TREE_STATE_FILES_MAX_CHARS);
  const diffStat = truncateTreeStateSection(stat.trim(), TREE_STATE_STAT_MAX_CHARS);
  const branchDiff = truncateTreeStateSection(diff.trim(), TREE_STATE_DIFF_MAX_CHARS);
  if (changedFiles === '' && diffStat === '' && branchDiff === '') return '';
  return [
    `Base ref: ${args.baseRef}`,
    '',
    'Changed files already present on this branch:',
    changedFiles || '(none reported)',
    '',
    'Diffstat already present on this branch:',
    diffStat || '(none reported)',
    '',
    'Branch diff excerpt already present before this task diff:',
    branchDiff || '(no diff excerpt reported)',
  ].join('\n');
}

async function readTreeStateGit(
  args: { runGit: GitRunner; cwd: string },
  gitArgs: string[],
): Promise<string> {
  try {
    return (await args.runGit(gitArgs, { cwd: args.cwd })).stdout;
  } catch {
    return '';
  }
}

function truncateTreeStateSection(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n[truncated branch tree-state evidence]`;
}

// ---------------------------------------------------------------------------
// Terminal-bug filing → canonical bugs.md
// ---------------------------------------------------------------------------

/** Persist the run's open-at-terminal findings to the CANONICAL product repo's
 *  `docs/projects/bugs.md` under `## Loop-filed`, deduped by defect signature.
 *  The I/O glue around the pure `appendTerminalBugsToBacklog`: one file-lock
 *  critical section (serialized against cockpit `+` adds on the same path),
 *  guard → read → append → atomic write → best-effort audit. Targets the live
 *  repo, never the worktree, so a non-merge run's bug survives teardown.
 *  Returns the number of bullets actually written (0 when all were duplicates). */
export async function fileTerminalBugsToBacklog(opts: {
  repoPath: string;
  product: string;
  entries: readonly OrchestrationTerminalBugEntry[];
  runGit: GitRunner;
  mutationsLogFile: string;
}): Promise<{ appended: number }> {
  if (opts.entries.length === 0) return { appended: 0 };
  const filePath = join(opts.repoPath, 'docs/projects/bugs.md');
  return withFileLock(filePath, async () => {
    assertBacklogWriteAllowed(opts.repoPath, filePath);
    const before = readFileSafe(filePath);
    const { content, appended } = appendTerminalBugsToBacklog(before, opts.entries);
    if (appended === 0) return { appended: 0 }; // every entry already filed
    // Capture pre-write git state for the audit, then write atomically.
    let branch = 'unknown';
    let dirty = false;
    try {
      branch = (await opts.runGit(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: opts.repoPath })).stdout.trim() || 'unknown';
      dirty = (await opts.runGit(['status', '--porcelain'], { cwd: opts.repoPath })).stdout.trim() !== '';
    } catch {
      // Best-effort audit metadata; a git read failure must not lose the bug.
    }
    writeFileAtomic(filePath, content);
    try {
      appendBacklogMutationLog(opts.mutationsLogFile, {
        product: opts.product,
        file: 'docs/projects/bugs.md',
        branch,
        dirty,
        before,
        after: content,
      });
    } catch (err) {
      log.warn('orchestrated-work-runner: terminal-bug audit log failed', {
        error: (err as Error).message,
      });
    }
    return { appended };
  });
}

// ---------------------------------------------------------------------------
// Durable run checkpoints + boot recovery
// ---------------------------------------------------------------------------

const ORCHESTRATED_NOTIFICATION_PUBLICATIONS_FILE = 'notification-publications.jsonl';
// Durable evidence for a failed closeout validation: the sandbox worktree is
// GC'd on a blocked run, so the failing command's output tail written here is
// the only post-mortem trace of WHICH test failed. Append-mode so a future
// closeout repair loop can record multiple attempts.
const CLOSEOUT_VALIDATION_FAILURE_FILE = 'closeout-validation-failure.txt';
export const RELATED_TEST_DIAGNOSTICS_FILE = 'related-test-diagnostics.jsonl';
const CLOSEOUT_LOG_TAIL_CHARS = 2_000;

type OrchestratedNotificationPublicationKind = 'closeout-progress' | 'merge-success';
type OrchestratedNotificationPublicationStatus = 'published' | 'skipped' | 'error';

export interface OrchestratedNotificationPublication {
  kind: OrchestratedNotificationPublicationKind;
  key: string;
  status: OrchestratedNotificationPublicationStatus;
  commitSha?: string;
  branch?: string;
  phase?: string;
  reason?: string;
  error?: string;
}

type OrchestratedNotificationPublicationInput = {
  kind: OrchestratedNotificationPublicationKind;
  key: string;
  commitSha?: string;
  branch?: string;
  phase?: string;
};

type OrchestratedNotificationPublicationErrorInput =
  OrchestratedNotificationPublicationInput & { error: string };

export function claimOrchestratedNotificationPublication(
  baseDir: string,
  runId: string,
  publication: OrchestratedNotificationPublicationInput,
): { shouldPublish: boolean; key: string } {
  const existing = readOrchestratedNotificationPublications(baseDir, runId)
    .find((record) => record.key === publication.key && record.status === 'published');
  if (existing) {
    appendOrchestratedNotificationPublication(baseDir, runId, {
      ...publication,
      status: 'skipped',
      reason: 'duplicate publication already recorded',
    });
    return { shouldPublish: false, key: publication.key };
  }

  appendOrchestratedNotificationPublication(baseDir, runId, {
    ...publication,
    status: 'published',
  });
  return { shouldPublish: true, key: publication.key };
}

export function recordOrchestratedNotificationPublicationError(
  baseDir: string,
  runId: string,
  publication: OrchestratedNotificationPublicationErrorInput,
): void {
  appendOrchestratedNotificationPublication(baseDir, runId, {
    ...publication,
    status: 'error',
  });
}

export function readOrchestratedNotificationPublications(
  baseDir: string,
  runId: string,
): OrchestratedNotificationPublication[] {
  let raw: string;
  try {
    raw = readFileSync(join(baseDir, runId, ORCHESTRATED_NOTIFICATION_PUBLICATIONS_FILE), 'utf8');
  } catch {
    return [];
  }

  const records: OrchestratedNotificationPublication[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as Partial<OrchestratedNotificationPublication>;
      if (isNotificationPublication(parsed)) {
        records.push(parsed);
      } else {
        log.warn('orchestrated notification-publications.jsonl: skipped malformed row', { runId });
      }
    } catch {
      log.warn('orchestrated notification-publications.jsonl: skipped malformed line', { runId });
    }
  }
  return records;
}

function appendOrchestratedNotificationPublication(
  baseDir: string,
  runId: string,
  publication: OrchestratedNotificationPublication,
): void {
  const dir = join(baseDir, runId);
  mkdirSync(dir, { recursive: true });
  appendFileSync(
    join(dir, ORCHESTRATED_NOTIFICATION_PUBLICATIONS_FILE),
    JSON.stringify(publication) + '\n',
    'utf8',
  );
}

function isNotificationPublication(
  value: Partial<OrchestratedNotificationPublication>,
): value is OrchestratedNotificationPublication {
  return (
    (value.kind === 'closeout-progress' || value.kind === 'merge-success') &&
    typeof value.key === 'string' &&
    (value.status === 'published' || value.status === 'skipped' || value.status === 'error') &&
    (value.commitSha === undefined || typeof value.commitSha === 'string') &&
    (value.branch === undefined || typeof value.branch === 'string') &&
    (value.phase === undefined || typeof value.phase === 'string') &&
    (value.reason === undefined || typeof value.reason === 'string') &&
    (value.error === undefined || typeof value.error === 'string')
  );
}

export async function recoverOrchestratedWorkRuns(
  deps: OrchestratedWorkRecoveryDeps,
): Promise<OrchestratedWorkRecoveryResult> {
  const result: OrchestratedWorkRecoveryResult = { resumed: [], orphaned: [], skipped: [] };
  const mutations = await deps.readRunningOrchestratedMutations();

  for (const mutation of mutations) {
    if (mutation.kind !== 'orchestrated-work' || mutation.status !== 'running') {
      result.skipped.push(mutation.id);
      continue;
    }

    let leaseAcquired = false;
    if (deps.acquireRecoveryLease) {
      leaseAcquired = await deps.acquireRecoveryLease(mutation.id);
      if (!leaseAcquired) {
        result.skipped.push(mutation.id);
        continue;
      }
    }

    try {
      const preflight = await deps.preflightRecovery(mutation);
      if (preflight.kind === 'not-resumable') {
        await deps.markOrphaned(mutation, preflight.reason);
        result.orphaned.push(mutation.id);
        continue;
      }
      try {
        const { cursor, reconstruction } = preflight;

        await deps.redispatchOrchestratedMutation(mutation, {
          branch: cursor.branch,
          baseBranch: cursor.baseBranch,
          worktreePath: cursor.worktreePath,
          reconstruction,
          resumeFromTaskId: reconstruction.nextTask?.id ?? null,
          existingBranch: true,
        });
        result.resumed.push(mutation.id);
      } catch (err) {
        await deps.markOrphaned(mutation, (err as Error).message);
        result.orphaned.push(mutation.id);
      }
    } finally {
      if (leaseAcquired) {
        await deps.releaseRecoveryLease?.(mutation.id);
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// The applier
// ---------------------------------------------------------------------------

export const orchestratedWorkApplier: MutationApplier<OrchestratedWorkPayload> = {
  kind: 'orchestrated-work',
  autoApprove: true,

  validate(payload: OrchestratedWorkPayload): { ok: true } | { ok: false; reason: string } {
    const { projectSlug } = payload;
    if (!projectSlug || typeof projectSlug !== 'string') {
      return { ok: false, reason: 'projectSlug is required' };
    }
    if (!VALID_SLUG.test(projectSlug)) {
      return { ok: false, reason: `invalid projectSlug: ${projectSlug}` };
    }
    if (payload.product !== undefined && !VALID_SLUG.test(payload.product)) {
      return { ok: false, reason: `invalid product: ${payload.product}` };
    }
    const project = resolveLiveWorkProject({
      projectSlug,
      product: payload.product,
      productsConfigPath: config.PRODUCTS_CONFIG_FILE,
      fallbackRoot: PROJECT_ROOT,
    });
    if (!project.ok) return project;
    const dir = project.projectDir;
    if (!existsSync(join(dir, 'spec.md'))) {
      return { ok: false, reason: `spec.md missing for project: ${projectSlug}` };
    }
    // Per-project + global concurrency caps (shared with the legacy work-run
    // applier — the two never run the same project concurrently because they
    // share the deterministic per-project worktree path).
    const product = payload.product ?? 'rune';
    const runningForSlug = [...activeRuns.values()].filter(
      (h) =>
        (h.descriptor.kind === 'orchestrated-work' || h.descriptor.kind === 'work-run') &&
        (h.descriptor.payload as OrchestratedWorkPayload).projectSlug === projectSlug &&
        ((h.descriptor.payload as OrchestratedWorkPayload).product ?? 'rune') === product &&
        h.descriptor.status === 'running',
    );
    if (runningForSlug.length >= config.WORK_RUN_PER_PROJECT_CAP) {
      return { ok: false, reason: `already running for ${projectSlug}` };
    }
    const globalRunning = [...activeRuns.values()].filter(
      (h) => h.descriptor.kind === 'orchestrated-work' || h.descriptor.kind === 'work-run',
    );
    if (globalRunning.length >= config.WORK_RUN_GLOBAL_CAP) {
      return { ok: false, reason: 'global work-run cap reached' };
    }
    return { ok: true };
  },

  async *apply(
    descriptor: MutationDescriptor<OrchestratedWorkPayload>,
    ctx: ApplyContext,
  ): AsyncIterable<MutationEvent> {
    const { projectSlug } = descriptor.payload;
    const product = descriptor.payload.product ?? 'rune';
    const deps = runtimeDeps;
    const recovery = recoveryRedispatchOptions.get(descriptor);
    recoveryRedispatchOptions.delete(descriptor);
    const branch = recovery?.branch ?? workBranchName(projectSlug);
    let terminalStatePersisted = false;
    const persistTerminalStateOnce = (terminal: MutationEvent): void => {
      if (terminalStatePersisted) return;
      persistTerminalMutationState(descriptor, terminal);
      terminalStatePersisted = true;
    };

    if (ctx.cancel()) {
      const cancelReason = ctx.cancelReason?.() ?? 'user';
      const cancelSource = ctx.cancelSource?.() ?? (cancelReason === 'user' ? 'user' : 'system');
      const trigger: ExecutionTerminalTrigger = {
        kind: 'cancellation',
        reason: 'cancelled before start',
        cancellationSource: cancelSource,
      };
      const terminal = term(descriptor.id, cancelReason === 'user' ? 'failed' : 'completed', {
        reason: trigger.reason,
        cancelReason,
        cancelSource,
        projectSlug,
        product,
        trigger,
        disposition: {
          kind: 'removed',
          reason: 'no worktree was created',
        } satisfies ExecutionTerminalDisposition,
      });
      persistTerminalStateOnce(terminal);
      yield terminal;
      return;
    }

    let sandbox: SandboxSpec | null = null;
    const terminalization = new TerminalizationCoordinator();
    let dispositionBaseBranch = recovery?.baseBranch ?? 'main';
    let sink: TranscriptSink | null = null;
    const startedAtMs = Date.now();
    const prepareTerminalDisposition = async (terminal: MutationEvent): Promise<MutationEvent> => {
      if (!sandbox || terminalization.dispositionResolved) return terminal;
      if (isExecutionTerminalDisposition(((terminal.data ?? {}) as Record<string, unknown>)['disposition'])) {
        terminalization.markDispositionResolved(
          ((terminal.data ?? {}) as Record<string, unknown>)['disposition'] as ExecutionTerminalDisposition,
        );
        return terminal;
      }
      if (
        isMutationRecoveryHandoff(descriptor.id) ||
        isMutationShutdownInProgress() ||
        terminalization.preserveWorktree ||
        terminalization.finalizerOwnsTeardown
      ) {
        const terminalData = (terminal.data ?? {}) as Record<string, unknown>;
        const alreadyParked = terminalData['parked'] === true;
        const contextFailure = terminalData['contextFailure'];
        const checkpoint = contextFailure && typeof contextFailure === 'object'
          ? (contextFailure as Record<string, unknown>)['checkpoint']
          : undefined;
        const wipSha = checkpoint && typeof checkpoint === 'object' &&
            (checkpoint as Record<string, unknown>)['kind'] === 'committed' &&
            typeof (checkpoint as Record<string, unknown>)['sha'] === 'string'
          ? String((checkpoint as Record<string, unknown>)['sha'])
          : undefined;
        const disposition: ExecutionTerminalDisposition = {
          kind: alreadyParked ? 'parked' : 'preserved',
          reason: alreadyParked
            ? 'worktree parked by orchestration result'
            : contextFailure !== undefined
              ? 'worktree preserved after context closeout failure'
            : terminalization.finalizerOwnsTeardown
            ? 'terminal worktree lifecycle owned by finalizer'
            : isMutationShutdownInProgress()
              ? 'worktree preserved for shutdown recovery'
              : 'worktree preserved by orchestration result',
          ...(wipSha !== undefined ? { wipSha } : {}),
        };
        terminalization.markDispositionResolved(disposition);
        return withTerminalDisposition(terminal, disposition);
      }
      const disposition = await disposeTerminalWorktree({
        deps,
        descriptor,
        sandbox,
        branch,
        baseBranch: dispositionBaseBranch,
      });
      terminalization.markDispositionResolved(disposition);
      return withTerminalDisposition(terminal, disposition, sandbox, branch, dispositionBaseBranch);
    };
    try {
      try {
        if (recovery) {
          let egressAllowlist: string[] = [];
          try {
            egressAllowlist = getProductConfig(product, config.PRODUCTS_CONFIG_FILE).egressAllowlist;
          } catch {
            /* keep recovery best-effort if products.json is temporarily unreadable */
          }
          sandbox = {
            product,
            project: projectSlug,
            worktree: recovery.worktreePath,
            egressAllowlist,
            resumed: true,
          };
          // Restart salvage (bugs.md restart safety 2/2): the interrupted task
          // may have left uncommitted work in the reused worktree. Commit it as
          // a labeled salvage commit so the re-run task starts from a clean
          // tree and closeout's `git add -A` cannot silently absorb stale dirt
          // — the half-work stays inspectable on the branch instead. Best-effort.
          const salvageSha = await commitWorktreeWip(deps.runGit, recovery.worktreePath, {
            message: `rune(${product}): WIP — restart salvage — ${projectSlug}`,
            logLabel: 'restart salvage commit',
            product,
            projectSlug,
          });
          if (salvageSha !== null) {
            log.info('orchestrated-work-runner: salvaged uncommitted work from interrupted run', {
              id: descriptor.id,
              project: projectSlug,
              sha: salvageSha,
            });
          }
        } else {
          sandbox = await deps.createWorktree({
            product,
            project: projectSlug,
            branch,
            worktreeRoot: config.WORKTREE_ROOT,
            productsConfigPath: config.PRODUCTS_CONFIG_FILE,
          });
        }
      } catch (err) {
        const detail = (err as Error).message;
        log.error('orchestrated-work-runner: worktree provisioning failed', {
          id: descriptor.id,
          product,
          project: projectSlug,
          error: detail,
        });
        const terminal = await prepareTerminalDisposition(term(descriptor.id, 'failed', {
          reason: scrubAbsolutePaths(worktreeProvisioningTerminalReason(detail)),
          projectSlug,
          product,
        }));
        persistTerminalStateOnce(terminal);
        yield terminal;
        return;
      }

      let productConfig;
      try {
        productConfig = getProductConfig(product, config.PRODUCTS_CONFIG_FILE);
      } catch (err) {
        log.error('orchestrated-work-runner: provisioning config verification failed', {
          id: descriptor.id,
          product,
          project: projectSlug,
          error: (err as Error).message,
        });
        const terminal = await prepareTerminalDisposition(term(descriptor.id, 'failed', {
          reason: 'worktree provisioning failed: product-config',
          projectSlug,
          product,
        }));
        persistTerminalStateOnce(terminal);
        yield terminal;
        return;
      }
      const provisioning = await deps.verifyWorktree({
        repoPath: productConfig.repoPath,
        worktree: sandbox.worktree,
        expectedBranch: branch,
        project: projectSlug,
        runGit: deps.runGit,
      });
      if (!provisioning.ok) {
        log.error('orchestrated-work-runner: worktree pre-dispatch verification failed', {
          id: descriptor.id,
          product,
          project: projectSlug,
          worktree: sandbox.worktree,
          stage: provisioning.stage,
          error: provisioning.cause.message,
        });
        const terminal = await prepareTerminalDisposition(term(descriptor.id, 'failed', {
          reason: `worktree provisioning failed: ${provisioning.stage}`,
          projectSlug,
          product,
        }));
        persistTerminalStateOnce(terminal);
        yield terminal;
        return;
      }
      const projectDir = provisioning.projectDir!;
      const runSandbox = sandbox;
      const baselineTasks = provisioning.tasksContent!;

      let baseBranch = 'main';
      let repoPath = runSandbox.worktree;
      let validationCommands: string[] = [];
      let validationCommandProfiles: ValidationCommandProfile[] = [];
      let validationAdapters: ValidationAdapter[] = [];
      let validationCwd: string | undefined;
      let closeoutValidationStrategy: CloseoutValidationStrategy = 'product-commands';
      try {
        baseBranch = productConfig.baseBranch;
        repoPath = productConfig.repoPath;
        validationCommands = productConfig.validationCommands ?? [];
        validationCommandProfiles = productConfig.validationCommandProfiles ?? [];
        validationAdapters = productConfig.validationAdapters ?? [];
        validationCwd = productConfig.validationCwd;
        closeoutValidationStrategy = productConfig.closeoutValidationStrategy ?? 'product-commands';
      } catch (err) {
        if ((err as Error).message.includes('invalid closeoutValidationStrategy')) {
          const terminal = await prepareTerminalDisposition(term(descriptor.id, 'failed', {
            reason: scrubPathsInText(`product config invalid: ${(err as Error).message}`),
            projectSlug,
            product,
          }));
          persistTerminalStateOnce(terminal);
          yield terminal;
          return;
        }
        /* default to main if products.json is unreadable */
      }
      if (recovery) {
        baseBranch = recovery.baseBranch;
      }
      dispositionBaseBranch = baseBranch;

      try {
        sink = deps.createSink(descriptor.id, deps.workRunsDir);
      } catch (err) {
        log.warn('orchestrated-work-runner: transcript sink creation failed; run continues without a durable transcript', {
          id: descriptor.id,
          error: (err as Error).message,
        });
        sink = null;
      }

      yield { mutationId: descriptor.id, ts: new Date().toISOString(), kind: 'log', data: { line: `orchestrated run starting for ${projectSlug}` } };

      const streamedEvents: MutationEvent[] = [];
      let wakeStream: (() => void) | undefined;
      const enqueue = (event: MutationEvent): void => {
        streamedEvents.push(event);
        wakeStream?.();
        wakeStream = undefined;
      };
      let finalizerTerminal: MutationEvent | null = null;
      let finalizerDisposition: ExecutionTerminalDisposition | null = null;
      let gateHeldReason: GateFailReason | null = null;
      let gateValidationReceipt: import('./work-run-gate.js').GateValidationReceipt | undefined;
      const orchestrationDeps = buildOrchestrationDeps({
        descriptor,
        sandbox: runSandbox,
        projectDir,
        product,
        projectSlug,
        branch,
        baseBranch: recovery?.baseBranch ?? baseBranch,
        validationCommands,
        validationCommandProfiles,
        validationAdapters,
        ...(validationCwd !== undefined ? { validationCwd } : {}),
        closeoutValidationStrategy,
        workRunsDir: deps.workRunsDir,
        runGit: deps.runGit,
        runCanonicalGit: deps.runCanonicalGit,
        captureTaskBaseTree: deps.captureTaskBaseTree,
        runValidationCommandArgv: deps.runValidationCommandArgv,
        runValidationCommands: deps.runValidationCommands,
        runFullSuiteValidation: deps.runFullSuiteValidation,
        createTaskWorkflowRunner: deps.createTaskWorkflowRunner,
        cancel: ctx.cancel,
        cancelReason: ctx.cancelReason,
        cancelSource: ctx.cancelSource,
        supersedeSystemCancellation: ctx.supersedeSystemCancellation,
        publishAgents: (records) => {
          ctx.bus.publish(buildRunAgentsEventFromTaskRecords({
            runId: descriptor.id,
            product,
            target: { kind: 'project', slug: projectSlug },
            ts: new Date().toISOString(),
            userId: config.TELEGRAM_USER_ID,
            records,
          }));
        },
        emit: (event) => {
          const mutationEvent = toMutationEvent(descriptor.id, event);
          if (!shouldPublishCloseoutProgress(deps.workRunsDir, descriptor.id, mutationEvent)) return;
          enqueue(mutationEvent);
        },
        finalize: async (handoff) => {
          const relatedTestDiagnostics =
            collectRelatedTestTaskDiagnostics(handoff.taskRecords);
          const relatedTestDiagnostic =
            relatedTestDiagnostics.at(-1)?.diagnostic;
          let gateTasksRemaining = 0;
          let endedAt = '';
          const integrationWorktree = deps.integrationWorktree(product, descriptor.id);
          const exit = (): ExitFacts => ({
            exitCode: 0,
            signal: null,
            cancelled: false,
            durationMs: Date.now() - startedAtMs,
            exitFact: 'clean-exit',
          });
          const hasConcurrentRun = (): boolean =>
            [...activeRuns.values()].some(
              (h) =>
                (h.descriptor.kind === 'orchestrated-work' || h.descriptor.kind === 'work-run') &&
                h.descriptor.id !== descriptor.id &&
                ((h.descriptor.payload as OrchestratedWorkPayload).product ?? 'rune') === product &&
                h.descriptor.status === 'running',
            );

          const effects: FinalizerEffects = {
            classify: async () => {
              const terminalEvent = await finalizeWorkRun({
                mutationId: descriptor.id,
                computeFacts: async () => {
                  const workProduct = await computeOrchestratedWorkProduct({
                    deps,
                    descriptor,
                    sandbox: runSandbox,
                    branch,
                    projectDir,
                    baselineTasks,
                  });
                  if (!workProduct) throw new Error('orchestrated work product unavailable');
                  return { exit: exit(), product: workProduct };
                },
                exportForensics: async () => {},
              });
              const data = (terminalEvent.data ?? {}) as Record<string, unknown>;
              data['projectSlug'] = projectSlug;
              data['product'] = product;
              data['dispatchMode'] = 'orchestrated';
              data['baseBranch'] = baseBranch;
              if (relatedTestDiagnostics.length > 0) {
                data['relatedTestDiagnostics'] = relatedTestDiagnostics;
                data['relatedTestDiagnostic'] = relatedTestDiagnostic;
              }
              terminalEvent.data = data;
              const workProduct = data['workProduct'] as WorkProductFacts | undefined;
              gateTasksRemaining = workProduct?.transitions.tasksRemaining ?? 0;
              endedAt = new Date().toISOString();
              return terminalEvent;
            },
            flushTranscript: async () => {
              if (!sink) return;
              try {
                await sink.flush();
                terminalization.markTranscriptFlushed();
              } catch (err) {
                log.warn('orchestrated-work-runner: transcript flush failed', {
                  id: descriptor.id,
                  error: (err as Error).message,
                });
              }
            },
            writeSummary: (event) => {
              const summary = buildOrchestratedSummary({
                id: descriptor.id,
                project: projectSlug,
                product,
                target: runTargetFromDescriptor(descriptor),
                branch,
                baseSha: runSandbox.baseSha ?? '',
                startedAtMs,
                endedAt: endedAt || new Date().toISOString(),
                terminal: event,
                sink,
                workRunsDir: deps.workRunsDir,
                workProduct: terminalWorkProduct(event),
                result: {
                  kind: 'finalized',
                  outcome: readOutcome(event),
                  ...(relatedTestDiagnostics.length > 0
                    ? { relatedTestDiagnostics }
                    : {}),
                },
              });
              try {
                deps.writeSummary(join(deps.workRunsDir, descriptor.id), summary);
              } catch (err) {
                log.warn('orchestrated-work-runner: writeSummary failed', {
                  id: descriptor.id,
                  error: (err as Error).message,
                });
              }
            },
            appendIndexRow: (event) => {
              try {
                const finishedAt = endedAt || new Date().toISOString();
                deps.appendIndexRow(deps.workRunsIndexFile, {
                  id: descriptor.id,
                  project: projectSlug,
                  outcome: readOutcome(event),
                  durationMs: Date.parse(finishedAt) - startedAtMs,
                  startedAt: new Date(startedAtMs).toISOString(),
                  endedAt: finishedAt,
                });
              } catch (err) {
                log.warn('orchestrated-work-runner: appendIndexRow failed', {
                  id: descriptor.id,
                  error: (err as Error).message,
                });
              }
            },
            ...(existsSync(join(runSandbox.worktree, 'docs', 'projects', 'index.md'))
              ? {
                  markProjectDone: (input) =>
                    markProjectDoneOnBranch({
                      worktreePath: runSandbox.worktree,
                      project: input.project,
                    }),
                }
              : {}),
            writeSupervisionTerminal: (_status, terminalEvent) => {
              // The finalizer reports its trigger before teardown has settled.
              // Capture it here; the outer terminalization boundary persists
              // once the final disposition is known.
              finalizerTerminal = finalizerDisposition === null
                ? terminalEvent
                : withTerminalDisposition(
                    terminalEvent,
                    finalizerDisposition,
                    runSandbox,
                    branch,
                    baseBranch,
                  );
            },
            removeWorktree: async () => {
              const disposition = await disposeTerminalWorktree({
                deps,
                descriptor,
                sandbox: runSandbox,
                branch,
                baseBranch,
              });
              terminalization.markDispositionResolved(disposition);
              if (disposition.kind === 'removed') {
                terminalization.markFinalizerTeardown();
                finalizerDisposition = disposition;
                return;
              }
              finalizerDisposition = disposition;
              throw new Error('worktree teardown deferred for preservation');
            },
            recordPhase: (phase) => deps.recordWorkRunPhase?.(descriptor.id, phase),
            readLastPhase: () => deps.readLastWorkRunPhase?.(descriptor.id) ?? null,
            recordGateValidationReceipt: (receipt) =>
              writeGateValidationReceipt(deps.workRunsDir, descriptor.id, receipt),
            gate: () =>
              withBaseBranchLock(product, baseBranch, async () => {
                const verdict = await deps.runGate({
                  product,
                  repoPath,
                  baseBranch,
                  branch,
                  integrationWorktree,
                  validationCommands,
                  validationCommandProfiles,
                  validationAdapters,
                  ...(validationCwd !== undefined ? { validationCwd } : {}),
                  tasksRemaining: gateTasksRemaining,
                  concurrentRun: hasConcurrentRun(),
                  commandTimeoutMs: config.WORK_RUN_GATE_COMMAND_TIMEOUT_MS,
                  validationArtifactsDir: join(deps.workRunsDir, descriptor.id, 'validation-diagnostics'),
                  cancelled: ctx.cancel,
                });
                gateValidationReceipt = verdict.validationReceipt;
                return verdict;
              }),
            cancelled: ctx.cancel,
            alert: (reason) => {
              gateHeldReason = reason;
              log.warn('orchestrated run held at branch-complete: gate failed', {
                id: descriptor.id,
                projectSlug,
                product,
                branch,
                reason,
              });
            },
            mergeBranch: async () => {
              const message = `rune(${product}): merge orchestrated branch ${branch}`;
              try {
                await deps.runGit(['merge', '--no-ff', branch, '-m', message], { cwd: repoPath });
              } catch (err) {
                throw new Error(redactSecrets(`git merge failed: ${(err as Error).message}`));
              }
            },
            abortMerge: async () => {
              await deps.runGit(['merge', '--abort'], { cwd: repoPath });
            },
            pushBranch: async () => {
              try {
                await deps.runGit(['push', 'origin', baseBranch], { cwd: repoPath });
              } catch (err) {
                log.warn('orchestrated-work-runner: git push failed after local merge', {
                  product,
                  branch,
                  error: redactSecrets((err as Error).message),
                });
                throw new Error(redactSecrets(`git push failed: ${(err as Error).message}`));
              }
            },
            deleteBranch: async () => {
              await deps.runGit(['branch', '-d', branch], { cwd: repoPath });
            },
            readNotificationPublication: (key) =>
              readOrchestratedNotificationPublications(deps.workRunsDir, descriptor.id)
                .find((record) => record.key === key) ?? null,
            recordNotificationPublication: (record) => {
              if (record.status === 'error') {
                recordOrchestratedNotificationPublicationError(deps.workRunsDir, descriptor.id, {
                  kind: record.kind,
                  key: record.key,
                  error: record.error ?? 'unknown notification publication error',
                  ...(record.commitSha !== undefined ? { commitSha: record.commitSha } : {}),
                  ...(record.branch !== undefined ? { branch: record.branch } : {}),
                  ...(record.phase !== undefined ? { phase: record.phase } : {}),
                });
                return;
              }
              appendOrchestratedNotificationPublication(deps.workRunsDir, descriptor.id, {
                kind: record.kind,
                key: record.key,
                status: record.status,
                ...(record.commitSha !== undefined ? { commitSha: record.commitSha } : {}),
                ...(record.branch !== undefined ? { branch: record.branch } : {}),
                ...(record.phase !== undefined ? { phase: record.phase } : {}),
                ...(record.reason !== undefined ? { reason: record.reason } : {}),
              });
            },
            onLanded: (notification) => {
              refreshRegistryAfterLanding(deps, {
                runId: descriptor.id,
                projectSlug,
                product,
              });
              enqueue({
                mutationId: descriptor.id,
                ts: new Date().toISOString(),
                kind: 'progress',
                data: notification ?? {
                  event: 'merge-success',
                  runId: descriptor.id,
                  projectSlug,
                  product,
                  branch,
                  baseBranch,
                },
              });
            },
          };

          const finalizerResult = await runFinalizer(
            { mode: 'gated-merge', runId: descriptor.id, project: projectSlug, product, branch, baseBranch },
            effects,
          );
          const data = (finalizerResult.terminalEvent.data ?? {}) as Record<string, unknown>;
          data['projectSlug'] = projectSlug;
          data['product'] = product;
          data['dispatchMode'] = 'orchestrated';
          if (relatedTestDiagnostics.length > 0) {
            data['relatedTestDiagnostics'] = relatedTestDiagnostics;
            data['relatedTestDiagnostic'] = relatedTestDiagnostic;
          }
          if (gateValidationReceipt !== undefined) {
            data['gateValidationReceipt'] = gateValidationReceipt;
          }
          if (readOutcome(finalizerResult.terminalEvent) === 'branch-complete') {
            data['merged'] = finalizerResult.merged;
            data['branchDeleted'] = finalizerResult.branchDeleted;
            data['baseBranch'] = baseBranch;
            if (!finalizerResult.merged && gateHeldReason) data['gateHeldReason'] = gateHeldReason;
          }
          finalizerResult.terminalEvent.data = data;
          finalizerTerminal = finalizerDisposition === null
            ? finalizerResult.terminalEvent
            : withTerminalDisposition(finalizerResult.terminalEvent, finalizerDisposition, runSandbox, branch, baseBranch);
          return {
            kind: 'finalized',
            outcome: readOutcome(finalizerResult.terminalEvent),
            ...(relatedTestDiagnostics.length > 0
              ? { relatedTestDiagnostics }
              : {}),
          };
        },
      });

      const orchestration = deps.runOrchestration(orchestrationDeps).then(
        (result) => ({ kind: 'result' as const, result }),
        (error: unknown) => ({ kind: 'error' as const, error }),
      );
      // Child-liveness parity with work-runner: role sessions can be alive
      // while producing no output, so emit keep-alive without faking activity.
      const keepAliveTicker = setInterval(() => {
        enqueue({
          mutationId: descriptor.id,
          ts: new Date().toISOString(),
          kind: 'keep-alive',
          data: {},
        });
      }, 30_000);
      keepAliveTicker.unref();
      const unsubscribeCancel = ctx.onCancel?.(() => {
        enqueue({
          mutationId: descriptor.id,
          ts: new Date().toISOString(),
          kind: 'activity',
          data: {
            event: 'cancel-requested',
            line: 'cancellation requested; stopping at next orchestration boundary',
          },
        });
      });

      let outcome: Awaited<typeof orchestration> | undefined;
      try {
        while (outcome === undefined) {
          const event = streamedEvents.shift();
          if (event !== undefined) {
            await persistTranscriptEvent(sink, event);
            yield event;
            continue;
          }

          const nextStream = new Promise<{ kind: 'stream' }>((resolve) => {
            wakeStream = () => resolve({ kind: 'stream' });
          });
          const next = await Promise.race([orchestration, nextStream]);
          wakeStream = undefined;
          if (next.kind === 'stream') continue;
          outcome = next;
        }
      } finally {
        unsubscribeCancel?.();
        clearInterval(keepAliveTicker);
      }

      for (const event of streamedEvents.splice(0)) {
        await persistTranscriptEvent(sink, event);
        yield event;
      }
      if (outcome.kind === 'error') {
        const checkpoint = readOrchestratedRunCursor(deps.workRunsDir, descriptor.id)?.executionCheckpoint;
        const executionFailure = checkpoint === undefined
          ? undefined
          : adjacentExecutionFailure(checkpoint, outcome.error);
        const terminal = await prepareTerminalDisposition(term(descriptor.id, 'failed', {
          reason: executionFailure === undefined
            ? scrubPathsInText(`orchestration loop threw: ${(outcome.error as Error).message}`)
            : executionFailureSummary(executionFailure),
          ...(executionFailure !== undefined ? { executionFailure } : {}),
          projectSlug,
          product,
        }));
        await persistTerminalArtifacts({
          deps,
          sink,
          descriptor,
          terminal,
          startedAtMs,
          projectSlug,
          product,
          branch,
          sandbox,
          projectDir,
          baselineTasks,
          result: null,
        });
        persistTerminalStateOnce(terminal);
        terminalization.markTerminalPersisted();
        yield terminal;
        return;
      }

      const result = outcome.result;
      if (
        (result.kind === 'blocked' && result.parked?.preserveWorktree === true) ||
        (result.kind === 'held' && result.preserveWorktree === true)
      ) {
        terminalization.requestPreservation();
      }
      const terminal = await prepareTerminalDisposition(
        finalizerTerminal ?? mapResultToTerminal(descriptor.id, result, projectSlug, product, baseBranch),
      );
      await persistTerminalArtifacts({
        deps,
        sink,
        descriptor,
        terminal,
        startedAtMs,
        projectSlug,
        product,
        branch,
        sandbox,
        projectDir,
        baselineTasks,
        result,
      });
      persistTerminalStateOnce(terminal);
      terminalization.markTerminalPersisted();
      yield terminal;
    } finally {
      sink?.destroy();
      if (sandbox && isMutationRecoveryHandoff(descriptor.id)) {
        log.info('orchestrated-work-runner: recovery handoff; preserving worktree until redispatch', {
          id: descriptor.id,
          sandbox: sandbox.worktree,
        });
      } else if (sandbox && isMutationShutdownInProgress()) {
        // Shutdown suppression: the worktree may hold the in-flight task's
        // uncommitted diff — the shutdown parker WIP-commits and preserves it
        // (or boot recovery resumes it). Destroying it here would discard the
        // exact work the park exists to save.
        log.info('orchestrated-work-runner: shutdown in progress; leaving worktree for parker/boot recovery', {
          sandbox: sandbox.worktree,
        });
      } else if (
        sandbox &&
        !terminalization.dispositionResolved &&
        !terminalization.preserveWorktree &&
        !terminalization.finalizerOwnsTeardown
      ) {
        const disposition = await disposeTerminalWorktree({
          deps,
          descriptor,
          sandbox,
          branch,
          baseBranch: dispositionBaseBranch,
        });
        if (disposition.kind === 'parked') {
          // Unexpected throws have no normal terminal construction point. Keep
          // the fail-closed worktree visible through the recovery writer.
          const checkpoint = readOrchestratedRunCursor(deps.workRunsDir, descriptor.id)?.executionCheckpoint;
          const failure = checkpoint === undefined ? undefined : adjacentExecutionFailure(
            checkpoint,
            'orchestration runner threw outside its terminal boundary',
          );
          const terminal = withTerminalDisposition(term(descriptor.id, 'failed', {
            projectSlug,
            product,
            reason: failure ? executionFailureSummary(failure) : 'orchestration runner threw',
            ...(failure ? { executionFailure: failure } : {}),
          }), disposition, sandbox, branch, dispositionBaseBranch);
          deps.writeRecoveredTerminal(descriptor, terminal);
        }
      } else if (sandbox && terminalization.preserveWorktree) {
        log.info('orchestrated-work-runner: preserving parked worktree', {
          sandbox: sandbox.worktree,
        });
      }
    }
  },
};

function createOrchestratedTranscriptSink(runId: string, baseDir: string): TranscriptSink {
  const sink = createTranscriptSink({ runId, baseDir }) as TranscriptSink | undefined;
  return sink ?? createFallbackTranscriptSink(runId, baseDir);
}

function createFallbackTranscriptSink(runId: string, baseDir: string): TranscriptSink {
  if (!VALID_SLUG.test(runId)) {
    throw new Error(`createFallbackTranscriptSink: invalid runId (must be a slug): ${runId}`);
  }
  const dir = join(baseDir, runId);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'transcript.jsonl');
  let destroyed = false;
  return {
    path,
    append(event: unknown): Promise<void> {
      if (destroyed) return Promise.reject(new Error('createFallbackTranscriptSink: append after destroy'));
      appendFileSync(path, redactSecrets(JSON.stringify(event)) + '\n', 'utf8');
      return Promise.resolve();
    },
    flush(): Promise<void> {
      if (destroyed) return Promise.reject(new Error('createFallbackTranscriptSink: flush after destroy'));
      return Promise.resolve();
    },
    finish(): Promise<void> {
      if (destroyed) return Promise.reject(new Error('createFallbackTranscriptSink: finish after destroy'));
      return Promise.resolve();
    },
    destroy(): void {
      destroyed = true;
    },
  };
}

async function persistTranscriptEvent(sink: TranscriptSink | null, event: MutationEvent): Promise<void> {
  if (!sink || (event.kind !== 'activity' && event.kind !== 'output')) return;
  try {
    await sink.append(event);
  } catch (err) {
    log.warn('orchestrated-work-runner: transcript append failed', {
      id: event.mutationId,
      error: (err as Error).message,
    });
  }
}

async function persistTerminalArtifacts(args: {
  deps: OrchestratedRuntimeDeps;
  sink: TranscriptSink | null;
  descriptor: MutationDescriptor<OrchestratedWorkPayload>;
  terminal: MutationEvent;
  startedAtMs: number;
  projectSlug: string;
  product: string;
  branch: string;
  sandbox: SandboxSpec;
  projectDir: string;
  baselineTasks: string;
  result: OrchestrationResult | null;
}): Promise<void> {
  const {
    deps,
    sink,
    descriptor,
    terminal,
    startedAtMs,
    projectSlug,
    product,
    branch,
    sandbox,
    projectDir,
    baselineTasks,
    result,
  } = args;
  if (sink) {
    try {
      const data = (terminal.data ?? {}) as Record<string, unknown>;
      const trigger = isExecutionTerminalTrigger(data['trigger']) ? data['trigger'] : undefined;
      const disposition = isExecutionTerminalDisposition(data['disposition']) ? data['disposition'] : undefined;
      const gateValidationReceipt = isGateValidationReceipt(data['gateValidationReceipt'])
        ? data['gateValidationReceipt']
        : undefined;
      const terminalFactEvent = {
        mutationId: descriptor.id,
        ts: terminal.ts,
        kind: 'activity',
        data: {
          event: 'terminal-facts',
          ...(trigger !== undefined ? { trigger } : {}),
          ...(disposition !== undefined ? { disposition } : {}),
          ...(gateValidationReceipt !== undefined ? { gateValidationReceipt } : {}),
          line: [
            trigger ? `terminal ${trigger.kind}: ${trigger.reason}` : '',
            disposition ? `disposition ${disposition.kind}: ${disposition.reason}` : '',
            gateValidationReceipt
              ? `merge validation ${gateValidationReceipt.outcome} (${gateValidationReceipt.commands.length} commands)`
              : '',
          ].filter(Boolean).join(' · '),
        },
      };
      if (
        trigger !== undefined ||
        disposition !== undefined ||
        gateValidationReceipt !== undefined
      ) {
        await sink.append(terminalFactEvent);
      }
      await sink.finish();
    } catch (err) {
      log.warn('orchestrated-work-runner: transcript flush failed', {
        id: descriptor.id,
        error: (err as Error).message,
      });
    }
  }

  const endedAt = new Date().toISOString();
  const computedWorkProduct = await computeOrchestratedWorkProduct({
    deps,
    descriptor,
    sandbox,
    branch,
    projectDir,
    baselineTasks,
  });
  const workProduct = terminalWorkProduct(terminal) ?? computedWorkProduct;
  normalizeLateErrorTerminalFromWorkProduct(terminal, workProduct, result);
  const summary = buildOrchestratedSummary({
    id: descriptor.id,
    project: projectSlug,
    product,
    target: runTargetFromDescriptor(descriptor),
    branch,
    baseSha: sandbox.baseSha ?? '',
    startedAtMs,
    endedAt,
    terminal,
    sink,
    workRunsDir: deps.workRunsDir,
    workProduct,
    result,
  });
  // Backfill the terminal bus event with the outcome + work-product the summary
  // recorded, so the Telegram formatter renders the real outcome instead of the
  // "completed (no outcome recorded)" fallback (or the legacy generic
  // "/work --auto … finished"). Only the `finalized` branch of
  // mapResultToTerminal already carries these — held/parked/blocked/partial
  // terminals did not. FILL-MISSING only: the finalizer's own workProduct
  // (with the project-marked-done commit) is authoritative and must not be
  // clobbered by the recomputed summary view.
  const existingTerminalData = (terminal.data ?? {}) as Record<string, unknown>;
  terminal.data = {
    ...existingTerminalData,
    outcome: existingTerminalData['outcome'] ?? summary.outcome,
    workProduct: existingTerminalData['workProduct'] ?? summary.workProduct,
  };
  try {
    deps.writeSummary(join(deps.workRunsDir, descriptor.id), summary);
  } catch (err) {
    log.warn('orchestrated-work-runner: writeSummary failed', {
      id: descriptor.id,
      error: (err as Error).message,
    });
  }
  if (result?.kind !== 'finalized') {
    try {
      deps.appendIndexRow(deps.workRunsIndexFile, {
        id: descriptor.id,
        project: projectSlug,
        outcome: summary.outcome,
        durationMs: Date.parse(endedAt) - startedAtMs,
        startedAt: new Date(startedAtMs).toISOString(),
        endedAt,
      });
    } catch (err) {
      log.warn('orchestrated-work-runner: appendIndexRow failed', {
        id: descriptor.id,
        error: (err as Error).message,
      });
    }
  }
}

function normalizeLateErrorTerminalFromWorkProduct(
  terminal: MutationEvent,
  workProduct: WorkProductFacts | null,
  result: OrchestrationResult | null,
): void {
  if (result !== null || terminal.kind !== 'failed' || workProduct === null) return;
  const data = (terminal.data ?? {}) as Record<string, unknown>;
  if (isExecutionTerminalTrigger(data['trigger']) && data['trigger'].kind !== 'success') return;
  if (data['outcome'] !== undefined) return;

  const classification = classifyOutcome({
    exit: {
      exitCode: 0,
      signal: null,
      cancelled: false,
      durationMs: 0,
      exitFact: 'clean-exit',
    },
    product: workProduct,
  });
  if (classification.outcome !== 'branch-complete') return;

  terminal.kind = 'completed';
  terminal.data = {
    ...data,
    outcome: classification.outcome,
    reason: typeof data['reason'] === 'string' ? data['reason'] : classification.reason,
    workProduct,
  };
}

const EMPTY_WORK_PRODUCT: WorkProductFacts = {
  commitCount: 0,
  commitShas: [],
  filesChanged: [],
  diffstat: '',
  dirty: false,
  untracked: false,
  transitions: { tasksNewlyChecked: 0, tasksRemaining: 0, tasksAdded: 0, tasksRemoved: 0 },
};

async function computeOrchestratedWorkProduct(args: {
  deps: OrchestratedRuntimeDeps;
  descriptor: MutationDescriptor<OrchestratedWorkPayload>;
  sandbox: SandboxSpec;
  branch: string;
  projectDir: string;
  baselineTasks: string;
}): Promise<WorkProductFacts | null> {
  const { deps, descriptor, sandbox, branch, projectDir, baselineTasks } = args;
  if (deps.runGit === defaultRunGit && !existsSync(join(sandbox.worktree, '.git'))) {
    return null;
  }
  try {
    return await computeWorkProduct({
      runGit: deps.runGit,
      cwd: sandbox.worktree,
      baseSha: sandbox.baseSha ?? '',
      branch,
      baselineTasks,
      finalTasks: readFileSafe(join(projectDir, 'tasks.md')),
    });
  } catch (err) {
    log.warn('orchestrated-work-runner: work-product classification failed; summary uses declared outcome', {
      id: descriptor.id,
      error: (err as Error).message,
    });
    return null;
  }
}

function buildOrchestratedSummary(args: {
  id: string;
  project: string;
  product: string;
  target: WorkRunTarget;
  branch: string;
  baseSha: string;
  startedAtMs: number;
  endedAt: string;
  terminal: MutationEvent;
  sink: TranscriptSink | null;
  workRunsDir: string;
  workProduct: WorkProductFacts | null;
  result: OrchestrationResult | null;
}): WorkRunSummary {
  const { id, project, product, target, branch, baseSha, startedAtMs, endedAt, terminal, sink, workRunsDir, workProduct, result } = args;
  const data = (terminal.data ?? {}) as Record<string, unknown>;
  const trigger: ExecutionTerminalTrigger = isExecutionTerminalTrigger(data['trigger'])
    ? data['trigger']
    : {
        kind: terminal.kind === 'completed' ? 'success' : 'failure',
        reason: sanitizeExecutionDiagnostic(
          typeof data['reason'] === 'string' ? data['reason'] : terminal.kind,
        ),
      };
  const disposition = isExecutionTerminalDisposition(data['disposition'])
    ? data['disposition']
    : undefined;
  const contextFailure = data['contextFailure'] &&
      typeof data['contextFailure'] === 'object' &&
      !Array.isArray(data['contextFailure'])
    ? data['contextFailure'] as ContextCloseoutFailure
    : undefined;
  const relatedTestDiagnostics = isRelatedTestTaskDiagnosticList(
    data['relatedTestDiagnostics'],
  )
    ? data['relatedTestDiagnostics']
    : undefined;
  const relatedTestDiagnostic = isRelatedTestDiagnostic(data['relatedTestDiagnostic'])
    ? data['relatedTestDiagnostic']
    : relatedTestDiagnostics?.at(-1)?.diagnostic;
  const gateValidationReceipt = isGateValidationReceipt(data['gateValidationReceipt'])
    ? data['gateValidationReceipt']
    : undefined;
  const cancelReason = trigger.kind === 'cancellation' ? trigger.cancellationSource : data['cancelReason'];
  const exit: ExitFacts = {
    exitCode:
      trigger.kind === 'success' ? 0
      : trigger.kind === 'cancellation' && cancelReason !== 'user' ? null
      : 1,
    signal: null,
    cancelled: cancelReason === 'user',
    durationMs: Date.parse(endedAt) - startedAtMs,
    exitFact:
      cancelReason === 'user' ? 'user-cancel'
      : trigger.kind === 'cancellation' ? 'system-cancel'
      : trigger.kind === 'failure' ? 'execution-failure'
      : 'clean-exit',
  };
  const classification = trigger.kind === 'failure' || cancelReason === 'user'
    ? { outcome: 'failed' as const, reason: trigger.reason }
    : workProduct !== null
      ? classifyOutcome({ exit, product: workProduct })
      : { outcome: orchestratedOutcome(result, terminal), reason: '' };
  const cancellation = workRunCancellation(data['cancellation']);
  const judgmentOutcomes = workRunJudgmentOutcomes(data['judgmentOutcomes']);
  return {
    id,
    project,
    product,
    target,
    outcome: classification.outcome,
    reason: trigger.reason || classification.reason,
    exit,
    workProduct: workProduct ?? EMPTY_WORK_PRODUCT,
    baseSha,
    branch,
    startedAt: new Date(startedAtMs).toISOString(),
    endedAt,
    transcriptPath: sink?.path ?? '',
    forensicsPath: join(workRunsDir, id),
    ...(typeof data['baseBranch'] === 'string' ? { baseBranch: data['baseBranch'] } : {}),
    ...(typeof data['merged'] === 'boolean' ? { merged: data['merged'] } : {}),
    ...(typeof data['branchDeleted'] === 'boolean' ? { branchDeleted: data['branchDeleted'] } : {}),
    ...(typeof data['gateHeldReason'] === 'string' ? { gateHeldReason: data['gateHeldReason'] } : {}),
    ...(cancellation !== undefined ? { cancellation } : {}),
    ...(judgmentOutcomes !== undefined ? { judgmentOutcomes } : {}),
    trigger,
    ...(disposition !== undefined ? { disposition } : {}),
    ...(contextFailure !== undefined ? { contextFailure } : {}),
    ...(relatedTestDiagnostic !== undefined ? { relatedTestDiagnostic } : {}),
    ...(relatedTestDiagnostics !== undefined ? { relatedTestDiagnostics } : {}),
    ...(gateValidationReceipt !== undefined ? { gateValidationReceipt } : {}),
  };
}

function workRunCancellation(value: unknown): WorkRunCancellation | undefined {
  const cancellation = parseWorkRunCancellation(value);
  if (cancellation === undefined) return undefined;
  return {
    role: scrubPathsInText(cancellation.role),
    operationId: scrubPathsInText(cancellation.operationId),
    source: cancellation.source,
    requestedAt: scrubPathsInText(cancellation.requestedAt),
  };
}

function workRunJudgmentOutcomes(
  value: unknown,
): WorkRunSummary['judgmentOutcomes'] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > 4) return undefined;
  const outcomes: NonNullable<WorkRunSummary['judgmentOutcomes']> = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return undefined;
    const record = item as Record<string, unknown>;
    const role = record['role'];
    const status = record['status'];
    if (
      (role !== 'qa' && role !== 'reviewer' && role !== 'tech-lead' && role !== 'designer') ||
      (status !== 'pass' && status !== 'reject' && status !== 'failed' && status !== 'cancelled')
    ) {
      return undefined;
    }
    const summary = typeof record['summary'] === 'string'
      ? scrubPathsInText(record['summary']).slice(0, 500)
      : undefined;
    outcomes.push({
      role,
      status,
      ...(summary !== undefined ? { summary } : {}),
    });
  }
  return outcomes;
}

function terminalWorkProduct(event: MutationEvent): WorkProductFacts | null {
  const data = (event.data ?? {}) as Record<string, unknown>;
  const workProduct = data['workProduct'];
  return workProduct && typeof workProduct === 'object' ? (workProduct as WorkProductFacts) : null;
}

function orchestratedOutcome(result: OrchestrationResult | null, terminal: MutationEvent): WorkOutcome {
  if (result?.kind === 'finalized' && isWorkOutcome(result.outcome)) return result.outcome;
  if (result?.kind === 'held') return 'branch-complete';
  if (result?.kind === 'cancelled' && result.reason === 'user') return 'failed';
  if (terminal.kind === 'completed') return 'partial';
  return 'failed';
}

function isWorkOutcome(value: unknown): value is WorkOutcome {
  return value === 'branch-complete' || value === 'partial' || value === 'noop' || value === 'dirty-uncommitted' || value === 'failed';
}

function persistTerminalMutationState(
  descriptor: MutationDescriptor<OrchestratedWorkPayload>,
  terminal: MutationEvent,
): void {
  // Shutdown suppression: once shutdown() arms the flag, this run's on-disk
  // state is owned by the shutdown parker / next-boot recovery. The SIGTERM'd
  // child surfaces here as a failed terminal the run never earned — persisting
  // it would flip a boot-resumable `running` mutation to failed (or clobber a
  // just-written shutdown park).
  if (isMutationShutdownInProgress() || isMutationRecoveryHandoff(descriptor.id)) {
    log.info('orchestrated-work-runner: lifecycle handoff in progress; skipping terminal persistence', {
      id: descriptor.id,
    });
    return;
  }
  const terminalStatus = terminal.kind === 'completed' ? 'completed' : 'failed';
  descriptor.status = terminalStatus;
  if (terminal.kind === 'failed' && terminal.data) {
    descriptor.error = String((terminal.data as Record<string, unknown>)['reason'] ?? '');
  }
  applyOutcomeToDescriptor(descriptor, terminal);
  appendMutationLine({
    ...descriptor,
    target: { ...descriptor.target },
    preview: { ...descriptor.preview },
    payload: { ...descriptor.payload },
    ...(descriptor.outcome !== undefined ? { outcome: descriptor.outcome } : {}),
    ...(descriptor.workProduct !== undefined ? { workProduct: descriptor.workProduct } : {}),
  });

  try {
    upsertRun(
      buildTerminalSupervisedRun(
        descriptor,
        terminalSupervisionStatus(descriptor, terminal, terminalStatus),
        terminal,
      ),
      config.SUPERVISED_RUNS_FILE,
    );
  } catch (err) {
    log.warn('orchestrated-work-runner: terminal supervision upsert failed', {
      id: descriptor.id,
      error: (err as Error).message,
    });
  }
}

function terminalSupervisionStatus(
  descriptor: MutationDescriptor<OrchestratedWorkPayload>,
  terminal: MutationEvent,
  terminalStatus: 'completed' | 'failed',
): SupervisedRun['status'] {
  const parked =
    descriptor.kind === 'orchestrated-work' &&
    (terminal.data as Record<string, unknown> | undefined)?.['parked'] === true;
  return parked ? 'blocked-on-human' : terminalStatus;
}

function buildTerminalSupervisedRun(
  descriptor: MutationDescriptor<OrchestratedWorkPayload>,
  status: SupervisedRun['status'],
  terminal: MutationEvent,
): SupervisedRun {
  const product = descriptor.payload.product ?? 'rune';
  const project = descriptor.payload.projectSlug || descriptor.target.ref || descriptor.id;
  const run: SupervisedRun = {
    id: descriptor.id,
    kind: descriptor.kind,
    product,
    project,
    status,
    startedAt: descriptor.createdAt,
    lastHeartbeatAt: new Date().toISOString(),
  };
  const operatorWorktreePath = parkedOperatorWorktreePath(terminal);
  if (operatorWorktreePath !== undefined) {
    run.operatorWorktreePath = operatorWorktreePath;
  }
  return run;
}

function parkedOperatorWorktreePath(event: MutationEvent): string | undefined {
  const data = event.data as Record<string, unknown> | undefined;
  if (data?.['parked'] !== true) return undefined;
  const value = data['operatorWorktreePath'];
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/** Map the terminal OrchestrationResult to the single MutationEvent apply yields.
 *  Held is a legitimate durable terminal (branch-complete, awaiting Project 15) —
 *  rendered `completed`, flagged `held`, never a self-merge. */
function mapResultToTerminal(
  mutationId: string,
  result: OrchestrationResult,
  projectSlug: string,
  product: string,
  baseBranch: string,
): MutationEvent {
  const base = { projectSlug, product, dispatchMode: 'orchestrated' as const };
  if (result.kind === 'finalized') {
    const relatedTestDiagnostic = result.relatedTestDiagnostics?.at(-1)?.diagnostic;
    return term(mutationId, 'completed', {
      ...base,
      outcome: result.outcome,
      baseBranch,
      ...(result.relatedTestDiagnostics !== undefined
        ? { relatedTestDiagnostics: result.relatedTestDiagnostics }
        : {}),
      ...(relatedTestDiagnostic !== undefined ? { relatedTestDiagnostic } : {}),
    });
  }
  if (result.kind === 'held') {
    const executionFailure = result.executionFailure;
    const contextFailure = result.contextFailure;
    const relatedTestDiagnostic = result.relatedTestDiagnostic;
    return term(
      mutationId,
      executionFailure === undefined &&
          contextFailure === undefined &&
          relatedTestDiagnostic === undefined
        ? 'completed'
        : 'failed',
      {
      ...base,
      held: true,
      reason: result.reason ?? 'branch-complete; held for the Project 15 finalizer',
      branch: result.handoff.branch,
      baseBranch,
      taskCount: result.handoff.taskRecords.length,
      ...(result.worktreePath !== undefined ? { operatorWorktreePath: result.worktreePath } : {}),
      ...(result.preserveBranch === true ? { preserveBranch: true } : {}),
      ...(result.preserveWorktree === true ? { preserveWorktree: true } : {}),
      ...(executionFailure !== undefined ? {
        executionFailure,
      } : {}),
      ...(contextFailure !== undefined ? { contextFailure } : {}),
      ...(relatedTestDiagnostic !== undefined ? { relatedTestDiagnostic } : {}),
    });
  }
  if (result.kind === 'cancelled') {
    const nested = result.cancellation;
    const judgmentOutcomes = result.judgmentOutcomes;
    const nestedReason = nested === undefined
      ? undefined
      : scrubPathsInText(
          `${nested.role} cancelled from ${nested.source} (operation ${nested.operationId.slice(0, 8)})`,
        );
    if (result.reason === 'user') {
      return term(mutationId, 'failed', {
        ...base,
        cancelReason: 'user',
        ...(result.source !== undefined ? { cancelSource: result.source } : {}),
        reason: nestedReason ?? 'cancelled',
        ...(nested !== undefined ? { cancellation: nested } : {}),
        ...(judgmentOutcomes !== undefined ? { judgmentOutcomes } : {}),
        ...(result.task !== undefined ? { taskId: result.task.id, taskText: result.task.text } : {}),
      });
    }
    return term(mutationId, 'completed', {
      ...base,
      cancelReason: 'system',
      ...(result.source !== undefined ? { cancelSource: result.source } : {}),
      reason: nestedReason ?? 'system-cancelled; stopped at orchestration boundary',
      ...(nested !== undefined ? { cancellation: nested } : {}),
      ...(judgmentOutcomes !== undefined ? { judgmentOutcomes } : {}),
      baseBranch,
      ...(result.task !== undefined ? { taskId: result.task.id, taskText: result.task.text } : {}),
    });
  }
  if (result.parked !== undefined) {
    return term(mutationId, 'completed', {
      ...base,
      parked: true,
      reason: scrubPathsInText(`orchestration parked on "${result.task.text}": ${result.reason}`),
      operatorWorktreePath: result.parked.worktreePath,
      branch: result.parked.branch,
      baseBranch,
      preserveBranch: result.parked.preserveBranch,
      preserveWorktree: result.parked.preserveWorktree,
      ...(result.relatedTestDiagnostic !== undefined
        ? { relatedTestDiagnostic: result.relatedTestDiagnostic }
        : {}),
    });
  }
  // blocked
  return term(mutationId, 'failed', {
    ...base,
    reason: scrubPathsInText(`orchestration blocked on "${result.task.text}": ${result.reason}`),
    ...(result.relatedTestDiagnostic !== undefined
      ? { relatedTestDiagnostic: result.relatedTestDiagnostic }
      : {}),
  });
}

function term(
  mutationId: string,
  kind: 'completed' | 'failed',
  data: Record<string, unknown>,
): MutationEvent {
  return withTerminalTrigger({
    mutationId,
    ts: new Date().toISOString(),
    kind,
    data,
  });
}

function toMutationEvent(mutationId: string, event: OrchestrationActivityEvent): MutationEvent {
  return {
    mutationId,
    ts: new Date().toISOString(),
    kind: event.kind,
    ...(event.data !== undefined ? { data: event.data } : {}),
  };
}

function shouldPublishCloseoutProgress(workRunsDir: string, runId: string, event: MutationEvent): boolean {
  if (event.kind !== 'progress') return true;
  const data = event.data as Record<string, unknown> | undefined;
  if (data?.['event'] !== 'closeout-commit') return true;
  const commitSha = data['commitSha'];
  if (typeof commitSha !== 'string' || commitSha.length === 0) return true;
  try {
    return claimOrchestratedNotificationPublication(workRunsDir, runId, {
      kind: 'closeout-progress',
      key: `closeout-progress:${commitSha}`,
      commitSha,
    }).shouldPublish;
  } catch (err) {
    log.warn('orchestrated-work-runner: closeout progress publication claim failed; publishing anyway', {
      id: runId,
      error: (err as Error).message,
    });
    return true;
  }
}
