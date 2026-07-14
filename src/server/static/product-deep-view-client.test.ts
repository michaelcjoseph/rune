import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Listener = (event?: any) => unknown;
const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const WORKSPACE_ROOT = process.env.RUNE_WORKSPACE_DIR || PROJECT_ROOT;
const LIVE_WORKTREE_PATH = join(WORKSPACE_ROOT, '.worktrees', 'aura', '17-cockpit-redesign');

function makeRoot() {
  let html = '';
  const listeners = new Map<string, Set<Listener>>();
  const chatTranscript = {
    scrollTop: 0,
    scrollHeight: 1000,
    clientHeight: 200,
    scrollIntoView: vi.fn(),
  };
  const chatSurface = { scrollIntoView: vi.fn() };
  const chatInput = { value: '', focus: vi.fn() };
  // Models a real outerHTML replacement of the self-contained monitoring
  // <section> (no nested <section>, so the first following </section> closes it).
  // Splicing html directly — instead of going through the root innerHTML setter —
  // mirrors the production scoped repaint: the rest of the tree, including the
  // chat composer, is left untouched (chatInput.value is NOT reset).
  const monitoringNode = {
    scrollIntoView: vi.fn(),
    set outerHTML(next: string) {
      const attrIdx = html.indexOf('data-surface="monitoring"');
      if (attrIdx === -1) return;
      const openIdx = html.lastIndexOf('<section', attrIdx);
      const closeIdx = html.indexOf('</section>', attrIdx);
      if (openIdx === -1 || closeIdx === -1) return;
      html = html.slice(0, openIdx) + next + html.slice(closeIdx + '</section>'.length);
    },
  };
  const emit = async (type: string, event: unknown) => {
    const handlers = Array.from(listeners.get(type) ?? []);
    await Promise.all(handlers.map(listener => listener(event)));
  };
  return {
    get innerHTML() {
      return html;
    },
    set innerHTML(next: string) {
      html = next;
      // Mirror the real DOM: replacing innerHTML produces a fresh transcript and
      // composer node, so the scroll position and any typed text are reset. The
      // view's render() must explicitly re-apply them.
      if (next.includes('data-product-chat-transcript')) chatTranscript.scrollTop = 0;
      if (next.includes('data-product-chat-form')) chatInput.value = '';
    },
    chatTranscript,
    chatSurface,
    chatInput,
    querySelector: vi.fn((selector: string) => {
      if (selector === '[data-product-chat-transcript]') {
        return html.includes('data-product-chat-transcript') ? chatTranscript : null;
      }
      if (selector === '[data-surface="chat"]') return chatSurface;
      if (selector === '[data-product-chat-form] [name="message"]') return chatInput;
      if (selector === '[data-surface="runs"]') return { scrollIntoView: vi.fn() };
      if (selector === '[data-surface="projects"]') return { scrollIntoView: vi.fn() };
      if (selector === '[data-surface="bugs"]') return { scrollIntoView: vi.fn() };
      if (selector === '[data-surface="ideas"]') return { scrollIntoView: vi.fn() };
      if (selector === '[data-surface="monitoring"]') return monitoringNode;
      return null;
    }),
    addEventListener: vi.fn((type: string, listener: Listener) => {
      const handlers = listeners.get(type) ?? new Set<Listener>();
      handlers.add(listener);
      listeners.set(type, handlers);
    }),
    removeEventListener: vi.fn((type: string, listener: Listener) => {
      listeners.get(type)?.delete(listener);
    }),
    clickClosest(selector: string, dataset: Record<string, string> = {}) {
      return emit('click', {
        preventDefault: vi.fn(),
        target: {
          closest(query: string) {
            return query === selector ? { dataset, disabled: false } : null;
          },
        },
      });
    },
    submitClosest(selector: string, fields: Record<string, string> = {}) {
      return emit('submit', {
        preventDefault: vi.fn(),
        target: {
          closest(query: string) {
            return query === selector
              ? {
                dataset: {
                  product: fields.product ?? 'aura',
                  kind: fields.kind,
                },
                elements: {
                  message: { value: fields.message ?? '' },
                  text: { value: fields.text ?? '' },
                  query: { value: fields.query ?? '' },
                },
                reset: vi.fn(),
              }
              : null;
          },
        },
      });
    },
    async keyDownClosest(selector: string, fields: Record<string, unknown> = {}) {
      const event = {
        key: fields.key ?? 'Enter',
        shiftKey: !!fields.shiftKey,
        preventDefault: vi.fn(),
        target: {
          name: fields.name ?? 'message',
          closest(query: string) {
            return query === selector
              ? {
                dataset: { product: fields.product ?? 'aura' },
                elements: {
                  message: { value: fields.message ?? '' },
                },
                reset: vi.fn(),
              }
              : null;
          },
        },
      };
      await emit('keydown', event);
      return event;
    },
  };
}

function productView(overrides: Record<string, unknown> = {}) {
  return {
    name: 'aura',
    repoBacked: true,
    projects: [
      { slug: '17-cockpit-redesign', lifecycle: 'active', taskProgress: { done: 4, total: 9 } },
      { slug: '14-product-team-agents', lifecycle: 'done', taskProgress: { done: 7, total: 7 } },
    ],
    backlog: {
      bugs: [
        {
          id: 'BUG-available',
          title: 'Crash when saving',
          body: 'Clicking save terminates the request.',
          status: 'open',
          plan: { kind: 'plan', state: 'available' },
          fix: { kind: 'fix', state: 'available' },
        },
        {
          id: 'BUG-gating',
          title: 'OAuth callback hangs',
          status: 'open',
          plan: { kind: 'plan', state: 'available' },
          fix: { kind: 'fix', state: 'gating' },
        },
        {
          id: 'BUG-declined',
          title: 'Ambiguous import error',
          status: 'open',
          plan: { kind: 'plan', state: 'available' },
          fix: {
            kind: 'fix',
            state: 'declined',
            reason: 'pm-not-well-scoped',
            detail: 'Needs concrete reproduction steps before autorun can start.',
          },
        },
        {
          id: 'BUG-handoff',
          title: 'Valid gate, missing executor',
          status: 'open',
          plan: { kind: 'plan', state: 'available' },
          fix: {
            kind: 'fix',
            state: 'handoff-failed',
            reason: 'handoff-unavailable',
            detail: 'startFixRun unavailable',
          },
        },
        {
          id: 'BUG-proceeding',
          title: 'Accepted fix run',
          status: 'open',
          plan: { kind: 'plan', state: 'available' },
          fix: { kind: 'fix', state: 'proceeding', runId: 'run-fix-accepted' },
        },
        {
          id: 'BUG-disabled',
          title: 'Already done',
          status: 'done',
          plan: { kind: 'plan', state: 'disabled', reason: 'done' },
          fix: { kind: 'fix', state: 'disabled', reason: 'done' },
        },
        {
          id: 'BUG-plan-disabled',
          title: 'Already promoted',
          status: 'open',
          plan: { kind: 'plan', enabled: false, disabledReason: 'already-promoted' },
          fix: { kind: 'fix', state: 'disabled', reason: 'already-promoted' },
        },
      ].filter((bug) => bug.status !== 'done'),
      ideas: [
        {
          id: 'IDEA-1',
          title: 'Add a release dashboard',
          status: 'open',
          plan: { kind: 'plan', state: 'available' },
        },
      ],
      warnings: [{
        file: 'docs/projects/bugs.md',
        lineNumber: 42,
        code: 'non-checkbox-bullet',
        message: 'Unparseable backlog bullet',
      }],
    },
    runs: [
      {
        runId: 'run-fix-accepted',
        target: { kind: 'bug', slug: 'BUG-proceeding' },
        outcome: 'partial',
        endedAt: '2026-06-23T13:05:00.000Z',
        transcriptUrl: '/api/work-runs/run-fix-accepted/transcript',
      },
      {
        runId: 'run-recent-1',
        target: { kind: 'project', slug: '17-cockpit-redesign' },
        outcome: 'no-op',
        endedAt: '2026-06-23T12:30:00.000Z',
        transcriptUrl: '/api/work-runs/run-recent-1/transcript',
      },
    ],
    activeRun: {
      runId: 'run-live-1',
      target: { kind: 'project', slug: '17-cockpit-redesign' },
      state: 'running',
      startedAt: '2026-06-23T12:00:00.000Z',
      elapsedMs: 125_000,
      worktreePath: LIVE_WORKTREE_PATH,
      agents: [
        { role: 'qa', active: true },
        { role: 'coder', active: false },
      ],
      transcriptUrl: '/api/work-runs/run-live-1/transcript',
    },
    ...overrides,
  };
}

const liveSnapshot = {
  runId: 'run-live-1',
  product: 'aura',
  target: { kind: 'project', slug: '17-cockpit-redesign' },
  state: 'running',
  tasks: { done: 4, total: 9 },
  elapsedMs: 130_000,
  worktreePath: LIVE_WORKTREE_PATH,
  agents: [
    { role: 'qa', active: true },
    { role: 'coder', active: true },
  ],
  lastLogLines: ['qa wrote failing tests', 'coder edited src/server/static/product-deep-view.js'],
  ts: '2026-06-23T12:02:10.000Z',
};

const operations = {
  pendingApprovals: [
    { id: 'blocked-on-human:run-parked-1', kind: 'parked-run-release', label: 'Release parked run' },
    { id: 'intent-proposal:abc123', kind: 'intent-proposal', label: 'Approve intent proposal' },
  ],
  inFlightOps: [{ opId: 'op-live-1', label: 'agent', startedAt: '2026-06-23T12:01:00.000Z' }],
  mutations: [{ id: 'mut-live-1', kind: 'work-run', status: 'running' }],
  restartAvailable: true,
  planning: { product: 'aura', status: 'scoping' },
};

const productOperations = {
  inFlightOps: [{ opId: 'op-live-1', label: 'agent', product: 'aura' }],
  mutations: [{ id: 'mut-live-1', kind: 'work-run', status: 'running', product: 'aura' }],
  planning: { product: 'aura', status: 'scoping' },
};

const monitoringCapabilities = {
  projects: true,
  bugs: true,
  ideas: true,
  runs: true,
  chat: true,
  monitoring: 'enabled',
};

const stubbedMonitoringCapabilities = {
  ...monitoringCapabilities,
  monitoring: 'stubbed',
};

const mcpMetricsSnapshot = {
  totals: { calls: 42, errors: 3, timeouts: 1 },
  tools: {
    kb_query: {
      calls: 21,
      errors: 2,
      timeouts: 1,
      latencyMs: { p50: 24, p95: 88, p99: 144, sampleCount: 21, windowSize: 1024 },
    },
    mcp_metrics_snapshot: {
      calls: 4,
      errors: 0,
      timeouts: 0,
      latencyMs: { p50: 2, p95: 3, p99: 5, sampleCount: 4, windowSize: 1024 },
    },
  },
  activeSessions: 2,
  warmIndex: {
    ready: true,
    ageMs: 15_000,
    lastRebuild: { status: 'ok', files: 120, lines: 7_500 },
  },
};

const runeRunMetrics = {
  status: 'ok',
  activeRuns: 2,
  parkedRuns: 1,
  terminalOutcomes: {
    'branch-complete': 6,
    partial: 2,
    noop: 1,
    'dirty-uncommitted': 1,
    failed: 3,
  },
  recentFailures: [
    {
      id: 'run-failed-recent',
      project: '19-rune-product-os',
      outcome: 'failed',
      durationMs: 124_000,
      startedAt: '2026-06-29T10:00:00.000Z',
      endedAt: '2026-06-29T10:02:04.000Z',
    },
    {
      id: 'run-dirty-recent',
      project: '13-work-run-monitoring',
      outcome: 'dirty-uncommitted',
      durationMs: 88_000,
      startedAt: '2026-06-29T10:10:00.000Z',
      endedAt: '2026-06-29T10:11:28.000Z',
    },
  ],
  runtimeMs: {
    p95: 225_000,
    sampleCount: 13,
  },
};

// Full /api/mcp/monitoring payload shape (McpMonitoringPayload).
const mcpMonitoringPayload = {
  status: 'degraded',
  checkedAt: '2026-07-06T15:20:05.000Z',
  live: mcpMetricsSnapshot,
  daemon: {
    status: 'ok',
    uptimeSec: 273_906, // 3d 4h
    startedAt: '2026-07-03T11:00:00.000Z',
    oauthConfigured: true,
    sessions: [
      {
        id: 'sess-abc123def456',
        openedAt: '2026-07-06T14:20:05.000Z',
        lastSeenAt: '2026-07-06T15:19:05.000Z',
      },
    ],
  },
  clients: [
    { clientId: 'client-claude-app', clientName: 'Claude App', createdAt: '2026-06-30T09:00:00.000Z' },
  ],
  history: {
    callsPerDay: Array.from({ length: 14 }, (_, index) => ({
      date: new Date(Date.UTC(2026, 5, 23 + index)).toISOString().slice(0, 10),
      calls: 10 + index,
      errors: index % 4,
    })),
    // 24 hourly buckets: calls sum 186, errors sum 5 (2.7% error rate), timeouts sum 2.
    hourly: Array.from({ length: 24 }, (_, index) => ({
      ts: `2026-07-06T${String(index).padStart(2, '0')}:00:00.000Z`,
      calls: 5 + (index % 7),
      errors: index % 5 === 0 ? 1 : 0,
      timeouts: index % 12 === 0 ? 1 : 0,
    })),
    perTool24h: {
      kb_query: { calls: 96, errors: 6 },
      vault_search: { calls: 12, errors: 0 },
    },
    collectedSince: '2026-06-23T00:00:00.000Z',
  },
  runMetrics: runeRunMetrics,
  alerts: {
    active: [
      {
        kind: 'error-rate',
        key: 'error-rate:kb_query',
        message: 'kb_query error rate above 10% in the last hour',
        firstDetectedAt: '2026-07-06T14:50:00.000Z',
        lastDetectedAt: '2026-07-06T15:20:00.000Z',
      },
    ],
    count: 1,
  },
};

function installFrameBusWindow() {
  const listeners = new Map<string, Set<(event: unknown) => void>>();
  const previousWindow = (globalThis as any).window;
  (globalThis as any).window = {
    runeSendWebviewMessage: vi.fn(() => true),
    dispatchEvent: vi.fn(),
    CustomEvent: class {
      type: string;
      detail: unknown;
      constructor(type: string, init: { detail?: unknown } = {}) {
        this.type = type;
        this.detail = init.detail;
      }
    },
    addEventListener: vi.fn((type: string, listener: (event: unknown) => void) => {
      const set = listeners.get(type) ?? new Set<(event: unknown) => void>();
      set.add(listener);
      listeners.set(type, set);
    }),
    removeEventListener: vi.fn((type: string, listener: (event: unknown) => void) => {
      listeners.get(type)?.delete(listener);
    }),
  };
  return {
    emit(type: string, detail: unknown) {
      for (const listener of listeners.get(type) ?? []) listener({ detail });
    },
    restore() {
      if (previousWindow === undefined) delete (globalThis as any).window;
      else (globalThis as any).window = previousWindow;
    },
  };
}

