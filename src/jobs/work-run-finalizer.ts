/**
 * Work-run finalizer (project 15 — "Work-Run Finalizer: terminal correctness +
 * gated auto-merge").
 *
 * The single, idempotent, phase-recorded state machine that owns the terminal
 * end of a `/work --auto` run. It runs in two explicit modes:
 *
 *   - `hold`  (P0, no policy change): classify → flush transcript → write
 *     summary/index → resolve the worktree (remove per the existing non-merge
 *     policy, branch left intact) → terminal supervision write. NEVER merges,
 *     pushes, or deletes the branch. This is the mode the watchdog and the
 *     startup-recovery path drive a run through, so terminal correctness lands
 *     without any merge-policy change.
 *
 *   - `gated-merge` (P1, policy change): verify the hard gate → merge → push +
 *     verify → remove worktree → delete branch → terminal write. Reuses the
 *     gen-eval-loop's `realMergeBranch`; push happens BEFORE branch delete so
 *     origin is the durable backup.
 *
 * Both modes share the SAME durable phase store so a crash mid-finalize resumes
 * at the right step (P0.4 recovery) instead of re-merging or orphaning. Every
 * side-effect is an injected seam (`FinalizerEffects`) so the machine is
 * unit-testable with spies — no real git, worktree, or store.
 *
 * STATUS: both modes are implemented and pinned by `work-run-finalizer.test.ts`
 * — `hold` (P0.4a, test-plan §4) and `gated-merge` (P1.5, test-plan §6/§7),
 * including the crash-resume matrix (`runGatedMerge` consults `readLastPhase()`
 * to skip already-committed phases). The gate DECISION (`evaluateGate`), the
 * gate RUNTIME (`runGate`), and the per-base-branch lock are injected as effects
 * here and implemented in their own modules.
 *
 * See docs/projects/15-work-run-finalizer/{spec.md, tasks.md, test-plan.md}.
 */

import { execFile as execFileCb } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { MutationEvent } from '../transport/mutations.js';
import type { WorkOutcome, WorkProductFacts } from './work-run-classify.js';
import type { GateFailReason, GateResult } from './work-run-gate.js';
import { createLogger } from '../utils/logger.js';
import { scrubAbsolutePaths } from '../utils/sanitize-paths.js';

const log = createLogger('work-run-finalizer');
const execFile = promisify(execFileCb);
const PROJECT_INDEX_REPO_PATH = 'docs/projects/index.md';

/** Read the typed `outcome` off a classified terminal event (mirrors
 *  applyOutcomeToDescriptor / buildSummary). Falls back to `failed` if absent
 *  (the classification-error path omits it). Exported so the live work-runner
 *  reuses the single extraction instead of re-implementing the ternary. */
export function readOutcome(terminalEvent: MutationEvent): WorkOutcome {
  const data = (terminalEvent.data ?? {}) as Record<string, unknown>;
  return typeof data['outcome'] === 'string' ? (data['outcome'] as WorkOutcome) : 'failed';
}

function refreshWorkProductForProjectDoneCommit(
  terminalEvent: MutationEvent,
  markResult: MarkProjectDoneResult | undefined,
): MutationEvent {
  if (markResult?.kind !== 'committed' || typeof markResult.commitSha !== 'string') {
    return terminalEvent;
  }

  const data = (terminalEvent.data ?? {}) as Record<string, unknown>;
  const workProduct = data['workProduct'] as WorkProductFacts | undefined;
  if (!workProduct) return terminalEvent;

  const commitShas = workProduct.commitShas.includes(markResult.commitSha)
    ? workProduct.commitShas
    : [...workProduct.commitShas, markResult.commitSha];
  data['workProduct'] = {
    ...workProduct,
    commitShas,
    commitCount: commitShas.length,
  };
  terminalEvent.data = data;
  return terminalEvent;
}

function hasNonReversibleSevereFinding(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(hasNonReversibleSevereFinding);
  }
  if (!value || typeof value !== 'object') return false;

  const record = value as Record<string, unknown>;
  const severity = record['severity'];
  const status = record['status'];
  if (
    record['reversible'] === false &&
    (severity === 'high' || severity === 'critical') &&
    (status === 'open' || status === 'regressed')
  ) {
    return true;
  }

  for (const key of ['findingsLedger', 'terminalFindings', 'openFindings', 'findings']) {
    if (hasNonReversibleSevereFinding(record[key])) return true;
  }
  return false;
}

function isPreMergeHoldTerminal(terminalEvent: MutationEvent): boolean {
  const data = (terminalEvent.data ?? {}) as Record<string, unknown>;
  return data['held'] === true ||
    data['parked'] === true ||
    data['preserveBranch'] === true ||
    data['preserveWorktree'] === true ||
    hasNonReversibleSevereFinding(data);
}

