import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import type { Server, IncomingMessage, ServerResponse } from 'node:http';

/*
 * Test-suite-as-deliverable for the Plan-button endpoint (09-expand-cockpit, Phase 4, test-first).
 *
 * `POST /api/backlog/:product/items/:id/plan` opens a planning session seeded from an eligible
 * backlog item and creates a linked Promotion. Returns `{ planningSessionId, promotionId }`.
 * Errors: `409 stale-item` (the id no longer matches an item in that product), `422
 * item-not-eligible` (loop-filed / done / already-promoted). Ids are product-local: the `:product`
 * route segment disambiguates an id shared across product repos.
 *
 * (The `409 active-planning-session` collision is covered in planning-collision.test.ts.)
 * Stays RED until the Phase 4 build adds the route. Harness mirrors planning-collision.test.ts.
 */

vi.mock('../transport/mutations.js', () => ({ createMutation: vi.fn(), cancelMutation: vi.fn(), activeRuns: new Map() }));
vi.mock('../transport/in-flight.js', () => ({ cancelOp: vi.fn(), listOps: vi.fn(() => []) }));
vi.mock('../jobs/mutations-log.js', () => ({ readRecentMutations: vi.fn(() => []) }));
vi.mock('./cockpit-run-status.js', () => ({ readCockpitRunStatus: vi.fn(() => ({})) }));

const mockConfig = {
  HTTP_PORT: 0, HTTP_HOST: '127.0.0.1', TIMEZONE: 'America/Chicago', VAULT_DIR: '/test/vault',
  JARVIS_HTTP_SECRET: 'test-secret', OBSIDIAN_VAULT_NAME: 'TestVault', TELEGRAM_USER_ID: 42,
  JARVIS_ALLOWED_HOSTS: new Set(['localhost', '127.0.0.1']), IS_PRODUCTION: false as boolean,
  LAUNCHD_LABEL: 'com.jarvis.daemon', WORKSPACE_DIR: '/test/workspace',
  PRODUCTS_CONFIG_FILE: '/test/policies/products.json',
  SUPERVISED_RUNS_FILE: '/test/logs/supervised-runs.json', WORK_RUNS_DIR: '/test/logs/work-runs',
  WORK_RUNS_INDEX_FILE: '/test/logs/work-runs/index.jsonl', BACKLOG_MUTATIONS_FILE: '/test/logs/backlog-mutations.jsonl',
  PROMOTIONS_FILE: '/test/logs/promotions.jsonl',
};
vi.mock('../config.js', () => ({ default: mockConfig, PROJECT_ROOT: '/test/project' }));
vi.mock('../jobs/sandbox-runtime.js', () => ({
  readProductsConfig: vi.fn(() => ({
    aura: { repoPath: '/test/workspace/aura', baseBranch: 'main', credentialsFile: '', egressAllowlist: [] },
    relay: { repoPath: '/test/workspace/relay', baseBranch: 'main', credentialsFile: '', egressAllowlist: [] },
  })),
  createWorktree: vi.fn(),
  destroyWorktree: vi.fn(),
  getProductConfig: vi.fn(() => ({ product: 'aura', repoPath: '/test/workspace/aura', baseBranch: 'main', egressAllowlist: [] })),
  defaultRunGit: vi.fn(async () => ({ stdout: '', stderr: '' })),
}));
vi.mock('./restart.js', () => ({ restartServer: vi.fn(() => ({ ok: true as const })) }));
vi.mock('../ai/claude.js', () => ({ runAgent: vi.fn(async () => ({ text: 'ok', error: null })) }));

const mockCreatePlanningSession = vi.fn();
vi.mock('../reviews/planning.js', () => ({
  createPlanningSession: mockCreatePlanningSession,
  getActivePlanningSession: vi.fn(() => null),
  getAllPlanningSessions: vi.fn(() => []),
  deletePlanningSession: vi.fn(),
  approveActivePlanningSession: vi.fn(),
  abandonActivePlanningSession: vi.fn(),
}));
vi.mock('../reviews/planning-handler.js', () => ({ handlePlanningTurn: vi.fn(), defaultScopingTurn: vi.fn() }));
vi.mock('../vault/sessions.js', () => ({ getSession: vi.fn(() => null) }));
vi.mock('./state-snapshot.js', () => ({ getStateSnapshot: vi.fn(() => ({ version: 1, ready: true })) }));
vi.mock('./webview-bootstrap.js', () => ({ handleWebviewMessage: vi.fn(async () => undefined) }));
vi.mock('../intent/registry.js', () => ({
  readRegistry: vi.fn(() => ({
    version: 1, builtAt: '2026-06-03T00:00:00.000Z',
    products: [
      { name: 'aura', repoBacked: true, projects: [] },
      { name: 'relay', repoBacked: true, projects: [] },
    ],
  })),
}));
vi.mock('./projects-snapshot.js', () => ({ getProjectSummaries: vi.fn(() => []) }));
vi.mock('./work-run-projection.js', () => ({ readWorkRunProjections: vi.fn(() => ({})) }));

// Promotion job is created on a successful Plan click.
const mockCreatePromotion = vi.fn((input: any) => ({ ...input, id: 'promo-new', state: 'planning-started', attempts: 0, errors: [] }));
const mockAppendPromotion = vi.fn();
vi.mock('../intent/promotions.js', () => ({
  createPromotion: mockCreatePromotion,
  appendPromotion: mockAppendPromotion,
}));

