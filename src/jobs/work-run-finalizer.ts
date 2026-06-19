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

import type { MutationEvent } from '../transport/mutations.js';
import type { WorkOutcome, WorkProductFacts } from './work-run-classify.js';
import type { GateFailReason, GateResult } from './work-run-gate.js';
import { createLogger } from '../utils/logger.js';
import { scrubAbsolutePaths } from '../utils/sanitize-paths.js';

const log = createLogger('work-run-finalizer');

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
  /** `git merge --no-ff <branch>` onto the base branch (in an integration
   *  worktree / on the base). */
  mergeBranch?: () => Promise<void>;
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
  'project-marked-done',
  'summary-written',
  'index-appended',
  'merged-not-pushed',
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
  if (matchingRows === 0 && matchingHeadings === 0) {
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
 *   classify → flush → mark project Done → gate → summary → index → merge → push → delete → terminal
 *
 * recording `project-marked-done` before summary/index persistence,
 * `merged-not-pushed` after the merge, and `pushed-not-deleted` after the push
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

  // Only a branch-complete run is eligible to land on the base branch; anything
  // else (partial/noop/dirty/failed) never merges and never consults the gate.
  if (outcome === 'branch-complete') {
    if (reached('merged-not-pushed')) {
      // A prior attempt already merged — NEVER re-merge (exactly-once).
      merged = true;
      gateAllowedBranchComplete = true;
    } else {
      const shouldMarkProjectDone = !reached('project-marked-done');
      let markProjectDoneResult: MarkProjectDoneResult | undefined;
      if (shouldMarkProjectDone) {
        markProjectDoneResult = await effects.markProjectDone?.(input, terminalEvent);
      }
      refreshWorkProductForProjectDoneCommit(terminalEvent, markProjectDoneResult);
      if (markProjectDoneResult?.kind === 'ambiguous') {
        const supervisionStatus: FinalizerSupervisionStatus =
          terminalEvent.kind === 'completed' ? 'completed' : 'failed';
        return {
          outcome,
          terminalEvent,
          supervisionStatus,
          worktreeRemoved: false,
          merged: false,
          branchDeleted: false,
          phases,
        };
      }

      const verdict = await gate();
      if (verdict.ok === true) {
        gateAllowedBranchComplete = true;
        if (shouldMarkProjectDone && markProjectDoneResult?.kind !== 'skipped') {
          record('project-marked-done');
        }
        if (!reached('summary-written')) {
          effects.writeSummary(terminalEvent);
          record('summary-written');
        }
        if (!reached('index-appended')) {
          effects.appendIndexRow(terminalEvent);
          record('index-appended');
        }
        await mergeBranch();
        record('merged-not-pushed');
        merged = true;
      } else {
        // Gate refused — STOP at branch-complete: alert, never touch the base.
        alert(verdict.reason);
      }
    }
  }

  if (!gateAllowedBranchComplete) {
    if (!reached('summary-written')) {
      effects.writeSummary(terminalEvent);
      record('summary-written');
    }
    if (!reached('index-appended')) {
      effects.appendIndexRow(terminalEvent);
      record('index-appended');
    }
  } else if (reached('merged-not-pushed')) {
    if (!reached('summary-written')) {
      effects.writeSummary(terminalEvent);
      record('summary-written');
    }
    if (!reached('index-appended')) {
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
