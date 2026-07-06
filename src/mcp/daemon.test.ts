/**
 * Test-first suite for project 19 / W1 Phase 1 task
 * "mcp-daemon-entrypoint".
 *
 * Contract under test:
 * - package.json exposes `npm run mcp:start` and points it at
 *   `src/mcp/daemon.ts`.
 * - `src/mcp/daemon.ts` exports `startMcpDaemon(opts)` so the daemon can be
 *   exercised without shelling out.
 * - The daemon starts only the standalone MCP HTTP service: `/health` for
 *   daemon status and Streamable HTTP MCP at `/mcp`.
 * - It does not boot Telegram, the cockpit/webview routes, the scheduler, or
 *   Whoop OAuth routes in this process.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sideEffects = vi.hoisted(() => ({
  createBot: vi.fn(() => {
    throw new Error('Telegram bot must not boot in the MCP daemon');
  }),
  wireHandlers: vi.fn(),
  startScheduler: vi.fn(() => {
    throw new Error('scheduler must not boot in the MCP daemon');
  }),
  startStallCheck: vi.fn(() => {
    throw new Error('stall check must not boot in the MCP daemon');
  }),
  startWatcher: vi.fn(() => {
    throw new Error('vault watcher must not boot in the MCP daemon');
  }),
}));

const mockConfig = vi.hoisted(() => ({
  HTTP_HOST: '127.0.0.1',
  HTTP_PORT: 0,
  TIMEZONE: 'America/Chicago',
  VAULT_DIR: '/test/vault',
  LOGS_DIR: '/tmp/rune-test-logs',
  RUNE_HTTP_SECRET: 'web-secret',
  TELEGRAM_USER_ID: 42,
  RUNE_ALLOWED_HOSTS: new Set(['localhost', '127.0.0.1']),
  RUNE_MCP_SECRET: 'mcp-gate',
  RUNE_MCP_ISSUER_URL: 'https://mcp.example.invalid',
  RUNE_MCP_HOST: '127.0.0.1',
  RUNE_MCP_PORT: 0,
  RUNE_MCP_OAUTH_STORE_FILE: '/tmp/rune-test-logs/rune-mcp-oauth-store.json',
}));

const warmIndex = vi.hoisted(() => ({
  buildVaultIndex: vi.fn(),
  refreshVaultIndex: vi.fn(),
  getVaultIndexStatus: vi.fn(() => ({
    ready: false,
    status: 'starting',
    lastRebuild: null,
  })),
  queryVaultIndex: vi.fn(() => []),
}));

vi.mock('../config.js', () => ({
  default: mockConfig,
}));

vi.mock('../kb/vault-index.js', () => warmIndex);

vi.mock('../bot/telegram.js', () => ({
  createBot: sideEffects.createBot,
  wireHandlers: sideEffects.wireHandlers,
}));

vi.mock('../jobs/scheduler.js', () => ({
  startScheduler: sideEffects.startScheduler,
  stopScheduler: vi.fn(),
}));

vi.mock('../jobs/stall-check-runner.js', () => ({
  startStallCheck: sideEffects.startStallCheck,
  stopStallCheck: vi.fn(),
}));

vi.mock('../vault/watcher.js', () => ({
  startWatcher: sideEffects.startWatcher,
  stopWatcher: vi.fn(),
}));

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
    recentLog: ['PKMS_HEALTH_MUST_NOT_LEAK_FROM_KB_STATS'],
  }),
}));

vi.mock('../kb/search.js', () => ({
  searchWithFilter: vi.fn().mockReturnValue([]),
  searchRepo: vi.fn().mockReturnValue([]),
}));

vi.mock('../vault/sessions.js', () => ({
  getAllSessions: vi.fn(() => []),
}));

vi.mock('../jobs/capture.js', () => ({
  captureSessions: vi.fn().mockResolvedValue({ captured: 0 }),
}));

vi.mock('../integrations/whoop/client.js', () => ({
  isConfigured: vi.fn(() => false),
  exchangeCode: vi.fn(),
  verifyOAuthState: vi.fn(() => false),
}));

vi.mock('../server/webview.js', () => ({
  mountWebviewRoutes: vi.fn(() => vi.fn(async () => false)),
}));

import { APP_SURFACE_TOOLS, CONTENT_TOOLS } from './server.js';

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
    service: string;
    status: string;
    activeSessions: number;
  };
}

type StartMcpDaemon = (opts: StartMcpDaemonOptions) => Promise<McpDaemonHandle>;

interface RawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function rawReq(opts: http.RequestOptions & { body?: string }): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request({ ...opts, agent: false }, (res) => {
      let body = '';
      res.on('data', (chunk: Buffer) => {
        body += chunk;
      });
      res.on('end', () => {
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers as Record<string, string | string[] | undefined>,
          body,
        });
      });
    });
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
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

function formBody(params: Record<string, string>): string {
  return new URLSearchParams(params).toString();
}

function parseLocation(location: string): URL {
  return new URL(location.startsWith('http') ? location : `http://127.0.0.1${location}`);
}

function parseJsonRpcBody(body: string): Record<string, unknown> {
  const trimmed = body.trim();
  if (trimmed.startsWith('{')) {
    return JSON.parse(trimmed) as Record<string, unknown>;
  }
  const dataLine = trimmed.split('\n').find((line) => line.startsWith('data:'));
  if (dataLine) {
    return JSON.parse(dataLine.slice('data:'.length).trim()) as Record<string, unknown>;
  }
  expect.fail(`Expected a JSON-RPC response body, got: ${trimmed.slice(0, 120)}`);
}

function closeWebServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

async function registerOAuthClient(port: number): Promise<string> {
  const body = JSON.stringify({
    redirect_uris: ['http://localhost:9999/callback'],
    client_name: 'claude-app',
  });
  const res = await rawReq({
    host: '127.0.0.1',
    port,
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

async function postAuthorize(
  port: number,
  params: Record<string, string>,
  secret: string,
): Promise<RawResponse> {
  const body = formBody({ ...params, secret });
  return rawReq({
    host: '127.0.0.1',
    port,
    path: '/mcp/oauth/authorize',
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(body).toString(),
    },
    body,
  });
}

async function exchangeCodeForToken(
  port: number,
  params: Record<string, string> & { client_id: string; redirect_uri: string },
  code: string,
  verifier: string,
): Promise<string> {
  const body = formBody({
    grant_type: 'authorization_code',
    client_id: params.client_id,
    redirect_uri: params.redirect_uri,
    code,
    code_verifier: verifier,
  });
  const res = await rawReq({
    host: '127.0.0.1',
    port,
    path: '/mcp/oauth/token',
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(body).toString(),
    },
    body,
  });
  expect(res.status).toBe(200);
  const parsed = JSON.parse(res.body) as { access_token: string; token_type: string };
  expect(parsed.token_type).toBe('Bearer');
  expect(parsed.access_token).toEqual(expect.any(String));
  return parsed.access_token;
}

async function issueDaemonBearerToken(port: number, gateSecret: string): Promise<string> {
  const clientId = await registerOAuthClient(port);
  const verifier = randomVerifier();
  const state = 'state-for-daemon-store-split';
  const authorizeParams = {
    response_type: 'code',
    client_id: clientId,
    redirect_uri: 'http://localhost:9999/callback',
    code_challenge: pkceChallenge(verifier),
    code_challenge_method: 'S256',
    state,
  };

  const authorize = await postAuthorize(port, authorizeParams, gateSecret);
  expect(authorize.status).toBe(302);
  const location = authorize.headers['location'];
  expect(typeof location).toBe('string');
  const locationUrl = parseLocation(location as string);
  expect(locationUrl.searchParams.get('state')).toBe(state);
  const code = locationUrl.searchParams.get('code');
  expect(code).toEqual(expect.any(String));
  return exchangeCodeForToken(port, authorizeParams, code as string, verifier);
}

async function requireStartMcpDaemon(): Promise<StartMcpDaemon> {
  const specifier = './daemon' + '.js';
  try {
    const mod = (await import(/* @vite-ignore */ specifier)) as Record<string, unknown>;
    if (typeof mod.startMcpDaemon === 'function') {
      return mod.startMcpDaemon as StartMcpDaemon;
    }
    expect.fail('src/mcp/daemon.ts must export startMcpDaemon(opts)');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    expect.fail(`src/mcp/daemon.ts must exist and export startMcpDaemon(opts): ${message}`);
  }
}

