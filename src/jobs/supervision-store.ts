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

import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { SupervisedRun, SupervisedRunStatus } from '../intent/supervision.js';
import { createLogger } from '../utils/logger.js';

const VALID_STATUSES: ReadonlySet<SupervisedRunStatus> = new Set<SupervisedRunStatus>([
  'running',
  'blocked-on-human',
  'completed',
  'failed',
  'unknown',
]);

const log = createLogger('supervision-store');

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
    if (isSupervisedRun(entry)) valid.push(entry); else dropped++;
  }
  if (dropped > 0) {
    log.warn('readAllRuns: dropped malformed entries', { path: filePath, dropped });
  }
  return valid;
}

function isSupervisedRun(value: unknown): value is SupervisedRun {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v['id'] === 'string' &&
    typeof v['product'] === 'string' &&
    typeof v['project'] === 'string' &&
    typeof v['status'] === 'string' &&
    VALID_STATUSES.has(v['status'] as SupervisedRunStatus) &&
    typeof v['startedAt'] === 'string' &&
    typeof v['lastHeartbeatAt'] === 'string'
  );
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

/**
 * Write every run to `filePath`, atomically via temp-then-rename so a
 * crashed write leaves the previous file intact. The temp file is a sibling
 * of the target — same directory, so `renameSync` is an atomic intra-FS
 * operation. Overwrites any existing file. I/O failures are logged at
 * error level and re-thrown so the caller sees them — matches the
 * `mutations-log.ts` pattern.
 */
export function writeAllRuns(runs: SupervisedRun[], filePath: string): void {
  // PID-tagged temp name avoids collisions with other Rune processes only;
  // intra-process safety is guaranteed by Node's single-threaded event loop.
  const tmp = join(dirname(filePath), `.${basename(filePath)}.${process.pid}.tmp`);
  try {
    writeFileSync(tmp, JSON.stringify(runs, null, 2), 'utf8');
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
 * persisted field the rebuild doesn't know about. The supervision fields are
 * all monotonic-forward (status advances, timestamps advance, the nudge marker
 * is set once and never cleared), so a forward-merge is the correct semantic —
 * no field in this store is ever legitimately cleared by an upsert.
 *
 * `buildSupervisedRun` omits absent optional fields entirely (it never writes
 * `key: undefined`), so the spread preserves the stored value rather than
 * overwriting it with `undefined`.
 *
 * Implication: a caller that ever needs to CLEAR a field (set it back to
 * `undefined`/absent) cannot do so through `upsertRun` — the merge would
 * preserve the stored value. Such a caller must use `writeAllRuns` directly.
 * No field in this store needs that today.
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
 * Remove the run with the given id, if present. A missing id or a missing
 * file is a no-op — callers triggering cleanup don't have to pre-check.
 */
export function removeRun(id: string, filePath: string): void {
  const existing = readAllRuns(filePath);
  const next = existing.filter((r) => r.id !== id);
  if (next.length === existing.length) return;
  writeAllRuns(next, filePath);
}
