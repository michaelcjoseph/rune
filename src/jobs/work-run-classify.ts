/**
 * Work-run terminal classification (project 11, Phase 2 — "Terminal
 * classification + run store").
 *
 * The whole point of project 11: classify a work run on its WORK PRODUCT
 * (commits + tasks.md delta + working-tree state), not its exit code, so a run
 * that exits 0 while doing nothing is caught as `noop` instead of reported as
 * success. Everything here is pure / injectable so the rules are testable on
 * fixtures with no real git or worktree (see the spec's "Test seams" section):
 *
 *   - `parseTasks` / `computeTaskTransitions` — tasks.md delta on the ORIGINAL
 *     task set (so a deleted/rewritten task is added/removed, never progress).
 *   - `computeWorkProduct` — all work-product git through an injected
 *     `GitRunner` (rev-list/diff/status), never a direct spawn.
 *   - `classifyOutcome` — pure function over parsed facts (rules 3-7).
 *   - `finalizeWorkRun` — wraps classify+forensics so exactly ONE terminal
 *     outcome-bearing event always fires, even if classification throws.
 *   - `applyOutcomeToDescriptor` — copies the verdict off the terminal event
 *     onto the descriptor before persist, so it reaches mutations.jsonl.
 *
 * SCAFFOLD: signatures/types are settled here so the Phase 2 test suite
 * (`work-run-classify.test.ts`) can pin the contract test-first. Bodies are
 * unimplemented; the Phase 2 implementation tasks fill them in and wire them
 * into `work-runner.apply()` / `startApply`.
 */

import type { GitRunner } from './sandbox-runtime.js';
import type { MutationDescriptor, MutationEvent } from '../transport/mutations.js';

/** Terminal verdict, distinct from mutation `status` (which stays within its
 *  fixed enum). `noop` is the state that would have caught the two silent
 *  2026-05-30 runs. */
export type WorkOutcome = 'branch-complete' | 'partial' | 'noop' | 'dirty-uncommitted' | 'failed';

/** Process exit facts handed back by the (Phase 2) refactored `streamProcess`
 *  instead of a yielded terminal event. */
export interface ExitFacts {
  exitCode: number | null;
  signal: string | null;
  /** True when the run was cancelled by the user (SIGTERM via ctx.cancel). */
  cancelled: boolean;
  durationMs: number;
}

/** One parsed tasks.md checkbox line. Markers are normalized so `[x]` and
 *  `[X]` compare equal. */
export interface TaskRecord {
  indent: number;
  /** Normalized marker: `'x'` (checked) or `' '` (unchecked). */
  marker: string;
  /** Checkbox text, trimmed/normalized for stable cross-version comparison. */
  normalizedText: string;
  checked: boolean;
}

export interface TaskTransitions {
  /** Original (baseline) unchecked tasks that are now checked. */
  tasksNewlyChecked: number;
  /** Original tasks still unchecked in the final file. */
  tasksRemaining: number;
  /** Tasks present in the final file but absent from the baseline. */
  tasksAdded: number;
  /** Tasks present in the baseline but absent from the final file. */
  tasksRemoved: number;
}

export interface WorkProductFacts {
  commitCount: number;
  commitShas: string[];
  filesChanged: string[];
  diffstat: string;
  /** Tracked changes present (`git status --porcelain` non-empty), staged or unstaged. */
  dirty: boolean;
  /** Untracked files present. */
  untracked: boolean;
  transitions: TaskTransitions;
}

export interface ClassifyFacts {
  exit: ExitFacts;
  product: WorkProductFacts;
}

export interface ClassifyResult {
  outcome: WorkOutcome;
  reason: string;
}

/** Phase 2 adds these to `MutationDescriptor`; declared here as the contract
 *  the implementation task will graft on, so the copy helper can be typed and
 *  tested without editing `mutations.ts` in the test-first task. */
export interface WorkRunOutcomeFields {
  outcome?: WorkOutcome;
  workProduct?: WorkProductFacts;
}

