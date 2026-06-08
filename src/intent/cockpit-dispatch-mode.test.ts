import { describe, it, expect } from 'vitest';

/*
 * Phase 5 mode-visibility seam (project 14): the cockpit Start surface must show
 * whether Start will dispatch orchestrated work or legacy `/work --auto` BEFORE
 * launch, and a fallback run must expose its fallback reason. `buildCockpitView`
 * carries a per-project `dispatchMode` (+ `fallbackReason` on a legacy fallback)
 * sourced from the dispatch seam, mirroring the `taskProgress` overlay pattern.
 */

import { buildCockpitView } from './cockpit.js';
import type { Registry } from './registry.js';

function registry(): Registry {
  return {
    version: 1,
    builtAt: '2026-01-15T00:00:00.000Z',
    products: [
      {
        name: 'jarvis',
        repoBacked: true,
        projects: [
          { slug: '14-product-team-agents', status: 'active' },
          { slug: '11-work-runs', status: 'active' },
        ],
      },
    ],
  };
}

describe('cockpit dispatch-mode visibility (project 14, Phase 5)', () => {
  it('surfaces an orchestrated dispatch mode on the project card without a fallback reason', () => {
    const view = buildCockpitView(registry(), {}, undefined, undefined, undefined, {
      '14-product-team-agents': { mode: 'orchestrated' },
    });
    const proj = view.products[0]!.projects.find((p) => p.slug === '14-product-team-agents')!;
    expect(proj.dispatchMode).toBe('orchestrated');
    expect(proj.fallbackReason).toBeUndefined();
  });

  it('surfaces a legacy fallback mode WITH its reason so the surface is truthful', () => {
    const view = buildCockpitView(registry(), {}, undefined, undefined, undefined, {
      '11-work-runs': { mode: 'legacy', fallbackReason: 'orchestrated mode disabled' },
    });
    const proj = view.products[0]!.projects.find((p) => p.slug === '11-work-runs')!;
    expect(proj.dispatchMode).toBe('legacy');
    expect(proj.fallbackReason).toBe('orchestrated mode disabled');
  });

  it('leaves dispatchMode absent for projects with no entry in the map', () => {
    const view = buildCockpitView(registry(), {});
    for (const proj of view.products[0]!.projects) {
      expect(proj.dispatchMode).toBeUndefined();
    }
  });
});
