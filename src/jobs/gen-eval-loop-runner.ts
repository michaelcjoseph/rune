/**
 * Generator-Evaluator loop runner — Phase 6 A3.
 *
 * Per round: spawn `/work --auto` in the project's sandboxed worktree,
 * parse exit, spawn `/review` only when tests passed, record the round
 * via `recordRound`, decide via `evaluateLoop`, act on the outcome.
 * Bounded by `maxEvaluatorRounds` (default 3; A3.3 wires the policy
 * read). The single-model loop stops at a branch (`on-branch` →
 * `completed`); autonomous merge waits for Phase 4's cross-model upgrade.
 *
 * Orchestration is split from the spawn primitives via the `LoopSpawners`
 * interface — production wires real Claude CLI invocations + git worktree
 * lifecycle; tests inject mocks. The split means the orchestration logic
 * is exercised deterministically, and live verification (the final Phase 6
 * step) is what exercises the real spawns end-to-end.
 *
 * See tasks.md Phase 6 A3 and spec.md §"Layer 2".
 */

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import config from '../config.js';
import {
  CLAUDE_BIN,
  getProjectMcpArgs,
  registerActiveProcess,
  unregisterActiveProcess,
} from '../ai/claude.js';
import {
  evaluateMergeContract,
  resolveReviewMode,
  type Adjudication,
} from '../intent/adjudication.js';
import type { DispatchProvider } from '../intent/dispatch.js';
import { parseEscalationPolicy } from '../intent/escalation.js';
import { evaluateLoop, recordRound, type LoopRound } from '../intent/gen-eval-loop.js';
import { loadModelPolicy, resolveModel } from '../intent/model-policy.js';
import { VALID_SLUG, type SandboxSpec } from '../intent/sandbox.js';
import { createLogger } from '../utils/logger.js';
import { activeRuns } from '../transport/mutations.js';
import type {
  ApplyContext,
  MutationApplier,
  MutationDescriptor,
  MutationEvent,
} from '../transport/mutations.js';
import { buildSandboxEnv } from './credential-injector.js';
import {
  createWorktree as defaultCreateWorktree,
  destroyWorktree as defaultDestroyWorktree,
  getProductConfig,
  readProductsConfig,
  worktreeProvisioningTerminalReason,
} from './sandbox-runtime.js';

const log = createLogger('gen-eval-loop-runner');

/** Fallback when the escalation policy can't supply a cap. Matches the
 *  shipped `policies/escalation-policy.json` default so an unreachable
 *  policy file produces the same bound the policy itself enumerates. */
const FALLBACK_MAX_EVALUATOR_ROUNDS = 3;

/**
 * Read `maxEvaluatorRounds` from the escalation policy's
 * `run-exceeded-bounds` rule (the rule the spec earmarks for this cap; the
 * shipped rule id is `evaluator-round-cap` but we match by condition so a
 * future renamed/duplicated rule still works).
 *
 * Falls back to {@link FALLBACK_MAX_EVALUATOR_ROUNDS} on any of: missing
 * file, malformed JSON, validator throw, or no matching rule. The fallback
 * is intentional — a missing default cap shouldn't stop the loop from
 * running (escalation decisions still fail closed via
 * `escalation.decideFailClosed`; this is just the round-count bound).
 */
export function readEvaluatorRoundCapFromPolicy(policyPath: string): number {
  let raw: string;
  try {
    raw = readFileSync(policyPath, 'utf8');
  } catch {
    log.warn('readEvaluatorRoundCapFromPolicy: policy file missing; using fallback', {
      path: policyPath,
      fallback: FALLBACK_MAX_EVALUATOR_ROUNDS,
    });
    return FALLBACK_MAX_EVALUATOR_ROUNDS;
  }

  try {
    const policy = parseEscalationPolicy(raw);
    for (const rule of policy.rules) {
      if (rule.condition === 'run-exceeded-bounds' && typeof rule.maxEvaluatorRounds === 'number') {
        return rule.maxEvaluatorRounds;
      }
    }
    log.warn('readEvaluatorRoundCapFromPolicy: no run-exceeded-bounds rule; using fallback', {
      path: policyPath,
      fallback: FALLBACK_MAX_EVALUATOR_ROUNDS,
    });
    return FALLBACK_MAX_EVALUATOR_ROUNDS;
  } catch (err) {
    log.warn('readEvaluatorRoundCapFromPolicy: policy malformed; using fallback', {
      path: policyPath,
      fallback: FALLBACK_MAX_EVALUATOR_ROUNDS,
      error: (err as Error).message,
    });
    return FALLBACK_MAX_EVALUATOR_ROUNDS;
  }
}

