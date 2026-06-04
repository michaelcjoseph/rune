/**
 * Phase 3 test suite for `src/jobs/work-run-gc.ts` — retention GC (test-plan §3,
 * project 11 work-run-observability).
 *
 * Written TEST-FIRST: `planGc` / `gcWorkRuns` throw `notImplemented(...)`, so
 * every test here is RED until the Phase 3 implementation task lands. Expected
 * failure mode: assertion failure or the `work-run-gc: <fn> not implemented`
 * throw — NEVER a module-resolution / syntax / missing-env crash.
 *
 * `planGc` is pure (fixtures, no I/O). `gcWorkRuns` is effectful — exercised
 * against a real tmpdir + an injected GitRunner stub.
 *
 * See: docs/projects/11-work-run-observability/test-plan.md §3
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { planGc, gcWorkRuns } from './work-run-gc.js';
import type { GcRunEntry } from './work-run-gc.js';
import type { GitRunner } from './sandbox-runtime.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Build a terminal run entry. `n` orders age via endedAt (lower = older). */
function entry(id: string, overrides: Partial<GcRunEntry> = {}): GcRunEntry {
  return {
    id,
    dir: `/tmp/work-runs/${id}`,
    bytes: 100,
    endedAt: '2026-05-30T10:00:00.000Z',
    terminal: true,
    branch: `jarvis-work/${id}`,
    ...overrides,
  };
}

/** Five terminal runs, oldest (run-0) → newest (run-4), 100 bytes each. */
function fiveRuns(): GcRunEntry[] {
  return [0, 1, 2, 3, 4].map(i =>
    entry(`run-${i}`, { endedAt: `2026-05-30T1${i}:00:00.000Z`, bytes: 100 }),
  );
}

// ---------------------------------------------------------------------------
// planGc — pure rules
// ---------------------------------------------------------------------------

describe('planGc', () => {
  it('returns an empty plan when everything is under both caps (idempotent)', () => {
    const plan = planGc({ entries: fiveRuns(), protectedIds: new Set(), maxRuns: 10, maxBytes: 100_000 });
    expect(plan.deleteIds).toEqual([]);
  });

  it('prunes the oldest terminal runs when over the count cap', () => {
    // 5 runs, keep 3 → delete the 2 oldest (run-0, run-1).
    const plan = planGc({ entries: fiveRuns(), protectedIds: new Set(), maxRuns: 3, maxBytes: 100_000 });
    expect(plan.deleteIds).toEqual(['run-0', 'run-1']);
  });

  it('prunes oldest-first by bytes when over the byte cap', () => {
    // 5 × 100 bytes = 500; cap 250 → must drop to ≤250, i.e. delete 3 oldest
    // (500 → 200), leaving run-3 + run-4.
    const plan = planGc({ entries: fiveRuns(), protectedIds: new Set(), maxRuns: 100, maxBytes: 250 });
    expect(plan.deleteIds).toEqual(['run-0', 'run-1', 'run-2']);
  });

  it('never prunes a protected run even when over the count cap', () => {
    // Protect the two oldest; maxRuns 1 forces pruning of the rest.
    const plan = planGc({
      entries: fiveRuns(),
      protectedIds: new Set(['run-0', 'run-1']),
      maxRuns: 1,
      maxBytes: 100_000,
    });
    expect(plan.deleteIds).not.toContain('run-0');
    expect(plan.deleteIds).not.toContain('run-1');
    // The unprotected runs (oldest-first) are the deletion candidates.
    expect(plan.deleteIds).toEqual(['run-2', 'run-3']);
  });

  it('never prunes a non-terminal run', () => {
    const entries = [
      entry('run-old', { endedAt: '2026-05-30T09:00:00.000Z', terminal: false }),
      ...fiveRuns(),
    ];
    const plan = planGc({ entries, protectedIds: new Set(), maxRuns: 2, maxBytes: 100_000 });
    expect(plan.deleteIds).not.toContain('run-old');
  });

  it('deletes oldest-first (by endedAt), not by array order', () => {
    // Reverse the array so the newest is first — deletion must still be by age.
    const plan = planGc({ entries: fiveRuns().reverse(), protectedIds: new Set(), maxRuns: 3, maxBytes: 100_000 });
    expect(plan.deleteIds).toEqual(['run-0', 'run-1']);
  });
});

