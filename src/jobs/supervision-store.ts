/**
 * Persistent store for the `SupervisedRun[]` state managed by
 * `src/intent/supervision.ts`. Holds **current state per run**, not an
 * append-only event history — replacing entries by id rather than appending.
 *
 * Pairs with `mutations-log.ts` (which IS append-only events): mutations.jsonl
 * records every state transition for audit; supervised-runs.json records the
 * latest known state for visibility queries.
 *
 * Atomic writes via temp-then-rename so a crashed write leaves the previous
 * known-good state intact rather than a half-written file. Concurrent
 * read-modify-write callers in the same process are bounded by Node's
 * single-threaded event loop within each call; this module is not safe
 * against cross-process races, which the v1 trust model excludes (one
 * Rune process per machine).
 *
 * See spec.md §"Layer 3", tasks.md Phase 6 A2.1.
 */

import { readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { SupervisedRun, SupervisedRunStatus } from '../intent/supervision.js';
import { createLogger } from '../utils/logger.js';
import { VALID_SLUG } from '../intent/sandbox.js';

const VALID_STATUSES: ReadonlySet<SupervisedRunStatus> = new Set<SupervisedRunStatus>([
  'running',
  'blocked-on-human',
  'completed',
  'failed',
  'unknown',
]);

const log = createLogger('supervision-store');
const SUPERVISION_VISIBILITY_MAX_BYTES = 768 * 1024;

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * Read every persisted supervised run from `filePath`. Returns `[]` for a
 * missing file, an empty file, malformed JSON, or a JSON value that isn't an
 * array — never throws on a startup-recovery path. A malformed file is
 * logged at warn level so the operator knows the previous state was
 * unreadable; the recovery path can then choose to start fresh.
 */
export function readAllRuns(filePath: string): SupervisedRun[] {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch {
    return [];
  }
  if (!raw.trim()) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    log.warn('readAllRuns: malformed JSON; returning []', {
      path: filePath,
      error: (err as Error).message,
    });
    return [];
  }

  if (!Array.isArray(parsed)) {
    log.warn('readAllRuns: root value is not an array; returning []', { path: filePath });
    return [];
  }

  // Defense in depth — drop entries that don't have the required fields a
  // SupervisedRun must carry. A corrupt entry would otherwise reach the
  // visibility surface as a typed-but-broken record. (Only Rune writes
  // this file in practice, so corrupt rows are unexpected; logging at warn
  // lets the operator see if drift ever happens.)
  const valid: SupervisedRun[] = [];
  let dropped = 0;
  for (const entry of parsed) {
    const run = normalizeSupervisedRun(entry);
    if (run) valid.push(run); else dropped++;
  }
  if (dropped > 0) {
    log.warn('readAllRuns: dropped malformed entries', { path: filePath, dropped });
  }
  return valid;
}

export interface BoundedSupervisionRead {
  runs: SupervisedRun[];
  /** False means ownership evidence could not be read in full. */
  complete: boolean;
}

/** Byte-bounded complete snapshot for model-facing diagnostic authorization. */
export function readAllRunsBounded(
  filePath: string,
  maxBytes = 1024 * 1024,
): BoundedSupervisionRead {
  if (!Number.isInteger(maxBytes) || maxBytes < 1) return { runs: [], complete: false };
  try {
    if (statSync(filePath).size > maxBytes) return { runs: [], complete: false };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? { runs: [], complete: true }
      : { runs: [], complete: false };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return { runs: [], complete: false };
  }
  if (!Array.isArray(parsed)) return { runs: [], complete: false };
  let complete = true;
  const runs = parsed.flatMap(entry => {
    const run = normalizeSupervisedRun(entry);
    if (!run) complete = false;
    return run ? [run] : [];
  });
  return { runs, complete };
}

function normalizeParkedQuestion(value: unknown): SupervisedRun['parkedQuestion'] | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const question = value as Record<string, unknown>;
  if (question['source'] !== 'ask-user-question' ||
      typeof question['question'] !== 'string' ||
      typeof question['askedAt'] !== 'string' ||
      !Array.isArray(question['options'])) return undefined;
  const options = question['options'].flatMap(raw => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
    const option = raw as Record<string, unknown>;
    if (typeof option['id'] !== 'string' || typeof option['label'] !== 'string' || typeof option['value'] !== 'string') {
      return [];
    }
    return [{
      id: option['id'],
      label: option['label'],
      value: option['value'],
      ...(typeof option['description'] === 'string' ? { description: option['description'] } : {}),
    }];
  });
  if (options.length !== question['options'].length) return undefined;
  return {
    source: 'ask-user-question',
    question: question['question'],
    options,
    ...(typeof question['toolUseId'] === 'string' ? { toolUseId: question['toolUseId'] } : {}),
    askedAt: question['askedAt'],
  };
}

