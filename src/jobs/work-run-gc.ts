/**
 * Work-run garbage collection (project 11, Phase 3 — "Branch & forensic
 * retention").
 *
 * Retained per-run artifacts (transcripts, forensics) and local run-branch refs
 * are bounded by BOTH a run count and a total byte ceiling. GC runs on startup
 * and on each run completion, as a SINGLE SYNCHRONOUS PASS: the protected set is
 * read and the deletes performed with no `await` in between, so two concurrent
 * completions can't interleave a read-modify-delete (the same-tick discipline
 * `supervision-store.ts` documents).
 *
 * The decision is split into a pure planner and an effectful pass:
 *   - `planGc`     — pure over (entries, protectedIds, caps): which terminal,
 *                    unprotected runs to delete, oldest-first, to get back under
 *                    both caps. No I/O, fully fixture-testable.
 *   - `gcWorkRuns` — discovers run dirs under `workRunsDir`, sizes them, builds
 *                    the protected set (activeRuns + non-terminal run-store +
 *                    branches checked out in any worktree, reusing the
 *                    `git worktree list --porcelain` parse), calls `planGc`, and
 *                    deletes the dirs + prunes the local branch refs — never a
 *                    branch a worktree has checked out.
 *
 * SCAFFOLD: signatures/types are settled here for the Phase 3 test suite to pin
 * test-first; the bodies are unimplemented until the Phase 3 implementation task.
 */

import type { GitRunner } from './sandbox-runtime.js';

/** One candidate run for GC, as discovered on disk + cross-referenced with the
 *  run store. */
export interface GcRunEntry {
  id: string;
  /** Absolute path of the per-run dir (`logs/work-runs/<id>/`). */
  dir: string;
  /** Total bytes of the run's on-disk artifacts (transcript + forensics). */
  bytes: number;
  /** ISO end time — the oldest runs are pruned first. */
  endedAt: string;
  /** Only terminal runs are prunable; a still-running run is never deleted. */
  terminal: boolean;
  /** The run branch ref, if known — pruned alongside the dir (never when the
   *  branch is checked out in a worktree). */
  branch?: string;
}

export interface PlanGcOpts {
  entries: GcRunEntry[];
  /** Never pruned: active runs + non-terminal run-store + worktree-checked-out. */
  protectedIds: Set<string>;
  /** Max retained runs (count ceiling). */
  maxRuns: number;
  /** Max retained bytes (size ceiling). */
  maxBytes: number;
}

export interface GcPlan {
  /** Run ids to delete (dir + branch ref), oldest-first. */
  deleteIds: string[];
}

export interface GcWorkRunsOpts {
  /** Root holding the per-run dirs (`logs/work-runs`). */
  workRunsDir: string;
  /** Injected git runner — for `worktree list --porcelain` + `branch -d`. */
  runGit: GitRunner;
  /** Product repo path — cwd for the worktree-list + branch-prune git calls. */
  repoPath: string;
  /** Run ids currently active (from `activeRuns`) — never pruned. */
  activeIds: Set<string>;
  /** Run ids with a non-terminal run-store status — never pruned. */
  nonTerminalIds: Set<string>;
  maxRuns: number;
  maxBytes: number;
}

export interface GcResult {
  /** Run ids whose dir (and branch ref) were deleted this pass. */
  deletedIds: string[];
}

function notImplemented(fn: string): never {
  throw new Error(`work-run-gc: ${fn} not implemented (project 11 Phase 3 pending)`);
}

/**
 * Pure GC planner. Returns the terminal, unprotected run ids to delete —
 * oldest-first — so the retained set is within BOTH `maxRuns` and `maxBytes`.
 * Protected and non-terminal runs are never deleted (even if that leaves the
 * set over a cap — the cap is a target, not a guarantee against live work).
 * With everything already under both caps, returns an empty plan (idempotent).
 */
export function planGc(_opts: PlanGcOpts): GcPlan {
  notImplemented('planGc');
}

/**
 * Effectful GC pass over `workRunsDir`. Discovers + sizes run dirs (reading each
 * `summary.json` for `endedAt`/`branch`/terminal status), builds the protected
 * set (active + non-terminal + worktree-checked-out branches, reusing
 * sandbox-runtime's `git worktree list --porcelain` parse), calls `planGc`, then
 * deletes the planned dirs and prunes their branch refs. Never deletes a branch
 * checked out in a worktree.
 *
 * Implementation contract (same-tick discipline, requirement 18): perform ALL
 * async I/O FIRST — directory sizing, summary reads, the `git worktree list`
 * call — then call `planGc` (pure, sync) and execute the deletes as a synchronous
 * tail (`rmSync` + the branch-prune git calls) with NO `await` between building
 * the protected set and completing the last delete, so two concurrent completions
 * can't interleave a read-modify-delete.
 */
export async function gcWorkRuns(_opts: GcWorkRunsOpts): Promise<GcResult> {
  notImplemented('gcWorkRuns');
}
