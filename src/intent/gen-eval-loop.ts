/**
 * Generator-Evaluator loop, single-model — Layer 2 of the intent layer's execution engine.
 * `/work` is the Generator (test-first: it writes failing tests, then implements); `/review`
 * is the Evaluator, a separate skeptical pass. The loop runs Generator → tests → Evaluator
 * each round and is **bounded**: after a few failed Evaluator rounds the run escalates to
 * blocked-on-Michael rather than retrying forever.
 *
 * In Phase 3 the loop is single-model and **stops at a branch** — it never merges to a
 * repo's main line on its own. Autonomous merge is held until Phase 4, when cross-model
 * review (the other half of the merge contract) exists.
 *
 * This module is the deterministic decision core of that loop: recording a round (with the
 * invariant that a test-failing round never reaches the Evaluator) and deciding the loop's
 * outcome from its round history. Running the actual `/work` and `/review` skills is
 * orchestration that drives this core.
 *
 * STATUS: contract stub. The type surface and signatures below are the contract pinned by
 * the test-first suite in `gen-eval-loop.test.ts` (test-plan.md §12). The function bodies
 * are intentionally unimplemented — a Phase 3 Layer-2 task fills them in. Until then the
 * suite is RED by design.
 *
 * See docs/projects/08-intent-layer/{spec.md (§"Layer 2"), test-plan.md (§12)}.
 */

/**
 * The Evaluator's verdict for a loop round. `not-run` means the round's own tests failed,
 * so the run never reached the Evaluator as "ready".
 */
export type EvaluatorVerdict = 'pass' | 'fail' | 'not-run';

/** One pass of the Generator-Evaluator loop. */
export interface LoopRound {
  /** Whether the project's own test suite passed this round. */
  testsPass: boolean;
  /** The Evaluator's verdict — `not-run` whenever `testsPass` is false. */
  evaluatorVerdict: EvaluatorVerdict;
}

/**
 * The loop's status. `on-branch` is the Phase 3 success terminal — the result sits on a
 * branch, never merged. `escalated` is the bounded-loop terminal — blocked on Michael.
 */
export type LoopStatus = 'in-progress' | 'on-branch' | 'escalated';

/** The decided outcome of a loop. */
export interface LoopOutcome {
  status: LoopStatus;
  /** How many rounds the Evaluator returned `fail` — the count the bound is measured against. */
  failedEvaluatorRounds: number;
}

const NOT_IMPLEMENTED =
  'gen-eval-loop: not implemented — a Phase 3 Layer-2 task (docs/projects/08-intent-layer) fills this in';

/**
 * Record a loop round. When `testsPass` is false the Evaluator is never consulted, so the
 * round's verdict is forced to `not-run` regardless of `evaluatorVerdict` — a run that
 * fails its own tests never reaches the Evaluator. When `testsPass` is true the supplied
 * `evaluatorVerdict` (`pass` or `fail`) is recorded.
 */
export function recordRound(
  _testsPass: boolean,
  _evaluatorVerdict: 'pass' | 'fail',
): LoopRound {
  throw new Error(NOT_IMPLEMENTED);
}

/**
 * Decide the loop's outcome from its round history. A round whose Evaluator returned `pass`
 * ends the loop `on-branch` — the single-model loop stops at a branch and never merges to
 * main. Once the Evaluator has returned `fail` on `maxEvaluatorRounds` rounds, the run is
 * `escalated` to blocked-on-Michael rather than retried forever. Otherwise the loop is
 * `in-progress`. Test-failing rounds (Evaluator `not-run`) do not count toward the bound.
 *
 * Rounds are evaluated in order; the first terminal reached decides the outcome — a `pass`
 * recorded only after the bound was already hit does not rescue an escalated run (the loop
 * would have stopped escalating before that round could run).
 */
export function evaluateLoop(_rounds: LoopRound[], _maxEvaluatorRounds: number): LoopOutcome {
  throw new Error(NOT_IMPLEMENTED);
}