function normalizeSupervisedRun(value: unknown): SupervisedRun | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (!(
    typeof v['id'] === 'string' && VALID_SLUG.test(v['id']) &&
    typeof v['product'] === 'string' &&
    typeof v['project'] === 'string' &&
    typeof v['status'] === 'string' &&
    VALID_STATUSES.has(v['status'] as SupervisedRunStatus) &&
    typeof v['startedAt'] === 'string' &&
    typeof v['lastHeartbeatAt'] === 'string'
  )) return null;
  const run = { ...v } as unknown as SupervisedRun;
  if (
    v['maxRuntimeEpochAt'] !== undefined &&
    typeof v['maxRuntimeEpochAt'] !== 'string'
  ) {
    delete run.maxRuntimeEpochAt;
  }
  if (v['target'] !== undefined) {
    const target = v['target'];
    if (
      target && typeof target === 'object' && !Array.isArray(target) &&
      ((target as Record<string, unknown>)['kind'] === 'project' || (target as Record<string, unknown>)['kind'] === 'bug') &&
      typeof (target as Record<string, unknown>)['slug'] === 'string'
    ) {
      run.target = target as SupervisedRun['target'];
    } else {
      delete run.target;
    }
  }
  if (v['parkedQuestion'] !== undefined) {
    const parkedQuestion = normalizeParkedQuestion(v['parkedQuestion']);
    if (parkedQuestion) run.parkedQuestion = parkedQuestion;
    else delete run.parkedQuestion;
  }
  return run;
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

/**
 * Bound the current-state visibility store without ever dropping an active or
 * parked run. Terminal history is already durable in work-run summaries and
 * mutations.jsonl, so retain the newest terminal rows that fit and discard the
 * oldest. Surviving rows preserve their original order.
 */
export function compactSupervisedRuns(
  runs: SupervisedRun[],
  maxBytes = SUPERVISION_VISIBILITY_MAX_BYTES,
): SupervisedRun[] {
  if (!Number.isInteger(maxBytes) || maxBytes < 1) return runs;
  const serializedBytes = (values: SupervisedRun[]) =>
    Buffer.byteLength(JSON.stringify(values, null, 2), 'utf8');
  if (serializedBytes(runs) <= maxBytes) return runs;

  const retained = new Set(runs.filter(run =>
    run.status === 'running' || run.status === 'blocked-on-human'));
  // In a pretty-printed JSON array every row is its pretty JSON with two
  // leading spaces per line, plus exactly two separator/newline bytes. The
  // empty array contributes the initial two bracket bytes. Computing this once
  // per row avoids repeatedly serializing the growing retained set.
  const rowCost = (run: SupervisedRun): number => {
    const indented = JSON.stringify(run, null, 2)
      .split('\n')
      .map(line => `  ${line}`)
      .join('\n');
    return Buffer.byteLength(indented, 'utf8') + 2;
  };
  let retainedBytes = 2;
  for (const run of retained) retainedBytes += rowCost(run);
  const terminalsNewestFirst = runs
    .filter(run => !retained.has(run))
    .sort((a, b) => {
      const aTime = Date.parse(a.lastHeartbeatAt || a.startedAt);
      const bTime = Date.parse(b.lastHeartbeatAt || b.startedAt);
      return (Number.isNaN(bTime) ? 0 : bTime) - (Number.isNaN(aTime) ? 0 : aTime);
    });

  for (const terminal of terminalsNewestFirst) {
    const cost = rowCost(terminal);
    if (retainedBytes + cost > maxBytes) continue;
    retained.add(terminal);
    retainedBytes += cost;
  }
  return runs.filter(run => retained.has(run));
}

