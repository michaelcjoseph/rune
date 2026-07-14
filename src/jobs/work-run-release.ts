/**
 * Project 13 Phase 1c — the shared work-run RELEASE runtime.
 *
 * A parked (`blocked-on-human`) run keeps its worktree live, holds the
 * per-project slot, and blocks the Project 15 finalizer until a human releases
 * it. Release is reachable from BOTH the cockpit (`POST /api/work-runs/:id/release`
 * + the existing `blocked-on-human` inbox row) and Telegram (callback
 * `work-run-release:<id>`); every surface routes through the ONE shared entry
 * (`requestWorkRunRelease`) so they can't drift.
 *
 * Three layers:
 *   1. `releasePreflight(runId, opts, deps)` — the PRE-mutation decision used by
 *      both surfaces:
 *        - not parked / unknown run        → `not-parked` (no mutation)
 *        - dirty worktree + no confirm     → `dirty-confirm` + the file list (no mutation)
 *        - clean worktree                  → `release` (create a clean cold-finalize mutation)
 *        - dirty worktree + `confirmDirty` → `release` (create an explicit-discard mutation)
 *   2. `requestWorkRunRelease(runId, opts, deps)` — runs the preflight, and on a
 *      `release` decision creates the auto-approved `work-run-release` mutation.
 *      Returns a surface-agnostic outcome (`not-parked`/`dirty-confirm`/`created`/
 *      `error`) the HTTP route, Telegram callback, and inbox row each map.
 *   3. `runWorkRunRelease(payload, deps)` — the `work-run-release` applier core.
 *      It RECHECKS parked + dirty state, then:
 *        - clean      → COLD-finalize through the Project 15 finalizer in
 *          `gated-merge` mode (recompute baseSha via merge-base → classify on the
 *          current work product → runFinalizer). Reuses `finalizeStaleRun`'s
 *          building blocks but drives `gated-merge` EXPLICITLY (not its fresh-run
 *          hold default). The supervision `blocked-on-human` hold stays until
 *          `clearParkedHold` fires AFTER the finalizer terminal — only then is
 *          the project slot freed.
 *        - confirmed dirty → explicit DISCARD: destroy the worktree, clear the
 *          parked hold AFTER destructive cleanup, emit a terminal event, and do
 *          NOT invoke gated merge.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import config from '../config.js';
import { createLogger } from '../utils/logger.js';
import { scrubPathsInText } from '../ai/tool-labels.js';
import { VALID_SLUG, worktreePathFor, workBranchName } from '../intent/sandbox.js';
import type { SupervisedRun } from '../intent/supervision.js';
import {
  createMutation,
  activeRuns,
  type MutationApplier,
  type MutationDescriptor,
  type MutationEvent,
  type ApplyContext,
} from '../transport/mutations.js';
import {
  defaultRunGit,
  destroyWorktree,
  getProductConfig,
} from './sandbox-runtime.js';
import {
  classifyOutcome,
  computeWorkProduct,
  type ExitFacts,
} from './work-run-classify.js';
import { redactSecrets } from './work-run-transcript.js';
import {
  runFinalizer,
  readOutcome,
  type FinalizerEffects,
  type GateFailReason,
} from './work-run-finalizer.js';
import { runGate } from './work-run-gate-runtime.js';
import { withBaseBranchLock } from './work-run-merge-lock.js';
import {
  writeSummary,
  appendIndexRow,
  recordWorkRunPhase,
  readLastWorkRunPhase,
  type WorkRunSummary,
} from './work-run-store.js';
import { sweepWorktreeProcesses } from './worktree-sweep.js';
import { readAllRuns, upsertRun } from './supervision-store.js';

const log = createLogger('work-run-release');

/** Audit source for the release mutation. Mirrors `MutationDescriptor['source']`
 *  — both the cockpit route and the Telegram callback are local-operator
 *  surfaces, so they record `'webview'` (the generic operator surface). */
type ReleaseSource = MutationDescriptor['source'];

