/**
 * Work-run persistence (project 11, Phase 2 — run store).
 *
 * Two durable artifacts beyond the transcript:
 *   - `summary.json` per run (outcome facts), written temp-then-rename so a
 *     crash never leaves a half-written file (mirrors `writeAllRuns` in
 *     supervision-store.ts).
 *   - `index.jsonl`, the rolling recent-runs index; readers tolerate a torn
 *     trailing line (the skip-malformed pattern from `readRecentMutations`).
 *
 * Implemented; the remaining Phase 2 work is the caller wiring (work-runner
 * writes summary.json + the index row before the terminal event).
 */

import {
  appendFileSync,
  closeSync,
  constants as fsConstants,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { createLogger } from '../utils/logger.js';
import { readBoundedRegularFileNoFollow } from '../utils/bounded-file.js';
import { VALID_SLUG } from '../intent/sandbox.js';
import type { WorkOutcome, WorkProductFacts, ExitFacts } from './work-run-classify.js';
// `PHASE_ORDER` is a runtime value, `FinalizerPhase` a type — both from the
// finalizer, which does NOT import this module, so there is no cycle. Deriving
// `KNOWN_PHASES` from `PHASE_ORDER` keeps the two in lockstep (a phase added to
// the finalizer can't silently fall out of the store's validation).
import { PHASE_ORDER, type FinalizerPhase } from './work-run-finalizer.js';
import { readJsonlTail } from './jsonl-tail.js';
import type { WorkRunTarget } from '../intent/run-target.js';
import type { OperationCancellation } from '../cancellation.js';
import type { JudgmentOutcomeEvidence } from '../intent/team-task-workflow.js';
import {
  isExecutionTerminalDisposition,
  isExecutionTerminalTrigger,
  sanitizeExecutionDiagnostic,
  type ExecutionTerminalDisposition,
  type ExecutionTerminalTrigger,
} from '../intent/execution-failure.js';
import type {
  ContextCloseoutFailure,
  WipCheckpointResult,
} from '../intent/context-closeout.js';
import type {
  RelatedTestDiagnostic,
  RelatedTestTaskDiagnostic,
} from '../intent/related-test-diagnostic.js';
import {
  isRelatedTestDiagnostic,
  isRelatedTestTaskDiagnosticList,
} from '../intent/related-test-diagnostic.js';
import {
  CONTEXT_CONFLICTING_HEADINGS_MAX,
  CONTEXT_PROPOSED_REPAIR_MAX_CHARS,
  checkpointWipSha,
  isContextUpdateReason,
} from '../intent/context-closeout.js';
import {
  isGateValidationReceipt,
  type GateValidationReceipt,
} from '../intent/full-suite-attestation.js';

const log = createLogger('work-run-store');

export interface WorkRunCancellation extends OperationCancellation {
  role: string;
}

/** Parse the durable cancellation correlation shape at persistence boundaries. */
export function parseWorkRunCancellation(value: unknown): WorkRunCancellation | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const source = record['source'];
  if (
    typeof record['role'] !== 'string' ||
    typeof record['operationId'] !== 'string' ||
    (source !== 'telegram' && source !== 'cockpit' && source !== 'internal') ||
    typeof record['requestedAt'] !== 'string'
  ) return undefined;
  return {
    role: record['role'],
    operationId: record['operationId'],
    source,
    requestedAt: record['requestedAt'],
  };
}

function parseJudgmentOutcomes(
  value: unknown,
): JudgmentOutcomeEvidence[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > 4) return undefined;
  const outcomes: JudgmentOutcomeEvidence[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return undefined;
    const record = item as Record<string, unknown>;
    const role = record['role'];
    const status = record['status'];
    if (
      (role !== 'qa' && role !== 'reviewer' && role !== 'tech-lead' && role !== 'designer') ||
      (status !== 'pass' && status !== 'reject' && status !== 'failed' && status !== 'cancelled') ||
      (record['summary'] !== undefined && typeof record['summary'] !== 'string')
    ) {
      return undefined;
    }
    outcomes.push({
      role,
      status,
      ...(typeof record['summary'] === 'string'
        ? { summary: record['summary'].slice(0, 500) }
        : {}),
    });
  }
  return outcomes;
}

/** Contents of `logs/work-runs/<id>/summary.json` — the run's outcome facts
 *  (spec requirement 9) plus paths to the transcript and forensics. */
