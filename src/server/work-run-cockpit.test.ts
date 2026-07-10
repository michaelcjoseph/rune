/**
 * Test-suite-as-deliverable for project 11 (work-run observability) Phase 5 —
 * Cockpit UX (test-plan.md §5). This file is written test-first BEFORE the
 * Phase 5 implementation lands; every behavioral test here is expected to stay
 * RED until the matching impl task ships:
 *
 *   - "Data path + card" — the work-run projection added to `buildCockpitView`
 *     from the new run store (id, last-N output, elapsed, outcome, reason,
 *     transcript URL), surfaced on `/api/cockpit`.
 *   - "Data path + card" — the authenticated `GET /api/work-runs/:id` and
 *     `GET /api/work-runs/:id/transcript` routes with path containment,
 *     traversal rejection, and correct content-type.
 *
 * What's testable here vs. what isn't:
 *   - The DOM-side card rendering in `src/server/static/app.js` is browser
 *     vanilla JS and isn't directly importable. So §5's card items are tested
 *     at the DATA CONTRACT the card reads FROM — the `workRun` projection shape
 *     (`buildCockpitView` output + `/api/cockpit` response) and the
 *     transcript/record routes. Live DOM verification is the Phase 6 watched-run
 *     integration check (test-plan.md §6), out of scope for this unit suite.
 *
 * Design note — how the work-run projection is fed:
 *   The Phase 5 Plan phase settles the exact wiring, but the contract these
 *   tests pin is: `buildCockpitView` gains a work-run projection sourced from
 *   the new store and surfaces it on each `CockpitProject` as a `workRun` field
 *   carrying { mutationId, outcome, reason, lastOutput[], startedAt,
 *   transcriptUrl }. Mirroring the `taskProgress` precedent (a slug-keyed map
 *   passed as a positional arg), the projection is fed as a slug-keyed map. If
 *   the impl chooses a different feed, the feed in these tests adapts — but the
 *   OUTPUT contract (these fields reach the cockpit project) holds.
 *
 * The suite mirrors `cockpit-ux.test.ts` / `webview.test.ts`'s HTTP-server
 * setup so the new routes can be hit via real `http.request` once they exist.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import type { Server, IncomingMessage, ServerResponse } from 'node:http';
import type { CockpitView } from '../intent/cockpit.js';

// ---------------------------------------------------------------------------
// Hoisted fixtures — a per-process work-runs dir the mocked config points at.
// Computed without imports (hoisted runs before module init); created in
// beforeAll, torn down in afterAll.
// ---------------------------------------------------------------------------

const { WORK_RUNS_DIR } = vi.hoisted(() => ({
  WORK_RUNS_DIR: `/tmp/rune-test-work-run-cockpit-${process.pid}`,
}));

// ---------------------------------------------------------------------------
// Mocks — mirror cockpit-ux.test.ts so mountWebviewRoutes' import graph
// resolves, plus the work-runs config the Phase 5 route handler reads.
// ---------------------------------------------------------------------------

// activeRuns is cleared in beforeEach; createMutation/cancelMutation are
// mocked only so the import graph resolves — never asserted on, so inline them.
const mockActiveRunsMap = new Map<string, unknown>();
vi.mock('../transport/mutations.js', () => ({
  createMutation: vi.fn(),
  cancelMutation: vi.fn(),
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

// getProjectSummaries is read by handleApiCockpit — mock it so the endpoint
// tests don't depend on real tasks.md on disk.
vi.mock('./projects-snapshot.js', () => ({
  getProjectSummaries: vi.fn(() => []),
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
  IS_PRODUCTION: false,
  WORK_RUNS_DIR,
  WORK_RUNS_INDEX_FILE: join(WORK_RUNS_DIR, 'index.jsonl'),
};
vi.mock('../config.js', () => ({
  default: mockConfig,
  PROJECT_ROOT: '/test/project',
}));

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
    products: [{ name: 'aura', repoBacked: true, projects: [{ slug: '02-growth', status: 'active' }] }],
  },
}));
vi.mock('../intent/registry.js', () => ({ readRegistry: vi.fn(() => mockRegistry) }));

// Planning + approval-inbox store mocks — present so mountWebviewRoutes'
// import graph resolves; not exercised by this suite.
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
vi.mock('../intent/intent-proposal-queue.js', () => ({ readIntentProposalQueue: vi.fn(() => []) }));
vi.mock('../jobs/proposal-queue.js', () => ({ readProposalQueue: vi.fn(() => []) }));
vi.mock('../jobs/playbook-extract.js', () => ({ readPlaybookQueue: vi.fn(() => []) }));
vi.mock('../jobs/supervision-store.js', () => ({ readAllRuns: vi.fn(() => []) }));
vi.mock('../intent/supervision.js', () => ({
  getVisibility: vi.fn(() => ({ active: [], blocked: [], stalled: [] })),
}));
vi.mock('../transport/approval-actions.js', () => ({
  dispatchApprovalStatus: vi.fn(async () => 'not-found'),
}));

const { mountWebviewRoutes } = await import('./webview.js');
const { buildCockpitView } = await import('../intent/cockpit.js');
const { readAllRuns } = await import('../jobs/supervision-store.js');

// Loosely-typed view of buildCockpitView so the (future) 4th work-run arg can
// be passed without a TS arity error before the param exists on the signature.
// vitest strips types at runtime — extra args are ignored by today's impl,
// which is exactly what makes the projection assertions red until Phase 5.
// TODO(phase-5): drop this `build` cast and the per-call `as any` on `project`
// once `buildCockpitView` gains the work-runs param and `CockpitProject.workRun`.
// `typeof mockRegistry` (not the real `Registry`) intentionally — the hoisted
// mock literal types `status` as `string`, not `LifecycleStatus`, matching how
// cockpit-ux.test.ts feeds the same fixture to buildCockpitView. Using `Registry`
// here would add a spurious tsc error against the loose mock literal.
const build = buildCockpitView as unknown as (
  registry: typeof mockRegistry | null,
  runStatus: Record<string, unknown>,
  taskProgress?: Record<string, { done: number; total: number }>,
  workRuns?: Record<string, unknown>,
) => CockpitView;

// ---------------------------------------------------------------------------
// HTTP helper — identical to the one in cockpit-ux.test.ts / webview.test.ts.
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

/** Coerce a parsed response body (object or raw string) back to text for
 *  substring/regex assertions. */
