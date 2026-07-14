import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { buildProductChatMcpConfig } from '../ai/product-chat-mcp.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function textResult(result: unknown): { text: string; isError?: boolean } {
  const response = result as { content: Array<{ type: string; text: string }>; isError?: boolean };
  return { text: response.content[0]!.text, ...(response.isError ? { isError: true } : {}) };
}

describe('product-chat MCP stdio subprocess', () => {
  it('boots without operator or product credentials and serves all seven isolated tools', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rune-product-chat-mcp-'));
    roots.push(root);
    const vault = join(root, 'vault');
    const logs = join(root, 'logs');
    const workspace = join(root, 'workspace');
    const bin = join(root, 'bin');
    mkdirSync(vault);
    mkdirSync(logs);
    mkdirSync(workspace);
    mkdirSync(bin);
    symlinkSync('/usr/bin/false', join(bin, 'claude'));
    symlinkSync('/usr/bin/which', join(bin, 'which'));

    process.env['ASSAY_API_KEY'] = 'must-not-cross-product-chat-mcp';
    const registration = buildProductChatMcpConfig('assay');
    delete process.env['ASSAY_API_KEY'];
    const claude = JSON.parse(registration.claudeArgs[2]!) as {
      mcpServers: Record<string, {
        command: string;
        args: string[];
        cwd: string;
        env: Record<string, string>;
      }>;
    };
    const server = claude.mcpServers['rune-kb']!;

    for (const forbidden of [
      'TELEGRAM_BOT_TOKEN',
      'TELEGRAM_USER_ID',
      'RUNE_HTTP_SECRET',
      'RUNE_MCP_SECRET',
      'READWISE_TOKEN',
      'WHOOP_CLIENT_SECRET',
      'ASSAY_API_KEY',
    ]) {
      expect(server.env).not.toHaveProperty(forbidden);
      expect(registration.codexConfigOverrides[0]).not.toContain(forbidden);
    }

    const transport = new StdioClientTransport({
      ...server,
      env: {
        ...server.env,
        VAULT_DIR: vault,
        RUNE_LOGS_DIR: logs,
        RUNE_WORKSPACE_DIR: workspace,
        PATH: bin,
        HOME: root,
      },
      stderr: 'pipe',
    });
    const client = new Client({ name: 'product-chat-subprocess-test', version: '1.0.0' });
    try {
      await client.connect(transport);
      expect((await client.listTools()).tools.map(tool => tool.name).sort()).toEqual([
        'cockpit_active_runs',
        'cockpit_inspect_run',
        'cockpit_list_runs',
        'kb_query',
        'kb_search',
        'kb_stats',
        'repo_search',
      ]);

      expect(textResult(await client.callTool({ name: 'kb_stats', arguments: {} })).text)
        .toContain('Total pages: 0');
      expect(textResult(await client.callTool({ name: 'kb_search', arguments: { query: 'no-such-page' } })).text)
        .toContain('No results found.');
      expect(textResult(await client.callTool({
        name: 'repo_search',
        arguments: { query: 'no-such-code', repoPath: workspace },
      })).text).toContain('No results found.');
      expect(JSON.parse(textResult(await client.callTool({
        name: 'cockpit_list_runs', arguments: { limit: 1 },
      })).text)).toEqual({ runs: [] });
      expect(JSON.parse(textResult(await client.callTool({
        name: 'cockpit_active_runs', arguments: {},
      })).text)).toEqual({ runs: [] });
      expect(textResult(await client.callTool({
        name: 'cockpit_inspect_run', arguments: { runId: 'missing-run' },
      })).isError).toBe(true);
      expect(textResult(await client.callTool({
        name: 'kb_query', arguments: { question: 'test-only forced failure' },
      })).isError).toBe(true);
    } finally {
      await client.close();
    }
  });
});
