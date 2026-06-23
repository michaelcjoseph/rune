import { describe, expect, it, vi } from 'vitest';

type Listener = (event?: any) => unknown;

function makeRoot() {
  let html = '';
  const listeners = new Map<string, Listener>();
  return {
    get innerHTML() {
      return html;
    },
    set innerHTML(next: string) {
      html = next;
    },
    addEventListener: vi.fn((type: string, listener: Listener) => {
      listeners.set(type, listener);
    }),
    clickClosest(selector: string, dataset: Record<string, string> = {}) {
      return listeners.get('click')?.({
        preventDefault: vi.fn(),
        target: {
          closest(query: string) {
            return query === selector ? { dataset, disabled: false } : null;
          },
        },
      });
    },
    submitClosest(selector: string, fields: Record<string, string> = {}) {
      return listeners.get('submit')?.({
        preventDefault: vi.fn(),
        target: {
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
      });
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
          fix: { kind: 'fix', state: 'declined', reason: 'pm-not-well-scoped' },
        },
        {
          id: 'BUG-handoff',
          title: 'Valid gate, missing executor',
          status: 'open',
          plan: { kind: 'plan', state: 'available' },
          fix: { kind: 'fix', state: 'handoff-failed', reason: 'startFixRun unavailable' },
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
      ],
      ideas: [
        {
          id: 'IDEA-1',
          title: 'Add a release dashboard',
          status: 'open',
          plan: { kind: 'plan', state: 'available' },
        },
      ],
      warnings: [{ line: 42, message: 'Unparseable backlog bullet' }],
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
      worktreePath: '/Users/jarvis/workspace/jarvis/.worktrees/aura/17-cockpit-redesign',
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
  worktreePath: '/Users/jarvis/workspace/jarvis/.worktrees/aura/17-cockpit-redesign',
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

describe('Product deep view UI (cockpit redesign Phase 6)', () => {
  it('loads the per-product projection and renders Projects, Backlog, Runs, and Chat without depending on /api/cockpit', async () => {
    const { createProductDeepView } = await import('./product-deep-view.js');
    const root = makeRoot();
    const fetchJson = vi.fn(async (url: string) => {
      expect(url).toBe('/api/products/aura');
      return productView();
    });

    const view = createProductDeepView({ root, product: 'aura', fetchJson });
    await view.load();

    expect(fetchJson).toHaveBeenCalledTimes(1);
    expect(fetchJson).not.toHaveBeenCalledWith('/api/cockpit');
    expect(root.innerHTML).toMatch(/data-product=["']aura["']|aura/i);
    for (const surface of ['Projects', 'Backlog', 'Runs', 'Chat']) {
      expect(root.innerHTML).toMatch(new RegExp(`data-surface=["']${surface.toLowerCase()}["']|${surface}`, 'i'));
    }
    expect(root.innerHTML).toContain('17-cockpit-redesign');
    expect(root.innerHTML).toContain('Crash when saving');
    expect(root.innerHTML).toContain('run-recent-1');
  });

  it('keeps chat as a scoped secondary panel instead of the dominant surface', async () => {
    const { renderProductDeepView } = await import('./product-deep-view.js');

    const html = renderProductDeepView(productView());

    expect(html).toMatch(/product-deep-view|deep-view/i);
    expect(html).toMatch(/data-surface=["']chat["']/i);
    expect(html).toMatch(/data-chat-scope=["']product["']|data-product=["']aura["']/i);
    expect(html).toMatch(/chat-panel--secondary|data-panel-priority=["']secondary["']|aria-label=["'][^"']*product chat/i);
    expect(html).not.toMatch(/chat-panel--primary|data-panel-priority=["']primary["']|id=["']chat["'][\s\S]{0,80}autofocus/i);
  });

  it('renders the live run panel from activeRun plus the live snapshot: task progress, agents, elapsed, logs, worktree path, and transcript link', async () => {
    const { renderProductDeepView } = await import('./product-deep-view.js');

    const html = renderProductDeepView(productView(), { liveRuns: { 'run-live-1': liveSnapshot } });

    expect(html).toContain('run-live-1');
    expect(html).toContain('17-cockpit-redesign');
    expect(html).toMatch(/4\s*(\/|of)\s*9|4\s+done/i);
    expect(html).toMatch(/running/i);
    expect(html).toMatch(/2m5s|2m10s|2\s*min/i);
    expect(html).toContain('/Users/jarvis/workspace/jarvis/.worktrees/aura/17-cockpit-redesign');
    expect(html).toMatch(/qa[\s\S]*active|active[\s\S]*qa/i);
    expect(html).toMatch(/coder[\s\S]*active|active[\s\S]*coder/i);
    expect(html).toContain('qa wrote failing tests');
    expect(html).toContain('coder edited src/server/static/product-deep-view.js');
    expect(html).toContain('/api/work-runs/run-live-1/transcript');
    expect(html).toContain('/api/work-runs/run-recent-1/transcript');
    expect(html).toMatch(/no-op/i);
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

  it('renders every Fix state while retaining Plan for bugs and ideas and never exposing Fix on ideas', async () => {
    const { renderProductDeepView } = await import('./product-deep-view.js');

    const html = renderProductDeepView(productView());

    for (const id of ['BUG-available', 'BUG-gating', 'BUG-declined', 'BUG-handoff', 'BUG-proceeding', 'BUG-disabled']) {
      expect(html).toContain(id);
      expect(html).toMatch(new RegExp(`data-plan-item-id=["']${id}["']|${id}[\\s\\S]{0,240}\\bPlan\\b`, 'i'));
      expect(html).toMatch(new RegExp(`data-fix-item-id=["']${id}["']|${id}[\\s\\S]{0,240}\\bFix\\b`, 'i'));
    }
    expect(html).toMatch(/BUG-available[\s\S]{0,260}(available|Fix)/i);
    expect(html).toMatch(/BUG-gating[\s\S]{0,260}(gating|scoping|disabled)/i);
    expect(html).toMatch(/BUG-declined[\s\S]{0,320}pm-not-well-scoped/i);
    expect(html).toMatch(/BUG-handoff[\s\S]{0,320}startFixRun unavailable/i);
    expect(html).toMatch(/BUG-proceeding[\s\S]{0,320}run-fix-accepted/i);
    expect(html).toMatch(/BUG-disabled[\s\S]{0,320}done/i);
    expect(html).toMatch(/IDEA-1[\s\S]{0,240}\bPlan\b/i);
    expect(html).not.toMatch(/IDEA-1[\s\S]{0,240}\bFix\b/i);
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

  it('keeps migrated operational controls reachable in the new deep-view IA', async () => {
    const { renderProductDeepView } = await import('./product-deep-view.js');

    const html = renderProductDeepView(productView(), { operations });

    expect(html).toMatch(/pending approvals|approvals/i);
    expect(html).toContain('Release parked run');
    expect(html).toMatch(/data-approval-action=["']approve["'][\s\S]{0,180}blocked-on-human:run-parked-1|blocked-on-human:run-parked-1[\s\S]{0,180}data-approval-action=["']approve["']/i);
    expect(html).toMatch(/intent proposal/i);
    expect(html).toMatch(/restart server/i);
    expect(html).toMatch(/op-live-1[\s\S]{0,180}cancel|cancel[\s\S]{0,180}op-live-1/i);
    expect(html).toMatch(/mut-live-1[\s\S]{0,180}cancel|cancel[\s\S]{0,180}mut-live-1/i);
    expect(html).toMatch(/planning[\s\S]{0,160}aura|aura[\s\S]{0,160}planning/i);
  });

  it('submits chat turns with product scope, preserves slash commands verbatim, and links KB research out instead of embedding it', async () => {
    const { createProductDeepView, renderProductDeepView } = await import('./product-deep-view.js');
    const root = makeRoot();
    const sendChat = vi.fn(async () => ({ ok: true }));

    const view = createProductDeepView({
      root,
      product: 'aura',
      fetchJson: vi.fn(async () => productView()),
      sendChat,
    });
    await view.load();
    await root.submitClosest('[data-product-chat-form]', { product: 'aura', message: '/fresh' });

    expect(sendChat).toHaveBeenCalledWith(expect.objectContaining({
      product: 'aura',
      text: '/fresh',
    }));

    const html = renderProductDeepView(productView());
    expect(html).toMatch(/data-product-chat-form|data-chat-scope=["']product["']/i);
    expect(html).toMatch(/repo\s*\+\s*vault|product repo[\s\S]{0,120}vault|data-search-scope=["']repo\+vault["']/i);
    expect(html).toMatch(/claude app|app:\/\/|data-app-deeplink/i);
    expect(html).not.toMatch(/embedded-app-thread|kb-research-thread|idea-exploration-thread/i);
  });
});
