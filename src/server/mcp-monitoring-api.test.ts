/**
 * GET /api/mcp/monitoring + cockpit watchdog-alert grafting (MCP monitoring
 * redesign). Reuses the webview.test.ts harness patterns (real
 * mountWebviewRoutes against a fake Streamable-HTTP daemon) without touching
 * that file — its legacy pins stay frozen.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { Server, IncomingMessage, ServerResponse, IncomingHttpHeaders } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// --- Mocks must be declared before any imports that pull in the mocked modules ---

const { mockLogger } = vi.hoisted(() => ({
  mockLogger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../utils/logger.js', () => ({
  createLogger: () => mockLogger,
}));

vi.mock('../transport/mutations.js', () => ({
  createMutation: vi.fn(),
  cancelMutation: vi.fn(),
  activeRuns: new Map(),
}));

vi.mock('../jobs/work-run-release.js', () => ({
  requestWorkRunRelease: vi.fn(),
  defaultReleaseRequestDeps: vi.fn(() => ({})),
}));

vi.mock('../jobs/orchestrated-work-runner.js', () => ({
  requestOrchestratedRunRecovery: vi.fn(),
  readOrchestratedTaskRunRecords: vi.fn(() => []),
}));

vi.mock('../transport/in-flight.js', () => ({
  cancelOp: vi.fn(),
  listOps: vi.fn(() => []),
  registerOp: vi.fn(),
  unregisterOp: vi.fn(),
  isCancelled: vi.fn(() => false),
}));

vi.mock('../jobs/mutations-log.js', () => ({
  readRecentMutations: vi.fn(() => []),
}));

vi.mock('./cockpit-run-status.js', () => ({
  readCockpitRunStatus: vi.fn(() => ({})),
}));

vi.mock('./restart.js', () => ({ restartServer: vi.fn(() => ({ ok: true })) }));

vi.mock('../ai/claude.js', () => ({
  runAgent: vi.fn(async () => ({ text: 'ok', error: null })),
}));

vi.mock('../reviews/planning.js', () => ({
  createPlanningSession: vi.fn(),
  getActivePlanningSession: vi.fn(() => null),
  getPlanningSession: vi.fn(() => null),
  getAllPlanningSessions: vi.fn(() => []),
  updatePlanningSession: vi.fn(),
  deletePlanningSession: vi.fn(),
  approveActivePlanningSession: vi.fn(),
  abandonActivePlanningSession: vi.fn(),
}));
vi.mock('../reviews/planning-handler.js', () => ({
  handlePlanningTurn: vi.fn(),
  defaultScopingTurn: vi.fn(),
}));
vi.mock('../intent/planning-roles.js', () => ({
  runDownstreamPlan: vi.fn(),
}));
vi.mock('../jobs/scaffold-approval.js', () => ({
  runScaffoldApproval: vi.fn(),
  retryPromotionMarkSource: vi.fn(),
}));
vi.mock('../vault/sessions.js', () => ({
  getSession: vi.fn(() => null),
}));
vi.mock('./state-snapshot.js', () => ({
  getStateSnapshot: vi.fn(() => ({ version: 1, ready: true })),
}));
vi.mock('./webview-bootstrap.js', () => ({
  handleWebviewMessage: vi.fn(async () => undefined),
}));

// Registry fixture includes the rune-mcp product so attachMcpMonitoring
// grafts the monitoring card in the cockpit tests below.
const { mockRegistry } = vi.hoisted(() => ({
  mockRegistry: {
    version: 1,
    builtAt: '2026-07-01T00:00:00.000Z',
    products: [
      {
        name: 'rune-mcp',
        class: 'internal',
        repoBacked: true,
        projects: [{ slug: '19-rune-product-os', status: 'active' }],
      },
    ],
  },
}));
vi.mock('../intent/registry.js', () => ({ readRegistry: vi.fn(() => mockRegistry) }));
vi.mock('./projects-snapshot.js', () => ({ getProjectSummaries: vi.fn(() => []) }));

// --- Fixture files (real fs — the monitoring sections under test read files) ---

const tmpRoot = mkdtempSync(join(tmpdir(), 'mcp-monitoring-api-'));

const mockConfig = {
  HTTP_PORT: 0,
  HTTP_HOST: '127.0.0.1',
  TIMEZONE: 'America/Chicago',
  VAULT_DIR: '/test/vault',
  WORKSPACE_DIR: '/test/workspace',
  RUNE_HTTP_SECRET: 'test-secret',
  OBSIDIAN_VAULT_NAME: 'TestVault',
  TELEGRAM_USER_ID: 42,
  RUNE_ALLOWED_HOSTS: new Set(['localhost', '127.0.0.1']),
  IS_PRODUCTION: false as boolean,
  LAUNCHD_LABEL: 'com.jarvis.daemon',
  RUNE_MCP_HOST: '127.0.0.1',
  RUNE_MCP_PORT: 65534,
  RUNE_MCP_OAUTH_STORE_FILE: join(tmpRoot, 'rune-mcp-oauth-store.json'),
  RUNE_MCP_METRICS_HISTORY_FILE: join(tmpRoot, 'rune-mcp-metrics-history.jsonl'),
  MCP_WATCHDOG_STATE_FILE: join(tmpRoot, 'mcp-watchdog-state.json'),
  SUPERVISED_RUNS_FILE: join(tmpRoot, 'supervised-runs.json'),
  WORK_RUNS_INDEX_FILE: join(tmpRoot, 'work-runs-index.jsonl'),
  WORK_RUNS_DIR: join(tmpRoot, 'work-runs'),
  PRODUCTS_CONFIG_FILE: '/test/products.json',
  ORCHESTRATED_WORK_ENABLED: false as boolean,
};

vi.mock('../config.js', () => ({
  default: mockConfig,
  PROJECT_ROOT: '/test/project',
}));

// Import after mocks are wired up
const { mountWebviewRoutes } = await import('./webview.js');

// ---- fixtures ----

const HOUR_MS = 60 * 60 * 1000;
const bearerTokenValue = 'rune-secret-bearer-token-do-not-leak';
const redirectUriValue = 'https://claude.ai/api/mcp/auth_callback';

const liveSnapshotFixture = {
  totals: { calls: 42, errors: 3, timeouts: 1 },
  tools: {
    kb_query: {
      calls: 21,
      errors: 2,
      timeouts: 1,
      latencyMs: { p50: 24, p95: 88, p99: 144, sampleCount: 21, windowSize: 1024 },
    },
  },
  activeSessions: 2,
  warmIndex: { ready: true, status: 'ok', ageMs: 15_000, lastRebuild: { status: 'ok' } },
};

const daemonHealthFixture = {
  service: 'rune-mcp',
  status: 'ok',
  uptime: 3600.4,
  startedAt: '2026-07-06T12:00:00.000Z',
  bootId: 'boot-live',
  oauth: { configured: true },
  activeSessions: 1,
  sessions: [
    { id: 'sess-1', openedAt: '2026-07-06T12:01:00.000Z', lastSeenAt: '2026-07-06T12:30:00.000Z' },
  ],
  warmIndex: { ready: true, status: 'ok', lastRebuild: null },
  recentLogs: [],
  logPointers: [{ path: 'logs/rune.log', description: 'MCP daemon process log' }],
};

/** Three cumulative flush records with one shared bootId; deltas sum to
 *  calls 12 / errors 2 / timeouts 1, per-tool kb_query {10,2} + log_idea {2,0}. */
