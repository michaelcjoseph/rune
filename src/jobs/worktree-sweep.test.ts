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

import { describe, it, expect, vi } from 'vitest';
import {
  planWorktreeScopedReap,
  parseLsofCwd,
  sweepWorktreeProcesses,
  type SweepProcess,
  type SweepIO,
} from './worktree-sweep.js';

const WT = '/tmp/worktrees/rune/15-work-run-finalizer';

type ProtectedAwareSweepProcess = SweepProcess & {
  listeningOn?: Array<{ host: string; port: number }>;
  launchdLabel?: string;
  ownedByCurrentTask?: boolean;
  humanApproval?: { approved: boolean; approvalId: string };
};

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
    const procs = [proc(201, '/tmp/worktrees/rune/99-other-project')];
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
      proc(2, '/tmp/worktrees/rune/99-other'), // out (other run)
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

describe('parseLsofCwd — lsof -Fpn field parser', () => {
  it('parses the per-process p/fcwd/n field sequence into (pid, cwd) pairs', () => {
    const out = ['p101', 'fcwd', `n${WT}/a`, 'p202', 'fcwd', 'n/usr/local/bin', ''].join('\n');
    expect(parseLsofCwd(out)).toEqual([
      { pid: 101, cwd: `${WT}/a` },
      { pid: 202, cwd: '/usr/local/bin' },
    ]);
  });

  it('drops a non-positive / garbage pid line (guards against process.kill(0|-1))', () => {
    // A bare `p` line → Number('') === 0; a `p-1` line → -1. Neither must yield
    // a pid (process.kill(0|-1) would signal the whole group / everything).
    const out = ['p', 'fcwd', '/n-should-be-ignored', 'p-1', 'fcwd', 'n/whatever', 'p0', 'fcwd', 'n/zero'].join('\n');
    expect(parseLsofCwd(out)).toEqual([]);
  });

  it('returns [] for empty output', () => {
    expect(parseLsofCwd('')).toEqual([]);
  });
});

describe('sweepWorktreeProcesses — runtime fallback reap (P2.7)', () => {
  function makeIO(processes: SweepProcess[], over: Partial<SweepIO> = {}): { io: SweepIO; killed: number[] } {
    const killed: number[] = [];
    const io: SweepIO = {
      listProcesses: () => processes,
      kill: (pid) => { killed.push(pid); },
      realpath: (p) => p, // identity — no symlink resolution in the stub
      ...over,
    };
    return { io, killed };
  }

  it('SIGKILLs only the in-worktree processes and spares those outside', () => {
    const { io, killed } = makeIO([
      { pid: 1, cwd: `${WT}/a` }, // in
      { pid: 2, cwd: '/tmp/worktrees/rune/99-other' }, // out
      { pid: 3, cwd: WT }, // in
      { pid: 4, cwd: `${WT}-evil` }, // out (prefix sibling)
    ]);
    const result = sweepWorktreeProcesses(WT, io);
    expect(result.sort((a, b) => a - b)).toEqual([1, 3]);
    expect(killed.sort((a, b) => a - b)).toEqual([1, 3]);
  });

  it('refuses to SIGKILL an in-worktree PID that owns a protected Rune service port', () => {
    const processes: ProtectedAwareSweepProcess[] = [
      {
        pid: 384700,
        cwd: `${WT}/sub`,
        ownedByCurrentTask: true,
        listeningOn: [{ host: '127.0.0.1', port: 3847 }],
      },
      {
        pid: 384800,
        cwd: `${WT}/sub`,
        ownedByCurrentTask: true,
        listeningOn: [{ host: '127.0.0.1', port: 3848 }],
      },
      { pid: 9101, cwd: `${WT}/sub`, ownedByCurrentTask: true },
    ];
    const { io, killed } = makeIO(processes);

    const result = sweepWorktreeProcesses(WT, io);

    expect(result).toEqual([9101]);
    expect(killed).toEqual([9101]);
  });

  it('refuses to SIGKILL an in-worktree PID matching a protected launchd service label', () => {
    const processes: ProtectedAwareSweepProcess[] = [
      {
        pid: 7102,
        cwd: `${WT}/sub`,
        ownedByCurrentTask: true,
        launchdLabel: 'com.jarvis.rune-mcp',
      },
      { pid: 9102, cwd: `${WT}/sub`, ownedByCurrentTask: true },
    ];
    const { io, killed } = makeIO(processes);

    const result = sweepWorktreeProcesses(WT, io);

    expect(result).toEqual([9102]);
    expect(killed).toEqual([9102]);
  });

  it('requires an explicit human approval path before sweeping a protected service process', () => {
    const approved: ProtectedAwareSweepProcess = {
      pid: 7103,
      cwd: `${WT}/sub`,
      ownedByCurrentTask: true,
      launchdLabel: 'com.jarvis.daemon',
      humanApproval: { approved: true, approvalId: 'protected-service-kill:7103' },
    };
    const { io, killed } = makeIO([approved]);

    const result = sweepWorktreeProcesses(WT, io);

    expect(result).toEqual([7103]);
    expect(killed).toEqual([7103]);
  });

  it('refuses to sweep a non-protected PID until current-task ownership is verified', () => {
    const processes: ProtectedAwareSweepProcess[] = [
      {
        pid: 9103,
        cwd: `${WT}/sub`,
        ownedByCurrentTask: false,
        listeningOn: [{ host: '127.0.0.1', port: 49152 }],
      },
      { pid: 9104, cwd: `${WT}/sub`, ownedByCurrentTask: true },
    ];
    const { io, killed } = makeIO(processes);

    const result = sweepWorktreeProcesses(WT, io);

    expect(result).toEqual([9104]);
    expect(killed).toEqual([9104]);
  });

  it('realpath-resolves the root and cwds before the containment check (macOS /tmp parity)', () => {
    // Stub realpath maps the symlinked /tmp form to the /private/tmp real form.
    const realed = (p: string) => p.replace(/^\/tmp\//, '/private/tmp/');
    const { io, killed } = makeIO(
      [{ pid: 10, cwd: '/private/tmp/worktrees/rune/15-work-run-finalizer/sub' }],
      { realpath: realed },
    );
    // Caller passes the symlinked /tmp form; realpath aligns both sides.
    const result = sweepWorktreeProcesses(WT, io);
    expect(result).toEqual([10]);
    expect(killed).toEqual([10]);
  });

  it('is a no-op when listProcesses throws (best-effort, never propagates)', () => {
    const io: SweepIO = {
      listProcesses: () => { throw new Error('lsof exploded'); },
      kill: vi.fn(),
      realpath: (p) => p,
    };
    expect(() => sweepWorktreeProcesses(WT, io)).not.toThrow();
    expect(sweepWorktreeProcesses(WT, io)).toEqual([]);
    expect(io.kill).not.toHaveBeenCalled();
  });

  it('continues past a kill that throws (process already gone / pid reused)', () => {
    const killed: number[] = [];
    const io: SweepIO = {
      listProcesses: () => [{ pid: 1, cwd: `${WT}/a` }, { pid: 2, cwd: `${WT}/b` }],
      kill: (pid) => {
        if (pid === 1) throw new Error('ESRCH');
        killed.push(pid);
      },
      realpath: (p) => p,
    };
    const result = sweepWorktreeProcesses(WT, io);
    // pid 1's kill threw; pid 2 still reaped, and only successfully-killed pids returned.
    expect(result).toEqual([2]);
    expect(killed).toEqual([2]);
  });
});
