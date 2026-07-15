import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SandboxSpec } from '../intent/sandbox.js';

const { spawnMock, spawnSyncMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  spawnSyncMock: vi.fn(() => ({ status: 0 })),
}));
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: spawnMock,
  spawnSync: spawnSyncMock,
}));

import { buildArtifactMcpConfig } from './artifact-mcp.js';

const dirs: string[] = [];
let fakePid = 200_000;

function makeBrokerChild(): any {
  const child = new EventEmitter() as any;
  child.pid = fakePid++;
  child.exitCode = null;
  child.signalCode = null;
  child.stdout = new EventEmitter();
  child.stderr = Object.assign(new EventEmitter(), { resume: vi.fn() });
  child.stdin = {
    end: () => queueMicrotask(() => {
      child.stdout.emit('data', Buffer.from('READY\n'));
      queueMicrotask(() => {
        child.exitCode = 0;
        child.emit('exit', 0, null);
      });
    }),
  };
  return child;
}

spawnMock.mockImplementation(() => makeBrokerChild());
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  spawnSyncMock.mockReset();
  spawnSyncMock.mockReturnValue({ status: 0 });
  spawnMock.mockReset();
  spawnMock.mockImplementation(() => makeBrokerChild());
});

function fixture(policy: boolean): {
  root: string;
  products: string;
  vault: string;
  codexHome: string;
  homeDir: string;
  sandbox: SandboxSpec;
} {
  const root = mkdtempSync(join(tmpdir(), 'artifact-mcp-builder-'));
  dirs.push(root);
  mkdirSync(join(root, 'scripts'), { recursive: true });
  mkdirSync(join(root, 'src', 'mcp'), { recursive: true });
  writeFileSync(join(root, 'scripts', 'register-ts.mjs'), '// fixture');
  writeFileSync(join(root, 'src', 'mcp', 'artifact-readonly.ts'), '// fixture');
  writeFileSync(join(root, 'src', 'mcp', 'artifact-readonly-relay.ts'), '// fixture');
  const vault = join(root, 'vault');
  mkdirSync(vault);
  const codexHome = join(root, 'codex-home');
  mkdirSync(codexHome);
  writeFileSync(join(codexHome, 'auth.json'), 'fixture-auth-secret', { mode: 0o600 });
  const homeDir = join(root, 'home');
  mkdirSync(join(homeDir, '.ssh'), { recursive: true });
  writeFileSync(join(homeDir, '.ssh', 'id_ed25519'), 'ssh-secret');
  mkdirSync(join(root, 'worktree'));
  const products = join(root, 'products.json');
  writeFileSync(products, JSON.stringify({
    writing: {
      repoPath: join(root, 'repo'),
      ...(policy ? { artifactMcp: 'rune-kb-readonly' } : {}),
    },
  }));
  return {
    root,
    products,
    vault,
    codexHome,
    homeDir,
    sandbox: {
      product: 'writing', project: 'one', worktree: join(root, 'worktree'),
      egressAllowlist: [], resumed: false,
    } as SandboxSpec,
  };
}

