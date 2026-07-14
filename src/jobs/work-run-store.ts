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
import { dirname, join } from 'node:path';
import { createLogger } from '../utils/logger.js';
import { VALID_SLUG } from '../intent/sandbox.js';
import type { WorkOutcome, WorkProductFacts, ExitFacts } from './work-run-classify.js';
// `PHASE_ORDER` is a runtime value, `FinalizerPhase` a type — both from the
// finalizer, which does NOT import this module, so there is no cycle. Deriving
// `KNOWN_PHASES` from `PHASE_ORDER` keeps the two in lockstep (a phase added to
// the finalizer can't silently fall out of the store's validation).
import { PHASE_ORDER, type FinalizerPhase } from './work-run-finalizer.js';
import { readJsonlTail } from './jsonl-tail.js';
import type { WorkRunTarget } from '../intent/run-target.js';

const log = createLogger('work-run-store');

/** Contents of `logs/work-runs/<id>/summary.json` — the run's outcome facts
 *  (spec requirement 9) plus paths to the transcript and forensics. */
export interface WorkRunSummary {
  id: string;
  project: string;
  product: string;
  /** User-facing target identity; absent on legacy summaries. */
  target?: WorkRunTarget;
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
  /** Gated-merge disposition (Phase 3.5) — present once the finalizer has
   *  resolved a branch-complete run: `merged` true when the run landed on the
   *  base branch, `branchDeleted` true when the work branch was then removed.
   *  Absent on the pre-merge summary write and on every non-branch-complete
   *  run. */
  merged?: boolean;
  branchDeleted?: boolean;
  /** The base branch a branch-complete run targets (e.g. `main`) — stamped so a
   *  cockpit/restart reader renders the right "merged to <base>" wording for a
   *  non-`main` product. */
  baseBranch?: string;
  /** Why a branch-complete run was HELD off the base branch (the gate's typed
   *  refusal reason) — persisted so the hold reason survives a restart and
   *  reaches the cockpit, not just the live Telegram notification. */
  gateHeldReason?: string;
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

export type WorkRunSummaryReadResult =
  | { status: 'found'; summary: WorkRunSummary }
  | { status: 'missing' }
  | { status: 'invalid' };

/**
 * Read a single run's `summary.json` while preserving the security-relevant
 * distinction between missing evidence and invalid/unreadable evidence.
 *
 * `id` MUST be slug-validated by the caller (VALID_SLUG) before this is called —
 * it is joined into the path verbatim, mirroring `writeSummary`'s contract. The
 * caller (the authenticated `GET /api/work-runs/:id` route) is the boundary.
 */
export function readWorkRunSummaryResult(dir: string, id: string): WorkRunSummaryReadResult {
  // Defense-in-depth: `id` is joined into the path, so reject a non-slug id here
  // too — every call site gets the same hard boundary even if it forgot to
  // guard (mirrors createTranscriptSink's VALID_SLUG check).
  if (!VALID_SLUG.test(id)) return { status: 'invalid' };
  let raw: string;
  try {
    raw = readFileSync(join(dir, id, 'summary.json'), 'utf8');
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? { status: 'missing' }
      : { status: 'invalid' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: 'invalid' };
  }
  // Lightweight shape guard (mirrors readRecentIndex) — a well-formed-JSON file
  // that isn't a summary is dropped, not returned as a bogus WorkRunSummary.
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    log.warn('readWorkRunSummary: summary.json has unexpected shape', { id });
    return { status: 'invalid' };
  }
  const s = parsed as Partial<WorkRunSummary>;
  const rawTarget = (parsed as Record<string, unknown>)['target'];
  const targetValid = rawTarget === undefined || (
    rawTarget !== null &&
    typeof rawTarget === 'object' &&
    !Array.isArray(rawTarget) &&
    (((rawTarget as Record<string, unknown>)['kind'] === 'project') ||
      ((rawTarget as Record<string, unknown>)['kind'] === 'bug')) &&
    typeof (rawTarget as Record<string, unknown>)['slug'] === 'string' &&
    ((rawTarget as Record<string, unknown>)['slug'] as string).trim() !== ''
  );
  if (
    s.id === id &&
    typeof s.product === 'string' &&
    s.product.trim() !== '' &&
    typeof s.outcome === 'string' &&
    targetValid
  ) {
    return { status: 'found', summary: s as WorkRunSummary };
  }
  log.warn('readWorkRunSummary: summary.json has unexpected shape', { id });
  return { status: 'invalid' };
}

