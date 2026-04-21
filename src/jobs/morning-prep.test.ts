import { describe, it, expect, vi, beforeEach } from 'vitest';
import type TelegramBot from 'node-telegram-bot-api';

const mockReadVaultFile = vi.fn<(path: string) => string | null>();
const mockParseTag = vi.fn<(content: string, tag: string) => string | null>();
const mockWriteMorningPrep = vi.fn<(sections: string) => { written: boolean; filepath: string }>();
const mockGitCommitAndPush = vi.fn<(message: string) => void>();
const mockGetYesterdayFilename = vi.fn(() => '2026_04_08.md');
const mockGetDayOfWeek = vi.fn(() => 'Wednesday');
const mockAskClaudeOneShot = vi.fn<(message: string, timeoutMs?: number) => Promise<{ text: string | null; error: string | null }>>();

vi.mock('../vault/files.js', () => ({
  readVaultFile: mockReadVaultFile,
}));

vi.mock('../vault/journal.js', () => ({
  parseTag: mockParseTag,
  writeMorningPrep: mockWriteMorningPrep,
}));

vi.mock('../vault/git.js', () => ({
  gitCommitAndPush: mockGitCommitAndPush,
}));

vi.mock('../utils/time.js', () => ({
  getYesterdayFilename: mockGetYesterdayFilename,
  getDayOfWeek: mockGetDayOfWeek,
}));

vi.mock('../utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../config.js', () => ({
  default: {
    VAULT_DIR: '/test/vault',
    TIMEZONE: 'America/Chicago',
    TELEGRAM_USER_ID: 123456,
  },
}));

vi.mock('../ai/claude.js', () => ({
  askClaudeOneShot: mockAskClaudeOneShot,
}));

const { gatherMorningData, formatMorningPrepFallback, synthesizeMorningPrep, executeMorningPrep, runMorningPrep } = await import('./morning-prep.js');

describe('jobs/morning-prep — gatherMorningData', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns real content for all fields when every source is present', () => {
    const journalContent = '# Journal\n#priorities\n- Ship feature X\n- Review PRs\n';
    mockReadVaultFile.mockImplementation((path: string) => {
      if (path === 'journals/2026_04_08.md') return journalContent;
      if (path === 'health/plan.md') return 'Run 5k + stretching';
      if (path === 'study/syllabus.md') return 'Chapter 7: Transformers';
      if (path === 'study/progress.json') return '{"chapter":6,"complete":true}';
      if (path === 'writing/topics.md') return 'Draft: LLM orchestration patterns';
      return null;
    });
    mockParseTag.mockReturnValue('- Ship feature X\n- Review PRs');

    const data = gatherMorningData();

    expect(data.priorities).toBe('- Ship feature X\n- Review PRs');
    expect(data.workout).toBe('Run 5k + stretching');
    expect(data.study).toBe('Chapter 7: Transformers\n\n{"chapter":6,"complete":true}');
    expect(data.writing).toBe('Draft: LLM orchestration patterns');
    expect(data.yesterdayFile).toBe('2026_04_08.md');
    expect(data.dayOfWeek).toBe('Wednesday');
  });

  it('returns fallback strings when all sources are missing', () => {
    mockReadVaultFile.mockReturnValue(null);
    mockParseTag.mockReturnValue(null);

    const data = gatherMorningData();

    expect(data.priorities).toBe('No priorities logged yesterday.');
    expect(data.workout).toBe('No workout plan found.');
    expect(data.study).toBe('No active study assignments.');
    expect(data.writing).toBe('No writing topic set.');
  });

  it('returns fallback for priorities when journal exists but has no #priorities tag', () => {
    mockReadVaultFile.mockImplementation((path: string) => {
      if (path === 'journals/2026_04_08.md') return '# Journal\nJust some notes.';
      return null;
    });
    mockParseTag.mockReturnValue(null);

    const data = gatherMorningData();

    expect(data.priorities).toBe('No priorities logged yesterday.');
    expect(mockParseTag).toHaveBeenCalledWith('# Journal\nJust some notes.', 'priorities');
  });

  it('returns just syllabus when progress.json is missing', () => {
    mockReadVaultFile.mockImplementation((path: string) => {
      if (path === 'study/syllabus.md') return 'Week 3: Attention mechanisms';
      return null;
    });
    mockParseTag.mockReturnValue(null);

    const data = gatherMorningData();

    expect(data.study).toBe('Week 3: Attention mechanisms');
  });

  it('returns just progress.json when syllabus is missing', () => {
    mockReadVaultFile.mockImplementation((path: string) => {
      if (path === 'study/progress.json') return '{"lesson":4}';
      return null;
    });
    mockParseTag.mockReturnValue(null);

    const data = gatherMorningData();

    expect(data.study).toBe('{"lesson":4}');
  });

  it('always populates yesterdayFile and dayOfWeek from time utils', () => {
    mockReadVaultFile.mockReturnValue(null);
    mockParseTag.mockReturnValue(null);

    const data = gatherMorningData();

    expect(data.yesterdayFile).toBe('2026_04_08.md');
    expect(data.dayOfWeek).toBe('Wednesday');
    expect(mockGetYesterdayFilename).toHaveBeenCalledOnce();
    expect(mockGetDayOfWeek).toHaveBeenCalledOnce();
  });

  it('never throws even if readVaultFile returns null for every path', () => {
    mockReadVaultFile.mockReturnValue(null);
    mockParseTag.mockReturnValue(null);

    expect(() => gatherMorningData()).not.toThrow();
  });
});

