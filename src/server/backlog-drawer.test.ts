import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import type { Server, IncomingMessage, ServerResponse } from 'node:http';

/*
 * Test-suite-as-deliverable for the backlog drawer's data endpoint (09-expand-cockpit,
 * Phase 2, written test-first).
 *
 * The drawer's DOM (Bugs/Ideas tabs, tab persistence, tooltip rendering, nested ideas body,
 * source-file link) is browser vanilla JS in app.js and not directly importable — that's the
 * integration check. What IS unit-testable is the `GET /api/backlog/:product` contract that the
 * drawer fetches: the full parsed lists + file warnings, and per-item server-COMPUTED `actions`
 * with the right `disabledReason` for each item state (spec.md "API surface" + "Data model").
 *
 * Stays RED until the Phase 2 build adds the `GET /api/backlog/:product` route (today it falls
 * through to the server's 404). The harness mirrors `webview.test.ts` / cockpit-backlog-counts.
 */

// --- Mocks (mirror the webview harness so webview.js loads) ---

vi.mock('../transport/mutations.js', () => ({
  createMutation: vi.fn(),
  cancelMutation: vi.fn(),
  activeRuns: new Map<string, unknown>(),
}));
vi.mock('../transport/in-flight.js', () => ({ cancelOp: vi.fn(), listOps: vi.fn(() => []) }));
vi.mock('../jobs/mutations-log.js', () => ({ readRecentMutations: vi.fn(() => []) }));
vi.mock('./cockpit-run-status.js', () => ({ readCockpitRunStatus: vi.fn(() => ({})) }));

const mockConfig = {
  HTTP_PORT: 0,
  HTTP_HOST: '127.0.0.1',
  TIMEZONE: 'America/Chicago',
  VAULT_DIR: '/test/vault',
  JARVIS_HTTP_SECRET: 'test-secret',
  OBSIDIAN_VAULT_NAME: 'TestVault',
  TELEGRAM_USER_ID: 42,
  JARVIS_ALLOWED_HOSTS: new Set(['localhost', '127.0.0.1']),
  IS_PRODUCTION: false as boolean,
  LAUNCHD_LABEL: 'com.jarvis.daemon',
  WORKSPACE_DIR: '/test/workspace',
  PRODUCTS_CONFIG_FILE: '/test/policies/products.json',
  SUPERVISED_RUNS_FILE: '/test/logs/supervised-runs.json',
  WORK_RUNS_DIR: '/test/logs/work-runs',
  WORK_RUNS_INDEX_FILE: '/test/logs/work-runs/index.jsonl',
};
vi.mock('../config.js', () => ({ default: mockConfig, PROJECT_ROOT: '/test/project' }));
// handleApiBacklog reads products.json via readProductsConfig — mock it so the endpoint has a
// product config without staging a real file (readBacklogs itself is mocked, so the value's
// content is irrelevant; only the call must not throw on a missing file).
vi.mock('../jobs/sandbox-runtime.js', () => ({
  readProductsConfig: vi.fn(() => ({
    aura: { repoPath: '/test/workspace/aura', baseBranch: 'main', credentialsFile: '', egressAllowlist: [] },
  })),
  createWorktree: vi.fn(),
  destroyWorktree: vi.fn(),
  getProductConfig: vi.fn(() => ({ product: 'aura', repoPath: '/test/workspace/aura', baseBranch: 'main', egressAllowlist: [] })),
  defaultRunGit: vi.fn(async () => ({ stdout: '', stderr: '' })),
}));
vi.mock('./restart.js', () => ({ restartServer: vi.fn(() => ({ ok: true as const })) }));
vi.mock('../ai/claude.js', () => ({ runAgent: vi.fn(async () => ({ text: 'ok', error: null })) }));

// The endpoint is PRODUCT-scoped, but planning sessions are chatId-keyed (a session's product
// lives at `session.planning.product`). So `planning-active` is detected by scanning ALL
// sessions for one whose `planning.product` matches — `getAllPlanningSessions`, not the
// chatId-keyed `getActivePlanningSession`.
const mockGetAllPlanningSessions = vi.fn(() => [] as Array<[number, unknown]>);
vi.mock('../reviews/planning.js', () => ({
  createPlanningSession: vi.fn(),
  getActivePlanningSession: vi.fn(() => null),
  getAllPlanningSessions: mockGetAllPlanningSessions,
  deletePlanningSession: vi.fn(),
  approveActivePlanningSession: vi.fn(),
  abandonActivePlanningSession: vi.fn(),
}));
vi.mock('../reviews/planning-handler.js', () => ({ handlePlanningTurn: vi.fn(), defaultScopingTurn: vi.fn() }));
vi.mock('../vault/sessions.js', () => ({ getSession: vi.fn(() => null) }));
vi.mock('./state-snapshot.js', () => ({ getStateSnapshot: vi.fn(() => ({ version: 1, ready: true })) }));
vi.mock('./webview-bootstrap.js', () => ({ handleWebviewMessage: vi.fn(async () => undefined) }));

