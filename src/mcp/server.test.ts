/**
 * Test suite for the MCP server shared factory (project 16, Phase 1 task:
 * "mcp-server-shared-factory").
 *
 * This file is the test-first deliverable — it is expected to be PARTIALLY RED
 * until the factory implementation lands. Specifically:
 *
 *   RED  — contract points 1-3 (createJarvisMcpServer, APP_SURFACE_TOOLS,
 *           ADMIN_TOOLS constants): the export does not exist yet.
 *   RED/GREEN — contract point 4 (admin search surface pins): these exercise
 *               createKBServer() as the chat MCP surface evolves.
 *
 * Mechanics:
 *   - vi.mock stubs '../kb/engine.js' and '../kb/search.js' so no vault I/O
 *     or Claude CLI spawn occurs.
 *   - Factory tests import via `import * as serverModule` so a missing export
 *     never causes a file-level crash that would also take down the passing pins.
 *   - Tool enumeration uses a real Client connected to the McpServer over
 *     InMemoryTransport so the assertions are behavioural (what the SDK hands
 *     back), not white-box (peeking at internal _registeredTools).
 */

import { describe, it, expect, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

// ─── Mock KB engine and search so no vault I/O or Claude CLI runs ────────────

vi.mock('../kb/engine.js', () => ({
  initKB: vi.fn(),
  queryKB: vi.fn().mockResolvedValue({ answer: 'mocked answer', success: true }),
  ingestSource: vi.fn().mockResolvedValue({ output: 'ingested', success: true }),
  lintKB: vi.fn().mockResolvedValue({ report: 'all good', success: true }),
  getKBStats: vi.fn().mockReturnValue({
    totalPages: 5,
    entities: 1,
    concepts: 2,
    topics: 1,
    comparisons: 1,
    recentLog: ['2024-01-01 ingest ok'],
  }),
}));

vi.mock('../kb/search.js', () => ({
  searchWithFilter: vi.fn().mockReturnValue([]),
  searchRepo: vi.fn().mockReturnValue([]),
}));

// ─── Lazy module import (after mocks are hoisted) ────────────────────────────

// Use a namespace import so that accessing a missing export is a runtime check
// (undefined) rather than a compile-time-only error that would never blow up
// a test file. This keeps the RED factory tests isolated from the GREEN admin pins.
import * as serverModule from './server.js';

// ─── Helper: connect an McpServer to an in-memory Client ─────────────────────

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

async function connectClient(server: McpServer): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return client;
}

// ─── Helper: extract just the tool names from listTools() ────────────────────

async function listedToolNames(client: Client): Promise<string[]> {
  const { tools } = await client.listTools();
  return tools.map((t) => t.name).sort();
}

// ─── Helper: look up the not-yet-existing factory export ─────────────────────
//
// Returns undefined while the implementation is pending. Each test performs its
// own typeof guard on the result so a missing export fails only that test.

type JarvisMcpFactory = (opts: { tools: string[] }) => McpServer;

