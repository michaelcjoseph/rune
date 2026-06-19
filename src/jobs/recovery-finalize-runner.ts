/**
 * Runtime glue for P0.4 recovery finalize (project 15). At startup — BEFORE the
 * orphan-worktree sweep — drive each stale `running` supervised run to a real
 * terminal state through the hold-mode finalizer, classified on its work
 * product, instead of only relabeling it `unknown`.
 *
 * `buildRecoveryFinalizeDeps(io?)` wires the pure `recoverAndFinalizeStaleRuns`
 * core (supervision-recovery.ts) to config + the real git/fs/stores. Every
 * effect is an injected seam (defaulting to production) so the per-run
 * `finalizeStaleRun` is unit-testable with stubs — no real git, worktree, or
 * disk. The core fault-isolates each run (a throw → the run is left for the
 * unknown-relabel fallback in index.ts), so one bad run never aborts the pass
 * or crashes boot.
 *
 * A recovered run lost its in-memory spawn-time tasks baseline, so the classify
 * uses the ABSOLUTE unchecked-task count of the current tasks.md as
 * `tasksRemaining` (an unchecked box means work remains) and a
 * `reaped-after-terminal-result` exit fact so the classifier decides on work
 * product, not on the (absent) process exit.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import config from '../config.js';
import { createLogger } from '../utils/logger.js';
import { scrubPathsInText } from '../ai/tool-labels.js';
import type { MutationEvent } from '../transport/mutations.js';
import type { SupervisedRun } from '../intent/supervision.js';
import { worktreePathFor, VALID_SLUG } from '../intent/sandbox.js';
import { workBranchName } from './work-runner.js';
import {
  defaultRunGit,
  destroyWorktree,
  getProductConfig,
  type GitRunner,
  type ProductConfig,
} from './sandbox-runtime.js';
import {
  classifyOutcome,
  computeWorkProduct,
  type ExitFacts,
} from './work-run-classify.js';
import {
  runFinalizer,
  type FinalizerEffects,
  type FinalizerPhase,
  type FinalizerSupervisionStatus,
} from './work-run-finalizer.js';
import type { GateResult } from './work-run-gate.js';
import { runGate, type GateRuntimeOpts } from './work-run-gate-runtime.js';
import { withBaseBranchLock } from './work-run-merge-lock.js';
import { redactSecrets } from './work-run-transcript.js';
import { sweepWorktreeProcesses } from './worktree-sweep.js';
import {
  writeSummary,
  appendIndexRow,
  recordWorkRunPhase,
  readLastWorkRunPhase,
  type WorkRunSummary,
} from './work-run-store.js';
import { upsertRun, readAllRuns, writeAllRuns } from './supervision-store.js';
import {
  recoverAndFinalizeStaleRuns,
  type RecoverAndFinalizeDeps,
  type RecoverFinalizeResult,
} from './supervision-recovery.js';

const log = createLogger('recovery-finalize-runner');

/** Per-run wall-clock ceiling at boot. defaultRunGit caps each git call at 30s,
 *  but a stale run makes ~5 serial git calls (merge-base + work-product +
 *  worktree-remove); a gated-merge RESUME adds a network-bound `git push` +
 *  `branch -d` on top. This bounds a pathologically slow/contended run so boot
 *  isn't blocked; a timeout (e.g. a slow remote during the resume push) leaves
 *  the run for the unknown-relabel fallback — safe, because the durable
 *  `merged-not-pushed` phase means the NEXT boot retries the push exactly-once. */
const RECOVERY_PER_RUN_TIMEOUT_MS = 60_000;

/** Reject `p` if it doesn't settle within `ms`. The timer is unref'd + cleared
 *  so a fast finalize never leaves a dangling boot timer. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`recovery finalize timed out after ${ms}ms for ${label}`)),
      ms,
    );
    timer.unref?.();
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e as Error); },
    );
  });
}

/** Injectable I/O seams — production defaults shell out to real git/fs/stores;
 *  the unit test injects stubs so `finalizeStaleRun` runs with no real repo. */
