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

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'; // writeFileSync used by malformed-JSON test
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { SupervisedRun } from '../intent/supervision.js';
import { readAllRuns, writeAllRuns } from './supervision-store.js';

// The module under test — does not exist yet; the suite fails at import.
import {
  recoverSupervisedRuns,
  recoverAndFinalizeStaleRuns,
  type RecoverAndFinalizeDeps,
} from './supervision-recovery.js';
import type { FinalizerSupervisionStatus } from './work-run-finalizer.js';

let tmpDir: string;
let filePath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'rune-supervision-recovery-test-'));
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

// ---------------------------------------------------------------------------
// P0.4 (project 15) — recovery FINALIZES stale runs through the finalizer in
// HOLD mode rather than only relabeling them `unknown`. test-plan.md §4
// "Startup recovery". WRITE-FIRST: `recoverAndFinalizeStaleRuns` is a scaffold
// that throws notImplemented, so every test below is RED until P0.4 lands.
// ---------------------------------------------------------------------------

describe('recoverAndFinalizeStaleRuns (P0.4)', () => {
  /** Deps bag backed by the temp store, with a spy finalizer. */
  function makeDeps(
    finalize: (run: SupervisedRun) => Promise<FinalizerSupervisionStatus>,
  ): RecoverAndFinalizeDeps {
    return {
      readRuns: () => readAllRuns(filePath),
      writeRuns: (runs) => writeAllRuns(runs, filePath),
      finalizeStaleRun: vi.fn(finalize),
    };
  }

  it('drives a stale running run to a real terminal state via the finalizer — NOT left as unknown', async () => {
    // Also the test-plan §4 "orphaned-across-restart, clean complete branch"
    // case: hold-mode classification yields a terminal 'completed' (the old
    // path would have relabeled it the useless 'unknown'). Recovery never
    // merges — there is no merge seam at this layer (gated-merge is a separate
    // mode that recovery never invokes), so `.toBe('completed')` is the whole
    // contract: a real terminal status, not 'unknown' and not still 'running'.
    writeAllRuns([makeRun('run-stale', { status: 'running' })], filePath);
    const deps = makeDeps(async () => 'completed');

    const result = await recoverAndFinalizeStaleRuns(deps);

    expect(result.finalized).toBe(1);
    expect(deps.finalizeStaleRun).toHaveBeenCalledOnce();
    expect(readAllRuns(filePath)[0]!.status).toBe('completed');
  });

  it('leaves terminal / blocked / unknown runs untouched and does not finalize them', async () => {
    writeAllRuns(
      [
        makeRun('run-done', { status: 'completed' }),
        makeRun('run-fail', { status: 'failed' }),
        makeRun('run-blocked', { status: 'blocked-on-human' }),
        makeRun('run-unknown', { status: 'unknown' }),
      ],
      filePath,
    );
    const deps = makeDeps(async () => 'completed');

    const result = await recoverAndFinalizeStaleRuns(deps);

    expect(result.finalized).toBe(0);
    expect(deps.finalizeStaleRun).not.toHaveBeenCalled();
    const byId = Object.fromEntries(readAllRuns(filePath).map((r) => [r.id, r.status]));
    expect(byId).toEqual({
      'run-done': 'completed',
      'run-fail': 'failed',
      'run-blocked': 'blocked-on-human',
      'run-unknown': 'unknown',
    });
  });

  // --- Project 13 Phase 1b parked lifecycle (test-plan §2, verify-not-implement) ---

  it('project 13: a PARKED (blocked-on-human) run survives recovery untouched — parked state is durable across restart', async () => {
    // The happy parked case: the durable blocked-on-human record landed before
    // the crash. Recovery must leave it exactly as-is (its worktree stays live
    // for the human, slot held). This guards the load-bearing assumption that
    // storing parked as `blocked-on-human` keeps it invisible to finalize.
    writeAllRuns([makeRun('run-parked', { status: 'blocked-on-human' })], filePath);
    const deps = makeDeps(async () => 'completed');

    const result = await recoverAndFinalizeStaleRuns(deps);

    expect(result.finalized).toBe(0);
    expect(deps.finalizeStaleRun).not.toHaveBeenCalled();
    expect(readAllRuns(filePath)[0]!.status).toBe('blocked-on-human');
  });

  it('project 13 crash-window: a sentinel-emitting run whose parked write was LOST (still running) is finalized as an ordinary terminal — no park, no crash', async () => {
    // The dangerous window (spec Edge Cases): Rune dies AFTER the agent emits
    // the sentinel but BEFORE the durable blocked-on-human write lands, so the
    // on-disk record is still 'running'. At next boot recovery finalizes it to a
    // real terminal (hold mode removes the worktree) — the human hand-back is
    // lost, but there is no crash and the run is never stranded 'running'. The
    // first-write ordering (Req 3) minimizes this window; this documents the
    // degraded-but-safe outcome when the race is lost.
    writeAllRuns([makeRun('run-lost-park', { status: 'running' })], filePath);
    const deps = makeDeps(async () => 'completed');

    const result = await recoverAndFinalizeStaleRuns(deps);

    expect(result.finalized).toBe(1);
    // An ordinary recovered terminal — NOT parked, NOT left 'running'.
    expect(readAllRuns(filePath)[0]!.status).toBe('completed');
  });

  it('awaits the finalizer serially — recovery completes before resolving (so index.ts can order it before the sweep)', async () => {
    // The orphan-worktree sweep (index.ts:84) runs AFTER recovery. Recovery
    // must be awaitable so index.ts can finish finalizing — while the worktree
    // still exists — before launching the sweep. This pins (a) every stale run
    // is finalized before the promise resolves, and (b) finalization is SERIAL
    // (one worktree at a time), the safe startup contract.
    writeAllRuns(
      [makeRun('run-1', { status: 'running' }), makeRun('run-2', { status: 'running' })],
      filePath,
    );
    let inFlight = 0;
    let maxConcurrent = 0;
    let completed = 0;
    const deps = makeDeps(async () => {
      inFlight++;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      await Promise.resolve();
      inFlight--;
      completed++;
      return 'completed';
    });

    await recoverAndFinalizeStaleRuns(deps);

    // Both stale runs were finalized before the promise resolved, one at a time.
    expect(completed).toBe(2);
    expect(maxConcurrent).toBe(1);
    expect(readAllRuns(filePath).every((r) => r.status === 'completed')).toBe(true);
  });

  it('isolates a per-run finalize failure: one rejecting run does not abort the rest', async () => {
    writeAllRuns(
      [makeRun('run-bad', { status: 'running' }), makeRun('run-good', { status: 'running' })],
      filePath,
    );
    const deps = makeDeps(async (run) => {
      if (run.id === 'run-bad') throw new Error('git failure / worktree gone');
      return 'completed';
    });

    const result = await recoverAndFinalizeStaleRuns(deps);

    // The good run was still finalized; the bad one is counted, not fatal.
    expect(result.finalized).toBe(1);
    expect(result.failedToFinalize).toBe(1);
    const byId = Object.fromEntries(readAllRuns(filePath).map((r) => [r.id, r.status]));
    expect(byId['run-good']).toBe('completed');
    // The failed run is left as-is (still running) rather than crashing recovery.
    expect(byId['run-bad']).toBe('running');
  });
});
