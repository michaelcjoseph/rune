/**
 * Generator-Evaluator loop runner — Phase 6 A3.1 scaffold.
 *
 * Ships the `MutationApplier` for the `'gen-eval-loop'` mutation kind: payload
 * validation, registration in the mutation pipeline, and a placeholder
 * `apply()` body that surfaces a structured "not implemented" failure until
 * A3.2 lands the actual per-round loop body (`/work --auto` → `/review` →
 * `recordRound` + `evaluateLoop`).
 *
 * Why a placeholder rather than waiting for A3.2: the scaffold lets the
 * mutation kind be registerable now (A3 sub-tasks land independently); a
 * caller that triggers a run gets a clear "not implemented" failure rather
 * than silent success or an unknown-kind error.
 *
 * See tasks.md Phase 6 A3 and spec.md §"Layer 2".
 */

import config from '../config.js';
import { VALID_SLUG } from '../intent/sandbox.js';
import { createLogger } from '../utils/logger.js';
import { activeRuns } from '../transport/mutations.js';
import type {
  ApplyContext,
  MutationApplier,
  MutationDescriptor,
  MutationEvent,
} from '../transport/mutations.js';
import { readProductsConfig } from './sandbox-runtime.js';

const log = createLogger('gen-eval-loop-runner');

export interface GenEvalLoopPayload extends Record<string, unknown> {
  /** Product slug (must be in `policies/products.json`). */
  product: string;
  /** Project slug. */
  project: string;
  /** Optional cap override. A3.3 will default this from
   *  `policies/escalation-policy.json`'s evaluator-round-cap rule. */
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

  // Confirm the product is registered before we ever try to dispatch.
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

  // Per-product concurrency cap: one gen-eval-loop per product at a time.
  // Matches the scheduler design from A4 (and the spec's
  // "one project per product" constraint); enforcing it at validate keeps
  // the cap honest even before the scheduler module exists.
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

export const genEvalLoopApplier: MutationApplier<GenEvalLoopPayload> = {
  kind: 'gen-eval-loop',
  // Manual approval by default — the autonomous engine dispatches these via
  // the future planner approval flow, not bare `createMutation`. Defaulting
  // to false avoids accidentally firing a long run from a misroute.
  autoApprove: false,

  validate(payload: GenEvalLoopPayload) {
    return validatePayload(payload as Record<string, unknown>);
  },

  // eslint-disable-next-line require-yield
  async *apply(
    descriptor: MutationDescriptor<GenEvalLoopPayload>,
    _ctx: ApplyContext,
  ): AsyncIterable<MutationEvent> {
    // A3.1 ships only the scaffold. The per-round body — spawn `/work
    // --auto`, parse exit, spawn `/review`, build a LoopRound via
    // `recordRound`, decide via `evaluateLoop`, act on the outcome — lands
    // in A3.2. Surface a clear failure so a caller doesn't mistake silent
    // success for a completed run.
    log.warn('gen-eval-loop apply() body not yet implemented (Phase 6 A3.2)', {
      mutationId: descriptor.id,
      product: descriptor.payload.product,
      project: descriptor.payload.project,
    });
    const reason =
      'gen-eval-loop apply() not implemented — Phase 6 A3.2 lands the per-round body ' +
      '(spawn /work --auto, parse exit, spawn /review, recordRound, evaluateLoop)';
    yield {
      mutationId: descriptor.id,
      ts: new Date().toISOString(),
      kind: 'failed',
      data: { reason },
    };
  },
};
