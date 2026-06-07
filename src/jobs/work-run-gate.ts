/**
 * The hard merge gate (project 15, P1.5) — the line between "autonomous" and
 * "lands broken work on `main`". A gated-merge run merges ONLY if every gate
 * condition holds; otherwise the finalizer stops at `branch-complete` and
 * alerts (see `work-run-finalizer.ts`).
 *
 * `evaluateGate` is the PURE decision core: it takes already-gathered facts and
 * returns the first failure (ordered gates, first-failure-wins) or `{ ok: true }`.
 * Gathering the facts — running the product's `validationCommands` in an
 * integration worktree (so a red check never alters local `main`), checking the
 * per-product/per-base-branch concurrency lock, computing tasksRemaining / tree
 * state / merge-conflict — is the runtime's job (the P1.5 impl), kept out of this
 * pure function so the precedence is testable on fixtures.
 *
 * Fail-closed: a product with no `validationCommands` fails the gate with
 * `missing-validation-command` (req 16) — never an unverified merge.
 *
 * SCAFFOLD — `evaluateGate` throws until the P1.5 implementation task.
 */

import type { GateResult } from './work-run-finalizer.js';

/** The facts the gate decides on, gathered by the runtime before `evaluateGate`. */
export interface GateFacts {
  /** The product declares `validationCommands` in policies/products.json. */
  hasValidationCommands: boolean;
  /** Another run owns the same product / base branch right now. */
  concurrentRun: boolean;
  /** Original tasks still unchecked (must be 0 to merge). */
  tasksRemaining: number;
  /** The integration worktree's tree is clean (no uncommitted changes). */
  treeClean: boolean;
  /** Every validation command exited 0. */
  testsGreen: boolean;
  /** A validation command exceeded WORK_RUN_GATE_COMMAND_TIMEOUT_MS. */
  validationTimedOut: boolean;
  /** Merging the branch onto the base conflicts / the base relationship is unsound. */
  mergeConflict: boolean;
}

/**
 * Decide the gate on `facts`, ordered so the FIRST failure wins. Cheap
 * structural checks precede the expensive validation result, so a run that
 * can't possibly merge never burns a validation run:
 *
 *   missing-validation-command  (fail-closed — can't even run the gate, req 16)
 *   → concurrent-run            (another run owns the base branch — bail early)
 *   → merge-conflict            (conflict probe — validating pre-merge code is
 *                                meaningless and the integration worktree can't
 *                                be set up cleanly anyway, req 13)
 *   → tasks-remaining           (work product incomplete)
 *   → dirty-tree                (uncommitted changes)
 *   → validation-timeout        (a validation command ran too long)
 *   → tests-red                 (a validation command exited non-zero)
 *
 * `mergeConflict` is a pre-gathered dry-run PROBE result; the actual `git merge`
 * mutation happens in the finalizer AFTER this gate passes, not here.
 * SCAFFOLD — throws until P1.5.
 */
export function evaluateGate(_facts: GateFacts): GateResult {
  throw new Error('work-run-gate: evaluateGate not implemented (project 15 P1.5 pending)');
}