export interface WorkRunSummary {
  id: string;
  project: string;
  product: string;
  /** User-facing target identity; absent on legacy summaries. */
  target?: WorkRunTarget;
  outcome: WorkOutcome;
  reason: string;
  exit: ExitFacts;
  workProduct: WorkProductFacts;
  baseSha: string;
  branch: string;
  startedAt: string;
  endedAt: string;
  transcriptPath: string;
  forensicsPath: string;
  /** Gated-merge disposition (Phase 3.5) — present once the finalizer has
   *  resolved a branch-complete run: `merged` true when the run landed on the
   *  base branch, `branchDeleted` true when the work branch was then removed.
   *  Absent on the pre-merge summary write and on every non-branch-complete
   *  run. */
  merged?: boolean;
  branchDeleted?: boolean;
  /** The base branch a branch-complete run targets (e.g. `main`) — stamped so a
   *  cockpit/restart reader renders the right "merged to <base>" wording for a
   *  non-`main` product. */
  baseBranch?: string;
  /** Why a branch-complete run was HELD off the base branch (the gate's typed
   *  refusal reason) — persisted so the hold reason survives a restart and
   *  reaches the cockpit, not just the live Telegram notification. */
  gateHeldReason?: string;
  /** Compact receipt for the independent integration-worktree validation. */
  gateValidationReceipt?: GateValidationReceipt;
  /** Durable correlation for a nested team-role cancellation. */
  cancellation?: WorkRunCancellation;
  /** Bounded secondary outcomes from a post-coder judgment batch. */
  judgmentOutcomes?: JudgmentOutcomeEvidence[];
  /** Immutable cause plus separate cleanup result. Absent on legacy summaries. */
  trigger?: ExecutionTerminalTrigger;
  disposition?: ExecutionTerminalDisposition;
  /** Actionable context-closeout failure evidence, absent on unrelated runs. */
  contextFailure?: ContextCloseoutFailure;
  /** Related-test host-conflict/fallback evidence, absent on legacy runs. */
  relatedTestDiagnostic?: RelatedTestDiagnostic;
  /** Bounded per-task related-test evidence for successful multi-task runs. */
  relatedTestDiagnostics?: RelatedTestTaskDiagnostic[];
}

/** One row in `logs/work-runs/index.jsonl` — the rolling recent-runs index. */
export interface WorkRunIndexRow {
  id: string;
  project: string;
  outcome: WorkOutcome;
  durationMs: number;
  startedAt: string;
  endedAt: string;
}

/**
 * Write `summary.json` into the per-run directory atomically (temp-then-rename
 * in the same directory, so the rename is an atomic intra-FS op and a crash
 * mid-write never leaves a torn `summary.json`).
 *
 * `dir` MUST be a trusted, caller-constructed path (e.g. `join(LOGS_DIR,
 * 'work-runs', runId)` where `runId` is VALID_SLUG-validated by the caller,
 * mirroring `createTranscriptSink`). The slug guard lives at the caller's
 * boundary, not here — this function joins `dir` verbatim. The caller is also
 * responsible for redacting `summary` content (diffstat / reason — see
 * `scrubPathsInText` in finalizeWorkRun) before persisting; this module stays
 * config-free and writes what it's given.
 *
 * Concurrency: safe for synchronous sequential callers (Node's single-threaded
 * event loop). The pid-based tmp name is NOT unique across two interleaved
 * async writes to the same `dir` in one process — same-dir serialization is the
 * caller's responsibility (mirrors supervision-store).
 */
export function writeSummary(dir: string, summary: WorkRunSummary): void {
  const target = join(dir, 'summary.json');
  const tmp = join(dir, `.summary.json.${process.pid}.tmp`);
  try {
    // Ensure the per-run dir exists — `createTranscriptSink` normally creates
    // it, but a sink-creation failure (or summary-only callers) must not leave
    // summary.json silently unwritten. Mirrors the sink's own `mkdirSync`.
    mkdirSync(dir, { recursive: true });
    writeFileSync(tmp, JSON.stringify(summary, null, 2), 'utf8');
    renameSync(tmp, target);
  } catch (err) {
    log.error('writeSummary: failed to persist summary.json', {
      dir,
      error: (err as Error).message,
    });
    throw err;
  }
}

export type WorkRunSummaryReadResult =
  | { status: 'found'; summary: WorkRunSummary }
  | { status: 'missing' }
  | { status: 'invalid' };

