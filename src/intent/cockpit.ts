/**
 * Product/project cockpit — the data model behind the Phase 2 cockpit view. The cockpit
 * extends the 06-webview surface into a live picture of every product, its projects, and
 * each project's status; this module builds that picture from the registry.
 *
 * The cockpit **owns no state**. `buildCockpitView` is a pure projection of its inputs —
 * the registry (durable lifecycle status) plus the supervision surface's run-status
 * (running / blocked) — so deleting the cockpit and rebuilding from the registry + repos +
 * vault loses nothing. Two notions of status stay distinct: `lifecycleStatus` (planned /
 * active / done, from the registry) and `runStatus` (idle / running / blocked-on-human,
 * from supervision — Layer 3, §10).
 *
 * The contract is pinned by the test suite in `cockpit.test.ts` (test-plan.md §7).
 *
 * See docs/projects/08-intent-layer/{spec.md (§"Cockpit"), test-plan.md (§7)}.
 */

import type { LifecycleStatus, Registry } from './registry.js';

/** Live run-status of a project — held by supervision (Layer 3), never by the registry. */
export type CockpitRunStatus = 'idle' | 'running' | 'blocked-on-human';

/** A per-project control the cockpit offers; each is gated per-action (an explicit click). */
export type CockpitAction = 'start' | 'continue' | 'enter-planning-mode';

/** One project as the cockpit presents it — lifecycle status and run-status side by side. */
export interface CockpitProject {
  /** Project slug, e.g. `08-intent-layer`. */
  slug: string;
  /** Durable lifecycle status, from the registry. */
  lifecycleStatus: LifecycleStatus;
  /** Live run-status, from the supervision surface; `idle` when supervision reports nothing. */
  runStatus: CockpitRunStatus;
  /** The actions offered for this project — each rendered as its own gated control. */
  actions: CockpitAction[];
}

/** A product and the projects under it, as the cockpit presents them. */
export interface CockpitProduct {
  name: string;
  repoBacked: boolean;
  projects: CockpitProject[];
}

/** The cockpit view — every product/project, or a clear unavailable state. */
export interface CockpitView {
  /** False when the registry could not be read; the UI shows `unavailableReason`, not a blank page. */
  available: boolean;
  /** Every product with its projects; empty when the registry is unavailable. */
  products: CockpitProduct[];
  /** Human-readable reason, set only when `available` is false. */
  unavailableReason?: string;
}

/** Run-status keyed by project slug — the supervision surface's contribution to the view. */
export type RunStatusByProject = Record<string, CockpitRunStatus>;

/**
 * Build the cockpit view from the registry and the supervision surface's run-status. Pure:
 * it owns no state and only projects its inputs, so the view is always rebuildable.
 *
 * A `null` registry (it could not be read) yields `{ available: false, products: [],
 * unavailableReason }` — the UI shows a clear unavailable state, never a blank or broken
 * page. Otherwise every product and project from the registry is present; each project
 * carries its registry `lifecycleStatus` and, separately, its `runStatus` from the
 * `runStatus` argument (defaulting to `idle` when supervision reports nothing for that slug). A
 * product with zero projects yields a product with an empty `projects` list, not an error.
 */
export function buildCockpitView(
  registry: Registry | null,
  runStatus: RunStatusByProject,
): CockpitView {
  if (registry === null) {
    return {
      available: false,
      products: [],
      unavailableReason: 'registry unavailable — it has not been built yet',
    };
  }
  const products: CockpitProduct[] = registry.products.map((product) => ({
    name: product.name,
    repoBacked: product.repoBacked,
    projects: product.projects.map((project) => ({
      slug: project.slug,
      lifecycleStatus: project.status,
      // Run-status comes from the supervision surface; `idle` when it reports nothing.
      runStatus: runStatus[project.slug] ?? 'idle',
      // Every project offers all three actions, each its own gated control.
      actions: ['start', 'continue', 'enter-planning-mode'],
    })),
  }));
  return { available: true, products };
}
