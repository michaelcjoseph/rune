/**
 * Tests for src/jobs/supervision-store.ts — task A2.1.
 *
 * The module does not exist yet. Every test in this file must fail with a
 * missing-module / missing-export error (the right kind of red).
 */

import { chmodSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { SupervisedRun } from '../intent/supervision.js';
import { isQuietRun, planQuietNudges } from '../intent/supervision.js';
import {
  readAllRuns,
  writeAllRuns,
  upsertRun,
  removeRun,
} from './supervision-store.js';

// ---------------------------------------------------------------------------
// Fixture helper
// ---------------------------------------------------------------------------

function makeRun(id: string, overrides: Partial<SupervisedRun> = {}): SupervisedRun {
  return {
    id,
    product: 'aura',
    project: '01-test',
    status: 'running',
    startedAt: '2026-01-01T00:00:00.000Z',
    lastHeartbeatAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Per-test temp directory
// ---------------------------------------------------------------------------

let tmpDir: string;
let filePath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'supervision-store-test-'));
  filePath = join(tmpDir, 'supervised-runs.json');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// readAllRuns
// ---------------------------------------------------------------------------

describe('readAllRuns', () => {
  it('returns [] when the file does not exist', () => {
    const result = readAllRuns(filePath);
    expect(result).toEqual([]);
  });

  it('returns [] for an empty file', () => {
    writeFileSync(filePath, '', 'utf8');
    const result = readAllRuns(filePath);
    expect(result).toEqual([]);
  });

  it('returns [] for malformed JSON without throwing', () => {
    writeFileSync(filePath, '{ this is not valid json }}', 'utf8');
    expect(() => readAllRuns(filePath)).not.toThrow();
    expect(readAllRuns(filePath)).toEqual([]);
  });

  it('returns the single run from a valid file', () => {
    const run = makeRun('run-1');
    writeFileSync(filePath, JSON.stringify([run]), 'utf8');
    const result = readAllRuns(filePath);
    expect(result).toEqual([run]);
  });

  it('returns multiple runs in file order', () => {
    const runs = [makeRun('run-1'), makeRun('run-2'), makeRun('run-3')];
    writeFileSync(filePath, JSON.stringify(runs), 'utf8');
    const result = readAllRuns(filePath);
    expect(result).toEqual(runs);
    expect(result.map((r) => r.id)).toEqual(['run-1', 'run-2', 'run-3']);
  });

  it('returns [] when the JSON root value is a plain object (not an array)', () => {
    writeFileSync(filePath, JSON.stringify({ id: 'run-1' }), 'utf8');
    expect(readAllRuns(filePath)).toEqual([]);
  });

  it('returns [] when the JSON root value is null', () => {
    writeFileSync(filePath, 'null', 'utf8');
    expect(readAllRuns(filePath)).toEqual([]);
  });

  it('returns [] when the JSON root value is a scalar number', () => {
    writeFileSync(filePath, '42', 'utf8');
    expect(readAllRuns(filePath)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// writeAllRuns
// ---------------------------------------------------------------------------

describe('writeAllRuns', () => {
  it('writes the full array and readAllRuns returns the same shape', () => {
    const runs = [makeRun('run-a'), makeRun('run-b')];
    writeAllRuns(runs, filePath);
    expect(readAllRuns(filePath)).toEqual(runs);
  });

  it('overwrites an existing file (does not append)', () => {
    const first = [makeRun('run-old')];
    const second = [makeRun('run-new-1'), makeRun('run-new-2')];
    writeAllRuns(first, filePath);
    writeAllRuns(second, filePath);
    const result = readAllRuns(filePath);
    expect(result).toEqual(second);
    expect(result.find((r) => r.id === 'run-old')).toBeUndefined();
  });

  it('writing [] is valid and results in an empty array on re-read', () => {
    const runs = [makeRun('run-1')];
    writeAllRuns(runs, filePath);
    writeAllRuns([], filePath);
    expect(readAllRuns(filePath)).toEqual([]);
  });

  it('the on-disk file is valid JSON after a write', () => {
    const runs = [makeRun('run-1')];
    writeAllRuns(runs, filePath);
    const raw = readFileSync(filePath, 'utf8');
    expect(() => JSON.parse(raw)).not.toThrow();
    expect(JSON.parse(raw)).toEqual(runs);
  });

  it('throws a meaningful error when the target directory is read-only', () => {
    // Make tmpDir read-only so writeFileSync of the temp file fails. The
    // error must propagate to the caller (after being logged) rather than
    // silently swallow — A2.2's mutation-event hook needs to know if
    // persistence failed.
    chmodSync(tmpDir, 0o555);
    try {
      expect(() => writeAllRuns([makeRun('run-x')], filePath)).toThrow();
    } finally {
      // Restore write permission so afterEach cleanup works.
      chmodSync(tmpDir, 0o755);
    }
  });
});

// ---------------------------------------------------------------------------
// readAllRuns — defense in depth: corrupt entries
// ---------------------------------------------------------------------------

describe('readAllRuns — corrupt entries', () => {
  it('drops entries missing required fields and returns the valid rest', () => {
    // Mix one valid SupervisedRun with two malformed entries. The two
    // malformed ones must be dropped silently (after a warn log) rather
    // than reach the visibility surface as broken records.
    const valid = makeRun('run-good');
    const malformed = [
      valid,
      { id: 'run-half', product: 'aura' }, // missing project/status/timestamps
      { not_a_run: true }, // entirely wrong shape
    ];
    writeFileSync(filePath, JSON.stringify(malformed), 'utf8');
    const result = readAllRuns(filePath);
    expect(result).toEqual([valid]);
  });

  it('drops entries whose status is not in the SupervisedRunStatus union', () => {
    // status: 'garbage' would pass typeof === 'string' but isn't a real
    // SupervisedRunStatus value — the visibility surface would silently
    // mis-classify a 'garbage' run if the entry reached it.
    const valid = makeRun('run-good');
    const badStatus = { ...makeRun('run-bad'), status: 'garbage' };
    writeFileSync(filePath, JSON.stringify([valid, badStatus]), 'utf8');
    expect(readAllRuns(filePath)).toEqual([valid]);
  });
});

// ---------------------------------------------------------------------------
// upsertRun
// ---------------------------------------------------------------------------

describe('upsertRun', () => {
  it('inserts a new run when the id is not present', () => {
    const run = makeRun('run-new');
    upsertRun(run, filePath);
    expect(readAllRuns(filePath)).toEqual([run]);
  });

  it('replaces an existing run when the id is already present', () => {
    const original = makeRun('run-1', { status: 'running' });
    const updated = makeRun('run-1', { status: 'completed' });
    writeAllRuns([original], filePath);
    upsertRun(updated, filePath);
    const result = readAllRuns(filePath);
    expect(result).toHaveLength(1);
    expect(result[0]!.status).toBe('completed');
  });

  it('preserves order — a replaced entry stays at its original index', () => {
    const runA = makeRun('run-a');
    const runB = makeRun('run-b');
    const runC = makeRun('run-c');
    writeAllRuns([runA, runB, runC], filePath);
    const updatedB = makeRun('run-b', { status: 'failed' });
    upsertRun(updatedB, filePath);
    const result = readAllRuns(filePath);
    expect(result.map((r) => r.id)).toEqual(['run-a', 'run-b', 'run-c']);
    expect(result[1]!.status).toBe('failed');
  });

  it('works on a missing file (treated as empty — just inserts)', () => {
    const run = makeRun('run-first');
    expect(() => upsertRun(run, filePath)).not.toThrow();
    expect(readAllRuns(filePath)).toEqual([run]);
  });
});

// ---------------------------------------------------------------------------
// removeRun
// ---------------------------------------------------------------------------

describe('readAllRuns / writeAllRuns — lastChildAliveAt back-compat', () => {
  // Why: lastChildAliveAt is a new optional field on SupervisedRun (separate
  // process-liveness signal). On-disk entries from before this field existed
  // must still read back as valid SupervisedRuns — otherwise every legacy
  // entry gets dropped at startup and the visibility surface goes blank.

  it('round-trips a run that has lastChildAliveAt set', () => {
    const run: SupervisedRun = {
      ...makeRun('run-with-alive'),
      lastChildAliveAt: '2026-02-01T00:00:30.000Z',
    };
    writeAllRuns([run], filePath);
    expect(readAllRuns(filePath)).toEqual([run]);
  });

  it('reads a legacy on-disk entry (no lastChildAliveAt) as a valid SupervisedRun', () => {
    // Simulate a file written by the pre-fix code — only the original five
    // fields, no lastChildAliveAt. The type guard must accept it (the field
    // is optional, not required) and the round-trip must not synthesize a
    // bogus value.
    const legacyOnDisk = {
      id: 'run-legacy',
      product: 'jarvis',
      project: '10-jarvis-identity-refactor',
      status: 'failed',
      startedAt: '2026-05-27T20:12:05.818Z',
      lastHeartbeatAt: '2026-05-27T20:17:48.203Z',
    };
    writeFileSync(filePath, JSON.stringify([legacyOnDisk]), 'utf8');
    const result = readAllRuns(filePath);
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe('run-legacy');
    expect(result[0]!.lastChildAliveAt).toBeUndefined();
  });

  it('upsertRun preserves lastChildAliveAt when present', () => {
    const original: SupervisedRun = {
      ...makeRun('run-1'),
      lastChildAliveAt: '2026-02-01T00:00:30.000Z',
    };
    writeAllRuns([original], filePath);
    const updated: SupervisedRun = {
      ...original,
      status: 'completed',
      lastChildAliveAt: '2026-02-01T00:01:00.000Z',
    };
    upsertRun(updated, filePath);
    const result = readAllRuns(filePath);
    expect(result).toEqual([updated]);
    expect(result[0]!.lastChildAliveAt).toBe('2026-02-01T00:01:00.000Z');
  });
});

describe('removeRun', () => {
  it('removes the run with the given id', () => {
    const runA = makeRun('run-a');
    const runB = makeRun('run-b');
    writeAllRuns([runA, runB], filePath);
    removeRun('run-a', filePath);
    const result = readAllRuns(filePath);
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe('run-b');
  });

  it('missing id is a no-op (does not throw, file unchanged)', () => {
    const runs = [makeRun('run-a')];
    writeAllRuns(runs, filePath);
    expect(() => removeRun('run-does-not-exist', filePath)).not.toThrow();
    expect(readAllRuns(filePath)).toEqual(runs);
  });

  it('removing from a missing file is a no-op (does not throw)', () => {
    expect(() => removeRun('run-a', filePath)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Phase 4: lastOutputAt / quietNudgedAt round-trip (project 11, test-plan §4)
// ---------------------------------------------------------------------------

describe('quiet-run fields round-trip through the store', () => {
  it('preserves lastOutputAt and quietNudgedAt across write + read (isSupervisedRun must not drop them)', () => {
    const runs = [
      makeRun('run-quiet', {
        lastOutputAt: '2026-01-01T00:03:00.000Z',
        quietNudgedAt: '2026-01-01T00:08:00.000Z',
      }),
    ];
    writeAllRuns(runs, filePath);
    const read = readAllRuns(filePath);
    expect(read).toHaveLength(1);
    expect(read[0]!.lastOutputAt).toBe('2026-01-01T00:03:00.000Z');
    expect(read[0]!.quietNudgedAt).toBe('2026-01-01T00:08:00.000Z');
  });

  it('a run without the optional quiet fields still validates and round-trips', () => {
    const runs = [makeRun('run-plain')];
    writeAllRuns(runs, filePath);
    const read = readAllRuns(filePath);
    expect(read).toHaveLength(1);
    expect(read[0]!.lastOutputAt).toBeUndefined();
    expect(read[0]!.quietNudgedAt).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Project 15 — P0.1: supervision-store metadata survival across heartbeats
// (test-plan.md §1). WRITE-FIRST: these must fail red against the current
// replace-by-id `upsertRun` and go green once it field-merges.
//
// The incident (defect 3): a keep-alive heartbeat rebuilds the SupervisedRun
// via `buildSupervisedRun` (mutations.ts), which never carries `quietNudgedAt`.
// Because `upsertRun` REPLACES the record by id rather than merging, every
// heartbeat clears the once-only quiet marker, so the quiet nudge re-fires
// every tick (~once per 30s) for the life of the run.
// ---------------------------------------------------------------------------

/**
 * Mimic exactly what `buildSupervisedRun` produces for a keep-alive heartbeat
 * upsert (mutations.ts:305-321): base fields + a fresh `lastChildAliveAt`, the
 * prior `lastOutputAt` threaded back through (keep-alive does NOT advance
 * output), and — critically — NO `quietNudgedAt`. This is the rebuild that the
 * current replace-by-id `upsertRun` uses to clobber the persisted marker.
 *
 * `lastOutputAt` is optional and, when omitted, the field is left OFF the
 * object — faithful to mutations.ts:60-62, where `buildSupervisedRun` only sets
 * `lastOutputAt` when the threaded value is `!== undefined`. A run that has
 * produced zero output events (the most common quiet-run shape) therefore
 * yields a keep-alive rebuild with no `lastOutputAt` at all.
 */
function rebuiltKeepAlive(id: string, nowMs: number, lastOutputAt?: string): SupervisedRun {
  const iso = new Date(nowMs).toISOString();
  const run: SupervisedRun = {
    id,
    product: 'aura',
    project: '01-test',
    status: 'running',
    startedAt: '2026-01-01T00:00:00.000Z',
    lastHeartbeatAt: iso,
    lastChildAliveAt: iso,
  };
  // Unchanged — a keep-alive tick is not LLM output, so the run stays quiet.
  if (lastOutputAt !== undefined) run.lastOutputAt = lastOutputAt;
  return run;
}

describe('upsertRun — field-merge across heartbeats (P0.1)', () => {
  const QUIET_MS = 5 * 60_000; // matches stall-check QUIET_THRESHOLD_MS
  const TICK_MS = 30_000;
  const START = Date.parse('2026-01-01T00:00:00.000Z');

  it('field-merges by id: an upsert that omits a persisted field preserves it', () => {
    // Seed a record carrying every optional field plus a forward-compatible
    // "unknown" field the rebuild doesn't know about.
    const seeded = {
      ...makeRun('run-merge', {
        lastChildAliveAt: '2026-01-01T00:05:00.000Z',
        lastOutputAt: '2026-01-01T00:04:00.000Z',
        quietNudgedAt: '2026-01-01T00:08:00.000Z',
      }),
      futureField: 'keep-me',
    } as SupervisedRun & { futureField: string };
    writeAllRuns([seeded], filePath);

    // A keep-alive rebuild that carries fresh liveness but NOT quietNudgedAt
    // and NOT futureField — replace-by-id drops them; field-merge keeps them.
    const rebuilt: SupervisedRun = {
      id: 'run-merge',
      product: 'aura',
      project: '01-test',
      status: 'running',
      startedAt: '2026-01-01T00:00:00.000Z',
      lastHeartbeatAt: '2026-01-01T00:09:00.000Z',
      lastChildAliveAt: '2026-01-01T00:09:00.000Z',
      lastOutputAt: '2026-01-01T00:04:00.000Z',
    };
    upsertRun(rebuilt, filePath);

    const result = readAllRuns(filePath);
    expect(result).toHaveLength(1);
    // Incoming fields win where present.
    expect(result[0]!.lastHeartbeatAt).toBe('2026-01-01T00:09:00.000Z');
    expect(result[0]!.lastChildAliveAt).toBe('2026-01-01T00:09:00.000Z');
    // Persisted-but-omitted fields survive the merge.
    expect(result[0]!.quietNudgedAt).toBe('2026-01-01T00:08:00.000Z');
    expect((result[0] as { futureField?: string }).futureField).toBe('keep-me');
  });

  it('a once-stamped quietNudgedAt survives a keep-alive rebuild so the nudge does not re-fire', () => {
    const run = makeRun('run-quiet', { lastOutputAt: '2026-01-01T00:00:00.000Z' });
    writeAllRuns([run], filePath);

    // Tick 1, past the quiet threshold: it's quiet → plan + persist the stamp.
    const t1 = START + QUIET_MS + TICK_MS;
    const plan1 = planQuietNudges(readAllRuns(filePath), QUIET_MS, t1);
    expect(plan1.toNudge).toHaveLength(1);
    upsertRun(plan1.updated[0]!, filePath);
    expect(readAllRuns(filePath)[0]!.quietNudgedAt).toBeTruthy();

    // Keep-alive heartbeat rebuild — the defect-3 clobber path.
    const tHeartbeat = t1 + 1_000;
    upsertRun(rebuiltKeepAlive('run-quiet', tHeartbeat, '2026-01-01T00:00:00.000Z'), filePath);

    // The persisted marker must survive so isQuietRun stays false.
    const after = readAllRuns(filePath)[0]!;
    expect(after.quietNudgedAt).toBeTruthy();
    expect(isQuietRun(after, QUIET_MS, tHeartbeat + 60_000)).toBe(false);

    // Tick 2, still quiet: no second nudge.
    const plan2 = planQuietNudges(readAllRuns(filePath), QUIET_MS, tHeartbeat + 60_000);
    expect(plan2.toNudge).toHaveLength(0);
  });

  it('a 30s heartbeat loop over a long quiet run produces exactly one quiet nudge', () => {
    writeAllRuns([makeRun('run-quiet', { lastOutputAt: '2026-01-01T00:00:00.000Z' })], filePath);

    let nudges = 0;
    // 40 ticks = 20 simulated minutes, well past the 5-minute quiet threshold.
    for (let i = 1; i <= 40; i++) {
      const now = START + i * TICK_MS;
      const plan = planQuietNudges(readAllRuns(filePath), QUIET_MS, now);
      for (const updated of plan.updated) {
        nudges++;
        upsertRun(updated, filePath);
      }
      // Each tick also fires a keep-alive heartbeat rebuild (the clobber path).
      upsertRun(rebuiltKeepAlive('run-quiet', now, '2026-01-01T00:00:00.000Z'), filePath);
    }

    expect(nudges).toBe(1);
  });

  it('a zero-output run (keep-alive rebuild omits lastOutputAt) still nudges exactly once', () => {
    // The more common quiet-run shape: no output events yet, so the keep-alive
    // rebuild carries no `lastOutputAt` (mutations.ts:60-62 guard). isQuietRun
    // then measures quiet from `startedAt`. The clobber must still be prevented.
    writeAllRuns([makeRun('run-silent')], filePath); // no lastOutputAt seeded

    let nudges = 0;
    for (let i = 1; i <= 40; i++) {
      const now = START + i * TICK_MS;
      const plan = planQuietNudges(readAllRuns(filePath), QUIET_MS, now);
      for (const updated of plan.updated) {
        nudges++;
        upsertRun(updated, filePath);
      }
      // Rebuild WITHOUT lastOutputAt — the zero-output shape.
      upsertRun(rebuiltKeepAlive('run-silent', now), filePath);
    }

    expect(nudges).toBe(1);
  });
});