/** Release-mutation payload (the `work-run-release` mutation kind). */
export interface WorkRunReleasePayload {
  /** The parked run's id (== the supervised run id == the work-run mutation id). */
  runId: string;
  /** True only after the operator explicitly confirmed discarding a dirty
   *  worktree. A clean release carries `false`. */
  confirmDirty?: boolean;
}

/** The preflight decision — what each surface does BEFORE creating a mutation. */
export type ReleasePreflightOutcome =
  | { kind: 'not-parked'; runId: string }
  | { kind: 'dirty-confirm'; runId: string; files: string[] }
  | { kind: 'release'; runId: string; confirmDirty: boolean };

/** Injected IO for the preflight decision — so the unit test runs with no real
 *  supervision store, worktree, or git. */
export interface ReleasePreflightDeps {
  /** The durable `blocked-on-human` supervised record for this run, or null
   *  (unknown / already-released / never-parked). */
  readParkedRun: (runId: string) => SupervisedRun | null;
  /** Deterministic worktree path for a parked run's product+project. */
  worktreeFor: (product: string, project: string) => string;
  /** True if the worktree still exists on disk. */
  worktreeExists: (worktreePath: string) => boolean;
  /** `git status --porcelain` in the worktree → the list of dirty/uncommitted
   *  paths (empty = clean). */
  gitStatusPorcelain: (worktreePath: string) => Promise<string[]>;
}

/**
 * Decide what a release request should do, WITHOUT creating a mutation. Both the
 * cockpit route and the Telegram callback call this first (via
 * `requestWorkRunRelease`).
 *
 * A parked record whose worktree is gone (swept/stale) resolves to `not-parked`
 * — releasing it must be a clean no-op, never an error that touches an
 * unrelated path.
 */
export async function releasePreflight(
  runId: string,
  opts: { confirmDirty?: boolean },
  deps: ReleasePreflightDeps,
): Promise<ReleasePreflightOutcome> {
  const run = deps.readParkedRun(runId);
  if (!run) return { kind: 'not-parked', runId };
  const worktreePath = deps.worktreeFor(run.product, run.project);
  if (!deps.worktreeExists(worktreePath)) return { kind: 'not-parked', runId };
  const dirty = await deps.gitStatusPorcelain(worktreePath);
  if (dirty.length > 0 && !opts.confirmDirty) {
    return { kind: 'dirty-confirm', runId, files: dirty };
  }
  return { kind: 'release', runId, confirmDirty: opts.confirmDirty ?? false };
}

/** Injected IO for the release applier's cold-finalize / discard paths. The real
 *  wiring reuses `finalizeStaleRun`'s building blocks (merge-base baseSha,
 *  computeWorkProduct, the gate/merge/push/delete effects); every effect is a
 *  seam so the applier is unit-testable with no real git/worktree/disk. */
export interface ReleaseRuntimeDeps {
  readParkedRun: (runId: string) => SupervisedRun | null;
  worktreeFor: (product: string, project: string) => string;
  worktreeExists: (worktreePath: string) => boolean;
  gitStatusPorcelain: (worktreePath: string) => Promise<string[]>;
  /** Cold-finalize the run through the Project 15 finalizer in `gated-merge`
   *  mode (NOT the fresh-run hold default), keeping the parked hold until the
   *  finalizer terminal write. Returns the classified terminal event. */
  coldFinalizeGatedMerge: (run: SupervisedRun, worktreePath: string) => Promise<MutationEvent>;
  /** Explicit discard of a confirmed-dirty worktree: destroy it, then clear the
   *  parked hold. */
  discardDirtyWorktree: (run: SupervisedRun, worktreePath: string) => Promise<void>;
  /** Clear the parked hold (release the project slot) — called ONLY after the
   *  finalizer terminal write (clean) or destructive cleanup (dirty). */
  clearParkedHold: (run: SupervisedRun, terminalStatus: 'completed' | 'failed') => void;
}

