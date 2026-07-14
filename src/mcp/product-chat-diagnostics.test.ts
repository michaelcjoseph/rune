import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { join } from 'node:path';

const diagnostics = vi.hoisted(() => ({
  listRuns: vi.fn(),
  inspectRun: vi.fn(),
  activeRuns: vi.fn(),
}));
const buildDeps = vi.hoisted(() => vi.fn(() => ({ source: 'production' })));

vi.mock('../jobs/work-run-diagnostics.js', () => ({
  createWorkRunDiagnostics: vi.fn((_deps: unknown, product: string) => ({
    listRuns: (input: unknown) => diagnostics.listRuns(product, input),
    inspectRun: (input: unknown) => diagnostics.inspectRun(product, input),
    activeRuns: () => diagnostics.activeRuns(product),
  })),
}));

vi.mock('./tools/cockpit-runs-deps.js', () => ({
  buildProductionWorkRunDiagnosticsDeps: buildDeps,
}));

import { createProductChatServer } from './server.js';

async function connectClient(server: McpServer): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'product-chat-diagnostics-test', version: '1.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

function textResult(result: unknown): { text: string; isError?: boolean } {
  const response = result as { content: Array<{ type: string; text: string }>; isError?: boolean };
  return { text: response.content[0]!.text, ...(response.isError ? { isError: true } : {}) };
}

describe('product-chat diagnostic MCP handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    diagnostics.listRuns.mockReturnValue({ runs: [{ id: 'assay-run-1' }] });
    diagnostics.inspectRun.mockReturnValue({ id: 'assay-run-1', state: 'failed' });
    diagnostics.activeRuns.mockReturnValue({ runs: [{ id: 'assay-active' }] });
  });

  it('uses the server-owned product scope for all three diagnostic tools', async () => {
    const client = await connectClient(createProductChatServer('assay'));
    try {
      const listed = textResult(await client.callTool({
        name: 'cockpit_list_runs',
        arguments: { limit: 3 },
      }));
      const inspected = textResult(await client.callTool({
        name: 'cockpit_inspect_run',
        arguments: { runId: 'assay-run-1', transcriptLines: 7 },
      }));
      const active = textResult(await client.callTool({
        name: 'cockpit_active_runs',
        arguments: {},
      }));

      expect(JSON.parse(listed.text)).toEqual({ runs: [{ id: 'assay-run-1' }] });
      expect(JSON.parse(inspected.text)).toEqual({ id: 'assay-run-1', state: 'failed' });
      expect(JSON.parse(active.text)).toEqual({ runs: [{ id: 'assay-active' }] });
      expect(diagnostics.listRuns).toHaveBeenCalledWith('assay', { limit: 3 });
      expect(diagnostics.inspectRun).toHaveBeenCalledWith('assay', {
        runId: 'assay-run-1',
        transcriptLines: 7,
      });
      expect(diagnostics.activeRuns).toHaveBeenCalledWith('assay');
      expect(buildDeps).toHaveBeenCalledTimes(3);
    } finally {
      await client.close();
    }
  });

  it('returns sanitized model-facing errors from a diagnostic handler', async () => {
    const sensitivePath = join(process.cwd(), 'private.ts');
    diagnostics.inspectRun.mockImplementationOnce(() => {
      throw new Error(`failed at ${sensitivePath} with sk-supersecret123`);
    });
    const client = await connectClient(createProductChatServer('assay'));
    try {
      const result = textResult(await client.callTool({
        name: 'cockpit_inspect_run',
        arguments: { runId: 'assay-run-1' },
      }));

      expect(result.isError).toBe(true);
      expect(result.text).toContain('failed at');
      expect(result.text).not.toContain(sensitivePath);
      expect(result.text).not.toContain('sk-supersecret123');
    } finally {
      await client.close();
    }
  });

  it('rejects an invalid server-owned product scope before registering tools', () => {
    expect(() => createProductChatServer('../assay')).toThrow(/invalid product scope/i);
  });
});