function item(over: Record<string, unknown>) {
  return { id: 'x', kind: 'bugs', text: 't', status: 'open', body: [], source: { file: 'docs/projects/bugs.md', lineNumber: 1, raw: '- [ ] t' }, warnings: [], ...over };
}
// aura and relay each have an item with the SAME id 'shared-id' (product-local ids).
const { mockBacklogs } = vi.hoisted(() => ({ mockBacklogs: [] as any[] }));
function setBacklogs(list: any[]) { mockBacklogs.length = 0; mockBacklogs.push(...list); }
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

describe('POST /api/backlog/:product/items/:id/plan (09-expand-cockpit Phase 4)', () => {
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
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreatePromotion.mockImplementation((input: any) => ({ ...input, id: 'promo-new', state: 'planning-started', attempts: 0, errors: [] }));
    setBacklogs([{ product: 'aura', notRepoBacked: false, bugs: [item({ id: 'open-bug', status: 'open' })], ideas: [], fileWarnings: [] }]);
  });

  it('requires auth', async () => {
    expect((await request(port, 'POST', '/api/backlog/aura/items/open-bug/plan')).status).toBe(401);
  });

  it('opens a planning session + promotion for an eligible open item, returning both ids', async () => {
    const res = await request(port, 'POST', '/api/backlog/aura/items/open-bug/plan', AUTH);
    expect(res.status).toBe(200);
    expect(typeof res.body.planningSessionId).toBe('string');
    expect(typeof res.body.promotionId).toBe('string');
    expect(mockCreatePromotion).toHaveBeenCalledOnce();
    expect(mockCreatePlanningSession).toHaveBeenCalledOnce();
    // The promotion must be PERSISTED at creation (append-only log) — else it's lost on restart.
    expect(mockAppendPromotion).toHaveBeenCalledOnce();
  });

  it('returns 409 stale-item when the id no longer matches an item in the product', async () => {
    const res = await request(port, 'POST', '/api/backlog/aura/items/gone-id/plan', AUTH);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: 'stale-item' });
    expect(mockCreatePromotion).not.toHaveBeenCalled();
  });

  it('returns 422 item-not-eligible for a loop-filed idea', async () => {
    setBacklogs([{ product: 'aura', notRepoBacked: false, bugs: [], ideas: [item({ id: 'loop', kind: 'ideas', status: 'open', section: 'loop-filed' })], fileWarnings: [] }]);
    const res = await request(port, 'POST', '/api/backlog/aura/items/loop/plan', AUTH);
    expect(res.status).toBe(422);
    expect(res.body.error).toMatchObject({ code: 'item-not-eligible' });
    expect(mockCreatePromotion).not.toHaveBeenCalled();
  });

  it('returns 422 item-not-eligible for a done bug', async () => {
    setBacklogs([{ product: 'aura', notRepoBacked: false, bugs: [item({ id: 'done', status: 'done' })], ideas: [], fileWarnings: [] }]);
    const res = await request(port, 'POST', '/api/backlog/aura/items/done/plan', AUTH);
    expect(res.status).toBe(422);
    expect(res.body.error).toMatchObject({ code: 'item-not-eligible' });
  });

  it('returns 422 item-not-eligible for an already-promoted item', async () => {
    setBacklogs([{ product: 'aura', notRepoBacked: false, bugs: [item({ id: 'promoted', status: 'open', promotedTo: '08-x' })], ideas: [], fileWarnings: [] }]);
    const res = await request(port, 'POST', '/api/backlog/aura/items/promoted/plan', AUTH);
    expect(res.status).toBe(422);
    expect(res.body.error).toMatchObject({ code: 'item-not-eligible' });
  });

  it('returns 422 item-not-eligible for an item with a parse warning (plan action is disabled)', async () => {
    setBacklogs([{ product: 'aura', notRepoBacked: false, bugs: [item({ id: 'warned', status: 'open', warnings: ['bad-promotion-marker'] })], ideas: [], fileWarnings: [] }]);
    const res = await request(port, 'POST', '/api/backlog/aura/items/warned/plan', AUTH);
    expect(res.status).toBe(422);
    expect(res.body.error).toMatchObject({ code: 'item-not-eligible' });
  });

  it('resolves a product-local id within the routed product (shared id does not cross products)', async () => {
    // Both aura and relay carry an item with id 'shared-id'; aura's is eligible (open), relay's is
    // done. A Plan on aura/shared-id must resolve aura's item (eligible → 200), not relay's.
    setBacklogs([
      { product: 'aura', notRepoBacked: false, bugs: [item({ id: 'shared-id', status: 'open' })], ideas: [], fileWarnings: [] },
      { product: 'relay', notRepoBacked: false, bugs: [item({ id: 'shared-id', status: 'done' })], ideas: [], fileWarnings: [] },
    ]);
    const res = await request(port, 'POST', '/api/backlog/aura/items/shared-id/plan', AUTH);
    expect(res.status).toBe(200);
    expect(mockCreatePromotion).toHaveBeenCalledOnce();
    expect(mockCreatePlanningSession).toHaveBeenCalledOnce();
  });
});
