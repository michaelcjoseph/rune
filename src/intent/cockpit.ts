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

/** Live progress data for an in-flight gen-eval-loop run on a project. Phase 6
 *  C3 extends `CockpitProject` to carry this so the project card can render
 *  the round / failed-rounds / model / heartbeat-age line without a second
 *  fetch. Populated from the gen-eval-loop runner's `progress` MutationEvents
 *  plus the supervised-run store's heartbeat. */
export interface CockpitProgress {
  /** Optional mutation id — the Cancel button on the cockpit project card
   *  routes to `cancelMutation(id)` via `POST /api/mutations/:id/cancel`.
   *  Optional because the supervision surface for a `blocked-on-human` run
   *  may surface progress without an in-flight cancellable mutation. */
  mutationId?: string;
  /** Optional cap (max evaluator rounds) — when present the renderer shows
   *  `round N / cap`, otherwise it shows `round N`. Comes from the
   *  escalation policy's `evaluator-round-cap` rule. */
  cap?: number;
  /** Current round number (1-indexed). */
  round: number;
  /** Running count of failed Evaluator rounds — the escalation policy gates
   *  on this against the configured cap. */
  failedEvaluatorRounds: number;
  /** Generator model alias (e.g., `sonnet`). Optional — populated once the
   *  resolution event fires from A7.1. */
  modelGen?: string;
  /** Evaluator model alias (e.g., `codex`). Optional and may be `null` when
   *  the policy could not resolve a distinct-provider evaluator. */
  modelEval?: string | null;
  /** ISO-8601 timestamp of the run's most recent heartbeat. The app.js
   *  amber-when-stale renderer compares this against `STALL_THRESHOLD_MS`.
   *
   *  @invariant Must be a string `Date.parse()` accepts. The runtime caller
   *  that wires this from the gen-eval-loop runner's progress events is
   *  responsible for validation — renderers must treat a non-parseable
   *  value as stalled, mirroring the pattern in `src/intent/supervision.ts`. */
  lastHeartbeatAt: string;
}

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
  /** Live progress for an active gen-eval-loop run (Phase 6 C3). Absent for
   *  idle projects and for active runs whose runner hasn't emitted progress
   *  yet (the cockpit just renders the run-status pill in that case). */
  progress?: CockpitProgress;
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

/** A richer per-project entry the supervision surface can pass — carries
 *  the bare run-status plus an optional progress object for the cockpit's
 *  in-flight render (C3). The map values can be the bare status string
 *  (the legacy shape) OR this entry; `buildCockpitView` normalizes both.
 *  Internal — callers reference the `RunStatusByProject` union below;
 *  exporting would only encourage drift between the test's `as any`
 *  shape and this declaration. */
interface CockpitRunStatusEntry {
  status: CockpitRunStatus;
  progress?: CockpitProgress;
}

/** Run-status keyed by project slug — the supervision surface's contribution to the view.
 *  Union: legacy bare-status callers continue to work; C3 callers can pass
 *  the richer `CockpitRunStatusEntry` carrying progress. */
export type RunStatusByProject = Record<string, CockpitRunStatus | CockpitRunStatusEntry>;

/** Normalize a runStatus map entry to `{status, progress}`. Accepts the
 *  legacy bare-status string and the C3-extended object shape. */
function normalizeRunStatusEntry(
  entry: CockpitRunStatus | CockpitRunStatusEntry | undefined,
): CockpitRunStatusEntry {
  if (entry === undefined) return { status: 'idle' };
  if (typeof entry === 'string') return { status: entry };
  return entry;
}

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
    projects: product.projects.map((project) => {
      const entry = normalizeRunStatusEntry(runStatus[project.slug]);
      const out: CockpitProject = {
        slug: project.slug,
        lifecycleStatus: project.status,
        // Run-status comes from the supervision surface; `idle` when it reports nothing.
        runStatus: entry.status,
        // Every project offers all three actions, each its own gated control.
        actions: ['start', 'continue', 'enter-planning-mode'],
      };
      // Phase 6 C3: surface live progress when the entry carries it.
      if (entry.progress !== undefined) out.progress = entry.progress;
      return out;
    }),
  }));
  return { available: true, products };
}
