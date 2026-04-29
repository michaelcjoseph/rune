import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdirSync, writeFileSync, existsSync, readFileSync, unlinkSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Create temp dirs before any mocks — vi.hoisted must be synchronous.
const { vaultTmpDir, logsTmpDir } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdirSync: mkd } = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir: td } = require('node:os') as typeof import('node:os');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join: jn } = require('node:path') as typeof import('node:path');
  const vaultTmpDir = jn(td(), `jarvis-workout-vault-${Date.now()}`);
  const logsTmpDir = jn(td(), `jarvis-workout-logs-${Date.now()}`);
  mkd(vaultTmpDir, { recursive: true });
  mkd(logsTmpDir, { recursive: true });
  return { vaultTmpDir, logsTmpDir };
});

vi.mock('../../config.js', () => ({
  default: {
    VAULT_DIR: vaultTmpDir,
    LOGS_DIR: logsTmpDir,
    LAST_WORKOUT_FILE: join(logsTmpDir, 'last-workout.json'),
    TG_MAX_MESSAGE_LENGTH: 4000,
  },
}));

const mockRunAgent = vi.fn();

vi.mock('../../ai/claude.js', () => ({
  runAgent: mockRunAgent,
}));

const mockSendLongMessage = vi.fn();

vi.mock('../../integrations/telegram/client.js', () => ({
  sendLongMessage: mockSendLongMessage,
  startTyping: vi.fn(() => setInterval(() => {}, 99999)),
  stopTyping: vi.fn((i: NodeJS.Timeout) => clearInterval(i)),
}));

vi.mock('../../utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  }),
}));

const mockEnsureWhoopSyncedForToday = vi.fn().mockResolvedValue(undefined);

vi.mock('../../jobs/whoop-sync.js', () => ({
  ensureWhoopSyncedForToday: mockEnsureWhoopSyncedForToday,
}));

const {
  parseWorkoutArgs,
  buildWorkoutPrompt,
  extractStructured,
  generateWorkout,
  handleWorkout,
} = await import('./workout.js');

// ─── helpers ──────────────────────────────────────────────────────────────────

function writeVaultFile(relPath: string, content: string): void {
  const full = join(vaultTmpDir, relPath);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content);
}

/** Delete a vault file if it exists. */
function deleteVaultFile(relPath: string): void {
  const full = join(vaultTmpDir, relPath);
  try { unlinkSync(full); } catch { /* absent — ok */ }
}

function deleteLogsFile(name: string): void {
  try { unlinkSync(join(logsTmpDir, name)); } catch { /* absent — ok */ }
}

const CHAT_ID = 42;

function mockBot() {
  return {
    sendMessage: vi.fn().mockResolvedValue(undefined),
    sendChatAction: vi.fn().mockResolvedValue(undefined),
  } as any;
}

// ─── 1. parseWorkoutArgs — both token orders ──────────────────────────────────

describe('parseWorkoutArgs — vocabulary recognition', () => {
  it('home strength (location first) yields {location: home, focus: strength}', () => {
    expect(parseWorkoutArgs('home strength')).toEqual({ location: 'home', focus: 'strength', extra: '' });
  });

  it('strength home (focus first) yields same result', () => {
    expect(parseWorkoutArgs('strength home')).toEqual({ location: 'home', focus: 'strength', extra: '' });
  });

  it('gym mobility yields {location: gym, focus: mobility}', () => {
    expect(parseWorkoutArgs('gym mobility')).toEqual({ location: 'gym', focus: 'mobility', extra: '' });
  });
});

// ─── 2. parseWorkoutArgs — invalid / unrecognized tokens ─────────────────────

describe('parseWorkoutArgs — invalid args', () => {
  it('/workout cardio (1 unknown token) → null', () => {
    expect(parseWorkoutArgs('cardio')).toBeNull();
  });

  it('/workout xyz pdq (2 unknown tokens) → null', () => {
    expect(parseWorkoutArgs('xyz pdq')).toBeNull();
  });

  it('3 unknown tokens is NOT null (only 1–2 are bounced)', () => {
    // 3 unrecognized tokens → valid: location=null, focus=null, extra='a b c'
    expect(parseWorkoutArgs('a b c')).not.toBeNull();
  });
});

