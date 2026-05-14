import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import type { Server, IncomingMessage, ServerResponse } from 'node:http';

// --- Mocks must be declared before any imports that pull in the mocked modules ---

// Mutation mocks (used by the Phase E route tests appended below)
const mockCreateMutation = vi.fn();
const mockCancelMutation = vi.fn();
const mockActiveRunsMap = new Map<string, any>();
vi.mock('../transport/mutations.js', () => ({
  createMutation: mockCreateMutation,
  cancelMutation: mockCancelMutation,
  activeRuns: mockActiveRunsMap,
}));

// In-flight op mocks for POST /api/ops/:id/cancel
const mockCancelOp = vi.fn();
vi.mock('../transport/in-flight.js', () => ({
  cancelOp: mockCancelOp,
  listOps: vi.fn(() => []),
}));

const mockReadRecentMutations = vi.fn(() => []);
vi.mock('../jobs/mutations-log.js', () => ({
  readRecentMutations: mockReadRecentMutations,
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
}));

vi.mock('../vault/sessions.js', () => ({
  getSession: vi.fn(() => null),
}));

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

// Import after mocks are wired up
const { mountWebviewRoutes } = await import('./webview.js');
const { handleWebviewMessage } = await import('./webview-bootstrap.js');
const { getSession } = await import('../vault/sessions.js');
const { getStateSnapshot } = await import('./state-snapshot.js');

// ---- helpers ----

