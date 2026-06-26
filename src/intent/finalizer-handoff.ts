/**
 * Finalizer handoff — the seam to Project 15 (project 14, Phase 3).
 *
 * When no unchecked tasks remain, Rune hands the completed project's branch /
 * run facts to the Project 15 finalizer through an INJECTED adapter. It never
 * implements its own merge: the finalizer owns terminal classification, the
 * gated merge, push, cleanup, and terminal writes. If the real finalizer is
 * unavailable at runtime, `runFinalizerHandoff` records the payload and STOPS in
 * a durable held (branch-complete/blocked) state — it does not self-merge as a
 * shortcut.
 *
 * The handoff payload mirrors Project 15's `FinalizerInput` (mode/runId/project/
 * product/branch/baseBranch) plus the task-level evidence the finalizer needs
 * for useful terminal summaries.
 *
 * Pure types + the adapter dispatch. The real adapter (wrapping Project 15's
 * `runFinalizer`) is wired in a later phase.
 */

import type { TaskRunRecord } from './orch-run-record.js';

export interface FinalizerHandoff {
  runId: string;
  project: string;
  product: string;
  /** The work branch (e.g. `rune-work/14-...`). */
  branch: string;
  /** The base branch a gated merge would land on. */
  baseBranch?: string;
  /** Per-task evidence for terminal summaries + forensics links. */
  taskRecords: TaskRunRecord[];
}

/** What the injected finalizer adapter returns. `unavailable` is the
 *  finalizer-not-wired signal that holds the run rather than self-merging. */
export type FinalizerAdapterResult =
  | { kind: 'finalized'; outcome: string }
  | { kind: 'unavailable'; reason: string };

/** Injected Project-15 finalizer. Tests pass a fixture; production wraps the
 *  real `runFinalizer`.
 *
 *  NOTE: `FinalizerHandoff` deliberately omits Project 15's `mode` field
 *  (`'hold' | 'gated-merge'`). Mode is the ADAPTER's decision, not the
 *  orchestrator's payload: the production adapter supplies `'gated-merge'` for a
 *  completed run (or `'hold'` to stop short) when it calls `runFinalizer`. Keep
 *  that obligation here so it isn't rediscovered as a type mismatch at wiring. */
export type FinalizerAdapter = (handoff: FinalizerHandoff) => Promise<FinalizerAdapterResult>;

export type RunFinalizerHandoffResult =
  | { kind: 'finalized'; outcome: string }
  | { kind: 'held'; reason: string; handoff: FinalizerHandoff };

/** Build a finalizer handoff payload, defensively copying the task records. */
export function buildFinalizerHandoff(input: FinalizerHandoff): FinalizerHandoff {
  return {
    runId: input.runId,
    project: input.project,
    product: input.product,
    branch: input.branch,
    ...(input.baseBranch !== undefined ? { baseBranch: input.baseBranch } : {}),
    taskRecords: [...input.taskRecords],
  };
}

/**
 * Dispatch the handoff to the injected finalizer. On `finalized`, surface the
 * terminal outcome. On `unavailable`, return a `held` result carrying the
 * preserved payload — the run stops branch-complete/blocked for a later retry,
 * never a self-merge.
 */
export async function runFinalizerHandoff(
  handoff: FinalizerHandoff,
  adapter: FinalizerAdapter,
): Promise<RunFinalizerHandoffResult> {
  const result = await adapter(handoff);
  if (result.kind === 'finalized') {
    return { kind: 'finalized', outcome: result.outcome };
  }
  return { kind: 'held', reason: result.reason, handoff };
}
