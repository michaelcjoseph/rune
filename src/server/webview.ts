import { createReadStream } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { join, extname, resolve as resolvePath, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { request as httpRequest, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { WebSocketServer } from 'ws';
import { readBody } from './read-body.js';
import config from '../config.js';
import { verifyAuth, isAllowedHost, safeCompare } from './auth.js';
import { getStateSnapshot } from './state-snapshot.js';
import { readRegistry, type Registry } from '../intent/registry.js';
import { readFileSync } from 'node:fs';
import { buildCockpitView, type WorkRunProjection, type BacklogCounts } from '../intent/cockpit.js';
import { buildHomePulse } from '../intent/home-pulse.js';
import { buildProductDeepView, type ProductDeepViewWorkRun } from '../intent/product-deep-view.js';
import { readBacklogs, computeBacklogCounts } from '../intent/backlog-reader.js';
import { parseBugs, parseIdeas, type BacklogItem } from '../intent/backlog-parser.js';
import { appendBug, appendIdea } from '../intent/backlog-append.js';
import {
  withFileLock,
  writeFileAtomic,
  assertBacklogWriteAllowed,
  appendBacklogMutationLog,
  BacklogWriteError,
} from '../intent/backlog-write-lock.js';
import { readProductsConfig, defaultRunGit } from '../jobs/sandbox-runtime.js';
import { computeFixAction, withActions } from './backlog-actions.js';
import { getSession, type SessionScope } from '../vault/sessions.js';
import { createLogger } from '../utils/logger.js';
import type { WebviewSender } from '../transport/webview-sender.js';
import { handleWebviewMessage } from './webview-bootstrap.js';
import { createMutation, cancelMutation, activeRuns } from '../transport/mutations.js';
import type { MutationKind } from '../transport/mutations.js';
import { resolveWorkDispatch, readDispatchModeInput } from '../jobs/work-dispatch.js';
import type { DispatchModeView } from '../intent/cockpit.js';
import { cancelOp, isCancelled, registerOp, unregisterOp } from '../transport/in-flight.js';
import { restartServer } from './restart.js';
import { readCockpitRunStatus } from './cockpit-run-status.js';
import { getProjectSummaries } from './projects-snapshot.js';
import { readWorkRunProjections } from './work-run-projection.js';
import { readRecentIndex, readWorkRunSummary } from '../jobs/work-run-store.js';
import { requestWorkRunRelease, defaultReleaseRequestDeps } from '../jobs/work-run-release.js';
import { VALID_SLUG, worktreePathFor } from '../intent/sandbox.js';
import { appendInteraction } from '../utils/observation-log.js';
import {
  createPlanningSession,
  getActivePlanningSession,
  getAllPlanningSessions,
  getPlanningSession,
  updatePlanningSession,
  deletePlanningSession,
  approveActivePlanningSession,
  abandonActivePlanningSession,
  type StoredPlanningSession,
} from '../reviews/planning.js';
import { handlePlanningTurn, defaultScopingTurn } from '../reviews/planning-handler.js';
import { runScaffoldApproval, retryPromotionMarkSource } from '../jobs/scaffold-approval.js';
import {
  runDownstreamPlan,
  type PlanningDownstreamErrorDetails,
  type PlanningProgress,
  type PlanningProgressStage,
} from '../intent/planning-roles.js';
import { isPmSpecApprovalArtifact, type SpecArtifact } from '../intent/planner.js';
import { createPromotion, appendPromotion, loadPromotions, transitionPromotion } from '../intent/promotions.js';
import { scrubAbsolutePaths } from '../utils/sanitize-paths.js';
import { readIntentProposalQueue } from '../intent/intent-proposal-queue.js';
import { readProposalQueue } from '../jobs/proposal-queue.js';
import { readAllRuns } from '../jobs/supervision-store.js';
import { getVisibility } from '../intent/supervision.js';
import { readPlaybookQueue } from '../jobs/playbook-extract.js';
import { dispatchApprovalStatus } from '../transport/approval-actions.js';
import { readOrchestratedTaskRunRecords } from '../jobs/orchestrated-work-runner.js';
import { parseStreamJsonLine, streamJsonToDisplay } from '../jobs/work-run-transcript.js';
import { redactSecrets } from '../utils/redact-secrets.js';
import { evaluateBugFixGate } from '../jobs/bug-fix-gate.js';
import { runPmTechLeadBugScoping } from '../jobs/pm-techlead-bug-scoping.js';
import {
  appendFixAttempt,
  getLatestFixAttempt,
  readLatestFixAttempts,
  type FixAttempt,
} from '../jobs/fix-attempt-store.js';
import { startFixRun } from '../jobs/fix-run-handoff.js';
import { readOAuthStore } from './mcp-oauth-store.js';

const log = createLogger('webview');

class PlanningApprovalCancelled extends Error {
  constructor() {
    super('Planning approval cancelled.');
  }
}

type PlanningApprovalStatus =
  | { status: 'success' }
  | { status: 'error'; error: string }
  | { status: 'cancelled' };

interface PlanningApprovalControl {
  opId?: string;
  terminalSent: boolean;
}

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

function reject400(res: ServerResponse, msg: string): void {
  res.writeHead(400, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: msg }));
}

function reject401(res: ServerResponse): void {
  res.writeHead(401, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'unauthorized' }));
}

function reject403(res: ServerResponse): void {
  res.writeHead(403, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'forbidden' }));
}

// Bounded body reads use the shared reader (1 MB default) — see
// src/server/read-body.ts. The shared version also destroys the socket on
// overflow, which the old local copy did not.

/** Load and template-substitute index.html. Called at mount time (prod
 *  pre-load) and on every `GET /` request in dev mode. */
async function loadIndexHtml(): Promise<string> {
  const raw = await readFile(join(STATIC_DIR, 'index.html'), 'utf8');
  const safeName = escapeHtmlAttr(config.OBSIDIAN_VAULT_NAME);
  return raw
    .replace('__OBSIDIAN_VAULT_NAME__', safeName)
    .replace('__IS_PRODUCTION__', config.IS_PRODUCTION ? 'true' : 'false');
}

/** Read index.html fresh from disk and write it to `res`. On read failure,
 *  respond 404. Used by the dev path and by the prod fallback when the
 *  mount-time pre-load did not populate the cache. */
async function serveIndexHtml(res: ServerResponse): Promise<void> {
  try {
    const html = await loadIndexHtml();
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
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
  if (!config.RUNE_HTTP_SECRET) {
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
  if (!body.token || !safeCompare(body.token, config.RUNE_HTTP_SECRET)) {
    reject401(res);
    return;
  }
  const isHttps =
    req.headers['x-forwarded-proto'] === 'https' &&
    (req.socket.remoteAddress === '127.0.0.1' || req.socket.remoteAddress === '::1');
  const cookieParts = [
    `rune-auth=${config.RUNE_HTTP_SECRET}`,
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

type McpMonitoring = {
  mcp?: {
    status: 'ok' | 'degraded';
    endpoint: string;
    checkedAt: string;
    error?: string;
  };
};

type CockpitProductWithMonitoring = ReturnType<typeof buildCockpitView>['products'][number] & {
  monitoring?: McpMonitoring;
};

type CockpitViewWithMonitoring = Omit<ReturnType<typeof buildCockpitView>, 'products'> & {
  products: CockpitProductWithMonitoring[];
};

type McpToolCallResult = {
  content?: Array<{ type?: string; text?: string }>;
  isError?: boolean;
};

type McpMetricsMonitoringState = {
  status: 'ok' | 'degraded';
  sourceTool: 'mcp_metrics_snapshot';
  checkedAt: string;
  mcpMetrics?: unknown;
  error?: string;
};

type McpJsonRpcResponse = {
  id?: unknown;
  result?: unknown;
  error?: { message?: string };
};

type McpMetricsSession = {
  endpointKey: string;
  sessionId: string;
  bearerToken?: string;
  nextId: number;
};

let mcpMetricsSession: McpMetricsSession | null = null;
let mcpMetricsSessionInit: Promise<McpMetricsSession> | null = null;

/**
 * Extract the JSON-RPC payload from a Server-Sent Events body.
 *
 * The Streamable-HTTP MCP daemon answers a single `tools/call`/`initialize`
 * POST with `Content-Type: text/event-stream` (the SDK transport does not set
 * `enableJsonResponse`), so the body is one or more SSE frames:
 *
 *   event: message
 *   data: {"jsonrpc":"2.0","id":2,"result":{...}}
 *
 * We collect the `data:` field(s) of each event (blank-line-separated, multiple
 * `data:` lines joined with `\n` per the SSE spec), JSON.parse each, and return
 * the JSON-RPC response carrying `result`/`error` — falling back to the last
 * parsed event. Comment lines (`:`-prefixed keep-alives) and non-JSON data are
 * skipped. Throws if no JSON data payload is present.
 */
function extractSseJson(body: string): unknown {
  const events: unknown[] = [];
  const blocks = body.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n\n');
  for (const block of blocks) {
    const dataLines: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
    }
    const payload = dataLines.join('\n').trim();
    if (!payload) continue;
    try {
      events.push(JSON.parse(payload));
    } catch {
      // Skip non-JSON data payloads (keep-alives, partial frames).
    }
  }
  if (events.length === 0) {
    throw new Error('MCP daemon returned an event stream with no JSON data payload');
  }
  const response = events.find((evt) => (
    evt !== null && typeof evt === 'object' && ('result' in evt || 'error' in evt)
  ));
  return response ?? events[events.length - 1];
}

function readJsonResponse(res: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = '';
    res.setEncoding('utf8');
    res.on('data', (chunk) => { body += chunk; });
    res.on('end', () => {
      if (!body.trim()) {
        resolve(null);
        return;
      }
      // The Streamable-HTTP MCP daemon replies with SSE, not JSON. Detect it by
      // content-type, with a body-shape fallback so a missing/odd header still
      // parses instead of throwing `Unexpected token 'e', "event: mes...`. The
      // SDK transport always emits the frame's `event:`/`data:` field at byte 0,
      // and valid JSON never begins with either, so this can't reroute real JSON.
      const contentType = String(res.headers['content-type'] ?? '').toLowerCase();
      if (
        contentType.includes('text/event-stream') ||
        body.startsWith('event:') ||
        body.startsWith('data:')
      ) {
        try {
          resolve(extractSseJson(body));
        } catch (err) {
          reject(err);
        }
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (err) {
        reject(err);
      }
    });
    res.on('error', reject);
  });
}

function mcpEndpointKey(): string {
  return `${config.RUNE_MCP_HOST}:${config.RUNE_MCP_PORT}`;
}

function readMcpDaemonBearerToken(now = Date.now()): string | undefined {
  try {
    const state = readOAuthStore(config.RUNE_MCP_OAUTH_STORE_FILE);
    const userId = String(config.TELEGRAM_USER_ID);
    const token = state?.tokens.find((record) => (
      record.userId === userId &&
      (record.expiresAt === null || record.expiresAt > now)
    ));
    return token?.token;
  } catch {
    return undefined;
  }
}

function postMcpJsonRpc(body: Record<string, unknown>, opts: {
  sessionId?: string;
  bearerToken?: string;
} = {}): Promise<{
  statusCode: number;
  sessionId?: string;
  body: unknown;
}> {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host: config.RUNE_MCP_HOST,
      port: config.RUNE_MCP_PORT,
      path: '/mcp',
      method: 'POST',
      timeout: 1_000,
      headers: {
        Accept: 'application/json, text/event-stream',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        ...(opts.bearerToken ? { Authorization: `Bearer ${opts.bearerToken}` } : {}),
        ...(opts.sessionId ? { 'mcp-session-id': opts.sessionId } : {}),
      },
    }, async (mcpRes) => {
      try {
        resolve({
          statusCode: mcpRes.statusCode ?? 0,
          sessionId: typeof mcpRes.headers['mcp-session-id'] === 'string'
            ? mcpRes.headers['mcp-session-id']
            : undefined,
          body: await readJsonResponse(mcpRes),
        });
      } catch (err) {
        reject(err);
      }
    });
    req.on('timeout', () => {
      req.destroy(new Error('MCP daemon metrics tool call timed out'));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

async function createMcpMetricsSession(): Promise<McpMetricsSession> {
  const bearerToken = readMcpDaemonBearerToken();
  const init = await postMcpJsonRpc({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'rune-webview', version: '1.0.0' },
    },
  }, { bearerToken });
  const initError = rpcErrorMessage(init, 'MCP initialize');
  if (initError) throw new Error(initError);
  if (!init.sessionId) throw new Error('MCP daemon did not return a session id');

  const session: McpMetricsSession = {
    endpointKey: mcpEndpointKey(),
    sessionId: init.sessionId,
    ...(bearerToken ? { bearerToken } : {}),
    nextId: 2,
  };

  await postMcpJsonRpc({
    jsonrpc: '2.0',
    method: 'notifications/initialized',
    params: {},
  }, {
    sessionId: session.sessionId,
    bearerToken: session.bearerToken,
  });

  return session;
}

async function getMcpMetricsSession(): Promise<McpMetricsSession> {
  if (mcpMetricsSession?.endpointKey === mcpEndpointKey()) return mcpMetricsSession;
  mcpMetricsSession = null;
  if (!mcpMetricsSessionInit) {
    mcpMetricsSessionInit = createMcpMetricsSession().finally(() => {
      mcpMetricsSessionInit = null;
    });
  }
  mcpMetricsSession = await mcpMetricsSessionInit;
  return mcpMetricsSession;
}

function dropMcpMetricsSession(session?: McpMetricsSession): void {
  if (!session || mcpMetricsSession?.sessionId === session.sessionId) {
    mcpMetricsSession = null;
  }
}

function rpcErrorMessage(response: { statusCode: number; body: unknown }, fallback: string): string | null {
  if (response.statusCode >= 200 && response.statusCode < 300) {
    const body = response.body as McpJsonRpcResponse | null;
    if (body?.error?.message) return body.error.message;
    return null;
  }
  const body = response.body as McpJsonRpcResponse | null;
  return body?.error?.message ?? `${fallback} returned HTTP ${response.statusCode || 'unknown'}`;
}

function mcpTextContent(result: McpToolCallResult): string {
  return (result.content ?? [])
    .map((part) => (part.type === 'text' && typeof part.text === 'string' ? part.text : ''))
    .filter(Boolean)
    .join('\n');
}

async function callMcpMetricsSnapshotTool(): Promise<McpMetricsMonitoringState> {
  const checkedAt = new Date().toISOString();
  try {
    let session = await getMcpMetricsSession();
    let tool = await postMcpJsonRpc({
      jsonrpc: '2.0',
      id: session.nextId++,
      method: 'tools/call',
      params: {
        name: 'mcp_metrics_snapshot',
        arguments: {},
      },
    }, {
      sessionId: session.sessionId,
      bearerToken: session.bearerToken,
    });
    let toolError = rpcErrorMessage(tool, 'mcp_metrics_snapshot');
    if (toolError && (tool.statusCode === 401 || tool.statusCode === 404)) {
      dropMcpMetricsSession(session);
      session = await getMcpMetricsSession();
      tool = await postMcpJsonRpc({
        jsonrpc: '2.0',
        id: session.nextId++,
        method: 'tools/call',
        params: {
          name: 'mcp_metrics_snapshot',
          arguments: {},
        },
      }, {
        sessionId: session.sessionId,
        bearerToken: session.bearerToken,
      });
      toolError = rpcErrorMessage(tool, 'mcp_metrics_snapshot');
    }
    if (toolError) throw new Error(toolError);
    const result = (tool.body as McpJsonRpcResponse | null)?.result as McpToolCallResult | undefined;
    if (!result || typeof result !== 'object') throw new Error('mcp_metrics_snapshot returned an invalid result');
    const text = mcpTextContent(result);
    if (result.isError) {
      throw new Error(text || 'mcp_metrics_snapshot returned an MCP tool error');
    }
    if (!text) throw new Error('mcp_metrics_snapshot returned no metrics payload');
    return {
      status: 'ok',
      sourceTool: 'mcp_metrics_snapshot',
      checkedAt,
      mcpMetrics: JSON.parse(text),
    };
  } catch (err) {
    return {
      status: 'degraded',
      sourceTool: 'mcp_metrics_snapshot',
      checkedAt,
      error: scrubAbsolutePaths((err as Error).message || 'MCP daemon metrics unavailable'),
    };
  }
}

async function handleApiMcpMetricsSnapshot(res: ServerResponse): Promise<void> {
  const state = await callMcpMetricsSnapshotTool();
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(state));
}

