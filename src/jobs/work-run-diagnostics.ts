/**
 * Product-scoped, read-only work-run diagnostics.
 *
 * The model-facing MCP handlers use this pure service so product authorization
 * happens before task records or transcripts are touched. Production readers
 * are bound separately; tests inject in-memory records.
 */

import { join } from 'node:path';
import { scrubPathsInText } from '../ai/tool-labels.js';
import { VALID_SLUG } from '../intent/sandbox.js';
import type { SupervisedRun } from '../intent/supervision.js';
import type { TaskRunRecord } from '../intent/orch-run-record.js';
import { scrubAbsolutePaths } from '../utils/sanitize-paths.js';
import { redactSecrets, parseStreamJsonLine, streamJsonToDisplay } from './work-run-transcript.js';
import type { WorkRunSummary, WorkRunSummaryReadResult } from './work-run-store.js';
import { readTextTail } from './jsonl-tail.js';
import type { BoundedSupervisionRead } from './supervision-store.js';

const INDEX_SCAN_LIMIT = 200;
const DEFAULT_LIST_LIMIT = 10;
const MAX_LIST_LIMIT = 20;
const DEFAULT_TRANSCRIPT_LINES = 50;
const MAX_TRANSCRIPT_LINES = 100;
const ACTIVE_RUN_LIMIT = 10;
const ACTIVE_LOG_LINE_LIMIT = 10;
const MAX_TASK_RECORDS = 20;
const MAX_TRANSCRIPT_BYTES = 512 * 1024;
const MAX_STRING_CHARS = 1_000;
const MAX_OBJECT_ENTRIES = 20;
const MAX_KEY_CHARS = 200;
const MAX_RESPONSE_CHARS = 64_000;
const UNAVAILABLE = 'Run diagnostics are not available in this product scope.';

export interface TranscriptTail {
  lines: string[];
  sourceTruncated: boolean;
}

export interface WorkRunDiagnosticsDeps {
  readRecentSummaries: (limit: number) => WorkRunSummary[];
  readSummary: (runId: string) => WorkRunSummaryReadResult;
  readSupervisedRuns: () => BoundedSupervisionRead;
  readTaskRunRecords: (runId: string) => TaskRunRecord[];
  readTranscriptTail: (runId: string) => TranscriptTail;
}

type SafeRecord = Record<string, unknown>;

function scrubGenericAbsolutePaths(value: string): string {
  return value
    .replace(/(^|[\s([{:="'`])\/[A-Za-z0-9._-]+(?:\/[^\s)\]}>,”,"'`]*)?/g, '$1<path>')
    .replace(/\b[A-Za-z]:\\[^\\\s]+(?:\\[^\s]*)?/g, '<path>');
}

function safeText(value: string, limit = MAX_STRING_CHARS): string {
  const clean = scrubGenericAbsolutePaths(redactSecrets(scrubAbsolutePaths(scrubPathsInText(value))));
  return clean.length <= limit ? clean : `${clean.slice(0, limit - 1)}…`;
}

function sanitizeValue(value: unknown): unknown {
  if (typeof value === 'string') return safeText(value);
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as SafeRecord)
      .slice(0, MAX_OBJECT_ENTRIES)
      .map(([key, nested]) => [safeText(key, MAX_KEY_CHARS), sanitizeValue(nested)]),
  );
}

function fitResponse<T>(value: T): T {
  const copy = sanitizeValue(value) as T;
  const serializedLength = () => JSON.stringify(copy).length;
  if (serializedLength() <= MAX_RESPONSE_CHARS) return copy;

  type ShrinkableArray = { values: unknown[]; remove: 'first' | 'last' };
  const byPriority: ShrinkableArray[][] = [[], [], []];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) return;
    if (!node || typeof node !== 'object') return;
    for (const [key, child] of Object.entries(node as SafeRecord)) {
      if (Array.isArray(child)) {
        if (key === 'lines' || key === 'lastLogLines') byPriority[0]!.push({ values: child, remove: 'first' });
        else if (key === 'taskRecords') byPriority[1]!.push({ values: child, remove: 'first' });
        else if (key === 'runs') byPriority[2]!.push({ values: child, remove: 'last' });
        for (const item of child) visit(item);
      } else visit(child);
    }
  };
  visit(copy);
  while (serializedLength() > MAX_RESPONSE_CHARS) {
    const candidate = byPriority
      .flatMap(group => group.some(item => item.values.length > 0) ? [group] : [])
      .at(0)
      ?.filter(item => item.values.length > 0)
      .sort((a, b) => b.values.length - a.values.length)[0];
    if (!candidate) break;
    if (candidate.remove === 'first') candidate.values.shift();
    else candidate.values.pop();
  }
  if (serializedLength() > MAX_RESPONSE_CHARS) {
    throw new Error('Bounded diagnostic response could not fit the output limit.');
  }
  return copy;
}

function stateOf(summary: WorkRunSummary | null, supervised: SupervisedRun | null): string {
  if (supervised?.status === 'blocked-on-human') return 'parked';
  if (supervised?.status === 'running') return 'running';
  if (supervised?.status === 'completed') return 'completed';
  if (supervised?.status === 'failed' || supervised?.status === 'unknown') return 'failed';
  return summary?.outcome === 'branch-complete' ? 'completed' : 'failed';
}

function groupByValidId<T extends { id: string }>(records: T[]): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const record of records) {
    if (!record || typeof record.id !== 'string' || !VALID_SLUG.test(record.id)) continue;
    grouped.set(record.id, [...(grouped.get(record.id) ?? []), record]);
  }
  return grouped;
}

