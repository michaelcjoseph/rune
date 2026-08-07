import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { mkdtempSync, symlinkSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as attestationModule from './full-suite-attestation.js';

const testedExports = {
  buildGateValidationReceipt: attestationModule.buildGateValidationReceipt,
  captureTrustedVitestImplementation: attestationModule.captureTrustedVitestImplementation,
  captureValidationFingerprints: attestationModule.captureValidationFingerprints,
  compactValidationReceipt: attestationModule.compactValidationReceipt,
  fingerprintValidationEnvironment: attestationModule.fingerprintValidationEnvironment,
  fingerprintValidationToolchain: attestationModule.fingerprintValidationToolchain,
  parseDurableValidationReceipt: attestationModule.parseDurableValidationReceipt,
  parseGateValidationReceipt: attestationModule.parseGateValidationReceipt,
  parseValidationBatchReceipt: attestationModule.parseValidationBatchReceipt,
  parseVitestManifest: attestationModule.parseVitestManifest,
  readAuthenticatedVitestManifest: attestationModule.readAuthenticatedVitestManifest,
  sanitizeValidationCommandIdentifier: attestationModule.sanitizeValidationCommandIdentifier,
  validateFullSuiteAttestation: attestationModule.validateFullSuiteAttestation,
};

function exported<K extends keyof typeof testedExports>(name: K): (typeof testedExports)[K] {
  return testedExports[name];
}

const TREE = 'a'.repeat(40);
const REVIEW_HASH = 'b'.repeat(64);
const COMMAND_FINGERPRINT = 'c'.repeat(64);
const CONFIGURATION_FINGERPRINT = 'd'.repeat(64);
const DEPENDENCY_FINGERPRINT = 'e'.repeat(64);

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    runner: 'vitest',
    completedNormally: true,
    collectionErrors: 0,
    discovered: { suites: 3, tests: 7 },
    completed: {
      suites: 3,
      tests: 7,
      passed: 4,
      failed: 0,
      skipped: 1,
      todo: 2,
      cancelled: 0,
    },
    ...overrides,
  };
}

function attestation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    treeOid: TREE,
    fullTaskReviewHash: REVIEW_HASH,
    validationCwd: '.',
    configuredArgv: [['npm', 'test']],
    adapter: { runner: 'vitest', version: 1 },
    commandFingerprint: COMMAND_FINGERPRINT,
    configurationFingerprint: CONFIGURATION_FINGERPRINT,
    dependencyFingerprint: DEPENDENCY_FINGERPRINT,
    startedAt: '2026-07-30T12:00:00.000Z',
    completedAt: '2026-07-30T12:00:05.000Z',
    durationMs: 5_000,
    execution: {
      outcome: 'passed',
      exitCode: 0,
      timedOut: false,
      cancelled: false,
    },
    coverage: { status: 'complete', manifest: manifest() },
    ...overrides,
  };
}

const expectedIdentity = {
  treeOid: TREE,
  fullTaskReviewHash: REVIEW_HASH,
  validationCwd: '.',
  configuredArgv: [['npm', 'test']],
  commandFingerprint: COMMAND_FINGERPRINT,
  configurationFingerprint: CONFIGURATION_FINGERPRINT,
  dependencyFingerprint: DEPENDENCY_FINGERPRINT,
};

