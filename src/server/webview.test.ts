import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import type { Server, IncomingMessage, ServerResponse, IncomingHttpHeaders } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';

// --- Mocks must be declared before any imports that pull in the mocked modules ---

// Mutation mocks (used by the Phase E route tests appended below)
const mockCreateMutation = vi.fn();
const mockCancelMutation = vi.fn();
const mockActiveRunsMap = new Map<string, any>();
vi.mock('../transport/mutations.js', () => ({
  createMutation: mockCreateMutation,
  cancelMutation: mockCancelMutation,
  activeRuns: mockActiveRunsMap,
}));

// Shared release-runtime mock (project 13, Phase 1c). The release route
// delegates to `requestWorkRunRelease`; tests drive its outcome per-case.
const mockRequestWorkRunRelease = vi.fn();
vi.mock('../jobs/work-run-release.js', () => ({
  requestWorkRunRelease: mockRequestWorkRunRelease,
  defaultReleaseRequestDeps: vi.fn(() => ({})),
}));

// In-flight op mocks for POST /api/ops/:id/cancel
const mockCancelOp = vi.fn();
const mockRegisterOp = vi.fn();
const mockUnregisterOp = vi.fn();
const mockIsCancelled = vi.fn(() => false);
vi.mock('../transport/in-flight.js', () => ({
  cancelOp: mockCancelOp,
  listOps: vi.fn(() => []),
  registerOp: mockRegisterOp,
  unregisterOp: mockUnregisterOp,
  isCancelled: mockIsCancelled,
}));

const mockReadRecentMutations = vi.fn(() => []);
vi.mock('../jobs/mutations-log.js', () => ({
  readRecentMutations: mockReadRecentMutations,
}));

// Cockpit run-status: webview reads via this helper. Tests inject a fixture
// per-case via the `mockReadCockpitRunStatus.mockReturnValue(...)` knob.
const mockReadCockpitRunStatus = vi.fn(() => ({}));
vi.mock('./cockpit-run-status.js', () => ({
  readCockpitRunStatus: mockReadCockpitRunStatus,
}));

const mockConfig = {
  HTTP_PORT: 0,
  HTTP_HOST: '127.0.0.1',
  TIMEZONE: 'America/Chicago',
  VAULT_DIR: '/test/vault',
  RUNE_HTTP_SECRET: 'test-secret',
  OBSIDIAN_VAULT_NAME: 'TestVault',
  TELEGRAM_USER_ID: 42,
  RUNE_ALLOWED_HOSTS: new Set(['localhost', '127.0.0.1']),
  IS_PRODUCTION: false as boolean,
  LAUNCHD_LABEL: 'com.jarvis.daemon',
  RUNE_MCP_OAUTH_STORE_FILE: '/test/missing-rune-mcp-oauth-store.json',
  RUNE_MCP_HOST: '127.0.0.1',
  RUNE_MCP_PORT: 65534,
  // Project 14 Phase 5 dispatch seam. PRODUCTS_CONFIG_FILE points at a path that
  // doesn't exist so readDispatchModeInput's per-product read fails and falls
  // back to the global toggle — which the dispatch tests below flip per-case.
  PRODUCTS_CONFIG_FILE: '/test/products.json',
  ORCHESTRATED_WORK_ENABLED: false as boolean,
};

// restartServer is spawned via setTimeout by the restart endpoint; mock it so
// the prod-path test never actually shells out to launchctl.
const mockRestartServer = vi.fn(() => ({ ok: true as const }));
vi.mock('./restart.js', () => ({ restartServer: mockRestartServer }));

vi.mock('../config.js', () => ({
  default: mockConfig,
  PROJECT_ROOT: '/test/project',
}));

// runAgent is invoked by handleApiPlanningApprove (C1.2); mock here so the
// webview module load doesn't pull in the real ai/claude.ts which requires
// a resolvable claude binary.
vi.mock('../ai/claude.js', () => ({
  runAgent: vi.fn(async () => ({ text: 'ok', error: null })),
}));

// The planning store + handler imports are pulled in by handleApiPlanning*.
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
  getStateSnapshot: vi.fn(() => ({
    version: 1,
    ready: true,
    sessions: { webview: null, telegram: null },
    activeReview: null,
    ingestionQueueDepth: 0,
    recentAgentRuns: [],
    pendingApprovals: { playbook: 0, proposal: 0 },
    lastMorningPrepAt: null,
    lastNightlyAt: null,
    warnings: [],
  })),
}));

vi.mock('./webview-bootstrap.js', () => ({
  handleWebviewMessage: vi.fn(async () => undefined),
}));

// readRegistry is mocked so GET /api/cockpit has a registry to project; buildCockpitView
// (from intent/cockpit.ts) is left real — it is the function under test for the endpoint.
// vi.hoisted so the fixture is shared by the mock factory and the beforeEach restore.
const { mockRegistry } = vi.hoisted(() => ({
  mockRegistry: {
    version: 1,
    builtAt: '2026-01-15T00:00:00.000Z',
    products: [
      {
        name: 'aura',
        class: 'external',
        repoBacked: true,
        containerCapabilities: {
          projects: true,
          bugs: true,
          ideas: true,
          runs: true,
          chat: true,
          monitoring: 'stubbed',
        },
        projects: [{ slug: '01-mvp', status: 'active' }],
      },
    ],
  },
}));
vi.mock('../intent/registry.js', () => ({ readRegistry: vi.fn(() => mockRegistry) }));

// getProjectSummaries is called by handleApiCockpit to enrich the view with
// task progress (done/total). Mock to an empty list so the cockpit endpoint
// works without staging real tasks.md files. Per-test overrides go via
// vi.mocked(...).mockReturnValue([...]) in the enrichment test below.
const mockGetProjectSummaries = vi.fn(() => [] as any[]);
vi.mock('./projects-snapshot.js', () => ({ getProjectSummaries: mockGetProjectSummaries }));

// Import after mocks are wired up
const { mountWebviewRoutes } = await import('./webview.js');
const { handleWebviewMessage } = await import('./webview-bootstrap.js');
const { getSession } = await import('../vault/sessions.js');
const { getStateSnapshot } = await import('./state-snapshot.js');
const { readRegistry } = await import('../intent/registry.js');
const {
  approveActivePlanningSession,
  deletePlanningSession,
  getPlanningSession,
  updatePlanningSession,
} = await import('../reviews/planning.js');
const { runDownstreamPlan } = await import('../intent/planning-roles.js');
const { runScaffoldApproval } = await import('../jobs/scaffold-approval.js');

// ---- helpers ----

