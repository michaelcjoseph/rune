/**
 * Worktree-scoped process sweep (project 15, P2.7) — a defense-in-depth fallback
 * reap for reparented/detached grandchildren that the process-group kill
 * (`killProcessTree` via the pgid) misses. When a grandchild double-forks and
 * is reparented to init, it leaves the run's process group, so the pgid SIGKILL
 * can't reach it; but its working directory is still under the run's isolated
 * worktree, so a cwd-scoped sweep finds it.
 *
 * `planWorktreeScopedReap` is the PURE selection core: given a snapshot of
 * candidate processes (pid + cwd) and the run's worktree path, it returns the
 * pids whose cwd is the worktree path or a descendant of it — and ONLY those.
 *
 * IMPL NOTE (P2.7): `isContainedIn` is a LEXICAL check on resolved paths. On
 * macOS `/tmp` symlinks to `/private/tmp`, so the actuator must `realpathSync`
 * BOTH the `ps`/`lsof`-derived cwds AND the worktree path before calling this,
 * or a real process under `/private/tmp/worktrees/...` would miss a
 * `/tmp/worktrees/...` root (same gap the sandbox.ts docstring calls out).
 * Containment is checked with the same lexical `isContainedIn` guard the
 * worktree-removal path uses, so a sibling that merely shares the path as a
 * prefix (`<wt>-evil`) is NOT swept. The actuator (P2.7 impl) supplies the real
 * process table (via `ps`/`lsof`) and the kill adapter; this module never reads
 * the process table or sends a signal, so it is trivially testable on fixtures.
 *
 * SCAFFOLD — `planWorktreeScopedReap` throws until the P2.7 implementation task.
 */

import { isContainedIn } from '../intent/sandbox.js';

/** One candidate process in the swept snapshot. */
export interface SweepProcess {
  pid: number;
  /** The process's current working directory (absolute). */
  cwd: string;
}

/** The reap plan: the pids to signal, scoped to exactly one worktree path. */
export interface WorktreeReapPlan {
  toKill: number[];
}

/**
 * Select the processes whose `cwd` is the worktree path or a descendant of it.
 * Pure; scoped to EXACTLY `worktreePath` via `isContainedIn` (a sibling sharing
 * the prefix is excluded). SCAFFOLD — throws until P2.7.
 */
export function planWorktreeScopedReap(
  _processes: SweepProcess[],
  _worktreePath: string,
): WorktreeReapPlan {
  // Referenced so the import is retained for the implementation task.
  void isContainedIn;
  throw new Error('worktree-sweep: planWorktreeScopedReap not implemented (project 15 P2.7 pending)');
}