/** Terminal-write strategy. `hold` never touches `main`; `gated-merge` lands the
 *  branch through the hard gate. */
export type FinalizerMode = 'hold' | 'gated-merge';

/**
 * Durable, ordered finalize phases — the resume checkpoints. A crash after any
 * phase lets recovery resume at the next one rather than re-running a mutating
 * step. `merged-not-pushed` / `pushed-not-deleted` are reached only in
 * `gated-merge` mode (push-before-delete: origin is the backup before the local
 * branch is removed). The union is declared in committed order — the SAME order
 * as `PHASE_ORDER`, which drives the `reached()` resume comparison.
 */
export type FinalizerPhase =
  | 'classified'
  | 'transcript-flushed'
  | 'project-marked-done'
  | 'summary-written'
  | 'index-appended'
  | 'merged-not-pushed'
  | 'pushed-not-deleted'
  | 'worktree-resolved'
  | 'finalized';

/** Terminal supervision status the finalizer writes — always one of these, so a
 *  run NEVER ends as a quiet-pinging `running`. */
export type FinalizerSupervisionStatus = 'completed' | 'failed';

export interface FinalizerInput {
  mode: FinalizerMode;
  runId: string;
  project: string;
  product: string;
  /** The work branch (e.g. `jarvis-work/15-...`). */
  branch: string;
  /** The base branch a `gated-merge` would land on (e.g. `main`). Optional in
   *  `hold` mode, which never reads it. */
  baseBranch?: string;
}

export type NotificationPublicationKind = 'closeout-progress' | 'merge-success';
export type NotificationPublicationStatus = 'published' | 'skipped' | 'error';

export interface NotificationPublicationRecord {
  kind: NotificationPublicationKind;
  key: string;
  status: NotificationPublicationStatus;
  commitSha?: string;
  branch?: string;
  phase?: string;
  reason?: string;
  error?: string;
}

export interface MergeSuccessNotification {
  event: NotificationPublicationKind;
  runId: string;
  projectSlug: string;
  product: string;
  branch: string;
  baseBranch: string;
}

export type ProjectIndexAmbiguousReason = 'malformed-table' | 'no-match' | 'multiple-matches';

export type MarkProjectDoneResult =
  | {
      kind: 'committed' | 'already-done' | 'skipped';
      commitSha?: string | null;
      changedTokens?: string[];
    }
  | {
      kind: 'ambiguous';
      reason: ProjectIndexAmbiguousReason;
      commitSha?: string | null;
      changedTokens?: string[];
    };

/**
 * Injected side-effects + the durable phase store. Every effect is a seam so the
 * state machine is unit-testable with spies. The merge/push/delete effects are
 * OPTIONAL and MUST NOT be invoked in `hold` mode — the hold-mode tests assert
 * they are never called.
 */
