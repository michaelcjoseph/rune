import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import config from '../config.js';
import { getAllSessions, deleteSession } from '../vault/sessions.js';
import { summarizeSession } from '../ai/claude.js';
import { appendToJournal } from '../vault/journal.js';
import { getTimestamp } from '../utils/time.js';
import { gitCommitAndPush } from '../vault/git.js';
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
  const sessions = getAllSessions();
  let captured = 0;

  for (const [chatId, session] of sessions) {
    try {
      const result = await summarizeSession(session.sessionId);
      if (result.text) {
        const ts = getTimestamp();
        const summaryLines = result.text.split('\n').map((l) => `\t- ${l}`).join('\n');
        const entry = `- ${ts} [[jarvis]] telegram chat\n${summaryLines}`;
        appendToJournal(entry);
        captured++;
      }
    } catch (err) {
      log.error(`Failed to capture session ${chatId}`, { error: (err as Error).message });
    }
  }

  // Clear all sessions after capture
  for (const [chatId] of sessions) {
    deleteSession(chatId);
  }

  if (captured > 0) {
    gitCommitAndPush('TG sessions captured (nightly)');
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ captured }));
}

export function startHttpServer(): Server {
  const server = createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/health') {
        return await handleHealth(req, res);
      }
      if (req.method === 'POST' && req.url === '/capture-sessions') {
        return await handleCaptureSessions(req, res);
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
