import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import config, { PROJECT_ROOT } from '../config.js';
import { CLAUDE_BIN, registerActiveProcess, unregisterActiveProcess, getProjectMcpArgs } from '../ai/claude.js';
import { activeRuns } from '../transport/mutations.js';
import { createWorktree, destroyWorktree, defaultRunGit, getProductConfig, type GitRunner } from './sandbox-runtime.js';
import { parseStreamJsonLine, streamJsonToDisplay, createRingBuffer, createTranscriptSink, redactSecrets, type StreamJsonEnvelope, type TranscriptSink } from './work-run-transcript.js';
import { parseWorkRunSentinel, type WorkRunSentinel } from './work-run-sentinel.js';
import { parseAskUserQuestionEnvelope, pendingCheckForQuestion, type ParsedAskUserQuestion, type WorkRunParkedQuestion } from './work-run-question.js';
import { upsertRun, readAllRuns } from './supervision-store.js';
import { computeWorkProduct, finalizeWorkRun, parseTasks, type ExitFact, type ExitFacts, type WorkOutcome, type WorkProductFacts } from './work-run-classify.js';
import { planCommitProgress, COMMIT_POLL_INTERVAL_MS, COMMIT_PING_THROTTLE_MS, type CommitPollState } from './work-run-commit-poll.js';
import { writeSummary, appendIndexRow, recordWorkRunPhase, readLastWorkRunPhase, type WorkRunSummary, type WorkRunIndexRow } from './work-run-store.js';
import { runFinalizer, readOutcome, type FinalizerEffects, type FinalizerPhase } from './work-run-finalizer.js';
import { runGate } from './work-run-gate-runtime.js';
import { withBaseBranchLock } from './work-run-merge-lock.js';
import type { GateFailReason } from './work-run-gate.js';
import { exportForensics, type ExportForensicsOpts, type ForensicsResult } from './work-run-forensics.js';
import { runWorkRunGc } from './work-run-gc-runner.js';
import { rebuildRegistry } from './registry-rebuild.js';
import { scrubPathsInText } from '../ai/tool-labels.js';
import { VALID_SLUG, worktreePathFor, workBranchName, type SandboxSpec } from '../intent/sandbox.js';
import { createLogger } from '../utils/logger.js';
import type { MutationApplier, MutationDescriptor, MutationEvent, ApplyContext, CancelReason } from '../transport/mutations.js';
import { findWorkProjectDir, resolveLiveWorkProject } from './work-project.js';

const log = createLogger('work-runner');

// `workBranchName` moved to `src/intent/sandbox.ts` (the light sandbox-policy
// module) so consumers like `work-run-release.ts` can reuse it without importing
// this heavy Claude-CLI-spawn module. Re-exported here for back-compat with
// existing `from './work-runner.js'` importers (e.g. recovery-finalize-runner).
export { workBranchName } from '../intent/sandbox.js';

// ---------------------------------------------------------------------------
// Classification + persist runtime seam
// ---------------------------------------------------------------------------

/**
 * The git runner, durable-transcript factory, and run-store writer that
 * `apply()` uses to compute work product and persist a run's artifacts. Held in
 * a module-level holder so the unit suite can inject test doubles (no real git,
 * no real `WriteStream`, no real fs) without threading params through the
 * fixed `MutationApplier.apply` signature — mirroring gen-eval-loop's injectable
 * `LoopSpawners`, adapted to a generator applier.
 */
export interface WorkRunRuntimeDeps {
  /** Work-product git (`rev-list`/`diff`/`status`) — the same seam
   *  createWorktree/destroyWorktree take. */
  runGit: GitRunner;
  /** Base dir for per-run artifacts (`<workRunsDir>/<id>/{transcript,summary}`). */
  workRunsDir: string;
  /** Rolling recent-runs index file (`logs/work-runs/index.jsonl`). */
  workRunsIndexFile: string;
  /** Build the per-run durable transcript sink, or null to disable persistence
   *  (e.g. if the run dir can't be created). */
  createSink: (runId: string, baseDir: string) => TranscriptSink | null;
  /** Atomically write the run's `summary.json` into its per-run dir. */
  writeSummary: (dir: string, summary: WorkRunSummary) => void;
  /** Append one torn-line-tolerant row to the rolling index. */
  appendIndexRow: (filePath: string, row: WorkRunIndexRow) => void;
  /** Export the forensic evidence bundle into the per-run dir (best-effort,
   *  before the terminal event, while the worktree still exists). */
  runForensics: (opts: ExportForensicsOpts) => Promise<ForensicsResult>;
  /** P1.5 / Phase 3.5 (project 15) — gated-merge durable per-run finalize-phase
   *  store. The live gated-merge wiring records each finalizer phase here so a
   *  crash mid-merge is resumable; `recovery-finalize-runner` reads the last
   *  phase to resume in `gated-merge` mode off the SAME store. OPTIONAL until the
   *  gated-merge wiring lands — `hold` mode records no phase, so the live path
   *  leaves these unset today. */
  recordWorkRunPhase?: (runId: string, phase: FinalizerPhase) => void;
  readLastWorkRunPhase?: (runId: string) => FinalizerPhase | null;
  /** Refresh the rebuildable product/project registry after a branch lands on
   *  the product's base branch, so cockpit project cards stop reading stale
   *  lifecycle/progress counts. Best-effort at the call site. */
  refreshRegistry: () => void;
}

/** Production defaults — real git, real config dir, real sink + store. */
function productionRuntimeDeps(): WorkRunRuntimeDeps {
  return {
    runGit: defaultRunGit,
    workRunsDir: config.WORK_RUNS_DIR,
    workRunsIndexFile: config.WORK_RUNS_INDEX_FILE,
    createSink: (runId, baseDir) => createTranscriptSink({ runId, baseDir }),
    writeSummary,
    appendIndexRow,
    runForensics: exportForensics,
    // Durable per-run finalize-phase store (Phase 3.5) — gated-merge records its
    // resume checkpoint here; recovery reads the last phase to resume a crashed
    // merge. Best-effort: recordWorkRunPhase logs + swallows on disk failure.
    recordWorkRunPhase: (runId, phase) => recordWorkRunPhase(config.WORK_RUNS_DIR, runId, phase),
    readLastWorkRunPhase: (runId) => readLastWorkRunPhase(config.WORK_RUNS_DIR, runId),
    refreshRegistry: () => { rebuildRegistry(); },
  };
}

let runtimeDeps: WorkRunRuntimeDeps = productionRuntimeDeps();

function refreshRegistryAfterLanding(deps: WorkRunRuntimeDeps, context: {
  runId: string;
  projectSlug: string;
  product: string;
}): void {
  try {
    deps.refreshRegistry();
  } catch (err) {
    log.warn('work-runner: registry refresh failed after branch landing', {
      id: context.runId,
      projectSlug: context.projectSlug,
      product: context.product,
      error: (err as Error).message,
    });
  }
}

/** Test-only: override part of the classification/persist seam. */
export function __setWorkRunRuntimeForTest(partial: Partial<WorkRunRuntimeDeps>): void {
  runtimeDeps = { ...runtimeDeps, ...partial };
}

/** Test-only: restore the production seam after a test. */
export function __resetWorkRunRuntimeForTest(): void {
  runtimeDeps = productionRuntimeDeps();
}

/**
 * Reap a `/work` agent's entire process group.
 *
 * The agent spawns grandchildren (e.g. a `vitest` via a Bash tool call) that
 * inherit its stdio fds. If one hangs, it holds the run's stdout/stderr pipes
 * open and the runner's `close` event never fires — the run sits `running` for
 * hours (docs/projects/bugs.md, "wedges open"). The child is spawned `detached`,
 * so it is its own process-group leader and signalling the NEGATIVE pid reaches
 * the whole tree — even after the leader itself has exited, because orphaned
 * grandchildren keep the leader's pgid.
 *
 * Indirected behind a module-level binding so the unit suite can stub it: a real
 * `process.kill(-pid)` against a fake test pid could signal an unrelated group.
 */
const defaultKillProcessTree = (child: ReturnType<typeof spawn>, signal: NodeJS.Signals): void => {
  const pid = child.pid;
  if (pid === undefined) return;
  try {
    process.kill(-pid, signal); // negative pid → the whole process GROUP
  } catch {
    // Group already gone, or a platform without group signalling — fall back to
    // the direct child so a cancel still does something.
    try { child.kill(signal); } catch { /* already dead */ }
  }
};

let killProcessTree = defaultKillProcessTree;

/** Test-only: stub the process-group reaper (avoids real signals in unit runs). */
export function __setKillProcessTreeForTest(
  fn: (child: ReturnType<typeof spawn>, signal: NodeJS.Signals) => void,
): void {
  killProcessTree = fn;
}

/** Test-only: restore the production reaper. */
export function __resetKillProcessTreeForTest(): void {
  killProcessTree = defaultKillProcessTree;
}

/** Zero work-product blob — the `summary.json` fallback when classification
 *  failed before facts were computed (the classification-error path), so the
 *  summary still carries a well-typed `workProduct`. */