// ---------------------------------------------------------------------------
// Payload + validate
// ---------------------------------------------------------------------------

export interface GenEvalLoopPayload extends Record<string, unknown> {
  /** Product slug (must be in `policies/products.json`). */
  product: string;
  /** Project slug. */
  project: string;
  /** Optional cap override. */
  maxEvaluatorRounds?: number;
}

function validatePayload(
  payload: Record<string, unknown>,
): { ok: true } | { ok: false; reason: string } {
  const product = payload['product'];
  if (typeof product !== 'string' || product.length === 0) {
    return { ok: false, reason: 'product is required' };
  }
  if (!VALID_SLUG.test(product)) {
    return { ok: false, reason: `invalid product slug: ${product}` };
  }

  const project = payload['project'];
  if (typeof project !== 'string' || project.length === 0) {
    return { ok: false, reason: 'project is required' };
  }
  if (!VALID_SLUG.test(project)) {
    return { ok: false, reason: `invalid project slug: ${project}` };
  }

  let products: Record<string, unknown>;
  try {
    products = readProductsConfig(config.PRODUCTS_CONFIG_FILE);
  } catch (err) {
    return { ok: false, reason: `failed to read products config: ${(err as Error).message}` };
  }
  if (!(product in products)) {
    return { ok: false, reason: `product not registered: ${product}` };
  }

  const cap = payload['maxEvaluatorRounds'];
  if (cap !== undefined) {
    if (typeof cap !== 'number' || !Number.isInteger(cap) || cap < 1) {
      return {
        ok: false,
        reason: `maxEvaluatorRounds must be a positive integer — got ${String(cap)}`,
      };
    }
  }

  for (const handle of activeRuns.values()) {
    const d = handle.descriptor;
    if (d.kind !== 'gen-eval-loop' || d.status !== 'running') continue;
    const otherProduct = (d.payload as Record<string, unknown>)['product'];
    if (otherProduct === product) {
      return { ok: false, reason: `gen-eval-loop already in flight for product ${product}` };
    }
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Spawn primitives — injectable for tests, default to real subprocess spawns
// ---------------------------------------------------------------------------

/** The set of spawn primitives the loop calls between rounds. Split out so
 *  unit tests can mock them and exercise the orchestration deterministically;
 *  production wires defaults that drive Claude CLI + git worktree lifecycle. */
export interface LoopSpawners {
  /** Create the run's worktree and return the populated SandboxSpec. */
  createWorktree: (opts: {
    product: string;
    project: string;
    branch?: string;
    /** Explicit base commit; omitted here — the runner always branches from
     *  createWorktree's atomic HEAD capture (baseSha is returned on the spec). */
    startPoint?: string;
    worktreeRoot: string;
    productsConfigPath: string;
  }) => Promise<SandboxSpec>;
  /** Tear down the worktree. Called from a `finally`. */
  destroyWorktree: (sandbox: SandboxSpec, opts: { productsConfigPath: string; worktreeRoot: string }) => Promise<void>;
  /** Spawn `/work --auto` for the round; resolves with the child's exit code
   *  (0 = tests pass, non-zero = tests fail or other failure). */
  runWorkAuto: (sandbox: SandboxSpec, opts: { productsConfigPath: string }) => Promise<number>;
  /** Spawn `/review` for the round; parses the verdict from the output. A
   *  caller that can't determine a verdict returns 'fail' (conservative —
   *  an unresolvable review escalates rather than degrading to no-review). */
  runReview: (sandbox: SandboxSpec, opts: { productsConfigPath: string }) => Promise<'pass' | 'fail'>;
  /** Merge the gen-eval feature branch into the product's base branch and
   *  push (Phase 6 A7.3). Production shells out to git in the product's
   *  main repo; tests inject a mock. Returns `{ok: true}` on a clean merge
   *  + push, `{ok: false, error}` on any git failure — the runner surfaces
   *  the error as a `failed` mutation event so the run holds for human
   *  review rather than silently degrading. */
  mergeBranch: (
    sandbox: SandboxSpec,
    branch: string,
    opts: { productsConfigPath: string },
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
}

const defaultSpawners: LoopSpawners = {
  createWorktree: defaultCreateWorktree,
  destroyWorktree: defaultDestroyWorktree,
  runWorkAuto: realRunWorkAuto,
  runReview: realRunReview,
  mergeBranch: realMergeBranch,
};

/** Spawn Claude CLI with `/work --auto` against the sandbox worktree. */
async function realRunWorkAuto(
  sandbox: SandboxSpec,
  opts: { productsConfigPath: string },
): Promise<number> {
  return spawnClaude('/work --auto', sandbox, opts);
}

/** Spawn `/review` and parse the verdict from the output. Looks for a
 *  `VERDICT: PASS` / `VERDICT: FAIL` marker; absence is a `fail`
 *  (conservative — an unresolvable review escalates). The marker format
 *  is settled in live verification; until then this is a placeholder
 *  the integration test will refine. */
async function realRunReview(
  sandbox: SandboxSpec,
  opts: { productsConfigPath: string },
): Promise<'pass' | 'fail'> {
  let output = '';
  const exit = await spawnClaude('/review', sandbox, opts, (chunk) => {
    output += chunk;
  });
  if (exit !== 0) return 'fail';
  if (/VERDICT:\s*PASS/i.test(output)) return 'pass';
  // The "exit 0 but no PASS marker" case is invaluable diagnostic during
  // live verification — log a short tail so the marker format can be
  // pinned without re-running the loop.
  log.warn('realRunReview: exit 0 but no VERDICT: PASS marker — treating as fail', {
    outputLength: output.length,
    tail: output.slice(-200),
  });
  return 'fail';
}

/** Merge the feature branch into the product's `baseBranch` in the main
 *  product repo, then push (Phase 6 A7.3). The invariant for autonomous
 *  runs: the product repo's HEAD is on `baseBranch` when the engine
 *  fires — `git -C <repo> merge --no-ff <branch>` mutates the working
 *  tree's branch and would fail loudly on a divergent HEAD. Failure modes
 *  surface as `{ok:false, error}` so the loop runner emits a `failed`
 *  event and the run holds for human review.
 *
 *  After a clean push the feature branch is deleted from the main repo
 *  (`git branch -d <branch>`) so a future run with the same mutation-id
 *  prefix can't collide with a stale branch from a prior run; a delete
 *  failure logs a warning but does not fail the merge (the merge itself
 *  succeeded; the branch is now redundant tracking ref). */
async function realMergeBranch(
  sandbox: SandboxSpec,
  branch: string,
  opts: { productsConfigPath: string },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const product = getProductConfig(sandbox.product, opts.productsConfigPath);
  const message = `rune(${sandbox.product}): merge gen-eval-loop branch ${branch}`;
  const merge = await runGitCmd(
    ['merge', '--no-ff', branch, '-m', message],
    product.repoPath,
  );
  if (!merge.ok) return { ok: false, error: `git merge failed: ${merge.error}` };
  const push = await runGitCmd(['push'], product.repoPath);
  if (!push.ok) {
    // Half-merged state: local baseBranch has the merge but remote is
    // behind. Surface the product + repoPath so the operator knows which
    // repo needs a manual `git push` to recover.
    log.warn('realMergeBranch: git push failed after successful local merge — product repo is half-merged', {
      product: sandbox.product,
      repoPath: product.repoPath,
      branch,
      pushError: push.error,
    });
    return { ok: false, error: `git push failed: ${push.error}` };
  }
  // Best-effort branch cleanup — a delete failure (e.g., baseBranch is not
  // the merge target, branch already deleted) is non-fatal.
  const del = await runGitCmd(['branch', '-d', branch], product.repoPath);
  if (!del.ok) {
    log.warn('realMergeBranch: git branch -d failed (non-fatal)', {
      branch,
      error: del.error,
    });
  }
  return { ok: true };
}

/** Spawn a single `git` subcommand in `cwd`; collect stderr for the error
 *  channel. Resolves with `{ok}` rather than throwing so the merge
 *  step's branch logic stays linear. */
function runGitCmd(args: string[], cwd: string): Promise<{ ok: true } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    registerActiveProcess(child);
    let stderr = '';
    child.stdout!.resume();
    child.stderr!.on('data', (b: Buffer) => {
      stderr += b.toString('utf8');
    });
    let spawnError: string | null = null;
    child.on('error', (err) => { spawnError = err.message; });
    child.on('close', (code) => {
      unregisterActiveProcess(child);
      if (spawnError !== null) {
        resolve({ ok: false, error: spawnError });
        return;
      }
      if (code === 0) {
        resolve({ ok: true });
        return;
      }
      // Sanitize before surfacing: git stderr from `git push` can include
      // remote URLs with embedded credentials (`https://<token>@host/...`)
      // when the product repo's remote is configured that way. Redact the
      // userinfo and cap length so a verbose stderr can't unbound the
      // mutation log entry either.
      const trimmed = stderr.trim();
      const safe = trimmed
        .replace(/https?:\/\/[^@\s]+@/g, 'https://<redacted>@')
        .slice(0, 500);
      resolve({
        ok: false,
        error: safe || `git ${args[0] ?? 'cmd'} exited with code ${code}`,
      });
    });
  });
}

