/**
 * Cockpit run-status projection — maps the supervision `VisibilitySurface`
 * into the cockpit's `RunStatusByProject` shape consumed by
 * `buildCockpitView`.
 *
 * The pure mapper (`mapVisibilityToRunStatus`) is exported separately so
 * it stays test-importable without bootstrapping the runtime config; the
 * `readCockpitRunStatus` wrapper adds the I/O layer (reading the
 * supervised-run store, calling `getVisibility`) that the webview cockpit
 * endpoint uses.
 *
 * Mapping rule: when a project has both `running` and `blocked-on-human`
 * entries in the visibility surface, `blocked-on-human` wins — it's the
 * more urgent cockpit signal (the user needs to take action).
 *
 * See tasks.md Phase 6 A2.5.
 */

import { getVisibility, type VisibilitySurface } from '../intent/supervision.js';
import type { RunStatusByProject } from '../intent/cockpit.js';
import { readAllRuns } from '../jobs/supervision-store.js';
import { STALL_THRESHOLD_MS } from '../jobs/stall-check.js';

/**
 * Pure projection. Walks `visibility.active` (running + blocked-on-human)
 * and builds a project-slug → run-status map. Blocked entries win over
 * running ones for the same slug.
 */
export function mapVisibilityToRunStatus(visibility: VisibilitySurface): RunStatusByProject {
  const out: RunStatusByProject = {};
  for (const run of visibility.active) {
    // 'running' → 'running'; 'blocked-on-human' → 'blocked-on-human'.
    // Terminal/unknown statuses are filtered upstream by getVisibility.active.
    if (run.status === 'running' || run.status === 'blocked-on-human') {
      // Blocked-on-human wins: if we've already recorded a 'running' for
      // this slug, a subsequent 'blocked-on-human' overrides it. Once
      // we've seen 'blocked-on-human' we don't downgrade back to 'running'.
      if (out[run.project] === 'blocked-on-human') continue;
      out[run.project] = run.status;
    }
  }
  return out;
}

/**
 * Read the persisted SupervisedRun[], compute the visibility surface, and
 * project to the cockpit's RunStatusByProject. A missing or malformed
 * store returns `{}` (readAllRuns already handles those cases).
 */
export function readCockpitRunStatus(filePath: string, now: number = Date.now()): RunStatusByProject {
  const runs = readAllRuns(filePath);
  return mapVisibilityToRunStatus(getVisibility(runs, STALL_THRESHOLD_MS, now));
}
