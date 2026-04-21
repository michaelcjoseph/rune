import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../config.js', () => ({
  default: { VAULT_DIR: '/test/vault', TIMEZONE: 'America/Chicago', TELEGRAM_USER_ID: 12345 },
}));

vi.mock('../utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../integrations/whoop/client.js', () => ({
  isConfigured: vi.fn(),
  getAccessToken: vi.fn(),
  fetchSleep: vi.fn(),
  fetchRecovery: vi.fn(),
  fetchCycles: vi.fn(),
  fetchWorkouts: vi.fn(),
  describeTokenError: (r: { reason: string; status?: number; detail?: string }) => {
    switch (r.reason) {
      case 'not_configured': return 'Whoop not configured';
      case 'no_refresh_token': return 'Whoop: re-auth required (no stored token). Run /whoop';
      case 'refresh_rejected': return `Whoop: re-auth required (refresh rejected: HTTP ${r.status}). Run /whoop`;
      case 'network_error': return `Whoop: transient failure (${r.detail}). Will retry next cycle.`;
      default: return 'unknown';
    }
  },
}));

vi.mock('../vault/files.js', () => ({
  readVaultFile: vi.fn(),
  writeVaultFile: vi.fn(),
}));

vi.mock('../vault/git.js', () => ({
  gitCommitAndPush: vi.fn(),
}));

vi.mock('../utils/time.js', () => ({
  getYesterdayDate: vi.fn(() => '2026-04-10'),
  getTodayDate: vi.fn(() => '2026-04-11'),
}));

const { isConfigured, getAccessToken, fetchSleep, fetchRecovery, fetchCycles, fetchWorkouts } = await import('../integrations/whoop/client.js');
const { readVaultFile, writeVaultFile } = await import('../vault/files.js');
const { gitCommitAndPush } = await import('../vault/git.js');
const { executeSleepSync, executeActivitySync, runWhoopSleepSync } = await import('./whoop-sync.js');

const isConfiguredMock = isConfigured as unknown as ReturnType<typeof vi.fn>;
const getTokenMock = getAccessToken as unknown as ReturnType<typeof vi.fn>;
const fetchSleepMock = fetchSleep as unknown as ReturnType<typeof vi.fn>;
const fetchRecoveryMock = fetchRecovery as unknown as ReturnType<typeof vi.fn>;
const fetchCyclesMock = fetchCycles as unknown as ReturnType<typeof vi.fn>;
const fetchWorkoutsMock = fetchWorkouts as unknown as ReturnType<typeof vi.fn>;

// Helper — fetch helpers return { records, error } now
const ok = <T>(records: T[]) => ({ records, error: null });
const apiErr = <T>(error: string, records: T[] = []) => ({ records, error });
const readMock = readVaultFile as unknown as ReturnType<typeof vi.fn>;
const writeMock = writeVaultFile as unknown as ReturnType<typeof vi.fn>;
const gitMock = gitCommitAndPush as unknown as ReturnType<typeof vi.fn>;

// --- Test Fixtures ---

function makeSleep(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    score_state: 'SCORED',
    nap: false,
    score: {
      stage_summary: {
        total_in_bed_time_milli: 28_800_000, // 8h
        total_awake_time_milli: 3_600_000,   // 1h
        total_rem_sleep_time_milli: 5_400_000,
        total_slow_wave_sleep_time_milli: 3_600_000,
        disturbance_count: 2,
        total_no_data_time_milli: 0,
        total_light_sleep_time_milli: 12_600_000,
        sleep_cycle_count: 4,
      },
      respiratory_rate: 15.5,
      sleep_performance_percentage: 85,
      sleep_efficiency_percentage: 90,
      sleep_consistency_percentage: 78,
      sleep_needed: { baseline_milli: 0, need_from_sleep_debt_milli: 0, need_from_recent_strain_milli: 0, need_from_recent_nap_milli: 0 },
    },
    ...overrides,
  };
}

function makeRecovery(overrides: Record<string, unknown> = {}) {
  return {
    cycle_id: 1,
    score_state: 'SCORED',
    score: {
      recovery_score: 72,
      hrv_rmssd_milli: 45.678,
      resting_heart_rate: 55,
      spo2_percentage: 97,
      user_calibrating: false,
      skin_temp_celsius: 33.5,
    },
    ...overrides,
  };
}