const bodyText = (b: unknown): string => (typeof b === 'string' ? b : JSON.stringify(b));

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

const AUTH_COOKIE = 'rune-auth=test-secret';

// A run fixture seeded under WORK_RUNS_DIR/<id>/ — summary.json + transcript.jsonl.
const RUN_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const RUN_NO_TRANSCRIPT = 'ffffffff-1111-2222-3333-444444444444';
const ORCH_RUN_ID = 'orch-run-active-001';

const SUMMARY_FIXTURE = {
  id: RUN_ID,
  project: '02-growth',
  product: 'aura',
  outcome: 'partial',
  reason: 'commits present, 2 tasks remain',
  exit: { exitCode: 0, signal: null, cancelled: false, durationMs: 12000 },
  workProduct: {
    commitCount: 1, commitShas: ['abc1234'], filesChanged: ['src/x.ts'],
    diffstat: ' src/x.ts | 2 +-', dirty: false, untracked: false,
    transitions: { tasksNewlyChecked: 3, tasksRemaining: 2, tasksAdded: 0, tasksRemoved: 0 },
  },
  baseSha: 'base000',
  branch: 'rune-work/02-growth',
  startedAt: '2026-05-30T12:00:00.000Z',
  endedAt: '2026-05-30T12:00:12.000Z',
  transcriptPath: join(WORK_RUNS_DIR, RUN_ID, 'transcript.jsonl'),
  forensicsPath: join(WORK_RUNS_DIR, RUN_ID),
};

const TRANSCRIPT_LINES = [
  JSON.stringify({ type: 'assistant', text: 'Reading tasks.md' }),
  JSON.stringify({ type: 'tool_use', name: 'Edit', input: { file_path: 'src/x.ts' } }),
  JSON.stringify({ type: 'result', subtype: 'success' }),
].join('\n') + '\n';

const ORCH_TRANSCRIPT_LINES = [
  JSON.stringify({
    mutationId: ORCH_RUN_ID,
    ts: '2026-06-17T10:00:05.000Z',
    kind: 'activity',
    data: {
      role: 'qa',
      provider: 'openai',
      model: 'gpt-5.6-terra',
      line: 'qa | openai | gpt-5.6-terra | writing tests from the spec',
    },
  }),
  JSON.stringify({
    mutationId: ORCH_RUN_ID,
    ts: '2026-06-17T10:00:10.000Z',
    kind: 'output',
    data: {
      role: 'coder',
      provider: 'openai',
      model: 'gpt-5.6-sol',
      line: 'coder | openai | gpt-5.6-sol | wiring cockpit projection',
    },
  }),
].join('\n') + '\n';

