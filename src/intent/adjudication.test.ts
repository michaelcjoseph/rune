import { describe, it, expect } from 'vitest';

/*
 * Test-first suite for test-plan.md §14 — cross-model adjudication, Layer 2 upgrade
 * (08-intent-layer, Phase 4).
 *
 * Written BEFORE the implementation. `src/intent/adjudication.ts` ships as a contract stub
 * whose functions throw 'not implemented', so every test here is RED. That is the intended,
 * correct state: this is a "Tests (write first)" task — the suite goes green when the
 * Phase 4 Layer-2-upgrade implementation task lands. Do not implement it to make these pass.
 *
 * Scope note: §14's "the single-model loop from Phase 3 still works" is a regression
 * property of gen-eval-loop.ts — covered by that module's own suite staying green, not here.
 * Running the two model reviews and the git merge are integration. This suite pins the
 * deterministic core — review-mode resolution, the cross-model constraint, the merge contract.
 */

import {
  resolveReviewMode,
  isCrossModel,
  evaluateMergeContract,
  type Adjudication,
} from './adjudication.js';

// --- Fixtures ---

/**
 * A cross-model adjudication (Anthropic Generator, OpenAI Evaluator); override per test.
 * The model strings are illustrative — `Adjudication` records the model that ran as an
 * opaque identifier; this layer does not validate it against the model-selection policy.
 */
function adjudication(overrides: Partial<Adjudication> = {}): Adjudication {
  return {
    generatorModel: 'opus',
    generatorProvider: 'anthropic',
    evaluatorModel: 'gpt-5-codex',
    evaluatorProvider: 'openai',
    verdict: 'pass',
    ...overrides,
  };
}

describe('cross-model adjudication — review mode (test-plan §14)', () => {
  it('an autonomous engine run is always cross-model', () => {
    expect(resolveReviewMode({ autonomous: true, crossModelFlag: false })).toBe('cross-model');
  });

  it('a manual review is single-model by default', () => {
    expect(resolveReviewMode({ autonomous: false, crossModelFlag: false })).toBe('single-model');
  });

  it('a manual review opts into cross-model with the --cross-model flag', () => {
    expect(resolveReviewMode({ autonomous: false, crossModelFlag: true })).toBe('cross-model');
  });

  it('an autonomous run ignores the --cross-model flag — it is always cross-model', () => {
    expect(resolveReviewMode({ autonomous: true, crossModelFlag: true })).toBe('cross-model');
  });
});

describe('cross-model adjudication — the cross-model constraint (test-plan §14)', () => {
  it('is cross-model when the Evaluator ran on a different provider than the Generator', () => {
    expect(isCrossModel(adjudication({ generatorProvider: 'anthropic', evaluatorProvider: 'openai' }))).toBe(true);
  });

  it('is not cross-model when both ran on the same provider', () => {
    expect(isCrossModel(adjudication({ generatorProvider: 'anthropic', evaluatorProvider: 'anthropic' }))).toBe(false);
  });
});

describe('cross-model adjudication — the merge contract (test-plan §14)', () => {
  it('merges when cross-model review passes, tests pass, and escalation does not flag', () => {
    const outcome = evaluateMergeContract({
      adjudication: adjudication({ verdict: 'pass' }),
      testsPass: true,
      escalationFlags: false,
    });
    expect(outcome.merge).toBe(true);
  });

  it('does not merge when the cross-model review verdict is fail', () => {
    const outcome = evaluateMergeContract({
      adjudication: adjudication({ verdict: 'fail' }),
      testsPass: true,
      escalationFlags: false,
    });
    expect(outcome.merge).toBe(false);
  });

  it('does not merge when the test suite did not pass', () => {
    const outcome = evaluateMergeContract({
      adjudication: adjudication({ verdict: 'pass' }),
      testsPass: false,
      escalationFlags: false,
    });
    expect(outcome.merge).toBe(false);
  });

  it('does not merge when the escalation policy flags the change', () => {
    const outcome = evaluateMergeContract({
      adjudication: adjudication({ verdict: 'pass' }),
      testsPass: true,
      escalationFlags: true,
    });
    expect(outcome.merge).toBe(false);
  });

  it('does not merge on a same-provider review — an autonomous merge requires cross-model', () => {
    const outcome = evaluateMergeContract({
      adjudication: adjudication({ generatorProvider: 'anthropic', evaluatorProvider: 'anthropic' }),
      testsPass: true,
      escalationFlags: false,
    });
    expect(outcome.merge).toBe(false);
  });
});

describe('cross-model adjudication — second provider unavailable (test-plan §14)', () => {
  it('holds the run when the cross-model review could not run — no degrade to unreviewed merge', () => {
    // A null adjudication means the second provider was unavailable. Even with tests passing
    // and no escalation flag, the merge contract is not satisfied — the run does not degrade
    // to a single-model review and merge unreviewed.
    const outcome = evaluateMergeContract({
      adjudication: null,
      testsPass: true,
      escalationFlags: false,
    });
    // toMatchObject asserts both fields at once — MergeOutcome's discriminated union cannot
    // be narrowed off `merge` for direct `.reason` access without a runtime type guard.
    expect(outcome).toMatchObject({ merge: false, reason: expect.stringMatching(/unavailable|review|cross-model/i) });
  });
});

// §14's 🟢 "the adjudication result records both models and the verdict" is the `Adjudication`
// type's own shape — exercised here by isCrossModel reading both providers and
// evaluateMergeContract reading the verdict, not by a separate fixture-only assertion.
