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
 * STATUS: implemented. The decision core — `recordRound` and `evaluateLoop` — is live; the
 * contract is pinned by the test suite in `gen-eval-loop.test.ts` (test-plan.md §12).
 * Running the actual `/work` Generator and `/review` Evaluator against a repo-backed
 * product is orchestration that drives this core.
 *
 * See docs/projects/08-intent-layer/{spec.md (§"Layer 2"), test-plan.md (§12)}.
 */

/**
 * One pass of the Generator-Evaluator loop — a discriminated union on `testsPass`. A
 * tests-passed round carries a real Evaluator verdict (`pass` or `fail`); a tests-failed
 * round never reached the Evaluator, so its verdict is `not-run`. The incoherent
 * combinations — tests passed but `not-run`, or tests failed with a real verdict — are
 * unrepresentable by construction.
 */
export type LoopRound =
  | { testsPass: true; evaluatorVerdict: 'pass' | 'fail' }
  | { testsPass: false; evaluatorVerdict: 'not-run' };

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

/**
 * Record a loop round. When `testsPass` is false the Evaluator is never consulted, so the
 * round's verdict is forced to `not-run` regardless of `evaluatorVerdict` — a run that
 * fails its own tests never reaches the Evaluator. When `testsPass` is true the supplied
 * `evaluatorVerdict` (`pass` or `fail`) is recorded.
 */
export function recordRound(
  testsPass: boolean,
  evaluatorVerdict: 'pass' | 'fail',
): LoopRound {
  return testsPass
    ? { testsPass: true, evaluatorVerdict }
    : { testsPass: false, evaluatorVerdict: 'not-run' };
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
 *
 * `maxEvaluatorRounds` must be a positive integer (`>= 1`) — a bound of zero or below is
 * rejected, since a loop cannot escalate before its first Evaluator round runs.
 */
export function evaluateLoop(rounds: LoopRound[], maxEvaluatorRounds: number): LoopOutcome {
  if (maxEvaluatorRounds < 1) {
    throw new RangeError(
      `evaluateLoop: maxEvaluatorRounds must be a positive integer — got ${maxEvaluatorRounds}`,
    );
  }
  let failedEvaluatorRounds = 0;
  for (const round of rounds) {
    if (round.evaluatorVerdict === 'pass') {
      return { status: 'on-branch', failedEvaluatorRounds };
    }
    if (round.evaluatorVerdict === 'fail') {
      failedEvaluatorRounds += 1;
      if (failedEvaluatorRounds >= maxEvaluatorRounds) {
        return { status: 'escalated', failedEvaluatorRounds };
      }
    }
  }
  return { status: 'in-progress', failedEvaluatorRounds };
}
