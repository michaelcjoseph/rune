import { redactSecrets } from '../utils/redact-secrets.js';
import { scrubAbsolutePaths } from '../utils/sanitize-paths.js';
import { createLogger } from '../utils/logger.js';
import type {
  BusMutationEvent,
  NotificationBus,
} from '../transport/notification-bus.js';
import type { MutationDescriptor } from '../transport/mutations.js';
import {
  appendFixAttempt,
  readLatestFixAttempts,
  type FixAttempt,
  type FixAttemptState,
  type LatestFixAttempts,
} from './fix-attempt-store.js';
import { readRecentMutations } from './mutations-log.js';
import { readAllRuns } from './supervision-store.js';
import { readWorkRunSummary, type WorkRunSummary } from './work-run-store.js';

const logger = createLogger('fix-attempt-reconciler');

export interface RecordedFixRun {
  id: string;
  status: 'running' | 'completed' | 'failed' | 'blocked-on-human' | string;
  outcome?: string;
  merged?: boolean;
  reason?: string;
}

export interface FixAttemptReconcileLog {
  runId: string;
  terminal: Extract<FixAttemptState, 'fixed' | 'failed' | 'parked-on-human'>;
  status: string;
  outcome: string;
  merged?: boolean;
}

interface ReconcileOptions {
  now?: () => string;
  log?: (entry: FixAttemptReconcileLog) => void;
}

interface SweepOptions extends ReconcileOptions {
  readRun: (runId: string) => RecordedFixRun | undefined;
}

interface RecordedRunReaderOptions {
  supervisedRunsFile: string;
  workRunsDir: string;
  readSupervisedRuns?: typeof readAllRuns;
  readSummary?: typeof readWorkRunSummary;
  readMutations?: () => MutationDescriptor[];
}

interface StartReconcilerOptions extends SweepOptions {
  filePath: string;
  /** Optional snapshot-backed reader used only by the startup catch-up sweep. */
  readRunForSweep?: SweepOptions['readRun'];
}

type FixRunTerminal = Extract<FixAttemptState, 'fixed' | 'failed' | 'parked-on-human'>;

interface TerminalMapping {
  state: FixRunTerminal;
  reason: string;
  detail?: string;
}

const PARKED_OUTCOMES = new Set([
  'parked',
  'blocked-on-human',
  'held',
  'noop',
  'no-op',
  'partial',
]);

function safeDetail(detail: string | undefined): string | undefined {
  if (detail === undefined) return undefined;
  return redactSecrets(scrubAbsolutePaths(detail));
}

function terminalMapping(run: RecordedFixRun): TerminalMapping | null {
  const outcome = run.outcome ?? run.status;
  const detail = safeDetail(run.reason);

  if (run.status === 'failed' || run.outcome === 'failed') {
    return {
      state: 'failed',
      reason: outcome,
      ...(detail !== undefined ? { detail } : {}),
    };
  }

  if (run.status === 'completed' && run.merged === true) {
    return {
      state: 'fixed',
      reason: outcome,
      ...(detail !== undefined ? { detail } : {}),
    };
  }

  if (
    run.status === 'completed' ||
    run.status === 'blocked-on-human' ||
    PARKED_OUTCOMES.has(run.status) ||
    PARKED_OUTCOMES.has(outcome)
  ) {
    return {
      state: 'parked-on-human',
      reason: outcome,
      ...(detail !== undefined ? { detail } : {}),
    };
  }

  return null;
}

function appendTerminalForRun(
  filePath: string,
  latest: LatestFixAttempts,
  run: RecordedFixRun,
  options: ReconcileOptions,
): FixAttempt[] {
  const mapping = terminalMapping(run);
  if (!mapping) return [];

  const now = options.now?.() ?? new Date().toISOString();
  const changed: FixAttempt[] = [];
  for (const attempt of latest.values()) {
    if (attempt.state !== 'proceeding' || attempt.runId !== run.id) continue;

    const terminal: FixAttempt = {
      attemptId: attempt.attemptId,
      product: attempt.product,
      bugId: attempt.bugId,
      state: mapping.state,
      reason: mapping.reason,
      ...(mapping.detail !== undefined ? { detail: mapping.detail } : {}),
      runId: run.id,
      updatedAt: now,
    };
    appendFixAttempt(filePath, terminal);
    changed.push(terminal);

    const entry: FixAttemptReconcileLog = {
      runId: run.id,
      terminal: mapping.state,
      status: run.status,
      outcome: run.outcome ?? run.status,
      ...(run.merged !== undefined ? { merged: run.merged } : {}),
    };
    if (options.log) options.log(entry);
    else logger.info('FixAttempt reconciled from terminal run', { ...entry });
  }
  return changed;
}

