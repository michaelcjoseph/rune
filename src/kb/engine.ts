import config from '../config.js';
import { ingestSource } from './ingest.js';
import { queryKB } from './query.js';
import { lintKB } from './lint.js';
import { getQueue, getPriority, type QueueEntry } from './queue.js';
import { readVaultFile, listVaultFiles, appendVaultFile } from '../vault/files.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('kb-engine');

/** Invoke wiki-linter + append a checkpoint summary to `knowledge/log.md`
 *  every N successful ingestions. The Karpathy-style spec calls for 15;
 *  keeping it named so tests can reason about boundaries. */
export const INGESTS_PER_CHECKPOINT = 15;

export { initKB } from './init.js';
export { enqueue } from './queue.js';
export { ingestSource, queryKB, lintKB };

/**
 * Process all sources in the ingestion queue.
 * Sorts by priority (higher first) so first-person + hand-curated sources
 * land in the KB before noisier third-party content. Every 15 successful
 * ingestions, runs wiki-linter and appends a `[CHECKPOINT]` line to
 * `knowledge/log.md` so quality drift is visible to downstream review prep.
 * Called during nightly processing.
 *
 * Single-caller assumption: the scheduler's `guarded()` wrapper serializes
 * nightly invocations, and no other code path currently invokes a full
 * queue run. If a second caller is ever added (e.g., a manual CLI trigger
 * wired in parallel), add an in-process lock here — two concurrent runs
 * would interleave checkpoint appends to knowledge/log.md and double-fire
 * dequeue on the same sources.
 */
export async function processIngestionQueue(): Promise<{ processed: number; errors: number; created: number; updated: number; checkpoints: number }> {
  const queue = getQueue();
  if (queue.length === 0) {
    log.info('Ingestion queue is empty');
    return { processed: 0, errors: 0, created: 0, updated: 0, checkpoints: 0 };
  }

  // Priority-ordered processing: higher first, FIFO within the same tier.
  // Legacy queue entries without a `priority` field fall back to a derivation
  // on read so a nightly doesn't skip them after an upgrade.
  const sorted = [...queue].sort((a, b) => priorityOf(b) - priorityOf(a));

  log.info(`Processing ${sorted.length} queued source(s)`);
  let processed = 0;
  let errors = 0;
  let created = 0;
  let updated = 0;
  let checkpoints = 0;

  for (const entry of sorted) {
    const result = await ingestSource(entry.source, { guidance: entry.guidance });
    created += result.counts.created;
    updated += result.counts.updated;
    if (result.success) {
      processed++;
      if (processed % INGESTS_PER_CHECKPOINT === 0) {
        try {
          await runCheckpoint(processed);
          checkpoints++;
        } catch (err) {
          // Checkpoint failure is non-blocking — the queue keeps processing.
          log.error('Checkpoint failed, continuing queue', { error: (err as Error).message });
        }
      }
    } else {
      errors++;
      log.error('Failed to ingest queued source', { source: entry.source, error: result.output });
    }
  }

  log.info('Ingestion queue processed', { processed, errors, created, updated, checkpoints });
  return { processed, errors, created, updated, checkpoints };
}

function priorityOf(entry: QueueEntry): number {
  return typeof entry.priority === 'number' ? entry.priority : getPriority(entry.source);
}

/** Run the wiki-linter and append a checkpoint line to knowledge/log.md.
 *  The line shape is `[YYYY-MM-DD HH:MM] [CHECKPOINT] ...` — stable so the
 *  kb-activity scanner (which only surfaces [INGEST] entries) can reliably
 *  bound its blocks at the checkpoint marker without misattributing the
 *  checkpoint prose to the previous ingest. */
async function runCheckpoint(processedCount: number): Promise<void> {
  log.info('Running mid-queue checkpoint', { processedCount });
  const lintResult = await lintKB();
  const ts = nowLogTimestamp();
  const line = `[${ts}] [CHECKPOINT] After ${processedCount} ingestions — ${summarizeLint(lintResult.report)}\n`;
  appendVaultFile('knowledge/log.md', line);
}

/** Format today in the vault's timezone as `YYYY-MM-DD HH:MM` to match the
 *  existing `[INGEST]` line shape at the top of `knowledge/log.md`. */
function nowLogTimestamp(): string {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: config.TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = fmt.formatToParts(now);
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
}

/** One-line tail summary of a lint report. Wiki-linter's report can run to
 *  dozens of lines; the checkpoint only needs a scannable headline. Skips
 *  pure-markdown-heading lines so a report starting with "# Wiki Health
 *  Report" doesn't become the checkpoint's user-facing headline. */
function summarizeLint(report: string): string {
  const trimmed = report.trim();
  if (trimmed.length === 0) return 'lint clean';
  const firstLine = trimmed
    .split('\n')
    .find(l => {
      const t = l.trim();
      return t.length > 0 && !t.startsWith('#');
    }) ?? '';
  if (firstLine.length === 0) return 'lint clean';
  return firstLine.slice(0, 160);
}

/** Get KB stats: page counts, last operations from log. */
export function getKBStats(): {
  entities: number;
  concepts: number;
  topics: number;
  comparisons: number;
  totalPages: number;
  recentLog: string[];
} {
  const entities = listVaultFiles('knowledge/wiki/entities').length;
  const concepts = listVaultFiles('knowledge/wiki/concepts').length;
  const topics = listVaultFiles('knowledge/wiki/topics').length;
  const comparisons = listVaultFiles('knowledge/wiki/comparisons').length;

  // Get last 10 log entries
  const logContent = readVaultFile('knowledge/log.md') || '';
  const logLines = logContent.split('\n').filter((l) => l.startsWith('['));
  const recentLog = logLines.slice(-10);

  return {
    entities,
    concepts,
    topics,
    comparisons,
    totalPages: entities + concepts + topics + comparisons,
    recentLog,
  };
}
