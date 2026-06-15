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

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
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
import type { FinalizerAdapterResult } from '../intent/finalizer-handoff.js';
import { workBranchName } from './work-runner.js';
import { VALID_SLUG, type SandboxSpec } from '../intent/sandbox.js';
import { scrubPathsInText } from '../ai/tool-labels.js';
import { activeRuns } from '../transport/mutations.js';
import { createLogger } from '../utils/logger.js';
import type { MutationApplier, MutationDescriptor, MutationEvent, ApplyContext } from '../transport/mutations.js';

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
}

function productionRuntimeDeps(): OrchestratedRuntimeDeps {
  return {
    createWorktree: defaultCreateWorktree,
    destroyWorktree: defaultDestroyWorktree,
    runOrchestration: runProjectOrchestration,
    runGit: defaultRunGit,
    createTaskWorkflowRunner: createProductionTaskWorkflowRunner,
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

    // DELIBERATE HOLD (Phase 8 decision, recorded 2026-06-10): the Project 15
    // finalizer is live for `work-run` mutations, but its gated-merge pipeline
    // is bound to the work-run artifact substrate (transcript sink,
    // summary.json, work-product classification, gate runtime + per-base
    // merge lock) — none of which exists for orchestrated runs yet. Until an
    // orchestrated run produces those inputs, the adapter reports
    // `unavailable` and the run HOLDS branch-complete with the handoff
    // payload recorded for the operator — it NEVER self-merges (spec req 17).
    finalize: async (): Promise<FinalizerAdapterResult> => ({
      kind: 'unavailable',
      reason:
        'deliberate hold: the Project 15 gated-merge finalizer is bound to work-run ' +
        'artifacts (transcript/summary/classification) that orchestrated runs do not ' +
        'produce yet — branch-complete, awaiting operator merge',
    }),
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

      let baseBranch = 'main';
      try {
        baseBranch = getProductConfig(product, config.PRODUCTS_CONFIG_FILE).baseBranch;
      } catch {
        /* default to main if products.json is unreadable */
      }

      yield { mutationId: descriptor.id, ts: new Date().toISOString(), kind: 'log', data: { line: `orchestrated run starting for ${projectSlug}` } };

      const streamedEvents: MutationEvent[] = [];
      let wakeStream: (() => void) | undefined;
      const emit = (event: OrchestrationActivityEvent): void => {
        streamedEvents.push(toMutationEvent(descriptor.id, event));
        wakeStream?.();
        wakeStream = undefined;
      };

      const orchestrationDeps = buildOrchestrationDeps({
        descriptor,
        sandbox,
        projectDir,
        product,
        projectSlug,
        branch,
        baseBranch,
        runGit: deps.runGit,
        createTaskWorkflowRunner: deps.createTaskWorkflowRunner,
        emit,
      });

      const orchestration = deps.runOrchestration(orchestrationDeps).then(
        (result) => ({ kind: 'result' as const, result }),
        (error: unknown) => ({ kind: 'error' as const, error }),
      );

      let outcome: Awaited<typeof orchestration> | undefined;
      while (outcome === undefined) {
        const event = streamedEvents.shift();
        if (event !== undefined) {
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

      for (const event of streamedEvents.splice(0)) yield event;
      if (outcome.kind === 'error') {
        yield term(descriptor.id, 'failed', {
          reason: scrubPathsInText(`orchestration loop threw: ${(outcome.error as Error).message}`),
          projectSlug,
          product,
        });
        return;
      }

      const result = outcome.result;
      preserveWorktree = result.kind === 'blocked' && result.parked?.preserveWorktree === true;
      yield mapResultToTerminal(descriptor.id, result, projectSlug, product, baseBranch);
    } finally {
      if (sandbox && !preserveWorktree) {
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
