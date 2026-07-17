import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NotificationBus, type BusMutationEvent } from '../transport/notification-bus.js';
import {
  appendFixAttempt,
  getLatestFixAttempt,
  readLatestFixAttempts,
} from './fix-attempt-store.js';

const { mockLog } = vi.hoisted(() => ({
  mockLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../utils/logger.js', () => ({ createLogger: () => mockLog }));

/**
 * The reconciler deliberately consumes recorded run facts. These tests do not
 * start a runner or bind a port: the mutation descriptor / supervision record
 * remains the single source of truth for the terminal outcome.
 */
async function loadReconciler(): Promise<any> {
  try {
    const mod = await import('./fix-attempt-reconciler.js');
    for (const name of [
      'readRecordedFixRun',
      'reconcileProceedingFixAttempts',
      'reconcileFixAttemptForRun',
      'startFixAttemptReconciler',
    ] as const) {
      expect(mod[name], `expected fix-attempt-reconciler.ts to export ${name}`).toBeTypeOf('function');
    }
    return mod;
  } catch (error) {
    throw new Error(
      `fix-attempt terminal reconciler is missing or invalid: expected src/jobs/fix-attempt-reconciler.ts (${(error as Error).message})`,
    );
  }
}

type RecordedRun = {
  id: string;
  status: 'running' | 'completed' | 'failed' | 'blocked-on-human';
  outcome?: string;
  merged?: boolean;
  reason?: string;
};

let dir: string;
let file: string;

beforeEach(() => {
  vi.clearAllMocks();
  dir = mkdtempSync(join(tmpdir(), 'rune-fix-attempt-reconciler-'));
  file = join(dir, 'fix-attempts.jsonl');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function seedProceeding(overrides: Record<string, unknown> = {}): void {
  appendFixAttempt(file, {
    attemptId: 'attempt-1',
    product: 'rune',
    bugId: 'BUG-17',
    state: 'proceeding',
    runId: 'run-17',
    updatedAt: '2026-07-16T12:00:00.000Z',
    ...overrides,
  } as any);
}

function latest(bugId = 'BUG-17') {
  return getLatestFixAttempt(readLatestFixAttempts(file), 'rune', bugId);
}

function recordedRun(overrides: Partial<RecordedRun> = {}): RecordedRun {
  return {
    id: 'run-17',
    status: 'completed',
    outcome: 'branch-complete',
    merged: true,
    ...overrides,
  };
}

function mutationEvent(overrides: Partial<BusMutationEvent> = {}): BusMutationEvent {
  return {
    kind: 'mutation-event',
    mutationId: 'run-17',
    mutationKind: 'orchestrated-work',
    subKind: 'completed',
    ts: '2026-07-16T12:05:00.000Z',
    userId: 1,
    data: { outcome: 'branch-complete' },
    ...overrides,
  };
}

describe('fix-attempt terminal reconciler', () => {
  it('moves proceeding to fixed only when the recorded run completed and merged, and records a diagnosable transition', async () => {
    const { reconcileProceedingFixAttempts } = await loadReconciler();
    seedProceeding();
    const log = vi.fn();

    const changed = reconcileProceedingFixAttempts(file, {
      readRun: (runId: string) => runId === 'run-17' ? recordedRun() : undefined,
      now: () => '2026-07-16T12:05:00.000Z',
      log,
    });

    expect(changed).toEqual([
      expect.objectContaining({
        attemptId: 'attempt-1',
        runId: 'run-17',
        state: 'fixed',
      }),
    ]);
    expect(latest()).toMatchObject({
      attemptId: 'attempt-1',
      state: 'fixed',
      runId: 'run-17',
      updatedAt: '2026-07-16T12:05:00.000Z',
    });
    expect(log).toHaveBeenCalledWith(expect.objectContaining({
      runId: 'run-17',
      terminal: 'fixed',
      outcome: 'branch-complete',
    }));
  });

  it('emits a terminal mapping with the run id and underlying outcome to the diagnosis log', async () => {
    const { reconcileFixAttemptForRun } = await loadReconciler();
    seedProceeding();

    reconcileFixAttemptForRun(file, recordedRun({
      status: 'failed',
      outcome: 'failed',
      merged: undefined,
      reason: 'reviewer gate rejected the diff',
    }));

    expect(mockLog.info).toHaveBeenCalledWith('FixAttempt reconciled from terminal run', {
      runId: 'run-17',
      terminal: 'failed',
      status: 'failed',
      outcome: 'failed',
    });
  });

  it.each([
    ['completed without a merge', recordedRun({ merged: false })],
    ['a blocked-on-human run', recordedRun({ status: 'blocked-on-human', merged: undefined })],
    ['a parked outcome', recordedRun({ outcome: 'parked', merged: undefined })],
    ['a held outcome', recordedRun({ outcome: 'held', merged: undefined })],
    ['a noop outcome', recordedRun({ outcome: 'noop', merged: undefined })],
    ['a partial outcome', recordedRun({ outcome: 'partial', merged: undefined })],
  ])('maps %s to parked-on-human', async (_label, run) => {
    const { reconcileProceedingFixAttempts } = await loadReconciler();
    seedProceeding();

    reconcileProceedingFixAttempts(file, {
      readRun: () => run,
      now: () => '2026-07-16T12:05:00.000Z',
    });

    expect(latest()).toMatchObject({
      state: 'parked-on-human',
      runId: 'run-17',
    });
  });

  it('maps a recorded failed run to failed and preserves its diagnostic detail', async () => {
    const { reconcileProceedingFixAttempts } = await loadReconciler();
    seedProceeding();

    reconcileProceedingFixAttempts(file, {
      readRun: () => recordedRun({
        status: 'failed',
        outcome: 'failed',
        merged: undefined,
        reason: 'reviewer gate rejected the diff',
      }),
      now: () => '2026-07-16T12:05:00.000Z',
    });

    expect(latest()).toMatchObject({
      state: 'failed',
      runId: 'run-17',
      reason: 'failed',
      detail: expect.stringContaining('reviewer gate rejected the diff'),
    });
  });

  it('leaves a proceeding attempt alone when the recorded run is missing or non-terminal', async () => {
    const { reconcileProceedingFixAttempts } = await loadReconciler();
    seedProceeding();

    expect(reconcileProceedingFixAttempts(file, {
      readRun: () => recordedRun({ status: 'running', merged: undefined }),
      now: () => '2026-07-16T12:05:00.000Z',
    })).toEqual([]);
    expect(latest()).toMatchObject({ state: 'proceeding', runId: 'run-17' });

    expect(reconcileProceedingFixAttempts(file, {
      readRun: () => undefined,
      now: () => '2026-07-16T12:06:00.000Z',
    })).toEqual([]);
    expect(latest()).toMatchObject({ state: 'proceeding', runId: 'run-17' });
  });

  it('supports an event-driven terminal update and never overwrites an already-terminal attempt', async () => {
    const { reconcileFixAttemptForRun } = await loadReconciler();
    seedProceeding();

    const first = reconcileFixAttemptForRun(file, recordedRun({ outcome: 'partial', merged: undefined }), {
      now: () => '2026-07-16T12:05:00.000Z',
    });
    const once = readFileSync(file, 'utf8');
    const second = reconcileFixAttemptForRun(file, recordedRun({ outcome: 'branch-complete', merged: true }), {
      now: () => '2026-07-16T12:06:00.000Z',
    });

    expect(first).toEqual([expect.objectContaining({ state: 'parked-on-human', runId: 'run-17' })]);
    expect(second).toEqual([]);
    expect(latest()).toMatchObject({ state: 'parked-on-human', runId: 'run-17' });
    expect(readFileSync(file, 'utf8')).toBe(once);
  });

  it('catches up every proceeding attempt after downtime without touching a pre-existing terminal', async () => {
    const { reconcileProceedingFixAttempts } = await loadReconciler();
    seedProceeding();
    seedProceeding({
      attemptId: 'attempt-2',
      bugId: 'BUG-18',
      runId: 'run-18',
      state: 'proceeding',
    });
    seedProceeding({
      attemptId: 'already-fixed',
      bugId: 'BUG-19',
      runId: 'run-19',
      state: 'fixed',
      reason: 'branch-complete',
    });

    const changed = reconcileProceedingFixAttempts(file, {
      readRun: (runId: string) => ({
        'run-17': recordedRun(),
        'run-18': recordedRun({ id: 'run-18', status: 'failed', outcome: 'failed', merged: undefined, reason: 'runner exited 1' }),
        'run-19': recordedRun({ id: 'run-19', merged: false }),
      })[runId],
      now: () => '2026-07-16T12:05:00.000Z',
    });

    expect(changed).toHaveLength(2);
    expect(latest('BUG-17')).toMatchObject({ state: 'fixed', runId: 'run-17' });
    expect(latest('BUG-18')).toMatchObject({ state: 'failed', runId: 'run-18' });
    expect(latest('BUG-19')).toMatchObject({
      attemptId: 'already-fixed',
      state: 'fixed',
      runId: 'run-19',
    });
  });

  it('composes blocked supervision ahead of terminal mutation and summary facts', async () => {
    const { readRecordedFixRun } = await loadReconciler();

    const run = readRecordedFixRun('run-17', {
      supervisedRunsFile: 'supervised-runs.json',
      workRunsDir: 'work-runs',
      readSupervisedRuns: () => [{ id: 'run-17', status: 'blocked-on-human' }] as any,
      readMutations: () => [{ id: 'run-17', status: 'completed', outcome: 'branch-complete' }] as any,
      readSummary: () => ({
        id: 'run-17',
        outcome: 'branch-complete',
        merged: true,
        gateHeldReason: 'merge requires operator action',
      }) as any,
    });

    expect(run).toEqual({
      id: 'run-17',
      status: 'blocked-on-human',
      outcome: 'branch-complete',
      merged: true,
      reason: 'merge requires operator action',
    });
  });

  it('uses a terminal mutation ahead of stale running supervision', async () => {
    const { readRecordedFixRun } = await loadReconciler();

    const run = readRecordedFixRun('run-17', {
      supervisedRunsFile: 'supervised-runs.json',
      workRunsDir: 'work-runs',
      readSupervisedRuns: () => [{ id: 'run-17', status: 'running' }] as any,
      readMutations: () => [{ id: 'run-17', status: 'completed', outcome: 'partial' }] as any,
      readSummary: () => null,
    });

    expect(run).toEqual({
      id: 'run-17',
      status: 'completed',
      outcome: 'partial',
    });
  });

  it('falls back to a summary when supervision and mutation records are absent', async () => {
    const { readRecordedFixRun } = await loadReconciler();

    const run = readRecordedFixRun('run-17', {
      supervisedRunsFile: 'supervised-runs.json',
      workRunsDir: 'work-runs',
      readSupervisedRuns: () => [],
      readMutations: () => [],
      readSummary: () => ({
        id: 'run-17',
        outcome: 'branch-complete',
        merged: true,
        reason: 'merged by finalizer',
      }) as any,
    });

    expect(run).toEqual({
      id: 'run-17',
      status: 'completed',
      outcome: 'branch-complete',
      merged: true,
      reason: 'merged by finalizer',
    });
  });

  it('uses durable merged facts for a live event whose payload omits the merged discriminator', async () => {
    const { startFixAttemptReconciler } = await loadReconciler();
    const bus = new NotificationBus();
    const readRun = vi.fn(() => recordedRun());
    const readRunForSweep = vi.fn(() => recordedRun({ status: 'running', merged: undefined }));
    seedProceeding();

    const stop = startFixAttemptReconciler(bus, {
      filePath: file,
      readRun,
      readRunForSweep,
    });
    expect(readRunForSweep).toHaveBeenCalledWith('run-17');
    expect(readRun).not.toHaveBeenCalled();

    bus.publish(mutationEvent({ data: { outcome: 'branch-complete' } }));

    expect(readRun).toHaveBeenCalledWith('run-17');
    expect(latest()).toMatchObject({
      state: 'fixed',
      runId: 'run-17',
    });
    stop();
  });

  it('filters unrelated bus events, falls back to terminal event facts, and unsubscribes', async () => {
    const { startFixAttemptReconciler } = await loadReconciler();
    const bus = new NotificationBus();
    const readRun = vi.fn(() => undefined);
    const stop = startFixAttemptReconciler(bus, { filePath: file, readRun });
    seedProceeding();

    bus.publish(mutationEvent({ mutationKind: 'work-run' }));
    bus.publish(mutationEvent({ subKind: 'progress' }));
    expect(readRun).not.toHaveBeenCalled();
    expect(latest()).toMatchObject({ state: 'proceeding' });

    bus.publish(mutationEvent({ data: { outcome: 'partial' } }));
    expect(readRun).toHaveBeenCalledTimes(1);
    expect(latest()).toMatchObject({ state: 'parked-on-human' });

    stop();
    seedProceeding({ attemptId: 'attempt-2', bugId: 'BUG-18', runId: 'run-18' });
    bus.publish(mutationEvent({ mutationId: 'run-18', data: { outcome: 'failed' } }));
    expect(readRun).toHaveBeenCalledTimes(1);
    expect(latest('BUG-18')).toMatchObject({ state: 'proceeding' });
  });
});