const EMPTY_WORK_PRODUCT: WorkProductFacts = {
  commitCount: 0,
  commitShas: [],
  filesChanged: [],
  diffstat: '',
  dirty: false,
  untracked: false,
  transitions: { tasksNewlyChecked: 0, tasksRemaining: 0, tasksAdded: 0, tasksRemoved: 0 },
};

type WorkRunPayload = {
  projectSlug: string;
  /**
   * Product key (matches an entry in `policies/products.json`). Defaults to
   * `'rune'` for back-compat with existing cockpit start paths that didn't
   * yet wire the product through. Cockpit's `handleApiMutations` should pass
   * the registry's product for the project so a future aura/assay work-run
   * targets the right repo.
   */
  product?: string;
};

export const workRunApplier: MutationApplier<WorkRunPayload> = {
  kind: 'work-run',
  autoApprove: true,

  validate(payload: WorkRunPayload): { ok: true } | { ok: false; reason: string } {
    const { projectSlug } = payload;
    if (!projectSlug || typeof projectSlug !== 'string') {
      return { ok: false, reason: 'projectSlug is required' };
    }
    // Both slugs are validated against VALID_SLUG (lowercase alnum/hyphen) — it
    // subsumes the path-separator/`..` traversal rejection and matches the
    // boundary guard gen-eval-loop-runner uses. projectSlug feeds findProjectDir
    // + the worktree path; product feeds getProductConfig + git ops via
    // runWorkRunGc.
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

    // Parked-run backstops (project 13, Phase 1b). A run that parked for a human
    // keeps its worktree live and holds the project slot — a new run for the
    // same slug must be rejected before it forks a second worktree on the
    // occupied deterministic path. Two independent checks:
    //   (a) a durable supervision `blocked-on-human` record for this
    //       product+project — the source of truth while a record survives, and
    //   (b) a synchronous existsSync on the deterministic worktree path — the
    //       crash-lost-record backstop (recovery relabels a lost record
    //       'unknown', so (a) misses it, but the worktree still occupies disk).
    // (b) is sync (no async `git worktree list`) so it fits this sync validate().
    const product = payload.product ?? 'rune';
    let parkedForSlug = false;
    try {
      parkedForSlug = readAllRuns(config.SUPERVISED_RUNS_FILE).some(
        (r) => r.status === 'blocked-on-human' && r.product === product && r.project === projectSlug,
      );
    } catch {
      // A supervision-store read failure must not block a legitimate run — the
      // existsSync backstop below still guards the occupied-path case.
    }
    if (parkedForSlug) {
      return { ok: false, reason: `parked (blocked-on-human) run exists for ${projectSlug}` };
    }
    if (existsSync(worktreePathFor(product, projectSlug, config.WORKTREE_ROOT))) {
      return { ok: false, reason: `worktree already exists for ${projectSlug}` };
    }

    // Per-project concurrency cap. The deterministic worktree path
    // (`<WORKTREE_ROOT>/<product>/<projectSlug>`) is single-occupant, so
    // cap=1 also keeps two runs from colliding on the same on-disk path.
    const runningForSlug = [...activeRuns.values()].filter(
      h =>
        // Count orchestrated-work too (project 14): both appliers use the SAME
        // deterministic per-project worktree path, so a legacy run must not
        // start while an orchestrated run owns that project's worktree.
        (h.descriptor.kind === 'work-run' || h.descriptor.kind === 'orchestrated-work') &&
        (h.descriptor.payload as WorkRunPayload).projectSlug === projectSlug &&
        ((h.descriptor.payload as WorkRunPayload).product ?? 'rune') === product &&
        h.descriptor.status === 'running',
    );
    if (runningForSlug.length >= config.WORK_RUN_PER_PROJECT_CAP) {
      return { ok: false, reason: `already running for ${projectSlug}` };
    }

    // Global cap. Count BOTH work-run and orchestrated-work runs (project 14):
    // the two appliers share one global budget, and the orchestrated applier
    // already counts both kinds — counting only 'work-run' here would let a
    // legacy run slip past the cap while orchestrated runs fill it.
    const globalRunning = [...activeRuns.values()].filter(
      h => h.descriptor.kind === 'work-run' || h.descriptor.kind === 'orchestrated-work',
    );
    if (globalRunning.length >= config.WORK_RUN_GLOBAL_CAP) {
      return { ok: false, reason: 'global work-run cap reached' };
    }

    return { ok: true };
  },

  async *apply(descriptor: MutationDescriptor<WorkRunPayload>, ctx: ApplyContext): AsyncIterable<MutationEvent> {
    const { projectSlug } = descriptor.payload;
    const product = descriptor.payload.product ?? 'rune';
    // Snapshot the classification/persist seam once per run so every artifact
    // path + git call reads a single consistent deps object (rather than
    // re-reading the module-level `runtimeDeps`, which a concurrent test reset
    // could swap mid-run).
    const deps = runtimeDeps;
    // Stable per-project branch so a later run for the same project RESUMES it
    // instead of re-forking off `main` and restarting from Phase 1 — the
    // re-fork bug in docs/projects/bugs.md. The per-project run cap of 1 keeps
    // a single run on the branch at a time.
    const branch = workBranchName(projectSlug);

    let sandbox: SandboxSpec | null = null;
    // Per-run durable transcript sink — created once the worktree exists, teed
    // during the stream, flushed before the terminal event, destroyed in the
    // outer finally (idempotent) so the fd never leaks on an abort.
    let sink: TranscriptSink | null = null;
    // Set true once the finalizer's `removeWorktree` effect tears the run
    // worktree down (gated-merge moves teardown ownership into the finalizer),
    // so the outer `finally` does NOT double-destroy it. Declared at this scope
    // so that `finally` can read it; the early-return setup-failure paths leave
    // it false, so the outer `finally` still owns teardown there.
    let finalizerOwnedTeardown = false;
    // Set true on a parsed blocked-on-human sentinel (project 13, Phase 1b). A
    // parked run keeps its worktree LIVE for a human, so the outer `finally`
    // must NOT destroy it (the release path later hands it to the finalizer or
    // discards it explicitly).
    let parked = false;
    try {
      try {
        // createWorktree resolves HEAD atomically and returns it on
        // sandbox.baseSha — the stable diff base (baseSha..branch) the Phase 2
        // classifier will compute work product against. Captured here; consumed
        // once the work-product/classify step lands.
        sandbox = await createWorktree({
          product,
          project: projectSlug,
          branch,
          worktreeRoot: config.WORKTREE_ROOT,
          productsConfigPath: config.PRODUCTS_CONFIG_FILE,
        });
      } catch (err) {
        // No worktree was created, so the outer finally's destroy is a
        // no-op (sandbox stays null). Surface the failure as a terminal
        // event so the mutation reaches a clean failed state.
        // Scrub host paths: createWorktree's error embeds the worktree path
        // (which carries the OS username), and this reason reaches Telegram +
        // mutations.jsonl. `projectSlug` lets the work-run formatter label the
        // run instead of degrading to the mutation-id prefix.
        yield term(descriptor.id, 'failed', {
          reason: scrubPathsInText(`worktree create failed: ${(err as Error).message}`),
          projectSlug,
        });
        return;
      }

      // Run-start notification (project 13, Phase 1a): now that the worktree
      // exists, surface its deterministic path + run id so the operator can
      // reach a live (or later parked) run in one step. `operatorWorktreePath`
      // is the RAW, UN-SCRUBBED worktree path on a LOCAL-OPERATOR-ONLY field —
      // it rides the bus to Telegram/cockpit (both local surfaces) but is never
      // copied onto the descriptor, so it can't leak into mutations.jsonl,
      // summaries/index, the transcript, forensics, or any committed artifact
      // (those stay scrubbed). Emitted only on the success path: the
      // createWorktree-failure branch above returns BEFORE this, so a run with
      // no worktree omits the field cleanly rather than emitting an empty path.
      yield startEvent(descriptor.id, {
        operatorWorktreePath: sandbox.worktree,
        runId: descriptor.id,
        projectSlug,
        product,
      });

      const dir = findWorkProjectDir(projectSlug, sandbox.worktree);
      if (!dir) {
        yield term(descriptor.id, 'failed', { reason: `project not found in worktree: ${projectSlug}`, projectSlug });
        return;
      }

      const specPath = join(dir, 'spec.md');
      const tasksPath = join(dir, 'tasks.md');

      let specContent: string;
      try {
        specContent = readFileSync(specPath, 'utf8');
      } catch {
        yield term(descriptor.id, 'failed', { reason: `could not read spec.md for ${projectSlug}`, projectSlug });
        return;
      }

      let tasksContent = '';
      try {
        if (existsSync(tasksPath)) tasksContent = readFileSync(tasksPath, 'utf8');
      } catch {
        // tasks.md is optional
      }

      // On a resume the worktree already holds the project's prior commits, so
      // tell the agent not to restart — the core symptom of the re-fork bug was
      // an agent reading an all-unchecked tasks.md and re-doing shipped phases
      // (docs/projects/bugs.md).
      if (sandbox.resumed) {
        log.info('work-runner: resuming existing work branch', { id: descriptor.id, projectSlug, branch });
      }
      const resumeNote = sandbox.resumed
        ? '\n\nNOTE: This is a RESUMED run — the project\'s prior commits are already ' +
          'present in this worktree. Do NOT restart from Phase 1. Continue from the first ' +
          'genuinely incomplete task, treating the committed files and tasks.md checkboxes ' +
          'as the source of truth for what is already done.'
        : '';
      const prompt = `${specContent}${tasksContent ? `\n\n${tasksContent}` : ''}${resumeNote}\n\n/work --auto`;
      const t0 = Date.now();

      // Open the durable transcript sink before spawning so every stream-json
      // envelope is teed to `<workRunsDir>/<id>/transcript.jsonl` regardless of
      // whether a cockpit drawer is open (requirement 11). A sink-creation
      // failure (e.g. the dir can't be made) must not abort the run — degrade
      // to no durable transcript and keep going.
      try {
        sink = deps.createSink(descriptor.id, deps.workRunsDir);
      } catch (err) {
        log.warn('work-runner: transcript sink creation failed; run continues without a durable transcript', {
          id: descriptor.id,
          error: (err as Error).message,
        });
        sink = null;
      }

      // cwd = sandbox.worktree (NOT PROJECT_ROOT) — the whole point of
      // Fix 1. Spawning into the live tree can trigger node --watch to SIGTERM
      // the parent when the agent edits Rune's own source files. The
      // worktree lives under `<WORKTREE_ROOT>/<product>/<project>`, outside
      // PROJECT_ROOT/src, so the dev watcher ignores it.
      //
      // The pre-worktree version passed `--add-dir docs/projects/<dirName>`
      // as a relative path; that worked because cwd was PROJECT_ROOT. The
      // worktree's HEAD already contains the project dir, so the flag is
      // redundant — dropped here.
      const child = spawn(CLAUDE_BIN, [
        // Headless `claude -p` has no one to answer permission prompts, so in
        // default mode every mutating tool (Edit/Write, git, npm/npx/vitest)
        // auto-denies — the run does its analysis, commits nothing, and
        // classifies `noop` (the 2026-06-01 silent run; docs/projects/bugs.md).
        // Mirror execClaude (claude.ts:227): the run is an isolated throwaway
        // worktree on a GC'd branch that cannot reach main, so skip-permissions
        // is scoped to a sandbox. It also lifts the working-dir containment so
        // the node_modules symlink createWorktree drops in resolves.
        '--dangerously-skip-permissions',
        ...getProjectMcpArgs(),
        // stream-json so every assistant turn and tool call lands on stdout as
        // a parseable envelope (requirement 10). The consumer below converts
        // each envelope to a human-readable `output` event via the adapter.
        '--output-format', 'stream-json', '--verbose',
        '-p', prompt,
      ], {
        cwd: sandbox.worktree,
        // Own process group (child is the leader) so `killProcessTree` can reap
        // orphaned grandchildren — a hung `vitest` that holds the inherited
        // stdio open and otherwise wedges the run open (docs/projects/bugs.md).
        // NOT unref'd: we still manage and reap this child.
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          RUNE_PROJECT_ROOT: PROJECT_ROOT,
          ...(config.WORKSPACE_DIR ? { RUNE_WORKSPACE_DIR: config.WORKSPACE_DIR } : {}),
        },
      });

      registerActiveProcess(child);
      try {
        // Drive streamProcess manually so we capture its RETURN value (exit
        // facts + ring buffer + stderr tail) — `for await` / `yield*` discard a
        // generator's return. streamProcess now yields only non-terminal events
        // (output/log/keep-alive) and hands back the facts; apply() owns the
        // single terminal event. `it.return()` in finally propagates an early
        // consumer-abort into streamProcess's cleanup, matching `yield*`.
        // Parent-side commit poll (requirement 22) — enabled only when a base
        // sha was captured (so the `baseSha..branch` range is valid). The poll
        // emits throttled `progress` events as the run lands commits.
        const commitPoll: CommitPollConfig | null = sandbox.baseSha
          ? {
              runGit: deps.runGit,
              cwd: sandbox.worktree,
              baseSha: sandbox.baseSha,
              branch,
              tasksPath,
              pollIntervalMs: COMMIT_POLL_INTERVAL_MS,
              throttleMs: COMMIT_PING_THROTTLE_MS,
            }
          : null;
        const it = streamProcess(child, descriptor.id, ctx, t0, sink, commitPoll);
        let step = await it.next();
        try {
          while (!step.done) {
            yield step.value;
            step = await it.next();
          }
        } finally {
          // `step.done` is true only on normal completion; if the loop exited
          // via an early consumer-abort it is still false. Propagate that abort
          // into streamProcess's cleanup (clearInterval keep-alive ticker),
          // matching `yield*` — but not on normal completion, which would
          // needlessly re-enter its finally and add a microtask tick.
          if (!step.done) await it.return?.(undefined as never);
        }
        // Only reached on normal completion (an abort propagates out through
        // the finally above); the guard also narrows step.value to StreamResult.
        if (!step.done) throw new Error('work-runner: stream ended without exit facts');
        const streamResult = step.value;

        // --- Parked branch (project 13, Phase 1b) ---
        // The run emitted a valid RUNE_WORK_RUN_SENTINEL — it hit a step
        // `--auto` can't take and needs a human. PARK it: write the durable
        // supervision `blocked-on-human` record FIRST (before any terminal step,
        // so a crash can't strand a `running` record that recovery would
        // finalize and reap), then SKIP `runFinalizer` entirely (its shared tail
        // would remove the worktree) and yield a terminal mutation event. The
        // worktree is left LIVE; the outer `finally` skips teardown via `parked`.
        // The mutation still terminates normally (no new MutationStatus); the
        // parked terminal event carries `parked: true` so mutations.ts reasserts
        // supervision as `blocked-on-human` rather than completed/failed.
        //
        // A user/actuator cancel OVERRIDES a park: if the run was cancelled
        // (ctx.cancel — the cockpit/Telegram `/cancel`, the quiet→cancel and
        // max-runtime backstops all route through it), the human's explicit
        // "stop this" wins over a sentinel the agent happened to print on its
        // way down. That run flows through the ordinary classifier/finalizer
        // (which tears the worktree down) instead of parking.
        if ((streamResult.sentinel || streamResult.askUserQuestion) && !streamResult.exit.cancelled) {
          parked = true;
          const askedAt = new Date().toISOString();
          const parkedQuestion: WorkRunParkedQuestion | undefined = streamResult.askUserQuestion
            ? {
                source: 'ask-user-question',
                question: streamResult.askUserQuestion.question,
                options: streamResult.askUserQuestion.options,
                ...(streamResult.askUserQuestion.toolUseId ? { toolUseId: streamResult.askUserQuestion.toolUseId } : {}),
                askedAt,
              }
            : undefined;
          const pendingCheck = streamResult.sentinel
            ? streamResult.sentinel.pendingCheck
            : parkedQuestion
              ? pendingCheckForQuestion(streamResult.askUserQuestion!)
              : 'human input required';
          // 1. Durable parked record FIRST. Best-effort (a disk failure logs but
          //    never denies the park) — mutations.ts's terminal override is the
          //    second writer that re-asserts blocked-on-human regardless.
          try {
            upsertRun(
              {
                id: descriptor.id,
                product,
                project: projectSlug,
                status: 'blocked-on-human',
                startedAt: new Date(t0).toISOString(),
                // Park time = the nudge baseline isParkedRun ages from.
                lastHeartbeatAt: new Date().toISOString(),
                ...(parkedQuestion ? { parkedQuestion } : {}),
              },
              config.SUPERVISED_RUNS_FILE,
            );
          } catch (err) {
            log.warn('work-runner: parked supervision write failed', {
              id: descriptor.id,
              error: (err as Error).message,
            });
          }
          // 2. Flush the durable transcript best-effort so the human can read the
          //    run that led to the park (the finalizer normally owns this flush;
          //    we skip the finalizer here).
          if (sink) {
            try {
              await sink.finish();
            } catch (err) {
              log.warn('work-runner: parked transcript flush failed', {
                id: descriptor.id,
                error: (err as Error).message,
              });
            }
          }
          // 3. Yield the parked terminal. `operatorWorktreePath` is the
          //    UN-SCRUBBED live worktree (same local-operator field as the
          //    Phase 1a start event) — never copied onto the descriptor, so it
          //    can't reach mutations.jsonl. `pendingCheck`/`command`/`reason`
          //    come from the sentinel; the parked-aware Telegram/cockpit branch
          //    renders them. The mutation terminates `completed` (the child
          //    exited cleanly to report the block); `parked: true` is what keeps
          //    supervision at blocked-on-human.
          const parkedData: Record<string, unknown> = {
            parked: true,
            operatorWorktreePath: sandbox.worktree,
            pendingCheck,
            projectSlug,
            product,
          };
          if (parkedQuestion) parkedData['parkedQuestion'] = parkedQuestion;
          if (streamResult.askUserQuestion?.malformed) {
            parkedData['reason'] = 'AskUserQuestion payload could not be parsed; inspect transcript.';
          }
          if (streamResult.sentinel?.command) parkedData['command'] = streamResult.sentinel.command;
          if (streamResult.sentinel?.reason) parkedData['reason'] = streamResult.sentinel.reason;
          yield term(descriptor.id, 'completed', parkedData);
          return;
        }

        // Classify on the WORK PRODUCT (commits + tasks.md delta + tree state),
        // not the exit code, and persist the run's artifacts BEFORE emitting the
        // terminal event: startApply publishes/persists and the outer finally
        // destroys the worktree the moment a terminal event is seen
        // (mutations.ts), so the git reads + transcript flush + summary.json
        // write must all complete first (requirements 8 & 13).
        //
        // The final tasks.md is the post-run (mutated) file in the worktree —
        // NOT the in-memory baseline (`tasksContent`) captured at spawn.
        let finalTasks = '';
        try {
          if (existsSync(tasksPath)) finalTasks = readFileSync(tasksPath, 'utf8');
        } catch {
          // tasks.md unreadable post-run — treat as empty (transitions fall back
          // to commit count + tree state, per the spec's absent-tasks.md rule).
        }

        // Bind the worktree facts to consts: `sandbox` is a reassignable `let`,
        // so TS widens it back to nullable inside the async `computeFacts`
        // closure — but it is guaranteed non-null here (the create-failure path
        // returned early above).
        const worktreeDir = sandbox.worktree;
        const baseSha = sandbox.baseSha ?? '';

        // --- Gated-merge facts (Phase 3.5) ---
        // The product config carries the base branch a clean run lands on, the
        // repo whose `main` the merge mutates, and the validation commands the
        // gate runs. `createWorktree` already resolved the same product config
        // above, so this read normally cannot fail — but products.json could be
        // deleted/corrupted in the interim, and an unhandled throw here would
        // bypass the finalizer (no summary/index/teardown). Degrade instead: a
        // fail-closed fallback (no validationCommands → gate returns
        // `missing-validation-command` → the run HOLDS at branch-complete, never
        // a stray merge).
        let baseBranch = 'main';
        let repoPath = '';
        let validationCommands: string[] = [];
        try {
          const productConfig = getProductConfig(product, config.PRODUCTS_CONFIG_FILE);
          baseBranch = productConfig.baseBranch;
          repoPath = productConfig.repoPath;
          validationCommands = productConfig.validationCommands ?? [];
        } catch (err) {
          log.warn('work-runner: product config unreadable at finalize; gate will fail closed', {
            id: descriptor.id,
            product,
            error: scrubPathsInText((err as Error).message),
          });
        }
        // Pre-gathered concurrency fact for the gate: another work-run owns the
        // same product right now (its branch could be based on a `main` this
        // merge is about to move). Read LIVE inside the gate closure (below) so
        // it reflects the moment the gate runs, not a stale finalize-setup
        // snapshot. The per-base-branch lock serializes the gate; this fact is
        // the separate ownership signal (gate req 14) and fails toward HOLD.
        const hasConcurrentRun = (): boolean =>
          [...activeRuns.values()].some(
            h =>
              h.descriptor.kind === 'work-run' &&
              h.descriptor.id !== descriptor.id &&
              ((h.descriptor.payload as WorkRunPayload).product ?? 'rune') === product &&
              h.descriptor.status === 'running',
          );
        // Throwaway integration worktree the gate creates + tears down to test
        // `main` BEFORE it is mutated (never the product's real checkout). The
        // run id is a randomUUID (VALID_SLUG-shaped), safe as a path segment.
        const integrationWorktree = join(config.WORKTREE_ROOT, `gate-${product}-${descriptor.id}`);
        // Original tasks still unchecked, captured from the classified work
        // product so the gate (which runs after classify) sees the real value;
        // a branch-complete run is 0 by definition, but capture it rather than
        // assume so a misclassification can't slip a non-zero past the gate.
        let gateTasksRemaining = 0;
        // Set by the gate-fail `alert` effect so the yielded terminal event can
        // surface WHY a branch-complete run was held off main (never a silently-
        // dropped alert) on the Telegram/cockpit notification surface.
        let gateHeldReason: GateFailReason | null = null;

        // Single end timestamp shared by summary.json + the index row. Captured
        // inside the `classify` effect (when classification actually completes)
        // rather than here, so it reflects the run's true end — not the instant
        // BEFORE the multi-second git classification.
        let endedAt = '';

        // Route the terminal sequence through the shared, idempotent finalizer
        // (project 15) in `gated-merge` mode (Phase 3.5 — live activation):
        // classify on work product → flush transcript → write summary + index →
        // [branch-complete + gate green: merge → push → remove worktree → delete
        // branch] → terminal write. This is the SINGLE live terminal owner; the
        // failure/partial/cancelled paths flow through the SAME machine that
        // recovery uses, keeping the §7 guarantees (always flush + summary,
        // never merge, branch retained, never left `running`) because
        // `runGatedMerge` merges ONLY a branch-complete run behind the hard gate
        // and holds every other outcome through the non-merge tail.
        //
        // `writeSupervisionTerminal` stays inert: mutations.ts owns the terminal
        // supervision write, driven by the terminal event apply() yields below —
        // the finalizer must not double-write it in the live path (recovery,
        // which has no generator to yield, uses a real write).
        const effects: FinalizerEffects = {
          classify: async () => {
            const ev = await finalizeWorkRun({
              mutationId: descriptor.id,
              computeFacts: async () => ({
                exit: streamResult.exit,
                product: await computeWorkProduct({
                  runGit: deps.runGit,
                  cwd: worktreeDir,
                  baseSha,
                  branch,
                  baselineTasks: tasksContent,
                  finalTasks,
                }),
              }),
              // Export the forensic evidence bundle into the per-run dir while
              // the worktree still exists (the outer `finally` destroys it only
              // after the terminal event yields). `facts` is null on the
              // classification-error path — capture everything best-effort
              // (treat as non-clean). finalizeWorkRun wraps this call in its own
              // try/catch, so a forensics failure never denies the terminal event.
              exportForensics: async (facts) => {
                await deps.runForensics({
                  runGit: deps.runGit,
                  worktree: worktreeDir,
                  outDir: join(deps.workRunsDir, descriptor.id),
                  baseSha,
                  branch,
                  nonClean: facts ? facts.product.dirty || facts.product.untracked : true,
                });
              },
            });
            // Augment the classified terminal event with the run's identity so
            // downstream surfaces (TelegramSender's work-run formatter, the
            // cockpit bus frame) can label it by project — finalizeWorkRun only
            // knows the mutation id, not the slug.
            const augmentedData = (ev.data ?? {}) as Record<string, unknown>;
            augmentedData['projectSlug'] = projectSlug;
            augmentedData['product'] = product;
            ev.data = augmentedData;
            // Capture the real tasks-remaining count for the gate (which runs
            // after classify). Branch-complete is 0 by definition; reading the
            // computed value rather than assuming keeps the gate honest.
            const wp = augmentedData['workProduct'] as WorkProductFacts | undefined;
            gateTasksRemaining = wp?.transitions.tasksRemaining ?? 0;
            // Classification is done — stamp the shared end timestamp now (the
            // summary + index effects below close over it).
            endedAt = new Date().toISOString();
            return ev;
          },
          // Flush + await the durable transcript's `finish` so every buffered
          // event is on disk before summary.json. A flush failure is logged (and
          // surfaced via the stderr tail upstream) but never denies the terminal.
          flushTranscript: async () => {
            if (!sink) return;
            try {
              await sink.finish();
            } catch (err) {
              log.warn('work-runner: transcript flush failed', {
                id: descriptor.id,
                error: (err as Error).message,
              });
            }
          },
          // Persist summary.json atomically (best-effort): a disk failure must
          // not deny the terminal event, which is the classification's source of
          // truth.
          writeSummary: (ev) => {
            const summary = buildSummary({
              id: descriptor.id,
              project: projectSlug,
              product,
              branch,
              baseSha,
              t0,
              exit: streamResult.exit,
              terminalEvent: ev,
              sink,
              workRunsDir: deps.workRunsDir,
              endedAt,
            });
            try {
              deps.writeSummary(join(deps.workRunsDir, descriptor.id), summary);
            } catch (err) {
              log.warn('work-runner: writeSummary failed', {
                id: descriptor.id,
                error: (err as Error).message,
              });
            }
          },
          // Append the rolling index row (best-effort — a failure here must not
          // deny the terminal event). The reader (readRecentIndex) tolerates a
          // torn trailing line, so a crash mid-append is recoverable. The
          // outcome is read off the classified terminal event (mirrors
          // buildSummary's read).
          appendIndexRow: (ev) => {
            try {
              deps.appendIndexRow(deps.workRunsIndexFile, {
                id: descriptor.id,
                project: projectSlug,
                outcome: readOutcome(ev),
                durationMs: streamResult.exit.durationMs,
                startedAt: new Date(t0).toISOString(),
                endedAt,
              });
            } catch (err) {
              log.warn('work-runner: appendIndexRow failed', {
                id: descriptor.id,
                error: (err as Error).message,
              });
            }
          },
          // Real teardown (Phase 3.5): the finalizer owns worktree removal in
          // gated-merge mode — it removes the run worktree AFTER merge+push and
          // BEFORE branch delete (`git branch -d` refuses a checked-out branch).
          // Setting the flag AFTER a successful destroy lets the outer `finally`
          // retry if this throws, and skip if it succeeds (no double-destroy).
          removeWorktree: async () => {
            // `sandbox` is non-null here by construction — the createWorktree
            // early-return path yields a terminal and returns before `effects`
            // is built — but narrow it for TS and as a defensive guard. Set the
            // ownership flag only AFTER a successful destroy so a throw leaves it
            // false and the outer `finally` retries (no leak, no double-destroy).
            if (!sandbox) return;
            await destroyWorktree(sandbox, {
              productsConfigPath: config.PRODUCTS_CONFIG_FILE,
              worktreeRoot: config.WORKTREE_ROOT,
            });
            finalizerOwnedTeardown = true;
          },
          // Supervision is still owned by mutations.ts on the yielded terminal
          // event (apply() yields it below) — the finalizer must not double-write
          // it in the live path. Inert here; recovery uses a real write.
          writeSupervisionTerminal: () => {},
          // Durable resume checkpoints (Phase 3.5): best-effort per-run phase
          // store so a crash mid-gated-merge resumes at the right step. A fresh
          // live run has no prior phase, so readLastPhase returns null today —
          // the value matters when recovery re-drives a crashed run.
          recordPhase: (phase) => deps.recordWorkRunPhase?.(descriptor.id, phase),
          readLastPhase: () => deps.readLastWorkRunPhase?.(descriptor.id) ?? null,
          // --- gated-merge effects (Phase 3.5) ---
          // The hard gate runs INSIDE the per-product/per-base-branch lock so two
          // projects sharing one `main` serialize (req 14); the gate itself tests
          // `main` in a throwaway integration worktree, never the real checkout.
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
                // Live read inside the lock — accurate at gate time, not a stale
                // finalize-setup snapshot.
                concurrentRun: hasConcurrentRun(),
                commandTimeoutMs: config.WORK_RUN_GATE_COMMAND_TIMEOUT_MS,
                validationArtifactsDir: join(config.WORK_RUNS_DIR, descriptor.id, 'validation-diagnostics'),
              }),
            ),
          // Gate refused → the run holds at branch-complete off `main`. Never a
          // silent drop. (Task 4 enriches this into a Telegram/cockpit alert.)
          alert: (reason: GateFailReason) => {
            // Record the reason so the yielded terminal event surfaces it on the
            // operator notification surface (Telegram/cockpit), not just the log.
            gateHeldReason = reason;
            log.warn('work-run held at branch-complete: gate failed', {
              id: descriptor.id,
              projectSlug,
              product,
              branch,
              reason,
            });
          },
          // Decomposed merge/push/delete (reusing gen-eval-loop's realMergeBranch
          // git logic) through the injected runGit seam so they are observable in
          // tests. Push BEFORE delete (the finalizer records the durable
          // checkpoints between them); delete is best-effort.
          mergeBranch: async () => {
            const message = `rune(${product}): merge work-run branch ${branch}`;
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
              // Explicit remote + refspec so the push target is independent of
              // the repo's `push.default` / upstream-tracking config (a bare
              // `git push` can silently no-op on a repo without a tracking ref).
              await deps.runGit(['push', 'origin', baseBranch], { cwd: repoPath });
            } catch (err) {
              // Half-merged state: local base branch has the merge but origin is
              // behind. The finalizer has recorded `merged-not-pushed`, so a
              // recovery resume completes the push. Surface (redacted) which repo
              // needs attention; the credential URL in a push error never logs raw.
              log.warn('work-runner: git push failed after local merge — repo is half-merged', {
                product,
                branch,
                error: redactSecrets((err as Error).message),
              });
              throw new Error(redactSecrets(`git push failed: ${(err as Error).message}`));
            }
          },
          deleteBranch: async () => {
            // Let a git failure throw: the finalizer's `onBranchDelete` guard
            // (resolveWorktreeAndFinalize) is the single canonical safety net —
            // it logs the failure and leaves `branchDeleted` false (accurate:
            // the branch is a redundant tracking ref the GC prunes later) WITHOUT
            // denying the terminal (the merge + push already landed).
            await deps.runGit(['branch', '-d', branch], { cwd: repoPath });
          },
          onLanded: () => {
            refreshRegistryAfterLanding(deps, {
              runId: descriptor.id,
              projectSlug,
              product,
            });
          },
        };

        // Always route through `gated-merge` mode: `runGatedMerge` merges ONLY a
        // branch-complete run (behind the hard gate) and HOLDS every other
        // outcome (partial/noop/dirty/failed) through the same non-merge tail —
        // so failure/partial/cancelled runs keep the §7 guarantees (flush +
        // summary, never merge, branch retained, never left `running`) while a
        // clean, complete, gate-passing run lands on `main`.
        const result = await runFinalizer(
          { mode: 'gated-merge', runId: descriptor.id, project: projectSlug, product, branch, baseBranch },
          effects,
        );

        // Stamp the gated-merge DISPOSITION onto the terminal event so the
        // operator surfaces (TelegramSender's formatWorkRunTerminal, the cockpit)
        // render `merged to main` / `held off main: <reason>` rather than a bare
        // branch-complete — and re-write summary.json with merged/branchDeleted
        // now that the finalizer has resolved them (the finalizer's own
        // writeSummary ran BEFORE the merge, so it couldn't carry them). The
        // disposition keys are only meaningful for a branch-complete run; a held
        // run carries `merged:false` + the gate reason, never a silent drop.
        const termData = (result.terminalEvent.data ?? {}) as Record<string, unknown>;
        if (readOutcome(result.terminalEvent) === 'branch-complete') {
          termData['merged'] = result.merged;
          termData['branchDeleted'] = result.branchDeleted;
          // Stamp the base branch so the formatter renders "merged to <base>"
          // correctly for a non-`main` product (defaults to `main` if absent).
          termData['baseBranch'] = baseBranch;
          if (!result.merged && gateHeldReason) termData['gateHeldReason'] = gateHeldReason;
          // Reassign covers the `data === null/undefined` case; on the normal
          // path termData aliases the existing object and the mutations above
          // already took.
          result.terminalEvent.data = termData;
          // Best-effort summary re-write with the resolved disposition (a disk
          // failure must not deny the terminal — mirrors the finalizer's own
          // best-effort writeSummary).
          try {
            deps.writeSummary(
              join(deps.workRunsDir, descriptor.id),
              buildSummary({
                id: descriptor.id,
                project: projectSlug,
                product,
                branch,
                baseSha,
                t0,
                exit: streamResult.exit,
                terminalEvent: result.terminalEvent,
                sink,
                workRunsDir: deps.workRunsDir,
                endedAt,
                merged: result.merged,
                branchDeleted: result.branchDeleted,
                baseBranch,
                gateHeldReason: !result.merged && gateHeldReason ? gateHeldReason : undefined,
              }),
            );
          } catch (err) {
            log.warn('work-runner: post-finalize summary re-write failed', {
              id: descriptor.id,
              error: (err as Error).message,
            });
          }
        }

        // The finalizer surfaces the classified terminal event on its result.
        // Yield it (disposition-augmented) so mutations.ts persists the mutation
        // log + drives the terminal supervision write.
        yield result.terminalEvent;
      } finally {
        unregisterActiveProcess(child);
        log.info('work-run finished', { projectSlug, durationMs: Date.now() - t0 });
      }
    } finally {
      // Close the transcript fd. Idempotent and non-throwing: on the normal
      // path finish() already flushed + ended the stream, so this is a no-op;
      // on an abort path (run died before finalize) it frees the fd that
      // finish() never reached.
      sink?.destroy();
      // Tear down the worktree if we created one AND the finalizer didn't
      // already own its teardown. Success, failure, cancel, and
      // generator-consumer-abort all flow through here. In `gated-merge` mode
      // the finalizer's `removeWorktree` effect removes the worktree (AFTER
      // merge/push, BEFORE branch delete) and sets `finalizerOwnedTeardown`, so
      // this `finally` must skip it or it would double-destroy. The flag stays
      // false on every path where the finalizer never reached removeWorktree —
      // early-return setup failures, consumer aborts, a crash mid-merge — so the
      // outer `finally` still owns teardown there (and a removeWorktree that
      // threw leaves the flag false too, letting this retry).
      // `parked` (project 13, Phase 1b): a parked run keeps its worktree LIVE
      // for a human, so teardown is skipped here entirely — the release path
      // (Phase 1c) is the only thing that later removes or discards it.
      if (sandbox && !finalizerOwnedTeardown && !parked) {
        try {
          await destroyWorktree(sandbox, {
            productsConfigPath: config.PRODUCTS_CONFIG_FILE,
            worktreeRoot: config.WORKTREE_ROOT,
          });
        } catch (err) {
          log.warn('work-runner: destroyWorktree failed', {
            sandbox: sandbox.worktree,
            error: (err as Error).message,
          });
        }
      }
      // Prune retained work-run artifacts over the retention caps now that this
      // run is terminal. Sweeps ALL products (not just this run's) — the dir
      // retention is global and branch pruning is per-repo. Fire-and-forget +
      // best-effort (runWorkRunGc swallows its own errors). This run's own dir is
      // still protected here — its mutation id is in activeRuns until startApply's
      // finally — so a freshly completed run is never GC'd by its own pass.
      void runWorkRunGc();
    }
  },
};