const sampleData = {
  priorities: '- Ship feature X\n- Review PRs',
  workout: 'Run 5k + stretching',
  study: 'Chapter 7: Transformers',
  writing: 'Draft: LLM orchestration patterns',
  yesterdayFile: '2026_04_08.md',
  dayOfWeek: 'Wednesday',
};

describe('jobs/morning-prep — formatMorningPrepFallback', () => {
  it('produces correct 4-section markdown with the data', () => {
    const result = formatMorningPrepFallback(sampleData);

    expect(result).toBe(
      '### Priorities Recap\n- Ship feature X\n- Review PRs\n\n' +
      '### Workout\nRun 5k + stretching\n\n' +
      '### Study\nChapter 7: Transformers\n\n' +
      '### Writing Focus\nDraft: LLM orchestration patterns'
    );
  });

  it('truncates workout content exceeding the line cap and adds a source hint', () => {
    const longWorkout = Array.from({ length: 50 }, (_, i) => `- exercise ${i}`).join('\n');
    const data = { ...sampleData, workout: longWorkout };

    const result = formatMorningPrepFallback(data);

    // Fallback must be terse — no raw 50-line dump
    expect(result).toContain('exercise 0');
    expect(result).not.toContain('exercise 20');
    expect(result).toContain('truncated');
    expect(result).toContain('health/plan.md');
    expect(result.length).toBeLessThan(2000);
  });

  it('truncates study content containing a raw JSON blob', () => {
    const jsonBlob = JSON.stringify(Array.from({ length: 30 }, (_, i) => ({ id: i, title: `item ${i}` })), null, 2);
    const data = { ...sampleData, study: `## Syllabus\n- Chapter 7: Transformers\n\n${jsonBlob}` };

    const result = formatMorningPrepFallback(data);

    // Raw item 29 must not end up in the journal
    expect(result).not.toContain('item 29');
    expect(result).toContain('truncated');
    expect(result).toContain('study/syllabus.md');
  });

  it('truncates priorities content exceeding the 15-line cap and adds a journal source hint', () => {
    const longPriorities = Array.from({ length: 30 }, (_, i) => `- priority ${i}`).join('\n');
    const data = { ...sampleData, priorities: longPriorities };

    const result = formatMorningPrepFallback(data);

    expect(result).toContain('priority 0');
    expect(result).toContain('priority 14'); // 15-line cap: indices 0..14 retained
    expect(result).not.toContain('priority 20');
    expect(result).not.toContain('priority 29');
    expect(result).toContain('truncated');
    expect(result).toContain('#priorities');
  });

  it('truncates writing content exceeding the 10-line cap and adds a topics source hint', () => {
    const longWriting = Array.from({ length: 25 }, (_, i) => `- topic ${i}`).join('\n');
    const data = { ...sampleData, writing: longWriting };

    const result = formatMorningPrepFallback(data);

    expect(result).toContain('topic 0');
    expect(result).toContain('topic 9'); // 10-line cap: indices 0..9 retained
    expect(result).not.toContain('topic 15');
    expect(result).not.toContain('topic 24');
    expect(result).toContain('truncated');
    expect(result).toContain('writing/topics.md');
  });
});

