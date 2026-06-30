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

import type {
  LifecycleStatus,
  ProductClass,
  ProductContainerCapabilities,
  Registry,
  RegistryProduct,
} from './registry.js';

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

/** Terminal verdict mirror of `WorkOutcome` in `src/jobs/work-run-classify.ts`
 *  (project 11). Kept as a LOCAL union rather than imported so the intent layer
 *  doesn't depend on the jobs layer (the dependency direction is jobs → intent).
 *  The server-side bridge that maps the work-run store into this projection
 *  (`src/server/work-run-projection.ts`) imports both and will fail to compile
 *  if the two unions ever drift, so this duplication is drift-safe. */
export type WorkRunOutcome = 'branch-complete' | 'partial' | 'noop' | 'dirty-uncommitted' | 'failed';

/** Live/terminal projection of a single work run onto its project's cockpit
 *  card (project 11, Phase 5). Sourced from the new work-run store
 *  (`logs/work-runs/`), distinct from the gen-eval-loop `CockpitProgress`.
 *  An active run carries `lastOutput` + `startedAt` (elapsed basis) with a null
 *  `outcome`; a terminated run carries `outcome` + `reason`. `transcriptUrl` is
 *  null until a transcript exists, so the card degrades gracefully. */
export interface WorkRunProjection {
  /** Mutation/run id — also the per-run dir name and the transcript route id. */
  mutationId: string;
  /** Terminal verdict, or null while the run is still in flight. */
  outcome: WorkRunOutcome | null;
  /** Terminal reason string, or null while in flight. */
  reason: string | null;
  /** Last N readable output lines (drawer-closed live tail / terminal tail). */
  lastOutput: string[];
  /** ISO-8601 run start — the card derives elapsed from this. */
  startedAt: string;
  /** Authenticated transcript route URL, or null when no transcript exists yet. */
  transcriptUrl: string | null;
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
  /** Static task progress (done / total) sourced from `tasks.md` via
   *  `getProjectSummaries()`. Used by the cockpit's per-project card to
   *  render the same progress bar the (now-removed) Projects sidebar
   *  panel had. Optional because the source can fail to read for a
   *  project — the cockpit must render even without it. Distinct from
   *  the `progress` field above, which carries gen-eval-loop run state
   *  (rounds + models + heartbeat). */
  taskProgress?: { done: number; total: number };
  /** Live/terminal work-run projection (project 11, Phase 5), sourced from the
   *  work-run store. Absent when the project has no recent work run. Distinct
   *  from `progress` (gen-eval-loop run state). */
  workRun?: WorkRunProjection;
  /** Which applier the Start action will dispatch (project 14, Phase 5) —
   *  `orchestrated` (the product-team loop) or `legacy` (`/work --auto`). The
   *  cockpit Start surface shows this BEFORE launch so the mode is never a
   *  surprise. Absent when the caller didn't supply a dispatch-mode map. */
  dispatchMode?: DispatchMode;
  /** On a `legacy` fallback, the recorded reason (e.g. "orchestrated mode
   *  disabled") so a fallback run is truthful, never silently legacy. */
  fallbackReason?: string;
}

/** A per-project dispatch-mode entry for the cockpit Start surface (project 14).
 *  Sourced from the work-dispatch seam (`resolveWorkDispatch`). */
export interface DispatchModeView {
  mode: DispatchMode;
  fallbackReason?: string;
}

/** The applier-selection mode — mirrors `DispatchMode` in src/intent/orch-config.ts.
 *  Kept as a LOCAL union so the cockpit data model stays free of a runtime
 *  import; the server bridge that feeds it imports the real type. */
export type DispatchMode = 'orchestrated' | 'legacy';

/** Open/done tallies for a product's backlog (09-expand-cockpit). Surfaced on the product
 *  card so the sidebar can render a `Bugs N · Ideas N · ⚠ N` one-liner without fetching the
 *  full lists — the drawer fetches those separately, keeping the cockpit payload bounded.
 *  `warnings` is the file-level format-warning count (the drawer's "Format warnings" banner). */
export interface BacklogCounts {
  bugs: { open: number; done: number };
  ideas: { open: number; done: number };
  warnings: number;
}