/** Spawn Claude CLI with a single prompt, in the sandbox worktree, with
 *  scoped credentials. Returns the exit code; resolves on close. The
 *  optional `onStdout` callback receives each chunk for callers that need
 *  to parse output (the /review verdict parser). */
function spawnClaude(
  prompt: string,
  sandbox: SandboxSpec,
  opts: { productsConfigPath: string },
  onStdout?: (chunk: string) => void,
): Promise<number> {
  const env = buildSandboxEnv(sandbox, { productsConfigPath: opts.productsConfigPath });
  const child = spawn(
    CLAUDE_BIN,
    [
      // Match work-runner's MCP isolation — sandboxed children must not
      // inherit the user's global MCP servers (claude.ai KB, Linear, Gmail).
      ...getProjectMcpArgs(),
      '--dangerously-skip-permissions',
      '-p',
      prompt,
    ],
    {
      cwd: sandbox.worktree,
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    },
  );
  registerActiveProcess(child);
  return new Promise<number>((resolve) => {
    if (onStdout) {
      child.stdout!.on('data', (b: Buffer) => onStdout(b.toString('utf8')));
    } else {
      child.stdout!.resume();
    }
    // Drain stderr unconditionally — without this, a verbose CLI run that
    // fills the ~64KB pipe buffer would deadlock the child waiting on the
    // parent to read, and `close` would never fire.
    child.stderr!.resume();
    let spawnError = false;
    child.on('error', () => { spawnError = true; });
    // `close` always follows `error` per Node's docs, so a single close
    // handler owns the cleanup (avoids the double-unregister race the
    // separate-handlers version would create).
    child.on('close', (code) => {
      unregisterActiveProcess(child);
      resolve(spawnError || typeof code !== 'number' ? 1 : code);
    });
  });
}

