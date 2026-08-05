// @module-tag validation-sandbox-integration
import { describe, expect, it, vi } from 'vitest';
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

import type { SandboxSpec } from '../intent/sandbox.js';
import type { ArtifactMcpConfig } from './artifact-mcp.js';
import {
  preflightExecution,
  type ExecutionPreflightIO,
  type ExecutionPreflightRoleModels,
} from './execution-preflight.js';
import type { RoleModelBinding } from './execution-agent.js';
import { codexProbeOwnerRoot } from '../ai/codex.js';
import { createConfinementCapability } from '../utils/validation-confinement.js';
import { requestValidationSandboxProbe } from './validation-sandbox-broker.js';

const claude = (alias = 'opus'): RoleModelBinding => ({
  alias,
  provider: 'anthropic',
  format: 'claude',
});
const codex = (alias = 'gpt-coder'): RoleModelBinding => ({
  alias,
  provider: 'openai',
  format: 'codex',
});

function models(overrides: Partial<ExecutionPreflightRoleModels> = {}): ExecutionPreflightRoleModels {
  return {
    pm: claude(),
    techLead: claude(),
    qa: codex(),
    coder: codex(),
    reviewer: claude(),
    designer: claude(),
    security: claude(),
    ...overrides,
  };
}

const sandbox = {
  product: 'rune',
  project: 'preflight',
  worktree: '/tmp/preflight-worktree',
  egressAllowlist: [],
  resumed: false,
} as SandboxSpec;

function io(overrides: Partial<ExecutionPreflightIO> = {}): ExecutionPreflightIO {
  return {
    resolveBinary: vi.fn(async (format) => ({ ok: true as const, path: `/bin/${format}` })),
    buildEnv: vi.fn(() => ({ PATH: '/usr/bin', HOME: '/tmp/home' })),
    checkAuthentication: vi.fn(async () => ({ ok: true })),
    probeModel: vi.fn(async () => ({ ok: true })),
    buildArtifactMcp: vi.fn(async () => null),
    ...overrides,
  };
}

const args = (roleModels = models()) => ({
  models: roleModels,
  sandbox,
  productsConfigPath: '/tmp/products.json',
});

function artifactConfig(stop = vi.fn(async () => {})): ArtifactMcpConfig {
  const confinementCapability = createConfinementCapability(
    'artifact-launcher',
    '/tmp/artifact.sb',
  );
  return {
    claudeArgs: [],
    codexConfigOverrides: [],
    sandboxProfilePath: '/tmp/artifact.sb',
    confinementCapability,
    runtimeEnv: {},
    verifyRegistration: vi.fn(async () => {}),
    stop,
  };
}