/**
 * Read a single run's `summary.json` while preserving the security-relevant
 * distinction between missing evidence and invalid/unreadable evidence.
 *
 * `id` MUST be slug-validated by the caller (VALID_SLUG) before this is called —
 * it is joined into the path verbatim, mirroring `writeSummary`'s contract. The
 * caller (the authenticated `GET /api/work-runs/:id` route) is the boundary.
 */
export function readWorkRunSummaryResult(dir: string, id: string): WorkRunSummaryReadResult {
  // Defense-in-depth: `id` is joined into the path, so reject a non-slug id here
  // too — every call site gets the same hard boundary even if it forgot to
  // guard (mirrors createTranscriptSink's VALID_SLUG check).
  if (!VALID_SLUG.test(id)) return { status: 'invalid' };
  let raw: string;
  try {
    raw = readFileSync(join(dir, id, 'summary.json'), 'utf8');
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? { status: 'missing' }
      : { status: 'invalid' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: 'invalid' };
  }
  // Lightweight shape guard (mirrors readRecentIndex) — a well-formed-JSON file
  // that isn't a summary is dropped, not returned as a bogus WorkRunSummary.
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    log.warn('readWorkRunSummary: summary.json has unexpected shape', { id });
    return { status: 'invalid' };
  }
  const s = parsed as Partial<WorkRunSummary>;
  const rawTarget = (parsed as Record<string, unknown>)['target'];
  const rawCancellation = (parsed as Record<string, unknown>)['cancellation'];
  const rawJudgmentOutcomes =
    (parsed as Record<string, unknown>)['judgmentOutcomes'];
  const rawTrigger = (parsed as Record<string, unknown>)['trigger'];
  const rawDisposition = (parsed as Record<string, unknown>)['disposition'];
  const rawContextFailure = (parsed as Record<string, unknown>)['contextFailure'];
  const rawRelatedTestDiagnostic =
    (parsed as Record<string, unknown>)['relatedTestDiagnostic'];
  const rawRelatedTestDiagnostics =
    (parsed as Record<string, unknown>)['relatedTestDiagnostics'];
  const rawGateValidationReceipt =
    (parsed as Record<string, unknown>)['gateValidationReceipt'];
  const cancellation = rawCancellation === undefined
    ? undefined
    : parseWorkRunCancellation(rawCancellation);
  const targetValid = rawTarget === undefined || (
    rawTarget !== null &&
    typeof rawTarget === 'object' &&
    !Array.isArray(rawTarget) &&
    (((rawTarget as Record<string, unknown>)['kind'] === 'project') ||
      ((rawTarget as Record<string, unknown>)['kind'] === 'bug')) &&
    typeof (rawTarget as Record<string, unknown>)['slug'] === 'string' &&
    ((rawTarget as Record<string, unknown>)['slug'] as string).trim() !== ''
  );
  const cancellationValid = rawCancellation === undefined || cancellation !== undefined;
  const judgmentOutcomes = rawJudgmentOutcomes === undefined
    ? undefined
    : parseJudgmentOutcomes(rawJudgmentOutcomes);
  const judgmentOutcomesValid =
    rawJudgmentOutcomes === undefined || judgmentOutcomes !== undefined;
  const triggerValid = rawTrigger === undefined || isExecutionTerminalTrigger(rawTrigger);
  const dispositionValid = rawDisposition === undefined || isExecutionTerminalDisposition(rawDisposition);
  const contextFailure = rawContextFailure === undefined
    ? undefined
    : parseContextCloseoutFailure(rawContextFailure);
  const contextFailureValid = rawContextFailure === undefined || contextFailure !== undefined;
  const relatedTestDiagnostic = isRelatedTestDiagnostic(rawRelatedTestDiagnostic)
    ? rawRelatedTestDiagnostic
    : undefined;
  const relatedTestDiagnosticValid =
    rawRelatedTestDiagnostic === undefined || relatedTestDiagnostic !== undefined;
  const relatedTestDiagnostics = isRelatedTestTaskDiagnosticList(rawRelatedTestDiagnostics)
    ? rawRelatedTestDiagnostics
    : undefined;
  const relatedTestDiagnosticsValid =
    rawRelatedTestDiagnostics === undefined || relatedTestDiagnostics !== undefined;
  const relatedTestProjectionConsistent =
    relatedTestDiagnostic === undefined ||
    relatedTestDiagnostics === undefined ||
    JSON.stringify(relatedTestDiagnostic) ===
      JSON.stringify(relatedTestDiagnostics.at(-1)?.diagnostic);
  const gateValidationReceipt = isGateValidationReceipt(rawGateValidationReceipt)
    ? rawGateValidationReceipt
    : undefined;
  if (
    s.id === id &&
    typeof s.product === 'string' &&
    s.product.trim() !== '' &&
    typeof s.outcome === 'string' &&
    targetValid &&
    cancellationValid && judgmentOutcomesValid &&
    triggerValid && dispositionValid && contextFailureValid &&
    relatedTestDiagnosticValid && relatedTestDiagnosticsValid &&
    relatedTestProjectionConsistent
  ) {
    const {
      gateValidationReceipt: _untrustedGateValidationReceipt,
      ...baseSummary
    } = s;
    const summary = {
      ...baseSummary,
      ...(cancellation !== undefined ? { cancellation } : {}),
      ...(judgmentOutcomes !== undefined ? { judgmentOutcomes } : {}),
      ...(contextFailure !== undefined ? { contextFailure } : {}),
      ...(relatedTestDiagnostic !== undefined ? { relatedTestDiagnostic } : {}),
      ...(relatedTestDiagnostics !== undefined ? { relatedTestDiagnostics } : {}),
      ...(gateValidationReceipt !== undefined ? { gateValidationReceipt } : {}),
    } as WorkRunSummary;
    if (
      contextFailure !== undefined &&
      !hasConsistentContextFailureTerminalState(summary, contextFailure)
    ) {
      log.warn('readWorkRunSummary: context failure contradicts terminal state', { id });
      return { status: 'invalid' };
    }
    return { status: 'found', summary };
  }
  log.warn('readWorkRunSummary: summary.json has unexpected shape', { id });
  return { status: 'invalid' };
}

