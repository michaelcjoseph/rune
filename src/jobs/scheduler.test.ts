import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockStop = vi.fn();
const mockSchedule = vi.fn((..._args: unknown[]) => ({ stop: mockStop }));
const mockValidate = vi.fn((_expr: string) => true);

vi.mock('node-cron', () => ({
  default: { schedule: mockSchedule, validate: mockValidate },
}));

vi.mock('../config.js', () => ({
  default: {
    TIMEZONE: 'America/Chicago',
    VAULT_DIR: '/test/vault',
    LOGS_DIR: '/test/logs',
    TELEGRAM_USER_ID: 42,
    AGENT_MODEL: 'opus',
    CLAUDE_TIMEOUT_MS: 300_000,
  },
  PROJECT_ROOT: '/test/project',
}));

vi.mock('../ai/claude.js', () => ({
  loadAgentDef: vi.fn(() => ({ prompt: 'agent body', tools: [] })),
  runAgent: vi.fn(async () => ({ text: 'result', error: null })),
  clearAgentDefCache: vi.fn(),
}));

vi.mock('../bot/skill-registry.js', () => ({
  reloadSkillRegistry: vi.fn(),
}));

vi.mock('../integrations/telegram/client.js', () => ({
  sendLongMessage: vi.fn(async () => {}),
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

// Mock fs to avoid writing real state files and real agent-dir scans in tests.
// readdirSync returns [] by default — per-test overrides can inject fake agents.
vi.mock('node:fs', () => ({
  readFileSync: vi.fn(() => { throw new Error('ENOENT'); }),
  writeFileSync: vi.fn(),
  readdirSync: vi.fn(() => []),
}));

const { startScheduler, stopScheduler, recordJobRun, scanAgentCronJobs } = await import('./scheduler.js');
const { readFileSync, writeFileSync, readdirSync } = await import('node:fs');
const { runMorningPrep } = await import('./morning-prep.js');
const { loadAgentDef, runAgent } = await import('../ai/claude.js');
const { sendLongMessage } = await import('../integrations/telegram/client.js');

// Minimal cron-validation stub: the real node-cron module is mocked at the top,
// so we need to expose `.validate` on the mocked default so scheduler.ts can call it.
// Done via module augmentation below.

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

  it('startScheduler calls cron.schedule with UTC timezone', () => {
    startScheduler({} as any);

    expect(mockSchedule).toHaveBeenCalled();
    const options = mockSchedule.mock.calls[0]![2] as unknown as { timezone: string };
    expect(options.timezone).toBe('UTC');
  });

  it('startScheduler registers the expected number of jobs (5)', () => {
    startScheduler({} as any);

    expect(mockSchedule).toHaveBeenCalledTimes(5);
  });

  it('startScheduler passes the morning-prep cron expression in UTC', () => {
    startScheduler({} as any);

    const cronExpr = mockSchedule.mock.calls[0]![0] as unknown as string;
    expect(cronExpr).toBe('30 10 * * *'); // 5:30 AM CDT
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

  // ─── Skill-frontmatter cron: agent-cron registration ───────────────────────

  describe('scanAgentCronJobs', () => {
    it('registers a job per agent that declares a cron field', () => {
      vi.mocked(readdirSync).mockImplementation(((dir: string) => {
        if (dir.includes('/test/project/')) return ['sec-filings-watcher.md', 'no-cron-agent.md'];
        return [];
      }) as any);
      vi.mocked(loadAgentDef).mockImplementation((name: string) => {
        if (name === 'sec-filings-watcher') {
          return { prompt: 'body', tools: [], cron: '0 7 * * 1', cronArgs: 'review', cronChat: true };
        }
        return { prompt: 'body', tools: [] }; // no cron
      });

      const jobs = scanAgentCronJobs({} as any);
      expect(jobs.map(j => j.name)).toEqual(['agent:sec-filings-watcher']);
      expect(jobs[0]!.schedule).toBe('0 7 * * 1');
    });

    it('skips agents with invalid cron expressions and logs an error', () => {
      vi.mocked(readdirSync).mockImplementation(((dir: string) => {
        if (dir.includes('/test/project/')) return ['bad-cron.md'];
        return [];
      }) as any);
      vi.mocked(loadAgentDef).mockReturnValue({
        prompt: 'body',
        tools: [],
        cron: 'not a cron',
      });
      mockValidate.mockReturnValueOnce(false);

      const jobs = scanAgentCronJobs({} as any);
      expect(jobs).toEqual([]);
    });

    it('dedupes by filename stem — Jarvis agent dir wins over vault', () => {
      vi.mocked(readdirSync).mockImplementation(((dir: string) => {
        if (dir.includes('/test/project/')) return ['dup.md'];
        if (dir.includes('/test/vault/')) return ['dup.md'];
        return [];
      }) as any);
      vi.mocked(loadAgentDef).mockReturnValue({ prompt: 'body', tools: [], cron: '0 9 * * *' });

      const jobs = scanAgentCronJobs({} as any);
      expect(jobs).toHaveLength(1);
      // loadAgentDef should have been called exactly once (second dir's dup is skipped)
      expect(vi.mocked(loadAgentDef)).toHaveBeenCalledTimes(1);
    });

    it('posts output to Telegram when cron_chat is true', async () => {
      vi.mocked(readdirSync).mockImplementation(((dir: string) => {
        if (dir.includes('/test/project/')) return ['chatty.md'];
        return [];
      }) as any);
      vi.mocked(loadAgentDef).mockReturnValue({
        prompt: 'body',
        tools: [],
        cron: '0 * * * *',
        cronArgs: 'do it',
        cronChat: true,
      });
      vi.mocked(runAgent).mockResolvedValue({ text: 'chatty output', error: null });

      const jobs = scanAgentCronJobs({ sendMessage: vi.fn() } as any);
      await jobs[0]!.run();

      expect(vi.mocked(runAgent)).toHaveBeenCalledWith('chatty', 'do it');
      expect(vi.mocked(sendLongMessage)).toHaveBeenCalledWith(expect.anything(), 42, 'chatty output');
    });

    it('logs without posting to Telegram when cron_chat is false or missing', async () => {
      vi.mocked(readdirSync).mockImplementation(((dir: string) => {
        if (dir.includes('/test/project/')) return ['quiet.md'];
        return [];
      }) as any);
      vi.mocked(loadAgentDef).mockReturnValue({
        prompt: 'body',
        tools: [],
        cron: '0 * * * *',
        // cronChat intentionally omitted
      });
      vi.mocked(runAgent).mockResolvedValue({ text: 'quiet output', error: null });

      const jobs = scanAgentCronJobs({} as any);
      await jobs[0]!.run();

      expect(vi.mocked(runAgent)).toHaveBeenCalledWith('quiet', '');
      expect(vi.mocked(sendLongMessage)).not.toHaveBeenCalled();
    });

    it('logs error and does not post when runAgent returns an error', async () => {
      vi.mocked(readdirSync).mockImplementation(((dir: string) => {
        if (dir.includes('/test/project/')) return ['failing.md'];
        return [];
      }) as any);
      vi.mocked(loadAgentDef).mockReturnValue({
        prompt: 'body',
        tools: [],
        cron: '0 * * * *',
        cronChat: true,
      });
      vi.mocked(runAgent).mockResolvedValue({ text: null, error: 'agent exploded' });

      const jobs = scanAgentCronJobs({} as any);
      await jobs[0]!.run(); // must not throw

      expect(vi.mocked(sendLongMessage)).not.toHaveBeenCalled();
    });

    it('startScheduler merges agent-cron jobs with the hardcoded jobs', () => {
      vi.mocked(readdirSync).mockImplementation(((dir: string) => {
        if (dir.includes('/test/project/')) return ['scheduled-agent.md'];
        return [];
      }) as any);
      vi.mocked(loadAgentDef).mockReturnValue({
        prompt: 'body',
        tools: [],
        cron: '0 12 * * *',
      });

      // Baseline hardcoded count (no readdirSync hits yet — happens inside scanAgentCronJobs)
      const agentJobs = scanAgentCronJobs({} as any);
      mockSchedule.mockClear();

      startScheduler({} as any);
      // Hardcoded jobs + scanned agent jobs — avoid hardcoding the count so
      // future additions to registerJobs don't silently break this test.
      expect(mockSchedule.mock.calls.length).toBeGreaterThan(agentJobs.length);
      // All registered schedules should include the agent cron expression.
      const schedules = mockSchedule.mock.calls.map((c) => c[0]);
      expect(schedules).toContain('0 12 * * *');
    });

    it('rejects 6-field cron expressions even when cron.validate accepts them', () => {
      vi.mocked(readdirSync).mockImplementation(((dir: string) => {
        if (dir.includes('/test/project/')) return ['seconds-cron.md'];
        return [];
      }) as any);
      vi.mocked(loadAgentDef).mockReturnValue({
        prompt: 'body',
        tools: [],
        cron: '0 0 12 * * *', // 6-field; seconds field not supported by our catchup
      });
      mockValidate.mockReturnValueOnce(true); // validate would accept it

      const jobs = scanAgentCronJobs({} as any);
      expect(jobs).toEqual([]);
    });

    it('returns [] gracefully when agent dirs do not exist (ENOENT)', () => {
      vi.mocked(readdirSync).mockImplementation((() => {
        const err = new Error('ENOENT') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }) as any);
      const jobs = scanAgentCronJobs({} as any);
      expect(jobs).toEqual([]);
    });
  });
});
