import { readVaultFile, vaultFileExists } from '../vault/files.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('sr-pool');

/** Relative vault path to the Phase-1 hand-seeded concept list. */
export const SR_SEED_PATH = 'study/sr-seed.json';

/** Wiki concept status values. The hand-seeded Phase-1 pool carries no status
 *  data; this filter becomes meaningful in Phase 3's frontmatter walker. */
export type ConceptStatus = 'evergreen' | 'active' | 'stale';

export interface ReadPoolOptions {
  /** Statuses admitted to the pool. Honored by the Phase 3 frontmatter walker;
   *  inert in the Phase 1 seed-list implementation. Defaults to non-stale. */
  statusFilter?: ConceptStatus[];
}

/** Return the SR pool — the set of wiki-concept paths eligible for review.
 *
 *  Phase 1 implementation: reads a hand-curated list from `study/sr-seed.json`
 *  (`{ concepts: string[] }`) and returns the entries that still exist on disk.
 *  Wiki `status` frontmatter does not exist yet, so `statusFilter` is accepted
 *  for API stability but has no effect until the Phase 3 frontmatter walker
 *  replaces this implementation.
 *
 *  A missing, empty, or corrupt seed file yields an empty pool (not an error) —
 *  the `/study` command surface reports "no concepts in the SR pool yet". */
export function readPool(_options: ReadPoolOptions = {}): string[] {
  const raw = readVaultFile(SR_SEED_PATH);
  if (raw === null || raw.trim() === '') return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    log.warn(`Corrupt SR seed file (${SR_SEED_PATH}) — treating pool as empty`, {
      error: (err as Error).message,
    });
    return [];
  }

  const concepts = (parsed as { concepts?: unknown })?.concepts;
  if (!Array.isArray(concepts)) {
    log.warn(`SR seed file (${SR_SEED_PATH}) has no concepts array — treating pool as empty`);
    return [];
  }

  const pool: string[] = [];
  for (const entry of concepts) {
    if (typeof entry !== 'string') {
      log.warn('Skipping non-string entry in SR seed file', { entry: String(entry) });
      continue;
    }
    if (!vaultFileExists(entry)) {
      log.warn('SR seed concept missing from disk — excluding from pool', { conceptPath: entry });
      continue;
    }
    pool.push(entry);
  }
  return pool;
}