function authorized(
  product: string,
  id: string,
  summaries: WorkRunSummary[],
  supervised: SupervisedRun[],
): boolean {
  const evidence = [...summaries, ...supervised];
  if (evidence.length === 0) return false;
  return evidence.every(record =>
    record.id === id &&
    VALID_SLUG.test(record.id) &&
    typeof record.product === 'string' &&
    record.product === product,
  );
}

function boundedInteger(value: number | undefined, fallback: number, max: number, label: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new Error(`${label} must be an integer between 1 and ${max}.`);
  }
  return value;
}

function summaryRow(summary: WorkRunSummary | null, supervised: SupervisedRun | null): SafeRecord {
  return {
    id: summary?.id ?? supervised?.id,
    target: summary?.target ?? supervised?.target ?? {
      kind: 'project',
      slug: summary?.project ?? supervised?.project ?? 'unknown',
    },
    state: stateOf(summary, supervised),
    ...(summary ? {
      outcome: summary.outcome,
      reason: summary.reason,
      ...(summary.cancellation !== undefined ? { cancellation: summary.cancellation } : {}),
    } : {}),
    startedAt: summary?.startedAt ?? supervised?.startedAt,
    ...(summary?.endedAt ? { endedAt: summary.endedAt } : {}),
    ...(supervised?.lastHeartbeatAt ? { lastProgressAt: supervised.lastOutputAt ?? supervised.lastHeartbeatAt } : {}),
  };
}

function validParkedQuestion(
  value: SupervisedRun['parkedQuestion'] | undefined,
): value is NonNullable<SupervisedRun['parkedQuestion']> {
  return Boolean(value) &&
    typeof value?.question === 'string' &&
    typeof value.askedAt === 'string' &&
    Array.isArray(value.options) &&
    value.options.every(option =>
      Boolean(option) &&
      typeof option.id === 'string' &&
      typeof option.label === 'string' &&
      typeof option.value === 'string' &&
      (option.description === undefined || typeof option.description === 'string'));
}

function projectTaskRecord(record: TaskRunRecord): SafeRecord {
  const rolesInvoked = Array.isArray(record.rolesInvoked)
    ? record.rolesInvoked.filter((role): role is string => typeof role === 'string').slice(0, 20)
    : [];
  const warnings = Array.isArray(record.warnings)
    ? record.warnings.flatMap((warning) => {
      if (!warning || typeof warning !== 'object') return [];
      return [{
        ...(typeof warning.severity === 'string' ? { severity: warning.severity } : {}),
        ...(typeof warning.class === 'string' ? { class: warning.class } : {}),
        ...(typeof warning.location === 'string' ? { location: warning.location } : {}),
        ...(typeof warning.rationale === 'string' ? { rationale: warning.rationale } : {}),
      }];
    }).slice(0, 10)
    : undefined;
  return {
    taskId: record.taskId,
    ...(typeof record.taskText === 'string' ? { taskText: record.taskText } : {}),
    ...(typeof record.attemptId === 'string' ? { attemptId: record.attemptId } : {}),
    rolesInvoked,
    ...(record.modelChoices && typeof record.modelChoices === 'object' ? { modelChoices: record.modelChoices } : {}),
    ...(record.verdicts && typeof record.verdicts === 'object' ? { verdicts: record.verdicts } : {}),
    ...(record.commitSha ? { commitSha: record.commitSha } : {}),
    ...(typeof record.contextOutcome === 'string' ? { contextOutcome: record.contextOutcome } : {}),
    ...(typeof record.outcome === 'string' ? { outcome: record.outcome } : {}),
    ...(warnings ? { warnings } : {}),
  };
}

