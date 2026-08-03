/**
 * Phase 1 — canonical repository identity + base-branch lock suite
 * (`work-run-merge-lock.ts`). Products can be separate entries for the same
 * checkout (rune/rune-mcp and writing/brand), including through git worktrees.
 * Their base-branch mutations must serialize by repository identity, never by
 * the product label used to start the run.
 *
 * This is intentionally a real git fixture: testing two strings that happen to
 * be equal would not prove git worktrees resolve to the same common directory.
 *
 * Headline contract: the lock keys on (canonicalRepoId, baseBranch), NOT on the
 * product or project slug. Before the task adds the required helper exports,
 * tests fail as clean missing-symbol assertions rather than a bad import.
 */

import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { baseBranchLockKey, withBaseBranchLock } from './work-run-merge-lock.js';

type BaseBranchRunHandle = {
  descriptor: { id: string; kind: string; status: string; payload: unknown };
};

type BaseBranchTarget = { repoPath: string; baseBranch: string };

type RepoIdentityModule = {
  canonicalRepoId?: (repoPath: string) => Promise<string> | string;
  hasConcurrentBaseBranchRun?: (
    runs: Iterable<BaseBranchRunHandle>,
    currentRunId: string,
    repoId: string,
    baseBranch: string,
    includedKinds: ReadonlySet<string>,
    resolveTarget: (product: string) => BaseBranchTarget,
  ) => Promise<boolean>;
};

// Keep the existing module import usable while the new named exports do not yet
// exist. The first expectation below then gives the coder a precise RED signal.
const repoIdentity = (await import('./work-run-merge-lock.js')) as unknown as RepoIdentityModule;

function canonicalRepoId(repoPath: string): Promise<string> {
  expect(repoIdentity.canonicalRepoId).toBeTypeOf('function');
  return Promise.resolve(repoIdentity.canonicalRepoId!(repoPath));
}

function hasConcurrentBaseBranchRun(
  runs: Iterable<BaseBranchRunHandle>,
  currentRunId: string,
  repoId: string,
  baseBranch: string,
  includedKinds: ReadonlySet<string>,
  resolveTarget: (product: string) => BaseBranchTarget,
): Promise<boolean> {
  expect(repoIdentity.hasConcurrentBaseBranchRun).toBeTypeOf('function');
  return repoIdentity.hasConcurrentBaseBranchRun!(
    runs, currentRunId, repoId, baseBranch, includedKinds, resolveTarget,
  );
}

let fixtureRoot = '';
let runeRepo = '';
let runeMcpWorktree = '';
let writingRepo = '';
let brandWorktree = '';
let distinctRepo = '';

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

beforeAll(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'rune-repo-identity-'));
  runeRepo = join(fixtureRoot, 'rune');
  runeMcpWorktree = join(fixtureRoot, 'rune-mcp-worktree');
  writingRepo = join(fixtureRoot, 'writing');
  brandWorktree = join(fixtureRoot, 'brand-worktree');
  distinctRepo = join(fixtureRoot, 'aura');

  for (const repo of [runeRepo, writingRepo, distinctRepo]) {
    mkdirSync(repo);
    git(repo, ['init', '--initial-branch=main']);
    git(repo, ['config', 'user.email', 'qa@example.test']);
    git(repo, ['config', 'user.name', 'QA']);
    git(repo, ['commit', '--allow-empty', '-m', 'fixture']);
  }
  git(runeRepo, ['worktree', 'add', '-b', 'rune-mcp-fixture', runeMcpWorktree]);
  git(writingRepo, ['worktree', 'add', '-b', 'brand-fixture', brandWorktree]);
});

afterAll(() => {
  if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
});

