import { readVaultFile, writeVaultFile } from '../vault/files.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('sr-state');

/** Relative vault path to the spaced-repetition state store. */
export const SR_STATE_PATH = 'study/spaced-repetition.json';

/** Fixed-interval ladder, ascending. The last entry is the cap. */
export const RUNGS = ['1d', '3d', '7d', '14d', '30d', '60d', '120d'] as const;
export type Rung = (typeof RUNGS)[number];

/** Days until the next review for a rung — derived from the rung label, which
 *  is always "<N>d" (e.g. "14d" → 14). */
function rungDays(rung: Rung): number {
  return parseInt(rung, 10);
}

/** Grades a reviewer can assign, worst to best. */
export const GRADES = ['again', 'hard', 'good', 'easy'] as const;
export type Grade = (typeof GRADES)[number];

/** Per-concept spaced-repetition state. */
export interface ConceptState {
  concept_path: string;
  admitted_date: string; // YYYY-MM-DD
  current_rung: Rung;
  next_due: string; // YYYY-MM-DD
  last_reviewed: string | null; // YYYY-MM-DD
  last_grade: Grade | null;
  review_count: number;
  lapse_count: number;
  last_questions: string[]; // last 3 question texts, oldest first
}

/** The whole SR state store (`study/spaced-repetition.json`). */
export interface SRState {
  concepts: Record<string, ConceptState>;
  meta: {
    last_session_at: string | null; // ISO timestamp
    last_session_summary: string | null;
  };
}

/** Thrown for invalid input or a corrupt state file. */
export class SRStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SRStateError';
  }
}

/** A fresh, empty SR state. */
export function emptyState(): SRState {
  return { concepts: {}, meta: { last_session_at: null, last_session_summary: null } };
}

// --- date arithmetic -------------------------------------------------------

/** Add `days` calendar days to a YYYY-MM-DD date string. Anchored at UTC
 *  midnight so DST transitions cannot shift the result — pure calendar math. */
function addDays(dateStr: string, days: number): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    throw new SRStateError(`Invalid date (expected YYYY-MM-DD): ${dateStr}`);
  }
  const parts = dateStr.split('-');
  const dt = new Date(Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2])));
  dt.setUTCDate(dt.getUTCDate() + days);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

// --- persistence -----------------------------------------------------------

/** Throw if a parsed concept entry is structurally unsound. Validates the
 *  fields whose bad values would propagate silently (a bad `current_rung`
 *  yields `undefined` from RUNG_DAYS → a `NaN` next_due). */
function assertValidConcept(path: string, entry: unknown): void {
  const prefix = `Corrupt SR state file (${SR_STATE_PATH}): concept "${path}"`;
  if (typeof entry !== 'object' || entry === null) {
    throw new SRStateError(`${prefix} is not an object`);
  }
  const c = entry as Partial<ConceptState>;
  if (!(RUNGS as readonly unknown[]).includes(c.current_rung)) {
    throw new SRStateError(`${prefix} has invalid current_rung "${String(c.current_rung)}"`);
  }
  if (c.last_grade !== null && c.last_grade !== undefined && !(GRADES as readonly unknown[]).includes(c.last_grade)) {
    throw new SRStateError(`${prefix} has invalid last_grade "${String(c.last_grade)}"`);
  }
}

/** Read the SR state store. A missing/empty file yields a fresh empty state; a
 *  present-but-unparseable or structurally-unsound file throws (fail fast —
 *  never silently overwrite a corrupt store with empty state). */