function writeHistoryFixture(nowMs: number): { firstTs: string } {
  const record = (
    tsMs: number,
    totals: { calls: number; errors: number; timeouts: number },
    tools: Record<string, { calls: number; errors: number }>,
  ) => JSON.stringify({
    ts: new Date(tsMs).toISOString(),
    bootId: 'boot-history',
    uptimeSec: 100,
    activeSessions: 1,
    totals,
    tools: Object.fromEntries(Object.entries(tools).map(([name, t]) => [
      name,
      { ...t, timeouts: 0, p50: 5, p95: 10, p99: 20 },
    ])),
  });
  const firstTs = new Date(nowMs - 3 * HOUR_MS).toISOString();
  writeFileSync(mockConfig.RUNE_MCP_METRICS_HISTORY_FILE, [
    record(nowMs - 3 * HOUR_MS, { calls: 0, errors: 0, timeouts: 0 }, {}),
    record(nowMs - 2 * HOUR_MS, { calls: 5, errors: 1, timeouts: 0 }, {
      kb_query: { calls: 5, errors: 1 },
    }),
    record(nowMs - 30 * 60 * 1000, { calls: 12, errors: 2, timeouts: 1 }, {
      kb_query: { calls: 10, errors: 2 },
      log_idea: { calls: 2, errors: 0 },
    }),
  ].join('\n') + '\n');
  return { firstTs };
}