// ---------------------------------------------------------------------------
// Orchestration core — exported for testability
// ---------------------------------------------------------------------------

export interface RunGenEvalLoopOpts {
  mutationId: string;
  payload: GenEvalLoopPayload;
  worktreeRoot: string;
  productsConfigPath: string;
  /** Path to `policies/escalation-policy.json`; the cap is read from its
   *  `run-exceeded-bounds` rule when the payload doesn't override. */
  escalationPolicyPath: string;
  /** Path to `policies/model-policy.json` — the runner resolves the
   *  Generator and Evaluator (model, provider) pair via the policy at
   *  loop start (Phase 6 A7.1). A null policy file falls back to a
   *  Claude generator with no Evaluator, surfacing as a resolution
   *  event with `evaluator: null` — A7.2/A7.3's merge contract will
   *  hold the run when the second provider can't be resolved. */
  modelPolicyPath: string;
  /** Injectable spawn primitives; defaults to the production set. */
  spawners?: LoopSpawners;
  /** Returns true when the run should be cancelled (checked between rounds). */
  cancel: () => boolean;
  /** Optional callback invoked after each round completes. Mostly a test
   *  hook for the cancel-after-N case. */
  onRound?: () => void;
}

/** Resolved (model, provider) pair for a side of the dispatch loop. */
interface ResolvedSide {
  model: string;
  provider: string;
}

/** Resolution event payload emitted at loop start. The cockpit reads this
 *  to populate the per-round model line; A7.2's Adjudication is built from
 *  the same pair when the verdict comes back. */
interface ResolutionEventData {
  kind: 'resolution';
  mode: 'cross-model' | 'single-model';
  generator: ResolvedSide;
  evaluator: ResolvedSide | null;
}

