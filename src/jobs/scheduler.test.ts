import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockStop = vi.fn();
const mockSchedule = vi.fn(() => ({ stop: mockStop }));

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

const { startScheduler, stopScheduler } = await import('./scheduler.js');

describe('jobs/scheduler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Ensure clean state — stop any lingering tasks from prior tests
    stopScheduler();
    vi.clearAllMocks();
  });

  it('startScheduler calls cron.schedule with the correct timezone', () => {
    startScheduler({} as any);

    expect(mockSchedule).toHaveBeenCalled();
    const options = mockSchedule.mock.calls[0]![2] as { timezone: string };
    expect(options.timezone).toBe('America/Chicago');
  });

  it('startScheduler registers the expected number of jobs (5)', () => {
    startScheduler({} as any);

    expect(mockSchedule).toHaveBeenCalledTimes(5);
  });

  it('startScheduler passes the morning-prep cron expression', () => {
    startScheduler({} as any);

    const cronExpr = mockSchedule.mock.calls[0]![0] as string;
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
});