function probeMcpDaemonHealth(): Promise<{
  status: 'ok' | 'degraded';
  endpoint: string;
  checkedAt: string;
  error?: string;
}> {
  const endpoint = `http://${config.RUNE_MCP_HOST}:${config.RUNE_MCP_PORT}/health`;
  const checkedAt = new Date().toISOString();
  return new Promise((resolve) => {
    const req = httpRequest(endpoint, { method: 'GET', timeout: 500 }, (mcpRes) => {
      mcpRes.resume();
      mcpRes.on('end', () => {
        if (mcpRes.statusCode === 200) {
          resolve({ status: 'ok', endpoint, checkedAt });
          return;
        }
        resolve({
          status: 'degraded',
          endpoint,
          checkedAt,
          error: `MCP daemon health returned HTTP ${mcpRes.statusCode ?? 'unknown'}`,
        });
      });
    });
    req.on('timeout', () => {
      req.destroy(new Error('MCP daemon health check timed out'));
    });
    req.on('error', (err: NodeJS.ErrnoException) => {
      resolve({
        status: 'degraded',
        endpoint,
        checkedAt,
        error: err.code ? `${err.code}: ${err.message}` : `MCP daemon unreachable: ${err.message}`,
      });
    });
    req.end();
  });
}

async function attachMcpMonitoring(view: ReturnType<typeof buildCockpitView>): Promise<CockpitViewWithMonitoring> {
  const out = view as CockpitViewWithMonitoring;
  if (!out.available) return out;
  const runeMcp = out.products.find((product): product is CockpitProductWithMonitoring => product.name === 'rune-mcp');
  if (!runeMcp) return out;
  runeMcp.monitoring = {
    ...(runeMcp.monitoring ?? {}),
    mcp: await probeMcpDaemonHealth(),
  };
  return out;
}

async function handleApiCockpit(res: ServerResponse): Promise<void> {
  // No bot-ready guard: this endpoint only reads a file and runs a pure projection, so it
  // works during startup too. A registry not yet built (or corrupt) is a clear cockpit
  // state, not a server error — buildCockpitView turns a null registry into a clean
  // "unavailable" view.
  let registry: Registry | null;
  try {
    registry = readRegistry();
  } catch {
    registry = null;
  }
  // Feed live run-status from the supervision surface — the persisted store
  // (logs/supervised-runs.json) is the source of truth, populated by the
  // mutation pipeline's hooks (A2.2). Reading here keeps the cockpit
  // consistent with what stall-check sees and survives the in-memory
  // `activeRuns` map being cleared on shutdown. A project with no active
  // run defaults to `idle` in buildCockpitView.
  const runStatus = readCockpitRunStatus(config.SUPERVISED_RUNS_FILE);
  // Cross-product task progress (done / total) rides on each project's registry
  // entry, refreshed on registry rebuild — so every product's cards render a bar,
  // not just Rune's. On top of that, overlay a LIVE read of Rune's own
  // tasks.md so Rune cards update in real time each poll (the daemon runs in
  // the Rune repo, so only it is cheap to read live). Scoped to the rune
  // product so a slug shared with another product can't override its counts. A
  // failed read just leaves the registry-baked progress in place.
  if (registry) {
    try {
      const live = new Map(
        getProjectSummaries().map((s) => [s.slug, { done: s.progress.done, total: s.progress.total }]),
      );
      const rune = registry.products.find((p) => p.name === 'rune');
      if (rune) {
        for (const project of rune.projects) {
          const lp = live.get(project.slug);
          if (lp && lp.total > 0) project.progress = lp;
        }
      }
    } catch (err) {
      log.warn('handleApiCockpit: live rune task-progress overlay failed', { error: (err as Error).message });
    }
  }
  // Enrich with the work-run projection (project 11 Phase 5) from the new
  // work-run store. A failed read (missing/corrupt store) falls back to no
  // projection — the cockpit must render even without it.
  let workRuns: Record<string, WorkRunProjection> = {};
  try {
    // Feed in-flight runs (running / blocked-on-human) from the supervision
    // store so a live run's card renders last-N output + elapsed immediately,
    // rather than staying blank until termination writes the index row (Gap #2,
    // phase-6-diagnosis.md; spec req 24). Terminal index rows still win once a
    // run ends.
    //
    // This re-reads supervised-runs.json (readCockpitRunStatus above read it for
    // runStatus). The second read is accepted rather than consolidated: the file
    // is small and local, the cockpit is poll-driven, and the only divergence a
    // mid-poll write could cause (runStatus vs. workRun reflecting different
    // snapshots for one cycle) is cosmetic, not a correctness/security issue.
    // Consolidating would require threading pre-loaded runs through
    // readCockpitRunStatus and updating its three test mocks — not worth it here.
    const activeRuns = readAllRuns(config.SUPERVISED_RUNS_FILE).filter(
      (r) => r.status === 'running' || r.status === 'blocked-on-human',
    );
    workRuns = readWorkRunProjections(
      config.WORK_RUNS_DIR,
      config.WORK_RUNS_INDEX_FILE,
      undefined,
      activeRuns,
    );
  } catch (err) {
    log.warn('handleApiCockpit: readWorkRunProjections failed', { error: (err as Error).message });
  }
  // Per-product backlog counts (09-expand-cockpit) for the sidebar one-liner. Bounded
  // (counts only, not the full lists — the drawer fetches those). Fail-soft: a missing
  // products.json or unreadable backlog leaves counts absent so the cockpit still renders.
  // Synchronous reads on the poll path (2 files per repo-backed product): sound on local SSD;
  // if WORKSPACE_DIR is ever iCloud-synced, a `.icloud` placeholder read would block — defer
  // off the event loop then (same caveat as ReadBacklogsOpts / handleApiBacklog).
  let backlogCounts: Record<string, BacklogCounts> = {};
  if (registry) {
    try {
      const productsConfig = readProductsConfig(config.PRODUCTS_CONFIG_FILE);
      for (const pb of readBacklogs(registry, productsConfig, { workspaceRoot: config.WORKSPACE_DIR })) {
        if (!pb.notRepoBacked) backlogCounts[pb.product] = computeBacklogCounts(pb);
      }
    } catch (err) {
      log.warn('handleApiCockpit: backlog counts failed', { error: (err as Error).message });
    }
  }

  // Per-project dispatch mode (project 14 Phase 5) so the Start surface shows
  // whether Start will run orchestrated work or legacy `/work --auto` BEFORE
  // launch (and a legacy fallback's reason). The toggle is per-PRODUCT, so every
  // project under a product shares its resolution. Fail-soft: a read failure
  // leaves the map empty and the card simply omits the mode chip.
  let dispatchModes: Record<string, DispatchModeView> = {};
  if (registry) {
    try {
      for (const product of registry.products) {
        const resolution = resolveWorkDispatch(
          readDispatchModeInput({
            product: product.name,
            productsConfigPath: config.PRODUCTS_CONFIG_FILE,
            globalEnabled: config.ORCHESTRATED_WORK_ENABLED,
          }),
        );
        const entry: DispatchModeView = {
          mode: resolution.mode,
          ...(resolution.fallbackReason !== undefined ? { fallbackReason: resolution.fallbackReason } : {}),
        };
        for (const project of product.projects) dispatchModes[project.slug] = entry;
      }
    } catch (err) {
      log.warn('handleApiCockpit: dispatch-mode resolution failed', { error: (err as Error).message });
    }
  }

  const view = await attachMcpMonitoring(
    buildCockpitView(registry, runStatus, undefined, workRuns, backlogCounts, dispatchModes),
  );
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(view));
}