const { mockRegistry } = vi.hoisted(() => ({
  mockRegistry: {
    version: 1,
    builtAt: '2026-06-03T00:00:00.000Z',
    products: [
      { name: 'aura', repoBacked: true, projects: [] },
      { name: 'relay', repoBacked: false, projects: [] },
    ],
  },
}));
vi.mock('../intent/registry.js', () => ({ readRegistry: vi.fn(() => mockRegistry) }));
vi.mock('./projects-snapshot.js', () => ({ getProjectSummaries: vi.fn(() => []) }));
vi.mock('./work-run-projection.js', () => ({ readWorkRunProjections: vi.fn(() => ({})) }));

// readBacklogs returns a fixture product backlog covering every action state the endpoint must
// distinguish: open bug (plan enabled), done bug (bug-done), promoted bug (already-promoted),
// open idea (enabled), loop-filed idea (loop-filed), bad-marker idea (parse-warning).
//
// disabledReason precedence the build must implement (each case here is orthogonal, but the
// intersections need a fixed order): planning-active > already-promoted > bug-done > loop-filed
// > parse-warning. Rationale: planning-active is a transient global gate (a session is open, so
// nothing new may start); a permanent promotion (already-promoted) outranks a transient done
// checkbox; loop-filed and parse-warning are the weakest, item-intrinsic reasons.
const { mockBacklogs } = vi.hoisted(() => {
  let n = 0;
  const item = (over: Record<string, unknown>) => ({
    id: `id${n++}`,
    kind: 'bugs',
    text: 'item',
    status: 'open',
    body: [],
    source: { file: 'docs/projects/bugs.md', lineNumber: n, raw: `- [ ] item` },
    warnings: [],
    ...over,
  });
  return {
    mockBacklogs: [
      {
        product: 'aura',
        notRepoBacked: false,
        bugs: [
          item({ id: 'b-open', kind: 'bugs', text: 'open bug', status: 'open' }),
          item({ id: 'b-done', kind: 'bugs', text: 'done bug', status: 'done' }),
          item({ id: 'b-promoted', kind: 'bugs', text: 'promoted bug', status: 'open', promotedTo: '09-x' }),
        ],
        ideas: [
          item({ id: 'i-open', kind: 'ideas', text: 'open idea', status: 'open', section: 'user-authored', body: ['sub a', 'sub b'] }),
          item({ id: 'i-loop', kind: 'ideas', text: 'loop idea', status: 'open', section: 'loop-filed' }),
          item({ id: 'i-bad', kind: 'ideas', text: 'bad → marker', status: 'open', section: 'user-authored', warnings: ['bad-promotion-marker'] }),
        ],
        fileWarnings: [{ file: 'docs/projects/ideas.md', lineNumber: 0, code: 'tab-indented', message: 'm' }],
      },
      { product: 'relay', notRepoBacked: true, bugs: [], ideas: [], fileWarnings: [] },
    ],
  };
});
vi.mock('../intent/backlog-reader.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../intent/backlog-reader.js')>();
  return { ...actual, readBacklogs: vi.fn(() => mockBacklogs) };
});

const { mountWebviewRoutes } = await import('./webview.js');

