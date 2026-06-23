import { describe, expect, it, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse, Server } from 'node:http';
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
vi.mock('../intent/registry.js', () => ({
  readRegistry: vi.fn(() => ({
    version: 1,
    builtAt: '2026-06-23T00:00:00.000Z',
    products: [{ name: 'aura', repoBacked: true, projects: [{ slug: '01-mvp', status: 'active' }] }],
  })),
}));
vi.mock('../intent/backlog-reader.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../intent/backlog-reader.js')>();
  return { ...actual, readBacklogs: vi.fn(() => []) };
});
vi.mock('../jobs/sandbox-runtime.js', () => ({
  readProductsConfig: vi.fn(() => ({
    aura: { repoPath: '/test/workspace/aura', baseBranch: 'main', credentialsFile: '', egressAllowlist: [] },
  })),
  defaultRunGit: vi.fn(),
}));

const mockGetAllPlanningSessions = vi.fn(() => [] as Array<[number, unknown]>);
vi.mock('../reviews/planning.js', () => ({
  createPlanningSession: vi.fn(),
  getActivePlanningSession: vi.fn(() => null),
  getAllPlanningSessions: mockGetAllPlanningSessions,
  deletePlanningSession: vi.fn(),
  approveActivePlanningSession: vi.fn(),
  abandonActivePlanningSession: vi.fn(),
}));

const { mockRuns, mockReadOrchestratedTaskRunRecords, mockConfig } = vi.hoisted(() => ({
  mockRuns: [] as SupervisedRun[],
  mockReadOrchestratedTaskRunRecords: vi.fn(() => [] as Array<{
    rolesInvoked: string[];
    modelChoices?: Record<string, string>;
  }>),
  mockConfig: {
    HTTP_PORT: 0,
    HTTP_HOST: '127.0.0.1',
    TIMEZONE: 'America/Chicago',
    VAULT_DIR: '/test/vault',
    JARVIS_HTTP_SECRET: 'test-secret',
    OBSIDIAN_VAULT_NAME: 'TestVault',
    TELEGRAM_USER_ID: 42,
    JARVIS_ALLOWED_HOSTS: new Set(['localhost', '127.0.0.1']),
    IS_PRODUCTION: false,
    LAUNCHD_LABEL: 'com.jarvis.daemon',
    WORKSPACE_DIR: '/test/workspace',
    WORKTREE_ROOT: '/test/worktrees',
    PRODUCTS_CONFIG_FILE: '/test/products.json',
    SUPERVISED_RUNS_FILE: '/test/logs/supervised-runs.json',
    WORK_RUNS_DIR: '',
    WORK_RUNS_INDEX_FILE: '',
    ORCHESTRATED_WORK_ENABLED: false,
  },
}));

vi.mock('../config.js', () => ({ default: mockConfig, PROJECT_ROOT: '/test/project' }));
vi.mock('../jobs/supervision-store.js', () => ({ readAllRuns: vi.fn(() => mockRuns) }));
vi.mock('../jobs/work-run-store.js', () => ({
  readRecentIndex: vi.fn(() => []),
  readWorkRunSummary: vi.fn(() => null),
}));
vi.mock('../jobs/orchestrated-work-runner.js', () => ({
  readOrchestratedTaskRunRecords: mockReadOrchestratedTaskRunRecords,
}));

const { mountWebviewRoutes } = await import('./webview.js');

const AUTH = { authorization: 'Bearer test-secret' };
const RUN_ID = 'run-live-001';
const RAW_TOKEN = 'sk-liveSnapshotSecret0123456789';

const mockWebviewSender = {
  name: 'webview' as const,
  register: vi.fn(),
  unregister: vi.fn(),
  send: vi.fn(async () => undefined),
  startTyping: vi.fn(),
  stopTyping: vi.fn(),
  shutdown: vi.fn(),
};

let tmpDir: string;
let server: Server & EventEmitter;
let webviewHandler: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

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
      if (!handled) resolve({ status: 404, body: { error: 'not found (fallthrough)' } });
    } catch (err) {
      reject(err);
    }
  });
}

