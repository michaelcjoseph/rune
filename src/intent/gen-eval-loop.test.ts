import { describe, it, expect } from 'vitest';

/*
 * Test-first suite for test-plan.md §12 — single-model Generator-Evaluator loop, Layer 2
 * (08-intent-layer, Phase 3).
 *
 * Written BEFORE the implementation. `src/intent/gen-eval-loop.ts` ships as a contract stub
 * whose functions throw 'not implemented', so every test here is RED. That is the intended,
 * correct state: this is a "Tests (write first)" task — the suite goes green when a Phase 3
 * Layer-2 implementation task lands. Do not implement the loop to make these pass.
 *
 * Scope note: §12's "the Generator works test-first" is a property of the `/work` skill
 * itself (it writes failing tests before implementation) — covered by `/work`'s own
 * behavior, not by this loop-decision suite. The end-to-end run against a real repo is
 * integration. This suite pins the deterministic loop-decision core.
 */

import {
  recordRound,
  evaluateLoop,
  type LoopRound,
} from './gen-eval-loop.js';

// --- Fixtures ---

/** A round where tests passed and the Evaluator returned `pass`. */
const passingRound: LoopRound = { testsPass: true, evaluatorVerdict: 'pass' };
/** A round where tests passed but the Evaluator returned `fail`. */
const evaluatorFailRound: LoopRound = { testsPass: true, evaluatorVerdict: 'fail' };
/** A round where the project's own tests failed — the Evaluator was never reached. */
const testsFailRound: LoopRound = { testsPass: false, evaluatorVerdict: 'not-run' };

describe('Generator-Evaluator loop — recording a round (test-plan §12)', () => {
  it('records the Evaluator verdict for a round whose tests passed', () => {
    expect(recordRound(true, 'pass')).toEqual({ testsPass: true, evaluatorVerdict: 'pass' });
    expect(recordRound(true, 'fail')).toEqual({ testsPass: true, evaluatorVerdict: 'fail' });
  });

  it('forces a test-failing round to not-run — it never reaches the Evaluator as ready', () => {
    // Even though `pass` is supplied, a failed test suite means the Evaluator never ran.
    expect(recordRound(false, 'pass')).toEqual({ testsPass: false, evaluatorVerdict: 'not-run' });
  });
});

describe('Generator-Evaluator loop — the success terminal (test-plan §12)', () => {
  it('ends on-branch once the Evaluator passes a round', () => {
    const outcome = evaluateLoop([evaluatorFailRound, passingRound], 3);
    expect(outcome.status).toBe('on-branch');
  });

  it('stops at a branch — the single-model loop never reports a merged status', () => {
    // Phase 3 holds autonomous merge until Phase 4; the only success terminal is on-branch.
    // (`LoopStatus` has no `merged` member — autonomous merge cannot even be expressed here.)
    expect(evaluateLoop([passingRound], 3).status).toBe('on-branch');
  });
});

describe('Generator-Evaluator loop — the Evaluator gate (test-plan §12)', () => {
  it('does not end the loop on tests passing alone — the Evaluator must pass too', () => {
    // A separate, skeptical Evaluator pass is required; a green test suite is not enough.
    // (That every tests-passed round carries a real Evaluator verdict is pinned by the
    // recordRound tests above — the Evaluator runs as a step of every such round.)
    const outcome = evaluateLoop([evaluatorFailRound], 3);
    expect(outcome.status).not.toBe('on-branch');
  });
});

describe('Generator-Evaluator loop — the bound (test-plan §12)', () => {
  it('escalates after maxEvaluatorRounds failed Evaluator rounds — not retried forever', () => {
    const outcome = evaluateLoop([evaluatorFailRound, evaluatorFailRound, evaluatorFailRound], 3);
    expect(outcome.status).toBe('escalated');
    expect(outcome.failedEvaluatorRounds).toBe(3);
  });

  it('stays in-progress while failed Evaluator rounds are below the bound', () => {
    const outcome = evaluateLoop([evaluatorFailRound, evaluatorFailRound], 3);
    expect(outcome.status).toBe('in-progress');
    expect(outcome.failedEvaluatorRounds).toBe(2);
  });

  it('does not count test-failing rounds toward the Evaluator-round bound', () => {
    // Three test-failing rounds: the Evaluator never ran, so none count against the bound.
    const outcome = evaluateLoop([testsFailRound, testsFailRound, testsFailRound], 3);
    expect(outcome.status).toBe('in-progress');
    expect(outcome.failedEvaluatorRounds).toBe(0);
  });

  it('escalates even if a pass round follows — the loop had already hit the bound', () => {
    // The loop would have escalated at round 3; a 4th passing round is unreachable, so it
    // does not rescue the run. The first terminal reached, in round order, wins.
    const outcome = evaluateLoop(
      [evaluatorFailRound, evaluatorFailRound, evaluatorFailRound, passingRound],
      3,
    );
    expect(outcome.status).toBe('escalated');
  });
});

describe('Generator-Evaluator loop — in-progress (test-plan §12)', () => {
  it('reports in-progress for a loop with no rounds yet', () => {
    expect(evaluateLoop([], 3).status).toBe('in-progress');
  });
});