function makeRequest(
  port: number,
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const r = http.request(
      { host: '127.0.0.1', port, path, method: 'GET', headers: { host: 'localhost', ...headers } },
      (res) => {
        let body = '';
        res.on('data', (c: Buffer) => (body += c.toString()));
        res.on('end', () => {
          const parsed = (() => {
            try {
              return JSON.parse(body);
            } catch {
              return body;
            }
          })();
          resolve({ status: res.statusCode!, body: parsed });
        });
      },
    );
    r.on('error', reject);
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

const AUTH = { authorization: 'Bearer test-secret' };

let server: Server;
let webviewHandler: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;
let port: number;

/** Find the single item with the given id across bugs+ideas of a /api/backlog response. */
function findItem(body: any, id: string): any {
  return [...(body.bugs ?? []), ...(body.ideas ?? [])].find((i: any) => i.id === id);
}
/** The single `plan` action on an item. Null-safe so a missing endpoint (item undefined)
 *  yields a clean `expected undefined to match …` assertion rather than a TypeError crash. */
function planAction(item: any): any {
  return (item?.actions ?? []).find((a: any) => a.kind === 'plan');
}

describe('GET /api/backlog/:product (09-expand-cockpit Phase 2)', () => {
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

  afterAll(() => server.close());

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAllPlanningSessions.mockReturnValue([]);
  });

  it('requires auth', async () => {
    const res = await makeRequest(port, '/api/backlog/aura');
    expect(res.status).toBe(401);
  });

  it('returns parsed bugs, ideas, and fileWarnings for a repo-backed product', async () => {
    const res = await makeRequest(port, '/api/backlog/aura', AUTH);
    expect(res.status).toBe(200);
    expect((res.body.bugs ?? []).map((b: any) => b.text)).toEqual(['open bug', 'done bug', 'promoted bug']);
    expect((res.body.ideas ?? []).map((i: any) => i.text)).toEqual(['open idea', 'loop idea', 'bad → marker']);
    expect(res.body.fileWarnings).toHaveLength(1);
  });

  it('preserves the ideas body for nested-list rendering and the repo-relative source path', async () => {
    const res = await makeRequest(port, '/api/backlog/aura', AUTH);
    expect(res.status).toBe(200);
    const openIdea = findItem(res.body, 'i-open');
    expect(openIdea?.body).toEqual(['sub a', 'sub b']);
    // Source paths are repo-relative, never absolute host paths.
    expect(openIdea?.source.file.startsWith('/')).toBe(false);
  });

  it('computes a plan action: enabled for an open, unpromoted, warning-free bug', async () => {
    const res = await makeRequest(port, '/api/backlog/aura', AUTH);
    expect(planAction(findItem(res.body, 'b-open'))).toMatchObject({ kind: 'plan', enabled: true });
  });

  it('disables plan on a done bug with disabledReason bug-done', async () => {
    const res = await makeRequest(port, '/api/backlog/aura', AUTH);
    expect(planAction(findItem(res.body, 'b-done'))).toMatchObject({ enabled: false, disabledReason: 'bug-done' });
  });

  it('disables plan on an already-promoted item with disabledReason already-promoted', async () => {
    const res = await makeRequest(port, '/api/backlog/aura', AUTH);
    expect(planAction(findItem(res.body, 'b-promoted'))).toMatchObject({
      enabled: false,
      disabledReason: 'already-promoted',
    });
  });

  it('disables plan on a loop-filed idea with disabledReason loop-filed', async () => {
    const res = await makeRequest(port, '/api/backlog/aura', AUTH);
    expect(planAction(findItem(res.body, 'i-loop'))).toMatchObject({ enabled: false, disabledReason: 'loop-filed' });
  });

  it('disables plan on an item with a parse warning with disabledReason parse-warning', async () => {
    const res = await makeRequest(port, '/api/backlog/aura', AUTH);
    expect(planAction(findItem(res.body, 'i-bad'))).toMatchObject({ enabled: false, disabledReason: 'parse-warning' });
  });

  it('disables plan on every item with disabledReason planning-active when a planning session is open for the product', async () => {
    // A properly-shaped session whose product (at `planning.product`) matches the route.
    mockGetAllPlanningSessions.mockReturnValue([
      [42, { id: 's1', chatId: 42, planning: { product: 'aura', status: 'scoping', idea: 'x', surface: 'cockpit' } }],
    ]);
    const res = await makeRequest(port, '/api/backlog/aura', AUTH);
    // planning-active disables ALL items regardless of kind/state, and OUTRANKS the item's own
    // disabledReason — assert across both lists and over items that would otherwise be
    // bug-done / already-promoted.
    for (const id of ['b-open', 'i-open', 'b-done', 'b-promoted']) {
      expect(planAction(findItem(res.body, id))).toMatchObject({
        enabled: false,
        disabledReason: 'planning-active',
      });
    }
  });

  it('does NOT gate the drawer for an approved session (terminal — scaffolding in progress)', async () => {
    mockGetAllPlanningSessions.mockReturnValue([
      [42, { id: 's1', chatId: 42, planning: { product: 'aura', status: 'approved', idea: 'x', surface: 'cockpit' } }],
    ]);
    const res = await makeRequest(port, '/api/backlog/aura', AUTH);
    // An approved session is terminal — the open bug's plan action stays enabled.
    expect(planAction(findItem(res.body, 'b-open'))).toMatchObject({ kind: 'plan', enabled: true });
  });

  it('returns 404 unknown-product (structured error envelope) for a product not in the registry', async () => {
    const res = await makeRequest(port, '/api/backlog/nope', AUTH);
    expect(res.status).toBe(404);
    expect(res.body.error).toMatchObject({ code: 'unknown-product' });
  });

  it('returns 409 not-repo-backed for a non-repo-backed product', async () => {
    const res = await makeRequest(port, '/api/backlog/relay', AUTH);
    expect(res.status).toBe(409);
  });
});
