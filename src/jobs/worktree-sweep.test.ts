/**
 * Project 15 P2.7 test suite for the worktree-scoped process sweep selection
 * core, `planWorktreeScopedReap` (src/jobs/worktree-sweep.ts). test-plan.md §5
 * "Worktree-scoped sweep".
 *
 * Written TEST-FIRST: `planWorktreeScopedReap` is a notImplemented scaffold, so
 * every test here is RED until the P2.7 implementation lands. Expected failure
 * mode: a `... not implemented` throw or a clean assertion — NEVER a
 * module-resolution / syntax error.
 *
 * The headline contract: the fallback reap finds a reparented/detached
 * grandchild by its cwd (still under the run's worktree) when the pgid kill
 * misses it — but is scoped to EXACTLY one worktree path: a process whose cwd is
 * OUTSIDE the worktree (an unrelated run, or a sibling sharing the path prefix)
 * is left untouched. No real processes are spawned — an injected process-table
 * snapshot drives the pure selection.
 */

import { describe, it, expect } from 'vitest';
import { planWorktreeScopedReap, type SweepProcess } from './worktree-sweep.js';

const WT = '/tmp/worktrees/jarvis/15-work-run-finalizer';

function proc(pid: number, cwd: string): SweepProcess {
  return { pid, cwd };
}

describe('planWorktreeScopedReap — cwd-scoped fallback reap (P2.7)', () => {
  it('reaps a reparented process whose cwd is UNDER the run worktree', () => {
    const procs = [proc(101, `${WT}/node_modules/.bin`)];
    expect(planWorktreeScopedReap(procs, WT).toKill).toEqual([101]);
  });

  it('reaps a process whose cwd IS the worktree path exactly', () => {
    expect(planWorktreeScopedReap([proc(102, WT)], WT).toKill).toEqual([102]);
  });

  it('leaves a process whose cwd is OUTSIDE the worktree untouched', () => {
    const procs = [proc(201, '/tmp/worktrees/jarvis/99-other-project')];
    expect(planWorktreeScopedReap(procs, WT).toKill).toEqual([]);
  });

  it('does NOT reap a sibling that merely shares the worktree path as a prefix', () => {
    // `<wt>-evil` is a sibling, not a descendant — isContainedIn rejects it.
    const procs = [proc(202, `${WT}-evil/sub`)];
    expect(planWorktreeScopedReap(procs, WT).toKill).toEqual([]);
  });

  it('selects ONLY the in-worktree pids from a mixed snapshot (scoped to one path)', () => {
    const procs = [
      proc(1, `${WT}/a`), // in
      proc(2, '/tmp/worktrees/jarvis/99-other'), // out (other run)
      proc(3, WT), // in (the worktree itself)
      proc(4, '/usr/local/bin'), // out (unrelated)
      proc(5, `${WT}-evil`), // out (prefix sibling)
    ];
    expect(planWorktreeScopedReap(procs, WT).toKill.sort((a, b) => a - b)).toEqual([1, 3]);
  });

  it('returns an empty plan for an empty process table', () => {
    expect(planWorktreeScopedReap([], WT).toKill).toEqual([]);
  });
});
