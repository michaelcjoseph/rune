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
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
  TIMEZONE: 'America/Chicago',
  VAULT_DIR: '/test/vault',
  LOGS_DIR: '/tmp/rune-test-logs',
  RUNE_ALLOWED_HOSTS: new Set(['localhost', '127.0.0.1']),
  RUNE_MCP_SECRET: 'mcp-gate',
  RUNE_MCP_ISSUER_URL: 'https://mcp.example.invalid',
  RUNE_MCP_HOST: '127.0.0.1',
  RUNE_MCP_PORT: 0,
  RUNE_MCP_OAUTH_STORE_FILE: '/tmp/rune-test-logs/rune-mcp-oauth-store.json',
}));

vi.mock('../config.js', () => ({
  default: mockConfig,
}));

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
    recentLog: [],
  }),
}));

vi.mock('../kb/search.js', () => ({
  searchWithFilter: vi.fn().mockReturnValue([]),
  searchRepo: vi.fn().mockReturnValue([]),
}));

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
    const req = http.request(opts, (res) => {
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
  });

  it('declares npm run mcp:start as the standalone daemon command', () => {
    const packageJson = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { scripts?: Record<string, string> };

    const command = packageJson.scripts?.['mcp:start'];
    expect(command, 'package.json must define scripts["mcp:start"]').toBeDefined();
    expect(command).toMatch(/tsx\b/);
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
});
