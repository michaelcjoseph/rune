import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  existsSync,
} from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Test suite for `src/jobs/sandbox-runtime.ts` — the runtime complement to
 * `src/intent/sandbox.ts`'s deterministic policy core.
 *
 * Written test-first; the implementation file does not exist yet. Every test here
 * must fail with a missing-module or missing-export error, not a syntax error.
 *
 * Mirrors test-plan.md §11 — sandboxing and security (worktree isolation, cleanup,
 * error handling), and covers the full public API contract described in the Phase 6
 * A1 task.
 *
 * IMPORTANT: No test shells out to real git. All tests stub the `runGit` seam.
 */

import type { SandboxSpec } from '../intent/sandbox.js';

import {
  readProductsConfig,
  getProductConfig,
  createWorktree,
  destroyWorktree,
  cleanupOrphanWorktrees,
  type ProductConfig,
  type GitRunner,
} from './sandbox-runtime.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal products.json fixture that tests write to a temp dir. */
const FIXTURE_PRODUCTS = {
  aura: {
    repoPath: '/fake/workspace/aura',
    baseBranch: 'main',
    credentialsFile: '/fake/.config/credentials/aura/.env',
    egressAllowlist: ['github.com', 'registry.npmjs.org'],
  },
  assay: {
    repoPath: '/fake/workspace/assay',
    baseBranch: 'develop',
    credentialsFile: '/fake/.config/credentials/assay/.env',
    egressAllowlist: ['github.com'],
  },
};

const FIXTURE_WITH_TILDE = {
  aura: {
    repoPath: '~/workspace/aura',
    baseBranch: 'main',
    credentialsFile: '~/.config/jarvis/credentials/aura/.env',
    egressAllowlist: ['github.com'],
  },
};

function writeProductsJson(
  dir: string,
  contents: object = FIXTURE_PRODUCTS,
): string {
  const path = join(dir, 'products.json');
  writeFileSync(path, JSON.stringify(contents));
  return path;
}

/** A runGit stub that resolves immediately with empty stdout/stderr. */
function makeRunGit(stdout = '', stderr = '') {
  return vi.fn<GitRunner>().mockResolvedValue({ stdout, stderr });
}

/** A runGit stub that rejects with an error carrying a given message. */
function makeFailingRunGit(message: string, stderr = '') {
  const err = Object.assign(new Error(message), { stderr });
  return vi.fn<GitRunner>().mockRejectedValue(err);
}

/**
 * Porcelain output listing `worktreePath` as a registered worktree. The format
 * `git worktree list --porcelain` uses: worktree, HEAD, branch, then blank line.
 */
function porcelainListing(worktreePath: string): string {
  return `worktree ${worktreePath}\nHEAD abc1234\nbranch refs/heads/main\n\n`;
}

// ---------------------------------------------------------------------------
// Temp dir management
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'jarvis-sandbox-test-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// readProductsConfig
// ---------------------------------------------------------------------------

describe('readProductsConfig', () => {
  it('returns each product entry on a valid file', () => {
    const configPath = writeProductsJson(tmpDir);
    const result = readProductsConfig(configPath);

    expect(result).toHaveProperty('aura');
    expect(result).toHaveProperty('assay');
    expect(result['aura']!.baseBranch).toBe('main');
    expect(result['assay']!.baseBranch).toBe('develop');
  });

  it('returns the correct egressAllowlist for each product', () => {
    const configPath = writeProductsJson(tmpDir);
    const result = readProductsConfig(configPath);

    expect(result['aura']!.egressAllowlist).toEqual(['github.com', 'registry.npmjs.org']);
    expect(result['assay']!.egressAllowlist).toEqual(['github.com']);
  });

  it('expands tilde in repoPath to the user home directory', () => {
    const configPath = writeProductsJson(tmpDir, FIXTURE_WITH_TILDE);
    const result = readProductsConfig(configPath);

    const home = homedir();
    expect(result['aura']!.repoPath).toBe(join(home, 'workspace/aura'));
    expect(result['aura']!.repoPath).not.toContain('~');
  });

  it('expands tilde in credentialsFile to the user home directory', () => {
    const configPath = writeProductsJson(tmpDir, FIXTURE_WITH_TILDE);
    const result = readProductsConfig(configPath);

    const home = homedir();
    expect(result['aura']!.credentialsFile).toBe(
      join(home, '.config/jarvis/credentials/aura/.env'),
    );
    expect(result['aura']!.credentialsFile).not.toContain('~');
  });

  it('throws a clear error (naming the file path) on malformed JSON', () => {
    const configPath = join(tmpDir, 'products.json');
    writeFileSync(configPath, 'this is { not valid json');

    expect(() => readProductsConfig(configPath)).toThrow(configPath);
  });

  it('throws a clear error (naming the file path) when the file does not exist', () => {
    const missing = join(tmpDir, 'nonexistent-products.json');
    expect(() => readProductsConfig(missing)).toThrow(missing);
  });

  it('rejects a malformed product slug (e.g. path-traversal in a key)', () => {
    const configPath = writeProductsJson(tmpDir, {
      '../etc': {
        repoPath: '/fake/repo',
        baseBranch: 'main',
        credentialsFile: '/fake/.env',
        egressAllowlist: [],
      },
    });
    expect(() => readProductsConfig(configPath)).toThrow(/invalid product slug|\.\.\/etc/i);
  });

  it('rejects an entry missing the required repoPath', () => {
    const configPath = writeProductsJson(tmpDir, {
      aura: {
        baseBranch: 'main',
        credentialsFile: '/fake/.env',
        egressAllowlist: [],
      },
    });
    expect(() => readProductsConfig(configPath)).toThrow(/repoPath/);
  });
});

