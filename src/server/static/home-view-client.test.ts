import { describe, expect, it, vi } from 'vitest';

type Listener = (event?: unknown) => unknown;

function makeWindow(hash = '') {
  const listeners = new Map<string, Listener>();
  const location = {
    pathname: '/',
    search: '',
    hash,
  };
  const history = {
    pushState: vi.fn((_state: unknown, _title: string, url?: string | URL | null) => {
      if (url == null) return;
      const next = String(url);
      const hashIndex = next.indexOf('#');
      location.hash = hashIndex >= 0 ? next.slice(hashIndex) : '';
    }),
    replaceState: vi.fn((_state: unknown, _title: string, url?: string | URL | null) => {
      if (url == null) return;
      const next = String(url);
      const hashIndex = next.indexOf('#');
      location.hash = hashIndex >= 0 ? next.slice(hashIndex) : '';
    }),
  };
  return {
    location,
    history,
    addEventListener: vi.fn((type: string, listener: Listener) => {
      listeners.set(type, listener);
    }),
    dispatch(type: string) {
      listeners.get(type)?.();
    },
  };
}

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
    clickClosest(selector: string, dataset: Record<string, string>) {
      listeners.get('click')?.({
        target: {
          closest(query: string) {
            return query === selector ? { dataset } : null;
          },
        },
      });
    },
  };
}

const homePulse = {
  available: true,
  products: [
    {
      name: 'aura',
      repoBacked: true,
      activeRun: {
        runId: 'run-parked-1',
        target: { kind: 'project', slug: '17-cockpit-redesign' },
        state: 'parked',
        elapsedMs: 725_000,
      },
      counts: { activeProjects: 2, openBugs: 3, openIdeas: 5, backlogWarnings: 1 },
      mostRecentRun: {
        runId: 'run-noop-1',
        outcome: 'no-op',
        endedAt: '2026-06-23T12:30:00.000Z',
      },
      attention: [
        {
          kind: 'parked-run',
          runId: 'run-parked-1',
          target: { kind: 'project', slug: '17-cockpit-redesign' },
        },
        { kind: 'backlog-warning', count: 1 },
      ],
    },
    {
      name: 'relay',
      repoBacked: false,
      counts: { activeProjects: 0, openBugs: 0, openIdeas: 1, backlogWarnings: 0 },
      attention: [],
    },
  ],
};

describe('client view-router (cockpit redesign Phase 5)', () => {
  it('parses reloadable home and per-product routes, including run focus deep links', async () => {
    const { parseClientRoute } = await import('./view-router.js');

    expect(parseClientRoute('')).toEqual({ view: 'home' });
    expect(parseClientRoute('#/')).toEqual({ view: 'home' });
    expect(parseClientRoute('#/products/aura')).toEqual({ view: 'product', product: 'aura' });
    expect(parseClientRoute('#/products/aura?run=run-parked-1')).toEqual({
      view: 'product',
      product: 'aura',
      focusRunId: 'run-parked-1',
    });
  });

  it('owns active view/product selection and pushes browser history when navigating', async () => {
    const { createClientViewRouter } = await import('./view-router.js');
    const win = makeWindow('#/');
    const onChange = vi.fn();

    const router = createClientViewRouter({ window: win, onChange });

    expect(router.getState()).toEqual({ view: 'home' });

    router.goProduct('aura');

    expect(router.getState()).toEqual({ view: 'product', product: 'aura' });
    expect(win.history.pushState).toHaveBeenLastCalledWith(
      { view: 'product', product: 'aura' },
      '',
      '#/products/aura',
    );
    expect(onChange).toHaveBeenLastCalledWith({ view: 'product', product: 'aura' });

    router.goHome();

    expect(router.getState()).toEqual({ view: 'home' });
    expect(win.history.pushState).toHaveBeenLastCalledWith({ view: 'home' }, '', '#/');
  });

  it('restores the route state from the URL on back navigation and page reload', async () => {
    const { createClientViewRouter } = await import('./view-router.js');
    const win = makeWindow('#/products/aura?run=run-parked-1');
    const onChange = vi.fn();

    const router = createClientViewRouter({ window: win, onChange });

    expect(router.getState()).toEqual({
      view: 'product',
      product: 'aura',
      focusRunId: 'run-parked-1',
    });

    win.location.hash = '#/';
    win.dispatch('popstate');

    expect(router.getState()).toEqual({ view: 'home' });
    expect(onChange).toHaveBeenLastCalledWith({ view: 'home' });
  });
});

describe('Home view UI (cockpit redesign Phase 5)', () => {
  it('loads the read-mostly pulse from /api/home and never depends on /api/cockpit', async () => {
    const { createHomeView } = await import('./home-view.js');
    const root = makeRoot();
    const fetchJson = vi.fn(async (url: string) => {
      expect(url).toBe('/api/home');
      return homePulse;
    });

    const home = createHomeView({ root, fetchJson, router: { goProduct: vi.fn() } });
    await home.load();

    expect(fetchJson).toHaveBeenCalledTimes(1);
    expect(fetchJson).not.toHaveBeenCalledWith('/api/cockpit');
    expect(root.innerHTML).toContain('aura');
    expect(root.innerHTML).toContain('relay');
  });

  it('renders product cards with repo status, live run, counts, outcome, and attention', async () => {
    const { renderHomeView } = await import('./home-view.js');

    const html = renderHomeView(homePulse);

    expect(html).toContain('aura');
    expect(html).toMatch(/repo-backed/i);
    expect(html).toContain('relay');
    expect(html).toMatch(/limited|tracked|not repo-backed/i);
    expect(html).toContain('run-parked-1');
    expect(html).toMatch(/parked/i);
    expect(html).toMatch(/12m5s|12\s*min/i);
    expect(html).toContain('17-cockpit-redesign');
    expect(html).toMatch(/2\s*active projects/i);
    expect(html).toMatch(/3\s*open bugs/i);
    expect(html).toMatch(/5\s*open ideas/i);
    expect(html).toMatch(/1\s*(backlog )?warning/i);
    expect(html).toMatch(/no-op/i);
    expect(html).toMatch(/needs|attention|parked/i);
  });

  it('does not render chat, logs, or Fix controls on the Home pulse', async () => {
    const { renderHomeView } = await import('./home-view.js');

    const html = renderHomeView(homePulse);

    expect(html).not.toMatch(/id=["']message-input["']|<textarea|chat/i);
    expect(html).not.toMatch(/\blogs?\b|transcript|worktree/i);
    expect(html).not.toMatch(/\bfix\b/i);
  });

  it('deep-links a live active-run indicator into the product view focused on that run', async () => {
    const { createHomeView } = await import('./home-view.js');
    const root = makeRoot();
    const router = { goProduct: vi.fn() };

    const home = createHomeView({
      root,
      fetchJson: vi.fn(async () => homePulse),
      router,
    });
    await home.load();

    root.clickClosest('[data-home-active-run]', {
      product: 'aura',
      runId: 'run-parked-1',
    });

    expect(router.goProduct).toHaveBeenCalledWith('aura', { focusRunId: 'run-parked-1' });
  });

  it('renders the unavailable HomePulse state clearly without product-card chrome', async () => {
    const { renderHomeView } = await import('./home-view.js');

    const html = renderHomeView({
      available: false,
      products: [],
      unavailableReason: 'registry unreadable',
    });

    expect(html).toContain('registry unreadable');
    expect(html).toMatch(/unavailable|cannot load|could not load/i);
    expect(html).not.toMatch(/home-product-card/i);
  });
});
