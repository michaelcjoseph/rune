/**
 * Work-run cockpit projection bridge (project 11, Phase 5).
 *
 * Reads the work-run store (`logs/work-runs/`) and maps recent runs into the
 * slug-keyed `WorkRunProjection` map that `buildCockpitView` projects onto each
 * project's card. This is the server-layer bridge between the jobs-layer store
 * and the intent-layer cockpit view — it imports both, so it is the single
 * place where the `WorkRunOutcome` mirror in `cockpit.ts` and `WorkOutcome` in
 * `work-run-classify.ts` are required to line up (a drift fails compilation
 * here, not silently at runtime).
 *
 * Sourcing per project (newest run wins — index rows are newest-first):
 *   - `outcome` / `reason` / `startedAt` from the per-run `summary.json`.
 *   - `lastOutput` from the tail of `transcript.jsonl` (readable display lines
 *     via the Phase 1 adapter), best-effort and capped.
 *   - `transcriptUrl` is `null` until the authenticated transcript route ships
 *     (the next Phase 5 task — see TODO below), so the card degrades gracefully
 *     rather than linking at a route that 404s.
 *
 * Best-effort by contract: any per-run read failure skips that run rather than
 * throwing, and the caller (`handleApiCockpit`) wraps the whole call so the
 * cockpit always renders even when the store is missing or corrupt.
 *
 * Cross-layer drift guard: this is the single bridge that sees both the
 * jobs-layer `WorkOutcome` and the intent-layer `WorkRunOutcome` mirror. The
 * `_AssertOutcomesEqual` type below turns any divergence between the two unions
 * into a hard compile error here (in BOTH directions), so the local-mirror
 * duplication in `cockpit.ts` can never silently fall out of sync.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readRecentIndex, type WorkRunSummary } from '../jobs/work-run-store.js';
import { parseStreamJsonLine, streamJsonToDisplay } from '../jobs/work-run-transcript.js';
import type { WorkOutcome } from '../jobs/work-run-classify.js';
import { VALID_SLUG } from '../intent/sandbox.js';
import type { WorkRunProjection, WorkRunOutcome } from '../intent/cockpit.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('work-run-projection');

// Compile-time drift guard (erased at runtime): fails to typecheck if
// `WorkOutcome` (jobs) and `WorkRunOutcome` (intent mirror) ever diverge in
// either direction. Keeps the deliberate local-mirror in cockpit.ts honest.
type _AssertOutcomesEqual =
  [WorkOutcome] extends [WorkRunOutcome]
    ? ([WorkRunOutcome] extends [WorkOutcome] ? true : never)
    : never;
const _outcomeDriftCheck: _AssertOutcomesEqual = true;
void _outcomeDriftCheck;

/** How many recent index rows to scan. Bounded so a long index doesn't make
 *  the cockpit poll read unboundedly; newest-first, one projection per slug. */
const DEFAULT_RECENT_RUNS = 20;
/** Last-N readable output lines retained on the projection. */
const LAST_OUTPUT_LINES = 5;
/** Cap on transcript bytes scanned for the tail, so a large transcript can't
 *  make a cockpit poll read a huge file. The tail lives at the end, so we read
 *  the whole file only when it is under this cap; larger files read the final
 *  slice. */
const TRANSCRIPT_TAIL_MAX_BYTES = 256 * 1024;

/** Read the last N readable display lines from a run's transcript.jsonl.
 *  Best-effort — returns `[]` on any read/parse failure. */
function readTranscriptTail(transcriptPath: string, n: number): string[] {
  let raw: string;
  try {
    raw = readFileSync(transcriptPath, 'utf8');
  } catch {
    return [];
  }
  // Only scan the final slice of a large transcript — the tail is what we want.
  if (raw.length > TRANSCRIPT_TAIL_MAX_BYTES) {
    raw = raw.slice(-TRANSCRIPT_TAIL_MAX_BYTES);
  }
  const display: string[] = [];
  for (const line of raw.split('\n')) {
    const envelope = parseStreamJsonLine(line);
    if (!envelope) continue;
    const text = streamJsonToDisplay(envelope);
    if (text) display.push(...text.split('\n'));
  }
  return display.slice(-n);
}

/**
 * Build the slug-keyed work-run projection map from the store.
 *
 * @param dir       The work-runs root (`config.WORK_RUNS_DIR`).
 * @param indexFile The rolling index file (`config.WORK_RUNS_INDEX_FILE`).
 */
export function readWorkRunProjections(
  dir: string,
  indexFile: string,
  recent = DEFAULT_RECENT_RUNS,
): Record<string, WorkRunProjection> {
  const out: Record<string, WorkRunProjection> = {};
  // readRecentIndex is torn-line-tolerant and returns [] on a missing file.
  const rows = readRecentIndex(indexFile, recent);
  for (const row of rows) {
    // `row.id` becomes a directory name in join() below. readRecentIndex's
    // shape guard only checks `typeof id === 'string'`, so a poisoned/torn
    // index row could carry a traversal id (`../escape`). Validate against the
    // project-wide slug guard before any fs join — same boundary as
    // createTranscriptSink (work-run-transcript.ts) and gcWorkRuns.
    if (!VALID_SLUG.test(row.id)) {
      log.warn('readWorkRunProjections: skipping row with non-slug id', { id: row.id });
      continue;
    }
    // Per-run summary.json carries reason / startedAt / project; fall back to
    // the index row's fields when it can't be read.
    let summary: WorkRunSummary | null = null;
    try {
      summary = JSON.parse(readFileSync(join(dir, row.id, 'summary.json'), 'utf8')) as WorkRunSummary;
    } catch {
      // No summary (or corrupt) — fall back to the index row below.
    }
    const slug = summary?.project ?? row.project;
    if (!slug) continue;
    // Newest run per project wins — rows are newest-first, so skip if seen.
    if (out[slug]) continue;
    // readTranscriptTail absorbs ENOENT/read errors → [], so no existsSync
    // pre-check is needed (and avoiding it sidesteps a benign TOCTOU if GC
    // deletes the file between a check and the read).
    const transcriptPath = join(dir, row.id, 'transcript.jsonl');
    out[slug] = {
      mutationId: row.id,
      outcome: summary?.outcome ?? row.outcome ?? null,
      reason: summary?.reason ?? null,
      lastOutput: readTranscriptTail(transcriptPath, LAST_OUTPUT_LINES),
      // `startedAt` is typed `string` on both summary and index row, but the
      // index shape guard doesn't enforce it — fall back to '' so a torn row
      // can't surface `undefined` (which would render as "NaN ago" on the card).
      startedAt: summary?.startedAt ?? row.startedAt ?? '',
      // TODO(phase-5 route task): point at `/api/work-runs/${row.id}/transcript`
      // once that authenticated route ships. Until then leave null so the card
      // never links at a route that 404s.
      transcriptUrl: null,
    };
  }
  if (rows.length > 0) {
    log.debug('readWorkRunProjections', { runs: rows.length, projected: Object.keys(out).length });
  }
  return out;
}