/**
 * The `work-run-release` applier core. Rechecks parked + dirty state, then
 * cold-finalizes a clean worktree (gated-merge) or discards a confirmed-dirty
 * one. Yields a single terminal mutation event keyed on the PARKED run's id (so
 * the bus frame names the run the operator cares about).
 *
 * Ordering is load-bearing: `clearParkedHold` fires only AFTER the cold-finalize
 * (or the discard) resolves, so the supervision `blocked-on-human` hold — and
 * therefore the per-project slot — persists for the whole finalization.
 */
export async function* runWorkRunRelease(
  payload: WorkRunReleasePayload,
  deps: ReleaseRuntimeDeps,
): AsyncIterable<MutationEvent> {
  const { runId } = payload;
  const run = deps.readParkedRun(runId);
  if (!run) {
    // No-longer-parked / already-released / unknown — a clean no-op terminal.
    // Never touches a worktree.
    yield term(runId, 'completed', { released: false, reason: 'run is not parked (already released or unknown)' });
    return;
  }
  const worktreePath = deps.worktreeFor(run.product, run.project);
  if (!deps.worktreeExists(worktreePath)) {
    // The record survived but the worktree was swept — release is a clean no-op.
    yield term(runId, 'completed', {
      released: false,
      reason: 'parked worktree is gone (stale record)',
      projectSlug: run.project,
      product: run.product,
    });
    return;
  }

  const dirty = await deps.gitStatusPorcelain(worktreePath);
  if (dirty.length > 0) {
    if (!payload.confirmDirty) {
      // The preflight gates this; defensive backstop — never destroy a human's
      // uncommitted fix without explicit confirmation.
      yield term(runId, 'failed', {
        reason: 'dirty worktree requires explicit confirmation to discard',
        files: dirty,
        projectSlug: run.project,
        product: run.product,
      });
      return;
    }
    // Confirmed dirty → explicit DISCARD. Destroy first, clear the hold AFTER the
    // destructive cleanup (so the slot stays held until the worktree is gone).
    // Never invokes gated merge.
    await deps.discardDirtyWorktree(run, worktreePath);
    deps.clearParkedHold(run, 'completed');
    yield term(runId, 'completed', {
      released: true,
      discarded: true,
      reason: 'dirty parked worktree discarded by operator',
      projectSlug: run.project,
      product: run.product,
    });
    return;
  }

  // Clean → COLD-finalize through the Project 15 finalizer (gated-merge). The
  // gate decides merge vs branch-complete hold. Keep the parked hold until the
  // finalizer terminal write resolves, THEN clear it.
  const terminal = await deps.coldFinalizeGatedMerge(run, worktreePath);
  deps.clearParkedHold(run, terminal.kind === 'failed' ? 'failed' : 'completed');
  yield terminal;
}

function term(
  mutationId: string,
  kind: 'completed' | 'failed',
  data: Record<string, unknown>,
): MutationEvent {
  return { mutationId, ts: new Date().toISOString(), kind, data };
}

// ---------------------------------------------------------------------------
// Shared release entry (`requestWorkRunRelease`)
// ---------------------------------------------------------------------------

/** What a release REQUEST resolves to — the surface-agnostic outcome both the
 *  cockpit route and the Telegram callback map to their own response shape. */
export type ReleaseRequestOutcome =
  | { kind: 'not-parked'; runId: string }
  | { kind: 'dirty-confirm'; runId: string; files: string[] }
  | { kind: 'created'; runId: string; mutationId: string }
  | { kind: 'error'; runId: string; reason: string };

/** Injected IO for the shared release request: the preflight deps plus a
 *  mutation-creation seam (so the unit test never touches the real pipeline). */
export interface ReleaseRequestDeps {
  preflight: ReleasePreflightDeps;
  /** Create the auto-approved `work-run-release` mutation. Production wires
   *  `createMutation('work-run-release', payload, source)`. */
  createReleaseMutation: (
    payload: WorkRunReleasePayload,
  ) => Promise<{ ok: true; id: string } | { ok: false; reason: string }>;
}

/**
 * Run a release request through the shared runtime: preflight, then on a
 * `release` decision create the auto-approved `work-run-release` mutation.
 */
