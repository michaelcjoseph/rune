/**
 * Cross-model adjudication — the Phase 4 upgrade to Layer 2's Generator-Evaluator loop. The
 * Phase 3 loop was single-model; for an autonomous engine run the Evaluator now resolves to
 * a **different provider family** than the Generator, so every merge is preceded by a
 * cross-model review. A change reaches a repo's main line only by passing the **merge
 * contract**: cross-model review and the test suite both pass, and the escalation policy
 * does not flag the change.
 *
 * This module is the deterministic core of that: resolving the review mode (autonomous runs
 * are always cross-model; manual `/review` is single-model unless opted in), checking the
 * cross-model constraint, and evaluating the merge contract. Running the two model reviews
 * and performing the git merge are the orchestration this builds on.
 *
 * STATUS: contract stub. The type surface and signatures below are the contract pinned by
 * the test-first suite in `adjudication.test.ts` (test-plan.md §14). The function bodies are
 * intentionally unimplemented — a Phase 4 Layer-2-upgrade task fills them in. Until then the
 * suite is RED by design.
 *
 * Implementer note: enabling the cross-model path also requires flipping
 * `evaluatorDistinctFromGenerator` to `true` in `policies/model-policy.json` — otherwise the
 * policy resolves one provider for both Generator and Evaluator and `isCrossModel` would
 * reject every autonomous merge.
 *
 * See docs/projects/08-intent-layer/{spec.md (§"Layer 2"), test-plan.md (§14)}.
 */

import type { DispatchProvider } from './dispatch.js';

/** Whether a review uses one model or two-from-different-providers. */
export type ReviewMode = 'single-model' | 'cross-model';

/**
 * The result of a cross-model review — it records both the Generator and the Evaluator
 * (model + provider) and the Evaluator's verdict, so an autonomous merge is auditable.
 */
export interface Adjudication {
  generatorModel: string;
  generatorProvider: DispatchProvider;
  evaluatorModel: string;
  evaluatorProvider: DispatchProvider;
  /** The Evaluator's verdict on the Generator's output. */
  verdict: 'pass' | 'fail';
}

/**
 * The merge-contract decision. `merge: true` means the change may land on the repo's main
 * line with no human action; `merge: false` carries the reason it was held (which the
 * caller surfaces — typically escalating to blocked-on-Michael).
 */
export type MergeOutcome = { merge: true } | { merge: false; reason: string };

const NOT_IMPLEMENTED =
  'adjudication: not implemented — a Phase 4 Layer-2-upgrade task (docs/projects/08-intent-layer) fills this in';

/**
 * Resolve the review mode. An autonomous engine run is **always** cross-model — cross-model
 * review is mandatory before every autonomous merge. A manual `/review` is single-model by
 * default; `crossModelFlag` (the `--cross-model` opt-in) makes it cross-model.
 */
export function resolveReviewMode(_input: {
  autonomous: boolean;
  crossModelFlag: boolean;
}): ReviewMode {
  throw new Error(NOT_IMPLEMENTED);
}

/**
 * Whether an adjudication is genuinely cross-model — its Evaluator ran on a different
 * provider family than its Generator. A same-provider review does not satisfy the
 * cross-model requirement for an autonomous merge.
 */
export function isCrossModel(_adjudication: Adjudication): boolean {
  throw new Error(NOT_IMPLEMENTED);
}

/**
 * Evaluate the merge contract. A change merges only when all hold: a cross-model review
 * passed, the test suite passed, and the escalation policy did not flag the change. A `null`
 * adjudication means the cross-model review could not run (the second provider was
 * unavailable) — the contract is not satisfied and the run holds; it never degrades to a
 * single-model review and merges unreviewed.
 */
export function evaluateMergeContract(_input: {
  adjudication: Adjudication | null;
  testsPass: boolean;
  escalationFlags: boolean;
}): MergeOutcome {
  throw new Error(NOT_IMPLEMENTED);
}
