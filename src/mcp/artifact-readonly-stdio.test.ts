import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { buildArtifactMcpConfig } from '../jobs/artifact-mcp.js';
import type { SandboxSpec } from '../intent/sandbox.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tree(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(full.slice(root.length + 1));
    }
  };
  walk(root);
  return out.sort();
}

describe('artifact read-only stdio MCP', () => {
  it('advertises exactly three tools and queries a planted vault without mutation', async () => {
    const root = fileURLToPath(new URL('../..', import.meta.url));
    const vault = mkdtempSync(join(tmpdir(), 'artifact-readonly-vault-'));
    dirs.push(vault);
    mkdirSync(join(vault, 'writing'), { recursive: true });
    mkdirSync(join(vault, 'journals'), { recursive: true });
    mkdirSync(join(vault, 'knowledge'), { recursive: true });
    const source = join(vault, 'writing', 'voice.md');
    writeFileSync(source, '# Voice\n\nUse the planted resonance marker and [[Voice Target]].\n');
    writeFileSync(join(vault, 'journals', '2026_07_11.md'), '# Day\n\nJOURNAL_RANGE_MARKER\n');
    writeFileSync(join(vault, 'knowledge', 'voice-target.md'), '# Voice Target\n\nWIKILINK_TARGET_MARKER\n');
    const outside = mkdtempSync(join(tmpdir(), 'artifact-outside-'));
    dirs.push(outside);
    writeFileSync(join(outside, 'secret.md'), '# Outside\n\nOUTSIDE_SYMLINK_MARKER\n');
    symlinkSync(join(outside, 'secret.md'), join(vault, 'writing', 'outside.md'));
    const beforeTree = tree(vault);
    const beforeSource = readFileSync(source, 'utf8');

    const products = join(outside, 'products.json');
    writeFileSync(products, JSON.stringify({
      writing: { repoPath: vault, artifactMcp: 'rune-kb-readonly' },
    }));
    const cfg = await buildArtifactMcpConfig({
      product: 'writing', project: 'fixture', worktree: vault,
      egressAllowlist: [], resumed: false,
    } as SandboxSpec, {
      productsConfigPath: products,
      projectRoot: root,
      vaultDir: vault,
    });
    expect(cfg).not.toBeNull();
    const claude = JSON.parse(cfg!.claudeArgs[2]!) as { mcpServers: Record<string, {
      command: string; args: string[]; cwd: string; env: Record<string, string>;
    }> };
    const registration = claude.mcpServers['rune-kb']!;
    expect(JSON.stringify(registration)).not.toContain(vault);
    const denied = spawnSync('/usr/bin/sandbox-exec', [
      '-f', cfg!.sandboxProfilePath, '/usr/bin/head', '-n', '1', source,
    ], { encoding: 'utf8' });
    expect(denied.status).not.toBe(0);
    const deniedWrite = spawnSync('/usr/bin/sandbox-exec', [
      '-f', cfg!.sandboxProfilePath,
      '/bin/sh', '-c', 'printf tampered >> "$1"', 'sh', source,
    ], { encoding: 'utf8' });
    expect(deniedWrite.status).not.toBe(0);
    expect(readFileSync(source, 'utf8')).toBe(beforeSource);

    const transport = new StdioClientTransport({
      ...registration,
      stderr: 'pipe',
    });
    const client = new Client({ name: 'artifact-readonly-test', version: '1.0.0' });
    let heldSocket: ReturnType<typeof connect> | undefined;
    try {
      await client.connect(transport);
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name).sort()).toEqual([
        'follow_wikilinks', 'journal_range', 'vault_search',
      ]);
      for (const tool of listed.tools) {
        expect(tool.annotations).toMatchObject({
          readOnlyHint: true,
          destructiveHint: false,
          openWorldHint: false,
        });
      }
      const result = await client.callTool({
        name: 'vault_search',
        arguments: { query: 'planted resonance marker', maxResults: 5 },
      });
      expect(JSON.stringify(result)).toContain('writing/voice.md');
      expect(JSON.stringify(result)).toContain('planted resonance marker');
      const journal = await client.callTool({
        name: 'journal_range',
        arguments: { startDate: '2026-07-11', endDate: '2026-07-11' },
      });
      expect(JSON.stringify(journal)).toContain('JOURNAL_RANGE_MARKER');
      const links = await client.callTool({
        name: 'follow_wikilinks',
        arguments: { sourceFile: 'writing/voice.md', maxDepth: 1, maxResults: 5 },
      });
      expect(JSON.stringify(links)).toContain('WIKILINK_TARGET_MARKER');
      const escaped = await client.callTool({
        name: 'vault_search',
        arguments: { query: 'OUTSIDE_SYMLINK_MARKER', maxResults: 5 },
      });
      expect(JSON.stringify(escaped)).not.toContain('OUTSIDE_SYMLINK_MARKER');
      const socketPath = registration.args.at(-1)!;
      heldSocket = connect(socketPath);
      await new Promise<void>((resolve, reject) => {
        heldSocket!.once('connect', resolve);
        heldSocket!.once('error', reject);
      });
    } finally {
      await client.close();
      const heldClosed = heldSocket
        ? new Promise<void>((resolve) => heldSocket!.once('close', () => resolve()))
        : Promise.resolve();
      await cfg?.stop();
      await heldClosed;
    }

    expect(tree(vault)).toEqual(beforeTree);
    expect(readFileSync(source, 'utf8')).toBe(beforeSource);
    expect(tree(vault)).not.toContain('knowledge/index.md');
    expect(existsSync(cfg!.sandboxProfilePath)).toBe(false);

  }, 20_000);
});