export interface FinalizerEffects {
  /** Classify on work product. Wraps `finalizeWorkRun` — INCLUDING its
   *  best-effort `exportForensics` step, which is bundled inside this closure
   *  (forensics are a peer of classification, captured while the worktree still
   *  exists). Returns the single terminal MutationEvent carrying outcome +
   *  workProduct + exit. */
  classify: () => Promise<MutationEvent>;
  /** Flush + await the durable transcript before summary/index/terminal writes. */
  flushTranscript: () => Promise<void>;
  writeSummary: (terminalEvent: MutationEvent) => void;
  appendIndexRow: (terminalEvent: MutationEvent) => void;
  /** Terminal supervision/mutation write — the run never stays `running`. */
  writeSupervisionTerminal: (
    status: FinalizerSupervisionStatus,
    terminalEvent: MutationEvent,
  ) => void;
  /** Remove the worktree (the branch ref is left intact in `hold` mode). */
  removeWorktree: () => Promise<void>;
  /** Durable phase store: advance to `phase`. Recorded after EACH mutating step
   *  (not only at the end) so a crash-resume can skip exactly the steps already
   *  committed. */
  recordPhase: (phase: FinalizerPhase) => void;
  /** Read the last durable phase the prior finalize attempt reached, or null for
   *  a fresh run. The P0.4 crash-resume path consults this at the top of
   *  `runFinalizer` to resume at the next step instead of re-running a mutating
   *  one (e.g. a re-merge or double-push). */
  readLastPhase: () => FinalizerPhase | null;
  /** Optional critical section for callers that must hold a shared base-branch
   *  lock across the gate-through-merge sequence. Existing live callers may
   *  keep locking inside their gate effect; recovery uses this to avoid a
   *  stale-base window between validation and merge. */
  baseBranchCriticalSection?: <T>(fn: () => Promise<T>) => Promise<T>;
  // --- gated-merge only (P1) — MUST NOT be invoked in `hold` mode. ---
  /** Evaluate the hard merge gate (tests green, clean tree, zero tasks
   *  remaining, no conflict/bad-base, no concurrent owner, product has
   *  validationCommands and they pass within the timeout). Runs in an
   *  integration worktree so a red check never alters local `main`. */
  gate?: () => Promise<GateResult>;
  /** Alert the operator that a `gated-merge` run STOPPED at `branch-complete`
   *  (gate failed) instead of landing on `main`. */
  alert?: (reason: GateFailReason) => void;
  /** Idempotently mark the project `Done` in docs/projects/index.md on the work
   *  branch before a clean branch-complete gated merge lands. */
  markProjectDone?: (
    input: FinalizerInput,
    terminalEvent: MutationEvent,
  ) => Promise<MarkProjectDoneResult>;
  /** Optional notification seam for a clean gated merge after the branch has
   *  landed and cleanup/delete have been attempted, before the terminal write. */
  onLanded?: (notification?: MergeSuccessNotification) => void;
  /** Durable lookup used to suppress duplicate notification publications during
   *  crash/replay after a publishable phase has already been recorded. */
  readNotificationPublication?: (key: string) => NotificationPublicationRecord | null;
  /** Durable best-effort record for notification publication failures. */
  recordNotificationPublication?: (record: NotificationPublicationRecord) => void;
  /** `git merge --no-ff <branch>` onto the base branch (in an integration
   *  worktree / on the base). */
  mergeBranch?: () => Promise<void>;
  /** Abort an in-progress real merge after `mergeBranch` reports a conflict.
   *  Optional so existing callers that wrap merge in a self-cleaning runtime do
   *  not need a no-op seam. */
  abortMerge?: () => Promise<void>;
  /** Push the merged base branch to origin (the durable backup BEFORE delete). */
  pushBranch?: () => Promise<void>;
  /** Delete the work branch — only AFTER a successful push. */
  deleteBranch?: () => Promise<void>;
}

// `GateFailReason` / `GateResult` are defined alongside the pure gate decision
// in `work-run-gate.ts` and re-exported here so existing
// `from './work-run-finalizer.js'` imports keep working. The canonical home is
// the gate module — that's what the effectful `runGate` runtime imports — so
// the P1.5 wiring (finalizer → gate-runtime) can't form an import cycle.
export type { GateFailReason, GateResult };

export interface FinalizerResult {
  outcome: WorkOutcome;
  /** The classified terminal MutationEvent (carrying outcome + workProduct +
   *  exit on `data`). Surfaced so a caller that drives the finalizer — e.g. the
   *  live work-runner generator — can yield it without a mutable
   *  capture-via-closure of the `classify` effect's return. */
  terminalEvent: MutationEvent;
  /** Terminal supervision status written (never `running`). */
  supervisionStatus: FinalizerSupervisionStatus;
  worktreeRemoved: boolean;
  merged: boolean;
  branchDeleted: boolean;
  /** Phases recorded, in order. */
  phases: FinalizerPhase[];
}

/** Durable phases in their committed order — the resume axis. `reached(phase)`
 *  (in `gated-merge`) compares the last persisted phase against this list to
 *  skip steps a prior attempt already committed. */
