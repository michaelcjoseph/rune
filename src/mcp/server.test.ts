/**
 * Test suite for the MCP server shared factory (project 16, Phase 1 task:
 * "mcp-server-shared-factory").
 *
 * This file is the test-first deliverable — it is expected to be PARTIALLY RED
 * until the factory implementation lands. Specifically:
 *
 *   RED  — contract points 1-3 (MCP server factory, APP_SURFACE_TOOLS,
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

import { beforeEach, describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
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
  searchVault: vi.fn().mockReturnValue([]),
  searchWithFilter: vi.fn().mockReturnValue([]),
  searchRepo: vi.fn().mockReturnValue([]),
}));

vi.mock('../kb/vault-index.js', () => ({
  refreshVaultIndex: vi.fn(),
  getVaultIndexStatus: vi.fn().mockReturnValue({
    ready: true,
    status: 'ready',
    lastRebuild: {
      files: 1,
      lines: 2,
      bytes: 3,
      heapUsed: 4,
      buildMs: 5,
    },
  }),
  queryVaultIndex: vi.fn().mockReturnValue([]),
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

function collectEnumValues(schema: unknown): string[] {
  if (schema === null || typeof schema !== 'object') return [];
  const node = schema as Record<string, unknown>;
  const own = Array.isArray(node.enum) ? node.enum.filter((v): v is string => typeof v === 'string') : [];
  return [
    ...own,
    ...Object.values(node).flatMap((value) => collectEnumValues(value)),
  ];
}

// ─── Helper: look up the not-yet-existing factory export ─────────────────────
//
// Returns undefined while the implementation is pending. Each test performs its
// own typeof guard on the result so a missing export fails only that test.

type RuntimeMcpFactory = (opts: { tools: string[]; name?: string }) => McpServer;

const retiredBrand = ['Jar', 'vis'].join('');
const retiredServerName = `${retiredBrand.toLowerCase()}-kb`;
const renamedFactoryExport = 'createRuneMcpServer';

function getFactory(): RuntimeMcpFactory | undefined {
  return (serverModule as Record<string, unknown>)[renamedFactoryExport] as
    | RuntimeMcpFactory
    | undefined;
}

beforeEach(() => {
  vi.clearAllMocks();
});

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

  it('reports the renamed default server identity as rune-kb', async () => {
    const server = serverModule.createKBServer();
    const client = await connectClient(server);

    expect(client.getServerVersion()).toMatchObject({ name: 'rune-kb' });
    expect(client.getServerVersion()?.name).not.toBe(retiredServerName);

    await client.close();
  });
});

describe('kb_query daemon warm-route boundary', () => {
  it('keeps admin stdio kb_query on the legacy cold queryKB path', async () => {
    const { queryKB } = await import('../kb/engine.js');
    const queryKBMock = queryKB as unknown as ReturnType<typeof vi.fn>;
    queryKBMock.mockResolvedValueOnce({ answer: 'admin cold answer', success: true });

    const server = serverModule.createKBServer();
    const client = await connectClient(server);

    await client.callTool({
      name: 'kb_query',
      arguments: { question: 'admin stdio question' },
    });

    expect(queryKBMock).toHaveBeenCalledTimes(1);
    expect(queryKBMock.mock.calls[0]).toEqual(['admin stdio question']);

    await client.close();
  });

  it('daemon kb_query falls back to cold ripgrep while the warm index is not ready', async () => {
    const createMcpServer = getFactory();
    if (typeof createMcpServer !== 'function') {
      expect.fail(`${renamedFactoryExport} is not exported — implementation pending`);
    }

    const { queryKB } = await import('../kb/engine.js');
    const { searchVault } = await import('../kb/search.js');
    const { getVaultIndexStatus, queryVaultIndex } = await import('../kb/vault-index.js');
    const queryKBMock = queryKB as unknown as ReturnType<typeof vi.fn>;
    const searchVaultMock = searchVault as unknown as ReturnType<typeof vi.fn>;
    const getStatusMock = getVaultIndexStatus as unknown as ReturnType<typeof vi.fn>;
    const queryVaultIndexMock = queryVaultIndex as unknown as ReturnType<typeof vi.fn>;
    const coldHit = [{ file: 'journals/cold.md', line: 4, content: 'COLD_FALLBACK_CONTEXT' }];

    getStatusMock.mockReturnValueOnce({ ready: false, status: 'starting', lastRebuild: null });
    searchVaultMock.mockReturnValueOnce(coldHit);
    let capturedDeps: {
      searchVault?: (
        query: string,
        options?: { directory?: string; maxResults?: number },
      ) => Array<{ file: string; line: number; content: string }>;
    } | undefined;
    let routedHits: Array<{ file: string; line: number; content: string }> | undefined;
    queryKBMock.mockImplementationOnce(async (...args: unknown[]) => {
      capturedDeps = args[1] as typeof capturedDeps;
      if (capturedDeps?.searchVault) {
        routedHits = capturedDeps.searchVault('fallback marker', { maxResults: 3 });
      }
      return { answer: 'cold fallback answer', success: true };
    });

    const server = createMcpServer({ tools: ['kb_query'], name: 'rune-mcp' });
    const client = await connectClient(server);

    const result = await client.callTool({
      name: 'kb_query',
      arguments: { question: 'daemon not ready question' },
    });

    expect(result.isError).toBeFalsy();
    expect(queryKBMock.mock.calls[0]?.[0]).toBe('daemon not ready question');
    expect(capturedDeps?.searchVault).toEqual(expect.any(Function));
    expect(routedHits).toEqual(coldHit);
    expect(searchVaultMock).toHaveBeenCalledWith('fallback marker', { maxResults: 3 });
    expect(queryVaultIndexMock).not.toHaveBeenCalled();

    await client.close();
  });

  it('daemon kb_query uses queryVaultIndex for broad retrieval after readiness', async () => {
    const createMcpServer = getFactory();
    if (typeof createMcpServer !== 'function') {
      expect.fail(`${renamedFactoryExport} is not exported — implementation pending`);
    }

    const { queryKB } = await import('../kb/engine.js');
    const { searchVault } = await import('../kb/search.js');
    const { getVaultIndexStatus, queryVaultIndex } = await import('../kb/vault-index.js');
    const queryKBMock = queryKB as unknown as ReturnType<typeof vi.fn>;
    const searchVaultMock = searchVault as unknown as ReturnType<typeof vi.fn>;
    const getStatusMock = getVaultIndexStatus as unknown as ReturnType<typeof vi.fn>;
    const queryVaultIndexMock = queryVaultIndex as unknown as ReturnType<typeof vi.fn>;
    const warmHit = [{ file: 'knowledge/warm.md', line: 8, content: 'WARM_READY_CONTEXT' }];

    getStatusMock.mockReturnValueOnce({
      ready: true,
      status: 'ready',
      lastRebuild: {
        files: 1,
        lines: 1,
        bytes: 64,
        heapUsed: 128,
        buildMs: 9,
      },
    });
    queryVaultIndexMock.mockReturnValueOnce(warmHit);
    let capturedDeps: {
      searchVault?: (
        query: string,
        options?: { directory?: string; maxResults?: number },
      ) => Array<{ file: string; line: number; content: string }>;
    } | undefined;
    let routedHits: Array<{ file: string; line: number; content: string }> | undefined;
    queryKBMock.mockImplementationOnce(async (...args: unknown[]) => {
      capturedDeps = args[1] as typeof capturedDeps;
      if (capturedDeps?.searchVault) {
        routedHits = capturedDeps.searchVault('warm marker', { maxResults: 5 });
      }
      return { answer: 'warm answer', success: true };
    });

    const server = createMcpServer({ tools: ['kb_query'], name: 'rune-mcp' });
    const client = await connectClient(server);

    const result = await client.callTool({
      name: 'kb_query',
      arguments: { question: 'daemon ready question' },
    });

    expect(result.isError).toBeFalsy();
    expect(queryKBMock.mock.calls[0]?.[0]).toBe('daemon ready question');
    expect(capturedDeps?.searchVault).toEqual(expect.any(Function));
    expect(routedHits).toEqual(warmHit);
    expect(queryVaultIndexMock).toHaveBeenCalledWith('warm marker', { maxResults: 5 });
    expect(searchVaultMock).not.toHaveBeenCalled();

    await client.close();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §1 — Factory: registers exactly the requested tool set
// (🔴 EXPECTED RED until factory is implemented)
// ─────────────────────────────────────────────────────────────────────────────

describe('MCP server factory contract', () => {
  it('export exists and is a function', () => {
    // Clean assertion: if the export is missing this fails with a descriptive
    // message, not a file-level crash.
    expect(
      typeof (serverModule as Record<string, unknown>)[renamedFactoryExport],
      `${renamedFactoryExport} must be exported from src/mcp/server.ts`,
    ).toBe('function');
  });

  it('App-surface opts register exactly the six App tools', async () => {
    const createMcpServer = getFactory();
    if (typeof createMcpServer !== 'function') {
      expect.fail(`${renamedFactoryExport} is not exported — implementation pending`);
    }

    const APP_SURFACE_TOOLS = (serverModule as Record<string, unknown>)['APP_SURFACE_TOOLS'] as string[] | undefined;
    if (!Array.isArray(APP_SURFACE_TOOLS)) {
      expect.fail('APP_SURFACE_TOOLS is not exported — implementation pending');
    }

    const server = createMcpServer({ tools: APP_SURFACE_TOOLS });
    const client = await connectClient(server);

    const names = await listedToolNames(client);
    expect(names).toEqual(
      [...APP_SURFACE_TOOLS].sort(),
    );

    await client.close();
  });

  it('admin opts register exactly the kb_* tools plus repo_search', async () => {
    const createMcpServer = getFactory();
    if (typeof createMcpServer !== 'function') {
      expect.fail(`${renamedFactoryExport} is not exported — implementation pending`);
    }

    const ADMIN_TOOLS = (serverModule as Record<string, unknown>)['ADMIN_TOOLS'] as string[] | undefined;
    if (!Array.isArray(ADMIN_TOOLS)) {
      expect.fail('ADMIN_TOOLS is not exported — implementation pending');
    }

    const server = createMcpServer({ tools: ADMIN_TOOLS });
    const client = await connectClient(server);

    const names = await listedToolNames(client);
    expect(names).toEqual(
      [...ADMIN_TOOLS].sort(),
    );

    await client.close();
  });

  it('reports the renamed MCP server identity as rune-kb by default', async () => {
    const createMcpServer = getFactory();
    if (typeof createMcpServer !== 'function') {
      expect.fail(`${renamedFactoryExport} is not exported — implementation pending`);
    }

    const server = createMcpServer({ tools: ['kb_query'] });
    const client = await connectClient(server);

    expect(client.getServerVersion()).toMatchObject({ name: 'rune-kb' });
    expect(client.getServerVersion()?.name).not.toBe(retiredServerName);

    await client.close();
  });
});

describe('runtime rename — MCP public strings', () => {
  it('uses Rune in tool descriptions and does not expose the retired brand', async () => {
    const server = serverModule.createKBServer();
    const client = await connectClient(server);

    const { tools } = await client.listTools();
    const kbQuery = tools.find((tool) => tool.name === 'kb_query');
    expect(kbQuery?.description).toContain('Rune');
    expect(kbQuery?.description ?? '').not.toMatch(
      new RegExp(`\\b${retiredBrand}\\b|${retiredServerName}`, 'i'),
    );

    await client.close();
  });

  it('registers the renamed MCP server key in Claude settings without a retired alias', () => {
    const settings = JSON.parse(
      readFileSync(new URL('../../.claude/settings.json', import.meta.url), 'utf8'),
    ) as { mcpServers?: Record<string, unknown> };

    const names = Object.keys(settings.mcpServers ?? {});
    expect(names).toContain('rune-kb');
    expect(names).not.toContain(retiredServerName);
  });
});

describe('vault_search App schema — full-vault markdown coverage', () => {
  it('advertises whole-vault markdown search and does not lock types to journals/pages/projects', async () => {
    const createMcpServer = getFactory();
    if (typeof createMcpServer !== 'function') {
      expect.fail(`${renamedFactoryExport} is not exported — implementation pending`);
    }

    const server = createMcpServer({ tools: ['vault_search'] });
    const client = await connectClient(server);

    const { tools } = await client.listTools();
    const vaultSearch = tools.find((tool) => tool.name === 'vault_search');
    expect(vaultSearch, 'vault_search tool must be registered').toBeDefined();

    const description = vaultSearch?.description ?? '';
    expect(description).toMatch(/whole[- ]vault/i);
    expect(description).toMatch(/markdown/i);
    expect(description).not.toMatch(/journals,\s*pages,\s*projects/i);

    const inputSchema = vaultSearch?.inputSchema as unknown;
    const enumValues = collectEnumValues(inputSchema);
    expect(enumValues).not.toEqual(expect.arrayContaining(['journals', 'pages', 'projects']));
    expect(enumValues).toEqual([]);

    const schemaText = JSON.stringify(inputSchema);
    expect(schemaText).toMatch(/top[- ]level/i);
    expect(schemaText).toMatch(/folder/i);
    expect(schemaText).toMatch(/prefix/i);
    expect(schemaText).toMatch(/unknown/i);
    expect(schemaText).toMatch(/ignored?/i);

    await client.close();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §2 — Exported constants
// (🔴 EXPECTED RED until constants are exported)
// ─────────────────────────────────────────────────────────────────────────────

describe('exported constants', () => {
  it('APP_SURFACE_TOOLS is exported and is exactly the six App tools', () => {
    const APP_SURFACE_TOOLS = (serverModule as Record<string, unknown>)['APP_SURFACE_TOOLS'];
    expect(APP_SURFACE_TOOLS, 'APP_SURFACE_TOOLS must be exported').toBeDefined();
    expect(Array.isArray(APP_SURFACE_TOOLS)).toBe(true);

    const names = APP_SURFACE_TOOLS as string[];
    expect(names).toHaveLength(6);
    expect([...names].sort()).toEqual([
      'crm_lookup',
      'get_priorities',
      'kb_query',
      'log_conversation',
      'log_idea',
      'vault_search',
    ]);
    expect(names).not.toContain('refresh_vault_index');
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

describe('refresh_vault_index tool registration — warm-index readiness and stats', () => {
  it('can be registered explicitly and reports readiness/build stats, not vault content', async () => {
    const createMcpServer = getFactory();
    if (typeof createMcpServer !== 'function') {
      expect.fail(`${renamedFactoryExport} is not exported — implementation pending`);
    }

    const server = createMcpServer({ tools: ['refresh_vault_index'] });
    const client = await connectClient(server);

    const names = await listedToolNames(client);
    expect(names).toEqual(['refresh_vault_index']);

    const result = await client.callTool({ name: 'refresh_vault_index', arguments: {} });
    const content = result.content as Array<{ type: string; text: string }>;
    expect(result.isError).toBeFalsy();
    expect(content).toHaveLength(1);
    expect(content[0]?.type).toBe('text');

    const parsed = JSON.parse(content[0]!.text) as {
      ready?: unknown;
      status?: unknown;
      lastRebuild?: {
        files?: unknown;
        lines?: unknown;
        bytes?: unknown;
        heapUsed?: unknown;
        buildMs?: unknown;
      };
    };
    expect(parsed.ready).toEqual(expect.any(Boolean));
    expect(parsed.status).toEqual(expect.any(String));
    expect(parsed.lastRebuild).toMatchObject({
      files: expect.any(Number),
      lines: expect.any(Number),
      bytes: expect.any(Number),
      heapUsed: expect.any(Number),
      buildMs: expect.any(Number),
    });

    const serialized = JSON.stringify(parsed);
    expect(serialized).not.toMatch(/PRIVATE|journal|world-view|knowledge\/.+\.md/i);

    await client.close();
  });

  it('server.ts registers refresh_vault_index through a lazy tool module so admin stdio does not import the warm index', () => {
    const source = readFileSync(new URL('./server.ts', import.meta.url), 'utf8');

    expect(source).toContain('refresh_vault_index');
    expect(source).toMatch(/import\s*\([\s\S]*['"]\.\/tools\/vault-index-tools\.js['"][\s\S]*\)/);
    expect(source).not.toMatch(/from ['"]\.\.\/kb\/vault-index\.js['"]/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §3 — Unknown tool name throws at construction (🟡)
// (🔴 EXPECTED RED until factory is implemented)
// ─────────────────────────────────────────────────────────────────────────────

describe('MCP server factory — unknown tool name', () => {
  it('throws at construction when an unknown tool name is requested', () => {
    const createMcpServer = getFactory();
    if (typeof createMcpServer !== 'function') {
      expect.fail(`${renamedFactoryExport} is not exported — implementation pending`);
    }

    expect(() =>
      createMcpServer({ tools: ['kb_query', 'nonexistent_tool_xyz'] }),
    ).toThrow();
  });

  it('empty tool list throws at construction', () => {
    // An empty tool set is a programming error — a server that exposes nothing
    // is never intentional here. The factory must fail loudly, not silently
    // register zero tools.
    const createMcpServer = getFactory();
    if (typeof createMcpServer !== 'function') {
      expect.fail(`${renamedFactoryExport} is not exported — implementation pending`);
    }

    expect(() => createMcpServer({ tools: [] })).toThrow();
  });
});
