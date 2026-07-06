/**
 * Streamable HTTP transport for the Claude App MCP connector — project 16,
 * Phase 2, spec R4 / tech-spec "Architecture decision (R4)".
 *
 * `mountMcpRoute(opts?)` returns a `(req, res) => Promise<boolean>` handler
 * (the webviewHandler pattern in startHttpServer): it handles every method on
 * `/mcp` and returns false for any other path. Per-session SDK
 * `StreamableHTTPServerTransport`s are kept in a closure map keyed by the
 * `mcp-session-id` header; each new session gets its OWN `McpServer` instance
 * from `getServer()` (the SDK binds one transport per Server instance).
 *
 * Gate order on every /mcp request (including session-routed ones):
 *   1. host allowlist (`isAllowedHost`) → 403 — same defense-in-depth gate
 *      the webview routes use.
 *   2. bearer (`verifyBearer`) → 401 — FAIL-CLOSED: when no verifier is
 *      injected, every request is rejected. The §7 OAuth task binds the real
 *      validator; an unconfigured /mcp endpoint must never be open.
 *   3. SDK transport handles the request (initialize POST → new session;
 *      otherwise routed by session id). A standalone no-session GET SSE
 *      stream (server-initiated notifications) is deliberately out of scope —
 *      sessions open only via an initialize POST.
 *
 * Lifecycle: sessions are evicted on client DELETE / transport close AND by
 * an idle timer (SESSION_IDLE_MS, unref'd). The returned handler carries a
 * `closeAll()` method that force-closes every live transport; daemon shutdown
 * calls it BEFORE `server.close()` so an open SSE stream cannot keep
 * connections from draining.
 */

import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createRuneMcpServer, APP_SURFACE_TOOLS } from '../mcp/server.js';
import { isAllowedHost } from './auth.js';
import { readBody, BodyTooLargeError } from './read-body.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('mcp-transport');

export interface McpTransportOpts {
  /** MCP server factory — one INDEPENDENT instance per session.
   *  Default: the six App-surface tools (never the kb_* admin set). */
  getServer?: () => McpServer;
  /** Bearer validator. DEFAULT REJECTS EVERYTHING (fail-closed) — the §7
   *  OAuth module binds the real validator in production wiring. */
  verifyBearer?: (req: IncomingMessage) => boolean | Promise<boolean>;
}

/** Monitoring row for one live session — id truncated to 8 chars, ISO times. */
export interface McpSessionStat {
  id: string;
  openedAt: string;
  lastSeenAt: string;
}

/** The /mcp route handler plus the teardown for its live sessions. */
export type McpRouteHandler = ((req: IncomingMessage, res: ServerResponse) => Promise<boolean>) & {
  /** Force-close every live session transport (idempotent). */
  closeAll: () => Promise<void>;
  /** Current live Streamable HTTP MCP sessions. */
  getActiveSessionCount: () => number;
  /** Monitoring stats for the live sessions (ids truncated to 8 chars). */
  getSessionStats: () => McpSessionStat[];
};

const MCP_PATH = '/mcp';

/** Idle sessions are force-closed after this long with no requests. */
const SESSION_IDLE_MS = 30 * 60_000;

/** JSON-RPC-shaped rejection — one consistent error shape for every gate. */
function reject(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(
    JSON.stringify({
      jsonrpc: '2.0',
      error: { code: status === 401 ? -32001 : -32000, message },
      id: null,
    }),
  );
}

/**
 * Mount the /mcp Streamable HTTP route. Returns a handler that resolves true
 * when it handled the request (any method on /mcp), false otherwise; the
 * handler's `closeAll()` tears down all live session transports.
 */