export const PHASE_ORDER: FinalizerPhase[] = [
  'classified',
  'transcript-flushed',
  'merged-not-pushed',
  'project-marked-done',
  'summary-written',
  'index-appended',
  'pushed-not-deleted',
  'worktree-resolved',
  'finalized',
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function setTrimmedCell(cell: string, value: string): string {
  const leading = cell.match(/^\s*/)?.[0] ?? '';
  const trailing = cell.match(/\s*$/)?.[0] ?? '';
  return `${leading}${value}${trailing}`;
}

function markHeadingDone(line: string, slug: string): { line: string; changed: boolean } {
  const eol = line.endsWith('\r') ? '\r' : '';
  const bareLine = eol ? line.slice(0, -1) : line;
  const match = bareLine.match(new RegExp(`^(##\\s+${escapeRegExp(slug)}\\s+—\\s+)(.*)$`));
  if (!match) return { line, changed: false };

  const prefix = match[1]!;
  const rest = match[2]!;
  if (rest === 'Done' || rest.startsWith('Done ')) return { line, changed: false };

  const suffix = rest.match(/(\s+\(.*\)\s*)$/)?.[1] ?? '';
  return { line: `${prefix}Done${suffix}${eol}`, changed: true };
}

function isProjectHeadingLine(line: string, slug: string): boolean {
  const bareLine = line.endsWith('\r') ? line.slice(0, -1) : line;
  return new RegExp(`^##\\s+${escapeRegExp(slug)}\\s+—\\s+.*$`).test(bareLine);
}

function hasProjectLink(cell: string, slug: string): boolean {
  return new RegExp(`\\(${escapeRegExp(slug)}/?\\)`).test(cell);
}

function hasProjectLinkInColumn(
  cells: string[],
  column: number | null,
  slug: string,
): boolean {
  return column !== null && column < cells.length && hasProjectLink(cells[column]!, slug);
}

function findTableColumn(cells: string[], name: string): number | null {
  const index = cells.findIndex((cell) => cell.trim() === name);
  return index >= 0 ? index : null;
}

function hasProjectLinkAnywhere(cells: string[], slug: string): boolean {
  return cells.some((cell) => new RegExp(`\\(${escapeRegExp(slug)}/?\\)`).test(cell));
}

export type MarkProjectIndexDoneResult =
  | { kind: 'updated' | 'already-done'; content: string }
  | {
      kind: 'ambiguous';
      reason: ProjectIndexAmbiguousReason;
      content: string;
    };

/**
 * Pure docs/projects/index.md completion writer. It updates the matching
 * project's table Status cell and matching `## <slug> — <status>` section
 * heading, preserving unrelated bytes. Already-Done content returns
 * `already-done`; missing, duplicated, or malformed content returns
 * `ambiguous` with the original content unchanged.
 */
export function markProjectIndexDoneInText(
  content: string,
  slug: string,
): MarkProjectIndexDoneResult {
  const lines = content.split('\n');
  let statusColumn: number | null = null;
  let projectColumn: number | null = null;
  let inTable = false;
  let malformedTable = false;
  let matchingRows = 0;
  let matchingHeadings = 0;

  for (const line of lines) {
    if (!line.trimStart().startsWith('|')) {
      inTable = false;
      statusColumn = null;
      projectColumn = null;
      if (isProjectHeadingLine(line, slug)) matchingHeadings += 1;
      continue;
    }

    if (!inTable) {
      inTable = true;
      statusColumn = null;
      projectColumn = null;
    }

    const cells = line.split('|');
    const statusIdx = findTableColumn(cells, 'Status');
    const projectIdx = findTableColumn(cells, 'Project');
    if (statusIdx !== null || projectIdx !== null) {
      statusColumn = statusIdx;
      projectColumn = projectIdx;
      continue;
    }

    if (projectColumn === null && statusColumn === null && hasProjectLinkAnywhere(cells, slug)) {
      malformedTable = true;
    } else if (hasProjectLinkInColumn(cells, projectColumn, slug)) {
      if (statusColumn === null || statusColumn >= cells.length) {
        malformedTable = true;
      } else {
        matchingRows += 1;
      }
    }
  }

  if (malformedTable) {
    return { kind: 'ambiguous', reason: 'malformed-table', content };
  }
  if (matchingRows === 0 || matchingHeadings === 0) {
    return { kind: 'ambiguous', reason: 'no-match', content };
  }
  if (matchingRows > 1 || matchingHeadings > 1) {
    return { kind: 'ambiguous', reason: 'multiple-matches', content };
  }

  statusColumn = null;
  projectColumn = null;
  inTable = false;
  let changed = false;

  const next = lines.map((line) => {
    if (line.trimStart().startsWith('|')) {
      if (!inTable) {
        inTable = true;
        statusColumn = null;
        projectColumn = null;
      }

      const cells = line.split('|');
      const statusIdx = findTableColumn(cells, 'Status');
      const projectIdx = findTableColumn(cells, 'Project');
      if (statusIdx !== null || projectIdx !== null) {
        statusColumn = statusIdx;
        projectColumn = projectIdx;
        return line;
      }

      if (
        hasProjectLinkInColumn(cells, projectColumn, slug) &&
        statusColumn !== null &&
        statusColumn < cells.length
      ) {
        const current = cells[statusColumn]!;
        if (current.trim() !== 'Done') {
          cells[statusColumn] = setTrimmedCell(current, 'Done');
          changed = true;
          return cells.join('|');
        }
      }

      return line;
    }

    inTable = false;
    statusColumn = null;
    projectColumn = null;
    const heading = markHeadingDone(line, slug);
    if (heading.changed) changed = true;
    return heading.line;
  });

  const nextContent = next.join('\n');
  return { kind: changed ? 'updated' : 'already-done', content: nextContent };
}

function changedProjectIndexTokens(before: string, after: string, slug: string): string[] {
  const beforeLines = before.split('\n');
  const afterLines = after.split('\n');
  const changed = new Set<string>();
  const length = Math.max(beforeLines.length, afterLines.length);

  for (let i = 0; i < length; i += 1) {
    const beforeLine = beforeLines[i] ?? '';
    const afterLine = afterLines[i] ?? '';
    if (beforeLine === afterLine) continue;

    if (beforeLine.trimStart().startsWith('|') || afterLine.trimStart().startsWith('|')) {
      if (
        hasProjectLinkAnywhere(beforeLine.split('|'), slug) ||
        hasProjectLinkAnywhere(afterLine.split('|'), slug)
      ) {
        changed.add('table-status');
      }
    }
    if (isProjectHeadingLine(beforeLine, slug) || isProjectHeadingLine(afterLine, slug)) {
      changed.add('section-heading-status');
    }
  }

  return [...changed];
}

function gitIdentityEnv(): NodeJS.ProcessEnv {
  const committerName = process.env.GIT_COMMITTER_NAME ?? process.env.GIT_AUTHOR_NAME ?? 'Jarvis';
  const committerEmail =
    process.env.GIT_COMMITTER_EMAIL ?? process.env.GIT_AUTHOR_EMAIL ?? 'jarvis@example.com';
  return {
    ...process.env,
    GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME ?? committerName,
    GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL ?? committerEmail,
    GIT_COMMITTER_NAME: committerName,
    GIT_COMMITTER_EMAIL: committerEmail,
  };
}

async function git(worktreePath: string, args: string[]): Promise<string> {
  const { stdout } = await execFile('git', args, {
    cwd: worktreePath,
    encoding: 'utf8',
    env: gitIdentityEnv(),
  });
  return stdout.trim();
}

export async function markProjectDoneOnBranch(opts: {
  worktreePath: string;
  project: string;
  commitMessage?: string;
}): Promise<MarkProjectDoneResult> {
  const indexPath = join(opts.worktreePath, PROJECT_INDEX_REPO_PATH);
  if (!existsSync(indexPath)) {
    return { kind: 'skipped', commitSha: null, changedTokens: [] };
  }

  const before = readFileSync(indexPath, 'utf8');
  const result = markProjectIndexDoneInText(before, opts.project);
  if (result.kind === 'ambiguous') {
    return { kind: 'ambiguous', reason: result.reason, commitSha: null, changedTokens: [] };
  }
  if (result.kind === 'already-done') {
    return { kind: 'already-done', commitSha: null, changedTokens: [] };
  }

  writeFileSync(indexPath, result.content, 'utf8');
  await git(opts.worktreePath, ['add', '--', PROJECT_INDEX_REPO_PATH]);
  await git(opts.worktreePath, [
    'commit',
    '-m',
    opts.commitMessage ?? `Mark ${opts.project} Done in project index`,
    '--',
    PROJECT_INDEX_REPO_PATH,
  ]);
  const commitSha = await git(opts.worktreePath, ['rev-parse', 'HEAD']);

  return {
    kind: 'committed',
    commitSha,
    changedTokens: changedProjectIndexTokens(before, result.content, opts.project),
  };
}

/** Build the durable-phase recorder both modes use: each `record(phase)` writes
 *  the phase to the durable store AND appends it to the returned `phases` array
 *  (the in-order list surfaced on `FinalizerResult`). */
function makeRecorder(effects: FinalizerEffects): {
  phases: FinalizerPhase[];
  record: (phase: FinalizerPhase) => void;
} {
  const phases: FinalizerPhase[] = [];
  return {
    phases,
    record: (phase: FinalizerPhase): void => {
      effects.recordPhase(phase);
      phases.push(phase);
    },
  };
}

function notificationPublicationKey(
  input: FinalizerInput,
  kind: NotificationPublicationKind,
  phase: FinalizerPhase,
): string {
  return `${input.runId}:${kind}:${input.branch}:${phase}`;
}

function recordNotificationPublicationFailure(
  input: FinalizerInput,
  effects: FinalizerEffects,
  kind: NotificationPublicationKind,
  phase: FinalizerPhase,
  error: string,
): void {
  try {
    effects.recordNotificationPublication?.({
      kind,
      key: notificationPublicationKey(input, kind, phase),
      status: 'error',
      ...(kind === 'merge-success' ? { branch: input.branch, phase } : {}),
      error,
    });
  } catch (err) {
    log.warn('notification publication failure record failed; finalizing anyway', {
      runId: input.runId,
      error: scrubAbsolutePaths((err as Error).message),
    });
  }
}

function mergeSuccessNotification(input: FinalizerInput): MergeSuccessNotification {
  return {
    event: 'merge-success',
    runId: input.runId,
    projectSlug: input.project,
    product: input.product,
    branch: input.branch,
    baseBranch: input.baseBranch ?? 'main',
  };
}

function publishMergeSuccessNotification(
  input: FinalizerInput,
  effects: FinalizerEffects,
): void {
  const kind: NotificationPublicationKind = 'merge-success';
  const phase: FinalizerPhase = 'pushed-not-deleted';
  const key = notificationPublicationKey(input, kind, phase);
  const metadata = { kind, key, branch: input.branch, phase };

  try {
    const existing = effects.readNotificationPublication?.(key);
    if (existing?.status === 'published') {
      try {
        effects.recordNotificationPublication?.({
          ...metadata,
          status: 'skipped',
          reason: 'duplicate publication already recorded',
        });
      } catch (err) {
        log.warn('notification publication skip record failed; finalizing anyway', {
          runId: input.runId,
          error: scrubAbsolutePaths((err as Error).message),
        });
      }
      return;
    }
  } catch (err) {
    log.warn('notification publication read failed; publishing anyway', {
      runId: input.runId,
      error: scrubAbsolutePaths((err as Error).message),
    });
  }

  try {
    effects.recordNotificationPublication?.({
      ...metadata,
      status: 'published',
    });
  } catch (err) {
    log.warn('notification publication claim failed; publishing anyway', {
      runId: input.runId,
      error: scrubAbsolutePaths((err as Error).message),
    });
  }

  try {
    effects.onLanded?.(mergeSuccessNotification(input));
  } catch (err) {
    const error = scrubAbsolutePaths((err as Error).message);
    recordNotificationPublicationFailure(input, effects, kind, phase, error);
    log.warn('landed notification failed after push; finalizing anyway', {
      runId: input.runId,
      error,
    });
  }
}

/**
 * The shared finalize tail used by BOTH modes: resolve the worktree (best-effort
 * removal — a failure must never block the terminal write, req 17), then — in
 * `gated-merge` mode only — delete the now-free branch, then write a terminal
 * supervision status (never a quiet-pinging `running`). Records
 * `worktree-resolved` then `finalized`.
 *
 * `onBranchDelete` (gated-merge, merge landed) runs AFTER `removeWorktree`
 * because `git branch -d` refuses a branch still checked out in the run's
 * worktree; the push already put the work on origin, so deleting last is safe
 * (req: removeWorktree before delete). Omitted in `hold` mode and on the
 * gate-fail / non-branch-complete paths → `branchDeleted` stays false.
 */
async function resolveWorktreeAndFinalize(
  input: FinalizerInput,
  effects: FinalizerEffects,
  terminalEvent: MutationEvent,
  record: (phase: FinalizerPhase) => void,
  phases: FinalizerPhase[],
  merged: boolean,
  onBranchDelete?: () => Promise<void>,
): Promise<FinalizerResult> {
  let worktreeRemoved = false;
  try {
    await effects.removeWorktree();
    worktreeRemoved = true;
  } catch (err) {
    // Scrub host-absolute paths from the git error before logging — a worktree
    // path lives under PROJECT_ROOT/.worktrees and would otherwise reach the
    // (process-local) stdout log stream verbatim.
    log.warn('worktree removal failed; finalizing anyway', {
      runId: input.runId,
      error: scrubAbsolutePaths((err as Error).message),
    });
  }
  record('worktree-resolved');

  // Branch delete happens here — after the worktree is gone, so `git branch -d`
  // no longer sees the branch checked out. A delete failure must NOT deny the
  // terminal (the merge + push already landed): the try/catch here is the safety
  // net, independent of whether the injected `deleteBranch` self-swallows.
  // branchDeleted reflects a clean delete; a thrown delete leaves it false.
  let branchDeleted = false;
  if (onBranchDelete) {
    try {
      await onBranchDelete();
      branchDeleted = true;
    } catch (err) {
      log.warn('branch delete failed after push; finalizing anyway', {
        runId: input.runId,
        error: scrubAbsolutePaths((err as Error).message),
      });
    }
  }
  if (merged) {
    publishMergeSuccessNotification(input, effects);
  }

  const supervisionStatus: FinalizerSupervisionStatus =
    terminalEvent.kind === 'completed' ? 'completed' : 'failed';
  effects.writeSupervisionTerminal(supervisionStatus, terminalEvent);
  record('finalized');

  return {
    outcome: readOutcome(terminalEvent),
    terminalEvent,
    supervisionStatus,
    worktreeRemoved,
    merged,
    branchDeleted,
    phases,
  };
}

function isMergeConflictError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /\bCONFLICT\b/i.test(message) ||
    /automatic merge failed/i.test(message) ||
    /merge conflict/i.test(message);
}