function writeWatchdogFixture(active: Array<Record<string, unknown>>): void {
  writeFileSync(mockConfig.MCP_WATCHDOG_STATE_FILE, JSON.stringify({
    consecutiveDownTicks: 0,
    consecutiveDegradedTicks: 0,
    active,
    lastNotifiedAt: {},
  }));
}

const errorSpikeAlert = {
  kind: 'error-spike',
  key: 'error-spike',
  // Contains a scrub-target absolute path — the response must carry the placeholder.
  message: 'MCP error rate spiked (details in /test/workspace/rune/logs/rune.log)',
  firstDetectedAt: '2026-07-06T13:00:00.000Z',
  lastDetectedAt: '2026-07-06T13:05:00.000Z',
};

// ---- fake MCP daemon (health + Streamable-HTTP tool route) ----

type FakeMcpRequest = {
  method: string | undefined;
  path: string;
  headers: IncomingHttpHeaders;
  body: any;
};

async function startFakeMcpDaemon(): Promise<{
  port: number;
  requests: FakeMcpRequest[];
  close: () => Promise<void>;
}> {
  const requests: FakeMcpRequest[] = [];
  const mcpServer = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => { raw += chunk.toString(); });
    req.on('end', () => {
      const path = req.url?.split('?')[0] ?? '';
      let body: any = null;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        body = raw;
      }
      requests.push({ method: req.method, path, headers: req.headers, body });

      if (req.method === 'GET' && path === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(daemonHealthFixture));
        return;
      }
      if (req.method !== 'POST' || path !== '/mcp') {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
        return;
      }
      // The real daemon answers tool posts as SSE frames (Streamable HTTP).
      const writeSse = (message: unknown, extraHeaders: Record<string, string> = {}): void => {
        res.writeHead(200, { ...extraHeaders, 'Content-Type': 'text/event-stream' });
        res.end(`event: message\ndata: ${JSON.stringify(message)}\n\n`);
      };
      if (body?.method === 'initialize') {
        writeSse({
          jsonrpc: '2.0',
          id: body.id,
          result: {
            protocolVersion: body.params?.protocolVersion ?? '2025-03-26',
            capabilities: { tools: {} },
            serverInfo: { name: 'fake-rune-mcp', version: '1.0.0' },
          },
        }, { 'mcp-session-id': 'test-mcp-session' });
        return;
      }
      if (body?.method === 'notifications/initialized') {
        res.writeHead(202);
        res.end();
        return;
      }
      if (body?.method === 'tools/call' && body?.params?.name === 'mcp_metrics_snapshot') {
        writeSse({
          jsonrpc: '2.0',
          id: body.id,
          result: { content: [{ type: 'text', text: JSON.stringify(liveSnapshotFixture) }] },
        });
        return;
      }
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        jsonrpc: '2.0',
        id: body?.id ?? null,
        error: { code: -32601, message: `unexpected MCP method ${body?.method ?? 'unknown'}` },
      }));
    });
  });
  const sockets = new Set<{ destroy: () => void }>();
  mcpServer.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => mcpServer.listen(0, '127.0.0.1', resolve));
  return {
    port: (mcpServer.address() as any).port,
    requests,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => mcpServer.close(() => resolve()));
    },
  };
}

