import { describe, it, expect } from 'vitest';

/*
 * Test-first suite for test-plan.md §7 — product/project cockpit (08-intent-layer, Phase 2).
 *
 * Written BEFORE the implementation. `src/intent/cockpit.ts` ships as a contract stub whose
 * `buildCockpitView` throws 'not implemented', so every test here is RED. That is the
 * intended, correct state: this is a "Tests (write first)" task — the suite goes green when
 * a Phase 2 cockpit implementation task lands. Do not implement the cockpit to make these
 * pass; that is a separate task.
 *
 * Scope note: test-plan §7's "06-webview's existing surface keeps working unchanged" is an
 * integration property — `cockpit.ts` is a new, pure data-model module that never touches
 * the webview, so that item is covered by 06-webview's own test suite staying green when
 * the cockpit is wired in, not by this data-model suite.
 */

import {
  buildCockpitView,
  type BacklogCounts,
  type CockpitView,
} from './cockpit.js';
import type { Registry } from './registry.js';

// --- Fixtures ---

/** A registry spanning repo-backed and tracked-only products, including a zero-project one. */
function sampleRegistry(): Registry {
  return {
    version: 1,
    builtAt: '2026-01-15T00:00:00.000Z',
    products: [
      {
        name: 'aura',
        repoBacked: true,
        projects: [
          { slug: '01-mvp', status: 'done' },
          { slug: '02-growth', status: 'active' },
        ],
      },
      {
        name: 'relay',
        repoBacked: true,
        projects: [{ slug: '01-relay-core', status: 'planned' }],
      },
      // A tracked-only product with no project docs — must render cleanly.
      { name: 'family', repoBacked: false, projects: [] },
    ],
  };
}

/** Every project across the view, flattened — convenient for per-project assertions. */
function allProjects(view: CockpitView) {
  return view.products.flatMap((p) => p.projects);
}