/** Exit facts (consumed by the Phase 2 classifier) plus the last-N stdout ring
 *  buffer and stderr tail. The ring buffer + stderr tail ride along for the
 *  Phase 3 forensics export (which will run `stderrTail` through
 *  `redactSecrets` at the persistence boundary); apply() reads only `exit`
 *  today. */
interface StreamResult {
  exit: ExitFacts;
  ringBuffer: string[];
  stderrTail: string[];
  /** Project 13, Phase 1b — the blocked-on-human sentinel parsed from the raw
   *  `result`/`assistant` envelope text (before display scrubbing), or null if
   *  the run emitted none. The LAST valid sentinel wins. apply() reads this to
   *  decide whether to PARK the run. */
  sentinel: WorkRunSentinel | null;
  /** Parsed Claude AskUserQuestion tool_use, if the run asked for operator input. */
  askUserQuestion: ParsedAskUserQuestion | null;
}

/** Extract the raw (un-scrubbed) text a sentinel could ride on from a stream
 *  envelope: a `result` envelope's `result` string, or an `assistant`
 *  envelope's concatenated text blocks. Other envelope types carry no
 *  agent-final text. Raw on purpose — the sentinel must be matched BEFORE
 *  `scrubPathsInText` rewrites a `command` path. */
function envelopeSentinelText(envelope: StreamJsonEnvelope): string | null {
  if (envelope.type === 'result') {
    return typeof envelope['result'] === 'string' ? envelope['result'] : null;
  }
  if (envelope.type === 'assistant') {
    const message = envelope['message'];
    if (!message || typeof message !== 'object') return null;
    const content = (message as Record<string, unknown>)['content'];
    if (!Array.isArray(content)) return null;
    const parts: string[] = [];
    for (const block of content) {
      if (block && typeof block === 'object') {
        const b = block as Record<string, unknown>;
        if (b['type'] === 'text' && typeof b['text'] === 'string') parts.push(b['text']);
      }
    }
    return parts.length > 0 ? parts.join('\n') : null;
  }
  return null;
}

