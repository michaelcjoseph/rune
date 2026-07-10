/**
 * Work-run GC runtime glue (project 11, Phase 3). Gathers the live protected-set
 * inputs — active mutation ids (`activeRuns`) + non-terminal supervised-run ids
 * (`supervised-runs.json`) — and invokes the pure-ish `gcWorkRuns` pass against a
 * product's repo. Best-effort: a failure is logged, never thrown, so GC can be
 * fired-and-forgotten on startup (`src/index.ts`) and on each run completion
 * (`work-runner.apply`) without risking the caller.
 */

import config from '../config.js';
import { activeRuns } from '../transport/mutations.js';
import { readAllRuns } from './supervision-store.js';
import { readProductsConfig, defaultRunGit } from './sandbox-runtime.js';
import { gcWorkRuns } from './work-run-gc.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('work-run-gc-runner');

/** A supervised run is prunable only once terminal; everything else is still
 *  live work and must be protected from GC. */
const TERMINAL_STATUSES = new Set(['completed', 'failed']);

/**
 * Run a best-effort GC pass across ALL registered products' work-run artifacts.
 * Protects every active mutation and every non-terminal supervised run. Resolves
 * regardless of outcome (errors are logged), so callers can `void` it.
 *
 * Scope note: `workRunsDir` (`logs/work-runs/`) is Rune-global, so the dir-level
 * retention is computed once over every product's run dirs. Worktree-checkout
 * protection and `branch -D` pruning are per-repo — `gcWorkRuns` reads each
 * product's worktree list and prunes each run's branch in the repo named by its
 * `product` — so the full `products.json` repo map is handed in and a single pass
 * covers all repos (no per-product loop, which would re-run the global dir prune).
 */
export async function runWorkRunGc(): Promise<void> {
  try {
    // Tolerate a missing/incomplete products.json (fresh clone) by skipping
    // quietly rather than throwing — matches the best-effort posture of
    // cleanupOrphanWorktrees.
    let productRepos: Record<string, string>;
    let productBaseBranches: Record<string, string>;
    try {
      const products = readProductsConfig(config.PRODUCTS_CONFIG_FILE);
      productRepos = Object.fromEntries(
        Object.entries(products).map(([slug, p]) => [slug, p.repoPath]),
      );
      // Base branches feed the unmerged-branch check before a `branch -D` —
      // product config is the source of truth (same field the fork/merge
      // paths use), not the run summaries.
      productBaseBranches = Object.fromEntries(
        Object.entries(products).map(([slug, p]) => [slug, p.baseBranch]),
      );
    } catch {
      return; // no readable products.json → nothing to GC
    }
    if (Object.keys(productRepos).length === 0) return;

    // In-flight mutations (work-run + any other kind) — their ids match the
    // per-run dir names; protecting extras is harmless.
    const activeIds = new Set<string>(activeRuns.keys());

    // Non-terminal supervised runs (running / blocked-on-human / unknown).
    let nonTerminalIds = new Set<string>();
    try {
      nonTerminalIds = new Set(
        readAllRuns(config.SUPERVISED_RUNS_FILE)
          .filter(r => !TERMINAL_STATUSES.has(r.status))
          .map(r => r.id),
      );
    } catch (err) {
      log.warn('runWorkRunGc: reading supervised runs failed; proceeding with active-only protection', {
        error: (err as Error).message,
      });
    }

    const result = await gcWorkRuns({
      workRunsDir: config.WORK_RUNS_DIR,
      runGit: defaultRunGit,
      productRepos,
      productBaseBranches,
      activeIds,
      nonTerminalIds,
      maxRuns: config.WORK_RUN_RETENTION_MAX_RUNS,
      maxBytes: config.WORK_RUN_RETENTION_MAX_BYTES,
    });

    if (result.deletedIds.length > 0) {
      log.info('work-run GC pruned runs', { count: result.deletedIds.length, ids: result.deletedIds });
    }
  } catch (err) {
    log.warn('runWorkRunGc failed', { error: (err as Error).message });
  }
}
