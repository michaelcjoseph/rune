/**
 * Test suite for `src/server/mcp-transport.ts` — project 16-claude-app-connector,
 * Phase 2, test-plan.md §6 "Streamable HTTP transport".
 *
 * Written TEST-FIRST: the implementation module does not exist yet.
 * ALL tests in this file are expected to be RED until the implementation lands.
 *
 * Contract under test (future src/server/mcp-transport.ts):
 *
 *   export interface McpTransportOpts {
 *     getServer?: () => McpServer;
 *     verifyBearer?: (req: IncomingMessage) => boolean | Promise<boolean>;
 *   }
 *   export function mountMcpRoute(
 *     opts?: McpTransportOpts,
 *   ): (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;
 *
 * Mechanics:
 *   - Dynamic import via a computed specifier defeats tsc static resolution so
 *     this file is tsc-clean before the module exists.
 *   - Every test calls loadMcpTransport() and asserts the module is present;
 *     when the module is absent each test fails with a clean "implementation pending"
 *     message — never an import crash.
 *   - The integration tests start a tiny local HTTP harness around
 *     mountMcpRoute() and connect a real SDK Client over
 *     StreamableHTTPClientTransport to the ephemeral port. The Rune web server
 *     does not own this mount anymore; src/server/http.test.ts pins that
 *     cutover boundary.
 *   - verifyBearer is stubbed to `() => true` for the §6 happy-path transport
 *     tests so the suite stays green when the OAuth gate (§7) lands separately;
 *     test 6 pins the CLOSED direction (`() => false` → 401) so the gate can
 *     never accidentally default open before §7's full OAuth suite exists.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import http from 'node:http';
import type { IncomingMessage, ServerResponse, Server } from 'node:http';

// ---------------------------------------------------------------------------
// Config mock — vi.hoisted() ensures the value is available inside the
// vi.mock() factory (which vitest hoists to the top of the file before any
// imports are evaluated). Mirrors http.test.ts; adds RUNE_ALLOWED_HOSTS
// (a Set) because isAllowedHost in auth.ts calls config.RUNE_ALLOWED_HOSTS.has().
// ---------------------------------------------------------------------------

const mockConfig = vi.hoisted(() => ({
  HTTP_PORT: 0,
  HTTP_HOST: '127.0.0.1',
  TIMEZONE: 'America/Chicago',
  VAULT_DIR: '/test/vault',
  RUNE_HTTP_SECRET: 'test-secret',
  RUNE_ALLOWED_HOSTS: new Set(['localhost', '127.0.0.1']),
  TELEGRAM_USER_ID: 0,
}));

vi.mock('../config.js', () => ({
  default: mockConfig,
}));

// ---------------------------------------------------------------------------
// Mocks for modules pulled in by http.ts import chain.
// Mirrors http.test.ts exactly for the shared set; adds kb/engine + kb/search
// which are pulled in by mcp/server.ts (via createRuneMcpServer).
// ---------------------------------------------------------------------------

vi.mock('../vault/sessions.js', () => ({
  getAllSessions: vi.fn(() => []),
  deleteSession: vi.fn(),
  transportLabel: (t: string) => (t === 'webview' ? 'webview chat' : 'telegram chat'),
}));
vi.mock('../ai/claude.js', () => ({ summarizeSession: vi.fn(), cleanupSession: vi.fn() }));
vi.mock('../vault/journal.js', () => ({ appendToJournal: vi.fn() }));
vi.mock('../utils/time.js', () => ({ getTimestamp: vi.fn(() => '14:30') }));
vi.mock('../vault/git.js', () => ({ gitCommitAndPush: vi.fn() }));

// Mirrors server.test.ts kb mocks so createRuneMcpServer(APP_SURFACE_TOOLS)
// performs no vault I/O or Claude CLI spawn.
vi.mock('../kb/engine.js', () => ({
  initKB: vi.fn(),
  queryKB: vi.fn().mockResolvedValue({ answer: 'mocked', success: true }),
  ingestSource: vi.fn().mockResolvedValue({ output: 'ok', success: true }),
  lintKB: vi.fn().mockResolvedValue({ report: 'ok', success: true }),
  getKBStats: vi.fn().mockReturnValue({
    totalPages: 0,
    entities: 0,
    concepts: 0,
    topics: 0,
    comparisons: 0,
    recentLog: [],
  }),
}));

vi.mock('../kb/search.js', () => ({
  searchWithFilter: vi.fn().mockReturnValue([]),
}));

// ---------------------------------------------------------------------------
// Static imports (after vi.mock hoisting)
// ---------------------------------------------------------------------------

import { APP_SURFACE_TOOLS } from '../mcp/server.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

// ---------------------------------------------------------------------------
// Local type declarations — mirror the future module's public surface so this
// file is tsc-clean today while the implementation module does not exist.
// These types are used only for casting.
// ---------------------------------------------------------------------------

interface McpTransportOpts {
  getServer?: () => import('@modelcontextprotocol/sdk/server/mcp.js').McpServer;
  verifyBearer?: (req: IncomingMessage) => boolean | Promise<boolean>;
}

type McpRouteHandler = ((
  req: IncomingMessage,
  res: ServerResponse,
) => Promise<boolean>) & {
  closeAll: () => Promise<void>;
  getActiveSessionCount: () => number;
  getSessionStats: () => Array<{ id: string; openedAt: string; lastSeenAt: string }>;
};

// ---------------------------------------------------------------------------
// Dynamic import guard — computed specifier bypasses tsc static resolution.
// ---------------------------------------------------------------------------

const IMPL_PENDING =
  'src/server/mcp-transport.ts not implemented yet — implementation pending';

async function loadMcpTransport(): Promise<Record<string, unknown> | null> {
  const specifier = './mcp-transport' + '.js';
  try {
    return (await import(/* @vite-ignore */ specifier)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Red guard: fails THIS test with a clean "implementation pending" message
 *  while the module is absent. Each red is isolated — never an import crash. */