/** Bound on the retained last-N stdout display lines and stderr tail. */
const RING_CAPACITY = 50;

/** Once the agent process exits, how long to let its stdio close on its own
 *  before escalating SIGTERM→SIGKILL to the (possibly orphaned) process group,
 *  and a hard ceiling after which the run force-completes even if `close` never
 *  fires — so a grandchild holding the pipes open can no longer wedge the run
 *  open for hours (docs/projects/bugs.md). The SIGTERM→SIGKILL grace is the
 *  project-15 `WORK_RUN_REAP_GRACE_MS` config constant. */
const REAP_SIGKILL_MS = config.WORK_RUN_REAP_GRACE_MS;
const REAP_FORCE_DONE_MS = 10_000;

/** Terminal-result watchdog window (project 15, P0.2): after the agent emits a
 *  terminal `result` envelope, wait this long for the child to exit on its own
 *  before reaping the process group. The child is NEVER killed on `result`
 *  itself (that would re-introduce the false `failed` the 2026-06-04 fix
 *  removed) — only if it wedges past the drain window. */
const TERMINAL_DRAIN_MS = config.WORK_RUN_TERMINAL_DRAIN_MS;

/** Inputs for the parent-side commit poll that runs during the stream
 *  (requirement 22). Null disables the poll (e.g. no captured baseSha, or a
 *  unit test that doesn't exercise it). */
