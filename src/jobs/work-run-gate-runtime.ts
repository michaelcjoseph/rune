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

import { spawn } from 'node:child_process';
import { defaultRunGit, type GitRunner } from './sandbox-runtime.js';
// Import `GateResult` from the gate module (its canonical home), NOT the
// finalizer — the finalizer imports `runGate` from here once P1.5 lands, so
// pulling the type from the finalizer would form an import cycle.
import { evaluateGate, type GateFacts, type GateResult } from './work-run-gate.js';
import { registerActiveProcess, unregisterActiveProcess } from '../ai/claude.js';
import { createLogger } from '../utils/logger.js';
import { scrubAbsolutePaths } from '../utils/sanitize-paths.js';
import { redactSecrets } from './work-run-transcript.js';
import config from '../config.js';

const log = createLogger('work-run-gate-runtime');

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
  /** The feature/work branch (e.g. `rune-work/15-…`). */
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
 *
 * SECURITY (P1.5, hard requirement): `validationCommands` entries come from
 * `policies/products.json` and become EXECUTED shell commands here, so the spawn
 * MUST use `execFile`/`spawn` with an argv array and NEVER a shell string
 * (`exec`/`execSync` or `spawn(..., { shell: true })`). A shell spawn would turn
 * any metacharacter in a product's command (`;`, `&&`, `|`, `$(…)`, backticks,
 * redirects) into injection — and the scaffold-approval pipeline can now write
 * products.json at runtime, so this is not purely a hand-edited-config threat.
 * Treat each command as `[argv0, ...args]` (split, or move the JSON schema to
 * pre-split `string[][]`); reject metacharacters at the parse boundary.
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
 * Production validation-command executor: spawn the command in `cwd` with NO
 * shell (argv array — injection-safe by construction; a `;`/`|`/`$()` in a
 * command becomes a literal argument, never a shell operator), bounded by
 * `timeoutMs`. The child is spawned `detached` into its own process group and a
 * timeout reaps the WHOLE group (SIGTERM → SIGKILL after the reap grace) so a
 * command that forks (e.g. `npm` → `node`) can't outlive its budget. Registered
 * with the active-process registry so a graceful Rune shutdown reaps it too.
 */
function defaultRunValidationCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
): Promise<ValidationCommandResult> {
  return new Promise<ValidationCommandResult>((resolve) => {
    const [bin, ...args] = command.trim().split(/\s+/);
    if (!bin) {
      // An empty command can't pass — treat as a non-zero (red) result.
      resolve({ exitCode: 1, timedOut: false });
      return;
    }
    const child = spawn(bin, args, { cwd, stdio: ['ignore', 'ignore', 'ignore'], detached: true });
    registerActiveProcess(child);

    let timedOut = false;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;
    const killGroup = (signal: NodeJS.Signals): void => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, signal); // negative pid → the whole process group
      } catch {
        /* group already gone */
      }
    };
    // unref'd so a validation command in flight during a graceful Rune
    // shutdown can't hold the process alive for the full timeout window.
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup('SIGTERM');
      killTimer = setTimeout(() => killGroup('SIGKILL'), config.WORK_RUN_REAP_GRACE_MS);
      killTimer.unref();
    }, timeoutMs);
    timer.unref();

    const finish = (exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      unregisterActiveProcess(child);
      resolve({ exitCode, timedOut });
    };
    // `close` (not `exit`) for parity with the spawn pattern elsewhere — safe
    // with `stdio: 'ignore'` and defensively correct if stdio is ever piped.
    child.on('close', (code) => finish(code));
    child.on('error', () => finish(null));
  });
}

export type ValidationCommandListResult =
  | { ok: true }
  | { ok: false; command: string; result: ValidationCommandResult };

/**
 * Run a product validation command list in `cwd`, stopping at the first failed
 * or timed-out command. An empty list is a pass for callers that intentionally
 * allow "no task-scoped checks"; the merge gate still fail-closes on missing
 * commands before it calls into this helper.
 */
export async function runValidationCommands(
  commands: readonly string[],
  cwd: string,
  timeoutMs: number,
  runValidationCommand: GateRuntimeIO['runValidationCommand'] = defaultRunValidationCommand,
): Promise<ValidationCommandListResult> {
  for (const command of commands) {
    const result = await runValidationCommand(command, cwd, timeoutMs);
    if (result.timedOut || result.exitCode !== 0) {
      return { ok: false, command, result };
    }
  }
  return { ok: true };
}

const defaultGateRuntimeIO = (): GateRuntimeIO => ({
  runGit: defaultRunGit,
  runValidationCommand: defaultRunValidationCommand,
});

