import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../config.js', () => ({
  default: { VAULT_DIR: '/test/vault', TIMEZONE: 'America/Chicago', TELEGRAM_USER_ID: 12345 },
}));

vi.mock('./capture.js', () => ({ captureSessions: vi.fn() }));
vi.mock('./whoop-sync.js', () => ({ executeActivitySync: vi.fn(() => ({ status: 'skipped', detail: 'Whoop not configured' })) }));
vi.mock('./playbook-extract.js', () => ({
  extractPlaybookDrafts: vi.fn(() => ({ status: 'skipped', detail: 'No #playbook tag' })),
}));
vi.mock('../kb/engine.js', () => ({
  processIngestionQueue: vi.fn(),
  lintKB: vi.fn(),
  enqueue: vi.fn(),
}));
vi.mock('../ai/claude.js', () => ({
  askClaudeOneShot: vi.fn(),
  runAgent: vi.fn(),
}));
vi.mock('../vault/files.js', () => ({ readVaultFile: vi.fn() }));
vi.mock('../vault/git.js', () => ({ gitCommitAndPush: vi.fn() }));
vi.mock('../utils/time.js', () => ({
  getTodayDate: vi.fn(() => '2026-04-11'),
  getTodayFilename: vi.fn(() => '2026_04_11.md'),
  getDayOfWeek: vi.fn(() => 'Saturday'),
}));

const { captureSessions } = await import('./capture.js');
const { processIngestionQueue, lintKB, enqueue } = await import('../kb/engine.js');
const { askClaudeOneShot, runAgent } = await import('../ai/claude.js');
const { readVaultFile } = await import('../vault/files.js');
const { gitCommitAndPush } = await import('../vault/git.js');
const { getDayOfWeek } = await import('../utils/time.js');
const { executeNightly, runNightly } = await import('./nightly.js');

const captureMock = captureSessions as unknown as ReturnType<typeof vi.fn>;
const queueMock = processIngestionQueue as unknown as ReturnType<typeof vi.fn>;
const enqueueMock = enqueue as unknown as ReturnType<typeof vi.fn>;
const lintMock = lintKB as unknown as ReturnType<typeof vi.fn>;
const askMock = askClaudeOneShot as unknown as ReturnType<typeof vi.fn>;
const agentMock = runAgent as unknown as ReturnType<typeof vi.fn>;
const readMock = readVaultFile as unknown as ReturnType<typeof vi.fn>;
const gitMock = gitCommitAndPush as unknown as ReturnType<typeof vi.fn>;
const dayMock = getDayOfWeek as unknown as ReturnType<typeof vi.fn>;

function setDefaults() {
  captureMock.mockResolvedValue({ captured: 0 });
  queueMock.mockResolvedValue({ processed: 0, errors: 0 });
  readMock.mockReturnValue(null);
  dayMock.mockReturnValue('Saturday');
}

