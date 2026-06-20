import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { VALID_SLUG } from '../intent/sandbox.js';
import type { SupervisedRun } from '../intent/supervision.js';
import type { MutationDescriptor, MutationEvent } from '../transport/mutations.js';
import type { WorkOutcome } from './work-run-classify.js';
import { readAllRuns, upsertRun } from './supervision-store.js';
import type { WorkRunSummary } from './work-run-store.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('work-run-reconciler');

export const TERMINAL_WORK_RUN_RECONCILE_INTERVAL_MS = 60_000;

export interface TerminalWorkRunReconcilerDeps {
  supervisedRunsFile: string;
  workRunsDir: string;
  terminalizeMutation: (descriptor: MutationDescriptor, summary: WorkRunSummary) => void;
  findRunningMutation: (id: string) => MutationDescriptor | null;
  findRunningMutations?: (ids: string[]) => Map<string, MutationDescriptor>;
  now: () => string;
}

export interface TerminalWorkRunReconcileResult {
  reconciled: number;
  examined: number;
  skipped: number;
}

interface TerminalWorkRunReconcilerOptions {
  reconcileNow?: (deps: TerminalWorkRunReconcilerDeps) => TerminalWorkRunReconcileResult;
}

let timer: ReturnType<typeof setInterval> | null = null;

function terminalStatusForOutcome(outcome: WorkOutcome): 'completed' | 'failed' {
  return outcome === 'failed' ? 'failed' : 'completed';
}

function terminalDescriptorFromSummary(
  descriptor: MutationDescriptor,
  summary: WorkRunSummary,
): MutationDescriptor {
  const status = terminalStatusForOutcome(summary.outcome);
  return {
    ...descriptor,
    status,
    ...(status === 'failed' ? { error: summary.reason } : {}),
    outcome: summary.outcome,
    workProduct: summary.workProduct,
  };
}

function terminalRunFromSummary(
  run: SupervisedRun,
  summary: WorkRunSummary,
  nowIso: string,
): SupervisedRun {
  return {
    id: run.id,
    kind: run.kind,
    product: run.product,
    project: run.project,
    status: terminalStatusForOutcome(summary.outcome),
    startedAt: run.startedAt,
    lastHeartbeatAt: nowIso,
  };
}

function isStillReconciliationTarget(
  run: SupervisedRun,
  summary: WorkRunSummary,
  supervisedRunsFile: string,
): boolean {
  const current = readAllRuns(supervisedRunsFile).find((entry) => entry.id === run.id);
  if (!current) return false;
  if (current.status === 'running') return true;
  return current.status === terminalStatusForOutcome(summary.outcome);
}

function readTerminalSummary(workRunsDir: string, id: string): WorkRunSummary | null {
  if (!VALID_SLUG.test(id)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(workRunsDir, id, 'summary.json'), 'utf8'));
  } catch {
    return null;
  }

  const summary = parsed as Partial<WorkRunSummary>;
  if (typeof summary.id === 'string' && summary.id === id && typeof summary.outcome === 'string') {
    return summary as WorkRunSummary;
  }
  log.warn('terminal summary has unexpected shape during reconciliation', { id });
  return null;
}