function notImplemented(fn: string): never {
  throw new Error(`work-run-classify: ${fn} not implemented (project 11 Phase 2 pending)`);
}

/**
 * Parse a tasks.md body into checkbox records. Non-checkbox lines are ignored.
 * `[x]` and `[X]` both parse as checked.
 */
export function parseTasks(_content: string): TaskRecord[] {
  notImplemented('parseTasks');
}

/**
 * Compute task transitions between the in-memory baseline (captured at spawn)
 * and the final tasks.md. Keyed on normalized text so a deleted or rewritten
 * task counts as removed/added, never as progress. An absent tasks.md (empty
 * string) yields all-zero transitions.
 */
export function computeTaskTransitions(_baseline: string, _final: string): TaskTransitions {
  notImplemented('computeTaskTransitions');
}

export interface ComputeWorkProductOpts {
  /** Injected git runner — the same seam createWorktree/destroyWorktree take. */
  runGit: GitRunner;
  /** Worktree directory the git commands run in. */
  cwd: string;
  /** Captured base sha; the diff base is `baseSha..branch`, NOT `main`. */
  baseSha: string;
  branch: string;
  /** In-memory tasks.md captured at spawn (NOT a post-run re-read). */
  baselineTasks: string;
  /** Final tasks.md content read from the worktree after the run. */
  finalTasks: string;
}

/**
 * Compute work-product facts via the injected GitRunner: `rev-list --count`
 * and `rev-list` over `baseSha..branch` for commit count + shas, `diff --stat`
 * for diffstat/files, `status --porcelain` for dirty/untracked, plus the
 * tasks.md transitions. The diff base is the captured `baseSha`, so a moving
 * `HEAD` cannot change it.
 */
export function computeWorkProduct(_opts: ComputeWorkProductOpts): Promise<WorkProductFacts> {
  notImplemented('computeWorkProduct');
}

/**
 * Pure terminal classifier (spec requirements 3-7):
 *  - non-zero/signal exit -> `failed` (reason: cancelled / killed / exited with code N)
 *  - exit 0 + commits + no original tasks remain -> `branch-complete`
 *  - exit 0 + commits + unchecked tasks remain -> `partial`
 *  - exit 0 + zero commits + zero transitions + clean tree -> `noop`
 *  - exit 0 + zero commits + dirty/untracked tree -> `dirty-uncommitted`
 */
export function classifyOutcome(_facts: ClassifyFacts): ClassifyResult {
  notImplemented('classifyOutcome');
}

export interface FinalizeWorkRunDeps {
  mutationId: string;
  /** Computes the classify facts; may throw (worktree gone, git failure). */
  computeFacts: () => Promise<ClassifyFacts>;
  /** Best-effort forensics export, given the facts (or null if compute threw). */
  exportForensics: (facts: ClassifyFacts | null) => Promise<void>;
}

/**
 * Produce exactly ONE terminal outcome-bearing MutationEvent. Runs
 * `computeFacts` -> `classifyOutcome`, exports forensics, and returns a
 * `completed` event for branch-complete/partial/noop or `failed` otherwise,
 * carrying the typed `outcome` + work-product facts on `data`. If anything
 * throws, forensics are exported best-effort and a single terminal `failed`
 * event with reason `classification-error` is returned — so the error never
 * escapes to leave the run without a terminal event.
 */
export function finalizeWorkRun(_deps: FinalizeWorkRunDeps): Promise<MutationEvent> {
  notImplemented('finalizeWorkRun');
}

/**
 * Copy the typed `outcome` + `workProduct` off a terminal event onto the
 * descriptor before `appendMutationLine`, mirroring `startApply`'s terminal
 * write — otherwise the classification is dropped on persist and never reaches
 * mutations.jsonl, the cockpit, Telegram, the index, or GC.
 */
export function applyOutcomeToDescriptor(
  _descriptor: MutationDescriptor & WorkRunOutcomeFields,
  _event: MutationEvent,
): void {
  notImplemented('applyOutcomeToDescriptor');
}
