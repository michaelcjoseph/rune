/**
 * The `writing` MutationApplier — /blog and /writing-critique runs routed
 * through the mutation pipeline (the CLAUDE.md invariant for autonomous
 * codebase ops), driving `startWritingProductRun` with the production deps
 * (src/jobs/writing-run-deps.ts).
 *
 * Shape of a run: preflight the writing repo → guard against a concurrent run
 * on the same slug (two runs would share one worktree path) → bridge the
 * pipeline's fine-grained states into `output` events (run-feed log lines) →
 * run → terminal `completed` (outcome branch-complete + commitSha) or `failed`
 * (scrubbed reason, stage-attributed via the deps' recorded failure) → destroy
 * the worktree ALWAYS (committed work lives on the rune-writing/{slug} branch;
 * a kept dirty tree would wedge the slug — `reclaimPreservedWorktree` refuses
 * dirty trees).
 *
 * The 30s keep-alive/activity ticker is load-bearing, not cosmetic: the
 * quiet→cancel backstop (stall-check) is not kind-gated, and a writing run is
 * silent for minutes at a time inside one-shot model calls — without the
 * ticker a healthy run gets system-reaped. The model calls' own
 * CLAUDE_TIMEOUT_MS remains the real hang backstop.
 */

import config from '../config.js';
import { createLogger } from '../utils/logger.js';
import { scrubAbsolutePaths } from '../utils/sanitize-paths.js';
import { VALID_SLUG, writingBranchName, type SandboxSpec } from '../intent/sandbox.js';
import type {
  ApplyContext,
  MutationApplier,
  MutationDescriptor,
  MutationEvent,
  RunHandle,
} from '../transport/mutations.js';
import { activeRuns } from '../transport/mutations.js';
import { getProductConfig, destroyWorktree, type ProductConfig } from './sandbox-runtime.js';
import {
  buildProductionStartWritingDeps,
  writingRepoPresent,
  type ProductionStartWritingDeps,
  type WritingRunFailure,
} from './writing-run-deps.js';
import {
  startWritingProductRun,
  type StartWritingProductRunInput,
  type StartedWritingProductRun,
} from './writing-product-orchestration.js';
import type { WritingPipelineEvent } from './writing-pipeline.js';

const log = createLogger('writing-run-runner');

export interface WritingRunPayload extends Record<string, unknown> {
  command: 'blog' | 'writing-critique';
  chatId: number;
  /** Always 'writing' — `buildSupervisedRun` reads it for the cockpit row. */
  product: 'writing';
  /** The topic/target slug — supervision project, run-feed target, worktree
   *  path segment, and the `rune-writing/{slug}` branch stem. */
  projectSlug: string;
  /** blog only. */
  topic?: string;
  /** critique only — the raw target the user named. NOT keyed `target`:
   *  `runTargetFromDescriptor` probes payload['target'] for a structured
   *  {kind, slug} object and a raw string there invites confusion. */
  critiqueTarget?: string;
  /** critique only — docs/rune/critiques/{slug}.md, command-computed. */
  outputPath?: string;
  revisionRequested?: boolean;
}

/** Injectable seams for the runner tests; production uses the defaults. */
export interface WritingRunnerDeps {
  buildStartDeps: (hooks: {
    emitRunState: (event: WritingPipelineEvent) => void;
    cancelRequested?: () => boolean;
  }) => ProductionStartWritingDeps;
  startRun: (
    input: StartWritingProductRunInput,
    deps: ProductionStartWritingDeps['deps'],
  ) => Promise<StartedWritingProductRun>;
  destroy: (sandbox: SandboxSpec) => Promise<void>;
  getProduct: (product: string) => ProductConfig;
  repoPresent: (repoPath: string) => boolean;
  listActiveRuns: () => Map<string, RunHandle>;
  tickerMs: number;
}

export const KEEP_ALIVE_TICKER_MS = 30_000;

