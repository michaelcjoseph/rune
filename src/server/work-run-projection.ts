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
 *   - `transcriptUrl` points at the authenticated `GET /api/work-runs/:id/
 *     transcript` route when a transcript file exists, and is `null` otherwise
 *     so the card degrades gracefully rather than linking at a route that 404s.
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

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readRecentIndex, readWorkRunSummary } from '../jobs/work-run-store.js';
import { parseStreamJsonLine, streamJsonToDisplay } from '../jobs/work-run-transcript.js';
import type { WorkOutcome } from '../jobs/work-run-classify.js';
import { VALID_SLUG } from '../intent/sandbox.js';
import type { WorkRunProjection, WorkRunOutcome } from '../intent/cockpit.js';
import type { SupervisedRun } from '../intent/supervision.js';
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
 * Build one `WorkRunProjection` for a run id. Shared by the terminal-index and
 * the active-run paths — both resolve `outcome`/`reason`/`startedAt` from their
 * own source, then need the identical transcript-presence formula:
 *
 * One `existsSync` drives `transcriptUrl` (the card links only when a transcript
 * is present, degrading to null otherwise). `readTranscriptTail` separately
 * absorbs ENOENT → [], so a GC delete racing between this check and the read is
 * benign (URL set, tail empty — the route would then 404).
 */
function buildProjection(
  dir: string,
  id: string,
  outcome: WorkRunOutcome | null,
  reason: string | null,
  startedAt: string,
): WorkRunProjection {
  const transcriptPath = join(dir, id, 'transcript.jsonl');
  const hasTranscript = existsSync(transcriptPath);
  return {
    mutationId: id,
    outcome,
    reason,
    lastOutput: hasTranscript ? readTranscriptTail(transcriptPath, LAST_OUTPUT_LINES) : [],
    startedAt,
    transcriptUrl: hasTranscript ? `/api/work-runs/${id}/transcript` : null,
  };
}

/**
 * Build the slug-keyed work-run projection map from the store.
 *
 * @param dir        The work-runs root (`config.WORK_RUNS_DIR`).
 * @param indexFile  The rolling index file (`config.WORK_RUNS_INDEX_FILE`).
 * @param recent     How many recent terminal index rows to scan.
 * @param activeRuns In-flight runs from the supervision store (the caller passes
 *   the `running`/`blocked-on-human` subset). Per spec req 15 the index row and
 *   `summary.json` are written only at termination, so a live run has no index
 *   row — without this, the card stays blank for the whole run (Gap #2,
 *   phase-6-diagnosis.md). These are layered over the terminal rows below so a
 *   live run renders last-N output + elapsed (spec req 24).
 */
export function readWorkRunProjections(
  dir: string,
  indexFile: string,
  recent = DEFAULT_RECENT_RUNS,
  activeRuns: readonly SupervisedRun[] = [],
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
    // the index row's fields when it's missing/corrupt. Go through the guarded
    // reader (shape + slug guard) rather than a bare cast.
    const summary = readWorkRunSummary(dir, row.id);
    const slug = summary?.project ?? row.project;
    if (!slug) continue;
    // Newest run per project wins — rows are newest-first, so skip if seen.
    if (out[slug]) continue;
    // `startedAt` is typed `string` on both summary and index row, but the index
    // shape guard doesn't enforce it — fall back to '' so a torn row can't
    // surface `undefined` (which would render as "NaN ago" on the card).
    out[slug] = buildProjection(
      dir,
      row.id,
      summary?.outcome ?? row.outcome ?? null,
      summary?.reason ?? null,
      summary?.startedAt ?? row.startedAt ?? '',
    );
  }
  // Layer in-flight runs over the terminal index rows. An active run has no
  // index row / summary.json yet (written only at termination, spec req 15), so
  // its live data comes from the transcript.jsonl tail the sink writes from run
  // start. The per-product concurrency cap (config.WORK_RUN_PER_PROJECT_CAP)
  // makes an active run the newest activity for its slug, so it wins over an
  // older terminal row — but a terminal row for a strictly-newer run still wins
  // (defensive against a future cap relaxation; recency rule below).
  for (const run of activeRuns) {
    // `run.id` becomes a directory name in join() below — same boundary guard as
    // the index-row path. A non-slug id is dropped rather than projected.
    if (!VALID_SLUG.test(run.id)) {
      log.warn('readWorkRunProjections: skipping active run with non-slug id', { id: run.id });
      continue;
    }
    // `slug` is only a map key (never an fs path), but guard it too so a corrupt
    // store entry can't pollute the cockpit view with a non-slug key — mirrors
    // the run.id boundary above.
    const slug = run.project;
    if (!slug || !VALID_SLUG.test(slug)) continue;
    // Recency: keep an existing terminal projection only when it has a valid,
    // strictly-later startedAt. An unparseable/empty active startedAt loses to a
    // valid existing one; otherwise the live run wins (visibility-favouring
    // default, sound under the per-product cap that makes it the newest run).
    const existing = out[slug];
    if (existing) {
      const existingTs = Date.parse(existing.startedAt);
      const activeTs = Date.parse(run.startedAt);
      if (!Number.isNaN(existingTs) && (Number.isNaN(activeTs) || existingTs > activeTs)) continue;
    }
    // In-flight → no terminal verdict yet (outcome/reason null).
    out[slug] = buildProjection(dir, run.id, null, null, run.startedAt ?? '');
  }
  if (rows.length > 0 || activeRuns.length > 0) {
    log.debug('readWorkRunProjections', {
      runs: rows.length,
      active: activeRuns.length,
      projected: Object.keys(out).length,
    });
  }
  return out;
}
