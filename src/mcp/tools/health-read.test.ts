import { describe, it, expect, vi } from 'vitest';
import {
  whoopSnapshot,
  healthTrends,
  workoutHistory,
  nutritionLog,
  healthDoc,
  type HealthReadDeps,
  type HealthDocName,
} from './health-read.js';
import type { McpTextResult } from './types.js';

const TODAY = '2026-07-06';

function makeDeps(overrides: Partial<HealthReadDeps> = {}): HealthReadDeps {
  return {
    ensureSynced: vi.fn(async () => {}),
    readWhoopDay: vi.fn(async () => null),
    readWhoopRange: vi.fn(async () => []),
    readRecentWorkouts: vi.fn(async () => []),
    readVaultDoc: vi.fn(async () => null),
    getTodayDate: () => TODAY,
    ...overrides,
  };
}

function textOf(result: McpTextResult): string {
  return result.content[0]!.text;
}

function jsonOf(result: McpTextResult): Record<string, unknown> {
  return JSON.parse(textOf(result)) as Record<string, unknown>;
}

const FULL_DAY = {
  date: TODAY,
  sleep: { duration_hours: 7.5, performance: 85, efficiency: 92, rem_pct: 20, deep_pct: 18, respiratory_rate: 15.2, disturbances: 4 },
  recovery: { score: 68, hrv: 48, resting_hr: 58, spo2: 97 },
  strain: { score: 12.4, calories: 2200, avg_hr: 78, max_hr: 152 },
  workouts: [{ sport_name: 'Running', duration_min: 40, strain: 9.1, calories: 450, avg_hr: 140, max_hr: 165 }],
};

describe('whoopSnapshot', () => {
  it('calls ensureSynced before reading any data', async () => {
    const order: string[] = [];
    const deps = makeDeps({
      ensureSynced: vi.fn(async () => {
        order.push('sync');
      }),
      readWhoopDay: vi.fn(async () => {
        order.push('read');
        return null;
      }),
      readVaultDoc: vi.fn(async () => {
        order.push('trends');
        return null;
      }),
    });

    await whoopSnapshot(deps);

    expect(order[0]).toBe('sync');
    expect(order.slice(1)).toContain('read');
  });

  it('still returns data when ensureSynced throws', async () => {
    const deps = makeDeps({
      ensureSynced: vi.fn(async () => {
        throw new Error('whoop api down');
      }),
      readWhoopDay: vi.fn(async (date: string) => (date === TODAY ? FULL_DAY : null)),
    });

    const result = await whoopSnapshot(deps);

    expect(result.isError).toBeUndefined();
    const payload = jsonOf(result);
    expect(payload.date).toBe(TODAY);
    expect((payload.today as { recovery?: unknown }).recovery).toBeTruthy();
    expect(payload.synced).toBe(true);
  });

  it('reads today and yesterday and includes trends markdown', async () => {
    const readWhoopDay = vi.fn(async (date: string) => (date === TODAY ? FULL_DAY : { date }));
    const readVaultDoc = vi.fn(async () => '# Trends\nsome trends');
    const deps = makeDeps({ readWhoopDay, readVaultDoc });

    const result = await whoopSnapshot(deps);

    expect(readWhoopDay).toHaveBeenCalledWith(TODAY);
    expect(readWhoopDay).toHaveBeenCalledWith('2026-07-05');
    expect(readVaultDoc).toHaveBeenCalledWith('health/whoop/trends.md');
    const payload = jsonOf(result);
    expect(payload.trends_md).toBe('# Trends\nsome trends');
    expect((payload.yesterday as { date?: string }).date).toBe('2026-07-05');
  });

  it('lists absent sections in missing', async () => {
    const partial = { date: TODAY, sleep: FULL_DAY.sleep, recovery: FULL_DAY.recovery };
    const deps = makeDeps({
      readWhoopDay: vi.fn(async (date: string) => (date === TODAY ? partial : null)),
    });

    const payload = jsonOf(await whoopSnapshot(deps));

    expect(payload.missing).toEqual(['strain', 'workouts']);
    expect(payload.synced).toBe(true);
  });

  it('reports missing empty when all four sections are present', async () => {
    const deps = makeDeps({
      readWhoopDay: vi.fn(async (date: string) => (date === TODAY ? FULL_DAY : null)),
    });

    const payload = jsonOf(await whoopSnapshot(deps));

    expect(payload.missing).toEqual([]);
  });

  it('returns ok with note when today is entirely missing', async () => {
    const deps = makeDeps();

    const result = await whoopSnapshot(deps);

    expect(result.isError).toBeUndefined();
    const payload = jsonOf(result);
    expect(payload.note).toBe(`No Whoop data for ${TODAY} — Whoop may be unconfigured or sync failed.`);
    expect(payload.missing).toEqual(['sleep', 'recovery', 'strain', 'workouts']);
    expect(payload.synced).toBe(false);
    expect(payload.today).toBeNull();
  });

  it('marks synced false when today has data but no recovery section', async () => {
    const deps = makeDeps({
      readWhoopDay: vi.fn(async (date: string) =>
        date === TODAY ? { date: TODAY, sleep: FULL_DAY.sleep } : null,
      ),
    });

    const payload = jsonOf(await whoopSnapshot(deps));

    expect(payload.synced).toBe(false);
    expect(payload.note).toBeUndefined();
  });

  it('returns isError (never throws) when a reader fails', async () => {
    const deps = makeDeps({
      readWhoopDay: vi.fn(async () => {
        throw new Error('disk exploded');
      }),
    });

    const result = await whoopSnapshot(deps);

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('whoop_snapshot failed');
  });

  it('applies sanitizeError to failure text', async () => {
    const deps = makeDeps({
      readWhoopDay: vi.fn(async () => {
        throw new Error('secret path');
      }),
      sanitizeError: (msg) => msg.replace('secret path', '[scrubbed]'),
    });

    const result = await whoopSnapshot(deps);

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('[scrubbed]');
    expect(textOf(result)).not.toContain('secret path');
  });
});

