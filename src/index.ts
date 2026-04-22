import { mkdirSync } from 'node:fs';
import config from './config.js';
import { initKB } from './kb/init.js';
import { restoreSessions, persistSessions, getAllSessions } from './vault/sessions.js';
import { markSessionCreated, killActiveProcesses, waitForActiveProcesses } from './ai/claude.js';
import { restoreReviewSessions, persistReviewSessions } from './reviews/session.js';
import { createBot } from './bot/telegram.js';
import { startHttpServer } from './server/http.js';
import { startScheduler, stopScheduler } from './jobs/scheduler.js';
import { startWatcher, stopWatcher } from './vault/watcher.js';
import { getSkillRegistry } from './bot/skill-registry.js';
import { createLogger, flushLogger } from './utils/logger.js';

const log = createLogger('main');

// Ensure logs directory exists
mkdirSync(config.LOGS_DIR, { recursive: true });

// Ensure knowledge base structure exists
initKB();

// Restore sessions from previous run
restoreSessions();
for (const [, session] of getAllSessions()) {
  markSessionCreated(session.sessionId);
}
restoreReviewSessions();

// Start services
const bot = createBot();
const server = startHttpServer();
startScheduler(bot);
startWatcher(bot);

// Warm the skill-registry cache. startScheduler() above calls
// reloadSkillRegistry(), which evicts the cache; without priming here the
// first non-slash TG message pays the fs scan inline.
getSkillRegistry();

log.info('Jarvis started', {
  vault: config.VAULT_DIR,
  http: `${config.HTTP_HOST}:${config.HTTP_PORT}`,
});

// Graceful shutdown
async function shutdown() {
  log.info('Shutting down...');
  stopWatcher();
  stopScheduler();
  killActiveProcesses();
  await waitForActiveProcesses();
  persistSessions();
  persistReviewSessions();
  bot.stopPolling();
  server.close();
  await flushLogger();
  process.exit(0);
}

process.on('SIGTERM', () => { void shutdown(); });
process.on('SIGINT', () => { void shutdown(); });

process.on('uncaughtException', (err) => {
  log.error('Uncaught exception', { error: err.message, stack: err.stack });
  persistSessions();
  persistReviewSessions();
  void flushLogger().finally(() => process.exit(1));
});

process.on('unhandledRejection', (err) => {
  log.error('Unhandled rejection', { error: String(err) });
});
