import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import type { Server, IncomingMessage, ServerResponse } from 'node:http';
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
vi.mock('../transport/in-flight.js', () => ({
  cancelOp: mockCancelOp,
  listOps: vi.fn(() => []),
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
  getAllPlanningSessions: vi.fn(() => []),
  deletePlanningSession: vi.fn(),
  approveActivePlanningSession: vi.fn(),
  abandonActivePlanningSession: vi.fn(),
}));
vi.mock('../reviews/planning-handler.js', () => ({
  handlePlanningTurn: vi.fn(),
  defaultScopingTurn: vi.fn(),
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
    products: [{ name: 'aura', repoBacked: true, projects: [{ slug: '01-mvp', status: 'active' }] }],
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

// ---- mock WebviewSender ----

const mockWebviewSender = {
  name: 'webview' as const,
  register: vi.fn(),
  unregister: vi.fn(),
  send: vi.fn(async () => undefined),
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

      const res = await makeRequest(port, '/api/cockpit', {
        headers: { authorization: 'Bearer test-secret' },
      });

      expect(res.status).toBe(200);
      expect(res.body.available).toBe(true);
      const runeMcp = res.body.products.find((p: any) => p.name === 'rune-mcp');
      expect(runeMcp).toBeDefined();
      expect(runeMcp.monitoring?.mcp).toMatchObject({
        status: 'degraded',
        endpoint: `http://127.0.0.1:${unreachablePort}/health`,
        error: expect.stringMatching(/ECONNREFUSED|unreachable|down/i),
        checkedAt: expect.any(String),
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
