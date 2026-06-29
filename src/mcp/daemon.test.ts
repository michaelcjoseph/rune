/**
 * Test-first suite for project 19 / W1 Phase 1 task
 * "mcp-standalone-lifecycle".
 *
 * Contract under test:
 * - `src/mcp/daemon.ts` exports `startMcpDaemon(opts)` for testable lifecycle
 *   wiring and is also the `npm run mcp:start` entrypoint.
 * - The daemon owns `/mcp`, OAuth, `/health`, active MCP sessions, and graceful
 *   teardown independently of the Rune cockpit/web process.
 * - The Rune web entrypoint must not own MCP OAuth state or close MCP sessions
 *   during a cockpit restart.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const mockConfig = vi.hoisted(() => ({
  HTTP_PORT: 0,
  HTTP_HOST: '127.0.0.1',
  TIMEZONE: 'America/Chicago',
  VAULT_DIR: '/test/vault',
  RUNE_HTTP_SECRET: 'web-secret',
  MCP_ISSUER_URL: 'https://web.example.invalid',
  RUNE_ALLOWED_HOSTS: new Set(['localhost', '127.0.0.1']),
  TELEGRAM_USER_ID: 0,
  LOGS_DIR: '/tmp/rune-test-logs',
  get MCP_OAUTH_STORE_FILE() {
    return join(this.LOGS_DIR, 'web-mcp-oauth-store.json');
  },
}));

vi.mock('../config.js', () => ({
  default: mockConfig,
}));

vi.mock('../vault/sessions.js', () => ({
  getAllSessions: vi.fn(() => []),
  deleteSession: vi.fn(),
  transportLabel: (t: string) => (t === 'webview' ? 'webview chat' : 'telegram chat'),
}));
vi.mock('../ai/claude.js', () => ({ summarizeSession: vi.fn(), cleanupSession: vi.fn() }));
vi.mock('../vault/journal.js', () => ({ appendToJournal: vi.fn() }));
vi.mock('../utils/time.js', () => ({ getTimestamp: vi.fn(() => '14:30') }));
vi.mock('../vault/git.js', () => ({ gitCommitAndPush: vi.fn() }));

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

import { startHttpServer } from '../server/http.js';

interface StartMcpDaemonOptions {
  host: string;
  port: number;
  gateSecret: string;
  userId: string;
  issuerBaseUrl?: string;
  oauthStoreFile: string;
  tokenTtlMs?: number | null;
}

interface McpDaemonHandle {
  host: string;
  port: number;
  url: string;
  stop(): Promise<void>;
  getStatus(): {
    status: string;
    activeSessions: number;
  };
}

type StartMcpDaemon = (opts: StartMcpDaemonOptions) => Promise<McpDaemonHandle>;

const IMPL_PENDING = 'src/mcp/daemon.ts not implemented yet — implementation pending';

async function requireStartMcpDaemon(): Promise<StartMcpDaemon> {
  const specifier = './daemon' + '.js';
  try {
    const mod = (await import(/* @vite-ignore */ specifier)) as Record<string, unknown>;
    if (typeof mod.startMcpDaemon === 'function') {
      return mod.startMcpDaemon as StartMcpDaemon;
    }
  } catch {
    // fall through to the clean red failure
  }
  expect.fail(IMPL_PENDING);
}

interface RawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function rawReq(opts: http.RequestOptions & { body?: string }): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const r = http.request(opts, (res) => {
      let body = '';
      res.on('data', (c: Buffer) => (body += c));
      res.on('end', () =>
        resolve({
          status: res.statusCode!,
          headers: res.headers as Record<string, string | string[] | undefined>,
          body,
        }),
      );
    });
    r.on('error', reject);
    if (opts.body) r.write(opts.body);
    r.end();
  });
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function startWebOnce(): Promise<Server> {
  const server = startHttpServer();
  await new Promise<void>((resolve) => server.on('listening', resolve));
  return server;
}

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function pkceChallenge(verifier: string): string {
  return base64url(createHash('sha256').update(verifier).digest());
}

function randomVerifier(): string {
  return base64url(randomBytes(32));
}

