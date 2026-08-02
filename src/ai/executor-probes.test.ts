import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { probeClaudeModelCall } from './claude.js';
import {
  CODEX_PROBE_RUNTIME_ROOT,
  codexProbeOwnerRoot,
  probeCodexAuthentication,
  probeCodexModelCall,
  reapStaleCodexProbeRuntimes,
} from './codex.js';
import { requestValidationSandboxProbe } from '../jobs/validation-sandbox-broker.js';
import { PROJECT_ROOT } from '../config.js';

const SANDBOX_INTEGRATION_TAG = { tags: ['validation-sandbox-integration'] };

async function proveInheritedSandbox(
  scenario: 'profile-compiles' | 'private-write-denied' | 'loopback-allowed-external-denied',
  candidateProfile: string,
): Promise<boolean> {
  const socketPath = process.env['RUNE_VALIDATION_SANDBOX_BROKER_SOCKET'];
  if (socketPath === undefined) return false;
  await expect(requestValidationSandboxProbe(socketPath, {
    version: 1,
    scenario,
    candidateProfile,
  })).resolves.toMatchObject({ ok: true, exitCode: 0, timedOut: false });
  return true;
}

describe('centralized executor probes', () => {
  it.each([
    undefined,
    { owner: 'artifact-launcher', profilePath: '/private/tmp/artifact.sb', nonce: 'forged' },
  ])('rejects missing or forged outer-confinement proof before a Codex probe spawn', async (
    confinementCapability,
  ) => {
    await expect(probeCodexAuthentication({
      binaryPath: '/usr/bin/true',
      cwd: '/private/tmp',
      env: {},
      timeoutMs: 1_000,
      sandboxProfilePath: '/private/tmp/artifact.sb',
      ...(confinementCapability === undefined
        ? {}
        : { confinementCapability: confinementCapability as never }),
    })).resolves.toEqual({ ok: false, code: 'sandbox-setup-failed' });
  });

  it('contains Codex host reads and removes its private runtime', SANDBOX_INTEGRATION_TAG, async () => {
    if (await proveInheritedSandbox(
      'private-write-denied',
      '(version 1)(allow default)(deny file-write*)',
    )) return;
    const dir = await mkdtemp(join(tmpdir(), 'codex-probe-containment-'));
    const binary = join(dir, 'codex-fixture');
    const home = join(dir, 'home');
    const codexHome = join(dir, 'codex-home');
    const secret = join(home, 'secret');
    // Scope the containment assertion to THIS process's own allocation root.
    // The shared repo-owned root is written by every concurrent Vitest worker,
    // so diffing it made a correct probe fail on someone else's in-flight
    // runtime — noise that masked the regression this assertion exists to catch.
    const ownerRoot = codexProbeOwnerRoot();
    const before = new Set(existsSync(ownerRoot)
      ? await readdir(ownerRoot)
      : []);
    try {
      await mkdir(home);
      await mkdir(codexHome);
      await writeFile(join(codexHome, 'auth.json'), '{}');
      await writeFile(secret, 'private-host-value');
      await writeFile(binary, [
        '#!/bin/sh',
        `if /bin/cat '${secret}' >/dev/null 2>&1; then`,
        "  printf '%s\\n' '{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"OK\"}}'",
        'else',
        '  exit 7',
        'fi',
      ].join('\n'));
      await chmod(binary, 0o700);

      const result = await probeCodexModelCall({
        binaryPath: binary,
        cwd: dir,
        env: { PATH: '/usr/bin:/bin', HOME: home, CODEX_HOME: codexHome },
        timeoutMs: 2_000,
        model: 'fixture-model',
      });

      expect(result).toMatchObject({ ok: false, code: 'nonzero-exit' });
      const after = existsSync(ownerRoot) ? await readdir(ownerRoot) : [];
      expect(after.filter((name) => !before.has(name))).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns a sanitized Codex stderr diagnostic on model failure', SANDBOX_INTEGRATION_TAG, async () => {
    if (await proveInheritedSandbox('profile-compiles', '(version 1)(allow default)')) return;
    const dir = await mkdtemp(join(tmpdir(), 'codex-probe-diagnostic-'));
    const binary = join(dir, 'codex-fixture');
    const home = join(dir, 'home');
    const codexHome = join(dir, 'codex-home');
    try {
      await mkdir(home);
      await mkdir(codexHome);
      await writeFile(join(codexHome, 'auth.json'), '{}');
      await writeFile(binary, [
        '#!/bin/sh',
        "printf '%s\\n' 'unknown model fixture-model; token=sk-raw-secret /Users/operator/private' >&2",
        'exit 7',
      ].join('\n'));
      await chmod(binary, 0o700);

      const result = await probeCodexModelCall({
        binaryPath: binary,
        cwd: dir,
        env: {
          PATH: '/usr/bin:/bin', HOME: home, CODEX_HOME: codexHome,
          OPENAI_API_KEY: 'sk-raw-secret',
        },
        timeoutMs: 2_000,
        model: 'fixture-model',
      });

      expect(result).toMatchObject({ ok: false, code: 'nonzero-exit' });
      expect(JSON.stringify(result)).not.toContain('sk-raw-secret');
      expect(JSON.stringify(result)).not.toContain('/Users/operator');
      expect(result.ok ? '' : result.diagnostic).toContain('<host-path>');
      expect(result.ok ? '' : result.diagnostic).toContain('unknown model fixture-model');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform === 'darwin')(
    'allows the Codex probe internal loopback client',
    SANDBOX_INTEGRATION_TAG,
    async () => {
    if (await proveInheritedSandbox(
      'loopback-allowed-external-denied',
      [
        '(version 1)',
        '(allow default)',
        '(deny network-outbound)',
        '(deny network-inbound)',
        '(allow network-inbound (local ip "localhost:*"))',
        '(allow network-outbound (remote ip "localhost:*"))',
      ].join(''),
    )) return;
    const dir = await mkdtemp(join(tmpdir(), 'codex-probe-loopback-'));
    const binary = join(dir, 'codex-fixture');
    const home = join(dir, 'home');
    const codexHome = join(dir, 'codex-home');
    const server = createServer((_req, res) => res.end('OK'));
    try {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('loopback test server did not bind');
      await mkdir(home);
      await mkdir(codexHome);
      await writeFile(join(codexHome, 'auth.json'), '{}');
      await writeFile(binary, [
        '#!/bin/sh',
        `curl -fsS 'http://127.0.0.1:${address.port}/' >/dev/null || exit 7`,
        "printf '%s\\n' '{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"OK\"}}'",
      ].join('\n'));
      await chmod(binary, 0o700);

      const result = await probeCodexModelCall({
        binaryPath: binary,
        cwd: dir,
        env: { PATH: '/usr/bin:/bin', HOME: home, CODEX_HOME: codexHome },
        timeoutMs: 2_000,
        model: 'fixture-model',
      });

      expect(result).toEqual({ ok: true });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns a sanitized, bounded Claude stderr diagnostic on model failure', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'claude-probe-diagnostic-'));
    const binary = join(dir, 'claude-fixture');
    try {
      await writeFile(binary, [
        '#!/bin/sh',
        "printf '%s\\n' 'unknown model fixture-model; token=sk-raw-secret /Users/operator/private' >&2",
        'exit 7',
      ].join('\n'));
      await chmod(binary, 0o700);

      const result = await probeClaudeModelCall({
        binaryPath: binary,
        cwd: dir,
        env: { PATH: '/usr/bin:/bin', HOME: dir, ANTHROPIC_API_KEY: 'sk-raw-secret' },
        timeoutMs: 2_000,
        model: 'fixture-model',
      });

      expect(result).toMatchObject({ ok: false, code: 'nonzero-exit' });
      expect(JSON.stringify(result)).not.toContain('sk-raw-secret');
      expect(JSON.stringify(result)).not.toContain('/Users/operator');
      expect(result.ok ? '' : result.diagnostic).toContain('<host-path>');
      expect(result.ok ? '' : result.diagnostic).toContain('unknown model fixture-model');
      expect(result.ok ? '' : result.diagnostic).toContain(
        'runtime: binary=executable, cwd=usable, home=usable, tmpdir=unset, claude-config=unset',
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

/**
 * `CODEX_PROBE_RUNTIME_ROOT` must stay repo-owned (Codex refuses to place its
 * app-server helpers in the OS temp dir), so a probe killed before its own
 * `finally` used to leak its directory permanently into a gitignored path.
 */
describe('Codex probe runtime reaping', () => {
  const HOUR_MS = 60 * 60 * 1_000;
  // The reaping logic is root-agnostic, so exercise it against a temp root
  // rather than the live repo. Writing into `PROJECT_ROOT/.rune` works in a
  // worktree but not in the trusted observer's materialized reviewed tree,
  // which is read-only — the divergence that kept the full-suite receipt red.
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'codex-probe-reap-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function ownerDir(pid: number, ageMs: number): string {
    const dir = codexProbeOwnerRoot(pid, root);
    mkdirSync(join(dir, 'probe-abc123'), { recursive: true, mode: 0o700 });
    const when = new Date(Date.now() - ageMs);
    utimesSync(dir, when, when);
    return dir;
  }

  it('keeps the production runtime root repo-owned', () => {
    // The seam above must not become a way for production to drift out of the
    // repository: Codex refuses to place its app-server helpers in the OS temp
    // dir, so the real root stays under PROJECT_ROOT.
    expect(CODEX_PROBE_RUNTIME_ROOT).toBe(join(PROJECT_ROOT, '.rune', 'codex-preflight'));
    expect(codexProbeOwnerRoot(4242)).toBe(join(CODEX_PROBE_RUNTIME_ROOT, 'owner-4242'));
  });

  it('removes a runtime orphaned by a killed probe', () => {
    // Far above macOS's pid ceiling, so process.kill(pid, 0) is a clean ESRCH.
    const orphan = ownerDir(999_999, 2 * HOUR_MS);

    reapStaleCodexProbeRuntimes(undefined, undefined, root);

    expect(existsSync(orphan)).toBe(false);
  });

  it('never removes a live owner, including its own', () => {
    const self = ownerDir(process.pid, 2 * HOUR_MS);
    const otherLive = ownerDir(process.ppid, 2 * HOUR_MS);

    reapStaleCodexProbeRuntimes(undefined, undefined, root);

    expect(existsSync(self)).toBe(true);
    expect(existsSync(otherLive)).toBe(true);
  });

  it('leaves a recent dead-owner runtime alone until it ages out', () => {
    const recent = ownerDir(999_998, 5 * 60 * 1_000);

    reapStaleCodexProbeRuntimes(undefined, undefined, root);
    expect(existsSync(recent)).toBe(true);

    reapStaleCodexProbeRuntimes(HOUR_MS, Date.now() + 2 * HOUR_MS, root);
    expect(existsSync(recent)).toBe(false);
  });

  it('ignores entries that are not owner scopes', () => {
    const stray = join(root, 'probe-legacyFormat');
    mkdirSync(stray, { recursive: true, mode: 0o700 });
    const when = new Date(Date.now() - 2 * HOUR_MS);
    utimesSync(stray, when, when);

    reapStaleCodexProbeRuntimes(undefined, undefined, root);

    expect(existsSync(stray)).toBe(true);
  });
});
