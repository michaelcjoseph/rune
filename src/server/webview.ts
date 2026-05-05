import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { join, extname, resolve as resolvePath, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IncomingMessage, ServerResponse, Server } from 'node:http';
import { WebSocketServer } from 'ws';
import config from '../config.js';
import { verifyAuth, isAllowedHost, safeCompare } from './auth.js';
import { getStateSnapshot } from './state-snapshot.js';
import { getSession } from '../vault/sessions.js';
import { createLogger } from '../utils/logger.js';
import type { WebviewSender } from '../transport/webview-sender.js';
import { handleWebviewMessage } from './webview-bootstrap.js';

const log = createLogger('webview');

// __dirname for this ESM file → src/server/; static files live alongside it
const STATIC_DIR = join(dirname(fileURLToPath(import.meta.url)), 'static');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

function escapeHtmlAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

function reject401(res: ServerResponse): void {
  res.writeHead(401, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'unauthorized' }));
}

function reject403(res: ServerResponse): void {
  res.writeHead(403, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'forbidden' }));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    const MAX = 1 * 1024 * 1024; // 1 MB cap
    req.on('data', (c: Buffer) => {
      total += c.length;
      if (total > MAX) { reject(new Error('request body too large')); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** Load and template-substitute index.html once at mount time. */
async function loadIndexHtml(): Promise<string> {
  const raw = await readFile(join(STATIC_DIR, 'index.html'), 'utf8');
  const safeName = escapeHtmlAttr(config.OBSIDIAN_VAULT_NAME);
  return raw.replace('__OBSIDIAN_VAULT_NAME__', safeName);
}

async function handleStaticFile(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
  const relative = pathname.slice('/static/'.length);
  if (!relative || relative.includes('..') || relative.startsWith('/')) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  const filePath = resolvePath(STATIC_DIR, relative);
  if (!filePath.startsWith(STATIC_DIR + '/')) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  try {
    await stat(filePath);
  } catch {
    res.writeHead(404);
    res.end('Not found');
    return;
  }
  const mime = MIME[extname(filePath)] ?? 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': mime });
  const rs = createReadStream(filePath);
  try {
    await pipeline(rs, res);
  } catch {
    // Client dropped connection — pipeline already cleaned up the stream.
  }
}

async function handleAuthBootstrap(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!config.JARVIS_HTTP_SECRET) {
    reject401(res);
    return;
  }
  let body: { token?: string } = {};
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid JSON body' }));
    return;
  }
  if (!body.token || !safeCompare(body.token, config.JARVIS_HTTP_SECRET)) {
    reject401(res);
    return;
  }
  const isHttps =
    req.headers['x-forwarded-proto'] === 'https' &&
    (req.socket.remoteAddress === '127.0.0.1' || req.socket.remoteAddress === '::1');
  const cookieParts = [
    `jarvis-auth=${config.JARVIS_HTTP_SECRET}`,
    'HttpOnly',
    'SameSite=Strict',
    'Path=/',
  ];
  if (isHttps) cookieParts.push('Secure');
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Set-Cookie': cookieParts.join('; '),
  });
  res.end(JSON.stringify({ ok: true }));
}

function handleApiState(res: ServerResponse, isReady: () => boolean): void {
  if (!isReady()) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ready: false, reason: 'bot starting' }));
    return;
  }
  const snapshot = getStateSnapshot();
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(snapshot));
}

async function handleApiChat(req: IncomingMessage, res: ServerResponse, isReady: () => boolean): Promise<void> {
  if (!isReady()) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ready: false, reason: 'bot starting' }));
    return;
  }
  let body: { message?: string } = {};
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid JSON body' }));
    return;
  }
  const text = (body.message ?? '').trim();
  if (!text) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'message is required' }));
    return;
  }
  const userId = config.TELEGRAM_USER_ID;
  const chunks: string[] = [];
  // capturingSender collects the direct reply. Secondary bus-published messages
  // (e.g., background notifications that fire concurrently) reach open WS
  // connections via WebviewSender but do not appear in this REST response.
  const capturingSender = {
    name: 'webview' as const,
    send: async (_userId: number, text: string) => { chunks.push(text); },
    startTyping: () => {},
    stopTyping: () => {},
  };
  try {
    await handleWebviewMessage(capturingSender, userId, text);
  } catch (err) {
    log.error('POST /api/chat dispatch error', { error: (err as Error).message });
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'internal error' }));
    return;
  }
  const session = getSession(userId);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    text: chunks.join('\n\n'),
    sessionId: session?.sessionId ?? '',
    model: session?.model ?? '',
  }));
}

