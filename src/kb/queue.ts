import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import config from '../config.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('kb-queue');

interface QueueEntry {
  source: string; // relative path in vault
  addedAt: string; // ISO timestamp
  guidance?: string; // optional user guidance for ingestion
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
  entries.push({ source, addedAt: new Date().toISOString(), guidance });
  writeQueue(entries);
  log.info('Added to ingestion queue', { source });
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
