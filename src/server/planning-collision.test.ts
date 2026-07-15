import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import type { Server, IncomingMessage, ServerResponse } from 'node:http';

/*
 * Test-suite-as-deliverable for the Plan-button planning collision (09-expand-cockpit, Phase 4,
 * written test-first).
 *
 * `POST /api/backlog/:product/items/:id/plan` opens a planning session seeded from a backlog
 * item. If a planning session is already IN PROGRESS for that product, a second Plan click must
 * NOT start another — it returns `409 active-planning-session` carrying `{ activeSessionId }` so
 * the cockpit can offer a resume/abandon dialog (the dialog itself is DOM, the integration check).
 *
 * Stays RED until the Phase 4 build adds the route. Harness mirrors backlog-drawer.test.ts.
 */

vi.mock('../transport/mutations.js', () => ({ createMutation: vi.fn(), cancelMutation: vi.fn(), activeRuns: new Map() }));
vi.mock('../transport/in-flight.js', () => ({ cancelOp: vi.fn(), listOps: vi.fn(() => []) }));
vi.mock('../jobs/mutations-log.js', () => ({ readRecentMutations: vi.fn(() => []) }));
vi.mock('./cockpit-run-status.js', () => ({ readCockpitRunStatus: vi.fn(() => ({})) }));

const mockConfig = {
  HTTP_PORT: 0, HTTP_HOST: '127.0.0.1', TIMEZONE: 'America/Chicago', VAULT_DIR: '/test/vault',
  RUNE_HTTP_SECRET: 'test-secret', OBSIDIAN_VAULT_NAME: 'TestVault', TELEGRAM_USER_ID: 42,
  RUNE_ALLOWED_HOSTS: new Set(['localhost', '127.0.0.1']), IS_PRODUCTION: false as boolean,
  LAUNCHD_LABEL: 'com.jarvis.daemon', WORKSPACE_DIR: '/test/workspace',
  PRODUCTS_CONFIG_FILE: '/test/policies/products.json',
  SUPERVISED_RUNS_FILE: '/test/logs/supervised-runs.json', WORK_RUNS_DIR: '/test/logs/work-runs',
  WORK_RUNS_INDEX_FILE: '/test/logs/work-runs/index.jsonl', BACKLOG_MUTATIONS_FILE: '/test/logs/backlog-mutations.jsonl',
  PROMOTIONS_FILE: '/test/logs/promotions.jsonl',
};
vi.mock('../config.js', () => ({ default: mockConfig, PROJECT_ROOT: '/test/project' }));
vi.mock('../jobs/sandbox-runtime.js', () => ({
  readProductsConfig: vi.fn(() => ({ aura: { repoPath: '/test/workspace/aura', baseBranch: 'main', credentialsFile: '', egressAllowlist: [] } })),
  createWorktree: vi.fn(),
  destroyWorktree: vi.fn(),
  getProductConfig: vi.fn(() => ({ product: 'aura', repoPath: '/test/workspace/aura', baseBranch: 'main', egressAllowlist: [] })),
  defaultRunGit: vi.fn(async () => ({ stdout: '', stderr: '' })),
  verifyWorktreeProvisioning: vi.fn(),
  worktreeProvisioningTerminalReason: vi.fn(() => 'worktree provisioning failed: setup'),
}));
vi.mock('./restart.js', () => ({ restartServer: vi.fn(() => ({ ok: true as const })) }));
vi.mock('../ai/claude.js', () => ({ runAgent: vi.fn(async () => ({ text: 'ok', error: null })) }));

const mockGetAllPlanningSessions = vi.fn(() => [] as Array<[number, unknown]>);
const mockCreatePlanningSession = vi.fn();
vi.mock('../reviews/planning.js', () => ({
  createPlanningSession: mockCreatePlanningSession,
  getActivePlanningSession: vi.fn(() => null),
  getAllPlanningSessions: mockGetAllPlanningSessions,
  deletePlanningSession: vi.fn(),
  approveActivePlanningSession: vi.fn(),
  abandonActivePlanningSession: vi.fn(),
}));
// The Plan route creates + persists a promotion on the non-collision (200) path; mock the
// promotions module so the success cases don't hit the real append-only log fs write.
vi.mock('../intent/promotions.js', () => ({
  createPromotion: vi.fn((input: any) => ({ ...input, id: 'promo-new', state: 'planning-started', attempts: 0, errors: [] })),
  appendPromotion: vi.fn(),
  loadPromotions: vi.fn(() => new Map()),
}));
vi.mock('../reviews/planning-handler.js', () => ({ handlePlanningTurn: vi.fn(), defaultScopingTurn: vi.fn() }));
vi.mock('../vault/sessions.js', () => ({ getSession: vi.fn(() => null) }));
vi.mock('./state-snapshot.js', () => ({ getStateSnapshot: vi.fn(() => ({ version: 1, ready: true })) }));
vi.mock('./webview-bootstrap.js', () => ({ handleWebviewMessage: vi.fn(async () => undefined) }));
vi.mock('../intent/registry.js', () => ({
  readRegistry: vi.fn(() => ({
    version: 1, builtAt: '2026-06-03T00:00:00.000Z',
    products: [{ name: 'aura', repoBacked: true, projects: [] }],
  })),
}));
vi.mock('./projects-snapshot.js', () => ({ getProjectSummaries: vi.fn(() => []) }));
vi.mock('./work-run-projection.js', () => ({ readWorkRunProjections: vi.fn(() => ({})) }));