async function abortConflictedMerge(input: FinalizerInput, effects: FinalizerEffects): Promise<void> {
  try {
    await effects.abortMerge?.();
  } catch (err) {
    log.warn('merge abort failed after conflict; preserving worktree for operator', {
      runId: input.runId,
      error: scrubAbsolutePaths((err as Error).message),
    });
  }
}

function writeOperationalHoldTerminal(
  effects: FinalizerEffects,
  terminalEvent: MutationEvent,
  phases: FinalizerPhase[],
  opts: { merged?: boolean } = {},
): FinalizerResult {
  // Do not record `finalized` here: in PHASE_ORDER it implies the merge/push
  // checkpoints were reached, but this operational hold preserves the branch
  // and worktree for a human to resolve the conflict.
  const supervisionStatus: FinalizerSupervisionStatus =
    terminalEvent.kind === 'completed' ? 'completed' : 'failed';
  effects.writeSupervisionTerminal(supervisionStatus, terminalEvent);
  return {
    outcome: readOutcome(terminalEvent),
    terminalEvent,
    supervisionStatus,
    worktreeRemoved: false,
    merged: opts.merged === true,
    branchDeleted: false,
    phases,
  };
}

/**
 * Drive a work run to a correct terminal state through the shared, idempotent,
 * phase-recorded state machine.
 *
 * `hold` mode (P0.4a): classify on work product → flush the transcript → write
 * summary + index → resolve the worktree (remove it; the branch ref is left
 * intact) → write terminal supervision. It NEVER merges, pushes, or deletes the
 * branch, and the run never ends `running`. It runs straight through (no resume
 * skipping) — the P0.4 recovery path always re-drives a hold-mode run from the
 * top, and its only append-only side-effect (the index row) is idempotent enough
 * for that.
 *
 * `gated-merge` mode (P1.5) is delegated to `runGatedMerge`, which consults
 * `effects.readLastPhase()` for crash-resume (skipping an already-committed
 * merge/push/index-append) and lands a branch-complete run on the base branch
 * through the injected hard gate.
 */