interface CommitPollConfig {
  runGit: GitRunner;
  /** Worktree dir — cwd for the `git log` poll. */
  cwd: string;
  baseSha: string;
  branch: string;
  /** tasks.md path in the worktree, re-read each poll for the running tally. */
  tasksPath: string;
  pollIntervalMs: number;
  throttleMs: number;
}

async function* streamProcess(
  child: ReturnType<typeof spawn>,
  mutationId: string,
  ctx: ApplyContext,
  t0: number,
  sink: TranscriptSink | null,
  commitPoll: CommitPollConfig | null,
): AsyncGenerator<MutationEvent, StreamResult> {
  const queue: MutationEvent[] = [];
  let done = false;
  let resolveWaiter: (() => void) | null = null;
  let cancelSent = false;
  // Who initiated the cancel, captured when the SIGTERM is sent. A user cancel
  // is terminal-fail; a system backstop reap (quiet→cancel / max-runtime) is
  // classified on work product. Defaults to 'user' (the cockpit/`/cancel`
  // surface) so a context without `cancelReason` keeps the old behavior.
  let cancelKind: CancelReason = 'user';
  let exitCode: number | null = null;
  let exitSignal: string | null = null;
  let reapStarted = false;
  let reapSigkillTimer: ReturnType<typeof setTimeout> | null = null;
  let reapForceTimer: ReturnType<typeof setTimeout> | null = null;

  // Terminal-result watchdog (P0.2). `terminalResultSeen` flips when the agent
  // emits a `result` envelope; `drainTimer` is the bounded grace before the
  // watchdog reaps a wedged (never-exiting) child; `reapedAfterTerminalResult`
  // records that the reap was the watchdog's (an internal post-result reap),
  // distinct from a user-cancel or an external kill, so the classifier reads a
  // clean+complete branch as `branch-complete` rather than `failed`.
  // `exitFired` / `closeFired` let the final exit-fact derivation tell a clean
  // self-exit from a stdio-wedged one.
  let terminalResultSeen = false;
  let reapedAfterTerminalResult = false;
  let exitFired = false;
  let closeFired = false;
  let drainTimer: ReturnType<typeof setTimeout> | null = null;

  // Last-N stdout display lines + stderr tail, retained for the terminal
  // classification/forensics (independent of what the drawer consumed).
  const stdoutRing = createRingBuffer<string>(RING_CAPACITY);
  const stderrTail = createRingBuffer<string>(RING_CAPACITY);

  // Project 13, Phase 1b — the blocked-on-human sentinel, parsed from the raw
  // result/assistant envelope text as the stream flows. The terminal `result`
  // envelope is AUTHORITATIVE (the SKILL.md contract pins the sentinel to the
  // agent's final message): once a `result` envelope is seen, its parse result
  // (sentinel OR null) wins and overwrites any earlier `assistant`-turn match —
  // so an intermediate turn that merely QUOTES the sentinel format in its
  // reasoning can't force a false park when the run actually finished clean.
  // `assistant`-turn matches are a FALLBACK only for a run that dies before a
  // `result` envelope ever arrives.
  let sentinel: WorkRunSentinel | null = null;
  let resultSentinelDecided = false;
  let askUserQuestion: ParsedAskUserQuestion | null = null;

  function enqueue(event: MutationEvent) {
    queue.push(event);
    const r = resolveWaiter;
    resolveWaiter = null;
    r?.();
  }

  function evt(kind: MutationEvent['kind'], data: Record<string, unknown>): MutationEvent {
    return { mutationId, ts: new Date().toISOString(), kind, data };
  }

  function waitForNext(): Promise<void> {
    if (queue.length > 0 || done) return Promise.resolve();
    return new Promise(r => { resolveWaiter = r; });
  }

  // Child-process liveness ticker. Emits a `keep-alive` MutationEvent every
  // 30s so the supervision store's `lastChildAliveAt` stays fresh even when
  // Claude is mid-LLM-call with no stdout for minutes. See
  // src/transport/mutations.ts for the matching throttle gate; see
  // src/intent/supervision.ts (isStalled) for why this distinct signal
  // exists. `.unref()` so the timer can't hold the process open past
  // shutdown if the close handler somehow doesn't fire.
  const keepAliveTicker = setInterval(() => {
    enqueue(evt('keep-alive', {}));
  }, 30_000);
  keepAliveTicker.unref();

  // Parent-side commit poll (requirement 22). Every `pollIntervalMs` it lists
  // commits on `baseSha..branch` + reads the running tasks.md tally, and
  // `planCommitProgress` decides whether to enqueue a throttled `progress`
  // event (the latest commit subject + X/Y tasks) — never one per task. State
  // (last-seen SHA + last ping time) lives in this closure. Best-effort: a git
  // failure is swallowed so a transient error never disrupts the stream.
  let commitState: CommitPollState = { lastSeenSha: null, lastPingAt: 0 };
  async function runCommitPoll(cfg: CommitPollConfig): Promise<void> {
    try {
      const { stdout } = await cfg.runGit(
        ['log', `${cfg.baseSha}..${cfg.branch}`, '--format=%H %s'],
        { cwd: cfg.cwd },
      );
      const commits = stdout
        .split('\n')
        .filter(Boolean)
        .map(line => {
          const sp = line.indexOf(' ');
          return sp === -1
            ? { sha: line, subject: '' }
            : { sha: line.slice(0, sp), subject: line.slice(sp + 1) };
        });
      let tasksContent = '';
      try {
        // Sync read of a small bounded tasks.md. The worktree lives under
        // <PROJECT_ROOT>/.worktrees (a normal repo, NOT the iCloud-synced
        // vault), so this never hits an iCloud placeholder; the cost is sub-ms.
        tasksContent = readFileSync(cfg.tasksPath, 'utf8');
      } catch {
        /* tasks.md unreadable this tick — tally falls back to 0/0 */
      }
      const tasks = parseTasks(tasksContent);
      const tally = { done: tasks.filter(t => t.checked).length, total: tasks.length };
      const result = planCommitProgress({
        state: commitState,
        commits,
        taskTally: tally,
        now: Date.now(),
        throttleMs: cfg.throttleMs,
      });
      commitState = result.nextState;
      // Scrub host paths from the (LLM-authored) commit subject before it rides
      // the bus to Telegram/cockpit — same treatment as the transcript + the
      // classification-error reason.
      if (result.ping) enqueue(evt('progress', { line: scrubPathsInText(result.message) }));
    } catch {
      /* best-effort poll — a transient git error must not disrupt the stream */
    }
  }
  // Re-entrancy guard: the poll is async (awaits git). If a `git log` runs long
  // (slow/contended worktree) the next tick must not start a second pass that
  // races the first on `commitState` (a double ping / clobbered state).
  let pollInFlight = false;
  const commitTicker = commitPoll
    ? setInterval(() => {
        if (pollInFlight) return;
        pollInFlight = true;
        void runCommitPoll(commitPoll).finally(() => { pollInFlight = false; });
      }, commitPoll.pollIntervalMs)
    : null;
  commitTicker?.unref();

  let stdoutBuf = '';
  let stderrBuf = '';

  // Convert one newline-delimited stream-json line to events. A parseable
  // envelope becomes a human-readable `output` event (drawer back-compat); a
  // blank line is ignored; a malformed/partial line is routed to the `log`
  // (stderr-tail) path so it never crashes the run and never reads as agent
  // output. Phase 2 tees the raw envelope to the durable transcript here too.
  function emitStdoutLine(line: string) {
    if (!line.trim()) return; // blank separator line between envelopes — drop silently
    const envelope = parseStreamJsonLine(line);
    if (!envelope) {
      // Malformed/partial JSON or a non-envelope banner — route to the log
      // (stderr-tail) path tagged 'stdout' to preserve provenance, so it never
      // crashes the run and never reads as agent output.
      enqueue(evt('log', { line, stream: 'stdout' }));
      return;
    }
    // Tee the raw parsed envelope to the durable transcript (requirement 11),
    // independent of what the drawer renders. Fire-and-forget: sink.finish()
    // (called at finalize) flushes all buffered writes via stream.end(), so a
    // synchronously-issued write is never lost. A write error is recorded on
    // the stderr tail rather than crashing the run (spec: "transcript write
    // fails -> record on the stderr tail, do not crash the run").
    void sink?.append(envelope).catch((err: Error) => {
      stderrTail.push(`[transcript] append failed: ${err.message}`);
    });
    // Project 13, Phase 1b — scan the RAW envelope text for the blocked-on-human
    // sentinel BEFORE display scrubbing (a `command` path in the sentinel must
    // survive intact for the operator). apply() reads `streamResult.sentinel` to
    // decide whether to park. The terminal `result` envelope is authoritative:
    // its parse (sentinel or null) is final and ignores later input; an
    // `assistant`-turn match is a fallback recorded only until a `result` lands.
    if (envelope.type === 'result') {
      sentinel = parseWorkRunSentinel(envelopeSentinelText(envelope) ?? '');
      resultSentinelDecided = true;
    } else if (!resultSentinelDecided) {
      const sentinelText = envelopeSentinelText(envelope);
      if (sentinelText) {
        const parsed = parseWorkRunSentinel(sentinelText);
        if (parsed) sentinel = parsed;
      }
    }
    const parsedQuestion = parseAskUserQuestionEnvelope(envelope);
    if (parsedQuestion) askUserQuestion = parsedQuestion;
    // Terminal-result watchdog (P0.2): the agent's `result` envelope means it
    // declared done — but `claude -p` won't exit while a backgrounded task is
    // still alive (the d0679453 wedge). Open a bounded drain window; if the
    // child exits on its own first, the `exit` handler clears this timer and the
    // normal teardown runs (no watchdog reap). If it never exits, reap the
    // group and mark `reapedAfterTerminalResult` so the classifier treats a
    // clean+complete branch as branch-complete, not failed. Do NOT kill on
    // `result` — that re-introduces the false `failed` the 2026-06-04 fix removed.
    if (envelope.type === 'result' && !terminalResultSeen) {
      terminalResultSeen = true;
      drainTimer = setTimeout(() => {
        // Skip if the child already exited, a reap already started, or the user
        // cancelled — a cancelled run must classify as a cancel, never as a
        // watchdog reap (makes the precedence explicit, not order-dependent).
        if (!done && !exitFired && !reapStarted && !cancelSent) {
          reapedAfterTerminalResult = true;
          reapTree();
        }
      }, TERMINAL_DRAIN_MS);
      drainTimer.unref?.();
    }
    const display = streamJsonToDisplay(envelope);
    if (display === null) {
      // A parsed envelope that renders nothing — a `system` task_progress /
      // task_started / task_notification / thinking frame, or a successful
      // tool_result — is still evidence the run is actively working. Subagent
      // (Task) lifecycle frames are ALL type:'system', so without this a run
      // grinding through a subagent or a long single tool call emits no
      // `output` event for minutes, `lastOutputAt` goes stale, and the run
      // reads as quiet — tripping the quiet nudge and the P2.7 quiet→cancel
      // backstop on a healthy run. Emit a non-rendered `activity` event so the
      // supervision heartbeat advances (see docs/projects/bugs.md).
      enqueue(evt('activity', {}));
      return;
    }
    // Redact secrets on the display/bus path too. `streamJsonToDisplay` only
    // scrubs host paths; an error tool_result can echo a credential-bearing URL
    // or command. The durable sink redacts independently at append time (so the
    // persisted transcript and the projection tail that reads it are covered);
    // this single call covers the in-memory ring buffer and the bus → WS/TG
    // surfaces uniformly for every display line (assistant, result, user-error).
    const redacted = redactSecrets(display);
    // A single envelope may render multiple lines (mixed text + tool_use
    // blocks); emit one `output` event per line so downstream surfaces never
    // receive an embedded newline in a single line field.
    for (const displayLine of redacted.split('\n')) {
      if (displayLine) {
        stdoutRing.push(displayLine);
        enqueue(evt('output', { line: displayLine }));
      }
    }
  }

  child.stdout!.on('data', (chunk: Buffer) => {
    stdoutBuf += chunk.toString('utf8');
    const lines = stdoutBuf.split('\n');
    stdoutBuf = lines.pop() ?? '';
    for (const line of lines) emitStdoutLine(line);
  });

  child.stderr!.on('data', (chunk: Buffer) => {
    stderrBuf += chunk.toString('utf8');
    const lines = stderrBuf.split('\n');
    stderrBuf = lines.pop() ?? '';
    for (const line of lines) {
      stderrTail.push(line);
      enqueue(evt('log', { line, stream: 'stderr' }));
    }
  });

  function clearReapTimers() {
    if (reapSigkillTimer) { clearTimeout(reapSigkillTimer); reapSigkillTimer = null; }
    if (reapForceTimer) { clearTimeout(reapForceTimer); reapForceTimer = null; }
    if (drainTimer) { clearTimeout(drainTimer); drainTimer = null; }
  }

  /**
   * Derive the P0.3 exit fact (project 15) from what was observed, so the
   * classifier decides on the MANNER of exit + work product. Order matters:
   *  - user cancel and watchdog reap are the two facts we set ourselves;
   *  - a signalled termination we did NOT initiate (no clean code) is external;
   *  - `close` firing means stdio drained → a clean self-exit; `exit` without
   *    `close` (we force-completed) is a stdio-wedged clean exit;
   *  - nothing observed (e.g. a spawn `error`) returns undefined so the
   *    classifier falls back to the legacy derivation (which fails closed on a
   *    null exit code).
   */
  function deriveExitFact(): ExitFact | undefined {
    if (cancelSent) return cancelKind === 'system' ? 'system-cancel' : 'user-cancel';
    if (reapedAfterTerminalResult) return 'reaped-after-terminal-result';
    if (exitSignal !== null && exitCode === null) return 'external-kill';
    if (closeFired) return 'clean-exit';
    if (exitFired) return 'clean-exit-wedged-stdio';
    return undefined;
  }

  // Reap the agent's process group and guarantee the run completes. Called once
  // the agent process has exited: any grandchildren it left (e.g. a hung
  // `vitest`) hold the inherited stdio open, so `close` may never fire and the
  // run would otherwise sit `running` indefinitely (docs/projects/bugs.md).
  // SIGTERM the group now, escalate to SIGKILL after a grace, and force the loop
  // to complete if `close` STILL never arrives — the agent already exited, so we
  // complete from the captured exit facts rather than waiting on dead pipes.
  function reapTree() {
    if (reapStarted) return;
    reapStarted = true;
    killProcessTree(child, 'SIGTERM');
    reapSigkillTimer = setTimeout(() => killProcessTree(child, 'SIGKILL'), REAP_SIGKILL_MS);
    reapSigkillTimer.unref?.();
    reapForceTimer = setTimeout(() => {
      if (!done) {
        done = true;
        resolveWaiter?.();
        resolveWaiter = null;
      }
    }, REAP_FORCE_DONE_MS);
    reapForceTimer.unref?.();
  }

  // `exit` fires when the agent process itself terminates — BEFORE `close`,
  // which additionally waits for every inherited stdio fd to drain. Capture the
  // real exit code/signal here (so a clean exit isn't later misread) and reap
  // any orphaned grandchildren so `close` can fire promptly instead of hanging
  // on their still-open pipes. The runner previously keyed completion only on
  // `close`, which is exactly why a wedged grandchild stranded the run.
  child.on('exit', (code, signal) => {
    exitFired = true;
    if (exitCode === null && exitSignal === null) {
      exitCode = code;
      exitSignal = signal;
    }
    // The child exited on its own — cancel the terminal-result watchdog so it
    // can't reap an already-exited process; teardown proceeds via the existing
    // exit-keyed path (reapTree reaps any orphaned grandchildren).
    if (drainTimer) { clearTimeout(drainTimer); drainTimer = null; }
    reapTree();
  });

  child.on('close', (code, signal) => {
    closeFired = true;
    clearReapTimers();
    clearInterval(keepAliveTicker);
    if (commitTicker) clearInterval(commitTicker);
    if (stdoutBuf) emitStdoutLine(stdoutBuf);
    if (stderrBuf) {
      stderrTail.push(stderrBuf);
      enqueue(evt('log', { line: stderrBuf, stream: 'stderr' }));
    }
    // Preserve the first-seen exit facts (the `exit` handler captures the real
    // code/signal): a reap's SIGKILL must not stomp a clean exit code captured
    // earlier, or the external-kill reason string would change. `exit` always
    // fires before `close`; this only assigns on the error-less close-without-
    // prior-exit path (where both are still null).
    if (exitCode === null && exitSignal === null) {
      exitCode = code;
      exitSignal = signal;
    }
    done = true;
    resolveWaiter?.();
    resolveWaiter = null;
  });

  child.on('error', (err) => {
    clearReapTimers();
    clearInterval(keepAliveTicker);
    if (commitTicker) clearInterval(commitTicker);
    stderrTail.push(err.message);
    enqueue(evt('log', { line: err.message, stream: 'stderr' }));
    done = true;
    resolveWaiter?.();
    resolveWaiter = null;
  });

  try {
    while (!done || queue.length > 0) {
      if (ctx.cancel() && !cancelSent) {
        cancelSent = true;
        // Capture WHO cancelled so the classifier can tell a user cancel
        // (terminal-fail) from a system backstop reap (classify on work
        // product). Default 'user' when the context predates `cancelReason`.
        cancelKind = ctx.cancelReason?.() ?? 'user';
        // Group kill, not just the direct child — otherwise a cancel leaves the
        // agent's grandchildren (vitest, etc.) orphaned and still holding the
        // pipes open (docs/projects/bugs.md).
        killProcessTree(child, 'SIGTERM');
      }
      await waitForNext();
      while (queue.length > 0) yield queue.shift()!;
    }

    // Return exit facts instead of yielding a terminal event — apply() owns
    // the single terminal (and, in a later Phase 2 task, classification).
    const exitFact = deriveExitFact();
    return {
      exit: {
        exitCode,
        signal: exitSignal,
        // `cancelled` means a USER cancel — it short-circuits the classifier to
        // terminal-fail. A system backstop reap sets `exitFact: 'system-cancel'`
        // instead and classifies on work product, so it must NOT set this.
        cancelled: cancelSent && cancelKind === 'user',
        durationMs: Date.now() - t0,
        ...(exitFact !== undefined ? { exitFact } : {}),
      },
      ringBuffer: stdoutRing.items(),
      stderrTail: stderrTail.items(),
      sentinel,
      askUserQuestion,
    };
  } finally {
    // Belt-and-suspenders: the close/error handlers above also clear the
    // timers, but a consumer that aborts the iteration before the child
    // exits would otherwise leak them.
    clearReapTimers();
    clearInterval(keepAliveTicker);
    if (commitTicker) clearInterval(commitTicker);
  }
}