/** Build an `Adjudication` from the resolved generator/evaluator pair (the
 *  A7.1 startup resolution event's data) and the round's verdict. Returns
 *  `null` when the Evaluator is unresolved — `evaluateMergeContract` treats
 *  a null adjudication as "cross-model review unavailable" and holds the
 *  merge, never degrading to a single-model autonomous merge. */
function buildAdjudicationFromResolution(
  resolution: ResolutionEventData,
  verdict: 'pass' | 'fail',
): Adjudication | null {
  if (resolution.evaluator === null) return null;
  return {
    generatorModel: resolution.generator.model,
    generatorProvider: resolution.generator.provider as DispatchProvider,
    evaluatorModel: resolution.evaluator.model,
    evaluatorProvider: resolution.evaluator.provider as DispatchProvider,
    verdict,
  };
}

/** Resolve the Generator and Evaluator (model, provider) pair from the
 *  model-selection policy at loop start. Autonomous runs are always
 *  cross-model — Evaluator resolves with `distinctFromProvider` set to the
 *  Generator's provider so the policy returns a different family. A null
 *  policy file (fresh install, no model policy) yields a placeholder
 *  Generator pair and a null Evaluator; A7.2's merge contract holds the
 *  run when Evaluator is null. */
function resolveLoopModels(modelPolicyPath: string): ResolutionEventData {
  // Autonomous engine runs are always cross-model — `resolveReviewMode`'s
  // `crossModelFlag` is irrelevant here.
  const mode = resolveReviewMode({ autonomous: true, crossModelFlag: false });

  // The Generator is Claude `/work --auto` today; A7+ may swap this to a
  // resolveModel call once `/work --auto` is portable.
  const generator: ResolvedSide = { model: 'sonnet', provider: 'anthropic' };

  const policy = loadModelPolicy(modelPolicyPath);
  if (policy === null) {
    log.warn('resolveLoopModels: model policy unavailable; evaluator unresolved', {
      modelPolicyPath,
    });
    return { kind: 'resolution', mode, generator, evaluator: null };
  }

  let evaluator: ResolvedSide | null = null;
  try {
    const resolution = resolveModel(
      {
        role: 'evaluator',
        capabilities: ['coding'],
        distinctFromProvider: generator.provider,
      },
      policy,
    );
    evaluator = { model: resolution.model, provider: resolution.provider };
  } catch (err) {
    // A constraint violation (no cross-provider model registered yet, or the
    // policy's `evaluatorDistinctFromGenerator` flag is set without a fit)
    // surfaces as a null Evaluator — the run holds at merge time rather than
    // degrading to a single-model autonomous merge.
    log.warn('resolveLoopModels: evaluator resolution failed; treating as null', {
      error: (err as Error).message,
    });
  }
  return { kind: 'resolution', mode, generator, evaluator };
}

/**
 * Run the Generator-Evaluator loop for one mutation. Yields MutationEvents
 * (output for round-progress lines, terminal completed/failed at the end).
 * Worktree cleanup runs in a `finally` so every exit path tears it down,
 * including cancel and crash.
 */