// ─── 3. parseWorkoutArgs — natural-language tail ─────────────────────────────

describe('parseWorkoutArgs — natural-language tail', () => {
  it('home 30min quick hit → {location: home, focus: null, extra: "30min quick hit"}', () => {
    expect(parseWorkoutArgs('home 30min quick hit')).toEqual({
      location: 'home',
      focus: null,
      extra: '30min quick hit',
    });
  });

  it('gym strength upper body → {location: gym, focus: strength, extra: "upper body"}', () => {
    expect(parseWorkoutArgs('gym strength upper body')).toEqual({
      location: 'gym',
      focus: 'strength',
      extra: 'upper body',
    });
  });
});

// ─── 4. parseWorkoutArgs — empty args ────────────────────────────────────────

describe('parseWorkoutArgs — empty args', () => {
  it('empty string → {location: null, focus: null, extra: ""}', () => {
    expect(parseWorkoutArgs('')).toEqual({ location: null, focus: null, extra: '' });
  });

  it('whitespace-only string → same as empty', () => {
    expect(parseWorkoutArgs('   ')).toEqual({ location: null, focus: null, extra: '' });
  });
});

// ─── 5. parseWorkoutArgs — last-write-wins ───────────────────────────────────

describe('parseWorkoutArgs — last-write-wins', () => {
  it('home gym strength → last location token wins (gym)', () => {
    expect(parseWorkoutArgs('home gym strength')).toEqual({
      location: 'gym',
      focus: 'strength',
      extra: '',
    });
  });

  it('strength endurance gym → last focus token wins (endurance)', () => {
    expect(parseWorkoutArgs('strength endurance gym')).toEqual({
      location: 'gym',
      focus: 'endurance',
      extra: '',
    });
  });
});

// ─── 6. buildWorkoutPrompt — section headings present ────────────────────────

