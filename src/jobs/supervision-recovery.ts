/**
 * Supervision startup recovery — walk every persisted SupervisedRun and apply
 * `recoverRun` (flipping stale `'running'` entries to `'unknown'` since they
 * can't be observed across a Jarvis restart). Mirrors `reconcileOrphans()`
 * in `mutations-log.ts` for the supervision store.
 *
 * Idempotent: terminal entries (`completed` / `failed`) and durable states
 * (`blocked-on-human`, `unknown`) are unchanged. Skips the disk write when
 * no entry transitioned to avoid needless I/O on a clean boot.
 *
 * Called from `src/index.ts` at startup, paired with `reconcileOrphans`.
 *
 * See spec.md §"Layer 3", tasks.md Phase 6 A2.3.
 */

import { recoverRun } from '../intent/supervision.js';
import { readAllRuns, writeAllRuns } from './supervision-store.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('supervision-recovery');

export interface RecoveryResult {
  /** Number of runs whose status was changed by `recoverRun` (today: the
   *  count of `'running'` entries that became `'unknown'`). */
  transitioned: number;
  /** Total number of persisted runs walked. */
  total: number;
}

/**
 * Run the startup recovery pass. Reads `filePath`, applies `recoverRun` to
 * each entry, and writes the result back if anything actually changed.
 * A missing file is treated as an empty store — returns `{0, 0}` with no
 * throw, so a fresh install or a wiped log dir doesn't gate startup.
 */
export function recoverSupervisedRuns(filePath: string): RecoveryResult {
  const runs = readAllRuns(filePath);
  if (runs.length === 0) return { transitioned: 0, total: 0 };

  let transitioned = 0;
  const next = runs.map((run) => {
    const recovered = recoverRun(run);
    if (recovered.status !== run.status) transitioned++;
    return recovered;
  });

  // Safe only because recoverRun is identity except for 'running' → 'unknown'.
  // If it's ever extended to mutate other fields, this guard becomes too
  // aggressive and needs to compare more than just status.
  if (transitioned === 0) {
    return { transitioned: 0, total: runs.length };
  }

  writeAllRuns(next, filePath);
  log.info('Recovered supervised runs', { transitioned, total: runs.length, path: filePath });

  return { transitioned, total: runs.length };
}