// ---------------------------------------------------------------------------
// Home + product deep-view routes (cockpit redesign, Phase 1)
// ---------------------------------------------------------------------------

const NEW_COCKPIT_RECENT_RUNS = 20;

function readNewCockpitBacklogs(registry: Registry) {
  const productsConfig = readProductsConfig(config.PRODUCTS_CONFIG_FILE);
  return readBacklogs(registry, productsConfig, { workspaceRoot: config.WORKSPACE_DIR });
}

function readNewCockpitRecentWorkRuns(): ProductDeepViewWorkRun[] {
  const rows = readRecentIndex(config.WORK_RUNS_INDEX_FILE, NEW_COCKPIT_RECENT_RUNS);
  const runs: ProductDeepViewWorkRun[] = [];
  for (const row of rows) {
    if (!VALID_SLUG.test(row.id)) continue;
    const summary = readWorkRunSummary(config.WORK_RUNS_DIR, row.id);
    const product = summary?.product;
    const project = summary?.project ?? row.project;
    if (!product || !project) continue;
    const summaryMetadata = summary as (typeof summary & {
      target?: ProductDeepViewWorkRun['target'];
      routePath?: string;
      writingStage?: string;
    });
    const isWritingRun = product === 'writing';
    runs.push({
      runId: row.id,
      product,
      project,
      target: isWritingRun && summaryMetadata?.target
        ? summaryMetadata.target
        : { kind: 'project', slug: project },
      outcome: summary?.outcome ?? row.outcome,
      endedAt: summary?.endedAt ?? row.endedAt,
      transcriptExists: Boolean(summary?.transcriptPath),
      ...(isWritingRun && summary?.branch ? { branch: summary.branch } : {}),
      ...(isWritingRun && summaryMetadata?.routePath ? { routePath: summaryMetadata.routePath } : {}),
      ...(isWritingRun && summaryMetadata?.writingStage ? { writingStage: summaryMetadata.writingStage } : {}),
    });
  }
  return runs;
}

function handleApiHome(res: ServerResponse): void {
  const view = buildHomePulse({
    readRegistry,
    readSupervisedRuns: () => readAllRuns(config.SUPERVISED_RUNS_FILE),
    readRecentWorkRuns: readNewCockpitRecentWorkRuns,
    readBacklogs: () => {
      const registry = readRegistry();
      return readNewCockpitBacklogs(registry);
    },
  });
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(view));
}

function handleApiProductDeepView(res: ServerResponse, product: string): void {
  if (!VALID_SLUG.test(product)) {
    sendErrorEnvelope(res, 400, 'invalid-slug', `invalid product slug '${product}'`);
    return;
  }

  let registry: Registry;
  try {
    registry = readRegistry();
  } catch (err) {
    log.warn('handleApiProductDeepView: registry read failed', { product, error: (err as Error).message });
    sendErrorEnvelope(res, 500, 'registry-unavailable', 'could not read the product registry', false);
    return;
  }

  if (!registry.products.some((candidate) => candidate.name === product)) {
    sendErrorEnvelope(res, 404, 'unknown-product', `unknown product '${product}'`, false);
    return;
  }

  const planningActive = isPlanningActiveForProduct(product);
  let dispatchModes: Record<string, DispatchModeView> = {};
  try {
    const resolution = resolveWorkDispatch(
      readDispatchModeInput({
        product,
        productsConfigPath: config.PRODUCTS_CONFIG_FILE,
        globalEnabled: config.ORCHESTRATED_WORK_ENABLED,
      }),
    );
    const entry: DispatchModeView = {
      mode: resolution.mode,
      ...(resolution.fallbackReason !== undefined ? { fallbackReason: resolution.fallbackReason } : {}),
    };
    const productEntry = registry.products.find((candidate) => candidate.name === product);
    if (productEntry) {
      dispatchModes = Object.fromEntries(productEntry.projects.map((project) => [project.slug, entry]));
    }
  } catch (err) {
    log.warn('handleApiProductDeepView: dispatch-mode resolution failed', { product, error: (err as Error).message });
  }
  const view = buildProductDeepView({
    product,
    readRegistry: () => registry,
    readSupervisedRuns: () => readAllRuns(config.SUPERVISED_RUNS_FILE),
    readRecentWorkRuns: readNewCockpitRecentWorkRuns,
    readBacklogs: () => readNewCockpitBacklogs(registry),
    readFixAttempts: () => readLatestFixAttempts(config.FIX_ATTEMPTS_FILE),
    readTaskRunRecords: (runId) => readOrchestratedTaskRunRecords(config.WORK_RUNS_DIR, runId),
    readActiveMutations: () => [...activeRuns.values()].map((handle) => handle.descriptor),
    dispatchModes,
    worktreePathFor: (productName, projectSlug) => worktreePathFor(productName, projectSlug, config.WORKTREE_ROOT),
    planningActive,
  });
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(view));
}

// ---------------------------------------------------------------------------
// Backlog drawer route (09-expand-cockpit, Phase 2)
// ---------------------------------------------------------------------------

/** Typed error envelope `{ error: { code, message, retryable } }` per spec "API surface". */
function sendErrorEnvelope(
  res: ServerResponse,
  status: number,
  code: string,
  message: string,
  retryable = false,
  /** Extra fields merged into the error object (e.g. `activeSessionId` on a collision 409). */
  extras?: Record<string, unknown>,
): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { code, message, retryable, ...extras } }));
}

/**
 * GET /api/backlog/:product — the drawer's full-list fetch. Returns the product's parsed bugs
 * and ideas (each augmented with a server-computed `plan` action) plus file-level warnings.
 * 404 `unknown-product` when the slug isn't in the registry; 409 `not-repo-backed` when the
 * product has no repo. `planning-active` disables every item's action while a planning session
 * is open for the product — the endpoint is product-scoped, so it scans all sessions (which are
 * chatId-keyed) for one whose `planning.product` matches.
 */
function handleApiBacklog(res: ServerResponse, product: string): void {
  if (!VALID_SLUG.test(product)) {
    reject400(res, 'invalid product');
    return;
  }

  let registry: Registry | null;
  try {
    registry = readRegistry();
  } catch {
    registry = null;
  }
  const regProduct = registry?.products.find((p) => p.name === product);
  if (!registry || !regProduct) {
    sendErrorEnvelope(res, 404, 'unknown-product', `unknown product '${product}'`);
    return;
  }
  if (!regProduct.repoBacked) {
    sendErrorEnvelope(res, 409, 'not-repo-backed', `product '${product}' is not repo-backed`);
    return;
  }

  let backlogs;
  try {
    const productsConfig = readProductsConfig(config.PRODUCTS_CONFIG_FILE);
    // Synchronous read on the request fiber: sound while product repos live on local SSD. If
    // WORKSPACE_DIR is ever pointed at an iCloud-synced path, this should be deferred off the
    // event loop (a `.icloud` placeholder read would block the process) — see ReadBacklogsOpts.
    backlogs = readBacklogs(registry, productsConfig, { workspaceRoot: config.WORKSPACE_DIR });
  } catch (err) {
    log.warn('handleApiBacklog: read failed', { product, error: (err as Error).message });
    // Not retryable: a missing/malformed products.json or an unreadable backlog file does not
    // resolve on an immediate retry — it needs operator action.
    sendErrorEnvelope(res, 500, 'backlog-read-failed', 'could not read the backlog', false);
    return;
  }

  const pb = backlogs.find((b) => b.product === product);
  // A repo-backed registry product the reader didn't return is an internal inconsistency;
  // degrade to an empty backlog rather than 500 so the drawer still renders.
  const bugs = pb?.bugs ?? [];
  const ideas = pb?.ideas ?? [];
  const fileWarnings = pb?.fileWarnings ?? [];

  const planningActive = isPlanningActiveForProduct(product);

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(
    JSON.stringify({
      bugs: bugs.map((i) => withActions(i, planningActive)),
      ideas: ideas.map((i) => withActions(i, planningActive)),
      fileWarnings,
    }),
  );
}

/** The IN-PROGRESS planning session for a product (the product is scoped, but sessions are
 *  chatId-keyed, so scan all), or undefined. "In progress" mirrors `getActivePlanningSession`'s
 *  definition — terminal `approved` (awaiting/retrying scaffold) and `abandoned` don't count. The
 *  single predicate both the drawer's action-disable (`isPlanningActiveForProduct`) and the Plan
 *  collision check use, so they can't drift. */
function findActivePlanningSessionForProduct(product: string) {
  return getAllPlanningSessions().find(
    ([, s]) =>
      s.planning?.product === product &&
      s.planning.status !== 'approved' &&
      s.planning.status !== 'abandoned',
  );
}

/** True when an in-progress planning session exists for the product. */
function isPlanningActiveForProduct(product: string): boolean {
  return findActivePlanningSessionForProduct(product) !== undefined;
}

/** Relative path of each backlog file under a product repo. */
const BACKLOG_REL: Record<'bugs' | 'ideas', string> = {
  bugs: 'docs/projects/bugs.md',
  ideas: 'docs/projects/ideas.md',
};

/** Best-effort current branch + worktree-dirty status for the audit log. Never throws. The two
 *  git probes run in parallel. Captured BEFORE the write (inside the lock) so `dirty` reflects
 *  whether the repo had uncommitted work prior to Rune's append, not the always-true
 *  post-write state. */
async function getBacklogGitState(repoPath: string): Promise<{ branch: string; dirty: boolean }> {
  try {
    const [b, s] = await Promise.all([
      defaultRunGit(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoPath }),
      defaultRunGit(['status', '--porcelain'], { cwd: repoPath }),
    ]);
    return { branch: b.stdout.trim() || 'unknown', dirty: s.stdout.trim() !== '' };
  } catch {
    return { branch: 'unknown', dirty: false };
  }
}

/**
 * POST /api/backlog/:product/:kind — the drawer's `+` add. Validates product (404
 * unknown-product) and kind (404 unknown-kind), reads `{ text }`, then under a per-file mutex:
 * guards the write target, reads the current content, appends via the pure core (400 empty-text
 * / multiline-text on rejection), and atomically writes. Audit-logs every write (best-effort,
 * with git branch + dirty), then re-parses the NEW content in memory and returns the appended
 * item (`{ item }`) with its computed action. A guard rejection → 500.
 */
