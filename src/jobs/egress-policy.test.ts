/**
 * Test suite for `src/jobs/egress-policy.ts` — the thin policy-wrapper module
 * that the future egress proxy will consult internally, plus audit-log telemetry
 * for denied egress attempts.
 *
 * Written test-first (task A1.3 of docs/projects/08-intent-layer/tasks.md).
 * The implementation file does not exist yet — every test must fail with a
 * missing-module / missing-export error, confirming "the right kind of red"
 * before implementation begins.
 *
 * See docs/projects/08-intent-layer/{spec.md (§"Layer 4"), test-plan.md §11}.
 *
 * IMPORTANT: No test reads the real `policies/products.json`. Each test writes
 * its own fixture into a mkdtempSync temp dir. Denial-log files also land in
 * the temp dir and are cleaned up in afterEach via rmSync.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { SandboxSpec } from '../intent/sandbox.js';

// ---------------------------------------------------------------------------
// Module under test — does not exist yet; every test must fail at this import.
// ---------------------------------------------------------------------------

import {
  EGRESS_ENFORCEMENT_MODE,
  checkEgress,
  appendEgressDenialLog,
} from './egress-policy.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Products fixture with two products, one with a non-empty allowlist and one
 *  with an empty allowlist. Tests write this to their temp dir. */
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
    egressAllowlist: [],
  },
};

/** Write a products.json fixture to `dir` and return the full path. */
function writeProductsJson(dir: string, contents: object = FIXTURE_PRODUCTS): string {
  const path = join(dir, 'products.json');
  writeFileSync(path, JSON.stringify(contents, null, 2));
  return path;
}

/** Build a minimal SandboxSpec for the given product. The egressAllowlist here
 *  is intentionally NOT used by checkEgress — it always re-reads from
 *  products.json. It is present only to satisfy the SandboxSpec shape. */
function makeSandbox(product: string, project = '01-test'): SandboxSpec {
  return {
    product,
    project,
    worktree: `/tmp/rune-worktrees/${product}/${project}`,
    egressAllowlist: [], // checkEgress reads from productsConfigPath, not this field
  };
}

/** Parse every non-empty line in the denial log as JSON and return the array. */
function readDenialLog(logPath: string): Array<Record<string, unknown>> {
  const raw = readFileSync(logPath, 'utf8');
  return raw
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

// ---------------------------------------------------------------------------
// Temp dir management
// ---------------------------------------------------------------------------

let tmpDir: string;
let denialLogPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'rune-egress-policy-test-'));
  denialLogPath = join(tmpDir, 'egress-denials.jsonl');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// EGRESS_ENFORCEMENT_MODE
// ---------------------------------------------------------------------------

describe('EGRESS_ENFORCEMENT_MODE', () => {
  it('is the string "documented-gap" (today\'s mode)', () => {
    // This locks in the current mode. When enforcement is wired, this changes
    // to "proxy-enforced" and the test serves as the update prompt.
    expect(EGRESS_ENFORCEMENT_MODE).toBe('documented-gap');
  });
});

// ---------------------------------------------------------------------------
// checkEgress
// ---------------------------------------------------------------------------

