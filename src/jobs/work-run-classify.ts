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
 * The pure cores are implemented; the remaining Phase 2 work is wiring them
 * into `work-runner.apply()` (compute facts from the worktree + run
 * finalizeWorkRun) and `startApply` (copy outcome onto the descriptor before
 * persist via applyOutcomeToDescriptor).
 */

import type { GitRunner } from './sandbox-runtime.js';
import type { MutationDescriptor, MutationEvent } from '../transport/mutations.js';
import { scrubPathsInText } from '../ai/tool-labels.js';

/** Cap on the persisted/broadcast diffstat string so a pathological diff can't
 *  balloon mutations.jsonl or a bus frame. */
const DIFFSTAT_MAX_CHARS = 4000;

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

/**
 * Parse a tasks.md body into checkbox records. Non-checkbox lines are ignored.
 * `[x]` and `[X]` both parse as checked.
 */
const TASK_LINE = /^(\s*)[-*]\s+\[([ xX])\]\s*(.*)$/;

export function parseTasks(content: string): TaskRecord[] {
  const records: TaskRecord[] = [];
  for (const line of content.split('\n')) {
    const m = TASK_LINE.exec(line);
    if (!m) continue;
    const checked = m[2]!.toLowerCase() === 'x';
    records.push({
      indent: m[1]!.length,
      marker: checked ? 'x' : ' ',
      // Normalize for stable cross-version comparison (case + whitespace).
      normalizedText: m[3]!.trim().toLowerCase().replace(/\s+/g, ' '),
      checked,
    });
  }
  return records;
}

/**
 * Compute task transitions between the in-memory baseline (captured at spawn)
 * and the final tasks.md. Keyed on normalized text so a deleted or rewritten
 * task counts as removed/added, never as progress. An absent tasks.md (empty
 * string) yields all-zero transitions. `tasksRemaining` counts only tasks that
 * started unchecked and are still unchecked (a regressed baseline-checked task
 * is not "remaining original work").
 *
 * Limitation: keyed by normalized text, so duplicate identical task lines in a
 * single file collapse (last-wins) and may be miscounted. Well-authored
 * tasks.md files do not repeat task text; deduping is out of scope.
 */