export interface RecoveryFinalizeIO {
  runGit: GitRunner;
  /** Resolve a product's config (repo path + base branch). Throws on unknown. */
  getProduct: (product: string) => ProductConfig;
  /** Absolute worktree path for a run. */
  worktreeFor: (product: string, project: string) => string;
  /** True if the worktree still exists on disk (recovery must run before the sweep). */
  worktreeExists: (path: string) => boolean;
  /** Read the worktree's tasks.md, or '' if absent/unreadable. */
  readTasks: (worktreePath: string, project: string) => string;
  writeSummaryFile: (dir: string, summary: WorkRunSummary) => void;
  appendIndex: (filePath: string, row: import('./work-run-store.js').WorkRunIndexRow) => void;
  upsertSupervision: (run: SupervisedRun) => void;
  removeWorktree: (run: SupervisedRun, worktreePath: string, baseSha: string, egressAllowlist: string[]) => Promise<void>;
  /** Read the last durable finalize phase a crashed run reached, or null. Drives
   *  the gated-merge crash-resume decision (Phase 3.5). */
  readLastPhase: (runId: string) => FinalizerPhase | null;
  /** Persist a finalize phase as recovery advances a resumed gated-merge. */
  recordPhase: (runId: string, phase: FinalizerPhase) => void;
  /** Evaluate the gated-merge hard gate. Production wires the real gate
   *  runtime; tests must inject an explicit seam so a missing gate fails loud. */
  runGate: (opts: GateRuntimeOpts) => Promise<GateResult>;
  /** Wall clock — injected so the test is deterministic. */
  now: () => number;
}

function defaultIO(): RecoveryFinalizeIO {
  return {
    runGit: defaultRunGit,
    getProduct: (product) => getProductConfig(product, config.PRODUCTS_CONFIG_FILE),
    worktreeFor: (product, project) => worktreePathFor(product, project, config.WORKTREE_ROOT),
    worktreeExists: (p) => existsSync(p),
    readTasks: (worktreePath, project) => {
      try {
        return readFileSync(join(worktreePath, 'docs', 'projects', project, 'tasks.md'), 'utf8');
      } catch {
        return '';
      }
    },
    writeSummaryFile: writeSummary,
    appendIndex: appendIndexRow,
    upsertSupervision: (run) => upsertRun(run, config.SUPERVISED_RUNS_FILE),
    removeWorktree: async (run, worktreePath, baseSha, egressAllowlist) => {
      // Defense-in-depth (P2.7): SIGKILL any reparented grandchild that escaped
      // the process group and is still holding this worktree, BEFORE removing it.
      // Best-effort — sweepWorktreeProcesses never throws.
      sweepWorktreeProcesses(worktreePath);
      await destroyWorktree(
        { product: run.product, project: run.project, worktree: worktreePath, egressAllowlist, baseSha },
        { productsConfigPath: config.PRODUCTS_CONFIG_FILE, worktreeRoot: config.WORKTREE_ROOT, runGit: defaultRunGit },
      );
    },
    readLastPhase: (runId) => readLastWorkRunPhase(config.WORK_RUNS_DIR, runId),
    recordPhase: (runId, phase) => recordWorkRunPhase(config.WORK_RUNS_DIR, runId, phase),
    runGate,
    now: () => Date.now(),
  };
}

/**
 * Finalize ONE stale `running` run through the hold-mode finalizer. May throw
 * (unknown product, missing worktree, git failure) — the recovery core catches
 * it per-run and leaves the run for the unknown-relabel fallback.
 */
