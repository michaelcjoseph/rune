import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import config from '../config.js';
import { initKB } from '../kb/engine.js';
import { searchVault } from '../kb/search.js';
import {
  buildVaultIndex,
  getVaultIndexStatus,
  queryVaultIndex,
  refreshVaultIndex,
  type VaultIndexStatus,
} from '../kb/vault-index.js';
import { APP_SURFACE_TOOLS, CONTENT_TOOLS, HEALTH_TOOLS, createRuneMcpServer } from './server.js';
import { getMcpMetricsSnapshot } from './metrics.js';
import { getBootId, startMcpMetricsFlush } from './metrics-history.js';
import { createMcpOAuth } from '../server/mcp-oauth.js';
import { readOAuthStore, writeOAuthStore } from '../server/mcp-oauth-store.js';
import { mountMcpRoute, type McpRouteHandler, type McpSessionStat } from '../server/mcp-transport.js';
import { createLogger, flushLogger } from '../utils/logger.js';

const log = createLogger('mcp-daemon');

export interface StartMcpDaemonOptions {
  host: string;
  port: number;
  gateSecret: string;
  userId: string;
  issuerBaseUrl?: string;
  oauthStoreFile: string;
  tokenTtlMs?: number | null;
}

export interface McpDaemonStatus {
  service: 'rune-mcp';
  status: 'ok' | 'starting' | 'degraded';
  uptime: number;
  startedAt: string;
  bootId: string;
  oauth: { configured: boolean };
  activeSessions: number;
  sessions: McpSessionStat[];
  warmIndex: {
    ready: boolean;
    status: VaultIndexStatus['status'];
    lastRebuild: VaultIndexStatus['lastRebuild'];
  };
  recentLogs: string[];
  logPointers: Array<{ path: string; description: string }>;
}

export interface McpDaemonHandle {
  host: string;
  port: number;
  url: string;
  stop(): Promise<void>;
  getStatus(): McpDaemonStatus;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function listen(server: Server, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => {
      server.off('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function buildStatus(
  opts: StartMcpDaemonOptions,
  mcpHandler: McpRouteHandler,
  startedAt: string,
): McpDaemonStatus {
  const warmIndex = getVaultIndexStatus();
  return {
    service: 'rune-mcp',
    status: opts.gateSecret && warmIndex.status !== 'failed' ? 'ok' : 'degraded',
    uptime: process.uptime(),
    startedAt,
    bootId: getBootId(),
    oauth: { configured: Boolean(opts.gateSecret) },
    activeSessions: mcpHandler.getActiveSessionCount(),
    sessions: mcpHandler.getSessionStats(),
    warmIndex: {
      ready: warmIndex.ready,
      status: warmIndex.status,
      lastRebuild: warmIndex.lastRebuild,
    },
    recentLogs: [],
    logPointers: [
      {
        path: 'logs/rune.log',
        description: 'MCP daemon process log',
      },
    ],
  };
}

function daemonBroadSearch(
  query: string,
  options?: { directory?: string; maxResults?: number },
): Array<{ file: string; line: number; content: string }> {
  // Daemon kb_query broad retrieval uses warm state after readiness.
  const { ready } = getVaultIndexStatus();
  return ready ? queryVaultIndex(query, options) : searchVault(query, options);
}

export async function startMcpDaemon(opts: StartMcpDaemonOptions): Promise<McpDaemonHandle> {
  const startedAt = new Date().toISOString();
  mkdirSync(dirname(opts.oauthStoreFile), { recursive: true });
  initKB();
  const refreshTimer = setInterval(() => {
    try {
      refreshVaultIndex();
    } catch (err) {
      log.error('Scheduled vault index refresh failed', { error: (err as Error).message });
    }
  }, 15 * 60 * 1000);
  refreshTimer.unref();

  const oauth = createMcpOAuth({
    gateSecret: opts.gateSecret,
    gateSecretLabel: 'RUNE_MCP_SECRET',
    userId: opts.userId,
    issuerBaseUrl: opts.issuerBaseUrl,
    tokenTtlMs: opts.tokenTtlMs,
    loadState: () => readOAuthStore(opts.oauthStoreFile),
    saveState: (state) => writeOAuthStore(opts.oauthStoreFile, state),
  });

  const mcpHandler = mountMcpRoute({
    verifyBearer: oauth.verifyBearer,
    getServer: () => createRuneMcpServer({
      tools: [...APP_SURFACE_TOOLS, ...CONTENT_TOOLS, ...HEALTH_TOOLS, 'refresh_vault_index', 'mcp_metrics_snapshot'],
      name: 'rune-mcp',
      kbQueryBroadSearch: daemonBroadSearch,
      getActiveSessionCount: () => mcpHandler.getActiveSessionCount(),
    }),
  });

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const path = (req.url ?? '').split('?')[0];
      if (req.method === 'GET' && path === '/health') {
        json(res, 200, buildStatus(opts, mcpHandler, startedAt));
        return;
      }
      if (await oauth.handleOAuthRoute(req, res)) return;
      if (await mcpHandler(req, res)) return;
      res.writeHead(404);
      res.end('Not found');
    } catch (err) {
      log.error('MCP daemon request failed', { error: (err as Error).message });
      if (!res.headersSent) {
        res.writeHead(500);
        res.end('Internal error');
      } else {
        res.end();
      }
    }
  });