function seedLiveTranscript(): void {
  const runDir = join(tmpDir, RUN_ID);
  mkdirSync(runDir, { recursive: true });
  const lines = [
    JSON.stringify({
      kind: 'run-event',
      subKind: 'progress',
      runId: RUN_ID,
      product: 'aura',
      target: { kind: 'project', slug: '01-mvp' },
      tasks: { done: 3, total: 7 },
      ts: '2026-06-23T12:00:30.000Z',
    }),
    JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: `checking provider token ${RAW_TOKEN}` },
        ],
      },
    }),
    JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } },
        ],
      },
    }),
  ].join('\n') + '\n';
  writeFileSync(join(runDir, 'transcript.jsonl'), lines, 'utf8');
}

describe('GET /api/work-runs/:id/live (cockpit redesign Phase 2)', () => {
  beforeAll(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-23T12:01:05.000Z'));
    tmpDir = mkdtempSync(join(tmpdir(), 'work-run-live-api-'));
    mockConfig.WORK_RUNS_DIR = tmpDir;
    mockConfig.WORK_RUNS_INDEX_FILE = join(tmpDir, 'index.jsonl');
    server = new EventEmitter() as Server & EventEmitter;
    webviewHandler = mountWebviewRoutes(server, { webview: mockWebviewSender as any, isReady: () => true });
  });

  afterAll(() => {
    server.emit('close');
    rmSync(tmpDir, { recursive: true, force: true });
    vi.useRealTimers();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAllPlanningSessions.mockReturnValue([]);
    mockRuns.length = 0;
    mockRuns.push({
      id: RUN_ID,
      kind: 'work-run',
      product: 'aura',
      project: '01-mvp',
      status: 'running',
      startedAt: '2026-06-23T12:00:00.000Z',
      lastHeartbeatAt: '2026-06-23T12:00:55.000Z',
      lastChildAliveAt: '2026-06-23T12:01:00.000Z',
      operatorWorktreePath: '/test/worktrees/aura-01-mvp',
    });
    mockReadOrchestratedTaskRunRecords.mockReturnValue([{
      rolesInvoked: ['qa', 'coder'],
      modelChoices: { qa: 'claude', coder: 'codex' },
    }]);
    rmSync(join(tmpDir, RUN_ID), { recursive: true, force: true });
    seedLiveTranscript();
  });

  it('rejects unauthenticated live snapshots like the transcript route', async () => {
    const res = await makeRequest(`/api/work-runs/${RUN_ID}/live`);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('unauthorized');
  });

  it('returns a live snapshot rebuilt from supervision, task records, and transcript tail', async () => {
    const res = await makeRequest(`/api/work-runs/${RUN_ID}/live`, AUTH);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      runId: RUN_ID,
      product: 'aura',
      target: { kind: 'project', slug: '01-mvp' },
      state: 'running',
      tasks: { done: 3, total: 7 },
      elapsedMs: 65_000,
      worktreePath: '/test/worktrees/aura-01-mvp',
      agents: [
        { role: 'qa', active: true, model: 'claude' },
        { role: 'coder', active: true, model: 'codex' },
      ],
    });
    expect(res.body.lastLogLines).toHaveLength(2);
    expect(res.body.lastLogLines.join('\n')).toContain('checking provider token');
    expect(res.body.lastLogLines.join('\n')).toMatch(/sk-<redacted-[0-9a-f]{6}>/);
    expect(res.body.lastLogLines.join('\n')).not.toContain(RAW_TOKEN);
    expect(res.body.lastLogLines.join('\n')).toMatch(/Bash:/);
  });

  it('rehydrates a supervised live run even before its transcript exists', async () => {
    rmSync(join(tmpDir, RUN_ID, 'transcript.jsonl'), { force: true });

    const res = await makeRequest(`/api/work-runs/${RUN_ID}/live`, AUTH);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      runId: RUN_ID,
      product: 'aura',
      target: { kind: 'project', slug: '01-mvp' },
      state: 'running',
      tasks: { done: 0, total: 0 },
      elapsedMs: 65_000,
      worktreePath: '/test/worktrees/aura-01-mvp',
      agents: [
        { role: 'qa', active: true, model: 'claude' },
        { role: 'coder', active: true, model: 'codex' },
      ],
    });
    expect(res.body.lastLogLines).toEqual([]);
  });

  it('returns a typed 404 for an unknown run id', async () => {
    const res = await makeRequest('/api/work-runs/run-missing/live', AUTH);

    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      error: {
        code: 'unknown-run',
        message: expect.any(String),
        retryable: false,
      },
    });
  });
});