// ---------------------------------------------------------------------------
// getProductConfig
// ---------------------------------------------------------------------------

describe('getProductConfig', () => {
  it('returns the matching ProductConfig for a known product slug', () => {
    const configPath = writeProductsJson(tmpDir);
    const config = getProductConfig('aura', configPath);

    expect(config.baseBranch).toBe('main');
    expect(config.egressAllowlist).toContain('github.com');
  });

  it('throws a clear error naming the slug when the product is not in the file', () => {
    const configPath = writeProductsJson(tmpDir);

    expect(() => getProductConfig('relay', configPath)).toThrow(/relay/i);
  });

  it('throws a clear error naming the slug for an empty-string product', () => {
    const configPath = writeProductsJson(tmpDir);

    expect(() => getProductConfig('', configPath)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// createWorktree
// ---------------------------------------------------------------------------

describe('createWorktree', () => {
  const WORKTREE_ROOT = '/tmp/jarvis-worktrees-test';

  it('happy path: returns a SandboxSpec with worktree matching worktreePathFor', async () => {
    const configPath = writeProductsJson(tmpDir);
    const runGit = makeRunGit();

    const spec = await createWorktree({
      product: 'aura',
      project: '01-growth',
      worktreeRoot: WORKTREE_ROOT,
      productsConfigPath: configPath,
      runGit,
    });

    // worktree should be <worktreeRoot>/aura/01-growth
    expect(spec.worktree).toBe(join(WORKTREE_ROOT, 'aura', '01-growth'));
    expect(spec.product).toBe('aura');
    expect(spec.project).toBe('01-growth');
  });

  it('happy path: egressAllowlist comes from products.json', async () => {
    const configPath = writeProductsJson(tmpDir);
    const runGit = makeRunGit();

    const spec = await createWorktree({
      product: 'aura',
      project: '01-growth',
      worktreeRoot: WORKTREE_ROOT,
      productsConfigPath: configPath,
      runGit,
    });

    expect(spec.egressAllowlist).toEqual(['github.com', 'registry.npmjs.org']);
  });

  it('happy path (no branch): calls runGit with worktree add and the baseBranch from config', async () => {
    const configPath = writeProductsJson(tmpDir);
    const runGit = makeRunGit();
    const expectedPath = join(WORKTREE_ROOT, 'aura', '01-growth');

    await createWorktree({
      product: 'aura',
      project: '01-growth',
      worktreeRoot: WORKTREE_ROOT,
      productsConfigPath: configPath,
      runGit,
    });

    expect(runGit).toHaveBeenCalledOnce();
    const [calledArgs, calledOpts] = (runGit as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(calledArgs).toContain('worktree');
    expect(calledArgs).toContain('add');
    expect(calledArgs).toContain(expectedPath);
    // base branch from fixture is 'main'
    expect(calledArgs).toContain('main');
    // cwd must be the product's repoPath
    expect(calledOpts?.cwd).toBe(FIXTURE_PRODUCTS.aura.repoPath);
  });

  it('with explicit branch: passes -b <branch> before the worktree path (canonical form)', async () => {
    const configPath = writeProductsJson(tmpDir);
    const runGit = makeRunGit();
    const expectedPath = join(WORKTREE_ROOT, 'aura', '01-growth');

    await createWorktree({
      product: 'aura',
      project: '01-growth',
      branch: 'feature/my-branch',
      worktreeRoot: WORKTREE_ROOT,
      productsConfigPath: configPath,
      runGit,
    });

    const [calledArgs] = runGit.mock.calls[0]!;
    expect(calledArgs).toContain('-b');
    expect(calledArgs).toContain('feature/my-branch');
    // Canonical git syntax — `[-b <new-branch>] <path>` — requires the flag
    // before the path. Some git builds reject the flag-after-path form.
    const pathIdx = calledArgs.indexOf(expectedPath);
    const flagIdx = calledArgs.indexOf('-b');
    expect(flagIdx).toBeLessThan(pathIdx);
  });

  it('throws a clear error when the product is unknown', async () => {
    const configPath = writeProductsJson(tmpDir);
    const runGit = makeRunGit();

    await expect(
      createWorktree({
        product: 'relay',
        project: '01-core',
        worktreeRoot: WORKTREE_ROOT,
        productsConfigPath: configPath,
        runGit,
      }),
    ).rejects.toThrow(/relay/i);
  });

  it('does not call runGit when the product is unknown', async () => {
    const configPath = writeProductsJson(tmpDir);
    const runGit = makeRunGit();

    await expect(
      createWorktree({
        product: 'relay',
        project: '01-core',
        worktreeRoot: WORKTREE_ROOT,
        productsConfigPath: configPath,
        runGit,
      }),
    ).rejects.toThrow();

    expect(runGit).not.toHaveBeenCalled();
  });

  it('rethrows a clear error (mentioning the worktree path) when runGit rejects', async () => {
    const configPath = writeProductsJson(tmpDir);
    const runGit = makeFailingRunGit('fatal: not a git repository', 'fatal: not a git repository');
    const expectedPath = join(WORKTREE_ROOT, 'aura', '01-growth');

    await expect(
      createWorktree({
        product: 'aura',
        project: '01-growth',
        worktreeRoot: WORKTREE_ROOT,
        productsConfigPath: configPath,
        runGit,
      }),
    ).rejects.toThrow(new RegExp(expectedPath.replace(/\//g, '\\/'), 'i'));
  });

  it('throws before shelling out when the worktree path already exists on disk', async () => {
    const configPath = writeProductsJson(tmpDir);
    const runGit = makeRunGit();

    // Use the actual tmp dir as the worktree root so the path will exist
    const worktreeRoot = tmpDir;
    const existingPath = join(worktreeRoot, 'aura', '01-growth');
    mkdirSync(existingPath, { recursive: true });

    await expect(
      createWorktree({
        product: 'aura',
        project: '01-growth',
        worktreeRoot,
        productsConfigPath: configPath,
        runGit,
      }),
    ).rejects.toThrow();

    // runGit must not have been called
    expect(runGit).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// destroyWorktree
// ---------------------------------------------------------------------------

describe('destroyWorktree', () => {
  const WORKTREE_PATH = '/tmp/jarvis-worktrees-test/aura/01-growth';

  function makeSpec(overrides: Partial<SandboxSpec> = {}): SandboxSpec {
    return {
      product: 'aura',
      project: '01-growth',
      worktree: WORKTREE_PATH,
      egressAllowlist: ['github.com'],
      ...overrides,
    };
  }

  it('happy path: calls runGit with worktree remove --force and the worktree path', async () => {
    const configPath = writeProductsJson(tmpDir);
    const runGit = makeRunGit();
    const spec = makeSpec();

    await destroyWorktree(spec, { productsConfigPath: configPath, runGit });

    expect(runGit).toHaveBeenCalledOnce();
    const [calledArgs, calledOpts] = (runGit as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(calledArgs).toContain('worktree');
    expect(calledArgs).toContain('remove');
    expect(calledArgs).toContain('--force');
    expect(calledArgs).toContain(WORKTREE_PATH);
    expect(calledOpts?.cwd).toBe(FIXTURE_PRODUCTS.aura.repoPath);
  });

  it('is idempotent: does not throw when runGit stderr says "not a working tree"', async () => {
    const configPath = writeProductsJson(tmpDir);
    const err = Object.assign(new Error('exit code 128'), {
      stderr: 'fatal: /tmp/some/path is not a working tree',
    });
    const runGit = vi.fn().mockRejectedValue(err);
    const spec = makeSpec();

    // Must resolve without throwing
    await expect(
      destroyWorktree(spec, { productsConfigPath: configPath, runGit }),
    ).resolves.toBeUndefined();
  });

  it('rethrows on failures unrelated to "not a working tree"', async () => {
    const configPath = writeProductsJson(tmpDir);
    const err = Object.assign(new Error('fatal: not a git repository'), {
      stderr: 'fatal: not a git repository',
    });
    const runGit = vi.fn().mockRejectedValue(err);
    const spec = makeSpec();

    await expect(
      destroyWorktree(spec, { productsConfigPath: configPath, runGit }),
    ).rejects.toThrow(/git repository|worktree/i);
  });

  it('rethrows with a clear error on a non-zero exit with no stderr', async () => {
    const configPath = writeProductsJson(tmpDir);
    const err = Object.assign(new Error('Process exited with code 1'), { stderr: '' });
    const runGit = vi.fn<GitRunner>().mockRejectedValue(err);
    const spec = makeSpec();

    await expect(
      destroyWorktree(spec, { productsConfigPath: configPath, runGit }),
    ).rejects.toThrow();
  });

  it('refuses (without calling runGit) when the worktree is outside worktreeRoot', async () => {
    const configPath = writeProductsJson(tmpDir);
    const runGit = makeRunGit();
    const spec = makeSpec({ worktree: '/etc/passwd' });

    await expect(
      destroyWorktree(spec, {
        productsConfigPath: configPath,
        worktreeRoot: '/tmp/jarvis-worktrees-test',
        runGit,
      }),
    ).rejects.toThrow(/worktreeRoot|inside/i);

    expect(runGit).not.toHaveBeenCalled();
  });

  it('refuses a sibling that merely shares the worktreeRoot prefix', async () => {
    const configPath = writeProductsJson(tmpDir);
    const runGit = makeRunGit();
    // `/tmp/jarvis-worktrees-test-evil/...` is NOT inside `/tmp/jarvis-worktrees-test`.
    const spec = makeSpec({ worktree: '/tmp/jarvis-worktrees-test-evil/aura/x' });

    await expect(
      destroyWorktree(spec, {
        productsConfigPath: configPath,
        worktreeRoot: '/tmp/jarvis-worktrees-test',
        runGit,
      }),
    ).rejects.toThrow(/worktreeRoot|inside/i);

    expect(runGit).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// cleanupOrphanWorktrees
// ---------------------------------------------------------------------------

describe('cleanupOrphanWorktrees', () => {
  it('returns [] and makes no runGit calls when worktreeRoot does not exist', async () => {
    const configPath = writeProductsJson(tmpDir);
    const runGit = makeRunGit();
    const missingRoot = join(tmpDir, 'no-such-root');

    const result = await cleanupOrphanWorktrees({
      worktreeRoot: missingRoot,
      productsConfigPath: configPath,
      runGit,
    });

    expect(result).toEqual([]);
    expect(runGit).not.toHaveBeenCalled();
  });

  it('returns [] and makes no runGit calls when products.json does not exist', async () => {
    const runGit = makeRunGit();
    const missingConfig = join(tmpDir, 'products.json'); // does not exist yet
    const worktreeRoot = tmpDir;

    const result = await cleanupOrphanWorktrees({
      worktreeRoot,
      productsConfigPath: missingConfig,
      runGit,
    });

    expect(result).toEqual([]);
    expect(runGit).not.toHaveBeenCalled();
  });

  it('returns [] when the on-disk worktree IS registered in git worktree list --porcelain', async () => {
    const configPath = writeProductsJson(tmpDir);

    // Create an on-disk worktree dir for aura
    const worktreeRoot = join(tmpDir, 'worktrees');
    const auraWorktree = join(worktreeRoot, 'aura', '01-growth');
    mkdirSync(auraWorktree, { recursive: true });

    const runGit = vi.fn().mockImplementation(async (args: string[]) => {
      if (args.includes('prune')) return { stdout: '', stderr: '' };
      if (args.includes('--porcelain')) {
        return { stdout: porcelainListing(auraWorktree), stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });

    const result = await cleanupOrphanWorktrees({
      worktreeRoot,
      productsConfigPath: configPath,
      runGit,
    });

    expect(result).toEqual([]);
    // The on-disk dir must still exist (was not removed)
    expect(existsSync(auraWorktree)).toBe(true);
  });

  it('removes an on-disk dir that is NOT in git worktree list --porcelain and returns its path', async () => {
    const configPath = writeProductsJson(tmpDir);

    const worktreeRoot = join(tmpDir, 'worktrees');
    const orphanDir = join(worktreeRoot, 'aura', '99-orphan');
    mkdirSync(orphanDir, { recursive: true });

    const runGit = vi.fn().mockImplementation(async (args: string[]) => {
      if (args.includes('prune')) return { stdout: '', stderr: '' };
      // porcelain output does NOT include orphanDir — so it is an orphan
      if (args.includes('--porcelain')) {
        return {
          stdout: 'worktree /some/other/path\nHEAD abc\nbranch refs/heads/main\n\n',
          stderr: '',
        };
      }
      return { stdout: '', stderr: '' };
    });

    const result = await cleanupOrphanWorktrees({
      worktreeRoot,
      productsConfigPath: configPath,
      runGit,
    });

    expect(result).toContain(orphanDir);
    // The orphan dir must have been removed
    expect(existsSync(orphanDir)).toBe(false);
  });

  it('removes only the orphan when there are two on-disk dirs and one is registered', async () => {
    const configPath = writeProductsJson(tmpDir);

    const worktreeRoot = join(tmpDir, 'worktrees');
    const registeredDir = join(worktreeRoot, 'aura', '01-growth');
    const orphanDir = join(worktreeRoot, 'aura', '99-orphan');
    mkdirSync(registeredDir, { recursive: true });
    mkdirSync(orphanDir, { recursive: true });

    const runGit = vi.fn().mockImplementation(async (args: string[]) => {
      if (args.includes('prune')) return { stdout: '', stderr: '' };
      if (args.includes('--porcelain')) {
        // Only registeredDir appears in the porcelain listing
        return { stdout: porcelainListing(registeredDir), stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });

    const result = await cleanupOrphanWorktrees({
      worktreeRoot,
      productsConfigPath: configPath,
      runGit,
    });

    expect(result).toContain(orphanDir);
    expect(result).not.toContain(registeredDir);
    expect(existsSync(orphanDir)).toBe(false);
    expect(existsSync(registeredDir)).toBe(true);
  });

  it('continues to the next product and does not throw when one product\'s prune fails', async () => {
    // Two-product fixture: aura's prune fails, assay's prune succeeds.
    // The test is order-independent — we identify which product's invocation
    // came in by `opts.cwd`, not by call order, so any future change in
    // Object.entries iteration order leaves the test correct.
    const configPath = writeProductsJson(tmpDir);

    const worktreeRoot = join(tmpDir, 'worktrees');
    mkdirSync(join(worktreeRoot, 'aura'), { recursive: true });
    mkdirSync(join(worktreeRoot, 'assay'), { recursive: true });

    const prunedFor: string[] = [];
    const runGit = vi.fn<GitRunner>().mockImplementation(async (args, opts) => {
      if (args.includes('prune')) {
        prunedFor.push(opts?.cwd ?? '');
        if (opts?.cwd === FIXTURE_PRODUCTS.aura.repoPath) {
          throw Object.assign(new Error('fatal: not a git repository'), {
            stderr: 'fatal: not a git repository',
          });
        }
        return { stdout: '', stderr: '' };
      }
      // For the surviving product, --porcelain returns empty so any on-disk
      // child would be treated as orphan — keep the product dir empty to
      // isolate this test from removal logic.
      return { stdout: '', stderr: '' };
    });

    // Must not throw even though aura's prune failed.
    await expect(
      cleanupOrphanWorktrees({
        worktreeRoot,
        productsConfigPath: configPath,
        runGit,
      }),
    ).resolves.not.toThrow();

    // Prune must have been attempted for both products, regardless of order.
    expect(prunedFor).toContain(FIXTURE_PRODUCTS.aura.repoPath);
    expect(prunedFor).toContain(FIXTURE_PRODUCTS.assay.repoPath);
  });
});
