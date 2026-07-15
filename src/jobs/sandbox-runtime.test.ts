import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  lstatSync,
  readlinkSync,
  realpathSync,
  readFileSync,
} from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

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

import { worktreePathFor, type SandboxSpec } from '../intent/sandbox.js';

import {
  readProductsConfig,
  getProductConfig,
  createWorktree as createWorktreeProduction,
  linkWorktreeDeps,
  destroyWorktree,
  cleanupOrphanWorktrees,
  vitestCacheDirFor,
  removeVitestCache,
  verifyWorktreeProvisioning,
  defaultRunGit,
  type ProductConfig,
  type GitRunner,
  type CreateWorktreeOpts,
} from './sandbox-runtime.js';

// Most lifecycle unit tests inject Git and intentionally do not create real
// directories. Keep their scope on argument/reconciliation behavior; dedicated
// postcondition and real-repository tests call createWorktreeProduction.
function createWorktree(opts: CreateWorktreeOpts) {
  return createWorktreeProduction({
    ...opts,
    verifyProvisioning: async () => ({ ok: true }),
  });
}

describe('worktree Vitest cache isolation', () => {
  it('derives a stable opaque cache path under the OS temp root', () => {
    const worktree = join(tmpdir(), 'worktrees', 'rune', '01-test');
    const cache = vitestCacheDirFor(worktree);

    expect(cache).toBe(vitestCacheDirFor(worktree));
    expect(cache.startsWith(join(tmpdir(), 'rune-vitest-cache') + '/')).toBe(true);
    expect(cache).not.toContain(worktree);
    expect(cache).not.toContain('01-test');
  });

  it('derives distinct cache paths for distinct worktrees', () => {
    expect(vitestCacheDirFor('/tmp/worktrees/rune/01-test'))
      .not.toBe(vitestCacheDirFor('/tmp/worktrees/aura/01-test'));
  });

  it('removes only the cache belonging to the requested worktree and is idempotent', () => {
    const first = join(tmpDir, 'first-worktree');
    const second = join(tmpDir, 'second-worktree');
    const firstCache = vitestCacheDirFor(first);
    const secondCache = vitestCacheDirFor(second);
    mkdirSync(firstCache, { recursive: true });
    mkdirSync(secondCache, { recursive: true });
    writeFileSync(join(firstCache, 'cache-entry'), 'first');
    writeFileSync(join(secondCache, 'cache-entry'), 'second');

    expect(removeVitestCache(first)).toBe(true);
    expect(removeVitestCache(first)).toBe(true);
    expect(existsSync(firstCache)).toBe(false);
    expect(existsSync(secondCache)).toBe(true);
    removeVitestCache(second);
  });
});

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
    credentialsFile: '~/.config/rune/credentials/aura/.env',
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
  tmpDir = mkdtempSync(join(tmpdir(), 'rune-sandbox-test-'));
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
      join(home, '.config/rune/credentials/aura/.env'),
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