/** A deferred so a test can hold the lock open until it chooses to release. */
function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Yield a full macrotask so EVERY pending microtask drains, regardless of how
 * many `.then()` hops the mutex impl puts before invoking `fn`. (A single
 * `await Promise.resolve()` only drains one tick and would false-fail a correct
 * impl whose dispatch is a hop deeper.) The held-open deferred — not this flush
 * — is what proves a waiter can't proceed: the lock holder parks on an
 * unresolved promise, so a serialized waiter stays blocked across the flush.
 */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('repository-identity helper API', () => {
  it('exports canonicalRepoId', () => {
    expect(repoIdentity.canonicalRepoId).toBeTypeOf('function');
  });

  it('exports the shared concurrent-run predicate', () => {
    expect(repoIdentity.hasConcurrentBaseBranchRun).toBeTypeOf('function');
  });
});

describe('canonicalRepoId', () => {
  it('uses realpath(git-common-dir), so rune and its rune-mcp worktree share one id', async () => {
    const runeId = await canonicalRepoId(runeRepo);
    const runeMcpId = await canonicalRepoId(runeMcpWorktree);

    expect(runeId).toBe(realpathSync(join(runeRepo, '.git')));
    expect(runeMcpId).toBe(runeId);
  });

  it('falls back deterministically to realpath(repoPath) outside a git repository', async () => {
    const nonRepository = join(fixtureRoot, 'not-a-repository');
    mkdirSync(nonRepository);

    await expect(canonicalRepoId(nonRepository)).resolves.toBe(realpathSync(nonRepository));
  });

  it('falls back deterministically to the resolved path when repoPath is missing', async () => {
    const missingRepository = join(fixtureRoot, 'missing-repository');

    await expect(canonicalRepoId(missingRepository)).resolves.toBe(missingRepository);
  });
});

describe.each([
  ['rune/rune-mcp', () => runeRepo, 'rune-mcp', () => runeMcpWorktree],
  ['writing/brand', () => writingRepo, 'brand', () => brandWorktree],
] as const)('hasConcurrentBaseBranchRun — %s', (
  _pair,
  currentRepo,
  candidateProduct,
  candidateRepo,
) => {
  const includedKinds = new Set(['orchestrated-work', 'work-run']);
  const runningRun = (id: string, product: string, kind = 'work-run'): BaseBranchRunHandle => ({
    descriptor: { id, kind, status: 'running', payload: { product } },
  });

  it('finds a differently named product using the same repository/base branch', async () => {
    await expect(hasConcurrentBaseBranchRun(
      [runningRun('candidate-run', candidateProduct)],
      'current-run',
      await canonicalRepoId(currentRepo()),
      'main',
      includedKinds,
      () => ({ repoPath: candidateRepo(), baseBranch: 'main' }),
    )).resolves.toBe(true);
  });

  it('does not report a distinct repository as a concurrent base-branch owner', async () => {
    await expect(hasConcurrentBaseBranchRun(
      [runningRun('candidate-run', 'aura')],
      'current-run',
      await canonicalRepoId(currentRepo()),
      'main',
      includedKinds,
      () => ({ repoPath: distinctRepo, baseBranch: 'main' }),
    )).resolves.toBe(false);
  });

  it('does not report a different base branch in the same repository', async () => {
    await expect(hasConcurrentBaseBranchRun(
      [runningRun('candidate-run', candidateProduct)],
      'current-run',
      await canonicalRepoId(currentRepo()),
      'main',
      includedKinds,
      () => ({ repoPath: candidateRepo(), baseBranch: 'release' }),
    )).resolves.toBe(false);
  });

  it('counts only OTHER running runs of included kinds — self, parked, and excluded kinds are ignored', async () => {
    // Every candidate here resolves to the current repo + base branch, so a
    // predicate that skips any of the three filters (currentRunId
    // self-exclusion, status === 'running', includedKinds membership) reports
    // true and would hold every merge on itself.
    const parkedRun: BaseBranchRunHandle = {
      descriptor: {
        id: 'parked-run',
        kind: 'work-run',
        status: 'parked',
        payload: { product: candidateProduct },
      },
    };

    await expect(hasConcurrentBaseBranchRun(
      [
        runningRun('current-run', candidateProduct),
        parkedRun,
        runningRun('excluded-kind-run', candidateProduct, 'kb-sync'),
      ],
      'current-run',
      await canonicalRepoId(currentRepo()),
      'main',
      includedKinds,
      () => ({ repoPath: candidateRepo(), baseBranch: 'main' }),
    )).resolves.toBe(false);
  });

  it('fails toward contention when a running candidate cannot be resolved', async () => {
    await expect(hasConcurrentBaseBranchRun(
      [
        runningRun('stale-run', 'removed-product'),
        runningRun('distinct-run', 'aura'),
      ],
      'current-run',
      await canonicalRepoId(currentRepo()),
      'main',
      includedKinds,
      (product) => {
        if (product === 'removed-product') throw new Error('unknown product');
        return { repoPath: distinctRepo, baseBranch: 'main' };
      },
    )).resolves.toBe(true);
  });
});