/**
 * Gather the gate's facts in an integration worktree and decide via
 * `evaluateGate`. The product repo's `baseBranch` is never mutated here — a red
 * result leaves local `main` byte-for-byte unchanged (req 13).
 *
 * Flow: create a DETACHED integration worktree at `baseBranch`'s commit
 * (`--detach` avoids git's "branch already checked out" refusal since the
 * product repo has `baseBranch` checked out) → dry-merge the feature branch into
 * it to probe for a conflict → if clean, check the merged tree is clean and run
 * each validation command in the integration worktree → assemble `GateFacts` and
 * decide. The throwaway worktree is always torn down in `finally`, so a red gate
 * or a thrown git/validation error never leaks it.
 *
 * @precondition The caller MUST hold the per-product/per-base-branch merge lock
 * (`withBaseBranchLock`, work-run-merge-lock.ts) — two concurrent `runGate`s for
 * the same product would collide on the integration worktree path / base branch.
 * `runGate` does not acquire the lock itself; `concurrentRun` is a pre-gathered
 * fact, not the lock.
 */
export async function runGate(
  opts: GateRuntimeOpts,
  io: GateRuntimeIO = defaultGateRuntimeIO(),
): Promise<GateResult> {
  const { runGit, runValidationCommand } = io;
  const hasValidationCommands = opts.validationCommands.length > 0;

  // Create the throwaway integration worktree in DETACHED HEAD at baseBranch.
  // Inside the try so a partial `worktree add` failure still hits the finally
  // teardown (git can leave a half-initialized dir on some failures).
  let worktreeCreated = false;
  try {
    await runGit(['worktree', 'add', '--detach', opts.integrationWorktree, opts.baseBranch], {
      cwd: opts.repoPath,
    });
    worktreeCreated = true;

    let mergeConflict = false;
    let treeClean = true;
    let testsGreen = true;
    let validationTimedOut = false;

    // Conflict probe: merge the feature branch into the detached integration
    // worktree. A conflict (or ANY merge error — fail-closed) → mergeConflict;
    // abort to leave the worktree clean for teardown. This NEVER touches the
    // product repo's real baseBranch checkout — the merge runs in the
    // integration worktree.
    try {
      await runGit(['merge', '--no-ff', '-m', 'work-run gate integration merge', opts.branch], {
        cwd: opts.integrationWorktree,
      });
    } catch (err) {
      mergeConflict = true;
      // Log the (scrubbed) git stderr so a non-conflict cause (e.g. a missing
      // branch ref) is diagnosable rather than silently labelled a conflict —
      // the gate still fails closed either way (no merge).
      log.warn('gate merge probe failed; treating as merge-conflict (fail-closed)', {
        product: opts.product,
        branch: opts.branch,
        error: redactSecrets(scrubAbsolutePaths((err as Error).message)),
      });
      await runGit(['merge', '--abort'], { cwd: opts.integrationWorktree }).catch(() => {
        /* nothing to abort / already clean */
      });
    }

    if (!mergeConflict) {
      // Tree must be clean after a committed merge (before validation runs, so
      // build artifacts can't dirty this check).
      const status = await runGit(['status', '--porcelain'], { cwd: opts.integrationWorktree });
      treeClean = status.stdout.trim() === '';

      // Run validation commands in the integration worktree. testsGreen = all
      // exited 0; validationTimedOut = the first red command exceeded budget.
      const validation = await runValidationCommands(
        opts.validationCommands,
        opts.integrationWorktree,
        opts.commandTimeoutMs,
        runValidationCommand,
      );
      if (!validation.ok) {
        validationTimedOut = validation.result.timedOut;
        testsGreen = validation.result.exitCode === 0 && !validation.result.timedOut;
      }
    }

    const facts: GateFacts = {
      hasValidationCommands,
      concurrentRun: opts.concurrentRun,
      tasksRemaining: opts.tasksRemaining,
      treeClean,
      testsGreen,
      validationTimedOut,
      mergeConflict,
    };
    return evaluateGate(facts);
  } finally {
    // Always tear down the throwaway worktree — best-effort, never throws out of
    // the finally (a teardown failure must not mask the gate result). Skip if
    // `worktree add` itself failed (nothing to remove).
    if (worktreeCreated) {
      await runGit(['worktree', 'remove', '--force', opts.integrationWorktree], {
        cwd: opts.repoPath,
      }).catch((err) => {
        log.warn('integration worktree teardown failed', {
          product: opts.product,
          error: redactSecrets(scrubAbsolutePaths((err as Error).message)),
        });
      });
    }
  }
}