async function registerClient(baseUrl: string): Promise<string> {
  const body = JSON.stringify({
    redirect_uris: ['http://localhost:9999/cb'],
    client_name: 'claude-app-test',
  });
  const res = await rawReq({
    host: '127.0.0.1',
    port: Number(new URL(baseUrl).port),
    path: '/mcp/oauth/register',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body).toString(),
    },
    body,
  });
  expect(res.status).toBe(201);
  return (JSON.parse(res.body) as { client_id: string }).client_id;
}

async function issueAccessToken(baseUrl: string, gateSecret: string): Promise<string> {
  const port = Number(new URL(baseUrl).port);
  const clientId = await registerClient(baseUrl);
  const verifier = randomVerifier();
  const state = 'daemon-lifecycle-state';
  const authBody = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: 'http://localhost:9999/cb',
    state,
    code_challenge: pkceChallenge(verifier),
    code_challenge_method: 'S256',
    secret: gateSecret,
  }).toString();
  const authRes = await rawReq({
    host: '127.0.0.1',
    port,
    path: '/mcp/oauth/authorize',
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(authBody).toString(),
    },
    body: authBody,
  });
  expect(authRes.status).toBe(302);
  const location = authRes.headers['location'] as string;
  const redirect = new URL(location);
  expect(redirect.searchParams.get('state')).toBe(state);
  const code = redirect.searchParams.get('code');
  expect(code).toBeTruthy();

  const tokenBody = new URLSearchParams({
    grant_type: 'authorization_code',
    code: code!,
    code_verifier: verifier,
    client_id: clientId,
    redirect_uri: 'http://localhost:9999/cb',
  }).toString();
  const tokenRes = await rawReq({
    host: '127.0.0.1',
    port,
    path: '/mcp/oauth/token',
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(tokenBody).toString(),
    },
    body: tokenBody,
  });
  expect(tokenRes.status).toBe(200);
  return (JSON.parse(tokenRes.body) as { access_token: string }).access_token;
}

async function connectClient(baseUrl: string, accessToken: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
  });
  const client = new Client({ name: 'daemon-lifecycle-test', version: '1.0.0' });
  await client.connect(transport);
  return client;
}

