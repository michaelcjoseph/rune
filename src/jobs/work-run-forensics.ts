/**
 * Work-run forensics export (project 11, Phase 3 — "Branch & forensic
 * retention").
 *
 * When a run terminates, `apply()` exports a reconstructable evidence bundle to
 * the per-run dir BEFORE the worktree is destroyed (the worktree is the only
 * place the run branch + uncommitted tree live):
 *
 *   logs/work-runs/<id>/
 *     bundle.git          # `git bundle create` of the run branch
 *     diffstat.txt        # git diff --stat baseSha..branch
 *     status.txt          # git status --porcelain
 *     diff.patch          # working-tree diff (uncommitted, unstaged)
 *     diff-staged.patch   # staged diff
 *     untracked.tar       # non-clean runs only — tarball of untracked files
 *
 * All git invocations go through the injected `GitRunner` seam (the same one
 * `createWorktree`/`computeWorkProduct` take), so the suite never shells out to
 * real git. The text artifacts are captured from `runGit` stdout and written by
 * this module; `bundle.git` and `untracked.tar` are produced by the subprocess
 * the command spawns (git / tar), which writes the file at the given path.
 *
 * SCAFFOLD: signatures/types are settled here for the Phase 3 test suite to pin
 * test-first; the body is unimplemented until the Phase 3 implementation task.
 */

import type { GitRunner } from './sandbox-runtime.js';

export interface ExportForensicsOpts {
  /** Injected git runner — same seam as createWorktree/computeWorkProduct. */
  runGit: GitRunner;
  /** Worktree directory: cwd for every git command and the bundle source. */
  worktree: string;
  /** Per-run output directory (`logs/work-runs/<id>/`). Created if absent. */
  outDir: string;
  /** Captured base sha; diffstat range is `baseSha..branch`. */
  baseSha: string;
  /** The run branch — bundled into `bundle.git`. */
  branch: string;
  /** True when the tree had tracked changes or untracked files. Gates the
   *  `untracked.tar` export (clean runs skip it). */
  nonClean: boolean;
}

export interface ForensicsResult {
  /** Absolute path of the per-run forensics directory (`outDir`). */
  forensicsPath: string;
  /** Basenames of the artifacts actually written, for the run record / logging. */
  files: string[];
}

function notImplemented(fn: string): never {
  throw new Error(`work-run-forensics: ${fn} not implemented (project 11 Phase 3 pending)`);
}

/**
 * Export the forensic evidence bundle for a terminated run into `outDir`.
 * Best-effort by contract: the caller (`apply()`'s `exportForensics` callback)
 * swallows a rejection so a forensics failure never denies the terminal event.
 * Returns the artifacts written so the run record can reference them.
 */
export async function exportForensics(_opts: ExportForensicsOpts): Promise<ForensicsResult> {
  notImplemented('exportForensics');
}