describe('jobs/morning-prep — synthesizeMorningPrep', () => {
  beforeEach(() => vi.clearAllMocks());

  it('on Claude success, returns result.text with synthFailed=false', async () => {
    const synthesized = '### Priorities Recap\n- Ship feature X (in progress)\n\n### Workout\n- Run 5k + stretching\n\n### Study\n- Chapter 7: Transformers\n\n### Writing Focus\n- LLM orchestration patterns draft';
    mockAskClaudeOneShot.mockResolvedValue({ text: synthesized, error: null });

    const result = await synthesizeMorningPrep(sampleData);

    expect(result.text).toBe(synthesized);
    expect(result.synthFailed).toBe(false);
    expect(result.synthError).toBeNull();
  });

  it('on Claude error, returns fallback-formatted content and synthFailed=true', async () => {
    mockAskClaudeOneShot.mockResolvedValue({ text: null, error: 'Claude timed out after 30s' });

    const result = await synthesizeMorningPrep(sampleData);

    expect(result.text).toBe(formatMorningPrepFallback(sampleData));
    expect(result.synthFailed).toBe(true);
    expect(result.synthError).toBe('Claude timed out after 30s');
  });

  it('on Claude returning null text, returns fallback with synthFailed=true', async () => {
    mockAskClaudeOneShot.mockResolvedValue({ text: null, error: null });

    const result = await synthesizeMorningPrep(sampleData);

    expect(result.text).toBe(formatMorningPrepFallback(sampleData));
    expect(result.synthFailed).toBe(true);
    expect(result.synthError).toBe('empty response');
  });

  it('on Claude throwing an exception, returns fallback with synthFailed=true', async () => {
    mockAskClaudeOneShot.mockRejectedValue(new Error('spawn ENOENT'));

    const result = await synthesizeMorningPrep(sampleData);

    expect(result.text).toBe(formatMorningPrepFallback(sampleData));
    expect(result.synthFailed).toBe(true);
    expect(result.synthError).toContain('spawn ENOENT');
  });

  it('prompt includes dayOfWeek and yesterdayFile context', async () => {
    mockAskClaudeOneShot.mockResolvedValue({ text: 'synthesized', error: null });

    await synthesizeMorningPrep(sampleData);

    const prompt = mockAskClaudeOneShot.mock.calls[0]![0];
    expect(prompt).toContain('Wednesday');
    expect(prompt).toContain('2026_04_08.md');
  });
});

describe('jobs/morning-prep — executeMorningPrep', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReadVaultFile.mockReturnValue(null);
    mockParseTag.mockReturnValue(null);
    mockAskClaudeOneShot.mockResolvedValue({ text: '### Priorities Recap\n...', error: null });
  });

  it('returns written status and commits on successful write', async () => {
    mockWriteMorningPrep.mockReturnValue({ written: true, filepath: '/test/vault/journals/2026_04_09.md' });

    const result = await executeMorningPrep();

    expect(result).toEqual({ status: 'written', filepath: '/test/vault/journals/2026_04_09.md' });
    expect(mockGitCommitAndPush).toHaveBeenCalledWith('Morning prep');
  });

  it('returns fallback status with synthError when Claude synthesis fails but write succeeds', async () => {
    mockAskClaudeOneShot.mockResolvedValue({ text: null, error: 'Claude timed out after 120s' });
    mockWriteMorningPrep.mockReturnValue({ written: true, filepath: '/test/vault/journals/2026_04_09.md' });

    const result = await executeMorningPrep();

    expect(result.status).toBe('fallback');
    expect(result).toMatchObject({
      status: 'fallback',
      filepath: '/test/vault/journals/2026_04_09.md',
      synthError: 'Claude timed out after 120s',
    });
    expect(mockGitCommitAndPush).toHaveBeenCalledWith('Morning prep');
  });

  it('returns skipped status and does not commit when already written', async () => {
    mockWriteMorningPrep.mockReturnValue({ written: false, filepath: '/test/vault/journals/2026_04_09.md' });

    const result = await executeMorningPrep();

    expect(result).toEqual({ status: 'skipped', filepath: '/test/vault/journals/2026_04_09.md' });
    expect(mockGitCommitAndPush).not.toHaveBeenCalled();
  });

  it('propagates errors (does not swallow them)', async () => {
    mockWriteMorningPrep.mockImplementation(() => { throw new Error('disk full'); });

    await expect(executeMorningPrep()).rejects.toThrow('disk full');
    expect(mockGitCommitAndPush).not.toHaveBeenCalled();
  });
});

