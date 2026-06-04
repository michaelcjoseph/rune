import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import type { Server, IncomingMessage, ServerResponse } from 'node:http';

/*
 * Test-suite-as-deliverable for the cockpit backlog-counts contract (09-expand-cockpit,
 * Phase 2, written test-first).
 *
 * The sidebar one-liner (`Bugs N · Ideas N · ⚠ N`) and the drawer's "not repo-backed" state
 * are DOM behaviors in `src/server/static/app.js`, which is browser vanilla JS and not
 * directly importable (same constraint cockpit-ux.test.ts documents). What IS unit-testable —
 * and what the sidebar reads FROM — is the `GET /api/cockpit` data contract: that each
 * repo-backed product carries `backlogCounts` (open/done tallies + warning count) and a
 * non-repo-backed product carries none (so the drawer renders "not repo-backed").
 *
 * This stays RED until the Phase 2 build wires `readBacklogs` + `computeBacklogCounts` into
 * `handleApiCockpit` and passes the 5th `backlogCounts` arg to `buildCockpitView`.
 *
 * The harness mirrors `webview.test.ts` so the real HTTP server + `mountWebviewRoutes` are
 * exercised; only the data sources are mocked.
 */

// --- Mocks must be declared before any imports that pull in the mocked modules ---

const mockCreateMutation = vi.fn();
const mockCancelMutation = vi.fn();
const mockActiveRunsMap = new Map<string, unknown>();
vi.mock('../transport/mutations.js', () => ({
  createMutation: mockCreateMutation,
  cancelMutation: mockCancelMutation,
  activeRuns: mockActiveRunsMap,
}));

vi.mock('../transport/in-flight.js', () => ({
  cancelOp: vi.fn(),
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
  IS_PRODUCTION: false as boolean,
  LAUNCHD_LABEL: 'com.jarvis.daemon',
  WORKSPACE_DIR: '/test/workspace',
  PRODUCTS_CONFIG_FILE: '/test/policies/products.json',
  // Present so handleApiCockpit's run-status / work-run reads resolve to a path (the reads
  // themselves fail-soft on a missing file) rather than relying on swallowed `undefined`.
  SUPERVISED_RUNS_FILE: '/test/logs/supervised-runs.json',
  WORK_RUNS_DIR: '/test/logs/work-runs',
  WORK_RUNS_INDEX_FILE: '/test/logs/work-runs/index.jsonl',
};
vi.mock('../config.js', () => ({ default: mockConfig, PROJECT_ROOT: '/test/project' }));

vi.mock('./restart.js', () => ({ restartServer: vi.fn(() => ({ ok: true as const })) }));

vi.mock('../ai/claude.js', () => ({
  runAgent: vi.fn(async () => ({ text: 'ok', error: null })),
}));

vi.mock('../reviews/planning.js', () => ({
  createPlanningSession: vi.fn(),
  getActivePlanningSession: vi.fn(() => null),
  deletePlanningSession: vi.fn(),
  approveActivePlanningSession: vi.fn(),
  abandonActivePlanningSession: vi.fn(),
}));
vi.mock('../reviews/planning-handler.js', () => ({
  handlePlanningTurn: vi.fn(),
  defaultScopingTurn: vi.fn(),
}));

vi.mock('../vault/sessions.js', () => ({ getSession: vi.fn(() => null) }));

vi.mock('./state-snapshot.js', () => ({
  getStateSnapshot: vi.fn(() => ({
    version: 1,
    ready: true,
    activeSession: null,
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

// A registry with one repo-backed product (aura) and one non-repo-backed product (relay).
const { mockRegistry } = vi.hoisted(() => ({
  mockRegistry: {
    version: 1,
    builtAt: '2026-06-03T00:00:00.000Z',
    products: [
      { name: 'aura', repoBacked: true, projects: [{ slug: '01-mvp', status: 'active' }] },
      { name: 'relay', repoBacked: false, projects: [] },
    ],
  },
}));
vi.mock('../intent/registry.js', () => ({ readRegistry: vi.fn(() => mockRegistry) }));

vi.mock('./projects-snapshot.js', () => ({ getProjectSummaries: vi.fn(() => []) }));

vi.mock('./work-run-projection.js', () => ({ readWorkRunProjections: vi.fn(() => ({})) }));

// The new dependency the Phase 2 build will wire into handleApiCockpit. `readBacklogs` is
// mocked to return per-product fixtures; `computeBacklogCounts` is kept REAL (importActual) so
// the test exercises the genuine open/done/warning tally rather than a hand-stubbed shape.
const { mockProductBacklogs } = vi.hoisted(() => {
  const bug = (status: 'open' | 'done') => ({ status }) as unknown;
  const idea = (status: 'open' | 'done') => ({ status }) as unknown;
  const warn = () => ({ file: 'docs/projects/bugs.md', lineNumber: 0, code: 'x', message: 'm' });
  return {
    mockProductBacklogs: [
      {
        product: 'aura',
        notRepoBacked: false,
        bugs: [bug('open'), bug('open'), bug('open'), bug('open'), bug('done')],
        ideas: [idea('open'), idea('open'), idea('open'), idea('open'), idea('open'), idea('open'), idea('open')],
        fileWarnings: [warn(), warn()],
      },
      { product: 'relay', notRepoBacked: true, bugs: [], ideas: [], fileWarnings: [] },
    ],
  };
});
vi.mock('../intent/backlog-reader.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../intent/backlog-reader.js')>();
  return { ...actual, readBacklogs: vi.fn(() => mockProductBacklogs) };
});

// Import after mocks are wired up.
const { mountWebviewRoutes } = await import('./webview.js');
const { readRegistry } = await import('../intent/registry.js');

// ---- helpers ----

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

// ---- server setup ----

let server: Server;
let webviewHandler: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;
let port: number;

describe('GET /api/cockpit — backlog counts (09-expand-cockpit Phase 2)', () => {
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
    (readRegistry as ReturnType<typeof vi.fn>).mockReturnValue(mockRegistry);
    mockReadCockpitRunStatus.mockReturnValue({});
  });

  it('surfaces backlogCounts (open/done tallies + warning count) on a repo-backed product', async () => {
    const res = await makeRequest(port, '/api/cockpit', { authorization: 'Bearer test-secret' });
    expect(res.status).toBe(200);
    const aura = res.body.products.find((p: any) => p.name === 'aura');
    expect(aura.backlogCounts).toEqual({
      bugs: { open: 4, done: 1 },
      ideas: { open: 7, done: 0 },
      warnings: 2,
    });
  });

  it('exposes the warning count so the sidebar can render the ⚠ figure', async () => {
    const res = await makeRequest(port, '/api/cockpit', { authorization: 'Bearer test-secret' });
    const aura = res.body.products.find((p: any) => p.name === 'aura');
    expect(aura.backlogCounts?.warnings).toBe(2);
  });

  it('carries no backlogCounts on a non-repo-backed product (drawer renders "not repo-backed")', async () => {
    const res = await makeRequest(port, '/api/cockpit', { authorization: 'Bearer test-secret' });
    const relay = res.body.products.find((p: any) => p.name === 'relay');
    expect(relay.repoBacked).toBe(false);
    expect(relay.backlogCounts).toBeUndefined();
  });

  it('still requires auth', async () => {
    const res = await makeRequest(port, '/api/cockpit');
    expect(res.status).toBe(401);
  });
});
