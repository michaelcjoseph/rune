import { describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { SupervisedRun } from '../intent/supervision.js';
import type { MutationDescriptor } from '../transport/mutations.js';
import type { WorkOutcome, WorkProductFacts } from './work-run-classify.js';
import { readAllRuns, upsertRun, writeAllRuns } from './supervision-store.js';
import type { WorkRunSummary } from './work-run-store.js';
import {
  reconcileTerminalWorkRunsOnce,
  startTerminalWorkRunReconciler,
  stopTerminalWorkRunReconciler,
  TERMINAL_WORK_RUN_RECONCILE_INTERVAL_MS,
  type TerminalWorkRunReconcilerDeps,
} from './work-run-reconciler.js';

function makeRun(id: string, overrides: Partial<SupervisedRun> = {}): SupervisedRun {
  return {
    id,
    kind: 'orchestrated-work',
    product: 'jarvis',
    project: '14-product-team-agents',
    status: 'running',
    startedAt: '2026-06-18T03:00:00.000Z',
    lastHeartbeatAt: '2026-06-18T03:00:00.000Z',
    ...overrides,
  };
}

function workProduct(overrides: Partial<WorkProductFacts> = {}): WorkProductFacts {
  return {
    commitCount: 0,
    commitShas: [],
    filesChanged: [],
    diffstat: '',
    dirty: false,
    untracked: false,
    transitions: {
      tasksNewlyChecked: 0,
      tasksRemaining: 0,
      tasksAdded: 0,
      tasksRemoved: 0,
    },
    ...overrides,
  };
}

function summary(id: string, outcome: WorkOutcome): WorkRunSummary {
  return {
    id,
    project: '14-product-team-agents',
    product: 'jarvis',
    outcome,
    reason: `${outcome} recorded in terminal summary`,
    exit: {
      exitCode: 0,
      signal: null,
      cancelled: false,
      durationMs: 1200,
      exitFact: 'clean-exit',
    },
    workProduct: workProduct(
      outcome === 'branch-complete'
        ? { commitCount: 1, commitShas: ['abc123'], transitions: { tasksNewlyChecked: 1, tasksRemaining: 0, tasksAdded: 0, tasksRemoved: 0 } }
        : {},
    ),
    baseSha: 'base123',
    branch: 'work/test',
    startedAt: '2026-06-18T03:00:00.000Z',
    endedAt: '2026-06-18T03:10:00.000Z',
    transcriptPath: 'logs/work-runs/run/transcript.jsonl',
    forensicsPath: 'logs/work-runs/run/forensics.json',
  };
}

function writeTestSummary(workRunsDir: string, runId: string, value: WorkRunSummary): void {
  const dir = join(workRunsDir, runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'summary.json'), JSON.stringify(value, null, 2), 'utf8');
}

