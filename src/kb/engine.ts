import { ingestSource } from './ingest.js';
import { queryKB } from './query.js';
import { lintKB } from './lint.js';
import { getQueue, dequeue } from './queue.js';
import { readVaultFile, listVaultFiles } from '../vault/files.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('kb-engine');

export { ingestSource, queryKB, lintKB };

/**
 * Process all sources in the ingestion queue.
 * Called during nightly processing.
 */
export async function processIngestionQueue(): Promise<{ processed: number; errors: number }> {
  const queue = getQueue();
  if (queue.length === 0) {
    log.info('Ingestion queue is empty');
    return { processed: 0, errors: 0 };
  }

  log.info(`Processing ${queue.length} queued source(s)`);
  let processed = 0;
  let errors = 0;

  for (const entry of queue) {
    const result = await ingestSource(entry.source, { guidance: entry.guidance });
    if (result.success) {
      processed++;
    } else {
      errors++;
      log.error('Failed to ingest queued source', { source: entry.source, error: result.output });
    }
  }

  log.info('Ingestion queue processed', { processed, errors });
  return { processed, errors };
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