async function handleApiBacklogAppend(
  req: IncomingMessage,
  res: ServerResponse,
  product: string,
  kind: string,
): Promise<void> {
  if (!VALID_SLUG.test(product)) {
    reject400(res, 'invalid product');
    return;
  }
  if (kind !== 'bugs' && kind !== 'ideas') {
    sendErrorEnvelope(res, 404, 'unknown-kind', `unknown backlog kind '${kind}'`);
    return;
  }

  let registry: Registry | null;
  try {
    registry = readRegistry();
  } catch {
    registry = null;
  }
  const regProduct = registry?.products.find((p) => p.name === product);
  if (!registry || !regProduct) {
    sendErrorEnvelope(res, 404, 'unknown-product', `unknown product '${product}'`);
    return;
  }
  if (!regProduct.repoBacked) {
    sendErrorEnvelope(res, 409, 'not-repo-backed', `product '${product}' is not repo-backed`);
    return;
  }

  let text: string;
  try {
    const parsed = JSON.parse(await readBody(req));
    text = typeof parsed?.text === 'string' ? parsed.text : '';
  } catch {
    sendErrorEnvelope(res, 400, 'bad-request', 'invalid JSON body');
    return;
  }

  let repoPath: string;
  try {
    repoPath = readProductsConfig(config.PRODUCTS_CONFIG_FILE)[product]?.repoPath ?? '';
  } catch (err) {
    log.warn('handleApiBacklogAppend: products config read failed', { product, error: (err as Error).message });
    sendErrorEnvelope(res, 500, 'config-read-failed', 'could not resolve the product repo', false);
    return;
  }
  if (!repoPath) {
    sendErrorEnvelope(res, 409, 'not-repo-backed', `product '${product}' has no configured repo`);
    return;
  }

  const relFile = BACKLOG_REL[kind];
  const filePath = join(repoPath, relFile);

  // One critical section per file: guard → read → append → (capture pre-write git) → atomic
  // write, so two concurrent adds can't both read the pre-append content and clobber each other,
  // and the audited `dirty` flag reflects the repo state BEFORE this write.
  let outcome:
    | { kind: 'invalid'; error: 'empty-text' | 'multiline-text' }
    | {
        kind: 'written';
        before: string;
        after: string;
        lineNumber: number;
        git: { branch: string; dirty: boolean };
      };
  try {
    outcome = await withFileLock(filePath, async () => {
      assertBacklogWriteAllowed(repoPath, filePath);
      let before = '';
      try {
        before = readFileSync(filePath, 'utf8');
      } catch {
        before = ''; // missing file → start fresh
      }
      const appended = kind === 'bugs' ? appendBug(before, text) : appendIdea(before, text);
      if (!appended.ok) return { kind: 'invalid' as const, error: appended.error };
      const git = await getBacklogGitState(repoPath);
      writeFileAtomic(filePath, appended.content);
      return {
        kind: 'written' as const,
        before,
        after: appended.content,
        lineNumber: appended.lineNumber,
        git,
      };
    });
  } catch (err) {
    if (err instanceof BacklogWriteError) {
      log.warn('handleApiBacklogAppend: write guard rejected', { product, error: err.message });
      sendErrorEnvelope(res, 500, 'write-rejected', 'write rejected by the safety guard', false);
      return;
    }
    log.warn('handleApiBacklogAppend: append failed', { product, error: (err as Error).message });
    sendErrorEnvelope(res, 500, 'append-failed', 'could not append to the backlog', false);
    return;
  }

  if (outcome.kind === 'invalid') {
    sendErrorEnvelope(
      res,
      400,
      outcome.error,
      outcome.error === 'empty-text' ? 'text is empty' : 'text must be a single line',
    );
    return;
  }

  // Audit every write (best-effort — a logging failure must not fail the user's add). The log
  // `file` is the repo-RELATIVE path, never the absolute host path.
  try {
    appendBacklogMutationLog(config.BACKLOG_MUTATIONS_FILE, {
      product,
      file: relFile,
      branch: outcome.git.branch,
      dirty: outcome.git.dirty,
      before: outcome.before,
      after: outcome.after,
    });
  } catch (err) {
    log.warn('handleApiBacklogAppend: audit log failed', { product, error: (err as Error).message });
  }

  // Re-parse the NEW content in memory (not via readBacklogs) and find the appended item by its
  // line number — for ideas the bullet is inserted ABOVE the Loop-filed sentinel, so it is NOT
  // necessarily the last parsed item.
  const parsed = kind === 'bugs' ? parseBugs(outcome.after, relFile) : parseIdeas(outcome.after, relFile);
  const appendedItem = parsed.items.find((i) => i.source.lineNumber === outcome.lineNumber);
  const item = appendedItem ? withActions(appendedItem, isPlanningActiveForProduct(product)) : null;

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ item }));
}

// ---------------------------------------------------------------------------
// Plan-button + promotion routes (09-expand-cockpit, Phase 4)
// ---------------------------------------------------------------------------

/**
 * POST /api/backlog/:product/items/:id/plan — open a planning session seeded from an eligible
 * backlog item and create a linked durable Promotion. Returns `{ planningSessionId, promotionId }`.
 * Errors (typed envelope): 409 `stale-item` (id no longer matches an item in that product — the
 * cockpit re-fetches), 422 `item-not-eligible` (loop-filed / done / already-promoted / parse-warning
 * — the plan action is disabled), 409 `active-planning-session` (a session is already in progress
 * for the product; carries `activeSessionId` for the resume/abandon dialog). Ids are product-local,
 * so the `:product` segment disambiguates an id shared across repos.
 */
async function handleApiPlanItem(res: ServerResponse, product: string, id: string): Promise<void> {
  if (!VALID_SLUG.test(product)) {
    reject400(res, 'invalid product');
    return;
  }
  // Backlog item ids are 12-char hex (a strict subset of VALID_SLUG); a non-conforming id is
  // definitionally stale. Guard it like every other URL-segment id before it reaches a lookup/echo.
  if (!VALID_SLUG.test(id)) {
    reject400(res, 'invalid item id');
    return;
  }
  let registry: Registry | null;
  try {
    registry = readRegistry();
  } catch {
    registry = null;
  }
  const regProduct = registry?.products.find((p) => p.name === product);
  if (!registry || !regProduct) {
    sendErrorEnvelope(res, 404, 'unknown-product', `unknown product '${product}'`);
    return;
  }
  if (!regProduct.repoBacked) {
    sendErrorEnvelope(res, 409, 'not-repo-backed', `product '${product}' is not repo-backed`);
    return;
  }

  let backlogs;
  try {
    const productsConfig = readProductsConfig(config.PRODUCTS_CONFIG_FILE);
    backlogs = readBacklogs(registry, productsConfig, { workspaceRoot: config.WORKSPACE_DIR });
  } catch (err) {
    log.warn('handleApiPlanItem: backlog read failed', { product, error: (err as Error).message });
    sendErrorEnvelope(res, 500, 'backlog-read-failed', 'could not read the backlog', false);
    return;
  }

  const pb = backlogs.find((b) => b.product === product);
  // Product-LOCAL lookup: only items from the routed product, so an id shared across repos resolves
  // within this product.
  const item = [...(pb?.bugs ?? []), ...(pb?.ideas ?? [])].find((i) => i.id === id);
  if (!item) {
    // The id no longer matches an item — a stale cockpit URL. Retryable: re-fetch the drawer.
    sendErrorEnvelope(res, 409, 'stale-item', `backlog item '${id}' not found in '${product}'`, true);
    return;
  }

  // Eligibility is the item's plan action with planning-active EXCLUDED (collision is a separate,
  // more specific 409 below) — so an otherwise-eligible item still surfaces its own disabled reason.
  const planAction = withActions(item, false).actions.find((a) => a.kind === 'plan');
  if (!planAction || !planAction.enabled) {
    sendErrorEnvelope(
      res,
      422,
      'item-not-eligible',
      `item '${id}' is not eligible for Plan${planAction?.disabledReason ? ` (${planAction.disabledReason})` : ''}`,
    );
    return;
  }

  // Collision: an in-progress planning session for this product blocks a second one. Carry the
  // active session id so the cockpit can offer resume/abandon.
  const active = findActivePlanningSessionForProduct(product);
  if (active) {
    sendErrorEnvelope(
      res,
      409,
      'active-planning-session',
      `a planning session is already active for '${product}'`,
      false,
      { activeSessionId: active[1].id },
    );
    return;
  }

  // Create the durable Promotion (persisted at creation so a restart never loses it) and a linked
  // planning session whose id we generate up front so we can return + link it without a read-back.
  const planningSessionId = randomUUID();
  const seedIdea = [item.text, ...(item.body ?? [])].join('\n');
  const promotion = createPromotion({
    id: randomUUID(),
    product,
    backlogItemId: item.id,
    snapshotRaw: item.source.raw,
    planningSessionId,
    now: new Date().toISOString(),
  });
  appendPromotion(config.PROMOTIONS_FILE, promotion);
  try {
    createPlanningSession(config.TELEGRAM_USER_ID, seedIdea, 'cockpit', product, {
      id: planningSessionId,
      promotionId: promotion.id,
    });
  } catch (err) {
    // The promotion is already persisted but the session didn't open — reclaim the orphan by
    // abandoning the (still planning-started) promotion so restart-replay never chases a session
    // that will never exist.
    log.warn('handleApiPlanItem: createPlanningSession failed; abandoning orphan promotion', {
      product,
      promotionId: promotion.id,
      error: (err as Error).message,
    });
    const t = transitionPromotion(promotion, 'planning-abandoned', { now: new Date().toISOString() });
    if (t.ok) {
      try { appendPromotion(config.PROMOTIONS_FILE, t.promotion); } catch { /* best-effort cleanup */ }
    }
    sendErrorEnvelope(res, 500, 'plan-failed', 'could not open the planning session', true);
    return;
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ planningSessionId, promotionId: promotion.id }));
}

const fixAttemptQueues = new Map<string, Promise<unknown>>();

interface FixApiError {
  status: number;
  code: string;
  message: string;
  retryable?: boolean;
  attemptId?: string;
}

type FixStartResult =
  | { bug: BacklogItem; attemptId: string }
  | { error: FixApiError };

async function withFixAttemptQueue<T>(product: string, bugId: string, fn: () => Promise<T>): Promise<T> {
  const key = `${product}:${bugId}`;
  const previous = fixAttemptQueues.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(fn);
  fixAttemptQueues.set(key, next);
  try {
    return await next;
  } finally {
    if (fixAttemptQueues.get(key) === next) fixAttemptQueues.delete(key);
  }
}

function appendAttemptUpdate(attempt: Omit<FixAttempt, 'updatedAt'> & { updatedAt?: string }): void {
  appendFixAttempt(config.FIX_ATTEMPTS_FILE, {
    ...attempt,
    updatedAt: attempt.updatedAt ?? new Date().toISOString(),
  });
}

