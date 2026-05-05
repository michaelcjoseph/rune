import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import config from '../config.js';
import { createLogger } from '../utils/logger.js';
import type { MutationDescriptor } from '../transport/mutations.js';

const log = createLogger('mutations-log');

function logPath(): string {
  return join(config.LOGS_DIR, 'mutations.jsonl');
}

export function appendMutationLine(descriptor: MutationDescriptor): void {
  try {
    appendFileSync(logPath(), JSON.stringify(descriptor) + '\n', 'utf8');
  } catch (err) {
    log.error('Failed to append to mutations.jsonl', { error: (err as Error).message });
  }
}

/** Read the last n terminal (completed/failed/rejected) entries from mutations.jsonl,
 *  newest first. Malformed lines are skipped with a warning. */
export function readRecentMutations(n: number): MutationDescriptor[] {
  const all: MutationDescriptor[] = [];
  try {
    const raw = readFileSync(logPath(), 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as MutationDescriptor;
        all.push(entry);
      } catch {
        log.warn('mutations.jsonl: skipped malformed line');
      }
    }
  } catch {
    // File may not exist yet
  }
  const terminal = all.filter(d => d.status === 'completed' || d.status === 'failed' || d.status === 'rejected');
  return terminal.slice(-n).reverse();
}

/** On startup, flip any descriptors still in 'running' status to 'failed' with reason 'orphaned'.
 *  These represent mutations that were interrupted by a server restart mid-run. */
export function reconcileOrphans(): void {
  let raw: string;
  try {
    raw = readFileSync(logPath(), 'utf8');
  } catch {
    return; // File doesn't exist yet — nothing to reconcile
  }

  const lines = raw.split('\n');
  let changed = false;
  const updated = lines.map(line => {
    if (!line.trim()) return line;
    try {
      const entry = JSON.parse(line) as MutationDescriptor;
      if (entry.status === 'running') {
        changed = true;
        return JSON.stringify({ ...entry, status: 'failed', error: 'orphaned' } satisfies MutationDescriptor);
      }
      return line;
    } catch {
      return line; // preserve malformed lines unchanged
    }
  });

  if (changed) {
    try {
      writeFileSync(logPath(), updated.join('\n'), 'utf8');
      log.info('reconcileOrphans: flipped stale running mutations to failed');
    } catch (err) {
      log.error('reconcileOrphans: failed to rewrite mutations.jsonl', { error: (err as Error).message });
    }
  }
}