/** A product and the projects under it, as the cockpit presents them. */
export interface CockpitProduct {
  name: string;
  /** Product-OS class copied from the registry for internal/external roster grouping. */
  class?: ProductClass;
  /** Optional repo-relative product scope for shared-repo product containers. */
  scopePath?: string;
  /** Product-aware container contract copied from the registry. */
  containerCapabilities?: ProductContainerCapabilities;
  repoBacked: boolean;
  projects: CockpitProject[];
  /** Backlog open/done + warning counts (09-expand-cockpit). Absent unless the caller passes
   *  the `backlogCounts` map to `buildCockpitView`; product repos with no backlog stay absent. */
  backlogCounts?: BacklogCounts;
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

function resolveProductContainerCapabilities(
  product: Pick<RegistryProduct, 'name' | 'class' | 'containerCapabilities'>,
): ProductContainerCapabilities {
  if (product.containerCapabilities) return product.containerCapabilities;
  if (product.name === 'writing') {
    return {
      projects: false,
      bugs: false,
      ideas: true,
      runs: true,
      chat: true,
      monitoring: 'stubbed',
    };
  }
  return {
    projects: true,
    bugs: true,
    ideas: true,
    runs: true,
    chat: true,
    monitoring: product.class === 'internal' ? 'enabled' : 'stubbed',
  };
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
 *
 * The optional `taskProgress` argument is a slug-keyed map of `{done, total}` task counts
 * (a live overlay sourced from `getProjectSummaries()`); when a slug is present, it wins.
 * Otherwise each project falls back to the `progress` carried on its registry entry (the
 * cross-product source, refreshed on registry rebuild). A project with neither yields no
 * `taskProgress` — the renderer must handle that (don't render a bar for unknown counts).
 *
 * The optional `workRuns` argument (project 11, Phase 5) is a slug-keyed map of work-run
 * projections sourced from the new work-run store; when supplied, each matching project's
 * `workRun` field is populated. Slugs absent from the map yield projects without `workRun`.
 *
 * The optional `backlogCounts` argument (09-expand-cockpit) is a PRODUCT-NAME-keyed map of
 * backlog open/done + warning counts sourced from `readBacklogs` + `computeBacklogCounts`;
 * when supplied, each matching product's `backlogCounts` field is populated. Products absent
 * from the map (or non-repo-backed) yield no `backlogCounts`.
 */
export function buildCockpitView(
  registry: Registry | null,
  runStatus: RunStatusByProject,
  taskProgress?: Record<string, { done: number; total: number }>,
  workRuns?: Record<string, WorkRunProjection>,
  // NOTE: keyed by product NAME (product-level), unlike the slug-keyed (project-level)
  // taskProgress/workRuns above — products have no slug, so name is the only product key.
  backlogCounts?: Record<string, BacklogCounts>,
  // Project 14 Phase 5: slug-keyed dispatch-mode overlay (which applier Start
  // will use) for the cockpit Start surface. Mirrors the taskProgress/workRuns
  // slug-keyed pattern; absent slugs leave `dispatchMode` unset on the project.
  dispatchModes?: Record<string, DispatchModeView>,
): CockpitView {
  if (registry === null) {
    return {
      available: false,
      products: [],
      unavailableReason: 'registry unavailable — it has not been built yet',
    };
  }
  const products: CockpitProduct[] = registry.products.map((product) => {
    const projects = product.projects.map((project) => {
      const entry = normalizeRunStatusEntry(runStatus[project.slug]);
      const out: CockpitProject = {
        slug: project.slug,
        lifecycleStatus: project.status,
        // Run-status comes from the supervision surface; `idle` when it reports nothing.
        runStatus: entry.status,
        // Every project offers all three actions, each its own gated control.
        actions: ['start', 'continue', 'enter-planning-mode'],
      };
      // Phase 6 C3: surface live gen-eval-loop progress when the entry carries it.
      if (entry.progress !== undefined) out.progress = entry.progress;
      // Task progress: prefer the caller's slug-keyed live overlay (a fresh
      // read of the running product's tasks.md), falling back to the per-project
      // `progress` baked into the registry at its last rebuild (the cross-product
      // source — products other than the one the daemon runs in only have this).
      const tp = taskProgress?.[project.slug] ?? project.progress;
      if (tp !== undefined) out.taskProgress = tp;
      // Phase 5: work-run projection from the store when the caller supplied it.
      const wr = workRuns?.[project.slug];
      if (wr !== undefined) out.workRun = wr;
      // Project 14 Phase 5: dispatch mode for the Start surface. A legacy entry
      // carries its fallback reason so the card never reads as orchestrated by
      // omission.
      const dm = dispatchModes?.[project.slug];
      if (dm !== undefined) {
        out.dispatchMode = dm.mode;
        if (dm.fallbackReason !== undefined) out.fallbackReason = dm.fallbackReason;
      }
      return out;
    });
    const prod: CockpitProduct = {
      name: product.name,
      ...(product.class ? { class: product.class } : {}),
      ...(product.scopePath ? { scopePath: product.scopePath } : {}),
      containerCapabilities: resolveProductContainerCapabilities(product),
      repoBacked: product.repoBacked,
      projects,
    };
    // 09-expand-cockpit: product-name-keyed backlog counts when the caller supplied them.
    // Guard on repoBacked so a caller that feeds the all-zeros entry `readBacklogs` returns
    // for a non-repo-backed product can't render "Bugs 0 · Ideas 0" on a repo-less card —
    // "no backlog" (absent) stays distinct from "empty backlog".
    const counts = backlogCounts?.[product.name];
    if (counts !== undefined && product.repoBacked) prod.backlogCounts = counts;
    return prod;
  });
  return { available: true, products };
}