async function finalizeStaleRun(run: SupervisedRun, io: RecoveryFinalizeIO): Promise<FinalizerSupervisionStatus> {
  // Defense in depth: the run id/product/project come off the persisted
  // supervised-runs.json and flow into fs path joins (writeSummary's
  // `<WORK_RUNS_DIR>/<id>`) and git args. worktreePathFor/getProductConfig guard
  // product/project, but `run.id` reaches `writeSummary` (which joins verbatim
  // per its contract) unguarded — so validate all three at the boundary. A bad
  // slug throws → the recovery core catches it → unknown-relabel fallback.
  for (const [label, slug] of [['id', run.id], ['product', run.product], ['project', run.project]] as const) {
    if (!VALID_SLUG.test(slug)) {
      throw new Error(`recovery: invalid ${label} slug '${slug}' on supervised run`);
    }
  }
  const product = io.getProduct(run.product); // throws on unknown product
  const worktree = io.worktreeFor(run.product, run.project); // throws on bad slug
  if (!io.worktreeExists(worktree)) {
    throw new Error(`recovery: worktree absent (already swept?) for run ${run.id}`);
  }
  const branch = workBranchName(run.project);

  // We lost the in-memory baseSha; the fork point (merge-base of the work branch
  // and the product's base branch) is the stable diff base for the work product.
  const mb = await io.runGit(['merge-base', product.baseBranch, branch], { cwd: product.repoPath });
  const baseSha = mb.stdout.trim();
  if (!baseSha) throw new Error(`recovery: no merge-base for ${branch} on ${run.product}`);

  const finalTasks = io.readTasks(worktree, run.project);
  // Pass the SAME content as both baseline and final: with baseline === final,
  // computeTaskTransitions counts every still-unchecked task as `tasksRemaining`
  // — an ABSOLUTE unchecked count, which is the recovery-appropriate signal
  // (the spawn-time baseline is lost on restart). A resumed run carrying
  // pre-existing unchecked tasks from an earlier phase may therefore classify
  // `partial` where `branch-complete` would be more precise — acceptable, since
  // `branch-complete` still requires zero unchecked tasks and never over-claims.
  const productFacts = await computeWorkProduct({
    runGit: io.runGit,
    cwd: worktree,
    baseSha,
    branch,
    baselineTasks: finalTasks,
    finalTasks,
  });

  // No live process to read an exit from: classify on work product via the
  // reaped-after-terminal-result fact (the agent's branch is authoritative).
  const exit: ExitFacts = {
    exitCode: null,
    signal: null,
    cancelled: false,
    durationMs: 0,
    exitFact: 'reaped-after-terminal-result',
  };
  // Gated-merge crash-resume decision (read the durable phase BEFORE classifying
  // so a resume can choose the correct finalizer mode): `project-marked-done`
  // has already committed the project index flip, so recovery must continue the
  // gated finalizer from the next side-effect rather than falling back to hold
  // mode and stranding the Done commit on an unmerged branch. Once the merge has
  // landed (`merged-not-pushed`/`pushed-not-deleted`), the recorded phase is
  // authoritative and recovery completes only the remaining push/delete tail.
  const lastPhase = io.readLastPhase(run.id);
  const resumeAfterProjectDone = lastPhase === 'project-marked-done';
  const resumeAfterMerge = lastPhase === 'merged-not-pushed' || lastPhase === 'pushed-not-deleted';
  const resumeGatedMerge = resumeAfterProjectDone || resumeAfterMerge;

  const classified = classifyOutcome({ exit, product: productFacts });
  // On a gated-merge RESUME the recorded phase is authoritative: the merge landed,
  // so the run WAS branch-complete. Recovery's absolute unchecked-task count
  // would otherwise mis-read it as `partial` (the project's later-phase boxes are
  // unchecked) and the finalizer would skip the push, stranding origin behind.
  // Force branch-complete so `runGatedMerge` completes the push/delete.
  const outcome =
    resumeAfterMerge && classified.outcome !== 'branch-complete' ? 'branch-complete' : classified.outcome;
  const reason =
    outcome === classified.outcome
      ? classified.reason
      : `gated-merge resume from ${lastPhase} (merge already landed)`;
  if (resumeGatedMerge) {
    log.info('recovery: resuming a crashed gated-merge run', { id: run.id, lastPhase, outcome });
  }
  const scrubbedReason = scrubPathsInText(`recovered: ${reason}`);
  const endedAtMs = io.now();
  const endedAt = new Date(endedAtMs).toISOString();
  const startedAtMs = Number.isNaN(Date.parse(run.startedAt)) ? endedAtMs : Date.parse(run.startedAt);

  const terminalEvent: MutationEvent = {
    mutationId: run.id,
    ts: endedAt,
    kind: outcome === 'failed' ? 'failed' : 'completed',
    data: {
      outcome,
      reason: scrubbedReason,
      workProduct: productFacts,
      exit,
      projectSlug: run.project,
      product: run.product,
    },
  };

  // The finalizer COMPLETES an interrupted gated-merge (push/branch-delete),
  // skipping the already-committed merge via `readLastPhase` — never re-merges or
  // re-runs the gate. A run with no merge phase re-drives in `hold` mode below.
  const baseEffects: FinalizerEffects = {
    classify: async () => terminalEvent,
    flushTranscript: async () => {}, // no live transcript for a recovered run
    // `_ev` is the classified event the finalizer passes; the recovery path
    // builds the summary/index row from the surrounding scope (which carries
    // the recovery-only fields baseSha/branch/timing the event lacks), so the
    // argument is intentionally unused.
    writeSummary: (_ev) => {
        const summary: WorkRunSummary = {
          id: run.id,
          project: run.project,
          product: run.product,
          outcome,
          reason: scrubbedReason,
          exit,
          workProduct: productFacts,
          baseSha,
          branch,
          startedAt: run.startedAt,
          endedAt,
          // A recovered run collected no live transcript and no forensics
          // bundle — empty both (matching the cockpit's "no link" convention)
          // rather than pointing at a directory that holds neither.
          transcriptPath: '',
          forensicsPath: '',
        };
        io.writeSummaryFile(join(config.WORK_RUNS_DIR, run.id), summary);
      },
      appendIndexRow: (_ev) => {
        io.appendIndex(config.WORK_RUNS_INDEX_FILE, {
          id: run.id,
          project: run.project,
          outcome,
          durationMs: Math.max(0, endedAtMs - startedAtMs),
          startedAt: run.startedAt,
          endedAt,
        });
      },
    writeSupervisionTerminal: (status) => {
      io.upsertSupervision({ ...run, status });
    },
    removeWorktree: () => io.removeWorktree(run, worktree, baseSha, product.egressAllowlist),
    // Durable phases drive the gated-merge resume; harmless in hold mode (which
    // never consults readLastPhase and runs straight through).
    recordPhase: (phase) => io.recordPhase(run.id, phase),
    readLastPhase: () => lastPhase,
  };

  const integrationWorktree = join(config.WORKTREE_ROOT, `gate-${run.product}-${run.id}`);

  // In `gated-merge` resume mode, supply the merge effects. On resume from
  // `merged-not-pushed`/`pushed-not-deleted` the finalizer SKIPS the gate +
  // merge (via `readLastPhase`), so `gate`/`mergeBranch` throw defensively if a
  // contract violation tries to re-run them. On resume from `project-marked-done`,
  // the merge has NOT happened yet: the finalizer re-runs the gate, writes
  // summary/index, then merges/pushes/deletes exactly once, with the
  // gate-through-merge sequence under the base-branch lock.
  const effects: FinalizerEffects = resumeGatedMerge
    ? {
        ...baseEffects,
        baseBranchCriticalSection: (fn) => withBaseBranchLock(run.product, product.baseBranch, fn),
        gate: async () => {
          if (resumeAfterMerge) {
            throw new Error('recovery resume must not re-run the gate (merge already landed)');
          }
          return io.runGate({
            product: run.product,
            repoPath: product.repoPath,
            baseBranch: product.baseBranch,
            branch,
            integrationWorktree,
            validationCommands: product.validationCommands ?? [],
            tasksRemaining: productFacts.transitions.tasksRemaining,
            concurrentRun: false,
            commandTimeoutMs: config.WORK_RUN_GATE_COMMAND_TIMEOUT_MS,
          });
        },
        mergeBranch: async () => {
          if (resumeAfterMerge) {
            throw new Error('recovery resume must not re-merge (merge already landed)');
          }
          const message = `jarvis(${run.product}): merge recovered work-run branch ${branch}`;
          try {
            await io.runGit(['merge', '--no-ff', branch, '-m', message], { cwd: product.repoPath });
          } catch (err) {
            throw new Error(redactSecrets(`git merge failed: ${(err as Error).message}`));
          }
        },
        alert: () => {},
        pushBranch: async () => {
          try {
            await io.runGit(['push', 'origin', product.baseBranch], { cwd: product.repoPath });
          } catch (err) {
            throw new Error(redactSecrets(`git push failed: ${(err as Error).message}`));
          }
        },
        deleteBranch: async () => {
          await io.runGit(['branch', '-d', branch], { cwd: product.repoPath });
        },
      }
    : baseEffects;

  const result = await runFinalizer(
    {
      mode: resumeGatedMerge ? 'gated-merge' : 'hold',
      runId: run.id,
      project: run.project,
      product: run.product,
      branch,
      baseBranch: product.baseBranch,
    },
    effects,
  );

  // On a completed gated-merge resume the finalizer SKIPPED `writeSummary` (the
  // pre-merge summary was already on disk, phase `summary-written` reached), so
  // the persisted summary still lacks the merge disposition. Re-stamp it now so
  // the cockpit/restart reader shows a resumed-completed run as merged, not as a
  // gate-held branch-complete. Best-effort — a disk failure never changes the
  // already-resolved terminal status.
  if (resumeGatedMerge && result.merged) {
    try {
      io.writeSummaryFile(join(config.WORK_RUNS_DIR, run.id), {
        id: run.id,
        project: run.project,
        product: run.product,
        outcome,
        reason: scrubbedReason,
        exit,
        workProduct: productFacts,
        baseSha,
        branch,
        startedAt: run.startedAt,
        endedAt,
        transcriptPath: '',
        forensicsPath: '',
        merged: true,
        branchDeleted: result.branchDeleted,
        baseBranch: product.baseBranch,
      });
    } catch (err) {
      log.warn('recovery: post-resume summary re-write failed (best-effort)', {
        id: run.id,
        error: scrubPathsInText((err as Error).message),
      });
    }
  }
  return result.supervisionStatus;
}