function makeDescriptor(id: string, overrides: Partial<MutationDescriptor> = {}): MutationDescriptor {
  return {
    id,
    kind: 'orchestrated-work',
    source: 'webview',
    target: { type: 'orchestrated-work', ref: '14-product-team-agents' },
    preview: { summary: 'orchestrated-work on 14-product-team-agents' },
    payload: { projectSlug: '14-product-team-agents', product: 'jarvis' },
    createdAt: '2026-06-18T03:00:00.000Z',
    status: 'running',
    ...overrides,
  };
}

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-work-run-reconciler-test-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('reconcileTerminalWorkRunsOnce', () => {
  it('terminalizes a persisted running supervision row from its terminal summary.json, without a restart or live handle', () => {
    withTempDir((dir) => {
      const supervisedRunsFile = join(dir, 'supervised-runs.json');
      const workRunsDir = join(dir, 'work-runs');
      const runId = '0620f39e';
      writeAllRuns([makeRun(runId, { status: 'running' })], supervisedRunsFile);
      writeTestSummary(workRunsDir, runId, summary(runId, 'noop'));
      const terminalizedMutations: MutationDescriptor[] = [];

      const result = reconcileTerminalWorkRunsOnce({
        supervisedRunsFile,
        workRunsDir,
        terminalizeMutation: (descriptor) => terminalizedMutations.push(descriptor),
        findRunningMutation: (id) => makeDescriptor(id),
        now: () => '2026-06-18T03:15:00.000Z',
      });

      expect(result).toEqual({ reconciled: 1, examined: 1, skipped: 0 });
      expect(readAllRuns(supervisedRunsFile)[0]).toMatchObject({
        id: runId,
        status: 'completed',
        lastHeartbeatAt: '2026-06-18T03:15:00.000Z',
      });
      expect(terminalizedMutations).toHaveLength(1);
      expect(terminalizedMutations[0]).toMatchObject({
        id: runId,
        status: 'completed',
        outcome: 'noop',
      });
    });
  });

  it('maps failed terminal summaries to failed lifecycle while preserving the richer outcome on the mutation', () => {
    withTempDir((dir) => {
      const supervisedRunsFile = join(dir, 'supervised-runs.json');
      const workRunsDir = join(dir, 'work-runs');
      const runId = 'failed-run';
      writeAllRuns([makeRun(runId, { status: 'running' })], supervisedRunsFile);
      writeTestSummary(workRunsDir, runId, summary(runId, 'failed'));
      const terminalizedMutations: MutationDescriptor[] = [];

      const result = reconcileTerminalWorkRunsOnce({
        supervisedRunsFile,
        workRunsDir,
        terminalizeMutation: (descriptor) => terminalizedMutations.push(descriptor),
        findRunningMutation: (id) => makeDescriptor(id),
        now: () => '2026-06-18T03:15:00.000Z',
      });

      expect(result.reconciled).toBe(1);
      expect(readAllRuns(supervisedRunsFile)[0]!.status).toBe('failed');
      expect(terminalizedMutations[0]).toMatchObject({
        id: runId,
        status: 'failed',
        outcome: 'failed',
        error: 'failed recorded in terminal summary',
      });
    });
  });

  it('leaves genuinely in-flight running rows untouched when there is no terminal summary', () => {
    withTempDir((dir) => {
      const supervisedRunsFile = join(dir, 'supervised-runs.json');
      const workRunsDir = join(dir, 'work-runs');
      writeAllRuns([makeRun('still-live', { status: 'running' })], supervisedRunsFile);
      const terminalizeMutation = vi.fn();

      const result = reconcileTerminalWorkRunsOnce({
        supervisedRunsFile,
        workRunsDir,
        terminalizeMutation,
        findRunningMutation: () => null,
        now: () => '2026-06-18T03:15:00.000Z',
      });

      expect(result).toEqual({ reconciled: 0, examined: 1, skipped: 1 });
      expect(readAllRuns(supervisedRunsFile)[0]).toMatchObject({
        id: 'still-live',
        status: 'running',
        lastHeartbeatAt: '2026-06-18T03:00:00.000Z',
      });
      expect(terminalizeMutation).not.toHaveBeenCalled();
    });
  });

  it('ignores non-running rows even when a terminal summary exists', () => {
    withTempDir((dir) => {
      const supervisedRunsFile = join(dir, 'supervised-runs.json');
      const workRunsDir = join(dir, 'work-runs');
      writeAllRuns([makeRun('already-done', { status: 'completed' })], supervisedRunsFile);
      writeTestSummary(workRunsDir, 'already-done', summary('already-done', 'branch-complete'));
      const terminalizeMutation = vi.fn();

      const result = reconcileTerminalWorkRunsOnce({
        supervisedRunsFile,
        workRunsDir,
        terminalizeMutation,
        findRunningMutation: () => makeDescriptor('already-done', { status: 'completed' }),
        now: () => '2026-06-18T03:15:00.000Z',
      });

      expect(result).toEqual({ reconciled: 0, examined: 1, skipped: 0 });
      expect(readAllRuns(supervisedRunsFile)[0]!.status).toBe('completed');
      expect(terminalizeMutation).not.toHaveBeenCalled();
    });
  });

  it('preserves supervision updates to other rows that happen during terminal reconciliation', () => {
    withTempDir((dir) => {
      const supervisedRunsFile = join(dir, 'supervised-runs.json');
      const workRunsDir = join(dir, 'work-runs');
      const terminalRunId = 'terminal-run';
      const liveRunId = 'still-live';
      writeAllRuns(
        [
          makeRun(terminalRunId, { status: 'running' }),
          makeRun(liveRunId, { status: 'running', lastHeartbeatAt: '2026-06-18T03:01:00.000Z' }),
        ],
        supervisedRunsFile,
      );
      writeTestSummary(workRunsDir, terminalRunId, summary(terminalRunId, 'noop'));

      const result = reconcileTerminalWorkRunsOnce({
        supervisedRunsFile,
        workRunsDir,
        terminalizeMutation: () => {
          upsertRun(
            makeRun(liveRunId, { status: 'running', lastHeartbeatAt: '2026-06-18T03:14:00.000Z' }),
            supervisedRunsFile,
          );
        },
        findRunningMutation: (id) => makeDescriptor(id),
        now: () => '2026-06-18T03:15:00.000Z',
      });

      expect(result).toEqual({ reconciled: 1, examined: 2, skipped: 1 });
      const runs = readAllRuns(supervisedRunsFile);
      expect(runs.find((run) => run.id === terminalRunId)).toMatchObject({
        status: 'completed',
        lastHeartbeatAt: '2026-06-18T03:15:00.000Z',
      });
      expect(runs.find((run) => run.id === liveRunId)).toMatchObject({
        status: 'running',
        lastHeartbeatAt: '2026-06-18T03:14:00.000Z',
      });
    });
  });

  it('does not overwrite the same row when it already left running after the initial scan', () => {
    withTempDir((dir) => {
      const supervisedRunsFile = join(dir, 'supervised-runs.json');
      const workRunsDir = join(dir, 'work-runs');
      const runId = 'raced-run';
      writeAllRuns([makeRun(runId, { status: 'running' })], supervisedRunsFile);
      writeTestSummary(workRunsDir, runId, summary(runId, 'noop'));
      const terminalizeMutation = vi.fn();

      const result = reconcileTerminalWorkRunsOnce({
        supervisedRunsFile,
        workRunsDir,
        terminalizeMutation,
        findRunningMutation: (id) => {
          upsertRun(makeRun(id, { status: 'failed', lastHeartbeatAt: '2026-06-18T03:14:00.000Z' }), supervisedRunsFile);
          return makeDescriptor(id);
        },
        now: () => '2026-06-18T03:15:00.000Z',
      });

      expect(result).toEqual({ reconciled: 0, examined: 1, skipped: 1 });
      expect(readAllRuns(supervisedRunsFile)[0]).toMatchObject({
        id: runId,
        status: 'failed',
        lastHeartbeatAt: '2026-06-18T03:14:00.000Z',
      });
      expect(terminalizeMutation).not.toHaveBeenCalled();
    });
  });

  it('uses the batch mutation lookup when provided instead of falling back to per-row reads', () => {
    withTempDir((dir) => {
      const supervisedRunsFile = join(dir, 'supervised-runs.json');
      const workRunsDir = join(dir, 'work-runs');
      const runA = 'run-a';
      const runB = 'run-b';
      writeAllRuns([makeRun(runA), makeRun(runB)], supervisedRunsFile);
      writeTestSummary(workRunsDir, runA, summary(runA, 'noop'));
      writeTestSummary(workRunsDir, runB, summary(runB, 'noop'));
      const findRunningMutation = vi.fn();
      const findRunningMutations = vi.fn(
        (ids: string[]) => new Map(ids.map((id) => [id, makeDescriptor(id)])),
      );

      const result = reconcileTerminalWorkRunsOnce({
        supervisedRunsFile,
        workRunsDir,
        terminalizeMutation: vi.fn(),
        findRunningMutation,
        findRunningMutations,
        now: () => '2026-06-18T03:15:00.000Z',
      });

      expect(result).toEqual({ reconciled: 2, examined: 2, skipped: 0 });
      expect(findRunningMutations).toHaveBeenCalledTimes(1);
      expect(findRunningMutations).toHaveBeenCalledWith([runA, runB]);
      expect(findRunningMutation).not.toHaveBeenCalled();
    });
  });
});

describe('terminal work-run reconciler timer', () => {
  it('runs from a periodic timer over the persisted stores, not from startup recovery or live handles only', () => {
    vi.useFakeTimers();
    try {
      const deps: TerminalWorkRunReconcilerDeps = {
        supervisedRunsFile: '/tmp/supervised-runs.json',
        workRunsDir: '/tmp/work-runs',
        terminalizeMutation: vi.fn(),
        findRunningMutation: vi.fn(),
        now: () => '2026-06-18T03:15:00.000Z',
      };
      const reconcileNow = vi.fn();

      startTerminalWorkRunReconciler(deps, { reconcileNow });
      vi.advanceTimersByTime(TERMINAL_WORK_RUN_RECONCILE_INTERVAL_MS);
      stopTerminalWorkRunReconciler();

      expect(reconcileNow).toHaveBeenCalledWith(deps);
    } finally {
      stopTerminalWorkRunReconciler();
      vi.useRealTimers();
    }
  });
});
