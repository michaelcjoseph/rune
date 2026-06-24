import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
  // Per-product chat/planning state is retained at module scope (so it survives
  // navigate-away-and-back). Clear it between tests so they stay isolated.
  beforeEach(async () => {
    const mod = await import('./product-deep-view.js');
    mod.__resetProductSessions?.();
  });

  it('loads the per-product projection and renders Projects, Bugs, Ideas, Runs, and Chat without depending on /api/cockpit', async () => {
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
    for (const surface of ['Projects', 'Bugs', 'Ideas', 'Runs', 'Chat']) {
      expect(root.innerHTML).toMatch(new RegExp(`data-surface=["']${surface.toLowerCase()}["']|${surface}`, 'i'));
    }
    expect(root.innerHTML).toContain('17-cockpit-redesign');
    expect(root.innerHTML).toContain('Crash when saving');
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

  it('uses a two-column product layout with tabbed Projects, Bugs, and Ideas on the left and Chat, Operations, Runs on the right', async () => {
    const { createProductDeepView, renderProductDeepView } = await import('./product-deep-view.js');
    const root = makeRoot();
    const css = readFileSync(new URL('./app.css', import.meta.url), 'utf8');

    const html = renderProductDeepView(productView(), { operations: productOperations });

    expect(html).toMatch(/deep-two-column|deep-work-column|deep-side-stack/i);
    for (const tab of ['projects', 'bugs', 'ideas']) {
      expect(html).toMatch(new RegExp(`data-work-tab=["']${tab}["']|data-work-tab-panel=["']${tab}["']`, 'i'));
    }
    expect(html.indexOf('data-surface="chat"')).toBeLessThan(html.indexOf('data-surface="operations"'));
    expect(html.indexOf('data-surface="operations"')).toBeLessThan(html.indexOf('data-surface="runs"'));
    expect(css).toMatch(/\.deep-two-column[\s\S]*grid-template-columns/i);
    expect(css).toMatch(/\.deep-two-column[\s\S]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+minmax\(0,\s*1fr\)/i);
    expect(css).toMatch(/\.product-deep-view[\s\S]*min-height:\s*calc\(100vh - 2rem\)/i);
    expect(css).toMatch(/\.deep-two-column[\s\S]*align-items:\s*stretch/i);
    expect(css).toMatch(/\.deep-panel--chat[\s\S]*min-height:\s*calc\(100vh - 6rem\)/i);
    expect(css).toMatch(/\.deep-chat-transcript[\s\S]*flex:\s*1 1 auto/i);
    expect(css).toMatch(/\.deep-chat-transcript[\s\S]*max-height:\s*none/i);
    expect(css).toMatch(/\.deep-panel--chat textarea[\s\S]*min-height:\s*7\.5rem/i);
    expect(css).toMatch(/\.deep-tab-panel:not\(\.is-active\)[\s\S]*display:\s*none/i);

    const view = createProductDeepView({ root, product: 'aura', fetchJson: vi.fn(async () => productView()) });
    await view.load();
    await root.clickClosest('[data-work-tab]', { workTab: 'bugs' });

    expect(root.innerHTML).toMatch(/data-active-work-tab=["']bugs["']/i);
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
      if (url === '/api/state') return state;
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
    expect(root.innerHTML).toMatch(/data-project-run-action=["']cancel["'][\s\S]{0,180}mut-started/i);
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
        fetchJson: vi.fn(async () => productView()),
      });
      await view.load();

      listeners.get('jarvis-webview-frame')?.({
        detail: {
          kind: 'op-event',
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

      listeners.get('jarvis-webview-frame')?.({
        detail: {
          kind: 'op-event',
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

      listeners.get('jarvis-webview-frame')?.({
        detail: {
          kind: 'op-event',
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

      listeners.get('jarvis-webview-frame')?.({
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

      listeners.get('jarvis-webview-frame')?.({
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
      listeners.get('jarvis-webview-frame')?.({
        detail: {
          kind: 'op-event',
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
      title: 'Release dashboard',
      spec: 'Build a dashboard for releases.',
      tasks: '- [ ] scaffold\n- [ ] wire data',
      testPlan: 'unit + e2e',
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
    expect(root.innerHTML).toMatch(/data-planning-action=["']approve["']/i);

    await root.clickClosest('[data-planning-action]', { planningAction: 'approve' });
    expect(postJson).toHaveBeenCalledWith('/api/planning/approve');
    expect(root.innerHTML).toMatch(/Spec approved/i);
    // Planning surface clears after approval.
    expect(root.innerHTML).not.toMatch(/data-planning-action=["']approve["']/i);
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

  it('submits chat turns with product scope, preserves slash commands verbatim, and links KB research out instead of embedding it', async () => {
    const { createProductDeepView, renderProductDeepView } = await import('./product-deep-view.js');
    const root = makeRoot();
    const sendChat = vi.fn(async () => ({ text: 'Fresh summary complete.' }));

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
    expect(root.innerHTML).toMatch(/data-chat-message-role=["']user["'][\s\S]{0,80}\/fresh/i);
    expect(root.innerHTML).toMatch(/data-chat-message-role=["']assistant["'][\s\S]{0,120}Fresh summary complete/i);

    const html = renderProductDeepView(productView());
    expect(html).toMatch(/data-product-chat-form|data-chat-scope=["']product["']/i);
    expect(html).toMatch(/repo\s*\+\s*vault|product repo[\s\S]{0,120}vault|data-search-scope=["']repo\+vault["']/i);
    expect(html).toMatch(/claude app|app:\/\/|data-app-deeplink/i);
    expect(html).not.toMatch(/embedded-app-thread|kb-research-thread|idea-exploration-thread/i);
  });

  it('can send product chat over the shared WebSocket helper and append streamed replies into the visible transcript', async () => {
    const listeners = new Map<string, (event: unknown) => void>();
    const previousWindow = (globalThis as any).window;
    (globalThis as any).window = {
      jarvisSendWebviewMessage: vi.fn(() => true),
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

      expect((globalThis as any).window.jarvisSendWebviewMessage).toHaveBeenCalledWith({
        product: 'aura',
        text: 'What is next?',
      });
      expect(root.innerHTML).toMatch(/data-chat-message-role=["']user["'][\s\S]{0,120}What is next\?/i);

      listeners.get('jarvis-webview-frame')?.({ detail: { kind: 'message', text: 'Next: pick the highest-risk task.' } });

      expect(root.innerHTML).toMatch(/data-chat-message-role=["']assistant["'][\s\S]{0,160}highest-risk task/i);
      view.close();
      expect((globalThis as any).window.removeEventListener).toHaveBeenCalledWith('jarvis-webview-frame', expect.any(Function));
    } finally {
      if (previousWindow === undefined) delete (globalThis as any).window;
      else (globalThis as any).window = previousWindow;
    }
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
