import { describe, expect, it, vi } from 'vitest';

type Listener = (event?: any) => unknown;

function makeRoot() {
  let html = '';
  const listeners = new Map<string, Set<Listener>>();
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
    },
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

const productOperations = {
  inFlightOps: [{ opId: 'op-live-1', label: 'agent', product: 'aura' }],
  mutations: [{ id: 'mut-live-1', kind: 'work-run', status: 'running', product: 'aura' }],
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

  it('labels the run roster as Agent activity, shows each agent model, and renders the classified terminal outcome from live state', async () => {
    const { renderProductDeepView } = await import('./product-deep-view.js');

    const html = renderProductDeepView(productView(), {
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

    const html = renderProductDeepView(productView({
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
    }));

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
    expect(html).toMatch(/BUG-declined[\s\S]{0,420}Needs concrete reproduction steps before autorun can start/i);
    expect(html).toMatch(/BUG-handoff[\s\S]{0,320}handoff-unavailable/i);
    expect(html).toMatch(/BUG-handoff[\s\S]{0,320}startFixRun unavailable/i);
    expect(html).toMatch(/BUG-proceeding[\s\S]{0,320}run-fix-accepted/i);
    expect(html).toMatch(/BUG-disabled[\s\S]{0,320}done/i);
    expect(html).toMatch(/IDEA-1[\s\S]{0,240}\bPlan\b/i);
    expect(html).not.toMatch(/IDEA-1[\s\S]{0,240}\bFix\b/i);
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

  it('posts per-product op and mutation cancels from the deep view through the existing cancel endpoints', async () => {
    const { createProductDeepView } = await import('./product-deep-view.js');
    const root = makeRoot();
    const postJson = vi.fn(async () => ({ ok: true }));

    const view = createProductDeepView({
      root,
      product: 'aura',
      fetchJson: vi.fn(async () => productView()),
      postJson,
      operations: productOperations,
    });
    await view.load();
    await root.clickClosest('[data-cancel-op-id]', { cancelOpId: 'op-live-1' });
    await root.clickClosest('[data-cancel-mutation-id]', { cancelMutationId: 'mut-live-1' });

    expect(postJson).toHaveBeenCalledWith('/api/ops/op-live-1/cancel');
    expect(postJson).toHaveBeenCalledWith('/api/mutations/mut-live-1/cancel');
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

  it('keeps backlog Plan in the deep view and hands successful plans to the planning panel without starting a replacement session', async () => {
    const { createProductDeepView } = await import('./product-deep-view.js');
    const root = makeRoot();
    const postJson = vi.fn(async (url: string) => {
      expect(url).toBe('/api/backlog/aura/items/IDEA-1/plan');
      return { planningSessionId: 'planning-1', promotionId: 'promotion-1' };
    });
    const openPlanningPanel = vi.fn();

    const view = createProductDeepView({
      root,
      product: 'aura',
      fetchJson: vi.fn(async () => productView()),
      postJson,
      openPlanningPanel,
    });
    await view.load();
    await root.clickClosest('[data-plan-item-id]', { planItemId: 'IDEA-1' });

    expect(postJson).toHaveBeenCalledWith('/api/backlog/aura/items/IDEA-1/plan');
    expect(openPlanningPanel).toHaveBeenCalledWith(expect.objectContaining({
      product: 'aura',
      planningSessionId: 'planning-1',
      promotionId: 'promotion-1',
      linkedSession: true,
    }));
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

  it('renders product-chat command affordances for the preserved lifecycle and model commands', async () => {
    const { createProductDeepView, renderProductDeepView } = await import('./product-deep-view.js');
    const root = makeRoot();
    const sendChat = vi.fn(async () => ({ ok: true }));

    const requiredCommands = ['/fresh', '/fresh-full', '/clear', '/opus', '/sonnet', '/haiku'];
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

  it('renders an explicit product search affordance scoped to the product repo plus the vault', async () => {
    const { renderProductDeepView } = await import('./product-deep-view.js');

    const html = renderProductDeepView(productView());
    const searchForm = html.match(/<form[^>]*data-product-search-form[\s\S]*?<\/form>/i)?.[0] ?? '';

    expect(searchForm).toMatch(/data-product-search-form/i);
    expect(searchForm).toMatch(/data-product=["']aura["']/i);
    expect(searchForm).toMatch(/data-search-scope=["']repo\+vault["']/i);
    expect(searchForm).toMatch(/name=["']query["']|data-search-query/i);
    expect(searchForm).toMatch(/repo[\s\S]{0,80}vault|vault[\s\S]{0,80}repo/i);
    expect(searchForm).not.toMatch(/data-search-scope=["']vault["'](?!\+)|kb-only-search/i);
  });
});
