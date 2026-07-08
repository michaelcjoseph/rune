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

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import config, { PROJECT_ROOT } from '../config.js';
import {
  createWorktree as defaultCreateWorktree,
  destroyWorktree as defaultDestroyWorktree,
  defaultRunGit,
  getProductConfig,
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
import type { TaskEvidence } from '../intent/team-task-workflow.js';
import type { SelectedTask } from '../intent/orch-task-select.js';
import type { FinalizerAdapter } from '../intent/finalizer-handoff.js';
import { workBranchName } from './work-runner.js';
import { VALID_SLUG, worktreePathFor, type SandboxSpec } from '../intent/sandbox.js';
import { scrubPathsInText } from '../ai/tool-labels.js';
import { scrubAbsolutePaths } from '../utils/sanitize-paths.js';
import {
  activeRuns,
  redispatchMutation,
  writeRecoveredTerminalMutation,
  isMutationShutdownInProgress,
} from '../transport/mutations.js';
import { createLogger } from '../utils/logger.js';
import { appendMutationLine } from './mutations-log.js';
import { upsertRun } from './supervision-store.js';
import { createTranscriptSink, redactSecrets, type TranscriptSink } from './work-run-transcript.js';
import {
  writeSummary,
  appendIndexRow,
  recordWorkRunPhase,
  readLastWorkRunPhase,
  type WorkRunSummary,
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
import type { MutationApplier, MutationDescriptor, MutationEvent, ApplyContext, CancelReason, RunHandle } from '../transport/mutations.js';
import { buildRunAgentsEventFromTaskRecords } from '../transport/notification-bus.js';
import {
  markProjectDoneOnBranch,
  runFinalizer,
  readOutcome,
  type FinalizerEffects,
  type FinalizerPhase,
  type GateFailReason,
} from './work-run-finalizer.js';
import {
  runGate as defaultRunGate,
  runValidationCommands as defaultRunValidationCommands,
} from './work-run-gate-runtime.js';
import { withBaseBranchLock } from './work-run-merge-lock.js';
import type { SupervisedRun } from '../intent/supervision.js';
import { rebuildRegistry } from './registry-rebuild.js';

const log = createLogger('orchestrated-work-runner');

const PROJECTS_SUBDIR = join('docs', 'projects');

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
  readRunCursor: (runId: string) => Promise<OrchestrationRunCursor | null>;
  readTaskRunRecords: (runId: string) => Promise<TaskRunRecord[]>;
  readTasksMd: (cursor: OrchestrationRunCursor) => Promise<string>;
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
  readRunCursor: (runId: string) => Promise<OrchestrationRunCursor | null>;
  readTaskRunRecords: (runId: string) => Promise<TaskRunRecord[]>;
  readTasksMd: (cursor: OrchestrationRunCursor) => Promise<string>;
  redispatchOrchestratedMutation: (
    mutation: MutationDescriptor<OrchestratedWorkPayload>,
    options: OrchestratedRecoveryRedispatch,
  ) => { ok: true } | { ok: false; reason: string };
  activeRun: (runId: string) => { descriptor: MutationDescriptor; cancel: (reason?: 'user' | 'system') => void } | null;
  detachActiveRun: (runId: string) => void;
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

export function defaultOrchestratedRunRecoveryRequestDeps(): OrchestratedRunRecoveryRequestDeps {
  return {
    readRunCursor: async (runId) => readOrchestratedRunCursor(config.WORK_RUNS_DIR, runId),
    readTaskRunRecords: async (runId) => readOrchestratedTaskRunRecords(config.WORK_RUNS_DIR, runId),
    readTasksMd: readTasksMdForRecoveredCursor,
    redispatchOrchestratedMutation: redispatchRecoveredOrchestratedMutation,
    activeRun: (runId) => activeRuns.get(runId) ?? null,
    detachActiveRun: (runId) => {
      activeRuns.delete(runId);
    },
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
  const cursor = await deps.readRunCursor(runId);
  if (!cursor || cursor.resumeMarker !== 'resumable') {
    return { kind: 'not-resumable', reason: 'missing resumable orchestrated cursor' };
  }

  try {
    const [records, tasksMd] = await Promise.all([
      deps.readTaskRunRecords(runId),
      deps.readTasksMd(cursor),
    ]);
    const reconstruction = reconstructRun({ tasksMd, records });
    if (reconstruction.drift) {
      return {
        kind: 'not-resumable',
        reason: 'completed task records disagree with tasks.md',
      };
    }

    handle.cancel('system');
    deps.detachActiveRun(runId);
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
  }
}

// ---------------------------------------------------------------------------
// Shutdown park (docs/projects/bugs.md — orchestrated-run restart safety 1/2)
// ---------------------------------------------------------------------------

export interface ShutdownParkDeps {
  listActiveRuns: () => RunHandle[];
  readRunCursor: (runId: string) => Promise<OrchestrationRunCursor | null>;
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
    readRunCursor: async (runId) => readOrchestratedRunCursor(config.WORK_RUNS_DIR, runId),
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
 * - A run WITH a resumable cursor is left `running` on disk: boot recovery
 *   re-dispatches it automatically — parking it would degrade a routine deploy
 *   restart from hands-off resume to a human-gated release.
 * - A run WITHOUT a cursor (mid-first-task; recovery would orphan it and the
 *   diff would be discarded) is parked: best-effort WIP commit onto the run
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
      handle.cancel('system');
      const cursor = await deps.readRunCursor(descriptor.id);
      if (cursor !== null && cursor.resumeMarker === 'resumable') {
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

/** Best-effort WIP commit of a dirty worktree — mirrors the closeout
 *  `commitWip` dep. Returns the commit sha; null when the tree is clean or on
 *  any git failure (preservation is best-effort; the caller's own outcome —
 *  park or resume — must land regardless). Shared by the shutdown parker and
 *  the recovery-redispatch restart salvage. */
async function commitWorktreeWip(
  runGit: GitRunner,
  cwd: string,
  args: { message: string; logLabel: string; product: string; projectSlug: string },
): Promise<string | null> {
  const message = args.message.slice(0, 200);
  try {
    const { stdout } = await runGit(['status', '--porcelain'], { cwd });
    if (stdout.trim() === '') return null;
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
  /** Build the throwaway integration worktree path used by the gate runtime. */
  integrationWorktree: (product: string, runId: string) => string;
  /** Refresh the rebuildable product/project registry after a branch lands on
   *  the product's base branch. Best-effort at the call site. */
  refreshRegistry: () => void;
}

function productionRuntimeDeps(): OrchestratedRuntimeDeps {
  return {
    createWorktree: defaultCreateWorktree,
    destroyWorktree: defaultDestroyWorktree,
    runOrchestration: runProjectOrchestration,
    runGit: defaultRunGit,
    createTaskWorkflowRunner: createProductionTaskWorkflowRunner,
    workRunsDir: config.WORK_RUNS_DIR,
    workRunsIndexFile: config.WORK_RUNS_INDEX_FILE,
    createSink: createOrchestratedTranscriptSink,
    writeSummary,
    appendIndexRow,
    recordWorkRunPhase: (runId, phase) => recordWorkRunPhase(config.WORK_RUNS_DIR, runId, phase),
    readLastWorkRunPhase: (runId) => readLastWorkRunPhase(config.WORK_RUNS_DIR, runId),
    runGate: defaultRunGate,
    integrationWorktree: (product, runId) => join(config.WORKTREE_ROOT, `gate-${product}-${runId}`),
    refreshRegistry: () => { rebuildRegistry(); },
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

/** Find a project dir by slug under `<base>/docs/projects` (exact or
 *  `<numeric-prefix>-<slug>`), mirroring work-runner's resolver. */
function findProjectDir(slug: string, base: string): string | null {
  const projectsDir = join(base, PROJECTS_SUBDIR);
  let names: string[];
  try {
    names = readdirSync(projectsDir) as string[];
  } catch {
    return null;
  }
  for (const name of names) {
    try {
      if (!statSync(join(projectsDir, name)).isDirectory()) continue;
    } catch {
      continue;
    }
    if (name === slug || name.endsWith(`-${slug}`)) return join(projectsDir, name);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Production OrchestrationDeps wiring (real fs/git/finalizer effects)
// ---------------------------------------------------------------------------

/** Build the real-effect OrchestrationDeps for a run against its worktree.
 *  Pure-loop logic lives in project-orchestrator.ts; this binds the I/O. */
function buildOrchestrationDeps(args: {
  descriptor: MutationDescriptor<OrchestratedWorkPayload>;
  sandbox: SandboxSpec;
  projectDir: string;
  product: string;
  projectSlug: string;
  branch: string;
  baseBranch: string;
  validationCommands: string[];
  workRunsDir: string;
  runGit: GitRunner;
  createTaskWorkflowRunner: typeof createProductionTaskWorkflowRunner;
  emit?: (event: OrchestrationActivityEvent) => void;
  cancel?: () => boolean;
  cancelReason?: () => CancelReason | null;
  publishAgents?: (records: TaskRunRecord[]) => void;
  finalize: FinalizerAdapter;
}): OrchestrationDeps {
  const { descriptor, sandbox, projectDir, product, projectSlug, branch, baseBranch, runGit } = args;
  const specPath = join(projectDir, 'spec.md');
  const tasksPath = join(projectDir, 'tasks.md');
  const contextPath = join(projectDir, 'context.md');
  const cwd = sandbox.worktree;
  const taskWorkflowRunner = args.createTaskWorkflowRunner({
    sandbox,
    productsConfigPath: config.PRODUCTS_CONFIG_FILE,
    modelPolicyPath: config.MODEL_POLICY_FILE,
    validationCommands: args.validationCommands,
    cap: ORCHESTRATED_ROUND_CAP,
    ...(args.emit !== undefined ? { emit: args.emit } : {}),
  });

  return {
    runId: descriptor.id,
    project: projectSlug,
    product,
    branch,
    worktreePath: sandbox.worktree,
    baseBranch,
    ...(args.emit !== undefined ? { emit: args.emit } : {}),
    ...(args.cancel !== undefined ? { cancel: args.cancel } : {}),
    ...(args.cancelReason !== undefined ? { cancelReason: args.cancelReason } : {}),
    appendTaskRunRecord: async (record) => {
      appendOrchestratedTaskRunRecord(args.workRunsDir, descriptor.id, record);
      const records = readOrchestratedTaskRunRecords(args.workRunsDir, descriptor.id);
      args.publishAgents?.(records.length > 0 ? records : [record]);
    },
    writeRunCursor: async (cursor) => writeOrchestratedRunCursor(args.workRunsDir, descriptor.id, cursor),
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

    readTasksMd: async () => readFileSafe(tasksPath),
    readContextMd: async () => readFileSafe(contextPath),
    readSpec: async () => readFileSafe(specPath),

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
    writeContextMd: async (content: string) => writeFileSync(contextPath, content, 'utf8'),
    writeTasksMd: async (content: string) => writeFileSync(tasksPath, content, 'utf8'),

    // Task-scoped closeout checks: run the product's validation commands. (For
    // v1 these are the same fast checks the finalizer gate uses.) No commands ⇒
    // pass — the project-level finalizer gate still owns the full merge gate.
    runCloseoutChecks: async (task) => {
      const validation = await defaultRunValidationCommands(
        args.validationCommands,
        sandbox.worktree,
        config.WORK_RUN_GATE_COMMAND_TIMEOUT_MS,
      );
      if (validation.ok) return { ok: true };
      const scrub = (text: string): string => redactSecrets(scrubAbsolutePaths(scrubPathsInText(text)));
      const command = scrub(validation.command);
      const outputTail = scrub(validation.result.outputTail);
      const outcome = validation.result.timedOut ? 'timed out' : `exit ${validation.result.exitCode}`;
      // Durable artifact in the run dir — the worktree (and with it the diff
      // that caused the red suite) is GC'd, so this file is the only place the
      // failing output survives. Best-effort: never blocks the red verdict.
      try {
        const runDir = join(args.workRunsDir, descriptor.id);
        mkdirSync(runDir, { recursive: true });
        appendFileSync(
          join(runDir, CLOSEOUT_VALIDATION_FAILURE_FILE),
          `=== closeout validation failure @ ${new Date().toISOString()} ===\n` +
            `task: ${task.id} — ${task.text}\n` +
            `command: ${command}\n` +
            `outcome: ${outcome}\n\n` +
            `${outputTail || '(no output captured)'}\n\n`,
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
          line: `closeout validation failed: ${command} (${outcome}) — output tail saved to ${CLOSEOUT_VALIDATION_FAILURE_FILE}`,
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
        },
      };
    },

    commitCloseout: async (task: SelectedTask): Promise<CloseoutCommit> => {
      const message = `rune(${product}): closeout — ${task.text}`.slice(0, 200);
      // `-A` (not `-u`) is deliberate: a task's work product routinely includes
      // NEW files (new source/test modules), which `-u` would miss. This runs in
      // the isolated throwaway worktree on a GC'd branch — never the live repo —
      // so staging everything is the correct capture of the task's full output.
      await runGit(['add', '-A'], { cwd });
      await runGit(['commit', '-m', message], { cwd });
      const { stdout } = await runGit(['rev-parse', 'HEAD'], { cwd });
      return { sha: stdout.trim(), subject: message };
    },
    // Best-effort WIP preservation when the closeout repair loop exhausts: the
    // held run keeps branch + worktree, but only a commit on the stable branch
    // survives a later manual worktree cleanup and is what the resume path
    // checks back out. Null (nothing to commit / commit failed) never blocks
    // the hold.
    commitWip: async (task: SelectedTask): Promise<CloseoutCommit | null> => {
      const message = `rune(${product}): WIP — closeout blocked — ${task.text}`.slice(0, 200);
      try {
        const { stdout } = await runGit(['status', '--porcelain'], { cwd });
        if (stdout.trim() === '') return null; // nothing to preserve
        await runGit(['add', '-A'], { cwd });
        await runGit(['commit', '-m', message], { cwd });
        const { stdout: sha } = await runGit(['rev-parse', 'HEAD'], { cwd });
        args.emit?.({
          kind: 'activity',
          data: {
            event: 'closeout-wip-commit',
            taskId: task.id,
            commitSha: sha.trim(),
            line: `WIP preserved for ${task.text}: ${sha.trim().slice(0, 7)}`,
          },
        });
        return { sha: sha.trim(), subject: message };
      } catch (err) {
        log.warn('orchestrated-work-runner: WIP commit failed', {
          id: descriptor.id,
          error: (err as Error).message,
        });
        return null;
      }
    },
    verifyCleanWorktree: async (): Promise<boolean> => {
      const { stdout } = await runGit(['status', '--porcelain'], { cwd });
      return stdout.trim() === '';
    },

    finalize: args.finalize,
  };
}

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

const ORCHESTRATED_TASK_RECORDS_FILE = 'task-records.jsonl';
const ORCHESTRATED_CURSOR_FILE = 'cursor.json';
const ORCHESTRATED_NOTIFICATION_PUBLICATIONS_FILE = 'notification-publications.jsonl';
// Durable evidence for a failed closeout validation: the sandbox worktree is
// GC'd on a blocked run, so the failing command's output tail written here is
// the only post-mortem trace of WHICH test failed. Append-mode so a future
// closeout repair loop can record multiple attempts.
const CLOSEOUT_VALIDATION_FAILURE_FILE = 'closeout-validation-failure.txt';
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

export function appendOrchestratedTaskRunRecord(baseDir: string, runId: string, record: TaskRunRecord): void {
  const dir = join(baseDir, runId);
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, ORCHESTRATED_TASK_RECORDS_FILE), JSON.stringify(record) + '\n', 'utf8');
}

export function readOrchestratedTaskRunRecords(baseDir: string, runId: string): TaskRunRecord[] {
  let raw: string;
  try {
    raw = readFileSync(join(baseDir, runId, ORCHESTRATED_TASK_RECORDS_FILE), 'utf8');
  } catch {
    return [];
  }

  const records: TaskRunRecord[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line) as TaskRunRecord);
    } catch {
      log.warn('orchestrated task-records.jsonl: skipped malformed line', { runId });
    }
  }
  return records;
}

export function writeOrchestratedRunCursor(baseDir: string, runId: string, cursor: OrchestrationRunCursor): void {
  const dir = join(baseDir, runId);
  mkdirSync(dir, { recursive: true });
  const target = join(dir, ORCHESTRATED_CURSOR_FILE);
  const tmp = join(dir, `.${ORCHESTRATED_CURSOR_FILE}.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(cursor, null, 2), 'utf8');
  renameSync(tmp, target);
}

export function readOrchestratedRunCursor(baseDir: string, runId: string): OrchestrationRunCursor | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(baseDir, runId, ORCHESTRATED_CURSOR_FILE), 'utf8'));
  } catch {
    return null;
  }
  if (!isOrchestrationRunCursor(parsed) || parsed.runId !== runId) return null;
  return parsed;
}

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

function isOrchestrationRunCursor(value: unknown): value is OrchestrationRunCursor {
  if (!value || typeof value !== 'object') return false;
  const cursor = value as Partial<OrchestrationRunCursor>;
  const position = cursor.cursor as Partial<OrchestrationRunCursor['cursor']> | undefined;
  return (
    cursor.resumeMarker === 'resumable' &&
    typeof cursor.runId === 'string' &&
    typeof cursor.product === 'string' &&
    typeof cursor.project === 'string' &&
    typeof cursor.branch === 'string' &&
    typeof cursor.baseBranch === 'string' &&
    typeof cursor.worktreePath === 'string' &&
    !!position &&
    Array.isArray(position.completedTaskIds) &&
    position.completedTaskIds.every((taskId) => typeof taskId === 'string') &&
    (position.currentTaskId === null || typeof position.currentTaskId === 'string') &&
    (position.nextTaskId === null || typeof position.nextTaskId === 'string')
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
      const cursor = await deps.readRunCursor(mutation.id);
      if (!cursor || cursor.resumeMarker !== 'resumable') {
        await deps.markOrphaned(mutation, 'missing resumable orchestrated cursor');
        result.orphaned.push(mutation.id);
        continue;
      }

      try {
        const [records, tasksMd] = await Promise.all([
          deps.readTaskRunRecords(mutation.id),
          deps.readTasksMd(cursor),
        ]);
        const reconstruction = reconstructRun({ tasksMd, records });

        if (reconstruction.drift) {
          const terminal = term(mutation.id, 'failed', {
            projectSlug: mutation.payload.projectSlug,
            product: mutation.payload.product ?? cursor.product,
            reason: 'orchestrated recovery drift: completed task records disagree with tasks.md',
          });
          await deps.writeTerminal(mutation, terminal);
          result.orphaned.push(mutation.id);
          continue;
        }

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
    const dir = findProjectDir(projectSlug, PROJECT_ROOT);
    if (!dir) return { ok: false, reason: `project not found: ${projectSlug}` };
    if (!existsSync(join(dir, 'spec.md'))) {
      return { ok: false, reason: `spec.md missing for project: ${projectSlug}` };
    }
    // Per-project + global concurrency caps (shared with the legacy work-run
    // applier — the two never run the same project concurrently because they
    // share the deterministic per-project worktree path).
    const runningForSlug = [...activeRuns.values()].filter(
      (h) =>
        (h.descriptor.kind === 'orchestrated-work' || h.descriptor.kind === 'work-run') &&
        (h.descriptor.payload as OrchestratedWorkPayload).projectSlug === projectSlug &&
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
      const terminal = term(descriptor.id, 'failed', { reason: 'cancelled before start', projectSlug, product });
      persistTerminalStateOnce(terminal);
      yield terminal;
      return;
    }

    let sandbox: SandboxSpec | null = null;
    let preserveWorktree = false;
    let finalizerOwnedTeardown = false;
    let sink: TranscriptSink | null = null;
    const startedAtMs = Date.now();
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
        const terminal = term(descriptor.id, 'failed', {
          reason: scrubPathsInText(`worktree create failed: ${(err as Error).message}`),
          projectSlug,
          product,
        });
        persistTerminalStateOnce(terminal);
        yield terminal;
        return;
      }

      const projectDir = findProjectDir(projectSlug, sandbox.worktree);
      if (!projectDir) {
        const terminal = term(descriptor.id, 'failed', {
          reason: `project not found in worktree: ${projectSlug}`,
          projectSlug,
          product,
        });
        persistTerminalStateOnce(terminal);
        yield terminal;
        return;
      }
      const runSandbox = sandbox;
      const baselineTasks = readFileSafe(join(projectDir, 'tasks.md'));

      let baseBranch = 'main';
      let repoPath = runSandbox.worktree;
      let validationCommands: string[] = [];
      try {
        const productConfig = getProductConfig(product, config.PRODUCTS_CONFIG_FILE);
        baseBranch = productConfig.baseBranch;
        repoPath = productConfig.repoPath;
        validationCommands = productConfig.validationCommands ?? [];
      } catch {
        /* default to main if products.json is unreadable */
      }
      if (recovery) {
        baseBranch = recovery.baseBranch;
      }

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
      let gateHeldReason: GateFailReason | null = null;
      const orchestrationDeps = buildOrchestrationDeps({
        descriptor,
        sandbox: runSandbox,
        projectDir,
        product,
        projectSlug,
        branch,
        baseBranch: recovery?.baseBranch ?? baseBranch,
        validationCommands,
        workRunsDir: deps.workRunsDir,
        runGit: deps.runGit,
        createTaskWorkflowRunner: deps.createTaskWorkflowRunner,
        cancel: ctx.cancel,
        cancelReason: ctx.cancelReason,
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
        finalize: async () => {
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
              terminalEvent.data = data;
              const workProduct = data['workProduct'] as WorkProductFacts | undefined;
              gateTasksRemaining = workProduct?.transitions.tasksRemaining ?? 0;
              endedAt = new Date().toISOString();
              return terminalEvent;
            },
            flushTranscript: async () => {
              if (!sink) return;
              try {
                await sink.finish();
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
                branch,
                baseSha: runSandbox.baseSha ?? '',
                startedAtMs,
                endedAt: endedAt || new Date().toISOString(),
                terminal: event,
                sink,
                workRunsDir: deps.workRunsDir,
                workProduct: terminalWorkProduct(event),
                result: { kind: 'finalized', outcome: readOutcome(event) },
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
              persistTerminalStateOnce(terminalEvent);
            },
            removeWorktree: async () => {
              await deps.destroyWorktree(runSandbox, {
                productsConfigPath: config.PRODUCTS_CONFIG_FILE,
                worktreeRoot: config.WORKTREE_ROOT,
              });
              finalizerOwnedTeardown = true;
            },
            recordPhase: (phase) => deps.recordWorkRunPhase?.(descriptor.id, phase),
            readLastPhase: () => deps.readLastWorkRunPhase?.(descriptor.id) ?? null,
            gate: () =>
              withBaseBranchLock(product, baseBranch, () =>
                deps.runGate({
                  product,
                  repoPath,
                  baseBranch,
                  branch,
                  integrationWorktree,
                  validationCommands,
                  tasksRemaining: gateTasksRemaining,
                  concurrentRun: hasConcurrentRun(),
                  commandTimeoutMs: config.WORK_RUN_GATE_COMMAND_TIMEOUT_MS,
                }),
              ),
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
          if (readOutcome(finalizerResult.terminalEvent) === 'branch-complete') {
            data['merged'] = finalizerResult.merged;
            data['branchDeleted'] = finalizerResult.branchDeleted;
            data['baseBranch'] = baseBranch;
            if (!finalizerResult.merged && gateHeldReason) data['gateHeldReason'] = gateHeldReason;
          }
          finalizerResult.terminalEvent.data = data;
          finalizerTerminal = finalizerResult.terminalEvent;
          return { kind: 'finalized', outcome: readOutcome(finalizerResult.terminalEvent) };
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
        const terminal = term(descriptor.id, 'failed', {
          reason: scrubPathsInText(`orchestration loop threw: ${(outcome.error as Error).message}`),
          projectSlug,
          product,
        });
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
        yield terminal;
        return;
      }

      const result = outcome.result;
      preserveWorktree =
        (result.kind === 'blocked' && result.parked?.preserveWorktree === true) ||
        (result.kind === 'held' && result.preserveWorktree === true);
      const terminal = finalizerTerminal ?? mapResultToTerminal(descriptor.id, result, projectSlug, product, baseBranch);
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
      yield terminal;
    } finally {
      sink?.destroy();
      if (sandbox && isMutationShutdownInProgress()) {
        // Shutdown suppression: the worktree may hold the in-flight task's
        // uncommitted diff — the shutdown parker WIP-commits and preserves it
        // (or boot recovery resumes it). Destroying it here would discard the
        // exact work the park exists to save.
        log.info('orchestrated-work-runner: shutdown in progress; leaving worktree for parker/boot recovery', {
          sandbox: sandbox.worktree,
        });
      } else if (sandbox && !preserveWorktree && !finalizerOwnedTeardown) {
        try {
          await deps.destroyWorktree(sandbox, {
            productsConfigPath: config.PRODUCTS_CONFIG_FILE,
            worktreeRoot: config.WORKTREE_ROOT,
          });
        } catch (err) {
          log.warn('orchestrated-work-runner: destroyWorktree failed', {
            sandbox: sandbox.worktree,
            error: (err as Error).message,
          });
        }
      } else if (sandbox && preserveWorktree) {
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
  const { deps, sink, descriptor, terminal, startedAtMs, projectSlug, product, branch, sandbox, projectDir, baselineTasks, result } = args;
  if (sink) {
    try {
      await sink.finish();
    } catch (err) {
      log.warn('orchestrated-work-runner: transcript flush failed', {
        id: descriptor.id,
        error: (err as Error).message,
      });
    }
  }

  const endedAt = new Date().toISOString();
  const workProduct = await computeOrchestratedWorkProduct({
    deps,
    descriptor,
    sandbox,
    branch,
    projectDir,
    baselineTasks,
  });
  normalizeLateErrorTerminalFromWorkProduct(terminal, workProduct, result);
  const summary = buildOrchestratedSummary({
    id: descriptor.id,
    project: projectSlug,
    product,
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
  const { id, project, product, branch, baseSha, startedAtMs, endedAt, terminal, sink, workRunsDir, workProduct, result } = args;
  const data = (terminal.data ?? {}) as Record<string, unknown>;
  const cancelReason = data['cancelReason'];
  const exit: ExitFacts = {
    exitCode: terminal.kind === 'completed' ? 0 : 1,
    signal: null,
    cancelled: cancelReason === 'user',
    durationMs: Date.parse(endedAt) - startedAtMs,
    exitFact:
      cancelReason === 'user' ? 'user-cancel'
      : cancelReason === 'system' ? 'system-cancel'
      : 'clean-exit',
  };
  const classification =
    workProduct !== null
      ? classifyOutcome({ exit, product: workProduct })
      : { outcome: orchestratedOutcome(result, terminal), reason: '' };
  return {
    id,
    project,
    product,
    outcome: classification.outcome,
    reason: typeof data['reason'] === 'string' ? data['reason'] : classification.reason,
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
  };
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
  if (isMutationShutdownInProgress()) {
    log.info('orchestrated-work-runner: shutdown in progress; skipping terminal persistence', {
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
    return term(mutationId, 'completed', { ...base, outcome: result.outcome, baseBranch });
  }
  if (result.kind === 'held') {
    return term(mutationId, 'completed', {
      ...base,
      held: true,
      reason: result.reason ?? 'branch-complete; held for the Project 15 finalizer',
      branch: result.handoff.branch,
      baseBranch,
      taskCount: result.handoff.taskRecords.length,
      ...(result.worktreePath !== undefined ? { operatorWorktreePath: result.worktreePath } : {}),
      ...(result.preserveBranch === true ? { preserveBranch: true } : {}),
      ...(result.preserveWorktree === true ? { preserveWorktree: true } : {}),
    });
  }
  if (result.kind === 'cancelled') {
    if (result.reason === 'user') {
      return term(mutationId, 'failed', {
        ...base,
        cancelReason: 'user',
        reason: 'cancelled',
        ...(result.task !== undefined ? { taskId: result.task.id, taskText: result.task.text } : {}),
      });
    }
    return term(mutationId, 'completed', {
      ...base,
      cancelReason: 'system',
      reason: 'system-cancelled; stopped at orchestration boundary',
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
    });
  }
  // blocked
  return term(mutationId, 'failed', {
    ...base,
    reason: scrubPathsInText(`orchestration blocked on "${result.task.text}": ${result.reason}`),
  });
}

function term(
  mutationId: string,
  kind: 'completed' | 'failed',
  data: Record<string, unknown>,
): MutationEvent {
  return { mutationId, ts: new Date().toISOString(), kind, data };
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