/** Event-driven reconciliation for one recorded terminal run. */
export function reconcileFixAttemptForRun(
  filePath: string,
  run: RecordedFixRun,
  options: ReconcileOptions = {},
): FixAttempt[] {
  return appendTerminalForRun(filePath, readLatestFixAttempts(filePath), run, options);
}

/** Startup catch-up sweep over every latest-state proceeding Fix attempt. */
export function reconcileProceedingFixAttempts(
  filePath: string,
  options: SweepOptions,
): FixAttempt[] {
  const latest = readLatestFixAttempts(filePath);
  const changed: FixAttempt[] = [];
  const reconciledRunIds = new Set<string>();

  for (const attempt of latest.values()) {
    if (attempt.state !== 'proceeding' || attempt.runId === undefined) continue;
    if (reconciledRunIds.has(attempt.runId)) continue;
    reconciledRunIds.add(attempt.runId);
    const run = options.readRun(attempt.runId);
    if (!run) continue;
    changed.push(...appendTerminalForRun(filePath, latest, run, options));
  }

  return changed;
}

/**
 * Compose the durable supervision state with the work-run summary that carries
 * the gated-merge disposition. The mutation descriptor is a fallback when a
 * best-effort supervision write was lost.
 */
export function readRecordedFixRun(
  runId: string,
  options: RecordedRunReaderOptions,
): RecordedFixRun | undefined {
  const runs = (options.readSupervisedRuns ?? readAllRuns)(options.supervisedRunsFile);
  const supervised = runs.find((run) => run.id === runId);
  const mutations = (options.readMutations ?? (() => readRecentMutations(Number.MAX_SAFE_INTEGER)))();
  const mutation = mutations.find((descriptor) => descriptor.id === runId);
  const summary = (options.readSummary ?? readWorkRunSummary)(options.workRunsDir, runId);

  const status = recordedStatus(supervised?.status, mutation?.status, summary);
  if (status === undefined) return undefined;

  return {
    id: runId,
    status,
    ...(summary?.outcome !== undefined
      ? { outcome: summary.outcome }
      : mutation?.outcome !== undefined
        ? { outcome: mutation.outcome }
        : {}),
    ...(summary?.merged !== undefined ? { merged: summary.merged } : {}),
    ...((summary?.gateHeldReason ?? summary?.reason ?? mutation?.error) !== undefined
      ? { reason: summary?.gateHeldReason ?? summary?.reason ?? mutation?.error }
      : {}),
  };
}

function recordedStatus(
  supervisedStatus: RecordedFixRun['status'] | undefined,
  mutationStatus: MutationDescriptor['status'] | undefined,
  summary: WorkRunSummary | null,
): RecordedFixRun['status'] | undefined {
  if (supervisedStatus === 'blocked-on-human') return supervisedStatus;
  if (supervisedStatus === 'completed' || supervisedStatus === 'failed') return supervisedStatus;
  if (mutationStatus === 'completed' || mutationStatus === 'failed') return mutationStatus;
  if (supervisedStatus === 'running' || mutationStatus === 'running') return 'running';
  if (summary) return summary.outcome === 'failed' ? 'failed' : 'completed';
  return undefined;
}

function recordedRunFromEvent(event: BusMutationEvent): RecordedFixRun {
  const data = event.data && typeof event.data === 'object' && !Array.isArray(event.data)
    ? event.data as Record<string, unknown>
    : {};
  const parked = data['parked'] === true;
  const outcome = data['outcome'];
  const merged = data['merged'];
  const reason = data['gateHeldReason'] ?? data['reason'];
  return {
    id: event.mutationId,
    status: parked ? 'blocked-on-human' : event.subKind,
    ...(typeof outcome === 'string' ? { outcome } : {}),
    ...(typeof merged === 'boolean' ? { merged } : {}),
    ...(typeof reason === 'string' ? { reason } : {}),
  };
}

/**
 * Run startup catch-up, then subscribe to future orchestrated-work terminal
 * events. Returns an unsubscribe callback for graceful shutdown.
 */
export function startFixAttemptReconciler(
  bus: NotificationBus,
  options: StartReconcilerOptions,
): () => void {
  reconcileProceedingFixAttempts(options.filePath, {
    ...options,
    readRun: options.readRunForSweep ?? options.readRun,
  });

  const handler = (event: BusMutationEvent): void => {
    if (
      event.mutationKind !== 'orchestrated-work' ||
      (event.subKind !== 'completed' && event.subKind !== 'failed')
    ) return;
    const run = options.readRun(event.mutationId) ?? recordedRunFromEvent(event);
    reconcileFixAttemptForRun(options.filePath, run, {
      now: () => event.ts,
      ...(options.log !== undefined ? { log: options.log } : {}),
    });
  };
  bus.on('mutation-event', handler);
  return () => bus.off('mutation-event', handler);
}