// ---------------------------------------------------------------------------
// gcWorkRuns — effectful pass
// ---------------------------------------------------------------------------

describe('gcWorkRuns', () => {
  let workRunsDir: string;

  beforeEach(() => {
    workRunsDir = mkdtempSync(join(tmpdir(), 'work-run-gc-test-'));
  });

  afterEach(() => {
    rmSync(workRunsDir, { recursive: true, force: true });
  });

  /** Create a per-run dir with a transcript file + a summary.json giving the
   *  impl the metadata it discovers from disk: endedAt (age), branch (ref to
   *  prune), and a terminal outcome. `i` orders age (lower = older). */
  function seedRun(id: string, i: number, bytes = 100) {
    const dir = join(workRunsDir, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'transcript.jsonl'), 'x'.repeat(bytes));
    writeFileSync(
      join(dir, 'summary.json'),
      JSON.stringify({ id, outcome: 'noop', branch: `jarvis-work/${id}`, endedAt: `2026-05-30T1${i}:00:00.000Z` }),
    );
  }

  /** A GitRunner stub. `worktree list --porcelain` reports `checkedOutBranch`
   *  as checked out in a worktree (so its run is protected). Records all calls
   *  so branch-prune (`branch -d <ref>`) can be asserted. */
  function makeGitStub(checkedOutBranch?: string) {
    const calls: string[][] = [];
    const stub = vi.fn<GitRunner>().mockImplementation(async (args) => {
      calls.push([...args]);
      if (args.includes('worktree') && args.includes('list')) {
        const porcelain = checkedOutBranch
          ? `worktree /some/path\nHEAD abc123\nbranch refs/heads/${checkedOutBranch}\n`
          : '';
        return { stdout: porcelain, stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });
    return { stub, calls };
  }

  it('never deletes a branch a worktree has checked out, but does prune the others (over cap)', async () => {
    for (let i = 0; i < 4; i++) seedRun(`run-${i}`, i);
    const { stub } = makeGitStub('jarvis-work/run-0'); // run-0's branch is live

    const result = await gcWorkRuns({
      workRunsDir,
      runGit: stub,
      repoPath: '/fake/repo',
      activeIds: new Set(),
      nonTerminalIds: new Set(),
      maxRuns: 1,
      maxBytes: 100_000,
    });

    // The checked-out run is protected…
    expect(result.deletedIds).not.toContain('run-0');
    // …but the over-cap unprotected runs are pruned (oldest-first).
    expect(result.deletedIds.length).toBeGreaterThan(0);
    expect(result.deletedIds).toContain('run-1');
  });

  it('prunes the deleted run\'s branch ref (git branch -d)', async () => {
    for (let i = 0; i < 3; i++) seedRun(`run-${i}`, i);
    const { stub, calls } = makeGitStub();

    const result = await gcWorkRuns({
      workRunsDir,
      runGit: stub,
      repoPath: '/fake/repo',
      activeIds: new Set(),
      nonTerminalIds: new Set(),
      maxRuns: 1,
      maxBytes: 100_000,
    });

    // run-0 is the oldest and unprotected → deleted, and its branch pruned.
    expect(result.deletedIds).toContain('run-0');
    const branchPrune = calls.find(c => c.includes('branch') && (c.includes('-d') || c.includes('-D')));
    expect(branchPrune).toBeDefined();
    expect(branchPrune!.some(a => a.includes('jarvis-work/run-0'))).toBe(true);
  });

  /** Seed a run that lives on a SPECIFIC (shared) branch — the stable
   *  per-project resume branch every run of a project records. */
  function seedRunOnBranch(id: string, i: number, branch: string, bytes = 100) {
    const dir = join(workRunsDir, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'transcript.jsonl'), 'x'.repeat(bytes));
    writeFileSync(
      join(dir, 'summary.json'),
      JSON.stringify({ id, outcome: 'noop', branch, endedAt: `2026-05-30T1${i}:00:00.000Z` }),
    );
  }

  it('NEVER prunes a shared resume branch while a retained run still references it', async () => {
    // Three runs of the same project all live on the stable resume branch. The
    // cap forces the 2 oldest dirs out, but the branch must survive because the
    // newest retained run still lives on it — else GC re-creates the data-loss
    // the resume fix exists to prevent (docs/projects/bugs.md).
    const SHARED = 'jarvis-work/09-expand-cockpit';
    for (let i = 0; i < 3; i++) seedRunOnBranch(`run-${i}`, i, SHARED);
    const { stub, calls } = makeGitStub();

    const result = await gcWorkRuns({
      workRunsDir,
      runGit: stub,
      repoPath: '/fake/repo',
      activeIds: new Set(),
      nonTerminalIds: new Set(),
      maxRuns: 1,
      maxBytes: 100_000,
    });

    // Oldest two dirs pruned to honor the cap…
    expect(result.deletedIds).toEqual(['run-0', 'run-1']);
    // …but the shared branch is NEVER force-deleted (run-2 retains it).
    const branchPrune = calls.find(c => c.includes('branch') && c.includes('-D'));
    expect(branchPrune).toBeUndefined();
  });

  it('force-deletes the shared branch only once its LAST run ages out', async () => {
    const SHARED = 'jarvis-work/09-expand-cockpit';
    for (let i = 0; i < 3; i++) seedRunOnBranch(`run-${i}`, i, SHARED);
    const { stub, calls } = makeGitStub();

    const result = await gcWorkRuns({
      workRunsDir,
      runGit: stub,
      repoPath: '/fake/repo',
      activeIds: new Set(),
      nonTerminalIds: new Set(),
      maxRuns: 0, // prune every run → no run retains the branch
      maxBytes: 100_000,
    });

    expect(result.deletedIds).toEqual(['run-0', 'run-1', 'run-2']);
    // No run references the branch anymore → it is finally pruned.
    const branchPrune = calls.find(c => c.includes('branch') && c.includes('-D') && c.includes(SHARED));
    expect(branchPrune).toBeDefined();
  });

  it('is idempotent — after pruning over-cap runs, a second pass deletes nothing', async () => {
    for (let i = 0; i < 4; i++) seedRun(`run-${i}`, i);
    const { stub } = makeGitStub();
    const opts = {
      workRunsDir,
      runGit: stub,
      repoPath: '/fake/repo',
      activeIds: new Set<string>(),
      nonTerminalIds: new Set<string>(),
      maxRuns: 2,
      maxBytes: 100_000,
    };

    // First pass: 4 runs, cap 2 → prune the 2 oldest.
    const first = await gcWorkRuns(opts);
    expect(first.deletedIds.length).toBe(2);
    expect(first.deletedIds).toEqual(['run-0', 'run-1']);

    // Second pass: 2 runs remain, under cap → nothing to do.
    const second = await gcWorkRuns(opts);
    expect(second.deletedIds).toEqual([]);
  });

  it('excludes active + non-terminal runs from deletion but prunes the rest', async () => {
    for (let i = 0; i < 4; i++) seedRun(`run-${i}`, i);
    const { stub } = makeGitStub();

    const result = await gcWorkRuns({
      workRunsDir,
      runGit: stub,
      repoPath: '/fake/repo',
      activeIds: new Set(['run-0']),
      nonTerminalIds: new Set(['run-1']),
      maxRuns: 1,
      maxBytes: 100_000,
    });

    expect(result.deletedIds).not.toContain('run-0');
    expect(result.deletedIds).not.toContain('run-1');
    // The unprotected terminal runs are still pruned to honor the cap.
    expect(result.deletedIds.length).toBeGreaterThan(0);
  });
});