describe('readProductsConfig — artifactMcp', () => {
  it('accepts rune-kb-readonly and leaves an absent policy undefined', () => {
    const configPath = writeProductsJson(tmpDir, {
      writing: { repoPath: '/fake/writing', artifactMcp: 'rune-kb-readonly' },
      aura: { repoPath: '/fake/aura' },
    });
    const products = readProductsConfig(configPath);
    expect(products['writing']!.artifactMcp).toBe('rune-kb-readonly');
    expect(products['aura']!.artifactMcp).toBeUndefined();
  });

  it('rejects unknown artifact MCP policies', () => {
    const configPath = writeProductsJson(tmpDir, {
      writing: { repoPath: '/fake/writing', artifactMcp: 'rune-kb-admin' },
    });
    expect(() => readProductsConfig(configPath)).toThrow(/invalid artifactMcp.*rune-kb-readonly/i);
  });

  it('enables the read-only policy for both committed writing products only', () => {
    const realConfigPath = fileURLToPath(new URL('../../policies/products.json', import.meta.url));
    const products = readProductsConfig(realConfigPath);
    expect(products['writing']!.artifactMcp).toBe('rune-kb-readonly');
    expect(products['brand']!.artifactMcp).toBe('rune-kb-readonly');
    expect(products['rune']!.artifactMcp).toBeUndefined();
    expect(products['rune-mcp']!.artifactMcp).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// readProductsConfig — validationCommands (project 15, P1.5)
//
// The gated-merge finalizer reads each product's `validationCommands` from
// policies/products.json and runs them in an integration worktree as the hard
// merge gate. WRITE-FIRST: `readProductsConfig` does not yet parse the field, so
// these assert against fixtures and are RED (undefined ≠ the expected array)
// until the P1.5 parsing lands. The contract: ALWAYS an array — `[]` (or absent)
// fails the gate CLOSED (`missing-validation-command`, see work-run-gate.ts),
// never an unverified merge.
// ---------------------------------------------------------------------------

describe('readProductsConfig — validationCommands (P1.5)', () => {
  it('parses a product\'s validationCommands array from the file', () => {
    const configPath = writeProductsJson(tmpDir, {
      aura: {
        repoPath: '/fake/workspace/aura',
        baseBranch: 'main',
        credentialsFile: '/fake/.env',
        egressAllowlist: [],
        validationCommands: ['npm run build', 'npm test'],
      },
    });
    const result = readProductsConfig(configPath);
    expect(result['aura']!.validationCommands).toEqual(['npm run build', 'npm test']);
  });

  it('fails CLOSED: a product with NO validationCommands defaults to an empty array', () => {
    // Absent → `[]` (never undefined), so the gate reads hasValidationCommands
    // = false and stops at branch-complete rather than merging unverified.
    const configPath = writeProductsJson(tmpDir, {
      aura: {
        repoPath: '/fake/workspace/aura',
        baseBranch: 'main',
        credentialsFile: '/fake/.env',
        egressAllowlist: [],
      },
    });
    const result = readProductsConfig(configPath);
    expect(result['aura']!.validationCommands).toEqual([]);
  });

  it('coerces a non-array validationCommands to an empty array (fail-closed, mirrors egressAllowlist)', () => {
    const configPath = writeProductsJson(tmpDir, {
      aura: {
        repoPath: '/fake/workspace/aura',
        baseBranch: 'main',
        credentialsFile: '/fake/.env',
        egressAllowlist: [],
        validationCommands: 'npm test',
      },
    });
    const result = readProductsConfig(configPath);
    expect(result['aura']!.validationCommands).toEqual([]);
  });

  it('stringifies non-string validationCommands entries (mirrors egressAllowlist .map(String))', () => {
    const configPath = writeProductsJson(tmpDir, {
      aura: {
        repoPath: '/fake/workspace/aura',
        baseBranch: 'main',
        credentialsFile: '/fake/.env',
        egressAllowlist: [],
        validationCommands: ['npm test', 42],
      },
    });
    const result = readProductsConfig(configPath);
    expect(result['aura']!.validationCommands).toEqual(['npm test', '42']);
  });

  it('the REAL Rune product config declares validationCommands ["npm run build", "npm test"]', () => {
    // Read-only against the committed policies/products.json (test-plan §6:
    // "Rune product config includes validationCommands"). RED until the P1.5
    // impl task adds the field to the real file — this test never mutates it.
    // The exact list is a spec-pinned policy choice (spec req 16); if Rune's
    // build/test commands ever change, update the spec + this assertion together
    // (deliberately) rather than treating a drift as a silent false alarm.
    const realConfigPath = fileURLToPath(
      new URL('../../policies/products.json', import.meta.url),
    );
    const result = readProductsConfig(realConfigPath);
    expect(result['rune']!.validationCommands).toEqual(['npm run build', 'npm test']);
  });
});

describe('readProductsConfig — closeoutValidationStrategy', () => {
  it.each(['vitest-related', 'product-commands'] as const)('parses %s', (strategy) => {
    const configPath = writeProductsJson(tmpDir, {
      rune: {
        repoPath: '/fake/workspace/rune',
        closeoutValidationStrategy: strategy,
      },
    });
    expect(readProductsConfig(configPath)['rune']!.closeoutValidationStrategy).toBe(strategy);
  });

  it('defaults an absent strategy to product-commands', () => {
    const configPath = writeProductsJson(tmpDir, {
      aura: { repoPath: '/fake/workspace/aura' },
    });
    expect(readProductsConfig(configPath)['aura']!.closeoutValidationStrategy).toBe('product-commands');
  });

  it('rejects an invalid configured strategy', () => {
    const configPath = writeProductsJson(tmpDir, {
      rune: {
        repoPath: '/fake/workspace/rune',
        closeoutValidationStrategy: 'full-suite',
      },
    });
    expect(() => readProductsConfig(configPath)).toThrow(/invalid closeoutValidationStrategy/);
  });

  it('opts the real Rune products into related tests', () => {
    const configPath = fileURLToPath(new URL('../../policies/products.json', import.meta.url));
    const products = readProductsConfig(configPath);
    expect(products['rune']!.closeoutValidationStrategy).toBe('vitest-related');
    expect(products['rune-mcp']!.closeoutValidationStrategy).toBe('vitest-related');
  });
});

// ---------------------------------------------------------------------------
// readProductsConfig — product policy schema (project 19, W2 Phase 4)
//
// Product-OS metadata lives in policies/products.json, not in frontend grouping
// code. These tests pin the policy-reader contract only: class is constrained to
// internal/external, scopePath is optional and preserved for shared-repo products,
// and the real policy file contains the Phase 4 roster metadata. Phase 6 pins
// writing/brand execution fields; this phase must not require them.
// ---------------------------------------------------------------------------

describe('readProductsConfig — product-policy-schema (project 19)', () => {
  it('parses class and optional scopePath from products.json entries', () => {
    const configPath = writeProductsJson(tmpDir, {
      'rune-mcp': {
        class: 'internal',
        repoPath: '~/workspace/rune',
        baseBranch: 'main',
        credentialsFile: '~/.config/rune/credentials/rune/.env',
        egressAllowlist: ['github.com'],
      },
      writing: {
        class: 'external',
        repoPath: '~/workspace/michaelcjoseph.com',
        scopePath: 'docs/rune',
        baseBranch: 'main',
        credentialsFile: '~/.config/rune/credentials/writing/.env',
        egressAllowlist: ['github.com', 'registry.npmjs.org'],
      },
    });

    const result = readProductsConfig(configPath);

    expect(result['rune-mcp']).toMatchObject({
      class: 'internal',
      repoPath: join(homedir(), 'workspace/rune'),
    });
    expect(result['writing']).toMatchObject({
      class: 'external',
      repoPath: join(homedir(), 'workspace/michaelcjoseph.com'),
      scopePath: 'docs/rune',
    });
  });

  it('rejects a product class outside internal/external', () => {
    const configPath = writeProductsJson(tmpDir, {
      aura: {
        class: 'partner',
        repoPath: '/fake/workspace/aura',
        baseBranch: 'main',
        credentialsFile: '/fake/.env',
        egressAllowlist: [],
      },
    });

    expect(() => readProductsConfig(configPath)).toThrow(/class|internal|external/i);
  });

  it('the REAL products policy defines the Product-OS roster classes', () => {
    const realConfigPath = fileURLToPath(
      new URL('../../policies/products.json', import.meta.url),
    );
    const result = readProductsConfig(realConfigPath);
    const expectedRoster = ['rune', 'rune-mcp', 'aura', 'assay', 'relay', 'writing', 'brand'];

    expect(Object.keys(result).sort()).toEqual([...expectedRoster].sort());
    expect(Object.fromEntries(
      expectedRoster.map(
        (name) => [name, result[name]?.class],
      ),
    )).toEqual({
      rune: 'internal',
      'rune-mcp': 'internal',
      aura: 'external',
      assay: 'external',
      relay: 'external',
      writing: 'external',
      brand: 'external',
    });
  });

  it('the REAL products policy declares Phase 4 metadata for rune-mcp, writing, and brand', () => {
    const realConfigPath = fileURLToPath(
      new URL('../../policies/products.json', import.meta.url),
    );
    const result = readProductsConfig(realConfigPath);

    for (const product of ['rune-mcp', 'writing', 'brand']) {
      expect(result[product], `${product} entry`).toBeDefined();
    }

    expect(result['rune-mcp']!.class).toBe('internal');
    expect(result['writing']!.class).toBe('external');
    expect(result['brand']!.class).toBe('external');
    expect(result['writing']!.scopePath).toBe('docs/rune');
    expect(result['brand']!.scopePath).toBeUndefined();
  });

  it('the REAL products policy declares Phase 6 execution metadata for writing and brand', () => {
    const realConfigPath = fileURLToPath(
      new URL('../../policies/products.json', import.meta.url),
    );
    const result = readProductsConfig(realConfigPath);
    const expectedRepo = join(homedir(), 'workspace/michaelcjoseph.com');

    expect(result['writing']).toMatchObject({
      class: 'external',
      repoPath: expectedRepo,
      scopePath: 'docs/rune',
      baseBranch: 'main',
      orchestratedMode: true,
    });
    expect(result['brand']).toMatchObject({
      class: 'external',
      repoPath: expectedRepo,
      baseBranch: 'main',
    });
    expect(result['writing']!.credentialsFile).toMatch(/\/\.config\/rune\/credentials\/writing\/\.env$/);
    expect(result['brand']!.credentialsFile).toMatch(/\/\.config\/rune\/credentials\/brand\/\.env$/);
    expect(result['writing']!.egressAllowlist).toEqual(
      expect.arrayContaining(['github.com', 'api.github.com', 'registry.npmjs.org']),
    );
    const writingValidationCommands = result['writing']!.validationCommands ?? [];
    expect(writingValidationCommands.length).toBeGreaterThan(0);
    expect(writingValidationCommands).toEqual(
      expect.arrayContaining([expect.stringMatching(/\b(build|lint|test)\b/)]),
    );
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
  let WORKTREE_ROOT: string;

  beforeEach(() => {
    WORKTREE_ROOT = join(tmpDir, 'worktrees');
  });

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
    // A branch request resolves HEAD first; give rev-parse a sha so the
    // capture succeeds (empty stdout now throws by design).
    const runGit = vi.fn<GitRunner>(async (args: string[]) =>
      args.includes('rev-parse') ? { stdout: 'headsha123\n', stderr: '' } : { stdout: '', stderr: '' },
    );
    const expectedPath = join(WORKTREE_ROOT, 'aura', '01-growth');

    await createWorktree({
      product: 'aura',
      project: '01-growth',
      branch: 'feature/my-branch',
      worktreeRoot: WORKTREE_ROOT,
      productsConfigPath: configPath,
      runGit,
    });

    // A branch request now also resolves HEAD first (rev-parse), so locate the
    // worktree-add call explicitly rather than assuming it is call 0.
    const addCall = runGit.mock.calls.find(c => c[0].includes('add'))!;
    const calledArgs = addCall[0];
    expect(calledArgs).toContain('-b');
    expect(calledArgs).toContain('feature/my-branch');
    // Canonical git syntax — `[-b <new-branch>] <path>` — requires the flag
    // before the path. Some git builds reject the flag-after-path form.
    const pathIdx = calledArgs.indexOf(expectedPath);
    const flagIdx = calledArgs.indexOf('-b');
    expect(flagIdx).toBeLessThan(pathIdx);
  });

  it('with branch and no startPoint: resolves HEAD and branches from it; returns baseSha', async () => {
    const configPath = writeProductsJson(tmpDir);
    const headSha = 'deadbeefcafe1234567890';
    const runGit = vi.fn<GitRunner>(async (args: string[]) => {
      if (args.includes('rev-parse')) return { stdout: `${headSha}\n`, stderr: '' };
      return { stdout: '', stderr: '' };
    });

    const spec = await createWorktree({
      product: 'aura',
      project: '01-growth',
      branch: 'rune-work/abc',
      worktreeRoot: WORKTREE_ROOT,
      productsConfigPath: configPath,
      runGit,
    });

    // HEAD was resolved in the product repo (atomic capture + branch-point).
    const revParse = runGit.mock.calls.find(c => c[0].includes('rev-parse'));
    expect(revParse).toBeDefined();
    expect(revParse![0]).toEqual(['rev-parse', 'HEAD']);
    expect(revParse![1]?.cwd).toBe(FIXTURE_PRODUCTS.aura.repoPath);

    // The worktree-add branched from the captured sha (start-point last).
    const addCall = runGit.mock.calls.find(c => c[0].includes('add'))!;
    expect(addCall[0][addCall[0].length - 1]).toBe(headSha);
    // …and the resolved base sha is returned on the spec.
    expect(spec.baseSha).toBe(headSha);
  });

  it('with branch: throws (mentioning the product repo) when rev-parse HEAD fails', async () => {
    const configPath = writeProductsJson(tmpDir);
    const runGit = vi.fn<GitRunner>(async (args: string[]) => {
      if (args.includes('rev-parse')) throw Object.assign(new Error('not a git repo'), { stderr: '' });
      return { stdout: '', stderr: '' };
    });

    await expect(
      createWorktree({
        product: 'aura',
        project: '01-growth',
        branch: 'rune-work/fail',
        worktreeRoot: WORKTREE_ROOT,
        productsConfigPath: configPath,
        runGit,
      }),
    ).rejects.toThrow(FIXTURE_PRODUCTS.aura.repoPath);
  });

  it('with branch: throws when rev-parse HEAD returns empty (repo with no commits)', async () => {
    const configPath = writeProductsJson(tmpDir);
    const runGit = makeRunGit(); // empty stdout for all calls
    await expect(
      createWorktree({
        product: 'aura',
        project: '01-growth',
        branch: 'rune-work/empty',
        worktreeRoot: WORKTREE_ROOT,
        productsConfigPath: configPath,
        runGit,
      }),
    ).rejects.toThrow(/empty|no commits/i);
  });

  it('with explicit startPoint: branches from it without resolving HEAD; returns it as baseSha', async () => {
    const configPath = writeProductsJson(tmpDir);
    const runGit = makeRunGit();

    const spec = await createWorktree({
      product: 'aura',
      project: '01-growth',
      branch: 'rune-work/xyz',
      startPoint: 'abc1234base',
      worktreeRoot: WORKTREE_ROOT,
      productsConfigPath: configPath,
      runGit,
    });

    // Caller supplied the base — no rev-parse needed.
    expect(runGit.mock.calls.some(c => c[0].includes('rev-parse'))).toBe(false);
    // An explicit startPoint forces a fresh branch — the resume probe is skipped.
    expect(runGit.mock.calls.some(c => c[0][0] === 'show-ref')).toBe(false);
    const addCall = runGit.mock.calls.find(c => c[0].includes('add'))!;
    expect(addCall[0]).toContain('-b');
    expect(addCall[0]).toContain('abc1234base');
    expect(spec.baseSha).toBe('abc1234base');
    expect(spec.resumed).toBe(false);
  });

  it('RESUMES an existing branch with base already contained: checks it out, skips rebase, tip becomes baseSha', async () => {
    const configPath = writeProductsJson(tmpDir);
    const tip = 'resumetip0987654321fedcba0987654321fedcba';
    const baseTip = 'basetip0987654321fedcba0987654321fedcba00';
    const branch = 'rune-work/01-growth';
    const runGit = vi.fn<GitRunner>(async (args: string[]) => {
      if (args[0] === 'show-ref') return { stdout: `${tip} refs/heads/${branch}\n`, stderr: '' };
      if (args[0] === 'rev-parse' && args[1] === 'main') return { stdout: `${baseTip}\n`, stderr: '' };
      if (args[0] === 'merge-base') return { stdout: `${baseTip}\n`, stderr: '' };
      return { stdout: '', stderr: '' };
    });
    const expectedPath = join(WORKTREE_ROOT, 'aura', '01-growth');

    const spec = await createWorktree({
      product: 'aura',
      project: '01-growth',
      branch,
      worktreeRoot: WORKTREE_ROOT,
      productsConfigPath: configPath,
      runGit,
    });

    // No product-repo HEAD resolve on a resume — only the configured base
    // branch is inspected for resume-time reconciliation.
    expect(runGit.mock.calls.some(c => c[0][0] === 'rev-parse' && c[0][1] === 'HEAD')).toBe(false);
    // worktree-add checks out the EXISTING branch, with NO -b flag, so the
    // project's prior commits are present in the worktree.
    const addCall = runGit.mock.calls.find(c => c[0].includes('add'))!;
    expect(addCall[0]).not.toContain('-b');
    expect(addCall[0]).toContain(expectedPath);
    // The branch (a commit-ish) is the last arg — not a fresh sha.
    expect(addCall[0][addCall[0].length - 1]).toBe(branch);
    expect(runGit.mock.calls.some(c => c[0][0] === 'rebase')).toBe(false);
    expect(spec.baseSha).toBe(tip);
    expect(spec.baseReconciled).toBeUndefined();
    expect(spec.resumed).toBe(true);
  });

  it('RESUME: frees the branch from the main checkout (clean tree) before worktree add', async () => {
    const configPath = writeProductsJson(tmpDir);
    const tip = 'resumetip0987654321fedcba0987654321fedcba';
    const baseTip = 'basetip0987654321fedcba0987654321fedcba00';
    const branch = 'rune-work/01-growth';
    const runGit = vi.fn<GitRunner>(async (args: string[]) => {
      if (args[0] === 'show-ref') return { stdout: `${tip} refs/heads/${branch}\n`, stderr: '' };
      // The product's main checkout is sitting on the run's branch.
      if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return { stdout: `${branch}\n`, stderr: '' };
      if (args[0] === 'status') return { stdout: '', stderr: '' }; // clean
      if (args[0] === 'rev-parse' && args[1] === 'main') return { stdout: `${baseTip}\n`, stderr: '' };
      if (args[0] === 'merge-base') return { stdout: `${baseTip}\n`, stderr: '' };
      return { stdout: '', stderr: '' };
    });

    const spec = await createWorktree({
      product: 'aura',
      project: '01-growth',
      branch,
      worktreeRoot: WORKTREE_ROOT,
      productsConfigPath: configPath,
      runGit,
    });

    // The branch is freed by switching the main checkout to baseBranch, and that
    // happens BEFORE the worktree add so the add no longer collides.
    const checkoutIndex = runGit.mock.calls.findIndex(c => c[0][0] === 'checkout' && c[0][1] === 'main');
    const addIndex = runGit.mock.calls.findIndex(c => c[0][0] === 'worktree' && c[0][1] === 'add');
    expect(checkoutIndex).toBeGreaterThanOrEqual(0);
    expect(addIndex).toBeGreaterThan(checkoutIndex);
    expect(spec.resumed).toBe(true);
  });

  it('RESUME: refuses to free the branch when the main checkout has uncommitted changes', async () => {
    const configPath = writeProductsJson(tmpDir);
    const tip = 'resumetip0987654321fedcba0987654321fedcba';
    const branch = 'rune-work/01-growth';
    const runGit = vi.fn<GitRunner>(async (args: string[]) => {
      if (args[0] === 'show-ref') return { stdout: `${tip} refs/heads/${branch}\n`, stderr: '' };
      if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return { stdout: `${branch}\n`, stderr: '' };
      if (args[0] === 'status') return { stdout: ' M src/foo.ts\n', stderr: '' }; // dirty
      return { stdout: '', stderr: '' };
    });

    await expect(
      createWorktree({
        product: 'aura',
        project: '01-growth',
        branch,
        worktreeRoot: WORKTREE_ROOT,
        productsConfigPath: configPath,
        runGit,
      }),
    ).rejects.toThrow(/uncommitted changes/);
    // Never reached the worktree add — failed closed.
    expect(runGit.mock.calls.some(c => c[0][0] === 'worktree' && c[0][1] === 'add')).toBe(false);
  });

  it('RESUME: leaves the main checkout alone when it is on a different branch', async () => {
    const configPath = writeProductsJson(tmpDir);
    const tip = 'resumetip0987654321fedcba0987654321fedcba';
    const baseTip = 'basetip0987654321fedcba0987654321fedcba00';
    const branch = 'rune-work/01-growth';
    const runGit = vi.fn<GitRunner>(async (args: string[]) => {
      if (args[0] === 'show-ref') return { stdout: `${tip} refs/heads/${branch}\n`, stderr: '' };
      // Main checkout is on some unrelated branch — must not be disturbed.
      if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return { stdout: 'main\n', stderr: '' };
      if (args[0] === 'rev-parse' && args[1] === 'main') return { stdout: `${baseTip}\n`, stderr: '' };
      if (args[0] === 'merge-base') return { stdout: `${baseTip}\n`, stderr: '' };
      return { stdout: '', stderr: '' };
    });

    const spec = await createWorktree({
      product: 'aura',
      project: '01-growth',
      branch,
      worktreeRoot: WORKTREE_ROOT,
      productsConfigPath: configPath,
      runGit,
    });

    // No status probe and no checkout when the branch isn't held by the main tree.
    expect(runGit.mock.calls.some(c => c[0][0] === 'status')).toBe(false);
    expect(runGit.mock.calls.some(c => c[0][0] === 'checkout')).toBe(false);
    expect(spec.resumed).toBe(true);
  });

  it('RESUMES an existing branch behind base: rebases and returns post-rebase HEAD as baseSha', async () => {
    const configPath = writeProductsJson(tmpDir);
    const previousTip = 'previous0987654321fedcba0987654321fedcba';
    const baseTip = 'basetip0987654321fedcba0987654321fedcba00';
    const mergeBase = 'mergebase987654321fedcba987654321fedcba';
    const newTip = 'newtip0987654321fedcba0987654321fedcba000';
    const branch = 'rune-work/01-growth';
    const expectedPath = join(WORKTREE_ROOT, 'aura', '01-growth');
    const runGit = vi.fn<GitRunner>(async (args: string[]) => {
      if (args[0] === 'show-ref') return { stdout: `${previousTip} refs/heads/${branch}\n`, stderr: '' };
      if (args[0] === 'rev-parse' && args[1] === 'main') return { stdout: `${baseTip}\n`, stderr: '' };
      if (args[0] === 'merge-base') return { stdout: `${mergeBase}\n`, stderr: '' };
      if (args[0] === 'rev-list') return { stdout: '2\n', stderr: '' };
      if (args[0] === 'rebase' && args[1] === 'main') return { stdout: '', stderr: '' };
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') return { stdout: `${newTip}\n`, stderr: '' };
      return { stdout: '', stderr: '' };
    });

    const spec = await createWorktree({
      product: 'aura',
      project: '01-growth',
      branch,
      worktreeRoot: WORKTREE_ROOT,
      productsConfigPath: configPath,
      runGit,
    });

    const addCallIndex = runGit.mock.calls.findIndex(c => c[0][0] === 'worktree' && c[0][1] === 'add');
    const rebaseCallIndex = runGit.mock.calls.findIndex(c => c[0][0] === 'rebase' && c[0][1] === 'main');
    expect(addCallIndex).toBeGreaterThanOrEqual(0);
    expect(rebaseCallIndex).toBeGreaterThan(addCallIndex);
    expect(runGit.mock.calls[rebaseCallIndex]![1]?.cwd).toBe(expectedPath);
    expect(spec.resumed).toBe(true);
    expect(spec.baseSha).toBe(newTip);
    expect(spec.baseReconciled).toEqual({
      strategy: 'rebase',
      baseBranch: 'main',
      previousTip,
      newTip,
      baseAheadCount: 2,
    });
  });

  it('RESUMES an existing branch with rebase failure: aborts, removes worktree, and throws a reconciliation error', async () => {
    const configPath = writeProductsJson(tmpDir);
    const previousTip = 'previous0987654321fedcba0987654321fedcba';
    const baseTip = 'basetip0987654321fedcba0987654321fedcba00';
    const mergeBase = 'mergebase987654321fedcba987654321fedcba';
    const branch = 'rune-work/01-growth';
    const expectedPath = join(WORKTREE_ROOT, 'aura', '01-growth');
    const cache = vitestCacheDirFor(expectedPath);
    mkdirSync(cache, { recursive: true });
    const runGit = vi.fn<GitRunner>(async (args: string[]) => {
      if (args[0] === 'show-ref') return { stdout: `${previousTip} refs/heads/${branch}\n`, stderr: '' };
      if (args[0] === 'rev-parse' && args[1] === 'main') return { stdout: `${baseTip}\n`, stderr: '' };
      if (args[0] === 'merge-base') return { stdout: `${mergeBase}\n`, stderr: '' };
      if (args[0] === 'rev-list') return { stdout: '3\n', stderr: '' };
      if (args[0] === 'rebase' && args[1] === 'main') {
        throw Object.assign(new Error('conflict while rebasing'), { stderr: 'CONFLICT (content)' });
      }
      if (args[0] === 'rebase' && args[1] === '--abort') return { stdout: '', stderr: '' };
      if (args[0] === 'worktree' && args[1] === 'remove') return { stdout: '', stderr: '' };
      return { stdout: '', stderr: '' };
    });

    await expect(
      createWorktree({
        product: 'aura',
        project: '01-growth',
        branch,
        worktreeRoot: WORKTREE_ROOT,
        productsConfigPath: configPath,
        runGit,
      }),
    ).rejects.toThrow(/base reconciliation failed.*rune-work\/01-growth.*main.*previous0987654321fedcba0987654321fedcba.*base ahead 3/i);

    const abortCall = runGit.mock.calls.find(c => c[0][0] === 'rebase' && c[0][1] === '--abort');
    expect(abortCall?.[1]?.cwd).toBe(expectedPath);
    const removeCall = runGit.mock.calls.find(c => c[0][0] === 'worktree' && c[0][1] === 'remove');
    expect(removeCall?.[0]).toEqual(['worktree', 'remove', '--force', expectedPath]);
    expect(removeCall?.[1]?.cwd).toBe(FIXTURE_PRODUCTS.aura.repoPath);
    expect(existsSync(cache)).toBe(false);
    expect(runGit.mock.calls.some(c => c[0][0] === 'rev-parse' && c[0][1] === 'HEAD')).toBe(false);
  });

  it('RESUMES an existing branch with base inspection failure: removes the just-created worktree', async () => {
    const configPath = writeProductsJson(tmpDir);
    const previousTip = 'previous0987654321fedcba0987654321fedcba';
    const branch = 'rune-work/01-growth';
    const expectedPath = join(WORKTREE_ROOT, 'aura', '01-growth');
    const runGit = vi.fn<GitRunner>(async (args: string[]) => {
      if (args[0] === 'show-ref') return { stdout: `${previousTip} refs/heads/${branch}\n`, stderr: '' };
      if (args[0] === 'worktree' && args[1] === 'add') return { stdout: '', stderr: '' };
      if (args[0] === 'rev-parse' && args[1] === 'main') {
        throw Object.assign(new Error('unknown revision main'), { stderr: 'fatal: ambiguous argument' });
      }
      if (args[0] === 'worktree' && args[1] === 'remove') return { stdout: '', stderr: '' };
      return { stdout: '', stderr: '' };
    });

    await expect(
      createWorktree({
        product: 'aura',
        project: '01-growth',
        branch,
        worktreeRoot: WORKTREE_ROOT,
        productsConfigPath: configPath,
        runGit,
      }),
    ).rejects.toThrow(/rev-parse main failed/i);

    const removeCall = runGit.mock.calls.find(c => c[0][0] === 'worktree' && c[0][1] === 'remove');
    expect(removeCall?.[0]).toEqual(['worktree', 'remove', '--force', expectedPath]);
    expect(removeCall?.[1]?.cwd).toBe(FIXTURE_PRODUCTS.aura.repoPath);
    expect(runGit.mock.calls.some(c => c[0][0] === 'rebase')).toBe(false);
  });

  it('cuts a FRESH branch (resumed=false) when the requested branch does not exist', async () => {
    const configPath = writeProductsJson(tmpDir);
    const headSha = 'freshhead1234567890abcdef';
    // show-ref rejects (branch absent) → fresh path resolves HEAD and uses -b.
    const runGit = vi.fn<GitRunner>(async (args: string[]) => {
      if (args[0] === 'show-ref') throw Object.assign(new Error('not found'), { stderr: '' });
      if (args.includes('rev-parse')) return { stdout: `${headSha}\n`, stderr: '' };
      return { stdout: '', stderr: '' };
    });

    const spec = await createWorktree({
      product: 'aura',
      project: '01-growth',
      branch: 'rune-work/01-growth',
      worktreeRoot: WORKTREE_ROOT,
      productsConfigPath: configPath,
      runGit,
    });

    const addCall = runGit.mock.calls.find(c => c[0].includes('add'))!;
    expect(addCall[0]).toContain('-b');
    expect(addCall[0][addCall[0].length - 1]).toBe(headSha);
    expect(spec.baseSha).toBe(headSha);
    expect(spec.resumed).toBe(false);
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

  it('throws when the existing path is NOT a registered worktree (the orphan sweep owns it)', async () => {
    const configPath = writeProductsJson(tmpDir);
    // Blanket empty stdout → the registration probe sees no registered
    // worktrees, so the original orphan-dir throw is preserved.
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
    ).rejects.toThrow(/already exists/);

    // Only the registration probe ran — never a worktree add or remove.
    const gitSubcommands = runGit.mock.calls.map((call) => call[0]);
    expect(gitSubcommands.some((args) => args[0] === 'worktree' && args[1] === 'add')).toBe(false);
    expect(gitSubcommands.some((args) => args[0] === 'worktree' && args[1] === 'remove')).toBe(false);
  });

  it('reclaims a clean preserved (registered) worktree: removes it, then proceeds', async () => {
    const configPath = writeProductsJson(tmpDir);
    const worktreeRoot = tmpDir;
    const existingPath = join(worktreeRoot, 'aura', '01-growth');
    mkdirSync(existingPath, { recursive: true });
    const cache = vitestCacheDirFor(existingPath);
    mkdirSync(cache, { recursive: true });

    const runGit = vi.fn<GitRunner>(async (args: string[]) => {
      if (args[0] === 'worktree' && args.includes('--porcelain')) {
        return { stdout: porcelainListing(existingPath), stderr: '' };
      }
      if (args[0] === 'worktree' && args[1] === 'remove') {
        rmSync(existingPath, { recursive: true, force: true });
        return { stdout: '', stderr: '' };
      }
      if (args[0] === 'status') return { stdout: '', stderr: '' }; // clean
      return { stdout: '', stderr: '' };
    });

    const spec = await createWorktree({
      product: 'aura',
      project: '01-growth',
      worktreeRoot,
      productsConfigPath: configPath,
      runGit,
    });

    expect(spec.worktree).toBe(existingPath);
    const gitSubcommands = runGit.mock.calls.map((call) => call[0]);
    const removeIndex = gitSubcommands.findIndex(
      (args) => args[0] === 'worktree' && args[1] === 'remove' && args[2] === '--force' && args[3] === existingPath,
    );
    const addIndex = gitSubcommands.findIndex(
      (args) => args[0] === 'worktree' && args[1] === 'add',
    );
    expect(removeIndex).toBeGreaterThanOrEqual(0);
    expect(addIndex).toBeGreaterThan(removeIndex);
    expect(existsSync(cache)).toBe(false);
  });

  it('refuses to reclaim a dirty preserved worktree and never destroys it', async () => {
    const configPath = writeProductsJson(tmpDir);
    const worktreeRoot = tmpDir;
    const existingPath = join(worktreeRoot, 'aura', '01-growth');
    mkdirSync(existingPath, { recursive: true });

    const runGit = vi.fn<GitRunner>(async (args: string[]) => {
      if (args[0] === 'worktree' && args.includes('--porcelain')) {
        return { stdout: porcelainListing(existingPath), stderr: '' };
      }
      if (args[0] === 'status') return { stdout: ' M src/foo.ts\n', stderr: '' }; // dirty
      return { stdout: '', stderr: '' };
    });

    await expect(
      createWorktree({
        product: 'aura',
        project: '01-growth',
        worktreeRoot,
        productsConfigPath: configPath,
        runGit,
      }),
    ).rejects.toThrow(/uncommitted changes/);

    // Fail-closed: nothing was removed, nothing was added.
    const gitSubcommands = runGit.mock.calls.map((call) => call[0]);
    expect(gitSubcommands.some((args) => args[0] === 'worktree' && args[1] === 'remove')).toBe(false);
    expect(gitSubcommands.some((args) => args[0] === 'worktree' && args[1] === 'add')).toBe(false);
  });
});

describe('createWorktree provisioning integration', () => {
  function realRepoFixture() {
    const root = mkdtempSync(join(tmpdir(), 'rune-worktree-provisioning-'));
    const repo = join(root, 'repo');
    const worktreeRoot = join(root, 'worktrees');
    const projectDir = join(repo, 'docs', 'projects', '01-probe');
    const configPath = join(root, 'products.json');
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, 'spec.md'), '# Spec\n');
    writeFileSync(join(projectDir, 'tasks.md'), '- [ ] Task\n');
    execFileSync('git', ['init', '-b', 'main', repo]);
    execFileSync('git', ['-C', repo, 'config', 'user.email', 'rune-test@example.com']);
    execFileSync('git', ['-C', repo, 'config', 'user.name', 'Rune Test']);
    execFileSync('git', ['-C', repo, 'add', '.']);
    execFileSync('git', ['-C', repo, 'commit', '-m', 'initial']);
    writeFileSync(configPath, JSON.stringify({
      assay: {
        repoPath: repo,
        baseBranch: 'main',
        credentialsFile: '',
        egressAllowlist: [],
      },
    }));
    return { root, repo, worktreeRoot, projectDir, configPath };
  }

  it('creates a real directory registered at the exact path and intended branch', async () => {
    const f = realRepoFixture();
    try {
      const sandbox = await createWorktreeProduction({
        product: 'assay', project: '01-probe', branch: 'rune-work/01-probe',
        worktreeRoot: f.worktreeRoot, productsConfigPath: f.configPath,
      });
      const verified = await verifyWorktreeProvisioning({
        repoPath: f.repo,
        worktree: sandbox.worktree,
        expectedBranch: 'rune-work/01-probe',
        project: '01-probe',
      });
      expect(verified).toEqual({
        ok: true,
        projectDir: join(sandbox.worktree, 'docs', 'projects', '01-probe'),
        specContent: '# Spec\n',
        tasksContent: '- [ ] Task\n',
      });
      expect(execFileSync('git', ['-C', f.repo, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' }))
        .toContain(`worktree ${realpathSync(sandbox.worktree)}`);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it('rolls back a failed postcondition and allows a clean retry', async () => {
    const f = realRepoFixture();
    const target = worktreePathFor('assay', '01-probe', f.worktreeRoot);
    const startPoint = execFileSync('git', ['-C', f.repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    try {
      await expect(createWorktreeProduction({
        product: 'assay', project: '01-probe', branch: 'rune-work/01-probe',
        startPoint,
        worktreeRoot: f.worktreeRoot, productsConfigPath: f.configPath,
        verifyProvisioning: async () => ({
          ok: false,
          stage: 'git-registration',
          cause: new Error('simulated stale registration'),
        }),
      })).rejects.toThrow(/worktree provisioning failed: git-registration.*simulated stale registration/);
      expect(existsSync(target)).toBe(false);
      expect(execFileSync('git', ['-C', f.repo, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' }))
        .not.toContain(`worktree ${realpathSync(f.worktreeRoot)}/assay/01-probe`);
      expect(() => execFileSync('git', ['-C', f.repo, 'show-ref', '--verify', 'refs/heads/rune-work/01-probe']))
        .toThrow();

      const retry = await createWorktreeProduction({
        product: 'assay', project: '01-probe', branch: 'rune-work/01-probe',
        startPoint,
        worktreeRoot: f.worktreeRoot, productsConfigPath: f.configPath,
      });
      expect(retry.worktree).toBe(target);
      expect(existsSync(target)).toBe(true);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it('preserves a replacement directory when a failed add no longer owns its target', async () => {
    const f = realRepoFixture();
    const target = worktreePathFor('assay', '01-probe', f.worktreeRoot);
    const runGit = vi.fn<GitRunner>(async (args) => {
      if (args[0] === 'worktree' && args[1] === 'add') {
        rmSync(target, { recursive: true, force: true });
        mkdirSync(target, { recursive: true });
        writeFileSync(join(target, 'foreign-owner.txt'), 'preserve me');
        throw new Error('simulated add collision');
      }
      return { stdout: '', stderr: '' };
    });
    try {
      await expect(createWorktreeProduction({
        product: 'assay', project: '01-probe', branch: 'rune-work/01-probe',
        startPoint: 'abc1234', worktreeRoot: f.worktreeRoot,
        productsConfigPath: f.configPath, runGit,
      })).rejects.toThrow(/worktree provisioning failed: git-add/);

      expect(readFileSync(join(target, 'foreign-owner.txt'), 'utf8')).toBe('preserve me');
      expect(runGit.mock.calls.some(([args]) => args[0] === 'worktree' && args[1] === 'remove')).toBe(false);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it('rolls back a partial git-add failure, preserves its cause, and allows retry', async () => {
    const f = realRepoFixture();
    const target = worktreePathFor('assay', '01-probe', f.worktreeRoot);
    let failAdd = true;
    const runGit: GitRunner = async (args, opts) => {
      if (args[0] === 'worktree' && args[1] === 'add' && failAdd) {
        failAdd = false;
        mkdirSync(target, { recursive: true });
        throw Object.assign(new Error('simulated git add interruption'), { stderr: 'fatal: interrupted' });
      }
      return defaultRunGit(args, opts);
    };
    try {
      await expect(createWorktreeProduction({
        product: 'assay', project: '01-probe', branch: 'rune-work/01-probe',
        worktreeRoot: f.worktreeRoot, productsConfigPath: f.configPath, runGit,
      })).rejects.toThrow(/worktree provisioning failed: git-add.*simulated git add interruption.*fatal: interrupted/);
      expect(existsSync(target)).toBe(false);

      const retry = await createWorktreeProduction({
        product: 'assay', project: '01-probe', branch: 'rune-work/01-probe',
        worktreeRoot: f.worktreeRoot, productsConfigPath: f.configPath, runGit,
      });
      expect(retry.worktree).toBe(target);
      expect(existsSync(target)).toBe(true);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it.each([
    ['project-directory', 'project', 'missing-project'],
    ['spec-readable', 'spec', '01-probe'],
    ['tasks-readable', 'tasks', '01-probe'],
  ] as const)('reports %s before dispatch inputs can be read', async (stage, missing, project) => {
    const f = realRepoFixture();
    try {
      const sandbox = await createWorktreeProduction({
        product: 'assay', project: '01-probe', branch: 'rune-work/01-probe',
        worktreeRoot: f.worktreeRoot, productsConfigPath: f.configPath,
      });
      if (missing === 'spec') rmSync(join(sandbox.worktree, 'docs', 'projects', '01-probe', 'spec.md'));
      if (missing === 'tasks') rmSync(join(sandbox.worktree, 'docs', 'projects', '01-probe', 'tasks.md'));
      const result = await verifyWorktreeProvisioning({
        repoPath: f.repo, worktree: sandbox.worktree,
        expectedBranch: 'rune-work/01-probe', project,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.stage).toBe(stage);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// linkWorktreeDeps
// ---------------------------------------------------------------------------

describe('linkWorktreeDeps', () => {
  let repo: string;
  let worktree: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'rune-deps-repo-'));
    worktree = mkdtempSync(join(tmpdir(), 'rune-deps-wt-'));
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(worktree, { recursive: true, force: true });
  });

  it('symlinks the repo node_modules into the worktree, resolving to the source', () => {
    mkdirSync(join(repo, 'node_modules', '.bin'), { recursive: true });
    writeFileSync(join(repo, 'node_modules', '.bin', 'vitest'), '#!/bin/sh\n');

    linkWorktreeDeps(repo, worktree);

    const dest = join(worktree, 'node_modules');
    expect(lstatSync(dest).isSymbolicLink()).toBe(true);
    expect(readlinkSync(dest)).toBe(join(repo, 'node_modules'));
    // The runner is reachable through the link.
    expect(existsSync(join(dest, '.bin', 'vitest'))).toBe(true);
  });

  it('no-ops when the repo has no node_modules (never installed)', () => {
    linkWorktreeDeps(repo, worktree);
    expect(existsSync(join(worktree, 'node_modules'))).toBe(false);
  });

  it('leaves an existing worktree node_modules untouched', () => {
    mkdirSync(join(repo, 'node_modules'), { recursive: true });
    mkdirSync(join(worktree, 'node_modules'), { recursive: true });

    linkWorktreeDeps(repo, worktree);

    // Still a real dir, not replaced by a symlink.
    expect(lstatSync(join(worktree, 'node_modules')).isSymbolicLink()).toBe(false);
  });

  it('never throws when the worktree path does not exist', () => {
    mkdirSync(join(repo, 'node_modules'), { recursive: true });
    expect(() => linkWorktreeDeps(repo, join(worktree, 'missing', 'nested'))).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// destroyWorktree
// ---------------------------------------------------------------------------

describe('destroyWorktree', () => {
  const WORKTREE_PATH = '/tmp/rune-worktrees-test/aura/01-growth';

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
    const cache = vitestCacheDirFor(spec.worktree);
    mkdirSync(cache, { recursive: true });

    await destroyWorktree(spec, { productsConfigPath: configPath, runGit });

    expect(runGit).toHaveBeenCalledOnce();
    const [calledArgs, calledOpts] = (runGit as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(calledArgs).toContain('worktree');
    expect(calledArgs).toContain('remove');
    expect(calledArgs).toContain('--force');
    expect(calledArgs).toContain(WORKTREE_PATH);
    expect(calledOpts?.cwd).toBe(FIXTURE_PRODUCTS.aura.repoPath);
    expect(existsSync(cache)).toBe(false);
  });

  it('is idempotent: does not throw when runGit stderr says "not a working tree"', async () => {
    const configPath = writeProductsJson(tmpDir);
    const err = Object.assign(new Error('exit code 128'), {
      stderr: 'fatal: /tmp/some/path is not a working tree',
    });
    const runGit = vi.fn().mockRejectedValue(err);
    const spec = makeSpec();
    const cache = vitestCacheDirFor(spec.worktree);
    mkdirSync(cache, { recursive: true });

    // Must resolve without throwing
    await expect(
      destroyWorktree(spec, { productsConfigPath: configPath, runGit }),
    ).resolves.toBeUndefined();
    expect(existsSync(cache)).toBe(false);
  });

  it('rethrows on failures unrelated to "not a working tree"', async () => {
    const configPath = writeProductsJson(tmpDir);
    const err = Object.assign(new Error('fatal: not a git repository'), {
      stderr: 'fatal: not a git repository',
    });
    const runGit = vi.fn().mockRejectedValue(err);
    const spec = makeSpec();
    const cache = vitestCacheDirFor(spec.worktree);
    mkdirSync(cache, { recursive: true });

    await expect(
      destroyWorktree(spec, { productsConfigPath: configPath, runGit }),
    ).rejects.toThrow(/git repository|worktree/i);
    expect(existsSync(cache)).toBe(true);
    removeVitestCache(spec.worktree);
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
        worktreeRoot: '/tmp/rune-worktrees-test',
        runGit,
      }),
    ).rejects.toThrow(/worktreeRoot|inside/i);

    expect(runGit).not.toHaveBeenCalled();
  });

  it('refuses a sibling that merely shares the worktreeRoot prefix', async () => {
    const configPath = writeProductsJson(tmpDir);
    const runGit = makeRunGit();
    // `/tmp/rune-worktrees-test-evil/...` is NOT inside `/tmp/rune-worktrees-test`.
    const spec = makeSpec({ worktree: '/tmp/rune-worktrees-test-evil/aura/x' });

    await expect(
      destroyWorktree(spec, {
        productsConfigPath: configPath,
        worktreeRoot: '/tmp/rune-worktrees-test',
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
  it('preserves a candidate that becomes Git-registered after the initial snapshot', async () => {
    const configPath = writeProductsJson(tmpDir);
    const worktreeRoot = join(tmpDir, 'worktrees');
    const candidate = join(worktreeRoot, 'aura', 'new-run');
    mkdirSync(candidate, { recursive: true });
    let lists = 0;
    const runGit = vi.fn<GitRunner>(async (args) => {
      if (args.includes('prune')) return { stdout: '', stderr: '' };
      if (args.includes('--porcelain')) {
        lists += 1;
        return {
          stdout: lists === 1 ? '' : porcelainListing(candidate),
          stderr: '',
        };
      }
      return { stdout: '', stderr: '' };
    });

    const removed = await cleanupOrphanWorktrees({ worktreeRoot, productsConfigPath: configPath, runGit });

    expect(removed).not.toContain(candidate);
    expect(existsSync(candidate)).toBe(true);
    expect(lists).toBe(2);
  });

  it('preserves a candidate when a resumable cursor appears after the initial snapshot', async () => {
    const configPath = writeProductsJson(tmpDir);
    const worktreeRoot = join(tmpDir, 'worktrees');
    const candidate = worktreePathFor('aura', 'new-run', worktreeRoot);
    const workRunsDir = join(tmpDir, 'work-runs');
    mkdirSync(candidate, { recursive: true });
    mkdirSync(workRunsDir, { recursive: true });
    let lists = 0;
    const runGit = vi.fn<GitRunner>(async (args) => {
      if (args.includes('prune')) return { stdout: '', stderr: '' };
      if (args.includes('--porcelain')) {
        lists += 1;
        if (lists === 2) {
          const runDir = join(workRunsDir, 'new-run-id');
          mkdirSync(runDir, { recursive: true });
          writeFileSync(join(runDir, 'cursor.json'), JSON.stringify({
            runId: 'new-run-id', product: 'aura', project: 'new-run',
            branch: 'rune-work/new-run', baseBranch: 'main', worktreePath: candidate,
            resumeMarker: 'resumable',
            cursor: { completedTaskIds: [], currentTaskId: null, nextTaskId: 'task-one' },
          }));
        }
        return { stdout: '', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });

    const removed = await cleanupOrphanWorktrees({ worktreeRoot, productsConfigPath: configPath, workRunsDir, runGit });

    expect(removed).not.toContain(candidate);
    expect(existsSync(candidate)).toBe(true);
  });

  it('preserves a candidate when final Git verification fails', async () => {
    const configPath = writeProductsJson(tmpDir);
    const worktreeRoot = join(tmpDir, 'worktrees');
    const candidate = join(worktreeRoot, 'aura', 'uncertain');
    mkdirSync(candidate, { recursive: true });
    let lists = 0;
    const runGit = vi.fn<GitRunner>(async (args) => {
      if (args.includes('prune')) return { stdout: '', stderr: '' };
      if (args.includes('--porcelain') && ++lists === 2) throw new Error('registry unavailable');
      return { stdout: '', stderr: '' };
    });

    expect(await cleanupOrphanWorktrees({ worktreeRoot, productsConfigPath: configPath, runGit })).toEqual([]);
    expect(existsSync(candidate)).toBe(true);
  });

  it('preserves a candidate when final cursor verification fails', async () => {
    const configPath = writeProductsJson(tmpDir);
    const worktreeRoot = join(tmpDir, 'worktrees');
    const candidate = join(worktreeRoot, 'aura', 'uncertain-cursor');
    const workRunsDir = join(tmpDir, 'work-runs');
    mkdirSync(candidate, { recursive: true });
    mkdirSync(join(workRunsDir, 'broken'), { recursive: true });
    let lists = 0;
    const runGit = vi.fn<GitRunner>(async (args) => {
      if (args.includes('prune')) return { stdout: '', stderr: '' };
      if (args.includes('--porcelain') && ++lists === 2) {
        writeFileSync(join(workRunsDir, 'broken', 'cursor.json'), '{');
      }
      return { stdout: '', stderr: '' };
    });

    expect(await cleanupOrphanWorktrees({ worktreeRoot, productsConfigPath: configPath, workRunsDir, runGit })).toEqual([]);
    expect(existsSync(candidate)).toBe(true);
  });
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
    const orphanCache = vitestCacheDirFor(orphanDir);
    mkdirSync(orphanCache, { recursive: true });

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
    expect(existsSync(orphanCache)).toBe(false);
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

  it('preserves an unregistered worktree when a durable orchestrated cursor marks it resumable', async () => {
    const configPath = writeProductsJson(tmpDir);

    const worktreeRoot = join(tmpDir, 'worktrees');
    const resumableDir = worktreePathFor('aura', '14-product-team-agents', worktreeRoot);
    const ordinaryOrphanDir = join(worktreeRoot, 'aura', '99-orphan');
    mkdirSync(resumableDir, { recursive: true });
    mkdirSync(ordinaryOrphanDir, { recursive: true });

    const workRunsDir = join(tmpDir, 'work-runs');
    const runId = 'mut-orch-resume';
    mkdirSync(join(workRunsDir, runId), { recursive: true });
    const cursor = {
      runId,
      product: 'aura',
      project: '14-product-team-agents',
      branch: 'rune-work/14-product-team-agents',
      baseBranch: 'main',
      worktreePath: resumableDir,
      attemptCap: 3,
      resumeMarker: 'resumable',
      cursor: {
        completedTaskIds: ['persist-records-and-cursor'],
        currentTaskId: null,
        nextTaskId: 'resume-boot',
      },
    };
    writeFileSync(join(workRunsDir, runId, 'cursor.json'), JSON.stringify(cursor));

    const runGit = vi.fn().mockImplementation(async (args: string[]) => {
      if (args.includes('prune')) return { stdout: '', stderr: '' };
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
      workRunsDir,
    });

    expect(result).toContain(ordinaryOrphanDir);
    expect(result).not.toContain(resumableDir);
    expect(existsSync(ordinaryOrphanDir)).toBe(false);
    expect(existsSync(resumableDir)).toBe(true);
  });

  it('does not preserve an unregistered worktree when its cursor is not resume-marked', async () => {
    const configPath = writeProductsJson(tmpDir);

    const worktreeRoot = join(tmpDir, 'worktrees');
    const staleDir = worktreePathFor('aura', '14-product-team-agents', worktreeRoot);
    mkdirSync(staleDir, { recursive: true });

    const workRunsDir = join(tmpDir, 'work-runs');
    const runId = 'mut-orch-stale';
    mkdirSync(join(workRunsDir, runId), { recursive: true });
    const cursor = {
      runId,
      product: 'aura',
      project: '14-product-team-agents',
      branch: 'rune-work/14-product-team-agents',
      baseBranch: 'main',
      worktreePath: staleDir,
      attemptCap: 3,
      resumeMarker: 'running',
      cursor: {
        completedTaskIds: ['persist-records-and-cursor'],
        currentTaskId: null,
        nextTaskId: 'resume-boot',
      },
    };
    writeFileSync(join(workRunsDir, runId, 'cursor.json'), JSON.stringify(cursor));

    const runGit = vi.fn().mockImplementation(async (args: string[]) => {
      if (args.includes('prune')) return { stdout: '', stderr: '' };
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
      workRunsDir,
    });

    expect(result).toContain(staleDir);
    expect(existsSync(staleDir)).toBe(false);
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
