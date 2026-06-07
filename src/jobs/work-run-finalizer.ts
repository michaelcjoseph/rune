/**
 * Work-run finalizer (project 15 — "Work-Run Finalizer: terminal correctness +
 * gated auto-merge").
 *
 * The single, idempotent, phase-recorded state machine that owns the terminal
 * end of a `/work --auto` run. It runs in two explicit modes:
 *
 *   - `hold`  (P0, no policy change): classify → flush transcript → write
 *     summary/index → resolve the worktree (remove per the existing non-merge
 *     policy, branch left intact) → terminal supervision write. NEVER merges,
 *     pushes, or deletes the branch. This is the mode the watchdog and the
 *     startup-recovery path drive a run through, so terminal correctness lands
 *     without any merge-policy change.
 *
 *   - `gated-merge` (P1, policy change): verify the hard gate → merge → push +
 *     verify → remove worktree → delete branch → terminal write. Reuses the
 *     gen-eval-loop's `realMergeBranch`; push happens BEFORE branch delete so
 *     origin is the durable backup.
 *
 * Both modes share the SAME durable phase store so a crash mid-finalize resumes
 * at the right step (P0.4 recovery) instead of re-merging or orphaning. Every
 * side-effect is an injected seam (`FinalizerEffects`) so the machine is
 * unit-testable with spies — no real git, worktree, or store.
 *
 * STATUS: SCAFFOLD (test-first). `runFinalizer` throws `notImplemented` until the
 * P0.4a task implements `hold` mode and the P1.5 task extends it to
 * `gated-merge`. The type surface here is the contract pinned by
 * `work-run-finalizer.test.ts` (test-plan.md §4, §6, §7).
 *
 * See docs/projects/15-work-run-finalizer/{spec.md, tasks.md, test-plan.md}.
 */

import type { MutationEvent } from '../transport/mutations.js';
import type { WorkOutcome } from './work-run-classify.js';

function notImplemented(fn: string): never {
  throw new Error(`work-run-finalizer: ${fn} not implemented (project 15 Phase 1 P0.4a pending)`);
}

/** Terminal-write strategy. `hold` never touches `main`; `gated-merge` lands the
 *  branch through the hard gate. */
export type FinalizerMode = 'hold' | 'gated-merge';

/**
 * Durable, ordered finalize phases — the resume checkpoints. A crash after any
 * phase lets recovery resume at the next one rather than re-running a mutating
 * step. `merged-not-pushed` / `pushed-not-deleted` are reached only in
 * `gated-merge` mode (push-before-delete: origin is the backup before the local
 * branch is removed).
 */
export type FinalizerPhase =
  | 'classified'
  | 'transcript-flushed'
  | 'summary-written'
  | 'index-appended'
  | 'worktree-resolved'
  | 'merged-not-pushed'
  | 'pushed-not-deleted'
  | 'finalized';

/** Terminal supervision status the finalizer writes — always one of these, so a
 *  run NEVER ends as a quiet-pinging `running`. */
export type FinalizerSupervisionStatus = 'completed' | 'failed';

export interface FinalizerInput {
  mode: FinalizerMode;
  runId: string;
  project: string;
  product: string;
  /** The work branch (e.g. `jarvis-work/15-...`). */
  branch: string;
  /** The base branch a `gated-merge` would land on (e.g. `main`). Optional in
   *  `hold` mode, which never reads it. */
  baseBranch?: string;
}

/**
 * Injected side-effects + the durable phase store. Every effect is a seam so the
 * state machine is unit-testable with spies. The merge/push/delete effects are
 * OPTIONAL and MUST NOT be invoked in `hold` mode — the hold-mode tests assert
 * they are never called.
 */
export interface FinalizerEffects {
  /** Classify on work product. Wraps `finalizeWorkRun` — INCLUDING its
   *  best-effort `exportForensics` step, which is bundled inside this closure
   *  (forensics are a peer of classification, captured while the worktree still
   *  exists). Returns the single terminal MutationEvent carrying outcome +
   *  workProduct + exit. */
  classify: () => Promise<MutationEvent>;
  /** Flush + await the durable transcript before summary/index/terminal writes. */
  flushTranscript: () => Promise<void>;
  writeSummary: (terminalEvent: MutationEvent) => void;
  appendIndexRow: (terminalEvent: MutationEvent) => void;
  /** Terminal supervision/mutation write — the run never stays `running`. */
  writeSupervisionTerminal: (
    status: FinalizerSupervisionStatus,
    terminalEvent: MutationEvent,
  ) => void;
  /** Remove the worktree (the branch ref is left intact in `hold` mode). */
  removeWorktree: () => Promise<void>;
  /** Durable phase store: advance to `phase`. Recorded after EACH mutating step
   *  (not only at the end) so a crash-resume can skip exactly the steps already
   *  committed. */
  recordPhase: (phase: FinalizerPhase) => void;
  /** Read the last durable phase the prior finalize attempt reached, or null for
   *  a fresh run. The P0.4 crash-resume path consults this at the top of
   *  `runFinalizer` to resume at the next step instead of re-running a mutating
   *  one (e.g. a re-merge or double-push). */
  readLastPhase: () => FinalizerPhase | null;
  // --- gated-merge only (P1) — MUST NOT be invoked in `hold` mode. ---
  mergeBranch?: () => Promise<void>;
  pushBranch?: () => Promise<void>;
  deleteBranch?: () => Promise<void>;
}

export interface FinalizerResult {
  outcome: WorkOutcome;
  /** Terminal supervision status written (never `running`). */
  supervisionStatus: FinalizerSupervisionStatus;
  worktreeRemoved: boolean;
  merged: boolean;
  branchDeleted: boolean;
  /** Phases recorded, in order. */
  phases: FinalizerPhase[];
}

/**
 * Drive a work run to a correct terminal state through the shared, idempotent,
 * phase-recorded state machine. SCAFFOLD — throws until P0.4a implements `hold`
 * mode (and P1.5 extends `gated-merge`).
 */
export async function runFinalizer(
  _input: FinalizerInput,
  _effects: FinalizerEffects,
): Promise<FinalizerResult> {
  return notImplemented('runFinalizer');
}
