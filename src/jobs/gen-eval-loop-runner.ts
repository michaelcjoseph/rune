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
import config from '../config.js';
import {
  CLAUDE_BIN,
  getProjectMcpArgs,
  registerActiveProcess,
  unregisterActiveProcess,
} from '../ai/claude.js';
import { evaluateLoop, recordRound, type LoopRound } from '../intent/gen-eval-loop.js';
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
  readProductsConfig,
} from './sandbox-runtime.js';

const log = createLogger('gen-eval-loop-runner');

/** A3.3 will read this from `policies/escalation-policy.json`'s
 *  evaluator-round-cap rule. For now, hardcoded to the policy default. */
const DEFAULT_MAX_EVALUATOR_ROUNDS = 3;

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
}

const defaultSpawners: LoopSpawners = {
  createWorktree: defaultCreateWorktree,
  destroyWorktree: defaultDestroyWorktree,
  runWorkAuto: realRunWorkAuto,
  runReview: realRunReview,
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
  /** Injectable spawn primitives; defaults to the production set. */
  spawners?: LoopSpawners;
  /** Returns true when the run should be cancelled (checked between rounds). */
  cancel: () => boolean;
  /** Optional callback invoked after each round completes. Mostly a test
   *  hook for the cancel-after-N case. */
  onRound?: () => void;
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
  const cap = opts.payload.maxEvaluatorRounds ?? DEFAULT_MAX_EVALUATOR_ROUNDS;
  const baseEvent = (kind: MutationEvent['kind'], data?: Record<string, unknown>): MutationEvent => ({
    mutationId: opts.mutationId,
    ts: new Date().toISOString(),
    kind,
    ...(data !== undefined ? { data } : {}),
  });

  let sandbox: SandboxSpec | null = null;
  try {
    try {
      sandbox = await spawners.createWorktree({
        product: opts.payload.product,
        project: opts.payload.project,
        worktreeRoot: opts.worktreeRoot,
        productsConfigPath: opts.productsConfigPath,
      });
    } catch (err) {
      yield baseEvent('failed', { reason: `worktree create failed: ${(err as Error).message}` });
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
        yield baseEvent('failed', { reason: 'cancelled before next round', rounds: rounds.length });
        return;
      }
      roundNum++;
      yield baseEvent('output', { line: `round ${roundNum}: /work --auto starting` });

      let exitCode: number;
      try {
        exitCode = await spawners.runWorkAuto(sandbox, { productsConfigPath: opts.productsConfigPath });
      } catch (err) {
        yield baseEvent('failed', {
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

      if (outcome.status === 'on-branch') {
        yield baseEvent('completed', {
          rounds: rounds.length,
          failedEvaluatorRounds: outcome.failedEvaluatorRounds,
        });
        return;
      }
      if (outcome.status === 'escalated') {
        yield baseEvent('failed', {
          reason:
            `escalated after ${outcome.failedEvaluatorRounds} failed evaluator rounds ` +
            `(cap=${cap})`,
          rounds: rounds.length,
          failedEvaluatorRounds: outcome.failedEvaluatorRounds,
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
      cancel: ctx.cancel,
    });
  },
};
