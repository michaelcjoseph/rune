import { describe, it, expect } from 'vitest';

/*
 * Test suite for the friction-detection extension to Ask-Twice intent telemetry
 * (08-intent-layer, Phase 5). The detection itself — categorizing intent-log / interaction
 * events as recurring-friction, bug-fixed, or failed-interaction — is LLM/heuristic
 * integration; this module owns the deterministic **dedupe + aggregation** half: same id
 * collapses into one entry with an occurrence count, and the result is sorted by
 * frequency so the most-frequent friction surfaces first.
 *
 * Scope: aggregateFrictions over already-classified `FrictionSignal`s; the upstream
 * detection is integration that feeds it.
 */

import { aggregateFrictions, type FrictionSignal } from './friction-detect.js';

function s(id: string, category: FrictionSignal['category'] = 'recurring-friction'): FrictionSignal {
  return { id, category, description: `friction ${id}` };
}

describe('friction detect — aggregateFrictions', () => {
  it('returns an empty list for no input', () => {
    expect(aggregateFrictions([])).toEqual([]);
  });

  it('reports a single observation as occurrences: 1', () => {
    const out = aggregateFrictions([s('x')]);
    expect(out).toEqual([{ ...s('x'), occurrences: 1 }]);
  });

  it('collapses repeated signals with the same id into one entry with the occurrence count', () => {
    const out = aggregateFrictions([s('x'), s('x'), s('x')]);
    expect(out).toEqual([{ ...s('x'), occurrences: 3 }]);
  });

  it('keeps distinct ids as distinct entries', () => {
    const out = aggregateFrictions([s('x'), s('y'), s('x'), s('z')]);
    // Three distinct ids: x (2), y (1), z (1).
    expect(out).toHaveLength(3);
    expect(out.map((e) => e.id).sort()).toEqual(['x', 'y', 'z']);
  });

  it('sorts results most-frequent-first so the noisiest friction surfaces first', () => {
    const out = aggregateFrictions([s('rare'), s('common'), s('common'), s('common'), s('mid'), s('mid')]);
    expect(out.map((e) => ({ id: e.id, occurrences: e.occurrences }))).toEqual([
      { id: 'common', occurrences: 3 },
      { id: 'mid', occurrences: 2 },
      { id: 'rare', occurrences: 1 },
    ]);
  });

  it('is first-wins when same-id observations carry diverging categories', () => {
    // The upstream detector derives the id from category+description, so divergence here
    // is a caller bug — but it should be silent rather than throw, with the first
    // observation deciding the surfaced category and the later one just bumping the count.
    const out = aggregateFrictions([s('x', 'bug-fixed'), s('x', 'recurring-friction')]);
    expect(out).toEqual([{ ...s('x', 'bug-fixed'), occurrences: 2 }]);
  });

  it('preserves the category of each grouped signal', () => {
    const out = aggregateFrictions([
      s('bug', 'bug-fixed'),
      s('fail', 'failed-interaction'),
      s('fric', 'recurring-friction'),
    ]);
    const byId = new Map(out.map((e) => [e.id, e.category]));
    expect(byId.get('bug')).toBe('bug-fixed');
    expect(byId.get('fail')).toBe('failed-interaction');
    expect(byId.get('fric')).toBe('recurring-friction');
  });
});
