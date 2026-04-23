import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import config from '../config.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('kb-queue');

export interface QueueEntry {
  source: string; // relative path in vault
  addedAt: string; // ISO timestamp
  guidance?: string; // optional user guidance for ingestion
  /** Priority tier derived from the source path. Higher runs earlier in
   *  processIngestionQueue. Absent on legacy entries — treated as 0. */
  priority?: number;
}

/** Derive the ingestion priority for a source path. Higher = earlier in the
 *  queue. The tiers below reflect the Karpathy-style corpus hierarchy from
 *  the 03-resolver spec: first-person sources (world-view, journals) come
 *  before curated tactical content, which comes before active projects,
 *  which comes before third-party inputs. */
export function getPriority(sourcePath: string): number {
  if (sourcePath.startsWith('world-view/')) return 100;
  if (sourcePath.startsWith('journals/')) return 100;
  if (sourcePath === 'pages/playbook.md') return 80;
  if (sourcePath.startsWith('projects/') && !sourcePath.startsWith('projects/archive/')) return 60;
  if (sourcePath.startsWith('Readwise/')) return 40;
  if (sourcePath.includes('conversation')) return 20;
  return 0;
}

function readQueue(): QueueEntry[] {
  try {
    const data = readFileSync(config.INGESTION_QUEUE_FILE, 'utf8');
    return JSON.parse(data) as QueueEntry[];
  } catch {
    return [];
  }
}

function writeQueue(entries: QueueEntry[]): void {
  mkdirSync(dirname(config.INGESTION_QUEUE_FILE), { recursive: true });
  writeFileSync(config.INGESTION_QUEUE_FILE, JSON.stringify(entries, null, 2));
}

/** Add a source to the ingestion queue. */
export function enqueue(source: string, guidance?: string): void {
  const entries = readQueue();
  // Don't add duplicates
  if (entries.some((e) => e.source === source)) {
    log.info('Source already in queue, skipping', { source });
    return;
  }
  const priority = getPriority(source);
  entries.push({ source, addedAt: new Date().toISOString(), guidance, priority });
  writeQueue(entries);
  log.info('Added to ingestion queue', { source, priority });
}

/** Get all queued sources. */
export function getQueue(): QueueEntry[] {
  return readQueue();
}

/** Remove a source from the queue (after successful ingestion). */
export function dequeue(source: string): void {
  const entries = readQueue().filter((e) => e.source !== source);
  writeQueue(entries);
}

/** Clear the entire queue. */
export function clearQueue(): void {
  writeQueue([]);
}
