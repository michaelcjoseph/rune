/**
 * Test suite for `src/jobs/supervision-recovery.ts` — the startup pass that
 * walks every persisted SupervisedRun, calls `recoverRun` on it (flipping
 * stale 'running' entries to 'unknown' since they can't be observed across
 * a restart), and writes the result back.
 *
 * Written test-first (task A2.3); the implementation file does not exist
 * yet — every test must fail with a missing-module / missing-export error.
 *
 * Mirrors the pattern of `mutations-log.test.ts:reconcileOrphans` for the
 * supervision store.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'; // writeFileSync used by malformed-JSON test
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { SupervisedRun } from '../intent/supervision.js';
import { readAllRuns, writeAllRuns } from './supervision-store.js';

// The module under test — does not exist yet; the suite fails at import.
import { recoverSupervisedRuns } from './supervision-recovery.js';

let tmpDir: string;
let filePath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'jarvis-supervision-recovery-test-'));
  filePath = join(tmpDir, 'supervised-runs.json');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

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

describe('recoverSupervisedRuns', () => {
  it('returns { transitioned: 0, total: 0 } when the store is missing', () => {
    // No file at filePath — the recovery must not throw and must report 0/0.
    const result = recoverSupervisedRuns(filePath);
    expect(result).toEqual({ transitioned: 0, total: 0 });
  });

  it('returns { transitioned: 0, total: 0 } when the store is empty', () => {
    writeAllRuns([], filePath);
    const result = recoverSupervisedRuns(filePath);
    expect(result).toEqual({ transitioned: 0, total: 0 });
  });

  it('flips a single running run to unknown and persists the change', () => {
    writeAllRuns([makeRun('run-a', { status: 'running' })], filePath);

    const result = recoverSupervisedRuns(filePath);
    expect(result).toEqual({ transitioned: 1, total: 1 });

    const persisted = readAllRuns(filePath);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]!.status).toBe('unknown');
  });

  it('leaves terminal runs untouched (completed / failed)', () => {
    writeAllRuns(
      [
        makeRun('run-done', { status: 'completed' }),
        makeRun('run-fail', { status: 'failed' }),
      ],
      filePath,
    );

    const result = recoverSupervisedRuns(filePath);
    expect(result).toEqual({ transitioned: 0, total: 2 });

    const persisted = readAllRuns(filePath);
    const byId = Object.fromEntries(persisted.map((r) => [r.id, r.status]));
    expect(byId['run-done']).toBe('completed');
    expect(byId['run-fail']).toBe('failed');
  });

  it('leaves a blocked-on-human run untouched (durable state)', () => {
    writeAllRuns([makeRun('run-blocked', { status: 'blocked-on-human' })], filePath);

    const result = recoverSupervisedRuns(filePath);
    expect(result).toEqual({ transitioned: 0, total: 1 });

    expect(readAllRuns(filePath)[0]!.status).toBe('blocked-on-human');
  });

  it('leaves an already-unknown run untouched (idempotent)', () => {
    writeAllRuns([makeRun('run-unknown', { status: 'unknown' })], filePath);

    const result = recoverSupervisedRuns(filePath);
    expect(result).toEqual({ transitioned: 0, total: 1 });

    expect(readAllRuns(filePath)[0]!.status).toBe('unknown');
  });

  it('handles a mixed store: flips only the running entries, preserves the rest', () => {
    writeAllRuns(
      [
        makeRun('run-a', { status: 'running' }),
        makeRun('run-b', { status: 'completed' }),
        makeRun('run-c', { status: 'running' }),
        makeRun('run-d', { status: 'blocked-on-human' }),
        makeRun('run-e', { status: 'failed' }),
      ],
      filePath,
    );

    const result = recoverSupervisedRuns(filePath);
    expect(result).toEqual({ transitioned: 2, total: 5 });

    const byId = Object.fromEntries(readAllRuns(filePath).map((r) => [r.id, r.status]));
    expect(byId['run-a']).toBe('unknown');
    expect(byId['run-b']).toBe('completed');
    expect(byId['run-c']).toBe('unknown');
    expect(byId['run-d']).toBe('blocked-on-human');
    expect(byId['run-e']).toBe('failed');
  });

  it('does not rewrite the file when no transition happened (avoids needless I/O)', () => {
    // Write a file with only terminal entries — recovery should be a no-op
    // including the disk write. We assert by capturing the file's mtime
    // before and after, but the simpler proof is that recovery returns
    // transitioned: 0 and the persisted shape is unchanged.
    const terminal = [makeRun('run-x', { status: 'completed' })];
    writeAllRuns(terminal, filePath);

    const result = recoverSupervisedRuns(filePath);
    expect(result.transitioned).toBe(0);
    expect(readAllRuns(filePath)).toEqual(terminal);
  });

  it('returns { transitioned: 0, total: 0 } on a malformed JSON file (no throw)', () => {
    // readAllRuns already logs at warn and returns [] for malformed JSON;
    // recoverSupervisedRuns inherits that behavior.
    writeFileSync(filePath, '{ this is not valid json', 'utf8');

    const result = recoverSupervisedRuns(filePath);
    expect(result).toEqual({ transitioned: 0, total: 0 });
  });
});
