import { describe, expect, it } from 'vitest';
import { buildProductChatMcpConfig } from './product-chat-mcp.js';

const DIAGNOSTIC_TOOLS = [
  'cockpit_list_runs',
  'cockpit_inspect_run',
  'cockpit_active_runs',
] as const;

describe('product chat MCP provider configuration', () => {
  it('builds isolated Claude and Codex registrations scoped to the same product', async () => {
    const config = buildProductChatMcpConfig('assay');

    expect(config.claudeArgs.slice(0, 2)).toEqual(['--strict-mcp-config', '--mcp-config']);
    const claude = JSON.parse(config.claudeArgs[2]!) as {
      mcpServers: Record<string, { env?: Record<string, string> }>;
    };
    expect(Object.keys(claude.mcpServers)).toEqual(['rune-kb']);
    expect(claude.mcpServers['rune-kb']?.env).toEqual(expect.objectContaining({
      RUNE_PRODUCT_CHAT_PRODUCT: 'assay',
    }));

    expect(config.codexConfigOverrides).toHaveLength(1);
    const codex = config.codexConfigOverrides[0]!;
    expect(codex).toMatch(/^mcp_servers=/);
    expect(codex).toContain('"rune-kb"');
    expect(codex).toContain('RUNE_PRODUCT_CHAT_PRODUCT');
    expect(codex).toContain('assay');
    expect(codex).toContain('required=true');
    for (const tool of DIAGNOSTIC_TOOLS) expect(codex).toContain(tool);

    const serialized = JSON.stringify(config);
    expect(serialized).not.toContain('.env.local');
    expect(serialized).not.toContain('RUNE_HTTP_SECRET');
    expect(serialized).not.toContain('TELEGRAM_BOT_TOKEN');
  });

  it('rejects a product scope that could escape or alter the MCP registration', () => {
    expect(() => buildProductChatMcpConfig('../rune')).toThrow(/invalid product/i);
  });
});
