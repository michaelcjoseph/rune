/**
 * The hard merge gate's RUNTIME (project 15, P1.5) — the fact-gathering half of
 * the gate that `evaluateGate` (work-run-gate.ts) decides on.
 *
 * The pure decision lives in `evaluateGate`; gathering the facts it needs is
 * effectful and is this module's job:
 *
 *   - set up a THROWAWAY integration worktree checked out on the base branch
 *     (never the product's real `baseBranch` checkout / local `main`),
 *   - dry-run-merge the feature branch into it to probe for a conflict,
 *   - run the product's `validationCommands` in that integration worktree
 *     (each bounded by `WORK_RUN_GATE_COMMAND_TIMEOUT_MS`),
 *   - fold in the pre-gathered structural facts (tasksRemaining, concurrent-run
 *     lock state),
 *   - tear the integration worktree down,
 *   - and hand the assembled `GateFacts` to `evaluateGate`.
 *
 * THE CORE INVARIANT (spec req 13, test-plan §6 "test before mutating main"):
 * everything the gate touches happens in the integration worktree, so a RED gate
 * result leaves the product repo's `baseBranch` ref AND working tree
 * byte-for-byte unchanged. The actual `git merge` that lands the work onto the
 * base branch happens in `work-run-finalizer.ts` ONLY AFTER this gate returns
 * `{ ok: true }`.
 *
 * Fail-closed: a product with no `validationCommands` never reaches the
 * integration-worktree validation run — `evaluateGate` returns
 * `missing-validation-command` (req 16).
 *
 * SCAFFOLD — `runGate` throws until the P1.5 implementation task (tasks.md
 * "Run the gate's checks in an integration worktree …"). The contract is pinned
 * test-first by `work-run-gate-runtime.test.ts` (test-plan §6).
 */

import type { GitRunner } from './sandbox-runtime.js';
// Import `GateResult` from the gate module (its canonical home), NOT the
// finalizer — the finalizer imports `runGate` from here once P1.5 lands, so
// pulling the type from the finalizer would form an import cycle.
import type { GateResult } from './work-run-gate.js';

/**
 * Everything the gate runtime needs to gather facts. Structural facts that are
 * computed elsewhere (the work-product task tally, the per-product/per-base
 * concurrency lock) are passed in so this runtime owns only the
 * integration-worktree validation + conflict probe.
 */
export interface GateRuntimeOpts {
  product: string;
  /** The product repo whose `baseBranch` must stay byte-for-byte unchanged. */
  repoPath: string;
  /** The base branch the run would land on (e.g. `main`). */
  baseBranch: string;
  /** The feature/work branch (e.g. `jarvis-work/15-…`). */
  branch: string;
  /** Path for the throwaway integration worktree — created here, torn down here,
   *  never the product's real base-branch checkout. */
  integrationWorktree: string;
  /** Product `validationCommands` from policies/products.json. Empty/absent →
   *  fail-closed `missing-validation-command`. */
  validationCommands: string[];
  /** Original tasks still unchecked (computed from the work product). */
  tasksRemaining: number;
  /** Another run owns the same product / base branch right now (lock state). */
  concurrentRun: boolean;
  /** Per-command budget (WORK_RUN_GATE_COMMAND_TIMEOUT_MS). */
  commandTimeoutMs: number;
}

/** Result of one validation command run in the integration worktree. */
export interface ValidationCommandResult {
  /** Process exit code, or null if it was killed (e.g. on timeout). */
  exitCode: number | null;
  /** The command exceeded `commandTimeoutMs` and its process tree was reaped. */
  timedOut: boolean;
}

/**
 * Injected side-effects so the runtime is testable without the real `git` CLI
 * or arbitrary shell commands. Production wires `defaultRunGit` + a real
 * timeout-bounded, process-group-reaping command runner. A full optional
 * interface (mirroring `FinalizerEffects` / `SweepIO` etc.) — `runGate` defaults
 * to a concrete production `GateRuntimeIO` when `io` is omitted, rather than
 * defaulting field-by-field.
 *
 * IMPL OBLIGATION (P1.5): the production `runValidationCommand` spawns a real
 * child process, so it MUST register/unregister it via
 * `registerActiveProcess`/`unregisterActiveProcess` (src/ai/claude.ts) — the
 * same contract `gen-eval-loop-runner` and `work-runner` honor — so a validation
 * command in flight during a graceful shutdown is reaped, not orphaned. On
 * timeout it reaps the command's process tree and returns `{ timedOut: true }`.
 */
export interface GateRuntimeIO {
  runGit: GitRunner;
  /** Run one validation command in `cwd`, bounded by `timeoutMs`; on timeout the
   *  command's process tree is reaped and `{ timedOut: true }` returned. */
  runValidationCommand: (
    command: string,
    cwd: string,
    timeoutMs: number,
  ) => Promise<ValidationCommandResult>;
}

/**
 * Gather the gate's facts in an integration worktree and decide via
 * `evaluateGate`. The product repo's `baseBranch` is never mutated here — a red
 * result leaves local `main` byte-for-byte unchanged (req 13).
 *
 * IMPL OBLIGATION (P1.5): the integration worktree is created AND torn down
 * inside this call under a `try/finally`, so a thrown validation/git error (or
 * a red gate) never leaks the throwaway worktree. SCAFFOLD — throws until P1.5.
 */
export async function runGate(
  _opts: GateRuntimeOpts,
  _io?: GateRuntimeIO,
): Promise<GateResult> {
  throw new Error('work-run-gate-runtime: runGate not implemented (project 15 P1.5 pending)');
}
