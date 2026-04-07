import { mkdirSync } from 'node:fs';
import config from './config.js';
import { restoreSessions, persistSessions } from './vault/sessions.js';
import { createBot } from './bot/telegram.js';
import { startHttpServer } from './server/http.js';
import { createLogger } from './utils/logger.js';

const log = createLogger('main');

// Ensure logs directory exists
mkdirSync(config.LOGS_DIR, { recursive: true });

// Restore sessions from previous run
restoreSessions();

// Start services
const bot = createBot();
const server = startHttpServer();

log.info('Jarvis started', {
  vault: config.VAULT_DIR,
  http: `${config.HTTP_HOST}:${config.HTTP_PORT}`,
});

// Graceful shutdown
function shutdown() {
  log.info('Shutting down...');
  persistSessions();
  bot.stopPolling();
  server.close();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

process.on('uncaughtException', (err) => {
  log.error('Uncaught exception', { error: err.message, stack: err.stack });
  persistSessions();
});

process.on('unhandledRejection', (err) => {
  log.error('Unhandled rejection', { error: String(err) });
});