function transcriptResult(source: TranscriptTail, limit: number): {
  available: boolean;
  lines: string[];
  truncated: boolean;
  sourceTruncated: boolean;
} {
  const lines = source.lines.filter(line => line.trim() !== '').map(line => safeText(line));
  return {
    available: lines.length > 0,
    lines: lines.slice(-limit),
    truncated: source.sourceTruncated || lines.length > limit,
    sourceTruncated: source.sourceTruncated,
  };
}

/** Read a transcript tail without ever loading the full file. */
export function readTranscriptDisplayTail(
  workRunsDir: string,
  runId: string,
  maxBytes = MAX_TRANSCRIPT_BYTES,
): TranscriptTail {
  if (!VALID_SLUG.test(runId)) return { lines: [], sourceTruncated: false };
  const path = join(workRunsDir, runId, 'transcript.jsonl');
  const tail = readTextTail(path, maxBytes);
  if (!tail) return { lines: [], sourceTruncated: false };
  try {
    const display: string[] = [];
    for (const line of tail.text.split('\n')) {
      if (!line.trim()) continue;
      let parsed: unknown;
      try { parsed = JSON.parse(line); } catch { parsed = null; }
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const obj = parsed as SafeRecord;
        if ((obj['kind'] === 'output' || obj['kind'] === 'activity') && obj['data'] && typeof obj['data'] === 'object') {
          const text = (obj['data'] as SafeRecord)['line'];
          if (typeof text === 'string') display.push(...text.split('\n'));
          continue;
        }
      }
      const envelope = parseStreamJsonLine(line);
      const text = envelope ? streamJsonToDisplay(envelope) : null;
      if (text) display.push(...text.split('\n'));
    }
    return { lines: display.map(line => safeText(line)).filter(Boolean), sourceTruncated: tail.sourceTruncated };
  } catch {
    return { lines: [], sourceTruncated: false };
  }
}

