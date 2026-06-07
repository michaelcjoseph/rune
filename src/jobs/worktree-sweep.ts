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

import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { isContainedIn } from '../intent/sandbox.js';
import { scrubPathsInText } from '../ai/tool-labels.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('worktree-sweep');

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
  processes: SweepProcess[],
  worktreePath: string,
): WorktreeReapPlan {
  const toKill = processes
    .filter((p) => isContainedIn(worktreePath, p.cwd))
    .map((p) => p.pid);
  return { toKill };
}

/** Injected I/O for the runtime sweep — production reads the process table via
 *  `lsof` and kills via `process.kill`; the test injects stubs so the sweep
 *  LOGIC runs with no real processes. */
export interface SweepIO {
  /** Snapshot of candidate processes (pid + absolute cwd). */
  listProcesses: () => SweepProcess[];
  /** Send a signal to a pid (production: `process.kill`). */
  kill: (pid: number, signal: NodeJS.Signals) => void;
  /** Resolve symlinks on a path (production: `realpathSync`); MUST be identity
   *  on failure so an absent path doesn't abort the sweep. Needed because
   *  `isContainedIn` is lexical and macOS `/tmp`→`/private/tmp`. */
  realpath: (p: string) => string;
}

/**
 * Parse `lsof -a -d cwd -Fpn` field output into (pid, cwd) pairs. The output is
 * per-process: a `p<pid>` line, then an `f<fdtype>` line (always `fcwd` here),
 * then the cwd path on an `n<path>` line; `f` lines are skipped by the chain.
 * The `n > 0` guard is load-bearing: a bare/garbage `p` line yields `Number('')
 * === 0`, and `process.kill(0|-1, …)` would signal the whole process group /
 * every reachable process — so a non-positive pid is dropped, never killed.
 * Pure — exported so the parser is unit-tested without spawning lsof.
 */
export function parseLsofCwd(output: string): SweepProcess[] {
  const procs: SweepProcess[] = [];
  let pid: number | null = null;
  for (const line of output.split('\n')) {
    if (line.startsWith('p')) {
      const n = Number(line.slice(1));
      pid = Number.isInteger(n) && n > 0 ? n : null;
    } else if (line.startsWith('n') && pid !== null) {
      procs.push({ pid, cwd: line.slice(1) });
    }
  }
  return procs;
}

/**
 * Production sweep I/O. `listProcesses` shells out to `lsof` for each process's
 * cwd; best-effort — any failure (lsof missing, non-zero exit, parse error)
 * yields an empty snapshot so the sweep is a no-op rather than a throw.
 */
export function defaultSweepIO(): SweepIO {
  return {
    listProcesses: () => {
      let out: string;
      try {
        out = execFileSync('lsof', ['-a', '-d', 'cwd', '-Fpn'], {
          encoding: 'utf8',
          timeout: 5_000, // bounded — this runs synchronously on the boot path
          maxBuffer: 8 * 1024 * 1024,
        });
      } catch {
        return []; // lsof unavailable / errored — best-effort no-op
      }
      return parseLsofCwd(out);
    },
    kill: (pid, signal) => process.kill(pid, signal),
    realpath: (p) => {
      try {
        return realpathSync(p);
      } catch {
        return p;
      }
    },
  };
}

/**
 * Fallback reap (project 15, P2.7): SIGKILL any process whose cwd is under
 * `worktreePath` — for reparented/detached grandchildren that escaped the
 * process group, so the pgid kill missed them. Defense-in-depth, NOT the happy
 * path (the pgid reap handles the common case). Best-effort and fault-isolated:
 * any I/O failure logs and yields no kills. Both the root and each cwd are
 * realpath-resolved before the lexical containment check (macOS symlink parity).
 * Returns the pids actually signalled.
 *
 * Caveats (acceptable for a single-machine personal server + defense-in-depth):
 *  - cwd-scoped: it SIGKILLs ANY process whose cwd is under the worktree, not
 *    only the run's own descendants — e.g. a developer shell left `cd`'d into
 *    the worktree would be killed. The worktree path is narrow
 *    (`<WORKTREE_ROOT>/<product>/<project>`, slug-validated), bounding this.
 *  - pid-reuse: between the lsof snapshot and the kill, a pid could be recycled
 *    to an unrelated process. The window is sub-millisecond and the sweep is
 *    boot-time/recovery-only (the system is quiet), so the residual risk is very
 *    low; a failed/misfired kill is swallowed.
 */
export function sweepWorktreeProcesses(worktreePath: string, io: SweepIO = defaultSweepIO()): number[] {
  const root = io.realpath(worktreePath);
  let procs: SweepProcess[];
  try {
    procs = io.listProcesses().map((p) => ({ pid: p.pid, cwd: io.realpath(p.cwd) }));
  } catch (err) {
    log.warn('worktree sweep: listProcesses failed; skipping', { error: (err as Error).message });
    return [];
  }
  const { toKill } = planWorktreeScopedReap(procs, root);
  const killed: number[] = [];
  for (const pid of toKill) {
    try {
      io.kill(pid, 'SIGKILL');
      killed.push(pid);
    } catch {
      // Process already gone (or pid reused/permission) — best-effort.
    }
  }
  if (killed.length > 0) {
    // Scrub the host path (worktree path encodes the host username).
    log.info('worktree sweep reaped escaped processes', {
      worktreePath: scrubPathsInText(root),
      count: killed.length,
    });
  }
  return killed;
}