beforeAll(async () => {
  // Seed fixtures: one full run (summary + transcript), one record-only run.
  mkdirSync(join(WORK_RUNS_DIR, RUN_ID), { recursive: true });
  writeFileSync(join(WORK_RUNS_DIR, RUN_ID, 'summary.json'), JSON.stringify(SUMMARY_FIXTURE, null, 2));
  writeFileSync(join(WORK_RUNS_DIR, RUN_ID, 'transcript.jsonl'), TRANSCRIPT_LINES);
  mkdirSync(join(WORK_RUNS_DIR, RUN_NO_TRANSCRIPT), { recursive: true });
  writeFileSync(
    join(WORK_RUNS_DIR, RUN_NO_TRANSCRIPT, 'summary.json'),
    JSON.stringify({ ...SUMMARY_FIXTURE, id: RUN_NO_TRANSCRIPT }, null, 2),
  );
  // Also seed the rolling index (logs/work-runs/index.jsonl). The Phase 5
  // cockpit projection may source recent runs via `readRecentIndex` rather
  // than scanning per-run summary.json dirs; seeding both keeps the §5.1
  // /api/cockpit test green-able regardless of which the impl reads from.
  const indexRow = (id: string) => JSON.stringify({
    id, project: '02-growth', outcome: 'partial',
    durationMs: 12000, startedAt: SUMMARY_FIXTURE.startedAt, endedAt: SUMMARY_FIXTURE.endedAt,
  });
  writeFileSync(
    join(WORK_RUNS_DIR, 'index.jsonl'),
    `${indexRow(RUN_ID)}\n${indexRow(RUN_NO_TRANSCRIPT)}\n`,
  );
  mkdirSync(join(WORK_RUNS_DIR, ORCH_RUN_ID), { recursive: true });
  writeFileSync(join(WORK_RUNS_DIR, ORCH_RUN_ID, 'transcript.jsonl'), ORCH_TRANSCRIPT_LINES);

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
  rmSync(WORK_RUNS_DIR, { recursive: true, force: true });
});

beforeEach(() => {
  vi.clearAllMocks();
  mockActiveRunsMap.clear();
  mockReadCockpitRunStatus.mockReturnValue({});
  (readAllRuns as ReturnType<typeof vi.fn>).mockReturnValue([]);
});

// ---------------------------------------------------------------------------
// §5 item 1 — buildCockpitView projection exposes the work-run fields
// ---------------------------------------------------------------------------
//
// "🔴 buildCockpitView / /api/cockpit exposes run id, last-N output, elapsed,
// outcome, and reason."