function parseContextCloseoutFailure(value: unknown): ContextCloseoutFailure | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const reason = record['reason'];
  const parsedCheckpoint = parseWipCheckpoint(record['checkpoint']);
  if (parsedCheckpoint === undefined) return undefined;
  const conflicts = record['conflictingHeadings'];
  const conflictsValid = conflicts === undefined || (
    Array.isArray(conflicts) &&
    conflicts.length > 0 &&
    conflicts.length <= CONTEXT_CONFLICTING_HEADINGS_MAX &&
    conflicts.every((heading) => boundedString(heading, 200))
  );
  const conflictCount = record['conflictingHeadingCount'];
  const conflictCountValid = conflictCount === undefined || (
    Array.isArray(conflicts) &&
    Number.isSafeInteger(conflictCount) &&
    Number(conflictCount) > conflicts.length
  );
  if (
    !isContextUpdateReason(reason) ||
    !boundedString(record['file'], 1_000)
  ) {
    return undefined;
  }
  if (
    String(record['file']).startsWith('/') ||
    String(record['file']).split('/').includes('..') ||
    String(record['file']).includes('\\') ||
    (record['canonicalHeading'] !== undefined &&
      !boundedString(record['canonicalHeading'], 200)) ||
    !conflictsValid ||
    !conflictCountValid ||
    !boundedString(record['proposedRepair'], CONTEXT_PROPOSED_REPAIR_MAX_CHARS)
  ) {
    return undefined;
  }
  const file = sanitizeExecutionDiagnostic(record['file']);
  return {
    reason,
    file,
    ...(record['canonicalHeading'] !== undefined
      ? { canonicalHeading: sanitizeExecutionDiagnostic(record['canonicalHeading']) }
      : {}),
    ...(conflicts !== undefined
      ? {
          conflictingHeadings: conflicts.map((heading) =>
            sanitizeExecutionDiagnostic(heading),
          ),
        }
      : {}),
    ...(typeof conflictCount === 'number'
      ? { conflictingHeadingCount: conflictCount }
      : {}),
    proposedRepair: sanitizeExecutionDiagnostic(record['proposedRepair']),
    checkpoint: parsedCheckpoint,
  };
}