function getFactory(): JarvisMcpFactory | undefined {
  return (serverModule as Record<string, unknown>)['createJarvisMcpServer'] as
    | JarvisMcpFactory
    | undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// §4 — Admin search surface pins
//
// These run against createKBServer() and pin the local chat/search tool surface:
// existing KB tools stay present, and product chat gains repo_search.
// ─────────────────────────────────────────────────────────────────────────────

describe('createKBServer — repo plus KB search pins', () => {
  it('exposes the existing kb_* tools plus repo_search for product chat', async () => {
    const server = serverModule.createKBServer();
    const client = await connectClient(server);

    const names = await listedToolNames(client);
    expect(names).toEqual(
      ['kb_ingest', 'kb_lint', 'kb_query', 'kb_search', 'kb_stats', 'repo_search'],
    );

    await client.close();
  });

  it('kb_query returns the standard MCP text-content shape on success', async () => {
    const { queryKB } = await import('../kb/engine.js');
    vi.mocked(queryKB).mockResolvedValueOnce({ answer: 'The capital is Paris.', success: true });

    const server = serverModule.createKBServer();
    const client = await connectClient(server);

    const result = await client.callTool({ name: 'kb_query', arguments: { question: 'What is the capital of France?' } });

    const content = result.content as Array<{ type: string; text: string }>;
    expect(content).toHaveLength(1);
    expect(content[0]).toMatchObject({ type: 'text', text: 'The capital is Paris.' });
    expect(result.isError).toBeFalsy();

    await client.close();
  });

  it('kb_query sets isError:true when queryKB reports failure', async () => {
    const { queryKB } = await import('../kb/engine.js');
    vi.mocked(queryKB).mockResolvedValueOnce({ answer: 'KB not initialised.', success: false });

    const server = serverModule.createKBServer();
    const client = await connectClient(server);

    const result = await client.callTool({ name: 'kb_query', arguments: { question: 'anything' } });

    const content = result.content as Array<{ type: string; text: string }>;
    expect(result.isError).toBe(true);
    expect(content[0]).toMatchObject({ type: 'text', text: 'KB not initialised.' });

    await client.close();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §1 — Factory: createJarvisMcpServer registers exactly the requested tool set
// (🔴 EXPECTED RED until factory is implemented)
// ─────────────────────────────────────────────────────────────────────────────

describe('createJarvisMcpServer — factory contract', () => {
  it('export exists and is a function', () => {
    // Clean assertion: if the export is missing this fails with a descriptive
    // message, not a file-level crash.
    expect(
      typeof (serverModule as Record<string, unknown>)['createJarvisMcpServer'],
      'createJarvisMcpServer must be exported from src/mcp/server.ts',
    ).toBe('function');
  });

  it('App-surface opts register exactly the six App tools', async () => {
    const createJarvisMcpServer = getFactory();
    if (typeof createJarvisMcpServer !== 'function') {
      expect.fail('createJarvisMcpServer is not exported — implementation pending');
    }

    const APP_SURFACE_TOOLS = (serverModule as Record<string, unknown>)['APP_SURFACE_TOOLS'] as string[] | undefined;
    if (!Array.isArray(APP_SURFACE_TOOLS)) {
      expect.fail('APP_SURFACE_TOOLS is not exported — implementation pending');
    }

    const server = createJarvisMcpServer({ tools: APP_SURFACE_TOOLS });
    const client = await connectClient(server);

    const names = await listedToolNames(client);
    expect(names).toEqual(
      [...APP_SURFACE_TOOLS].sort(),
    );

    await client.close();
  });

  it('admin opts register exactly the kb_* tools plus repo_search', async () => {
    const createJarvisMcpServer = getFactory();
    if (typeof createJarvisMcpServer !== 'function') {
      expect.fail('createJarvisMcpServer is not exported — implementation pending');
    }

    const ADMIN_TOOLS = (serverModule as Record<string, unknown>)['ADMIN_TOOLS'] as string[] | undefined;
    if (!Array.isArray(ADMIN_TOOLS)) {
      expect.fail('ADMIN_TOOLS is not exported — implementation pending');
    }

    const server = createJarvisMcpServer({ tools: ADMIN_TOOLS });
    const client = await connectClient(server);

    const names = await listedToolNames(client);
    expect(names).toEqual(
      [...ADMIN_TOOLS].sort(),
    );

    await client.close();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §2 — Exported constants
// (🔴 EXPECTED RED until constants are exported)
// ─────────────────────────────────────────────────────────────────────────────

describe('exported constants', () => {
  it('APP_SURFACE_TOOLS is exported and contains exactly the six App tools', () => {
    const APP_SURFACE_TOOLS = (serverModule as Record<string, unknown>)['APP_SURFACE_TOOLS'];
    expect(APP_SURFACE_TOOLS, 'APP_SURFACE_TOOLS must be exported').toBeDefined();
    expect(Array.isArray(APP_SURFACE_TOOLS)).toBe(true);

    const names = APP_SURFACE_TOOLS as string[];
    expect(names).toHaveLength(6);
    expect(names).toContain('kb_query');
    expect(names).toContain('vault_search');
    expect(names).toContain('log_idea');
    expect(names).toContain('crm_lookup');
    expect(names).toContain('get_priorities');
    expect(names).toContain('log_conversation');
  });

  it('ADMIN_TOOLS is exported and contains the kb_* tools plus repo_search', () => {
    const ADMIN_TOOLS = (serverModule as Record<string, unknown>)['ADMIN_TOOLS'];
    expect(ADMIN_TOOLS, 'ADMIN_TOOLS must be exported').toBeDefined();
    expect(Array.isArray(ADMIN_TOOLS)).toBe(true);

    const names = ADMIN_TOOLS as string[];
    expect(names).toHaveLength(6);
    expect(names).toContain('kb_query');
    expect(names).toContain('kb_search');
    expect(names).toContain('repo_search');
    expect(names).toContain('kb_ingest');
    expect(names).toContain('kb_stats');
    expect(names).toContain('kb_lint');
  });

  it('APP_SURFACE_TOOLS and ADMIN_TOOLS are distinct sets', () => {
    const APP_SURFACE_TOOLS = (serverModule as Record<string, unknown>)['APP_SURFACE_TOOLS'] as string[] | undefined;
    const ADMIN_TOOLS = (serverModule as Record<string, unknown>)['ADMIN_TOOLS'] as string[] | undefined;

    if (!Array.isArray(APP_SURFACE_TOOLS) || !Array.isArray(ADMIN_TOOLS)) {
      expect.fail('Both APP_SURFACE_TOOLS and ADMIN_TOOLS must be exported — implementation pending');
    }

    // kb_query appears in both sets: the App surface re-registers the existing KB
    // query tool (spec "MCP server factory" section), while ADMIN_TOOLS keeps the
    // admin kb_* set. The two sets must nonetheless not be identical.
    const appSet = new Set(APP_SURFACE_TOOLS);
    const adminSet = new Set(ADMIN_TOOLS);
    const identical = appSet.size === adminSet.size && [...appSet].every((t) => adminSet.has(t));
    expect(identical, 'APP_SURFACE_TOOLS and ADMIN_TOOLS must not be identical sets').toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §3 — Unknown tool name throws at construction (🟡)
// (🔴 EXPECTED RED until factory is implemented)
// ─────────────────────────────────────────────────────────────────────────────

describe('createJarvisMcpServer — unknown tool name', () => {
  it('throws at construction when an unknown tool name is requested', () => {
    const createJarvisMcpServer = getFactory();
    if (typeof createJarvisMcpServer !== 'function') {
      expect.fail('createJarvisMcpServer is not exported — implementation pending');
    }

    expect(() =>
      createJarvisMcpServer({ tools: ['kb_query', 'nonexistent_tool_xyz'] }),
    ).toThrow();
  });

  it('empty tool list throws at construction', () => {
    // An empty tool set is a programming error — a server that exposes nothing
    // is never intentional here. The factory must fail loudly, not silently
    // register zero tools.
    const createJarvisMcpServer = getFactory();
    if (typeof createJarvisMcpServer !== 'function') {
      expect.fail('createJarvisMcpServer is not exported — implementation pending');
    }

    expect(() => createJarvisMcpServer({ tools: [] })).toThrow();
  });
});