describe('product/project cockpit — view contents (test-plan §7)', () => {
  it("shows every product, its projects, and each project's lifecycle status from the registry", () => {
    const view = buildCockpitView(sampleRegistry(), {});
    expect(view.available).toBe(true);
    expect(view.products.map((p) => p.name)).toEqual(['aura', 'relay', 'family']);
    const aura = view.products.find((p) => p.name === 'aura')!;
    expect(aura.repoBacked).toBe(true);
    expect(aura.projects.map((p) => p.slug)).toEqual(['01-mvp', '02-growth']);
    expect(aura.projects.find((p) => p.slug === '01-mvp')?.lifecycleStatus).toBe('done');
    expect(aura.projects.find((p) => p.slug === '02-growth')?.lifecycleStatus).toBe('active');
  });

  it('owns no state — the same registry and run-status always rebuild an identical view', () => {
    const a = buildCockpitView(sampleRegistry(), { '02-growth': 'running' });
    const b = buildCockpitView(sampleRegistry(), { '02-growth': 'running' });
    expect(a).toEqual(b);
  });

  it('renders a product with zero projects cleanly — an empty project list, not an error', () => {
    const family = buildCockpitView(sampleRegistry(), {}).products.find((p) => p.name === 'family')!;
    expect(family.projects).toEqual([]);
    expect(family.repoBacked).toBe(false); // repoBacked threads through from the registry
  });

  it('copies product class from the registry into the cockpit projection for roster grouping', () => {
    const registry: Registry = {
      version: 1,
      builtAt: '2026-06-29T00:00:00.000Z',
      products: [
        { name: 'rune', class: 'internal', repoBacked: true, projects: [] },
        { name: 'rune-mcp', class: 'internal', repoBacked: true, projects: [] },
        { name: 'aura', class: 'external', repoBacked: true, projects: [] },
        { name: 'writing', class: 'external', repoBacked: true, projects: [] },
        { name: 'brand', class: 'external', repoBacked: true, projects: [] },
      ],
    };

    const view = buildCockpitView(registry, {});

    expect(Object.fromEntries(view.products.map((product) => [product.name, product.class]))).toEqual({
      rune: 'internal',
      'rune-mcp': 'internal',
      aura: 'external',
      writing: 'external',
      brand: 'external',
    });
  });

  it('copies product scopePath from the registry into the cockpit projection for scoped containers', () => {
    const registry: Registry = {
      version: 1,
      builtAt: '2026-06-29T00:00:00.000Z',
      products: [
        {
          name: 'writing',
          class: 'external',
          scopePath: 'docs/rune',
          repoBacked: true,
          projects: [],
        } as any,
        {
          name: 'brand',
          class: 'external',
          repoBacked: true,
          projects: [],
        },
      ],
    };

    const view = buildCockpitView(registry, {});

    const byName = Object.fromEntries(view.products.map((product) => [product.name, product]));
    expect((byName['writing'] as any).scopePath).toBe('docs/rune');
    expect((byName['brand'] as any).scopePath).toBeUndefined();
  });

  it('copies product container capabilities into the cockpit projection so clients do not infer behavior from names', () => {
    const registry = {
      version: 1,
      builtAt: '2026-06-29T00:00:00.000Z',
      products: [
        {
          name: 'rune',
          class: 'internal',
          repoBacked: true,
          containerCapabilities: {
            projects: true,
            bugs: true,
            ideas: true,
            runs: true,
            chat: true,
            monitoring: 'enabled',
          },
          projects: [],
        },
        {
          name: 'essay-lab',
          class: 'external',
          repoBacked: true,
          containerCapabilities: {
            projects: false,
            bugs: false,
            ideas: true,
            runs: true,
            chat: true,
            monitoring: 'stubbed',
          },
          projects: [],
        },
      ],
    } as unknown as Registry;

    const view = buildCockpitView(registry, {});
    const byName = Object.fromEntries(view.products.map((product) => [product.name, product as any]));

    expect(byName['rune'].containerCapabilities).toEqual({
      projects: true,
      bugs: true,
      ideas: true,
      runs: true,
      chat: true,
      monitoring: 'enabled',
    });
    expect(byName['essay-lab'].containerCapabilities).toEqual({
      projects: false,
      bugs: false,
      ideas: true,
      runs: true,
      chat: true,
      monitoring: 'stubbed',
    });
  });
});

describe('product/project cockpit — per-action controls (test-plan §7)', () => {
  it('offers exactly start / continue / enter-planning-mode on every project, each its own gated control', () => {
    // Phase 2 offers all three actions on every project unconditionally — the action set
    // is flat, not lifecycle-gated. Per-action gating is the explicit-click UI behavior.
    for (const project of allProjects(buildCockpitView(sampleRegistry(), {}))) {
      expect([...project.actions].sort()).toEqual(['continue', 'enter-planning-mode', 'start']);
    }
  });
});

describe('product/project cockpit — run-status vs. lifecycle status (test-plan §7)', () => {
  it('shows run-status from the supervision surface, distinct from lifecycle status', () => {
    const project = allProjects(buildCockpitView(sampleRegistry(), { '02-growth': 'running' })).find(
      (p) => p.slug === '02-growth',
    )!;
    expect(project.runStatus).toBe('running');
    // Lifecycle status is unchanged — the two notions of status never collide.
    expect(project.lifecycleStatus).toBe('active');
  });

  it('defaults run-status to idle for a project the supervision surface does not report', () => {
    const view = buildCockpitView(sampleRegistry(), {});
    expect(allProjects(view).every((p) => p.runStatus === 'idle')).toBe(true);
  });

  it('surfaces a blocked-on-human run-status', () => {
    const project = allProjects(
      buildCockpitView(sampleRegistry(), { '01-relay-core': 'blocked-on-human' }),
    ).find((p) => p.slug === '01-relay-core')!;
    expect(project.runStatus).toBe('blocked-on-human');
  });
});

