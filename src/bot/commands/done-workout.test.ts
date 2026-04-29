import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Create temp dirs before any mocks — vi.hoisted must be synchronous.
const { logsTmpDir } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdirSync: mkd } = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir: td } = require('node:os') as typeof import('node:os');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join: jn } = require('node:path') as typeof import('node:path');
  const logsTmpDir = jn(td(), `jarvis-done-workout-logs-${Date.now()}`);
  mkd(logsTmpDir, { recursive: true });
  return { logsTmpDir };
});

vi.mock('../../config.js', () => ({
  default: {
    LAST_WORKOUT_FILE: join(logsTmpDir, 'last-workout.json'),
  },
}));

const mockAppendToJournal = vi.fn();

vi.mock('../../vault/journal.js', () => ({
  appendToJournal: mockAppendToJournal,
}));

vi.mock('../../utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  }),
}));

const { handleDoneWorkout, _resetDoneWorkoutState } = await import('./done-workout.js');

// ─── helpers ──────────────────────────────────────────────────────────────────

const LAST_WORKOUT_PATH = join(logsTmpDir, 'last-workout.json');

function writeLastWorkout(overrides: Partial<{
  generated_at: string;
  location: string | null;
  focus: string | null;
  markdown: string;
  structured: object;
}> = {}): void {
  const defaults = {
    generated_at: new Date().toISOString(),
    location: 'gym',
    focus: 'strength',
    markdown: '# Workout\n\nSquats 5x5\nDeadlifts 3x5',
    structured: { exercises: ['squat', 'deadlift'] },
  };
  writeFileSync(LAST_WORKOUT_PATH, JSON.stringify({ ...defaults, ...overrides }, null, 2));
}

function deleteLastWorkout(): void {
  try { unlinkSync(LAST_WORKOUT_PATH); } catch { /* absent — ok */ }
}

const CHAT_ID = 42;

function mockBot() {
  return {
    sendMessage: vi.fn().mockResolvedValue(undefined),
  } as any;
}

// ─── 1. No prior workout path ─────────────────────────────────────────────────

describe('handleDoneWorkout — no prior workout', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetDoneWorkoutState();
    deleteLastWorkout();
  });

  it('sends "Nothing to log" when LAST_WORKOUT_FILE does not exist', async () => {
    const bot = mockBot();
    await handleDoneWorkout(bot, CHAT_ID);

    expect(bot.sendMessage).toHaveBeenCalledOnce();
    const msg = (bot.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as string;
    expect(msg).toContain('Nothing to log');
    expect(msg).toContain('/workout');
  });

  it('does not call appendToJournal when file is missing', async () => {
    const bot = mockBot();
    await handleDoneWorkout(bot, CHAT_ID);

    expect(mockAppendToJournal).not.toHaveBeenCalled();
  });

  it('does not create LAST_WORKOUT_FILE when it is missing', async () => {
    const bot = mockBot();
    await handleDoneWorkout(bot, CHAT_ID);

    expect(existsSync(LAST_WORKOUT_PATH)).toBe(false);
  });
});

// ─── 2. Corrupt JSON path ─────────────────────────────────────────────────────

describe('handleDoneWorkout — corrupt JSON', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetDoneWorkoutState();
    deleteLastWorkout();
  });

  it('sends parse-error message when file contains invalid JSON', async () => {
    writeFileSync(LAST_WORKOUT_PATH, '{not valid json');

    const bot = mockBot();
    await handleDoneWorkout(bot, CHAT_ID);

    expect(bot.sendMessage).toHaveBeenCalledOnce();
    const msg = (bot.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as string;
    expect(msg).toContain('Could not parse');
  });

  it('does not call appendToJournal when file is corrupt', async () => {
    writeFileSync(LAST_WORKOUT_PATH, '{not valid json');

    const bot = mockBot();
    await handleDoneWorkout(bot, CHAT_ID);

    expect(mockAppendToJournal).not.toHaveBeenCalled();
  });
});

// ─── 2b. Shape validation (corrupt-status) paths ─────────────────────────────