describe('Product deep view UI (cockpit redesign Phase 6)', () => {
  // Per-product chat/planning state is retained at module scope (so it survives
  // navigate-away-and-back). Clear it between tests so they stay isolated.
  beforeEach(async () => {
    const mod = await import('./product-deep-view.js');
    mod.__resetProductSessions?.();
  });

  it('lets a user open every Phase 4 product from Home, see its expected containers, and send product-scoped chat', async () => {
    const { createHomeView, renderHomeView } = await import('./home-view.js');
    const { createProductDeepView } = await import('./product-deep-view.js');
    const roster = [
      { name: 'rune', class: 'internal', workTabs: ['projects', 'bugs', 'ideas'], profile: 'standard' },
      { name: 'rune-mcp', class: 'internal', workTabs: ['projects', 'bugs', 'ideas'], profile: 'operations-runs-heavy' },
      { name: 'aura', class: 'external', workTabs: ['projects', 'bugs', 'ideas'], profile: 'standard' },
      { name: 'assay', class: 'external', workTabs: ['projects', 'bugs', 'ideas'], profile: 'standard' },
      { name: 'relay', class: 'external', workTabs: ['projects', 'bugs', 'ideas'], profile: 'standard' },
      { name: 'writing', class: 'external', workTabs: ['ideas'], profile: 'standard' },
      { name: 'brand', class: 'external', workTabs: ['projects', 'bugs', 'ideas'], profile: 'standard' },
    ];
    const homePulseForRoster = {
      available: true,
      products: roster.map(product => ({
        name: product.name,
        class: product.class,
        repoBacked: true,
        counts: { activeProjects: 0, openBugs: 0, openIdeas: product.name === 'writing' ? 1 : 0, backlogWarnings: 0 },
        attention: [],
      })),
    };
    const homeHtml = renderHomeView(homePulseForRoster);
    const groupHtml = (productClass: string) => {
      const match = new RegExp(
        `<section[^>]*data-home-product-class=["']${productClass}["'][\\s\\S]*?</section>`,
        'i',
      ).exec(homeHtml);
      expect(match?.[0], `${productClass} group should be visible on Home`).toBeDefined();
      return match![0];
    };
    const internalHtml = groupHtml('internal');
    const externalHtml = groupHtml('external');
    expect(internalHtml).toMatch(/>\s*Internal\s*</i);
    expect(externalHtml).toMatch(/>\s*External\s*</i);

    const homeRoot = makeRoot();
    const router = { goProduct: vi.fn() };
    const home = createHomeView({
      root: homeRoot,
      fetchJson: vi.fn(async (url: string) => {
        if (url === '/api/home') return homePulseForRoster;
        if (url === '/api/state') return { ready: true };
        if (url === '/api/approvals') return [];
        throw new Error(`unexpected fetch ${url}`);
      }),
      router,
    });
    await home.load();

    for (const product of roster) {
      const expectedGroup = product.class === 'internal' ? internalHtml : externalHtml;
      expect(expectedGroup).toMatch(new RegExp(`data-home-product=["']${product.name}["']`, 'i'));

      await homeRoot.clickClosest('[data-home-open-product]', { product: product.name });
      expect(router.goProduct).toHaveBeenLastCalledWith(product.name);

      const root = makeRoot();
      const sendChat = vi.fn(async () => ({ text: `${product.name} scoped reply` }));
      const view = createProductDeepView({
        root,
        product: product.name,
        fetchJson: vi.fn(async (url: string) => {
          expect(url).toBe(`/api/products/${product.name}`);
          return productView({
            name: product.name,
            projects: product.workTabs.includes('projects')
              ? [{ slug: `${product.name}-project`, lifecycle: 'active', taskProgress: { done: 0, total: 1 } }]
              : [],
            backlog: {
              bugs: product.workTabs.includes('bugs')
                ? [{ id: `${product.name}-bug`, title: `${product.name} bug`, status: 'open', plan: { kind: 'plan', state: 'available' } }]
                : [],
              ideas: [{ id: `${product.name}-idea`, title: `${product.name} idea`, status: 'open', plan: { kind: 'plan', state: 'available' } }],
              warnings: [],
            },
            runs: [],
            activeRun: undefined,
          });
        }),
        sendChat,
      });
      await view.load();

      expect(root.innerHTML).toMatch(new RegExp(`data-product=["']${product.name}["']`, 'i'));
      expect(root.innerHTML).toMatch(new RegExp(`data-container-profile=["']${product.profile}["']`, 'i'));
      for (const surface of ['work', 'side-panel', 'chat']) {
        expect(root.innerHTML).toMatch(new RegExp(`data-surface=["']${surface}["']`, 'i'));
      }
      for (const tab of product.workTabs) {
        expect(root.innerHTML).toMatch(new RegExp(`data-work-tab=["']${tab}["']`, 'i'));
      }
      if (product.name === 'writing') {
        expect(root.innerHTML).not.toMatch(/data-work-tab=["']projects["']|data-work-tab=["']bugs["']/i);
      }

      await root.clickClosest('[data-side-panel-tab]', { sidePanelTab: 'runs' });
      expect(root.innerHTML).toMatch(/data-surface=["']runs["']/i);

      await root.submitClosest('[data-product-chat-form]', {
        product: product.name,
        message: `What is next for ${product.name}?`,
      });
      expect(sendChat).toHaveBeenLastCalledWith({
        product: product.name,
        text: `What is next for ${product.name}?`,
      });
      view.close();
    }
  });

  it('loads the per-product projection and renders Projects, Bugs, Ideas, Runs, and Chat without depending on /api/cockpit', async () => {
    const { createProductDeepView } = await import('./product-deep-view.js');
    const root = makeRoot();
    const fetchJson = vi.fn(async (url: string) => {
      if (url === '/api/products/aura') return productView();
      if (url === '/api/work-runs/run-live-1/live') return liveSnapshot;
      throw new Error(`unexpected fetch ${url}`);
    });

    const view = createProductDeepView({ root, product: 'aura', fetchJson });
    await view.load();

    expect(fetchJson).toHaveBeenCalledWith('/api/products/aura');
    expect(fetchJson).toHaveBeenCalledWith('/api/work-runs/run-live-1/live');
    expect(fetchJson).not.toHaveBeenCalledWith('/api/cockpit');
    expect(root.innerHTML).toMatch(/data-product=["']aura["']|aura/i);
    for (const surface of ['Projects', 'Bugs', 'Ideas', 'Runs', 'Chat']) {
      expect(root.innerHTML).toMatch(new RegExp(`data-surface=["']${surface.toLowerCase()}["']|${surface}`, 'i'));
    }
    expect(root.innerHTML).toContain('17-cockpit-redesign');
    expect(root.innerHTML).toContain('Crash when saving');
    await root.clickClosest('[data-side-panel-tab]', { sidePanelTab: 'runs' });
    expect(root.innerHTML).toContain('run-recent-1');
  });

  it('renders a Home button and routes it through the client router', async () => {
    const { createProductDeepView, renderProductDeepView } = await import('./product-deep-view.js');
    const root = makeRoot();
    const router = { goHome: vi.fn() };

    expect(renderProductDeepView(productView())).toMatch(/data-go-home[\s\S]{0,80}Home|Home[\s\S]{0,80}data-go-home/i);

    const view = createProductDeepView({
      root,
      product: 'aura',
      fetchJson: vi.fn(async () => productView()),
      router,
    });
    await view.load();
    await root.clickClosest('[data-go-home]', {});

    expect(router.goHome).toHaveBeenCalledTimes(1);
  });

  it('uses a left work column with Operations/Runs below it and a right-column Chat-only workspace', async () => {
    const { createProductDeepView, renderProductDeepView } = await import('./product-deep-view.js');
    const root = makeRoot();
    const css = readFileSync(new URL('./app.css', import.meta.url), 'utf8');

    const html = renderProductDeepView(productView(), { operations: productOperations });

    expect(html).toMatch(/deep-two-column|deep-work-column|deep-chat-column/i);
    for (const tab of ['projects', 'bugs', 'ideas']) {
      expect(html).toMatch(new RegExp(`data-work-tab=["']${tab}["']|data-work-tab-panel=["']${tab}["']`, 'i'));
    }
    expect(html.indexOf('data-surface="side-panel"')).toBeLessThan(html.indexOf('data-surface="chat"'));
    expect(html.indexOf('class="deep-work-column"')).toBeLessThan(html.indexOf('data-surface="side-panel"'));
    expect(html.indexOf('class="deep-chat-column"')).toBeLessThan(html.indexOf('data-surface="chat"'));
    expect(html).toMatch(/data-side-panel-tab=["']operations["'][\s\S]{0,120}aria-selected=["']true["']/i);
    expect(html).toMatch(/data-side-panel-tab=["']runs["']/i);
    expect(html).toMatch(/data-surface=["']operations["']/i);
    expect(html).not.toMatch(/data-surface=["']runs["']/i);
    expect(css).toMatch(/\.deep-two-column[\s\S]*grid-template-columns/i);
    expect(css).toMatch(/\.deep-two-column[\s\S]*grid-template-columns:\s*minmax\(320px,\s*\.95fr\)\s+minmax\(420px,\s*1\.05fr\)/i);
    expect(css).toMatch(/\.product-deep-view[\s\S]*min-height:\s*calc\(100vh - 2rem\)/i);
    expect(css).toMatch(/\.deep-two-column[\s\S]*align-items:\s*stretch/i);
    expect(css).toMatch(/\.deep-work-column,\s*\n\.deep-chat-column[\s\S]*height:\s*calc\(100vh - 6rem\)/i);
    expect(css).toMatch(/\.deep-chat-column[\s\S]*overflow:\s*hidden/i);
    expect(css).toMatch(/\.deep-panel--chat[\s\S]*flex:\s*1 1 auto/i);
    expect(css).toMatch(/\.deep-panel--chat[\s\S]*overflow:\s*hidden/i);
    expect(css).toMatch(/\.deep-chat-transcript[\s\S]*flex:\s*1 1 auto/i);
    expect(css).toMatch(/\.deep-chat-transcript[\s\S]*min-height:\s*0/i);
    expect(css).toMatch(/\.deep-side-tab-panel[\s\S]*flex:\s*0 0 clamp\(14rem,\s*30vh,\s*24rem\)/i);
    expect(css).toMatch(/\.deep-side-tab-body[\s\S]*overflow:\s*auto/i);
    expect(css).toMatch(/\.deep-panel--chat textarea[\s\S]*min-height:\s*7\.5rem/i);
    expect(css).toMatch(/\.deep-tab-panel:not\(\.is-active\)[\s\S]*display:\s*none/i);
    expect(css).toMatch(/@media \(max-width:\s*760px\)[\s\S]*\.deep-work-column,\s*\n\s*\.deep-chat-column[\s\S]*height:\s*auto/i);

    const view = createProductDeepView({ root, product: 'aura', fetchJson: vi.fn(async () => productView()) });
    await view.load();
    await root.clickClosest('[data-work-tab]', { workTab: 'bugs' });

    expect(root.innerHTML).toMatch(/data-active-work-tab=["']bugs["']/i);
  });

  it('renders operation activity with the newest stream event first', async () => {
    const { renderProductDeepView } = await import('./product-deep-view.js');

    const html = renderProductDeepView(productView({ activeRun: undefined }), {
      operations: {
        ...productOperations,
        activity: [
          { opId: 'op-chat-1', at: '12:00:01', status: 'started', label: 'Asking Claude' },
          { opId: 'op-chat-1', at: '12:00:02', detail: 'Read: package.json' },
          { opId: 'op-chat-1', at: '12:00:03', status: 'success', detail: 'success' },
        ],
      },
    });

    expect(html.indexOf('success: success')).toBeLessThan(html.indexOf('Read: package.json'));
    expect(html.indexOf('Read: package.json')).toBeLessThan(html.indexOf('started: Asking Claude'));
  });

  it('renders the shared three-container spine with product-aware work contents', async () => {
    const { renderProductDeepView } = await import('./product-deep-view.js');

    const standard = renderProductDeepView(productView(), { operations: productOperations });
    expect(standard).toMatch(/data-surface=["']work["']/i);
    expect(standard).toMatch(/data-surface=["']side-panel["']/i);
    expect(standard).toMatch(/data-surface=["']chat["']/i);
    for (const tab of ['projects', 'bugs', 'ideas']) {
      expect(standard).toMatch(new RegExp(`data-work-tab=["']${tab}["']`, 'i'));
    }
    expect(standard).toContain('17-cockpit-redesign');
    expect(standard).toContain('Crash when saving');
    expect(standard).toContain('Add a release dashboard');

    const writing = renderProductDeepView(productView({
      name: 'writing',
      projects: [],
      backlog: {
        bugs: [],
        ideas: [
          {
            id: 'writing-idea-1',
            title: 'Draft a Rune essay',
            status: 'open',
            plan: { kind: 'plan', state: 'available' },
          },
        ],
        warnings: [],
      },
      activeRun: {
        runId: 'run-writing-draft',
        target: { kind: 'project', slug: 'draft-a-rune-essay' },
        state: 'running',
        startedAt: '2026-06-23T12:00:00.000Z',
        elapsedMs: 70_000,
        worktreePath: LIVE_WORKTREE_PATH,
        agents: [{ role: 'coder', active: true }],
        transcriptUrl: '/api/work-runs/run-writing-draft/transcript',
      },
      runs: [
        {
          runId: 'run-writing-publish',
          target: { kind: 'project', slug: 'draft-a-rune-essay' },
          outcome: 'completed',
          endedAt: '2026-06-23T12:30:00.000Z',
          transcriptUrl: '/api/work-runs/run-writing-publish/transcript',
        },
      ],
    }), { operations: productOperations, activeTab: 'ideas', activeSidePanel: 'runs' });

    expect(writing).toMatch(/data-product=["']writing["']/i);
    expect(writing).toMatch(/data-surface=["']work["']/i);
    expect(writing).toMatch(/data-surface=["']runs["']/i);
    expect(writing).toMatch(/data-surface=["']chat["']/i);
    expect(writing).toMatch(/data-work-tab=["']ideas["']/i);
    expect(writing).toContain('Draft a Rune essay');
    expect(writing).toContain('run-writing-draft');
    expect(writing).not.toMatch(/data-work-tab=["']projects["']|data-work-tab-panel=["']projects["']|>Projects</i);
    expect(writing).not.toMatch(/data-work-tab=["']bugs["']|data-work-tab-panel=["']bugs["']|>Bugs</i);
    expect(writing).not.toMatch(/No projects|No bugs/i);
  });

  it('derives visible work containers from containerCapabilities, not from the product slug', async () => {
    const { renderProductDeepView } = await import('./product-deep-view.js');

    const ideaOnlyProduct = renderProductDeepView(productView({
      name: 'essay-lab',
      class: 'external',
      containerCapabilities: {
        projects: false,
        bugs: false,
        ideas: true,
        runs: true,
        chat: true,
        monitoring: 'stubbed',
      },
      projects: [
        { slug: 'should-not-render', lifecycle: 'active', taskProgress: { done: 0, total: 1 } },
      ],
      backlog: {
        bugs: [
          { id: 'BUG-hidden', title: 'Hidden bug queue', status: 'open', plan: { kind: 'plan', state: 'available' } },
        ],
        ideas: [
          { id: 'IDEA-visible', title: 'Visible essay idea', status: 'open', plan: { kind: 'plan', state: 'available' } },
        ],
        warnings: [],
      },
      runs: [],
      activeRun: undefined,
    }), { activeTab: 'projects', activeSidePanel: 'runs' });

    expect(ideaOnlyProduct).toMatch(/data-product=["']essay-lab["']/i);
    expect(ideaOnlyProduct).toMatch(/data-surface=["']work["']/i);
    expect(ideaOnlyProduct).toMatch(/data-surface=["']runs["']/i);
    expect(ideaOnlyProduct).toMatch(/data-surface=["']chat["']/i);
    expect(ideaOnlyProduct).toMatch(/data-work-tab=["']ideas["']/i);
    expect(ideaOnlyProduct).toContain('Visible essay idea');
    expect(ideaOnlyProduct).not.toMatch(/data-work-tab=["']projects["']|data-work-tab-panel=["']projects["']/i);
    expect(ideaOnlyProduct).not.toMatch(/data-work-tab=["']bugs["']|data-work-tab-panel=["']bugs["']/i);
    expect(ideaOnlyProduct).not.toContain('should-not-render');
    expect(ideaOnlyProduct).not.toContain('Hidden bug queue');

    const standardBrand = renderProductDeepView(productView({
      name: 'brand',
      class: 'external',
      containerCapabilities: {
        projects: true,
        bugs: true,
        ideas: true,
        runs: true,
        chat: true,
        monitoring: 'stubbed',
      },
      projects: [
        { slug: 'site-homepage', lifecycle: 'active', taskProgress: { done: 1, total: 3 } },
      ],
      backlog: {
        bugs: [
          { id: 'BUG-brand', title: 'Homepage copy bug', status: 'open', plan: { kind: 'plan', state: 'available' } },
        ],
        ideas: [
          { id: 'IDEA-brand', title: 'Refresh root positioning', status: 'open', plan: { kind: 'plan', state: 'available' } },
        ],
        warnings: [],
      },
      runs: [],
      activeRun: undefined,
    }), { activeTab: 'projects', activeSidePanel: 'runs' });

    for (const tab of ['projects', 'bugs', 'ideas']) {
      expect(standardBrand).toMatch(new RegExp(`data-work-tab=["']${tab}["']`, 'i'));
    }
    expect(standardBrand).toContain('site-homepage');
    expect(standardBrand).toContain('Homepage copy bug');
    expect(standardBrand).toContain('Refresh root positioning');
  });

  it('renders the writing surface with ideas, draft/publish run stages, route targets, and scoped chat', async () => {
    const { createProductDeepView, renderProductDeepView } = await import('./product-deep-view.js');
    const writingView = productView({
      name: 'writing',
      class: 'external',
      scopePath: 'docs/rune',
      projects: [],
      containerCapabilities: {
        projects: false,
        bugs: false,
        ideas: true,
        runs: true,
        chat: true,
        monitoring: 'stubbed',
      },
      backlog: {
        bugs: [],
        ideas: [
          {
            id: 'writing-idea-memory',
            title: 'Operating from memory',
            status: 'open',
            plan: { kind: 'plan', state: 'available' },
          },
        ],
        warnings: [],
      },
      activeRun: {
        runId: 'run-writing-draft',
        target: { kind: 'writing-page', slug: 'operating-from-memory' },
        state: 'running',
        writingStage: 'drafting',
        routePath: '/rune/operating-from-memory',
        branch: 'rune-writing/operating-from-memory',
        startedAt: '2026-06-23T12:00:00.000Z',
        elapsedMs: 70_000,
        worktreePath: LIVE_WORKTREE_PATH,
        agents: [{ role: 'coder', active: true }],
        transcriptUrl: '/api/work-runs/run-writing-draft/transcript',
      },
      runs: [
        {
          runId: 'run-writing-research',
          target: { kind: 'writing-page', slug: 'operating-from-memory' },
          outcome: 'completed',
          writingStage: 'researching',
          routePath: '/rune/operating-from-memory',
          branch: 'rune-writing/operating-from-memory',
          endedAt: '2026-06-23T12:10:00.000Z',
          transcriptUrl: '/api/work-runs/run-writing-research/transcript',
        },
        {
          runId: 'run-writing-publish',
          target: { kind: 'writing-page', slug: 'operating-from-memory' },
          outcome: 'completed',
          writingStage: 'committed',
          routePath: '/rune/operating-from-memory',
          branch: 'rune-writing/operating-from-memory',
          endedAt: '2026-06-23T12:30:00.000Z',
          transcriptUrl: '/api/work-runs/run-writing-publish/transcript',
        },
      ],
    });
    const html = renderProductDeepView(writingView, { activeTab: 'ideas', activeSidePanel: 'runs' });

    expect(html).toMatch(/data-product=["']writing["']/i);
    expect(html).toMatch(/data-work-tab=["']ideas["']/i);
    expect(html).toContain('Operating from memory');
    expect(html).toContain('run-writing-draft');
    expect(html).toContain('run-writing-publish');
    expect(html).toContain('/rune/operating-from-memory');
    expect(html).toContain('rune-writing/operating-from-memory');
    for (const state of ['researching', 'drafting', 'committed']) {
      expect(html).toContain(state);
    }
    expect(html).not.toMatch(/data-work-tab=["']projects["']|data-work-tab=["']bugs["']/i);

    const root = makeRoot();
    const sendChat = vi.fn(async () => ({ text: 'writing scoped reply' }));
    const view = createProductDeepView({
      root,
      product: 'writing',
      fetchJson: vi.fn(async () => writingView),
      sendChat,
    });
    await view.load();
    await root.submitClosest('[data-product-chat-form]', {
      product: 'writing',
      message: 'What should this essay become?',
    });

    expect(sendChat).toHaveBeenLastCalledWith({
      product: 'writing',
      text: 'What should this essay become?',
    });
    view.close();
  });

  it('renders explicit product-aware empty states for products with no projects or ideas', async () => {
    const { renderProductDeepView } = await import('./product-deep-view.js');

    const emptyBrand = productView({
      name: 'brand',
      projects: [],
      backlog: { bugs: [], ideas: [], warnings: [] },
      runs: [],
      activeRun: undefined,
    });

    const projectsHtml = renderProductDeepView(emptyBrand, { activeTab: 'projects' });
    expect(projectsHtml).toMatch(/data-empty-state=["']projects["']/i);
    expect(projectsHtml).toMatch(/brand[\s\S]{0,220}(no active projects|no projects yet)|(no active projects|no projects yet)[\s\S]{0,220}brand/i);
    expect(projectsHtml).not.toMatch(/>\s*No projects\s*</i);

    const ideasHtml = renderProductDeepView(emptyBrand, { activeTab: 'ideas' });
    expect(ideasHtml).toMatch(/data-empty-state=["']ideas["']/i);
    expect(ideasHtml).toMatch(/brand[\s\S]{0,220}(no ideas captured|no ideas yet)|(no ideas captured|no ideas yet)[\s\S]{0,220}brand/i);
    expect(ideasHtml).not.toMatch(/>\s*No ideas\s*</i);
  });

  it('keeps writing ideas-only while showing an explicit no-ideas state instead of a blank panel', async () => {
    const { renderProductDeepView } = await import('./product-deep-view.js');

    const html = renderProductDeepView(productView({
      name: 'writing',
      projects: [],
      backlog: { bugs: [], ideas: [], warnings: [] },
      runs: [],
      activeRun: undefined,
    }), { activeTab: 'ideas' });

    expect(html).toMatch(/data-product=["']writing["']/i);
    expect(html).toMatch(/data-work-tab=["']ideas["']/i);
    expect(html).toMatch(/data-empty-state=["']ideas["']/i);
    expect(html).toMatch(/writing[\s\S]{0,220}(no ideas captured|no writing ideas yet)|(no ideas captured|no writing ideas yet)[\s\S]{0,220}writing/i);
    expect(html).not.toMatch(/data-work-tab=["']projects["']|data-work-tab=["']bugs["']/i);
    expect(html).not.toMatch(/>\s*No ideas\s*</i);
  });

  it('renders an unavailable repo as a degraded product view with nonblank work, runs, and chat containers', async () => {
    const { renderProductDeepView } = await import('./product-deep-view.js');

    const html = renderProductDeepView(productView({
      name: 'relay',
      repoBacked: false,
      limitedReason: 'Repo path is unavailable or unreadable.',
      projects: [],
      backlog: { bugs: [], ideas: [], warnings: [] },
      runs: [],
      activeRun: undefined,
    }));

    expect(html).toMatch(/data-degraded-state=["']repo["']|product-deep-view--repo-unavailable/i);
    expect(html).toMatch(/repo(?:sitory)? unavailable|repo path is unavailable/i);
    expect(html).toContain('Repo path is unavailable or unreadable.');
    for (const surface of ['work', 'runs', 'chat']) {
      expect(html).toMatch(new RegExp(`data-surface=["']${surface}["']`, 'i'));
    }
    expect(html).not.toMatch(/data-fix-item-id|data-plan-item-id|data-project-run-action=["']start["']/i);
  });

  it('marks Rune MCP as operations/runs-heavy so that container gets more room than the work backlog', async () => {
    const { renderProductDeepView } = await import('./product-deep-view.js');

    const html = renderProductDeepView(productView({
      name: 'rune-mcp',
      projects: [
        { slug: 'mcp-daemon', lifecycle: 'active', taskProgress: { done: 3, total: 6 } },
      ],
      backlog: {
        bugs: [],
        ideas: [
          {
            id: 'mcp-idea-1',
            title: 'Add a metrics panel',
            status: 'open',
            plan: { kind: 'plan', state: 'available' },
          },
        ],
        warnings: [],
      },
      activeRun: {
        runId: 'run-mcp-refresh',
        target: { kind: 'project', slug: 'mcp-daemon' },
        state: 'running',
        startedAt: '2026-06-23T12:00:00.000Z',
        elapsedMs: 90_000,
        worktreePath: LIVE_WORKTREE_PATH,
        agents: [{ role: 'qa', active: true }],
        transcriptUrl: '/api/work-runs/run-mcp-refresh/transcript',
      },
      runs: [
        {
          runId: 'run-mcp-recent',
          target: { kind: 'project', slug: 'mcp-daemon' },
          outcome: 'no-op',
          endedAt: '2026-06-23T11:30:00.000Z',
          transcriptUrl: '/api/work-runs/run-mcp-recent/transcript',
        },
      ],
    }), { operations: productOperations, activeSidePanel: 'runs' });

    expect(html).toMatch(/data-product=["']rune-mcp["']/i);
    expect(html).toMatch(/data-container-profile=["']operations-runs-heavy["']|product-deep-view--operations-runs-heavy/i);
    expect(html).toMatch(/data-surface=["']side-panel["'][^>]*(data-container-weight=["']heavy["']|deep-side-tab-panel--heavy)/i);
    expect(html).toMatch(/data-surface=["']runs["'][\s\S]{0,500}run-mcp-refresh/i);
    expect(html).toMatch(/data-surface=["']work["'][\s\S]{0,500}mcp-daemon/i);
  });

  it('renders Monitoring as a live internal-product tab with MCP and Rune run metrics', async () => {
    const { renderProductDeepView } = await import('./product-deep-view.js');

    for (const product of ['rune', 'rune-mcp']) {
      const html = renderProductDeepView(
        productView({
          name: product,
          class: 'internal',
          containerCapabilities: monitoringCapabilities,
          activeRun: undefined,
        }),
        {
          activeSidePanel: 'monitoring',
          monitoring: {
            mcpMetrics: mcpMetricsSnapshot,
            runMetrics: runeRunMetrics,
            sourceTool: 'mcp_metrics_snapshot',
            status: 'ok',
          },
        },
      );

      expect(html).toMatch(new RegExp(`data-product=["']${product}["']`, 'i'));
      expect(html).toMatch(/data-side-panel-tab=["']monitoring["']|data-surface-jump=["']monitoring["']/i);
      expect(html).toMatch(/data-surface=["']monitoring["']/i);
      expect(html).toMatch(/data-monitoring-mode=["']live["']|data-monitoring-state=["']live["']/i);
      expect(html).toMatch(/mcp_metrics_snapshot/i);
      expect(html).toMatch(/MCP|kb_query|call metrics/i);
      expect(html).toMatch(/42|21/);
      expect(html).toMatch(/timeouts?[\s\S]{0,120}1|1[\s\S]{0,120}timeouts?/i);
      expect(html).toMatch(/p95[\s\S]{0,120}88|88[\s\S]{0,120}p95/i);
      expect(html).toMatch(/active sessions?[\s\S]{0,120}2|2[\s\S]{0,120}active sessions?/i);
      expect(html).toMatch(/warm index[\s\S]{0,160}ready|ready[\s\S]{0,160}warm index/i);
      expect(html).toMatch(/Rune run|orchestration|work runs/i);
      expect(html).toMatch(/active runs?[\s\S]{0,120}2|2[\s\S]{0,120}active runs?/i);
      expect(html).toMatch(/parked[\s\S]{0,120}1|1[\s\S]{0,120}parked/i);
    }
  });

  it('renders external-product Monitoring as a stubbed empty container with the same surface shape', async () => {
    const { renderProductDeepView } = await import('./product-deep-view.js');

    for (const product of ['aura', 'assay', 'relay', 'writing', 'brand']) {
      const html = renderProductDeepView(
        productView({
          name: product,
          class: 'external',
          containerCapabilities: stubbedMonitoringCapabilities,
          activeRun: undefined,
        }),
        { activeSidePanel: 'monitoring' },
      );

      expect(html).toMatch(new RegExp(`data-product=["']${product}["']`, 'i'));
      expect(html).toMatch(/data-side-panel-tab=["']monitoring["']|data-surface-jump=["']monitoring["']/i);
      expect(html).toMatch(/data-surface=["']monitoring["']/i);
      expect(html).toMatch(/data-monitoring-mode=["']stubbed["']|data-monitoring-state=["']stubbed["']|monitoring[^<]{0,160}(empty|not available|later)/i);
      expect(html).not.toMatch(/kb_query|mcp_metrics_snapshot|active sessions?|p95/i);
    }
  });

  it('renders Rune run metrics from the adapter, including terminal outcomes, recent failures, and p95 runtime', async () => {
    const { renderProductDeepView } = await import('./product-deep-view.js');

    const html = renderProductDeepView(
      productView({
        name: 'rune-mcp',
        class: 'internal',
        containerCapabilities: monitoringCapabilities,
        activeRun: undefined,
      }),
      {
        activeSidePanel: 'monitoring',
        monitoring: {
          mcpMetrics: mcpMetricsSnapshot,
          runMetrics: runeRunMetrics,
          sourceTool: 'mcp_metrics_snapshot',
          status: 'ok',
        },
      },
    );

    expect(html).toMatch(/data-surface=["']monitoring["']/i);
    expect(html).toMatch(/Rune run|orchestration|work runs/i);
    expect(html).toMatch(/active runs?[\s\S]{0,120}2|2[\s\S]{0,120}active runs?/i);
    expect(html).toMatch(/parked[\s\S]{0,120}1|1[\s\S]{0,120}parked/i);
    expect(html).toMatch(/branch-complete[\s\S]{0,120}6|6[\s\S]{0,120}branch-complete/i);
    expect(html).toMatch(/failed[\s\S]{0,120}3|3[\s\S]{0,120}failed/i);
    expect(html).toMatch(/dirty-uncommitted[\s\S]{0,120}1|1[\s\S]{0,120}dirty-uncommitted/i);
    expect(html).toMatch(/run-failed-recent/i);
    expect(html).toMatch(/19-rune-product-os/i);
    expect(html).toMatch(/p95[\s\S]{0,120}(225000|225,000|225s|3m 45s)/i);
    expect(html).toMatch(/sample count[\s\S]{0,120}13|13[\s\S]{0,120}samples?/i);
  });

  it('renders the full MCP monitoring payload: alerts, health strip, KPI tiles, history chart, tools, sessions', async () => {
    const { renderProductDeepView } = await import('./product-deep-view.js');

    const html = renderProductDeepView(
      productView({
        name: 'rune-mcp',
        class: 'internal',
        containerCapabilities: monitoringCapabilities,
        activeRun: undefined,
      }),
      { activeSidePanel: 'monitoring', monitoring: mcpMonitoringPayload },
    );

    expect(html).toMatch(/data-monitoring-mode=["']live["']/i);
    expect(html).toMatch(/data-monitoring-state=["']degraded["']/i);

    // Alert banner: kind + message + since.
    expect(html).toMatch(/deep-monitoring-alert/);
    expect(html).toContain('error-rate');
    expect(html).toContain('kb_query error rate above 10% in the last hour');
    expect(html).toMatch(/since /i);

    // Health strip: uptime, sessions, warm index, clients, checked time.
    expect(html).toMatch(/daemon up 3d 4h/i);
    expect(html).toMatch(/2 active sessions/i);
    expect(html).toMatch(/warm index ready/i);
    expect(html).toMatch(/1 client\b/);
    expect(html).toMatch(/last updated/i);

    // KPI tiles are computed from the 24h history when present.
    expect(html).toMatch(/data-monitoring-kpi=["']calls-24h["']/);
    expect(html).toMatch(/186[\s\S]{0,160}calls · 24h/);
    expect(html).toMatch(/data-monitoring-kpi=["']error-rate-24h["']/);
    expect(html).toMatch(/deep-monitoring-kpi--warn/);
    expect(html).toContain('2.7%');
    expect(html).toMatch(/88ms[\s\S]{0,200}p95 latency|p95 latency[\s\S]{0,200}88ms/i);
    expect(html).toMatch(/data-monitoring-kpi=["']timeouts-24h["']/);

    // Charts render as inline SVG; history present means no collecting notice.
    expect(html).toContain('<svg');
    expect(html).toMatch(/data-monitoring-chart=["']calls-per-day["']/);
    expect(html).not.toMatch(/data-empty-state=["']monitoring-history["']/);

    // Per-tool table: 24h counts from perTool24h, sorted by calls descending.
    expect(html).toMatch(/data-monitoring-tool=["']kb_query["'][\s\S]{0,80}kb_query[\s\S]{0,40}96 calls/);
    const kbIdx = html.indexOf('data-monitoring-tool="kb_query"');
    const vaultIdx = html.indexOf('data-monitoring-tool="vault_search"');
    expect(kbIdx).toBeGreaterThan(-1);
    expect(vaultIdx).toBeGreaterThan(kbIdx);

    // Sessions & clients.
    expect(html).toMatch(/data-monitoring-session=["']sess-abc123def456["']/);
    expect(html).toContain('Claude App');
    expect(html).toContain('created 2026-06-30');

    // Run metrics keep rendering from the payload.
    expect(html).toMatch(/active runs?[\s\S]{0,120}2|2[\s\S]{0,120}active runs?/i);
  });

  it('polls the MCP monitoring endpoint every five seconds while internal Monitoring is visible', async () => {
    vi.useFakeTimers();
    try {
      const { createProductDeepView } = await import('./product-deep-view.js');
      const root = makeRoot();
      const monitoringCallCount = () => fetchJson.mock.calls
        .filter(([url]) => url === '/api/mcp/monitoring').length;
      const fetchJson = vi.fn(async (url: string) => {
        if (url === '/api/products/rune-mcp') {
          return productView({
            name: 'rune-mcp',
            class: 'internal',
            containerCapabilities: monitoringCapabilities,
            activeRun: undefined,
          });
        }
        // No runMetrics in the payload → the view falls back to /api/state.
        if (url === '/api/mcp/monitoring') {
          return { status: 'ok', checkedAt: '2026-06-29T15:00:00.000Z', live: mcpMetricsSnapshot };
        }
        if (url === '/api/state') {
          return {
            inFlight: [],
            mutations: {
              active: [
                { id: 'mut-run-1', kind: 'orchestrated-work', status: 'running', payload: { product: 'rune-mcp' } },
                { id: 'mut-run-2', kind: 'work-run', status: 'blocked-on-human', payload: { product: 'rune' } },
              ],
            },
          };
        }
        throw new Error(`unexpected fetch ${url}`);
      });

      const view = createProductDeepView({ root, product: 'rune-mcp', fetchJson });
      await view.load();

      expect(fetchJson).not.toHaveBeenCalledWith('/api/mcp/metrics');
      expect(fetchJson).not.toHaveBeenCalledWith('/api/metrics');
      expect(fetchJson).not.toHaveBeenCalledWith('/logs/mcp-metrics.json');
      expect(fetchJson).not.toHaveBeenCalledWith('/api/mcp/monitoring');

      await vi.advanceTimersByTimeAsync(12_500);
      expect(monitoringCallCount()).toBe(0);

      await root.clickClosest('[data-side-panel-tab]', { sidePanelTab: 'monitoring' });
      await Promise.resolve();

      expect(fetchJson).toHaveBeenCalledWith('/api/mcp/monitoring');
      expect(fetchJson).not.toHaveBeenCalledWith('/api/mcp/tools/mcp_metrics_snapshot');
      expect(root.innerHTML).toMatch(/data-active-side-panel=["']monitoring["']/i);
      expect(root.innerHTML).toMatch(/kb_query[\s\S]{0,180}21|21[\s\S]{0,180}kb_query/i);
      expect(root.innerHTML).toMatch(/active runs?[\s\S]{0,120}2|2[\s\S]{0,120}active runs?/i);
      expect(monitoringCallCount()).toBe(1);

      await vi.advanceTimersByTimeAsync(4999);
      expect(monitoringCallCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(5000);
      expect(monitoringCallCount()).toBe(2);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(monitoringCallCount()).toBe(5);

      view.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('updates visible Rune MCP monitoring counters after a later MCP tool-call snapshot', async () => {
    vi.useFakeTimers();
    try {
      const { createProductDeepView } = await import('./product-deep-view.js');
      const root = makeRoot();
      const snapshotFor = (totalCalls: number, kbQueryCalls: number) => ({
        ...mcpMetricsSnapshot,
        totals: { calls: totalCalls, errors: 0, timeouts: 0 },
        tools: {
          kb_query: {
            ...mcpMetricsSnapshot.tools.kb_query,
            calls: kbQueryCalls,
            errors: 0,
            timeouts: 0,
          },
          mcp_metrics_snapshot: {
            ...mcpMetricsSnapshot.tools.mcp_metrics_snapshot,
            calls: totalCalls - kbQueryCalls,
            errors: 0,
            timeouts: 0,
          },
        },
      });
      const fetchJson = vi.fn(async (url: string) => {
        if (url === '/api/products/rune-mcp') {
          return productView({
            name: 'rune-mcp',
            class: 'internal',
            containerCapabilities: monitoringCapabilities,
            activeRun: undefined,
          });
        }
        if (url === '/api/mcp/monitoring') {
          const callIndex = fetchJson.mock.calls
            .filter(([calledUrl]) => calledUrl === '/api/mcp/monitoring').length;
          return {
            status: 'ok',
            checkedAt: `2026-06-29T15:20:0${callIndex}.000Z`,
            live: callIndex === 1
              ? snapshotFor(10, 2)
              : snapshotFor(11, 3),
          };
        }
        if (url === '/api/state') {
          return {
            inFlight: [],
            mutations: { active: [] },
          };
        }
        throw new Error(`unexpected fetch ${url}`);
      });

      const view = createProductDeepView({ root, product: 'rune-mcp', fetchJson });
      await view.load();
      await root.clickClosest('[data-side-panel-tab]', { sidePanelTab: 'monitoring' });

      expect(root.innerHTML).toMatch(/data-active-side-panel=["']monitoring["']/i);
      expect(root.innerHTML).toMatch(/data-monitoring-state=["']ok["']/i);
      expect(root.innerHTML).toMatch(/total calls[\s\S]{0,120}10|10[\s\S]{0,120}total calls/i);
      expect(root.innerHTML).toMatch(/kb_query[\s\S]{0,120}2 calls/i);

      await vi.advanceTimersByTimeAsync(5000);

      expect(root.innerHTML).toMatch(/total calls[\s\S]{0,120}11|11[\s\S]{0,120}total calls/i);
      expect(root.innerHTML).toMatch(/kb_query[\s\S]{0,120}3 calls/i);

      view.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('refreshes Monitoring metrics on poll without rebuilding the chat composer (preserves in-progress typing)', async () => {
    vi.useFakeTimers();
    try {
      const { createProductDeepView } = await import('./product-deep-view.js');
      const root = makeRoot();
      const snapshotFor = (totalCalls: number, kbQueryCalls: number) => ({
        ...mcpMetricsSnapshot,
        totals: { calls: totalCalls, errors: 0, timeouts: 0 },
        tools: {
          kb_query: { ...mcpMetricsSnapshot.tools.kb_query, calls: kbQueryCalls, errors: 0, timeouts: 0 },
        },
      });
      const fetchJson = vi.fn(async (url: string) => {
        if (url === '/api/products/rune-mcp') {
          return productView({
            name: 'rune-mcp',
            class: 'internal',
            containerCapabilities: monitoringCapabilities,
            activeRun: undefined,
          });
        }
        if (url === '/api/mcp/monitoring') {
          const callIndex = fetchJson.mock.calls
            .filter(([calledUrl]) => calledUrl === '/api/mcp/monitoring').length;
          return {
            status: 'ok',
            checkedAt: `2026-06-29T15:20:0${callIndex}.000Z`,
            live: callIndex === 1 ? snapshotFor(10, 2) : snapshotFor(11, 3),
          };
        }
        if (url === '/api/state') return { inFlight: [], mutations: { active: [] } };
        throw new Error(`unexpected fetch ${url}`);
      });

      const view = createProductDeepView({ root, product: 'rune-mcp', fetchJson });
      await view.load();
      await root.clickClosest('[data-side-panel-tab]', { sidePanelTab: 'monitoring' });
      expect(root.innerHTML).toMatch(/total calls[\s\S]{0,120}10|10[\s\S]{0,120}total calls/i);

      // The user starts typing a message into the composer. A full root.innerHTML
      // rebuild (the old behavior) resets chatInput.value via the mock, mirroring
      // the real DOM discarding a freshly-created textarea's contents and focus.
      root.chatInput.value = 'half-written question I have not sent yet';

      await vi.advanceTimersByTimeAsync(5000);

      // The scoped repaint must leave the composer untouched...
      expect(root.chatInput.value).toBe('half-written question I have not sent yet');
      // ...while still advancing the live monitoring metrics.
      expect(root.innerHTML).toMatch(/total calls[\s\S]{0,120}11|11[\s\S]{0,120}total calls/i);

      view.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows a last-updated time for each internal Monitoring poll, including degraded MCP failures', async () => {
    vi.useFakeTimers();
    try {
      const firstPollAt = new Date('2026-06-29T15:20:05.000Z');
      const secondPollAt = new Date('2026-06-29T15:20:10.000Z');
      const fmtExpectedTime = (date: Date) =>
        date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      vi.setSystemTime(firstPollAt);

      const { createProductDeepView } = await import('./product-deep-view.js');
      const root = makeRoot();
      let metricsCalls = 0;
      const fetchJson = vi.fn(async (url: string) => {
        if (url === '/api/products/rune-mcp') {
          return productView({
            name: 'rune-mcp',
            class: 'internal',
            containerCapabilities: monitoringCapabilities,
            activeRun: undefined,
          });
        }
        if (url === '/api/mcp/monitoring') {
          metricsCalls += 1;
          if (metricsCalls === 1) {
            return { status: 'ok', checkedAt: firstPollAt.toISOString(), live: mcpMetricsSnapshot };
          }
          throw new Error('MCP daemon unavailable');
        }
        if (url === '/api/state') {
          return {
            inFlight: [],
            mutations: { active: [] },
          };
        }
        throw new Error(`unexpected fetch ${url}`);
      });

      const view = createProductDeepView({ root, product: 'rune-mcp', fetchJson });
      await view.load();
      await root.clickClosest('[data-side-panel-tab]', { sidePanelTab: 'monitoring' });

      expect(root.innerHTML).toMatch(/last updated/i);
      expect(root.innerHTML).toContain(fmtExpectedTime(firstPollAt));

      vi.setSystemTime(secondPollAt);
      await vi.advanceTimersByTimeAsync(5000);

      expect(root.innerHTML).toMatch(/data-monitoring-state=["']degraded["']|>\s*degraded\s*</i);
      expect(root.innerHTML).toMatch(/last updated/i);
      expect(root.innerHTML).toContain(fmtExpectedTime(secondPollAt));
      expect(root.innerHTML).toMatch(/MCP daemon unavailable/i);
      // The failed poll keeps the last-good data on screen, marked stale.
      expect(root.innerHTML).toMatch(/deep-monitoring-stale/);
      expect(root.innerHTML).toMatch(/kb_query/);

      view.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops MCP monitoring polling when Monitoring is hidden or the view is unmounted', async () => {
    vi.useFakeTimers();
    try {
      const { createProductDeepView } = await import('./product-deep-view.js');
      const root = makeRoot();
      const monitoringCallCount = () => fetchJson.mock.calls
        .filter(([url]) => url === '/api/mcp/monitoring').length;
      const fetchJson = vi.fn(async (url: string) => {
        if (url === '/api/products/rune-mcp') {
          return productView({
            name: 'rune-mcp',
            class: 'internal',
            containerCapabilities: monitoringCapabilities,
            activeRun: undefined,
          });
        }
        if (url === '/api/mcp/monitoring') {
          return { status: 'ok', checkedAt: '2026-06-29T15:00:00.000Z', live: mcpMetricsSnapshot };
        }
        if (url === '/api/state') {
          return {
            inFlight: [],
            mutations: {
              active: [
                { id: 'mut-run-1', kind: 'orchestrated-work', status: 'running', payload: { product: 'rune-mcp' } },
                { id: 'mut-run-2', kind: 'work-run', status: 'blocked-on-human', payload: { product: 'rune' } },
              ],
            },
          };
        }
        throw new Error(`unexpected fetch ${url}`);
      });

      const view = createProductDeepView({ root, product: 'rune-mcp', fetchJson });
      await view.load();
      await root.clickClosest('[data-side-panel-tab]', { sidePanelTab: 'monitoring' });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(monitoringCallCount()).toBe(3);

      await root.clickClosest('[data-side-panel-tab]', { sidePanelTab: 'runs' });
      const monitoringCallsAfterHide = monitoringCallCount();
      await vi.advanceTimersByTimeAsync(25_000);
      expect(monitoringCallCount()).toBe(monitoringCallsAfterHide);

      await root.clickClosest('[data-side-panel-tab]', { sidePanelTab: 'monitoring' });
      expect(monitoringCallCount()).toBe(monitoringCallsAfterHide + 1);
      await vi.advanceTimersByTimeAsync(5000);
      const monitoringCallsBeforeUnmount = monitoringCallCount();
      expect(monitoringCallsBeforeUnmount).toBe(monitoringCallsAfterHide + 2);

      view.close();
      await vi.advanceTimersByTimeAsync(25_000);
      expect(monitoringCallCount()).toBe(monitoringCallsBeforeUnmount);
    } finally {
      vi.useRealTimers();
    }
  });

  it('renders internal Monitoring as degraded when the MCP metrics snapshot tool is unavailable', async () => {
    const { createProductDeepView } = await import('./product-deep-view.js');
    const root = makeRoot();
    const fetchJson = vi.fn(async (url: string) => {
      if (url === '/api/products/rune-mcp') {
        return productView({
          name: 'rune-mcp',
          class: 'internal',
          containerCapabilities: monitoringCapabilities,
          activeRun: undefined,
        });
      }
      if (url === '/api/mcp/monitoring') throw new Error('MCP daemon unavailable');
      if (url === '/api/state') {
        return {
          inFlight: [],
          mutations: {
            active: [
              { id: 'mut-run-1', kind: 'orchestrated-work', status: 'running', payload: { product: 'rune-mcp' } },
              { id: 'mut-run-2', kind: 'work-run', status: 'blocked-on-human', payload: { product: 'rune' } },
            ],
          },
        };
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    const view = createProductDeepView({ root, product: 'rune-mcp', fetchJson });
    await view.load();
    await root.clickClosest('[data-side-panel-tab]', { sidePanelTab: 'monitoring' });

    expect(fetchJson).toHaveBeenCalledWith('/api/mcp/monitoring');
    expect(root.innerHTML).toMatch(/data-surface=["']monitoring["']/i);
    expect(root.innerHTML).toMatch(/data-monitoring-mode=["']live["']/i);
    expect(root.innerHTML).toMatch(/data-monitoring-state=["']degraded["']|>\s*degraded\s*</i);
    expect(root.innerHTML).toMatch(/MCP daemon unavailable/i);
    expect(root.innerHTML).toMatch(/deep-monitoring-stale/);
    // Run metrics come from cockpit state, so they render even with the daemon down.
    expect(root.innerHTML).toMatch(/active runs?[\s\S]{0,120}2|2[\s\S]{0,120}active runs?/i);
    expect(root.innerHTML).not.toMatch(/data-empty-state=["']monitoring["']/i);

    view.close();
  });

  it('keeps external-product Monitoring from polling MCP metrics while still showing the stub container', async () => {
    vi.useFakeTimers();
    try {
      const { createProductDeepView } = await import('./product-deep-view.js');
      const root = makeRoot();
      const fetchJson = vi.fn(async (url: string) => {
        if (url === '/api/products/aura') {
          return productView({
            name: 'aura',
            class: 'external',
            containerCapabilities: stubbedMonitoringCapabilities,
            activeRun: undefined,
          });
        }
        throw new Error(`unexpected fetch ${url}`);
      });

      const view = createProductDeepView({ root, product: 'aura', fetchJson });
      await view.load();
      await root.clickClosest('[data-side-panel-tab]', { sidePanelTab: 'monitoring' });
      await vi.advanceTimersByTimeAsync(2500);

      expect(root.innerHTML).toMatch(/data-active-side-panel=["']monitoring["']/i);
      expect(root.innerHTML).toMatch(/data-surface=["']monitoring["']/i);
      expect(root.innerHTML).toMatch(/data-monitoring-mode=["']stubbed["']|data-monitoring-state=["']stubbed["']|monitoring[^<]{0,160}(empty|not available|later)/i);
      expect(fetchJson).not.toHaveBeenCalledWith('/api/mcp/monitoring');
      expect(fetchJson).not.toHaveBeenCalledWith('/api/mcp/tools/mcp_metrics_snapshot');

      view.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('switches the lower-left panel between Operations and Runs without resetting chat state', async () => {
    const { createProductDeepView } = await import('./product-deep-view.js');
    const root = makeRoot();
    const sendChat = vi.fn(async () => ({ text: 'Still here.' }));
    // No active run, so the lower panel defaults to Operations (an active run
    // would default to Runs — covered by its own test below).
    const fetchJson = vi.fn(async () => productView({ activeRun: undefined }));

    const view = createProductDeepView({
      root,
      product: 'aura',
      fetchJson,
      sendChat,
      operations: productOperations,
    });
    await view.load();
    await root.submitClosest('[data-product-chat-form]', { product: 'aura', message: 'Keep this message' });

    expect(root.innerHTML).toMatch(/data-active-side-panel=["']operations["']/i);
    expect(root.innerHTML).toMatch(/data-surface=["']operations["']/i);
    expect(root.innerHTML).not.toMatch(/data-surface=["']runs["']/i);
    expect(root.innerHTML).toContain('Keep this message');

    await root.clickClosest('[data-side-panel-tab]', { sidePanelTab: 'runs' });

    expect(fetchJson).toHaveBeenCalledTimes(1);
    expect(root.innerHTML).toMatch(/data-active-side-panel=["']runs["']/i);
    expect(root.innerHTML).toMatch(/data-surface=["']runs["']/i);
    expect(root.innerHTML).not.toMatch(/data-surface=["']operations["']/i);
    expect(root.innerHTML).toContain('run-recent-1');
    expect(root.innerHTML).toContain('Keep this message');
  });

  it('defaults the lower-left panel to Runs when a run is active on entry', async () => {
    const { createProductDeepView } = await import('./product-deep-view.js');
    const root = makeRoot();
    // productView() carries an active run (run-live-1), so the lower panel
    // should open on Runs so live progress is visible without a click.
    const view = createProductDeepView({
      root,
      product: 'aura',
      fetchJson: vi.fn(async () => productView()),
      operations: productOperations,
    });
    await view.load();

    expect(root.innerHTML).toMatch(/data-active-side-panel=["']runs["']/i);
    expect(root.innerHTML).toMatch(/data-surface=["']runs["']/i);
    expect(root.innerHTML).not.toMatch(/data-surface=["']operations["']/i);
    expect(root.innerHTML).toContain('run-live-1');
  });

  it('subscribes to an active run on entry without a focusRunId deep link', async () => {
    const { createProductDeepView } = await import('./product-deep-view.js');
    const root = makeRoot();
    const fetchJson = vi.fn(async (url: string) => {
      if (url === '/api/products/aura') return productView();
      if (url === '/api/work-runs/run-live-1/live') return liveSnapshot;
      throw new Error(`unexpected fetch ${url}`);
    });
    const subscription = { connect: vi.fn(async () => {}), close: vi.fn() };
    const createRunFeedSubscription = vi.fn(() => subscription);

    const view = createProductDeepView({
      root,
      product: 'aura',
      fetchJson,
      createRunFeedSubscription,
    });
    await view.load();

    expect(fetchJson).toHaveBeenCalledWith('/api/work-runs/run-live-1/live');
    expect(createRunFeedSubscription).toHaveBeenCalledWith(expect.objectContaining({
      runId: 'run-live-1',
      fetchJson,
    }));
    expect(subscription.connect).toHaveBeenCalledTimes(1);
    expect(root.innerHTML).toMatch(/data-active-side-panel=["']runs["']/i);
  });

  it('renders a per-product limited view for known products that are not repo-backed', async () => {
    const { createProductDeepView } = await import('./product-deep-view.js');
    const root = makeRoot();
    const fetchJson = vi.fn(async (url: string) => {
      expect(url).toBe('/api/products/relay');
      return productView({
        name: 'relay',
        repoBacked: false,
        limitedReason: 'Product is tracked but has no writable repo configured.',
        projects: [],
        backlog: { bugs: [], ideas: [], warnings: [] },
        runs: [],
        activeRun: undefined,
      });
    });

    const view = createProductDeepView({ root, product: 'relay', fetchJson });
    await view.load();

    expect(fetchJson).toHaveBeenCalledWith('/api/products/relay');
    expect(fetchJson).not.toHaveBeenCalledWith('/api/cockpit');
    expect(root.innerHTML).toContain('relay');
    expect(root.innerHTML).toMatch(/limited|not repo-backed|no writable repo/i);
    expect(root.innerHTML).toContain('Product is tracked but has no writable repo configured.');
    expect(root.innerHTML).not.toMatch(/data-fix-item-id|data-plan-item-id|data-run-id=["']run-/i);
  });

  it('keeps chat as the scoped dominant product panel', async () => {
    const { renderProductDeepView } = await import('./product-deep-view.js');

    const html = renderProductDeepView(productView());

    expect(html).toMatch(/product-deep-view|deep-view/i);
    expect(html).toMatch(/data-surface=["']chat["']/i);
    expect(html).toMatch(/data-chat-scope=["']product["']|data-product=["']aura["']/i);
    expect(html).toMatch(/chat-panel--primary|data-panel-priority=["']primary["']|aria-label=["'][^"']*product chat/i);
    expect(html).not.toMatch(/chat-panel--secondary|data-panel-priority=["']secondary["']/i);
  });

  it('renders the live run panel from activeRun plus the live snapshot: task progress, agents, elapsed, logs, worktree path, and transcript link', async () => {
    const { renderProductDeepView } = await import('./product-deep-view.js');

    const html = renderProductDeepView(productView(), {
      activeSidePanel: 'runs',
      liveRuns: { 'run-live-1': liveSnapshot },
    });

    expect(html).toContain('run-live-1');
    expect(html).toContain('17-cockpit-redesign');
    expect(html).toMatch(/4\s*(\/|of)\s*9|4\s+done/i);
    expect(html).toMatch(/running/i);
    expect(html).toMatch(/2m5s|2m10s|2\s*min/i);
    expect(html).toContain(LIVE_WORKTREE_PATH);
    expect(html).toMatch(/qa[\s\S]*active|active[\s\S]*qa/i);
    expect(html).toMatch(/coder[\s\S]*active|active[\s\S]*coder/i);
    expect(html).toContain('qa wrote failing tests');
    expect(html).toContain('coder edited src/server/static/product-deep-view.js');
    expect(html).toContain('/api/work-runs/run-live-1/transcript');
    expect(html).toContain('/api/work-runs/run-recent-1/transcript');
    expect(html).toMatch(/no-op/i);
  });

  it('labels the run roster as Agent activity, shows each agent model, and renders the classified terminal outcome from live state', async () => {
    const { renderProductDeepView } = await import('./product-deep-view.js');

    const html = renderProductDeepView(productView(), {
      activeSidePanel: 'runs',
      liveRuns: {
        'run-live-1': {
          ...liveSnapshot,
          state: 'completed',
          outcome: 'partial',
          elapsedMs: 185_000,
          agents: [
            { role: 'pm', active: false, model: 'claude' },
            { role: 'tech-lead', active: false, model: 'codex' },
            { role: 'coder', active: false, model: 'codex' },
            { role: 'reviewer', active: false, model: 'claude' },
          ],
          lastLogLines: ['classified outcome: partial'],
        },
      },
    });

    expect(html).toMatch(/Agent activity/i);
    expect(html).not.toMatch(/Claude activity/i);
    for (const [role, model] of [
      ['pm', 'claude'],
      ['tech-lead', 'codex'],
      ['coder', 'codex'],
      ['reviewer', 'claude'],
    ]) {
      expect(html).toMatch(new RegExp(`${role}[\\s\\S]{0,180}${model}|${model}[\\s\\S]{0,180}${role}`, 'i'));
    }
    expect(html).toMatch(/completed[\s\S]{0,180}partial|partial[\s\S]{0,180}completed/i);
  });

  it('keeps the most-recent run transcript readable from the Runs panel even when no run is active', async () => {
    const { renderProductDeepView } = await import('./product-deep-view.js');

    const html = renderProductDeepView(
      productView({
        activeRun: undefined,
        runs: [
          {
            runId: 'run-most-recent',
            target: { kind: 'project', slug: '17-cockpit-redesign' },
            outcome: 'failed',
            endedAt: '2026-06-23T14:00:00.000Z',
            transcriptUrl: '/api/work-runs/run-most-recent/transcript',
          },
          {
            runId: 'run-older',
            target: { kind: 'bug', slug: 'BUG-available' },
            outcome: 'completed',
            endedAt: '2026-06-23T13:00:00.000Z',
            transcriptUrl: '/api/work-runs/run-older/transcript',
          },
        ],
      }),
      { activeSidePanel: 'runs' },
    );

    expect(html).toMatch(/run-most-recent[\s\S]{0,260}failed/i);
    expect(html).toMatch(
      /run-most-recent[\s\S]{0,320}href=["']\/api\/work-runs\/run-most-recent\/transcript["'][\s\S]{0,120}>Transcript</i,
    );
  });

  it('rehydrates a focused run from /live and merges streamed run-feed updates into the rendered panel', async () => {
    const { createProductDeepView } = await import('./product-deep-view.js');
    const root = makeRoot();
    const fetchJson = vi.fn(async (url: string) => {
      if (url === '/api/products/aura') return productView();
      if (url === '/api/work-runs/run-live-1/live') return liveSnapshot;
      throw new Error(`unexpected fetch ${url}`);
    });
    let onState: ((state: unknown) => void) | undefined;
    const subscription = { connect: vi.fn(async () => {}), reconnect: vi.fn(), close: vi.fn() };
    const createRunFeedSubscription = vi.fn((opts: { onState: (state: unknown) => void }) => {
      onState = opts.onState;
      return subscription;
    });

    const view = createProductDeepView({
      root,
      product: 'aura',
      focusRunId: 'run-live-1',
      fetchJson,
      createRunFeedSubscription,
    });
    await view.load();
    onState?.({
      ...liveSnapshot,
      tasks: { done: 5, total: 9 },
      lastLogLines: [...liveSnapshot.lastLogLines, 'reviewer read the diff'],
      elapsedMs: 145_000,
    });

    expect(fetchJson).toHaveBeenCalledWith('/api/products/aura');
    expect(fetchJson).toHaveBeenCalledWith('/api/work-runs/run-live-1/live');
    expect(createRunFeedSubscription).toHaveBeenCalledWith(expect.objectContaining({
      runId: 'run-live-1',
      fetchJson,
    }));
    expect(subscription.connect).toHaveBeenCalledTimes(1);
    expect(root.innerHTML).toMatch(/5\s*(\/|of)\s*9|5\s+done/i);
    expect(root.innerHTML).toContain('reviewer read the diff');
  });

  it('applies product run-event progress frames to the live Runs panel', async () => {
    const listeners = new Map<string, (event: unknown) => void>();
    const previousWindow = (globalThis as any).window;
    (globalThis as any).window = {
      addEventListener: vi.fn((type: string, listener: (event: unknown) => void) => {
        listeners.set(type, listener);
      }),
      removeEventListener: vi.fn(),
    };
    try {
      const { createProductDeepView } = await import('./product-deep-view.js');
      const root = makeRoot();
      const fetchJson = vi.fn(async (url: string) => {
        if (url === '/api/products/aura') return productView();
        if (url === '/api/work-runs/run-live-1/live') return liveSnapshot;
        throw new Error(`unexpected fetch ${url}`);
      });
      let onState: ((state: unknown) => void) | undefined;
      const createRunFeedSubscription = vi.fn((opts: { onState: (state: unknown) => void }) => {
        onState = opts.onState;
        return {
          connect: vi.fn(async () => {}),
          close: vi.fn(),
          applyEvent(event: any) {
            onState?.({
              ...liveSnapshot,
              tasks: event.tasks || liveSnapshot.tasks,
              ts: event.ts,
            });
          },
        };
      });

      const view = createProductDeepView({
        root,
        product: 'aura',
        fetchJson,
        createRunFeedSubscription,
      });
      await view.load();

      expect(root.innerHTML).toMatch(/4\s*(\/|of)\s*9|4\s+done/i);
      listeners.get('rune-webview-frame')?.({
        detail: {
          kind: 'run-event',
          subKind: 'progress',
          runId: 'run-live-1',
          product: 'aura',
          target: { kind: 'project', slug: '17-cockpit-redesign' },
          tasks: { done: 5, total: 9 },
          ts: '2026-06-23T12:02:00.000Z',
        },
      });

      expect(root.innerHTML).toMatch(/5\s*(\/|of)\s*9|5\s+done/i);
      expect(root.innerHTML).toMatch(/4 remaining/i);
      view.close();
    } finally {
      if (previousWindow === undefined) delete (globalThis as any).window;
      else (globalThis as any).window = previousWindow;
    }
  });

  it('preserves in-progress chat composer text across a live run-event re-render', async () => {
    const listeners = new Map<string, (event: unknown) => void>();
    const previousWindow = (globalThis as any).window;
    (globalThis as any).window = {
      addEventListener: vi.fn((type: string, listener: (event: unknown) => void) => {
        listeners.set(type, listener);
      }),
      removeEventListener: vi.fn(),
    };
    try {
      const { createProductDeepView } = await import('./product-deep-view.js');
      const root = makeRoot();
      const fetchJson = vi.fn(async (url: string) => {
        if (url === '/api/products/aura') return productView();
        if (url === '/api/work-runs/run-live-1/live') return liveSnapshot;
        throw new Error(`unexpected fetch ${url}`);
      });
      const view = createProductDeepView({ root, product: 'aura', fetchJson });
      await view.load();

      // The user is mid-typing a chat message when run telemetry arrives.
      root.chatInput.value = 'half-written question about the run';
      listeners.get('rune-webview-frame')?.({
        detail: {
          kind: 'run-event',
          subKind: 'log',
          runId: 'run-live-1',
          product: 'aura',
          target: { kind: 'project', slug: '17-cockpit-redesign' },
          lines: ['reviewer started reading the diff'],
          ts: '2026-06-23T12:03:00.000Z',
        },
      });

      expect(root.chatInput.value).toBe('half-written question about the run');
      view.close();
    } finally {
      if (previousWindow === undefined) delete (globalThis as any).window;
      else (globalThis as any).window = previousWindow;
    }
  });

  it('does not yank the user off the Operations panel when a run-event arrives', async () => {
    const listeners = new Map<string, (event: unknown) => void>();
    const previousWindow = (globalThis as any).window;
    (globalThis as any).window = {
      addEventListener: vi.fn((type: string, listener: (event: unknown) => void) => {
        listeners.set(type, listener);
      }),
      removeEventListener: vi.fn(),
    };
    try {
      const { createProductDeepView } = await import('./product-deep-view.js');
      const root = makeRoot();
      const fetchJson = vi.fn(async (url: string) => {
        if (url === '/api/products/aura') return productView();
        if (url === '/api/work-runs/run-live-1/live') return liveSnapshot;
        throw new Error(`unexpected fetch ${url}`);
      });
      let onState: ((state: unknown) => void) | undefined;
      const createRunFeedSubscription = vi.fn((opts: { onState: (state: unknown) => void }) => {
        onState = opts.onState;
        return {
          connect: vi.fn(async () => {}),
          close: vi.fn(),
          applyEvent: () => onState?.(liveSnapshot),
        };
      });
      const view = createProductDeepView({ root, product: 'aura', fetchJson, createRunFeedSubscription });
      await view.load();

      // The user deliberately switches the lower panel to Operations during the run.
      await root.clickClosest('[data-side-panel-tab]', { sidePanelTab: 'operations' });
      expect(root.innerHTML).toMatch(/data-active-side-panel=["']operations["']/i);

      listeners.get('rune-webview-frame')?.({
        detail: {
          kind: 'run-event',
          subKind: 'progress',
          runId: 'run-live-1',
          product: 'aura',
          target: { kind: 'project', slug: '17-cockpit-redesign' },
          tasks: { done: 6, total: 9 },
          ts: '2026-06-23T12:04:00.000Z',
        },
      });

      expect(root.innerHTML).toMatch(/data-active-side-panel=["']operations["']/i);
      view.close();
    } finally {
      if (previousWindow === undefined) delete (globalThis as any).window;
      else (globalThis as any).window = previousWindow;
    }
  });

  it('reconciles the product model when a run terminates on its own so Cancel flips back to Start', async () => {
    const listeners = new Map<string, (event: unknown) => void>();
    const previousWindow = (globalThis as any).window;
    (globalThis as any).window = {
      addEventListener: vi.fn((type: string, listener: (event: unknown) => void) => {
        listeners.set(type, listener);
      }),
      removeEventListener: vi.fn(),
    };
    try {
      const { createProductDeepView } = await import('./product-deep-view.js');
      const root = makeRoot();
      let state = {
        mutations: {
          active: [{
            id: 'mut-live-project',
            kind: 'work-run',
            status: 'running',
            payload: { product: 'aura', projectSlug: '17-cockpit-redesign' },
          }] as any[],
        },
      };
      const fetchJson = vi.fn(async (url: string) => {
        if (url === '/api/products/aura') {
          return state.mutations.active.length ? productView() : productView({ activeRun: undefined });
        }
        if (url === '/api/state') return state;
        if (url === '/api/work-runs/run-live-1/live') return liveSnapshot;
        throw new Error(`unexpected fetch ${url}`);
      });
      let onState: ((state: unknown) => void) | undefined;
      const createRunFeedSubscription = vi.fn((opts: { onState: (state: unknown) => void }) => {
        onState = opts.onState;
        return {
          connect: vi.fn(async () => {}),
          close: vi.fn(),
          applyEvent(event: any) {
            if (event.subKind === 'state') {
              onState?.({ ...liveSnapshot, state: event.state, outcome: event.outcome, elapsedMs: event.elapsedMs, ts: event.ts });
            }
          },
        };
      });

      const view = createProductDeepView({ root, product: 'aura', fetchJson, postJson: vi.fn(), loadOperations: true, createRunFeedSubscription });
      await view.load();
      expect(root.innerHTML).toMatch(/data-project-run-action=["']cancel["']/i);

      // The run ends on its own — no operator click, only the terminal frame.
      state = { mutations: { active: [] } };
      const terminalFrame = {
        kind: 'run-event',
        subKind: 'state',
        runId: 'run-live-1',
        product: 'aura',
        target: { kind: 'project', slug: '17-cockpit-redesign' },
        state: 'failed',
        outcome: 'failed',
        elapsedMs: 200_000,
        ts: '2026-06-23T12:05:00.000Z',
      };
      listeners.get('rune-webview-frame')?.({ detail: terminalFrame });
      listeners.get('rune-webview-frame')?.({ detail: { ...terminalFrame, ts: '2026-06-23T12:05:01.000Z' } });
      await new Promise(resolve => setTimeout(resolve, 0));

      // One initial load + one reconcile — the second frame is deduped by the in-flight guard.
      expect(fetchJson.mock.calls.filter(call => call[0] === '/api/products/aura').length).toBe(2);
      expect(root.innerHTML).toMatch(/data-project-run-action=["']start["'][\s\S]{0,120}>Start</i);
      expect(root.innerHTML).toContain('No active run');
      view.close();
    } finally {
      if (previousWindow === undefined) delete (globalThis as any).window;
      else (globalThis as any).window = previousWindow;
    }
  });

  it('does not re-fetch the product model on non-terminal run state frames', async () => {
    const listeners = new Map<string, (event: unknown) => void>();
    const previousWindow = (globalThis as any).window;
    (globalThis as any).window = {
      addEventListener: vi.fn((type: string, listener: (event: unknown) => void) => {
        listeners.set(type, listener);
      }),
      removeEventListener: vi.fn(),
    };
    try {
      const { createProductDeepView } = await import('./product-deep-view.js');
      const root = makeRoot();
      const fetchJson = vi.fn(async (url: string) => {
        if (url === '/api/products/aura') return productView();
        if (url === '/api/state') return { mutations: { active: [] } };
        if (url === '/api/work-runs/run-live-1/live') return liveSnapshot;
        throw new Error(`unexpected fetch ${url}`);
      });
      let onState: ((state: unknown) => void) | undefined;
      const createRunFeedSubscription = vi.fn((opts: { onState: (state: unknown) => void }) => {
        onState = opts.onState;
        return {
          connect: vi.fn(async () => {}),
          close: vi.fn(),
          applyEvent(event: any) {
            if (event.subKind === 'state') {
              onState?.({ ...liveSnapshot, state: event.state, elapsedMs: event.elapsedMs, ts: event.ts });
            }
          },
        };
      });
      const view = createProductDeepView({ root, product: 'aura', fetchJson, loadOperations: true, createRunFeedSubscription });
      await view.load();

      listeners.get('rune-webview-frame')?.({
        detail: {
          kind: 'run-event',
          subKind: 'state',
          runId: 'run-live-1',
          product: 'aura',
          target: { kind: 'project', slug: '17-cockpit-redesign' },
          state: 'running',
          elapsedMs: 140_000,
          ts: '2026-06-23T12:05:00.000Z',
        },
      });
      await new Promise(resolve => setTimeout(resolve, 0));

      expect(fetchJson.mock.calls.filter(call => call[0] === '/api/products/aura').length).toBe(1);
      view.close();
    } finally {
      if (previousWindow === undefined) delete (globalThis as any).window;
      else (globalThis as any).window = previousWindow;
    }
  });

  it('marks the run roster idle from the terminal frame even before the product re-fetch lands', async () => {
    const listeners = new Map<string, (event: unknown) => void>();
    const previousWindow = (globalThis as any).window;
    (globalThis as any).window = {
      addEventListener: vi.fn((type: string, listener: (event: unknown) => void) => {
        listeners.set(type, listener);
      }),
      removeEventListener: vi.fn(),
    };
    try {
      const { createProductDeepView } = await import('./product-deep-view.js');
      const root = makeRoot();
      let terminalPhase = false;
      const fetchJson = vi.fn((url: string) => {
        // After the terminal frame, the reconcile re-fetch hangs — the roster
        // must already read idle from the frame alone.
        if (terminalPhase && (url === '/api/products/aura' || url === '/api/state')) {
          return new Promise(() => {});
        }
        if (url === '/api/products/aura') return Promise.resolve(productView());
        if (url === '/api/state') return Promise.resolve({ mutations: { active: [] } });
        if (url === '/api/work-runs/run-live-1/live') return Promise.resolve(liveSnapshot);
        return Promise.reject(new Error(`unexpected fetch ${url}`));
      });
      let onState: ((state: unknown) => void) | undefined;
      const createRunFeedSubscription = vi.fn((opts: { onState: (state: unknown) => void }) => {
        onState = opts.onState;
        return {
          connect: vi.fn(async () => {}),
          close: vi.fn(),
          applyEvent(event: any) {
            if (event.subKind === 'state') {
              onState?.({ ...liveSnapshot, state: event.state, outcome: event.outcome, elapsedMs: event.elapsedMs, ts: event.ts });
            }
          },
        };
      });
      const view = createProductDeepView({ root, product: 'aura', fetchJson, loadOperations: true, createRunFeedSubscription });
      await view.load();

      terminalPhase = true;
      listeners.get('rune-webview-frame')?.({
        detail: {
          kind: 'run-event',
          subKind: 'state',
          runId: 'run-live-1',
          product: 'aura',
          target: { kind: 'project', slug: '17-cockpit-redesign' },
          state: 'failed',
          outcome: 'failed',
          elapsedMs: 200_000,
          ts: '2026-06-23T12:05:00.000Z',
        },
      });
      await new Promise(resolve => setTimeout(resolve, 0));

      const roster = root.innerHTML.match(/<ul class="deep-agents">[\s\S]*?<\/ul>/)?.[0] ?? '';
      expect(roster).toContain('qa');
      expect(roster).toContain('coder');
      expect(roster).not.toContain('>active<');
      expect(roster.match(/>idle</g)?.length).toBe(2);
      expect(root.innerHTML).toContain('status-pill pill-failed');
      expect(root.innerHTML).toMatch(/pill-failed["'][^>]*>failed</i);
      view.close();
    } finally {
      if (previousWindow === undefined) delete (globalThis as any).window;
      else (globalThis as any).window = previousWindow;
    }
  });

  it('derives the run-card status pill class from live run state', async () => {
    const { renderProductDeepView } = await import('./product-deep-view.js');

    for (const [state, pill] of [
      ['failed', 'pill-failed'],
      ['completed', 'pill-done'],
      ['running', 'pill-inprogress'],
      ['partial', 'pill-warn'],
    ] as const) {
      const html = renderProductDeepView(productView(), {
        activeSidePanel: 'runs',
        liveRuns: { 'run-live-1': { ...liveSnapshot, state } },
      });
      expect(html).toContain(`status-pill ${pill}`);
    }
  });

  it('renders every Fix state while retaining Plan for bugs and ideas and never exposing Fix on ideas', async () => {
    const { renderProductDeepView } = await import('./product-deep-view.js');

    const html = renderProductDeepView(productView());

    for (const id of ['BUG-available', 'BUG-gating', 'BUG-declined', 'BUG-handoff', 'BUG-proceeding']) {
      expect(html).toContain(id);
      expect(html).toMatch(new RegExp(`data-plan-item-id=["']${id}["']|${id}[\\s\\S]{0,240}\\bPlan\\b`, 'i'));
      expect(html).toMatch(new RegExp(`data-fix-item-id=["']${id}["']|${id}[\\s\\S]{0,240}\\bFix\\b`, 'i'));
    }
    expect(html).toMatch(/BUG-available[\s\S]{0,260}(available|Fix)/i);
    expect(html).toMatch(/BUG-gating[\s\S]{0,260}(gating|scoping|disabled)/i);
    expect(html).toMatch(/BUG-declined[\s\S]{0,320}pm-not-well-scoped/i);
    expect(html).toMatch(/BUG-declined[\s\S]{0,420}Needs concrete reproduction steps before autorun can start/i);
    expect(html).toMatch(/BUG-handoff[\s\S]{0,320}handoff-unavailable/i);
    expect(html).toMatch(/BUG-handoff[\s\S]{0,320}startFixRun unavailable/i);
    expect(html).toMatch(/BUG-proceeding[\s\S]{0,320}run-fix-accepted/i);
    expect(html).not.toContain('BUG-disabled');
    expect(html).toMatch(/IDEA-1[\s\S]{0,240}\bPlan\b/i);
    expect(html).not.toMatch(/IDEA-1[\s\S]{0,240}\bFix\b/i);
  });

  it('honors the real Plan action enabled/disabledReason contract from the API', async () => {
    const { renderProductDeepView } = await import('./product-deep-view.js');

    const html = renderProductDeepView(productView());
    const disabledRow = html.match(/<article class="deep-backlog-item deep-backlog-item--bugs" data-backlog-item-id="BUG-plan-disabled">[\s\S]*?<\/article>/)?.[0] ?? '';

    expect(disabledRow).toContain('Already promoted');
    expect(disabledRow).toMatch(/data-plan-item-id=["']BUG-plan-disabled["'][^>]*disabled/i);
    expect(disabledRow).toContain('already-promoted');
  });

  it('renders backlog titles as the primary label, IDs as metadata, and file warnings with file, line, and code', async () => {
    const { renderProductDeepView } = await import('./product-deep-view.js');

    const html = renderProductDeepView(productView());
    const bugRow = html.match(/<article class="deep-backlog-item deep-backlog-item--bugs" data-backlog-item-id="BUG-available">[\s\S]*?<\/article>/)?.[0] ?? '';
    const ideaRow = html.match(/<article class="deep-backlog-item deep-backlog-item--ideas" data-backlog-item-id="IDEA-1">[\s\S]*?<\/article>/)?.[0] ?? '';

    expect(bugRow.indexOf('Crash when saving')).toBeGreaterThanOrEqual(0);
    expect(bugRow.indexOf('Crash when saving')).toBeLessThan(bugRow.indexOf('deep-item-id'));
    expect(bugRow).toMatch(/deep-item-id[\s\S]{0,80}BUG-available/i);
    expect(ideaRow.indexOf('Add a release dashboard')).toBeGreaterThanOrEqual(0);
    expect(ideaRow.indexOf('Add a release dashboard')).toBeLessThan(ideaRow.indexOf('deep-item-id'));
    expect(html).toContain('docs/projects/bugs.md:42 [non-checkbox-bullet]');
    expect(html).toContain('Unparseable backlog bullet');
  });

  it('makes Fix the headline bug action while Plan remains available as the secondary action', async () => {
    const { renderProductDeepView } = await import('./product-deep-view.js');

    const html = renderProductDeepView(productView());
    const bugRow = html.match(/<article class="deep-backlog-item deep-backlog-item--bugs" data-backlog-item-id="BUG-available">[\s\S]*?<\/article>/)?.[0];
    expect(bugRow, 'expected BUG-available row to render').toBeTypeOf('string');

    const fixIndex = bugRow!.indexOf('data-fix-item-id="BUG-available"');
    const planIndex = bugRow!.indexOf('data-plan-item-id="BUG-available"');
    expect(fixIndex, 'expected bug row to expose a Fix action').toBeGreaterThanOrEqual(0);
    expect(planIndex, 'expected bug row to retain a Plan action').toBeGreaterThanOrEqual(0);
    expect(fixIndex, 'Fix must appear before Plan for bugs because it is the headline action').toBeLessThan(planIndex);
    expect(bugRow).toMatch(/deep-action--headline|data-primary-action=["']fix["']|aria-label=["'][^"']*Fix[^"']*headline/i);

    const ideaRow = html.match(/<article class="deep-backlog-item deep-backlog-item--ideas" data-backlog-item-id="IDEA-1">[\s\S]*?<\/article>/)?.[0];
    expect(ideaRow, 'expected IDEA-1 row to render').toBeTypeOf('string');
    expect(ideaRow).toContain('data-plan-item-id="IDEA-1"');
    expect(ideaRow).not.toContain('data-fix-item-id="IDEA-1"');
  });

  it('posts an available bug Fix asynchronously, disables the affordance, and shows the durable gating attempt id', async () => {
    const { createProductDeepView } = await import('./product-deep-view.js');
    const root = makeRoot();
    const fetchJson = vi.fn(async () => productView());
    const postJson = vi.fn(async (url: string) => {
      expect(url).toBe('/api/backlog/aura/items/BUG-available/fix');
      return { attemptId: 'fix-attempt-1' };
    });

    const view = createProductDeepView({ root, product: 'aura', fetchJson, postJson });
    await view.load();
    await root.clickClosest('[data-fix-item-id]', { fixItemId: 'BUG-available' });

    expect(postJson).toHaveBeenCalledTimes(1);
    expect(root.innerHTML).toMatch(/fix-attempt-1|gating|scoping/i);
    expect(root.innerHTML).toMatch(/BUG-available[\s\S]{0,320}(disabled|aria-busy=["']true["']|gating|scoping)/i);
  });

  it('tears down delegated root listeners on close so product re-navigation does not duplicate actions', async () => {
    const { createProductDeepView } = await import('./product-deep-view.js');
    const root = makeRoot();
    const fetchJson = vi.fn(async () => productView());
    const postJson = vi.fn(async () => ({ attemptId: 'fix-attempt-1' }));
    const sendChat = vi.fn(async () => ({ ok: true }));

    const first = createProductDeepView({ root, product: 'aura', fetchJson, postJson, sendChat });
    await first.load();
    first.close();
    const second = createProductDeepView({ root, product: 'aura', fetchJson, postJson, sendChat });
    await second.load();

    await root.clickClosest('[data-fix-item-id]', { fixItemId: 'BUG-available' });
    await root.submitClosest('[data-product-chat-form]', { product: 'aura', message: '/fresh' });

    expect(root.removeEventListener).toHaveBeenCalledWith('click', expect.any(Function));
    expect(root.removeEventListener).toHaveBeenCalledWith('submit', expect.any(Function));
    expect(postJson).toHaveBeenCalledTimes(1);
    expect(sendChat).toHaveBeenCalledTimes(1);
  });

  it('keeps per-product operational controls reachable in the deep view without cross-product rail controls', async () => {
    const { renderProductDeepView } = await import('./product-deep-view.js');

    const html = renderProductDeepView(productView(), { operations: productOperations });

    expect(html).toMatch(/op-live-1[\s\S]{0,180}cancel|cancel[\s\S]{0,180}op-live-1/i);
    expect(html).toMatch(/mut-live-1[\s\S]{0,180}cancel|cancel[\s\S]{0,180}mut-live-1/i);
    expect(html).toMatch(/planning[\s\S]{0,160}aura|aura[\s\S]{0,160}planning/i);
    expect(html).not.toMatch(/data-approval-action|pending approvals|blocked-on-human:run-parked-1/i);
    expect(html).not.toMatch(/data-restart-server|restart server|global status/i);
  });

  it('renders project-card Start by default and Cancel for a matching active work mutation from operations state', async () => {
    const { createProductDeepView, renderProductDeepView } = await import('./product-deep-view.js');

    expect(renderProductDeepView(productView({
      projects: [
        {
          slug: '17-cockpit-redesign',
          lifecycle: 'active',
          taskProgress: { done: 4, total: 9 },
          runControl: { state: 'start', dispatchMode: 'legacy', fallbackReason: 'operator override' },
        },
      ],
    }))).toMatch(/data-project-run-action=["']start["'][\s\S]{0,160}>Start</i);

    const root = makeRoot();
    const fetchJson = vi.fn(async (url: string) => {
      if (url === '/api/products/aura') {
        return productView({
          projects: [
            {
              slug: '17-cockpit-redesign',
              lifecycle: 'active',
              taskProgress: { done: 4, total: 9 },
              runControl: { state: 'start', dispatchMode: 'legacy' },
            },
          ],
        });
      }
      if (url === '/api/state') {
        return {
          mutations: {
            active: [
              {
                id: 'mut-project-live',
                kind: 'orchestrated-work',
                status: 'running',
                payload: { product: 'aura', projectSlug: '17-cockpit-redesign', dispatchMode: 'orchestrated' },
              },
              {
                id: 'mut-other-project',
                kind: 'work-run',
                status: 'running',
                payload: { product: 'aura', projectSlug: 'other-project' },
              },
              {
                id: 'mut-other-product',
                kind: 'work-run',
                status: 'running',
                payload: { product: 'relay', projectSlug: '17-cockpit-redesign' },
              },
            ],
          },
        };
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    const view = createProductDeepView({ root, product: 'aura', fetchJson, loadOperations: true });
    await view.load();

    expect(root.innerHTML).toMatch(/data-project-run-action=["']cancel["'][\s\S]{0,180}data-mutation-id=["']mut-project-live["']/i);
    expect(root.innerHTML).not.toMatch(/data-project-run-action=["']cancel["'][\s\S]{0,180}data-mutation-id=["']mut-other-project["']/i);
    expect(root.innerHTML).not.toContain('mut-other-product');
  });

  it('posts project-card Start and reloads product plus operations state so the control flips', async () => {
    const { createProductDeepView } = await import('./product-deep-view.js');
    const root = makeRoot();
    let state = { mutations: { active: [] as any[] } };
    const fetchJson = vi.fn(async (url: string) => {
      if (url === '/api/products/aura') {
        const activeRun = state.mutations.active.length ? productView().activeRun : undefined;
        return productView({
          activeRun,
          projects: [
            {
              slug: '17-cockpit-redesign',
              lifecycle: 'active',
              taskProgress: { done: 4, total: 9 },
              runControl: { state: 'start', dispatchMode: 'legacy' },
            },
          ],
        });
      }
      if (url === '/api/state') return state;
      if (url === '/api/work-runs/run-live-1/live') return liveSnapshot;
      throw new Error(`unexpected fetch ${url}`);
    });
    const postJson = vi.fn(async (url: string, body?: unknown) => {
      expect(url).toBe('/api/mutations');
      expect(body).toEqual({
        kind: 'work-run',
        payload: { product: 'aura', projectSlug: '17-cockpit-redesign' },
      });
      state = {
        mutations: {
          active: [{
            id: 'mut-started',
            kind: 'work-run',
            status: 'running',
            payload: { product: 'aura', projectSlug: '17-cockpit-redesign', dispatchMode: 'legacy' },
          }],
        },
      };
      return { id: 'mut-started' };
    });

    const view = createProductDeepView({ root, product: 'aura', fetchJson, postJson, loadOperations: true });
    await view.load();
    await root.clickClosest('[data-project-run-action]', {
      projectRunAction: 'start',
      projectSlug: '17-cockpit-redesign',
    });

    expect(postJson).toHaveBeenCalledWith('/api/mutations', {
      kind: 'work-run',
      payload: { product: 'aura', projectSlug: '17-cockpit-redesign' },
    });
    expect(fetchJson).toHaveBeenCalledWith('/api/products/aura');
    expect(fetchJson).toHaveBeenCalledWith('/api/state');
    expect(fetchJson).toHaveBeenCalledWith('/api/work-runs/run-live-1/live');
    expect(root.innerHTML).toMatch(/data-project-run-action=["']cancel["'][\s\S]{0,180}mut-started/i);
    expect(root.innerHTML).toMatch(/data-active-side-panel=["']runs["']/i);
  });

  it('posts project-card Cancel and reloads product plus operations state so the control flips back to Start', async () => {
    const { createProductDeepView } = await import('./product-deep-view.js');
    const root = makeRoot();
    let state = {
      mutations: {
        active: [{
          id: 'mut-live-project',
          kind: 'work-run',
          status: 'running',
          payload: { product: 'aura', projectSlug: '17-cockpit-redesign' },
        }],
      },
    };
    const fetchJson = vi.fn(async (url: string) => {
      if (url === '/api/products/aura') {
        return productView({
          projects: [
            {
              slug: '17-cockpit-redesign',
              lifecycle: 'active',
              taskProgress: { done: 4, total: 9 },
              runControl: { state: 'cancel', mutationId: 'mut-live-project' },
            },
          ],
        });
      }
      if (url === '/api/state') return state;
      throw new Error(`unexpected fetch ${url}`);
    });
    const postJson = vi.fn(async (url: string) => {
      expect(url).toBe('/api/mutations/mut-live-project/cancel');
      state = { mutations: { active: [] } };
      return { ok: true };
    });

    const view = createProductDeepView({ root, product: 'aura', fetchJson, postJson, loadOperations: true });
    await view.load();
    await root.clickClosest('[data-project-run-action]', {
      projectRunAction: 'cancel',
      projectSlug: '17-cockpit-redesign',
      mutationId: 'mut-live-project',
    });

    expect(postJson).toHaveBeenCalledWith('/api/mutations/mut-live-project/cancel');
    expect(root.innerHTML).toMatch(/data-project-run-action=["']start["'][\s\S]{0,120}>Start</i);
  });

  it('posts project-card Recover for active orchestrated runs', async () => {
    const { createProductDeepView } = await import('./product-deep-view.js');
    const root = makeRoot();
    const fetchJson = vi.fn(async (url: string) => {
      if (url === '/api/products/aura') {
        return productView({
          projects: [
            {
              slug: '17-cockpit-redesign',
              lifecycle: 'active',
              taskProgress: { done: 4, total: 9 },
              runControl: { state: 'cancel', mutationId: 'mut-orch-live', recoverable: true },
            },
          ],
        });
      }
      if (url === '/api/state') {
        return {
          mutations: {
            active: [{
              id: 'mut-orch-live',
              kind: 'orchestrated-work',
              status: 'running',
              recoverable: true,
              payload: { product: 'aura', projectSlug: '17-cockpit-redesign' },
            }],
          },
        };
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    const postJson = vi.fn(async (url: string) => {
      expect(url).toBe('/api/work-runs/mut-orch-live/recover');
      return { recovered: true, runId: 'mut-orch-live' };
    });

    const view = createProductDeepView({ root, product: 'aura', fetchJson, postJson, loadOperations: true });
    await view.load();
    await root.clickClosest('[data-project-run-action]', {
      projectRunAction: 'recover',
      projectSlug: '17-cockpit-redesign',
      mutationId: 'mut-orch-live',
    });

    expect(postJson).toHaveBeenCalledWith('/api/work-runs/mut-orch-live/recover');
  });

  it('hides project-card and Operations Recover controls when the server marks the worktree unavailable', async () => {
    const { createProductDeepView } = await import('./product-deep-view.js');
    const root = makeRoot();
    const mutation = {
      id: 'mut-orch-missing', kind: 'orchestrated-work', status: 'running', recoverable: false,
      payload: { product: 'aura', projectSlug: '17-cockpit-redesign' },
    };
    const fetchJson = vi.fn(async (url: string) => {
      if (url === '/api/products/aura') {
        return productView({
          projects: [{
            slug: '17-cockpit-redesign', lifecycle: 'active', taskProgress: { done: 4, total: 9 },
            runControl: { state: 'cancel', mutationId: mutation.id, recoverable: false },
          }],
        });
      }
      if (url === '/api/state') return { mutations: { active: [mutation] } };
      throw new Error(`unexpected fetch ${url}`);
    });

    const view = createProductDeepView({
      root,
      product: 'aura',
      fetchJson,
      loadOperations: true,
      operations: { ...productOperations, mutations: [mutation] },
    });
    await view.load();

    expect(root.innerHTML).not.toContain('data-recover-work-run-id');
    expect(root.innerHTML).not.toMatch(/data-project-run-action=["']recover["']/i);
    expect(root.innerHTML).toContain('data-project-run-action="cancel"');
  });

  it('keeps project-card run controls usable and renders inline errors after Start or Cancel failures', async () => {
    const { createProductDeepView } = await import('./product-deep-view.js');
    const startRoot = makeRoot();
    const fetchJson = vi.fn(async (url: string) => {
      if (url === '/api/products/aura') {
        return productView({
          projects: [{
            slug: '17-cockpit-redesign',
            lifecycle: 'active',
            taskProgress: { done: 4, total: 9 },
            runControl: { state: 'start' },
          }],
        });
      }
      if (url === '/api/state') return { mutations: { active: [] } };
      throw new Error(`unexpected fetch ${url}`);
    });

    const startView = createProductDeepView({
      root: startRoot,
      product: 'aura',
      fetchJson,
      postJson: vi.fn(async () => { throw new Error('boom'); }),
      loadOperations: true,
    });
    await startView.load();
    await startRoot.clickClosest('[data-project-run-action]', {
      projectRunAction: 'start',
      projectSlug: '17-cockpit-redesign',
    });
    expect(startRoot.innerHTML).toMatch(/Start failed: boom/i);
    expect(startRoot.innerHTML).toMatch(/data-project-run-action=["']start["'][^>]*>Start/i);

    const cancelRoot = makeRoot();
    const cancelView = createProductDeepView({
      root: cancelRoot,
      product: 'aura',
      fetchJson: vi.fn(async (url: string) => {
        if (url === '/api/products/aura') {
          return productView({
            projects: [{
              slug: '17-cockpit-redesign',
              lifecycle: 'active',
              taskProgress: { done: 4, total: 9 },
              runControl: { state: 'cancel', mutationId: 'mut-live-project' },
            }],
          });
        }
        if (url === '/api/state') {
          return {
            mutations: {
              active: [{
                id: 'mut-live-project',
                kind: 'work-run',
                status: 'running',
                payload: { product: 'aura', projectSlug: '17-cockpit-redesign' },
              }],
            },
          };
        }
        throw new Error(`unexpected fetch ${url}`);
      }),
      postJson: vi.fn(async () => { throw new Error('nope'); }),
      loadOperations: true,
    });
    await cancelView.load();
    await cancelRoot.clickClosest('[data-project-run-action]', {
      projectRunAction: 'cancel',
      projectSlug: '17-cockpit-redesign',
      mutationId: 'mut-live-project',
    });
    expect(cancelRoot.innerHTML).toMatch(/Cancel failed: nope/i);
    expect(cancelRoot.innerHTML).toMatch(/data-project-run-action=["']cancel["'][\s\S]{0,180}mut-live-project/i);
  });

  it('aborts project-card Start (no POST) when the confirmation is declined', async () => {
    const { createProductDeepView } = await import('./product-deep-view.js');
    const previousWindow = (globalThis as any).window;
    const confirmFn = vi.fn(() => false);
    (globalThis as any).window = {
      confirm: confirmFn,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    try {
      const root = makeRoot();
      const postJson = vi.fn(async () => ({ id: 'should-not-happen' }));
      const fetchJson = vi.fn(async (url: string) => {
        if (url === '/api/products/aura') {
          return productView({
            projects: [{
              slug: '17-cockpit-redesign',
              lifecycle: 'active',
              taskProgress: { done: 4, total: 9 },
              runControl: { state: 'start', dispatchMode: 'legacy', fallbackReason: 'toggle off' },
            }],
          });
        }
        if (url === '/api/state') return { mutations: { active: [] } };
        throw new Error(`unexpected fetch ${url}`);
      });
      const view = createProductDeepView({ root, product: 'aura', fetchJson, postJson, loadOperations: true });
      await view.load();
      await root.clickClosest('[data-project-run-action]', {
        projectRunAction: 'start',
        projectSlug: '17-cockpit-redesign',
      });
      expect(confirmFn).toHaveBeenCalledTimes(1);
      expect(postJson).not.toHaveBeenCalled();
      expect(root.innerHTML).toMatch(/data-project-run-action=["']start["'][^>]*>Start/i);
    } finally {
      if (previousWindow === undefined) delete (globalThis as any).window;
      else (globalThis as any).window = previousWindow;
    }
  });

  it('proceeds with project-card Start when the confirmation is accepted', async () => {
    const { createProductDeepView } = await import('./product-deep-view.js');
    const previousWindow = (globalThis as any).window;
    (globalThis as any).window = {
      confirm: vi.fn(() => true),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    try {
      const root = makeRoot();
      const postJson = vi.fn(async () => ({ id: 'mut-started' }));
      const fetchJson = vi.fn(async (url: string) => {
        if (url === '/api/products/aura') {
          return productView({
            projects: [{
              slug: '17-cockpit-redesign',
              lifecycle: 'active',
              taskProgress: { done: 4, total: 9 },
              runControl: { state: 'start' },
            }],
          });
        }
        if (url === '/api/state') return { mutations: { active: [] } };
        throw new Error(`unexpected fetch ${url}`);
      });
      const view = createProductDeepView({ root, product: 'aura', fetchJson, postJson, loadOperations: true });
      await view.load();
      await root.clickClosest('[data-project-run-action]', {
        projectRunAction: 'start',
        projectSlug: '17-cockpit-redesign',
      });
      expect(postJson).toHaveBeenCalledWith('/api/mutations', {
        kind: 'work-run',
        payload: { product: 'aura', projectSlug: '17-cockpit-redesign' },
      });
    } finally {
      if (previousWindow === undefined) delete (globalThis as any).window;
      else (globalThis as any).window = previousWindow;
    }
  });

  it('surfaces the server error reason inline when a default-path Start is rejected', async () => {
    const { createProductDeepView } = await import('./product-deep-view.js');
    const root = makeRoot();
    const fetchJson = vi.fn(async (url: string) => {
      if (url === '/api/products/aura') {
        return productView({
          projects: [{
            slug: '17-cockpit-redesign',
            lifecycle: 'active',
            taskProgress: { done: 4, total: 9 },
            runControl: { state: 'start' },
          }],
        });
      }
      if (url === '/api/state') return { mutations: { active: [] } };
      throw new Error(`unexpected fetch ${url}`);
    });
    const previousFetch = (globalThis as any).fetch;
    // No postJson injected → exercises the real defaultPostJson over global fetch,
    // which must surface the server's {error} body rather than a bare status.
    (globalThis as any).fetch = vi.fn(async () => ({
      ok: false,
      status: 409,
      json: async () => ({ error: 'global work-run cap reached' }),
    }));
    try {
      const view = createProductDeepView({ root, product: 'aura', fetchJson, loadOperations: true });
      await view.load();
      await root.clickClosest('[data-project-run-action]', {
        projectRunAction: 'start',
        projectSlug: '17-cockpit-redesign',
      });
      expect(root.innerHTML).toMatch(/Start failed: global work-run cap reached/i);
      expect(root.innerHTML).toMatch(/data-project-run-action=["']start["'][^>]*>Start/i);
    } finally {
      if (previousFetch === undefined) delete (globalThis as any).fetch;
      else (globalThis as any).fetch = previousFetch;
    }
  });

  it('preserves an active Cancel control when the /api/state fetch fails on load', async () => {
    const { createProductDeepView } = await import('./product-deep-view.js');
    const root = makeRoot();
    const fetchJson = vi.fn(async (url: string) => {
      if (url === '/api/products/aura') {
        return productView({
          projects: [{
            slug: '17-cockpit-redesign',
            lifecycle: 'active',
            taskProgress: { done: 4, total: 9 },
            runControl: { state: 'cancel', mutationId: 'mut-server' },
          }],
        });
      }
      if (url === '/api/state') throw new Error('state unavailable');
      throw new Error(`unexpected fetch ${url}`);
    });
    const view = createProductDeepView({ root, product: 'aura', fetchJson, loadOperations: true });
    await view.load();
    // /api/state rejected → overlay must keep the server's cancel control, not reset to start.
    expect(root.innerHTML).toMatch(/data-project-run-action=["']cancel["'][\s\S]{0,180}mut-server/i);
  });

  it('posts per-product op and mutation cancels from the deep view through the existing cancel endpoints', async () => {
    const { createProductDeepView } = await import('./product-deep-view.js');
    const root = makeRoot();
    const postJson = vi.fn(async () => ({ ok: true }));
    const operations = {
      ...productOperations,
      mutations: [
        ...(productOperations.mutations || []),
        {
          id: 'mut-orch-live',
          kind: 'orchestrated-work',
          status: 'running',
          recoverable: true,
          payload: { product: 'aura', projectSlug: '17-cockpit-redesign' },
        },
      ],
    };

    const view = createProductDeepView({
      root,
      product: 'aura',
      // No active run, so the lower panel defaults to Operations where the
      // cancel controls live (the cancel buttons come from productOperations,
      // independent of any active run).
      fetchJson: vi.fn(async () => productView({ activeRun: undefined })),
      postJson,
      operations,
    });
    await view.load();
    expect(root.innerHTML).toMatch(/data-active-side-panel=["']operations["']/i);
    expect(root.innerHTML).toMatch(/data-surface=["']operations["'][\s\S]*data-cancel-op-id=["']op-live-1["']/i);
    expect(root.innerHTML).toMatch(/data-surface=["']operations["'][\s\S]*data-cancel-mutation-id=["']mut-live-1["']/i);
    expect(root.innerHTML).toMatch(/data-surface=["']operations["'][\s\S]*data-recover-work-run-id=["']mut-orch-live["']/i);

    await root.clickClosest('[data-cancel-op-id]', { cancelOpId: 'op-live-1' });
    await root.clickClosest('[data-cancel-mutation-id]', { cancelMutationId: 'mut-live-1' });
    await root.clickClosest('[data-recover-work-run-id]', { recoverWorkRunId: 'mut-orch-live' });

    expect(postJson).toHaveBeenCalledWith('/api/ops/op-live-1/cancel');
    expect(postJson).toHaveBeenCalledWith('/api/mutations/mut-live-1/cancel');
    expect(postJson).toHaveBeenCalledWith('/api/work-runs/mut-orch-live/recover');
  });

  it('renders product-local op status from WebSocket op-event frames and logs activity in Operations', async () => {
    const listeners = new Map<string, (event: unknown) => void>();
    const previousWindow = (globalThis as any).window;
    (globalThis as any).window = {
      addEventListener: vi.fn((type: string, listener: (event: unknown) => void) => {
        listeners.set(type, listener);
      }),
      removeEventListener: vi.fn(),
    };
    try {
      const { createProductDeepView } = await import('./product-deep-view.js');
      const root = makeRoot();
      const view = createProductDeepView({
        root,
        product: 'aura',
        // No active run, so the lower panel defaults to Operations where the
        // logged op activity ([data-product-op-activity]) is rendered.
        fetchJson: vi.fn(async () => productView({ activeRun: undefined })),
      });
      await view.load();

      listeners.get('rune-webview-frame')?.({
        detail: {
          kind: 'op-event',
          product: 'aura',
          subKind: 'start',
          opKind: 'chat',
          opId: 'op-chat-1',
          label: 'webview chat',
          startedAt: '2026-06-24T12:00:00.000Z',
          elapsedMs: 0,
        },
      });

      expect(root.innerHTML).toMatch(/data-product-chat-op-status/i);
      expect(root.innerHTML).toMatch(/Asking Claude/i);
      expect(root.innerHTML).toMatch(/data-cancel-op-id=["']op-chat-1["']/i);

      listeners.get('rune-webview-frame')?.({
        detail: {
          kind: 'op-event',
          product: 'aura',
          subKind: 'progress',
          opKind: 'chat',
          opId: 'op-chat-1',
          label: 'webview chat',
          startedAt: '2026-06-24T12:00:00.000Z',
          elapsedMs: 1000,
          detail: 'Read: package.json',
        },
      });

      expect(root.innerHTML).toMatch(/data-product-op-activity/i);
      expect(root.innerHTML).toContain('Read: package.json');

      listeners.get('rune-webview-frame')?.({
        detail: {
          kind: 'op-event',
          product: 'aura',
          subKind: 'end',
          opKind: 'chat',
          opId: 'op-chat-1',
          label: 'webview chat',
          startedAt: '2026-06-24T12:00:00.000Z',
          elapsedMs: 2000,
          status: 'success',
        },
      });

      expect(root.innerHTML).not.toMatch(/data-product-chat-op-status/i);
      expect(root.innerHTML).toMatch(/success/i);
      view.close();
    } finally {
      if (previousWindow === undefined) delete (globalThis as any).window;
      else (globalThis as any).window = previousWindow;
    }
  });

  it('ignores classifier op-event frames in the product-local status surface', async () => {
    const listeners = new Map<string, (event: unknown) => void>();
    const previousWindow = (globalThis as any).window;
    (globalThis as any).window = {
      addEventListener: vi.fn((type: string, listener: (event: unknown) => void) => {
        listeners.set(type, listener);
      }),
      removeEventListener: vi.fn(),
    };
    try {
      const { createProductDeepView } = await import('./product-deep-view.js');
      const root = makeRoot();
      const view = createProductDeepView({
        root,
        product: 'aura',
        fetchJson: vi.fn(async () => productView()),
      });
      await view.load();

      listeners.get('rune-webview-frame')?.({
        detail: {
          kind: 'op-event',
          subKind: 'start',
          opKind: 'classifier',
          opId: 'op-classifier-1',
          label: 'classifier',
          startedAt: '2026-06-24T12:00:00.000Z',
          elapsedMs: 0,
        },
      });

      expect(root.innerHTML).not.toMatch(/data-product-chat-op-status/i);
      expect(root.innerHTML).not.toContain('op-classifier-1');
      view.close();
    } finally {
      if (previousWindow === undefined) delete (globalThis as any).window;
      else (globalThis as any).window = previousWindow;
    }
  });

  it('ignores unscoped chat op-event frames so global chat does not attach a product working pill', async () => {
    const listeners = new Map<string, (event: unknown) => void>();
    const previousWindow = (globalThis as any).window;
    (globalThis as any).window = {
      addEventListener: vi.fn((type: string, listener: (event: unknown) => void) => {
        listeners.set(type, listener);
      }),
      removeEventListener: vi.fn(),
    };
    try {
      const { createProductDeepView } = await import('./product-deep-view.js');
      const root = makeRoot();
      const view = createProductDeepView({
        root,
        product: 'aura',
        fetchJson: vi.fn(async () => productView()),
      });
      await view.load();

      listeners.get('rune-webview-frame')?.({
        detail: {
          kind: 'op-event',
          subKind: 'start',
          opKind: 'chat',
          opId: 'op-global-chat-1',
          label: 'webview chat',
          startedAt: '2026-06-24T12:00:00.000Z',
          elapsedMs: 0,
        },
      });

      expect(root.innerHTML).not.toMatch(/data-product-chat-op-status/i);
      expect(root.innerHTML).not.toContain('op-global-chat-1');
      view.close();
    } finally {
      if (previousWindow === undefined) delete (globalThis as any).window;
      else (globalThis as any).window = previousWindow;
    }
  });

  it('ignores chat op-event frames for a different product so the working pill stays on the owning panel', async () => {
    const listeners = new Map<string, (event: unknown) => void>();
    const previousWindow = (globalThis as any).window;
    (globalThis as any).window = {
      addEventListener: vi.fn((type: string, listener: (event: unknown) => void) => {
        listeners.set(type, listener);
      }),
      removeEventListener: vi.fn(),
    };
    try {
      const { createProductDeepView } = await import('./product-deep-view.js');
      const root = makeRoot();
      const view = createProductDeepView({
        root,
        product: 'aura',
        fetchJson: vi.fn(async () => productView()),
      });
      await view.load();

      listeners.get('rune-webview-frame')?.({
        detail: {
          kind: 'op-event',
          product: 'rune',
          subKind: 'start',
          opKind: 'chat',
          opId: 'op-chat-rune-1',
          label: 'webview chat',
          startedAt: '2026-06-24T12:00:00.000Z',
          elapsedMs: 0,
        },
      });

      expect(root.innerHTML).not.toMatch(/data-product-chat-op-status/i);
      expect(root.innerHTML).not.toContain('op-chat-rune-1');
      view.close();
    } finally {
      if (previousWindow === undefined) delete (globalThis as any).window;
      else (globalThis as any).window = previousWindow;
    }
  });

  it('ignores unrelated background agent op-event frames (op-events carry no product scope)', async () => {
    const listeners = new Map<string, (event: unknown) => void>();
    const previousWindow = (globalThis as any).window;
    (globalThis as any).window = {
      addEventListener: vi.fn((type: string, listener: (event: unknown) => void) => {
        listeners.set(type, listener);
      }),
      removeEventListener: vi.fn(),
    };
    try {
      const { createProductDeepView } = await import('./product-deep-view.js');
      const root = makeRoot();
      const view = createProductDeepView({
        root,
        product: 'aura',
        fetchJson: vi.fn(async () => productView()),
      });
      await view.load();

      listeners.get('rune-webview-frame')?.({
        detail: {
          kind: 'op-event',
          subKind: 'start',
          opKind: 'agent',
          opId: 'op-agent-1',
          label: 'nightly',
          startedAt: '2026-06-24T12:00:00.000Z',
          elapsedMs: 0,
        },
      });

      expect(root.innerHTML).not.toMatch(/data-product-chat-op-status/i);
      expect(root.innerHTML).not.toContain('op-agent-1');
      view.close();
    } finally {
      if (previousWindow === undefined) delete (globalThis as any).window;
      else (globalThis as any).window = previousWindow;
    }
  });

  it('cancels the active product-local chat op through the existing ops endpoint', async () => {
    const listeners = new Map<string, (event: unknown) => void>();
    const previousWindow = (globalThis as any).window;
    (globalThis as any).window = {
      addEventListener: vi.fn((type: string, listener: (event: unknown) => void) => {
        listeners.set(type, listener);
      }),
      removeEventListener: vi.fn(),
    };
    try {
      const { createProductDeepView } = await import('./product-deep-view.js');
      const root = makeRoot();
      const postJson = vi.fn(async () => ({ ok: true }));
      const view = createProductDeepView({
        root,
        product: 'aura',
        fetchJson: vi.fn(async () => productView()),
        postJson,
      });
      await view.load();
      listeners.get('rune-webview-frame')?.({
        detail: {
          kind: 'op-event',
          product: 'aura',
          subKind: 'start',
          opKind: 'chat',
          opId: 'op-chat-1',
          label: 'webview chat',
          startedAt: '2026-06-24T12:00:00.000Z',
          elapsedMs: 0,
        },
      });

      await root.clickClosest('[data-cancel-op-id]', { cancelOpId: 'op-chat-1' });

      expect(postJson).toHaveBeenCalledWith('/api/ops/op-chat-1/cancel');
      view.close();
    } finally {
      if (previousWindow === undefined) delete (globalThis as any).window;
      else (globalThis as any).window = previousWindow;
    }
  });

  it('renders product chat messages through markdown-it with unsafe HTML disabled', async () => {
    const previousWindow = (globalThis as any).window;
    const markdownOptions: unknown[] = [];
    (globalThis as any).window = {
      markdownit: vi.fn((opts: unknown) => {
        markdownOptions.push(opts);
        return {
          render(raw: string) {
            const escaped = String(raw)
              .replace(/&/g, '&amp;')
              .replace(/</g, '&lt;')
              .replace(/>/g, '&gt;')
              .replace(/"/g, '&quot;');
            const lines = escaped.split('\n');
            return lines.map(line => {
              if (line.startsWith('- ')) return `<ul><li>${line.slice(2)}</li></ul>`;
              return `<p>${line.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/`([^`]+)`/g, '<code>$1</code>')}</p>`;
            }).join('');
          },
        };
      }),
    };
    try {
      const { renderProductDeepView } = await import('./product-deep-view.js');

      const html = renderProductDeepView(productView(), {
        chatMessages: [{
          role: 'assistant',
          text: '**Bold**\n- item\nUse `code`\n<script>alert("x")</script>',
        }],
      });

      expect(markdownOptions).toContainEqual(expect.objectContaining({ html: false, linkify: true }));
      expect(html).toContain('<strong>Bold</strong>');
      expect(html).toContain('<li>item</li>');
      expect(html).toContain('<code>code</code>');
      expect(html).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
      expect(html).not.toContain('<script>');
    } finally {
      if (previousWindow === undefined) delete (globalThis as any).window;
      else (globalThis as any).window = previousWindow;
    }
  });

  it('falls back to escaped text with preserved line breaks when markdown-it is unavailable', async () => {
    const previousWindow = (globalThis as any).window;
    // No markdownit on window — exercise the degraded-mode fallback path.
    (globalThis as any).window = {};
    try {
      const { renderProductDeepView } = await import('./product-deep-view.js');

      const html = renderProductDeepView(productView(), {
        chatMessages: [{
          role: 'assistant',
          text: 'line one\nline two\n<script>alert("x")</script>',
        }],
      });

      // Newlines survive as <br> (the message container is white-space: normal).
      expect(html).toContain('line one<br>line two');
      // HTML is still escaped — no raw tag injection.
      expect(html).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
      expect(html).not.toContain('<script>');
    } finally {
      if (previousWindow === undefined) delete (globalThis as any).window;
      else (globalThis as any).window = previousWindow;
    }
  });

  it('keeps backlog add in the deep-view backlog surface and appends through the existing backlog endpoint', async () => {
    const { createProductDeepView, renderProductDeepView } = await import('./product-deep-view.js');
    const root = makeRoot();
    const appendedBug = {
      id: 'BUG-new',
      title: 'Newly captured bug',
      status: 'open',
      plan: { kind: 'plan', state: 'available' },
      fix: { kind: 'fix', state: 'available' },
    };
    const postJson = vi.fn(async (url: string, body?: unknown) => {
      expect(url).toBe('/api/backlog/aura/bugs');
      expect(body).toEqual({ text: 'Newly captured bug' });
      return { item: appendedBug };
    });

    expect(renderProductDeepView(productView())).toMatch(/data-backlog-add-form[\s\S]{0,240}bugs|bugs[\s\S]{0,240}data-backlog-add-form/i);

    const view = createProductDeepView({
      root,
      product: 'aura',
      fetchJson: vi.fn(async () => productView()),
      postJson,
    });
    await view.load();
    await root.submitClosest('[data-backlog-add-form]', {
      product: 'aura',
      kind: 'bugs',
      text: 'Newly captured bug',
    });

    expect(postJson).toHaveBeenCalledTimes(1);
    expect(root.innerHTML).toContain('BUG-new');
    expect(root.innerHTML).toContain('Newly captured bug');
  });

  it('starts planning in the right-column chat panel after creating the planning session (no separate overlay)', async () => {
    const { createProductDeepView } = await import('./product-deep-view.js');
    const root = makeRoot();
    const postJson = vi.fn(async (url: string) => {
      expect(url).toBe('/api/backlog/aura/items/IDEA-1/plan');
      return { planningSessionId: 'planning-1', promotionId: 'promotion-1' };
    });

    const view = createProductDeepView({
      root,
      product: 'aura',
      fetchJson: vi.fn(async () => productView()),
      postJson,
    });
    await view.load();
    await root.clickClosest('[data-plan-item-id]', { planItemId: 'IDEA-1' });

    expect(postJson).toHaveBeenCalledWith('/api/backlog/aura/items/IDEA-1/plan');
    // Breadcrumb lands in the visible product-chat transcript and the chat panel
    // enters planning mode (status pill) — no dependency on a separate overlay.
    expect(root.innerHTML).toMatch(/data-product-chat-transcript[\s\S]*Planning started for Add a release dashboard/i);
    expect(root.innerHTML).toMatch(/data-planning-active|data-planning-status/i);
    expect(root.innerHTML).toMatch(/data-plan-item-id=["']IDEA-1["'][^>]*disabled/i);
    expect(root.innerHTML).toContain('planning-active');
  });

  it('routes chat turns through the planning endpoint while planning, renders the proposed spec inline, and approves it', async () => {
    const { createProductDeepView } = await import('./product-deep-view.js');
    const root = makeRoot();
    const artifact = {
      version: 2,
      kind: 'pm-spec',
      product: 'aura',
      title: 'Release dashboard',
      spec: 'Build a dashboard for releases.',
      assumptions: ['Existing release records are available.'],
      selfReview: { revised: false, summary: 'Spec is internally consistent.' },
    };
    const postJson = vi.fn(async (url: string) => {
      if (url === '/api/backlog/aura/items/IDEA-1/plan') return { planningSessionId: 'planning-1' };
      if (url === '/api/planning/turn') return { reply: 'Here is the proposed spec.', status: 'spec-proposed', artifact };
      if (url === '/api/planning/approve') return { ok: true, slug: 'aura-release-dashboard' };
      throw new Error(`unexpected post ${url}`);
    });

    const view = createProductDeepView({
      root,
      product: 'aura',
      fetchJson: vi.fn(async () => productView()),
      postJson,
    });
    await view.load();
    await root.clickClosest('[data-plan-item-id]', { planItemId: 'IDEA-1' });
    await root.submitClosest('[data-product-chat-form]', { product: 'aura', message: 'A board listing recent releases' });

    // The free-form turn went to the structured planning endpoint, not the WS/chat send.
    expect(postJson).toHaveBeenCalledWith('/api/planning/turn', { text: 'A board listing recent releases' });
    // Structured spec rendered inline with the artifact fields + action buttons.
    expect(root.innerHTML).toMatch(/data-planning-status[^>]*>spec-proposed</i);
    expect(root.innerHTML).toContain('Release dashboard');
    expect(root.innerHTML).toContain('Build a dashboard for releases.');
    expect(root.innerHTML).toContain('Existing release records are available.');
    expect(root.innerHTML).toContain('Spec is internally consistent.');
    expect(root.innerHTML).toMatch(/only planning approval/i);
    expect(root.innerHTML).toMatch(/data-planning-action=["']approve["']/i);

    await root.clickClosest('[data-planning-action]', { planningAction: 'approve' });
    expect(postJson).toHaveBeenCalledWith('/api/planning/approve');
    expect(root.innerHTML).toMatch(/Spec approved/i);
    // Planning surface clears after approval.
    expect(root.innerHTML).not.toMatch(/data-planning-action=["']approve["']/i);
  });

  it('renders a proposed PM spec from a fenced pm-spec reply when the turn response omits artifact', async () => {
    const { createProductDeepView } = await import('./product-deep-view.js');
    const root = makeRoot();
    const replyArtifact = {
      version: 2,
      kind: 'pm-spec',
      product: 'aura',
      title: 'Fenced release dashboard',
      spec: 'Render the PM spec from the assistant reply.',
      assumptions: ['The reply includes the approval artifact fence.'],
      selfReview: { revised: true, summary: 'Tightened the acceptance language.' },
    };
    const postJson = vi.fn(async (url: string) => {
      if (url === '/api/backlog/aura/items/IDEA-1/plan') return { planningSessionId: 'planning-1' };
      if (url === '/api/planning/turn') {
        return {
          reply: `Ready for approval.\n\n\`\`\`pm-spec\n${JSON.stringify(replyArtifact, null, 2)}\n\`\`\``,
          status: 'spec-proposed',
        };
      }
      throw new Error(`unexpected post ${url}`);
    });

    const view = createProductDeepView({
      root,
      product: 'aura',
      fetchJson: vi.fn(async () => productView()),
      postJson,
    });
    await view.load();
    await root.clickClosest('[data-plan-item-id]', { planItemId: 'IDEA-1' });
    await root.submitClosest('[data-product-chat-form]', { product: 'aura', message: 'Proceed with this idea' });

    expect(root.innerHTML).toMatch(/data-planning-status[^>]*>spec-proposed</i);
    expect(root.innerHTML).toContain('Fenced release dashboard');
    expect(root.innerHTML).toContain('Render the PM spec from the assistant reply.');
    expect(root.innerHTML).toContain('The reply includes the approval artifact fence.');
    expect(root.innerHTML).toContain('Tightened the acceptance language.');
    expect(root.innerHTML).toMatch(/data-planning-action=["']approve["']/i);
  });

  it('retains the product chat transcript across navigate-away-and-back (in-session)', async () => {
    const { createProductDeepView } = await import('./product-deep-view.js');
    const root = makeRoot();
    const sendChat = vi.fn(async () => ({ text: 'Working on it.' }));

    const first = createProductDeepView({
      root,
      product: 'aura',
      fetchJson: vi.fn(async () => productView()),
      sendChat,
    });
    await first.load();
    await root.submitClosest('[data-product-chat-form]', { product: 'aura', message: 'Remember this' });
    expect(root.innerHTML).toContain('Remember this');
    first.close();

    // Re-navigate: a fresh view for the same product restores the transcript.
    const second = createProductDeepView({
      root,
      product: 'aura',
      fetchJson: vi.fn(async () => productView()),
      sendChat,
    });
    await second.load();
    expect(root.innerHTML).toContain('Remember this');
    expect(root.innerHTML).toContain('Working on it.');
  });

  it('scrolls the product chat transcript to bottom when appending a user message', async () => {
    const { createProductDeepView } = await import('./product-deep-view.js');
    const root = makeRoot();
    const sendChat = vi.fn(async () => ({ ok: true }));

    const view = createProductDeepView({
      root,
      product: 'aura',
      fetchJson: vi.fn(async () => productView({ activeRun: undefined })),
      sendChat,
    });
    await view.load();
    root.chatTranscript.scrollHeight = 1400;
    root.chatTranscript.clientHeight = 240;
    root.chatTranscript.scrollTop = 1160;

    await root.submitClosest('[data-product-chat-form]', { product: 'aura', message: 'Follow this' });

    expect(root.innerHTML).toContain('Follow this');
    expect(root.chatTranscript.scrollTop).toBe(root.chatTranscript.scrollHeight);
  });

  it('keeps appended and streaming assistant replies pinned to the bottom', async () => {
    const listeners = new Map<string, (event: unknown) => void>();
    const previousWindow = (globalThis as any).window;
    (globalThis as any).window = {
      runeSendWebviewMessage: vi.fn(() => true),
      addEventListener: vi.fn((type: string, listener: (event: unknown) => void) => {
        listeners.set(type, listener);
      }),
      removeEventListener: vi.fn(),
    };
    try {
      const { createProductDeepView } = await import('./product-deep-view.js');
      const root = makeRoot();
      const view = createProductDeepView({
        root,
        product: 'aura',
        fetchJson: vi.fn(async () => productView({ activeRun: undefined })),
      });
      await view.load();
      root.chatTranscript.scrollHeight = 1800;
      root.chatTranscript.clientHeight = 300;
      root.chatTranscript.scrollTop = 1500;

      await root.submitClosest('[data-product-chat-form]', { product: 'aura', message: 'Stream please' });
      listeners.get('rune-webview-frame')?.({ detail: { kind: 'chunk', text: 'First chunk. ' } });
      expect(root.chatTranscript.scrollTop).toBe(root.chatTranscript.scrollHeight);

      root.chatTranscript.scrollHeight = 1900;
      listeners.get('rune-webview-frame')?.({ detail: { kind: 'message', text: 'Final answer.' } });
      expect(root.chatTranscript.scrollTop).toBe(root.chatTranscript.scrollHeight);
      view.close();
    } finally {
      if (previousWindow === undefined) delete (globalThis as any).window;
      else (globalThis as any).window = previousWindow;
    }
  });

  it('does not force chat to bottom on unrelated tab switches after a manual scroll-up', async () => {
    const { createProductDeepView } = await import('./product-deep-view.js');
    const root = makeRoot();
    const view = createProductDeepView({
      root,
      product: 'aura',
      fetchJson: vi.fn(async () => productView({ activeRun: undefined })),
    });
    await view.load();
    root.chatTranscript.scrollHeight = 2000;
    root.chatTranscript.clientHeight = 300;
    root.chatTranscript.scrollTop = 250;

    await root.clickClosest('[data-work-tab]', { workTab: 'bugs' });

    expect(root.innerHTML).toMatch(/data-active-work-tab=["']bugs["']/i);
    expect(root.chatTranscript.scrollTop).toBe(250);
  });

  it('submits chat turns with product scope, preserves slash commands verbatim, and links KB research out instead of embedding it', async () => {
    const { createProductDeepView, renderProductDeepView } = await import('./product-deep-view.js');
    const root = makeRoot();
    const sendChat = vi.fn(async () => ({ text: 'Model switched.' }));

    const view = createProductDeepView({
      root,
      product: 'aura',
      fetchJson: vi.fn(async () => productView()),
      sendChat,
    });
    await view.load();
    await root.submitClosest('[data-product-chat-form]', { product: 'aura', message: '/opus' });

    expect(sendChat).toHaveBeenCalledWith(expect.objectContaining({
      product: 'aura',
      text: '/opus',
    }));
    expect(root.innerHTML).toMatch(/data-chat-message-role=["']user["'][\s\S]{0,80}\/opus/i);
    expect(root.innerHTML).toMatch(/data-chat-message-role=["']assistant["'][\s\S]{0,120}Model switched/i);
    expect(root.innerHTML).toMatch(/data-chat-message-depth[\s\S]{0,80}2 messages deep/i);

    const html = renderProductDeepView(productView());
    expect(html).toMatch(/data-product-chat-form|data-chat-scope=["']product["']/i);
    expect(html).toMatch(/repo\s*\+\s*vault|product repo[\s\S]{0,120}vault|data-search-scope=["']repo\+vault["']/i);
    expect(html).toMatch(/claude app|app:\/\/|data-app-deeplink/i);
    expect(html).not.toMatch(/embedded-app-thread|kb-research-thread|idea-exploration-thread/i);
  });

  it('resets product-local message depth when the active chat session is cleared', async () => {
    const { createProductDeepView } = await import('./product-deep-view.js');
    const root = makeRoot();
    const sendChat = vi.fn(async ({ text }: { text: string }) => (
      text === '/clear' ? { text: 'Cleared.' } : { text: 'Reply.' }
    ));

    const view = createProductDeepView({
      root,
      product: 'aura',
      fetchJson: vi.fn(async () => productView()),
      sendChat,
    });
    await view.load();
    await root.submitClosest('[data-product-chat-form]', { product: 'aura', message: 'Before clear' });

    expect(root.innerHTML).toMatch(/data-chat-message-depth[\s\S]{0,80}2 messages deep/i);
    expect(root.innerHTML).toContain('Before clear');

    await root.submitClosest('[data-product-chat-form]', { product: 'aura', message: '/clear' });

    expect(sendChat).toHaveBeenCalledWith(expect.objectContaining({
      product: 'aura',
      text: '/clear',
    }));
    expect(root.innerHTML).toMatch(/data-chat-message-depth[\s\S]{0,80}0 messages deep/i);
    expect(root.innerHTML).not.toContain('Before clear');
    expect(root.innerHTML).not.toContain('Cleared.');
  });

  it('sends product chat on Enter while preserving Shift+Enter for newlines', async () => {
    const { createProductDeepView } = await import('./product-deep-view.js');
    const root = makeRoot();
    const sendChat = vi.fn(async () => ({ text: 'Sent from enter.' }));

    const view = createProductDeepView({
      root,
      product: 'aura',
      fetchJson: vi.fn(async () => productView()),
      sendChat,
    });
    await view.load();

    const shiftEnter = await root.keyDownClosest('[data-product-chat-form]', {
      product: 'aura',
      message: 'line one',
      shiftKey: true,
    });
    expect(shiftEnter.preventDefault).not.toHaveBeenCalled();
    expect(sendChat).not.toHaveBeenCalled();

    const enter = await root.keyDownClosest('[data-product-chat-form]', {
      product: 'aura',
      message: 'Send this',
    });
    expect(enter.preventDefault).toHaveBeenCalledTimes(1);
    expect(sendChat).toHaveBeenCalledWith(expect.objectContaining({
      product: 'aura',
      text: 'Send this',
    }));
    expect(root.innerHTML).toMatch(/data-chat-message-role=["']assistant["'][\s\S]{0,120}Sent from enter/i);
  });

  it('can send product chat over the shared WebSocket helper and append streamed replies into the visible transcript', async () => {
    const listeners = new Map<string, (event: unknown) => void>();
    const previousWindow = (globalThis as any).window;
    (globalThis as any).window = {
      runeSendWebviewMessage: vi.fn(() => true),
      addEventListener: vi.fn((type: string, listener: (event: unknown) => void) => {
        listeners.set(type, listener);
      }),
      removeEventListener: vi.fn(),
    };
    try {
      const { createProductDeepView } = await import('./product-deep-view.js');
      const root = makeRoot();
      const view = createProductDeepView({
        root,
        product: 'aura',
        fetchJson: vi.fn(async () => productView()),
      });
      await view.load();
      await root.submitClosest('[data-product-chat-form]', { product: 'aura', message: 'What is next?' });

      expect((globalThis as any).window.runeSendWebviewMessage).toHaveBeenCalledWith({
        product: 'aura',
        text: 'What is next?',
      });
      expect(root.innerHTML).toMatch(/data-chat-message-role=["']user["'][\s\S]{0,120}What is next\?/i);

      listeners.get('rune-webview-frame')?.({ detail: { kind: 'message', text: 'Next: pick the highest-risk task.' } });

      expect(root.innerHTML).toMatch(/data-chat-message-role=["']assistant["'][\s\S]{0,160}highest-risk task/i);
      view.close();
      expect((globalThis as any).window.removeEventListener).toHaveBeenCalledWith('rune-webview-frame', expect.any(Function));
    } finally {
      if (previousWindow === undefined) delete (globalThis as any).window;
      else (globalThis as any).window = previousWindow;
    }
  });

  it('routes scoped streamed product frames to their owning session and replays inactive buffers in arrival order', async () => {
    const bus = installFrameBusWindow();
    try {
      const { createProductDeepView } = await import('./product-deep-view.js');
      const auraRoot = makeRoot();
      const relayRoot = makeRoot();
      const fetchJson = vi.fn(async (url: string) => {
        if (url === '/api/products/aura') return productView({ name: 'aura', activeRun: undefined });
        if (url === '/api/products/relay') return productView({ name: 'relay', activeRun: undefined });
        throw new Error(`unexpected fetch ${url}`);
      });

      const aura = createProductDeepView({ root: auraRoot, product: 'aura', fetchJson });
      await aura.load();
      aura.close();

      const relay = createProductDeepView({ root: relayRoot, product: 'relay', fetchJson });
      await relay.load();

      bus.emit('rune-webview-frame', { kind: 'chunk', product: 'aura', text: 'aura chunk one. ' });
      bus.emit('rune-webview-frame', { kind: 'message', product: 'relay', text: 'relay visible answer' });
      bus.emit('rune-webview-frame', { kind: 'chunk', product: 'aura', text: 'aura chunk two. ' });
      bus.emit('rune-webview-frame', { kind: 'message', product: 'aura', text: 'aura final answer' });

      expect(relayRoot.innerHTML).toContain('relay visible answer');
      expect(relayRoot.innerHTML).not.toContain('aura chunk one');
      expect(relayRoot.innerHTML).not.toContain('aura chunk two');
      expect(relayRoot.innerHTML).not.toContain('aura final answer');

      relay.close();
      const auraAgain = createProductDeepView({ root: auraRoot, product: 'aura', fetchJson });
      await auraAgain.load();

      const html = auraRoot.innerHTML;
      expect(html).toContain('aura chunk one');
      expect(html).toContain('aura chunk two');
      expect(html).toContain('aura final answer');
      expect(html.indexOf('aura chunk one')).toBeLessThan(html.indexOf('aura chunk two'));
      expect(html.indexOf('aura chunk two')).toBeLessThan(html.indexOf('aura final answer'));
      auraAgain.close();
    } finally {
      bus.restore();
    }
  });

  it('keeps product chat status pills scoped and restores an inactive product pill on switch-back', async () => {
    const bus = installFrameBusWindow();
    try {
      const { createProductDeepView } = await import('./product-deep-view.js');
      const auraRoot = makeRoot();
      const relayRoot = makeRoot();
      const fetchJson = vi.fn(async (url: string) => {
        if (url === '/api/products/aura') return productView({ name: 'aura', activeRun: undefined });
        if (url === '/api/products/relay') return productView({ name: 'relay', activeRun: undefined });
        throw new Error(`unexpected fetch ${url}`);
      });

      const relay = createProductDeepView({ root: relayRoot, product: 'relay', fetchJson });
      await relay.load();

      bus.emit('rune-webview-frame', {
        kind: 'status',
        product: 'aura',
        label: 'Aura is thinking',
      });
      bus.emit('rune-webview-frame', {
        kind: 'op-event',
        product: 'aura',
        subKind: 'start',
        opKind: 'chat',
        opId: 'op-aura-chat-1',
        label: 'webview chat',
        startedAt: '2026-07-09T12:00:00.000Z',
        elapsedMs: 0,
      });

      expect(relayRoot.innerHTML).not.toContain('Aura is thinking');
      expect(relayRoot.innerHTML).not.toContain('op-aura-chat-1');
      expect(relayRoot.innerHTML).not.toMatch(/data-product-chat-op-status/i);

      relay.close();
      const aura = createProductDeepView({ root: auraRoot, product: 'aura', fetchJson });
      await aura.load();

      expect(auraRoot.innerHTML).toContain('Aura is thinking');
      expect(auraRoot.innerHTML).toContain('op-aura-chat-1');
      expect(auraRoot.innerHTML).toMatch(/data-product-chat-op-status/i);
      aura.close();
    } finally {
      bus.restore();
    }
  });

  it('renders browser-local unread cues on sibling product channel entries, not the active channel', async () => {
    const { renderProductDeepView } = await import('./product-deep-view.js');

    const html = renderProductDeepView(
      productView({
        name: 'relay',
        activeRun: undefined,
        productChannels: [
          { name: 'aura', label: 'Aura' },
          { name: 'relay', label: 'Relay' },
        ],
      }),
      { unreadProducts: new Set(['aura']) },
    );

    const auraChannel = /<[^>]+data-product-channel=["']aura["'][\s\S]*?(?=<[^>]+data-product-channel=|<\/nav>|<\/header>)/i.exec(html)?.[0] || '';
    const relayChannel = /<[^>]+data-product-channel=["']relay["'][\s\S]*?(?=<[^>]+data-product-channel=|<\/nav>|<\/header>)/i.exec(html)?.[0] || '';
    expect(auraChannel).toMatch(/data-product-chat-unread|product-channel--unread|new chat output|unread|activity/i);
    expect(relayChannel).not.toMatch(/data-product-chat-unread|product-channel--unread|new chat output|unread|activity/i);
  });

  it('lights a backgrounded sibling channel entry live from a scoped frame, deriving switcher unread in the controller with no injected set', async () => {
    const bus = installFrameBusWindow();
    try {
      const { createProductDeepView } = await import('./product-deep-view.js');
      const relayRoot = makeRoot();
      // Operator is inside relay's deep view (Home is not mounted). Only the
      // deep-view controller can raise the sibling switcher cue here, and it must
      // derive that unread from frame events — never from an injected Set.
      const relay = createProductDeepView({
        root: relayRoot,
        product: 'relay',
        fetchJson: vi.fn(async () =>
          productView({
            name: 'relay',
            activeRun: undefined,
            productChannels: [
              { name: 'aura', label: 'Aura' },
              { name: 'relay', label: 'Relay' },
            ],
          }),
        ),
      });

      await relay.load();

      // Baseline: nothing backgrounded yet, so no sibling channel is flagged.
      const auraBefore = /<[^>]+data-product-channel=["']aura["'][\s\S]*?(?=<[^>]+data-product-channel=|<\/nav>|<\/header>)/i.exec(relayRoot.innerHTML)?.[0] || '';
      expect(auraBefore).not.toMatch(/data-product-chat-unread|product-channel--unread|new chat output|unread|activity/i);

      // A frame for the backgrounded sibling must light its switcher entry live.
      bus.emit('rune-webview-frame', { kind: 'message', product: 'aura', text: 'aura background answer' });

      const auraAfter = /<[^>]+data-product-channel=["']aura["'][\s\S]*?(?=<[^>]+data-product-channel=|<\/nav>|<\/header>)/i.exec(relayRoot.innerHTML)?.[0] || '';
      const relayAfter = /<[^>]+data-product-channel=["']relay["'][\s\S]*?(?=<[^>]+data-product-channel=|<\/nav>|<\/header>)/i.exec(relayRoot.innerHTML)?.[0] || '';
      // The backgrounded sibling lights up; the active channel the operator is
      // viewing never does.
      expect(auraAfter).toMatch(/data-product-chat-unread|product-channel--unread|new chat output|unread|activity/i);
      expect(relayAfter).not.toMatch(/data-product-chat-unread|product-channel--unread|new chat output|unread|activity/i);

      relay.close();
    } finally {
      bus.restore();
    }
  });

  it('announces a product chat as viewed on load so browser-local unread state can clear', async () => {
    const bus = installFrameBusWindow();
    try {
      const { createProductDeepView } = await import('./product-deep-view.js');
      const root = makeRoot();
      const view = createProductDeepView({
        root,
        product: 'aura',
        fetchJson: vi.fn(async () => productView({ activeRun: undefined })),
      });

      await view.load();

      expect((globalThis as any).window.dispatchEvent).toHaveBeenCalledWith(expect.objectContaining({
        type: 'rune-product-chat-viewed',
        detail: { product: 'aura' },
      }));
      view.close();
    } finally {
      bus.restore();
    }
  });

  it('renders product-chat command affordances for the preserved lifecycle and model commands', async () => {
    const { createProductDeepView, renderProductDeepView } = await import('./product-deep-view.js');
    const root = makeRoot();
    const sendChat = vi.fn(async () => ({ ok: true }));

    const requiredCommands = ['/fresh', '/fresh-full', '/clear', '/gpt-5.6-terra', '/opus', '/sonnet', '/haiku'];
    const html = renderProductDeepView(productView());

    for (const command of requiredCommands) {
      expect(html).toMatch(new RegExp(`data-chat-command=["']${command}["']|>${command}<`, 'i'));
    }

    const view = createProductDeepView({
      root,
      product: 'aura',
      fetchJson: vi.fn(async () => productView()),
      sendChat,
    });
    await view.load();
    await root.clickClosest('[data-chat-command]', { chatCommand: '/fresh-full' });

    expect(sendChat).toHaveBeenCalledWith(expect.objectContaining({
      product: 'aura',
      text: '/fresh-full',
    }));
  });

  it('does not render a separate product search form because normal product chat already has repo plus vault scope', async () => {
    const { renderProductDeepView } = await import('./product-deep-view.js');

    const html = renderProductDeepView(productView());

    expect(html).toMatch(/data-product-chat-form/i);
    expect(html).toMatch(/data-chat-scope=["']product["']/i);
    expect(html).toMatch(/data-search-scope=["']repo\+vault["']/i);
    expect(html).not.toMatch(/data-product-search-form|Search repo \+ vault|name=["']query["']/i);
  });
});
