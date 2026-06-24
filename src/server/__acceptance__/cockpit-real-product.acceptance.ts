#!/usr/bin/env tsx
/**
 * Cockpit Redesign Phase 7 - LIVE real-product acceptance for Jarvis itself.
 *
 * This is deliberately not a Vitest unit test. It drives the authenticated
 * local Jarvis cockpit over HTTP/WebSocket against the real `jarvis` product,
 * with no mocked projections, no mocked PM/TL gate, and no mocked realtime run
 * feed. The deferred Fix autorun hand-off is the only acceptable seam.
 *
 * Required:
 *   JARVIS_HTTP_SECRET=<local cockpit secret>
 *   JARVIS_ACCEPTANCE_MUTATE_REAL_JARVIS=1
 *
 * Optional:
 *   JARVIS_ACCEPTANCE_BASE_URL=http://127.0.0.1:3847
 *   JARVIS_ACCEPTANCE_PRODUCT=jarvis
 *   JARVIS_ACCEPTANCE_PROJECT=17-cockpit-redesign
 *   JARVIS_ACCEPTANCE_TIMEOUT_MS=7200000
 *
 * Exit 0 means the real cockpit passed the Phase 7 walkthrough. Exit non-zero
 * names the first contract breach.
 */
import { setTimeout as sleep } from 'node:timers/promises';
import { WebSocket } from 'ws';

type Json = Record<string, unknown>;

const BASE_URL = env('JARVIS_ACCEPTANCE_BASE_URL', 'http://127.0.0.1:3847').replace(/\/$/, '');
const SECRET = env('JARVIS_HTTP_SECRET');
const PRODUCT = env('JARVIS_ACCEPTANCE_PRODUCT', 'jarvis');
const PROJECT = env('JARVIS_ACCEPTANCE_PROJECT', '17-cockpit-redesign');
const TIMEOUT_MS = Number(env('JARVIS_ACCEPTANCE_TIMEOUT_MS', String(2 * 60 * 60 * 1000)));
const MUTATE_REAL_JARVIS = process.env['JARVIS_ACCEPTANCE_MUTATE_REAL_JARVIS'] === '1';
const FIXTURE_TAG = `cockpit-phase7-${Date.now().toString(36)}`;

class AcceptanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AcceptanceError';
  }
}

function env(name: string, fallback?: string): string {
  const value = process.env[name] || fallback;
  if (!value) throw new AcceptanceError(`missing ${name}`);
  return value;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new AcceptanceError(message);
}

function assertNoStubLanguage(value: unknown, context: string): void {
  const text = JSON.stringify(value);
  assert(!/\b(stub|mock|fake|fixture-only)\b/i.test(text), `${context} exposed stub/mock language`);
}

function log(stage: string, message: string): void {
  console.log(`[cockpit-real:${stage}] ${message}`);
}

async function request(
  method: string,
  path: string,
  body?: unknown,
  expected: number | number[] = 200,
): Promise<{ status: number; body: unknown; text: string }> {
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${SECRET}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const parsed = (() => {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  })();
  const allowed = Array.isArray(expected) ? expected : [expected];
  assert(
    allowed.includes(response.status),
    `${method} ${path} returned ${response.status}, expected ${allowed.join('/')} body=${text.slice(0, 500)}`,
  );
  return { status: response.status, body: parsed, text };
}

async function poll<T>(
  label: string,
  fn: () => Promise<T | null | undefined | false>,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<T> {
  const deadline = Date.now() + (opts.timeoutMs ?? 120_000);
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (err) {
      lastError = err;
    }
    await sleep(opts.intervalMs ?? 2_000);
  }
  throw new AcceptanceError(
    `timed out waiting for ${label}${lastError ? ` (${(lastError as Error).message})` : ''}`,
  );
}

function asRecord(value: unknown, label: string): Json {
  assert(value && typeof value === 'object' && !Array.isArray(value), `${label} is not an object`);
  return value as Json;
}

function asArray(value: unknown, label: string): unknown[] {
  assert(Array.isArray(value), `${label} is not an array`);
  return value;
}

