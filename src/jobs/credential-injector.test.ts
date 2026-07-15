/**
 * Test suite for `src/jobs/credential-injector.ts` — spawn-time env injection
 * for sandboxed Regime B runs.
 *
 * Written test-first (task A1.2); the implementation file does not exist yet.
 * Every test must fail with a missing-module / missing-export error, not a
 * syntax error. This confirms the "right kind of red" before any implementation.
 *
 * See docs/projects/08-intent-layer/tasks.md — Phase 6 A1 (A1.2).
 *
 * IMPORTANT: No test reads ~/.config/rune/credentials/ or any real on-disk
 * credentials. All credential files are written to mkdtempSync temp dirs and
 * cleaned up in afterEach. vi.stubEnv / vi.unstubAllEnvs manage process.env
 * mutations.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import type { SandboxSpec } from '../intent/sandbox.js';

// ---------------------------------------------------------------------------
// Module under test — does not exist yet; every test must fail at this import.
// ---------------------------------------------------------------------------

import { buildToolchainPath } from '../utils/toolchain-path.js';

import {
  readCredentials,
  getBaseEnv,
  buildSandboxEnv,
  DEFAULT_BASE_ENV_KEYS,
  type BuildSandboxEnvOpts,
} from './credential-injector.js';
import { vitestCacheDirFor } from './sandbox-runtime.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal products.json fixture with two products, each pointing at files
 *  inside a caller-supplied temp dir. */
function writeProductsJson(
  dir: string,
  productACredsFile: string,
  productBCredsFile: string,
): string {
  const contents = {
    aura: {
      repoPath: '/fake/workspace/aura',
      baseBranch: 'main',
      credentialsFile: productACredsFile,
      egressAllowlist: ['github.com', 'registry.npmjs.org'],
    },
    assay: {
      repoPath: '/fake/workspace/assay',
      baseBranch: 'develop',
      credentialsFile: productBCredsFile,
      egressAllowlist: ['github.com'],
    },
  };
  const path = join(dir, 'products.json');
  writeFileSync(path, JSON.stringify(contents, null, 2));
  return path;
}

/** Build a minimal SandboxSpec for a product. */
function makeSandbox(product: string, project = '01-test'): SandboxSpec {
  return {
    product,
    project,
    worktree: `/tmp/rune-worktrees/${product}/${project}`,
    egressAllowlist: ['github.com'],
  };
}

// ---------------------------------------------------------------------------
// Temp dir management
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'rune-cred-injector-test-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
// readCredentials
// ---------------------------------------------------------------------------