describe('jobs/morning-prep — runMorningPrep', () => {
  const mockBot = { sendMessage: vi.fn().mockResolvedValue(undefined) } as unknown as TelegramBot;

  beforeEach(() => {
    vi.clearAllMocks();
    // Default stubs: sources present, Claude succeeds, write succeeds
    mockReadVaultFile.mockReturnValue(null);
    mockParseTag.mockReturnValue(null);
    mockAskClaudeOneShot.mockResolvedValue({ text: '### Priorities Recap\n...', error: null });
    mockWriteMorningPrep.mockReturnValue({ written: true, filepath: '/test/vault/journals/2026_04_09.md' });
  });

  it('full success: gather -> synthesize -> write -> commit -> notify', async () => {
    await runMorningPrep(mockBot);

    expect(mockWriteMorningPrep).toHaveBeenCalledOnce();
    expect(mockGitCommitAndPush).toHaveBeenCalledWith('Morning prep');
    expect(mockBot.sendMessage).toHaveBeenCalledWith(123456, 'Your journal is ready.');
  });

  it('idempotent skip: writeMorningPrep returns written=false, no commit or notification', async () => {
    mockWriteMorningPrep.mockReturnValue({ written: false, filepath: '/test/vault/journals/2026_04_09.md' });

    await runMorningPrep(mockBot);

    expect(mockWriteMorningPrep).toHaveBeenCalledOnce();
    expect(mockGitCommitAndPush).not.toHaveBeenCalled();
    expect(mockBot.sendMessage).not.toHaveBeenCalled();
  });

  it('fallback: when Claude synthesis fails, sends a distinct TG message referencing the error', async () => {
    mockAskClaudeOneShot.mockResolvedValue({ text: null, error: 'Claude timed out after 120s' });

    await runMorningPrep(mockBot);

    expect(mockWriteMorningPrep).toHaveBeenCalledOnce();
    expect(mockGitCommitAndPush).toHaveBeenCalledWith('Morning prep');
    const sent = (mockBot.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(sent?.[0]).toBe(123456);
    expect(sent?.[1]).toContain('fallback');
    expect(sent?.[1]).toContain('Claude timed out after 120s');
    expect(sent?.[1]).not.toBe('Your journal is ready.');
  });

  it('fallback: redacts absolute paths from synthError before sending to Telegram', async () => {
    mockAskClaudeOneShot.mockResolvedValue({
      text: null,
      error: 'spawn ENOENT /Users/somebody/workspace/jarvis/node_modules/.bin/claude',
    });

    await runMorningPrep(mockBot);

    const sent = (mockBot.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(sent?.[1]).not.toContain('/Users/somebody');
    expect(sent?.[1]).toContain('[path]');
    expect(sent?.[1]).toContain('spawn ENOENT');
  });

  it('fallback: caps long synthError messages at 200 characters', async () => {
    const longError = 'Claude error: ' + 'x'.repeat(500);
    mockAskClaudeOneShot.mockResolvedValue({ text: null, error: longError });

    await runMorningPrep(mockBot);

    const sent = (mockBot.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0];
    const msg = sent?.[1] as string;
    // Extract the error substring from the template "... failed: <error>. Review..."
    const match = msg.match(/failed: (.*?)\. Review/);
    expect(match).not.toBeNull();
    expect(match![1]!.length).toBeLessThanOrEqual(200);
  });

  it('git commit is called with exact message "Morning prep"', async () => {
    await runMorningPrep(mockBot);

    expect(mockGitCommitAndPush).toHaveBeenCalledOnce();
    expect(mockGitCommitAndPush.mock.calls[0]![0]).toBe('Morning prep');
  });

  it('TG notification sent to config.TELEGRAM_USER_ID', async () => {
    await runMorningPrep(mockBot);

    expect(mockBot.sendMessage).toHaveBeenCalledOnce();
    expect(mockBot.sendMessage).toHaveBeenCalledWith(123456, 'Your journal is ready.');
  });

  it('error in gatherMorningData does not throw', async () => {
    mockGetYesterdayFilename.mockImplementation(() => { throw new Error('time exploded'); });

    await expect(runMorningPrep(mockBot)).resolves.toBeUndefined();

    expect(mockGitCommitAndPush).not.toHaveBeenCalled();
    expect(mockBot.sendMessage).not.toHaveBeenCalled();
  });

  it('error in writeMorningPrep does not throw', async () => {
    mockWriteMorningPrep.mockImplementation(() => { throw new Error('fs write failed'); });

    await expect(runMorningPrep(mockBot)).resolves.toBeUndefined();

    expect(mockGitCommitAndPush).not.toHaveBeenCalled();
    expect(mockBot.sendMessage).not.toHaveBeenCalled();
  });

  it('error in gitCommitAndPush does not throw', async () => {
    mockGitCommitAndPush.mockImplementation(() => { throw new Error('git failed'); });

    await expect(runMorningPrep(mockBot)).resolves.toBeUndefined();
  });

  it('error in bot.sendMessage does not throw', async () => {
    (mockBot.sendMessage as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('TG API down'));

    await expect(runMorningPrep(mockBot)).resolves.toBeUndefined();
  });
});
