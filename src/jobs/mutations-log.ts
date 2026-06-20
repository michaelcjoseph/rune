import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import config from '../config.js';
import { createLogger } from '../utils/logger.js';
import type { MutationDescriptor } from '../transport/mutations.js';
import type { WorkOutcome, WorkProductFacts } from './work-run-classify.js';

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

/** Read latest-state orchestrated-work descriptors whose newest persisted line
 *  is still `running`. Startup recovery owns deciding whether each is resumable
 *  or should be terminalized; the generic orphan reconciler intentionally skips
 *  this kind. */
export function readRunningOrchestratedMutations(): MutationDescriptor[] {
  const latest = new Map<string, MutationDescriptor>();
  try {
    const raw = readFileSync(logPath(), 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as MutationDescriptor;
        latest.set(entry.id, entry);
      } catch {
        log.warn('mutations.jsonl: skipped malformed line');
      }
    }
  } catch {
    return [];
  }

  return [...latest.values()].filter(
    (d) => d.kind === 'orchestrated-work' && d.status === 'running',
  );
}

interface TerminalSummary {
  id: string;
  outcome: WorkOutcome;
  reason?: string;
  workProduct?: WorkProductFacts;
}

function terminalStatusForOutcome(outcome: WorkOutcome): 'completed' | 'failed' {
  return outcome === 'failed' ? 'failed' : 'completed';
}

function readTerminalSummary(id: string): TerminalSummary | null {
  if (typeof config.WORK_RUNS_DIR !== 'string' || config.WORK_RUNS_DIR.trim() === '') {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(config.WORK_RUNS_DIR, id, 'summary.json'), 'utf8'));
  } catch {
    return null;
  }

  const summary = parsed as Partial<TerminalSummary>;
  if (summary.id !== id || typeof summary.outcome !== 'string') {
    log.warn('mutations.jsonl: skipped terminal summary with unexpected shape', { id });
    return null;
  }
  return summary as TerminalSummary;
}

function terminalizeFromSummary(
  entry: MutationDescriptor,
  summary: TerminalSummary,
): MutationDescriptor {
  const status = terminalStatusForOutcome(summary.outcome);
  const { error: _error, ...base } = entry;
  return {
    ...base,
    status,
    ...(status === 'failed' ? { error: summary.reason ?? '' } : {}),
    outcome: summary.outcome,
    ...(summary.workProduct ? { workProduct: summary.workProduct } : {}),
  };
}

/** On startup, flip non-resumable descriptors still in 'running' status to 'failed' with reason 'orphaned'.
 *  These represent mutations that were interrupted by a server restart mid-run. */
export function reconcileOrphans(): void {
  let raw: string;
  try {
    raw = readFileSync(logPath(), 'utf8');
  } catch {
    return; // File doesn't exist yet — nothing to reconcile
  }

  const lines = raw.split('\n');
  const latestLineById = new Map<string, number>();
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line?.trim()) continue;
    try {
      const entry = JSON.parse(line) as MutationDescriptor;
      latestLineById.set(entry.id, i);
    } catch {
      // Malformed lines are preserved unchanged below and cannot be reconciled.
    }
  }

  let changed = false;
  const updated = lines.map((line, index) => {
    if (!line.trim()) return line;
    try {
      const entry = JSON.parse(line) as MutationDescriptor;
      const isLatestState = latestLineById.get(entry.id) === index;
      if (isLatestState && entry.status === 'running') {
        if (entry.kind === 'orchestrated-work') {
          const summary = readTerminalSummary(entry.id);
          if (summary) {
            changed = true;
            return JSON.stringify(terminalizeFromSummary(entry, summary) satisfies MutationDescriptor);
          }
          return line;
        }
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