function errorDetail(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function runFixGateAttempt(product: string, bug: BacklogItem, attemptId: string): Promise<void> {
  try {
    let facts;
    try {
      facts = await runPmTechLeadBugScoping({ product, bug });
    } catch (err) {
      appendAttemptUpdate({
        attemptId,
        product,
        bugId: bug.id,
        state: 'declined',
        reason: 'pm-not-well-scoped',
        detail: `PM/TL bug scoping failed: ${errorDetail(err)}`,
      });
      return;
    }

    const gate = evaluateBugFixGate(facts);
    if (gate.decision === 'declined') {
      appendAttemptUpdate({
        attemptId,
        product,
        bugId: bug.id,
        state: 'declined',
        reason: gate.reason,
        ...(gate.detail !== undefined ? { detail: gate.detail } : {}),
      });
      return;
    }

    try {
      const handoff = await startFixRun({
        product,
        bugId: bug.id,
        scope: { bug, facts },
      });
      if (handoff.accepted === true) {
        appendAttemptUpdate({
          attemptId,
          product,
          bugId: bug.id,
          state: 'proceeding',
          runId: handoff.runId,
        });
        return;
      }
      appendAttemptUpdate({
        attemptId,
        product,
        bugId: bug.id,
        state: 'handoff-failed',
        reason: handoff.reason || 'handoff-unavailable',
        ...(handoff.detail !== undefined ? { detail: handoff.detail } : {}),
      });
    } catch (err) {
      appendAttemptUpdate({
        attemptId,
        product,
        bugId: bug.id,
        state: 'handoff-failed',
        reason: 'handoff-unavailable',
        detail: errorDetail(err),
      });
    }
  } catch (err) {
    log.error('runFixGateAttempt failed unexpectedly', {
      product,
      bugId: bug.id,
      attemptId,
      error: errorDetail(err),
    });
    try {
      appendAttemptUpdate({
        attemptId,
        product,
        bugId: bug.id,
        state: 'interrupted',
        detail: `Fix attempt failed unexpectedly: ${errorDetail(err)}`,
      });
    } catch (writeErr) {
      log.error('runFixGateAttempt could not record unexpected failure', {
        product,
        bugId: bug.id,
        attemptId,
        error: errorDetail(writeErr),
      });
    }
  }
}

function findFixableBug(
  registry: Registry,
  product: string,
  id: string,
): { bug: BacklogItem } | { error: FixApiError } {
  const regProduct = registry.products.find((p) => p.name === product);
  if (!regProduct) {
    return { error: { status: 404, code: 'unknown-product', message: `unknown product '${product}'` } };
  }
  if (!regProduct.repoBacked) {
    return { error: { status: 409, code: 'not-repo-backed', message: `product '${product}' is not repo-backed` } };
  }

  let backlogs;
  try {
    const productsConfig = readProductsConfig(config.PRODUCTS_CONFIG_FILE);
    backlogs = readBacklogs(registry, productsConfig, { workspaceRoot: config.WORKSPACE_DIR });
  } catch (err) {
    log.warn('findFixableBug: backlog read failed', { product, error: (err as Error).message });
    return {
      error: {
        status: 500,
        code: 'backlog-read-failed',
        message: 'could not read the backlog',
        retryable: false,
      },
    };
  }

  const pb = backlogs.find((b) => b.product === product);
  const item = [...(pb?.bugs ?? []), ...(pb?.ideas ?? [])].find((candidate) => candidate.id === id);
  if (!item) {
    return {
      error: {
        status: 409,
        code: 'stale-item',
        message: `backlog item '${id}' not found in '${product}'`,
        retryable: true,
      },
    };
  }

  const fix = computeFixAction(item);
  if (fix.state === 'disabled' || item.kind !== 'bugs') {
    return {
      error: {
        status: 422,
        code: 'item-not-eligible',
        message: `item '${id}' is not eligible for Fix${fix.reason ? ` (${fix.reason})` : ''}`,
      },
    };
  }
  return { bug: item };
}

async function handleApiFixItem(res: ServerResponse, product: string, id: string): Promise<void> {
  if (!VALID_SLUG.test(product)) {
    reject400(res, 'invalid product');
    return;
  }
  if (!VALID_SLUG.test(id)) {
    reject400(res, 'invalid item id');
    return;
  }

  let registry: Registry | null;
  try {
    registry = readRegistry();
  } catch {
    registry = null;
  }
  if (!registry) {
    sendErrorEnvelope(res, 500, 'registry-unavailable', 'could not read the product registry', false);
    return;
  }

  const result = await withFixAttemptQueue<FixStartResult>(product, id, async () => {
    const validation = findFixableBug(registry, product, id);
    if ('error' in validation) return validation;

    const latest = readLatestFixAttempts(config.FIX_ATTEMPTS_FILE);
    const existing = getLatestFixAttempt(latest, product, id);
    if (existing?.state === 'gating') {
      return {
        error: {
          status: 409,
          code: 'fix-already-gating',
          message: `fix attempt '${existing.attemptId}' is already gating '${id}'`,
          attemptId: existing.attemptId,
        },
      };
    }

    const attemptId = randomUUID();
    appendAttemptUpdate({
      attemptId,
      product,
      bugId: validation.bug.id,
      state: 'gating',
    });
    return { bug: validation.bug, attemptId };
  });

  if ('error' in result) {
    sendErrorEnvelope(
      res,
      result.error.status,
      result.error.code,
      result.error.message,
      result.error.retryable ?? false,
      'attemptId' in result.error ? { attemptId: result.error.attemptId } : undefined,
    );
    return;
  }

  res.writeHead(202, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ attemptId: result.attemptId }));
  void runFixGateAttempt(product, result.bug, result.attemptId);
}

/** GET /api/promotions/:id — the promotion's current state for the cockpit. 404 `unknown-promotion`. */
function handleApiPromotionGet(res: ServerResponse, id: string): void {
  if (!VALID_SLUG.test(id)) {
    reject400(res, 'invalid promotion id');
    return;
  }
  const promotion = loadPromotions(config.PROMOTIONS_FILE).get(id);
  if (!promotion) {
    sendErrorEnvelope(res, 404, 'unknown-promotion', `unknown promotion '${id}'`);
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  // Scrub absolute host paths from persisted error strings before they cross the HTTP boundary.
  res.end(JSON.stringify({
    state: promotion.state,
    slug: promotion.slug,
    errors: promotion.errors.map(scrubAbsolutePaths),
  }));
}

/**
 * POST /api/promotions/:id/retry — re-attempt the source-bullet marking for a `mark-source-error`
 * promotion (idempotent; does not re-scaffold). 404 `unknown-promotion`, 409 `not-retryable`.
 */
async function handleApiPromotionRetry(res: ServerResponse, id: string): Promise<void> {
  if (!VALID_SLUG.test(id)) {
    reject400(res, 'invalid promotion id');
    return;
  }
  const outcome = await retryPromotionMarkSource(id);
  if (!outcome.ok) {
    if (outcome.error === 'unknown-promotion') {
      sendErrorEnvelope(res, 404, 'unknown-promotion', `unknown promotion '${id}'`);
      return;
    }
    if (outcome.error === 'not-retryable') {
      sendErrorEnvelope(res, 409, 'not-retryable', `promotion '${id}' is not in a retryable state`);
      return;
    }
    sendErrorEnvelope(res, 500, 'retry-failed', scrubAbsolutePaths(outcome.message ?? 'retry failed'), false);
    return;
  }
  // The outcome carries the final state/slug/errors — no second log read needed.
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    state: outcome.state,
    slug: outcome.slug,
    errors: outcome.errors.map(scrubAbsolutePaths),
  }));
}

// ---------------------------------------------------------------------------
// Work-run record + transcript routes (project 11, Phase 5)
// ---------------------------------------------------------------------------
//
// Authenticated GET /api/work-runs/:id (run summary.json) and
// /api/work-runs/:id/transcript (raw stream-json transcript). The run id is
// VALID_SLUG-validated before any fs join — that slug guard IS the path-
// containment mechanism (a `..`- or `/`-bearing id can't match the slug
// pattern), mirroring `createTranscriptSink`. Static serving is `/static/*`-only,
// so these per-run files are reachable only through these guarded routes.

/** Upper bound on a transcript served in full. Transcripts are GC-retention
 *  bounded, but a single long run has no write-side cap, so refuse to stream an
 *  oversized one rather than tie up the response / pressure the client. */
const MAX_TRANSCRIPT_SERVE_BYTES = 50 * 1024 * 1024;
const LIVE_LOG_LINE_LIMIT = 20;

function supervisedRunTarget(run: ReturnType<typeof readAllRuns>[number]): { kind: 'project' | 'bug'; slug: string } {
  const target = (run as typeof run & { target?: { kind?: unknown; slug?: unknown } }).target;
  if (
    target &&
    (target.kind === 'project' || target.kind === 'bug') &&
    typeof target.slug === 'string'
  ) {
    return { kind: target.kind, slug: target.slug };
  }
  return { kind: 'project', slug: run.project };
}

function supervisedRunState(run: ReturnType<typeof readAllRuns>[number]): 'running' | 'parked' | 'completed' | 'failed' {
  if (run.status === 'blocked-on-human') return 'parked';
  if (run.status === 'completed') return 'completed';
  if (run.status === 'failed' || run.status === 'unknown') return 'failed';
  return 'running';
}

function elapsedSince(startedAt: string, now = Date.now()): number {
  const parsed = Date.parse(startedAt);
  return Number.isNaN(parsed) ? 0 : Math.max(0, now - parsed);
}

function agentsFromTaskRecords(records: Array<{ rolesInvoked: string[]; modelChoices?: Record<string, string> }>) {
  const seen = new Set<string>();
  const agents: Array<{ role: string; active: boolean; model?: string }> = [];
  for (const record of records) {
    for (const role of record.rolesInvoked) {
      if (seen.has(role)) continue;
      seen.add(role);
      const model = record.modelChoices?.[role];
      agents.push({
        role,
        active: true,
        ...(model !== undefined ? { model } : {}),
      });
    }
  }
  return agents;
}

function transcriptLineToLiveDisplay(line: string): { display: string[]; tasks?: { done: number; total: number } } {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(line);
  } catch {
    parsedJson = null;
  }

  if (parsedJson && typeof parsedJson === 'object' && !Array.isArray(parsedJson)) {
    const obj = parsedJson as Record<string, unknown>;
    if (obj['kind'] === 'run-event' && obj['subKind'] === 'progress') {
      const tasks = obj['tasks'];
      if (tasks && typeof tasks === 'object' && !Array.isArray(tasks)) {
        const done = (tasks as Record<string, unknown>)['done'];
        const total = (tasks as Record<string, unknown>)['total'];
        if (typeof done === 'number' && typeof total === 'number') return { display: [], tasks: { done, total } };
      }
      return { display: [] };
    }
    if ((obj['kind'] === 'output' || obj['kind'] === 'activity') && obj['data']) {
      const data = obj['data'];
      if (typeof data === 'object' && !Array.isArray(data)) {
        const text = (data as Record<string, unknown>)['line'];
        return typeof text === 'string' ? { display: text.split('\n') } : { display: [] };
      }
    }
  }

  const envelope = parseStreamJsonLine(line);
  const text = envelope ? streamJsonToDisplay(envelope) : null;
  return { display: text ? text.split('\n') : [] };
}

function readLiveTranscriptSnapshot(runId: string): { tasks: { done: number; total: number }; lastLogLines: string[] } {
  const filePath = join(config.WORK_RUNS_DIR, runId, 'transcript.jsonl');
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch {
    return { tasks: { done: 0, total: 0 }, lastLogLines: [] };
  }
  let tasks = { done: 0, total: 0 };
  const display: string[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    const next = transcriptLineToLiveDisplay(line);
    if (next.tasks) tasks = next.tasks;
    for (const displayLine of next.display) {
      if (displayLine) display.push(redactSecrets(displayLine));
    }
  }
  return { tasks, lastLogLines: display.slice(-LIVE_LOG_LINE_LIMIT) };
}

function handleApiWorkRunRecord(res: ServerResponse, id: string): void {
  if (!VALID_SLUG.test(id)) { reject400(res, 'invalid run id'); return; }
  // summary.json is a small JSON object; the synchronous read here matches the
  // existing sync-read precedent on cockpit data (handleApiCockpit).
  const summary = readWorkRunSummary(config.WORK_RUNS_DIR, id);
  if (!summary) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'work run not found' }));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(summary));
}

function handleApiWorkRunLive(res: ServerResponse, id: string): void {
  if (!VALID_SLUG.test(id)) { reject400(res, 'invalid run id'); return; }
  const run = readAllRuns(config.SUPERVISED_RUNS_FILE).find((candidate) => candidate.id === id);
  if (!run) {
    sendErrorEnvelope(res, 404, 'unknown-run', `work run '${id}' was not found`, false);
    return;
  }
  const transcript = readLiveTranscriptSnapshot(id);
  const target = supervisedRunTarget(run);
  const agents = agentsFromTaskRecords(readOrchestratedTaskRunRecords(config.WORK_RUNS_DIR, id));
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    runId: id,
    product: run.product,
    target,
    state: supervisedRunState(run),
    tasks: transcript.tasks,
    elapsedMs: elapsedSince(run.startedAt),
    worktreePath: run.operatorWorktreePath ?? worktreePathFor(run.product, target.slug, config.WORKTREE_ROOT),
    agents: agents.length > 0 ? agents : [{ role: 'coder', active: true }],
    lastLogLines: transcript.lastLogLines,
    ts: new Date().toISOString(),
  }));
}