export async function requestWorkRunRelease(
  runId: string,
  opts: { confirmDirty?: boolean },
  deps: ReleaseRequestDeps,
): Promise<ReleaseRequestOutcome> {
  const pf = await releasePreflight(runId, opts, deps.preflight);
  if (pf.kind === 'not-parked') return { kind: 'not-parked', runId };
  if (pf.kind === 'dirty-confirm') return { kind: 'dirty-confirm', runId, files: pf.files };
  const created = await deps.createReleaseMutation({ runId, confirmDirty: pf.confirmDirty });
  if (!created.ok) return { kind: 'error', runId, reason: created.reason };
  return { kind: 'created', runId, mutationId: created.id };
}

/** Render a release-request outcome as a one-line operator reply (Telegram). Pure. */
export function formatReleaseRequestReply(outcome: ReleaseRequestOutcome): string {
  switch (outcome.kind) {
    case 'created':
      return `🔓 Release started · ${outcome.runId} · mutation ${outcome.mutationId}`;
    case 'dirty-confirm':
      return (
        `⚠️ ${outcome.runId} has ${outcome.files.length} uncommitted change(s) — release would discard them.\n` +
        `Confirm discard via the explicit release with confirmDirty, or commit/clean the worktree first.`
      );
    case 'not-parked':
      return `ℹ️ ${outcome.runId} is not parked (already released or unknown) — nothing to do.`;
    case 'error':
      return `❌ Could not release ${outcome.runId}: ${outcome.reason}`;
  }
}

// ---------------------------------------------------------------------------
// Production deps wiring
// ---------------------------------------------------------------------------

/** Read the durable `blocked-on-human` record for a run, or null. */
function readParkedRunProd(runId: string): SupervisedRun | null {
  try {
    const runs = readAllRuns(config.SUPERVISED_RUNS_FILE);
    return runs.find((r) => r.id === runId && r.status === 'blocked-on-human') ?? null;
  } catch (err) {
    log.warn('readParkedRun failed', { runId, error: (err as Error).message });
    return null;
  }
}

/** `git status --porcelain` in the worktree → list of dirty/uncommitted paths. */
async function gitStatusPorcelainProd(worktreePath: string): Promise<string[]> {
  const { stdout } = await defaultRunGit(['status', '--porcelain'], { cwd: worktreePath });
  return stdout.split('\n').map((l) => l.trim()).filter(Boolean);
}

/** Clear the parked hold by flipping the supervised record to its terminal
 *  status — the single signal that frees the per-project slot. */
function clearParkedHoldProd(run: SupervisedRun, terminalStatus: 'completed' | 'failed'): void {
  try {
    upsertRun({ ...run, status: terminalStatus }, config.SUPERVISED_RUNS_FILE);
  } catch (err) {
    log.warn('clearParkedHold failed', { id: run.id, error: (err as Error).message });
  }
}

/** Explicit discard of a confirmed-dirty parked worktree: SIGKILL any reparented
 *  grandchild still holding it, then force-remove it. */
async function discardDirtyWorktreeProd(run: SupervisedRun, worktreePath: string): Promise<void> {
  const product = getProductConfig(run.product, config.PRODUCTS_CONFIG_FILE);
  sweepWorktreeProcesses(worktreePath);
  await destroyWorktree(
    {
      product: run.product,
      project: run.project,
      worktree: worktreePath,
      egressAllowlist: product.egressAllowlist,
    },
    {
      productsConfigPath: config.PRODUCTS_CONFIG_FILE,
      worktreeRoot: config.WORKTREE_ROOT,
      runGit: defaultRunGit,
    },
  );
}

/**
 * COLD-finalize a clean parked run through the Project 15 finalizer in
 * `gated-merge` mode. There is no live process/transcript/baseSha at release
 * time, so recompute baseSha via merge-base, classify on the current work
 * product, and drive `runFinalizer` with the REAL gate/merge/push/delete
 * effects. Mirrors `finalizeStaleRun`'s building blocks but ALWAYS gated-merge
 * (the gate is what makes that safe) — never its fresh-run hold default.
 *
 * `writeSupervisionTerminal` stays inert: the release runtime owns the terminal
 * supervision write via `clearParkedHold` (which runs AFTER this resolves), so
 * the parked hold persists for the whole finalization.
 */
