/**
 * Project 13 Phase 1c — the shared work-run RELEASE runtime.
 *
 * A parked (`blocked-on-human`) run keeps its worktree live, holds the
 * per-project slot, and blocks the Project 15 finalizer until a human releases
 * it. Release is reachable from BOTH the cockpit (`POST /api/work-runs/:id/release`)
 * and Telegram (callback `work-run-release:<id>`); both surfaces route through
 * the ONE shared runtime here so they can't drift.
 *
 * Two halves:
 *   1. `releasePreflight(runId, opts, deps)` — a PURE-over-injected-IO decision
 *      used by both surfaces BEFORE a mutation is created:
 *        - not parked / unknown run        → `not-parked` (no mutation)
 *        - dirty worktree + no confirm     → `dirty-confirm` + the file list (no mutation)
 *        - clean worktree                  → `release` (create a clean cold-finalize mutation)
 *        - dirty worktree + `confirmDirty` → `release` (create an explicit-discard mutation)
 *   2. `runWorkRunRelease(payload, deps)` — the `work-run-release` applier core.
 *      It RECHECKS parked + dirty state, then:
 *        - clean      → COLD-finalize through the Project 15 finalizer in
 *          `gated-merge` mode (recompute baseSha via merge-base → classify on
 *          the current work product → runFinalizer). Reuses `finalizeStaleRun`'s
 *          building blocks but drives `gated-merge` EXPLICITLY (not its fresh-run
 *          hold default). The supervision `blocked-on-human` hold stays until the
 *          finalizer terminal write; only then is the project slot freed.
 *        - confirmed dirty → explicit DISCARD: destroy the worktree, clear the
 *          parked hold AFTER destructive cleanup, emit terminal events, and do
 *          NOT invoke gated merge.
 *
 * STUB (Phase 1c "Tests write first"): `releasePreflight` returns `not-parked`
 * and the applier yields a `failed` "not implemented" terminal until the
 * implementation task lands — the clean/dirty/cold-finalize tests are RED, the
 * not-parked guard tests pass.
 */

import type { SupervisedRun } from '../intent/supervision.js';
import type { MutationApplier, MutationDescriptor, MutationEvent, ApplyContext } from '../transport/mutations.js';
import type { GitRunner } from './sandbox-runtime.js';

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
 * cockpit route and the Telegram callback call this first.
 *
 * STUB: always returns `not-parked` until the implementation lands.
 */
export async function releasePreflight(
  runId: string,
  _opts: { confirmDirty?: boolean },
  _deps: ReleasePreflightDeps,
): Promise<ReleasePreflightOutcome> {
  return { kind: 'not-parked', runId };
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
  runGit: GitRunner;
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
 * one. Yields terminal mutation events.
 *
 * STUB: yields a single `failed` "not implemented" terminal until the
 * implementation lands, so the cold-finalize / discard / hold tests are RED.
 */
export async function* runWorkRunRelease(
  payload: WorkRunReleasePayload,
  _deps: ReleaseRuntimeDeps,
): AsyncIterable<MutationEvent> {
  yield {
    mutationId: payload.runId,
    ts: new Date().toISOString(),
    kind: 'failed',
    data: { reason: 'work-run-release not implemented (Phase 1c stub)' },
  };
}

/**
 * The `work-run-release` mutation applier. Auto-approved (the human already
 * decided to release; the preflight gated dirty-confirm). Registered alongside
 * the other appliers in `src/index.ts`.
 *
 * STUB: not yet registered / `validate` rejects until the implementation lands.
 */
export const workRunReleaseApplier: MutationApplier<WorkRunReleasePayload> = {
  kind: 'work-run-release',
  autoApprove: true,
  validate(_payload: WorkRunReleasePayload): { ok: true } | { ok: false; reason: string } {
    return { ok: false, reason: 'work-run-release not implemented (Phase 1c stub)' };
  },
  async *apply(
    _descriptor: MutationDescriptor<WorkRunReleasePayload>,
    _ctx: ApplyContext,
  ): AsyncIterable<MutationEvent> {
    yield {
      mutationId: _descriptor.id,
      ts: new Date().toISOString(),
      kind: 'failed',
      data: { reason: 'work-run-release not implemented (Phase 1c stub)' },
    };
  },
};
