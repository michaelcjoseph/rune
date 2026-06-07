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
 * STATUS: `hold` mode is implemented (P0.4a) and pinned by
 * `work-run-finalizer.test.ts` (test-plan.md §4). `gated-merge` mode throws
 * `notImplemented` until P1.5 (test-plan.md §6, §7). The crash-resume matrix
 * (consulting `readLastPhase()` to skip already-committed phases) lands in
 * Phase 3.
 *
 * See docs/projects/15-work-run-finalizer/{spec.md, tasks.md, test-plan.md}.
 */

import type { MutationEvent } from '../transport/mutations.js';
import type { WorkOutcome } from './work-run-classify.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('work-run-finalizer');

function notImplemented(fn: string): never {
  throw new Error(`work-run-finalizer: ${fn} not implemented (project 15 pending)`);
}

/** Read the typed `outcome` off a classified terminal event (mirrors
 *  applyOutcomeToDescriptor / buildSummary). Falls back to `failed` if absent
 *  (the classification-error path omits it). */
function readOutcome(terminalEvent: MutationEvent): WorkOutcome {
  const data = (terminalEvent.data ?? {}) as Record<string, unknown>;
  return typeof data['outcome'] === 'string' ? (data['outcome'] as WorkOutcome) : 'failed';
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
  /** Evaluate the hard merge gate (tests green, clean tree, zero tasks
   *  remaining, no conflict/bad-base, no concurrent owner, product has
   *  validationCommands and they pass within the timeout). Runs in an
   *  integration worktree so a red check never alters local `main`. */
  gate?: () => Promise<GateResult>;
  /** Alert the operator that a `gated-merge` run STOPPED at `branch-complete`
   *  (gate failed) instead of landing on `main`. */
  alert?: (reason: GateFailReason) => void;
  /** `git merge --no-ff <branch>` onto the base branch (in an integration
   *  worktree / on the base). */
  mergeBranch?: () => Promise<void>;
  /** Push the merged base branch to origin (the durable backup BEFORE delete). */
  pushBranch?: () => Promise<void>;
  /** Delete the work branch — only AFTER a successful push. */
  deleteBranch?: () => Promise<void>;
}

/** Why the hard merge gate refused to land a run on `main`. */
export type GateFailReason =
  | 'tests-red'
  | 'dirty-tree'
  | 'tasks-remaining'
  | 'merge-conflict'
  | 'concurrent-run'
  | 'missing-validation-command'
  | 'validation-timeout';

/** Gate verdict: merge only on `ok`; otherwise stop at `branch-complete`. */
export type GateResult = { ok: true } | { ok: false; reason: GateFailReason };

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
 * phase-recorded state machine.
 *
 * `hold` mode (P0.4a) is implemented: classify on work product → flush the
 * transcript → write summary + index → resolve the worktree (remove it; the
 * branch ref is left intact) → write terminal supervision. It NEVER merges,
 * pushes, or deletes the branch, and the run never ends `running`. Each step
 * records a durable phase so the P-3 resume matrix can resume mid-finalize.
 *
 * `gated-merge` mode (P1.5) is not built yet — it throws until that task.
 *
 * NB: hold mode runs straight through. The crash-resume matrix (Phase 3,
 * test-plan §6) is what consults `effects.readLastPhase()` to skip
 * already-committed phases (e.g. to avoid a duplicate index-row append on
 * resume); P0.4a does not yet branch on it.
 */
export async function runFinalizer(
  input: FinalizerInput,
  effects: FinalizerEffects,
): Promise<FinalizerResult> {
  if (input.mode === 'gated-merge') {
    return notImplemented('runFinalizer(gated-merge)');
  }

  const phases: FinalizerPhase[] = [];
  const record = (phase: FinalizerPhase): void => {
    effects.recordPhase(phase);
    phases.push(phase);
  };

  // Classify on work product (wraps finalizeWorkRun, incl. forensics).
  const terminalEvent = await effects.classify();
  record('classified');

  // Flush the durable transcript before the summary/index/terminal writes so
  // every buffered event is on disk first.
  await effects.flushTranscript();
  record('transcript-flushed');

  effects.writeSummary(terminalEvent);
  record('summary-written');

  // `appendIndexRow` is append-only. Phase 3's resume matrix MUST consult
  // `readLastPhase()` and skip this when `index-appended` is already recorded,
  // or a crash-then-resume produces a duplicate index row for the same run.
  effects.appendIndexRow(terminalEvent);
  record('index-appended');

  // Hold mode: remove the worktree per the existing non-merge policy (branch ref
  // left intact — no merge → no delete). Best-effort: a removal failure must NOT
  // block the terminal supervision write (req 17 — the run must never be left a
  // quiet-pinging `running`). A leftover worktree is reaped later by the orphan
  // sweep / GC; the decision is recorded in `worktreeRemoved`.
  let worktreeRemoved = false;
  try {
    await effects.removeWorktree();
    worktreeRemoved = true;
  } catch (err) {
    log.warn('hold-mode worktree removal failed; finalizing anyway', {
      runId: input.runId,
      error: (err as Error).message,
    });
  }
  record('worktree-resolved');

  // Terminal supervision write — the run reaches a real terminal status and
  // never stays a quiet-pinging `running`.
  const supervisionStatus: FinalizerSupervisionStatus =
    terminalEvent.kind === 'completed' ? 'completed' : 'failed';
  effects.writeSupervisionTerminal(supervisionStatus, terminalEvent);
  record('finalized');

  return {
    outcome: readOutcome(terminalEvent),
    supervisionStatus,
    worktreeRemoved,
    merged: false,
    branchDeleted: false,
    phases,
  };
}