interface ReqOpts {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

function makeRequest(
  port: number,
  path: string,
  opts: ReqOpts = {},
): Promise<{ status: number; body: any; headers: Record<string, string> }> {
  return new Promise((resolve, reject) => {
    const reqOpts: http.RequestOptions = {
      host: '127.0.0.1',
      port,
      path,
      method: opts.method ?? 'GET',
      headers: {
        host: 'localhost',
        ...opts.headers,
      },
    };
    const r = http.request(reqOpts, (res) => {
      let body = '';
      res.on('data', (c: Buffer) => (body += c.toString()));
      res.on('end', () => {
        const parsed = (() => { try { return JSON.parse(body); } catch { return body; } })();
        resolve({
          status: res.statusCode!,
          body: parsed,
          headers: res.headers as Record<string, string>,
        });
      });
    });
    r.on('error', reject);
    if (opts.body) r.write(opts.body);
    r.end();
  });
}

function openWebSocket(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws`, {
      headers: { authorization: 'Bearer test-secret' },
    });
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

async function getReleasedLocalPort(): Promise<number> {
  const s = http.createServer();
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve));
  const releasedPort = (s.address() as any).port;
  await new Promise<void>((resolve) => s.close(() => resolve()));
  return releasedPort;
}

function waitForMockCall(mock: ReturnType<typeof vi.fn>, timeoutMs = 1000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (mock.mock.calls.length > 0) {
        resolve();
        return;
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error('timed out waiting for mock call'));
        return;
      }
      setTimeout(tick, 10);
    };
    tick();
  });
}

function useRuneMcpRegistry(): void {
  (readRegistry as ReturnType<typeof vi.fn>).mockReturnValueOnce({
    version: 1,
    builtAt: '2026-06-28T00:00:00.000Z',
    products: [
      {
        name: 'rune-mcp',
        class: 'internal',
        repoBacked: true,
        projects: [{ slug: '19-rune-product-os', status: 'active' }],
      },
    ],
  });
}

function findRuneMcpMonitoring(body: any): any {
  const runeMcp = body.products.find((p: any) => p.name === 'rune-mcp');
  expect(runeMcp).toBeDefined();
  return runeMcp.monitoring?.mcp;
}

const mcpMetricsSnapshotFixture = {
  totals: { calls: 42, errors: 3, timeouts: 1 },
  tools: {
    kb_query: {
      calls: 21,
      errors: 2,
      timeouts: 1,
      latencyMs: { p50: 24, p95: 88, p99: 144, sampleCount: 21, windowSize: 1024 },
    },
    mcp_metrics_snapshot: {
      calls: 4,
      errors: 0,
      timeouts: 0,
      latencyMs: { p50: 2, p95: 3, p99: 5, sampleCount: 4, windowSize: 1024 },
    },
  },
  activeSessions: 2,
  warmIndex: {
    ready: true,
    ageMs: 15_000,
    lastRebuild: { status: 'ok', files: 120, lines: 7_500 },
  },
};

async function startMcpHealthServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ port: number; close: () => Promise<void> }> {
  const mcpServer = http.createServer(handler);
  const sockets = new Set<{ destroy: () => void }>();
  mcpServer.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => mcpServer.listen(0, '127.0.0.1', resolve));
  return {
    port: (mcpServer.address() as any).port,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => mcpServer.close(() => resolve()));
    },
  };
}

type FakeMcpRequest = {
  method: string | undefined;
  path: string;
  headers: IncomingHttpHeaders;
  body: any;
};

async function startMcpMetricsToolServer(opts: {
  toolResult?: 'ok' | 'tool-error';
  requiredBearerToken?: string;
  /**
   * How the fake daemon frames MCP protocol responses. The real Streamable-HTTP
   * daemon answers with SSE (`text/event-stream`) because the SDK transport does
   * not enable JSON responses, so that is the default. `'json'` covers the
   * forward-compatible case where `enableJsonResponse` is ever turned on.
   */
  transport?: 'sse' | 'json';
} = {}): Promise<{ port: number; requests: FakeMcpRequest[]; close: () => Promise<void> }> {
  const requests: FakeMcpRequest[] = [];
  const transport = opts.transport ?? 'sse';
  const writeMcpResult = (
    res: ServerResponse,
    message: unknown,
    extraHeaders: Record<string, string> = {},
  ): void => {
    if (transport === 'sse') {
      res.writeHead(200, { ...extraHeaders, 'Content-Type': 'text/event-stream' });
      res.end(`event: message\ndata: ${JSON.stringify(message)}\n\n`);
    } else {
      res.writeHead(200, { ...extraHeaders, 'Content-Type': 'application/json' });
      res.end(JSON.stringify(message));
    }
  };
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

      if (req.method !== 'POST' || path !== '/mcp') {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'expected MCP Streamable HTTP /mcp call' }));
        return;
      }
      if (opts.requiredBearerToken && req.headers.authorization !== `Bearer ${opts.requiredBearerToken}`) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          id: body?.id ?? null,
          error: { code: -32001, message: 'Unauthorized: valid bearer token required' },
        }));
        return;
      }

      if (body?.method === 'initialize') {
        writeMcpResult(res, {
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
        writeMcpResult(res, {
          jsonrpc: '2.0',
          id: body.id,
          result: opts.toolResult === 'tool-error'
            ? {
                isError: true,
                content: [{ type: 'text', text: 'metrics unavailable from daemon' }],
              }
            : {
                content: [{ type: 'text', text: JSON.stringify(mcpMetricsSnapshotFixture) }],
              },
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

// ---- mock WebviewSender ----

const mockWebviewSender = {
  name: 'webview' as const,
  register: vi.fn(),
  unregister: vi.fn(),
  send: vi.fn(async (_userId: number, _message: string, _opts?: { approval?: unknown }) => undefined),
  startTyping: vi.fn(),
  stopTyping: vi.fn(),
  shutdown: vi.fn(),
};

// ---- server setup ----

let server: Server;
let webviewHandler: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;
let port: number;

describe('server/webview', () => {
  beforeAll(async () => {
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

  afterAll(() => {
    server.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockActiveRunsMap.clear();
    mockConfig.RUNE_HTTP_SECRET = 'test-secret';
    mockConfig.RUNE_MCP_OAUTH_STORE_FILE = '/test/missing-rune-mcp-oauth-store.json';
    mockConfig.RUNE_MCP_HOST = '127.0.0.1';
    mockConfig.RUNE_MCP_PORT = 65534;
    // Reset mocks to sensible defaults after clearAllMocks
    (getSession as ReturnType<typeof vi.fn>).mockReturnValue(null);
    (handleWebviewMessage as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (getStateSnapshot as ReturnType<typeof vi.fn>).mockReturnValue({
      version: 1,
      ready: true,
      sessions: { webview: null, telegram: null },
      activeReview: null,
      ingestionQueueDepth: 0,
      recentAgentRuns: [],
      pendingApprovals: { playbook: 0, proposal: 0 },
      lastMorningPrepAt: null,
      lastNightlyAt: null,
      warnings: [],
    });
    (readRegistry as ReturnType<typeof vi.fn>).mockReturnValue(mockRegistry);
    (approveActivePlanningSession as ReturnType<typeof vi.fn>).mockReturnValue({
      ok: false,
      reason: 'no-session',
    });
    (getPlanningSession as ReturnType<typeof vi.fn>).mockReturnValue(null);
    (runDownstreamPlan as ReturnType<typeof vi.fn>).mockResolvedValue({
      product: 'rune',
      title: 'Downstream Plan',
      spec: 'Spec.',
      techSpec: 'Tech spec.',
      tasks: 'Tasks.',
      testPlan: 'Test plan.',
      context: 'Context.',
    });
    (runScaffoldApproval as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      slug: '20-downstream-plan',
      agentText: 'Created docs/projects/20-downstream-plan/spec.md',
      promotion: 'none',
    });
    mockRegisterOp.mockReturnValue({
      opId: 'op-webview-post-approval-plan',
      kind: 'agent',
      label: 'planning approval',
      userId: 42,
      startedAt: 1,
      startedAtIso: '2026-07-01T12:00:00.000Z',
      child: { kill: vi.fn() },
      cancelled: false,
    });
    mockIsCancelled.mockReturnValue(false);
    // Re-establish the default getProjectSummaries return alongside the
    // other restored mocks for consistency — vi.clearAllMocks clears call
    // history but not implementations today, so the default persists; this
    // line keeps the suite resilient if the config ever flips to
    // vi.resetAllMocks (which would clear implementations too).
    mockGetProjectSummaries.mockReturnValue([]);
  });

  // ---- GET / ----

  describe('GET /', () => {
    it('returns 403 when host header is not in allowed set', async () => {
      const res = await makeRequest(port, '/', {
        headers: { host: 'evil.com' },
      });
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('forbidden');
    });

    it('returns 404 when index.html is absent (no static dir in test env)', async () => {
      // The static dir at src/server/static/ does not exist in CI/test env,
      // so handleIndexHtml catches the readFile error and sends 404.
      const res = await makeRequest(port, '/');
      // Either 404 (file not found) or 200 (if index.html happened to be present).
      // We only assert that the host guard passed (not 403) and the route was handled (not fallthrough 404 with "fallthrough" body).
      expect(res.status).not.toBe(403);
      if (res.status === 404) {
        expect(res.body).toBe('Not found');
      } else {
        expect(res.status).toBe(200);
      }
    });
  });

  // ---- GET /static/<file> ----

  describe('GET /static/<file>', () => {
    it('returns 200 and correct MIME type for an existing static file', async () => {
      // src/server/static/app.js is present in the repo — it should be served correctly.
      const res = await makeRequest(port, '/static/app.js');
      expect(res.status).toBe(200);
    });

    it('returns 404 when static file does not exist', async () => {
      const res = await makeRequest(port, '/static/nonexistent-file-xyz.js');
      expect(res.status).toBe(404);
      expect(res.body).toBe('Not found');
    });

    it('returns 403 on path traversal attempt', async () => {
      const res = await makeRequest(port, '/static/../config.js');
      // Node.js HTTP normalises the path, so /static/../config.js becomes /config.js,
      // which won't match /static/ prefix — it falls through to 404 fallback.
      // Either 403 (if the raw path reaches the handler) or 404 fallback is acceptable.
      expect([403, 404]).toContain(res.status);
    });

    it('returns 403 when path traversal is encoded in the filename segment', async () => {
      const res = await makeRequest(port, '/static/..%2Fconfig.js');
      // Node.js keeps the raw encoded path; the handler checks for '..' in relative.
      // After slice('/static/'.length) we get '..%2Fconfig.js' — no literal '..'
      // but the resolved path will escape STATIC_DIR, triggering the second guard.
      expect([403, 404]).toContain(res.status);
    });
  });

  // ---- POST /api/auth-bootstrap ----

  describe('POST /api/auth-bootstrap', () => {
    it('returns 401 when no secret is configured', async () => {
      mockConfig.RUNE_HTTP_SECRET = '';
      const res = await makeRequest(port, '/api/auth-bootstrap', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: 'anything' }),
      });
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('unauthorized');
    });

    it('returns 401 when token is wrong', async () => {
      const res = await makeRequest(port, '/api/auth-bootstrap', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: 'wrong-token' }),
      });
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('unauthorized');
    });

    it('returns 400 on invalid JSON body', async () => {
      const res = await makeRequest(port, '/api/auth-bootstrap', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'not-json{',
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid JSON body');
    });

    it('returns 200 and Set-Cookie on correct token', async () => {
      const res = await makeRequest(port, '/api/auth-bootstrap', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: 'test-secret' }),
      });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      // Node.js http.IncomingMessage returns set-cookie as string[]
      const cookies = res.headers['set-cookie'] as unknown as string[];
      expect(Array.isArray(cookies)).toBe(true);
      const cookieStr = cookies.join('; ');
      expect(cookieStr).toContain('rune-auth=test-secret');
      expect(cookieStr).toContain('HttpOnly');
      expect(cookieStr).toContain('SameSite=Strict');
    });

    it('returns 403 when host is not allowed', async () => {
      const res = await makeRequest(port, '/api/auth-bootstrap', {
        method: 'POST',
        headers: { host: 'evil.com', 'content-type': 'application/json' },
        body: JSON.stringify({ token: 'test-secret' }),
      });
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('forbidden');
    });
  });

  // ---- GET /api/state ----

  describe('GET /api/state', () => {
    it('returns 401 without auth', async () => {
      const res = await makeRequest(port, '/api/state');
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('unauthorized');
    });

    it('returns 200 with snapshot when authenticated via bearer token', async () => {
      const res = await makeRequest(port, '/api/state', {
        headers: { authorization: 'Bearer test-secret' },
      });
      expect(res.status).toBe(200);
      expect(res.body.ready).toBe(true);
      expect(res.body.sessions).toEqual({ webview: null, telegram: null });
      expect(res.body.activeReview).toBeNull();
      expect(res.body.ingestionQueueDepth).toBe(0);
    });

    it('reflects active sessions in snapshot', async () => {
      (getStateSnapshot as ReturnType<typeof vi.fn>).mockReturnValue({
        version: 1, ready: true,
        sessions: {
          webview: { sessionId: 'sess-abc', model: 'opus', messageCount: 3 },
          telegram: null,
        },
        activeReview: null, ingestionQueueDepth: 0, recentAgentRuns: [],
        pendingApprovals: { playbook: 0, proposal: 0 },
        lastMorningPrepAt: null, lastNightlyAt: null, warnings: [],
      });
      const res = await makeRequest(port, '/api/state', {
        headers: { authorization: 'Bearer test-secret' },
      });
      expect(res.status).toBe(200);
      expect(res.body.sessions).toEqual({
        webview: { sessionId: 'sess-abc', model: 'opus', messageCount: 3 },
        telegram: null,
      });
    });

    it('reflects active review in snapshot', async () => {
      (getStateSnapshot as ReturnType<typeof vi.fn>).mockReturnValue({
        version: 1, ready: true, sessions: { webview: null, telegram: null },
        activeReview: { type: 'daily', phase: 'interview', targetDate: '2026-05-05' },
        ingestionQueueDepth: 0, recentAgentRuns: [],
        pendingApprovals: { playbook: 0, proposal: 0 },
        lastMorningPrepAt: null, lastNightlyAt: null, warnings: [],
      });
      const res = await makeRequest(port, '/api/state', {
        headers: { authorization: 'Bearer test-secret' },
      });
      expect(res.status).toBe(200);
      expect(res.body.activeReview).toEqual({
        type: 'daily',
        phase: 'interview',
        targetDate: '2026-05-05',
      });
    });

    it('reflects non-empty ingestion queue depth', async () => {
      (getStateSnapshot as ReturnType<typeof vi.fn>).mockReturnValue({
        version: 1, ready: true, sessions: { webview: null, telegram: null }, activeReview: null,
        ingestionQueueDepth: 2, recentAgentRuns: [],
        pendingApprovals: { playbook: 0, proposal: 0 },
        lastMorningPrepAt: null, lastNightlyAt: null, warnings: [],
      });
      const res = await makeRequest(port, '/api/state', {
        headers: { authorization: 'Bearer test-secret' },
      });
      expect(res.status).toBe(200);
      expect(res.body.ingestionQueueDepth).toBe(2);
    });
  });

  describe('POST /api/planning/approve — PM-spec approval persistence', () => {
    const pmSpecArtifact = {
      version: 2,
      kind: 'pm-spec',
      product: 'rune',
      title: 'Cockpit PM Spec',
      spec: 'Approved PM-only scope.',
      assumptions: ['The approval artifact is PM-only.'],
      selfReview: { revised: false, summary: 'Spec is internally consistent.' },
    };

    const downstreamArtifact = {
      product: 'rune',
      title: 'Cockpit PM Spec',
      spec: 'Approved PM-only scope.',
      techSpec: 'Tech lead breakdown.',
      tasks: '## Phase 1\n### Tests (write first)\n- [ ] approval persists downstream artifact',
      testPlan: '## Approval resume\n- [ ] retries skip downstream once persisted',
      context: '# Context',
    };

    function approvedPmSpecSession(over: Record<string, unknown> = {}) {
      return {
        id: 'pm-spec-plan-webview',
        chatId: 42,
        claudeSessionId: 'claude-pm-spec-plan',
        planning: {
          status: 'approved' as const,
          product: 'rune',
          idea: 'new plan',
          surface: 'cockpit' as const,
          approvedSpec: pmSpecArtifact,
        },
        createdAt: '2026-07-01T00:00:00.000Z',
        lastActivity: '2026-07-01T00:00:00.000Z',
        ...over,
      };
    }

    function legacyApprovedSession() {
      return {
        id: 'legacy-plan-webview',
        chatId: 42,
        claudeSessionId: 'claude-legacy-plan',
        planning: {
          status: 'approved' as const,
          product: 'rune',
          idea: 'old plan',
          surface: 'cockpit' as const,
          artifact: {
            product: 'rune',
            title: 'Legacy Full Plan',
            spec: 'Old approved spec.',
            techSpec: 'Old tech spec.',
            tasks: 'Old tasks.',
            testPlan: 'Old test plan.',
          },
        },
        createdAt: '2026-07-01T00:00:00.000Z',
        lastActivity: '2026-07-01T00:00:00.000Z',
      };
    }

    function versionOnlyApprovedSession() {
      return {
        id: 'version-only-plan-webview',
        chatId: 42,
        claudeSessionId: 'claude-version-only-plan',
        planning: {
          status: 'approved' as const,
          product: 'rune',
          idea: 'old plan with partial marker',
          surface: 'cockpit' as const,
          approvedSpec: {
            version: 2,
            product: 'rune',
            title: 'Version Only Plan',
            spec: 'This persisted approval lacks kind: pm-spec.',
          },
        },
        createdAt: '2026-07-01T00:00:00.000Z',
        lastActivity: '2026-07-01T00:00:00.000Z',
      };
    }

    it('runs downstream planning from the PM-only approval artifact, persists it, then scaffolds', async () => {
      (approveActivePlanningSession as ReturnType<typeof vi.fn>).mockReturnValue({
        ok: true,
        session: approvedPmSpecSession(),
      });
      (runDownstreamPlan as ReturnType<typeof vi.fn>).mockResolvedValue(downstreamArtifact);

      const res = await makeRequest(port, '/api/planning/approve', {
        method: 'POST',
        headers: { authorization: 'Bearer test-secret' },
      });

      expect(res.status).toBe(200);
      expect(runDownstreamPlan).toHaveBeenCalledWith(pmSpecArtifact, expect.any(Object));
      expect(updatePlanningSession).toHaveBeenCalledWith(42, expect.any(Function));
      expect((updatePlanningSession as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!).toBeLessThan(
        (runScaffoldApproval as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!,
      );
      const scaffoldedSession = (runScaffoldApproval as ReturnType<typeof vi.fn>).mock.calls[0]![0] as any;
      expect(scaffoldedSession.planning.approvedSpec).toEqual(pmSpecArtifact);
      expect(scaffoldedSession.planning.downstreamArtifact).toEqual(downstreamArtifact);
      expect(deletePlanningSession).toHaveBeenCalledWith(42);
    });

    it('streams downstream progress, critique warnings, scaffold stage, and scaffold success through the webview sender', async () => {
      (approveActivePlanningSession as ReturnType<typeof vi.fn>).mockReturnValue({
        ok: true,
        session: approvedPmSpecSession(),
      });
      (runDownstreamPlan as ReturnType<typeof vi.fn>).mockImplementation(
        async (_approvedSpec: unknown, options: any) => {
          if (typeof options.progress === 'function') {
            await options.progress({ stage: 'tech-lead-breakdown' });
            await options.progress({ stage: 'pm-review-match' });
            await options.progress({ stage: 'claude-critique' });
            await options.progress({ stage: 'codex-critique' });
            await options.progress({
              warning: 'Codex critique skipped after reading /test/project/private-plan.md; continuing with the last coherent plan.',
            });
            await options.progress({ stage: 'context-seed' });
          }
          return downstreamArtifact;
        },
      );
      (runScaffoldApproval as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        slug: '20-downstream-plan',
        agentText: 'Created docs/projects/20-downstream-plan/spec.md',
        promotion: 'none',
      });

      const res = await makeRequest(port, '/api/planning/approve', {
        method: 'POST',
        headers: { authorization: 'Bearer test-secret' },
      });

      expect(res.status).toBe(200);
      expect(runDownstreamPlan).toHaveBeenCalledWith(
        pmSpecArtifact,
        expect.objectContaining({ progress: expect.any(Function) }),
      );
      const messages = mockWebviewSender.send.mock.calls.map(([, message]) => String(message));
      expect(messages.filter((message) => /^Planning progress: tech[- ]lead breakdown\.$/i.test(message))).toHaveLength(1);
      expect(messages.filter((message) => /^Planning progress: PM review\.$/i.test(message))).toHaveLength(1);
      expect(messages.filter((message) => /^Planning progress: Claude critique\.$/i.test(message))).toHaveLength(1);
      expect(messages.filter((message) => /^Planning progress: Codex critique\.$/i.test(message))).toHaveLength(1);
      const warning = messages.find((message) => /codex.*skipped/i.test(message));
      expect(warning).toBeDefined();
      expect(warning).not.toContain('/test/project');
      expect(warning).toContain('<project>');
      expect(messages.filter((message) => /^Planning progress: context seed\.$/i.test(message))).toHaveLength(1);
      expect(messages.filter((message) => /^Planning progress: scaffold\.$/i.test(message))).toHaveLength(1);
      expect(messages.some((message) => /Planning succeeded:.*Created docs\/projects\/20-downstream-plan\/spec\.md/i.test(message))).toBe(true);
      expect(mockWebviewSender.send.mock.calls.every((call) => call[2]?.approval === undefined)).toBe(true);
    });

    it('registers the webview approval pipeline as a cancellable in-flight op and marks it successful after scaffold success', async () => {
      (approveActivePlanningSession as ReturnType<typeof vi.fn>).mockReturnValue({
        ok: true,
        session: approvedPmSpecSession(),
      });
      (runDownstreamPlan as ReturnType<typeof vi.fn>).mockResolvedValue(downstreamArtifact);
      (runScaffoldApproval as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        slug: '20-webview-inflight-plan',
        agentText: 'Created docs/projects/20-webview-inflight-plan/spec.md',
        promotion: 'none',
      });

      const res = await makeRequest(port, '/api/planning/approve', {
        method: 'POST',
        headers: { authorization: 'Bearer test-secret' },
      });

      expect(res.status).toBe(200);
      expect(mockRegisterOp).toHaveBeenCalledOnce();
      expect(mockRegisterOp).toHaveBeenCalledWith(expect.objectContaining({
        userId: 42,
        label: expect.stringMatching(/planning|approve|scaffold/i),
        child: expect.objectContaining({ kill: expect.any(Function) }),
      }));
      expect(mockRegisterOp.mock.invocationCallOrder[0]!).toBeLessThan(
        (runDownstreamPlan as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!,
      );
      expect((runDownstreamPlan as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!).toBeLessThan(
        (runScaffoldApproval as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!,
      );

      const successIndex = mockWebviewSender.send.mock.calls.findIndex(([, message]) =>
        /Planning succeeded:.*Created docs\/projects\/20-webview-inflight-plan\/spec\.md/i.test(String(message)),
      );
      expect(successIndex).toBeGreaterThanOrEqual(0);
      expect(mockUnregisterOp).toHaveBeenCalledWith('op-webview-post-approval-plan', 'success');
      expect(mockUnregisterOp.mock.invocationCallOrder[0]!).toBeGreaterThan(
        mockWebviewSender.send.mock.invocationCallOrder[successIndex]!,
      );
      expect(deletePlanningSession).toHaveBeenCalledWith(42);
    });

    it('surfaces a scrubbed terminal progress line when scaffold fails', async () => {
      (approveActivePlanningSession as ReturnType<typeof vi.fn>).mockReturnValue({
        ok: true,
        session: approvedPmSpecSession(),
      });
      (runDownstreamPlan as ReturnType<typeof vi.fn>).mockResolvedValue(downstreamArtifact);
      (runScaffoldApproval as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: false,
        reason: 'agent',
        message: 'project-setup-writer failed while writing /test/project/docs/projects/20-downstream-plan/spec.md',
      });

      const res = await makeRequest(port, '/api/planning/approve', {
        method: 'POST',
        headers: { authorization: 'Bearer test-secret' },
      });

      expect(res.status).toBe(500);
      expect(deletePlanningSession).not.toHaveBeenCalled();
      const messages = mockWebviewSender.send.mock.calls.map(([, message]) => String(message));
      const terminal = messages.find((message) => /Planning stopped:.*scaffold/i.test(message));
      expect(terminal).toBeDefined();
      expect(terminal).not.toContain('/test/project');
      expect(terminal).toContain('<project>');
      expect(String(res.body.error)).not.toContain('/test/project');
      expect(String(res.body.error)).toContain('<project>');
    });

    it('marks the webview in-flight op as error on scaffold terminal failure after downstream planning was persisted', async () => {
      (approveActivePlanningSession as ReturnType<typeof vi.fn>).mockReturnValue({
        ok: true,
        session: approvedPmSpecSession(),
      });
      (runDownstreamPlan as ReturnType<typeof vi.fn>).mockResolvedValue(downstreamArtifact);
      (runScaffoldApproval as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: false,
        reason: 'agent',
        message: 'project-setup-writer failed while writing /test/project/docs/projects/20-webview-inflight-plan/spec.md',
      });

      const res = await makeRequest(port, '/api/planning/approve', {
        method: 'POST',
        headers: { authorization: 'Bearer test-secret' },
      });

      expect(res.status).toBe(500);
      expect(updatePlanningSession).toHaveBeenCalledWith(42, expect.any(Function));
      expect(deletePlanningSession).not.toHaveBeenCalled();
      const terminal = mockWebviewSender.send.mock.calls.find(([, message]) =>
        /Planning stopped:.*scaffold/i.test(String(message)),
      )?.[1] as string | undefined;
      expect(terminal).toBeDefined();
      expect(terminal).not.toContain('/test/project');
      expect(terminal).toContain('<project>');
      expect(mockUnregisterOp).toHaveBeenCalledWith(
        'op-webview-post-approval-plan',
        'error',
        expect.stringMatching(/scaffold.*<project>/i),
      );
    });

    it('cooperatively cancels the webview approval pipeline at the next downstream stage boundary', async () => {
      (approveActivePlanningSession as ReturnType<typeof vi.fn>).mockReturnValue({
        ok: true,
        session: approvedPmSpecSession(),
      });
      let completedStageBoundaries = 0;
      mockIsCancelled.mockImplementation(() => completedStageBoundaries >= 1);
      (runDownstreamPlan as ReturnType<typeof vi.fn>).mockImplementation(
        async (_approvedSpec: unknown, options: any) => {
          await options.progress({ stage: 'tech-lead-breakdown' });
          completedStageBoundaries += 1;
          await options.progress({ stage: 'pm-review-match' });
          return downstreamArtifact;
        },
      );

      const res = await makeRequest(port, '/api/planning/approve', {
        method: 'POST',
        headers: { authorization: 'Bearer test-secret' },
      });

      expect(res.status).toBe(499);
      expect(runScaffoldApproval).not.toHaveBeenCalled();
      expect(updatePlanningSession).not.toHaveBeenCalled();
      expect(deletePlanningSession).not.toHaveBeenCalled();
      const messages = mockWebviewSender.send.mock.calls.map(([, message]) => String(message));
      expect(messages.filter((message) => /^Planning progress: tech[- ]lead breakdown\.$/i.test(message))).toHaveLength(1);
      expect(messages.some((message) => /^Planning progress: PM review\.$/i.test(message))).toBe(false);
      expect(messages.some((message) => /Planning stopped:.*cancelled/i.test(message))).toBe(true);
      expect(messages.some((message) => /click approve again|run \/approve again/i.test(message))).toBe(true);
      expect(mockUnregisterOp).toHaveBeenCalledWith('op-webview-post-approval-plan', 'cancelled');
    });

    it('retry path reruns downstream when the approved session has only approvedSpec', async () => {
      (getPlanningSession as ReturnType<typeof vi.fn>).mockReturnValue(approvedPmSpecSession());
      (runDownstreamPlan as ReturnType<typeof vi.fn>).mockResolvedValue(downstreamArtifact);

      const res = await makeRequest(port, '/api/planning/approve', {
        method: 'POST',
        headers: { authorization: 'Bearer test-secret' },
      });

      expect(res.status).toBe(200);
      expect(approveActivePlanningSession).not.toHaveBeenCalled();
      expect(runDownstreamPlan).toHaveBeenCalledWith(pmSpecArtifact, expect.any(Object));
      expect(updatePlanningSession).toHaveBeenCalledWith(42, expect.any(Function));
      const scaffoldedSession = (runScaffoldApproval as ReturnType<typeof vi.fn>).mock.calls[0]![0] as any;
      expect(scaffoldedSession.planning.approvedSpec).toEqual(pmSpecArtifact);
      expect(scaffoldedSession.planning.downstreamArtifact).toEqual(downstreamArtifact);
      expect(deletePlanningSession).toHaveBeenCalledWith(42);
    });

    it('retry path skips downstream when downstreamArtifact is already persisted', async () => {
      const session = approvedPmSpecSession({
        planning: {
          status: 'approved' as const,
          product: 'rune',
          idea: 'new plan',
          surface: 'cockpit' as const,
          approvedSpec: pmSpecArtifact,
          downstreamArtifact,
        },
      });
      (getPlanningSession as ReturnType<typeof vi.fn>).mockReturnValue(session);

      const res = await makeRequest(port, '/api/planning/approve', {
        method: 'POST',
        headers: { authorization: 'Bearer test-secret' },
      });

      expect(res.status).toBe(200);
      expect(approveActivePlanningSession).not.toHaveBeenCalled();
      expect(runDownstreamPlan).not.toHaveBeenCalled();
      expect(updatePlanningSession).not.toHaveBeenCalled();
      expect(runScaffoldApproval).toHaveBeenCalledWith(session);
      expect(deletePlanningSession).toHaveBeenCalledWith(42);
    });

    it('hard-fails a legacy approval transition that lacks the version 2 pm-spec discriminant', async () => {
      (approveActivePlanningSession as ReturnType<typeof vi.fn>).mockReturnValue({
        ok: true,
        session: legacyApprovedSession(),
      });

      const res = await makeRequest(port, '/api/planning/approve', {
        method: 'POST',
        headers: { authorization: 'Bearer test-secret' },
      });

      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/restart planning/i);
      expect(runDownstreamPlan).not.toHaveBeenCalled();
      expect(runScaffoldApproval).not.toHaveBeenCalled();
      expect(deletePlanningSession).not.toHaveBeenCalled();
    });

    it('hard-fails a legacy spec-proposed transition result before downstream planning or scaffold', async () => {
      (approveActivePlanningSession as ReturnType<typeof vi.fn>).mockReturnValue({
        ok: false,
        reason: 'legacy-artifact',
      });

      const res = await makeRequest(port, '/api/planning/approve', {
        method: 'POST',
        headers: { authorization: 'Bearer test-secret' },
      });

      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/restart planning|pm-spec/i);
      expect(runDownstreamPlan).not.toHaveBeenCalled();
      expect(runScaffoldApproval).not.toHaveBeenCalled();
      expect(deletePlanningSession).not.toHaveBeenCalled();
    });

    it('hard-fails a stored approval with version 2 but no pm-spec kind discriminant', async () => {
      (approveActivePlanningSession as ReturnType<typeof vi.fn>).mockReturnValue({
        ok: true,
        session: versionOnlyApprovedSession(),
      });

      const res = await makeRequest(port, '/api/planning/approve', {
        method: 'POST',
        headers: { authorization: 'Bearer test-secret' },
      });

      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/restart planning/i);
      expect(runDownstreamPlan).not.toHaveBeenCalled();
      expect(runScaffoldApproval).not.toHaveBeenCalled();
      expect(deletePlanningSession).not.toHaveBeenCalled();
    });

    it('hard-fails an already-approved legacy retry session before downstream planning or scaffold', async () => {
      (getPlanningSession as ReturnType<typeof vi.fn>).mockReturnValue(legacyApprovedSession());

      const res = await makeRequest(port, '/api/planning/approve', {
        method: 'POST',
        headers: { authorization: 'Bearer test-secret' },
      });

      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/restart planning/i);
      expect(approveActivePlanningSession).not.toHaveBeenCalled();
      expect(runDownstreamPlan).not.toHaveBeenCalled();
      expect(runScaffoldApproval).not.toHaveBeenCalled();
      expect(deletePlanningSession).not.toHaveBeenCalled();
    });
  });

  // ---- GET /api/cockpit ----

  describe('GET /api/cockpit', () => {
    it('returns 401 without auth', async () => {
      const res = await makeRequest(port, '/api/cockpit');
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('unauthorized');
    });

    it('returns the cockpit view built from the registry when authenticated', async () => {
      const res = await makeRequest(port, '/api/cockpit', {
        headers: { authorization: 'Bearer test-secret' },
      });
      expect(res.status).toBe(200);
      expect(res.body.available).toBe(true);
      expect(res.body.products).toHaveLength(1);
      expect(res.body.products[0]).toMatchObject({ name: 'aura', repoBacked: true });
      const project = res.body.products[0].projects[0];
      expect(project).toMatchObject({ slug: '01-mvp', lifecycleStatus: 'active', runStatus: 'idle' });
      expect(project.actions).toEqual(
        expect.arrayContaining(['start', 'continue', 'enter-planning-mode']),
      );
    });

    it('returns product class and container capabilities on /api/cockpit product payloads', async () => {
      const res = await makeRequest(port, '/api/cockpit', {
        headers: { authorization: 'Bearer test-secret' },
      });

      expect(res.status).toBe(200);
      expect(res.body.products[0]).toMatchObject({
        name: 'aura',
        class: 'external',
        containerCapabilities: {
          projects: true,
          bugs: true,
          ideas: true,
          runs: true,
          chat: true,
          monitoring: 'stubbed',
        },
      });
    });

    it('returns a 200 unavailable view when the registry cannot be read', async () => {
      (readRegistry as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error('registry not yet built');
      });
      const res = await makeRequest(port, '/api/cockpit', {
        headers: { authorization: 'Bearer test-secret' },
      });
      // A registry read failure is a clear cockpit state, not a server error.
      expect(res.status).toBe(200);
      expect(res.body.available).toBe(false);
      expect(typeof res.body.unavailableReason).toBe('string');
    });

    it('feeds live run-status — a project with an active work-run shows as running', async () => {
      // The webview reads run-status via readCockpitRunStatus, which projects
      // the supervised-runs store through getVisibility + the mapper.
      mockReadCockpitRunStatus.mockReturnValueOnce({ '01-mvp': 'running' });
      const res = await makeRequest(port, '/api/cockpit', {
        headers: { authorization: 'Bearer test-secret' },
      });
      expect(res.status).toBe(200);
      expect(res.body.products[0].projects[0]).toMatchObject({ slug: '01-mvp', runStatus: 'running' });
    });

    it('surfaces a project blocked-on-human via the readCockpitRunStatus helper', async () => {
      mockReadCockpitRunStatus.mockReturnValueOnce({ '01-mvp': 'blocked-on-human' });
      const res = await makeRequest(port, '/api/cockpit', {
        headers: { authorization: 'Bearer test-secret' },
      });
      expect(res.status).toBe(200);
      expect(res.body.products[0].projects[0]).toMatchObject({
        slug: '01-mvp',
        runStatus: 'blocked-on-human',
      });
    });

    it('overlays a live read of rune tasks.md onto rune project cards', async () => {
      // handleApiCockpit overlays getProjectSummaries() (a fresh, rune-local
      // read) onto the registry's rune product so rune cards update in real
      // time. The overlay is scoped to the rune product to avoid a slug shared
      // with another product overriding its counts.
      (readRegistry as ReturnType<typeof vi.fn>).mockReturnValueOnce({
        version: 1,
        builtAt: '2026-06-03T00:00:00.000Z',
        products: [{ name: 'rune', repoBacked: true, projects: [{ slug: '01-mvp', status: 'active' }] }],
      });
      mockGetProjectSummaries.mockReturnValueOnce([
        { slug: '01-mvp', progress: { done: 7, total: 12, perPhase: [] }, status: 'In Progress', specPath: '', lastModified: null } as any,
      ]);
      const res = await makeRequest(port, '/api/cockpit', {
        headers: { authorization: 'Bearer test-secret' },
      });
      expect(res.status).toBe(200);
      expect(res.body.products[0].projects[0]).toMatchObject({
        slug: '01-mvp',
        taskProgress: { done: 7, total: 12 },
      });
    });

    it('surfaces a non-rune product\'s task progress from the registry, not the live rune read', async () => {
      // Cross-product progress rides on the registry entry (refreshed on rebuild);
      // the live rune-local read must NOT bleed onto another product even when
      // slugs collide. Here both rune and aura have a '01-mvp'; aura keeps its
      // registry-baked counts.
      (readRegistry as ReturnType<typeof vi.fn>).mockReturnValueOnce({
        version: 1,
        builtAt: '2026-06-03T00:00:00.000Z',
        products: [
          { name: 'aura', repoBacked: true, projects: [{ slug: '01-mvp', status: 'active', progress: { done: 2, total: 9 } }] },
          { name: 'rune', repoBacked: true, projects: [{ slug: '01-mvp', status: 'active' }] },
        ],
      });
      // Live rune read reports different counts for the same slug.
      mockGetProjectSummaries.mockReturnValueOnce([
        { slug: '01-mvp', progress: { done: 7, total: 12, perPhase: [] }, status: 'In Progress', specPath: '', lastModified: null } as any,
      ]);
      const res = await makeRequest(port, '/api/cockpit', {
        headers: { authorization: 'Bearer test-secret' },
      });
      expect(res.status).toBe(200);
      const aura = res.body.products.find((p: any) => p.name === 'aura');
      const rune = res.body.products.find((p: any) => p.name === 'rune');
      expect(aura.projects[0].taskProgress).toEqual({ done: 2, total: 9 }); // registry, not the live read
      expect(rune.projects[0].taskProgress).toEqual({ done: 7, total: 12 }); // live overlay
    });

    it('survives a getProjectSummaries throw — cockpit still renders without taskProgress', async () => {
      mockGetProjectSummaries.mockImplementationOnce(() => {
        throw new Error('tasks.md unreadable');
      });
      const res = await makeRequest(port, '/api/cockpit', {
        headers: { authorization: 'Bearer test-secret' },
      });
      expect(res.status).toBe(200);
      expect(res.body.available).toBe(true);
      expect(res.body.products[0].projects[0].taskProgress).toBeUndefined();
    });

    it('web-starts-with-mcp-degraded: marks Rune MCP monitoring degraded when the daemon health endpoint is unreachable', async () => {
      const unreachablePort = await getReleasedLocalPort();
      mockConfig.RUNE_MCP_HOST = '127.0.0.1';
      mockConfig.RUNE_MCP_PORT = unreachablePort;
      useRuneMcpRegistry();

      const res = await makeRequest(port, '/api/cockpit', {
        headers: { authorization: 'Bearer test-secret' },
      });

      expect(res.status).toBe(200);
      expect(res.body.available).toBe(true);
      expect(findRuneMcpMonitoring(res.body)).toMatchObject({
        status: 'degraded',
        endpoint: `http://127.0.0.1:${unreachablePort}/health`,
        error: expect.stringMatching(/ECONNREFUSED|unreachable|down/i),
        checkedAt: expect.any(String),
      });
    });

    it('web-starts-with-mcp-degraded: treats unauthenticated MCP health as degraded without failing cockpit state', async () => {
      const mcpServer = await startMcpHealthServer((_req, res) => {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
      });
      try {
        mockConfig.RUNE_MCP_HOST = '127.0.0.1';
        mockConfig.RUNE_MCP_PORT = mcpServer.port;
        useRuneMcpRegistry();

        const res = await makeRequest(port, '/api/cockpit', {
          headers: { authorization: 'Bearer test-secret' },
        });

        expect(res.status).toBe(200);
        expect(res.body.available).toBe(true);
        expect(findRuneMcpMonitoring(res.body)).toMatchObject({
          status: 'degraded',
          endpoint: `http://127.0.0.1:${mcpServer.port}/health`,
          error: expect.stringMatching(/401|unauth|HTTP/i),
          checkedAt: expect.any(String),
        });
      } finally {
        await mcpServer.close();
      }
    });

    it('web-starts-with-mcp-degraded: times out a hung MCP health check and still returns cockpit state promptly', async () => {
      const mcpServer = await startMcpHealthServer(() => {
        // Accept the connection but never send headers or a body.
      });
      try {
        mockConfig.RUNE_MCP_HOST = '127.0.0.1';
        mockConfig.RUNE_MCP_PORT = mcpServer.port;
        useRuneMcpRegistry();

        const startedAt = Date.now();
        const res = await makeRequest(port, '/api/cockpit', {
          headers: { authorization: 'Bearer test-secret' },
        });
        const elapsedMs = Date.now() - startedAt;

        expect(res.status).toBe(200);
        expect(res.body.available).toBe(true);
        expect(elapsedMs).toBeLessThan(1000);
        expect(findRuneMcpMonitoring(res.body)).toMatchObject({
          status: 'degraded',
          endpoint: `http://127.0.0.1:${mcpServer.port}/health`,
          error: expect.stringMatching(/timed out|timeout/i),
          checkedAt: expect.any(String),
        });
      } finally {
        await mcpServer.close();
      }
    });

    it('user-reachability-check: cockpit stays reachable and flips Rune MCP monitoring to degraded after the daemon stops', async () => {
      const mcpServer = await startMcpHealthServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ service: 'rune-mcp', status: 'ok' }));
      });
      mockConfig.RUNE_MCP_HOST = '127.0.0.1';
      mockConfig.RUNE_MCP_PORT = mcpServer.port;

      try {
        useRuneMcpRegistry();
        const healthy = await makeRequest(port, '/api/cockpit', {
          headers: { authorization: 'Bearer test-secret' },
        });

        expect(healthy.status).toBe(200);
        expect(healthy.body.available).toBe(true);
        expect(findRuneMcpMonitoring(healthy.body)).toMatchObject({
          status: 'ok',
          endpoint: `http://127.0.0.1:${mcpServer.port}/health`,
          checkedAt: expect.any(String),
        });
      } finally {
        await mcpServer.close();
      }

      useRuneMcpRegistry();
      const degraded = await makeRequest(port, '/api/cockpit', {
        headers: { authorization: 'Bearer test-secret' },
      });

      expect(degraded.status).toBe(200);
      expect(degraded.body.available).toBe(true);
      expect(findRuneMcpMonitoring(degraded.body)).toMatchObject({
        status: 'degraded',
        endpoint: `http://127.0.0.1:${mcpServer.port}/health`,
        error: expect.stringMatching(/ECONNREFUSED|ECONNRESET|unreachable|down|socket hang up/i),
        checkedAt: expect.any(String),
      });
    });
  });

  describe('GET /api/mcp/tools/mcp_metrics_snapshot', () => {
    it('calls the MCP daemon tool and returns a live monitoring state, not a health or shared metrics read', async () => {
      const mcpServer = await startMcpMetricsToolServer();
      try {
        mockConfig.RUNE_MCP_HOST = '127.0.0.1';
        mockConfig.RUNE_MCP_PORT = mcpServer.port;

        const res = await makeRequest(port, '/api/mcp/tools/mcp_metrics_snapshot', {
          headers: { authorization: 'Bearer test-secret' },
        });

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({
          status: 'ok',
          sourceTool: 'mcp_metrics_snapshot',
          mcpMetrics: mcpMetricsSnapshotFixture,
        });
        expect(mcpServer.requests.some((request) => (
          request.path === '/mcp' &&
          request.body?.method === 'tools/call' &&
          request.body?.params?.name === 'mcp_metrics_snapshot'
        ))).toBe(true);
        expect(mcpServer.requests.map((request) => request.path)).not.toContain('/health');
        expect(mcpServer.requests.map((request) => request.path)).not.toContain('/metrics');
      } finally {
        await mcpServer.close();
      }
    });

    it('parses an SSE (text/event-stream) metrics response from the Streamable-HTTP daemon', async () => {
      // Regression: the daemon's StreamableHTTPServerTransport answers with
      // `event: message\ndata: {...}` (no enableJsonResponse), and the proxy
      // used to JSON.parse the raw body, throwing
      // `Unexpected token 'e', "event: men"... is not valid JSON` and forcing
      // the cockpit Monitoring panel into a permanent degraded state.
      const mcpServer = await startMcpMetricsToolServer({ transport: 'sse' });
      try {
        mockConfig.RUNE_MCP_HOST = '127.0.0.1';
        mockConfig.RUNE_MCP_PORT = mcpServer.port;

        const res = await makeRequest(port, '/api/mcp/tools/mcp_metrics_snapshot', {
          headers: { authorization: 'Bearer test-secret' },
        });

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({
          status: 'ok',
          sourceTool: 'mcp_metrics_snapshot',
          mcpMetrics: mcpMetricsSnapshotFixture,
        });
        expect(res.body.error).toBeUndefined();
      } finally {
        await mcpServer.close();
      }
    });

    it('still parses a plain JSON metrics response if the daemon enables JSON responses', async () => {
      const mcpServer = await startMcpMetricsToolServer({ transport: 'json' });
      try {
        mockConfig.RUNE_MCP_HOST = '127.0.0.1';
        mockConfig.RUNE_MCP_PORT = mcpServer.port;

        const res = await makeRequest(port, '/api/mcp/tools/mcp_metrics_snapshot', {
          headers: { authorization: 'Bearer test-secret' },
        });

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({
          status: 'ok',
          sourceTool: 'mcp_metrics_snapshot',
          mcpMetrics: mcpMetricsSnapshotFixture,
        });
      } finally {
        await mcpServer.close();
      }
    });

    it('reuses one MCP session across repeated metrics polls', async () => {
      const mcpServer = await startMcpMetricsToolServer();
      try {
        mockConfig.RUNE_MCP_HOST = '127.0.0.1';
        mockConfig.RUNE_MCP_PORT = mcpServer.port;

        const first = await makeRequest(port, '/api/mcp/tools/mcp_metrics_snapshot', {
          headers: { authorization: 'Bearer test-secret' },
        });
        const second = await makeRequest(port, '/api/mcp/tools/mcp_metrics_snapshot', {
          headers: { authorization: 'Bearer test-secret' },
        });

        expect(first.body.status).toBe('ok');
        expect(second.body.status).toBe('ok');
        expect(mcpServer.requests.filter((request) => request.body?.method === 'initialize')).toHaveLength(1);
        expect(mcpServer.requests.filter((request) => (
          request.body?.method === 'tools/call' &&
          request.body?.params?.name === 'mcp_metrics_snapshot'
        ))).toHaveLength(2);
      } finally {
        await mcpServer.close();
      }
    });

    it('sends a daemon OAuth bearer from the standalone MCP OAuth store', async () => {
      const tempDir = mkdtempSync(join(tmpdir(), 'rune-webview-mcp-oauth-'));
      const token = 'daemon-oauth-token';
      const storeFile = join(tempDir, 'rune-mcp-oauth-store.json');
      writeFileSync(storeFile, JSON.stringify({
        clients: [{ clientId: 'client', redirectUris: ['http://127.0.0.1/callback'] }],
        tokens: [{ token, userId: '42', expiresAt: null }],
      }));
      const mcpServer = await startMcpMetricsToolServer({ requiredBearerToken: token });
      try {
        mockConfig.RUNE_MCP_OAUTH_STORE_FILE = storeFile;
        mockConfig.RUNE_MCP_HOST = '127.0.0.1';
        mockConfig.RUNE_MCP_PORT = mcpServer.port;

        const res = await makeRequest(port, '/api/mcp/tools/mcp_metrics_snapshot', {
          headers: { authorization: 'Bearer test-secret' },
        });

        expect(res.body.status).toBe('ok');
        expect(mcpServer.requests.every((request) => request.headers.authorization === `Bearer ${token}`)).toBe(true);
      } finally {
        await mcpServer.close();
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('maps MCP tool-error results to a degraded monitoring state without failing the web API', async () => {
      const mcpServer = await startMcpMetricsToolServer({ toolResult: 'tool-error' });
      try {
        mockConfig.RUNE_MCP_HOST = '127.0.0.1';
        mockConfig.RUNE_MCP_PORT = mcpServer.port;

        const res = await makeRequest(port, '/api/mcp/tools/mcp_metrics_snapshot', {
          headers: { authorization: 'Bearer test-secret' },
        });

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({
          status: 'degraded',
          sourceTool: 'mcp_metrics_snapshot',
          error: expect.stringMatching(/metrics unavailable/i),
        });
        expect(mcpServer.requests.some((request) => (
          request.path === '/mcp' &&
          request.body?.method === 'tools/call' &&
          request.body?.params?.name === 'mcp_metrics_snapshot'
        ))).toBe(true);
      } finally {
        await mcpServer.close();
      }
    });

    it('maps an unreachable MCP daemon to degraded monitoring instead of surfacing a route failure', async () => {
      const unreachablePort = await getReleasedLocalPort();
      mockConfig.RUNE_MCP_HOST = '127.0.0.1';
      mockConfig.RUNE_MCP_PORT = unreachablePort;

      const res = await makeRequest(port, '/api/mcp/tools/mcp_metrics_snapshot', {
        headers: { authorization: 'Bearer test-secret' },
      });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        status: 'degraded',
        sourceTool: 'mcp_metrics_snapshot',
        error: expect.stringMatching(/ECONNREFUSED|unreachable|MCP daemon|connect/i),
      });
    });
  });

  // ---- POST /api/chat ----

  describe('POST /api/chat', () => {
    it('returns 401 without auth', async () => {
      const res = await makeRequest(port, '/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: 'hello' }),
      });
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('unauthorized');
    });

    it('returns 400 on invalid JSON body', async () => {
      const res = await makeRequest(port, '/api/chat', {
        method: 'POST',
        headers: {
          authorization: 'Bearer test-secret',
          'content-type': 'application/json',
        },
        body: 'bad-json{',
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid JSON body');
    });

    it('returns 400 when message is empty', async () => {
      const res = await makeRequest(port, '/api/chat', {
        method: 'POST',
        headers: {
          authorization: 'Bearer test-secret',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ message: '   ' }),
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('message is required');
    });

    it('returns 200 with { text, sessionId, model } on valid auth and message', async () => {
      const res = await makeRequest(port, '/api/chat', {
        method: 'POST',
        headers: {
          authorization: 'Bearer test-secret',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ message: 'hello world' }),
      });
      expect(res.status).toBe(200);
      expect(typeof res.body.text).toBe('string');
      expect(typeof res.body.sessionId).toBe('string');
      expect(typeof res.body.model).toBe('string');
      expect(handleWebviewMessage).toHaveBeenCalledOnce();
    });

    it('calls handleWebviewMessage with the trimmed text', async () => {
      await makeRequest(port, '/api/chat', {
        method: 'POST',
        headers: {
          authorization: 'Bearer test-secret',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ message: '  what is the meaning of life  ' }),
      });
      expect(handleWebviewMessage).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'webview' }),
        mockConfig.TELEGRAM_USER_ID,
        'what is the meaning of life',
      );
    });

    it('carries product scope through POST /api/chat dispatch and response session lookup', async () => {
      await makeRequest(port, '/api/chat', {
        method: 'POST',
        headers: {
          authorization: 'Bearer test-secret',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ message: '  look in this repo  ', product: 'aura' }),
      });

      const expectedScope = { kind: 'product', product: 'aura' };
      expect(handleWebviewMessage).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'webview' }),
        mockConfig.TELEGRAM_USER_ID,
        'look in this repo',
        expectedScope,
      );
      expect(getSession).toHaveBeenCalledWith(mockConfig.TELEGRAM_USER_ID, 'webview', expectedScope);
    });

    it('keeps POST /api/chat global when product is invalid', async () => {
      await makeRequest(port, '/api/chat', {
        method: 'POST',
        headers: {
          authorization: 'Bearer test-secret',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ message: 'stay global', product: '../rune' }),
      });

      expect(handleWebviewMessage).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'webview' }),
        mockConfig.TELEGRAM_USER_ID,
        'stay global',
      );
      expect(getSession).toHaveBeenCalledWith(mockConfig.TELEGRAM_USER_ID, 'webview');
      expect(getSession).not.toHaveBeenCalledWith(
        mockConfig.TELEGRAM_USER_ID,
        'webview',
        expect.anything(),
      );
    });

    it('returns 500 when handleWebviewMessage throws', async () => {
      (handleWebviewMessage as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('dispatch failed'));
      const res = await makeRequest(port, '/api/chat', {
        method: 'POST',
        headers: {
          authorization: 'Bearer test-secret',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ message: 'trigger error' }),
      });
      expect(res.status).toBe(500);
      expect(res.body.error).toBe('internal error');
    });
  });

  describe('WebSocket /api/ws chat frames', () => {
    it('carries product scope from message frames through webview dispatch', async () => {
      const ws = await openWebSocket(port);
      try {
        ws.send(JSON.stringify({ kind: 'message', text: '  inspect this repo  ', product: 'aura' }));

        await waitForMockCall(handleWebviewMessage as ReturnType<typeof vi.fn>);

        expect(handleWebviewMessage).toHaveBeenCalledWith(
          expect.objectContaining({ name: 'webview' }),
          mockConfig.TELEGRAM_USER_ID,
          'inspect this repo',
          { kind: 'product', product: 'aura' },
        );
      } finally {
        ws.terminate();
      }
    });

    it('keeps WS message frames global when product is invalid', async () => {
      const ws = await openWebSocket(port);
      try {
        ws.send(JSON.stringify({ kind: 'message', text: '  global fallback  ', product: 'bad/product' }));

        await waitForMockCall(handleWebviewMessage as ReturnType<typeof vi.fn>);

        expect(handleWebviewMessage).toHaveBeenCalledWith(
          expect.objectContaining({ name: 'webview' }),
          mockConfig.TELEGRAM_USER_ID,
          'global fallback',
        );
      } finally {
        ws.terminate();
      }
    });
  });

  // ---- Unknown /api/* routes ----

  describe('GET /api/unknown', () => {
    it('returns 404 handled by webview (not fallthrough)', async () => {
      const res = await makeRequest(port, '/api/unknown', {
        headers: { authorization: 'Bearer test-secret' },
      });
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('not found');
    });

    it('returns 401 on unknown /api/* route without auth', async () => {
      const res = await makeRequest(port, '/api/unknown');
      expect(res.status).toBe(401);
    });
  });

  // ---- Paths that should fall through ----

  describe('paths that fall through to http.ts', () => {
    it('returns fallthrough 404 for /some-other-path', async () => {
      const res = await makeRequest(port, '/some-other-path');
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('not found (fallthrough)');
    });

    it('returns fallthrough 404 for /health (not owned by webview)', async () => {
      const res = await makeRequest(port, '/health');
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('not found (fallthrough)');
    });
  });

  // ---- POST /api/mutations ----

  describe('POST /api/mutations', () => {
    it('returns 200 with descriptor when createMutation returns ok: true', async () => {
      const descriptor = {
        id: 'desc-123',
        kind: 'work-run',
        source: 'webview',
        target: { type: 'work-run', ref: '06-webview' },
        preview: { summary: 'work-run on 06-webview' },
        payload: { projectSlug: '06-webview' },
        createdAt: '2026-05-05T12:00:00.000Z',
        status: 'pending',
      };
      mockCreateMutation.mockResolvedValue({ ok: true, descriptor });

      const res = await makeRequest(port, '/api/mutations', {
        method: 'POST',
        headers: {
          authorization: 'Bearer test-secret',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ kind: 'work-run', payload: { projectSlug: '06-webview' } }),
      });

      expect(res.status).toBe(200);
      expect(res.body.id).toBe('desc-123');
      expect(res.body.kind).toBe('work-run');
      expect(res.body.status).toBe('pending');
    });

    it('returns 400 with error message when createMutation returns ok: false', async () => {
      mockCreateMutation.mockResolvedValue({ ok: false, reason: 'unknown mutation kind: bad-kind' });

      const res = await makeRequest(port, '/api/mutations', {
        method: 'POST',
        headers: {
          authorization: 'Bearer test-secret',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ kind: 'bad-kind', payload: {} }),
      });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('bad-kind');
    });

    it('returns 401 without auth', async () => {
      const res = await makeRequest(port, '/api/mutations', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'work-run', payload: {} }),
      });
      expect(res.status).toBe(401);
    });

    // --- Project 14 Phase 5 dispatch seam (verified without a live run) ---

    it('routes a work-run Start to the LEGACY applier and records the fallback when orchestrated mode is off', async () => {
      mockConfig.ORCHESTRATED_WORK_ENABLED = false;
      mockCreateMutation.mockResolvedValue({ ok: true, descriptor: { id: 'm1', kind: 'work-run', status: 'pending' } });

      await makeRequest(port, '/api/mutations', {
        method: 'POST',
        headers: { authorization: 'Bearer test-secret', 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'work-run', payload: { projectSlug: 'demo', product: 'rune' } }),
      });

      expect(mockCreateMutation).toHaveBeenCalledTimes(1);
      const [kind, payload] = mockCreateMutation.mock.calls[0]!;
      expect(kind).toBe('work-run'); // legacy applier
      expect(payload.dispatchMode).toBe('legacy');
      expect(payload.fallbackReason).toBeTruthy(); // never a silent fallback
    });

    it('routes a work-run Start to the ORCHESTRATED applier when orchestrated mode is on', async () => {
      mockConfig.ORCHESTRATED_WORK_ENABLED = true;
      // try/finally so a failed assertion can't strand the global toggle `true`
      // for every subsequent test (vi.clearAllMocks doesn't reset mockConfig).
      try {
        mockCreateMutation.mockResolvedValue({ ok: true, descriptor: { id: 'm2', kind: 'orchestrated-work', status: 'pending' } });

        await makeRequest(port, '/api/mutations', {
          method: 'POST',
          headers: { authorization: 'Bearer test-secret', 'content-type': 'application/json' },
          body: JSON.stringify({ kind: 'work-run', payload: { projectSlug: 'demo', product: 'rune' } }),
        });

        const [kind, payload] = mockCreateMutation.mock.calls[0]!;
        expect(kind).toBe('orchestrated-work');
        expect(payload.dispatchMode).toBe('orchestrated');
        expect(payload.fallbackReason).toBeUndefined();
      } finally {
        mockConfig.ORCHESTRATED_WORK_ENABLED = false; // restore for other tests
      }
    });
  });

  // ---- POST /api/ops/:id/cancel ----

  describe('POST /api/ops/:id/cancel', () => {
    beforeEach(() => {
      mockCancelOp.mockReset();
    });

    it('returns 200 { ok: true } when cancelOp returns true', async () => {
      mockCancelOp.mockReturnValue(true);
      const res = await makeRequest(port, '/api/ops/abc123/cancel', {
        method: 'POST',
        headers: { authorization: 'Bearer test-secret' },
      });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
      expect(mockCancelOp).toHaveBeenCalledWith('abc123');
    });

    it('returns 409 when cancelOp returns false (op not found)', async () => {
      mockCancelOp.mockReturnValue(false);
      const res = await makeRequest(port, '/api/ops/not-found-id/cancel', {
        method: 'POST',
        headers: { authorization: 'Bearer test-secret' },
      });
      expect(res.status).toBe(409);
      expect(res.body.error).toContain('not found');
    });

    it('passes the opId from the URL path to cancelOp', async () => {
      mockCancelOp.mockReturnValue(true);
      const opId = 'ff00aa11-bbcc-ddee-0011-223344556677';
      await makeRequest(port, `/api/ops/${opId}/cancel`, {
        method: 'POST',
        headers: { authorization: 'Bearer test-secret' },
      });
      expect(mockCancelOp).toHaveBeenCalledWith(opId);
    });

    it('returns 401 without auth header', async () => {
      const res = await makeRequest(port, '/api/ops/some-op/cancel', {
        method: 'POST',
      });
      expect(res.status).toBe(401);
    });

    it('returns 404 for GET /api/ops/:id/cancel (wrong method)', async () => {
      const res = await makeRequest(port, '/api/ops/some-op/cancel', {
        method: 'GET',
        headers: { authorization: 'Bearer test-secret' },
      });
      // GET doesn't match the POST route — falls through to the unknown /api/* 404
      expect(res.status).toBe(404);
    });
  });

  // ---- POST /api/work-runs/:id/release (project 13, Phase 1c) ----

  describe('POST /api/work-runs/:id/release', () => {
    beforeEach(() => {
      mockRequestWorkRunRelease.mockReset();
    });

    it('returns 202 { mutationId } when the shared runtime creates a release mutation', async () => {
      mockRequestWorkRunRelease.mockResolvedValue({ kind: 'created', runId: 'parked-1', mutationId: 'rel-99' });
      const res = await makeRequest(port, '/api/work-runs/parked-1/release', {
        method: 'POST',
        headers: { authorization: 'Bearer test-secret', 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(202);
      expect(res.body.mutationId).toBe('rel-99');
      // The run id from the path is the one released.
      expect(mockRequestWorkRunRelease.mock.calls[0]![0]).toBe('parked-1');
    });

    it('returns 409 { error: dirty-worktree, files } on a dirty-confirm outcome and creates no mutation', async () => {
      mockRequestWorkRunRelease.mockResolvedValue({
        kind: 'dirty-confirm',
        runId: 'parked-1',
        files: ['M src/foo.ts', '?? scratch.md'],
      });
      const res = await makeRequest(port, '/api/work-runs/parked-1/release', {
        method: 'POST',
        headers: { authorization: 'Bearer test-secret', 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(409);
      expect(res.body.error).toBe('dirty-worktree');
      expect(res.body.files).toEqual(['M src/foo.ts', '?? scratch.md']);
    });

    it('returns 200 (no-op) on a not-parked outcome', async () => {
      mockRequestWorkRunRelease.mockResolvedValue({ kind: 'not-parked', runId: 'gone-1' });
      const res = await makeRequest(port, '/api/work-runs/gone-1/release', {
        method: 'POST',
        headers: { authorization: 'Bearer test-secret', 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(200);
    });

    it('forwards confirmDirty:true from the body to the shared runtime', async () => {
      mockRequestWorkRunRelease.mockResolvedValue({ kind: 'created', runId: 'parked-1', mutationId: 'rel-1' });
      await makeRequest(port, '/api/work-runs/parked-1/release', {
        method: 'POST',
        headers: { authorization: 'Bearer test-secret', 'content-type': 'application/json' },
        body: JSON.stringify({ confirmDirty: true }),
      });
      expect(mockRequestWorkRunRelease.mock.calls[0]![1]).toEqual({ confirmDirty: true });
    });

    it('rejects an invalid run id with 400 (VALID_SLUG guard)', async () => {
      const res = await makeRequest(port, '/api/work-runs/..%2Fetc/release', {
        method: 'POST',
        headers: { authorization: 'Bearer test-secret', 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
      expect(mockRequestWorkRunRelease).not.toHaveBeenCalled();
    });

    it('returns 401 without auth', async () => {
      const res = await makeRequest(port, '/api/work-runs/parked-1/release', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(401);
    });
  });

  describe('POST /api/server/restart', () => {
    beforeEach(() => {
      mockRestartServer.mockClear();
      mockConfig.IS_PRODUCTION = false;
    });
    afterEach(() => {
      mockConfig.IS_PRODUCTION = false;
    });

    it('returns 409 and does not restart outside production', async () => {
      mockConfig.IS_PRODUCTION = false;
      const res = await makeRequest(port, '/api/server/restart', {
        method: 'POST',
        headers: { authorization: 'Bearer test-secret' },
      });
      expect(res.status).toBe(409);
      expect(res.body.error).toContain('production');
      // Give the (non-)scheduled timer a beat — it must never fire in dev.
      await new Promise((r) => setTimeout(r, 200));
      expect(mockRestartServer).not.toHaveBeenCalled();
    });

    it('returns 202 and schedules the restart in production', async () => {
      mockConfig.IS_PRODUCTION = true;
      const res = await makeRequest(port, '/api/server/restart', {
        method: 'POST',
        headers: { authorization: 'Bearer test-secret' },
      });
      expect(res.status).toBe(202);
      expect(res.body).toEqual({ ok: true });
      await vi.waitFor(() => expect(mockRestartServer).toHaveBeenCalledTimes(1));
    });

    it('returns 401 without auth header', async () => {
      mockConfig.IS_PRODUCTION = true;
      const res = await makeRequest(port, '/api/server/restart', { method: 'POST' });
      expect(res.status).toBe(401);
      expect(mockRestartServer).not.toHaveBeenCalled();
    });
  });

});