/**
 * Assemble the per-run `summary.json` payload from the classified terminal
 * event plus the run's identity/timing facts. `outcome`/`reason`/`workProduct`
 * ride on `terminalEvent.data` (populated by `finalizeWorkRun`); on the
 * classification-error path `workProduct` is absent, so it falls back to the
 * zero blob and `exit` comes straight from the captured `streamResult.exit`.
 */
interface BuildSummaryOpts {
  id: string;
  project: string;
  product: string;
  branch: string;
  baseSha: string;
  /** Run start time (`Date.now()` ms). */
  t0: number;
  exit: ExitFacts;
  terminalEvent: MutationEvent;
  sink: TranscriptSink | null;
  workRunsDir: string;
  /** Run end time (ISO). Captured once by the caller and shared with the index
   *  row so the two artifacts agree to the millisecond. */
  endedAt: string;
  /** Gated-merge disposition (Phase 3.5) — only set on the post-finalize
   *  summary re-write, once the finalizer has resolved merge/delete. */
  merged?: boolean;
  branchDeleted?: boolean;
  /** Base branch the run targets + the gate's hold reason (if held) — persisted
   *  so the disposition survives a restart and reaches the cockpit. */
  baseBranch?: string;
  gateHeldReason?: string;
}

function buildSummary(opts: BuildSummaryOpts): WorkRunSummary {
  const { id, project, product, branch, baseSha, t0, exit, terminalEvent, sink, workRunsDir, endedAt, merged, branchDeleted, baseBranch, gateHeldReason } = opts;
  const data = (terminalEvent.data ?? {}) as Record<string, unknown>;
  const outcome = readOutcome(terminalEvent);
  const reason = typeof data['reason'] === 'string' ? data['reason'] : '';
  const workProduct = (data['workProduct'] as WorkProductFacts | undefined) ?? EMPTY_WORK_PRODUCT;
  return {
    id,
    project,
    product,
    outcome,
    reason,
    exit,
    workProduct,
    baseSha,
    branch,
    startedAt: new Date(t0).toISOString(),
    endedAt,
    // Scrub the host PROJECT_ROOT prefix from the persisted paths so a future
    // reader (Phase 3 forensics, a cockpit detail route) can't leak the host
    // username — mirrors finalizeWorkRun's scrub of the classification-error
    // reason. The files still live at the absolute path on disk; only the
    // recorded strings are repo-relative.
    transcriptPath: scrubPathsInText(sink?.path ?? ''),
    forensicsPath: scrubPathsInText(join(workRunsDir, id)),
    // Only stamp the gated-merge disposition keys when present (the post-finalize
    // re-write) so the pre-merge summary stays clean.
    ...(merged !== undefined ? { merged } : {}),
    ...(branchDeleted !== undefined ? { branchDeleted } : {}),
    ...(baseBranch !== undefined ? { baseBranch } : {}),
    ...(gateHeldReason !== undefined ? { gateHeldReason } : {}),
  };
}

function term(
  mutationId: string,
  kind: 'completed' | 'failed',
  data: Record<string, unknown>,
): MutationEvent {
  return { mutationId, ts: new Date().toISOString(), kind, data };
}

/** Build the one-shot run-start notification event (project 13, Phase 1a). The
 *  `data.operatorWorktreePath` it carries is intentionally UN-SCRUBBED — it is a
 *  local-operator field, distinct from every persisted/committed surface, which
 *  stays scrubbed via `scrubPathsInText`. The mutations pipeline publishes this
 *  to the bus without copying its data onto the descriptor. */
function startEvent(mutationId: string, data: Record<string, unknown>): MutationEvent {
  return { mutationId, ts: new Date().toISOString(), kind: 'start', data };
}
