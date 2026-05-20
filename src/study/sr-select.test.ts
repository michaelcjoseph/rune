import { describe, it, expect, vi } from 'vitest';

// sr-state.ts imports vault/files.ts which triggers config.ts env-var checks
// at module load time. Mock them before any import so the module graph
// resolves cleanly without requiring real env vars.
vi.mock('../vault/files.js', () => ({
  readVaultFile: vi.fn(),
  writeVaultFile: vi.fn(),
}));

vi.mock('../utils/logger.js', () => ({
  createLogger: () => ({
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const { selectDueConcepts } = await import('./sr-select.js');
const { emptyState, admitConcept } = await import('./sr-state.js');
import type { SRState, ConceptState } from './sr-state.js';

const TODAY = '2026-05-20';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal SRState containing exactly the given (path → next_due) pairs. */
function stateWithDates(entries: Record<string, string>): SRState {
  const concepts: Record<string, ConceptState> = {};
  for (const [path, next_due] of Object.entries(entries)) {
    concepts[path] = {
      concept_path: path,
      admitted_date: '2026-01-01',
      current_rung: '7d',
      next_due,
      last_reviewed: null,
      last_grade: null,
      review_count: 0,
      lapse_count: 0,
      last_questions: [],
    };
  }
  return { concepts, meta: { last_session_at: null, last_session_summary: null } };
}

/** A deterministic random stub: always returns 0. */
const alwaysZero = () => 0;

/** A deterministic random stub: always returns 1. */
const alwaysOne = () => 1;

/** Run selectDueConcepts with two equal-next_due concepts and a value sequence. */
function tiebreakOrder(values: number[]): string[] {
  const state = stateWithDates({ 'concepts/a.md': '2026-05-19', 'concepts/b.md': '2026-05-19' });
  let i = 0;
  return selectDueConcepts({
    pool: ['concepts/a.md', 'concepts/b.md'],
    state,
    today: TODAY,
    cap: 10,
    random: () => values[i++] ?? 0,
  });
}

// ---------------------------------------------------------------------------
// Filtering: only concepts with next_due <= today
// ---------------------------------------------------------------------------

describe('selectDueConcepts — filtering', () => {
  it('returns only concepts whose next_due is on or before today', () => {
    const state = stateWithDates({
      'concepts/overdue.md': '2026-05-18',   // 2 days ago — due
      'concepts/today.md': '2026-05-20',      // today — due
      'concepts/tomorrow.md': '2026-05-21',   // future — not due
      'concepts/future.md': '2026-06-01',     // future — not due
    });
    const pool = Object.keys(state.concepts);

    const result = selectDueConcepts({ pool, state, today: TODAY, cap: 10, random: alwaysZero });

    expect(result).toContain('concepts/overdue.md');
    expect(result).toContain('concepts/today.md');
    expect(result).not.toContain('concepts/tomorrow.md');
    expect(result).not.toContain('concepts/future.md');
  });

  it('excludes concepts whose next_due is exactly one day in the future', () => {
    const state = stateWithDates({ 'concepts/almost.md': '2026-05-21' });
    const result = selectDueConcepts({
      pool: ['concepts/almost.md'],
      state,
      today: TODAY,
      cap: 10,
      random: alwaysZero,
    });
    expect(result).toEqual([]);
  });

  it('includes a concept whose next_due equals today exactly', () => {
    const state = stateWithDates({ 'concepts/exactly-today.md': TODAY });
    const result = selectDueConcepts({
      pool: ['concepts/exactly-today.md'],
      state,
      today: TODAY,
      cap: 10,
      random: alwaysZero,
    });
    expect(result).toEqual(['concepts/exactly-today.md']);
  });
});

// ---------------------------------------------------------------------------
// Sorting: most-overdue first; ties broken by injected random
// ---------------------------------------------------------------------------

describe('selectDueConcepts — ordering', () => {
  it('sorts by earliest next_due first (most overdue first)', () => {
    const state = stateWithDates({
      'concepts/recent.md': '2026-05-19',    // 1 day ago
      'concepts/older.md': '2026-05-10',     // 10 days ago
      'concepts/oldest.md': '2026-04-01',    // 49 days ago
    });
    const pool = Object.keys(state.concepts);

    const result = selectDueConcepts({ pool, state, today: TODAY, cap: 10, random: alwaysZero });

    expect(result[0]).toBe('concepts/oldest.md');
    expect(result[1]).toBe('concepts/older.md');
    expect(result[2]).toBe('concepts/recent.md');
  });

  it('breaks ties via injected random — lower tiebreak value sorts first', () => {
    // [0.1, 0.9]: A gets lower tiebreak → A before B.
    expect(tiebreakOrder([0.1, 0.9])).toEqual(['concepts/a.md', 'concepts/b.md']);
  });

  it('reversed random order produces reversed tie result', () => {
    // [0.9, 0.1]: A gets higher tiebreak → B before A.
    expect(tiebreakOrder([0.9, 0.1])).toEqual(['concepts/b.md', 'concepts/a.md']);
  });
});

// ---------------------------------------------------------------------------
// Cap
// ---------------------------------------------------------------------------

describe('selectDueConcepts — cap', () => {
  it('never returns more than cap results', () => {
    const state = stateWithDates({
      'concepts/a.md': '2026-05-01',
      'concepts/b.md': '2026-05-02',
      'concepts/c.md': '2026-05-03',
      'concepts/d.md': '2026-05-04',
      'concepts/e.md': '2026-05-05',
    });
    const pool = Object.keys(state.concepts);

    const result = selectDueConcepts({ pool, state, today: TODAY, cap: 3, random: alwaysZero });

    expect(result).toHaveLength(3);
  });

  it('returns the 3 most-overdue concepts when cap=3', () => {
    const state = stateWithDates({
      'concepts/a.md': '2026-05-01',   // oldest
      'concepts/b.md': '2026-05-02',
      'concepts/c.md': '2026-05-03',
      'concepts/d.md': '2026-05-04',   // most recent, excluded by cap
    });
    const pool = Object.keys(state.concepts);

    const result = selectDueConcepts({ pool, state, today: TODAY, cap: 3, random: alwaysZero });

    expect(result).toContain('concepts/a.md');
    expect(result).toContain('concepts/b.md');
    expect(result).toContain('concepts/c.md');
    expect(result).not.toContain('concepts/d.md');
  });

  it('cap of 0 returns []', () => {
    const state = stateWithDates({ 'concepts/due.md': '2026-05-01' });
    const result = selectDueConcepts({
      pool: ['concepts/due.md'],
      state,
      today: TODAY,
      cap: 0,
      random: alwaysZero,
    });
    expect(result).toEqual([]);
  });

  it('cap of a negative number returns []', () => {
    const state = stateWithDates({ 'concepts/due.md': '2026-05-01' });
    const result = selectDueConcepts({
      pool: ['concepts/due.md'],
      state,
      today: TODAY,
      cap: -5,
      random: alwaysZero,
    });
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Pool smaller than cap
// ---------------------------------------------------------------------------

describe('selectDueConcepts — pool smaller than cap', () => {
  it('returns all due concepts when pool size < cap (no throw)', () => {
    const state = stateWithDates({
      'concepts/a.md': '2026-05-01',
      'concepts/b.md': '2026-05-02',
    });
    const pool = Object.keys(state.concepts);

    const result = selectDueConcepts({ pool, state, today: TODAY, cap: 10, random: alwaysZero });

    expect(result).toHaveLength(2);
    expect(result).toContain('concepts/a.md');
    expect(result).toContain('concepts/b.md');
  });

  it('cap of 1 with a single due concept returns that one concept', () => {
    const state = stateWithDates({ 'concepts/only.md': '2026-05-10' });

    const result = selectDueConcepts({
      pool: ['concepts/only.md'],
      state,
      today: TODAY,
      cap: 1,
      random: alwaysZero,
    });

    expect(result).toEqual(['concepts/only.md']);
  });
});

// ---------------------------------------------------------------------------
// Empty pool
// ---------------------------------------------------------------------------

describe('selectDueConcepts — empty pool', () => {
  it('returns [] for an empty pool', () => {
    const state = emptyState();
    const result = selectDueConcepts({ pool: [], state, today: TODAY, cap: 5, random: alwaysZero });
    expect(result).toEqual([]);
  });

  it('returns [] for an empty pool even with a populated state', () => {
    const state = stateWithDates({ 'concepts/a.md': '2026-05-01' });
    const result = selectDueConcepts({ pool: [], state, today: TODAY, cap: 5, random: alwaysZero });
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Concepts in pool but absent from state — treated as not due (excluded)
// ---------------------------------------------------------------------------

describe('selectDueConcepts — concept absent from state', () => {
  it('excludes a concept that is in the pool but missing from state', () => {
    const state = emptyState(); // no concepts in state at all

    const result = selectDueConcepts({
      pool: ['concepts/ghost.md'],
      state,
      today: TODAY,
      cap: 10,
      random: alwaysZero,
    });

    expect(result).toEqual([]);
  });

  it('excludes absent-state concepts while still including present due ones', () => {
    const state = stateWithDates({ 'concepts/due.md': '2026-05-10' });

    const result = selectDueConcepts({
      pool: ['concepts/due.md', 'concepts/ghost.md'],
      state,
      today: TODAY,
      cap: 10,
      random: alwaysZero,
    });

    expect(result).toEqual(['concepts/due.md']);
    expect(result).not.toContain('concepts/ghost.md');
  });

  it('concept admitted to state but not yet due (admitted today, next_due tomorrow) is excluded', () => {
    // admitConcept sets next_due = today + 1d, so newly admitted concepts are
    // not due on their admission day — this matches the production behaviour.
    const state = admitConcept(emptyState(), 'concepts/new.md', TODAY);

    const result = selectDueConcepts({
      pool: ['concepts/new.md'],
      state,
      today: TODAY,
      cap: 10,
      random: alwaysZero,
    });

    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Default random (Math.random) — smoke test that omitting `random` works
// ---------------------------------------------------------------------------

describe('selectDueConcepts — default random', () => {
  it('works when random is not provided (uses Math.random implicitly)', () => {
    const state = stateWithDates({
      'concepts/a.md': '2026-05-01',
      'concepts/b.md': '2026-05-02',
    });
    const pool = Object.keys(state.concepts);

    // Should not throw and should return the two due concepts.
    const result = selectDueConcepts({ pool, state, today: TODAY, cap: 10 });

    expect(result).toHaveLength(2);
    expect(new Set(result)).toEqual(new Set(['concepts/a.md', 'concepts/b.md']));
  });
});

// ---------------------------------------------------------------------------
// Immutability — pure function must not mutate inputs
// ---------------------------------------------------------------------------

describe('selectDueConcepts — immutability', () => {
  it('does not mutate the pool array', () => {
    const state = stateWithDates({ 'concepts/a.md': '2026-05-01' });
    const pool = ['concepts/a.md'];
    const poolSnapshot = JSON.stringify(pool);

    selectDueConcepts({ pool, state, today: TODAY, cap: 5, random: alwaysZero });

    expect(JSON.stringify(pool)).toBe(poolSnapshot);
  });

  it('does not mutate the state object', () => {
    const state = stateWithDates({ 'concepts/a.md': '2026-05-01' });
    const stateSnapshot = JSON.stringify(state);

    selectDueConcepts({ pool: ['concepts/a.md'], state, today: TODAY, cap: 5, random: alwaysZero });

    expect(JSON.stringify(state)).toBe(stateSnapshot);
  });
});
