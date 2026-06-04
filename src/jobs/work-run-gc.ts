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
 * Implemented in Phase 3; run best-effort on startup (`src/index.ts`) and on
 * each run completion (`work-runner.apply`).
 */

import { readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createLogger } from '../utils/logger.js';
import { isContainedIn } from '../intent/sandbox.js';
import type { GitRunner } from './sandbox-runtime.js';

const log = createLogger('work-run-gc');

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

/**
 * Pure GC planner. Returns the terminal, unprotected run ids to delete —
 * oldest-first — so the retained set is within BOTH `maxRuns` and `maxBytes`.
 * Protected and non-terminal runs are never deleted (even if that leaves the
 * set over a cap — the cap is a target, not a guarantee against live work), and
 * the caps are measured over the prunable set only. With everything already
 * under both caps, returns an empty plan (idempotent).
 */
export function planGc(opts: PlanGcOpts): GcPlan {
  const { entries, protectedIds, maxRuns, maxBytes } = opts;
  // Only terminal, unprotected runs are prunable. Oldest-first by endedAt
  // (ISO strings sort chronologically), so the oldest evidence is dropped first.
  const prunable = entries
    .filter(e => e.terminal && !protectedIds.has(e.id))
    .sort((a, b) => (a.endedAt < b.endedAt ? -1 : a.endedAt > b.endedAt ? 1 : 0));

  let retainedCount = prunable.length;
  let retainedBytes = prunable.reduce((sum, e) => sum + e.bytes, 0);
  const deleteIds: string[] = [];
  for (const e of prunable) {
    // Stop as soon as the prunable set fits under both caps.
    if (retainedCount <= maxRuns && retainedBytes <= maxBytes) break;
    deleteIds.push(e.id);
    retainedCount -= 1;
    retainedBytes -= e.bytes;
  }
  return { deleteIds };
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
 * async I/O FIRST (Phase A — directory sizing, summary reads, the `git worktree
 * list` call), then build the protected set + `planGc` (pure) + the `rmSync` dir
 * deletes as ONE synchronous run (Phase B) with no `await` between snapshotting
 * the protected set and the last `rmSync` — so Node's single-threaded execution
 * guarantees two concurrent passes can't interleave a read-modify-delete. The
 * branch-prune git calls (Phase C) run after, with awaits: that is safe because a
 * concurrent pass finds the deleted dir gone (its summary unreadable → not
 * prunable), and a duplicate `branch -D` of the same ref just no-ops with a
 * logged warning.
 */
export async function gcWorkRuns(opts: GcWorkRunsOpts): Promise<GcResult> {
  const { workRunsDir, runGit, repoPath, activeIds, nonTerminalIds, maxRuns, maxBytes } = opts;

  // --- Phase A: gather all inputs (the only awaits live here) ---
  let dirNames: string[];
  try {
    dirNames = readdirSync(workRunsDir);
  } catch {
    return { deletedIds: [] }; // no work-runs dir yet → nothing to GC
  }

  const entries: GcRunEntry[] = [];
  for (const name of dirNames) {
    const dir = join(workRunsDir, name);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    entries.push(discoverRun(name, dir));
  }

  // Branches checked out in a worktree must never be deleted — read the live
  // worktree list (best-effort; a failure leaves the worktree-protected set
  // empty rather than aborting GC).
  let porcelain = '';
  try {
    porcelain = (await runGit(['worktree', 'list', '--porcelain'], { cwd: repoPath })).stdout;
  } catch (err) {
    log.warn('gcWorkRuns: worktree list failed; proceeding without worktree protection', {
      error: (err as Error).message,
    });
  }
  const checkedOutBranches = parseCheckedOutBranches(porcelain);

  // --- Phase B: build protected set + plan + delete dirs, with NO await between
  //     reading the protected set and the rmSync deletes (same-tick discipline,
  //     requirement 18) so two concurrent completions can't race a delete. ---
  const protectedIds = new Set<string>([...activeIds, ...nonTerminalIds]);
  for (const e of entries) {
    if (e.branch && checkedOutBranches.has(e.branch)) protectedIds.add(e.id);
  }
  const { deleteIds } = planGc({ entries, protectedIds, maxRuns, maxBytes });
  const byId = new Map(entries.map(e => [e.id, e]));
  for (const id of deleteIds) {
    const e = byId.get(id);
    if (!e) continue;
    // Defense-in-depth before the most destructive op in the codebase: a
    // recursive force-delete must never escape workRunsDir. `e.dir` is
    // `join(workRunsDir, <readdir name>)` and POSIX names can't contain `/`, so
    // this is belt-and-suspenders, mirroring sandbox-fs's `assertWritable`.
    if (!isContainedIn(workRunsDir, e.dir)) {
      log.warn('gcWorkRuns: refusing to delete dir outside workRunsDir', { id, dir: e.dir });
      continue;
    }
    try {
      rmSync(e.dir, { recursive: true, force: true });
    } catch (err) {
      log.warn('gcWorkRuns: dir delete failed', { id, error: (err as Error).message });
    }
  }

  // The stable per-project resume branch (`jarvis-work/<slug>`) is shared by
  // EVERY run for that project, so the same branch name appears in many runs'
  // summaries. Pruning an aged-out run must never delete a branch a RETAINED
  // (newer) run still lives on — that would throw away the project's resume
  // point and re-introduce the re-fork bug in a new form (docs/projects/bugs.md).
  // Collect the branches still referenced by retained runs; the shared branch is
  // only deleted once the LAST run referencing it ages out.
  const deleteIdSet = new Set(deleteIds);
  const retainedBranches = new Set<string>();
  for (const e of entries) {
    if (!deleteIdSet.has(e.id) && e.branch) retainedBranches.add(e.branch);
  }

  // --- Phase C: prune the deleted runs' branch refs (after the dirs are gone).
  //     `-D` (force) because a run branch is intentionally never merged into the
  //     checkout; a checked-out branch is already excluded via protectedIds, and
  //     git refuses to delete a checked-out ref regardless. Best-effort. ---
  for (const id of deleteIds) {
    const branch = byId.get(id)?.branch;
    if (!branch) continue;
    // A retained run still lives on this branch (shared per-project resume
    // branch) — keep it, even though this run's dir was pruned.
    if (retainedBranches.has(branch)) continue;
    // Only ever force-delete a work-run branch. The branch value comes from the
    // run's summary.json on disk; a tampered value (e.g. `main`) is already
    // blocked by the checked-out-branch protection + git's own refusal to delete
    // a checked-out ref, but this prefix guard closes the residual gap when the
    // `worktree list` read failed (empty protection set).
    if (!branch.startsWith('jarvis-work/')) {
      log.warn('gcWorkRuns: refusing to prune a non-work-run branch', { id, branch });
      continue;
    }
    try {
      await runGit(['branch', '-D', branch], { cwd: repoPath });
    } catch (err) {
      log.warn('gcWorkRuns: branch prune failed', { id, branch, error: (err as Error).message });
    }
  }

  return { deletedIds: deleteIds };
}

/** Discover one run dir's GC metadata. A readable `summary.json` marks a
 *  terminal run (it is written only at the terminal event) and supplies
 *  endedAt + branch; a missing/corrupt summary means an in-progress run, which
 *  is non-terminal and therefore never prunable. */
function discoverRun(id: string, dir: string): GcRunEntry {
  const bytes = dirBytes(dir);
  try {
    const summary = JSON.parse(readFileSync(join(dir, 'summary.json'), 'utf8')) as Record<string, unknown>;
    return {
      id,
      dir,
      bytes,
      // '' (missing/non-string endedAt) sorts before any ISO string → treated
      // as the oldest run, pruned first. Conservative for a corrupt summary.
      endedAt: typeof summary['endedAt'] === 'string' ? summary['endedAt'] : '',
      terminal: true,
      branch: typeof summary['branch'] === 'string' ? summary['branch'] : undefined,
    };
  } catch {
    return { id, dir, bytes, endedAt: '', terminal: false };
  }
}

/** Sum the byte sizes of the (flat) files in a per-run dir. Assumes a flat
 *  layout (transcript + forensics are flat files today); a future subdir would
 *  be under-counted (statSync on a dir returns the inode size, not its contents)
 *  and would need a recursive walk. */
function dirBytes(dir: string): number {
  let total = 0;
  try {
    for (const f of readdirSync(dir)) {
      try {
        total += statSync(join(dir, f)).size;
      } catch {
        /* file vanished mid-walk — skip */
      }
    }
  } catch {
    /* dir vanished — 0 */
  }
  return total;
}

/** Extract the branch names checked out in any worktree from
 *  `git worktree list --porcelain` output (`branch refs/heads/<name>` lines).
 *  Distinct from `sandbox-runtime.parseRegisteredWorktrees`, which extracts
 *  worktree PATHS; GC needs the BRANCHES to know which run refs are live. A
 *  detached-HEAD worktree has no `branch` line and so isn't covered here — the
 *  work-runner only ever creates named-branch worktrees, and the branch-prefix
 *  guard + git's own checked-out-ref refusal are the backstops. */
function parseCheckedOutBranches(porcelain: string): Set<string> {
  const out = new Set<string>();
  for (const line of porcelain.split('\n')) {
    const m = /^branch\s+refs\/heads\/(.+)$/.exec(line.trim());
    if (m && m[1]) out.add(m[1]);
  }
  return out;
}