export interface WebviewDeps {
  webview: WebviewSender;
  isReady: () => boolean;
}

/**
 * Attach webview routes to an existing HTTP server.
 * Returns a request handler for webview-specific paths; caller should invoke it
 * after existing routes and before the 404 fallback.
 * Also registers a WebSocket upgrade listener and a server 'close' listener for cleanup.
 */
export function mountWebviewRoutes(
  server: Server,
  deps: WebviewDeps,
): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  const wss = new WebSocketServer({ noServer: true });

  // Cache index.html at mount time (vault name is constant at startup)
  let cachedIndexHtml: string | null = null;
  void loadIndexHtml().then(html => { cachedIndexHtml = html; }).catch(err => {
    log.warn('Could not pre-load index.html', { error: (err as Error).message });
  });

  // Per-userId inbound dispatch queue — serialises concurrent WS messages to
  // prevent concurrent handleConversation/createSession calls for the same user.
  const dispatchQueues = new Map<number, Promise<void>>();

  server.on('upgrade', (req, socket, head) => {
    const pathname = req.url?.split('?')[0] ?? '';
    if (pathname !== '/api/ws') {
      socket.destroy();
      return;
    }
    if (!isAllowedHost(req)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    if (!deps.isReady()) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
      socket.destroy();
      return;
    }
    const authResult = verifyAuth(req);
    if (!authResult.ok) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    // Auth already verified — pass userId via closure rather than re-parsing in 'connection'
    const { userId } = authResult;
    wss.handleUpgrade(req, socket, head, (ws) => {
      deps.webview.register(userId, ws);
      log.info('WS connected');

      ws.on('message', (data) => {
        try {
          const frame = JSON.parse(data.toString()) as { kind?: string; text?: string };
          if (frame.kind === 'message' && typeof frame.text === 'string') {
            const text = frame.text.trim();
            if (!text) return;
            // Chain dispatch promises to serialise inbound frames for the same user
            const prev = dispatchQueues.get(userId) ?? Promise.resolve();
            const next = prev
              .then(() => handleWebviewMessage(deps.webview, userId, text))
              .catch((err: unknown) => {
                log.error('WS message dispatch error', { error: (err as Error).message });
              });
            dispatchQueues.set(userId, next);
            void next.finally(() => {
              if (dispatchQueues.get(userId) === next) dispatchQueues.delete(userId);
            });
          }
        } catch {
          // malformed JSON — ignore
        }
      });

      ws.on('close', () => {
        deps.webview.unregister(userId, ws);
        log.info('WS disconnected');
      });

      ws.on('error', (err) => {
        log.error('WS error', { error: err.message });
        deps.webview.unregister(userId, ws);
      });
    });
  });

  // Close wss when the HTTP server closes so server.close() can drain fully
  server.on('close', () => { wss.close(); });

  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const url = req.url ?? '';
    const pathname = url.split('?')[0] ?? '';

    // Host guard runs before auth for all webview-owned routes
    if (pathname === '/' || pathname.startsWith('/static/') || pathname.startsWith('/api/')) {
      if (!isAllowedHost(req)) {
        reject403(res);
        return true;
      }
    }

    if (req.method === 'GET' && pathname === '/') {
      if (cachedIndexHtml !== null) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(cachedIndexHtml);
      } else {
        // Pre-load not yet complete — read synchronously as fallback
        try {
          const html = await loadIndexHtml();
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(html);
        } catch {
          res.writeHead(404);
          res.end('Not found');
        }
      }
      return true;
    }

    if (req.method === 'GET' && pathname.startsWith('/static/')) {
      await handleStaticFile(req, res, pathname);
      return true;
    }

    if (req.method === 'POST' && pathname === '/api/auth-bootstrap') {
      await handleAuthBootstrap(req, res);
      return true;
    }

    if (pathname.startsWith('/api/')) {
      const authResult = verifyAuth(req);
      if (!authResult.ok) {
        reject401(res);
        return true;
      }

      if (req.method === 'GET' && pathname === '/api/state') {
        handleApiState(res, deps.isReady);
        return true;
      }

      if (req.method === 'POST' && pathname === '/api/chat') {
        await handleApiChat(req, res, deps.isReady);
        return true;
      }

      // Unknown /api/* — return 404 rather than falling through to http.ts
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
      return true;
    }

    return false;
  };
}