describe('mcp-standalone-lifecycle (project 19 / W1 Phase 1)', () => {
  const daemons: McpDaemonHandle[] = [];
  const clients: Client[] = [];
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const client of clients.splice(0)) {
      try { await client.close(); } catch { /* ignore */ }
    }
    for (const daemon of daemons.splice(0)) {
      try { await daemon.stop(); } catch { /* ignore */ }
    }
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('declares a separate mcp:start process and removes MCP ownership from the web entrypoint', () => {
    const packageJson = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { scripts?: Record<string, string> };
    const mcpStart = packageJson.scripts?.['mcp:start'];
    expect(mcpStart, 'package.json must define an mcp:start script').toBeDefined();
    expect(mcpStart).toMatch(/src\/mcp\/daemon\.ts/);

    const indexSource = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
    expect(indexSource).not.toMatch(/createMcpOAuth|readOAuthStore|writeOAuthStore/);
    expect(indexSource).not.toContain('MCP_OAUTH_STORE_FILE');
    expect(indexSource).not.toContain('closeMcpSessions');
    expect(indexSource).not.toMatch(/startHttpServer\([^)]*mcpOauth/s);
  });

  it('starts a daemon with a service-only /health endpoint and no cockpit routes', async () => {
    const startMcpDaemon = await requireStartMcpDaemon();
    const dir = mkdtempSync(join(tmpdir(), 'rune-mcp-daemon-'));
    tempDirs.push(dir);

    const daemon = await startMcpDaemon({
      host: '127.0.0.1',
      port: 0,
      gateSecret: 'mcp-gate',
      userId: 'alice',
      oauthStoreFile: join(dir, 'rune-mcp-oauth-store.json'),
      tokenTtlMs: null,
    });
    daemons.push(daemon);

    expect(daemon.host).toBe('127.0.0.1');
    expect(daemon.port).toBeGreaterThan(0);

    const health = await rawReq({
      host: '127.0.0.1',
      port: daemon.port,
      path: '/health',
      method: 'GET',
    });
    expect(health.status).toBe(200);
    const body = JSON.parse(health.body) as {
      status?: string;
      service?: string;
      uptime?: number;
      oauth?: { configured?: boolean };
      activeSessions?: number;
      warmIndex?: { ready?: boolean; lastRebuild?: unknown };
      recentLogs?: unknown[];
      logPointers?: unknown;
    };
    expect(body.service).toBe('rune-mcp');
    expect(body.status).toMatch(/^(ok|starting|degraded)$/);
    expect(typeof body.uptime).toBe('number');
    expect(body.oauth?.configured).toBe(true);
    expect(body.activeSessions).toBe(0);
    expect(typeof body.warmIndex?.ready).toBe('boolean');
    expect('lastRebuild' in (body.warmIndex ?? {})).toBe(true);
    expect(Array.isArray(body.recentLogs) || body.logPointers !== undefined).toBe(true);

    expect(health.body).not.toContain('PRIVATE_HEALTH_MARKER_ZZ');
    expect(health.body).not.toContain('capture-sessions');

    for (const path of ['/capture-sessions', '/oauth/whoop', '/api/products']) {
      const res = await rawReq({
        host: '127.0.0.1',
        port: daemon.port,
        path,
        method: path === '/capture-sessions' ? 'POST' : 'GET',
      });
      expect(res.status).toBe(404);
    }
  });

  it('keeps MCP OAuth store and session alive across a cockpit web restart', async () => {
    const startMcpDaemon = await requireStartMcpDaemon();
    const dir = mkdtempSync(join(tmpdir(), 'rune-mcp-daemon-'));
    tempDirs.push(dir);
    const oauthStoreFile = join(dir, 'rune-mcp-oauth-store.json');

    const daemon = await startMcpDaemon({
      host: '127.0.0.1',
      port: 0,
      gateSecret: 'mcp-gate',
      userId: 'alice',
      oauthStoreFile,
      tokenTtlMs: null,
    });
    daemons.push(daemon);

    const token = await issueAccessToken(daemon.url, 'mcp-gate');
    const client = await connectClient(daemon.url, token);
    clients.push(client);
    await expect(client.listTools()).resolves.toHaveProperty('tools');

    expect(existsSync(oauthStoreFile)).toBe(true);
    const beforeContent = readFileSync(oauthStoreFile, 'utf8');
    const beforeMtime = statSync(oauthStoreFile).mtimeMs;
    const beforeSessions = daemon.getStatus().activeSessions;
    expect(beforeSessions).toBeGreaterThan(0);

    const webA = await startWebOnce();
    await closeServer(webA);
    const webB = await startWebOnce();
    await closeServer(webB);

    expect(readFileSync(oauthStoreFile, 'utf8')).toBe(beforeContent);
    expect(statSync(oauthStoreFile).mtimeMs).toBe(beforeMtime);
    expect(daemon.getStatus().activeSessions).toBe(beforeSessions);
    await expect(client.listTools()).resolves.toHaveProperty('tools');

    const healthAfter = await rawReq({
      host: '127.0.0.1',
      port: daemon.port,
      path: '/health',
      method: 'GET',
    });
    expect(healthAfter.status).toBe(200);
    expect(healthAfter.body).not.toContain(token);
  });

  it('gracefully tears down MCP sessions and closes the health listener', async () => {
    const startMcpDaemon = await requireStartMcpDaemon();
    const dir = mkdtempSync(join(tmpdir(), 'rune-mcp-daemon-'));
    tempDirs.push(dir);

    const daemon = await startMcpDaemon({
      host: '127.0.0.1',
      port: 0,
      gateSecret: 'mcp-gate',
      userId: 'alice',
      oauthStoreFile: join(dir, 'rune-mcp-oauth-store.json'),
      tokenTtlMs: null,
    });
    daemons.push(daemon);

    const token = await issueAccessToken(daemon.url, 'mcp-gate');
    const client = await connectClient(daemon.url, token);
    clients.push(client);
    expect(daemon.getStatus().activeSessions).toBeGreaterThan(0);

    await daemon.stop();
    daemons.splice(daemons.indexOf(daemon), 1);
    expect(daemon.getStatus().activeSessions).toBe(0);

    await expect(
      rawReq({
        host: '127.0.0.1',
        port: daemon.port,
        path: '/health',
        method: 'GET',
      }),
    ).rejects.toBeTruthy();

    await expect(client.listTools()).rejects.toBeTruthy();
    await expect(daemon.stop()).resolves.toBeUndefined();
  });
});