// One open bug whose id the Plan click targets.
const { OPEN_BUG_ID, mockBacklogs } = vi.hoisted(() => {
  const OPEN_BUG_ID = 'b-open-1';
  return {
    OPEN_BUG_ID,
    mockBacklogs: [
      {
        product: 'aura', notRepoBacked: false,
        bugs: [{ id: OPEN_BUG_ID, kind: 'bugs', text: 'open bug', status: 'open', body: [], source: { file: 'docs/projects/bugs.md', lineNumber: 1, raw: '- [ ] open bug' }, warnings: [] }],
        ideas: [], fileWarnings: [],
      },
    ],
  };
});
vi.mock('../intent/backlog-reader.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../intent/backlog-reader.js')>();
  return { ...actual, readBacklogs: vi.fn(() => mockBacklogs) };
});

const { mountWebviewRoutes } = await import('./webview.js');

function request(port: number, method: string, path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path, method, headers: { host: 'localhost', ...headers } }, (res) => {
      let buf = '';
      res.on('data', (c: Buffer) => (buf += c.toString()));
      res.on('end', () => resolve({ status: res.statusCode!, body: (() => { try { return JSON.parse(buf); } catch { return buf; } })() }));
    });
    r.on('error', reject);
    r.end();
  });
}

const mockSender = { name: 'webview' as const, register: vi.fn(), unregister: vi.fn(), send: vi.fn(async () => undefined), startTyping: vi.fn(), stopTyping: vi.fn(), shutdown: vi.fn() };
const AUTH = { authorization: 'Bearer test-secret' };

let server: Server;
let handler: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;
let port: number;

describe('POST /api/backlog/:product/items/:id/plan — planning collision (09-expand-cockpit Phase 4)', () => {
  beforeAll(async () => {
    server = http.createServer(async (req, res) => {
      const handled = await handler(req, res);
      if (!handled) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'fallthrough' })); }
    });
    handler = mountWebviewRoutes(server, { webview: mockSender as any, isReady: () => true });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as any).port;
  });
  afterAll(() => server.close());
  beforeEach(() => { vi.clearAllMocks(); mockGetAllPlanningSessions.mockReturnValue([]); });

  it('requires auth', async () => {
    expect((await request(port, 'POST', `/api/backlog/aura/items/${OPEN_BUG_ID}/plan`)).status).toBe(401);
  });

  it('returns 409 active-planning-session (with activeSessionId) when a session is already active for the product', async () => {
    mockGetAllPlanningSessions.mockReturnValue([
      [42, { id: 'sess-active', chatId: 42, planning: { product: 'aura', status: 'scoping', idea: 'x', surface: 'cockpit' } }],
    ]);
    const res = await request(port, 'POST', `/api/backlog/aura/items/${OPEN_BUG_ID}/plan`, AUTH);
    expect(res.status).toBe(409);
    // activeSessionId rides on the standard error envelope, not a bare top-level field.
    expect(res.body.error).toMatchObject({ code: 'active-planning-session', activeSessionId: 'sess-active' });
    // No new planning session is created on collision.
    expect(mockCreatePlanningSession).not.toHaveBeenCalled();
  });

  it('also collides on a spec-proposed session (the other in-progress status)', async () => {
    mockGetAllPlanningSessions.mockReturnValue([
      [42, { id: 'sess-spec', chatId: 42, planning: { product: 'aura', status: 'spec-proposed', idea: 'x', surface: 'cockpit' } }],
    ]);
    const res = await request(port, 'POST', `/api/backlog/aura/items/${OPEN_BUG_ID}/plan`, AUTH);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: 'active-planning-session' });
  });

  it('proceeds (200) when the only session is for a DIFFERENT product', async () => {
    mockGetAllPlanningSessions.mockReturnValue([
      [42, { id: 'sess-other', chatId: 42, planning: { product: 'relay', status: 'scoping', idea: 'x', surface: 'cockpit' } }],
    ]);
    const res = await request(port, 'POST', `/api/backlog/aura/items/${OPEN_BUG_ID}/plan`, AUTH);
    expect(res.status).toBe(200);
  });

  it('proceeds (200) when the existing session for this product is terminal (approved/abandoned)', async () => {
    mockGetAllPlanningSessions.mockReturnValue([
      [42, { id: 'sess-approved', chatId: 42, planning: { product: 'aura', status: 'approved', idea: 'x', surface: 'cockpit' } }],
    ]);
    const res = await request(port, 'POST', `/api/backlog/aura/items/${OPEN_BUG_ID}/plan`, AUTH);
    expect(res.status).toBe(200);
  });
});