describe('checkEgress', () => {
  describe('allowlisted host', () => {
    it('returns { allowed: true, mode: "documented-gap" }', () => {
      const configPath = writeProductsJson(tmpDir);
      const sandbox = makeSandbox('aura');

      const result = checkEgress(sandbox, 'github.com', {
        productsConfigPath: configPath,
        denialLogPath,
      });

      expect(result.allowed).toBe(true);
      expect(result.mode).toBe('documented-gap');
    });

    it('does NOT write to the denial log when the host is allowed', () => {
      const configPath = writeProductsJson(tmpDir);
      const sandbox = makeSandbox('aura');

      checkEgress(sandbox, 'github.com', {
        productsConfigPath: configPath,
        denialLogPath,
      });

      // The log file should not exist (or be empty if pre-created) — no denial
      // was recorded.
      let logExists = false;
      try {
        const content = readFileSync(denialLogPath, 'utf8');
        logExists = content.trim().length > 0;
      } catch {
        logExists = false;
      }
      expect(logExists).toBe(false);
    });

    it('second allowlisted host in the same product is also allowed', () => {
      const configPath = writeProductsJson(tmpDir);
      const sandbox = makeSandbox('aura');

      const result = checkEgress(sandbox, 'registry.npmjs.org', {
        productsConfigPath: configPath,
        denialLogPath,
      });

      expect(result.allowed).toBe(true);
    });
  });

  describe('non-allowlisted host', () => {
    it('returns { allowed: false, mode: "documented-gap" }', () => {
      const configPath = writeProductsJson(tmpDir);
      const sandbox = makeSandbox('aura');

      const result = checkEgress(sandbox, 'attacker.example.com', {
        productsConfigPath: configPath,
        denialLogPath,
      });

      expect(result.allowed).toBe(false);
      expect(result.mode).toBe('documented-gap');
    });

    it('appends one JSON line to opts.denialLogPath on denial', () => {
      const configPath = writeProductsJson(tmpDir);
      const sandbox = makeSandbox('aura');

      checkEgress(sandbox, 'attacker.example.com', {
        productsConfigPath: configPath,
        denialLogPath,
      });

      const lines = readDenialLog(denialLogPath);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({
        product: 'aura',
        project: '01-test',
        host: 'attacker.example.com',
      });
    });

    it('denial log entry has a ts field that looks like an ISO-8601 timestamp', () => {
      const configPath = writeProductsJson(tmpDir);
      const sandbox = makeSandbox('aura');

      checkEgress(sandbox, 'attacker.example.com', {
        productsConfigPath: configPath,
        denialLogPath,
      });

      const lines = readDenialLog(denialLogPath);
      const ts = lines[0]!['ts'] as string;
      expect(typeof ts).toBe('string');
      // ISO-8601: starts with a year and contains a T separator
      expect(ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
  });

  describe('subdomain of an allowlisted host', () => {
    it('denies evil.github.com when allowlist contains github.com (exact match only)', () => {
      const configPath = writeProductsJson(tmpDir);
      const sandbox = makeSandbox('aura');

      const result = checkEgress(sandbox, 'evil.github.com', {
        productsConfigPath: configPath,
        denialLogPath,
      });

      expect(result.allowed).toBe(false);
    });

    it('logs the denial for a subdomain of an allowlisted host', () => {
      const configPath = writeProductsJson(tmpDir);
      const sandbox = makeSandbox('aura');

      checkEgress(sandbox, 'evil.github.com', {
        productsConfigPath: configPath,
        denialLogPath,
      });

      const lines = readDenialLog(denialLogPath);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({ host: 'evil.github.com' });
    });
  });

  describe('case-fold rule (RFC 4343)', () => {
    it('allows "GitHub.COM" against an allowlist entry of "github.com"', () => {
      const configPath = writeProductsJson(tmpDir);
      const sandbox = makeSandbox('aura');

      // isEgressAllowed normalizes case — this must be allowed, not denied.
      const result = checkEgress(sandbox, 'GitHub.COM', {
        productsConfigPath: configPath,
        denialLogPath,
      });

      expect(result.allowed).toBe(true);
    });

    it('does NOT write to the denial log when the case-folded host matches', () => {
      const configPath = writeProductsJson(tmpDir);
      const sandbox = makeSandbox('aura');

      checkEgress(sandbox, 'GitHub.COM', {
        productsConfigPath: configPath,
        denialLogPath,
      });

      let logExists = false;
      try {
        const content = readFileSync(denialLogPath, 'utf8');
        logExists = content.trim().length > 0;
      } catch {
        logExists = false;
      }
      expect(logExists).toBe(false);
    });
  });

  describe('empty allowlist', () => {
    it('denies all hosts when the product allowlist is empty', () => {
      const configPath = writeProductsJson(tmpDir);
      // assay has egressAllowlist: [] in the fixture
      const sandbox = makeSandbox('assay');

      const result = checkEgress(sandbox, 'github.com', {
        productsConfigPath: configPath,
        denialLogPath,
      });

      expect(result.allowed).toBe(false);
    });

    it('logs the denial when the allowlist is empty', () => {
      const configPath = writeProductsJson(tmpDir);
      const sandbox = makeSandbox('assay');

      checkEgress(sandbox, 'github.com', {
        productsConfigPath: configPath,
        denialLogPath,
      });

      const lines = readDenialLog(denialLogPath);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({ product: 'assay', host: 'github.com' });
    });
  });

  describe('multiple calls accumulate in the log', () => {
    it('two denied calls produce two lines in the log', () => {
      const configPath = writeProductsJson(tmpDir);
      const sandbox = makeSandbox('aura');

      checkEgress(sandbox, 'evil1.example.com', {
        productsConfigPath: configPath,
        denialLogPath,
      });
      checkEgress(sandbox, 'evil2.example.com', {
        productsConfigPath: configPath,
        denialLogPath,
      });

      const lines = readDenialLog(denialLogPath);
      expect(lines).toHaveLength(2);
      expect(lines[0]).toMatchObject({ host: 'evil1.example.com' });
      expect(lines[1]).toMatchObject({ host: 'evil2.example.com' });
    });

    it('an allowed call sandwiched between two denied calls produces only two lines', () => {
      const configPath = writeProductsJson(tmpDir);
      const sandbox = makeSandbox('aura');

      checkEgress(sandbox, 'evil1.example.com', {
        productsConfigPath: configPath,
        denialLogPath,
      });
      // This one is allowed — must not appear in the log
      checkEgress(sandbox, 'github.com', {
        productsConfigPath: configPath,
        denialLogPath,
      });
      checkEgress(sandbox, 'evil2.example.com', {
        productsConfigPath: configPath,
        denialLogPath,
      });

      const lines = readDenialLog(denialLogPath);
      expect(lines).toHaveLength(2);
    });
  });
});

// ---------------------------------------------------------------------------
// appendEgressDenialLog
// ---------------------------------------------------------------------------

describe('appendEgressDenialLog', () => {
  it('writes one JSON line containing ts, product, project, and host', () => {
    const sandbox = makeSandbox('aura', '02-billing');

    appendEgressDenialLog(sandbox, 'evil.example.com', denialLogPath);

    const lines = readDenialLog(denialLogPath);
    expect(lines).toHaveLength(1);

    const entry = lines[0]!;
    expect(entry).toHaveProperty('ts');
    expect(entry).toHaveProperty('product', 'aura');
    expect(entry).toHaveProperty('project', '02-billing');
    expect(entry).toHaveProperty('host', 'evil.example.com');
  });

  it('ts field is an ISO-8601 string', () => {
    const sandbox = makeSandbox('aura');

    appendEgressDenialLog(sandbox, 'evil.example.com', denialLogPath);

    const lines = readDenialLog(denialLogPath);
    const ts = lines[0]!['ts'] as string;
    expect(typeof ts).toBe('string');
    expect(ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('two calls produce two separate lines', () => {
    const sandbox = makeSandbox('aura');

    appendEgressDenialLog(sandbox, 'first.example.com', denialLogPath);
    appendEgressDenialLog(sandbox, 'second.example.com', denialLogPath);

    const lines = readDenialLog(denialLogPath);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ host: 'first.example.com' });
    expect(lines[1]).toMatchObject({ host: 'second.example.com' });
  });

  it('each line is valid standalone JSON (not a JSON array)', () => {
    const sandbox = makeSandbox('assay', '01-core');

    appendEgressDenialLog(sandbox, 'sneaky.example.com', denialLogPath);

    const raw = readFileSync(denialLogPath, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);
    // Must parse as an object, not throw
    expect(() => JSON.parse(lines[0]!)).not.toThrow();
    expect(typeof JSON.parse(lines[0]!)).toBe('object');
  });

  it('three calls from different sandboxes each record their own product and project', () => {
    const sandboxA = makeSandbox('aura', '01-growth');
    const sandboxB = makeSandbox('assay', '02-billing');
    const sandboxC = makeSandbox('aura', '03-auth');

    appendEgressDenialLog(sandboxA, 'evil.example.com', denialLogPath);
    appendEgressDenialLog(sandboxB, 'evil.example.com', denialLogPath);
    appendEgressDenialLog(sandboxC, 'evil.example.com', denialLogPath);

    const lines = readDenialLog(denialLogPath);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatchObject({ product: 'aura', project: '01-growth' });
    expect(lines[1]).toMatchObject({ product: 'assay', project: '02-billing' });
    expect(lines[2]).toMatchObject({ product: 'aura', project: '03-auth' });
  });

  it('each line records the current enforcement mode (self-describing across the eventual flip)', () => {
    const sandbox = makeSandbox('aura');
    appendEgressDenialLog(sandbox, 'evil.example.com', denialLogPath);

    const lines = readDenialLog(denialLogPath);
    // Today's mode is 'documented-gap'; the test asserts on EGRESS_ENFORCEMENT_MODE
    // so it stays correct when the constant flips to 'proxy-enforced' later.
    expect(lines[0]).toHaveProperty('mode', EGRESS_ENFORCEMENT_MODE);
  });
});

// ---------------------------------------------------------------------------
// checkEgress — unknown product (config gap, not a runtime egress event)
// ---------------------------------------------------------------------------

describe('checkEgress — config gap behavior', () => {
  it('throws when sandbox.product is not in products.json', () => {
    // Documents the current behavior so a future proxy caller (A3) knows to
    // catch and fail-closed rather than letting the throw escape to a socket
    // handler. See egress-policy.ts JSDoc on checkEgress.
    const configPath = writeProductsJson(tmpDir);
    const sandbox = makeSandbox('relay'); // not in FIXTURE_PRODUCTS

    expect(() =>
      checkEgress(sandbox, 'github.com', {
        productsConfigPath: configPath,
        denialLogPath,
      }),
    ).toThrow(/relay/i);
  });
});