export async function* runGenEvalLoop(
  opts: RunGenEvalLoopOpts,
): AsyncIterable<MutationEvent> {
  const spawners = opts.spawners ?? defaultSpawners;
  // Payload override wins; otherwise the cap comes from the escalation
  // policy so the loop and the policy never disagree on the bound.
  const cap = opts.payload.maxEvaluatorRounds
    ?? readEvaluatorRoundCapFromPolicy(opts.escalationPolicyPath);
  const baseEvent = (kind: MutationEvent['kind'], data?: object): MutationEvent => ({
    mutationId: opts.mutationId,
    ts: new Date().toISOString(),
    kind,
    ...(data !== undefined ? { data } : {}),
  });

  // Phase 6 C5: every terminal event (completed / failed) carries the
  // product+project identity so the Telegram formatter can render
  // `<product>/<project>` instead of degrading to a UUID fragment. Spread
  // this into the data object of every terminal yield below.
  const identity = { product: opts.payload.product, project: opts.payload.project };

  // Phase 6 A7.1: resolve Generator and Evaluator (model, provider) at loop
  // start and emit a 'resolution' progress event. The cockpit reads it to
  // render the per-round model line; A7.2 builds the Adjudication from the
  // same pair when the verdict arrives.
  const resolution = resolveLoopModels(opts.modelPolicyPath);
  yield baseEvent('progress', resolution);

  // Phase 6 A7.3: deterministic feature-branch name derived from the
  // mutation id so every gen-eval run has its own branch. Commits from
  // `/work --auto` land on this branch; the A7.3 merge step merges it
  // into the product's `baseBranch` in the main repo on merge-ready.
  const branch = `rune-gen-eval/${opts.mutationId.slice(0, 8)}`;

  let sandbox: SandboxSpec | null = null;
  try {
    try {
      sandbox = await spawners.createWorktree({
        product: opts.payload.product,
        project: opts.payload.project,
        branch,
        worktreeRoot: opts.worktreeRoot,
        productsConfigPath: opts.productsConfigPath,
      });
    } catch (err) {
      const detail = (err as Error).message;
      log.error('gen-eval-loop-runner: worktree provisioning failed', {
        id: opts.mutationId,
        product: opts.payload.product,
        project: opts.payload.project,
        error: detail,
      });
      yield baseEvent('failed', {
        ...identity,
        reason: worktreeProvisioningTerminalReason(detail),
      });
      return;
    }
    // TODO(v2): cancel-check between createWorktree and first round — today
    // a cancel arriving during the worktree-create call is only honored at
    // the top of the loop body (line below); for v1 the worktree-create
    // window is short and the finally still tears the worktree down.

    const rounds: LoopRound[] = [];
    let roundNum = 0;
    while (true) {
      if (opts.cancel()) {
        yield baseEvent('failed', { ...identity, reason: 'cancelled before next round', rounds: rounds.length });
        return;
      }
      roundNum++;
      yield baseEvent('output', { line: `round ${roundNum}: /work --auto starting` });

      let exitCode: number;
      try {
        exitCode = await spawners.runWorkAuto(sandbox, { productsConfigPath: opts.productsConfigPath });
      } catch (err) {
        yield baseEvent('failed', {
          ...identity,
          reason: `/work --auto threw on round ${roundNum}: ${(err as Error).message}`,
        });
        return;
      }
      const testsPass = exitCode === 0;

      let verdict: 'pass' | 'fail' = 'fail';
      if (testsPass) {
        yield baseEvent('output', { line: `round ${roundNum}: tests passed, /review starting` });
        try {
          verdict = await spawners.runReview(sandbox, { productsConfigPath: opts.productsConfigPath });
        } catch (err) {
          yield baseEvent('failed', {
            ...identity,
            reason: `/review threw on round ${roundNum}: ${(err as Error).message}`,
          });
          return;
        }
      } else {
        yield baseEvent('output', { line: `round ${roundNum}: tests failed (exit ${exitCode})` });
      }

      rounds.push(recordRound(testsPass, verdict));
      opts.onRound?.();

      const outcome = evaluateLoop(rounds, cap);
      yield baseEvent('output', {
        line: `round ${roundNum}: outcome=${outcome.status} failedEvaluatorRounds=${outcome.failedEvaluatorRounds}`,
      });
      // Structured per-round signal for the cockpit / supervision surface —
      // the data is the same `failedEvaluatorRounds` the output line carries
      // but in a parse-free shape callers can render directly.
      yield baseEvent('progress', {
        round: roundNum,
        failedEvaluatorRounds: outcome.failedEvaluatorRounds,
        status: outcome.status,
      });

      if (outcome.status === 'on-branch') {
        // Phase 6 A7.2: build an Adjudication from the resolved Generator/
        // Evaluator pair (A7.1) and the round's verdict, then evaluate the
        // merge contract. On `merge: true` the gate clears and the loop
        // emits a `merge-ready` progress event before the existing
        // `completed` event (A7.3 swaps the placeholder `completed` for the
        // actual git merge). On `merge: false` the loop emits a `failed`
        // event with the contract's reason — the run holds rather than
        // degrading to an autonomous merge that skipped a contract gate.
        const adjudication = buildAdjudicationFromResolution(resolution, verdict);
        // Captured once so the five yield sites below stop repeating the
        // conditional spread — `adjObj` is `{}` when adjudication is null
        // and `{adjudication}` otherwise.
        const adjObj = adjudication !== null ? { adjudication } : {};
        const merge = evaluateMergeContract({
          adjudication,
          testsPass: true,
          // TODO(A7+): wire to the escalation policy via decide() once the
          // change-class shape the loop reports is settled. For now the
          // escalate-after-N-failed-rounds path is the only escalation
          // signal the runner emits, and that's handled in the
          // 'escalated' branch above.
          escalationFlags: false,
        });
        if (!merge.merge) {
          yield baseEvent('failed', {
            ...identity,
            reason: `merge contract held: ${merge.reason}`,
            ...adjObj,
            rounds: rounds.length,
            failedEvaluatorRounds: outcome.failedEvaluatorRounds,
          });
          return;
        }
        // Merge gate cleared — record the cleared contract, then run the
        // actual `git merge --no-ff <branch>` + push against the product
        // repo's main checkout (Phase 6 A7.3). On merge/push failure the
        // run holds for human review rather than degrading to "merge
        // happened but push failed" or vice versa.
        yield baseEvent('progress', {
          kind: 'merge-ready',
          ...adjObj,
        });
        // Wrap in try/catch so a synchronous throw from getProductConfig
        // (e.g., products.json edited between mutation creation and merge)
        // or from spawn itself (git binary missing) surfaces as a failed
        // event rather than escaping the generator. Mirrors the try/catch
        // around runWorkAuto / runReview earlier in the loop.
        let mergeResult: { ok: true } | { ok: false; error: string };
        try {
          mergeResult = await spawners.mergeBranch(sandbox, branch, {
            productsConfigPath: opts.productsConfigPath,
          });
        } catch (err) {
          yield baseEvent('failed', {
            ...identity,
            reason: `mergeBranch threw: ${(err as Error).message}`,
            ...adjObj,
            rounds: rounds.length,
            failedEvaluatorRounds: outcome.failedEvaluatorRounds,
            branch,
          });
          return;
        }
        if (!mergeResult.ok) {
          yield baseEvent('failed', {
            ...identity,
            reason: `merge failed: ${mergeResult.error}`,
            ...adjObj,
            rounds: rounds.length,
            failedEvaluatorRounds: outcome.failedEvaluatorRounds,
            branch,
          });
          return;
        }
        // Phase 6 C5: include `adjudication` on the `completed` event so the
        // Telegram formatter can render the cross-model verdict line. Without
        // this the message would degrade to `single-model PASS` even when the
        // run was cross-model.
        yield baseEvent('completed', {
          ...identity,
          rounds: rounds.length,
          failedEvaluatorRounds: outcome.failedEvaluatorRounds,
          branch,
          ...adjObj,
        });
        return;
      }
      if (outcome.status === 'escalated') {
        // Phase 6 C5: include `cap` as a discrete field so the Telegram
        // formatter can render the `N/cap` blocked-on-you line. Cap is also
        // embedded in `reason` for human readability — the discrete field
        // is for the formatter's branch guard.
        yield baseEvent('failed', {
          ...identity,
          reason:
            `escalated after ${outcome.failedEvaluatorRounds} failed evaluator rounds ` +
            `(cap=${cap})`,
          rounds: rounds.length,
          failedEvaluatorRounds: outcome.failedEvaluatorRounds,
          cap,
        });
        return;
      }
      // outcome === 'in-progress' — next round
    }
  } finally {
    if (sandbox) {
      try {
        await spawners.destroyWorktree(sandbox, {
          productsConfigPath: opts.productsConfigPath,
          worktreeRoot: opts.worktreeRoot,
        });
      } catch (err) {
        log.warn('gen-eval-loop: destroyWorktree failed', {
          mutationId: opts.mutationId,
          error: (err as Error).message,
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Applier
// ---------------------------------------------------------------------------

export const genEvalLoopApplier: MutationApplier<GenEvalLoopPayload> = {
  kind: 'gen-eval-loop',
  autoApprove: false,

  validate(payload: GenEvalLoopPayload) {
    return validatePayload(payload as Record<string, unknown>);
  },

  async *apply(descriptor: MutationDescriptor<GenEvalLoopPayload>, ctx: ApplyContext): AsyncIterable<MutationEvent> {
    yield* runGenEvalLoop({
      mutationId: descriptor.id,
      payload: descriptor.payload,
      worktreeRoot: config.WORKTREE_ROOT,
      productsConfigPath: config.PRODUCTS_CONFIG_FILE,
      escalationPolicyPath: config.ESCALATION_POLICY_FILE,
      modelPolicyPath: config.MODEL_POLICY_FILE,
      cancel: ctx.cancel,
    });
  },
};
