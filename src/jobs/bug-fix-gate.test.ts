import { describe, expect, expectTypeOf, it } from 'vitest';
import type { BugScopingFacts, FixGateResult } from './bug-fix-gate.js';

type LoadedGateModule = {
  evaluateBugFixGate: (facts: BugScopingFacts) => FixGateResult;
};

async function loadGate(): Promise<LoadedGateModule> {
  try {
    const mod = await import('./bug-fix-gate.js');
    expect(mod.evaluateBugFixGate, 'expected bug-fix-gate.ts to export evaluateBugFixGate').toBeTypeOf('function');
    return mod as LoadedGateModule;
  } catch (err) {
    throw new Error(
      `bug-fix-gate module missing or invalid: expected src/jobs/bug-fix-gate.ts exporting evaluateBugFixGate (${(err as Error).message})`,
    );
  }
}

function goodFacts(overrides: Record<string, unknown> = {}) {
  return {
    itemEligible: true,
    fieldsComplete: true,
    pmAssessed: true,
    pmWellScoped: true,
    techLeadReviewed: true,
    ...overrides,
  } as BugScopingFacts;
}

describe('evaluateBugFixGate - cockpit redesign Phase 3 Fix gate', () => {
  it('exports the Fix gate type contract names used by callers', async () => {
    const { evaluateBugFixGate } = await loadGate();

    expectTypeOf(evaluateBugFixGate).parameters.toEqualTypeOf<[BugScopingFacts]>();
    expectTypeOf(evaluateBugFixGate).returns.toEqualTypeOf<FixGateResult>();
  });

  it('proceeds only when the item is eligible, complete, PM-scoped, and TL-reviewed without objection', async () => {
    const { evaluateBugFixGate } = await loadGate();
    expect(evaluateBugFixGate(goodFacts())).toEqual({ decision: 'proceeding' });
  });

  it('fails closed on missing or ambiguous facts instead of proceeding', async () => {
    const { evaluateBugFixGate } = await loadGate();

    expect(evaluateBugFixGate({})).toEqual({
      decision: 'declined',
      reason: 'ineligible',
    });
    expect(evaluateBugFixGate(goodFacts({ itemEligible: undefined }))).toEqual({
      decision: 'declined',
      reason: 'ineligible',
    });
    expect(evaluateBugFixGate(goodFacts({ fieldsComplete: undefined }))).toEqual({
      decision: 'declined',
      reason: 'incomplete-fields',
    });
    expect(evaluateBugFixGate(goodFacts({ pmAssessed: undefined }))).toEqual({
      decision: 'declined',
      reason: 'pm-not-well-scoped',
      detail: expect.any(String),
    });
    expect(evaluateBugFixGate(goodFacts({ pmAssessed: false }))).toEqual({
      decision: 'declined',
      reason: 'pm-not-well-scoped',
      detail: expect.any(String),
    });
    expect(evaluateBugFixGate(goodFacts({ pmWellScoped: undefined }))).toEqual({
      decision: 'declined',
      reason: 'pm-not-well-scoped',
      detail: expect.any(String),
    });
    expect(evaluateBugFixGate(goodFacts({ techLeadReviewed: undefined }))).toEqual({
      decision: 'declined',
      reason: 'tech-lead-objection',
      detail: expect.any(String),
    });
    expect(evaluateBugFixGate(goodFacts({ techLeadReviewed: false }))).toEqual({
      decision: 'declined',
      reason: 'tech-lead-objection',
      detail: expect.any(String),
    });
  });

  it('is fact-ordered: ineligible beats incomplete, PM, and Tech-Lead failures', async () => {
    const { evaluateBugFixGate } = await loadGate();

    expect(
      evaluateBugFixGate(
        goodFacts({
          itemEligible: false,
          fieldsComplete: false,
          pmAssessed: false,
          pmWellScoped: false,
          techLeadObjection: 'unsafe without reproduction steps',
        }),
      ),
    ).toEqual({ decision: 'declined', reason: 'ineligible' });
  });

  it('orders incomplete fields before PM and Tech-Lead decisions', async () => {
    const { evaluateBugFixGate } = await loadGate();

    expect(
      evaluateBugFixGate(
        goodFacts({
          fieldsComplete: false,
          pmAssessed: true,
          pmWellScoped: false,
          pmReason: 'missing customer impact',
          techLeadObjection: 'missing repro',
        }),
      ),
    ).toEqual({ decision: 'declined', reason: 'incomplete-fields' });
  });

  it('declines with the PM reason when the PM says the bug is not well scoped', async () => {
    const { evaluateBugFixGate } = await loadGate();

    expect(
      evaluateBugFixGate(
        goodFacts({
          pmWellScoped: false,
          pmReason: 'The bug names a symptom but gives no reproduction path.',
        }),
      ),
    ).toEqual({
      decision: 'declined',
      reason: 'pm-not-well-scoped',
      detail: 'The bug names a symptom but gives no reproduction path.',
    });
  });

  it('orders a PM not-well-scoped decision before any Tech-Lead objection', async () => {
    const { evaluateBugFixGate } = await loadGate();

    expect(
      evaluateBugFixGate(
        goodFacts({
          pmWellScoped: false,
          pmReason: 'No concrete observed behavior.',
          techLeadReviewed: true,
          techLeadObjection: 'Needs a migration plan.',
        }),
      ),
    ).toEqual({
      decision: 'declined',
      reason: 'pm-not-well-scoped',
      detail: 'No concrete observed behavior.',
    });
  });

  it('declines on a Tech-Lead objection and preserves the objection detail', async () => {
    const { evaluateBugFixGate } = await loadGate();

    expect(
      evaluateBugFixGate(
        goodFacts({
          techLeadObjection: 'Needs a migration plan before a one-click fix run.',
        }),
      ),
    ).toEqual({
      decision: 'declined',
      reason: 'tech-lead-objection',
      detail: 'Needs a migration plan before a one-click fix run.',
    });
  });
});