async function handleApiWorkRunTranscript(res: ServerResponse, id: string): Promise<void> {
  if (!VALID_SLUG.test(id)) { reject400(res, 'invalid run id'); return; }
  const filePath = join(config.WORK_RUNS_DIR, id, 'transcript.jsonl');
  let st;
  try {
    st = await stat(filePath);
  } catch {
    // The run record may exist (summary.json) while no transcript was persisted
    // yet — a clean 404 the card degrades on, never a 500.
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'transcript not found' }));
    return;
  }
  if (st.size > MAX_TRANSCRIPT_SERVE_BYTES) {
    res.writeHead(413, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'transcript too large to serve' }));
    return;
  }
  // JSONL transcript → ndjson (a readable text type, not a download blob).
  // Content was already secret-redacted at persist time by createTranscriptSink.
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8' });
  const rs = createReadStream(filePath);
  try {
    await pipeline(rs, res);
  } catch {
    // Stream aborted — either the client dropped the connection, or GC deleted
    // the transcript in the window between stat() and the read (the 200 header
    // is already sent in that case; pipeline cleans up the stream regardless).
  }
}

/**
 * POST /api/work-runs/:id/release (project 13, Phase 1c). Release a PARKED
 * (`blocked-on-human`) run through the ONE shared release runtime. Optional body
 * `{ confirmDirty: true }` confirms discarding a dirty worktree. Maps the
 * surface-agnostic outcome to HTTP:
 *   - created      → 202 { mutationId } (the release mutation owns final success/failure)
 *   - dirty-confirm → 409 { error: 'dirty-worktree', files } (no mutation created)
 *   - not-parked   → 200 { released: false } (clean no-op)
 *   - error        → 500 { error }
 * The run id is VALID_SLUG-guarded before any store/worktree access.
 */
async function handleApiWorkRunRelease(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
  if (!VALID_SLUG.test(id)) { reject400(res, 'invalid run id'); return; }
  let body: { confirmDirty?: boolean } = {};
  try {
    const raw = await readBody(req);
    if (raw.trim()) body = JSON.parse(raw);
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid JSON body' }));
    return;
  }
  const opts = body.confirmDirty === true ? { confirmDirty: true } : {};
  const outcome = await requestWorkRunRelease(id, opts, defaultReleaseRequestDeps('webview'));
  switch (outcome.kind) {
    case 'created':
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ mutationId: outcome.mutationId }));
      // `id` passed VALID_SLUG above, so it's safe to log verbatim.
      logWebviewAction('work-run-release', 'success', `runId=${id}`);
      return;
    case 'dirty-confirm':
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'dirty-worktree', files: outcome.files }));
      return;
    case 'not-parked':
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ released: false, reason: 'not-parked' }));
      return;
    case 'error':
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: outcome.reason }));
      logWebviewAction('work-run-release', 'failure', 'reason=release-error');
      return;
  }
}

function productScopeFrom(value: unknown): SessionScope | undefined {
  const product = typeof value === 'string' ? value.trim() : '';
  if (!product || !VALID_SLUG.test(product)) return undefined;
  return { kind: 'product', product };
}

async function handleApiChat(req: IncomingMessage, res: ServerResponse, isReady: () => boolean): Promise<void> {
  if (!isReady()) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ready: false, reason: 'bot starting' }));
    return;
  }
  let body: { message?: string; product?: unknown } = {};
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
  const scope = productScopeFrom(body.product);
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
    if (scope) await handleWebviewMessage(capturingSender, userId, text, scope);
    else await handleWebviewMessage(capturingSender, userId, text);
  } catch (err) {
    log.error('POST /api/chat dispatch error', { error: (err as Error).message });
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'internal error' }));
    return;
  }
  const session = scope ? getSession(userId, 'webview', scope) : getSession(userId, 'webview');
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    text: chunks.join('\n\n'),
    sessionId: session?.sessionId ?? '',
    model: session?.model ?? '',
  }));
}

/** The known mutation kinds the webview action endpoint accepts. Phase 6
 *  B1.6 strict-discipline pass: validating `body.kind` against this set
 *  before it lands in the observation log's `detail` field upholds the
 *  invariant that `detail` carries only structured data — even though
 *  the endpoint is auth-gated, an unvalidated cast would let arbitrary
 *  client strings leak into the loop's sensor signal. */
const KNOWN_MUTATION_KINDS: ReadonlySet<MutationKind> = new Set([
  'work-run',
  'orchestrated-work',
  'gen-eval-loop',
  'project-edit',
  'proposal-action',
  'agent-edit',
  'cron-toggle',
]);

function safeMutationKind(raw: unknown): MutationKind | 'unknown' {
  return typeof raw === 'string' && (KNOWN_MUTATION_KINDS as ReadonlySet<string>).has(raw)
    ? (raw as MutationKind)
    : 'unknown';
}

/** Phase 6 B1.5 — log a webview action with outcome derived from whether
 *  the handler resolved without an error path. `detail` carries only the
 *  action name + structured kind/id — never request body content. */
function logWebviewAction(action: string, outcome: 'success' | 'failure', extra?: string): void {
  try {
    appendInteraction({
      ts: new Date().toISOString(),
      kind: 'webview',
      outcome,
      detail: extra ? `action=${action} ${extra}` : `action=${action}`,
    });
  } catch (err) {
    log.warn('appendInteraction failed for webview action', { action, error: (err as Error).message });
  }
}

async function handleApiMutationsCreate(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: { kind?: string; payload?: Record<string, unknown> } = {};
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid JSON body' }));
    logWebviewAction('mutation-create', 'failure', 'reason=invalid-json');
    return;
  }
  if (!body.kind) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'kind is required' }));
    logWebviewAction('mutation-create', 'failure', 'reason=missing-kind');
    return;
  }
  // Project 14 Phase 5 dispatch seam: a `work-run` Start goes through the
  // orchestrated-vs-legacy toggle. When orchestrated mode is selected the
  // request is re-routed to the `orchestrated-work` applier; otherwise it stays
  // on the legacy `/work --auto` applier as the RECORDED fallback. The resolved
  // mode + any fallback reason is stamped onto the payload so the run record and
  // cockpit expose which path ran (never a silent legacy masquerade).
  let dispatchKind = body.kind as MutationKind;
  let dispatchPayload: Record<string, unknown> = body.payload ?? {};
  if (dispatchKind === 'work-run') {
    const product = typeof dispatchPayload['product'] === 'string' ? dispatchPayload['product'] : 'rune';
    const resolution = resolveWorkDispatch(
      readDispatchModeInput({
        product,
        productsConfigPath: config.PRODUCTS_CONFIG_FILE,
        globalEnabled: config.ORCHESTRATED_WORK_ENABLED,
      }),
    );
    dispatchKind = resolution.kind;
    dispatchPayload = {
      ...dispatchPayload,
      dispatchMode: resolution.mode,
      ...(resolution.fallbackReason !== undefined ? { fallbackReason: resolution.fallbackReason } : {}),
    };
  }

  const safeKind = safeMutationKind(dispatchKind);
  const result = await createMutation(dispatchKind, dispatchPayload, 'webview');
  if (!result.ok) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: result.reason }));
    logWebviewAction('mutation-create', 'failure', `kind=${safeKind}`);
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(result.descriptor));
  logWebviewAction('mutation-create', 'success', `kind=${safeKind}`);
}

function handleApiMutationsCancel(res: ServerResponse, id: string): void {
  // The cockpit Cancel button is an explicit human action → 'user' (the
  // default, passed explicitly to distinguish it from the system backstop
  // reaps in stall-check-runner, which pass 'system').
  const result = cancelMutation(id, 'user');
  if (!result.ok) {
    res.writeHead(409, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: result.reason }));
    logWebviewAction('mutation-cancel', 'failure');
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true }));
  logWebviewAction('mutation-cancel', 'success');
}

function handleApiOpsCancel(res: ServerResponse, id: string): void {
  const ok = cancelOp(id);
  if (!ok) {
    res.writeHead(409, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'op not found or already terminal' }));
    logWebviewAction('op-cancel', 'failure');
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true }));
  logWebviewAction('op-cancel', 'success');
}

/** POST /api/server/restart — kickstart a launchd relaunch of the daemon.
 *  Production-only (the dev process has no launchd job). Responds 202 BEFORE
 *  firing the kickstart so the response flushes before launchd SIGTERMs us;
 *  the actual restart is deferred a tick via setTimeout. */
function handleApiServerRestart(res: ServerResponse): void {
  if (!config.IS_PRODUCTION) {
    res.writeHead(409, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'restart only available in production' }));
    logWebviewAction('server-restart', 'failure', 'reason=not-production');
    return;
  }
  res.writeHead(202, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true }));
  logWebviewAction('server-restart', 'success');
  setTimeout(() => { restartServer(); }, 150);
}

// ---------------------------------------------------------------------------
// Planning REST endpoints (Phase 6 C1.2)
// ---------------------------------------------------------------------------
//
// Four endpoints the cockpit planning panel calls: start a session, drive a
// turn, approve (which scaffolds via project-setup-writer), abandon. All
// auth-gated via the shared verifyAuth path in the route dispatcher; the
// handlers themselves trust the userId. Each handler maps the planning-
// session store's outcomes to HTTP status codes per the cockpit-ux.test.ts
// contract.

async function handleApiPlanningStart(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: { product?: string; idea?: string } = {};
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid JSON body' }));
    return;
  }
  if (!body.product || typeof body.product !== 'string') {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'product is required' }));
    return;
  }
  const session = createPlanningSession(
    config.TELEGRAM_USER_ID,
    body.idea ?? '',
    'cockpit',
    body.product,
  );
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ id: session.id, status: session.planning.status }));
}

async function handleApiPlanningTurn(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: { text?: string } = {};
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid JSON body' }));
    return;
  }
  const text = (body.text ?? '').trim();
  if (!text) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'text is required' }));
    return;
  }
  const userId = config.TELEGRAM_USER_ID;
  if (!getActivePlanningSession(userId)) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'no active planning session' }));
    return;
  }
  try {
    const result = await handlePlanningTurn(
      { scopingTurn: defaultScopingTurn },
      userId,
      text,
    );
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ reply: result.reply, status: result.status }));
  } catch (err) {
    log.error('handleApiPlanningTurn threw', { error: (err as Error).message });
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `planning turn error: ${(err as Error).message}` }));
  }
}

async function handleApiPlanningApprove(
  _req: IncomingMessage,
  res: ServerResponse,
  sender: WebviewSender,
): Promise<void> {
  const userId = config.TELEGRAM_USER_ID;
  const existing = getPlanningSession(userId);
  if (existing?.planning.status === 'approved') {
    await runPlanningApprovalPipeline(res, userId, existing, sender);
    return;
  }

  const result = approveActivePlanningSession(userId);
  if (!result.ok) {
    if (result.reason === 'no-session') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'no active planning session' }));
      return;
    }
    if (result.reason === 'legacy-artifact') {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: 'This planning approval uses a retired artifact shape. Please restart planning to produce a versioned pm-spec approval.',
      }));
      return;
    }
    // 'wrong-status' — session is in scoping or terminal.
    res.writeHead(409, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `cannot approve from status '${result.status}'` }));
    return;
  }

  await runPlanningApprovalPipeline(res, userId, result.session, sender);
}

type PreparedPlanningSession =
  | { ok: true; session: StoredPlanningSession }
  | { ok: false; status: number; error: string };