export function createWorkRunDiagnostics(deps: WorkRunDiagnosticsDeps, scopeProduct: string) {
  if (!VALID_SLUG.test(scopeProduct)) throw new Error('Invalid product scope.');

  const records = () => {
    const supervision = deps.readSupervisedRuns();
    if (!supervision.complete) throw new Error(UNAVAILABLE);
    const summaries = deps.readRecentSummaries(INDEX_SCAN_LIMIT);
    return {
      supervisedById: groupByValidId(supervision.runs),
      summariesById: groupByValidId(summaries),
      invalidSummaryIds: new Set<string>(),
    };
  };

  type Records = ReturnType<typeof records>;
  const ensureSummary = (all: Records, id: string): void => {
    if (all.summariesById.has(id) || all.invalidSummaryIds.has(id)) return;
    const result = deps.readSummary(id);
    if (result.status === 'missing') return;
    if (result.status === 'invalid') {
      all.invalidSummaryIds.add(id);
      return;
    }
    const summary = result.summary;
    if (summary.id !== id || !VALID_SLUG.test(summary.id) || typeof summary.product !== 'string' || summary.product.trim() === '') {
      all.invalidSummaryIds.add(id);
      return;
    }
    all.summariesById.set(id, [summary]);
  };

  const isAuthorized = (all: Records, id: string): boolean =>
    !all.invalidSummaryIds.has(id) && authorized(
      scopeProduct,
      id,
      all.summariesById.get(id) ?? [],
      all.supervisedById.get(id) ?? [],
    );

  const summaryFor = (all: Records, id: string): WorkRunSummary | null => all.summariesById.get(id)?.[0] ?? null;
  const supervisedFor = (all: Records, id: string): SupervisedRun | null => all.supervisedById.get(id)?.[0] ?? null;

  const resolveRun = (inputId: string): { id: string; summary: WorkRunSummary | null; supervised: SupervisedRun | null } => {
    if (!VALID_SLUG.test(inputId) || inputId.length < 8) throw new Error('Invalid run ID.');
    const all = records();
    ensureSummary(all, inputId);
    const candidateIds = new Set([...all.summariesById.keys(), ...all.supervisedById.keys()]);
    const exact = candidateIds.has(inputId) ? [inputId] : [];
    const matching = exact.length > 0
      ? exact
      : [...candidateIds].filter(id => id.startsWith(inputId));
    // A prefix candidate may come only from supervision. Load its summary now
    // and re-check all ownership evidence before any artifact reader runs.
    for (const id of matching) ensureSummary(all, id);
    const allowed = matching.filter(id => isAuthorized(all, id));
    if (allowed.length === 0) throw new Error(UNAVAILABLE);
    if (allowed.length > 1) throw new Error('Run prefix is ambiguous in this product scope; provide the full run ID.');
    const id = allowed[0]!;
    return { id, summary: summaryFor(all, id), supervised: supervisedFor(all, id) };
  };

  return {
    listRuns(input: { limit?: number } = {}) {
      const limit = boundedInteger(input.limit, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT, 'limit');
      const all = records();
      const ids = new Set([...all.summariesById.keys(), ...all.supervisedById.keys()]);
      for (const id of ids) ensureSummary(all, id);
      const runs = [...ids]
        .flatMap(id => {
          const summary = summaryFor(all, id);
          const supervised = supervisedFor(all, id);
          return isAuthorized(all, id) ? [summaryRow(summary, supervised)] : [];
        })
        .sort((a, b) => String(b['startedAt'] ?? '').localeCompare(String(a['startedAt'] ?? '')))
        .slice(0, limit);
      return fitResponse({ runs });
    },

    inspectRun(input: { runId: string; transcriptLines?: number }) {
      const transcriptLines = boundedInteger(
        input.transcriptLines,
        DEFAULT_TRANSCRIPT_LINES,
        MAX_TRANSCRIPT_LINES,
        'transcriptLines',
      );
      const run = resolveRun(input.runId);
      // Authorization is complete above. Only now may artifact readers run.
      const taskRecords = deps.readTaskRunRecords(run.id).slice(-MAX_TASK_RECORDS).map(projectTaskRecord);
      const transcript = transcriptResult(deps.readTranscriptTail(run.id), transcriptLines);
      const summary = run.summary;
      const supervised = run.supervised;
      return fitResponse({
        ...summaryRow(summary, supervised),
        ...(summary ? {
          exit: {
            exitCode: summary.exit?.exitCode ?? null,
            signal: summary.exit?.signal ?? null,
            cancelled: summary.exit?.cancelled ?? false,
            ...(summary.exit?.exitFact ? { exitFact: summary.exit.exitFact } : {}),
          },
          workProduct: {
            commitCount: summary.workProduct?.commitCount ?? 0,
            dirty: summary.workProduct?.dirty ?? false,
            untracked: summary.workProduct?.untracked ?? false,
            transitions: summary.workProduct?.transitions,
          },
          ...(summary.merged !== undefined ? { merged: summary.merged } : {}),
          ...(summary.gateHeldReason ? { gateHeldReason: summary.gateHeldReason } : {}),
        } : {}),
        ...(validParkedQuestion(supervised?.parkedQuestion) ? {
          parkedQuestion: {
            question: supervised!.parkedQuestion!.question,
            options: supervised!.parkedQuestion!.options.slice(0, 10).map(option => ({
              id: option.id,
              label: option.label,
              description: option.description,
            })),
            askedAt: supervised!.parkedQuestion!.askedAt,
          },
        } : {}),
        taskRecords,
        transcript,
      });
    },

    activeRuns() {
      const all = records();
      const candidateIds = [...all.supervisedById.entries()]
        .filter(([, runs]) => runs.some(run => run.status === 'running' || run.status === 'blocked-on-human'))
        .map(([id]) => id);
      for (const id of candidateIds) ensureSummary(all, id);
      const active = candidateIds
        .filter(id => isAuthorized(all, id))
        .map(id => supervisedFor(all, id)!)
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
        .slice(0, ACTIVE_RUN_LIMIT)
        .map(run => {
          const taskRecords = deps.readTaskRunRecords(run.id).slice(-MAX_TASK_RECORDS);
          const agents = [...new Set(taskRecords.flatMap(record =>
            Array.isArray(record.rolesInvoked)
              ? record.rolesInvoked.filter((role): role is string => typeof role === 'string')
              : []))].slice(0, 20);
          const transcript = transcriptResult(deps.readTranscriptTail(run.id), ACTIVE_LOG_LINE_LIMIT);
          return {
            ...summaryRow(null, run),
            agents,
            lastLogLines: transcript.lines,
            logTruncated: transcript.truncated,
            ...(validParkedQuestion(run.parkedQuestion) ? { parkedQuestion: {
              question: run.parkedQuestion.question,
              options: run.parkedQuestion.options.slice(0, 10).map(option => ({ id: option.id, label: option.label })),
              askedAt: run.parkedQuestion.askedAt,
            } } : {}),
          };
        });
      return fitResponse({ runs: active });
    },
  };
}