async function getReleasedLocalPort(): Promise<number> {
  const s = http.createServer();
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve));
  const releasedPort = (s.address() as any).port;
  await new Promise<void>((resolve) => s.close(() => resolve()));
  return releasedPort;
}

// ---- request helper (webview.test.ts pattern) ----

function makeRequest(
  port: number,
  path: string,
  opts: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; body: any; raw: string }> {
  return new Promise((resolve, reject) => {
    const r = http.request({
      host: '127.0.0.1',
      port,
      path,
      method: opts.method ?? 'GET',
      headers: { host: 'localhost', ...opts.headers },
    }, (res) => {
      let raw = '';
      res.on('data', (c: Buffer) => (raw += c.toString()));
      res.on('end', () => {
        const parsed = (() => { try { return JSON.parse(raw); } catch { return raw; } })();
        resolve({ status: res.statusCode!, body: parsed, raw });
      });
    });
    r.on('error', reject);
    if (opts.body) r.write(opts.body);
    r.end();
  });
}

const authed = { authorization: 'Bearer test-secret' };

// ---- server setup ----

const mockWebviewSender = {
  name: 'webview' as const,
  register: vi.fn(),
  unregister: vi.fn(),
  send: vi.fn(async () => undefined),
  startTyping: vi.fn(),
  stopTyping: vi.fn(),
  shutdown: vi.fn(),
};

let server: Server;
let webviewHandler: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;
let port: number;
let historyFirstTs: string;