describe('jobs/nightly', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setDefaults();
  });

  describe('executeNightly', () => {
    it('runs all 7 steps and returns results', async () => {
      const result = await executeNightly();
      expect(result.steps).toHaveLength(7);
      expect(result.steps.map((s) => s.step)).toEqual([
        'Session capture',
        'Daily tags',
        'Playbook extract',
        'Journal ingest',
        'KB queue',
        'Whoop activity',
        'KB lint',
      ]);
    });

    it('always runs final git commit', async () => {
      await executeNightly();
      // Last call to gitCommitAndPush should be the final "Nightly processing" commit
      expect(gitMock).toHaveBeenCalledWith('Nightly processing');
    });

    // -- Session capture step --
    it('reports session capture success', async () => {
      captureMock.mockResolvedValue({ captured: 3 });
      const result = await executeNightly();
      const step = result.steps.find((s) => s.step === 'Session capture')!;
      expect(step.status).toBe('success');
      expect(step.detail).toContain('3');
    });

    it('reports session capture skipped when none active', async () => {
      captureMock.mockResolvedValue({ captured: 0 });
      const result = await executeNightly();
      const step = result.steps.find((s) => s.step === 'Session capture')!;
      expect(step.status).toBe('skipped');
    });

    // -- KB queue step --
    it('reports KB queue success', async () => {
      queueMock.mockResolvedValue({ processed: 2, errors: 0 });
      const result = await executeNightly();
      const step = result.steps.find((s) => s.step === 'KB queue')!;
      expect(step.status).toBe('success');
      expect(step.detail).toContain('2');
    });

    it('reports KB queue error when some items fail', async () => {
      queueMock.mockResolvedValue({ processed: 1, errors: 1 });
      const result = await executeNightly();
      const step = result.steps.find((s) => s.step === 'KB queue')!;
      expect(step.status).toBe('error');
    });

    it('reports KB queue skipped when empty', async () => {
      queueMock.mockResolvedValue({ processed: 0, errors: 0 });
      const result = await executeNightly();
      const step = result.steps.find((s) => s.step === 'KB queue')!;
      expect(step.status).toBe('skipped');
    });

    // -- Daily tags step --
    it('skips daily tags when no journal content', async () => {
      readMock.mockReturnValue(null);
      const result = await executeNightly();
      const step = result.steps.find((s) => s.step === 'Daily tags')!;
      expect(step.status).toBe('skipped');
      expect(step.detail).toContain('No journal');
      expect(askMock).not.toHaveBeenCalled();
    });

    it('skips daily tags when journal is empty whitespace', async () => {
      readMock.mockReturnValue('   \n  ');
      const result = await executeNightly();
      const step = result.steps.find((s) => s.step === 'Daily tags')!;
      expect(step.status).toBe('skipped');
    });

    it('skips daily tags when analysis says "No JSON updates needed"', async () => {
      readMock.mockReturnValue('# Journal\n- 10:00 Did some reading');
      askMock.mockResolvedValue({ text: 'No JSON updates needed. Light day.', error: null });

      const result = await executeNightly();
      const step = result.steps.find((s) => s.step === 'Daily tags')!;
      expect(step.status).toBe('skipped');
      expect(step.detail).toContain('No actionable tags');
      expect(agentMock).not.toHaveBeenCalled();
    });

    it('runs json-updater agent when tags found', async () => {
      readMock.mockReturnValue('# Journal\n- 10:00 #workout ran 5k');
      askMock.mockResolvedValue({
        text: '**#workout** -> health/workouts.json\n- 5k run',
        error: null,
      });
      agentMock.mockResolvedValue({ text: 'Updated', error: null });

      const result = await executeNightly();
      const step = result.steps.find((s) => s.step === 'Daily tags')!;
      expect(step.status).toBe('success');
      expect(agentMock).toHaveBeenCalledWith('json-updater', expect.stringContaining('#workout'));
      expect(gitMock).toHaveBeenCalledWith(expect.stringContaining('Daily tag processing'));
    });

    it('reports error when analysis returns an error', async () => {
      readMock.mockReturnValue('# Journal\n- stuff');
      askMock.mockResolvedValue({ text: null, error: 'Claude timed out' });

      const result = await executeNightly();
      const step = result.steps.find((s) => s.step === 'Daily tags')!;
      expect(step.status).toBe('error');
      expect(step.detail).toContain('Claude timed out');
    });

    it('reports error when json-updater agent fails', async () => {
      readMock.mockReturnValue('# Journal\n- 10:00 #book read Dune');
      askMock.mockResolvedValue({ text: '**#book** -> books.json', error: null });
      agentMock.mockResolvedValue({ text: null, error: 'Agent crashed' });

      const result = await executeNightly();
      const step = result.steps.find((s) => s.step === 'Daily tags')!;
      expect(step.status).toBe('error');
      expect(step.detail).toContain('Agent crashed');
    });

    // -- Journal ingest step --
    it('enqueues today\'s journal when content exists', async () => {
      readMock.mockReturnValue('# Journal\n- 10:00 meeting with #alice about project');
      // Prevent Daily tags from calling the json-updater agent during this test
      askMock.mockResolvedValue({ text: 'No JSON updates needed.', error: null });

      const result = await executeNightly();
      const step = result.steps.find((s) => s.step === 'Journal ingest')!;
      expect(step.status).toBe('success');
      expect(step.detail).toContain('journals/');
      expect(enqueueMock).toHaveBeenCalledWith('journals/2026_04_11.md');
    });

    it('skips journal ingest when journal is empty', async () => {
      readMock.mockReturnValue('   \n  ');
      const result = await executeNightly();
      const step = result.steps.find((s) => s.step === 'Journal ingest')!;
      expect(step.status).toBe('skipped');
      expect(enqueueMock).not.toHaveBeenCalled();
    });

    it('skips journal ingest when journal does not exist', async () => {
      readMock.mockReturnValue(null);
      const result = await executeNightly();
      const step = result.steps.find((s) => s.step === 'Journal ingest')!;
      expect(step.status).toBe('skipped');
      expect(enqueueMock).not.toHaveBeenCalled();
    });

    // -- Lint step --
    it('skips lint when not Sunday', async () => {
      dayMock.mockReturnValue('Wednesday');
      const result = await executeNightly();
      const step = result.steps.find((s) => s.step === 'KB lint')!;
      expect(step.status).toBe('skipped');
      expect(step.detail).toContain('Not Sunday');
      expect(lintMock).not.toHaveBeenCalled();
    });

    it('runs lint on Sunday and reports success', async () => {
      dayMock.mockReturnValue('Sunday');
      lintMock.mockResolvedValue({ success: true, report: 'All good, 0 issues' });

      const result = await executeNightly();
      const step = result.steps.find((s) => s.step === 'KB lint')!;
      expect(step.status).toBe('success');
      expect(step.detail).toContain('All good');
    });

    it('reports lint error when agent fails on Sunday', async () => {
      dayMock.mockReturnValue('Sunday');
      lintMock.mockResolvedValue({ success: false, report: 'Lint error: Claude timed out after 300s' });

      const result = await executeNightly();
      const step = result.steps.find((s) => s.step === 'KB lint')!;
      expect(step.status).toBe('error');
      expect(step.detail).toContain('timed out');
    });

    // -- Error isolation --
    it('continues when session capture throws', async () => {
      captureMock.mockRejectedValue(new Error('crash'));

      const result = await executeNightly();
      expect(result.steps).toHaveLength(7);
      expect(result.steps[0]!.status).toBe('error');
      // Remaining steps still ran
      expect(result.steps[1]!.step).toBe('Daily tags');
      expect(queueMock).toHaveBeenCalled();
    });

    it('continues when KB queue throws', async () => {
      queueMock.mockRejectedValue(new Error('queue exploded'));

      const result = await executeNightly();
      expect(result.steps).toHaveLength(7);
      // KB queue is now at index 4 (after Session capture, Daily tags, Playbook extract, Journal ingest)
      expect(result.steps[4]!.step).toBe('KB queue');
      expect(result.steps[4]!.status).toBe('error');
      // Whoop activity still ran after it
      expect(result.steps[5]!.step).toBe('Whoop activity');
    });

    it('continues when journal read throws', async () => {
      readMock.mockImplementation(() => { throw new Error('fs error'); });

      const result = await executeNightly();
      expect(result.steps).toHaveLength(7);
      // Journal read is centralized; both journal-dependent steps skip gracefully
      const dailyTags = result.steps.find((s) => s.step === 'Daily tags')!;
      const journalIngest = result.steps.find((s) => s.step === 'Journal ingest')!;
      expect(dailyTags.status).toBe('skipped');
      expect(journalIngest.status).toBe('skipped');
      expect(enqueueMock).not.toHaveBeenCalled();
      // Lint step still ran (last index)
      expect(result.steps[6]!.step).toBe('KB lint');
    });

    it('reads today journal only once across steps', async () => {
      readMock.mockReturnValue('# Journal\n- 10:00 #workout ran 5k');
      askMock.mockResolvedValue({ text: 'No JSON updates needed.', error: null });

      await executeNightly();

      const journalReads = readMock.mock.calls.filter(
        (call) => typeof call[0] === 'string' && call[0].startsWith('journals/'),
      );
      expect(journalReads).toHaveLength(1);
      expect(journalReads[0]![0]).toBe('journals/2026_04_11.md');
    });
  });

  describe('runNightly', () => {
    it('sends summary message to Telegram on success', async () => {
      const bot = { sendMessage: vi.fn().mockResolvedValue(undefined) } as any;

      await runNightly(bot);

      expect(bot.sendMessage).toHaveBeenCalledTimes(1);
      expect(bot.sendMessage).toHaveBeenCalledWith(12345, expect.stringContaining('Nightly complete'));
    });

    it('sends error message when executeNightly throws', async () => {
      captureMock.mockImplementation(() => { throw new Error('total failure'); });
      // Make all steps throw so the error propagates through run() — but run() catches.
      // Actually executeNightly wraps each step, so it won't throw from step errors.
      // We need to make something outside the steps throw.
      // gitCommitAndPush at the end will throw:
      gitMock.mockImplementation(() => { throw new Error('total failure'); });

      const bot = { sendMessage: vi.fn().mockResolvedValue(undefined) } as any;
      await runNightly(bot);

      expect(bot.sendMessage).toHaveBeenCalledWith(12345, expect.stringContaining('failed'));
    });

    it('does not throw when both nightly and TG message fail', async () => {
      gitMock.mockImplementation(() => { throw new Error('git broke'); });
      const bot = {
        sendMessage: vi.fn()
          .mockRejectedValueOnce(new Error('TG down'))   // error message send fails
          .mockRejectedValueOnce(new Error('TG down')),  // in case called again
      } as any;

      // Should not throw
      await expect(runNightly(bot)).resolves.toBeUndefined();
    });

    it('includes step status icons in summary message', async () => {
      captureMock.mockResolvedValue({ captured: 1 });
      gitMock.mockReturnValue(undefined); // ensure no leftover throw from prior test
      const bot = { sendMessage: vi.fn().mockResolvedValue(undefined) } as any;

      await runNightly(bot);

      const msg = bot.sendMessage.mock.calls[0][1] as string;
      expect(msg).toContain('[+]'); // success icon
      expect(msg).toContain('[-]'); // skipped icon
    });
  });
});