function hasConsistentContextFailureTerminalState(
  summary: WorkRunSummary,
  failure: ContextCloseoutFailure,
): boolean {
  const expectedWipSha = checkpointWipSha(failure.checkpoint);
  return summary.outcome === 'failed' &&
    summary.trigger?.kind === 'failure' &&
    summary.exit !== null &&
    typeof summary.exit === 'object' &&
    summary.exit.exitCode === 1 &&
    summary.exit.signal === null &&
    summary.exit.cancelled === false &&
    summary.exit.exitFact === 'execution-failure' &&
    summary.disposition?.kind === 'preserved' &&
    summary.disposition.wipSha === expectedWipSha;
}

function parseWipCheckpoint(value: unknown): WipCheckpointResult | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record['kind'] === 'already-clean') return { kind: 'already-clean' };
  if (
    record['kind'] === 'committed' &&
    typeof record['sha'] === 'string' &&
    /^[0-9a-f]{7,64}$/i.test(record['sha'])
  ) {
    return { kind: 'committed', sha: record['sha'] };
  }
  if (record['kind'] === 'failed' && boundedString(record['diagnostic'], 2_000)) {
    return {
      kind: 'failed',
      diagnostic: sanitizeExecutionDiagnostic(record['diagnostic']),
    };
  }
  return undefined;
}

function boundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

/** Compatibility reader for non-authorization surfaces. */
export function readWorkRunSummary(dir: string, id: string): WorkRunSummary | null {
  const result = readWorkRunSummaryResult(dir, id);
  return result.status === 'found' ? result.summary : null;
}

/** Append one row to `index.jsonl` (one JSON object per line). Creates the
 *  containing dir if absent — `appendFileSync` does not, and the work-runs dir
 *  may not exist on the very first run. */
export function appendIndexRow(filePath: string, row: WorkRunIndexRow): void {
  mkdirSync(dirname(filePath), { recursive: true });
  appendFileSync(filePath, JSON.stringify(row) + '\n', 'utf8');
}

/**
 * Read the most recent `n` rows from `index.jsonl`, newest first. A torn /
 * malformed line is skipped (never thrown — a crash mid-append must not poison
 * the reader); a missing file yields `[]`.
 */
export function readRecentIndex(filePath: string, n: number): WorkRunIndexRow[] {
  if (n <= 0) return []; // `slice(-0)` would otherwise return the whole array
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch {
    return []; // file doesn't exist yet
  }
  const rows: WorkRunIndexRow[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      log.warn('index.jsonl: skipped malformed line');
      continue;
    }
    // Lightweight shape guard (mirrors supervision-store's isSupervisedRun) —
    // a well-formed-JSON line that isn't an index row is dropped, not trusted.
    const row = entry as Partial<WorkRunIndexRow>;
    if (typeof row.id === 'string' && typeof row.outcome === 'string') {
      rows.push(row as WorkRunIndexRow);
    } else {
      log.warn('index.jsonl: skipped row with unexpected shape');
    }
  }
  // Newest-first, capped at n.
  return rows.slice(-n).reverse();
}

/** Fixed-byte variant for model-facing diagnostics; newest first. */
export function readRecentIndexBounded(
  filePath: string,
  n: number,
  maxBytes = 1024 * 1024,
): WorkRunIndexRow[] {
  if (n <= 0) return [];
  return readJsonlTail(filePath, maxBytes, n * 4)
    .filter((entry): entry is WorkRunIndexRow => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
      const row = entry as Partial<WorkRunIndexRow>;
      return typeof row.id === 'string' && VALID_SLUG.test(row.id) && typeof row.outcome === 'string';
    })
    .slice(-n)
    .reverse();
}

// ---------------------------------------------------------------------------
// Durable per-run finalize-phase store (project 15, Phase 3.5).
//
// The gated-merge finalizer records its resume checkpoint after EACH mutating
// step into `logs/work-runs/<id>/phase`; `recovery-finalize-runner` reads the
// last recorded phase to resume a run that crashed mid-gated-merge at the RIGHT
// step (skipping an already-committed merge/push) instead of re-merging or
// orphaning. One file, last-write-wins — only the latest phase matters for
// resume. Best-effort: a write failure logs and is swallowed (a phase-store
// hiccup must never deny the terminal event, the same contract summary/index
// hold). `recordWorkRunPhase`/`readLastWorkRunPhase` take the PARENT
// `work-runs` dir + a VALID_SLUG run id (mirrors `readWorkRunSummary`).
// ---------------------------------------------------------------------------

const PHASE_FILE = 'phase';

