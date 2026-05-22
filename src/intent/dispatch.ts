/**
 * Multi-model dispatch — Layer 5 of the intent layer's execution engine. A run is dispatched
 * to an executor on one of several model providers (Claude, Codex). A dispatch carries an
 * explicit, **structured handoff**: every piece of context the executor needs is a named
 * field, so the executor reconstructs nothing by compacting a prior in-place conversation.
 * Each dispatch is logged with the model and provider that ran it, for cost attribution.
 *
 * This module is the deterministic core of that — the handoff shape with its validating
 * constructor, and the dispatch log record. Actually spawning Claude or Codex, and the
 * Codex agent-definition compiler target (`compileToCodex` in `agent-def.ts`), are the
 * orchestration and compiler work this builds on.
 *
 * STATUS: implemented. The decision core — `buildHandoff` and `recordDispatch` — is live;
 * the contract is pinned by the test suite in `dispatch.test.ts` (test-plan.md §13).
 * Actually spawning a Claude or Codex executor is the orchestration that builds on this.
 *
 * See docs/projects/08-intent-layer/{spec.md (§"Layer 5"), test-plan.md (§13)}.
 */

/** The executor a run is dispatched to. */
export type DispatchTarget = 'claude' | 'codex';

/** The provider family behind a target. */
export type DispatchProvider = 'anthropic' | 'openai';

/**
 * The explicit, structured handoff a dispatch carries to its executor. It is self-contained:
 * every piece of context the run needs is a named field here, so the executor never
 * reconstructs intent by compacting a prior in-place conversation.
 */
export interface DispatchHandoff {
  /** The executor to run on. */
  target: DispatchTarget;
  /** The neutral agent-definition name to run. */
  agent: string;
  /** The product the dispatch is for. */
  product: string;
  /** The project slug the dispatch is for. */
  project: string;
  /** What the dispatched run must achieve. */
  objective: string;
  /** The explicit context the executor needs — carried in full, never reconstructed.
   *  Trust-boundary invariant: when `target === 'codex'`, `context` must not carry
   *  vault-sourced personal content — it crosses into the OpenAI trust domain. The
   *  orchestrator that spawns a Codex executor is responsible for enforcing this. */
  context: string;
}

/** The outcome of a dispatch, as reported back for logging. */
export type DispatchResult =
  | { model: string; provider: DispatchProvider; status: 'completed' }
  | { model: string; provider: DispatchProvider; status: 'failed'; failureReason: string };

/**
 * A log record of one dispatch — which model and provider executed it (for cost
 * attribution) and whether it completed or failed. A discriminated union on `status`: a
 * `failed` entry always carries a `failureReason`, and a `completed` entry can never have
 * one — the incoherent combination is unrepresentable.
 */
export type DispatchLogEntry =
  | { target: DispatchTarget; model: string; provider: DispatchProvider; status: 'completed' }
  | {
      target: DispatchTarget;
      model: string;
      provider: DispatchProvider;
      status: 'failed';
      /** A clear, human-readable reason — e.g. a provider being unavailable. */
      failureReason: string;
    };

/**
 * Validate and finalize a dispatch handoff. Throws if `objective` or `context` is empty: a
 * dispatch must carry explicit context, never relying on the executor to reconstruct intent
 * by compacting a prior conversation.
 */
export function buildHandoff(handoff: DispatchHandoff): DispatchHandoff {
  if (handoff.objective.trim() === '') {
    throw new Error(
      'buildHandoff: a dispatch must carry an explicit objective — the executor never reconstructs intent',
    );
  }
  if (handoff.context.trim() === '') {
    throw new Error(
      'buildHandoff: a dispatch must carry explicit context — no relying on in-place compaction',
    );
  }
  return handoff;
}

/**
 * Build the log record for a finished dispatch from its handoff and result — capturing the
 * target, the model and provider that executed it, and the completed/failed status (with a
 * clear reason on failure, so a provider-unavailable dispatch is a recorded clean failure).
 */
export function recordDispatch(
  handoff: DispatchHandoff,
  result: DispatchResult,
): DispatchLogEntry {
  const base = { target: handoff.target, model: result.model, provider: result.provider };
  return result.status === 'completed'
    ? { ...base, status: 'completed' }
    : { ...base, status: 'failed', failureReason: result.failureReason };
}