/** Compatibility reader for non-authorization surfaces. */
export function readWorkRunSummary(dir: string, id: string): WorkRunSummary | null {
  const result = readWorkRunSummaryResult(dir, id);
  return result.status === 'found' ? result.summary : null;
}

/** Append one row to `index.jsonl` (one JSON object per line). Creates the
 *  containing dir if absent — `appendFileSync` does not, and the work-runs dir
 *  may not exist on the very first run. */
export function appendIndexRow(filePath: string, row: WorkRunIndexRow): void {
  mkdirSync(dirname(filePath), { recursive: true });
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

/** Fixed-byte variant for model-facing diagnostics; newest first. */
export function readRecentIndexBounded(
  filePath: string,
  n: number,
  maxBytes = 1024 * 1024,
): WorkRunIndexRow[] {
  if (n <= 0) return [];
  return readJsonlTail(filePath, maxBytes, n * 4)
    .filter((entry): entry is WorkRunIndexRow => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
      const row = entry as Partial<WorkRunIndexRow>;
      return typeof row.id === 'string' && VALID_SLUG.test(row.id) && typeof row.outcome === 'string';
    })
    .slice(-n)
    .reverse();
}

// ---------------------------------------------------------------------------
// Durable per-run finalize-phase store (project 15, Phase 3.5).
//
// The gated-merge finalizer records its resume checkpoint after EACH mutating
// step into `logs/work-runs/<id>/phase`; `recovery-finalize-runner` reads the
// last recorded phase to resume a run that crashed mid-gated-merge at the RIGHT
// step (skipping an already-committed merge/push) instead of re-merging or
// orphaning. One file, last-write-wins — only the latest phase matters for
// resume. Best-effort: a write failure logs and is swallowed (a phase-store
// hiccup must never deny the terminal event, the same contract summary/index
// hold). `recordWorkRunPhase`/`readLastWorkRunPhase` take the PARENT
// `work-runs` dir + a VALID_SLUG run id (mirrors `readWorkRunSummary`).
// ---------------------------------------------------------------------------

const PHASE_FILE = 'phase';

/** The valid `FinalizerPhase` strings (derived from the finalizer's
 *  `PHASE_ORDER` so the two never drift) — a read of an unknown/corrupt value
 *  returns null (treat as "no resumable phase", i.e. re-drive from the top)
 *  rather than handing back an off-contract phase. */
const KNOWN_PHASES: ReadonlySet<string> = new Set<FinalizerPhase>(PHASE_ORDER);

/**
 * Record the latest finalize phase for `id` (overwrites — last-write-wins).
 * Atomic temp-then-rename so a crash never leaves a torn phase file. Best-effort
 * (logs + swallows on failure): the durable phase is an optimization for
 * crash-resume, never a gate on terminalization. `baseDir` is the parent
 * `work-runs` dir; `id` MUST be VALID_SLUG (joined into the path verbatim).
 */
export function recordWorkRunPhase(baseDir: string, id: string, phase: FinalizerPhase): void {
  if (!VALID_SLUG.test(id)) {
    log.warn('recordWorkRunPhase: invalid run id (no-op)', { id });
    return;
  }
  const dir = join(baseDir, id);
  const target = join(dir, PHASE_FILE);
  const tmp = join(dir, `.${PHASE_FILE}.${process.pid}.tmp`);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(tmp, phase, 'utf8');
    renameSync(tmp, target);
  } catch (err) {
    log.warn('recordWorkRunPhase: failed to persist phase (best-effort)', {
      id,
      phase,
      error: (err as Error).message,
    });
  }
}

/**
 * Read the last durable finalize phase for `id`, or `null` when absent/corrupt/
 * off-contract (recovery then re-drives from the top). `id` MUST be VALID_SLUG.
 */
export function readLastWorkRunPhase(baseDir: string, id: string): FinalizerPhase | null {
  if (!VALID_SLUG.test(id)) return null;
  let raw: string;
  try {
    raw = readFileSync(join(baseDir, id, PHASE_FILE), 'utf8');
  } catch {
    return null; // no prior phase recorded
  }
  const phase = raw.trim();
  return KNOWN_PHASES.has(phase) ? (phase as FinalizerPhase) : null;
}
