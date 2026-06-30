import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SupervisedRun } from '../intent/supervision.js';
import { writeAllRuns } from '../jobs/supervision-store.js';
import { appendIndexRow, type WorkRunIndexRow } from '../jobs/work-run-store.js';
import type { WorkOutcome } from '../jobs/work-run-classify.js';

type RuneRunMetrics = {
  status: 'ok';
  activeRuns: number;
  parkedRuns: number;
  terminalOutcomes: Record<WorkOutcome, number>;
  recentFailures: Array<{
    id: string;
    project: string;
    outcome: 'dirty-uncommitted' | 'failed';
    durationMs: number;
    startedAt: string;
    endedAt: string;
  }>;
  runtimeMs: {
    p95: number | null;
    sampleCount: number;
  };
};

type ReadRuneRunMetrics = (opts: {
  supervisedRunsFile: string;
  workRunsIndexFile: string;
  recentLimit?: number;
}) => RuneRunMetrics | Promise<RuneRunMetrics>;

async function loadAdapter(): Promise<ReadRuneRunMetrics> {
  let mod: Record<string, unknown>;
  try {
    mod = await import('./rune-run-metrics.js');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    expect.fail(`readRuneRunMetrics adapter is not available yet: ${message}`);
  }

  const adapter = mod['readRuneRunMetrics'];
  if (typeof adapter !== 'function') {
    expect.fail('rune-run-metrics.js must export readRuneRunMetrics(opts)');
  }
  return adapter as ReadRuneRunMetrics;
}

function makeRun(id: string, overrides: Partial<SupervisedRun> = {}): SupervisedRun {
  return {
    id,
    product: 'rune',
    project: '19-rune-product-os',
    status: 'running',
    startedAt: '2026-06-29T10:00:00.000Z',
    lastHeartbeatAt: '2026-06-29T10:01:00.000Z',
    ...overrides,
  };
}

function makeIndexRow(id: string, overrides: Partial<WorkRunIndexRow> = {}): WorkRunIndexRow {
  return {
    id,
    project: '19-rune-product-os',
    outcome: 'branch-complete',
    durationMs: 1_000,
    startedAt: '2026-06-29T10:00:00.000Z',
    endedAt: '2026-06-29T10:00:01.000Z',
    ...overrides,
  };
}

let tmpDir: string;
let supervisedRunsFile: string;
let workRunsIndexFile: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'rune-run-metrics-test-'));
  supervisedRunsFile = join(tmpDir, 'supervised-runs.json');
  workRunsIndexFile = join(tmpDir, 'work-runs', 'index.jsonl');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('readRuneRunMetrics', () => {
  it('aggregates active supervision counts, terminal outcomes, and p95 runtime from the real stores', async () => {
    const readRuneRunMetrics = await loadAdapter();
    writeAllRuns([
      makeRun('run-live-1', { status: 'running' }),
      makeRun('run-parked-1', { status: 'blocked-on-human' }),
      makeRun('run-completed-old', { status: 'completed' }),
      makeRun('run-failed-old', { status: 'failed' }),
    ], supervisedRunsFile);

    const outcomes: WorkOutcome[] = [
      'branch-complete',
      'branch-complete',
      'partial',
      'noop',
      'dirty-uncommitted',
      'failed',
    ];
    outcomes.forEach((outcome, index) => {
      appendIndexRow(workRunsIndexFile, makeIndexRow(`terminal-${index}`, {
        outcome,
        durationMs: (index + 1) * 1_000,
        startedAt: `2026-06-29T10:0${index}:00.000Z`,
        endedAt: `2026-06-29T10:0${index}:01.000Z`,
      }));
    });

    const snapshot = await Promise.resolve(readRuneRunMetrics({
      supervisedRunsFile,
      workRunsIndexFile,
      recentLimit: 20,
    }));

    expect(snapshot).toMatchObject({
      status: 'ok',
      activeRuns: 2,
      parkedRuns: 1,
      terminalOutcomes: {
        'branch-complete': 2,
        partial: 1,
        noop: 1,
        'dirty-uncommitted': 1,
        failed: 1,
      },
      runtimeMs: {
        p95: 6_000,
        sampleCount: 6,
      },
    });
  });

  it('returns recent failed/dirty terminal rows newest-first and capped without counting noop as a failure', async () => {
    const readRuneRunMetrics = await loadAdapter();
    writeAllRuns([], supervisedRunsFile);
    appendIndexRow(workRunsIndexFile, makeIndexRow('old-failed', {
      outcome: 'failed',
      durationMs: 1_000,
      endedAt: '2026-06-29T10:00:00.000Z',
    }));
    appendIndexRow(workRunsIndexFile, makeIndexRow('new-noop', {
      outcome: 'noop',
      durationMs: 2_000,
      endedAt: '2026-06-29T10:01:00.000Z',
    }));
    appendIndexRow(workRunsIndexFile, makeIndexRow('new-dirty', {
      outcome: 'dirty-uncommitted',
      durationMs: 3_000,
      endedAt: '2026-06-29T10:02:00.000Z',
    }));
    appendIndexRow(workRunsIndexFile, makeIndexRow('new-failed', {
      outcome: 'failed',
      durationMs: 4_000,
      endedAt: '2026-06-29T10:03:00.000Z',
    }));

    const snapshot = await Promise.resolve(readRuneRunMetrics({
      supervisedRunsFile,
      workRunsIndexFile,
      recentLimit: 2,
    }));

    expect(snapshot.recentFailures.map((row) => row.id)).toEqual(['new-failed', 'new-dirty']);
    expect(snapshot.recentFailures.map((row) => row.outcome)).toEqual(['failed', 'dirty-uncommitted']);
    expect(snapshot.recentFailures).toHaveLength(2);
  });

  it('returns an empty ok snapshot when the persisted stores are missing or corrupt', async () => {
    const readRuneRunMetrics = await loadAdapter();
    mkdirSync(join(tmpDir, 'work-runs'), { recursive: true });
    writeFileSync(supervisedRunsFile, '{not valid json', 'utf8');
    writeFileSync(workRunsIndexFile, '{not valid json\n', 'utf8');

    const snapshot = await Promise.resolve(readRuneRunMetrics({
      supervisedRunsFile,
      workRunsIndexFile,
    }));

    expect(snapshot).toEqual({
      status: 'ok',
      activeRuns: 0,
      parkedRuns: 0,
      terminalOutcomes: {
        'branch-complete': 0,
        partial: 0,
        noop: 0,
        'dirty-uncommitted': 0,
        failed: 0,
      },
      recentFailures: [],
      runtimeMs: {
        p95: null,
        sampleCount: 0,
      },
    });
  });
});