function makeCycle(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    score_state: 'SCORED',
    score: {
      strain: 12.345,
      kilojoule: 8368, // ~2000 kcal
      average_heart_rate: 75,
      max_heart_rate: 165,
    },
    ...overrides,
  };
}

function makeWorkout(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    sport_id: 44,
    score_state: 'SCORED',
    start: '2026-04-11T10:00:00.000Z',
    end: '2026-04-11T10:45:00.000Z',
    score: {
      strain: 8.5,
      kilojoule: 2092, // ~500 kcal
      average_heart_rate: 145,
      max_heart_rate: 178,
      percent_recorded: 100,
      zone_duration: { zone_zero_milli: 0, zone_one_milli: 0, zone_two_milli: 0, zone_three_milli: 0, zone_four_milli: 0, zone_five_milli: 0 },
    },
    ...overrides,
  };
}

describe('jobs/whoop-sync', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isConfiguredMock.mockReturnValue(true);
    getTokenMock.mockResolvedValue({ ok: true, token: 'test-token' });
    readMock.mockReturnValue(null); // no existing data files
  });

  describe('executeSleepSync', () => {
    it('returns skipped when not configured', async () => {
      isConfiguredMock.mockReturnValue(false);
      const result = await executeSleepSync();
      expect(result).toEqual({ status: 'skipped', detail: 'Whoop not configured' });
      expect(getTokenMock).not.toHaveBeenCalled();
    });

    it('returns error with actionable detail when refresh token missing', async () => {
      getTokenMock.mockResolvedValue({ ok: false, reason: 'no_refresh_token' });
      const result = await executeSleepSync();
      expect(result.status).toBe('error');
      expect(result.detail).toContain('re-auth required');
    });

    it('returns error with status when refresh rejected', async () => {
      getTokenMock.mockResolvedValue({ ok: false, reason: 'refresh_rejected', status: 401 });
      const result = await executeSleepSync();
      expect(result.status).toBe('error');
      expect(result.detail).toContain('HTTP 401');
    });

    it('returns skipped when no sleep or recovery data', async () => {
      fetchSleepMock.mockResolvedValue(ok([]));
      fetchRecoveryMock.mockResolvedValue(ok([]));

      const result = await executeSleepSync();
      expect(result).toEqual({ status: 'skipped', date: '2026-04-10', detail: 'No sleep/recovery data available' });
      expect(writeMock).not.toHaveBeenCalled();
    });

    it('writes JSON and generates trends on success', async () => {
      // generateTrends reads the last 30 days — provide data so trends.md is written
      const sampleData = JSON.stringify({
        date: '2026-04-10',
        sleep: { duration_hours: 7, performance: 85, efficiency: 90, rem_pct: 21, deep_pct: 14, respiratory_rate: 15, disturbances: 2 },
        recovery: { score: 72, hrv: 45.68, resting_hr: 55, spo2: 97 },
      });
      readMock.mockImplementation((path: string) => {
        if (typeof path === 'string' && path.endsWith('.json')) return sampleData;
        return null;
      });

      fetchSleepMock.mockResolvedValue(ok([makeSleep()]));
      fetchRecoveryMock.mockResolvedValue(ok([makeRecovery()]));

      const result = await executeSleepSync();

      expect(result.status).toBe('synced');
      expect(result.date).toBe('2026-04-10');
      expect(result.detail).toContain('Sleep:');
      expect(result.detail).toContain('Recovery: 72%');
      expect(result.detail).toContain('HRV: 45.68ms');

      // Verify daily data was written
      expect(writeMock).toHaveBeenCalledWith(
        'health/whoop/2026-04-10.json',
        expect.stringContaining('"date": "2026-04-10"'),
      );

      // Verify trends were generated (writes trends.md)
      const trendsCalls = writeMock.mock.calls.filter(
        (c: unknown[]) => (c[0] as string) === 'health/whoop/trends.md',
      );
      expect(trendsCalls.length).toBeGreaterThanOrEqual(1);

      // Verify git commit
      expect(gitMock).toHaveBeenCalledWith('Whoop sleep sync: 2026-04-10');
    });

    it('writes sleep data with correct transformations', async () => {
      fetchSleepMock.mockResolvedValue(ok([makeSleep()]));
      fetchRecoveryMock.mockResolvedValue(ok([]));

      await executeSleepSync();

      const written = JSON.parse(writeMock.mock.calls.find(
        (c: unknown[]) => (c[0] as string).includes('2026-04-10.json'),
      )![1]);

      expect(written.sleep).toBeDefined();
      // total_in_bed - total_awake = 25_200_000ms = 7 hours
      expect(written.sleep.duration_hours).toBe(7);
      expect(written.sleep.performance).toBe(85);
      expect(written.sleep.efficiency).toBe(90);
      expect(written.sleep.respiratory_rate).toBe(15.5);
      expect(written.sleep.disturbances).toBe(2);
    });

    it('merges with existing daily data file', async () => {
      readMock.mockImplementation((path: string) => {
        if (path === 'health/whoop/2026-04-10.json') {
          return JSON.stringify({ date: '2026-04-10', strain: { score: 10, calories: 2000, avg_hr: 75, max_hr: 165 } });
        }
        return null;
      });

      fetchSleepMock.mockResolvedValue(ok([makeSleep()]));
      fetchRecoveryMock.mockResolvedValue(ok([makeRecovery()]));

      await executeSleepSync();

      const written = JSON.parse(writeMock.mock.calls.find(
        (c: unknown[]) => (c[0] as string).includes('2026-04-10.json'),
      )![1]);

      // Existing strain preserved, sleep + recovery added
      expect(written.strain).toBeDefined();
      expect(written.sleep).toBeDefined();
      expect(written.recovery).toBeDefined();
    });
  });

  describe('executeActivitySync', () => {
    it('returns skipped when not configured', async () => {
      isConfiguredMock.mockReturnValue(false);
      const result = await executeActivitySync();
      expect(result).toEqual({ status: 'skipped', detail: 'Whoop not configured' });
    });

    it('returns error with transient detail on network error', async () => {
      getTokenMock.mockResolvedValue({ ok: false, reason: 'network_error', detail: 'Network error' });
      const result = await executeActivitySync();
      expect(result.status).toBe('error');
      expect(result.detail).toContain('transient');
    });

    it('returns skipped when no strain or workout data', async () => {
      fetchCyclesMock.mockResolvedValue(ok([]));
      fetchWorkoutsMock.mockResolvedValue(ok([]));

      const result = await executeActivitySync();
      expect(result).toEqual({ status: 'skipped', detail: 'No strain/workout data available' });
    });

    it('returns error when both cycles and workouts endpoints fail', async () => {
      fetchCyclesMock.mockResolvedValue(apiErr('HTTP 500 from /v1/cycle'));
      fetchWorkoutsMock.mockResolvedValue(apiErr('HTTP 500 from /v1/activity/workout'));

      const result = await executeActivitySync();

      expect(result.status).toBe('error');
      expect(result.date).toBe('2026-04-11');
      expect(result.detail).toContain('API errors');
      expect(result.detail).toContain('cycles=HTTP 500 from /v1/cycle');
      expect(result.detail).toContain('workouts=HTTP 500 from /v1/activity/workout');
      expect(writeMock).not.toHaveBeenCalled();
    });

    it('on partial API failure (cycles errored, workouts empty), returns skipped with partial-error suffix', async () => {
      fetchCyclesMock.mockResolvedValue(apiErr('HTTP 500 from /v1/cycle'));
      fetchWorkoutsMock.mockResolvedValue(ok([]));

      const result = await executeActivitySync();

      expect(result.status).toBe('skipped');
      expect(result.detail).toContain('No strain/workout data available');
      expect(result.detail).toContain('partial API errors');
      expect(result.detail).toContain('cycles=HTTP 500 from /v1/cycle');
      expect(result.detail).toContain('workouts=ok');
      expect(writeMock).not.toHaveBeenCalled();
    });

    it('merges strain/workouts into existing daily data', async () => {
      readMock.mockImplementation((path: string) => {
        if (path === 'health/whoop/2026-04-11.json') {
          return JSON.stringify({
            date: '2026-04-11',
            sleep: { duration_hours: 7, performance: 85, efficiency: 90, rem_pct: 21, deep_pct: 14, respiratory_rate: 15, disturbances: 2 },
            recovery: { score: 72, hrv: 45.68, resting_hr: 55, spo2: 97 },
          });
        }
        return null;
      });

      fetchCyclesMock.mockResolvedValue(ok([makeCycle()]));
      fetchWorkoutsMock.mockResolvedValue(ok([makeWorkout()]));

      const result = await executeActivitySync();

      expect(result.status).toBe('synced');
      expect(result.detail).toContain('Strain: 12.3');

      const written = JSON.parse(writeMock.mock.calls.find(
        (c: unknown[]) => (c[0] as string).includes('2026-04-11.json'),
      )![1]);

      // Existing sleep/recovery preserved
      expect(written.sleep).toBeDefined();
      expect(written.recovery).toBeDefined();
      // New strain/workouts added
      expect(written.strain.score).toBe(12.3);
      expect(written.strain.calories).toBe(2000);
      expect(written.workouts).toHaveLength(1);
      expect(written.workouts[0].sport_id).toBe(44);
      expect(written.workouts[0].duration_min).toBe(45);
      expect(written.workouts[0].strain).toBe(8.5);
    });

    it('writes strain without workouts', async () => {
      fetchCyclesMock.mockResolvedValue(ok([makeCycle()]));
      fetchWorkoutsMock.mockResolvedValue(ok([]));

      const result = await executeActivitySync();

      expect(result.status).toBe('synced');
      const written = JSON.parse(writeMock.mock.calls.find(
        (c: unknown[]) => (c[0] as string).includes('2026-04-11.json'),
      )![1]);
      expect(written.strain).toBeDefined();
      expect(written.workouts).toBeUndefined();
    });

    it('generates trends after syncing', async () => {
      const sampleData = JSON.stringify({
        date: '2026-04-11',
        strain: { score: 10, calories: 1800, avg_hr: 70, max_hr: 155 },
      });
      readMock.mockImplementation((path: string) => {
        if (typeof path === 'string' && path.endsWith('.json')) return sampleData;
        return null;
      });

      fetchCyclesMock.mockResolvedValue(ok([makeCycle()]));
      fetchWorkoutsMock.mockResolvedValue(ok([]));

      await executeActivitySync();

      const trendsCalls = writeMock.mock.calls.filter(
        (c: unknown[]) => (c[0] as string) === 'health/whoop/trends.md',
      );
      expect(trendsCalls.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('generateTrends (via executeSleepSync)', () => {
    it('reads last 30 days and writes trends.md', async () => {
      // Set up data for a few days
      const dailyData = {
        date: '2026-04-10',
        sleep: { duration_hours: 7.5, performance: 88, efficiency: 92, rem_pct: 22, deep_pct: 15, respiratory_rate: 15, disturbances: 1 },
        recovery: { score: 75, hrv: 50.0, resting_hr: 54, spo2: 98 },
        strain: { score: 11.2, calories: 1800, avg_hr: 70, max_hr: 155 },
      };

      readMock.mockImplementation((path: string) => {
        if (typeof path === 'string' && path.endsWith('.json')) {
          return JSON.stringify(dailyData);
        }
        return null;
      });

      fetchSleepMock.mockResolvedValue(ok([makeSleep()]));
      fetchRecoveryMock.mockResolvedValue(ok([makeRecovery()]));

      await executeSleepSync();

      const trendsCall = writeMock.mock.calls.find(
        (c: unknown[]) => (c[0] as string) === 'health/whoop/trends.md',
      );
      expect(trendsCall).toBeDefined();

      const content = trendsCall![1] as string;
      expect(content).toContain('# Whoop Trends');
      expect(content).toContain('7-Day Averages');
      expect(content).toContain('30-Day Averages');
      expect(content).toContain('Sleep');
      expect(content).toContain('Recovery');
      expect(content).toContain('HRV');
      expect(content).toContain('Strain');
    });

    it('skips trends when no data files exist', async () => {
      readMock.mockReturnValue(null);

      fetchSleepMock.mockResolvedValue(ok([makeSleep()]));
      fetchRecoveryMock.mockResolvedValue(ok([makeRecovery()]));

      await executeSleepSync();

      // Daily data JSON is written, but trends.md may or may not be
      // (trends reads the file just written — readMock returns null so trends skipped)
      const trendsCalls = writeMock.mock.calls.filter(
        (c: unknown[]) => (c[0] as string) === 'health/whoop/trends.md',
      );
      // When readVaultFile returns null for all 30 days, generateTrends returns early
      expect(trendsCalls).toHaveLength(0);
    });
  });

  describe('runWhoopSleepSync', () => {
    it('sends Telegram message on successful sync', async () => {
      fetchSleepMock.mockResolvedValue(ok([makeSleep()]));
      fetchRecoveryMock.mockResolvedValue(ok([makeRecovery()]));
      // Need readMock to return the written data for trends
      readMock.mockReturnValue(null);

      const bot = { sendMessage: vi.fn().mockResolvedValue(undefined) } as any;
      await runWhoopSleepSync(bot);

      expect(bot.sendMessage).toHaveBeenCalledWith(12345, expect.stringContaining('Whoop:'));
    });

    it('does not send message when sync is skipped for "Whoop not configured"', async () => {
      isConfiguredMock.mockReturnValue(false);
      const bot = { sendMessage: vi.fn().mockResolvedValue(undefined) } as any;
      await runWhoopSleepSync(bot);

      expect(bot.sendMessage).not.toHaveBeenCalled();
    });

    it('sends Telegram message when sync is skipped due to no data (distinct from not-configured)', async () => {
      fetchSleepMock.mockResolvedValue(ok([]));
      fetchRecoveryMock.mockResolvedValue(ok([]));
      const bot = { sendMessage: vi.fn().mockResolvedValue(undefined) } as any;

      await runWhoopSleepSync(bot);

      expect(bot.sendMessage).toHaveBeenCalledOnce();
      const call = bot.sendMessage.mock.calls[0];
      expect(call[0]).toBe(12345);
      expect(call[1]).toContain('No sleep/recovery data available');
      expect(call[1]).toContain('2026-04-10');
    });

    it('sends Telegram error when both sleep and recovery endpoints fail', async () => {
      fetchSleepMock.mockResolvedValue(apiErr('HTTP 500 from /v1/activity/sleep'));
      fetchRecoveryMock.mockResolvedValue(apiErr('HTTP 500 from /v1/recovery'));
      const bot = { sendMessage: vi.fn().mockResolvedValue(undefined) } as any;

      await runWhoopSleepSync(bot);

      expect(bot.sendMessage).toHaveBeenCalledWith(12345, expect.stringContaining('Whoop sync failed'));
      expect(bot.sendMessage).toHaveBeenCalledWith(12345, expect.stringContaining('HTTP 500'));
    });

    it('on partial API failure (sleep errored, recovery empty), surfaces it in the skipped-notify message', async () => {
      fetchSleepMock.mockResolvedValue(apiErr('HTTP 500 from /v1/activity/sleep'));
      fetchRecoveryMock.mockResolvedValue(ok([]));
      const bot = { sendMessage: vi.fn().mockResolvedValue(undefined) } as any;

      await runWhoopSleepSync(bot);

      expect(bot.sendMessage).toHaveBeenCalledOnce();
      const call = bot.sendMessage.mock.calls[0];
      expect(call[1]).toContain('No sleep/recovery data available');
      expect(call[1]).toContain('partial API errors');
      expect(call[1]).toContain('sleep=HTTP 500');
    });

    it('sends Telegram alert when sync errors due to bad token', async () => {
      getTokenMock.mockResolvedValue({ ok: false, reason: 'refresh_rejected', status: 401 });
      const bot = { sendMessage: vi.fn().mockResolvedValue(undefined) } as any;
      await runWhoopSleepSync(bot);

      expect(bot.sendMessage).toHaveBeenCalledWith(12345, expect.stringContaining('Whoop sync failed'));
      expect(bot.sendMessage).toHaveBeenCalledWith(12345, expect.stringContaining('HTTP 401'));
    });

    it('does not throw when sync errors', async () => {
      getTokenMock.mockRejectedValue(new Error('keychain crashed'));
      const bot = { sendMessage: vi.fn().mockResolvedValue(undefined) } as any;
      await expect(runWhoopSleepSync(bot)).resolves.toBeUndefined();
    });
  });
});