describe('work-run projection on buildCockpitView (§5.1)', () => {
  it('surfaces a workRun blob (id, lastOutput, startedAt, outcome, reason, transcriptUrl) for an active run', () => {
    const workRuns = {
      '02-growth': {
        mutationId: RUN_ID,
        outcome: null,                      // still running → no terminal verdict yet
        reason: null,
        lastOutput: ['Reading tasks.md', 'Editing src/x.ts'],
        startedAt: '2026-05-30T12:00:00.000Z',
        transcriptUrl: `/api/work-runs/${RUN_ID}/transcript`,
      },
    };
    const view = build(mockRegistry, { '02-growth': 'running' }, undefined, workRuns);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const project = view.products[0]!.projects[0]! as any;
    expect(project.workRun).toBeDefined();
    expect(project.workRun.mutationId).toBe(RUN_ID);
    expect(Array.isArray(project.workRun.lastOutput)).toBe(true);
    expect(project.workRun.lastOutput.length).toBeGreaterThan(0);
    // `elapsed` is derived at render from a parseable startedAt basis.
    expect(Number.isFinite(Date.parse(project.workRun.startedAt))).toBe(true);
    expect(project.workRun.transcriptUrl).toContain(RUN_ID);
  });

  it('carries the terminal outcome + reason once a run has terminated', () => {
    const workRuns = {
      '02-growth': {
        mutationId: RUN_ID,
        outcome: 'partial',
        reason: 'commits present, 2 tasks remain',
        lastOutput: ['done'],
        startedAt: '2026-05-30T12:00:00.000Z',
        transcriptUrl: `/api/work-runs/${RUN_ID}/transcript`,
      },
    };
    // A terminated run reports runStatus idle (no in-flight mutation), but the
    // workRun projection still carries the verdict so the card renders the
    // outcome in place of a stale `running` pill (§5.2).
    const view = build(mockRegistry, {}, undefined, workRuns);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const project = view.products[0]!.projects[0]! as any;
    expect(project.runStatus).toBe('idle');
    expect(project.workRun).toBeDefined();
    expect(project.workRun.outcome).toBe('partial');
    expect(project.workRun.reason).toBe('commits present, 2 tasks remain');
  });

  it('omits workRun for projects with no run data (back-compat)', () => {
    const view = build(mockRegistry, {});
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const project = view.products[0]!.projects[0]! as any;
    expect(project.workRun ?? null).toBeNull();
  });

  it('degrades gracefully when a run has no transcript yet (transcriptUrl null, still projected) (§5.4)', () => {
    const workRuns = {
      '02-growth': {
        mutationId: RUN_ID,
        outcome: null,
        reason: null,
        lastOutput: [],
        startedAt: '2026-05-30T12:00:00.000Z',
        transcriptUrl: null,   // no transcript persisted yet
      },
    };
    const view = build(mockRegistry, { '02-growth': 'running' }, undefined, workRuns);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const project = view.products[0]!.projects[0]! as any;
    // The projection is present (card renders) even with no transcript link.
    expect(project.workRun).toBeDefined();
    expect(project.workRun.transcriptUrl ?? null).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// §5 item 1 — /api/cockpit surfaces the work-run projection end-to-end
// ---------------------------------------------------------------------------

describe('GET /api/cockpit surfaces the work-run projection (§5.1)', () => {
  it('rejects unauthenticated requests', async () => {
    const res = await makeRequest(port, '/api/cockpit');
    expect(res.status).toBe(401);
  });

  it('includes a workRun projection (outcome + reason) for a project with a persisted run', async () => {
    // The Phase 5 handler reads the new run store (WORK_RUNS_DIR fixtures) and
    // feeds the projection into buildCockpitView. Until that wiring lands the
    // response carries no `workRun` → red.
    const res = await makeRequest(port, '/api/cockpit', { headers: { Cookie: AUTH_COOKIE } });
    expect(res.status).toBe(200);
    const view = res.body as CockpitView;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const project = view.products?.[0]?.projects?.[0] as any;
    expect(project).toBeDefined();
    expect(project.workRun).toBeDefined();
    expect(project.workRun.outcome).toBe('partial');
    expect(project.workRun.reason).toBeTruthy();
  });

  it('projects active orchestrated role activity into lastOutput with a transcript link', async () => {
    (readAllRuns as ReturnType<typeof vi.fn>).mockReturnValue([
      {
        id: ORCH_RUN_ID,
        product: 'aura',
        project: '02-growth',
        status: 'running',
        startedAt: '2026-06-17T10:00:00.000Z',
        lastHeartbeatAt: '2026-06-17T10:00:10.000Z',
        lastOutputAt: '2026-06-17T10:00:10.000Z',
      },
    ]);

    const res = await makeRequest(port, '/api/cockpit', { headers: { Cookie: AUTH_COOKIE } });

    expect(res.status).toBe(200);
    const view = res.body as CockpitView;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const project = view.products?.[0]?.projects?.[0] as any;
    expect(project).toBeDefined();
    expect(project.workRun).toBeDefined();
    expect(project.workRun.mutationId).toBe(ORCH_RUN_ID);
    expect(project.workRun.outcome).toBeNull();
    expect(project.workRun.transcriptUrl).toBe(`/api/work-runs/${ORCH_RUN_ID}/transcript`);
    expect(project.workRun.lastOutput).toEqual([
      'qa | openai | gpt-5.6-terra | writing tests from the spec',
      'coder | openai | gpt-5.6-sol | wiring cockpit projection',
    ]);
  });
});

// ---------------------------------------------------------------------------
// §5 item 3 — authenticated GET /api/work-runs/:id (run record)
// ---------------------------------------------------------------------------

describe('GET /api/work-runs/:id — run record (§5.3)', () => {
  it('rejects unauthenticated requests with 401', async () => {
    const res = await makeRequest(port, `/api/work-runs/${RUN_ID}`);
    expect(res.status).toBe(401);
  });

  it('returns 200 + the run summary JSON for a known id', async () => {
    const res = await makeRequest(port, `/api/work-runs/${RUN_ID}`, {
      headers: { Cookie: AUTH_COOKIE },
    });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    const rec = res.body as Record<string, unknown>;
    expect(rec.id).toBe(RUN_ID);
    expect(rec.outcome).toBe('partial');
  });

  it('returns 404 for an unknown run id', async () => {
    const res = await makeRequest(port, '/api/work-runs/does-not-exist-0000', {
      headers: { Cookie: AUTH_COOKIE },
    });
    expect(res.status).toBe(404);
  });

  it('rejects a path-traversal id with 400/403 (containment, never serves outside WORK_RUNS_DIR)', async () => {
    // The realistic traversal vector for a single-segment route (`([^/]+)`,
    // which never spans a literal `/`) is a percent-encoded id that DECODES to
    // contain `..`. The handler decodes (per the existing mutation/approval
    // routes) then must reject. 403 is the expected status — it mirrors
    // `handleStaticFile`'s 403-on-`..` convention; 400 is allowed in case the
    // impl rejects pre-decode. 404 is intentionally NOT accepted: today the
    // unimplemented route 404s, so this stays red until real containment lands.
    const evil = encodeURIComponent('../../../../etc/passwd');
    const res = await makeRequest(port, `/api/work-runs/${evil}`, {
      headers: { Cookie: AUTH_COOKIE },
    });
    expect([400, 403]).toContain(res.status);
    // Whatever the status, it must NOT have served the traversal target.
    expect(bodyText(res.body)).not.toMatch(/root:.*:0:0:/);
  });
});

// ---------------------------------------------------------------------------
// §5 item 3 — authenticated GET /api/work-runs/:id/transcript
// ---------------------------------------------------------------------------

describe('GET /api/work-runs/:id/transcript — transcript stream (§5.3)', () => {
  it('rejects unauthenticated requests with 401', async () => {
    const res = await makeRequest(port, `/api/work-runs/${RUN_ID}/transcript`);
    expect(res.status).toBe(401);
  });

  it('returns 200 + the transcript with a jsonl-family content-type', async () => {
    const res = await makeRequest(port, `/api/work-runs/${RUN_ID}/transcript`, {
      headers: { Cookie: AUTH_COOKIE },
    });
    expect(res.status).toBe(200);
    // "correct content-type" = a readable text/json-family type, not a binary
    // download blob (application/octet-stream).
    expect(res.headers['content-type']).toMatch(/json|ndjson|text\//);
    expect(res.headers['content-type']).not.toMatch(/octet-stream/);
    expect(bodyText(res.body)).toContain('Reading tasks.md');
  });

  it('rejects a path-traversal id with 400/403', async () => {
    const evil = encodeURIComponent('../../../../etc/passwd');
    const res = await makeRequest(port, `/api/work-runs/${evil}/transcript`, {
      headers: { Cookie: AUTH_COOKIE },
    });
    expect([400, 403]).toContain(res.status);
    expect(bodyText(res.body)).not.toMatch(/root:.*:0:0:/);
  });

  it('returns 404 (not 500) when the run exists but has no transcript yet (§5.4)', async () => {
    // Graceful degradation: the record route resolves (run exists) but the
    // transcript route is a clean 404 the card can handle, never a crash.
    // Coupling the two requests is deliberate — a bare transcript-404 would
    // pass vacuously today (the unimplemented route already 404s). Pinning the
    // record route to 200 first makes the test meaningfully red until Phase 5,
    // and the record-route 200 is the assertion that fails during the red phase
    // (the transcript-404 only becomes the discriminator once the routes exist).
    const rec = await makeRequest(port, `/api/work-runs/${RUN_NO_TRANSCRIPT}`, {
      headers: { Cookie: AUTH_COOKIE },
    });
    expect(rec.status).toBe(200);
    const res = await makeRequest(port, `/api/work-runs/${RUN_NO_TRANSCRIPT}/transcript`, {
      headers: { Cookie: AUTH_COOKIE },
    });
    expect(res.status).toBe(404);
  });
});