const defaultWritingRunnerDeps: WritingRunnerDeps = {
  buildStartDeps: (hooks) => buildProductionStartWritingDeps(hooks),
  startRun: (input, deps) => startWritingProductRun(input, deps),
  destroy: (sandbox) =>
    destroyWorktree(sandbox, {
      productsConfigPath: config.PRODUCTS_CONFIG_FILE,
      worktreeRoot: config.WORKTREE_ROOT,
    }),
  getProduct: (product) => getProductConfig(product, config.PRODUCTS_CONFIG_FILE),
  repoPresent: writingRepoPresent,
  listActiveRuns: () => activeRuns,
  tickerMs: KEEP_ALIVE_TICKER_MS,
};

function validateWritingPayload(payload: Record<string, unknown>): { ok: true } | { ok: false; reason: string } {
  const p = payload as Partial<WritingRunPayload>;
  if (p.command !== 'blog' && p.command !== 'writing-critique') {
    return { ok: false, reason: "command must be 'blog' or 'writing-critique'" };
  }
  if (typeof p.chatId !== 'number' || !Number.isFinite(p.chatId)) {
    return { ok: false, reason: 'chatId must be a finite number' };
  }
  if (p.product !== 'writing') {
    return { ok: false, reason: "product must be 'writing'" };
  }
  if (typeof p.projectSlug !== 'string' || !VALID_SLUG.test(p.projectSlug)) {
    return { ok: false, reason: 'projectSlug must be a valid lowercase slug' };
  }
  if (p.command === 'blog') {
    if (typeof p.topic !== 'string' || !p.topic.trim()) {
      return { ok: false, reason: 'blog requires a non-empty topic' };
    }
  } else {
    if (typeof p.critiqueTarget !== 'string' || !p.critiqueTarget.trim()) {
      return { ok: false, reason: 'writing-critique requires a non-empty critiqueTarget' };
    }
    if (typeof p.outputPath !== 'string' || !p.outputPath.startsWith('docs/rune/critiques/')) {
      return { ok: false, reason: 'writing-critique outputPath must live under docs/rune/critiques/' };
    }
  }
  return { ok: true };
}

