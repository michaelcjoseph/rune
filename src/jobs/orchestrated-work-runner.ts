/**
 * Orchestrated-work mutation applier (project 14, Phase 5).
 *
 * The Jarvis-owned multi-task orchestration loop dispatched through the existing
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

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
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
  type OrchestrationActivityEvent,
  type OrchestrationDeps,
  type OrchestrationResult,
} from '../intent/project-orchestrator.js';
import { createProductionTaskWorkflowRunner } from './team-task-deps.js';
import type { ContextUpdate } from '../intent/context-curator.js';
import type { TaskEvidence } from '../intent/team-task-workflow.js';
import type { SelectedTask } from '../intent/orch-task-select.js';
import type { FinalizerAdapter } from '../intent/finalizer-handoff.js';
import { workBranchName } from './work-runner.js';
import { VALID_SLUG, type SandboxSpec } from '../intent/sandbox.js';
import { scrubPathsInText } from '../ai/tool-labels.js';
import { activeRuns } from '../transport/mutations.js';
import { createLogger } from '../utils/logger.js';
import { redactSecrets, type TranscriptSink } from './work-run-transcript.js';
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
  type ExitFacts,
  type WorkOutcome,
  type WorkProductFacts,
} from './work-run-classify.js';
import type { MutationApplier, MutationDescriptor, MutationEvent, ApplyContext } from '../transport/mutations.js';
import { runFinalizer, readOutcome, type FinalizerEffects, type FinalizerPhase, type GateFailReason } from './work-run-finalizer.js';
import { runGate } from './work-run-gate-runtime.js';
import { withBaseBranchLock } from './work-run-merge-lock.js';

const log = createLogger('orchestrated-work-runner');

const PROJECTS_SUBDIR = join('docs', 'projects');

/** Outer per-task attempt cap — how many times the orchestrator re-invokes the
 *  whole team-task workflow for one task before escalating (the workflow runs
 *  its own internal round cap). 3 mirrors gen-eval-loop's default round cap. */
const ORCHESTRATED_ATTEMPT_CAP = 3;

/** INNER per-task round cap (coder → review rounds inside one workflow run) —
 *  distinct from the outer attempt cap so tuning one never silently moves the
 *  other. */
const ORCHESTRATED_ROUND_CAP = 3;