describe('handleDoneWorkout — shape validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetDoneWorkoutState();
    deleteLastWorkout();
  });

  it('treats file with missing markdown field as corrupt', async () => {
    writeFileSync(LAST_WORKOUT_PATH, JSON.stringify({
      generated_at: new Date().toISOString(),
      location: 'gym',
      focus: 'strength',
      // markdown is absent
      structured: {},
    }));

    const bot = mockBot();
    await handleDoneWorkout(bot, CHAT_ID);

    expect(bot.sendMessage).toHaveBeenCalledOnce();
    const msg = (bot.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as string;
    expect(msg).toContain('Could not parse');
    expect(mockAppendToJournal).not.toHaveBeenCalled();
  });

  it('treats file with invalid generated_at date as corrupt', async () => {
    writeFileSync(LAST_WORKOUT_PATH, JSON.stringify({
      generated_at: 'not-a-date',
      location: 'gym',
      focus: 'strength',
      markdown: '# Workout',
      structured: {},
    }));

    const bot = mockBot();
    await handleDoneWorkout(bot, CHAT_ID);

    expect(bot.sendMessage).toHaveBeenCalledOnce();
    const msg = (bot.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as string;
    expect(msg).toContain('Could not parse');
    expect(mockAppendToJournal).not.toHaveBeenCalled();
  });

  it('accepts file with location=null and focus=null (valid shape)', async () => {
    writeLastWorkout({ location: null, focus: null });
    mockAppendToJournal.mockReturnValue(undefined);

    const bot = mockBot();
    await handleDoneWorkout(bot, CHAT_ID);

    expect(mockAppendToJournal).toHaveBeenCalledOnce();
  });
});

// ─── 3. Stale warning + confirm flow ─────────────────────────────────────────

