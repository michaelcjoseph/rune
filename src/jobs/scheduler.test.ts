import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockStop = vi.fn();
const mockSchedule = vi.fn((..._args: unknown[]) => ({ stop: mockStop }));

vi.mock('node-cron', () => ({
  default: { schedule: mockSchedule },
}));

vi.mock('../config.js', () => ({
  default: {
    TIMEZONE: 'America/Chicago',
    VAULT_DIR: '/test/vault',
    LOGS_DIR: '/test/logs',
  },
}));

vi.mock('../utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('./morning-prep.js', () => ({
  runMorningPrep: vi.fn(async () => {}),
}));

vi.mock('./nightly.js', () => ({
  runNightly: vi.fn(async () => {}),
}));

vi.mock('./nudges.js', () => ({
  runWeeklyNudge: vi.fn(async () => {}),
  runReviewNudge: vi.fn(async () => {}),
}));

vi.mock('./whoop-sync.js', () => ({
  runWhoopSleepSync: vi.fn(async () => {}),
}));

// Mock fs to avoid writing real state files in tests
vi.mock('node:fs', () => ({
  readFileSync: vi.fn(() => { throw new Error('ENOENT'); }),
  writeFileSync: vi.fn(),
}));

const { startScheduler, stopScheduler, recordJobRun } = await import('./scheduler.js');
const { readFileSync, writeFileSync } = await import('node:fs');
const { runMorningPrep } = await import('./morning-prep.js');

describe('jobs/scheduler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Ensure clean state — stop any lingering tasks from prior tests
    stopScheduler();
    vi.clearAllMocks();
    // Reset fs mock to return empty state by default (no missed jobs)
    vi.mocked(readFileSync).mockImplementation(() => {
      // Return state with all jobs run "just now" so nothing is missed
      const now = Date.now();
      return JSON.stringify({
        'morning-prep': now,
        'nightly': now,
        'whoop-sleep': now,
        'weekly-nudge': now,
        'review-nudge': now,
      });
    });
  });

  it('startScheduler calls cron.schedule with the correct timezone', () => {
    startScheduler({} as any);

    expect(mockSchedule).toHaveBeenCalled();
    const options = mockSchedule.mock.calls[0]![2] as unknown as { timezone: string };
    expect(options.timezone).toBe('America/Chicago');
  });

  it('startScheduler registers the expected number of jobs (5)', () => {
    startScheduler({} as any);

    expect(mockSchedule).toHaveBeenCalledTimes(5);
  });

  it('startScheduler passes the morning-prep cron expression', () => {
    startScheduler({} as any);

    const cronExpr = mockSchedule.mock.calls[0]![0] as unknown as string;
    expect(cronExpr).toBe('30 5 * * *');
  });

  it('stopScheduler calls .stop() on all registered tasks', () => {
    startScheduler({} as any);
    stopScheduler();

    expect(mockStop).toHaveBeenCalledTimes(5);
  });

  it('stopScheduler clears the task list — second call does not error or re-stop', () => {
    startScheduler({} as any);
    stopScheduler();
    vi.clearAllMocks();

    // Second stop should be a no-op
    stopScheduler();
    expect(mockStop).not.toHaveBeenCalled();
  });

  it('startScheduler can re-register jobs after stopScheduler', () => {
    startScheduler({} as any);
    stopScheduler();
    vi.clearAllMocks();

    startScheduler({} as any);
    expect(mockSchedule).toHaveBeenCalledTimes(5);

    stopScheduler();
    expect(mockStop).toHaveBeenCalledTimes(5);
  });

  it('recordJobRun persists the timestamp to state file', () => {
    recordJobRun('morning-prep');

    expect(writeFileSync).toHaveBeenCalled();
    const written = JSON.parse(vi.mocked(writeFileSync).mock.calls[0]![1] as string);
    expect(written['morning-prep']).toBeGreaterThan(0);
  });

  it('catches up missed jobs on startup when state file shows stale last run', () => {
    // State shows morning-prep last ran 2 days ago
    vi.mocked(readFileSync).mockImplementation(() =>
      JSON.stringify({
        'morning-prep': Date.now() - 48 * 60 * 60 * 1000,
        'nightly': Date.now(),
        'whoop-sleep': Date.now(),
        'weekly-nudge': Date.now(),
        'review-nudge': Date.now(),
      }),
    );

    startScheduler({} as any);

    // morning-prep's guarded handler should have been called
    // The handler is wrapped by guarded(), which calls runMorningPrep
    expect(runMorningPrep).toHaveBeenCalled();
  });

  it('does not catch up jobs that ran recently', () => {
    // All jobs ran just now
    vi.mocked(readFileSync).mockImplementation(() =>
      JSON.stringify({
        'morning-prep': Date.now(),
        'nightly': Date.now(),
        'whoop-sleep': Date.now(),
        'weekly-nudge': Date.now(),
        'review-nudge': Date.now(),
      }),
    );

    startScheduler({} as any);

    expect(runMorningPrep).not.toHaveBeenCalled();
  });
});