async function coldFinalizeGatedMergeProd(run: SupervisedRun, worktreePath: string): Promise<MutationEvent> {
  for (const [label, slug] of [['id', run.id], ['product', run.product], ['project', run.project]] as const) {
    if (!VALID_SLUG.test(slug)) {
      throw new Error(`release: invalid ${label} slug '${slug}' on parked run`);
    }
  }
  const product = getProductConfig(run.product, config.PRODUCTS_CONFIG_FILE);
  const repoPath = product.repoPath;
  const baseBranch = product.baseBranch;
  const validationCommands = product.validationCommands ?? [];
  const branch = workBranchName(run.project);

  const mb = await defaultRunGit(['merge-base', baseBranch, branch], { cwd: repoPath });
  const baseSha = mb.stdout.trim();
  if (!baseSha) throw new Error(`release: no merge-base for ${branch} on ${run.product}`);

  // No spawn-time tasks baseline (cold finalize): pass the same content as
  // baseline + final so computeTaskTransitions counts every still-unchecked task
  // as `tasksRemaining` (the absolute unchecked count — the release-appropriate
  // signal). branch-complete still requires zero unchecked, so it never over-claims.
  let finalTasks = '';
  try {
    finalTasks = readFileSync(join(worktreePath, 'docs', 'projects', run.project, 'tasks.md'), 'utf8');
  } catch {
    /* tasks.md absent/unreadable → empty (transitions fall back to commit/tree state) */
  }
  const productFacts = await computeWorkProduct({
    runGit: defaultRunGit,
    cwd: worktreePath,
    baseSha,
    branch,
    baselineTasks: finalTasks,
    finalTasks,
  });
  const exit: ExitFacts = {
    exitCode: null,
    signal: null,
    cancelled: false,
    durationMs: 0,
    exitFact: 'reaped-after-terminal-result',
  };
  const classified = classifyOutcome({ exit, product: productFacts });
  const outcome = classified.outcome;
  const endedAt = new Date().toISOString();
  const scrubbedReason = scrubPathsInText(`released: ${classified.reason}`);
  const startedAtMs = Number.isNaN(Date.parse(run.startedAt)) ? Date.parse(endedAt) : Date.parse(run.startedAt);

  let gateHeldReason: GateFailReason | null = null;
  const integrationWorktree = join(config.WORKTREE_ROOT, `gate-${run.product}-${run.id}`);

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

  const buildSummary = (merged?: boolean, branchDeleted?: boolean): WorkRunSummary => ({
    id: run.id,
    project: run.project,
    product: run.product,
    target: run.target ?? { kind: 'project', slug: run.project },
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
    // merged + baseBranch co-occur (the post-finalize disposition re-write);
    // branchDeleted rides the same re-write.
    ...(merged !== undefined ? { merged, baseBranch } : {}),
    ...(branchDeleted !== undefined ? { branchDeleted } : {}),
  });

  const effects: FinalizerEffects = {
    classify: async () => terminalEvent,
    flushTranscript: async () => {},
    writeSummary: () => {
      try {
        writeSummary(join(config.WORK_RUNS_DIR, run.id), buildSummary());
      } catch (err) {
        log.warn('release: writeSummary failed', { id: run.id, error: (err as Error).message });
      }
    },
    appendIndexRow: () => {
      try {
        appendIndexRow(config.WORK_RUNS_INDEX_FILE, {
          id: run.id,
          project: run.project,
          outcome,
          durationMs: Math.max(0, Date.parse(endedAt) - startedAtMs),
          startedAt: run.startedAt,
          endedAt,
        });
      } catch (err) {
        log.warn('release: appendIndexRow failed', { id: run.id, error: (err as Error).message });
      }
    },
    // Inert — the release runtime owns the terminal supervision write via
    // clearParkedHold (after this resolves), keeping the parked hold in place.
    writeSupervisionTerminal: () => {},
    removeWorktree: async () => {
      sweepWorktreeProcesses(worktreePath);
      await destroyWorktree(
        {
          product: run.product,
          project: run.project,
          worktree: worktreePath,
          egressAllowlist: product.egressAllowlist,
          baseSha,
        },
        { productsConfigPath: config.PRODUCTS_CONFIG_FILE, worktreeRoot: config.WORKTREE_ROOT, runGit: defaultRunGit },
      );
    },
    recordPhase: (phase) => recordWorkRunPhase(config.WORK_RUNS_DIR, run.id, phase),
    readLastPhase: () => readLastWorkRunPhase(config.WORK_RUNS_DIR, run.id),
    gate: () =>
      withBaseBranchLock(run.product, baseBranch, () =>
        runGate({
          product: run.product,
          repoPath,
          baseBranch,
          branch,
          integrationWorktree,
          validationCommands,
          tasksRemaining: productFacts.transitions.tasksRemaining,
          concurrentRun: hasConcurrentRunForProduct(run.product, run.id),
          commandTimeoutMs: config.WORK_RUN_GATE_COMMAND_TIMEOUT_MS,
          validationArtifactsDir: join(config.WORK_RUNS_DIR, run.id, 'validation-diagnostics'),
        }),
      ),
    alert: (reason: GateFailReason) => {
      gateHeldReason = reason;
      log.warn('release: held at branch-complete (gate failed)', { id: run.id, branch, reason });
    },
    mergeBranch: async () => {
      const message = `rune(${run.product}): merge released work-run branch ${branch}`;
      try {
        await defaultRunGit(['merge', '--no-ff', branch, '-m', message], { cwd: repoPath });
      } catch (err) {
        // Redact any credential-bearing remote URL before the error propagates
        // to the mutation pipeline's crash handler (which persists it to
        // mutations.jsonl) — mirrors work-runner's merge/push redaction.
        throw new Error(redactSecrets(`git merge failed: ${(err as Error).message}`));
      }
    },
    abortMerge: async () => {
      await defaultRunGit(['merge', '--abort'], { cwd: repoPath });
    },
    pushBranch: async () => {
      try {
        await defaultRunGit(['push', 'origin', baseBranch], { cwd: repoPath });
      } catch (err) {
        throw new Error(redactSecrets(`git push failed: ${(err as Error).message}`));
      }
    },
    deleteBranch: async () => {
      await defaultRunGit(['branch', '-d', branch], { cwd: repoPath });
    },
  };

  const result = await runFinalizer(
    { mode: 'gated-merge', runId: run.id, project: run.project, product: run.product, branch, baseBranch },
    effects,
  );

  // Stamp the gated-merge disposition onto the terminal event + re-write the
  // summary with the resolved merge/delete (the finalizer's own writeSummary ran
  // BEFORE the merge). Disposition keys are only meaningful for a branch-complete
  // run; a held run carries `merged:false` + the gate reason, never a silent drop.
  if (readOutcome(result.terminalEvent) === 'branch-complete') {
    const termData = (result.terminalEvent.data ?? {}) as Record<string, unknown>;
    termData['merged'] = result.merged;
    termData['branchDeleted'] = result.branchDeleted;
    termData['baseBranch'] = baseBranch;
    if (!result.merged && gateHeldReason) termData['gateHeldReason'] = gateHeldReason;
    result.terminalEvent.data = termData;
    try {
      writeSummary(join(config.WORK_RUNS_DIR, run.id), buildSummary(result.merged, result.branchDeleted));
    } catch (err) {
      log.warn('release: post-finalize summary re-write failed', { id: run.id, error: (err as Error).message });
    }
  }
  return result.terminalEvent;
}