describe('handleDoneWorkout — stale warning + confirm flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetDoneWorkoutState();
    deleteLastWorkout();
  });

  it('sends stale warning on first call when workout is 60 hours old', async () => {
    const sixtyHoursAgo = new Date(Date.now() - 60 * 60 * 60 * 1000).toISOString();
    writeLastWorkout({ generated_at: sixtyHoursAgo });

    const bot = mockBot();
    await handleDoneWorkout(bot, CHAT_ID);

    expect(bot.sendMessage).toHaveBeenCalledOnce();
    const msg = (bot.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as string;
    expect(msg).toMatch(/\d+ hours ago/);
    expect(msg).toContain('/done-workout');
  });

  it('does not append to journal on stale first call', async () => {
    const sixtyHoursAgo = new Date(Date.now() - 60 * 60 * 60 * 1000).toISOString();
    writeLastWorkout({ generated_at: sixtyHoursAgo });

    const bot = mockBot();
    await handleDoneWorkout(bot, CHAT_ID);

    expect(mockAppendToJournal).not.toHaveBeenCalled();
  });

  it('appends on second call within 10 minutes after stale warning', async () => {
    const sixtyHoursAgo = new Date(Date.now() - 60 * 60 * 60 * 1000).toISOString();
    writeLastWorkout({ generated_at: sixtyHoursAgo });
    mockAppendToJournal.mockReturnValue(undefined);

    const bot = mockBot();

    // First call — stale warning
    await handleDoneWorkout(bot, CHAT_ID);
    expect(mockAppendToJournal).not.toHaveBeenCalled();

    // Second call within 10 minutes — confirm
    vi.clearAllMocks();
    await handleDoneWorkout(bot, CHAT_ID);

    expect(mockAppendToJournal).toHaveBeenCalledOnce();
    expect(bot.sendMessage).toHaveBeenCalledOnce();
    const msg = (bot.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as string;
    expect(msg).toContain('Logged');
  });

  it('deletes LAST_WORKOUT_FILE after confirmed stale append', async () => {
    const sixtyHoursAgo = new Date(Date.now() - 60 * 60 * 60 * 1000).toISOString();
    writeLastWorkout({ generated_at: sixtyHoursAgo });
    mockAppendToJournal.mockReturnValue(undefined);

    const bot = mockBot();

    // First call — warn
    await handleDoneWorkout(bot, CHAT_ID);
    // Second call — confirm
    await handleDoneWorkout(bot, CHAT_ID);

    expect(existsSync(LAST_WORKOUT_PATH)).toBe(false);
  });

  it('third call after confirmed delete replies "Nothing to log"', async () => {
    const sixtyHoursAgo = new Date(Date.now() - 60 * 60 * 60 * 1000).toISOString();
    writeLastWorkout({ generated_at: sixtyHoursAgo });
    mockAppendToJournal.mockReturnValue(undefined);

    const bot = mockBot();

    // First — warn; Second — confirm + delete
    await handleDoneWorkout(bot, CHAT_ID);
    await handleDoneWorkout(bot, CHAT_ID);

    // Third — file is gone
    vi.clearAllMocks();
    _resetDoneWorkoutState();
    await handleDoneWorkout(bot, CHAT_ID);

    const msg = (bot.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as string;
    expect(msg).toContain('Nothing to log');
  });
});

// ─── 4. Stale warning window expires ─────────────────────────────────────────

describe('handleDoneWorkout — stale warning window expiry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetDoneWorkoutState();
    deleteLastWorkout();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('issues a second stale warning after 11-minute gap (window expired)', async () => {
    const sixtyHoursAgo = new Date(Date.now() - 60 * 60 * 60 * 1000).toISOString();
    writeLastWorkout({ generated_at: sixtyHoursAgo });

    const bot = mockBot();

    // First call — stale warning
    await handleDoneWorkout(bot, CHAT_ID);
    expect(mockAppendToJournal).not.toHaveBeenCalled();

    // Advance time by 11 minutes (beyond the 10-min confirm window)
    vi.advanceTimersByTime(11 * 60 * 1000);

    // Second call — window has expired, should warn again (not append)
    vi.clearAllMocks();
    await handleDoneWorkout(bot, CHAT_ID);

    expect(mockAppendToJournal).not.toHaveBeenCalled();
    const msg = (bot.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as string;
    expect(msg).toMatch(/\d+ hours ago/);
  });
});

// ─── 5. Journal block format ──────────────────────────────────────────────────

describe('handleDoneWorkout — journal block format', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetDoneWorkoutState();
    deleteLastWorkout();
  });

  it('passes a block starting with #workout to appendToJournal', async () => {
    writeLastWorkout({ location: 'gym', focus: 'strength', markdown: '## Warmup\n\nJog 5 min' });
    mockAppendToJournal.mockReturnValue(undefined);

    const bot = mockBot();
    await handleDoneWorkout(bot, CHAT_ID);

    expect(mockAppendToJournal).toHaveBeenCalledOnce();
    const block = (mockAppendToJournal as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
    expect(block).toMatch(/^#workout/);
  });

  it('block includes **Generated workout** header', async () => {
    writeLastWorkout({ location: 'gym', focus: 'strength', markdown: '## Main\n\nSquats 5x5' });
    mockAppendToJournal.mockReturnValue(undefined);

    const bot = mockBot();
    await handleDoneWorkout(bot, CHAT_ID);

    const block = (mockAppendToJournal as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
    expect(block).toContain('**Generated workout** (');
  });

  it('block includes location in parenthetical tag', async () => {
    writeLastWorkout({ location: 'home', focus: 'mobility', markdown: '## Warmup\n\nStretch' });
    mockAppendToJournal.mockReturnValue(undefined);

    const bot = mockBot();
    await handleDoneWorkout(bot, CHAT_ID);

    const block = (mockAppendToJournal as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
    expect(block).toContain('home');
  });

  it('block includes focus in parenthetical tag', async () => {
    writeLastWorkout({ location: 'home', focus: 'mobility', markdown: '## Warmup\n\nStretch' });
    mockAppendToJournal.mockReturnValue(undefined);

    const bot = mockBot();
    await handleDoneWorkout(bot, CHAT_ID);

    const block = (mockAppendToJournal as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
    expect(block).toContain('mobility');
  });

  it('block includes the markdown body from last-workout.json', async () => {
    const markdown = '## Main\n\nDeadlifts 3x5\nBench 3x8';
    writeLastWorkout({ location: 'gym', focus: 'strength', markdown });
    mockAppendToJournal.mockReturnValue(undefined);

    const bot = mockBot();
    await handleDoneWorkout(bot, CHAT_ID);

    const block = (mockAppendToJournal as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
    expect(block).toContain(markdown);
  });

  it('block uses "session" fallback when location and focus are both null', async () => {
    writeLastWorkout({ location: null, focus: null, markdown: '## Warmup\n\nWalk 5 min' });
    mockAppendToJournal.mockReturnValue(undefined);

    const bot = mockBot();
    await handleDoneWorkout(bot, CHAT_ID);

    const block = (mockAppendToJournal as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
    expect(block).toContain('session');
  });

  it('block has correct shape matching json-updater expectations', async () => {
    const markdown = '## Main\n\nSquats 5x5';
    writeLastWorkout({ location: 'gym', focus: 'strength', markdown });
    mockAppendToJournal.mockReturnValue(undefined);

    const bot = mockBot();
    await handleDoneWorkout(bot, CHAT_ID);

    const block = (mockAppendToJournal as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
    // Leading #workout tag — required for json-updater to identify the block
    expect(block).toMatch(/^#workout\n\n/);
    // Bold header with location/focus
    expect(block).toMatch(/\*\*Generated workout\*\* \([^)]+\) — /);
    // Markdown body appears after the header
    const headerMatch = block.match(/\*\*Generated workout\*\* \([^)]+\) — [^\n]+\n\n([\s\S]+)/);
    expect(headerMatch).toBeTruthy();
    expect(headerMatch![1]).toContain('Squats 5x5');
  });
});

// ─── 6. File cleared on success ───────────────────────────────────────────────

describe('handleDoneWorkout — file cleared on success', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetDoneWorkoutState();
    deleteLastWorkout();
  });

  it('deletes LAST_WORKOUT_FILE after successful append', async () => {
    writeLastWorkout();
    mockAppendToJournal.mockReturnValue(undefined);

    const bot = mockBot();
    await handleDoneWorkout(bot, CHAT_ID);

    expect(existsSync(LAST_WORKOUT_PATH)).toBe(false);
  });

  it('sends success message after successful append', async () => {
    writeLastWorkout();
    mockAppendToJournal.mockReturnValue(undefined);

    const bot = mockBot();
    await handleDoneWorkout(bot, CHAT_ID);

    expect(bot.sendMessage).toHaveBeenCalledOnce();
    const msg = (bot.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as string;
    expect(msg).toContain('Logged');
    expect(msg).toContain('workouts.json');
  });
});

// ─── 7. File preserved on append failure ─────────────────────────────────────

describe('handleDoneWorkout — file preserved on append failure', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetDoneWorkoutState();
    deleteLastWorkout();
  });

  it('preserves LAST_WORKOUT_FILE when appendToJournal throws', async () => {
    writeLastWorkout();
    mockAppendToJournal.mockImplementation(() => {
      throw new Error('filesystem full');
    });

    const bot = mockBot();
    await handleDoneWorkout(bot, CHAT_ID);

    expect(existsSync(LAST_WORKOUT_PATH)).toBe(true);
  });

  it('sends error message when appendToJournal throws', async () => {
    writeLastWorkout();
    mockAppendToJournal.mockImplementation(() => {
      throw new Error('filesystem full');
    });

    const bot = mockBot();
    await handleDoneWorkout(bot, CHAT_ID);

    expect(bot.sendMessage).toHaveBeenCalledOnce();
    const msg = (bot.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as string;
    expect(msg).toContain('Could not append');
  });

  it('does not delete LAST_WORKOUT_FILE on append failure', async () => {
    writeLastWorkout();
    mockAppendToJournal.mockImplementation(() => {
      throw new Error('write error');
    });

    const bot = mockBot();
    await handleDoneWorkout(bot, CHAT_ID);

    // File should still be there for retry
    expect(existsSync(LAST_WORKOUT_PATH)).toBe(true);
  });
});
