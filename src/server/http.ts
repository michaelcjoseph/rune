import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import config from '../config.js';
import { getAllSessions } from '../vault/sessions.js';
import { captureSessions } from '../jobs/capture.js';
import { isConfigured, exchangeCode, verifyOAuthState } from '../integrations/whoop/client.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('http');

async function handleHealth(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(
    JSON.stringify({
      status: 'ok',
      uptime: process.uptime(),
      activeSessions: getAllSessions().length,
    }),
  );
}

async function handleCaptureSessions(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const secret = process.env['JARVIS_HTTP_SECRET'];
  if (secret) {
    const auth = req.headers['authorization'];
    if (auth !== `Bearer ${secret}`) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
  }

  const result = await captureSessions('http');
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(result));
}

const WHOOP_REDIRECT_URI = `http://localhost:${config.HTTP_PORT}/oauth/whoop`;

async function handleWhoopOAuth(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!isConfigured()) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Whoop not configured. Set WHOOP_CLIENT_ID and WHOOP_CLIENT_SECRET.');
    return;
  }

  const url = new URL(req.url || '', `http://${req.headers.host}`);
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');

  if (error) {
    log.error('Whoop OAuth error', { error });
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end(`OAuth error: ${error}`);
    return;
  }

  const state = url.searchParams.get('state');
  if (!state || !verifyOAuthState(state)) {
    log.error('Whoop OAuth state mismatch');
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('OAuth state mismatch. Please try /whoop again.');
    return;
  }

  if (!code) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Missing authorization code.');
    return;
  }

  const success = await exchangeCode(code, WHOOP_REDIRECT_URI);

  if (success) {
    log.info('Whoop OAuth completed successfully');
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<h1>Whoop connected!</h1><p>Tokens stored in Keychain. You can close this window.</p>');
  } else {
    res.writeHead(500, { 'Content-Type': 'text/html' });
    res.end('<h1>Whoop connection failed</h1><p>Check Jarvis logs for details.</p>');
  }
}

export { WHOOP_REDIRECT_URI };

export function startHttpServer(): Server {
  const server = createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/health') {
        return await handleHealth(req, res);
      }
      if (req.method === 'POST' && req.url === '/capture-sessions') {
        return await handleCaptureSessions(req, res);
      }
      if (req.method === 'GET' && req.url?.startsWith('/oauth/whoop')) {
        return await handleWhoopOAuth(req, res);
      }
      res.writeHead(404);
      res.end('Not found');
    } catch (err) {
      log.error('HTTP handler error', { error: (err as Error).message });
      res.writeHead(500);
      res.end('Internal error');
    }
  });

  server.listen(config.HTTP_PORT, config.HTTP_HOST, () => {
    log.info(`HTTP server listening on ${config.HTTP_HOST}:${config.HTTP_PORT}`);
  });

  return server;
}