describe('healthTrends', () => {
  it('defaults to a 30-day range ending today', async () => {
    const readWhoopRange = vi.fn(async () => []);
    const deps = makeDeps({ readWhoopRange });

    const payload = jsonOf(await healthTrends({}, deps));

    expect(readWhoopRange).toHaveBeenCalledWith('2026-06-07', TODAY);
    expect(payload.range).toEqual({ start: '2026-06-07', end: TODAY });
  });

  it('rejects a malformed startDate naming the expected format', async () => {
    const result = await healthTrends({ startDate: '07/01/2026' }, makeDeps());

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('YYYY-MM-DD');
  });

  it('rejects a malformed endDate naming the expected format', async () => {
    const result = await healthTrends({ endDate: '2026-7-1' }, makeDeps());

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('YYYY-MM-DD');
  });

  it('rejects start after end', async () => {
    const result = await healthTrends(
      { startDate: '2026-07-05', endDate: '2026-07-01' },
      makeDeps(),
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('2026-07-05');
  });

  it('rejects a span over 90 days', async () => {
    const result = await healthTrends(
      { startDate: '2026-01-01', endDate: '2026-06-01' },
      makeDeps(),
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('90');
  });

  it('accepts a span of exactly 90 days', async () => {
    // 2026-01-01..2026-03-31 = 31 + 28 + 31 = 90 days inclusive.
    const result = await healthTrends(
      { startDate: '2026-01-01', endDate: '2026-03-31' },
      makeDeps(),
    );

    expect(result.isError).toBeUndefined();
  });

  it('computes 1-decimal averages over present values only', async () => {
    const dayA = {
      date: '2026-07-05',
      recovery: { score: 60, hrv: 40, resting_hr: 60, spo2: 97 },
      sleep: { duration_hours: 7, performance: 80 },
      strain: { score: 10 },
    };
    const dayB = {
      date: '2026-07-06',
      recovery: { score: 61, resting_hr: 62, spo2: 96 }, // hrv absent
      sleep: { duration_hours: 8, performance: 90 },
      // strain absent entirely
    };
    const deps = makeDeps({ readWhoopRange: vi.fn(async () => [dayA, dayB]) });

    const payload = jsonOf(await healthTrends({}, deps));
    const averages = payload.averages as Record<string, number | null>;

    expect(averages.recovery).toBe(60.5);
    expect(averages.hrv).toBe(40); // only dayA has hrv
    expect(averages.resting_hr).toBe(61);
    expect(averages.sleep_hours).toBe(7.5);
    expect(averages.sleep_performance).toBe(85);
    expect(averages.strain).toBe(10); // only dayA has strain
  });

  it('returns null averages when a metric has no samples anywhere', async () => {
    const deps = makeDeps({
      readWhoopRange: vi.fn(async () => [{ date: '2026-07-05', sleep: { duration_hours: 7 } }]),
    });

    const payload = jsonOf(await healthTrends({}, deps));
    const averages = payload.averages as Record<string, number | null>;

    expect(averages.recovery).toBeNull();
    expect(averages.hrv).toBeNull();
    expect(averages.strain).toBeNull();
    expect(averages.sleep_hours).toBe(7);
  });

  it('returns ok with count 0 for an empty range', async () => {
    const result = await healthTrends({}, makeDeps());

    expect(result.isError).toBeUndefined();
    const payload = jsonOf(result);
    expect(payload.count).toBe(0);
    expect(payload.days).toEqual([]);
  });

  it('returns days newest-first even when the reader yields oldest-first', async () => {
    const deps = makeDeps({
      readWhoopRange: vi.fn(async () => [
        { date: '2026-07-01' },
        { date: '2026-07-03' },
        { date: '2026-07-02' },
      ]),
    });

    const payload = jsonOf(await healthTrends({}, deps));

    expect((payload.days as Array<{ date: string }>).map((d) => d.date)).toEqual([
      '2026-07-03',
      '2026-07-02',
      '2026-07-01',
    ]);
    expect(payload.count).toBe(3);
  });

  it('returns isError (never throws) when the range reader fails', async () => {
    const deps = makeDeps({
      readWhoopRange: vi.fn(async () => {
        throw new Error('boom');
      }),
    });

    const result = await healthTrends({}, deps);

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('health_trends failed');
  });
});

describe('workoutHistory', () => {
  it('defaults days to 30', async () => {
    const readRecentWorkouts = vi.fn(async () => []);
    await workoutHistory({}, makeDeps({ readRecentWorkouts }));

    expect(readRecentWorkouts).toHaveBeenCalledWith(30);
  });

  it('clamps days into [1, 365]', async () => {
    const readRecentWorkouts = vi.fn(async () => []);
    const deps = makeDeps({ readRecentWorkouts });

    await workoutHistory({ days: 0 }, deps);
    await workoutHistory({ days: 5000 }, deps);
    await workoutHistory({ days: -3 }, deps);

    expect(readRecentWorkouts).toHaveBeenNthCalledWith(1, 1);
    expect(readRecentWorkouts).toHaveBeenNthCalledWith(2, 365);
    expect(readRecentWorkouts).toHaveBeenNthCalledWith(3, 1);
  });

  it('returns ok with count 0 for an empty history', async () => {
    const result = await workoutHistory({}, makeDeps());

    expect(result.isError).toBeUndefined();
    expect(jsonOf(result)).toEqual({ count: 0, workouts: [] });
  });

  it('returns the workouts from deps with a matching count', async () => {
    const workouts = [
      { date: '2026-07-05', type: 'gym' },
      { date: '2026-07-03', type: 'home' },
    ];
    const deps = makeDeps({ readRecentWorkouts: vi.fn(async () => workouts) });

    const payload = jsonOf(await workoutHistory({ days: 7 }, deps));

    expect(payload.count).toBe(2);
    expect(payload.workouts).toEqual(workouts);
  });

  it('returns isError (never throws) when the reader fails', async () => {
    const deps = makeDeps({
      readRecentWorkouts: vi.fn(async () => {
        throw new Error('bad json');
      }),
    });

    const result = await workoutHistory({}, deps);

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('workout_history failed');
  });
});

describe('nutritionLog', () => {
  const NUTRITION_MD = [
    '# Nutrition',
    '',
    'Some intro prose.',
    '',
    '## Meal Notes',
    '',
    '### 2026-07-05',
    '- eggs and toast',
    '- chicken salad',
    '',
    '### 2026-06-20',
    '- old meal',
    '',
    '## Other Section',
    '### 2026-07-06',
    'this lives outside Meal Notes and must not leak in',
  ].join('\n');

  it('keeps only sections on or after the cutoff', async () => {
    const deps = makeDeps({ readVaultDoc: vi.fn(async () => NUTRITION_MD) });

    const result = await nutritionLog({ days: 7 }, deps);

    expect(result.isError).toBeUndefined();
    const text = textOf(result);
    expect(text).toContain('### 2026-07-05');
    expect(text).toContain('chicken salad');
    expect(text).not.toContain('2026-06-20');
    expect(text).not.toContain('old meal');
    expect(text).not.toContain('Other Section');
    expect(text).not.toContain('must not leak in');
  });

  it('window is inclusive: "last N days" = N calendar dates including today', async () => {
    // today = 2026-07-06, days = 7 → cutoff 2026-06-30 (not 06-29).
    const md = [
      '## Meal Notes',
      '',
      '### 2026-06-30',
      '- exactly on the cutoff, kept',
      '',
      '### 2026-06-29',
      '- one day too old, dropped',
    ].join('\n');
    const deps = makeDeps({ readVaultDoc: vi.fn(async () => md) });

    const text = textOf(await nutritionLog({ days: 7 }, deps));

    expect(text).toContain('### 2026-06-30');
    expect(text).not.toContain('2026-06-29');
  });

  it('returns the no-notes message when the file is missing', async () => {
    const result = await nutritionLog({}, makeDeps());

    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toBe('No meal notes found in the last 14 days.');
  });

  it('returns the no-notes message when the Meal Notes heading is absent', async () => {
    const deps = makeDeps({
      readVaultDoc: vi.fn(async () => '# Nutrition\n\n### 2026-07-05\n- floating section'),
    });

    const result = await nutritionLog({}, deps);

    expect(textOf(result)).toBe('No meal notes found in the last 14 days.');
  });

  it('returns the no-notes message when no section is recent enough', async () => {
    const deps = makeDeps({
      readVaultDoc: vi.fn(async () => '## Meal Notes\n\n### 2025-01-01\n- ancient meal\n'),
    });

    const result = await nutritionLog({ days: 30 }, deps);

    expect(textOf(result)).toBe('No meal notes found in the last 30 days.');
  });

  it('clamps days to [1, 90] and reflects the clamp in the message', async () => {
    const result = await nutritionLog({ days: 500 }, makeDeps());

    expect(textOf(result)).toBe('No meal notes found in the last 90 days.');
  });

  it('returns kept sections verbatim', async () => {
    const deps = makeDeps({ readVaultDoc: vi.fn(async () => NUTRITION_MD) });

    const text = textOf(await nutritionLog({ days: 7 }, deps));

    expect(text).toBe('### 2026-07-05\n- eggs and toast\n- chicken salad');
  });

  it('returns isError (never throws) when the reader fails', async () => {
    const deps = makeDeps({
      readVaultDoc: vi.fn(async () => {
        throw new Error('io error');
      }),
    });

    const result = await nutritionLog({}, deps);

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('nutrition_log failed');
  });
});

describe('healthDoc', () => {
  const DOC_PATHS: Record<HealthDocName, string> = {
    plan: 'health/plan.md',
    goals: 'health/goals.md',
    equipment: 'health/equipment.md',
    exercises: 'health/exercises.md',
  };

  it.each(Object.entries(DOC_PATHS))('maps doc "%s" to %s', async (doc, path) => {
    const readVaultDoc = vi.fn(async () => `# content of ${path}`);
    const deps = makeDeps({ readVaultDoc });

    const result = await healthDoc({ doc: doc as HealthDocName }, deps);

    expect(readVaultDoc).toHaveBeenCalledWith(path);
    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toBe(`# content of ${path}`);
  });

  it('returns ok with a not-found message when the doc is missing', async () => {
    const result = await healthDoc({ doc: 'plan' }, makeDeps());

    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toBe('health/plan.md not found.');
  });

  it('rejects an unknown doc name without touching the vault', async () => {
    const readVaultDoc = vi.fn(async () => 'nope');
    const deps = makeDeps({ readVaultDoc });

    const result = await healthDoc({ doc: '../secrets' as HealthDocName }, deps);

    expect(result.isError).toBe(true);
    expect(readVaultDoc).not.toHaveBeenCalled();
  });

  it('rejects prototype-chain doc names', async () => {
    const readVaultDoc = vi.fn(async () => 'nope');
    const deps = makeDeps({ readVaultDoc });

    const result = await healthDoc({ doc: 'constructor' as HealthDocName }, deps);

    expect(result.isError).toBe(true);
    expect(readVaultDoc).not.toHaveBeenCalled();
  });

  it('returns isError (never throws) when the reader fails', async () => {
    const deps = makeDeps({
      readVaultDoc: vi.fn(async () => {
        throw new Error('io error');
      }),
    });

    const result = await healthDoc({ doc: 'goals' }, deps);

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('health_doc failed');
  });
});
