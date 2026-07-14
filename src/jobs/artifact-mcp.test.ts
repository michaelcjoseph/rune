import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildArtifactMcpConfig } from './artifact-mcp.js';
import type { SandboxSpec } from '../intent/sandbox.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(policy: boolean): { root: string; products: string; vault: string; sandbox: SandboxSpec } {
  const root = mkdtempSync(join(tmpdir(), 'artifact-mcp-builder-'));
  dirs.push(root);
  mkdirSync(join(root, 'scripts'), { recursive: true });
  mkdirSync(join(root, 'src', 'mcp'), { recursive: true });
  writeFileSync(join(root, 'scripts', 'register-ts.mjs'), '// fixture');
  writeFileSync(join(root, 'src', 'mcp', 'artifact-readonly.ts'), '// fixture');
  writeFileSync(join(root, 'src', 'mcp', 'artifact-readonly-relay.ts'), '// fixture');
  const vault = join(root, 'vault');
  mkdirSync(vault);
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
      for (const forbidden of ['VAULT_DIR', 'RUNE_HTTP_SECRET', 'RUNE_MCP_SECRET', 'READWISE_TOKEN', 'WHOOP_CLIENT_SECRET']) {
        expect(serialized).not.toContain(forbidden);
      }
      expect(cfg!.codexConfigOverrides).toHaveLength(1);
      expect(cfg!.codexConfigOverrides[0]).toMatch(/^mcp_servers=/);
      expect(cfg!.codexConfigOverrides[0]).toContain('"rune-kb"');
      expect(cfg!.codexConfigOverrides[0]).toContain('required=true');
      expect(cfg!.codexConfigOverrides[0]).toContain('default_tools_approval_mode="approve"');
      expect(cfg!.codexConfigOverrides[0]).toContain(
        'enabled_tools=["vault_search","journal_range","follow_wikilinks"]',
      );
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
});