/** Another work-run owns the same product right now (its branch could be based
 *  on a base branch this release's merge is about to move) — fails the gate
 *  toward HOLD. Excludes the release mutation itself (kind `work-run-release`). */
function hasConcurrentRunForProduct(product: string, releaseRunId: string): boolean {
  return [...activeRuns.values()].some(
    (h) =>
      h.descriptor.kind === 'work-run' &&
      h.descriptor.id !== releaseRunId &&
      ((h.descriptor.payload as { product?: string }).product ?? 'rune') === product &&
      h.descriptor.status === 'running',
  );
}

/** Production preflight deps. */
export function defaultPreflightDeps(): ReleasePreflightDeps {
  return {
    readParkedRun: readParkedRunProd,
    worktreeFor: (product, project) => worktreePathFor(product, project, config.WORKTREE_ROOT),
    worktreeExists: (p) => existsSync(p),
    gitStatusPorcelain: gitStatusPorcelainProd,
  };
}

/** Production release-runtime deps for the applier core. */
export function defaultReleaseRuntimeDeps(): ReleaseRuntimeDeps {
  return {
    ...defaultPreflightDeps(),
    coldFinalizeGatedMerge: coldFinalizeGatedMergeProd,
    discardDirtyWorktree: discardDirtyWorktreeProd,
    clearParkedHold: clearParkedHoldProd,
  };
}