export function mountMcpRoute(opts?: McpTransportOpts): McpRouteHandler {
  const getServer =
    opts?.getServer ?? (() => createRuneMcpServer({ tools: APP_SURFACE_TOOLS }));
  // Fail-closed default: an /mcp mount without an injected verifier rejects
  // every request rather than exposing tools unauthenticated.
  const verifyBearer = opts?.verifyBearer ?? (() => false);

  /** Live transports keyed by SDK session id. */
  const transports = new Map<string, StreamableHTTPServerTransport>();
  /** Per-session idle timers (unref'd — never keep the process alive). */
  const idleTimers = new Map<string, NodeJS.Timeout>();
  /** Per-session open/last-seen timestamps (ms epoch) for monitoring. */
  const sessionMeta = new Map<string, { openedAt: number; lastSeenAt: number }>();

  function touchIdleTimer(sessionId: string, transport: StreamableHTTPServerTransport): void {
    const meta = sessionMeta.get(sessionId);
    if (meta) meta.lastSeenAt = Date.now();
    const existing = idleTimers.get(sessionId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      log.info('Evicting idle MCP session', { sessionId });
      void transport.close().catch(() => undefined);
    }, SESSION_IDLE_MS);
    timer.unref();
    idleTimers.set(sessionId, timer);
  }

  function dropSession(sessionId: string): void {
    transports.delete(sessionId);
    sessionMeta.delete(sessionId);
    const timer = idleTimers.get(sessionId);
    if (timer) clearTimeout(timer);
    idleTimers.delete(sessionId);
  }

  const handler = (async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    if (!req.url || req.url.split('?')[0] !== MCP_PATH) return false;

    // Gate 1: host allowlist — same convention as the webview routes (403).
    if (!isAllowedHost(req)) {
      reject(res, 403, 'Forbidden: disallowed host');
      return true;
    }

    // Gate 2: bearer — rejected BEFORE the transport sees the request.
    if (!(await verifyBearer(req))) {
      // RFC 9728: the challenge points at the PROTECTED RESOURCE metadata
      // (which names the authorization server), not the AS metadata itself.
      res.setHeader('WWW-Authenticate', 'Bearer resource_metadata="/.well-known/oauth-protected-resource"');
      reject(res, 401, 'Unauthorized: valid bearer token required');
      return true;
    }

    try {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;

      // Existing session → route to its transport.
      if (sessionId !== undefined) {
        const transport = transports.get(sessionId);
        if (!transport) {
          reject(res, 404, 'Unknown MCP session');
          return true;
        }
        touchIdleTimer(sessionId, transport);
        await transport.handleRequest(req, res);
        return true;
      }

      // No session id: only an initialize POST may open a new session.
      // (Standalone GET SSE is out of scope — see module JSDoc.)
      if (req.method !== 'POST') {
        reject(res, 400, 'Missing MCP session id');
        return true;
      }

      let raw: string;
      try {
        raw = await readBody(req);
      } catch (bodyErr) {
        if (bodyErr instanceof BodyTooLargeError) {
          reject(res, 413, 'Request body too large');
          return true;
        }
        throw bodyErr;
      }
      let parsedBody: unknown;
      try {
        parsedBody = JSON.parse(raw);
      } catch {
        reject(res, 400, 'Invalid JSON body');
        return true;
      }
      if (!isInitializeRequest(parsedBody)) {
        reject(res, 400, 'Expected an initialize request to open a session');
        return true;
      }

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          transports.set(sid, transport);
          const nowMs = Date.now();
          sessionMeta.set(sid, { openedAt: nowMs, lastSeenAt: nowMs });
          touchIdleTimer(sid, transport);
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) dropSession(transport.sessionId);
      };

      const server = getServer();
      await server.connect(transport);
      await transport.handleRequest(req, res, parsedBody);
      return true;
    } catch (err) {
      log.error('MCP transport error', { error: (err as Error).message });
      if (!res.headersSent) {
        reject(res, 500, 'Internal MCP transport error');
      } else {
        res.end();
      }
      return true;
    }
  }) as McpRouteHandler;

  handler.closeAll = async () => {
    const live = [...transports.values()];
    transports.clear();
    sessionMeta.clear();
    for (const timer of idleTimers.values()) clearTimeout(timer);
    idleTimers.clear();
    await Promise.all(live.map((t) => t.close().catch(() => undefined)));
  };
  handler.getActiveSessionCount = () => transports.size;
  handler.getSessionStats = () =>
    [...sessionMeta.entries()].map(([id, meta]) => ({
      id: id.slice(0, 8),
      openedAt: new Date(meta.openedAt).toISOString(),
      lastSeenAt: new Date(meta.lastSeenAt).toISOString(),
    }));

  return handler;
}