function productFromPulse(pulse: Json, product: string): Json {
  const products = asArray(pulse.products, 'HomePulse.products').map((p) => asRecord(p, 'HomeProductPulse'));
  const found = products.find((p) => p.name === product);
  assert(found, `HomePulse does not include product '${product}'`);
  return found;
}

async function assertHomeAndDeepView(): Promise<Json> {
  log('home', 'checking cross-product pulse');
  const home = asRecord((await request('GET', '/api/home')).body, 'HomePulse');
  assert(home.available === true, `HomePulse unavailable: ${String(home.unavailableReason ?? '')}`);
  const products = asArray(home.products, 'HomePulse.products').map((p) => asRecord(p, 'HomeProductPulse'));
  assert(products.length > 0, 'HomePulse must contain at least one product');
  const names = new Set<string>();
  for (const product of products) {
    assert(typeof product.name === 'string' && product.name.length > 0, 'HomeProductPulse.name is required');
    assert(!names.has(product.name), `duplicate HomeProductPulse '${product.name}'`);
    names.add(product.name);
    assert(typeof product.repoBacked === 'boolean', `${product.name}.repoBacked must be boolean`);
    const counts = asRecord(product.counts, `${product.name}.counts`);
    for (const key of ['activeProjects', 'openBugs', 'openIdeas', 'backlogWarnings']) {
      assert(Number.isFinite(counts[key]), `${product.name}.counts.${key} must be numeric`);
    }
    if (product.mostRecentRun) {
      const outcome = asRecord(product.mostRecentRun, `${product.name}.mostRecentRun`).outcome;
      assert(['completed', 'no-op', 'partial', 'failed'].includes(String(outcome)), `${product.name} has invalid terminal outcome ${String(outcome)}`);
      assert(outcome !== 'parked', `${product.name} leaked parked as a terminal outcome`);
    }
  }
  const jarvisPulse = productFromPulse(home, PRODUCT);
  assert(jarvisPulse.repoBacked === true, `${PRODUCT} must be repo-backed for real-product acceptance`);

  log('product', `checking deep view for ${PRODUCT}`);
  const view = asRecord((await request('GET', `/api/products/${encodeURIComponent(PRODUCT)}`)).body, 'ProductDeepView');
  assert(view.name === PRODUCT, `deep view returned ${String(view.name)} instead of ${PRODUCT}`);
  assert(view.repoBacked === true, `${PRODUCT} deep view unexpectedly limited`);
  for (const key of ['projects', 'runs']) asArray(view[key], `ProductDeepView.${key}`);
  const backlog = asRecord(view.backlog, 'ProductDeepView.backlog');
  asArray(backlog.bugs, 'ProductDeepView.backlog.bugs');
  asArray(backlog.ideas, 'ProductDeepView.backlog.ideas');
  asArray(backlog.warnings, 'ProductDeepView.backlog.warnings');

  const nonRepo = products.find((p) => p.repoBacked === false);
  if (nonRepo) {
    log('product', `checking limited-state product ${String(nonRepo.name)}`);
    const limited = asRecord(
      (await request('GET', `/api/products/${encodeURIComponent(String(nonRepo.name))}`)).body,
      'limited ProductDeepView',
    );
    assert(limited.repoBacked === false, 'non-repo-backed product must return limited ProductDeepView');
    assert(typeof limited.limitedReason === 'string' && limited.limitedReason.length > 0, 'limited ProductDeepView needs limitedReason');
    assert(asArray(limited.projects, 'limited.projects').length === 0, 'limited ProductDeepView must have no projects surface');
    assert(asArray(asRecord(limited.backlog, 'limited.backlog').bugs, 'limited bugs').length === 0, 'limited ProductDeepView must have no bugs');
  }
  return view;
}