/** Production deps for the shared release request — wires the real mutation
 *  pipeline. `source` is recorded for audit. */
export function defaultReleaseRequestDeps(source: ReleaseSource): ReleaseRequestDeps {
  return {
    preflight: defaultPreflightDeps(),
    createReleaseMutation: async (payload) => {
      const result = await createMutation('work-run-release', { ...payload }, source);
      return result.ok ? { ok: true, id: result.descriptor.id } : { ok: false, reason: result.reason };
    },
  };
}

// ---------------------------------------------------------------------------
// The `work-run-release` mutation applier
// ---------------------------------------------------------------------------

// LAZY holder: `defaultReleaseRuntimeDeps()` resolves production deps
// (`defaultRunGit`, etc.) eagerly, so building it at module-load would force
// those imports to resolve the instant ANY importer (e.g. webview.ts) is loaded
// — breaking unit suites that partially-mock `sandbox-runtime`. Resolve it
// lazily on first `apply()` instead (or on a test override).
let releaseRuntimeDeps: ReleaseRuntimeDeps | null = null;

function getReleaseRuntimeDeps(): ReleaseRuntimeDeps {
  return (releaseRuntimeDeps ??= defaultReleaseRuntimeDeps());
}

/** Test seam: override (part of) the applier's release-runtime deps. */
export function __setReleaseRuntimeForTest(partial: Partial<ReleaseRuntimeDeps>): void {
  releaseRuntimeDeps = { ...getReleaseRuntimeDeps(), ...partial };
}

/** Test seam: restore the production release-runtime deps. */
export function __resetReleaseRuntimeForTest(): void {
  releaseRuntimeDeps = null;
}

/**
 * The `work-run-release` mutation applier. Auto-approved (the human already
 * decided to release; the preflight gated dirty-confirm). Registered alongside
 * the other appliers in `src/index.ts`.
 */
export const workRunReleaseApplier: MutationApplier<WorkRunReleasePayload> = {
  kind: 'work-run-release',
  autoApprove: true,
  // A short-lived CONTROL mutation: it acts ON the parked run (which already has
  // its own supervised `blocked-on-human` record the release transitions). Opt
  // out of supervision tracking so the pipeline doesn't seed a redundant
  // bare-UUID record that would trip the stall nudge on a slow gate or produce a
  // spurious crash-recovery warning.
  supervised: false,
  validate(payload: WorkRunReleasePayload): { ok: true } | { ok: false; reason: string } {
    if (!payload.runId || typeof payload.runId !== 'string') {
      return { ok: false, reason: 'runId is required' };
    }
    if (!VALID_SLUG.test(payload.runId)) {
      return { ok: false, reason: `invalid runId: ${payload.runId}` };
    }
    return { ok: true };
  },
  async *apply(
    descriptor: MutationDescriptor<WorkRunReleasePayload>,
    _ctx: ApplyContext,
  ): AsyncIterable<MutationEvent> {
    yield* runWorkRunRelease(descriptor.payload, getReleaseRuntimeDeps());
  },
};