describe('buildArtifactMcpConfig', () => {
  it('returns null when the product has no artifact MCP policy', async () => {
    const f = fixture(false);
    await expect(buildArtifactMcpConfig(f.sandbox, {
      productsConfigPath: f.products, projectRoot: f.root, vaultDir: f.vault,
    })).resolves.toBeNull();
  });

  it('builds strict Claude and complete Codex configs without exposing the vault path', async () => {
    const f = fixture(true);
    const realRoot = fileURLToPath(new URL('../..', import.meta.url));
    const cfg = await buildArtifactMcpConfig(f.sandbox, {
      productsConfigPath: f.products,
      projectRoot: realRoot,
      vaultDir: f.vault,
      nodePath: process.execPath,
      codexHome: f.codexHome,
      homeDir: f.homeDir,
    });
    try {
      expect(cfg).not.toBeNull();
      const claude = JSON.parse(cfg!.claudeArgs[2]!) as { mcpServers: Record<string, any> };
      expect(Object.keys(claude.mcpServers)).toEqual(['rune-kb']);
      const server = claude.mcpServers['rune-kb'];
      expect(server.command).toBe(process.execPath);
      expect(server.args).toEqual([
        '--import', join(realRoot, 'scripts', 'register-ts.mjs'),
        join(realRoot, 'src', 'mcp', 'artifact-readonly-relay.ts'),
        expect.stringMatching(/broker\.sock$/),
      ]);
      expect(server.args.join(' ')).not.toContain('.env.local');
      expect(server.env).toEqual({});
      const serialized = JSON.stringify(cfg);
      expect(serialized).not.toContain(f.vault);
      expect(serialized).not.toContain('fixture-auth-secret');
      expect(cfg!.runtimeEnv['TMPDIR']).toMatch(/rune-artifact-mcp-/);
      expect(cfg!.codexEnv!['HOME']).toBe(cfg!.runtimeEnv['TMPDIR']);
      expect(cfg!.codexEnv!['CODEX_HOME']).not.toBe(f.codexHome);
      expect(readFileSync(join(cfg!.codexEnv!['CODEX_HOME']!, 'auth.json'), 'utf8'))
        .toBe('fixture-auth-secret');
      expect(statSync(join(cfg!.codexEnv!['CODEX_HOME']!, 'auth.json')).mode & 0o777)
        .toBe(0o600);
      for (const forbidden of ['VAULT_DIR', 'RUNE_HTTP_SECRET', 'RUNE_MCP_SECRET', 'READWISE_TOKEN', 'WHOOP_CLIENT_SECRET']) {
        expect(serialized).not.toContain(forbidden);
      }
      expect(cfg!.codexConfigOverrides).toHaveLength(2);
      expect(cfg!.codexConfigOverrides[0]).toMatch(/^mcp_servers=/);
      expect(cfg!.codexConfigOverrides[0]).toContain('"rune-kb"');
      expect(cfg!.codexConfigOverrides[0]).toContain('required=true');
      expect(cfg!.codexConfigOverrides[0]).toContain('default_tools_approval_mode="approve"');
      expect(cfg!.codexConfigOverrides[0]).toContain(
        'enabled_tools=["vault_search","journal_range","follow_wikilinks"]',
      );
      expect(cfg!.codexConfigOverrides[1]).toBe('shell_environment_policy.inherit="none"');
      const profile = readFileSync(cfg!.sandboxProfilePath, 'utf8');
      expect(profile).toContain(`(deny file-read* (subpath "${f.codexHome}"))`);
      expect(profile).toContain(`(deny file-read* (subpath "${join(f.homeDir, '.ssh')}"))`);
      expect(profile).toContain('(deny network-outbound (remote ip "localhost:*"))');
    } finally {
      await cfg?.stop();
    }
  });

  it('does not require or seed Codex auth for Claude-format artifact sessions', async () => {
    const realRoot = fileURLToPath(new URL('../..', import.meta.url));
    const f = fixture(true);
    rmSync(f.codexHome, { recursive: true, force: true });

    const cfg = await buildArtifactMcpConfig(f.sandbox, {
      productsConfigPath: f.products,
      projectRoot: realRoot,
      vaultDir: f.vault,
      executor: 'claude',
      homeDir: f.homeDir,
    });
    try {
      expect(cfg).not.toBeNull();
      expect(cfg!.runtimeEnv['TMPDIR']).toMatch(/rune-artifact-mcp-/);
      expect(cfg!.codexEnv).toBeUndefined();
    } finally {
      await cfg?.stop();
    }
  });

  it('fails validation when a required absolute entrypoint is missing', async () => {
    const f = fixture(true);
    rmSync(join(f.root, 'src', 'mcp', 'artifact-readonly.ts'));
    await expect(buildArtifactMcpConfig(f.sandbox, {
      productsConfigPath: f.products, projectRoot: f.root, vaultDir: f.vault,
    })).rejects.toThrow(/read-only MCP broker is missing/);
  });

  it('uses the real Rune relay and loader as absolute files', async () => {
    const realRoot = fileURLToPath(new URL('../..', import.meta.url));
    const f = fixture(true);
    const cfg = await buildArtifactMcpConfig(f.sandbox, {
      productsConfigPath: f.products, projectRoot: realRoot, vaultDir: f.vault,
      codexHome: f.codexHome,
    });
    try {
      const claude = JSON.parse(cfg!.claudeArgs[2]!) as { mcpServers: Record<string, any> };
      const args = claude.mcpServers['rune-kb'].args as string[];
      expect(args.every((arg) => arg === '--import' || arg.startsWith('/'))).toBe(true);
    } finally {
      await cfg?.stop();
    }
  });

  it('rejects missing and non-directory vault paths before spawning the broker', async () => {
    const realRoot = fileURLToPath(new URL('../..', import.meta.url));
    const f = fixture(true);
    await expect(buildArtifactMcpConfig(f.sandbox, {
      productsConfigPath: f.products,
      projectRoot: realRoot,
      vaultDir: join(f.root, 'missing'),
    })).rejects.toThrow(/VAULT_DIR is not a directory/);
    const file = join(f.root, 'not-a-directory');
    writeFileSync(file, 'x');
    await expect(buildArtifactMcpConfig(f.sandbox, {
      productsConfigPath: f.products,
      projectRoot: realRoot,
      vaultDir: file,
    })).rejects.toThrow(/VAULT_DIR is not a directory/);
  });

  it('rejects an unreadable vault before spawning the broker', async () => {
    const realRoot = fileURLToPath(new URL('../..', import.meta.url));
    const f = fixture(true);
    chmodSync(f.vault, 0o000);
    try {
      await expect(buildArtifactMcpConfig(f.sandbox, {
        productsConfigPath: f.products,
        projectRoot: realRoot,
        vaultDir: f.vault,
      })).rejects.toThrow();
    } finally {
      chmodSync(f.vault, 0o700);
    }
  });

  it('fails clearly on platforms without the required Seatbelt boundary', async () => {
    const f = fixture(true);
    await expect(buildArtifactMcpConfig(f.sandbox, {
      productsConfigPath: f.products,
      projectRoot: f.root,
      vaultDir: f.vault,
      platform: 'linux',
    })).rejects.toThrow(/requires macOS Seatbelt/);
  });

  it('validates the worktree before starting the privileged broker', async () => {
    const realRoot = fileURLToPath(new URL('../..', import.meta.url));
    const f = fixture(true);
    f.sandbox.worktree = join(f.root, 'missing-worktree');

    await expect(buildArtifactMcpConfig(f.sandbox, {
      productsConfigPath: f.products,
      projectRoot: realRoot,
      vaultDir: f.vault,
    })).rejects.toThrow(/worktree is not a directory/);
  });

  it('preflights shell startup and a worktree write against the generated profile', async () => {
    const realRoot = fileURLToPath(new URL('../..', import.meta.url));
    const f = fixture(true);
    spawnSyncMock.mockReturnValueOnce({ status: 1 });

    await expect(buildArtifactMcpConfig(f.sandbox, {
      productsConfigPath: f.products,
      projectRoot: realRoot,
      vaultDir: f.vault,
      codexHome: f.codexHome,
    })).rejects.toThrow(/artifact sandbox preflight failed/);
    const preflightArgs = (spawnSyncMock.mock.calls as unknown as Array<[string, string[]]>)[0]![1];
    expect(preflightArgs[0]).toBe('-f');
    expect(existsSync(join(preflightArgs[1]!, '..'))).toBe(false);
  });
});
