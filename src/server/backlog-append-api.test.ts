import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import type { Server, IncomingMessage, ServerResponse } from 'node:http';

/*
 * Test-suite-as-deliverable for the backlog add endpoint + write mechanics (09-expand-cockpit,
 * Phase 3, written test-first).
 *
 * Covers `POST /api/backlog/:product/:kind` (happy path returns the fully-parsed new item; each
 * typed error), plus the two write guarantees the endpoint relies on from `backlog-write-lock.ts`:
 *   - temp-then-rename atomicity (write a `.tmp` sibling, then rename over the target);
 *   - a per-file mutex that serializes concurrent appends to the same file.
 *
 * Strategy: everything real (the endpoint, `backlog-write-lock`, the pure `backlog-append` +
 * parser) except `node:fs` write/read, which is overridden so no real file is touched and the
 * temp-then-rename call sequence is observable. The fs mock is sound on the assumption that the
 * endpoint returns the freshly-appended item by re-parsing the NEW content in memory — NOT by
 * round-tripping back through `readBacklogs` (whose `realpathSync`/`openSync` would hit the
 * non-existent `/test` path and yield an empty list).
 *
 * Stays RED until the Phase 3 build lands `backlog-write-lock.ts` and the POST route.
 */

// --- fs override: keep everything real except the backlog read/write syscalls ---
const fsState = vi.hoisted(() => ({
  // current content the backlog file "contains" when read
  content: '' as string,
  // recorded write/rename calls for temp-then-rename assertions
  writes: [] as Array<{ path: string; data: string }>,
  renames: [] as Array<{ from: string; to: string }>,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const isBacklog = (p: unknown) => /docs\/projects\/(bugs|ideas)\.md(\.tmp)?$/.test(String(p));
  return {
    ...actual,
    readFileSync: vi.fn((p: any, ...rest: any[]) => {
      if (isBacklog(p) && !String(p).endsWith('.tmp')) return fsState.content;
      return (actual.readFileSync as any)(p, ...rest);
    }),
    writeFileSync: vi.fn((p: any, data: any) => {
      if (isBacklog(p)) { fsState.writes.push({ path: String(p), data: String(data) }); return; }
      return (actual.writeFileSync as any)(p, data);
    }),
    renameSync: vi.fn((from: any, to: any) => {
      if (isBacklog(from) || isBacklog(to)) {
        fsState.renames.push({ from: String(from), to: String(to) });
        // Model the atomic swap by the SOURCE path so it stays correct regardless of write
        // ordering (rather than blindly taking the last write).
        const swapped = [...fsState.writes].reverse().find((w) => w.path === String(from));
        if (swapped) fsState.content = swapped.data;
        return;
      }
      return (actual.renameSync as any)(from, to);
    }),
    // No real dirs are needed in this test — no-op all mkdir.
    mkdirSync: vi.fn(() => undefined),
    // The audit-log write goes through appendFileSync; no-op it so no real file is touched.
    appendFileSync: vi.fn(() => undefined),
    // The write guard realpaths the repo + closest-existing ancestor. The /test repo isn't on
    // disk, so resolve those to identity and treat /test paths as existing.
    realpathSync: vi.fn((p: any) => {
      const s = String(p);
      return s.startsWith('/test/') ? s : (actual.realpathSync as any)(p);
    }),
    existsSync: vi.fn((p: any) => {
      const s = String(p);
      return s.startsWith('/test/') ? true : (actual.existsSync as any)(p);
    }),
  };
});

// --- webview harness mocks (mirror backlog-drawer.test.ts) ---
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
  WORK_RUNS_INDEX_FILE: '/test/logs/work-runs/index.jsonl',
  BACKLOG_MUTATIONS_FILE: '/test/logs/backlog-mutations.jsonl',
};
vi.mock('../config.js', () => ({ default: mockConfig, PROJECT_ROOT: '/test/project' }));
vi.mock('../jobs/sandbox-runtime.js', () => ({
  readProductsConfig: vi.fn(() => ({
    aura: { repoPath: '/test/workspace/aura', baseBranch: 'main', credentialsFile: '', egressAllowlist: [] },
  })),
  createWorktree: vi.fn(),
  destroyWorktree: vi.fn(),
  getProductConfig: vi.fn(() => ({ product: 'aura', repoPath: '/test/workspace/aura', baseBranch: 'main', egressAllowlist: [] })),
  // The audit-log git probe; empty stdout → branch 'unknown', dirty false.
  defaultRunGit: vi.fn(async () => ({ stdout: '', stderr: '' })),
}));
vi.mock('./restart.js', () => ({ restartServer: vi.fn(() => ({ ok: true as const })) }));
vi.mock('../ai/claude.js', () => ({ runAgent: vi.fn(async () => ({ text: 'ok', error: null })) }));
vi.mock('../reviews/planning.js', () => ({
  createPlanningSession: vi.fn(), getActivePlanningSession: vi.fn(() => null),
  getAllPlanningSessions: vi.fn(() => []), deletePlanningSession: vi.fn(),
  approveActivePlanningSession: vi.fn(), abandonActivePlanningSession: vi.fn(),
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

const { mountWebviewRoutes } = await import('./webview.js');
const { withFileLock } = await import('../intent/backlog-write-lock.js');

function request(
  port: number,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const r = http.request(
      {
        host: '127.0.0.1', port, path, method,
        headers: { host: 'localhost', 'content-type': 'application/json', ...headers },
      },
      (res) => {
        let buf = '';
        res.on('data', (c: Buffer) => (buf += c.toString()));
        res.on('end', () => {
          const parsed = (() => { try { return JSON.parse(buf); } catch { return buf; } })();
          resolve({ status: res.statusCode!, body: parsed });
        });
      },
    );
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

const mockSender = {
  name: 'webview' as const, register: vi.fn(), unregister: vi.fn(),
  send: vi.fn(async () => undefined), startTyping: vi.fn(), stopTyping: vi.fn(), shutdown: vi.fn(),
};
const AUTH = { authorization: 'Bearer test-secret' };

let server: Server;
let handler: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;
let port: number;

describe('POST /api/backlog/:product/:kind (09-expand-cockpit Phase 3)', () => {
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
    fsState.content = '- [ ] Existing bug\n';
    fsState.writes.length = 0;
    fsState.renames.length = 0;
  });

  it('requires auth', async () => {
    expect((await request(port, 'POST', '/api/backlog/aura/bugs', { text: 'x' })).status).toBe(401);
  });

  it('appends a bug and returns the fully-parsed new item with computed actions', async () => {
    const res = await request(port, 'POST', '/api/backlog/aura/bugs', { text: 'A new bug' }, AUTH);
    expect(res.status).toBe(200);
    expect(res.body.item.text).toBe('A new bug');
    expect(res.body.item.kind).toBe('bugs');
    expect(res.body.item.status).toBe('open');
    expect(res.body.item.id).toMatch(/^[0-9a-f]{12}$/);
    // server-computed action present
    expect((res.body.item.actions ?? []).some((a: any) => a.kind === 'plan')).toBe(true);
  });

  it('writes via temp-then-rename: a .tmp sibling is written, then renamed over the target', async () => {
    await request(port, 'POST', '/api/backlog/aura/bugs', { text: 'A new bug' }, AUTH);
    expect(fsState.writes).toHaveLength(1);
    expect(fsState.writes[0]!.path).toMatch(/bugs\.md\.tmp$/);
    expect(fsState.writes[0]!.data).toContain('- [ ] A new bug');
    expect(fsState.renames).toHaveLength(1);
    expect(fsState.renames[0]!.from).toMatch(/bugs\.md\.tmp$/);
    expect(fsState.renames[0]!.to).toMatch(/bugs\.md$/);
  });

  it('appends an idea (non-checkbox bullet)', async () => {
    fsState.content = '## User-authored\n- Idea A\n';
    const res = await request(port, 'POST', '/api/backlog/aura/ideas', { text: 'A new idea' }, AUTH);
    expect(res.status).toBe(200);
    expect(res.body.item.kind).toBe('ideas');
    expect(res.body.item.text).toBe('A new idea');
    expect(fsState.writes[0]!.data).toContain('- A new idea');
    expect(fsState.writes[0]!.data).not.toContain('- [ ] A new idea');
  });

  it('returns the NEW idea (not a loop-filed item) when a Loop-filed section exists', async () => {
    // Regression: appendIdea inserts ABOVE the sentinel, so the new idea is not the last parsed
    // item. The endpoint must return the inserted user-authored idea, not the trailing filed one.
    fsState.content = '## User-authored\n- Idea A\n\n## Loop-filed\n- **Filed** — friction\n';
    const res = await request(port, 'POST', '/api/backlog/aura/ideas', { text: 'A new idea' }, AUTH);
    expect(res.status).toBe(200);
    expect(res.body.item.text).toBe('A new idea');
    expect(res.body.item.section).toBe('user-authored');
  });

  it('rejects empty text with 400 empty-text', async () => {
    const res = await request(port, 'POST', '/api/backlog/aura/bugs', { text: '   ' }, AUTH);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({ code: 'empty-text' });
    expect(fsState.writes).toHaveLength(0);
  });

  it('rejects multiline text with 400 multiline-text', async () => {
    const res = await request(port, 'POST', '/api/backlog/aura/bugs', { text: 'a\nb' }, AUTH);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({ code: 'multiline-text' });
    expect(fsState.writes).toHaveLength(0);
  });

  it('rejects an unknown product with 404 unknown-product', async () => {
    const res = await request(port, 'POST', '/api/backlog/nope/bugs', { text: 'x' }, AUTH);
    expect(res.status).toBe(404);
    expect(res.body.error).toMatchObject({ code: 'unknown-product' });
  });

  it('rejects an unknown kind with 404 unknown-kind', async () => {
    const res = await request(port, 'POST', '/api/backlog/aura/widgets', { text: 'x' }, AUTH);
    expect(res.status).toBe(404);
    expect(res.body.error).toMatchObject({ code: 'unknown-kind' });
  });
});

describe('backlog-write-lock — per-file mutex', () => {
  it('serializes overlapping operations on the same key (no interleaving)', async () => {
    let active = 0;
    let maxConcurrent = 0;
    const op = () =>
      withFileLock('same-key', async () => {
        active++;
        maxConcurrent = Math.max(maxConcurrent, active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
      });
    await Promise.all([op(), op(), op()]);
    expect(maxConcurrent).toBe(1); // never two critical sections at once for the same key
  });

  it('allows different keys to proceed without blocking each other', async () => {
    // Structural proof of non-blocking: while key-a holds its lock (10ms), key-b enters its own
    // critical section and OBSERVES key-a still running. If different keys shared a lock, key-b
    // would only run after key-a released, and would see aRunning === false.
    let aRunning = false;
    let bSawARunning = false;
    await Promise.all([
      withFileLock('key-a', async () => {
        aRunning = true;
        await new Promise((r) => setTimeout(r, 10));
        aRunning = false;
      }),
      withFileLock('key-b', async () => {
        await new Promise((r) => setTimeout(r, 2));
        bSawARunning = aRunning;
      }),
    ]);
    expect(bSawARunning).toBe(true);
  });
});