async function assertUiReachability(): Promise<void> {
  log('ia', 'checking Home/deep-view client entrypoints and controls are reachable');
  const html = (await request('GET', '/', undefined, 200)).text;
  assert(html.includes('/static/client-view.js'), 'index.html must load the new cockpit client-view module');
  assert(html.includes('meta name="is-production"'), 'index.html must expose production restart metadata');
  const homeJs = (await request('GET', '/static/home-view.js', undefined, 200)).text;
  const productJs = (await request('GET', '/static/product-deep-view.js', undefined, 200)).text;
  for (const needle of ['/api/home', '/api/approvals', '/api/server/restart', 'data-home-operational-rail']) {
    assert(homeJs.includes(needle), `Home IA missing ${needle}`);
  }
  for (const needle of [
    '/api/products/',
    '/api/work-runs/',
    '/api/chat',
    'data-fix-item-id',
    'data-plan-item-id',
    'data-cancel-op-id',
    'data-cancel-mutation-id',
    'data-search-scope="repo+vault"',
    '/fresh-full',
  ]) {
    assert(productJs.includes(needle), `Product IA missing ${needle}`);
  }
}

async function appendBacklog(kind: 'bugs' | 'ideas', text: string): Promise<Json> {
  const body = asRecord(
    (await request('POST', `/api/backlog/${encodeURIComponent(PRODUCT)}/${kind}`, { text })).body,
    'backlog append response',
  );
  const item = asRecord(body.item, 'appended backlog item');
  assert(typeof item.id === 'string' && item.id.length > 0, `appended ${kind} item needs id`);
  return item;
}

async function assertBacklogAndPlan(): Promise<void> {
  log('backlog', 'checking v1 backlog read/append and Plan path');
  const backlog = asRecord((await request('GET', `/api/backlog/${encodeURIComponent(PRODUCT)}`)).body, 'backlog');
  asArray(backlog.bugs, 'backlog.bugs');
  asArray(backlog.ideas, 'backlog.ideas');

  const idea = await appendBacklog('ideas', `Acceptance Plan probe ${FIXTURE_TAG}`);
  const planId = String(idea.id);
  const plan = asRecord(
    (await request('POST', `/api/backlog/${encodeURIComponent(PRODUCT)}/items/${encodeURIComponent(planId)}/plan`)).body,
    'Plan response',
  );
  assert(typeof plan.planningSessionId === 'string' && plan.planningSessionId.length > 0, 'Plan must return planningSessionId');
  assert(typeof plan.promotionId === 'string' && plan.promotionId.length > 0, 'Plan must return promotionId');
  await request('POST', '/api/planning/abandon', { product: PRODUCT }, [200, 204]);
}

async function assertFixGatePersists(): Promise<void> {
  log('fix', 'checking real PM/TL gate decline and persisted reload state');
  const bug = await appendBacklog('bugs', `Acceptance vague broken thing ${FIXTURE_TAG}`);
  const bugId = String(bug.id);
  const accepted = asRecord(
    (await request('POST', `/api/backlog/${encodeURIComponent(PRODUCT)}/items/${encodeURIComponent(bugId)}/fix`, undefined, 202)).body,
    'Fix 202 response',
  );
  assert(typeof accepted.attemptId === 'string' && accepted.attemptId.length > 0, 'Fix must return attemptId');

  const finalAction = await poll<Json>('Fix gate terminal state', async () => {
    const view = asRecord((await request('GET', `/api/products/${encodeURIComponent(PRODUCT)}`)).body, 'ProductDeepView');
    const bugs = asArray(asRecord(view.backlog, 'backlog').bugs, 'bugs').map((item) => asRecord(item, 'bug'));
    const current = bugs.find((item) => item.id === bugId);
    if (!current) throw new AcceptanceError(`Fix bug ${bugId} disappeared before decision`);
    const fix = asRecord(current.fix, 'bug.fix');
    return fix.state === 'gating' ? null : fix;
  }, { timeoutMs: 20 * 60 * 1000, intervalMs: 5_000 });

  assert(
    ['declined', 'handoff-failed', 'proceeding'].includes(String(finalAction.state)),
    `Fix ended in invalid state ${String(finalAction.state)}`,
  );
  assert(
    finalAction.state === 'declined',
    `the deliberately vague acceptance bug must be declined by the real PM/TL gate, got ${String(finalAction.state)}`,
  );
  assert(
    ['ineligible', 'incomplete-fields', 'pm-not-well-scoped', 'tech-lead-objection'].includes(String(finalAction.reason)),
    `Fix decline reason is not gate vocabulary: ${String(finalAction.reason)}`,
  );
  assertNoStubLanguage(finalAction, 'Fix gate result');

  const reloaded = asRecord((await request('GET', `/api/products/${encodeURIComponent(PRODUCT)}`)).body, 'reloaded ProductDeepView');
  const persisted = asArray(asRecord(reloaded.backlog, 'reloaded backlog').bugs, 'reloaded bugs')
    .map((item) => asRecord(item, 'bug'))
    .find((item) => item.id === bugId);
  assert(persisted, 'Fix decision did not survive a product-view reload');
  assert(asRecord(persisted.fix, 'persisted fix').state === 'declined', 'persisted Fix state changed after reload');
}