export async function* runWritingMutation(
  descriptor: MutationDescriptor<WritingRunPayload>,
  ctx: ApplyContext,
  deps: WritingRunnerDeps = defaultWritingRunnerDeps,
): AsyncIterable<MutationEvent> {
  const payload = descriptor.payload;
  const slug = payload.projectSlug;
  const branch = writingBranchName(slug);
  const now = () => new Date().toISOString();
  const event = (kind: MutationEvent['kind'], data?: unknown): MutationEvent => ({
    mutationId: descriptor.id,
    ts: now(),
    kind,
    ...(data !== undefined ? { data } : {}),
  });
  const terminalIdentity = {
    command: payload.command,
    slug,
    branch,
    ...(payload.topic ? { topic: payload.topic } : {}),
    ...(payload.critiqueTarget ? { critiqueTarget: payload.critiqueTarget } : {}),
  };

  // --- Preflight: the writing product's repo must exist before any work. ---
  let product: ProductConfig;
  try {
    product = deps.getProduct('writing');
  } catch (err) {
    yield event('failed', {
      ...terminalIdentity,
      reason: scrubAbsolutePaths(`writing product is not configured: ${(err as Error).message}`),
    });
    return;
  }
  if (!deps.repoPresent(product.repoPath)) {
    yield event('failed', {
      ...terminalIdentity,
      reason: 'the writing repo checkout is missing on this machine — clone it before running /blog',
    });
    return;
  }

  // --- One run per slug: a concurrent run would share the worktree path and
  //     reclaim the live tree out from under the first run. ---
  for (const [id, handle] of deps.listActiveRuns()) {
    if (id === descriptor.id) continue;
    if (handle.descriptor.kind !== 'writing') continue;
    if ((handle.descriptor.payload as Record<string, unknown>)['projectSlug'] === slug) {
      yield event('failed', {
        ...terminalIdentity,
        reason: `a writing run for '${slug}' is already in flight (id=${id.slice(0, 8)})`,
      });
      return;
    }
  }

  // --- Event bridge: the pipeline runs as one promise; emitRunState pushes
  //     into a queue the generator drains between awaits. Safe against missed
  //     wakeups: pushes only happen from async callbacks, and every resume
  //     re-drains the queue before re-arming the notify promise. ---
  const queue: MutationEvent[] = [];
  let notify: (() => void) | null = null;
  const push = (e: MutationEvent) => {
    queue.push(e);
    notify?.();
  };
  const emitRunState = (pipelineEvent: WritingPipelineEvent) => {
    push(event('output', {
      line: `writing: ${pipelineEvent.state}`,
      state: pipelineEvent.state,
      slug: pipelineEvent.target.slug,
      branch: pipelineEvent.branch,
    }));
  };

  yield event('start', { ...terminalIdentity });

  const ticker = setInterval(() => {
    push(event('keep-alive'));
    push(event('activity'));
  }, deps.tickerMs);
  // Never hold the process open for the ticker alone.
  ticker.unref?.();

  const { deps: startDeps, getSandbox, getFailure } = deps.buildStartDeps({
    emitRunState,
    cancelRequested: ctx.cancel,
  });

  const input: StartWritingProductRunInput = payload.command === 'blog'
    ? { command: 'blog', chatId: payload.chatId, topic: payload.topic ?? '' }
    : {
      command: 'writing-critique',
      chatId: payload.chatId,
      target: payload.critiqueTarget ?? '',
      outputPath: payload.outputPath ?? '',
      revisionRequested: payload.revisionRequested ?? false,
    };

  const runPromise: Promise<
    { ok: true; result: StartedWritingProductRun } | { ok: false; error: Error }
  > = deps.startRun(input, startDeps).then(
    (result) => ({ ok: true as const, result }),
    (error: unknown) => ({ ok: false as const, error: error as Error }),
  );

  try {
    // Object-held settle state: TS control-flow analysis can't see the closure
    // assignment on a plain `let`, and would narrow it to `null` forever.
    const state: { settled: Awaited<typeof runPromise> | null } = { settled: null };
    void runPromise.then((s) => {
      state.settled = s;
      notify?.();
    });
    for (;;) {
      while (queue.length > 0) yield queue.shift()!;
      if (state.settled) break;
      await new Promise<void>((resolve) => {
        notify = resolve;
      });
      notify = null;
    }
    while (queue.length > 0) yield queue.shift()!;
    const outcome = state.settled;
    if (!outcome) throw new Error('writing run: drain loop exited without settlement');

    if (outcome.ok) {
      const r = outcome.result;
      yield event('completed', {
        ...terminalIdentity,
        outcome: 'branch-complete',
        branch: r.branch,
        slug: r.slug,
        branchStatus: r.branchStatus,
        commitSha: r.publish.commitSha,
        routePath: `/rune/${r.slug}`,
        ...(payload.outputPath ? { outputPath: payload.outputPath } : {}),
      });
    } else {
      // The deps adapter throws stage-attributed messages; a raw worktree/git
      // error may carry absolute paths — scrub before the reason reaches the
      // bus/mutations.jsonl.
      const failure: WritingRunFailure | null = getFailure();
      const message = outcome.error.message?.trim()
        ? outcome.error.message
        : failure
          ? `writing pipeline failed at ${failure.stage}: ${failure.message}`
          : 'writing run failed with no recorded reason';
      yield event('failed', {
        ...terminalIdentity,
        reason: scrubAbsolutePaths(message),
        ...(ctx.cancel() ? { cancelled: true } : {}),
      });
    }
  } finally {
    clearInterval(ticker);
    const sandbox = getSandbox();
    if (sandbox) {
      try {
        await deps.destroy(sandbox);
      } catch (err) {
        // Best-effort: committed work lives on the branch; a stuck tree is
        // reclaimed by the next run's createWorktree if clean.
        log.warn('writing run: worktree teardown failed', {
          id: descriptor.id,
          slug,
          error: (err as Error).message,
        });
      }
    }
  }
}

export const writingRunApplier: MutationApplier<WritingRunPayload> = {
  kind: 'writing',
  // Explicit user command — start immediately, like the cockpit Start path.
  autoApprove: true,
  validate: validateWritingPayload,
  async *apply(descriptor: MutationDescriptor<WritingRunPayload>, ctx: ApplyContext) {
    yield* runWritingMutation(descriptor, ctx);
  },
};
