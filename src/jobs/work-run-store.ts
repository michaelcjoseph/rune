/**
 * Work-run persistence (project 11, Phase 2 — run store).
 *
 * Two durable artifacts beyond the transcript:
 *   - `summary.json` per run (outcome facts), written temp-then-rename so a
 *     crash never leaves a half-written file (mirrors `writeAllRuns` in
 *     supervision-store.ts).
 *   - `index.jsonl`, the rolling recent-runs index; readers tolerate a torn
 *     trailing line (the skip-malformed pattern from `readRecentMutations`).
 *
 * Implemented; the remaining Phase 2 work is the caller wiring (work-runner
 * writes summary.json + the index row before the terminal event).
 */

import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createLogger } from '../utils/logger.js';
import type { WorkOutcome, WorkProductFacts, ExitFacts } from './work-run-classify.js';

const log = createLogger('work-run-store');

/** Contents of `logs/work-runs/<id>/summary.json` — the run's outcome facts
 *  (spec requirement 9) plus paths to the transcript and forensics. */
export interface WorkRunSummary {
  id: string;
  project: string;
  product: string;
  outcome: WorkOutcome;
  reason: string;
  exit: ExitFacts;
  workProduct: WorkProductFacts;
  baseSha: string;
  branch: string;
  startedAt: string;
  endedAt: string;
  transcriptPath: string;
  forensicsPath: string;
}

/** One row in `logs/work-runs/index.jsonl` — the rolling recent-runs index. */
export interface WorkRunIndexRow {
  id: string;
  project: string;
  outcome: WorkOutcome;
  durationMs: number;
  startedAt: string;
  endedAt: string;
}

/**
 * Write `summary.json` into the per-run directory atomically (temp-then-rename
 * in the same directory, so the rename is an atomic intra-FS op and a crash
 * mid-write never leaves a torn `summary.json`).
 *
 * `dir` MUST be a trusted, caller-constructed path (e.g. `join(LOGS_DIR,
 * 'work-runs', runId)` where `runId` is VALID_SLUG-validated by the caller,
 * mirroring `createTranscriptSink`). The slug guard lives at the caller's
 * boundary, not here — this function joins `dir` verbatim. The caller is also
 * responsible for redacting `summary` content (diffstat / reason — see
 * `scrubPathsInText` in finalizeWorkRun) before persisting; this module stays
 * config-free and writes what it's given.
 *
 * Concurrency: safe for synchronous sequential callers (Node's single-threaded
 * event loop). The pid-based tmp name is NOT unique across two interleaved
 * async writes to the same `dir` in one process — same-dir serialization is the
 * caller's responsibility (mirrors supervision-store).
 */
export function writeSummary(dir: string, summary: WorkRunSummary): void {
  const target = join(dir, 'summary.json');
  const tmp = join(dir, `.summary.json.${process.pid}.tmp`);
  try {
    // Ensure the per-run dir exists — `createTranscriptSink` normally creates
    // it, but a sink-creation failure (or summary-only callers) must not leave
    // summary.json silently unwritten. Mirrors the sink's own `mkdirSync`.
    mkdirSync(dir, { recursive: true });
    writeFileSync(tmp, JSON.stringify(summary, null, 2), 'utf8');
    renameSync(tmp, target);
  } catch (err) {
    log.error('writeSummary: failed to persist summary.json', {
      dir,
      error: (err as Error).message,
    });
    throw err;
  }
}

/** Append one row to `index.jsonl` (one JSON object per line). */
export function appendIndexRow(filePath: string, row: WorkRunIndexRow): void {
  appendFileSync(filePath, JSON.stringify(row) + '\n', 'utf8');
}

/**
 * Read the most recent `n` rows from `index.jsonl`, newest first. A torn /
 * malformed line is skipped (never thrown — a crash mid-append must not poison
 * the reader); a missing file yields `[]`.
 */
export function readRecentIndex(filePath: string, n: number): WorkRunIndexRow[] {
  if (n <= 0) return []; // `slice(-0)` would otherwise return the whole array
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch {
    return []; // file doesn't exist yet
  }
  const rows: WorkRunIndexRow[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      log.warn('index.jsonl: skipped malformed line');
      continue;
    }
    // Lightweight shape guard (mirrors supervision-store's isSupervisedRun) —
    // a well-formed-JSON line that isn't an index row is dropped, not trusted.
    const row = entry as Partial<WorkRunIndexRow>;
    if (typeof row.id === 'string' && typeof row.outcome === 'string') {
      rows.push(row as WorkRunIndexRow);
    } else {
      log.warn('index.jsonl: skipped row with unexpected shape');
    }
  }
  // Newest-first, capped at n.
  return rows.slice(-n).reverse();
}
