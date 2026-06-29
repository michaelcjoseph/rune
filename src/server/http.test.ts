import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';

const mockConfig = {
  HTTP_PORT: 0,
  HTTP_HOST: '127.0.0.1',
  TIMEZONE: 'America/Chicago',
  VAULT_DIR: '/test/vault',
  RUNE_HTTP_SECRET: 'test-secret',
  RUNE_ALLOWED_HOSTS: new Set(['localhost', '127.0.0.1']),
};

vi.mock('../config.js', () => ({
  default: mockConfig,
}));

vi.mock('../vault/sessions.js', () => ({
  getAllSessions: vi.fn(() => []),
  deleteSession: vi.fn(),
  transportLabel: (t: string) => (t === 'webview' ? 'webview chat' : 'telegram chat'),
}));
vi.mock('../ai/claude.js', () => ({ summarizeSession: vi.fn(), cleanupSession: vi.fn() }));
vi.mock('../vault/journal.js', () => ({ appendToJournal: vi.fn() }));
vi.mock('../utils/time.js', () => ({ getTimestamp: vi.fn(() => '14:30') }));
vi.mock('../vault/git.js', () => ({ gitCommitAndPush: vi.fn() }));

const { getAllSessions, deleteSession } = await import('../vault/sessions.js');
const { summarizeSession } = await import('../ai/claude.js');
const { appendToJournal } = await import('../vault/journal.js');
const { gitCommitAndPush } = await import('../vault/git.js');
const { startHttpServer } = await import('./http.js');

const getAllMock = getAllSessions as unknown as ReturnType<typeof vi.fn>;
const summaryMock = summarizeSession as unknown as ReturnType<typeof vi.fn>;

let server: Server;
let port: number;

function req(
  path: string,
  opts: { method?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: any }> {
  return reqOnPort(port, path, opts);
}

function reqOnPort(
  targetPort: number,
  path: string,
  opts: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const r = http.request(
      { host: '127.0.0.1', port: targetPort, path, method: opts.method || 'GET', headers: opts.headers },
      (res) => {
        let body = '';
        res.on('data', (c: Buffer) => (body += c));
        res.on('end', () => {
          try { resolve({ status: res.statusCode!, body: JSON.parse(body) }); }
          catch { resolve({ status: res.statusCode!, body }); }
        });
      },
    );
    r.on('error', reject);
    if (opts.body) r.write(opts.body);
    r.end();
  });
}

describe('server/http', () => {
  beforeAll(async () => {
    server = startHttpServer();
    await new Promise<void>((resolve) => server.on('listening', resolve));
    port = (server.address() as any).port;
  });

  afterAll(() => server.close());

  beforeEach(() => {
    vi.clearAllMocks();
    getAllMock.mockReturnValue([]);
    mockConfig.RUNE_HTTP_SECRET = 'test-secret';
  });

  it('GET /health returns status, uptime, session count', async () => {
    const res = await req('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(typeof res.body.uptime).toBe('number');
    expect(res.body.activeSessions).toBe(0);
  });

  it('POST /capture-sessions with no sessions returns 0', async () => {
    const res = await req('/capture-sessions', {
      method: 'POST',
      headers: { authorization: 'Bearer test-secret' },
    });
    expect(res.status).toBe(200);
    expect(res.body.captured).toBe(0);
  });

  it('POST /capture-sessions summarizes and logs each session', async () => {
    getAllMock.mockReturnValue([
      { userId: 123, transport: 'telegram', session: { sessionId: 'sess-1', lastActivity: '', messageCount: 3, firstMessage: 'hi' } },
    ]);
    summaryMock.mockResolvedValue({ text: 'Topic: test', error: null });

    const res = await req('/capture-sessions', {
      method: 'POST',
      headers: { authorization: 'Bearer test-secret' },
    });
    expect(res.body.captured).toBe(1);
    expect(appendToJournal).toHaveBeenCalled();
    expect(deleteSession).toHaveBeenCalledWith(123, 'telegram');
    expect(gitCommitAndPush).toHaveBeenCalled();
  });

  it('POST /capture-sessions returns 401 without auth', async () => {
    const noAuth = await req('/capture-sessions', { method: 'POST' });
    expect(noAuth.status).toBe(401);

    const wrongAuth = await req('/capture-sessions', {
      method: 'POST',
      headers: { authorization: 'Bearer wrong' },
    });
    expect(wrongAuth.status).toBe(401);

    const withAuth = await req('/capture-sessions', {
      method: 'POST',
      headers: { authorization: 'Bearer test-secret' },
    });
    expect(withAuth.status).toBe(200);
  });

  it('unknown route returns 404', async () => {
    const res = await req('/unknown');
    expect(res.status).toBe(404);
  });

  it('does not mount MCP transport or OAuth routes on the Rune web server', async () => {
    const verifyBearer = vi.fn(() => true);
    const handleOAuthRoute = vi.fn(async (req: IncomingMessage, res: ServerResponse) => {
      const path = req.url?.split('?')[0] ?? '';
      const isOAuthRoute = path.startsWith('/mcp/oauth/')
        || path === '/.well-known/oauth-authorization-server/mcp'
        || path === '/.well-known/oauth-protected-resource/mcp';
      if (!isOAuthRoute) return false;

      res.writeHead(418, { 'Content-Type': 'text/plain' });
      res.end('legacy web MCP OAuth route handled');
      return true;
    });
    const legacyMcpOpts = { verifyBearer, handleOAuthRoute };

    const webServer = (startHttpServer as (...args: any[]) => Server)(undefined, legacyMcpOpts);
    await new Promise<void>((resolve) => webServer.on('listening', resolve));
    const webPort = (webServer.address() as { port: number }).port;

    try {
      const mcp = await reqOnPort(webPort, '/mcp');
      expect(mcp.status).toBe(404);
      expect(verifyBearer).not.toHaveBeenCalled();

      const oauth = await reqOnPort(webPort, '/mcp/oauth/register', { method: 'POST' });
      expect(oauth.status).toBe(404);
      expect(handleOAuthRoute).not.toHaveBeenCalled();

      const metadata = await reqOnPort(webPort, '/.well-known/oauth-authorization-server/mcp');
      expect(metadata.status).toBe(404);
      expect(handleOAuthRoute).not.toHaveBeenCalled();

      const health = await reqOnPort(webPort, '/health');
      expect(health.status).toBe(200);
      expect(health.body.status).toBe('ok');
    } finally {
      await new Promise<void>((resolve) => webServer.close(() => resolve()));
    }
  });
});
