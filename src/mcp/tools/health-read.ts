/**
 * Health read tools — whoop_snapshot / health_trends / workout_history /
 * nutrition_log / health_doc (MCP health expansion).
 *
 * PURE MODULE: config-free, deps-injected, handlers never throw (always
 * return an McpTextResult). Production bindings live in
 * ./health-read-deps.ts (config-required), loaded lazily by server.ts.
 * The exported signatures and the {@link HealthReadDeps} contract are FINAL.
 */

import type { WorkoutRecord } from '../../vault/workouts.js';
import { errText, ok, err, type McpTextResult } from './types.js';

export interface HealthReadDeps {
  /** Best-effort Whoop sync for today (must not throw into the handler). */
  ensureSynced(): Promise<void>;
  /** Parsed health/whoop/{date}.json, or null when the day file is absent. */
  readWhoopDay(date: string): Promise<unknown | null>;
  /** Parsed whoop day files for the inclusive date range (missing days skipped). */
  readWhoopRange(start: string, end: string): Promise<unknown[]>;
  /** Entries from health/workouts.json within the last `days`, newest first. */
  readRecentWorkouts(days: number): Promise<WorkoutRecord[]>;
  /** Raw vault doc content, or null when the file is absent. */
  readVaultDoc(relPath: string): Promise<string | null>;
  /** Today's date, YYYY-MM-DD, America/Chicago. */
  getTodayDate(): string;
  sanitizeError?(msg: string): string;
}

export interface HealthTrendsInput {
  startDate?: string;
  endDate?: string;
}

export interface WorkoutHistoryInput {
  days?: number;
}

export interface NutritionLogInput {
  days?: number;
}

export type HealthDocName = 'plan' | 'goals' | 'equipment' | 'exercises';

export interface HealthDocInput {
  doc: HealthDocName;
}

// ---------------------------------------------------------------------------
// Pure helpers (no config, no fs)
// ---------------------------------------------------------------------------

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

type CleanFn = (msg: string) => string;

function cleaner(deps: HealthReadDeps): CleanFn {
  return deps.sanitizeError ?? ((s: string) => s);
}

/** Shift a YYYY-MM-DD date by `deltaDays` using pure UTC arithmetic (the
 *  input is already a calendar date — no timezone resolution needed). */
function shiftIsoDate(date: string, deltaDays: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + deltaDays)).toISOString().slice(0, 10);
}

