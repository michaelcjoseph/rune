/**
 * Test-suite-as-deliverable for the cockpit UX (project 08-intent-layer
 * Phase 6 Track C / test-plan.md §19). This file is written test-first
 * BEFORE C1, C2, C3 implementations land — every test here is expected
 * to stay red until the matching impl task ships:
 *
 *   - C1 (cockpit planning panel) — POST /api/planning/{start,turn,
 *     approve,abandon} endpoints.
 *   - C2 (cockpit approval inbox) — GET /api/approvals,
 *     POST /api/approvals/:id/{approve,reject}.
 *   - C3 (in-flight run progress) — `CockpitProject.progress` field
 *     populated when a gen-eval-loop mutation is active.
 *
 * The DOM-side rendering in `src/server/static/app.js` is browser
 * vanilla JS and isn't directly importable; the contracts the panels
 * read FROM (API endpoints, cockpit data shape) are what's tested here.
 * Live DOM verification happens in the integration check at the bottom
 * of test-plan.md §19 — out of scope for this unit suite.
 *
 * The suite mirrors `src/server/webview.test.ts`'s HTTP-server test
 * setup so the new endpoints can be hit via real `http.request` once
 * they exist.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import type { Server, IncomingMessage, ServerResponse } from 'node:http';

// ---------------------------------------------------------------------------
// Mocks — mirror webview.test.ts so the same fixture surface works.
// ---------------------------------------------------------------------------

const mockCreateMutation = vi.fn();
const mockCancelMutation = vi.fn();
const mockActiveRunsMap = new Map<string, unknown>();
vi.mock('../transport/mutations.js', () => ({
  createMutation: mockCreateMutation,
  cancelMutation: mockCancelMutation,
  activeRuns: mockActiveRunsMap,
}));

const mockCancelOp = vi.fn();
vi.mock('../transport/in-flight.js', () => ({
  cancelOp: mockCancelOp,
  listOps: vi.fn(() => []),
}));

vi.mock('../jobs/mutations-log.js', () => ({
  readRecentMutations: vi.fn(() => []),
}));

const mockReadCockpitRunStatus = vi.fn(() => ({}));
vi.mock('./cockpit-run-status.js', () => ({
  readCockpitRunStatus: mockReadCockpitRunStatus,
}));

const mockConfig = {
  HTTP_PORT: 0,
  HTTP_HOST: '127.0.0.1',
  TIMEZONE: 'America/Chicago',
  VAULT_DIR: '/test/vault',
  JARVIS_HTTP_SECRET: 'test-secret',
  OBSIDIAN_VAULT_NAME: 'TestVault',
  TELEGRAM_USER_ID: 42,
  JARVIS_ALLOWED_HOSTS: new Set(['localhost', '127.0.0.1']),
};
vi.mock('../config.js', () => ({
  default: mockConfig,
  PROJECT_ROOT: '/test/project',
}));

// handleApiPlanningApprove delegates scaffolding to the shared scaffold-approval runtime.
vi.mock('../jobs/scaffold-approval.js', () => ({
  runScaffoldApproval: vi.fn(async () => ({
    ok: true, slug: '09-x', agentText: 'scaffolded', promotion: 'none',
  })),
  defaultScaffoldApprovalDeps: vi.fn(),
}));
// Still mocked because other transitively-imported modules touch the Claude CLI at load.
vi.mock('../ai/claude.js', () => ({
  runAgent: vi.fn(async () => ({ text: 'scaffolded', error: null })),
}));

vi.mock('../vault/sessions.js', () => ({ getSession: vi.fn(() => null) }));

vi.mock('./state-snapshot.js', () => ({
  getStateSnapshot: vi.fn(() => ({
    version: 1, ready: true, sessions: { webview: null, telegram: null }, activeReview: null,
    ingestionQueueDepth: 0, recentAgentRuns: [], pendingApprovals: {},
    lastMorningPrepAt: null, lastNightlyAt: null, warnings: [],
  })),
}));

vi.mock('./webview-bootstrap.js', () => ({
  handleWebviewMessage: vi.fn(async () => undefined),
}));

const { mockRegistry } = vi.hoisted(() => ({
  mockRegistry: {
    version: 1, builtAt: '2026-01-15T00:00:00.000Z',
    // `as const` keeps `status` as the literal 'active' (a LifecycleStatus)
    // rather than widening to `string`, so the fixture satisfies `Registry`
    // at every buildCockpitView call site.
    products: [{ name: 'aura', repoBacked: true, projects: [{ slug: '02-growth', status: 'active' as const }] }],
  },
}));
vi.mock('../intent/registry.js', () => ({ readRegistry: vi.fn(() => mockRegistry) }));

// Planning-session store mocks for the planning-panel tests. The C1 impl
// will reach into createPlanningSession / handlePlanningTurn / approve /
// abandon; tests inject controlled returns.
const mockCreatePlanningSession = vi.fn();
const mockGetActivePlanningSession = vi.fn(() => null);
const mockDeletePlanningSession = vi.fn();
const mockApproveActivePlanningSession = vi.fn();
const mockAbandonActivePlanningSession = vi.fn();
vi.mock('../reviews/planning.js', () => ({
  createPlanningSession: mockCreatePlanningSession,
  getActivePlanningSession: mockGetActivePlanningSession,
  getAllPlanningSessions: vi.fn(() => []),
  deletePlanningSession: mockDeletePlanningSession,
  approveActivePlanningSession: mockApproveActivePlanningSession,
  abandonActivePlanningSession: mockAbandonActivePlanningSession,
}));

const mockHandlePlanningTurn = vi.fn();
vi.mock('../reviews/planning-handler.js', () => ({
  handlePlanningTurn: mockHandlePlanningTurn,
  defaultScopingTurn: vi.fn(),
}));

const { mountWebviewRoutes } = await import('./webview.js');
const { buildCockpitView } = await import('../intent/cockpit.js');

// ---------------------------------------------------------------------------
// HTTP helper — identical to the one in webview.test.ts.
// ---------------------------------------------------------------------------

interface ReqOpts {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

function makeRequest(
  serverPort: number,
  path: string,
  opts: ReqOpts = {},
): Promise<{ status: number; body: unknown; headers: Record<string, string> }> {
  return new Promise((resolve, reject) => {
    const reqOpts: http.RequestOptions = {
      host: '127.0.0.1',
      port: serverPort,
      path,
      method: opts.method ?? 'GET',
      headers: { host: 'localhost', ...opts.headers },
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

const AUTH_COOKIE = 'jarvis-auth=test-secret';

beforeAll(async () => {
  server = http.createServer(async (req, res) => {
    const handled = await webviewHandler(req, res);
    if (!handled) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found (fallthrough)' }));
    }
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  webviewHandler = mountWebviewRoutes(server, { webview: mockWebviewSender as any, isReady: () => true });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  port = (server.address() as any).port;
});

afterAll(() => {
  server.close();
});

beforeEach(() => {
  vi.clearAllMocks();
  mockActiveRunsMap.clear();
  mockGetActivePlanningSession.mockReturnValue(null);
});

// ---------------------------------------------------------------------------
// §19. Planning panel (C1)
// ---------------------------------------------------------------------------
//
// The cockpit's Plan button opens a panel that drives the planning session
// through four lifecycle states: scoping → spec-proposed → approved | abandoned.
// The DOM is `src/server/static/app.js`; the API the panel calls into is
// what this suite pins. C1's deliverable: the four endpoints below.

describe('cockpit planning panel — POST /api/planning/start (C1)', () => {
  it('rejects unauthenticated requests with 401', async () => {
    const res = await makeRequest(port, '/api/planning/start', {
      method: 'POST',
      body: JSON.stringify({ product: 'aura' }),
    });
    expect(res.status).toBe(401);
  });

  it('creates a planning session and returns 200 with the session id', async () => {
    mockCreatePlanningSession.mockReturnValue({
      id: 'plan-1', chatId: 42, claudeSessionId: 'cl-1',
      planning: { status: 'scoping', product: 'aura', idea: '', surface: 'cockpit' },
      createdAt: '2026-05-25T12:00:00Z', lastActivity: '2026-05-25T12:00:00Z',
    });
    const res = await makeRequest(port, '/api/planning/start', {
      method: 'POST',
      headers: { Cookie: AUTH_COOKIE, 'Content-Type': 'application/json' },
      body: JSON.stringify({ product: 'aura' }),
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 'plan-1' });
    expect(mockCreatePlanningSession).toHaveBeenCalledWith(
      expect.any(Number),
      expect.any(String),
      'cockpit',
      'aura',
    );
  });

  it('400s when product is missing', async () => {
    const res = await makeRequest(port, '/api/planning/start', {
      method: 'POST',
      headers: { Cookie: AUTH_COOKIE, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});

describe('cockpit planning panel — POST /api/planning/turn (C1)', () => {
  it('rejects unauthenticated requests', async () => {
    const res = await makeRequest(port, '/api/planning/turn', {
      method: 'POST',
      body: JSON.stringify({ text: 'hi' }),
    });
    expect(res.status).toBe(401);
  });

  it('drives one turn and returns {reply, status}', async () => {
    mockGetActivePlanningSession.mockReturnValue({
      id: 'plan-1', chatId: 42, claudeSessionId: 'cl-1',
      planning: { status: 'scoping', product: 'aura', idea: '', surface: 'cockpit' },
      createdAt: '2026-05-25T12:00:00Z', lastActivity: '2026-05-25T12:00:00Z',
    });
    mockHandlePlanningTurn.mockResolvedValue({
      reply: 'What user problem does this solve?',
      status: 'scoping',
    });

    const res = await makeRequest(port, '/api/planning/turn', {
      method: 'POST',
      headers: { Cookie: AUTH_COOKIE, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'I want to fix the resolver' }),
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      reply: 'What user problem does this solve?',
      status: 'scoping',
    });
  });

  it('404s when no active planning session', async () => {
    mockGetActivePlanningSession.mockReturnValue(null);
    const res = await makeRequest(port, '/api/planning/turn', {
      method: 'POST',
      headers: { Cookie: AUTH_COOKIE, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'hi' }),
    });
    expect(res.status).toBe(404);
  });
});

describe('cockpit planning panel — POST /api/planning/approve (C1)', () => {
  it('rejects unauthenticated requests', async () => {
    const res = await makeRequest(port, '/api/planning/approve', { method: 'POST' });
    expect(res.status).toBe(401);
  });

  it('returns 200 when the session was in spec-proposed and got approved', async () => {
    mockApproveActivePlanningSession.mockReturnValue({
      ok: true,
      session: {
        id: 'plan-1', chatId: 42, claudeSessionId: 'cl-1',
        planning: {
          status: 'approved', product: 'aura', idea: '', surface: 'cockpit',
          artifact: { product: 'aura', title: 'X', spec: 'S', tasks: 'T', testPlan: 'P' },
        },
        createdAt: '2026-05-25T12:00:00Z', lastActivity: '2026-05-25T12:00:00Z',
      },
    });
    const res = await makeRequest(port, '/api/planning/approve', {
      method: 'POST',
      headers: { Cookie: AUTH_COOKIE },
    });
    expect(res.status).toBe(200);
  });

  it('409s when the session is in scoping (not yet spec-proposed)', async () => {
    mockApproveActivePlanningSession.mockReturnValue({
      ok: false, reason: 'wrong-status', status: 'scoping',
    });
    const res = await makeRequest(port, '/api/planning/approve', {
      method: 'POST',
      headers: { Cookie: AUTH_COOKIE },
    });
    expect(res.status).toBe(409);
  });

  it('404s when no active planning session', async () => {
    mockApproveActivePlanningSession.mockReturnValue({ ok: false, reason: 'no-session' });
    const res = await makeRequest(port, '/api/planning/approve', {
      method: 'POST',
      headers: { Cookie: AUTH_COOKIE },
    });
    expect(res.status).toBe(404);
  });
});

describe('cockpit planning panel — POST /api/planning/abandon (C1)', () => {
  it('rejects unauthenticated requests', async () => {
    const res = await makeRequest(port, '/api/planning/abandon', { method: 'POST' });
    expect(res.status).toBe(401);
  });

  it('returns 200 when a session was abandoned', async () => {
    mockAbandonActivePlanningSession.mockReturnValue(true);
    const res = await makeRequest(port, '/api/planning/abandon', {
      method: 'POST',
      headers: { Cookie: AUTH_COOKIE },
    });
    expect(res.status).toBe(200);
  });

  it('returns 200 even when there was no active session (idempotent abandon)', async () => {
    mockAbandonActivePlanningSession.mockReturnValue(false);
    const res = await makeRequest(port, '/api/planning/abandon', {
      method: 'POST',
      headers: { Cookie: AUTH_COOKIE },
    });
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// §19. Approval inbox (C2)
// ---------------------------------------------------------------------------
//
// Cross-source pending-approvals inbox: intent-proposal-queue, playbook-queue,
// proposal-queue, plus supervision's blocked-on-human runs. C2's deliverable:
// the three endpoints below.

describe('cockpit approval inbox — GET /api/approvals (C2)', () => {
  it('rejects unauthenticated requests', async () => {
    const res = await makeRequest(port, '/api/approvals');
    expect(res.status).toBe(401);
  });

  it('returns an array (empty inbox renders cleanly)', async () => {
    const res = await makeRequest(port, '/api/approvals', {
      headers: { Cookie: AUTH_COOKIE },
    });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('each row carries id, type, productProject, summary, age, source', async () => {
    const res = await makeRequest(port, '/api/approvals', {
      headers: { Cookie: AUTH_COOKIE },
    });
    expect(res.status).toBe(200);
    const list = res.body as Array<Record<string, unknown>>;
    for (const row of list) {
      expect(row).toHaveProperty('id');
      expect(row).toHaveProperty('type');
      expect(row).toHaveProperty('productProject');
      expect(row).toHaveProperty('summary');
      expect(row).toHaveProperty('age');
      expect(row).toHaveProperty('source');
    }
  });
});

describe('cockpit approval inbox — POST /api/approvals/:id/approve (C2)', () => {
  it('rejects unauthenticated requests', async () => {
    const res = await makeRequest(port, '/api/approvals/some-id/approve', { method: 'POST' });
    expect(res.status).toBe(401);
  });

  it('returns 404 for an unknown approval id', async () => {
    const res = await makeRequest(port, '/api/approvals/does-not-exist/approve', {
      method: 'POST',
      headers: { Cookie: AUTH_COOKIE },
    });
    expect(res.status).toBe(404);
  });
});

describe('cockpit approval inbox — POST /api/approvals/:id/reject (C2)', () => {
  it('rejects unauthenticated requests', async () => {
    const res = await makeRequest(port, '/api/approvals/some-id/reject', { method: 'POST' });
    expect(res.status).toBe(401);
  });

  it('returns 404 for an unknown approval id', async () => {
    const res = await makeRequest(port, '/api/approvals/does-not-exist/reject', {
      method: 'POST',
      headers: { Cookie: AUTH_COOKIE },
    });
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// §19. In-flight run progress (C3)
// ---------------------------------------------------------------------------
//
// `CockpitProject` gains an optional `progress` field populated when a
// gen-eval-loop mutation is active. The cockpit's project card renders it.
// C3's deliverable: the `progress` field in the type + buildCockpitView
// projection, fed from supervised-run-store + the progress MutationEvents
// A3.4 emits.

describe('CockpitProject.progress shape (C3)', () => {
  it('omits progress when the project is idle', () => {
    const view = buildCockpitView(mockRegistry, {});
    const project = view.products[0]!.projects[0]!;
    expect(project.runStatus).toBe('idle');
    // C3 contract: progress is omitted (or null) for idle projects.
    expect(project.progress ?? null).toBeNull();
  });

  it('carries round + failedEvaluatorRounds + heartbeat when an active progress is fed in', () => {
    // C3 contract: buildCockpitView accepts a second-arg shape that includes
    // optional per-project progress data (round, failedEvaluatorRounds,
    // modelGen, modelEval, lastHeartbeatAt). Today the second arg is just a
    // run-status map; C3 extends it to carry progress too.
    //
    // This test is intentionally written against the FUTURE shape. It will
    // fail until C3 ships — that's the test-suite-as-deliverable contract.
    interface ExtendedRunStatusEntry {
      status: 'idle' | 'running' | 'blocked-on-human';
      progress?: {
        round: number;
        failedEvaluatorRounds: number;
        modelGen?: string;
        modelEval?: string | null;
        lastHeartbeatAt: string;
      };
    }
    const runStatusByProject: Record<string, ExtendedRunStatusEntry> = {
      '02-growth': {
        status: 'running',
        progress: {
          round: 2,
          failedEvaluatorRounds: 1,
          modelGen: 'sonnet',
          modelEval: 'codex',
          lastHeartbeatAt: '2026-05-25T12:00:00Z',
        },
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const view = buildCockpitView(mockRegistry, runStatusByProject as any);
    const project = view.products[0]!.projects[0]!;
    expect(project.runStatus).toBe('running');
    expect(project.progress).toBeDefined();
    expect(project.progress).toMatchObject({
      round: 2,
      failedEvaluatorRounds: 1,
    });
  });

  it('progress object includes a parseable lastHeartbeatAt for amber-when-stale rendering', () => {
    // C3's amber-when-stale UI behavior in app.js reads lastHeartbeatAt and
    // compares against STALL_THRESHOLD_MS from src/jobs/stall-check.ts.
    // The shape needs to carry a parseable timestamp for that comparison.
    const runStatusByProject = {
      '02-growth': {
        status: 'running' as const,
        progress: {
          round: 1,
          failedEvaluatorRounds: 0,
          lastHeartbeatAt: '2026-05-25T12:00:00.000Z',
        },
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const view = buildCockpitView(mockRegistry, runStatusByProject as any);
    const heartbeat = view.products[0]!.projects[0]!.progress?.lastHeartbeatAt;
    expect(typeof heartbeat).toBe('string');
    expect(Number.isFinite(Date.parse(heartbeat ?? ''))).toBe(true);
  });
});

describe('CockpitProject.taskProgress shape (cockpit design tweaks)', () => {
  // The cockpit now subsumes the (removed) Projects sidebar panel's
  // done/total task counts. buildCockpitView accepts an optional third
  // argument — a slug-keyed map of {done, total} — sourced from
  // getProjectSummaries(). Slugs present in the map appear with
  // `taskProgress` on the project; absent slugs omit the field.

  it('emits taskProgress when a slug-keyed map is supplied', () => {
    const view = buildCockpitView(mockRegistry, {}, { '02-growth': { done: 5, total: 12 } });
    const project = view.products[0]!.projects[0]!;
    expect(project.taskProgress).toBeDefined();
    expect(project.taskProgress).toEqual({ done: 5, total: 12 });
  });

  it('omits taskProgress when no map is supplied (back-compat)', () => {
    const view = buildCockpitView(mockRegistry, {});
    const project = view.products[0]!.projects[0]!;
    expect(project.taskProgress ?? null).toBeNull();
  });

  it('omits taskProgress for slugs absent from the supplied map', () => {
    const view = buildCockpitView(mockRegistry, {}, { 'some-other-slug': { done: 1, total: 1 } });
    const project = view.products[0]!.projects[0]!;
    expect(project.taskProgress ?? null).toBeNull();
  });
});
