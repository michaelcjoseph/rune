import { mkdirSync } from 'node:fs';
import config from './config.js';
import { initKB } from './kb/init.js';
import { restoreSessions, persistSessions, getAllSessions } from './vault/sessions.js';
import { markSessionCreated, killActiveProcesses, waitForActiveProcesses, setBus, rotateStreamLogIfLarge, assertProjectMcpConfig } from './ai/claude.js';
import { setMutationBus, registerApplier } from './transport/mutations.js';
import { setInFlightBus, stopInFlightTicker } from './transport/in-flight.js';
import { reconcileOrphans } from './jobs/mutations-log.js';
import { cleanupOrphanWorktrees } from './jobs/sandbox-runtime.js';
import { recoverSupervisedRuns } from './jobs/supervision-recovery.js';
import { workRunApplier } from './jobs/work-runner.js';
import { genEvalLoopApplier } from './jobs/gen-eval-loop-runner.js';
import { restoreReviewSessions, persistReviewSessions, getAllReviewSessions } from './reviews/session.js';
import { restorePlanningSessions, persistPlanningSessions, getAllPlanningSessions } from './reviews/planning.js';
import { createBot, wireHandlers } from './bot/telegram.js';
import { startHttpServer } from './server/http.js';
import { startScheduler, stopScheduler } from './jobs/scheduler.js';
import { startStallCheck, stopStallCheck } from './jobs/stall-check-runner.js';
import { startWatcher, stopWatcher } from './vault/watcher.js';
import { getSkillRegistry } from './bot/skill-registry.js';
import { loadModelPolicy } from './intent/model-policy.js';
import { createLogger, flushLogger } from './utils/logger.js';
import { NotificationBus } from './transport/notification-bus.js';
import { createSenders } from './transport/sender.js';

const log = createLogger('main');

// Ensure logs directory exists
mkdirSync(config.LOGS_DIR, { recursive: true });

// Fail fast if .claude/settings.json (declaring the jarvis-kb MCP server) is
// missing — every Claude CLI spawn passes --mcp-config to it. Without this
// check a missing file would surface as per-call CLI errors across chat,
// agents, and cron.
assertProjectMcpConfig();

// Fail fast on a malformed model selection policy — runAgent() resolves every agent's
// model through it, so a present-but-broken file crashes the boot here rather than
// surfacing per agent run. Also warms the policy cache. A missing file is tolerated
// (pre-policy fallback).
loadModelPolicy(config.MODEL_POLICY_FILE);

// Ensure knowledge base structure exists
initKB();

// Flip any stale 'running' mutations from a prior interrupted run to 'failed'
reconcileOrphans();

// Recover the supervision visibility surface — flip stale 'running' entries
// in `logs/supervised-runs.json` to 'unknown' since a run that was in-flight
// at the time of the prior shutdown can no longer be observed. Best-effort;
// a malformed or missing file is tolerated. The function logs its own
// success and failure; the catch here only guards against the write
// throwing so a disk-full condition can't crash startup.
try {
  recoverSupervisedRuns(config.SUPERVISED_RUNS_FILE);
} catch (err) {
  log.error('Supervision startup recovery threw', { error: (err as Error).message });
}

// Sweep orphan project worktrees from a prior interrupted run. Best-effort —
// a missing products.json (fresh clone, no Regime B products registered yet)
// or a missing worktree root returns []; a per-product failure is logged and
// skipped inside cleanupOrphanWorktrees. Wrap in try/catch so an unexpected
// fs error can't block startup either.
void cleanupOrphanWorktrees({
  worktreeRoot: config.WORKTREE_ROOT,
  productsConfigPath: config.PRODUCTS_CONFIG_FILE,
}).then((removed) => {
  if (removed.length > 0) {
    log.info('Cleaned up orphan worktrees', { count: removed.length, paths: removed });
  }
}).catch((err) => {
  log.warn('Orphan worktree cleanup failed', { error: (err as Error).message });
});

// Rotate the Claude stream log if it has grown past the size cap. Idempotent
// and best-effort — never blocks startup.
rotateStreamLogIfLarge();

// Restore sessions from previous run
restoreSessions();
for (const { session } of getAllSessions()) {
  markSessionCreated(session.sessionId);
}
restoreReviewSessions();
for (const [, session] of getAllReviewSessions()) {
  markSessionCreated(session.claudeSessionId);
}
// Wrap restorePlanningSessions in try/catch matching the recoverSupervisedRuns
// precedent — a non-ENOENT disk error must not crash boot. Internal try/catch
// already handles missing/malformed file paths.
try {
  restorePlanningSessions();
} catch (err) {
  log.error('Planning-session startup restore threw', { error: (err as Error).message });
}
for (const [, session] of getAllPlanningSessions()) {
  markSessionCreated(session.claudeSessionId);
}

// Start services
const bot = createBot();
const bus = new NotificationBus();
setBus(bus);
setMutationBus(bus);
setInFlightBus(bus);
registerApplier(workRunApplier);
registerApplier(genEvalLoopApplier);
const { tg, webview, destroy } = createSenders(bot, bus);
wireHandlers(bot, tg);
let ready = false;
const server = startHttpServer({ webview, isReady: () => ready });
startScheduler({ bus });
startStallCheck(bus);
startWatcher(bus);

// Warm the skill-registry cache. startScheduler() above calls
// reloadSkillRegistry(), which evicts the cache; without priming here the
// first non-slash TG message pays the fs scan inline.
getSkillRegistry();

ready = true;

log.info('Jarvis started', {
  vault: config.VAULT_DIR,
  http: `${config.HTTP_HOST}:${config.HTTP_PORT}`,
});

// Graceful shutdown
async function shutdown() {
  log.info('Shutting down...');
  stopScheduler();
  stopStallCheck();
  stopWatcher();
  destroy();
  stopInFlightTicker();
  killActiveProcesses();
  await waitForActiveProcesses();
  persistSessions();
  persistReviewSessions();
  persistPlanningSessions();
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
  persistPlanningSessions();
  void flushLogger().finally(() => process.exit(1));
});

process.on('unhandledRejection', (err) => {
  log.error('Unhandled rejection', { error: String(err) });
});