export function readSRState(): SRState {
  const raw = readVaultFile(SR_STATE_PATH);
  if (raw === null || raw.trim() === '') return emptyState();

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new SRStateError(`Corrupt SR state file (${SR_STATE_PATH}): ${(err as Error).message}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new SRStateError(`Corrupt SR state file (${SR_STATE_PATH}): not an object`);
  }
  const obj = parsed as Partial<SRState>;
  if (typeof obj.concepts !== 'object' || obj.concepts === null) {
    throw new SRStateError(`Corrupt SR state file (${SR_STATE_PATH}): missing concepts map`);
  }
  for (const [path, entry] of Object.entries(obj.concepts)) {
    assertValidConcept(path, entry);
  }
  return {
    concepts: obj.concepts as Record<string, ConceptState>,
    meta: obj.meta ?? { last_session_at: null, last_session_summary: null },
  };
}

/** Persist the SR state store. `writeVaultFile` writes atomically (tmp + rename). */
export function writeSRState(state: SRState): void {
  writeVaultFile(SR_STATE_PATH, JSON.stringify(state, null, 2) + '\n');
}

// --- pure state helpers ----------------------------------------------------

function setConcept(state: SRState, conceptPath: string, concept: ConceptState): SRState {
  return { ...state, concepts: { ...state.concepts, [conceptPath]: concept } };
}

function requireConcept(state: SRState, conceptPath: string): ConceptState {
  const c = state.concepts[conceptPath];
  if (!c) throw new SRStateError(`Concept not in SR state: ${conceptPath}`);
  return c;
}

function isGrade(value: unknown): value is Grade {
  return typeof value === 'string' && (GRADES as readonly string[]).includes(value);
}

/** Move `rung` up `steps` rungs, clamped at the 120d cap. */
function climb(rung: Rung, steps: number): Rung {
  const idx = RUNGS.indexOf(rung);
  // idx is always >= 0 (rung is typed Rung) so the clamped index is in range.
  return RUNGS[Math.min(idx + steps, RUNGS.length - 1)]!;
}

// --- admission + transitions ----------------------------------------------

/** Admit a concept to the pool (Requirement #9): rung 1d, due tomorrow. If the
 *  concept already has state, returns `state` unchanged so a re-admission
 *  (stale → active, Requirement #11) preserves existing progress. */
export function admitConcept(state: SRState, conceptPath: string, today: string): SRState {
  if (state.concepts[conceptPath]) return state;
  return setConcept(state, conceptPath, {
    concept_path: conceptPath,
    admitted_date: today,
    current_rung: '1d',
    next_due: addDays(today, rungDays('1d')),
    last_reviewed: null,
    last_grade: null,
    review_count: 0,
    lapse_count: 0,
    last_questions: [],
  });
}

/** Reset a concept to the bottom rung (1d), due tomorrow. Pure — does not touch
 *  review bookkeeping (that is the caller's / advanceRung's job). */
export function resetRung(state: SRState, conceptPath: string, today: string): SRState {
  const c = requireConcept(state, conceptPath);
  return setConcept(state, conceptPath, {
    ...c,
    current_rung: '1d',
    next_due: addDays(today, rungDays('1d')),
  });
}

/** Keep a concept on its current rung, re-scheduling next_due by that rung's
 *  interval. Pure — does not touch review bookkeeping. */
export function repeatRung(state: SRState, conceptPath: string, today: string): SRState {
  const c = requireConcept(state, conceptPath);
  return setConcept(state, conceptPath, {
    ...c,
    next_due: addDays(today, rungDays(c.current_rung)),
  });
}

function withReviewBookkeeping(
  c: ConceptState,
  grade: Grade,
  today: string,
  question?: string,
): ConceptState {
  return {
    ...c,
    last_reviewed: today,
    last_grade: grade,
    review_count: c.review_count + 1,
    last_questions: question ? [...c.last_questions, question].slice(-3) : c.last_questions,
  };
}

/** Apply a grade to a concept and return the next state. Deterministic — the
 *  result depends only on the arguments (it emits a warning log only in the
 *  defensive missing-concept branch). Implements the interval ladder,
 *  Requirements #13–#18:
 *   - good:  advance one rung
 *   - easy:  advance two rungs on the first pass at the current rung, else one
 *   - hard:  repeat the current rung
 *   - again: reset to 1d and increment lapse_count
 *  Every grade also records last_reviewed / last_grade / review_count and, when
 *  a question text is supplied, appends it to last_questions (capped at 3).
 *
 *  `today` is an explicit YYYY-MM-DD argument so the function stays pure and
 *  deterministically testable. A concept missing from state is admitted first
 *  (defensive — Requirement #9 admission normally happens at selection time). */
export function advanceRung(
  state: SRState,
  conceptPath: string,
  grade: Grade,
  today: string,
  question?: string,
): SRState {
  if (!isGrade(grade)) {
    throw new SRStateError(`Invalid grade: ${String(grade)}`);
  }

  let working = state;
  if (!working.concepts[conceptPath]) {
    working = admitConcept(working, conceptPath, today);
    log.warn('Grading a concept missing from SR state — admitting it now', { conceptPath });
  }

  let next: SRState;
  switch (grade) {
    case 'again': {
      next = resetRung(working, conceptPath, today);
      const c = requireConcept(next, conceptPath);
      next = setConcept(next, conceptPath, { ...c, lapse_count: c.lapse_count + 1 });
      break;
    }
    case 'hard':
      next = repeatRung(working, conceptPath, today);
      break;
    case 'good':
    case 'easy': {
      const c = requireConcept(working, conceptPath);
      // First pass at a rung iff the concept did not arrive via `hard` — `hard`
      // is the only grade that leaves the current rung unchanged. A null
      // last_grade (a freshly admitted concept) is therefore also a first pass.
      const firstPass = c.last_grade !== 'hard';
      const steps = grade === 'easy' && firstPass ? 2 : 1;
      const rung = climb(c.current_rung, steps);
      next = setConcept(working, conceptPath, {
        ...c,
        current_rung: rung,
        next_due: addDays(today, rungDays(rung)),
      });
      break;
    }
  }

  return setConcept(
    next,
    conceptPath,
    withReviewBookkeeping(requireConcept(next, conceptPath), grade, today, question),
  );
}