/** Build the recovery-finalize deps for the pure core, wiring production I/O by
 *  default. `io` is injectable for the unit test. */
export function buildRecoveryFinalizeDeps(io: RecoveryFinalizeIO = defaultIO()): RecoverAndFinalizeDeps {
  return {
    readRuns: () => readAllRuns(config.SUPERVISED_RUNS_FILE),
    writeRuns: (runs) => writeAllRuns(runs, config.SUPERVISED_RUNS_FILE),
    // Per-run boot ceiling so a pathologically slow run can't block startup.
    finalizeStaleRun: (run) => withTimeout(finalizeStaleRun(run, io), RECOVERY_PER_RUN_TIMEOUT_MS, run.id),
  };
}

/**
 * Run recovery-finalize over the persisted supervised runs. Best-effort: never
 * throws (the core fault-isolates per run; this wrapper guards the rest). Called
 * from index.ts at startup, awaited BEFORE the orphan-worktree sweep.
 */
export async function runRecoveryFinalize(io?: RecoveryFinalizeIO): Promise<RecoverFinalizeResult> {
  try {
    return await recoverAndFinalizeStaleRuns(buildRecoveryFinalizeDeps(io));
  } catch (err) {
    log.error('runRecoveryFinalize threw; leaving runs for the unknown-relabel fallback', {
      error: (err as Error).message,
    });
    return { finalized: 0, failedToFinalize: 0, total: 0 };
  }
}

// Test seam: expose finalizeStaleRun for the unit suite.
export const __finalizeStaleRunForTest = finalizeStaleRun;