  await listen(server, opts.host, opts.port);

  // Metrics history flusher — started only once the HTTP surface is live so a
  // failed boot never writes a record. Fail-safe: mkdir/append errors degrade
  // to no persistence, never a crash.
  try {
    mkdirSync(dirname(config.RUNE_MCP_METRICS_HISTORY_FILE), { recursive: true });
  } catch (err) {
    log.error('Could not create MCP metrics history dir', { error: (err as Error).message });
  }
  const metricsFlush = startMcpMetricsFlush({
    file: config.RUNE_MCP_METRICS_HISTORY_FILE,
    getSnapshot: getMcpMetricsSnapshot,
    getActiveSessionCount: () => mcpHandler.getActiveSessionCount(),
  });

  let initialBuild: ReturnType<typeof setImmediate> | null = setImmediate(() => {
    initialBuild = null;
    try {
      buildVaultIndex();
    } catch (err) {
      log.error('Initial vault index build failed', { error: (err as Error).message });
    }
  });
  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : opts.port;
  const handle: McpDaemonHandle = {
    host: opts.host,
    port: actualPort,
    url: `http://${opts.host}:${actualPort}`,
    getStatus: () => buildStatus(opts, mcpHandler, startedAt),
    async stop() {
      if (initialBuild) {
        clearImmediate(initialBuild);
        initialBuild = null;
      }
      clearInterval(refreshTimer);
      metricsFlush.stop();
      await mcpHandler.closeAll();
      await closeServer(server);
    },
  };

  log.info('MCP daemon listening', { host: handle.host, port: handle.port });
  return handle;
}

async function main(): Promise<void> {
  const daemon = await startMcpDaemon({
    host: config.RUNE_MCP_HOST,
    port: config.RUNE_MCP_PORT,
    gateSecret: config.RUNE_MCP_SECRET,
    userId: String(config.TELEGRAM_USER_ID),
    issuerBaseUrl: config.RUNE_MCP_ISSUER_URL || undefined,
    oauthStoreFile: config.RUNE_MCP_OAUTH_STORE_FILE,
    tokenTtlMs: null,
  });

  async function shutdown(): Promise<void> {
    log.info('Shutting down MCP daemon');
    try {
      await daemon.stop();
    } finally {
      await flushLogger();
      process.exit(0);
    }
  }

  process.on('SIGTERM', () => { void shutdown(); });
  process.on('SIGINT', () => { void shutdown(); });
}

if (process.env['VITEST'] !== 'true' && process.argv[1]?.endsWith('/src/mcp/daemon.ts')) {
  main().catch((err) => {
    log.error('MCP daemon failed to start', { error: (err as Error).message });
    void flushLogger().finally(() => process.exit(1));
  });
}