describe.each([
  ['work-runner.ts', /hasConcurrentBaseBranchRun\(\s*activeRuns\.values\(\),\s*descriptor\.id,\s*repoId,\s*baseBranch,/],
  ['orchestrated-work-runner.ts', /hasConcurrentBaseBranchRun\(\s*activeRuns\.values\(\),\s*descriptor\.id,\s*repoId,\s*baseBranch,/],
  ['work-run-release.ts', /hasConcurrentBaseBranchRun\(\s*activeRuns\.values\(\),\s*releaseRunId,\s*repoId,\s*baseBranch,/],
  ['recovery-finalize-runner.ts', /hasConcurrentBaseBranchRun\(\s*activeRuns\.values\(\),\s*run\.id,\s*repoId,\s*product\.baseBranch,/],
] as const)('%s repository-identity wiring', (file, concurrentRunCall) => {
  it('uses the shared helper for its gate concurrent-run fact', () => {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');

    expect(source).toMatch(concurrentRunCall);
    expect(source).toMatch(/concurrentRun:\s*await hasConcurrentRun\([^)]*\)/);
  });

  it('acquires the base-branch lock by canonical repo id, not product label', () => {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    const lockFirstArguments = [...source.matchAll(/withBaseBranchLock\(\s*([^,\n]+)/g)]
      .map((match) => match[1]!.trim());

    expect(source).toMatch(/withBaseBranchLock\(repoId,\s*(?:product\.)?baseBranch,/);
    expect(source).not.toMatch(
      /withBaseBranchLock\(\s*(?:(?:run|payload)\.)?product\b/,
    );
    expect(lockFirstArguments.length).toBeGreaterThan(0);
    expect(lockFirstArguments.every((argument) => argument === 'repoId')).toBe(true);
  });
});

describe('baseBranchLockKey — per-repository / per-base-branch', () => {
  it('is the `<repoId>:<baseBranch>` composite', async () => {
    const repoId = await canonicalRepoId(runeRepo);
    expect(baseBranchLockKey(repoId, 'main')).toBe(`${repoId}:main`);
  });

  it('is identical for worktrees of the same repository and base branch', async () => {
    expect(baseBranchLockKey(await canonicalRepoId(runeRepo), 'main')).toBe(
      baseBranchLockKey(await canonicalRepoId(runeMcpWorktree), 'main'),
    );
  });

  it('differs by base branch within one repository', async () => {
    const repoId = await canonicalRepoId(runeRepo);
    expect(baseBranchLockKey(repoId, 'main')).not.toBe(baseBranchLockKey(repoId, 'release'));
  });

  it('differs by repository for the same base branch name', async () => {
    expect(baseBranchLockKey(await canonicalRepoId(runeRepo), 'main')).not.toBe(
      baseBranchLockKey(await canonicalRepoId(distinctRepo), 'main'),
    );
  });

  it('does not depend on a project slug', async () => {
    const repoId = await canonicalRepoId(runeRepo);
    const keyA = (baseBranchLockKey as (p: string, b: string, project?: string) => string)(
      repoId, 'main', 'project-A',
    );
    const keyB = (baseBranchLockKey as (p: string, b: string, project?: string) => string)(
      repoId, 'main', 'project-B',
    );
    expect(keyA).toBe(keyB);
  });
});

describe('withBaseBranchLock — repository-level serialization', () => {
  it('serializes rune and rune-mcp because their worktrees resolve to one repository', async () => {
    const order: string[] = [];
    const firstHolds = deferred();
    const runeId = await canonicalRepoId(runeRepo);
    const runeMcpId = await canonicalRepoId(runeMcpWorktree);

    const rune = withBaseBranchLock(runeId, 'main', async () => {
      order.push('rune:start');
      await firstHolds.promise;
      order.push('rune:end');
    });
    const runeMcp = withBaseBranchLock(runeMcpId, 'main', async () => {
      order.push('rune-mcp:start');
    });

    await flush();
    expect(order).toEqual(['rune:start']);

    firstHolds.resolve();
    await Promise.all([rune, runeMcp]);
    expect(order).toEqual(['rune:start', 'rune:end', 'rune-mcp:start']);
  });

  it('serializes writing and brand because their worktrees resolve to one repository', async () => {
    const order: string[] = [];
    const firstHolds = deferred();
    const writingId = await canonicalRepoId(writingRepo);
    const brandId = await canonicalRepoId(brandWorktree);

    const writing = withBaseBranchLock(writingId, 'main', async () => {
      order.push('writing:start');
      await firstHolds.promise;
      order.push('writing:end');
    });
    const brand = withBaseBranchLock(brandId, 'main', async () => {
      order.push('brand:start');
    });

    await flush();
    expect(order).toEqual(['writing:start']);

    firstHolds.resolve();
    await Promise.all([writing, brand]);
    expect(order).toEqual(['writing:start', 'writing:end', 'brand:start']);
  });

  it('does not block distinct repositories on the same base branch', async () => {
    const order: string[] = [];
    const runeHolds = deferred();
    const runeId = await canonicalRepoId(runeRepo);
    const auraId = await canonicalRepoId(distinctRepo);

    const rune = withBaseBranchLock(runeId, 'main', async () => {
      order.push('rune:start');
      await runeHolds.promise;
      order.push('rune:end');
    });
    const aura = withBaseBranchLock(auraId, 'main', async () => {
      order.push('aura:start');
    });

    await flush();
    expect(order).toContain('aura:start');

    runeHolds.resolve();
    await Promise.all([rune, aura]);
  });

  it('does not block different base branches of the same repository', async () => {
    const order: string[] = [];
    const mainHolds = deferred();
    const runeId = await canonicalRepoId(runeRepo);
    const runeMcpId = await canonicalRepoId(runeMcpWorktree);

    const main = withBaseBranchLock(runeId, 'main', async () => {
      order.push('main:start');
      await mainHolds.promise;
      order.push('main:end');
    });
    const release = withBaseBranchLock(runeMcpId, 'release', async () => {
      order.push('release:start');
    });

    await flush();
    expect(order).toContain('release:start');

    mainHolds.resolve();
    await Promise.all([main, release]);
  });

  it('releases the lock even when fn throws — one failed finalize never deadlocks the next', async () => {
    const repoId = await canonicalRepoId(runeRepo);
    await expect(
      withBaseBranchLock(repoId, 'main', async () => {
        throw new Error('merge blew up');
      }),
    ).rejects.toThrow('merge blew up');

    // A subsequent acquisition of the same key still proceeds.
    const ran = await withBaseBranchLock(repoId, 'main', async () => 'ok');
    expect(ran).toBe('ok');
  });

  it('returns fn\'s resolved value to the caller', async () => {
    const value = await withBaseBranchLock(await canonicalRepoId(runeRepo), 'main', async () => 42);
    expect(value).toBe(42);
  });
});