describe('Vitest full-suite lifecycle manifest', () => {
  it('accepts reconciled discovery/completion totals without fixed repository counts', () => {
    const parseVitestManifest = exported('parseVitestManifest');

    expect(parseVitestManifest(manifest())).toEqual(manifest());
    expect(parseVitestManifest(manifest({
      discovered: { suites: 101, tests: 2_003 },
      completed: {
        suites: 101,
        tests: 2_003,
        passed: 2_000,
        failed: 0,
        skipped: 1,
        todo: 2,
        cancelled: 0,
      },
    }))).toBeDefined();
  });

  it.each([
    ['internally inconsistent result buckets', manifest({
      completed: { suites: 3, tests: 7, passed: 7, failed: 1, skipped: 0, todo: 0, cancelled: 0 },
    })],
    ['malformed count', manifest({ discovered: { suites: 3, tests: -1 } })],
    ['unbounded raw test data', { ...manifest(), tests: Array.from({ length: 10_000 }, (_, i) => `secret test ${i}`) }],
  ])('rejects malformed or unbounded %s', (_label, candidate) => {
    const parseVitestManifest = exported('parseVitestManifest');
    expect(parseVitestManifest(candidate)).toBeUndefined();
  });

  it.each([
    ['failed', manifest({
      completed: {
        suites: 3, tests: 7, passed: 3, failed: 1, skipped: 1, todo: 2, cancelled: 0,
      },
    })],
    ['interrupted', manifest({ completedNormally: false })],
    ['collection-error', manifest({ collectionErrors: 1 })],
    ['partial', manifest({
      completed: { suites: 2, tests: 6, passed: 6, failed: 0, skipped: 0, todo: 0, cancelled: 0 },
    })],
    ['cancelled', manifest({
      completed: { suites: 3, tests: 7, passed: 6, failed: 0, skipped: 0, todo: 0, cancelled: 1 },
    })],
  ])('preserves a structurally valid %s lifecycle as bounded non-green evidence', (_label, candidate) => {
    const parseVitestManifest = exported('parseVitestManifest');
    expect(parseVitestManifest(candidate)).toEqual(candidate);
  });
});