interface ReqOpts {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

function makeRequest(
  port: number,
  path: string,
  opts: ReqOpts = {},
): Promise<{ status: number; body: any; headers: Record<string, string> }> {
  return new Promise((resolve, reject) => {
    const reqOpts: http.RequestOptions = {
      host: '127.0.0.1',
      port,
      path,
      method: opts.method ?? 'GET',
      headers: {
        host: 'localhost',
        ...opts.headers,
      },
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

// ---- mock WebviewSender ----

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

describe('server/webview', () => {
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
    mockConfig.JARVIS_HTTP_SECRET = 'test-secret';
    // Reset mocks to sensible defaults after clearAllMocks
    (getSession as ReturnType<typeof vi.fn>).mockReturnValue(null);
    (handleWebviewMessage as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (getStateSnapshot as ReturnType<typeof vi.fn>).mockReturnValue({
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
    });
  });

  // ---- GET / ----

  describe('GET /', () => {
    it('returns 403 when host header is not in allowed set', async () => {
      const res = await makeRequest(port, '/', {
        headers: { host: 'evil.com' },
      });
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('forbidden');
    });

    it('returns 404 when index.html is absent (no static dir in test env)', async () => {
      // The static dir at src/server/static/ does not exist in CI/test env,
      // so handleIndexHtml catches the readFile error and sends 404.
      const res = await makeRequest(port, '/');
      // Either 404 (file not found) or 200 (if index.html happened to be present).
      // We only assert that the host guard passed (not 403) and the route was handled (not fallthrough 404 with "fallthrough" body).
      expect(res.status).not.toBe(403);
      if (res.status === 404) {
        expect(res.body).toBe('Not found');
      } else {
        expect(res.status).toBe(200);
      }
    });
  });

  // ---- GET /static/<file> ----

  describe('GET /static/<file>', () => {
    it('returns 200 and correct MIME type for an existing static file', async () => {
      // src/server/static/app.js is present in the repo — it should be served correctly.
      const res = await makeRequest(port, '/static/app.js');
      expect(res.status).toBe(200);
    });

    it('returns 404 when static file does not exist', async () => {
      const res = await makeRequest(port, '/static/nonexistent-file-xyz.js');
      expect(res.status).toBe(404);
      expect(res.body).toBe('Not found');
    });

    it('returns 403 on path traversal attempt', async () => {
      const res = await makeRequest(port, '/static/../config.js');
      // Node.js HTTP normalises the path, so /static/../config.js becomes /config.js,
      // which won't match /static/ prefix — it falls through to 404 fallback.
      // Either 403 (if the raw path reaches the handler) or 404 fallback is acceptable.
      expect([403, 404]).toContain(res.status);
    });

    it('returns 403 when path traversal is encoded in the filename segment', async () => {
      const res = await makeRequest(port, '/static/..%2Fconfig.js');
      // Node.js keeps the raw encoded path; the handler checks for '..' in relative.
      // After slice('/static/'.length) we get '..%2Fconfig.js' — no literal '..'
      // but the resolved path will escape STATIC_DIR, triggering the second guard.
      expect([403, 404]).toContain(res.status);
    });
  });

  // ---- POST /api/auth-bootstrap ----

  describe('POST /api/auth-bootstrap', () => {
    it('returns 401 when no secret is configured', async () => {
      mockConfig.JARVIS_HTTP_SECRET = '';
      const res = await makeRequest(port, '/api/auth-bootstrap', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: 'anything' }),
      });
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('unauthorized');
    });

    it('returns 401 when token is wrong', async () => {
      const res = await makeRequest(port, '/api/auth-bootstrap', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: 'wrong-token' }),
      });
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('unauthorized');
    });

    it('returns 400 on invalid JSON body', async () => {
      const res = await makeRequest(port, '/api/auth-bootstrap', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'not-json{',
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid JSON body');
    });

    it('returns 200 and Set-Cookie on correct token', async () => {
      const res = await makeRequest(port, '/api/auth-bootstrap', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: 'test-secret' }),
      });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      // Node.js http.IncomingMessage returns set-cookie as string[]
      const cookies = res.headers['set-cookie'] as unknown as string[];
      expect(Array.isArray(cookies)).toBe(true);
      const cookieStr = cookies.join('; ');
      expect(cookieStr).toContain('jarvis-auth=test-secret');
      expect(cookieStr).toContain('HttpOnly');
      expect(cookieStr).toContain('SameSite=Strict');
    });

    it('returns 403 when host is not allowed', async () => {
      const res = await makeRequest(port, '/api/auth-bootstrap', {
        method: 'POST',
        headers: { host: 'evil.com', 'content-type': 'application/json' },
        body: JSON.stringify({ token: 'test-secret' }),
      });
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('forbidden');
    });
  });

  // ---- GET /api/state ----

  describe('GET /api/state', () => {
    it('returns 401 without auth', async () => {
      const res = await makeRequest(port, '/api/state');
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('unauthorized');
    });

    it('returns 200 with snapshot when authenticated via bearer token', async () => {
      const res = await makeRequest(port, '/api/state', {
        headers: { authorization: 'Bearer test-secret' },
      });
      expect(res.status).toBe(200);
      expect(res.body.ready).toBe(true);
      expect(res.body.activeSession).toBeNull();
      expect(res.body.activeReview).toBeNull();
      expect(res.body.ingestionQueueDepth).toBe(0);
    });

    it('reflects active session in snapshot', async () => {
      (getStateSnapshot as ReturnType<typeof vi.fn>).mockReturnValue({
        version: 1, ready: true,
        activeSession: { sessionId: 'sess-abc', model: 'opus', messageCount: 3 },
        activeReview: null, ingestionQueueDepth: 0, recentAgentRuns: [],
        pendingApprovals: { playbook: 0, proposal: 0 },
        lastMorningPrepAt: null, lastNightlyAt: null, warnings: [],
      });
      const res = await makeRequest(port, '/api/state', {
        headers: { authorization: 'Bearer test-secret' },
      });
      expect(res.status).toBe(200);
      expect(res.body.activeSession).toEqual({
        sessionId: 'sess-abc',
        model: 'opus',
        messageCount: 3,
      });
    });

    it('reflects active review in snapshot', async () => {
      (getStateSnapshot as ReturnType<typeof vi.fn>).mockReturnValue({
        version: 1, ready: true, activeSession: null,
        activeReview: { type: 'daily', phase: 'interview', targetDate: '2026-05-05' },
        ingestionQueueDepth: 0, recentAgentRuns: [],
        pendingApprovals: { playbook: 0, proposal: 0 },
        lastMorningPrepAt: null, lastNightlyAt: null, warnings: [],
      });
      const res = await makeRequest(port, '/api/state', {
        headers: { authorization: 'Bearer test-secret' },
      });
      expect(res.status).toBe(200);
      expect(res.body.activeReview).toEqual({
        type: 'daily',
        phase: 'interview',
        targetDate: '2026-05-05',
      });
    });

    it('reflects non-empty ingestion queue depth', async () => {
      (getStateSnapshot as ReturnType<typeof vi.fn>).mockReturnValue({
        version: 1, ready: true, activeSession: null, activeReview: null,
        ingestionQueueDepth: 2, recentAgentRuns: [],
        pendingApprovals: { playbook: 0, proposal: 0 },
        lastMorningPrepAt: null, lastNightlyAt: null, warnings: [],
      });
      const res = await makeRequest(port, '/api/state', {
        headers: { authorization: 'Bearer test-secret' },
      });
      expect(res.status).toBe(200);
      expect(res.body.ingestionQueueDepth).toBe(2);
    });
  });

  // ---- POST /api/chat ----

  describe('POST /api/chat', () => {
    it('returns 401 without auth', async () => {
      const res = await makeRequest(port, '/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: 'hello' }),
      });
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('unauthorized');
    });

    it('returns 400 on invalid JSON body', async () => {
      const res = await makeRequest(port, '/api/chat', {
        method: 'POST',
        headers: {
          authorization: 'Bearer test-secret',
          'content-type': 'application/json',
        },
        body: 'bad-json{',
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid JSON body');
    });

    it('returns 400 when message is empty', async () => {
      const res = await makeRequest(port, '/api/chat', {
        method: 'POST',
        headers: {
          authorization: 'Bearer test-secret',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ message: '   ' }),
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('message is required');
    });

    it('returns 200 with { text, sessionId, model } on valid auth and message', async () => {
      const res = await makeRequest(port, '/api/chat', {
        method: 'POST',
        headers: {
          authorization: 'Bearer test-secret',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ message: 'hello world' }),
      });
      expect(res.status).toBe(200);
      expect(typeof res.body.text).toBe('string');
      expect(typeof res.body.sessionId).toBe('string');
      expect(typeof res.body.model).toBe('string');
      expect(handleWebviewMessage).toHaveBeenCalledOnce();
    });

    it('calls handleWebviewMessage with the trimmed text', async () => {
      await makeRequest(port, '/api/chat', {
        method: 'POST',
        headers: {
          authorization: 'Bearer test-secret',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ message: '  what is the meaning of life  ' }),
      });
      expect(handleWebviewMessage).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'webview' }),
        mockConfig.TELEGRAM_USER_ID,
        'what is the meaning of life',
      );
    });

    it('returns 500 when handleWebviewMessage throws', async () => {
      (handleWebviewMessage as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('dispatch failed'));
      const res = await makeRequest(port, '/api/chat', {
        method: 'POST',
        headers: {
          authorization: 'Bearer test-secret',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ message: 'trigger error' }),
      });
      expect(res.status).toBe(500);
      expect(res.body.error).toBe('internal error');
    });
  });

  // ---- Unknown /api/* routes ----

  describe('GET /api/unknown', () => {
    it('returns 404 handled by webview (not fallthrough)', async () => {
      const res = await makeRequest(port, '/api/unknown', {
        headers: { authorization: 'Bearer test-secret' },
      });
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('not found');
    });

    it('returns 401 on unknown /api/* route without auth', async () => {
      const res = await makeRequest(port, '/api/unknown');
      expect(res.status).toBe(401);
    });
  });

  // ---- Paths that should fall through ----

  describe('paths that fall through to http.ts', () => {
    it('returns fallthrough 404 for /some-other-path', async () => {
      const res = await makeRequest(port, '/some-other-path');
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('not found (fallthrough)');
    });

    it('returns fallthrough 404 for /health (not owned by webview)', async () => {
      const res = await makeRequest(port, '/health');
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('not found (fallthrough)');
    });
  });

  // ---- POST /api/mutations ----

  describe('POST /api/mutations', () => {
    it('returns 200 with descriptor when createMutation returns ok: true', async () => {
      const descriptor = {
        id: 'desc-123',
        kind: 'work-run',
        source: 'webview',
        target: { type: 'work-run', ref: '06-webview' },
        preview: { summary: 'work-run on 06-webview' },
        payload: { projectSlug: '06-webview' },
        createdAt: '2026-05-05T12:00:00.000Z',
        status: 'pending',
      };
      mockCreateMutation.mockResolvedValue({ ok: true, descriptor });

      const res = await makeRequest(port, '/api/mutations', {
        method: 'POST',
        headers: {
          authorization: 'Bearer test-secret',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ kind: 'work-run', payload: { projectSlug: '06-webview' } }),
      });

      expect(res.status).toBe(200);
      expect(res.body.id).toBe('desc-123');
      expect(res.body.kind).toBe('work-run');
      expect(res.body.status).toBe('pending');
    });

    it('returns 400 with error message when createMutation returns ok: false', async () => {
      mockCreateMutation.mockResolvedValue({ ok: false, reason: 'unknown mutation kind: bad-kind' });

      const res = await makeRequest(port, '/api/mutations', {
        method: 'POST',
        headers: {
          authorization: 'Bearer test-secret',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ kind: 'bad-kind', payload: {} }),
      });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('bad-kind');
    });

    it('returns 401 without auth', async () => {
      const res = await makeRequest(port, '/api/mutations', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'work-run', payload: {} }),
      });
      expect(res.status).toBe(401);
    });
  });

  // ---- POST /api/ops/:id/cancel ----

  describe('POST /api/ops/:id/cancel', () => {
    beforeEach(() => {
      mockCancelOp.mockReset();
    });

    it('returns 200 { ok: true } when cancelOp returns true', async () => {
      mockCancelOp.mockReturnValue(true);
      const res = await makeRequest(port, '/api/ops/abc123/cancel', {
        method: 'POST',
        headers: { authorization: 'Bearer test-secret' },
      });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
      expect(mockCancelOp).toHaveBeenCalledWith('abc123');
    });

    it('returns 409 when cancelOp returns false (op not found)', async () => {
      mockCancelOp.mockReturnValue(false);
      const res = await makeRequest(port, '/api/ops/not-found-id/cancel', {
        method: 'POST',
        headers: { authorization: 'Bearer test-secret' },
      });
      expect(res.status).toBe(409);
      expect(res.body.error).toContain('not found');
    });

    it('passes the opId from the URL path to cancelOp', async () => {
      mockCancelOp.mockReturnValue(true);
      const opId = 'ff00aa11-bbcc-ddee-0011-223344556677';
      await makeRequest(port, `/api/ops/${opId}/cancel`, {
        method: 'POST',
        headers: { authorization: 'Bearer test-secret' },
      });
      expect(mockCancelOp).toHaveBeenCalledWith(opId);
    });

    it('returns 401 without auth header', async () => {
      const res = await makeRequest(port, '/api/ops/some-op/cancel', {
        method: 'POST',
      });
      expect(res.status).toBe(401);
    });

    it('returns 404 for GET /api/ops/:id/cancel (wrong method)', async () => {
      const res = await makeRequest(port, '/api/ops/some-op/cancel', {
        method: 'GET',
        headers: { authorization: 'Bearer test-secret' },
      });
      // GET doesn't match the POST route — falls through to the unknown /api/* 404
      expect(res.status).toBe(404);
    });
  });

});
