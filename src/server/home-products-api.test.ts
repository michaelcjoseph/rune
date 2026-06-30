import { describe, expect, it, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Server } from 'node:http';
import type { SupervisedRun } from '../intent/supervision.js';

vi.mock('../transport/mutations.js', () => ({
  createMutation: vi.fn(),
  cancelMutation: vi.fn(),
  activeRuns: new Map<string, unknown>(),
}));
vi.mock('../transport/in-flight.js', () => ({ cancelOp: vi.fn(), listOps: vi.fn(() => []) }));
vi.mock('../jobs/mutations-log.js', () => ({ readRecentMutations: vi.fn(() => []) }));
vi.mock('./cockpit-run-status.js', () => ({ readCockpitRunStatus: vi.fn(() => ({})) }));
vi.mock('./restart.js', () => ({ restartServer: vi.fn(() => ({ ok: true as const })) }));
vi.mock('../ai/claude.js', () => ({ runAgent: vi.fn(async () => ({ text: 'ok', error: null })) }));
vi.mock('../jobs/work-run-release.js', () => ({
  requestWorkRunRelease: vi.fn(),
  defaultReleaseRequestDeps: vi.fn(() => ({})),
}));
vi.mock('../reviews/planning-handler.js', () => ({ handlePlanningTurn: vi.fn(), defaultScopingTurn: vi.fn() }));
vi.mock('../vault/sessions.js', () => ({ getSession: vi.fn(() => null) }));
vi.mock('./state-snapshot.js', () => ({ getStateSnapshot: vi.fn(() => ({ version: 1, ready: true })) }));
vi.mock('./webview-bootstrap.js', () => ({ handleWebviewMessage: vi.fn(async () => undefined) }));
vi.mock('./projects-snapshot.js', () => ({ getProjectSummaries: vi.fn(() => []) }));
vi.mock('./work-run-projection.js', () => ({ readWorkRunProjections: vi.fn(() => ({})) }));

const mockGetAllPlanningSessions = vi.fn(() => [] as Array<[number, unknown]>);
vi.mock('../reviews/planning.js', () => ({
  createPlanningSession: vi.fn(),
  getActivePlanningSession: vi.fn(() => null),
  getAllPlanningSessions: mockGetAllPlanningSessions,
  deletePlanningSession: vi.fn(),
  approveActivePlanningSession: vi.fn(),
  abandonActivePlanningSession: vi.fn(),
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
  WORKSPACE_DIR: '/test/workspace',
  WORKTREE_ROOT: '/test/worktrees',
  PRODUCTS_CONFIG_FILE: '/test/policies/products.json',
  SUPERVISED_RUNS_FILE: '/test/logs/supervised-runs.json',
  WORK_RUNS_DIR: '/test/logs/work-runs',
  WORK_RUNS_INDEX_FILE: '/test/logs/work-runs/index.jsonl',
  ORCHESTRATED_WORK_ENABLED: false,
};
vi.mock('../config.js', () => ({ default: mockConfig, PROJECT_ROOT: '/test/project' }));

const { mockRegistry, mockBacklogs, mockRuns, mockIndexRows, mockSummariesById } = vi.hoisted(() => {
  const registry = {
    version: 1,
    builtAt: '2026-06-23T00:00:00.000Z',
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
        projects: [{ slug: '01-mvp', status: 'active', progress: { done: 2, total: 5 } }],
      },
      { name: 'relay', repoBacked: false, projects: [{ slug: '01-relay-core', status: 'active' }] },
    ],
  };
  const bug = {
    id: 'b-open',
    kind: 'bugs',
    text: 'button crashes',
    status: 'open',
    body: [],
    source: { file: 'docs/projects/bugs.md', lineNumber: 1, raw: '- [ ] button crashes' },
    warnings: [],
  };
  const idea = {
    id: 'i-open',
    kind: 'ideas',
    text: 'ship pulse view',
    status: 'open',
    body: ['show active run'],
    section: 'user-authored',
    source: { file: 'docs/projects/ideas.md', lineNumber: 1, raw: '- [ ] ship pulse view' },
    warnings: [],
  };
  const runs = [
    {
      id: 'run-parked',
      product: 'aura',
      project: '01-mvp',
      status: 'blocked-on-human',
      startedAt: '2026-06-23T12:00:00.000Z',
      lastHeartbeatAt: '2026-06-23T12:00:15.000Z',
      operatorWorktreePath: '/test/worktrees/aura-01-mvp',
    },
  ];
  return {
    mockRegistry: registry,
    mockBacklogs: [
      {
        product: 'aura',
        notRepoBacked: false,
        bugs: [bug],
        ideas: [idea],
        fileWarnings: [
          { file: 'docs/projects/ideas.md', lineNumber: 4, code: 'tab-indented', message: 'tab' },
        ],
      },
      { product: 'relay', notRepoBacked: true, bugs: [], ideas: [], fileWarnings: [] },
    ],
    mockRuns: runs,
    mockIndexRows: [
      {
        id: 'run-failed',
        project: '01-mvp',
        outcome: 'failed',
        durationMs: 600000,
        startedAt: '2026-06-23T11:00:00.000Z',
        endedAt: '2026-06-23T11:30:00.000Z',
      },
    ],
    mockSummariesById: {
      'run-failed': {
        id: 'run-failed',
        product: 'aura',
        project: '01-mvp',
        outcome: 'failed',
        reason: 'tests failed',
        exit: { code: 1, signal: null },
        workProduct: {},
        baseSha: 'abc',
        branch: 'work',
        startedAt: '2026-06-23T11:00:00.000Z',
        endedAt: '2026-06-23T11:30:00.000Z',
        transcriptPath: '/test/logs/work-runs/run-failed/transcript.jsonl',
        forensicsPath: '/test/logs/work-runs/run-failed/forensics.json',
      },
    },
  };
});