export function reconcileTerminalWorkRunsOnce(
  deps: TerminalWorkRunReconcilerDeps,
): TerminalWorkRunReconcileResult {
  const runs = readAllRuns(deps.supervisedRunsFile);
  if (runs.length === 0) return { reconciled: 0, examined: 0, skipped: 0 };

  const candidates: Array<{ run: SupervisedRun; summary: WorkRunSummary }> = [];
  const runningIds: string[] = [];
  let reconciled = 0;
  let skipped = 0;

  for (const run of runs) {
    if (run.status !== 'running') continue;

    const summary = readTerminalSummary(deps.workRunsDir, run.id);
    if (!summary) {
      skipped += 1;
      continue;
    }
    candidates.push({ run, summary });
    runningIds.push(run.id);
  }

  const descriptors = deps.findRunningMutations?.(runningIds);

  for (const { run, summary } of candidates) {
    const descriptor = descriptors ? (descriptors.get(run.id) ?? null) : deps.findRunningMutation(run.id);
    if (!descriptor || descriptor.status !== 'running') {
      skipped += 1;
      continue;
    }

    try {
      if (!isStillReconciliationTarget(run, summary, deps.supervisedRunsFile)) {
        skipped += 1;
        continue;
      }
      deps.terminalizeMutation(terminalDescriptorFromSummary(descriptor, summary), summary);
      upsertRun(terminalRunFromSummary(run, summary, deps.now()), deps.supervisedRunsFile);
      reconciled += 1;
    } catch (err) {
      skipped += 1;
      log.warn('terminal work-run reconciliation skipped row after terminal write failed', {
        id: run.id,
        error: (err as Error).message,
      });
    }
  }

  return { reconciled, examined: runs.length, skipped };
}

export function startTerminalWorkRunReconciler(
  deps: TerminalWorkRunReconcilerDeps,
  options: TerminalWorkRunReconcilerOptions = {},
): void {
  if (timer) stopTerminalWorkRunReconciler();

  const reconcileNow = options.reconcileNow ?? reconcileTerminalWorkRunsOnce;
  timer = setInterval(() => {
    try {
      reconcileNow(deps);
    } catch (err) {
      log.warn('terminal work-run reconciliation tick failed', {
        error: (err as Error).message,
      });
    }
  }, TERMINAL_WORK_RUN_RECONCILE_INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
}

export function stopTerminalWorkRunReconciler(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}

function latestRunningMutationsFromLog(
  mutationsLogFile: string,
  ids: readonly string[],
): Map<string, MutationDescriptor> {
  const wanted = new Set(ids);
  const latest = new Map<string, MutationDescriptor>();
  if (wanted.size === 0) return latest;

  let raw: string;
  try {
    raw = readFileSync(mutationsLogFile, 'utf8');
  } catch {
    return latest;
  }

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const descriptor = JSON.parse(line) as MutationDescriptor;
      if (wanted.has(descriptor.id)) latest.set(descriptor.id, descriptor);
    } catch {
      log.warn('mutations.jsonl: skipped malformed line during terminal reconciliation');
    }
  }

  for (const [id, descriptor] of latest) {
    if (descriptor.status !== 'running') latest.delete(id);
  }
  return latest;
}

function latestRunningMutationFromLog(mutationsLogFile: string, id: string): MutationDescriptor | null {
  return latestRunningMutationsFromLog(mutationsLogFile, [id]).get(id) ?? null;
}

function eventFromSummary(summary: WorkRunSummary): MutationEvent {
  return {
    mutationId: summary.id,
    ts: summary.endedAt,
    kind: terminalStatusForOutcome(summary.outcome),
    data: {
      outcome: summary.outcome,
      reason: summary.reason,
      workProduct: summary.workProduct,
      exit: summary.exit,
    },
  };
}

export async function defaultTerminalWorkRunReconcilerDeps(): Promise<TerminalWorkRunReconcilerDeps> {
  const [{ default: config }, { writeRecoveredTerminalMutation }] = await Promise.all([
    import('../config.js'),
    import('../transport/mutations.js'),
  ]);
  const mutationsLogFile = join(config.LOGS_DIR, 'mutations.jsonl');

  return {
    supervisedRunsFile: config.SUPERVISED_RUNS_FILE,
    workRunsDir: config.WORK_RUNS_DIR,
    findRunningMutation: (id) => latestRunningMutationFromLog(mutationsLogFile, id),
    findRunningMutations: (ids) => latestRunningMutationsFromLog(mutationsLogFile, ids),
    terminalizeMutation: (descriptor, summary) => {
      writeRecoveredTerminalMutation(descriptor, eventFromSummary(summary));
    },
    now: () => new Date().toISOString(),
  };
}