async function preparePlanningSessionForScaffold(
  userId: number,
  session: StoredPlanningSession,
  sender: WebviewSender,
  control: PlanningApprovalControl,
): Promise<PreparedPlanningSession> {
  if (!isPmSpecApprovalArtifact(session.planning.approvedSpec)) {
    return {
      ok: false,
      status: 409,
      error: 'This planning approval uses a retired artifact shape. Please restart planning to produce a versioned pm-spec approval.',
    };
  }
  if (session.planning.downstreamArtifact) {
    return { ok: true, session };
  }
  const downstreamArtifact = await runDownstreamPlan(session.planning.approvedSpec, {
    progress: (event) => sendPlanningProgress(sender, userId, event, control),
  });
  updatePlanningSession(userId, (sess) => ({
    ...sess,
    planning: {
      ...sess.planning,
      downstreamArtifact,
    },
  }));
  await throwIfPlanningApprovalCancelled(sender, userId, control);
  return { ok: true, session: withDownstreamArtifact(session, downstreamArtifact) };
}

async function runPlanningApprovalPipeline(
  res: ServerResponse,
  userId: number,
  session: StoredPlanningSession,
  sender: WebviewSender,
): Promise<void> {
  if (!isPmSpecApprovalArtifact(session.planning.approvedSpec)) {
    res.writeHead(409, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: 'This planning approval uses a retired artifact shape. Please restart planning to produce a versioned pm-spec approval.',
    }));
    return;
  }

  const op = registerOp({
    kind: 'agent',
    label: 'planning approval scaffold',
    userId,
    child: makeNoopChild(),
  });
  const control: PlanningApprovalControl = { opId: op?.opId, terminalSent: false };
  const status = await runPlanningApprovalPipelineWithOp(res, userId, session, sender, control);
  if (control.opId) {
    if (status.status === 'error') {
      unregisterOp(control.opId, 'error', status.error);
    } else {
      unregisterOp(control.opId, status.status);
    }
  }
}

async function runPlanningApprovalPipelineWithOp(
  res: ServerResponse,
  userId: number,
  session: StoredPlanningSession,
  sender: WebviewSender,
  control: PlanningApprovalControl,
): Promise<PlanningApprovalStatus> {
  try {
    const prepared = await preparePlanningSessionForScaffold(userId, session, sender, control);
    if (!prepared.ok) {
      res.writeHead(prepared.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: prepared.error }));
      return { status: 'error', error: scrubAbsolutePaths(prepared.error) };
    }
    return await scaffoldPlanningSession(res, userId, prepared.session, sender, control);
  } catch (err) {
    if (err instanceof PlanningApprovalCancelled) {
      res.writeHead(499, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: 'planning approval cancelled; click approve again or run /approve again to retry',
      }));
      return { status: 'cancelled' };
    }
    const failure = planningDownstreamFailure(err);
    const message = scrubAbsolutePaths((err as Error).message);
    log.error('planning approval failed', {
      userId,
      product: session.planning.product,
      stage: failure?.stage,
      retryable: failure?.retryable ?? true,
      error: message,
    });
    await sendTerminalOnce(sender, userId, control, message);
    if (isNonRetryablePmMismatch(failure)) {
      const error = formatNonRetryablePmMismatchMessage(failure);
      await sender.send(userId, error);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error }));
      return { status: 'error', error };
    }
    await sender.send(
      userId,
      'Planning session is still approved — click approve again or run /approve again to retry.',
    );
    const error = `${message}; click approve again or run /approve again to retry`;
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error }));
    return { status: 'error', error };
  }
}

function withDownstreamArtifact(
  session: StoredPlanningSession,
  downstreamArtifact: SpecArtifact,
): StoredPlanningSession {
  return {
    ...session,
    planning: {
      ...session.planning,
      downstreamArtifact,
    },
  };
}

async function scaffoldPlanningSession(
  res: ServerResponse,
  userId: number,
  session: StoredPlanningSession,
  sender: WebviewSender,
  control: PlanningApprovalControl,
): Promise<PlanningApprovalStatus> {
  // Run the shared scaffold-approval flow (resolve the target product repo, spawn the
  // setup-writer scoped to it, cross-check the scaffold-result, and drive any linked promotion).
  // Tolerate failure by leaving the session approved (retry via /approve or a re-click).
  await sendPlanningProgress(sender, userId, { stage: 'scaffold' }, control);
  const outcome = await runScaffoldApproval(session);
  if (!outcome.ok) {
    log.error('handleApiPlanningApprove: scaffold-approval failed', {
      reason: outcome.reason,
      message: outcome.message,
    });
    const message = `scaffold failed: ${outcome.message}`;
    await sendTerminalOnce(sender, userId, control, message);
    const error = `scaffolding failed: ${scrubAbsolutePaths(outcome.message)}`;
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error }));
    return { status: 'error', error: scrubAbsolutePaths(message) };
  }
  deletePlanningSession(userId);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    ok: true,
    output: outcome.agentText,
    slug: outcome.slug,
    promotion: outcome.promotion,
  }));
  await sendPlanningProgress(sender, userId, { success: outcome.agentText });
  return { status: 'success' };
}

async function sendPlanningProgress(
  sender: WebviewSender,
  userId: number,
  event: PlanningProgress,
  control?: PlanningApprovalControl,
): Promise<void> {
  if (event.stage && control?.opId && isCancelled(control.opId)) {
    await throwIfPlanningApprovalCancelled(sender, userId, control);
  }
  if (event.terminal && control) control.terminalSent = true;
  const message = formatPlanningProgress(event);
  if (!message) return;
  try {
    await sender.send(userId, scrubAbsolutePaths(message));
  } catch (err) {
    log.warn('Planning progress send failed', { userId, error: (err as Error).message });
  }
}

async function throwIfPlanningApprovalCancelled(
  sender: WebviewSender,
  userId: number,
  control: PlanningApprovalControl,
): Promise<void> {
  if (!control.opId || !isCancelled(control.opId)) return;
  await sendTerminalOnce(sender, userId, control, 'planning approval cancelled');
  await sender.send(
    userId,
    'Planning session is still approved — click approve again or run /approve again to retry.',
  );
  throw new PlanningApprovalCancelled();
}

async function sendTerminalOnce(
  sender: WebviewSender,
  userId: number,
  control: PlanningApprovalControl,
  message: string,
): Promise<void> {
  if (control.terminalSent) return;
  control.terminalSent = true;
  await sendPlanningProgress(sender, userId, { terminal: message });
}

function makeNoopChild(): Parameters<typeof registerOp>[0]['child'] {
  return { kill: () => true } as unknown as Parameters<typeof registerOp>[0]['child'];
}

function formatPlanningProgress(event: PlanningProgress): string | null {
  if (event.warning) return `Planning warning: ${event.warning}`;
  if (event.terminal) return `Planning stopped: ${event.terminal}`;
  if (event.success) return `Planning succeeded: ${event.success}`;
  if (event.stage) return `Planning progress: ${planningStageLabel(event.stage)}.`;
  return null;
}

function planningStageLabel(stage: PlanningProgressStage): string {
  switch (stage) {
    case 'tech-lead-breakdown':
      return 'tech-lead breakdown';
    case 'pm-review-match':
      return 'PM review';
    case 'claude-critique':
      return 'Claude critique';
    case 'codex-critique':
      return 'Codex critique';
    case 'context-seed':
      return 'context seed';
    case 'scaffold':
      return 'scaffold';
  }
}

function planningDownstreamFailure(err: unknown): PlanningDownstreamErrorDetails | null {
  const candidate = err as Partial<PlanningDownstreamErrorDetails> | null;
  if (!candidate || typeof candidate !== 'object') return null;
  if (typeof candidate.stage !== 'string') return null;
  if (typeof candidate.reason !== 'string') return null;
  if (typeof candidate.retryable !== 'boolean') return null;
  return {
    stage: candidate.stage as PlanningProgressStage,
    reason: scrubAbsolutePaths(candidate.reason),
    ...(Array.isArray(candidate.mismatches)
      ? { mismatches: candidate.mismatches.map((mismatch) => scrubAbsolutePaths(String(mismatch))) }
      : {}),
    retryable: candidate.retryable,
  };
}

function isNonRetryablePmMismatch(
  failure: PlanningDownstreamErrorDetails | null,
): failure is PlanningDownstreamErrorDetails {
  return failure?.stage === 'pm-review-match' && failure.retryable === false;
}

function formatNonRetryablePmMismatchMessage(failure: PlanningDownstreamErrorDetails): string {
  const mismatches = failure.mismatches?.length
    ? failure.mismatches.map((mismatch) => `- ${mismatch}`).join('\n')
    : `- ${failure.reason}`;
  return [
    'Planning session is still approved, but PM review found a structural mismatch. A blind retry is unlikely to help.',
    '',
    'Mismatches:',
    mismatches,
    '',
    'Next steps: amend the spec/DoD, or approve/add a manual live release-gate task.',
  ].join('\n');
}

function handleApiPlanningAbandon(_req: IncomingMessage, res: ServerResponse): void {
  // Idempotent: returns 200 whether or not a session was actually
  // abandoned. The cockpit's panel doesn't need to distinguish.
  abandonActivePlanningSession(config.TELEGRAM_USER_ID);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true }));
}

// ---------------------------------------------------------------------------
// Approval inbox REST endpoints (Phase 6 C2.2)
// ---------------------------------------------------------------------------
//
// Cross-source pending-approvals inbox. The cockpit reads `GET
// /api/approvals` to render rows; clicking Approve/Reject hits
// `POST /api/approvals/:id/{approve,reject}` which routes to the
// per-source actioning path (a status flip in the queue file; the
// existing nightly/post-review actioning consumes the approved
// entries).
//
// Source ids encode `<source>:<index-or-id>` so the POST endpoint can
// dispatch to the right queue without an extra lookup map.

interface ApprovalRow {
  /** Composite id: `<source>:<index-or-id>` — POST endpoints decode this. */
  id: string;
  /** Source queue: 'intent-proposal' | 'playbook' | 'ask-twice' | 'blocked-on-human'. */
  type: 'intent-proposal' | 'playbook' | 'ask-twice' | 'blocked-on-human';
  /** Short `product/project` (or just product, or product/—). */
  productProject: string;
  /** One-line human summary. */
  summary: string;
  /** Age in seconds since the entry was queued / run blocked. */
  age: number;
  /** Same as `type` — the cockpit uses this for filtering / iconography. */
  source: 'intent-proposal' | 'playbook' | 'ask-twice' | 'blocked-on-human';
}

function ageSeconds(iso: string | undefined, now: number): number {
  if (typeof iso !== 'string') return 0;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.max(0, Math.round((now - t) / 1000)) : 0;
}

function collectApprovals(): ApprovalRow[] {
  const now = Date.now();
  const rows: ApprovalRow[] = [];

  // intent-proposal-queue
  const intent = readIntentProposalQueue();
  intent.forEach((entry, i) => {
    if (entry.status !== 'pending') return;
    const p = entry.proposal;
    let productProject = '—';
    let summary = '';
    if (p.kind === 'vault-intake' || p.kind === 'roadmap' || p.kind === 'register-product') {
      productProject = p.product;
      summary = p.kind === 'vault-intake' ? p.note
        : p.kind === 'roadmap' ? p.item
        : `register product ${p.product}`;
    } else if (p.kind === 'disambiguation') {
      productProject = p.candidates.join(' / ');
      summary = p.note;
    }
    rows.push({
      id: `intent-proposal:${i}`,
      type: 'intent-proposal',
      source: 'intent-proposal',
      productProject,
      summary: summary.slice(0, 200),
      age: ageSeconds(entry.queuedAt, now),
    });
  });

  // playbook-queue
  const playbook = readPlaybookQueue();
  playbook.forEach((draft, i) => {
    if (draft.status !== 'pending') return;
    rows.push({
      id: `playbook:${i}`,
      type: 'playbook',
      source: 'playbook',
      productProject: `${draft.domain}/${draft.slug}`,
      summary: draft.entryMarkdown.split('\n')[0]?.slice(0, 200) ?? '',
      age: ageSeconds(draft.draftedAt, now),
    });
  });

  // proposal-queue (Ask-Twice)
  const askTwice = readProposalQueue();
  askTwice.forEach((proposal, i) => {
    if (proposal.status !== 'pending') return;
    rows.push({
      id: `ask-twice:${i}`,
      type: 'ask-twice',
      source: 'ask-twice',
      productProject: 'rune',
      summary: `${proposal.title} — ${proposal.rationale}`.slice(0, 200),
      age: ageSeconds(proposal.draftedAt, now),
    });
  });

  // supervision blocked-on-human runs
  try {
    const runs = readAllRuns(config.SUPERVISED_RUNS_FILE);
    const visibility = getVisibility(runs, /* heartbeatIntervalMs */ 5 * 60_000, now);
    visibility.blocked.forEach((run) => {
      rows.push({
        id: `blocked-on-human:${run.id}`,
        type: 'blocked-on-human',
        source: 'blocked-on-human',
        productProject: `${run.product}/${run.project}`,
        summary: `run ${run.id.slice(0, 8)} blocked-on-human`,
        age: ageSeconds(run.startedAt, now),
      });
    });
  } catch (err) {
    log.warn('collectApprovals: supervision read failed', { error: (err as Error).message });
  }

  return rows;
}