/**
 * Write every run to `filePath`, atomically via temp-then-rename so a
 * crashed write leaves the previous file intact. The temp file is a sibling
 * of the target — same directory, so `renameSync` is an atomic intra-FS
 * operation. Overwrites any existing file. I/O failures are logged at
 * error level and re-thrown so the caller sees them — matches the
 * `mutations-log.ts` pattern.
 */
export function writeAllRuns(runs: SupervisedRun[], filePath: string): void {
  const compacted = compactSupervisedRuns(runs);
  // PID-tagged temp name avoids collisions with other Rune processes only;
  // intra-process safety is guaranteed by Node's single-threaded event loop.
  const tmp = join(dirname(filePath), `.${basename(filePath)}.${process.pid}.tmp`);
  try {
    writeFileSync(tmp, JSON.stringify(compacted, null, 2), 'utf8');
    renameSync(tmp, filePath);
  } catch (err) {
    log.error('writeAllRuns: failed to persist runs', {
      path: filePath,
      error: (err as Error).message,
    });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Upsert / Remove
// ---------------------------------------------------------------------------

/**
 * Insert or FIELD-MERGE `run` by `run.id`. On an existing id the merge is
 * `{ ...current, ...run }`: fields present on the incoming `run` win, and any
 * field the incoming `run` omits is preserved from the stored record. The entry
 * stays at its original index (no reordering) so the cockpit / Telegram surfaces
 * don't shuffle on every heartbeat update. A missing file is treated as empty.
 *
 * Why merge, not replace (project 15, P0.1): the keep-alive heartbeat rebuilds a
 * `SupervisedRun` via `buildSupervisedRun` (mutations.ts), which only carries
 * the lifecycle fields — never `quietNudgedAt`. A replace-by-id would clobber
 * that once-only quiet-nudge marker on every 30s heartbeat, so the quiet nudge
 * re-fired forever (the d0679453 incident, defect 3). Merging preserves any
 * persisted field the rebuild doesn't know about. Most supervision fields are
 * monotonic-forward, so a forward-merge is the correct default semantic.
 *
 * `buildSupervisedRun` omits absent optional fields entirely (it never writes
 * `key: undefined`), so the spread preserves the stored value rather than
 * overwriting it with `undefined`.
 *
 * A caller that needs to CLEAR a field cannot do so through `upsertRun`.
 * `recordRunActivity` owns the deliberate exception: verified output clears
 * `quietNudgedAt` so a later quiet period can begin a new watchdog cycle.
 */
export function upsertRun(run: SupervisedRun, filePath: string): void {
  const existing = readAllRuns(filePath);
  const idx = existing.findIndex((r) => r.id === run.id);
  const next = idx === -1
    ? [...existing, run]
    : existing.map((r, i) => (i === idx ? { ...r, ...run } : r));
  writeAllRuns(next, filePath);
}

/**
 * Persist verified run activity as one read-modify-write transaction.
 *
 * Unlike {@link upsertRun}, this operation intentionally clears
 * `quietNudgedAt`: output after a quiet nudge proves that specific quiet cycle
 * ended, so a later genuinely quiet period can start a fresh nudge/cancel
 * cycle. A superseded max-runtime request may additionally renew the watchdog
 * epoch used by the hard-ceiling predicate.
 */
export function recordRunActivity(
  run: SupervisedRun,
  filePath: string,
  options: { renewMaxRuntimeEpoch?: boolean } = {},
): void {
  const existing = readAllRuns(filePath);
  const idx = existing.findIndex((r) => r.id === run.id);
  const current = idx === -1 ? undefined : existing[idx];
  const updated = { ...(current ?? {}), ...run } as SupervisedRun;
  delete updated.quietNudgedAt;
  if (options.renewMaxRuntimeEpoch === true) {
    updated.maxRuntimeEpochAt = run.lastOutputAt ?? run.lastHeartbeatAt;
  }
  const next = idx === -1
    ? [...existing, updated]
    : existing.map((r, i) => (i === idx ? updated : r));
  writeAllRuns(next, filePath);
}

/**
 * Remove the run with the given id, if present. A missing id or a missing
 * file is a no-op — callers triggering cleanup don't have to pre-check.
 */
export function removeRun(id: string, filePath: string): void {
  const existing = readAllRuns(filePath);
  const next = existing.filter((r) => r.id !== id);
  if (next.length === existing.length) return;
  writeAllRuns(next, filePath);
}