describe('product/project cockpit — registry unavailable (test-plan §7)', () => {
  it('shows a clear unavailable state when the registry could not be read — not a blank page', () => {
    const view = buildCockpitView(null, {});
    expect(view.available).toBe(false);
    expect(view.products).toEqual([]);
    expect(typeof view.unavailableReason).toBe('string');
    expect(view.unavailableReason!.length).toBeGreaterThan(0);
  });

  it('an available view never carries an unavailableReason', () => {
    const view = buildCockpitView(sampleRegistry(), {});
    expect(view.available).toBe(true);
    expect(view.unavailableReason).toBeUndefined();
  });
});

describe('product/project cockpit — task progress (cross-product)', () => {
  /** A registry whose projects carry baked-in `progress` (as a real rebuild produces). */
  function registryWithProgress(): Registry {
    const r = sampleRegistry();
    const aura = r.products.find((p) => p.name === 'aura')!;
    aura.projects.find((p) => p.slug === '01-mvp')!.progress = { done: 4, total: 4 };
    aura.projects.find((p) => p.slug === '02-growth')!.progress = { done: 1, total: 5 };
    return r;
  }

  it('surfaces the registry-baked progress when no live overlay is supplied', () => {
    const view = buildCockpitView(registryWithProgress(), {});
    const bySlug = Object.fromEntries(allProjects(view).map((p) => [p.slug, p.taskProgress]));
    expect(bySlug['01-mvp']).toEqual({ done: 4, total: 4 });
    expect(bySlug['02-growth']).toEqual({ done: 1, total: 5 });
    // A project with no baked progress and no overlay carries none.
    expect(bySlug['01-relay-core']).toBeUndefined();
  });

  it('lets the live overlay win over the registry-baked progress, by slug', () => {
    const view = buildCockpitView(registryWithProgress(), {}, { '02-growth': { done: 3, total: 5 } });
    const bySlug = Object.fromEntries(allProjects(view).map((p) => [p.slug, p.taskProgress]));
    expect(bySlug['02-growth']).toEqual({ done: 3, total: 5 }); // overlay wins
    expect(bySlug['01-mvp']).toEqual({ done: 4, total: 4 }); // untouched falls back to registry
  });
});

describe('product/project cockpit — backlog counts (09-expand-cockpit)', () => {
  it('carries no backlogCounts when the optional map is omitted', () => {
    const view = buildCockpitView(sampleRegistry(), {});
    for (const product of view.products) {
      expect(product.backlogCounts).toBeUndefined();
    }
  });

  it('populates backlogCounts on the matching product, keyed by product NAME (not slug)', () => {
    const counts: Record<string, BacklogCounts> = {
      aura: { bugs: { open: 4, done: 1 }, ideas: { open: 7, done: 2 }, warnings: 2 },
    };
    const view = buildCockpitView(sampleRegistry(), {}, undefined, undefined, counts);
    const aura = view.products.find((p) => p.name === 'aura')!;
    expect(aura.backlogCounts).toEqual({
      bugs: { open: 4, done: 1 },
      ideas: { open: 7, done: 2 },
      warnings: 2,
    });
    // Products absent from the map carry no counts.
    expect(view.products.find((p) => p.name === 'relay')!.backlogCounts).toBeUndefined();
    expect(view.products.find((p) => p.name === 'family')!.backlogCounts).toBeUndefined();
  });

  it('never populates backlogCounts on a non-repo-backed product, even if the map carries an entry', () => {
    // `readBacklogs` returns an all-zeros entry for non-repo-backed products; the view must
    // leave such a product absent (no "Bugs 0 · Ideas 0" card) rather than render empty counts.
    const counts: Record<string, BacklogCounts> = {
      family: { bugs: { open: 0, done: 0 }, ideas: { open: 0, done: 0 }, warnings: 0 },
    };
    const view = buildCockpitView(sampleRegistry(), {}, undefined, undefined, counts);
    expect(view.products.find((p) => p.name === 'family')!.backlogCounts).toBeUndefined();
  });
});