export async function runFinalizer(
  input: FinalizerInput,
  effects: FinalizerEffects,
): Promise<FinalizerResult> {
  if (input.mode === 'gated-merge') {
    return runGatedMerge(input, effects);
  }

  const { phases, record } = makeRecorder(effects);

  // Classify on work product (wraps finalizeWorkRun, incl. forensics).
  const terminalEvent = await effects.classify();
  record('classified');

  // Flush the durable transcript before the summary/index/terminal writes so
  // every buffered event is on disk first.
  await effects.flushTranscript();
  record('transcript-flushed');

  effects.writeSummary(terminalEvent);
  record('summary-written');

  effects.appendIndexRow(terminalEvent);
  record('index-appended');

  // Hold mode: remove the worktree per the existing non-merge policy (branch ref
  // left intact — no merge → no delete) and write the terminal supervision
  // status through the shared tail. `merged`/`branchDeleted` are always false
  // (no `onBranchDelete` callback).
  return resolveWorktreeAndFinalize(input, effects, terminalEvent, record, phases, false);
}

/**
 * `gated-merge` mode (P1.5): the policy path that lands a clean, complete run on
 * the base branch through the hard gate. Sequence (fresh run):
 *
 *   classify → flush → gate → merge → mark project Done → summary → index → push → delete → terminal
 *
 * recording `merged-not-pushed` immediately after the merge, then
 * `project-marked-done` before summary/index persistence, and
 * `pushed-not-deleted` after the push
 * so a crash mid-finalize resumes at the right step (push happens BEFORE
 * delete — origin is the durable backup before the local branch is removed). A
 * failed gate STOPS at `branch-complete`: it alerts and never touches the base
 * branch. A non-`branch-complete` run never consults the gate.
 *
 * Resume: `readLastPhase()` is consulted so an already-committed step is skipped
 * — never a re-merge of an already-merged branch, a double-push, or a duplicate
 * index-row append.
 */