async function openRunSocket(): Promise<{ ws: WebSocket; events: Json[]; close: () => void }> {
  const wsUrl = BASE_URL.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:') + '/api/ws';
  const ws = new WebSocket(wsUrl, { headers: { authorization: `Bearer ${SECRET}` } });
  const events: Json[] = [];
  ws.on('message', (data) => {
    try {
      events.push(JSON.parse(String(data)) as Json);
    } catch {
      // Ignore non-JSON frames; the cockpit contract is JSON.
    }
  });
  await new Promise<void>((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  return {
    ws,
    events,
    close: () => ws.close(),
  };
}

async function assertRealtimeRunAndMutationCancel(): Promise<void> {
  log('run', `starting real work run for ${PRODUCT}/${PROJECT}`);
  const socket = await openRunSocket();
  try {
    const descriptor = asRecord(
      (await request('POST', '/api/mutations', {
        kind: 'work-run',
        payload: { product: PRODUCT, projectSlug: PROJECT },
      })).body,
      'mutation descriptor',
    );
    const runId = String(descriptor.id);
    assert(runId.length > 0, 'mutation descriptor needs id');

    const live = await poll<Json>('live run snapshot with task/agent/log data', async () => {
      const snapshot = asRecord(
        (await request('GET', `/api/work-runs/${encodeURIComponent(runId)}/live`, undefined, [200, 404])).body,
        'LiveRunSnapshot',
      );
      if ('error' in snapshot) return null;
      const tasks = asRecord(snapshot.tasks, 'live.tasks');
      const agents = asArray(snapshot.agents, 'live.agents');
      const logs = asArray(snapshot.lastLogLines, 'live.lastLogLines');
      if (!Number.isFinite(tasks.total) || Number(tasks.total) <= 0) return null;
      if (agents.length === 0) return null;
      if (logs.length === 0) return null;
      return snapshot;
    }, { timeoutMs: 30 * 60 * 1000, intervalMs: 5_000 });

    assert(typeof live.worktreePath === 'string' && live.worktreePath.length > 0, 'live run must expose worktreePath');
    assert(asArray(live.agents, 'live.agents').length > 0, 'live run must expose agents-on-run');
    assert(asArray(live.lastLogLines, 'live.lastLogLines').length > 0, 'live run must expose readable logs');
    assertNoStubLanguage(live, 'LiveRunSnapshot');

    await poll('WebSocket run-event frame', async () => {
      return socket.events.find((event) => event.kind === 'run-event' && event.runId === runId) ?? null;
    }, { timeoutMs: 120_000, intervalMs: 1_000 });

    const cancel = await request('POST', `/api/mutations/${encodeURIComponent(runId)}/cancel`, undefined, [200, 409]);
    assert(cancel.status === 200, `mutation cancel route did not cancel the active run: ${cancel.text}`);
  } finally {
    socket.close();
  }
}

async function assertChatAndOpCancel(): Promise<void> {
  log('chat', 'checking product-scoped chat, repo+vault search, and command lifecycle');
  const chatPromise = request('POST', '/api/chat', {
    product: PRODUCT,
    message: `Search repo and vault for cockpit acceptance ${FIXTURE_TAG}`,
  }, [200, 500]);

  const op = await poll<Json>('in-flight product chat op', async () => {
    const state = asRecord((await request('GET', '/api/state')).body, 'state');
    return asArray(state.inFlight, 'state.inFlight')
      .map((item) => asRecord(item, 'op'))
      .find((item) => item.kind !== 'classifier') ?? null;
  }, { timeoutMs: 60_000, intervalMs: 500 });
  assert(typeof op.opId === 'string' && op.opId.length > 0, 'in-flight op needs opId');
  const cancel = await request('POST', `/api/ops/${encodeURIComponent(String(op.opId))}/cancel`, undefined, [200, 409]);
  assert(cancel.status === 200, `op cancel route did not cancel the active chat op: ${cancel.text}`);
  await chatPromise.catch(() => undefined);

  const turn = asRecord(
    (await request('POST', '/api/chat', {
      product: PRODUCT,
      message: `Acceptance product chat turn ${FIXTURE_TAG}: answer with one sentence.`,
    })).body,
    'chat response',
  );
  assert(typeof turn.sessionId === 'string' && turn.sessionId.length > 0, 'product chat turn must create a product-scoped session');
  await request('POST', '/api/chat', { product: PRODUCT, message: '/fresh-full' }, 200);
  await request('POST', '/api/chat', { product: PRODUCT, message: `Acceptance fresh probe ${FIXTURE_TAG}` }, 200);
  await request('POST', '/api/chat', { product: PRODUCT, message: '/fresh' }, 200);
  await request('POST', '/api/chat', { product: PRODUCT, message: '/clear' }, 200);
}

async function assertOperationalRail(): Promise<void> {
  log('ops', 'checking approvals, parked-run release affordance, and restart route');
  const approvals = asArray((await request('GET', '/api/approvals')).body, 'approvals');
  const parked = approvals.map((item) => asRecord(item, 'approval')).find((item) =>
    String(item.id ?? '').startsWith('blocked-on-human:') || String(item.type ?? item.source ?? '').includes('blocked-on-human')
  );
  assert(parked, 'acceptance requires a pending parked-run release approval in the operational rail');
  const parkedId = String(parked.id);
  const reject = await request('POST', `/api/approvals/${encodeURIComponent(parkedId)}/reject`, undefined, [200, 404, 409, 500]);
  assert(reject.status === 200, `parked-run release reject route was not working: ${reject.text}`);

  const restart = await request('POST', '/api/server/restart', undefined, [202, 409]);
  assert([202, 409].includes(restart.status), 'restart route must be reachable');
}

async function main(): Promise<void> {
  assert(MUTATE_REAL_JARVIS, 'set JARVIS_ACCEPTANCE_MUTATE_REAL_JARVIS=1 to run the real-product mutating acceptance');
  assert(Number.isFinite(TIMEOUT_MS) && TIMEOUT_MS > 0, 'JARVIS_ACCEPTANCE_TIMEOUT_MS must be a positive number');

  const deadline = Date.now() + TIMEOUT_MS;
  const remaining = () => Math.max(1, deadline - Date.now());

  await poll('Jarvis cockpit server', async () => {
    const health = await fetch(`${BASE_URL}/health`).catch(() => null);
    return health?.ok ? true : null;
  }, { timeoutMs: 30_000, intervalMs: 1_000 });

  await assertUiReachability();
  await assertHomeAndDeepView();
  await assertBacklogAndPlan();
  await assertFixGatePersists();
  assert(Date.now() < deadline, 'acceptance timeout reached before realtime run');
  await poll('realtime run + mutation cancel', async () => {
    await assertRealtimeRunAndMutationCancel();
    return true;
  }, { timeoutMs: remaining(), intervalMs: 1_000 });
  await assertChatAndOpCancel();
  await assertOperationalRail();

  log('pass', `Phase 7 real-product acceptance passed for ${PRODUCT}/${PROJECT}`);
}

main().catch((err) => {
  console.error(err instanceof AcceptanceError ? err.message : err);
  process.exit(1);
});