/** Inclusive day count between two YYYY-MM-DD dates (start ≤ end assumed). */
function inclusiveDaySpan(start: string, end: string): number {
  const toUtc = (v: string): number => {
    const [y, m, d] = v.split('-').map(Number);
    return Date.UTC(y!, m! - 1, d!);
  };
  return Math.round((toUtc(end) - toUtc(start)) / 86_400_000) + 1;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Clamp an optional numeric `days` input to [1, max]; non-numbers → def. */
function clampDays(value: number | undefined, def: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return def;
  return Math.min(max, Math.max(1, Math.floor(value)));
}

// ---------------------------------------------------------------------------
// whoop_snapshot
// ---------------------------------------------------------------------------

const WHOOP_SECTIONS = ['sleep', 'recovery', 'strain', 'workouts'] as const;

export async function whoopSnapshot(deps: HealthReadDeps): Promise<McpTextResult> {
  const clean = cleaner(deps);
  try {
    // Best-effort sync — a failure here must never block the read path.
    try {
      await deps.ensureSynced();
    } catch {
      /* proceed with whatever data is on disk */
    }

    const date = deps.getTodayDate();
    const today = await deps.readWhoopDay(date);
    const yesterday = await deps.readWhoopDay(shiftIsoDate(date, -1));
    const trendsMd = await deps.readVaultDoc('health/whoop/trends.md');

    const todayRecord = asRecord(today);
    const missing = WHOOP_SECTIONS.filter((section) => todayRecord?.[section] == null);
    const synced = todayRecord?.recovery != null;

    const payload: Record<string, unknown> = {
      date,
      today: todayRecord,
      yesterday: asRecord(yesterday),
      trends_md: trendsMd,
      missing,
      synced,
    };
    if (todayRecord === null) {
      payload.note = `No Whoop data for ${date} — Whoop may be unconfigured or sync failed.`;
    }
    return ok(JSON.stringify(payload));
  } catch (unexpected) {
    return err(`whoop_snapshot failed: ${clean(errText(unexpected))}`);
  }
}

// ---------------------------------------------------------------------------
// health_trends
// ---------------------------------------------------------------------------

const TRENDS_DEFAULT_SPAN_DAYS = 30;
const TRENDS_MAX_SPAN_DAYS = 90;

function dayDate(day: unknown): string {
  const record = asRecord(day);
  return typeof record?.date === 'string' ? record.date : '';
}

function metricValue(day: unknown, section: string, field: string): number | null {
  const sectionRecord = asRecord(asRecord(day)?.[section]);
  const value = sectionRecord?.[field];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Average of a metric over the days where it is present, 1 decimal; null
 *  when no day carries the metric. */
function averageMetric(days: unknown[], section: string, field: string): number | null {
  const values = days
    .map((day) => metricValue(day, section, field))
    .filter((v): v is number => v !== null);
  if (values.length === 0) return null;
  const avg = values.reduce((sum, v) => sum + v, 0) / values.length;
  return Math.round(avg * 10) / 10;
}

export async function healthTrends(
  input: HealthTrendsInput,
  deps: HealthReadDeps,
): Promise<McpTextResult> {
  const clean = cleaner(deps);
  try {
    if (input.startDate !== undefined && !ISO_DATE_RE.test(String(input.startDate))) {
      return err(`Invalid startDate "${String(input.startDate)}" — expected YYYY-MM-DD.`);
    }
    if (input.endDate !== undefined && !ISO_DATE_RE.test(String(input.endDate))) {
      return err(`Invalid endDate "${String(input.endDate)}" — expected YYYY-MM-DD.`);
    }

    const end = input.endDate ?? deps.getTodayDate();
    const start = input.startDate ?? shiftIsoDate(end, -(TRENDS_DEFAULT_SPAN_DAYS - 1));
    if (start > end) {
      return err(`startDate ${start} is after endDate ${end} — start must be on or before end.`);
    }
    const span = inclusiveDaySpan(start, end);
    if (span > TRENDS_MAX_SPAN_DAYS) {
      return err(`Date range spans ${span} days — maximum is ${TRENDS_MAX_SPAN_DAYS}.`);
    }

    const fetched = await deps.readWhoopRange(start, end);
    // Newest-first regardless of what the range reader returned.
    const days = [...fetched].sort((a, b) => dayDate(b).localeCompare(dayDate(a)));

    const averages = {
      recovery: averageMetric(days, 'recovery', 'score'),
      hrv: averageMetric(days, 'recovery', 'hrv'),
      resting_hr: averageMetric(days, 'recovery', 'resting_hr'),
      sleep_hours: averageMetric(days, 'sleep', 'duration_hours'),
      sleep_performance: averageMetric(days, 'sleep', 'performance'),
      strain: averageMetric(days, 'strain', 'score'),
    };

    return ok(JSON.stringify({ range: { start, end }, count: days.length, averages, days }));
  } catch (unexpected) {
    return err(`health_trends failed: ${clean(errText(unexpected))}`);
  }
}

// ---------------------------------------------------------------------------
// workout_history
// ---------------------------------------------------------------------------

export async function workoutHistory(
  input: WorkoutHistoryInput,
  deps: HealthReadDeps,
): Promise<McpTextResult> {
  const clean = cleaner(deps);
  try {
    const days = clampDays(input.days, 30, 365);
    const workouts = await deps.readRecentWorkouts(days);
    return ok(JSON.stringify({ count: workouts.length, workouts }));
  } catch (unexpected) {
    return err(`workout_history failed: ${clean(errText(unexpected))}`);
  }
}

// ---------------------------------------------------------------------------
// nutrition_log
// ---------------------------------------------------------------------------

const NUTRITION_PATH = 'health/nutrition.md';
const MEAL_NOTES_HEADING_RE = /^##\s+Meal Notes\s*$/m;
const MEAL_SECTION_RE = /^###\s+(\d{4}-\d{2}-\d{2})\b.*$/gm;

export async function nutritionLog(
  input: NutritionLogInput,
  deps: HealthReadDeps,
): Promise<McpTextResult> {
  const clean = cleaner(deps);
  try {
    const days = clampDays(input.days, 14, 90);
    const noNotes = ok(`No meal notes found in the last ${days} days.`);

    const raw = await deps.readVaultDoc(NUTRITION_PATH);
    if (raw === null) return noNotes;

    const headingMatch = MEAL_NOTES_HEADING_RE.exec(raw);
    if (headingMatch === null) return noNotes;

    // Content after the heading, up to the next level-2 heading (if any).
    let body = raw.slice(headingMatch.index + headingMatch[0].length);
    const nextH2 = /^##\s(?!#)/m.exec(body);
    if (nextH2 !== null) body = body.slice(0, nextH2.index);

    const cutoff = shiftIsoDate(deps.getTodayDate(), -days);
    const sections: Array<{ date: string; start: number }> = [];
    for (const match of body.matchAll(MEAL_SECTION_RE)) {
      sections.push({ date: match[1]!, start: match.index });
    }

    const kept: string[] = [];
    for (let i = 0; i < sections.length; i++) {
      if (sections[i]!.date < cutoff) continue;
      const end = i + 1 < sections.length ? sections[i + 1]!.start : body.length;
      kept.push(body.slice(sections[i]!.start, end).trimEnd());
    }

    if (kept.length === 0) return noNotes;
    return ok(kept.join('\n\n'));
  } catch (unexpected) {
    return err(`nutrition_log failed: ${clean(errText(unexpected))}`);
  }
}

// ---------------------------------------------------------------------------
// health_doc
// ---------------------------------------------------------------------------

/** Static doc→path map — the caller can never supply a vault path. */
const HEALTH_DOC_PATHS: Record<HealthDocName, string> = {
  plan: 'health/plan.md',
  goals: 'health/goals.md',
  equipment: 'health/equipment.md',
  exercises: 'health/exercises.md',
};

export async function healthDoc(
  input: HealthDocInput,
  deps: HealthReadDeps,
): Promise<McpTextResult> {
  const clean = cleaner(deps);
  // hasOwnProperty guard: a hostile runtime value like "constructor" must not
  // walk the prototype chain into a non-path.
  if (!Object.prototype.hasOwnProperty.call(HEALTH_DOC_PATHS, input.doc)) {
    return err(`Unknown doc "${String(input.doc)}" — expected one of: plan, goals, equipment, exercises.`);
  }
  const path = HEALTH_DOC_PATHS[input.doc];
  try {
    const content = await deps.readVaultDoc(path);
    if (content === null) return ok(`${path} not found.`);
    return ok(content);
  } catch (unexpected) {
    return err(`health_doc failed: ${clean(errText(unexpected))}`);
  }
}