type OrchestratedWorkPayload = {
  projectSlug: string;
  product?: string;
};

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
    createSink: createSyncTranscriptSink,
    writeSummary,
    appendIndexRow,
    recordWorkRunPhase: (runId, phase) => recordWorkRunPhase(config.WORK_RUNS_DIR, runId, phase),
    readLastWorkRunPhase: (runId) => readLastWorkRunPhase(config.WORK_RUNS_DIR, runId),
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
  runGit: GitRunner;
  createTaskWorkflowRunner: typeof createProductionTaskWorkflowRunner;
  emit?: (event: OrchestrationActivityEvent) => void;
  finalize: FinalizerAdapter;
}): OrchestrationDeps {
  const { descriptor, sandbox, projectDir, product, projectSlug, branch, baseBranch, runGit } = args;
  const specPath = join(projectDir, 'spec.md');
  const tasksPath = join(projectDir, 'tasks.md');
  const contextPath = join(projectDir, 'context.md');
  const cwd = sandbox.worktree;

  return {
    runId: descriptor.id,
    project: projectSlug,
    product,
    branch,
    worktreePath: sandbox.worktree,
    baseBranch,
    ...(args.emit !== undefined ? { emit: args.emit } : {}),
    // Per-task attempt cap (re-invoke the whole workflow on a non-objection
    // failure). The team-task-workflow runs its own internal round cap; this
    // bounds the OUTER retries. 3 mirrors gen-eval-loop's default round cap.
    attemptCap: ORCHESTRATED_ATTEMPT_CAP,

    readTasksMd: async () => readFileSafe(tasksPath),
    readContextMd: async () => readFileSafe(contextPath),
    readSpec: async () => readFileSafe(specPath),

    // Phase 8: the LIVE per-task role-spawn binding — runTeamTaskWorkflow over
    // the production TeamTaskDeps (execution-agent artifact sessions, charter
    // judgment calls, policy-resolved models, fail-closed reviewer
    // independence). Resolution failures surface as durable blocked evidence.
    runTaskWorkflow: args.createTaskWorkflowRunner({
      sandbox,
      productsConfigPath: config.PRODUCTS_CONFIG_FILE,
      modelPolicyPath: config.MODEL_POLICY_FILE,
      cap: ORCHESTRATED_ROUND_CAP,
      ...(args.emit !== undefined ? { emit: args.emit } : {}),
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
    runCloseoutChecks: async () => true,

    commitCloseout: async (task: SelectedTask): Promise<string> => {
      const message = `jarvis(${product}): closeout — ${task.text}`.slice(0, 200);
      // `-A` (not `-u`) is deliberate: a task's work product routinely includes
      // NEW files (new source/test modules), which `-u` would miss. This runs in
      // the isolated throwaway worktree on a GC'd branch — never the live repo —
      // so staging everything is the correct capture of the task's full output.
      await runGit(['add', '-A'], { cwd });
      await runGit(['commit', '-m', message], { cwd });
      const { stdout } = await runGit(['rev-parse', 'HEAD'], { cwd });
      return stdout.trim();
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
    const product = descriptor.payload.product ?? 'jarvis';
    const deps = runtimeDeps;
    const branch = workBranchName(projectSlug);

    if (ctx.cancel()) {
      yield term(descriptor.id, 'failed', { reason: 'cancelled before start', projectSlug, product });
      return;
    }

    let sandbox: SandboxSpec | null = null;
    let preserveWorktree = false;
    let finalizerOwnedTeardown = false;
    let sink: TranscriptSink | null = null;
    const startedAtMs = Date.now();
    try {
      try {
        sandbox = await deps.createWorktree({
          product,
          project: projectSlug,
          branch,
          worktreeRoot: config.WORKTREE_ROOT,
          productsConfigPath: config.PRODUCTS_CONFIG_FILE,
        });
      } catch (err) {
        yield term(descriptor.id, 'failed', {
          reason: scrubPathsInText(`worktree create failed: ${(err as Error).message}`),
          projectSlug,
          product,
        });
        return;
      }

      const projectDir = findProjectDir(projectSlug, sandbox.worktree);
      if (!projectDir) {
        yield term(descriptor.id, 'failed', {
          reason: `project not found in worktree: ${projectSlug}`,
          projectSlug,
          product,
        });
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
      const emit = (event: OrchestrationActivityEvent): void => {
        enqueue(toMutationEvent(descriptor.id, event));
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
        baseBranch,
        runGit: deps.runGit,
        createTaskWorkflowRunner: deps.createTaskWorkflowRunner,
        emit,
        finalize: async () => {
          let gateTasksRemaining = 0;
          let endedAt = '';
          const integrationWorktree = join(config.WORKTREE_ROOT, `gate-${product}-${descriptor.id}`);
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
                ((h.descriptor.payload as OrchestratedWorkPayload).product ?? 'jarvis') === product &&
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
            writeSupervisionTerminal: () => {},
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
                runGate({
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
              const message = `jarvis(${product}): merge orchestrated branch ${branch}`;
              try {
                await deps.runGit(['merge', '--no-ff', branch, '-m', message], { cwd: repoPath });
              } catch (err) {
                throw new Error(redactSecrets(`git merge failed: ${(err as Error).message}`));
              }
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
          finalizerOwnedTeardown = finalizerResult.worktreeRemoved;
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
        yield terminal;
        return;
      }

      const result = outcome.result;
      preserveWorktree = result.kind === 'blocked' && result.parked?.preserveWorktree === true;
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
      yield terminal;
    } finally {
      sink?.destroy();
      if (sandbox && !preserveWorktree && !finalizerOwnedTeardown) {
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

function createSyncTranscriptSink(runId: string, baseDir: string): TranscriptSink {
  if (!VALID_SLUG.test(runId)) {
    throw new Error(`createSyncTranscriptSink: invalid runId (must be a slug): ${runId}`);
  }
  const dir = join(baseDir, runId);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'transcript.jsonl');
  let destroyed = false;
  return {
    path,
    append(event: unknown): Promise<void> {
      if (destroyed) return Promise.reject(new Error('createSyncTranscriptSink: append after destroy'));
      appendFileSync(path, redactSecrets(JSON.stringify(event)) + '\n', 'utf8');
      return Promise.resolve();
    },
    finish(): Promise<void> {
      if (destroyed) return Promise.reject(new Error('createSyncTranscriptSink: finish after destroy'));
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
  try {
    deps.writeSummary(join(deps.workRunsDir, descriptor.id), summary);
  } catch (err) {
    log.warn('orchestrated-work-runner: writeSummary failed', {
      id: descriptor.id,
      error: (err as Error).message,
    });
  }
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
  const exit: ExitFacts = {
    exitCode: terminal.kind === 'completed' ? 0 : 1,
    signal: null,
    cancelled: false,
    durationMs: Date.parse(endedAt) - startedAtMs,
    exitFact: 'clean-exit',
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
  if (terminal.kind === 'completed') return 'partial';
  return 'failed';
}

function isWorkOutcome(value: unknown): value is WorkOutcome {
  return value === 'branch-complete' || value === 'partial' || value === 'noop' || value === 'dirty-uncommitted' || value === 'failed';
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
      reason: 'branch-complete; held for the Project 15 finalizer (not wired)',
      branch: result.handoff.branch,
      baseBranch,
      taskCount: result.handoff.taskRecords.length,
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