/** The valid `FinalizerPhase` strings (derived from the finalizer's
 *  `PHASE_ORDER` so the two never drift) — a read of an unknown/corrupt value
 *  returns null (treat as "no resumable phase", i.e. re-drive from the top)
 *  rather than handing back an off-contract phase. */
const KNOWN_PHASES: ReadonlySet<string> = new Set<FinalizerPhase>(PHASE_ORDER);

/**
 * Record the latest finalize phase for `id` (overwrites — last-write-wins).
 * Atomic temp-then-rename so a crash never leaves a torn phase file. Best-effort
 * (logs + swallows on failure): the durable phase is an optimization for
 * crash-resume, never a gate on terminalization. `baseDir` is the parent
 * `work-runs` dir; `id` MUST be VALID_SLUG (joined into the path verbatim).
 */
export function recordWorkRunPhase(baseDir: string, id: string, phase: FinalizerPhase): void {
  if (!VALID_SLUG.test(id)) {
    log.warn('recordWorkRunPhase: invalid run id (no-op)', { id });
    return;
  }
  const dir = join(baseDir, id);
  const target = join(dir, PHASE_FILE);
  const tmp = join(dir, `.${PHASE_FILE}.${process.pid}.tmp`);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(tmp, phase, 'utf8');
    renameSync(tmp, target);
  } catch (err) {
    log.warn('recordWorkRunPhase: failed to persist phase (best-effort)', {
      id,
      phase,
      error: (err as Error).message,
    });
  }
}

/**
 * Read the last durable finalize phase for `id`, or `null` when absent/corrupt/
 * off-contract (recovery then re-drives from the top). `id` MUST be VALID_SLUG.
 */
export function readLastWorkRunPhase(baseDir: string, id: string): FinalizerPhase | null {
  if (!VALID_SLUG.test(id)) return null;
  let raw: string;
  try {
    raw = readFileSync(join(baseDir, id, PHASE_FILE), 'utf8');
  } catch {
    return null; // no prior phase recorded
  }
  const phase = raw.trim();
  return KNOWN_PHASES.has(phase) ? (phase as FinalizerPhase) : null;
}

const GATE_VALIDATION_RECEIPT_FILE = 'gate-validation.json';
const MAX_GATE_VALIDATION_RECEIPT_BYTES = 64 * 1024;

/**
 * Persist the independent merge-gate receipt before merge starts. Unlike the
 * best-effort phase file, this authorization evidence is fail-closed: callers
 * must not merge when the atomic write fails.
 */
export function writeGateValidationReceipt(
  baseDir: string,
  id: string,
  receipt: GateValidationReceipt,
): void {
  if (!VALID_SLUG.test(id) || !isGateValidationReceipt(receipt)) {
    throw new Error('invalid merge-gate validation receipt');
  }
  if (receipt.outcome !== 'passed') {
    throw new Error('merge-gate authorization receipt is not green');
  }
  const dir = join(baseDir, id);
  const target = join(dir, GATE_VALIDATION_RECEIPT_FILE);
  const tmp = join(
    dir,
    `.${GATE_VALIDATION_RECEIPT_FILE}.${process.pid}.${randomUUID()}.tmp`,
  );
  const encoded = JSON.stringify(receipt);
  if (Buffer.byteLength(encoded, 'utf8') > MAX_GATE_VALIDATION_RECEIPT_BYTES) {
    throw new Error('merge-gate validation receipt exceeds durable bound');
  }
  mkdirSync(dir, { recursive: true });
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  const fd = openSync(
    tmp,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow,
    0o600,
  );
  try {
    const bytes = Buffer.from(encoded, 'utf8');
    let offset = 0;
    while (offset < bytes.length) {
      offset += writeSync(fd, bytes, offset, bytes.length - offset);
    }
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, target);
}

/** Read only a bounded, regular, schema-valid pre-merge receipt. */
export function readGateValidationReceipt(
  baseDir: string,
  id: string,
): GateValidationReceipt | undefined {
  if (!VALID_SLUG.test(id)) return undefined;
  const target = join(baseDir, id, GATE_VALIDATION_RECEIPT_FILE);
  try {
    const bytes = readBoundedRegularFileNoFollow(target, {
      maxBytes: MAX_GATE_VALIDATION_RECEIPT_BYTES,
      minBytes: 2,
    });
    if (bytes === undefined) return undefined;
    const parsed: unknown = JSON.parse(bytes.toString('utf8'));
    return isGateValidationReceipt(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}