export function computeTaskTransitions(baseline: string, final: string): TaskTransitions {
  const base = parseTasks(baseline);
  const fin = parseTasks(final);
  const finByText = new Map(fin.map(t => [t.normalizedText, t]));
  const baseTexts = new Set(base.map(t => t.normalizedText));

  let tasksNewlyChecked = 0;
  let tasksRemaining = 0;
  let tasksRemoved = 0;
  for (const b of base) {
    const f = finByText.get(b.normalizedText);
    if (!f) {
      // Original task gone from the final file — removed/rewritten, not progress.
      tasksRemoved++;
      continue;
    }
    if (!b.checked && f.checked) tasksNewlyChecked++;
    if (!b.checked && !f.checked) tasksRemaining++; // started unchecked, still unchecked
  }

  let tasksAdded = 0;
  for (const f of fin) {
    if (!baseTexts.has(f.normalizedText)) tasksAdded++;
  }

  return { tasksNewlyChecked, tasksRemaining, tasksAdded, tasksRemoved };
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
export async function computeWorkProduct(opts: ComputeWorkProductOpts): Promise<WorkProductFacts> {
  const { runGit, cwd, baseSha, branch, baselineTasks, finalTasks } = opts;
  const range = `${baseSha}..${branch}`;

  const shaOut = await runGit(['rev-list', range], { cwd });
  const commitShas = shaOut.stdout.split('\n').map(s => s.trim()).filter(Boolean);
  const commitCount = commitShas.length; // === `rev-list --count`, without the extra call

  const statOut = await runGit(['diff', '--stat', range], { cwd });
  const diffstat = statOut.stdout.trim().slice(0, DIFFSTAT_MAX_CHARS);
  // Per-file lines in --stat look like `path | 12 ++--`; the summary line
  // (`N files changed`) has no `|`, so filter on it.
  const filesChanged = diffstat
    .split('\n')
    .filter(l => l.includes('|'))
    .map(l => l.split('|')[0]!.trim())
    .filter(Boolean);

  const statusOut = await runGit(['status', '--porcelain'], { cwd });
  let dirty = false;
  let untracked = false;
  for (const line of statusOut.stdout.split('\n')) {
    if (line.length === 0) continue;
    if (line.startsWith('??')) untracked = true;
    else dirty = true; // any tracked-change status code (M/A/D/R/…)
  }

  return {
    commitCount,
    commitShas,
    filesChanged,
    diffstat,
    dirty,
    untracked,
    transitions: computeTaskTransitions(baselineTasks, finalTasks),
  };
}

/**
 * Pure terminal classifier (spec requirements 3-7):
 *  - non-zero/signal exit -> `failed` (reason: cancelled / killed / exited with code N)
 *  - exit 0 + commits + no original tasks remain -> `branch-complete`
 *  - exit 0 + commits + unchecked tasks remain -> `partial`
 *  - exit 0 + zero commits + zero transitions + clean tree -> `noop`
 *  - exit 0 + zero commits + dirty/untracked tree -> `dirty-uncommitted`
 */
export function classifyOutcome(facts: ClassifyFacts): ClassifyResult {
  const { exit, product } = facts;

  // Rule 7: non-zero / signal-killed → failed (cancelled wins over killed).
  if (exit.cancelled) return { outcome: 'failed', reason: 'cancelled' };
  if (exit.signal) return { outcome: 'failed', reason: `killed (signal ${exit.signal})` };
  if (exit.exitCode === null) return { outcome: 'failed', reason: 'no exit code (process disappeared)' };
  if (exit.exitCode !== 0) {
    return { outcome: 'failed', reason: `exited with code ${String(exit.exitCode)}` };
  }

  // Exit 0 — classify on work product.
  const { commitCount, dirty, untracked, transitions } = product;
  if (commitCount > 0) {
    // Rules 3-4: commits present → branch-complete iff no original task remains.
    return transitions.tasksRemaining > 0
      ? { outcome: 'partial', reason: `${commitCount} commit(s), ${transitions.tasksRemaining} task(s) still unchecked` }
      : { outcome: 'branch-complete', reason: `${commitCount} commit(s), all original tasks checked` };
  }
  // Zero commits.
  if (dirty || untracked) {
    return { outcome: 'dirty-uncommitted', reason: 'no commits but the working tree is dirty/untracked' };
  }
  // Rule 5: zero commits, zero transitions, clean tree — did nothing.
  return { outcome: 'noop', reason: 'no commits, no task transitions, clean tree' };
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
export async function finalizeWorkRun(deps: FinalizeWorkRunDeps): Promise<MutationEvent> {
  const { mutationId, computeFacts, exportForensics } = deps;
  try {
    const facts = await computeFacts();
    const { outcome, reason } = classifyOutcome(facts);
    // Best-effort forensics — a failure here must not deny the terminal event.
    try {
      await exportForensics(facts);
    } catch {
      /* swallow — forensics are best-effort */
    }
    const kind: MutationEvent['kind'] = outcome === 'failed' ? 'failed' : 'completed';
    return {
      mutationId,
      ts: new Date().toISOString(),
      kind,
      // `exit` rides along (req 9: exitCode/signal/durationMs reach the store).
      data: { outcome, reason, workProduct: facts.product, exit: facts.exit },
    };
  } catch (err) {
    // classify/forensics threw → export best-effort with null facts and emit a
    // single terminal failed/classification-error event. Never re-throw: the
    // caller must always get exactly one terminal event.
    try {
      await exportForensics(null);
    } catch {
      /* swallow — forensics are best-effort */
    }
    // Scrub absolute host paths from the raw error — this reason flows to
    // Telegram and mutations.jsonl, and a git/worktree error can embed the
    // worktree path (which encodes the host username).
    const reason = scrubPathsInText(`classification-error: ${(err as Error).message}`);
    return {
      mutationId,
      ts: new Date().toISOString(),
      kind: 'failed',
      data: { outcome: 'failed', reason },
    };
  }
}

/**
 * Copy the typed `outcome` + `workProduct` off a terminal event onto the
 * descriptor before `appendMutationLine`, mirroring `startApply`'s terminal
 * write — otherwise the classification is dropped on persist and never reaches
 * mutations.jsonl, the cockpit, Telegram, the index, or GC.
 */
export function applyOutcomeToDescriptor(
  descriptor: MutationDescriptor & WorkRunOutcomeFields,
  event: MutationEvent,
): void {
  const data = (event.data ?? {}) as Record<string, unknown>;
  if (typeof data['outcome'] === 'string') {
    descriptor.outcome = data['outcome'] as WorkOutcome;
  }
  if (data['workProduct'] !== undefined) {
    descriptor.workProduct = data['workProduct'] as WorkProductFacts;
  }
  // descriptor.status is deliberately untouched — the verdict rides on
  // `outcome`; status stays within its fixed enum (set by startApply).
}
