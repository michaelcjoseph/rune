import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import type { Server } from 'node:http';

vi.mock('../config.js', () => ({
  default: {
    HTTP_PORT: 0,
    HTTP_HOST: '127.0.0.1',
    TIMEZONE: 'America/Chicago',
    VAULT_DIR: '/test/vault',
  },
}));

vi.mock('../vault/sessions.js', () => ({
  getAllSessions: vi.fn(() => []),
  deleteSession: vi.fn(),
}));
vi.mock('../ai/claude.js', () => ({ summarizeSession: vi.fn() }));
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
  return new Promise((resolve, reject) => {
    const r = http.request(
      { host: '127.0.0.1', port, path, method: opts.method || 'GET', headers: opts.headers },
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
    delete process.env['JARVIS_HTTP_SECRET'];
  });

  it('GET /health returns status, uptime, session count', async () => {
    const res = await req('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(typeof res.body.uptime).toBe('number');
    expect(res.body.activeSessions).toBe(0);
  });

  it('POST /capture-sessions with no sessions returns 0', async () => {
    const res = await req('/capture-sessions', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(res.body.captured).toBe(0);
  });

  it('POST /capture-sessions summarizes and logs each session', async () => {
    getAllMock.mockReturnValue([
      [123, { sessionId: 'sess-1', lastActivity: '', messageCount: 3, firstMessage: 'hi' }],
    ]);
    summaryMock.mockResolvedValue({ text: 'Topic: test', error: null });

    const res = await req('/capture-sessions', { method: 'POST' });
    expect(res.body.captured).toBe(1);
    expect(appendToJournal).toHaveBeenCalled();
    expect(deleteSession).toHaveBeenCalledWith(123);
    expect(gitCommitAndPush).toHaveBeenCalled();
  });

  it('POST /capture-sessions enforces auth when secret is set', async () => {
    process.env['JARVIS_HTTP_SECRET'] = 'test-secret';

    const noAuth = await req('/capture-sessions', { method: 'POST' });
    expect(noAuth.status).toBe(401);

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
});
