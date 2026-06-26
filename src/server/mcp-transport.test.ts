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
 * And src/server/http.ts gains an optional second param:
 *   startHttpServer(webviewDeps?, mcpOpts?: McpTransportOpts)
 *   (cast through `as any` below so this file is tsc-clean before the param exists)
 *
 * Mechanics:
 *   - Dynamic import via a computed specifier defeats tsc static resolution so
 *     this file is tsc-clean before the module exists.
 *   - Every test calls loadMcpTransport() and asserts the module is present;
 *     when the module is absent each test fails with a clean "implementation pending"
 *     message — never an import crash.
 *   - The integration tests (1, 2, 4, 5) start startHttpServer() with mcpOpts
 *     and connect a real SDK Client over StreamableHTTPClientTransport to the
 *     ephemeral port, mirroring the http.test.ts pattern.
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
import { startHttpServer } from './http.js';
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

// Cast startHttpServer so the test file is tsc-clean before the optional
// second mcpOpts param exists on startHttpServer's signature.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const startHttpServerAny = startHttpServer as (...args: any[]) => Server;

/** Start an HTTP server with the /mcp route mounted and return the port. */
async function startWithMcp(mcpOpts: McpTransportOpts): Promise<{ server: Server; port: number }> {
  const server = startHttpServerAny(undefined, mcpOpts);
  await new Promise<void>((resolve) => server.on('listening', resolve));
  const port = (server.address() as { port: number }).port;
  return { server, port };
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
  // Test 5 🟡 — /mcp returns 404 when no mcpOpts are provided (opt-in)
  //
  // startHttpServer() with NO mcpOpts arg → /mcp is not mounted; a POST to
  // /mcp returns 404 (the same as any other unknown route).
  // -------------------------------------------------------------------------
  it('5: /mcp returns 404 when mcpOpts not provided — the route is opt-in', async () => {
    await requireMcpTransport(); // red guard

    // Start without mcpOpts — the second param is intentionally omitted.
    const server = startHttpServer();
    await new Promise<void>((resolve) => server.on('listening', resolve));
    const port = (server.address() as { port: number }).port;
    openServers.push(server);

    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test', version: '0.0.0' },
      },
    });

    const result = await rawReq({
      host: '127.0.0.1',
      port,
      path: '/mcp',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body).toString(),
      },
      body,
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
});