describe('GET /api/mcp/monitoring', () => {
  beforeAll(async () => {
    // Fixture files the offline sections read.
    historyFirstTs = writeHistoryFixture(Date.now()).firstTs;
    writeWatchdogFixture([errorSpikeAlert]);
    writeFileSync(mockConfig.RUNE_MCP_OAUTH_STORE_FILE, JSON.stringify({
      clients: [{
        clientId: 'client-abc',
        redirectUris: [redirectUriValue],
        clientName: 'Claude',
        createdAt: '2026-07-01T00:00:00.000Z',
      }],
      tokens: [{ token: bearerTokenValue, userId: '42', expiresAt: null }],
    }));
    writeFileSync(mockConfig.SUPERVISED_RUNS_FILE, JSON.stringify([
      {
        id: 'run-1', product: 'rune', project: '19-x', status: 'running',
        startedAt: '2026-07-06T10:00:00.000Z', lastHeartbeatAt: '2026-07-06T10:05:00.000Z',
      },
      {
        id: 'run-2', product: 'rune', project: '19-x', status: 'blocked-on-human',
        startedAt: '2026-07-06T09:00:00.000Z', lastHeartbeatAt: '2026-07-06T09:30:00.000Z',
      },
    ]));
    writeFileSync(mockConfig.WORK_RUNS_INDEX_FILE, [
      JSON.stringify({
        id: 'wr-1', project: '19-x', outcome: 'branch-complete', durationMs: 1000,
        startedAt: '2026-07-05T10:00:00.000Z', endedAt: '2026-07-05T10:20:00.000Z',
      }),
      JSON.stringify({
        id: 'wr-2', project: '19-x', outcome: 'failed', durationMs: 2000,
        startedAt: '2026-07-05T11:00:00.000Z', endedAt: '2026-07-05T11:40:00.000Z',
      }),
    ].join('\n') + '\n');

    server = http.createServer(async (req, res) => {
      const handled = await webviewHandler(req, res);
      if (!handled) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found (fallthrough)' }));
      }
    });
    webviewHandler = mountWebviewRoutes(server, { webview: mockWebviewSender as any, isReady: () => true });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as any).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('composes live, daemon, clients, history, runMetrics and alerts from one endpoint', async () => {
    const daemon = await startFakeMcpDaemon();
    try {
      mockConfig.RUNE_MCP_PORT = daemon.port;
      const res = await makeRequest(port, '/api/mcp/monitoring', { headers: authed });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
      expect(res.body.checkedAt).toEqual(expect.any(String));

      // live — parsed mcp_metrics_snapshot via the existing tool machinery.
      expect(res.body.live).toMatchObject({
        totals: { calls: 42, errors: 3, timeouts: 1 },
        activeSessions: 2,
        warmIndex: { ready: true, status: 'ok' },
      });
      expect(res.body.live.tools.kb_query.latencyMs).toMatchObject({ p95: 88, sampleCount: 21 });
      const toolCall = daemon.requests.find((request) => (
        request.body?.method === 'tools/call' && request.body?.params?.name === 'mcp_metrics_snapshot'
      ));
      expect(toolCall).toBeDefined();

      // daemon — parsed /health body, field-picked.
      expect(res.body.daemon).toEqual({
        status: 'ok',
        uptimeSec: 3600,
        startedAt: '2026-07-06T12:00:00.000Z',
        bootId: 'boot-live',
        oauthConfigured: true,
        sessions: [
          { id: 'sess-1', openedAt: '2026-07-06T12:01:00.000Z', lastSeenAt: '2026-07-06T12:30:00.000Z' },
        ],
      });

      // clients — display fields only.
      expect(res.body.clients).toEqual([
        { clientId: 'client-abc', clientName: 'Claude', createdAt: '2026-07-01T00:00:00.000Z' },
      ]);

      // history — 14d daily + 24h hourly rollups over the fixture deltas.
      expect(res.body.history.callsPerDay).toHaveLength(14);
      const dailyTotals = res.body.history.callsPerDay.reduce(
        (acc: { calls: number; errors: number }, b: any) => ({
          calls: acc.calls + b.calls,
          errors: acc.errors + b.errors,
        }),
        { calls: 0, errors: 0 },
      );
      expect(dailyTotals).toEqual({ calls: 12, errors: 2 });
      expect(res.body.history.hourly).toHaveLength(24);
      const hourlyTimeouts = res.body.history.hourly.reduce((sum: number, b: any) => sum + b.timeouts, 0);
      expect(hourlyTimeouts).toBe(1);
      expect(res.body.history.perTool24h).toEqual({
        kb_query: { calls: 10, errors: 2 },
        log_idea: { calls: 2, errors: 0 },
      });
      expect(res.body.history.collectedSince).toBe(historyFirstTs);

      // runMetrics — the previously-dead reader wired with real config.
      expect(res.body.runMetrics).toMatchObject({
        status: 'ok',
        activeRuns: 2,
        parkedRuns: 1,
        terminalOutcomes: { 'branch-complete': 1, failed: 1 },
        runtimeMs: { p95: 2000, sampleCount: 2 },
      });
      expect(res.body.runMetrics.recentFailures).toEqual([
        expect.objectContaining({ id: 'wr-2', outcome: 'failed' }),
      ]);

      // alerts — active watchdog alerts with scrubbed messages.
      expect(res.body.alerts.count).toBe(1);
      expect(res.body.alerts.active[0]).toMatchObject({ kind: 'error-spike', key: 'error-spike' });
      expect(res.body.alerts.active[0].message).toContain('<workspace>');
    } finally {
      await daemon.close();
    }
  });

  it('answers 200 degraded with history, runMetrics and alerts intact when the daemon is down', async () => {
    mockConfig.RUNE_MCP_PORT = await getReleasedLocalPort();
    const res = await makeRequest(port, '/api/mcp/monitoring', { headers: authed });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('degraded');
    expect(res.body.error).toEqual(expect.any(String));
    expect(res.body.live).toBeUndefined();
    expect(res.body.daemon).toBeUndefined();

    // File-backed sections keep rendering during a daemon outage.
    const dailyCalls = res.body.history.callsPerDay.reduce((sum: number, b: any) => sum + b.calls, 0);
    expect(dailyCalls).toBe(12);
    expect(res.body.runMetrics).toMatchObject({ activeRuns: 2 });
    expect(res.body.alerts).toMatchObject({ count: 1 });
    expect(res.body.clients).toHaveLength(1);
  });

  it('treats a 200 /health body self-reporting degraded as degraded, keeping the daemon detail', async () => {
    const daemon = await startFakeMcpDaemon();
    const fixture = daemonHealthFixture as { status: string };
    fixture.status = 'degraded';
    try {
      mockConfig.RUNE_MCP_PORT = daemon.port;
      const res = await makeRequest(port, '/api/mcp/monitoring', { headers: authed });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('degraded');
      expect(res.body.error).toContain('self-reports status "degraded"');
      // The body still arrived — the detail section must not be dropped.
      expect(res.body.daemon).toMatchObject({ status: 'degraded', bootId: 'boot-live' });
    } finally {
      fixture.status = 'ok';
      await daemon.close();
    }
  });

  it('never leaks token values, redirect URIs, or absolute paths', async () => {
    const daemon = await startFakeMcpDaemon();
    let healthyRaw: string;
    try {
      mockConfig.RUNE_MCP_PORT = daemon.port;
      healthyRaw = (await makeRequest(port, '/api/mcp/monitoring', { headers: authed })).raw;
    } finally {
      await daemon.close();
    }
    mockConfig.RUNE_MCP_PORT = await getReleasedLocalPort();
    const degradedRaw = (await makeRequest(port, '/api/mcp/monitoring', { headers: authed })).raw;

    for (const raw of [healthyRaw, degradedRaw]) {
      expect(raw).not.toContain(bearerTokenValue);
      expect(raw).not.toContain(redirectUriValue);
      // Scrub-target absolute roots (config mock values) must never appear.
      expect(raw).not.toContain('/test/vault');
      expect(raw).not.toContain('/test/workspace');
      expect(raw).not.toContain('/test/project');
      // Nor the real on-disk fixture locations.
      expect(raw).not.toContain(tmpRoot);
    }
  });

  it('grafts watchdog alerts into the cockpit projection and flips status while daemon-down is active', async () => {
    const daemon = await startFakeMcpDaemon();
    try {
      mockConfig.RUNE_MCP_PORT = daemon.port;

      // Active daemon-down alert outranks a momentarily-green probe.
      writeWatchdogFixture([
        {
          kind: 'daemon-down',
          key: 'daemon-down',
          message: 'MCP daemon unreachable for 3 ticks',
          firstDetectedAt: '2026-07-06T13:00:00.000Z',
          lastDetectedAt: '2026-07-06T13:03:00.000Z',
        },
      ]);
      const flagged = await makeRequest(port, '/api/cockpit', { headers: authed });
      expect(flagged.status).toBe(200);
      const runeMcp = flagged.body.products.find((p: any) => p.name === 'rune-mcp');
      expect(runeMcp.monitoring.mcp).toMatchObject({
        status: 'degraded',
        alerts: { count: 1, kinds: ['daemon-down'] },
        checkedAt: expect.any(String),
      });

      // A non-daemon-down alert keeps the probe's ok status but still surfaces.
      writeWatchdogFixture([errorSpikeAlert]);
      const healthy = await makeRequest(port, '/api/cockpit', { headers: authed });
      const runeMcpHealthy = healthy.body.products.find((p: any) => p.name === 'rune-mcp');
      expect(runeMcpHealthy.monitoring.mcp).toMatchObject({
        status: 'ok',
        alerts: { count: 1, kinds: ['error-spike'] },
      });
    } finally {
      await daemon.close();
    }
  });

  it('leaves the legacy snapshot endpoint serving its original shape', async () => {
    const daemon = await startFakeMcpDaemon();
    try {
      mockConfig.RUNE_MCP_PORT = daemon.port;
      const res = await makeRequest(port, '/api/mcp/tools/mcp_metrics_snapshot', { headers: authed });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        status: 'ok',
        sourceTool: 'mcp_metrics_snapshot',
        checkedAt: expect.any(String),
      });
      expect(res.body.mcpMetrics.totals).toEqual({ calls: 42, errors: 3, timeouts: 1 });
    } finally {
      await daemon.close();
    }
  });
});
