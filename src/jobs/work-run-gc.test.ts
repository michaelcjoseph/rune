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
import { defaultRunGit } from './sandbox-runtime.js';
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
    branch: `rune-work/${id}`,
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
      JSON.stringify({ id, outcome: 'noop', branch: `rune-work/${id}`, endedAt: `2026-05-30T1${i}:00:00.000Z` }),
    );
  }

  /** A GitRunner stub. `worktree list --porcelain` reports `checkedOutBranch`
   *  as checked out in a worktree (so its run is protected). `rev-list --count`
   *  (the unmerged-branch check) answers `revListCount` — default '0\n'
   *  (merged, prunable) — or throws when `revListError` is set. Records all
   *  calls so branch-prune (`branch -d <ref>`) can be asserted. */
  function makeGitStub(
    checkedOutBranch?: string,
    opts?: { revListCount?: string; revListError?: boolean },
  ) {
    const calls: string[][] = [];
    const stub = vi.fn<GitRunner>().mockImplementation(async (args) => {
      calls.push([...args]);
      if (args.includes('worktree') && args.includes('list')) {
        const porcelain = checkedOutBranch
          ? `worktree /some/path\nHEAD abc123\nbranch refs/heads/${checkedOutBranch}\n`
          : '';
        return { stdout: porcelain, stderr: '' };
      }
      if (args.includes('rev-list')) {
        if (opts?.revListError) throw new Error('rev-list failed (stub)');
        return { stdout: opts?.revListCount ?? '0\n', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });
    return { stub, calls };
  }

  it('never deletes a branch a worktree has checked out, but does prune the others (over cap)', async () => {
    for (let i = 0; i < 4; i++) seedRun(`run-${i}`, i);
    const { stub } = makeGitStub('rune-work/run-0'); // run-0's branch is live

    const result = await gcWorkRuns({
      workRunsDir,
      runGit: stub,
      productRepos: { rune: '/fake/repo' },
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

  it('project 13: a parked run (blocked-on-human id in nonTerminalIds) is never pruned — dir + branch protected, even over cap', async () => {
    // The gc-runner builds nonTerminalIds from supervised runs filtered by
    // `!TERMINAL_STATUSES.has(status)` — and TERMINAL_STATUSES = {completed,
    // failed}, so 'blocked-on-human' (parked) is non-terminal and lands in the
    // protected set. This asserts gcWorkRuns honors that protection: a parked
    // run's dir and branch ref survive a GC pass that is over the count cap.
    // Verify-not-implement (spec Background §4) — current behavior, no carve-out.
    for (let i = 0; i < 4; i++) seedRun(`run-${i}`, i);
    const { stub, calls } = makeGitStub();

    const result = await gcWorkRuns({
      workRunsDir,
      runGit: stub,
      productRepos: { rune: '/fake/repo' },
      activeIds: new Set(),
      nonTerminalIds: new Set(['run-0']), // run-0 is parked (blocked-on-human)
      maxRuns: 1,
      maxBytes: 100_000,
    });

    // The parked run (oldest) is protected despite being over the count cap…
    expect(result.deletedIds).not.toContain('run-0');
    // …and its branch ref is never pruned.
    expect(calls.some((c) => c.includes('branch') && c.some((a) => a.includes('rune-work/run-0')))).toBe(false);
    // The other over-cap unprotected runs ARE pruned.
    expect(result.deletedIds.length).toBeGreaterThan(0);
  });

  it('prunes the deleted run\'s branch ref (git branch -d)', async () => {
    for (let i = 0; i < 3; i++) seedRun(`run-${i}`, i);
    const { stub, calls } = makeGitStub();

    const result = await gcWorkRuns({
      workRunsDir,
      runGit: stub,
      productRepos: { rune: '/fake/repo' },
      activeIds: new Set(),
      nonTerminalIds: new Set(),
      maxRuns: 1,
      maxBytes: 100_000,
    });

    // run-0 is the oldest and unprotected → deleted, and its branch pruned.
    expect(result.deletedIds).toContain('run-0');
    const branchPrune = calls.find(c => c.includes('branch') && (c.includes('-d') || c.includes('-D')));
    expect(branchPrune).toBeDefined();
    expect(branchPrune!.some(a => a.includes('rune-work/run-0'))).toBe(true);
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
    const SHARED = 'rune-work/09-expand-cockpit';
    for (let i = 0; i < 3; i++) seedRunOnBranch(`run-${i}`, i, SHARED);
    const { stub, calls } = makeGitStub();

    const result = await gcWorkRuns({
      workRunsDir,
      runGit: stub,
      productRepos: { rune: '/fake/repo' },
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

  it('force-deletes a MERGED shared branch only once its LAST run ages out', async () => {
    const SHARED = 'rune-work/09-expand-cockpit';
    for (let i = 0; i < 3; i++) seedRunOnBranch(`run-${i}`, i, SHARED);
    // rev-list count 0 → the branch's work already landed on the base branch.
    const { stub, calls } = makeGitStub(undefined, { revListCount: '0\n' });

    const result = await gcWorkRuns({
      workRunsDir,
      runGit: stub,
      productRepos: { rune: '/fake/repo' },
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

  it('NEVER prunes an UNMERGED resume branch, even after ALL its run dirs age out', async () => {
    // The 2026-07-08 project-21 data loss: an incomplete project's every run dir
    // aged out of the retention window, the retained-branch guard lapsed, and
    // `branch -D` destroyed the only record of its task closeouts. An unmerged
    // branch (rev-list count > 0 against the base branch) is an incomplete
    // project's live resume point and must survive dir GC unconditionally.
    const SHARED = 'rune-work/21-parallel-product-chats';
    for (let i = 0; i < 3; i++) seedRunOnBranch(`run-${i}`, i, SHARED);
    const { stub, calls } = makeGitStub(undefined, { revListCount: '2\n' });

    const result = await gcWorkRuns({
      workRunsDir,
      runGit: stub,
      productRepos: { rune: '/fake/repo' },
      activeIds: new Set(),
      nonTerminalIds: new Set(),
      maxRuns: 0, // every run dir ages out → no dir-based retention protects the branch
      maxBytes: 100_000,
    });

    // The dirs are pruned to honor the cap…
    expect(result.deletedIds).toEqual(['run-0', 'run-1', 'run-2']);
    // …the unmerged check ran against the default base branch…
    const revList = calls.find(c => c.includes('rev-list'));
    expect(revList).toEqual(['rev-list', '--count', `main..${SHARED}`]);
    // …and the unmerged branch is NEVER force-deleted.
    const branchPrune = calls.find(c => c.includes('branch') && c.includes('-D'));
    expect(branchPrune).toBeUndefined();
  });

  it('keeps the branch when the unmerged check fails (fail-safe: cannot prove merged)', async () => {
    const SHARED = 'rune-work/21-parallel-product-chats';
    for (let i = 0; i < 3; i++) seedRunOnBranch(`run-${i}`, i, SHARED);
    const { stub, calls } = makeGitStub(undefined, { revListError: true });

    const result = await gcWorkRuns({
      workRunsDir,
      runGit: stub,
      productRepos: { rune: '/fake/repo' },
      activeIds: new Set(),
      nonTerminalIds: new Set(),
      maxRuns: 0,
      maxBytes: 100_000,
    });

    expect(result.deletedIds).toEqual(['run-0', 'run-1', 'run-2']);
    const branchPrune = calls.find(c => c.includes('branch') && c.includes('-D'));
    expect(branchPrune).toBeUndefined();
  });

  it('keeps the branch when the count is unparseable (fail-safe)', async () => {
    const SHARED = 'rune-work/21-parallel-product-chats';
    for (let i = 0; i < 3; i++) seedRunOnBranch(`run-${i}`, i, SHARED);
    const { stub, calls } = makeGitStub(undefined, { revListCount: 'not-a-number\n' });

    await gcWorkRuns({
      workRunsDir,
      runGit: stub,
      productRepos: { rune: '/fake/repo' },
      activeIds: new Set(),
      nonTerminalIds: new Set(),
      maxRuns: 0,
      maxBytes: 100_000,
    });

    const branchPrune = calls.find(c => c.includes('branch') && c.includes('-D'));
    expect(branchPrune).toBeUndefined();
  });

  it('runs the unmerged check against the product\'s OWN base branch (productBaseBranches)', async () => {
    const SHARED = 'rune-work/09-expand-cockpit';
    seedRunOnBranch('run-0', 0, SHARED);
    const { stub, calls } = makeGitStub(undefined, { revListCount: '0\n' });

    await gcWorkRuns({
      workRunsDir,
      runGit: stub,
      productRepos: { rune: '/fake/repo' },
      productBaseBranches: { rune: 'develop' },
      activeIds: new Set(),
      nonTerminalIds: new Set(),
      maxRuns: 0,
      maxBytes: 100_000,
    });

    const revList = calls.find(c => c.includes('rev-list'));
    expect(revList).toEqual(['rev-list', '--count', `develop..${SHARED}`]);
    // Merged against develop → pruned.
    const branchPrune = calls.find(c => c.includes('branch') && c.includes('-D') && c.includes(SHARED));
    expect(branchPrune).toBeDefined();
  });

  it('prunes each run\'s branch in its OWN product repo, and checks every repo\'s worktrees', async () => {
    // A rune run and an aura run both age out. Each branch ref lives in its own
    // product repo, so GC must prune in the right repo — not a single hardcoded
    // one (the cross-repo GC gap).
    const seed = (id: string, i: number, product: string, branch: string) => {
      const dir = join(workRunsDir, id);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'transcript.jsonl'), 'x'.repeat(100));
      writeFileSync(
        join(dir, 'summary.json'),
        JSON.stringify({ id, outcome: 'noop', product, branch, endedAt: `2026-05-30T1${i}:00:00.000Z` }),
      );
    };
    seed('run-rune', 0, 'rune', 'rune-work/09-cockpit');
    seed('run-aura', 1, 'aura', 'rune-work/03-mobile');

    // A cwd-recording stub (makeGitStub records args only). Both branches are
    // merged (rev-list count 0) so the prune proceeds.
    const calls: Array<{ args: string[]; cwd?: string }> = [];
    const stub = vi.fn<GitRunner>(async (args, opts) => {
      calls.push({ args: [...args], cwd: opts?.cwd });
      if (args.includes('rev-list')) return { stdout: '0\n', stderr: '' };
      return { stdout: '', stderr: '' };
    });

    const result = await gcWorkRuns({
      workRunsDir,
      runGit: stub,
      productRepos: { rune: '/repos/rune', aura: '/repos/aura' },
      activeIds: new Set(),
      nonTerminalIds: new Set(),
      maxRuns: 0, // age everything out
      maxBytes: 100_000,
    });

    expect([...result.deletedIds].sort()).toEqual(['run-aura', 'run-rune']);

    // Each branch is force-deleted in ITS product's repo.
    const runePrune = calls.find(c => c.args.includes('branch') && c.args.includes('rune-work/09-cockpit'));
    const auraPrune = calls.find(c => c.args.includes('branch') && c.args.includes('rune-work/03-mobile'));
    expect(runePrune?.cwd).toBe('/repos/rune');
    expect(auraPrune?.cwd).toBe('/repos/aura');

    // Worktree-checkout protection reads EVERY repo's worktree list.
    const wtListCwds = calls
      .filter(c => c.args.includes('worktree') && c.args.includes('list'))
      .map(c => c.cwd);
    expect(wtListCwds).toContain('/repos/rune');
    expect(wtListCwds).toContain('/repos/aura');
  });

  it('is idempotent — after pruning over-cap runs, a second pass deletes nothing', async () => {
    for (let i = 0; i < 4; i++) seedRun(`run-${i}`, i);
    const { stub } = makeGitStub();
    const opts = {
      workRunsDir,
      runGit: stub,
      productRepos: { rune: '/fake/repo' },
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
      productRepos: { rune: '/fake/repo' },
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

  it('REAL git: an unmerged resume branch survives total age-out; once merged it is pruned', async () => {
    // Integration proof of the actual rev-list semantics with defaultRunGit —
    // GC's branch -D is the most destructive op in the codebase, so the guard
    // gets one non-stubbed pin (temp-git precedent: team-task-deps.test.ts).
    const BRANCH = 'rune-work/21-parallel-product-chats';
    const repo = mkdtempSync(join(tmpdir(), 'work-run-gc-git-'));
    const git = (args: string[]) => defaultRunGit(args, { cwd: repo });
    try {
      await git(['init', '-b', 'main']);
      await git(['config', 'user.email', 'gc-test@rune.local']);
      await git(['config', 'user.name', 'gc-test']);
      writeFileSync(join(repo, 'base.txt'), 'base');
      await git(['add', '-A']);
      await git(['commit', '-m', 'base']);
      await git(['checkout', '-b', BRANCH]);
      writeFileSync(join(repo, 'closeout.txt'), 'task closeout');
      await git(['add', '-A']);
      await git(['commit', '-m', 'closeout: task 1']);
      await git(['checkout', 'main']);

      const branchExists = async () => {
        try {
          await git(['rev-parse', '--verify', `refs/heads/${BRANCH}`]);
          return true;
        } catch {
          return false;
        }
      };
      const gcOpts = {
        workRunsDir,
        runGit: defaultRunGit,
        productRepos: { rune: repo },
        activeIds: new Set<string>(),
        nonTerminalIds: new Set<string>(),
        maxRuns: 0, // age every run dir out
        maxBytes: 100_000,
      };

      // Pass 1: the branch carries an unmerged closeout commit → dirs pruned,
      // branch survives.
      seedRunOnBranch('run-0', 0, BRANCH);
      const first = await gcWorkRuns(gcOpts);
      expect(first.deletedIds).toEqual(['run-0']);
      expect(await branchExists()).toBe(true);

      // Pass 2: after the work lands on main, the branch is finally pruned.
      await git(['merge', BRANCH]);
      seedRunOnBranch('run-1', 1, BRANCH);
      const second = await gcWorkRuns(gcOpts);
      expect(second.deletedIds).toEqual(['run-1']);
      expect(await branchExists()).toBe(false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }, 20_000);
});