describe('preflightExecution', () => {
  it('runs the production auth/model probes for a mixed policy with the exact resolved aliases', async () => {
    const inheritedBroker = process.env['RUNE_VALIDATION_SANDBOX_BROKER_SOCKET'];
    if (inheritedBroker !== undefined) {
      await expect(requestValidationSandboxProbe(inheritedBroker, {
        version: 1,
        scenario: 'profile-compiles',
        candidateProfile: '(version 1)(allow default)',
      })).resolves.toMatchObject({ ok: true, exitCode: 0, timedOut: false });
      await expect(preflightExecution(args(), io())).resolves.toMatchObject({ status: 'success' });
      return;
    }
    // Own-process scope only: the shared repo-owned root is written by every
    // concurrent Vitest worker, so diffing it failed on another worker's
    // in-flight runtime rather than on a real containment regression.
    const ownerRoot = codexProbeOwnerRoot();
    const beforeProbeDirs = new Set(existsSync(ownerRoot)
      ? await readdir(ownerRoot)
      : []);
    const dir = await mkdtemp(join(tmpdir(), 'executor-preflight-cli-'));
    const claudeBin = join(dir, 'claude-fixture');
    const codexBin = join(dir, 'codex-fixture');
    const codexHome = join(dir, 'codex-home');
    const home = join(dir, 'home');
    try {
      await mkdir(codexHome);
      await mkdir(home);
      await writeFile(join(codexHome, 'auth.json'), '{}');
      await writeFile(join(home, 'host-secret'), 'must-not-be-readable');
      await writeFile(claudeBin, [
        '#!/bin/sh',
        '[ -z "$OPENAI_API_KEY" ] || exit 81',
        '[ -z "$ANTHROPIC_API_KEY" ] || exit 82',
        'if [ "$1" = "auth" ]; then',
        "  printf '%s\\n' '{\"loggedIn\":true}'",
        'else',
        '  case "$*" in *"--safe-mode"*"--model opus"*) ;; *) exit 83 ;; esac',
        '  probe_cwd=$(pwd -P)',
        '  sleep 0.05',
        '  [ -d "$probe_cwd" ] || exit 84',
        "  printf '%s\\n' 'OK'",
        'fi',
      ].join('\n'));
      await writeFile(codexBin, [
        '#!/bin/sh',
        '[ -z "$OPENAI_API_KEY" ] || exit 91',
        '[ -z "$ANTHROPIC_API_KEY" ] || exit 92',
        'if [ "$1" = "login" ]; then',
        "  printf '%s\\n' 'benign warning' 'Logged in with fixture credentials'",
        'else',
        '  case "$*" in *"-m gpt-coder"*"--ignore-user-config"*) ;; *) exit 93 ;; esac',
        '  case "$*" in *"features.shell_tool=false"*) ;; *) exit 94 ;; esac',
        '  case "$*" in *"features.unified_exec=false"*) ;; *) exit 95 ;; esac',
        '  case "$*" in *"features.apps=false"*) ;; *) exit 96 ;; esac',
        '  case "$*" in *"apps.enabled=false"*) exit 97 ;; esac',
        '  case "$*" in *"features.remote_plugin=false"*) ;; *) exit 98 ;; esac',
        '  case "$*" in *"remote_plugins.enabled=false"*) exit 99 ;; esac',
        '  case "$*" in *"tools_view_image=false"*) exit 100 ;; esac',
        "  printf '%s\\n' '{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"OK\"}}'",
        'fi',
      ].join('\n'));
      await chmod(claudeBin, 0o700);
      await chmod(codexBin, 0o700);

      const result = await preflightExecution(args(), {
        resolveBinary: async (format) => ({
          ok: true,
          path: format === 'claude' ? claudeBin : codexBin,
        }),
        buildEnv: () => ({
          PATH: '/usr/bin:/bin',
          HOME: home,
          CODEX_HOME: codexHome,
          OPENAI_API_KEY: 'must-not-reach-probe',
          ANTHROPIC_API_KEY: 'must-not-reach-probe',
        }),
        buildArtifactMcp: async () => null,
      });

      expect(result.status, JSON.stringify(result)).toBe('success');
      const afterProbeDirs = existsSync(ownerRoot) ? await readdir(ownerRoot) : [];
      expect(afterProbeDirs.filter((name) => !beforeProbeDirs.has(name))).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.each([
    ['codex', ['qa', 'coder']],
    ['claude', ['pm', 'tech-lead', 'reviewer', 'designer', 'security']],
  ] as const)('fails closed on a missing or unexecutable %s binary', async (format, roles) => {
    const seams = io({
      resolveBinary: vi.fn(async (candidate) => candidate === format
        ? { ok: false as const, diagnostic: `${candidate} binary missing` }
        : { ok: true as const, path: `/bin/${candidate}` }),
    });

    const result = await preflightExecution(args(), seams);

    expect(result).toMatchObject({
      status: 'failed',
      prerequisite: 'binary',
      format,
      roles,
    });
    expect(seams.probeModel).not.toHaveBeenCalled();
    expect(seams.buildArtifactMcp).not.toHaveBeenCalled();
  });

  it.each(['codex', 'claude'] as const)('labels failed %s authentication separately', async (format) => {
    const seams = io({
      checkAuthentication: vi.fn(async (candidate) => candidate === format
        ? { ok: false, diagnostic: `${candidate} session expired` }
        : { ok: true }),
    });

    const result = await preflightExecution(args(), seams);

    expect(result).toMatchObject({
      status: 'failed',
      prerequisite: 'authentication',
      format,
    });
    expect(result.status === 'failed' ? result.remediation : '').toMatch(/login|auth login/i);
    expect(seams.probeModel).not.toHaveBeenCalled();
  });

  it('fails the exact shared model binding once and retains every affected role', async () => {
    const probeModel = vi.fn(async (binding: RoleModelBinding) => binding.alias === 'gpt-coder'
      ? { ok: false, diagnostic: 'exact-model probe timed out after 30ms' }
      : { ok: true });
    const seams = io({ probeModel });

    const result = await preflightExecution(args(), seams);

    expect(result).toMatchObject({
      status: 'failed',
      prerequisite: 'model-call',
      model: 'gpt-coder',
      roles: ['qa', 'coder'],
    });
    expect(probeModel).toHaveBeenCalledTimes(2);
    expect(seams.buildArtifactMcp).not.toHaveBeenCalled();
  });

  it('surfaces a classified, sanitized CLI stderr excerpt for a failed model probe', async () => {
    const seams = io({
      probeModel: vi.fn(async (binding) => binding.alias === 'gpt-coder'
        ? { ok: false, code: 'nonzero-exit' as const, diagnostic: 'unknown model gpt-coder' }
        : { ok: true }),
    });

    const result = await preflightExecution(args(), seams);

    expect(result).toMatchObject({
      status: 'failed',
      prerequisite: 'model-call',
      diagnostic: 'codex model availability error: unknown model gpt-coder',
    });
  });

  it('points Bun ENOENT failures at the service runtime rather than model access', async () => {
    const seams = io({
      probeModel: vi.fn(async (binding) => binding.alias === 'gpt-coder'
        ? { ok: false, code: 'nonzero-exit' as const, diagnostic: 'ENOENT: Bun could not find a file' }
        : { ok: true }),
    });

    const result = await preflightExecution(args(), seams);

    expect(result).toMatchObject({
      status: 'failed',
      remediation: 'inspect the Rune service Claude runtime directories reported above, then retry the run',
    });
  });

  it('probes each shared executor and shared model binding only once', async () => {
    const seams = io();

    const result = await preflightExecution(args(), seams);

    expect(result).toMatchObject({ status: 'success', artifactMcp: 'not-required' });
    expect(seams.resolveBinary).toHaveBeenCalledTimes(2);
    expect(seams.checkAuthentication).toHaveBeenCalledTimes(2);
    expect(seams.probeModel).toHaveBeenCalledTimes(2);
    expect(seams.buildArtifactMcp).toHaveBeenCalledTimes(1);
    expect(result.status === 'success' ? result.bindings : []).toEqual(expect.arrayContaining([
      expect.objectContaining({ model: 'opus', roles: ['pm', 'tech-lead', 'reviewer', 'designer', 'security'] }),
      expect.objectContaining({ model: 'gpt-coder', roles: ['qa', 'coder'] }),
    ]));
  });

  it('preflights the declared adjudicator binding before workflow dispatch', async () => {
    const seams = io();

    const result = await preflightExecution(args(models({
      adjudicator: codex('gpt-judge-primary'),
    })), seams);

    expect(result).toMatchObject({ status: 'success' });
    expect(seams.probeModel).toHaveBeenCalledTimes(3);
    expect(result.status === 'success' ? result.bindings : []).toEqual(expect.arrayContaining([
      expect.objectContaining({ model: 'gpt-judge-primary', roles: ['adjudicator'] }),
    ]));
  });

  it.each([
    'artifact sandbox preflight failed: invalid Seatbelt profile',
    'read-only MCP broker exited before ready',
  ])('maps artifact environment setup failure to artifact-mcp evidence: %s', async (diagnostic) => {
    const seams = io({
      buildArtifactMcp: vi.fn(async () => { throw new Error(diagnostic); }),
    });

    const result = await preflightExecution(args(), seams);

    expect(result).toMatchObject({
      status: 'failed',
      prerequisite: 'artifact-mcp',
      roles: ['qa', 'coder'],
      format: 'codex',
    });
    expect(result.status === 'failed' ? result.diagnostic : '').toMatch(
      /artifact MCP (Seatbelt setup|broker startup) failed/,
    );
  });

  it('fails closed when a built artifact environment cannot be cleaned up', async () => {
    const stop = vi.fn(async () => { throw new Error('broker survived SIGKILL'); });
    const seams = io({ buildArtifactMcp: vi.fn(async () => artifactConfig(stop)) });

    const result = await preflightExecution(args(), seams);

    expect(stop).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      status: 'failed',
      prerequisite: 'artifact-mcp',
      diagnostic: expect.stringContaining('cleanup failed'),
    });
  });

  it('fails closed when the live artifact relay registration handshake fails', async () => {
    const config = artifactConfig();
    config.verifyRegistration = vi.fn(async () => {
      throw new Error('relay tools/list mismatch with host path /Users/operator/vault');
    });
    const seams = io({ buildArtifactMcp: vi.fn(async () => config) });

    const result = await preflightExecution(args(), seams);

    expect(config.verifyRegistration).toHaveBeenCalledOnce();
    expect(config.stop).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      status: 'failed',
      prerequisite: 'artifact-mcp',
      diagnostic: 'artifact MCP relay registration handshake failed',
    });
    expect(JSON.stringify(result)).not.toContain('/Users/operator');
  });

  it('builds and stops each distinct configured QA/coder executor format', async () => {
    const stops: Array<ReturnType<typeof vi.fn>> = [];
    const buildArtifactMcp = vi.fn(async () => {
      const stop = vi.fn(async () => {});
      stops.push(stop);
      return artifactConfig(stop);
    });
    const seams = io({ buildArtifactMcp });
    const roleModels = models({
      qa: codex('gpt-qa'),
      coder: claude('sonnet-coder'),
    });

    const result = await preflightExecution(args(roleModels), seams);

    expect(result).toMatchObject({
      status: 'success',
      artifactMcp: 'validated',
      artifactFormats: ['codex', 'claude'],
    });
    expect(buildArtifactMcp).toHaveBeenCalledTimes(2);
    expect(stops).toHaveLength(2);
    expect(stops.every((stop) => stop.mock.calls.length === 1)).toBe(true);
  });

  it('records artifact MCP as not required without building redundant formats', async () => {
    const buildArtifactMcp = vi.fn(async () => null);
    const seams = io({ buildArtifactMcp });
    const roleModels = models({ qa: codex('gpt-qa'), coder: claude('sonnet-coder') });

    const result = await preflightExecution(args(roleModels), seams);

    expect(result).toMatchObject({
      status: 'success',
      artifactMcp: 'not-required',
      artifactFormats: [],
    });
    expect(buildArtifactMcp).toHaveBeenCalledOnce();
  });

  it('redacts credentials and host paths and caps failure diagnostics', async () => {
    const secret = 'sk-preflightFixtureSecret123456';
    const hostPath = '/Users/jarvis/private/auth.json';
    const seams = io({
      probeModel: vi.fn(async (binding) => binding.alias === 'gpt-coder'
        ? { ok: false, diagnostic: `${secret} ${hostPath} ${'x'.repeat(2_000)}` }
        : { ok: true }),
    });

    const result = await preflightExecution(args(), seams);

    expect(result.status).toBe('failed');
    if (result.status !== 'failed') return;
    expect(result.diagnostic).not.toContain(secret);
    expect(result.diagnostic).not.toContain('/Users/jarvis');
    expect(result.diagnostic).toContain('<redacted-');
    expect(result.diagnostic.length).toBeLessThanOrEqual(600);
  });
});