describe('buildWorkoutPrompt — section headings', () => {
  beforeEach(() => {
    writeVaultFile('health/goals.md', 'Run a 5k');
    writeVaultFile('health/equipment.md', '## Home\n\nKettlebell\n\n## Gym\n\nBarbell\n');
    writeVaultFile('health/exercises.md', 'Squat, Deadlift');
    writeVaultFile('health/workouts.json', '[]');
    writeVaultFile('health/whoop/trends.md', 'HRV stable');
    writeVaultFile('health/plan.md', 'Focus on compound lifts');
  });

  it('output contains all required section labels', () => {
    const out = buildWorkoutPrompt({ location: 'gym', focus: 'strength', extra: '' });
    expect(out).toMatch(/^Args:/m);
    expect(out).toMatch(/^## goals/m);
    expect(out).toMatch(/^## equipment/m);
    expect(out).toMatch(/^## exercises/m);
    expect(out).toMatch(/^## recent_workouts/m);
    expect(out).toMatch(/^## recent_whoop/m);
    expect(out).toMatch(/^## whoop_trends/m);
    expect(out).toMatch(/^## plan/m);
  });

  it('Args line encodes location and focus', () => {
    const out = buildWorkoutPrompt({ location: 'home', focus: 'mobility', extra: '' });
    expect(out).toMatch(/^Args: home mobility/m);
  });

  it('Args line shows (none) when all args are empty', () => {
    const out = buildWorkoutPrompt({ location: null, focus: null, extra: '' });
    expect(out).toMatch(/^Args: \(none/m);
  });
});

// ─── 7. buildWorkoutPrompt — missing-data fallbacks ──────────────────────────

describe('buildWorkoutPrompt — missing-data fallbacks', () => {
  beforeEach(() => {
    // Remove all vault files the prompt reads so every section hits its fallback.
    deleteVaultFile('health/goals.md');
    deleteVaultFile('health/equipment.md');
    deleteVaultFile('health/exercises.md');
    deleteVaultFile('health/workouts.json');
    deleteVaultFile('health/whoop/trends.md');
    deleteVaultFile('health/plan.md');
    // Clear any whoop daily json files
    const whoopDir = join(vaultTmpDir, 'health/whoop');
    if (existsSync(whoopDir)) {
      for (const f of readdirSync(whoopDir)) {
        if ((f as string).endsWith('.json')) {
          deleteVaultFile(`health/whoop/${f as string}`);
        }
      }
    }
  });

  it('all sections still present when all source files are missing', () => {
    const out = buildWorkoutPrompt({ location: null, focus: null, extra: '' });
    expect(out).toMatch(/^## goals/m);
    expect(out).toMatch(/^## equipment/m);
    expect(out).toMatch(/^## exercises/m);
    expect(out).toMatch(/^## recent_workouts/m);
    expect(out).toMatch(/^## recent_whoop/m);
    expect(out).toMatch(/^## whoop_trends/m);
    expect(out).toMatch(/^## plan/m);
  });

  it('goals section shows [empty] placeholder when goals.md is missing', () => {
    const out = buildWorkoutPrompt({ location: null, focus: null, extra: '' });
    expect(out).toContain('[empty]');
  });

  it('equipment section shows bodyweight-only fallback when equipment.md is missing', () => {
    const out = buildWorkoutPrompt({ location: null, focus: null, extra: '' });
    expect(out).toContain('bodyweight');
  });

  it('recent_workouts shows [] when workouts.json is missing', () => {
    const out = buildWorkoutPrompt({ location: null, focus: null, extra: '' });
    // The section should be present and the content should be the empty array literal
    expect(out).toMatch(/## recent_workouts[\s\S]*?\[\]/m);
  });

  it('recent_whoop shows fallback note when whoop dir is empty', () => {
    const out = buildWorkoutPrompt({ location: null, focus: null, extra: '' });
    expect(out).toContain('no recent Whoop data');
  });
});

// ─── 8. buildWorkoutPrompt — recent workouts filtering ───────────────────────

describe('buildWorkoutPrompt — recent workouts date filtering', () => {
  it('filters out workouts older than 14 days, keeps recent ones', () => {
    const recentDate = new Date();
    recentDate.setDate(recentDate.getDate() - 3);
    const recentStr = recentDate.toISOString().slice(0, 10);

    const staleDate = new Date();
    staleDate.setDate(staleDate.getDate() - 30);
    const staleStr = staleDate.toISOString().slice(0, 10);

    writeVaultFile(
      'health/workouts.json',
      JSON.stringify([
        { date: recentStr, exercise: 'Squats' },
        { date: staleStr, exercise: 'Old run' },
      ]),
    );

    const out = buildWorkoutPrompt({ location: null, focus: null, extra: '' });
    expect(out).toContain(recentStr);
    expect(out).not.toContain(staleStr);
  });

  it('includes no workouts when all entries are older than 14 days', () => {
    const staleDate = new Date();
    staleDate.setDate(staleDate.getDate() - 30);
    const staleStr = staleDate.toISOString().slice(0, 10);

    writeVaultFile(
      'health/workouts.json',
      JSON.stringify([{ date: staleStr, exercise: 'Old run' }]),
    );

    const out = buildWorkoutPrompt({ location: null, focus: null, extra: '' });
    expect(out).not.toContain(staleStr);
    // Section present but entries filtered to empty array
    expect(out).toMatch(/## recent_workouts[\s\S]*?\[\]/m);
  });
});

// ─── 9. extractStructured — happy path ───────────────────────────────────────

describe('extractStructured — happy path', () => {
  it('parses a trailing fenced json block', () => {
    const md = 'Some prose\n\n```json\n{"exercises": ["squat"], "sets": 3}\n```';
    expect(extractStructured(md)).toEqual({ exercises: ['squat'], sets: 3 });
  });

  it('returns parsed object from json block mid-document', () => {
    const md = '# Header\n\n```json\n{"key": "value"}\n```\n\nMore text';
    expect(extractStructured(md)).toEqual({ key: 'value' });
  });
});

// ─── 10. extractStructured — malformed / missing ─────────────────────────────

describe('extractStructured — malformed / missing cases', () => {
  it('no fenced block → {}', () => {
    expect(extractStructured('plain text with no code block')).toEqual({});
  });

  it('fenced block with invalid JSON → {}', () => {
    const md = '```json\n{not valid json}\n```';
    expect(extractStructured(md)).toEqual({});
  });

  it('fenced block that parses to an array → {}', () => {
    const md = '```json\n[1, 2, 3]\n```';
    expect(extractStructured(md)).toEqual({});
  });

  it('fenced block that parses to a number → {}', () => {
    const md = '```json\n42\n```';
    expect(extractStructured(md)).toEqual({});
  });

  it('fenced block that parses to a string → {}', () => {
    const md = '```json\n"hello"\n```';
    expect(extractStructured(md)).toEqual({});
  });

  it('fenced block that parses to null → {}', () => {
    const md = '```json\nnull\n```';
    expect(extractStructured(md)).toEqual({});
  });

  it('empty string → {}', () => {
    expect(extractStructured('')).toEqual({});
  });
});

// ─── 11. generateWorkout — last-workout.json write shape on success ───────────

describe('generateWorkout — success path', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    deleteLogsFile('last-workout.json');
  });

  it('writes last-workout.json with expected keys on success', async () => {
    const successMarkdown = [
      '# Workout\n\nDo some squats.\n\n',
      '```json\n{"exercises": ["squat"], "duration_min": 45}\n```',
    ].join('');

    mockRunAgent.mockResolvedValue({ text: successMarkdown, error: null });

    const result = await generateWorkout({ location: 'gym', focus: 'strength', extra: '' });

    expect('error' in result).toBe(false);
    expect((result as { markdown: string }).markdown).toBe(successMarkdown);

    const lastWorkoutPath = join(logsTmpDir, 'last-workout.json');
    expect(existsSync(lastWorkoutPath)).toBe(true);

    const written = JSON.parse(readFileSync(lastWorkoutPath, 'utf8'));
    expect(written).toHaveProperty('generated_at');
    expect(written).toHaveProperty('location', 'gym');
    expect(written).toHaveProperty('focus', 'strength');
    expect(written).toHaveProperty('markdown', successMarkdown);
    expect(written).toHaveProperty('structured');
    expect(written.structured).toEqual({ exercises: ['squat'], duration_min: 45 });
  });

  it('structured is {} when agent output has no json block', async () => {
    mockRunAgent.mockResolvedValue({ text: 'Just prose, no json block.', error: null });

    await generateWorkout({ location: 'home', focus: null, extra: '' });

    const lastWorkoutPath = join(logsTmpDir, 'last-workout.json');
    const written = JSON.parse(readFileSync(lastWorkoutPath, 'utf8'));
    expect(written.structured).toEqual({});
  });
});

// ─── 12. generateWorkout — agent error: no file written ──────────────────────

describe('generateWorkout — agent error / timeout', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    deleteLogsFile('last-workout.json');
  });

  it('returns {error} when runAgent returns no text', async () => {
    mockRunAgent.mockResolvedValue({ text: null, error: 'timeout' });

    const result = await generateWorkout({ location: null, focus: null, extra: '' });

    expect(result).toEqual({ error: 'timeout' });
  });

  it('does NOT write last-workout.json on agent failure', async () => {
    mockRunAgent.mockResolvedValue({ text: null, error: 'timeout' });

    await generateWorkout({ location: null, focus: null, extra: '' });

    expect(existsSync(join(logsTmpDir, 'last-workout.json'))).toBe(false);
  });

  it('uses generic message when error field is null but text is also null', async () => {
    mockRunAgent.mockResolvedValue({ text: null, error: null });

    const result = await generateWorkout({ location: null, focus: null, extra: '' });

    expect('error' in result).toBe(true);
    expect((result as { error: string }).error).toBeTruthy();
  });

  it('returns {error} when the atomic write fails (logs dir missing)', async () => {
    mockRunAgent.mockResolvedValue({
      text: '## Warmup\n- Walk\n## Main\n- Squat\n## Cooldown\n- Stretch\n',
      error: null,
    });
    // Remove logsTmpDir so the atomic write throws ENOENT.
    rmSync(logsTmpDir, { recursive: true, force: true });

    const result = await generateWorkout({ location: 'home', focus: 'strength', extra: '' });

    expect('error' in result).toBe(true);
    expect((result as { error: string }).error).toMatch(/persist/);

    // Re-create for subsequent tests.
    mkdirSync(logsTmpDir, { recursive: true });
  });
});

// ─── 13. handleWorkout — invalid args path ────────────────────────────────────

describe('handleWorkout — invalid args', () => {
  beforeEach(() => vi.clearAllMocks());

  it('sends usage message for unrecognized single token (/workout cardio)', async () => {
    const bot = mockBot();
    await handleWorkout(bot, CHAT_ID, 'cardio');

    expect(bot.sendMessage).toHaveBeenCalledOnce();
    const msg = (bot.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as string;
    expect(msg).toContain("didn't recognize");
    expect(mockRunAgent).not.toHaveBeenCalled();
  });

  it('sends usage message for two unrecognized tokens (/workout xyz pdq)', async () => {
    const bot = mockBot();
    await handleWorkout(bot, CHAT_ID, 'xyz pdq');

    expect(bot.sendMessage).toHaveBeenCalledOnce();
    expect(mockRunAgent).not.toHaveBeenCalled();
  });

  it('usage message includes location and focus options', async () => {
    const bot = mockBot();
    await handleWorkout(bot, CHAT_ID, 'badarg');

    const msg = (bot.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as string;
    expect(msg).toContain('home');
    expect(msg).toContain('gym');
    expect(msg).toContain('strength');
  });
});

// ─── 14. handleWorkout — happy path ──────────────────────────────────────────

describe('handleWorkout — happy path', () => {
  beforeEach(() => vi.clearAllMocks());

  it('calls sendLongMessage with agent markdown on success', async () => {
    const markdown = "# Today's Workout\n\nSquats 5x5\n\n```json\n{\"sets\": 5}\n```";
    mockRunAgent.mockResolvedValue({ text: markdown, error: null });
    mockSendLongMessage.mockResolvedValue(undefined);

    const bot = mockBot();
    await handleWorkout(bot, CHAT_ID, 'gym strength');

    expect(mockRunAgent).toHaveBeenCalledOnce();
    expect(mockSendLongMessage).toHaveBeenCalledWith(bot, CHAT_ID, markdown);
    expect(bot.sendMessage).not.toHaveBeenCalled();
  });

  it('sends error message when agent returns error', async () => {
    mockRunAgent.mockResolvedValue({ text: null, error: 'Claude timed out' });

    const bot = mockBot();
    await handleWorkout(bot, CHAT_ID, 'home');

    expect(bot.sendMessage).toHaveBeenCalledOnce();
    const msg = (bot.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as string;
    expect(msg).toContain('Workout generation failed');
    expect(mockSendLongMessage).not.toHaveBeenCalled();
  });

  it('works with empty args (no location/focus)', async () => {
    const markdown = '# Workout\n\nGeneral session.';
    mockRunAgent.mockResolvedValue({ text: markdown, error: null });
    mockSendLongMessage.mockResolvedValue(undefined);

    const bot = mockBot();
    await handleWorkout(bot, CHAT_ID, '');

    expect(mockRunAgent).toHaveBeenCalledOnce();
    expect(mockSendLongMessage).toHaveBeenCalledWith(bot, CHAT_ID, markdown);
  });

  it('sends error message when runAgent throws', async () => {
    mockRunAgent.mockRejectedValue(new Error('unexpected crash'));

    const bot = mockBot();
    await handleWorkout(bot, CHAT_ID, 'gym');

    expect(bot.sendMessage).toHaveBeenCalledOnce();
    const msg = (bot.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as string;
    expect(msg).toContain('Workout generation failed');
  });

  it('calls ensureWhoopSyncedForToday before runAgent when handleWorkout runs', async () => {
    const callOrder: string[] = [];
    mockEnsureWhoopSyncedForToday.mockImplementation(async () => { callOrder.push('ensureWhoop'); });
    mockRunAgent.mockImplementation(async () => { callOrder.push('runAgent'); return { text: '# Workout', error: null }; });
    mockSendLongMessage.mockResolvedValue(undefined);

    const bot = mockBot();
    await handleWorkout(bot, CHAT_ID, 'gym strength');

    expect(mockEnsureWhoopSyncedForToday).toHaveBeenCalledOnce();
    expect(mockRunAgent).toHaveBeenCalledOnce();
    expect(callOrder).toEqual(['ensureWhoop', 'runAgent']);
  });
});