describe('trusted validation implementation fingerprints', () => {
  it('changes when the secret-free config extractor changes', () => {
    const capture = exported('captureValidationFingerprints');
    const captureImplementation = exported('captureTrustedVitestImplementation');
    const dir = mkdtempSync(join(tmpdir(), 'rune-attestation-fingerprint-'));
    try {
      const reporter = join(dir, 'reporter.mjs');
      const observer = join(dir, 'observer.mjs');
      const extractor = join(dir, 'extractor.mjs');
      writeFileSync(reporter, 'export default class Reporter {};\n');
      writeFileSync(observer, 'export const observer = 1;\n');
      writeFileSync(extractor, 'export const extractor = 1;\n');
      const paths = {
        reporterPath: reporter,
        observerPath: observer,
        extractorPath: extractor,
      };
      const first = capture(
        dir,
        ['npm test'],
        [{ command: 'npm test', runner: 'vitest' }],
        captureImplementation(paths),
      );
      writeFileSync(extractor, 'export const extractor = 2;\n');
      const second = capture(
        dir,
        ['npm test'],
        [{ command: 'npm test', runner: 'vitest' }],
        captureImplementation(paths),
      );

      expect(second.commandFingerprint).not.toBe(first.commandFingerprint);
      expect(second.configurationFingerprint).toBe(first.configurationFingerprint);
      expect(second.dependencyFingerprint).toBe(first.dependencyFingerprint);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('canonical full-suite attestation identity', () => {
  it('accepts only exact tree, review hash, cwd, argv and fingerprint matches', () => {
    const validate = exported('validateFullSuiteAttestation');
    expect(validate(attestation(), expectedIdentity)).toEqual({
      ok: true,
      attestation: attestation(),
    });
  });

  it.each([
    ['tree', { treeOid: 'c'.repeat(40) }],
    ['full-task review hash', { fullTaskReviewHash: 'c'.repeat(64) }],
    ['cwd', { validationCwd: 'packages/rune' }],
    ['argv', { configuredArgv: [['npm', 'test', '--', 'one.test.ts']] }],
    ['command fingerprint', { commandFingerprint: 'f'.repeat(64) }],
    ['configuration fingerprint', { configurationFingerprint: 'f'.repeat(64) }],
    ['dependency fingerprint', { dependencyFingerprint: 'f'.repeat(64) }],
  ])('rejects a stale %s identity', (_label, expectedOverride) => {
    const validate = exported('validateFullSuiteAttestation');
    const result = validate(attestation(), {
      ...expectedIdentity,
      ...expectedOverride,
    });
    expect(result).toMatchObject({ ok: false });
  });

  it.each([
    ['timed out', { execution: { outcome: 'failed', exitCode: null, timedOut: true, cancelled: false } }],
    ['cancelled', { execution: { outcome: 'cancelled', exitCode: null, timedOut: false, cancelled: true } }],
    ['nonzero', { execution: { outcome: 'failed', exitCode: 1, timedOut: false, cancelled: false } }],
    ['wrong cwd', { validationCwd: '/Users/operator/private/rune' }],
    ['partial manifest', {
      coverage: {
        status: 'complete',
        manifest: manifest({
          discovered: { suites: 3, tests: 7 },
          completed: { suites: 2, tests: 6, passed: 6, failed: 0, skipped: 0, todo: 0, cancelled: 0 },
        }),
      },
    }],
    ['interrupted manifest', {
      coverage: { status: 'complete', manifest: manifest({ completedNormally: false }) },
    }],
    ['collection error', {
      coverage: { status: 'complete', manifest: manifest({ collectionErrors: 1 }) },
    }],
    ['cancelled manifest', {
      coverage: {
        status: 'complete',
        manifest: manifest({
          completed: { suites: 3, tests: 7, passed: 6, failed: 0, skipped: 0, todo: 0, cancelled: 1 },
        }),
      },
    }],
  ])('rejects %s evidence', (_label, override) => {
    const validate = exported('validateFullSuiteAttestation');
    expect(validate(attestation(override), expectedIdentity)).toMatchObject({ ok: false });
  });

  it('records an unsupported command as executed without upgrading it to canonical coverage', () => {
    const validate = exported('validateFullSuiteAttestation');
    const unsupported = attestation({
      configuredArgv: [['npm', 'run', 'build']],
      adapter: { runner: 'unsupported', version: 1 },
      coverage: { status: 'unsupported' },
    });
    const result = validate(unsupported, {
      ...expectedIdentity,
      configuredArgv: [['npm', 'run', 'build']],
    });

    expect(result).toMatchObject({
      ok: true,
      attestation: {
        execution: { outcome: 'passed' },
        coverage: { status: 'unsupported' },
      },
    });
    expect(JSON.stringify(result)).not.toContain('"status":"complete"');
  });

  it('rejects raw output, environment, absolute paths, and oversized arrays at the durable boundary', () => {
    const validate = exported('validateFullSuiteAttestation');
    for (const unsafe of [
      attestation({ output: 'TELEGRAM_BOT_TOKEN=secret' }),
      attestation({ environment: { TELEGRAM_BOT_TOKEN: 'secret' } }),
      attestation({ reporterPath: '/Users/operator/workspace/rune/scripts/reporter.ts' }),
      attestation({ configuredArgv: [['node', '--config=/opt/operator/vitest.config.ts']] }),
      attestation({ configuredArgv: [['node', 'file:///Users/operator/private/test.mjs']] }),
      attestation({ configuredArgv: [['node', 'file:/Users/operator/private/test.mjs']] }),
      attestation({ configuredArgv: [['node', 'file://localhost/Users/operator/private/test.mjs']] }),
      attestation({ configuredArgv: [['node', '--token=supersecret']] }),
      attestation({ configuredArgv: [['node', '--auth', 'supersecret']] }),
      attestation({ configuredArgv: [['node', '--key=supersecret']] }),
      attestation({ commandFingerprint: 'not-a-sha256' }),
      attestation({ configuredArgv: Array.from({ length: 500 }, () => ['npm', 'test']) }),
    ]) {
      expect(validate(unsafe, expectedIdentity)).toMatchObject({ ok: false });
    }
  });

  it('rejects an internally inconsistent durable receipt', () => {
    const parse = exported('parseDurableValidationReceipt');
    expect(parse({
      provenance: 'full-suite-reused',
      command: 'npm test',
      treeOid: TREE,
      outcome: 'passed',
      coverage: 'complete',
      discovered: { suites: 3, tests: 7 },
      completed: {
        suites: 3,
        tests: 7,
        passed: 7,
        failed: 1,
        skipped: 0,
        todo: 0,
        cancelled: 0,
      },
    })).toBeUndefined();
    expect(parse({
      provenance: 'full-suite-reused',
      command: 'npm test',
      treeOid: TREE,
      outcome: 'passed',
      coverage: 'complete',
      discovered: { suites: 3, tests: 7 },
      completed: {
        suites: 3,
        tests: 7,
        passed: 6,
        failed: 1,
        skipped: 0,
        todo: 0,
        cancelled: 0,
      },
    })).toBeUndefined();
    expect(parse({
      provenance: 'related-ran',
      command: 'npx vitest --config=/Users/operator/private/vitest.config.ts',
      treeOid: TREE,
      outcome: 'passed',
      coverage: 'unsupported',
    })).toBeUndefined();
    expect(parse({
      provenance: 'related-ran',
      command: 'node file:///Users/operator/private/test.mjs',
      treeOid: TREE,
      outcome: 'passed',
      coverage: 'unsupported',
    })).toBeUndefined();
    expect(parse({
      provenance: 'related-ran',
      command: 'npx vitest related',
      treeOid: TREE,
      outcome: 'passed',
      coverage: 'complete',
      discovered: { suites: 1, tests: 1 },
      completed: {
        suites: 1,
        tests: 1,
        passed: 1,
        failed: 0,
        skipped: 0,
        todo: 0,
        cancelled: 0,
      },
    })).toBeUndefined();
  });
});

describe('trusted manifest authentication', () => {
  it('rejects a product-forged or post-reporter replacement manifest', () => {
    const read = exported('readAuthenticatedVitestManifest');
    const dir = mkdtempSync(join(tmpdir(), 'rune-attestation-auth-'));
    const path = join(dir, 'manifest.json');
    const capability = '1'.repeat(64);
    try {
      const validManifest = manifest();
      const authentication = createHmac('sha256', capability)
        .update(JSON.stringify(validManifest))
        .digest('hex');
      writeFileSync(path, JSON.stringify({ manifest: validManifest, authentication }));
      expect(read(path, capability)).toEqual(validManifest);

      const forged = manifest({
        discovered: { suites: 999, tests: 999 },
        completed: {
          suites: 999,
          tests: 999,
          passed: 999,
          failed: 0,
          skipped: 0,
          todo: 0,
          cancelled: 0,
        },
      });
      writeFileSync(path, JSON.stringify({ manifest: forged, authentication }));
      expect(read(path, capability)).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects missing, malformed, truncated, oversized, and symlinked evidence', () => {
    const read = exported('readAuthenticatedVitestManifest');
    const dir = mkdtempSync(join(tmpdir(), 'rune-attestation-bounded-'));
    const capability = '2'.repeat(64);
    try {
      const missing = join(dir, 'missing.json');
      const malformed = join(dir, 'malformed.json');
      const truncated = join(dir, 'truncated.json');
      const oversized = join(dir, 'oversized.json');
      const target = join(dir, 'target.json');
      const symlink = join(dir, 'symlink.json');
      writeFileSync(malformed, '{not json');
      writeFileSync(truncated, '{"manifest":');
      writeFileSync(oversized, Buffer.alloc(64 * 1024 + 1, 0x61));
      writeFileSync(target, JSON.stringify({ manifest: manifest(), authentication: '0'.repeat(64) }));
      symlinkSync(target, symlink);

      for (const path of [missing, malformed, truncated, oversized, symlink]) {
        expect(read(path, capability)).toBeUndefined();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('compact validation receipt', () => {
  it('projects sanitized command identifiers without paths or secret values', () => {
    const sanitize = exported('sanitizeValidationCommandIdentifier');
    expect(sanitize(['node', '--token', 'supersecret', 'file:///Users/operator/test.mjs']))
      .toBe('node --token <redacted> <path>');
    expect(sanitize(['tool', '--auth', 'hunter2', 'file://localhost/Users/operator/x']))
      .toBe('tool --auth <redacted> <path>');
  });

  it('admits a merge-gate receipt only when canonical identity survives', () => {
    const parse = exported('parseGateValidationReceipt');
    const receipt = {
      version: 1,
      treeOid: TREE,
      fullTaskReviewHash: REVIEW_HASH,
      completedAt: '2026-07-30T12:00:05.000Z',
      commandFingerprint: COMMAND_FINGERPRINT,
      configurationFingerprint: CONFIGURATION_FINGERPRINT,
      dependencyFingerprint: DEPENDENCY_FINGERPRINT,
      outcome: 'passed',
      commands: [{
        command: 'npm test',
        outcome: 'passed',
        coverage: 'unsupported',
      }],
    };
    expect(parse(receipt)).toEqual(receipt);
    const { treeOid: _treeOid, ...identityFree } = receipt;
    expect(parse(identityFree)).toBeUndefined();
  });

  it('projects only bounded command/tree/count/outcome facts', () => {
    const compact = exported('compactValidationReceipt');
    const receipt = compact(attestation() as unknown as Parameters<typeof compact>[0]);
    const serialized = JSON.stringify(receipt);

    expect(receipt).toMatchObject({
      command: 'npm test',
      treeOid: TREE,
      outcome: 'passed',
      coverage: 'complete',
      discovered: { suites: 3, tests: 7 },
      completed: {
        suites: 3,
        tests: 7,
        passed: 4,
        failed: 0,
        skipped: 1,
        todo: 2,
        cancelled: 0,
      },
    });
    expect(serialized).not.toContain('/Users/');
    expect(serialized).not.toContain('TELEGRAM_BOT_TOKEN');
    expect(serialized).not.toContain('secret test');
    expect(serialized.length).toBeLessThan(2_000);
  });

  it('rejects contradictory validation batch receipts at restart boundaries', () => {
    const parse = exported('parseValidationBatchReceipt');
    for (const candidate of [
      { outcome: 'passed', commands: [] },
      {
        outcome: 'passed',
        commands: [{ command: 'npm test', outcome: 'failed', coverage: 'unsupported' }],
      },
      {
        outcome: 'passed',
        commands: [{ command: 'npm test', outcome: 'passed', coverage: 'complete' }],
      },
      {
        outcome: 'passed',
        commands: [{
          command: 'npm test',
          outcome: 'passed',
          coverage: 'complete',
          discovered: { suites: 1, tests: 2 },
          completed: {
            suites: 1,
            tests: 2,
            passed: 1,
            failed: 1,
            skipped: 0,
            todo: 0,
            cancelled: 0,
          },
        }],
      },
    ]) {
      expect(parse(candidate)).toBeUndefined();
    }
    expect(parse({ outcome: 'drifted', commands: [] })).toEqual({
      outcome: 'drifted',
      commands: [],
    });
  });
});

describe('validation environment and toolchain fingerprints (V3 identity)', () => {
  it('fingerprints only sorted env entries, ignoring key order and dropping undefined values', () => {
    const fingerprint = exported('fingerprintValidationEnvironment');
    const withUndefinedExtra = fingerprint({
      PATH: '/usr/bin',
      LANG: 'en_US.UTF-8',
      MISSING: undefined,
    });
    const reorderedNoExtra = fingerprint({ LANG: 'en_US.UTF-8', PATH: '/usr/bin' });
    expect(withUndefinedExtra).toBe(reorderedNoExtra);
    expect(withUndefinedExtra).toMatch(/^[0-9a-f]{64}$/);

    const changedValue = fingerprint({ LANG: 'en_US.UTF-8', PATH: '/usr/local/bin' });
    expect(changedValue).not.toBe(withUndefinedExtra);
  });

  it('fingerprints the resolved executable\'s bytes and mtime, not just its name', () => {
    const fingerprintToolchain = exported('fingerprintValidationToolchain');
    const dir = mkdtempSync(join(tmpdir(), 'rune-toolchain-fingerprint-'));
    try {
      const tool = join(dir, 'faketool');
      writeFileSync(tool, '#!/bin/sh\necho one\n');
      const env = { PATH: dir };

      const first = fingerprintToolchain(['faketool --flag'], env);
      expect(first).toMatch(/^[0-9a-f]{64}$/);
      // Deterministic for identical, unchanged input.
      expect(fingerprintToolchain(['faketool --flag'], env)).toBe(first);

      writeFileSync(tool, '#!/bin/sh\necho two\n');
      const second = fingerprintToolchain(['faketool --flag'], env);
      expect(second).not.toBe(first);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fingerprints a tool missing from PATH deterministically, as distinct evidence from a resolved one', () => {
    const fingerprintToolchain = exported('fingerprintValidationToolchain');
    const dir = mkdtempSync(join(tmpdir(), 'rune-toolchain-missing-'));
    try {
      const missing = fingerprintToolchain(['nonexistent-tool --flag'], { PATH: dir });
      const missingAgain = fingerprintToolchain(['nonexistent-tool --flag'], { PATH: dir });
      expect(missing).toBe(missingAgain);
      expect(missing).toMatch(/^[0-9a-f]{64}$/);

      writeFileSync(join(dir, 'nonexistent-tool'), '#!/bin/sh\necho present\n');
      const nowPresent = fingerprintToolchain(['nonexistent-tool --flag'], { PATH: dir });
      expect(nowPresent).not.toBe(missing);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a malformed configured validation command rather than silently skipping it', () => {
    const fingerprintToolchain = exported('fingerprintValidationToolchain');
    expect(() => fingerprintToolchain(['; rm -rf /'], { PATH: '/usr/bin' })).toThrow(
      /malformed validation command/,
    );
  });
});

describe('buildGateValidationReceipt — V3 canonical receipt identity', () => {
  const fingerprints = {
    commandFingerprint: COMMAND_FINGERPRINT,
    configurationFingerprint: CONFIGURATION_FINGERPRINT,
    dependencyFingerprint: DEPENDENCY_FINGERPRINT,
    environmentFingerprint: '8'.repeat(64),
    toolchainFingerprint: '9'.repeat(64),
  };
  const profilePlan = {
    version: 1 as const,
    shards: [{ command: 'npm test', argv: ['npm', 'test'], profile: 'isolated' as const }],
    definitionFingerprint: '2'.repeat(64),
  };
  const profileOutcomes = [{
    profile: 'isolated' as const,
    outcome: 'passed' as const,
    probe: {
      profile: 'isolated' as const,
      definitionFingerprint: '2'.repeat(64),
      confinementOwner: 'validation-launcher' as const,
      outcome: 'passed' as const,
      startedAt: '2026-07-30T12:00:00.000Z',
      completedAt: '2026-07-30T12:00:01.000Z',
    },
  }];

  it('stamps a canonical receiptId on a profiled receipt that round-trips through the strict parser', () => {
    const build = exported('buildGateValidationReceipt');
    const parse = exported('parseGateValidationReceipt');
    const receipt = build({
      treeOid: TREE,
      fullTaskReviewHash: REVIEW_HASH,
      completedAt: '2026-07-30T12:00:05.000Z',
      fingerprints,
      batch: {
        outcome: 'passed',
        commands: [{ command: 'npm test', outcome: 'passed', coverage: 'unsupported' }],
        profilePlan,
        profileOutcomes,
      },
    });
    expect(receipt).toMatchObject({ version: 3, receiptId: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(parse(receipt)).toEqual(receipt);
  });

  // Documents the currently intended V1 fallback contract: a batch with no
  // profile plan (`profilePlan === undefined`) should still stamp a valid
  // version-1 receipt. `captureValidationFingerprints` now unconditionally
  // returns `environmentFingerprint`/`toolchainFingerprint`, and the V1/V2
  // branch of `parseGateValidationReceipt` fail-closed rejects a receipt
  // carrying those fields — so this candidate is built with a version the
  // parser can never admit, and `buildGateValidationReceipt` silently returns
  // `undefined` instead of a valid legacy receipt.
  it('still stamps a valid legacy receipt for a batch with no profile plan', () => {
    const build = exported('buildGateValidationReceipt');
    const receipt = build({
      treeOid: TREE,
      fullTaskReviewHash: REVIEW_HASH,
      completedAt: '2026-07-30T12:00:05.000Z',
      fingerprints,
      batch: {
        outcome: 'passed',
        commands: [{ command: 'npm test', outcome: 'passed', coverage: 'unsupported' }],
      },
    });
    expect(receipt).toMatchObject({ version: 1 });
    expect(receipt).not.toHaveProperty('receiptId');
  });
});