describe('readCredentials', () => {
  it('happy path: parses KEY=VALUE pairs from a valid file', () => {
    const file = join(tmpDir, '.env.aura');
    writeFileSync(file, 'FOO=bar\nBAZ=qux\n');

    const result = readCredentials(file);

    expect(result).toEqual({ FOO: 'bar', BAZ: 'qux' });
  });

  it('strips double quotes from values', () => {
    const file = join(tmpDir, '.env.aura');
    writeFileSync(file, 'FOO="hello world"\n');

    const result = readCredentials(file);

    expect(result['FOO']).toBe('hello world');
  });

  it('strips single quotes from values', () => {
    const file = join(tmpDir, '.env.aura');
    writeFileSync(file, "FOO='hello world'\n");

    const result = readCredentials(file);

    expect(result['FOO']).toBe('hello world');
  });

  it('skips comment lines starting with #', () => {
    const file = join(tmpDir, '.env.aura');
    writeFileSync(file, '# comment\nFOO=bar\n');

    const result = readCredentials(file);

    expect(result).toEqual({ FOO: 'bar' });
    expect(result).not.toHaveProperty('#');
  });

  it('skips blank lines without throwing', () => {
    const file = join(tmpDir, '.env.aura');
    writeFileSync(file, '\nFOO=bar\n\n');

    const result = readCredentials(file);

    expect(result).toEqual({ FOO: 'bar' });
  });

  it('treats lines with leading whitespace followed by # as comments', () => {
    const file = join(tmpDir, '.env.aura');
    writeFileSync(file, '  # indented comment\nFOO=bar\n');

    const result = readCredentials(file);

    expect(result).toEqual({ FOO: 'bar' });
    expect(Object.keys(result)).toHaveLength(1);
  });

  it('skips malformed lines (no = separator) without throwing', () => {
    const file = join(tmpDir, '.env.aura');
    writeFileSync(file, 'NOEQUALSSIGN\nFOO=bar\n');

    expect(() => readCredentials(file)).not.toThrow();

    const result = readCredentials(file);
    expect(result).toEqual({ FOO: 'bar' });
    expect(result).not.toHaveProperty('NOEQUALSSIGN');
  });

  it('skips lines with lowercase keys (not matching /^[A-Z_][A-Z0-9_]*$/) without throwing', () => {
    const file = join(tmpDir, '.env.aura');
    writeFileSync(file, 'lowercase_key=value\nFOO=bar\n');

    expect(() => readCredentials(file)).not.toThrow();

    const result = readCredentials(file);
    expect(result).toEqual({ FOO: 'bar' });
    expect(result).not.toHaveProperty('lowercase_key');
  });

  it('returns {} for a missing file (ENOENT) without throwing', () => {
    const missing = join(tmpDir, '.env.nonexistent');

    expect(() => readCredentials(missing)).not.toThrow();

    const result = readCredentials(missing);
    expect(result).toEqual({});
  });

  it('splits on the first = only — values containing = are preserved intact', () => {
    const file = join(tmpDir, '.env.aura');
    writeFileSync(file, 'FOO=a=b=c\n');

    const result = readCredentials(file);

    expect(result['FOO']).toBe('a=b=c');
  });

  it('handles an empty file by returning {}', () => {
    const file = join(tmpDir, '.env.aura');
    writeFileSync(file, '');

    const result = readCredentials(file);

    expect(result).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// getBaseEnv
// ---------------------------------------------------------------------------

describe('getBaseEnv', () => {
  it('routes PATH through buildToolchainPath (launchd-safe toolchain dirs prepended)', () => {
    vi.stubEnv('PATH', '/custom/tools');

    const result = getBaseEnv(['PATH']);

    expect(result['PATH']).toBe(buildToolchainPath('/custom/tools'));
    expect(result['PATH']?.split(':')).toContain(dirname(process.execPath));
  });

  it('returns only the keys from process.env that appear in the allowlist', () => {
    // PATH and HOME are virtually always defined in any Node process
    const result = getBaseEnv(['PATH', 'HOME']);

    for (const key of Object.keys(result)) {
      expect(['PATH', 'HOME']).toContain(key);
    }
  });

  it('omits allowlisted keys that are undefined in process.env', () => {
    // Use a key that almost certainly does not exist in process.env
    const result = getBaseEnv(['__RUNE_TEST_KEY_THAT_DOES_NOT_EXIST__']);

    expect(result).not.toHaveProperty('__RUNE_TEST_KEY_THAT_DOES_NOT_EXIST__');
  });

  it('returns {} for an empty allowlist', () => {
    const result = getBaseEnv([]);

    expect(result).toEqual({});
  });

  it('critical safety: TELEGRAM_BOT_TOKEN is NOT included when not in allowlist', () => {
    vi.stubEnv('TELEGRAM_BOT_TOKEN', 'secret-tg-token');

    // The allowlist contains only safe keys — TELEGRAM_BOT_TOKEN must not leak
    const result = getBaseEnv(['PATH', 'HOME']);

    expect(result).not.toHaveProperty('TELEGRAM_BOT_TOKEN');
    expect(Object.values(result)).not.toContain('secret-tg-token');
  });

  it('returns undefined-free entries only (no key: undefined in output)', () => {
    // Stub a real key and also request one that's definitely absent
    vi.stubEnv('PATH', '/usr/bin:/bin');

    const result = getBaseEnv(['PATH', '__ABSENT_KEY_XYZ__']);

    expect(result).not.toHaveProperty('__ABSENT_KEY_XYZ__');
    // All values in the result must be strings (not undefined)
    for (const value of Object.values(result)) {
      expect(typeof value).toBe('string');
    }
  });
});

// ---------------------------------------------------------------------------
// DEFAULT_BASE_ENV_KEYS
// ---------------------------------------------------------------------------

describe('DEFAULT_BASE_ENV_KEYS', () => {
  it('is a readonly array of string keys', () => {
    expect(Array.isArray(DEFAULT_BASE_ENV_KEYS)).toBe(true);
    expect(DEFAULT_BASE_ENV_KEYS.length).toBeGreaterThan(0);
    for (const key of DEFAULT_BASE_ENV_KEYS) {
      expect(typeof key).toBe('string');
    }
  });

  it('contains PATH, HOME, USER, LANG, LC_ALL, TERM, SHELL, TMPDIR', () => {
    const expected = ['PATH', 'HOME', 'USER', 'LANG', 'LC_ALL', 'TERM', 'SHELL', 'TMPDIR'];
    for (const key of expected) {
      expect(DEFAULT_BASE_ENV_KEYS).toContain(key);
    }
  });

  it('does NOT contain Rune-specific secret keys', () => {
    const forbidden = [
      'TELEGRAM_BOT_TOKEN',
      'READWISE_TOKEN',
      'RUNE_HTTP_SECRET',
      'WHOOP_CLIENT_SECRET',
    ];
    for (const key of forbidden) {
      expect(DEFAULT_BASE_ENV_KEYS).not.toContain(key);
    }
  });
});

// ---------------------------------------------------------------------------
// buildSandboxEnv
// ---------------------------------------------------------------------------

describe('buildSandboxEnv', () => {
  it('forces the worktree-derived Vitest cache over inherited and credential values', () => {
    vi.stubEnv('RUNE_VITEST_CACHE_DIR', '/tmp/inherited-shared-cache');
    const credsFile = join(tmpDir, '.env.aura');
    writeFileSync(credsFile, 'RUNE_VITEST_CACHE_DIR=/tmp/product-shared-cache\n');
    const credsFileB = join(tmpDir, '.env.assay');
    writeFileSync(credsFileB, '');
    const configPath = writeProductsJson(tmpDir, credsFile, credsFileB);
    const sandbox = makeSandbox('aura');

    const result = buildSandboxEnv(sandbox, { productsConfigPath: configPath });

    expect(result['RUNE_VITEST_CACHE_DIR']).toBe(vitestCacheDirFor(sandbox.worktree));
  });

  it('happy path: returns base env merged with product credentials', () => {
    const credsFile = join(tmpDir, '.env.aura');
    writeFileSync(credsFile, 'AURA_API_KEY=my-secret-key\n');

    const credsFileB = join(tmpDir, '.env.assay');
    writeFileSync(credsFileB, 'ASSAY_TOKEN=assay-secret\n');

    const configPath = writeProductsJson(tmpDir, credsFile, credsFileB);
    const sandbox = makeSandbox('aura');

    const result = buildSandboxEnv(sandbox, { productsConfigPath: configPath });

    expect(result).toHaveProperty('AURA_API_KEY', 'my-secret-key');
    // Should also have at least some base env key that's likely to be set
    // (PATH is virtually always present)
  });

  it('reads credentials from the path declared in products.json, not a hard-coded location', () => {
    // Put the credentials file at a custom location inside tmpDir, not ~/.config/
    const customCredsDir = join(tmpDir, 'custom-creds');
    mkdirSync(customCredsDir, { recursive: true });
    const credsFile = join(customCredsDir, 'aura-env');
    writeFileSync(credsFile, 'CUSTOM_KEY=custom-value\n');

    const credsFileB = join(tmpDir, '.env.assay');
    writeFileSync(credsFileB, 'ASSAY_TOKEN=assay-secret\n');

    const configPath = writeProductsJson(tmpDir, credsFile, credsFileB);
    const sandbox = makeSandbox('aura');

    const result = buildSandboxEnv(sandbox, { productsConfigPath: configPath });

    expect(result).toHaveProperty('CUSTOM_KEY', 'custom-value');
  });

  it('throws when the product is not in products.json', () => {
    const credsFileA = join(tmpDir, '.env.aura');
    writeFileSync(credsFileA, 'AURA_KEY=aura-val\n');
    const credsFileB = join(tmpDir, '.env.assay');
    writeFileSync(credsFileB, 'ASSAY_KEY=assay-val\n');

    const configPath = writeProductsJson(tmpDir, credsFileA, credsFileB);
    const sandbox = makeSandbox('relay'); // 'relay' not in products.json

    expect(() => buildSandboxEnv(sandbox, { productsConfigPath: configPath })).toThrow(/relay/i);
  });

  it('credentials shadow base env when both define the same key', () => {
    // If PATH is in both the credentials file and base env, credentials win
    const credsFile = join(tmpDir, '.env.aura');
    writeFileSync(credsFile, 'PATH=/custom/creds/path\n');

    const credsFileB = join(tmpDir, '.env.assay');
    writeFileSync(credsFileB, '');

    const configPath = writeProductsJson(tmpDir, credsFile, credsFileB);
    const sandbox = makeSandbox('aura');

    // Ensure PATH is in process.env so there's something to shadow
    vi.stubEnv('PATH', '/original/path');

    const result = buildSandboxEnv(sandbox, {
      productsConfigPath: configPath,
      baseEnvKeys: ['PATH'],
    });

    // Credentials value must win
    expect(result['PATH']).toBe('/custom/creds/path');
  });

  it('custom baseEnvKeys opt is respected — only those keys from process.env appear', () => {
    vi.stubEnv('HOME', '/home/testuser');

    const credsFile = join(tmpDir, '.env.aura');
    writeFileSync(credsFile, 'AURA_KEY=val\n');
    const credsFileB = join(tmpDir, '.env.assay');
    writeFileSync(credsFileB, '');

    const configPath = writeProductsJson(tmpDir, credsFile, credsFileB);
    const sandbox = makeSandbox('aura');

    const result = buildSandboxEnv(sandbox, {
      productsConfigPath: configPath,
      baseEnvKeys: ['HOME'], // only HOME from process.env
    });

    // HOME must be present (from the custom allowlist)
    expect(result).toHaveProperty('HOME', '/home/testuser');
    // PATH must NOT be present (not in custom baseEnvKeys)
    expect(result).not.toHaveProperty('PATH');
  });

  it('critical safety 1: TELEGRAM_BOT_TOKEN is never present in the returned env', () => {
    vi.stubEnv('TELEGRAM_BOT_TOKEN', 'leaked-tg-secret');

    const credsFile = join(tmpDir, '.env.aura');
    writeFileSync(credsFile, 'AURA_KEY=aura-val\n');
    const credsFileB = join(tmpDir, '.env.assay');
    writeFileSync(credsFileB, '');

    const configPath = writeProductsJson(tmpDir, credsFile, credsFileB);
    const sandbox = makeSandbox('aura');

    const result = buildSandboxEnv(sandbox, { productsConfigPath: configPath });

    expect(result).not.toHaveProperty('TELEGRAM_BOT_TOKEN');
    expect(Object.values(result)).not.toContain('leaked-tg-secret');
  });

  it('critical safety 1b: READWISE_TOKEN is never present in the returned env', () => {
    vi.stubEnv('READWISE_TOKEN', 'leaked-readwise-secret');

    const credsFile = join(tmpDir, '.env.aura');
    writeFileSync(credsFile, 'AURA_KEY=aura-val\n');
    const credsFileB = join(tmpDir, '.env.assay');
    writeFileSync(credsFileB, '');

    const configPath = writeProductsJson(tmpDir, credsFile, credsFileB);
    const sandbox = makeSandbox('aura');

    const result = buildSandboxEnv(sandbox, { productsConfigPath: configPath });

    expect(result).not.toHaveProperty('READWISE_TOKEN');
    expect(Object.values(result)).not.toContain('leaked-readwise-secret');
  });

  it('critical safety 2: credentials from product B are NOT in env built for product A', () => {
    const credsFileA = join(tmpDir, '.env.aura');
    writeFileSync(credsFileA, 'AURA_ONLY_SECRET=aura-secret-val\n');

    const credsFileB = join(tmpDir, '.env.assay');
    writeFileSync(credsFileB, 'ASSAY_ONLY_SECRET=assay-secret-val\n');

    const configPath = writeProductsJson(tmpDir, credsFileA, credsFileB);

    // Build env for product A (aura)
    const sandboxA = makeSandbox('aura');
    const resultA = buildSandboxEnv(sandboxA, { productsConfigPath: configPath });

    // Product B's secret must NOT appear
    expect(resultA).not.toHaveProperty('ASSAY_ONLY_SECRET');
    expect(Object.values(resultA)).not.toContain('assay-secret-val');

    // Product A's secret must appear
    expect(resultA).toHaveProperty('AURA_ONLY_SECRET', 'aura-secret-val');
  });

  it('critical safety 2b: building env for product B does not leak product A secrets', () => {
    const credsFileA = join(tmpDir, '.env.aura');
    writeFileSync(credsFileA, 'AURA_ONLY_SECRET=aura-secret-val\n');

    const credsFileB = join(tmpDir, '.env.assay');
    writeFileSync(credsFileB, 'ASSAY_ONLY_SECRET=assay-secret-val\n');

    const configPath = writeProductsJson(tmpDir, credsFileA, credsFileB);

    // Build env for product B (assay)
    const sandboxB = makeSandbox('assay');
    const resultB = buildSandboxEnv(sandboxB, { productsConfigPath: configPath });

    // Product A's secret must NOT appear
    expect(resultB).not.toHaveProperty('AURA_ONLY_SECRET');
    expect(Object.values(resultB)).not.toContain('aura-secret-val');

    // Product B's secret must appear
    expect(resultB).toHaveProperty('ASSAY_ONLY_SECRET', 'assay-secret-val');
  });

  it('works when the credentials file does not exist (product has no creds wired yet)', () => {
    // assay credentialsFile points at a nonexistent path — must not throw
    const credsFileA = join(tmpDir, '.env.aura');
    writeFileSync(credsFileA, 'AURA_KEY=aura-val\n');

    const nonExistentCredsB = join(tmpDir, '.env.assay-does-not-exist');
    // Deliberately do NOT create this file

    const configPath = writeProductsJson(tmpDir, credsFileA, nonExistentCredsB);
    const sandbox = makeSandbox('assay');

    // Must not throw — missing credentials file is not an error
    expect(() => buildSandboxEnv(sandbox, { productsConfigPath: configPath })).not.toThrow();

    const result = buildSandboxEnv(sandbox, { productsConfigPath: configPath });
    // No credential keys (the file was absent), but the result itself is valid
    expect(result).toBeDefined();
    expect(typeof result).toBe('object');
  });

  it('rejects a hand-constructed SandboxSpec with a malformed product slug', () => {
    // The defensive guard at the buildSandboxEnv boundary catches a slug that
    // would otherwise reach getProductConfig and surface as a less actionable
    // "product not found" error. Realistic threat: a future caller builds a
    // SandboxSpec by hand from external input.
    const configPath = writeProductsJson(
      tmpDir,
      join(tmpDir, '.env.aura'),
      join(tmpDir, '.env.assay'),
    );

    for (const badSlug of ['../etc', '', 'aura/x', 'AURA']) {
      const sandbox = makeSandbox(badSlug);
      expect(() => buildSandboxEnv(sandbox, { productsConfigPath: configPath }))
        .toThrow(/invalid sandbox\.product slug/i);
    }
  });

  it('handles an empty credentialsFile field as explicit no-credentials (no readFileSync)', () => {
    // Distinct from "file declared but missing" (ENOENT) — an empty
    // credentialsFile in products.json means the product has explicitly
    // declared no credentials.
    const credsFileA = join(tmpDir, '.env.aura');
    writeFileSync(credsFileA, 'AURA_KEY=aura-val\n');

    const products = {
      aura: {
        repoPath: '/fake/workspace/aura',
        baseBranch: 'main',
        credentialsFile: credsFileA,
        egressAllowlist: ['github.com'],
      },
      empty: {
        repoPath: '/fake/workspace/empty',
        baseBranch: 'main',
        // credentialsFile omitted on purpose — readProductsConfig coerces to ''
        egressAllowlist: ['github.com'],
      },
    };
    const configPath = join(tmpDir, 'products.json');
    writeFileSync(configPath, JSON.stringify(products));

    const sandbox = makeSandbox('empty');
    const result = buildSandboxEnv(sandbox, { productsConfigPath: configPath });
    // No keys from the (nonexistent) credentials file
    expect(result).not.toHaveProperty('AURA_KEY');
    // Base env still present
    expect(result).toHaveProperty('PATH');
  });
});

// ---------------------------------------------------------------------------
// readCredentials — additional edge cases discovered in review
// ---------------------------------------------------------------------------

describe('readCredentials — edge cases', () => {
  it('preserves a single-character value that IS a bare quote character', () => {
    // `FOO="` (trailing equals plus single quote) must NOT strip to '' — the
    // length-guard ensures `slice(1, -1)` only fires when value has >=2 chars.
    const file = join(tmpDir, '.env');
    writeFileSync(file, 'FOO="\nBAR=\'\n');
    const result = readCredentials(file);
    expect(result['FOO']).toBe('"');
    expect(result['BAR']).toBe("'");
  });

  it('treats `=VALUE` (empty key) as malformed and skips it', () => {
    const file = join(tmpDir, '.env');
    writeFileSync(file, '=orphan\nFOO=bar\n');
    const result = readCredentials(file);
    expect(result).toEqual({ FOO: 'bar' });
  });
});
