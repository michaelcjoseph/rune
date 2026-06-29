import { readAllRuns } from '../jobs/supervision-store.js';
import { readRecentIndex, type WorkRunIndexRow } from '../jobs/work-run-store.js';
import type { WorkOutcome } from '../jobs/work-run-classify.js';

const WORK_OUTCOMES: readonly WorkOutcome[] = [
  'branch-complete',
  'partial',
  'noop',
  'dirty-uncommitted',
  'failed',
];

const FAILURE_OUTCOMES = new Set<WorkOutcome>(['dirty-uncommitted', 'failed']);
const DEFAULT_RECENT_FAILURE_LIMIT = 5;
const INDEX_SCAN_LIMIT = Number.MAX_SAFE_INTEGER;

export type RuneRunMetrics = {
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

export type ReadRuneRunMetricsOptions = {
  supervisedRunsFile: string;
  workRunsIndexFile: string;
  recentLimit?: number;
};

function emptyTerminalOutcomes(): Record<WorkOutcome, number> {
  return {
    'branch-complete': 0,
    partial: 0,
    noop: 0,
    'dirty-uncommitted': 0,
    failed: 0,
  };
}

function isWorkOutcome(value: unknown): value is WorkOutcome {
  return typeof value === 'string' && WORK_OUTCOMES.includes(value as WorkOutcome);
}

function failureSortTime(row: WorkRunIndexRow): number {
  const parsed = Date.parse(row.endedAt);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function isFailureRow(row: WorkRunIndexRow): row is WorkRunIndexRow & { outcome: 'dirty-uncommitted' | 'failed' } {
  return (
    isWorkOutcome(row.outcome) &&
    FAILURE_OUTCOMES.has(row.outcome) &&
    typeof row.project === 'string' &&
    typeof row.durationMs === 'number' &&
    Number.isFinite(row.durationMs) &&
    typeof row.startedAt === 'string' &&
    typeof row.endedAt === 'string'
  );
}

function percentile95(samples: number[]): number | null {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
  return sorted[index] ?? null;
}

export function readRuneRunMetrics(opts: ReadRuneRunMetricsOptions): RuneRunMetrics {
  const runs = readAllRuns(opts.supervisedRunsFile);
  const active = runs.filter((run) => run.status === 'running' || run.status === 'blocked-on-human');
  const terminalOutcomes = emptyTerminalOutcomes();
  const rows = readRecentIndex(opts.workRunsIndexFile, INDEX_SCAN_LIMIT);
  const runtimes: number[] = [];

  for (const row of rows) {
    if (!isWorkOutcome(row.outcome)) continue;
    terminalOutcomes[row.outcome] += 1;
    if (typeof row.durationMs === 'number' && Number.isFinite(row.durationMs)) {
      runtimes.push(row.durationMs);
    }
  }

  const recentLimit = Math.max(0, Math.floor(opts.recentLimit ?? DEFAULT_RECENT_FAILURE_LIMIT));
  const recentFailures = rows
    .filter(isFailureRow)
    .sort((a, b) => failureSortTime(b) - failureSortTime(a))
    .slice(0, recentLimit)
    .map((row) => ({
      id: row.id,
      project: row.project,
      outcome: row.outcome,
      durationMs: row.durationMs,
      startedAt: row.startedAt,
      endedAt: row.endedAt,
    }));

  return {
    status: 'ok',
    activeRuns: active.length,
    parkedRuns: active.filter((run) => run.status === 'blocked-on-human').length,
    terminalOutcomes,
    recentFailures,
    runtimeMs: {
      p95: percentile95(runtimes),
      sampleCount: runtimes.length,
    },
  };
}
