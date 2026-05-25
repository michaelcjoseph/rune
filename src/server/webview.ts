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
import { readRegistry, type Registry } from '../intent/registry.js';
import { buildCockpitView } from '../intent/cockpit.js';
import { getSession } from '../vault/sessions.js';
import { createLogger } from '../utils/logger.js';
import type { WebviewSender } from '../transport/webview-sender.js';
import { handleWebviewMessage } from './webview-bootstrap.js';
import { createMutation, cancelMutation } from '../transport/mutations.js';
import type { MutationKind } from '../transport/mutations.js';
import { cancelOp } from '../transport/in-flight.js';
import { readCockpitRunStatus } from './cockpit-run-status.js';
import { appendInteraction } from '../utils/observation-log.js';
import {
  createPlanningSession,
  getActivePlanningSession,
  deletePlanningSession,
  approveActivePlanningSession,
  abandonActivePlanningSession,
} from '../reviews/planning.js';
import { handlePlanningTurn, defaultScopingTurn } from '../reviews/planning-handler.js';
import { buildSetupWriterBrief } from '../intent/planner.js';
import { runAgent } from '../ai/claude.js';
import { readIntentProposalQueue } from '../intent/intent-proposal-queue.js';
import { readProposalQueue } from '../jobs/proposal-queue.js';
import { readAllRuns } from '../jobs/supervision-store.js';
import { getVisibility } from '../intent/supervision.js';
import { readPlaybookQueue } from '../jobs/playbook-extract.js';
import { dispatchApprovalStatus } from '../transport/approval-actions.js';

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

function handleApiCockpit(res: ServerResponse): void {
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
  const view = buildCockpitView(registry, runStatus);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(view));
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
  const session = getSession(userId, 'webview');
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
  const safeKind = safeMutationKind(body.kind);
  const result = await createMutation(body.kind as MutationKind, body.payload ?? {}, 'webview');
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
  const result = cancelMutation(id);
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

async function handleApiPlanningApprove(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const userId = config.TELEGRAM_USER_ID;
  const result = approveActivePlanningSession(userId);
  if (!result.ok) {
    if (result.reason === 'no-session') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'no active planning session' }));
      return;
    }
    // 'wrong-status' — session is in scoping or terminal.
    res.writeHead(409, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `cannot approve from status '${result.status}'` }));
    return;
  }

  // Approved — scaffold via project-setup-writer (A4.4 pattern). Tolerate
  // agent failure by leaving the session in approved state (retry via the
  // /approve slash path or a re-click here will pick it up).
  const brief = buildSetupWriterBrief(result.session.planning);
  const agentResult = await runAgent('project-setup-writer', brief);
  if (agentResult.error || !agentResult.text) {
    log.error('handleApiPlanningApprove: project-setup-writer failed', {
      error: agentResult.error ?? 'empty output',
    });
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: `scaffolding failed: ${agentResult.error ?? 'empty output'}`,
    }));
    return;
  }
  deletePlanningSession(userId);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, output: agentResult.text }));
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
      productProject: 'jarvis',
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

function handleApiApprovalAction(res: ServerResponse, id: string, status: 'approved' | 'rejected'): void {
  const result = dispatchApprovalStatus(id, status);
  if (result === 'not-found') {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'approval not found' }));
    return;
  }
  if (result === 'error') {
    // C6 review fix: a disk-write failure inside dispatchApprovalStatus
    // now surfaces as 500 rather than masquerading as a 404 — the caller
    // can distinguish "entry not found" from "server failed to persist."
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'approval write failed' }));
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

      if (req.method === 'GET' && pathname === '/api/cockpit') {
        handleApiCockpit(res);
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
        await handleApiPlanningApprove(req, res);
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
        handleApiApprovalAction(res, decodeURIComponent(approveMatch[1]!), 'approved');
        return true;
      }
      const rejectMatch = pathname.match(/^\/api\/approvals\/([^/]+)\/reject$/);
      if (req.method === 'POST' && rejectMatch) {
        handleApiApprovalAction(res, decodeURIComponent(rejectMatch[1]!), 'rejected');
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
