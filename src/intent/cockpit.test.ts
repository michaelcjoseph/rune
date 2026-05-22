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