function handleApiApprovalsList(_req: IncomingMessage, res: ServerResponse): void {
  let rows: ApprovalRow[] = [];
  try {
    rows = collectApprovals();
  } catch (err) {
    log.error('handleApiApprovalsList failed', { error: (err as Error).message });
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'approvals list failed' }));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(rows));
}

// dispatchApprovalStatus and the per-source set*Status helpers live in
// src/server/approval-actions.ts so the Telegram callback-query handler
// (Phase 6 C6.2) can share the actioning path without importing the full
// HTTP server module.

async function handleApiApprovalAction(res: ServerResponse, id: string, status: 'approved' | 'rejected'): Promise<void> {
  // dispatchApprovalStatus became async in C8 so it can run the intent-
  // proposal consumer side-effect before flipping the queue entry.
  const result = await dispatchApprovalStatus(id, status);
  if (result === 'not-found') {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'approval not found' }));
    return;
  }
  if (result === 'error') {
    // C6 review fix: a disk-write failure inside dispatchApprovalStatus
    // now surfaces as 500 rather than masquerading as a 404 — the caller
    // can distinguish "entry not found" from "server failed to persist."
    // C8 extends this to also cover a consumer side-effect failure: when
    // the entry was approved but the consumer threw, status stays
    // pending and the caller sees 500.
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'approval action failed' }));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true }));
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

  // Cache index.html at mount time (vault name is constant at startup) —
  // only in production, where the GET / handler actually reads the cached
  // value. In dev the handler always re-reads, so the pre-load would be
  // a wasted disk read on every server start.
  let cachedIndexHtml: string | null = null;
  if (config.IS_PRODUCTION) {
    void loadIndexHtml().then(html => { cachedIndexHtml = html; }).catch(err => {
      log.warn('Could not pre-load index.html', { error: (err as Error).message });
    });
  }

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
          const frame = JSON.parse(data.toString()) as { kind?: string; text?: string; product?: unknown };
          if (frame.kind === 'message' && typeof frame.text === 'string') {
            const text = frame.text.trim();
            if (!text) return;
            const scope = productScopeFrom(frame.product);
            // Chain dispatch promises to serialise inbound frames for the same user
            const prev = dispatchQueues.get(userId) ?? Promise.resolve();
            const next = prev
              .then(() => (
                scope
                  ? handleWebviewMessage(deps.webview, userId, text, scope)
                  : handleWebviewMessage(deps.webview, userId, text)
              ))
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
      // In dev (config.IS_PRODUCTION === false) re-read index.html on every
      // request so static-markup edits show up on a plain browser refresh —
      // tsx watch only restarts on .ts changes, not on .html, so without
      // this dev-mode bypass an edit to index.html requires restarting
      // `npm run dev` to take effect. Prod serves the mount-time cache;
      // a failed pre-load falls back to a fresh read via serveIndexHtml
      // so a broken deploy returns 404 instead of crashing.
      if (config.IS_PRODUCTION && cachedIndexHtml !== null) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(cachedIndexHtml);
      } else {
        await serveIndexHtml(res);
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

      if (req.method === 'GET' && pathname === '/api/cockpit') {
        await handleApiCockpit(res);
        return true;
      }

      if (req.method === 'GET' && pathname === '/api/home') {
        handleApiHome(res);
        return true;
      }

      if (req.method === 'GET' && pathname === '/api/mcp/tools/mcp_metrics_snapshot') {
        await handleApiMcpMetricsSnapshot(res);
        return true;
      }

      const productDeepViewMatch = pathname.match(/^\/api\/products\/([^/]+)$/);
      if (req.method === 'GET' && productDeepViewMatch) {
        handleApiProductDeepView(res, decodeURIComponent(productDeepViewMatch[1]!));
        return true;
      }

      // Backlog drawer (09-expand-cockpit): GET /api/backlog/:product. The handler
      // VALID_SLUG-guards the decoded product before any registry/fs access.
      const backlogMatch = pathname.match(/^\/api\/backlog\/([^/]+)$/);
      if (req.method === 'GET' && backlogMatch) {
        handleApiBacklog(res, decodeURIComponent(backlogMatch[1]!));
        return true;
      }
      // Plan button (09-expand-cockpit): more segments than the append route, so its `$`-anchored
      // regex can't collide with the 2-segment append match — checked first for clarity.
      const fixItemMatch = pathname.match(/^\/api\/backlog\/([^/]+)\/items\/([^/]+)\/fix$/);
      if (req.method === 'POST' && fixItemMatch) {
        await handleApiFixItem(
          res,
          decodeURIComponent(fixItemMatch[1]!),
          decodeURIComponent(fixItemMatch[2]!),
        );
        return true;
      }
      const planItemMatch = pathname.match(/^\/api\/backlog\/([^/]+)\/items\/([^/]+)\/plan$/);
      if (req.method === 'POST' && planItemMatch) {
        await handleApiPlanItem(
          res,
          decodeURIComponent(planItemMatch[1]!),
          decodeURIComponent(planItemMatch[2]!),
        );
        return true;
      }
      const backlogAppendMatch = pathname.match(/^\/api\/backlog\/([^/]+)\/([^/]+)$/);
      if (req.method === 'POST' && backlogAppendMatch) {
        await handleApiBacklogAppend(
          req,
          res,
          decodeURIComponent(backlogAppendMatch[1]!),
          decodeURIComponent(backlogAppendMatch[2]!),
        );
        return true;
      }

      // Promotion job routes (09-expand-cockpit): retry (more specific) before the record GET.
      const promotionRetryMatch = pathname.match(/^\/api\/promotions\/([^/]+)\/retry$/);
      if (req.method === 'POST' && promotionRetryMatch) {
        await handleApiPromotionRetry(res, decodeURIComponent(promotionRetryMatch[1]!));
        return true;
      }
      const promotionGetMatch = pathname.match(/^\/api\/promotions\/([^/]+)$/);
      if (req.method === 'GET' && promotionGetMatch) {
        handleApiPromotionGet(res, decodeURIComponent(promotionGetMatch[1]!));
        return true;
      }

      // Work-run live snapshot/transcript (more specific) then record. These regexes are
      // `$`-anchored, so the record pattern can't match a sub-path like
      // `/:id/transcript` — order is for clarity, not correctness. A future
      // sub-path (e.g. `/forensics`) must be added before the record check.
      // decodeURIComponent matches the other id-bearing routes; the handlers
      // VALID_SLUG-guard the decoded id before any fs access.
      const workRunLiveMatch = pathname.match(/^\/api\/work-runs\/([^/]+)\/live$/);
      if (req.method === 'GET' && workRunLiveMatch) {
        handleApiWorkRunLive(res, decodeURIComponent(workRunLiveMatch[1]!));
        return true;
      }
      const workRunTranscriptMatch = pathname.match(/^\/api\/work-runs\/([^/]+)\/transcript$/);
      if (req.method === 'GET' && workRunTranscriptMatch) {
        await handleApiWorkRunTranscript(res, decodeURIComponent(workRunTranscriptMatch[1]!));
        return true;
      }
      const workRunRecordMatch = pathname.match(/^\/api\/work-runs\/([^/]+)$/);
      if (req.method === 'GET' && workRunRecordMatch) {
        handleApiWorkRunRecord(res, decodeURIComponent(workRunRecordMatch[1]!));
        return true;
      }
      // Release a parked work-run (project 13, Phase 1c).
      const workRunReleaseMatch = pathname.match(/^\/api\/work-runs\/([^/]+)\/release$/);
      if (req.method === 'POST' && workRunReleaseMatch) {
        await handleApiWorkRunRelease(req, res, decodeURIComponent(workRunReleaseMatch[1]!));
        return true;
      }

      if (req.method === 'POST' && pathname === '/api/chat') {
        await handleApiChat(req, res, deps.isReady);
        return true;
      }

      if (req.method === 'POST' && pathname === '/api/mutations') {
        await handleApiMutationsCreate(req, res);
        return true;
      }

      const cancelMatch = pathname.match(/^\/api\/mutations\/([^/]+)\/cancel$/);
      if (req.method === 'POST' && cancelMatch) {
        // decodeURIComponent matches the client (`encodeURIComponent` in
        // app.js) and the convention used by the approval endpoints below.
        // Today's mutation ids are randomUUIDs (no percent-encoding needed),
        // but consistent decoding keeps the contract resilient if the id
        // format ever changes.
        handleApiMutationsCancel(res, decodeURIComponent(cancelMatch[1]!));
        return true;
      }

      const opCancelMatch = pathname.match(/^\/api\/ops\/([^/]+)\/cancel$/);
      if (req.method === 'POST' && opCancelMatch) {
        handleApiOpsCancel(res, opCancelMatch[1]!);
        return true;
      }

      if (req.method === 'POST' && pathname === '/api/server/restart') {
        handleApiServerRestart(res);
        return true;
      }

      // Planning panel endpoints (Phase 6 C1.2)
      if (req.method === 'POST' && pathname === '/api/planning/start') {
        await handleApiPlanningStart(req, res);
        return true;
      }
      if (req.method === 'POST' && pathname === '/api/planning/turn') {
        await handleApiPlanningTurn(req, res);
        return true;
      }
      if (req.method === 'POST' && pathname === '/api/planning/approve') {
        await handleApiPlanningApprove(req, res, deps.webview);
        return true;
      }
      if (req.method === 'POST' && pathname === '/api/planning/abandon') {
        handleApiPlanningAbandon(req, res);
        return true;
      }

      // Approval inbox endpoints (Phase 6 C2.2)
      if (req.method === 'GET' && pathname === '/api/approvals') {
        handleApiApprovalsList(req, res);
        return true;
      }
      const approveMatch = pathname.match(/^\/api\/approvals\/([^/]+)\/approve$/);
      if (req.method === 'POST' && approveMatch) {
        // handleApiApprovalAction is async (C8) — fire-and-forget here,
        // it writes its own response. Wrap in .catch so an unhandled
        // promise rejection from the consumer can't escape the listener.
        void handleApiApprovalAction(res, decodeURIComponent(approveMatch[1]!), 'approved')
          .catch((err: unknown) => log.error('handleApiApprovalAction approve threw', { error: (err as Error).message }));
        return true;
      }
      const rejectMatch = pathname.match(/^\/api\/approvals\/([^/]+)\/reject$/);
      if (req.method === 'POST' && rejectMatch) {
        void handleApiApprovalAction(res, decodeURIComponent(rejectMatch[1]!), 'rejected')
          .catch((err: unknown) => log.error('handleApiApprovalAction reject threw', { error: (err as Error).message }));
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
