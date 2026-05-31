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
 * SCAFFOLD: signatures/types settled here for the Phase 2 test suite to pin
 * test-first; bodies unimplemented until the Phase 2 implementation task.
 */

import type { WorkOutcome, WorkProductFacts, ExitFacts } from './work-run-classify.js';

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

function notImplemented(fn: string): never {
  throw new Error(`work-run-store: ${fn} not implemented (project 11 Phase 2 pending)`);
}

/**
 * Write `summary.json` into the per-run directory atomically (temp-then-rename
 * in the same directory, so the rename is an atomic intra-FS op and a crash
 * mid-write never leaves a torn `summary.json`).
 *
 * `dir` MUST be a trusted, caller-constructed path (e.g. `join(LOGS_DIR,
 * 'work-runs', runId)` where `runId` is VALID_SLUG-validated, mirroring
 * `createTranscriptSink`). The implementation should assert
 * `VALID_SLUG.test(basename(dir))` before writing so a future caller cannot
 * pass a user-influenced path.
 */
export function writeSummary(_dir: string, _summary: WorkRunSummary): void {
  notImplemented('writeSummary');
}

/** Append one row to `index.jsonl` (one JSON object per line). */
export function appendIndexRow(_filePath: string, _row: WorkRunIndexRow): void {
  notImplemented('appendIndexRow');
}

/**
 * Read the most recent `n` rows from `index.jsonl`, newest first. A torn /
 * malformed trailing line is skipped, never thrown — a crash mid-append must
 * not poison the reader.
 */
export function readRecentIndex(_filePath: string, _n: number): WorkRunIndexRow[] {
  notImplemented('readRecentIndex');
}