vi.mock('../intent/registry.js', () => ({ readRegistry: vi.fn(() => mockRegistry) }));
vi.mock('../intent/backlog-reader.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../intent/backlog-reader.js')>();
  return { ...actual, readBacklogs: vi.fn(() => mockBacklogs) };
});
vi.mock('../jobs/sandbox-runtime.js', () => ({
  readProductsConfig: vi.fn(() => ({
    aura: { repoPath: '/test/workspace/aura', baseBranch: 'main', credentialsFile: '', egressAllowlist: [] },
  })),
  defaultRunGit: vi.fn(),
}));
vi.mock('../jobs/supervision-store.js', () => ({
  readAllRuns: vi.fn(() => mockRuns as SupervisedRun[]),
}));
vi.mock('../jobs/work-run-store.js', () => ({
  readRecentIndex: vi.fn(() => mockIndexRows),
  readWorkRunSummary: vi.fn((_dir: string, id: string) => (mockSummariesById as any)[id] ?? null),
}));
vi.mock('../jobs/orchestrated-work-runner.js', () => ({
  readOrchestratedTaskRunRecords: vi.fn(() => [{ rolesInvoked: ['qa', 'coder'] }]),
}));

const { mountWebviewRoutes } = await import('./webview.js');

const AUTH = { authorization: 'Bearer test-secret' };

