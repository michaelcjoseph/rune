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
 * Run a best-effort GC pass for `product`'s work-run artifacts. Protects every
 * active mutation and every non-terminal supervised run. Resolves regardless of
 * outcome (errors are logged), so callers can `void` it.
 *
 * Scope note: `workRunsDir` (`logs/work-runs/`) is Jarvis-global — the dir-level
 * prune covers every product's run dirs. `repoPath` is product-scoped (only the
 * `git worktree list` protection + `branch -D` prune use it), so a multi-product
 * setup would call this once per registered product; today only 'jarvis' runs
 * work-runs, so the startup default is 'jarvis'.
 */
export async function runWorkRunGc(product = 'jarvis'): Promise<void> {
  try {
    // Tolerate a missing/incomplete products.json (fresh clone, product not yet
    // registered) by skipping quietly rather than throwing — matches the
    // best-effort posture of cleanupOrphanWorktrees.
    let repoPath: string;
    try {
      const products = readProductsConfig(config.PRODUCTS_CONFIG_FILE);
      const entry = products[product];
      if (!entry) {
        log.debug('runWorkRunGc: product not registered; skipping', { product });
        return;
      }
      repoPath = entry.repoPath;
    } catch {
      return; // no readable products.json → nothing to GC
    }

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
      repoPath,
      activeIds,
      nonTerminalIds,
      maxRuns: config.WORK_RUN_RETENTION_MAX_RUNS,
      maxBytes: config.WORK_RUN_RETENTION_MAX_BYTES,
    });

    if (result.deletedIds.length > 0) {
      log.info('work-run GC pruned runs', { product, count: result.deletedIds.length, ids: result.deletedIds });
    }
  } catch (err) {
    log.warn('runWorkRunGc failed', { product, error: (err as Error).message });
  }
}