async function runGatedMerge(
  input: FinalizerInput,
  effects: FinalizerEffects,
): Promise<FinalizerResult> {
  const { gate, mergeBranch, pushBranch, deleteBranch, alert } = effects;
  // `alert` is required too: a gate-fail MUST notify the operator that a
  // branch-complete run was held off `main` — a silently-dropped alert would
  // leave a held run invisible. (`deleteBranch` must be idempotent: a resume
  // from `pushed-not-deleted` re-invokes it since there is no post-delete phase.)
  if (!gate || !mergeBranch || !pushBranch || !deleteBranch || !alert) {
    throw new Error(
      'gated-merge mode requires the gate, alert, mergeBranch, pushBranch, and deleteBranch effects',
    );
  }

  const { phases, record } = makeRecorder(effects);
  const lastPhase = effects.readLastPhase();
  const reached = (phase: FinalizerPhase): boolean =>
    lastPhase !== null && PHASE_ORDER.indexOf(lastPhase) >= PHASE_ORDER.indexOf(phase);
  const completed = (phase: FinalizerPhase): boolean => reached(phase) || phases.includes(phase);

  // Prologue. `classify()` is ALWAYS re-run — it returns the in-memory terminal
  // event every downstream step needs (it is not persisted), so it is exempt
  // from the resume skip; the `reached()` guards below skip only the durable
  // side-effects (notably the append-only index row) a prior attempt committed.
  const terminalEvent = await effects.classify();
  if (!reached('classified')) record('classified');
  if (!reached('transcript-flushed')) {
    await effects.flushTranscript();
    record('transcript-flushed');
  }

  const outcome = readOutcome(terminalEvent);
  let merged = false;
  let gateAllowedBranchComplete = false;
  let mergeConflictHold = false;

  if (outcome === 'branch-complete') {
    if (reached('merged-not-pushed')) {
      // A prior attempt already merged — NEVER re-merge (exactly-once).
      merged = true;
      gateAllowedBranchComplete = true;
    } else if (isPreMergeHoldTerminal(terminalEvent)) {
      // A terminal that already carries a hold signal (for example an open
      // non-reversible high/critical finding from the severity loop) is
      // branch-complete work, but it is not merge-bound and must not flip
      // docs/projects/index.md to Done. This guard is pre-merge only: once a
      // prior attempt recorded `merged-not-pushed`, recovery must finish the
      // push/delete sequence.
      return writeOperationalHoldTerminal(effects, terminalEvent, phases);
    } else {
      const gateThroughMerge = async () => {
        const verdict = await gate();
        if (verdict.ok === true) {
          gateAllowedBranchComplete = true;
          try {
            await mergeBranch();
          } catch (err) {
            if (!isMergeConflictError(err)) {
              throw err;
            }
            await abortConflictedMerge(input, effects);
            alert('merge-conflict');
            mergeConflictHold = true;
            return;
          }
          record('merged-not-pushed');
          merged = true;
        } else {
          // Gate refused — STOP at branch-complete: alert, never touch the base.
          alert(verdict.reason);
        }
      };
      if (effects.baseBranchCriticalSection) {
        await effects.baseBranchCriticalSection(gateThroughMerge);
      } else {
        await gateThroughMerge();
      }
    }
  }

  if (mergeConflictHold) {
    return writeOperationalHoldTerminal(effects, terminalEvent, phases);
  }

  if (outcome === 'branch-complete' && merged) {
    const shouldMarkProjectDone = !reached('project-marked-done') && !isPreMergeHoldTerminal(terminalEvent);
    const markProjectDoneResult = shouldMarkProjectDone
      ? await effects.markProjectDone?.(input, terminalEvent)
      : undefined;
    if (markProjectDoneResult?.kind === 'ambiguous') {
      return writeOperationalHoldTerminal(effects, terminalEvent, phases, { merged });
    }

    const projectDoneCommitted = markProjectDoneResult?.kind === 'committed';
    if (projectDoneCommitted) {
      refreshWorkProductForProjectDoneCommit(terminalEvent, markProjectDoneResult);
    }
    if (shouldMarkProjectDone && (projectDoneCommitted || !markProjectDoneResult)) {
      record('project-marked-done');
    }
    if (!completed('summary-written')) {
      effects.writeSummary(terminalEvent);
      record('summary-written');
    }
    if (!completed('index-appended')) {
      effects.appendIndexRow(terminalEvent);
      record('index-appended');
    }
  }

  if (!gateAllowedBranchComplete) {
    if (!completed('summary-written')) {
      effects.writeSummary(terminalEvent);
      record('summary-written');
    }
    if (!completed('index-appended')) {
      effects.appendIndexRow(terminalEvent);
      record('index-appended');
    }
  }

  // Push BEFORE delete: origin is the durable backup before the local branch
  // ref is removed. Skip the push on resume if it already landed. The branch
  // DELETE itself is deferred to the shared tail (after worktree removal) so
  // `git branch -d` doesn't trip on the still-checked-out run worktree.
  if (merged && !reached('pushed-not-deleted')) {
    await pushBranch();
    record('pushed-not-deleted');
  }

  // The shared tail removes the worktree, THEN deletes the branch (only when the
  // merge landed), then writes the terminal. `deleteBranch` is best-effort.
  return resolveWorktreeAndFinalize(
    input,
    effects,
    terminalEvent,
    record,
    phases,
    merged,
    merged ? deleteBranch : undefined,
  );
}