async function requireMcpTransport(): Promise<void> {
  const mod = await loadMcpTransport();
  if (!mod || typeof mod.mountMcpRoute !== 'function') {
    expect.fail(IMPL_PENDING);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Start a local transport-only HTTP harness and return the port. */
async function startWithMcp(
  mcpOpts: McpTransportOpts,
): Promise<{ server: Server; port: number; mcpHandler: McpRouteHandler }> {
  const mod = await loadMcpTransport();
  if (!mod || typeof mod.mountMcpRoute !== 'function') {
    expect.fail(IMPL_PENDING);
  }

  const mcpHandler = mod.mountMcpRoute(mcpOpts) as McpRouteHandler;
  const server = http.createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (await mcpHandler(req, res)) return;
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }
    res.writeHead(404);
    res.end('Not found');
  });
  server.on('close', () => {
    void mcpHandler.closeAll();
  });
  server.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.on('listening', resolve));
  const port = (server.address() as { port: number }).port;
  return { server, port, mcpHandler };
}

/** Create and connect an SDK Client to the /mcp endpoint at the given port. */
async function connectMcpClient(port: number): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${port}/mcp`),
  );
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await client.connect(transport);
  return client;
}

/** Make a raw HTTP request; resolves { status, body }. */
function rawReq(
  opts: http.RequestOptions & { body?: string },
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const r = http.request(opts, (res) => {
      let body = '';
      res.on('data', (c: Buffer) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode!, body }));
    });
    r.on('error', reject);
    if (opts.body) r.write(opts.body);
    r.end();
  });
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('server/mcp-transport (§6 Streamable HTTP transport)', () => {
  // Track servers opened per-test for afterEach cleanup.
  const openServers: Server[] = [];
  const openClients: Client[] = [];

  afterEach(async () => {
    // Close clients first (they hold the HTTP session open).
    for (const client of openClients.splice(0)) {
      try { await client.close(); } catch { /* ignore */ }
    }
    // Then close servers.
    await Promise.all(
      openServers.splice(0).map(
        (s) => new Promise<void>((resolve) => s.close(() => resolve())),
      ),
    );
  });

  // -------------------------------------------------------------------------
  // Test 1 🔴 — six App-surface tools only; no kb_* admin tools reachable
  //
  // Pins: start a real startHttpServer with { verifyBearer: () => true },
  // connect an SDK Client via StreamableHTTPClientTransport at /mcp,
  // call listTools(), assert sorted names === sorted APP_SURFACE_TOOLS,
  // assert kb_search / kb_ingest / kb_stats / kb_lint are NOT present.
  // -------------------------------------------------------------------------
  it('1: mountMcpRoute exposes exactly APP_SURFACE_TOOLS — no kb_* admin tools reachable', async () => {
    await requireMcpTransport(); // red guard

    const { server, port } = await startWithMcp({ verifyBearer: () => true });
    openServers.push(server);

    const client = await connectMcpClient(port);
    openClients.push(client);

    const { tools } = await client.listTools();
    const toolNames = tools.map((t) => t.name).sort();
    const expectedNames = [...APP_SURFACE_TOOLS].sort();

    expect(toolNames).toEqual(expectedNames);

    // Explicit check: admin-only tools must not appear
    const adminOnly = ['kb_search', 'kb_ingest', 'kb_stats', 'kb_lint'];
    for (const name of adminOnly) {
      expect(toolNames).not.toContain(name);
    }
  });

  // -------------------------------------------------------------------------
  // Test 2 🔴 — session/stream setup works; a second call on the same client
  // succeeds (session persists across calls)
  //
  // The successful initialize handshake in test 1 IS the primary pin; this
  // test additionally asserts that a second listTools() call on the same
  // already-connected client succeeds — the StreamableHTTP session is durable.
  // -------------------------------------------------------------------------
  it('2: session persists — a second listTools() call on the same client succeeds', async () => {
    await requireMcpTransport(); // red guard

    const { server, port } = await startWithMcp({ verifyBearer: () => true });
    openServers.push(server);

    const client = await connectMcpClient(port);
    openClients.push(client);

    // First call (initialize handshake + list)
    const first = await client.listTools();
    expect(first.tools.length).toBeGreaterThan(0);

    // Second call — session must still be alive
    const second = await client.listTools();
    expect(second.tools.map((t) => t.name).sort()).toEqual(
      first.tools.map((t) => t.name).sort(),
    );
  });

  // -------------------------------------------------------------------------
  // Test 3 🔴 — disallowed host rejected at /mcp boundary with status 403
  //
  // Covers BOTH §6 bullets: the 🔴 "session/stream setup conforms to the
  // existing host-allowlisting" contract and the 🟡 "disallowed host is
  // rejected at the /mcp boundary" case. Raw http.request POST to /mcp with
  // Host: evil.example.com. Asserts status === 403 (mirrors what webview.ts
  // returns via reject403 for disallowed hosts on /api/* routes — same
  // isAllowedHost gate, same 403). The MCP handshake must NOT proceed.
  // -------------------------------------------------------------------------
  it('3: disallowed Host header → 403, MCP handshake does not proceed', async () => {
    await requireMcpTransport(); // red guard

    const { server, port } = await startWithMcp({ verifyBearer: () => true });
    openServers.push(server);

    // Send a minimal MCP initialize POST with a disallowed Host header.
    // The body is a valid JSON-RPC initialize request so the transport can't
    // skip it on a malformed-body basis — the rejection must come from the
    // host guard.
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'evil-client', version: '0.0.0' },
      },
    });

    const result = await rawReq({
      host: '127.0.0.1',
      port,
      path: '/mcp',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        'Host': 'evil.example.com',
        'Content-Length': Buffer.byteLength(body).toString(),
      },
      body,
    });

    expect(result.status).toBe(403);
  });

  // -------------------------------------------------------------------------
  // Test 4 🟢 — route coexistence: /mcp does not break existing routes
  //
  // With /mcp mounted, GET /health still returns 200 { status: 'ok' },
  // and an unknown route still 404s.
  // -------------------------------------------------------------------------
  it('4: /mcp coexists with existing routes — /health → 200, /unknown → 404', async () => {
    await requireMcpTransport(); // red guard

    const { server, port } = await startWithMcp({ verifyBearer: () => true });
    openServers.push(server);

    // /health must still work
    const health = await rawReq({ host: '127.0.0.1', port, path: '/health', method: 'GET' });
    expect(health.status).toBe(200);
    expect((JSON.parse(health.body) as { status?: string }).status).toBe('ok');

    // Unknown route must 404
    const notFound = await rawReq({
      host: '127.0.0.1',
      port,
      path: '/no-such-route',
      method: 'GET',
    });
    expect(notFound.status).toBe(404);
  });

  // -------------------------------------------------------------------------
  // Test 5 🟡 — non-MCP paths fall through to the owning HTTP surface.
  //
  // mountMcpRoute handles only /mcp. The standalone daemon or any test harness
  // remains responsible for routing /health, OAuth metadata, and unknown paths.
  // -------------------------------------------------------------------------
  it('5: non-/mcp paths fall through to the owning HTTP server', async () => {
    await requireMcpTransport(); // red guard

    const { server, port } = await startWithMcp({ verifyBearer: () => true });
    openServers.push(server);

    const result = await rawReq({
      host: '127.0.0.1',
      port,
      path: '/not-mcp',
      method: 'GET',
    });

    expect(result.status).toBe(404);
  });

  // -------------------------------------------------------------------------
  // Test 6 🔴 — closed-gate direction: verifyBearer rejecting → 401
  //
  // The §6 happy-path tests stub verifyBearer to () => true; this test pins
  // the OTHER direction so the gate can never accidentally default open
  // before §7's full OAuth suite lands: a verifier that returns false must
  // reject the request BEFORE the transport handles it.
  // -------------------------------------------------------------------------
  it('6: verifyBearer returning false → 401, MCP handshake does not proceed', async () => {
    await requireMcpTransport(); // red guard

    const { server, port } = await startWithMcp({ verifyBearer: () => false });
    openServers.push(server);

    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'no-token-client', version: '0.0.0' },
      },
    });

    const result = await rawReq({
      host: '127.0.0.1',
      port,
      path: '/mcp',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        'Content-Length': Buffer.byteLength(body).toString(),
      },
      body,
    });

    expect(result.status).toBe(401);
  });

  // -------------------------------------------------------------------------
  // Session metadata (getSessionStats) — MCP monitoring redesign, Wave 0.
  // -------------------------------------------------------------------------
  it('7: getSessionStats reports truncated ids and ISO timestamps for live sessions', async () => {
    await requireMcpTransport(); // red guard

    const { server, port, mcpHandler } = await startWithMcp({ verifyBearer: () => true });
    openServers.push(server);

    expect(mcpHandler.getSessionStats()).toEqual([]);

    const client = await connectMcpClient(port);
    openClients.push(client);
    await client.listTools();

    const stats = mcpHandler.getSessionStats();
    expect(stats).toHaveLength(1);
    const stat = stats[0]!;
    expect(stat.id).toHaveLength(8);
    expect(Number.isFinite(Date.parse(stat.openedAt))).toBe(true);
    expect(Number.isFinite(Date.parse(stat.lastSeenAt))).toBe(true);
    expect(Date.parse(stat.lastSeenAt)).toBeGreaterThanOrEqual(Date.parse(stat.openedAt));
  });

  it('8: lastSeenAt advances on a subsequent request while openedAt stays fixed', async () => {
    await requireMcpTransport(); // red guard

    const { server, port, mcpHandler } = await startWithMcp({ verifyBearer: () => true });
    openServers.push(server);

    const client = await connectMcpClient(port);
    openClients.push(client);
    await client.listTools();

    const before = mcpHandler.getSessionStats()[0]!;
    await new Promise((resolve) => setTimeout(resolve, 15));
    await client.listTools();

    const after = mcpHandler.getSessionStats()[0]!;
    expect(after.id).toBe(before.id);
    expect(after.openedAt).toBe(before.openedAt);
    expect(Date.parse(after.lastSeenAt)).toBeGreaterThan(Date.parse(before.lastSeenAt));
  });

  it('9: session metadata is removed on session eviction and on closeAll', async () => {
    await requireMcpTransport(); // red guard

    const { server, port, mcpHandler } = await startWithMcp({ verifyBearer: () => true });
    openServers.push(server);

    // Eviction path: a client DELETE (terminateSession) drops the metadata.
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(transport);
    openClients.push(client);
    await client.listTools();
    expect(mcpHandler.getSessionStats()).toHaveLength(1);

    await transport.terminateSession();
    // The server-side onclose fires asynchronously — poll briefly.
    for (let i = 0; i < 40 && mcpHandler.getSessionStats().length > 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(mcpHandler.getSessionStats()).toEqual([]);

    // closeAll path: a fresh session's metadata is cleared with the transports.
    const client2 = await connectMcpClient(port);
    openClients.push(client2);
    await client2.listTools();
    expect(mcpHandler.getSessionStats()).toHaveLength(1);

    await mcpHandler.closeAll();
    expect(mcpHandler.getSessionStats()).toEqual([]);
    expect(mcpHandler.getActiveSessionCount()).toBe(0);
  });
});
