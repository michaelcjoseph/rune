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