function makeRequest(
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: any }> {
  return new Promise(async (resolve, reject) => {
    let status = 200;
    const req = {
      method: 'GET',
      url: path,
      headers: { host: 'localhost', ...headers },
    } as unknown as IncomingMessage;
    const res = {
      writeHead(code: number) {
        status = code;
        return res;
      },
      end(body = '') {
        const text = Buffer.isBuffer(body) ? body.toString() : String(body);
        const parsed = (() => {
          try {
            return JSON.parse(text);
          } catch {
            return text;
          }
        })();
        resolve({ status, body: parsed });
        return res;
      },
    } as unknown as ServerResponse;

    try {
      const handled = await webviewHandler(req, res);
      if (!handled) {
        status = 404;
        resolve({ status, body: { error: 'not found (fallthrough)' } });
      }
    } catch (err) {
      reject(err);
    }
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

let server: Server & EventEmitter;
let webviewHandler: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

describe('HomePulse and ProductDeepView API routes (cockpit redesign Phase 1)', () => {
  beforeAll(async () => {
    server = new EventEmitter() as Server & EventEmitter;
    webviewHandler = mountWebviewRoutes(server, { webview: mockWebviewSender as any, isReady: () => true });
  });

  afterAll(() => {
    server.emit('close');
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAllPlanningSessions.mockReturnValue([]);
  });

  it('requires auth on GET /api/home', async () => {
    const res = await makeRequest('/api/home');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('unauthorized');
  });

  it('keeps GET /api/home behind the existing host guard', async () => {
    const res = await makeRequest('/api/home', { ...AUTH, host: 'evil.example.com' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('forbidden');
  });

  it('returns the cross-product HomePulse at GET /api/home', async () => {
    const res = await makeRequest('/api/home', AUTH);

    expect(res.status).toBe(200);
    expect(res.body.available).toBe(true);
    const aura = res.body.products.find((p: any) => p.name === 'aura');
    expect(aura).toMatchObject({
      repoBacked: true,
      counts: { activeProjects: 1, openBugs: 1, openIdeas: 1, backlogWarnings: 1 },
      activeRun: {
        runId: 'run-parked',
        target: { kind: 'project', slug: '01-mvp' },
        state: 'parked',
      },
      mostRecentRun: {
        runId: 'run-failed',
        outcome: 'failed',
        endedAt: '2026-06-23T11:30:00.000Z',
      },
    });
    expect(aura.attention.map((s: any) => s.kind)).toEqual([
      'parked-run',
      'failed-run',
      'backlog-warning',
    ]);
  });

  it('keeps GET /api/cockpit alive during the transition', async () => {
    const res = await makeRequest('/api/cockpit', AUTH);

    expect(res.status).toBe(200);
    expect(res.body.available).toBe(true);
    expect(res.body.products.find((p: any) => p.name === 'aura')).toMatchObject({
      name: 'aura',
      repoBacked: true,
    });
  });

  it('requires auth on GET /api/products/:product', async () => {
    const res = await makeRequest('/api/products/aura');
    expect(res.status).toBe(401);
  });

  it('keeps GET /api/products/:product behind the existing host guard', async () => {
    const res = await makeRequest('/api/products/aura', { ...AUTH, host: 'evil.example.com' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('forbidden');
  });

  it('returns the repo-backed ProductDeepView at GET /api/products/:product', async () => {
    const res = await makeRequest('/api/products/aura', AUTH);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
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
      projects: [{ slug: '01-mvp', lifecycle: 'active', taskProgress: { done: 2, total: 5 } }],
      activeRun: {
        runId: 'run-parked',
        state: 'parked',
        worktreePath: '/test/worktrees/aura-01-mvp',
        transcriptUrl: '/api/work-runs/run-parked/transcript',
        agents: [
          { role: 'qa', active: true },
          { role: 'coder', active: true },
        ],
      },
    });
    expect(res.body.backlog.bugs[0]).toMatchObject({
      id: 'b-open',
      plan: { kind: 'plan', enabled: true },
    });
    expect(res.body.runs).toEqual([
      {
        runId: 'run-failed',
        target: { kind: 'project', slug: '01-mvp' },
        outcome: 'failed',
        endedAt: '2026-06-23T11:30:00.000Z',
        transcriptUrl: '/api/work-runs/run-failed/transcript',
      },
    ]);
  });

  it('surfaces terminal writing pipeline state metadata in the writing product operations/runs view', async () => {
    const writingProduct = {
      name: 'writing',
      class: 'external',
      scopePath: 'docs/rune',
      repoBacked: true,
      containerCapabilities: {
        projects: false,
        bugs: false,
        ideas: true,
        runs: true,
        chat: true,
        monitoring: 'stubbed',
      },
      projects: [],
    };
    const writingRow = {
      id: 'run-writing-committed',
      project: 'operating-from-memory',
      outcome: 'branch-complete',
      durationMs: 600000,
      startedAt: '2026-06-23T12:00:00.000Z',
      endedAt: '2026-06-23T12:10:00.000Z',
    };
    const writingSummary = {
      id: 'run-writing-committed',
      product: 'writing',
      project: 'operating-from-memory',
      target: { kind: 'writing-page', slug: 'operating-from-memory' },
      outcome: 'branch-complete',
      reason: 'committed writing artifact',
      exit: { code: 0, signal: null },
      workProduct: {},
      baseSha: 'abc',
      branch: 'rune-writing/operating-from-memory',
      routePath: '/rune/operating-from-memory',
      writingStage: 'committed',
      startedAt: '2026-06-23T12:00:00.000Z',
      endedAt: '2026-06-23T12:10:00.000Z',
      transcriptPath: '/test/logs/work-runs/run-writing-committed/transcript.jsonl',
      forensicsPath: '/test/logs/work-runs/run-writing-committed/forensics.json',
    };

    mockRegistry.products.push(writingProduct as any);
    mockIndexRows.unshift(writingRow as any);
    (mockSummariesById as Record<string, any>)['run-writing-committed'] = writingSummary;
    try {
      const res = await makeRequest('/api/products/writing', AUTH);

      expect(res.status).toBe(200);
      expect(res.body.runs).toEqual([
        expect.objectContaining({
          runId: 'run-writing-committed',
          target: { kind: 'writing-page', slug: 'operating-from-memory' },
          outcome: 'completed',
          branch: 'rune-writing/operating-from-memory',
          routePath: '/rune/operating-from-memory',
          writingStage: 'committed',
          transcriptUrl: '/api/work-runs/run-writing-committed/transcript',
        }),
      ]);
    } finally {
      mockRegistry.products.pop();
      mockIndexRows.shift();
      delete (mockSummariesById as Record<string, any>)['run-writing-committed'];
    }
  });

  it('returns a 200 limited ProductDeepView, not a 409, for a known non-repo-backed product', async () => {
    const res = await makeRequest('/api/products/relay', AUTH);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      name: 'relay',
      repoBacked: false,
      limitedReason: expect.any(String),
      projects: [],
      backlog: { bugs: [], ideas: [], warnings: [] },
      runs: [],
    });
  });

  it('returns the typed error envelope for an unknown product', async () => {
    const res = await makeRequest('/api/products/not-registered', AUTH);

    expect(res.status).toBe(404);
    expect(res.body.error).toMatchObject({
      code: 'unknown-product',
      message: expect.any(String),
      retryable: false,
    });
  });

  it('rejects an invalid product slug at the route boundary with a typed 400 envelope', async () => {
    const res = await makeRequest('/api/products/..%2Fetc', AUTH);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({
      code: 'invalid-slug',
      message: expect.any(String),
      retryable: false,
    });
  });
});