describe('mcp-daemon-entrypoint (project 19 / W1 Phase 1)', () => {
  const daemons: McpDaemonHandle[] = [];
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const daemon of daemons.splice(0)) {
      try {
        await daemon.stop();
      } catch {
        // Tests should report their assertion failure, not cleanup noise.
      }
    }
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
    vi.clearAllMocks();
    warmIndex.getVaultIndexStatus.mockReturnValue({
      ready: false,
      status: 'starting',
      lastRebuild: null,
    });
  });

  it('declares npm run mcp:start as the standalone daemon command', () => {
    const packageJson = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { scripts?: Record<string, string> };

    const command = packageJson.scripts?.['mcp:start'];
    expect(command, 'package.json must define scripts["mcp:start"]').toBeDefined();
    expect(command).toMatch(/\bnode\b/);
    expect(command).toContain('--import ./scripts/register-ts.mjs');
    expect(command).toContain('--env-file-if-exists=.env.local');
    expect(command).toMatch(/\bsrc\/mcp\/daemon\.ts\b/);
    expect(command).not.toMatch(/\bsrc\/index\.ts\b/);
  });

  it('provides a standalone daemon module without importing the Rune web entrypoint', () => {
    const daemonPath = new URL('./daemon.ts', import.meta.url);
    expect(existsSync(daemonPath), 'src/mcp/daemon.ts must exist').toBe(true);

    const source = readFileSync(daemonPath, 'utf8');
    expect(source).toMatch(/startMcpDaemon/);
    expect(source).not.toMatch(/from ['"]\.\.\/index\.js['"]/);
    expect(source).not.toMatch(/from ['"]\.\.\/bot\/telegram\.js['"]/);
    expect(source).not.toMatch(/from ['"]\.\.\/jobs\/scheduler\.js['"]/);
    expect(source).not.toMatch(/from ['"]\.\.\/server\/webview\.js['"]/);
    expect(source).not.toMatch(/from ['"]\.\.\/integrations\/whoop\/client\.js['"]/);
  });

  it('owns the warm-index startup build and 15-minute refresh cadence in the daemon process', () => {
    const daemonPath = new URL('./daemon.ts', import.meta.url);
    const source = readFileSync(daemonPath, 'utf8');

    expect(source).toMatch(/from ['"]\.\.\/kb\/vault-index\.js['"]/);
    expect(source).toMatch(/\bbuildVaultIndex\b/);
    expect(source).toMatch(/\brefreshVaultIndex\b/);
    expect(source).toMatch(/\bgetVaultIndexStatus\b/);
    expect(source).toMatch(/\bsetInterval\s*\(/);
    expect(source).toMatch(/\bunref\s*\(\s*\)/);
    expect(source).toMatch(/\bclearInterval\s*\(/);
  });

  it('schedules refreshVaultIndex on an evaluated 15-minute interval', async () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const startMcpDaemon = await requireStartMcpDaemon();
    const dir = mkdtempSync(join(tmpdir(), 'rune-mcp-refresh-cadence-'));
    tempDirs.push(dir);

    try {
      const daemon = await startMcpDaemon({
        host: '127.0.0.1',
        port: 0,
        gateSecret: 'mcp-gate',
        userId: 'alice',
        issuerBaseUrl: 'https://mcp.example.invalid',
        oauthStoreFile: join(dir, 'rune-mcp-oauth-store.json'),
        tokenTtlMs: null,
      });
      daemons.push(daemon);

      const cadenceCall = setIntervalSpy.mock.calls.find(([, delay]) => delay === 15 * 60 * 1000);
      expect(cadenceCall, 'daemon must schedule a 15-minute warm-index refresh').toBeDefined();

      const callback = cadenceCall?.[0];
      expect(typeof callback).toBe('function');
      (callback as () => void)();
      expect(warmIndex.refreshVaultIndex).toHaveBeenCalledTimes(1);
    } finally {
      setIntervalSpy.mockRestore();
    }
  });

  it('serves daemon health before the synchronous startup index build runs', async () => {
    const startMcpDaemon = await requireStartMcpDaemon();
    const dir = mkdtempSync(join(tmpdir(), 'rune-mcp-startup-index-nonblocking-'));
    tempDirs.push(dir);

    const daemon = await startMcpDaemon({
      host: '127.0.0.1',
      port: 0,
      gateSecret: 'mcp-gate',
      userId: 'alice',
      issuerBaseUrl: 'https://mcp.example.invalid',
      oauthStoreFile: join(dir, 'rune-mcp-oauth-store.json'),
      tokenTtlMs: null,
    });
    daemons.push(daemon);

    expect(
      warmIndex.buildVaultIndex,
      'the daemon must bind its HTTP surface before starting the synchronous full-vault build',
    ).not.toHaveBeenCalled();

    const health = await rawReq({
      host: '127.0.0.1',
      port: daemon.port,
      path: '/health',
      method: 'GET',
    });
    expect(health.status).toBe(200);

    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(warmIndex.buildVaultIndex).toHaveBeenCalledTimes(1);
  });

  it('clears the scheduled warm-index refresh timer when the daemon stops', async () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
    const startMcpDaemon = await requireStartMcpDaemon();
    const dir = mkdtempSync(join(tmpdir(), 'rune-mcp-refresh-teardown-'));
    tempDirs.push(dir);
    let daemon: McpDaemonHandle | undefined;

    try {
      daemon = await startMcpDaemon({
        host: '127.0.0.1',
        port: 0,
        gateSecret: 'mcp-gate',
        userId: 'alice',
        issuerBaseUrl: 'https://mcp.example.invalid',
        oauthStoreFile: join(dir, 'rune-mcp-oauth-store.json'),
        tokenTtlMs: null,
      });

      const cadenceCallIndex = setIntervalSpy.mock.calls.findIndex(([, delay]) => (
        delay === 15 * 60 * 1000
      ));
      expect(cadenceCallIndex, 'daemon must schedule a 15-minute warm-index refresh').toBeGreaterThanOrEqual(0);
      const refreshTimer = setIntervalSpy.mock.results[cadenceCallIndex]?.value;

      await daemon.stop();
      daemon = undefined;

      expect(clearIntervalSpy).toHaveBeenCalledWith(refreshTimer);
    } finally {
      if (daemon) {
        await daemon.stop();
      }
      setIntervalSpy.mockRestore();
      clearIntervalSpy.mockRestore();
    }
  });

  it('starts the warm-index build in the background instead of blocking daemon startup', () => {
    const daemonPath = new URL('./daemon.ts', import.meta.url);
    const source = readFileSync(daemonPath, 'utf8');
    const startIndex = source.indexOf('export async function startMcpDaemon');
    const mainIndex = source.indexOf('\nasync function main', startIndex);
    const startSource = source.slice(startIndex, mainIndex > startIndex ? mainIndex : undefined);

    expect(startSource).toMatch(/\bbuildVaultIndex\b/);
    expect(startSource).not.toMatch(/\bawait\s+buildVaultIndex\s*\(/);
    expect(startSource).toMatch(
      /\b(?:setImmediate|queueMicrotask)\s*\([\s\S]*\bbuildVaultIndex\b|void\s+Promise\.resolve\(\)\.then\s*\([\s\S]*\bbuildVaultIndex\b|void\s+\(\s*async\s*\(\s*\)\s*=>[\s\S]*\bbuildVaultIndex\b/,
    );
  });

  it('routes daemon-internal broad kb_query through warm index with cold ripgrep fallback until ready', () => {
    const daemonPath = new URL('./daemon.ts', import.meta.url);
    const source = readFileSync(daemonPath, 'utf8');

    expect(source).toMatch(/\bkb_query\b/);
    expect(source).toMatch(/\bgetVaultIndexStatus\b/);
    expect(source).toMatch(/\bqueryVaultIndex\b/);
    expect(source).toMatch(/\bsearchVault\b/);
    expect(source).toMatch(
      /ready[\s\S]*\?[\s\S]*queryVaultIndex[\s\S]*:[\s\S]*searchVault|if\s*\([^)]*ready[^)]*\)[\s\S]*queryVaultIndex[\s\S]*searchVault/,
    );
  });

  it('exposes utility tools on the authenticated daemon MCP surface without broad kb admin tools', async () => {
    const startMcpDaemon = await requireStartMcpDaemon();
    const dir = mkdtempSync(join(tmpdir(), 'rune-mcp-refresh-tool-surface-'));
    tempDirs.push(dir);

    const daemon = await startMcpDaemon({
      host: '127.0.0.1',
      port: 0,
      gateSecret: 'mcp-gate',
      userId: 'alice',
      issuerBaseUrl: 'https://mcp.example.invalid',
      oauthStoreFile: join(dir, 'rune-mcp-oauth-store.json'),
      tokenTtlMs: null,
    });
    daemons.push(daemon);

    const accessToken = await issueDaemonBearerToken(daemon.port, 'mcp-gate');
    const initializeBody = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'refresh-vault-index-surface-test', version: '1.0.0' },
      },
    });

    const initialized = await rawReq({
      host: '127.0.0.1',
      port: daemon.port,
      path: '/mcp',
      method: 'POST',
      headers: {
        host: 'localhost',
        authorization: `Bearer ${accessToken}`,
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(initializeBody).toString(),
      },
      body: initializeBody,
    });
    expect(initialized.status).toBe(200);
    const sessionId = initialized.headers['mcp-session-id'];
    expect(sessionId).toEqual(expect.any(String));

    const listBody = JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: {},
    });
    const listed = await rawReq({
      host: '127.0.0.1',
      port: daemon.port,
      path: '/mcp',
      method: 'POST',
      headers: {
        host: 'localhost',
        authorization: `Bearer ${accessToken}`,
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(listBody).toString(),
        'mcp-session-id': sessionId as string,
      },
      body: listBody,
    });
    expect(listed.status).toBe(200);

    const payload = parseJsonRpcBody(listed.body) as {
      result?: { tools?: Array<{ name?: string }> };
    };
    const toolNames = (payload.result?.tools ?? []).map((tool) => tool.name).sort();

    expect(toolNames).toEqual(
      [...APP_SURFACE_TOOLS, ...CONTENT_TOOLS, 'refresh_vault_index', 'mcp_metrics_snapshot'].sort(),
    );
    expect(toolNames).not.toContain('kb_search');
    expect(toolNames).not.toContain('kb_ingest');
    expect(toolNames).not.toContain('kb_stats');
    expect(toolNames).not.toContain('kb_lint');
  });

  it('does not hard-code warm-index health as permanently starting or empty', () => {
    const daemonPath = new URL('./daemon.ts', import.meta.url);
    const source = readFileSync(daemonPath, 'utf8');
    const buildStatusSource = source.match(/function buildStatus[\s\S]*?\n\}/)?.[0] ?? '';

    expect(buildStatusSource).toMatch(/\bgetVaultIndexStatus\s*\(/);
    expect(buildStatusSource).not.toContain('ready: false');
    expect(buildStatusSource).not.toContain("status: 'starting'");
    expect(buildStatusSource).not.toContain('lastRebuild: null');
  });

  it('defines the MCP health payload as daemon status, not pkms or product data', () => {
    const daemonPath = new URL('./daemon.ts', import.meta.url);
    const source = readFileSync(daemonPath, 'utf8');
    const healthType = source.match(/export interface McpDaemonStatus \{[\s\S]*?\n\}/)?.[0] ?? '';

    expect(healthType).toContain("service: 'rune-mcp'");
    expect(healthType).toContain("status: 'ok' | 'starting' | 'degraded'");
    expect(healthType).toContain('activeSessions: number');
    expect(healthType).toMatch(/oauth:\s*\{\s*configured:\s*boolean\s*\}/);
    expect(healthType).toMatch(/warmIndex:\s*\{[\s\S]*ready:\s*boolean/);
    expect(healthType).toMatch(/warmIndex:\s*\{[\s\S]*status:/);
    expect(healthType).toMatch(/warmIndex:\s*\{[\s\S]*lastRebuild:/);
    expect(healthType).toMatch(/recentLogs|logPointers/);

    const buildStatusSource = source.match(/function buildStatus[\s\S]*?\n\}/)?.[0] ?? '';
    expect(buildStatusSource).not.toMatch(/queryKB|getKBStats|searchWithFilter|searchRepo|APP_SURFACE_TOOLS/);
  });

  it('serves daemon status at /health and only MCP/OAuth routes besides that', async () => {
    const startMcpDaemon = await requireStartMcpDaemon();
    const dir = mkdtempSync(join(tmpdir(), 'rune-mcp-daemon-'));
    tempDirs.push(dir);

    const daemon = await startMcpDaemon({
      host: '127.0.0.1',
      port: 0,
      gateSecret: 'mcp-gate',
      userId: 'alice',
      issuerBaseUrl: 'https://mcp.example.invalid',
      oauthStoreFile: join(dir, 'rune-mcp-oauth-store.json'),
      tokenTtlMs: null,
    });
    daemons.push(daemon);

    expect(daemon.host).toBe('127.0.0.1');
    expect(daemon.port).toBeGreaterThan(0);
    expect(daemon.url).toBe(`http://127.0.0.1:${daemon.port}`);
    expect(daemon.getStatus()).toMatchObject({
      service: 'rune-mcp',
      activeSessions: 0,
    });

    const health = await rawReq({
      host: '127.0.0.1',
      port: daemon.port,
      path: '/health',
      method: 'GET',
    });
    expect(health.status).toBe(200);
    expect(health.headers['content-type']).toContain('application/json');
    const body = JSON.parse(health.body) as {
      service?: string;
      status?: string;
      uptime?: number;
      oauth?: { configured?: boolean };
      activeSessions?: number;
      warmIndex?: { ready?: boolean; lastRebuild?: unknown };
    };
    expect(body.service).toBe('rune-mcp');
    expect(body.status).toMatch(/^(ok|starting|degraded)$/);
    expect(typeof body.uptime).toBe('number');
    expect(body.oauth?.configured).toBe(true);
    expect(body.activeSessions).toBe(0);
    expect(typeof body.warmIndex?.ready).toBe('boolean');
    expect('lastRebuild' in (body.warmIndex ?? {})).toBe(true);

    const mcpUnauthorized = await rawReq({
      host: '127.0.0.1',
      port: daemon.port,
      path: '/mcp',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    expect(mcpUnauthorized.status).toBe(401);
    expect(mcpUnauthorized.headers['www-authenticate']).toContain('Bearer');

    const oauthMetadata = await rawReq({
      host: '127.0.0.1',
      port: daemon.port,
      path: '/.well-known/oauth-authorization-server',
      method: 'GET',
    });
    expect(oauthMetadata.status).toBe(200);
    expect(JSON.parse(oauthMetadata.body)).toMatchObject({
      issuer: 'https://mcp.example.invalid',
      authorization_endpoint: 'https://mcp.example.invalid/mcp/oauth/authorize',
      token_endpoint: 'https://mcp.example.invalid/mcp/oauth/token',
    });

    for (const route of [
      { path: '/', method: 'GET' },
      { path: '/metrics', method: 'GET' },
      { path: '/api/products', method: 'GET' },
      { path: '/capture-sessions', method: 'POST' },
      { path: '/oauth/whoop', method: 'GET' },
    ]) {
      const res = await rawReq({
        host: '127.0.0.1',
        port: daemon.port,
        path: route.path,
        method: route.method,
      });
      expect(res.status, `${route.method} ${route.path} must not be mounted by MCP daemon`).toBe(404);
    }

    expect(sideEffects.createBot).not.toHaveBeenCalled();
    expect(sideEffects.wireHandlers).not.toHaveBeenCalled();
    expect(sideEffects.startScheduler).not.toHaveBeenCalled();
    expect(sideEffects.startStallCheck).not.toHaveBeenCalled();
    expect(sideEffects.startWatcher).not.toHaveBeenCalled();
  });

  it('reports bounded process-only health shape and never vault or product payloads', async () => {
    const startMcpDaemon = await requireStartMcpDaemon();
    const dir = mkdtempSync(join(tmpdir(), 'rune-mcp-health-status-'));
    tempDirs.push(dir);

    const daemon = await startMcpDaemon({
      host: '127.0.0.1',
      port: 0,
      gateSecret: 'mcp-gate',
      userId: 'alice',
      issuerBaseUrl: 'https://mcp.example.invalid',
      oauthStoreFile: join(dir, 'rune-mcp-oauth-store.json'),
      tokenTtlMs: null,
    });
    daemons.push(daemon);

    const res = await rawReq({
      host: '127.0.0.1',
      port: daemon.port,
      path: '/health',
      method: 'GET',
    });
    expect(res.status).toBe(200);

    const body = JSON.parse(res.body) as {
      service?: unknown;
      status?: unknown;
      uptime?: unknown;
      oauth?: { configured?: unknown };
      activeSessions?: unknown;
      warmIndex?: {
        ready?: unknown;
        status?: unknown;
        lastRebuild?: unknown;
      };
      recentLogs?: unknown;
      logPointers?: unknown;
    };

    expect(body.service).toBe('rune-mcp');
    expect(body.status).toMatch(/^(ok|starting|degraded)$/);
    expect(body.uptime).toEqual(expect.any(Number));
    expect(body.oauth).toEqual({ configured: true });
    expect(body.activeSessions).toBe(0);
    expect(body.warmIndex?.ready).toEqual(expect.any(Boolean));
    expect(body.warmIndex?.status).toEqual(expect.any(String));
    expect(body.warmIndex).toHaveProperty('lastRebuild');

    expect(Boolean(body.recentLogs) || Boolean(body.logPointers)).toBe(true);
    if (Array.isArray(body.recentLogs)) {
      expect(body.recentLogs.length).toBeLessThanOrEqual(50);
      for (const line of body.recentLogs) {
        expect(typeof line).toBe('string');
        expect(line.length).toBeLessThanOrEqual(2_000);
      }
    }

    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('PKMS_HEALTH_MUST_NOT_LEAK_FROM_KB_STATS');
    for (const toolName of APP_SURFACE_TOOLS) {
      expect(serialized).not.toContain(toolName);
    }
    for (const productName of ['aura', 'assay', 'relay', 'writing', 'brand']) {
      expect(serialized).not.toContain(productName);
    }
  });

  it('counts active MCP sessions in /health after an authenticated initialize', async () => {
    const startMcpDaemon = await requireStartMcpDaemon();
    const dir = mkdtempSync(join(tmpdir(), 'rune-mcp-health-sessions-'));
    tempDirs.push(dir);

    const daemon = await startMcpDaemon({
      host: '127.0.0.1',
      port: 0,
      gateSecret: 'mcp-gate',
      userId: 'alice',
      issuerBaseUrl: 'https://mcp.example.invalid',
      oauthStoreFile: join(dir, 'rune-mcp-oauth-store.json'),
      tokenTtlMs: null,
    });
    daemons.push(daemon);

    const accessToken = await issueDaemonBearerToken(daemon.port, 'mcp-gate');
    const initializeBody = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'health-status-test', version: '1.0.0' },
      },
    });

    const initialized = await rawReq({
      host: '127.0.0.1',
      port: daemon.port,
      path: '/mcp',
      method: 'POST',
      headers: {
        host: 'localhost',
        authorization: `Bearer ${accessToken}`,
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(initializeBody).toString(),
      },
      body: initializeBody,
    });
    expect(initialized.status).toBe(200);

    const health = await rawReq({
      host: '127.0.0.1',
      port: daemon.port,
      path: '/health',
      method: 'GET',
    });
    expect(health.status).toBe(200);
    expect((JSON.parse(health.body) as { activeSessions?: number }).activeSessions).toBe(1);
  });

  it('uses the daemon OAuth secret, issuer, and store independently of web auth cookies', async () => {
    const startMcpDaemon = await requireStartMcpDaemon();
    const { verifyAuth } = await import('../server/auth.js');
    const dir = mkdtempSync(join(tmpdir(), 'rune-mcp-oauth-split-'));
    tempDirs.push(dir);
    const oauthStoreFile = join(dir, 'rune-mcp-oauth-store.json');

    const daemon = await startMcpDaemon({
      host: '127.0.0.1',
      port: 0,
      gateSecret: 'mcp-gate',
      userId: 'alice',
      issuerBaseUrl: 'https://mcp.example.invalid',
      oauthStoreFile,
      tokenTtlMs: null,
    });
    daemons.push(daemon);

    const metadata = await rawReq({
      host: '127.0.0.1',
      port: daemon.port,
      path: '/.well-known/oauth-authorization-server',
      method: 'GET',
    });
    expect(metadata.status).toBe(200);
    expect(JSON.parse(metadata.body)).toMatchObject({
      issuer: 'https://mcp.example.invalid',
      authorization_endpoint: 'https://mcp.example.invalid/mcp/oauth/authorize',
      token_endpoint: 'https://mcp.example.invalid/mcp/oauth/token',
    });

    const clientId = await registerOAuthClient(daemon.port);
    const verifier = randomVerifier();
    const authorizeParams = {
      response_type: 'code',
      client_id: clientId,
      redirect_uri: 'http://localhost:9999/callback',
      code_challenge: pkceChallenge(verifier),
      code_challenge_method: 'S256',
      state: 'wrong-secret-attempt',
    };
    const webSecretAttempt = await postAuthorize(daemon.port, authorizeParams, 'web-secret');
    expect(webSecretAttempt.status).toBe(401);

    const accessToken = await issueDaemonBearerToken(daemon.port, 'mcp-gate');
    expect(existsSync(oauthStoreFile), 'daemon OAuth must persist to RUNE_MCP_OAUTH_STORE_FILE').toBe(true);

    const beforeRevoke = await rawReq({
      host: '127.0.0.1',
      port: daemon.port,
      path: '/mcp',
      method: 'GET',
      headers: {
        host: 'localhost',
        authorization: `Bearer ${accessToken}`,
      },
    });
    expect(beforeRevoke.status).not.toBe(401);

    expect(verifyAuth({
      headers: { cookie: 'rune-auth=web-secret' },
    } as any)).toEqual({ ok: true, userId: 42 });

    await daemon.stop();
    rmSync(oauthStoreFile, { force: true });

    const afterRestart = await startMcpDaemon({
      host: '127.0.0.1',
      port: daemon.port,
      gateSecret: 'mcp-gate',
      userId: 'alice',
      issuerBaseUrl: 'https://mcp.example.invalid',
      oauthStoreFile,
      tokenTtlMs: null,
    });
    daemons.push(afterRestart);

    const afterRevoke = await rawReq({
      host: '127.0.0.1',
      port: afterRestart.port,
      path: '/mcp',
      method: 'GET',
      headers: {
        host: 'localhost',
        authorization: `Bearer ${accessToken}`,
      },
    });
    expect(afterRevoke.status).toBe(401);
    expect(afterRevoke.headers['www-authenticate']).toContain('Bearer');

    expect(verifyAuth({
      headers: { cookie: 'rune-auth=web-secret' },
    } as any)).toEqual({ ok: true, userId: 42 });
  });

  it('keeps the daemon OAuth store and live sessions untouched across a cockpit web restart', async () => {
    const startMcpDaemon = await requireStartMcpDaemon();
    const { startHttpServer } = await import('../server/http.js');
    const dir = mkdtempSync(join(tmpdir(), 'rune-mcp-reauth-owner-'));
    tempDirs.push(dir);
    const oauthStoreFile = join(dir, 'rune-mcp-oauth-store.json');

    const daemon = await startMcpDaemon({
      host: '127.0.0.1',
      port: 0,
      gateSecret: 'mcp-gate',
      userId: 'alice',
      issuerBaseUrl: 'https://mcp.example.invalid',
      oauthStoreFile,
      tokenTtlMs: null,
    });
    daemons.push(daemon);

    const accessToken = await issueDaemonBearerToken(daemon.port, 'mcp-gate');
    const initializeBody = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'reauth-store-ownership-test', version: '1.0.0' },
      },
    });

    const initialized = await rawReq({
      host: '127.0.0.1',
      port: daemon.port,
      path: '/mcp',
      method: 'POST',
      headers: {
        host: 'localhost',
        authorization: `Bearer ${accessToken}`,
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(initializeBody).toString(),
      },
      body: initializeBody,
    });
    expect(initialized.status).toBe(200);

    const activeBefore = daemon.getStatus().activeSessions;
    expect(activeBefore).toBe(1);
    const storeBefore = readFileSync(oauthStoreFile, 'utf8');
    const statBefore = statSync(oauthStoreFile);
    const healthBefore = await rawReq({
      host: '127.0.0.1',
      port: daemon.port,
      path: '/health',
      method: 'GET',
    });
    expect(healthBefore.status).toBe(200);
    expect((JSON.parse(healthBefore.body) as { service?: string; activeSessions?: number })).toMatchObject({
      service: 'rune-mcp',
      activeSessions: activeBefore,
    });

    const firstWeb = startHttpServer();
    await new Promise<void>((resolve) => firstWeb.on('listening', resolve));
    await closeWebServer(firstWeb);
    const restartedWeb = startHttpServer();
    await new Promise<void>((resolve) => restartedWeb.on('listening', resolve));
    await closeWebServer(restartedWeb);

    expect(readFileSync(oauthStoreFile, 'utf8')).toBe(storeBefore);
    const statAfter = statSync(oauthStoreFile);
    expect(statAfter.size).toBe(statBefore.size);
    expect(statAfter.mtimeMs).toBe(statBefore.mtimeMs);
    expect(daemon.getStatus().activeSessions).toBe(activeBefore);

    const healthAfter = await rawReq({
      host: '127.0.0.1',
      port: daemon.port,
      path: '/health',
      method: 'GET',
    });
    expect(healthAfter.status).toBe(200);
    expect((JSON.parse(healthAfter.body) as { service?: string; activeSessions?: number })).toMatchObject({
      service: 'rune-mcp',
      activeSessions: activeBefore,
    });

    const tokenStillAccepted = await rawReq({
      host: '127.0.0.1',
      port: daemon.port,
      path: '/mcp',
      method: 'GET',
      headers: {
        host: 'localhost',
        authorization: `Bearer ${accessToken}`,
      },
    });
    expect(tokenStillAccepted.status).not.toBe(401);
  });

  it('documents the one-time cutover reauth and non-migration of legacy web-store tokens', () => {
    const subsystemDocs = readFileSync(
      new URL('../../docs/architecture/subsystems.md', import.meta.url),
      'utf8',
    );

    expect(subsystemDocs).toMatch(/one-time cutover reauth/i);
    expect(subsystemDocs).toMatch(/old web(?: server)? store tokens? (?:are )?not migrated/i);
  });
});
