import type { SRState } from './sr-state.js';

export interface SelectDueOptions {
  /** Candidate concept paths (from `readPool`). */
  pool: string[];
  /** Current SR state — supplies each concept's `next_due`. */
  state: SRState;
  /** Today, as a YYYY-MM-DD string. */
  today: string;
  /** Maximum number of concepts to return. */
  cap: number;
  /** Tie-break RNG — injectable so tests can pin the ordering. Defaults to
   *  `Math.random`. */
  random?: () => number;
}

/** Select the concepts due for review, most-overdue first (Requirement #19).
 *
 *  A concept is due when its `next_due` is on or before `today`. `next_due`
 *  values are YYYY-MM-DD strings, which sort lexicographically in chronological
 *  order, so plain string comparison suffices — no date arithmetic. Results are
 *  ordered earliest-`next_due` first (most overdue), ties broken by `random`,
 *  and capped at `cap`.
 *
 *  Concepts in the pool but absent from SR state are treated as not yet due:
 *  admission (Requirement #9) schedules a new concept's first review for the
 *  day after it is admitted, so it never surfaces on its admission day.
 *  (`sr-session` admits pool concepts before calling this, so the absent case
 *  is only a defensive fallback.)
 *
 *  Pure: depends only on its arguments (with an injected `random`). */
export function selectDueConcepts(opts: SelectDueOptions): string[] {
  const { pool, state, today, cap, random = Math.random } = opts;

  const due = pool.flatMap((path) => {
    const nextDue = state.concepts[path]?.next_due;
    if (nextDue === undefined || nextDue > today) return [];
    return [{ path, nextDue, tiebreak: random() }];
  });

  due.sort((a, b) => {
    if (a.nextDue < b.nextDue) return -1;
    if (a.nextDue > b.nextDue) return 1;
    return a.tiebreak - b.tiebreak;
  });

  return due.slice(0, Math.max(0, cap)).map((x) => x.path);
}
