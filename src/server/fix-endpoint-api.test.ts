import { beforeAll, beforeEach, afterEach, afterAll, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../transport/mutations.js', () => ({ createMutation: vi.fn(), cancelMutation: vi.fn(), activeRuns: new Map() }));
vi.mock('../transport/in-flight.js', () => ({ cancelOp: vi.fn(), listOps: vi.fn(() => []) }));
vi.mock('../jobs/mutations-log.js', () => ({ readRecentMutations: vi.fn(() => []) }));
vi.mock('./cockpit-run-status.js', () => ({ readCockpitRunStatus: vi.fn(() => ({})) }));
vi.mock('./restart.js', () => ({ restartServer: vi.fn(() => ({ ok: true as const })) }));
vi.mock('../ai/claude.js', () => ({ runAgent: vi.fn(async () => ({ text: 'ok', error: null })) }));
vi.mock('../reviews/planning-handler.js', () => ({ handlePlanningTurn: vi.fn(), defaultScopingTurn: vi.fn() }));
vi.mock('../vault/sessions.js', () => ({ getSession: vi.fn(() => null) }));
vi.mock('./state-snapshot.js', () => ({ getStateSnapshot: vi.fn(() => ({ version: 1, ready: true })) }));
vi.mock('./webview-bootstrap.js', () => ({ handleWebviewMessage: vi.fn(async () => undefined) }));
vi.mock('./projects-snapshot.js', () => ({ getProjectSummaries: vi.fn(() => []) }));
vi.mock('./work-run-projection.js', () => ({ readWorkRunProjections: vi.fn(() => ({})) }));
vi.mock('../jobs/work-run-release.js', () => ({
  requestWorkRunRelease: vi.fn(),
  defaultReleaseRequestDeps: vi.fn(() => ({})),
}));
vi.mock('../intent/promotions.js', () => ({
  createPromotion: vi.fn(),
  appendPromotion: vi.fn(),
  loadPromotions: vi.fn(() => new Map()),
  transitionPromotion: vi.fn(),
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
  WORKTREE_ROOT: '/test/worktrees',
  PRODUCTS_CONFIG_FILE: '/test/policies/products.json',
  SUPERVISED_RUNS_FILE: '/test/logs/supervised-runs.json',
  WORK_RUNS_DIR: '/test/logs/work-runs',
  WORK_RUNS_INDEX_FILE: '/test/logs/work-runs/index.jsonl',
  BACKLOG_MUTATIONS_FILE: '/test/logs/backlog-mutations.jsonl',
  PROMOTIONS_FILE: '/test/logs/promotions.jsonl',
  FIX_ATTEMPTS_FILE: '/test/logs/fix-attempts.jsonl',
  ORCHESTRATED_WORK_ENABLED: false,
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

const { mockBacklogs } = vi.hoisted(() => {
  const bug = (overrides: Record<string, unknown>) => ({
    id: 'bug-open',
    kind: 'bugs',
    text: 'Save button crashes',
    status: 'open',
    body: ['Repro: click Save on Settings.'],
    source: { file: 'docs/projects/bugs.md', lineNumber: 1, raw: '- [ ] Save button crashes' },
    warnings: [],
    ...overrides,
  });
  return {
    mockBacklogs: [
      {
        product: 'aura',
        notRepoBacked: false,
        bugs: [
          bug({ id: 'bug-open' }),
          bug({ id: 'bug-handoff' }),
          bug({ id: 'bug-done', status: 'done' }),
          bug({ id: 'bug-warned', warnings: ['bad-marker'] }),
        ],
        ideas: [
          bug({ id: 'idea-open', kind: 'ideas', text: 'Build a dashboard', source: { file: 'docs/projects/ideas.md', lineNumber: 1, raw: '- [ ] Build a dashboard' } }),
        ],
        fileWarnings: [],
      },
      { product: 'relay', notRepoBacked: true, bugs: [], ideas: [], fileWarnings: [] },
    ],
  };
});

const mockRunPmTechLeadBugScoping = vi.fn(async () => ({
  itemEligible: true,
  fieldsComplete: true,
  pmAssessed: true,
  pmWellScoped: true,
  techLeadReviewed: true,
}));
vi.mock('../jobs/pm-techlead-bug-scoping.js', () => ({
  runPmTechLeadBugScoping: mockRunPmTechLeadBugScoping,
}));

const mockStartFixRun = vi.fn(async () => ({ accepted: true, runId: 'run-fix-accepted' }));
vi.mock('../jobs/fix-run-handoff.js', () => ({
  startFixRun: mockStartFixRun,
}));

vi.mock('../intent/registry.js', () => ({
  readRegistry: vi.fn(() => ({
    version: 1,
    builtAt: '2026-06-23T00:00:00.000Z',
    products: [
      { name: 'aura', repoBacked: true, projects: [] },
      { name: 'relay', repoBacked: false, projects: [] },
    ],
  })),
}));
vi.mock('../intent/backlog-reader.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../intent/backlog-reader.js')>();
  return { ...actual, readBacklogs: vi.fn(() => mockBacklogs) };
});
vi.mock('../reviews/planning.js', () => ({
  createPlanningSession: vi.fn(),
  getActivePlanningSession: vi.fn(() => null),
  getAllPlanningSessions: vi.fn(() => []),
  deletePlanningSession: vi.fn(),
  approveActivePlanningSession: vi.fn(),
  abandonActivePlanningSession: vi.fn(),
}));
vi.mock('../jobs/supervision-store.js', () => ({ readAllRuns: vi.fn(() => []) }));
vi.mock('../jobs/work-run-store.js', () => ({ readRecentIndex: vi.fn(() => []), readWorkRunSummary: vi.fn(() => null) }));
vi.mock('../jobs/orchestrated-work-runner.js', () => ({ readOrchestratedTaskRunRecords: vi.fn(() => []) }));

const { mountWebviewRoutes } = await import('./webview.js');

function request(method: string, path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
  return new Promise(async (resolve, reject) => {
    let status = 200;
    const req = {
      method,
      url: path,
      headers: { host: 'localhost', ...headers },
      on(event: string, cb: (...args: any[]) => void) {
        if (event === 'end') queueMicrotask(() => cb());
        return req;
      },
    } as unknown as IncomingMessage;
    const res = {
      writeHead(code: number) {
        status = code;
        return res;
      },
      end(raw = '') {
        const buf = Buffer.isBuffer(raw) ? raw.toString() : String(raw);
        const parsed = (() => {
          try { return JSON.parse(buf); } catch { return buf; }
        })();
        resolve({ status, body: parsed });
        return res;
      },
    } as unknown as ServerResponse;

    try {
      const handled = await handler(req, res);
      if (!handled) {
        status = 404;
        resolve({ status, body: { error: 'fallthrough' } });
      }
    } catch (err) {
      reject(err);
    }
  });
}

const AUTH = { authorization: 'Bearer test-secret' };
const mockSender = { name: 'webview' as const, register: vi.fn(), unregister: vi.fn(), send: vi.fn(async () => undefined), startTyping: vi.fn(), stopTyping: vi.fn(), shutdown: vi.fn() };

let server: Server & EventEmitter;
let handler: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;
let tempDir: string;

async function flushAsyncGate(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await Promise.resolve();
}

function readAttemptLines(): any[] {
  if (!existsSync(mockConfig.FIX_ATTEMPTS_FILE)) return [];
  return readFileSync(mockConfig.FIX_ATTEMPTS_FILE, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

describe('POST /api/backlog/:product/items/:id/fix - cockpit redesign Phase 3', () => {
  beforeAll(async () => {
    server = new EventEmitter() as Server & EventEmitter;
    handler = mountWebviewRoutes(server, { webview: mockSender as any, isReady: () => true });
  });

  afterAll(() => {
    server.emit('close');
  });

  beforeEach(() => {
    vi.clearAllMocks();
    tempDir = mkdtempSync(join(tmpdir(), 'fix-endpoint-api-'));
    mockConfig.FIX_ATTEMPTS_FILE = join(tempDir, 'fix-attempts.jsonl');
    mockRunPmTechLeadBugScoping.mockResolvedValue({
      itemEligible: true,
      fieldsComplete: true,
      pmAssessed: true,
      pmWellScoped: true,
      techLeadReviewed: true,
    });
    mockStartFixRun.mockResolvedValue({ accepted: true, runId: 'run-fix-accepted' });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('requires auth before accepting an LLM-spending Fix attempt', async () => {
    const res = await request('POST', '/api/backlog/aura/items/bug-open/fix');
    expect(res.status).toBe(401);
    expect(readAttemptLines()).toEqual([]);
  });

  it('validates an open bug, persists gating, returns 202 before PM/TL scoping resolves, then records proceeding only after startFixRun accepts a run id', async () => {
    let resolveScoping!: (facts: any) => void;
    mockRunPmTechLeadBugScoping.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveScoping = resolve;
      }),
    );

    const res = await request('POST', '/api/backlog/aura/items/bug-open/fix', AUTH);

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ attemptId: expect.any(String) });
    expect(mockStartFixRun).not.toHaveBeenCalled();
    expect(readAttemptLines()).toEqual([
      expect.objectContaining({
        attemptId: res.body.attemptId,
        product: 'aura',
        bugId: 'bug-open',
        state: 'gating',
        updatedAt: expect.any(String),
      }),
    ]);

    resolveScoping({
      itemEligible: true,
      fieldsComplete: true,
      pmAssessed: true,
      pmWellScoped: true,
      techLeadReviewed: true,
    });

    await flushAsyncGate();

    expect(mockRunPmTechLeadBugScoping).toHaveBeenCalledWith(expect.objectContaining({
      product: 'aura',
      bug: expect.objectContaining({ id: 'bug-open', text: 'Save button crashes' }),
    }));
    expect(mockStartFixRun).toHaveBeenCalledWith(expect.objectContaining({
      product: 'aura',
      bugId: 'bug-open',
      scope: expect.any(Object),
    }));

    expect(readAttemptLines()).toEqual([
      expect.objectContaining({ state: 'gating' }),
      expect.objectContaining({
        attemptId: res.body.attemptId,
        product: 'aura',
        bugId: 'bug-open',
        state: 'proceeding',
        runId: 'run-fix-accepted',
      }),
    ]);
  });

  it('records a declined attempt with the gate reason and never calls startFixRun', async () => {
    mockRunPmTechLeadBugScoping.mockResolvedValue({
      itemEligible: true,
      fieldsComplete: true,
      pmAssessed: true,
      pmWellScoped: false,
      pmReason: 'Missing reproduction steps.',
      techLeadReviewed: false,
    });

    const res = await request('POST', '/api/backlog/aura/items/bug-open/fix', AUTH);
    expect(res.status).toBe(202);
    await flushAsyncGate();

    expect(mockStartFixRun).not.toHaveBeenCalled();
    expect(readAttemptLines()).toEqual([
      expect.objectContaining({ state: 'gating' }),
      expect.objectContaining({
        attemptId: res.body.attemptId,
        product: 'aura',
        bugId: 'bug-open',
        state: 'declined',
        reason: 'pm-not-well-scoped',
        detail: 'Missing reproduction steps.',
      }),
    ]);
  });

  it('records handoff-failed when a passing gate cannot get an accepted run id', async () => {
    mockStartFixRun.mockRejectedValue(new Error('autorun handoff unavailable'));

    const res = await request('POST', '/api/backlog/aura/items/bug-open/fix', AUTH);
    expect(res.status).toBe(202);
    await flushAsyncGate();

    expect(readAttemptLines()).toEqual([
      expect.objectContaining({ state: 'gating' }),
      expect.objectContaining({
        attemptId: res.body.attemptId,
        product: 'aura',
        bugId: 'bug-open',
        state: 'handoff-failed',
        reason: expect.any(String),
        detail: expect.stringContaining('autorun handoff unavailable'),
      }),
    ]);
    expect(readAttemptLines()).not.toContainEqual(
      expect.objectContaining({ state: 'proceeding', runId: expect.any(String) }),
    );
  });

  it('surfaces declined and handoff-failed Fix attempts in the product deep view', async () => {
    const { appendFixAttempt } = await import('../jobs/fix-attempt-store.js');
    appendFixAttempt(mockConfig.FIX_ATTEMPTS_FILE, {
      attemptId: 'attempt-declined',
      product: 'aura',
      bugId: 'bug-open',
      state: 'declined',
      reason: 'pm-not-well-scoped',
      detail: 'Missing reproduction steps.',
      updatedAt: '2026-06-23T12:00:00.000Z',
    });
    appendFixAttempt(mockConfig.FIX_ATTEMPTS_FILE, {
      attemptId: 'attempt-handoff-failed',
      product: 'aura',
      bugId: 'bug-handoff',
      state: 'handoff-failed',
      reason: 'handoff-unavailable',
      detail: 'startFixRun unavailable.',
      updatedAt: '2026-06-23T12:01:00.000Z',
    });

    const res = await request('GET', '/api/products/aura', AUTH);

    expect(res.status).toBe(200);
    expect(res.body.backlog.bugs.find((bug: any) => bug.id === 'bug-open')).toMatchObject({
      fix: {
        kind: 'fix',
        state: 'declined',
        reason: 'pm-not-well-scoped',
        detail: 'Missing reproduction steps.',
      },
    });
    expect(res.body.backlog.bugs.find((bug: any) => bug.id === 'bug-handoff')).toMatchObject({
      fix: {
        kind: 'fix',
        state: 'handoff-failed',
        reason: 'handoff-unavailable',
        detail: 'startFixRun unavailable.',
      },
    });
  });

  it.each([
    ['missing item', 'missing-bug', 409, 'stale-item'],
    ['done bug', 'bug-done', 422, 'item-not-eligible'],
    ['parse-warning bug', 'bug-warned', 422, 'item-not-eligible'],
    ['idea', 'idea-open', 422, 'item-not-eligible'],
  ])('rejects %s without starting the gate', async (_label, id, status, code) => {
    const res = await request('POST', `/api/backlog/aura/items/${id}/fix`, AUTH);

    expect(res.status).toBe(status);
    expect(res.body.error).toMatchObject({ code });
    expect(readAttemptLines()).toEqual([]);
    expect(mockRunPmTechLeadBugScoping).not.toHaveBeenCalled();
    expect(mockStartFixRun).not.toHaveBeenCalled();
  });

  it('guards concurrent clicks for the same bug while a gating attempt is already active', async () => {
    const existing = {
      attemptId: 'existing-gate',
      product: 'aura',
      bugId: 'bug-open',
      state: 'gating',
      updatedAt: '2026-06-23T12:00:00.000Z',
    };
    await import('../jobs/fix-attempt-store.js').then(({ appendFixAttempt }) => {
      appendFixAttempt(mockConfig.FIX_ATTEMPTS_FILE, existing as any);
    });

    const res = await request('POST', '/api/backlog/aura/items/bug-open/fix', AUTH);

    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({
      code: 'fix-already-gating',
      attemptId: 'existing-gate',
    });
    expect(readAttemptLines()).toEqual([existing]);
    expect(mockRunPmTechLeadBugScoping).not.toHaveBeenCalled();
    expect(mockStartFixRun).not.toHaveBeenCalled();
  });
});
