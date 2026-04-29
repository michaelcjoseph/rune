import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync, existsSync, unlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpDir = join(tmpdir(), `jarvis-morning-prep-int-${Date.now()}`);
mkdirSync(tmpDir, { recursive: true });

const todayJournal = join(tmpDir, 'journals', '2026_04_09.md');

// --- Mocks (must be set before dynamic import) ---

vi.mock('../config.js', () => ({
  default: {
    VAULT_DIR: tmpDir,
    TIMEZONE: 'America/Chicago',
    CLAUDE_TIMEOUT_MS: 5000,
    ONESHOT_MODEL: 'opus',
  },
}));

vi.mock('../utils/time.js', () => ({
  getTodayFilename: () => '2026_04_09.md',
  getYesterdayFilename: () => '2026_04_08.md',
  getMostRecentFridayFilename: () => '2026_04_03.md',
  getDayOfWeek: () => 'Wednesday',
  getDateContext: () => 'Today is Wednesday, April 9, 2026 (America/Chicago). Today\'s journal file: 2026_04_09.md',
}));

const mockAskClaudeOneShot = vi.fn<(...args: unknown[]) => Promise<{ text: string | null; error: string | null }>>();
vi.mock('../ai/claude.js', () => ({
  askClaudeOneShot: (...args: unknown[]) => mockAskClaudeOneShot(...args),
}));

const mockGitCommitAndPush = vi.fn();
vi.mock('../vault/git.js', () => ({
  gitCommitAndPush: (...args: unknown[]) => mockGitCommitAndPush(...args),
}));

vi.mock('../utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// --- Dynamic import after mocks ---

const { executeMorningPrep, gatherMorningData, formatMorningPrepFallback } =
  await import('./morning-prep.js');

// --- Helpers ---

function writeVaultFixture(relativePath: string, content: string): void {
  const fullPath = join(tmpDir, relativePath);
  mkdirSync(join(fullPath, '..'), { recursive: true });
  writeFileSync(fullPath, content);
}

function seedAllVaultFiles(): void {
  writeVaultFixture(
    'journals/2026_04_08.md',
    `# 2026-04-08

Some notes from yesterday.

#priorities
- Ship feature X
- Review PRs
`
  );

  writeVaultFixture(
    'journals/2026_04_03.md',
    `# 2026-04-03

## Week in Review

**Reflection:** Solid week.

**Next Week's Goals:**
1. Ship Aura
2. Sleep 8h consistently
3. Build shelves for Sam
`
  );

  writeVaultFixture(
    'health/plan.md',
    `## Wednesday
- Bench press 3x8
- Pull-ups 3x10
- 20 min run
`
  );

  writeVaultFixture(
    'study/syllabus.md',
    `## Current Module
- Week 5: Transformer architectures
- Assignment: Implement attention mechanism
`
  );

  writeVaultFixture(
    'study/progress.json',
    JSON.stringify({ week: 5, completed: 4, remaining: 1 })
  );

  writeVaultFixture(
    'writing/topics.md',
    `## Active Topic
Personal knowledge management with LLMs
`
  );
}

// --- Setup / Teardown ---

beforeEach(() => {
  vi.clearAllMocks();

  // Default: Claude returns synthesized content
  mockAskClaudeOneShot.mockResolvedValue({
    text: '### Weekly Goals (from 2026-04-03)\n1. Ship Aura\n2. Sleep 8h consistently\n3. Build shelves for Sam\n\n### Priorities Recap\n- Ship feature X (in progress)\n- Review PRs (pending)\n\n### Study\n- Week 5: Transformer architectures\n- 1 assignment remaining\n\n### Writing Focus\n- Personal knowledge management with LLMs',
    error: null,
  });

  mockGitCommitAndPush.mockReturnValue(undefined);

  // Ensure journals dir exists
  mkdirSync(join(tmpDir, 'journals'), { recursive: true });

  // Clean today's journal
  if (existsSync(todayJournal)) unlinkSync(todayJournal);

  // Clean vault fixture dirs to start fresh each test
  for (const dir of ['health', 'study', 'writing']) {
    const fullDir = join(tmpDir, dir);
    if (existsSync(fullDir)) rmSync(fullDir, { recursive: true });
  }

  // Clean yesterday's journal
  const yesterdayJournal = join(tmpDir, 'journals', '2026_04_08.md');
  if (existsSync(yesterdayJournal)) unlinkSync(yesterdayJournal);

  // Clean Friday journal (weekly goals source)
  const fridayJournal = join(tmpDir, 'journals', '2026_04_03.md');
  if (existsSync(fridayJournal)) unlinkSync(fridayJournal);
});

// --- Tests ---

describe('morning-prep integration', () => {
  it('full pipeline success: vault files -> Claude synthesis -> journal written -> git committed', async () => {
    seedAllVaultFiles();

    const result = await executeMorningPrep();

    expect(result.status).toBe('written');
    expect(result.filepath).toBe(todayJournal);

    // Journal file was created with Morning Prep heading
    expect(existsSync(todayJournal)).toBe(true);
    const content = readFileSync(todayJournal, 'utf8');
    expect(content).toContain('## Morning Prep');
    expect(content).toContain('### Priorities Recap');
    expect(content).toContain('Ship feature X');

    // Claude was called with gathered data
    expect(mockAskClaudeOneShot).toHaveBeenCalledOnce();
    const prompt = mockAskClaudeOneShot.mock.calls[0]![0] as string;
    expect(prompt).toContain('Ship feature X');
    expect(prompt).toContain('Wednesday');
    // Weekly goals from Friday journal must be passed in and required in the template
    expect(prompt).toContain('Ship Aura');
    expect(prompt).toContain('### Weekly Goals (from 2026-04-03)');
    expect(prompt.indexOf('### Weekly Goals')).toBeLessThan(prompt.indexOf('### Priorities Recap'));

    // Synthesized journal contains the new section above Priorities Recap
    expect(content).toContain('### Weekly Goals (from 2026-04-03)');
    expect(content.indexOf('### Weekly Goals')).toBeLessThan(content.indexOf('### Priorities Recap'));

    // Git commit was called
    expect(mockGitCommitAndPush).toHaveBeenCalledWith('Morning prep');
  });

  it('missing vault data degrades gracefully: fallback strings gathered, journal still written', async () => {
    // No vault files seeded — all reads return null

    const result = await executeMorningPrep();

    expect(result.status).toBe('written');
    expect(existsSync(todayJournal)).toBe(true);
    const content = readFileSync(todayJournal, 'utf8');
    expect(content).toContain('## Morning Prep');

    // Claude was still called but with fallback data
    expect(mockAskClaudeOneShot).toHaveBeenCalledOnce();
    const prompt = mockAskClaudeOneShot.mock.calls[0]![0] as string;
    expect(prompt).toContain('No weekly goals set');
    expect(prompt).toContain('No priorities logged yesterday');
    expect(prompt).toContain('No active study assignments');
    expect(prompt).toContain('No writing topic set');

    expect(mockGitCommitAndPush).toHaveBeenCalledWith('Morning prep');
  });

  it('idempotent: second call returns skipped and does not alter journal', async () => {
    seedAllVaultFiles();

    const first = await executeMorningPrep();
    expect(first.status).toBe('written');

    const contentAfterFirst = readFileSync(todayJournal, 'utf8');

    const second = await executeMorningPrep();
    expect(second.status).toBe('skipped');
    expect(second.filepath).toBe(todayJournal);

    // Content unchanged
    const contentAfterSecond = readFileSync(todayJournal, 'utf8');
    expect(contentAfterSecond).toBe(contentAfterFirst);

    // Morning Prep heading appears exactly once
    expect(contentAfterSecond.match(/## Morning Prep/g)?.length).toBe(1);

    // Claude is called both times (synthesis happens before the idempotency check
    // in writeMorningPrep), but git commit only happens on the first (written) run
    expect(mockAskClaudeOneShot).toHaveBeenCalledTimes(2);
    expect(mockGitCommitAndPush).toHaveBeenCalledOnce();
  });

  it('Claude failure returns fallback status with synthError and writes terse journal', async () => {
    seedAllVaultFiles();

    mockAskClaudeOneShot.mockResolvedValue({ text: null, error: 'timeout' });

    const result = await executeMorningPrep();

    expect(result.status).toBe('fallback');
    if (result.status === 'fallback') {
      expect(result.synthError).toBe('timeout');
      expect(result.filepath).toBe(todayJournal);
    }
    expect(existsSync(todayJournal)).toBe(true);
    const content = readFileSync(todayJournal, 'utf8');

    // Fallback format headings present, including the new Weekly Goals section
    expect(content).toContain('### Weekly Goals (from 2026-04-03)');
    expect(content).toContain('### Priorities Recap');
    expect(content).toContain('### Study');
    expect(content).toContain('### Writing Focus');
    expect(content).not.toContain('### Workout');
    expect(content.indexOf('### Weekly Goals')).toBeLessThan(content.indexOf('### Priorities Recap'));

    // Raw data present (not synthesized)
    expect(content).toContain('Ship Aura');
    expect(content).toContain('Ship feature X');
    expect(content).toContain('Transformer architectures');
    expect(content).toContain('Personal knowledge management with LLMs');

    // Fallback must be terse — these fixtures are short, so no truncation should trigger
    expect(content.length).toBeLessThan(5000);

    expect(mockGitCommitAndPush).toHaveBeenCalledWith('Morning prep');
  });

  it('Claude failure with large source files produces a terse (truncated) fallback, not a raw dump', async () => {
    // Simulate the real-world incident: a 1000-line study/progress.json
    const largeProgress = JSON.stringify(
      Array.from({ length: 1000 }, (_, i) => ({ id: i, lesson: `Lesson ${i}`, done: false })),
      null,
      2
    );
    writeVaultFixture('journals/2026_04_08.md', '#priorities\n- X');
    writeVaultFixture('study/syllabus.md', '## Syllabus\n- Intro');
    writeVaultFixture('study/progress.json', largeProgress);
    writeVaultFixture('writing/topics.md', '- Topic A');

    mockAskClaudeOneShot.mockResolvedValue({ text: null, error: 'timeout' });

    const result = await executeMorningPrep();

    expect(result.status).toBe('fallback');
    const content = readFileSync(todayJournal, 'utf8');

    // Terse: far smaller than the 50KB incident that triggered this fix
    expect(content.length).toBeLessThan(3000);
    // The raw dump must not leak
    expect(content).not.toContain('"lesson": "Lesson 999"');
    // Source hints must be present so the user knows where to look
    expect(content).toContain('study/syllabus.md');
    expect(content).toContain('truncated');
  });

  it('gatherMorningData reads all vault sources correctly', () => {
    seedAllVaultFiles();

    const data = gatherMorningData();

    expect(data.yesterdayFile).toBe('2026_04_08.md');
    expect(data.dayOfWeek).toBe('Wednesday');
    expect(data.weeklyGoalsSource).toBe('2026_04_03.md');
    expect(data.weeklyGoals).toContain('Ship Aura');
    expect(data.weeklyGoals).toContain('Sleep 8h consistently');
    expect(data.priorities).toContain('Ship feature X');
    expect(data.priorities).toContain('Review PRs');
    expect(data.study).toContain('Transformer architectures');
    expect(data.study).toContain('"week":5');
    expect(data.writing).toContain('Personal knowledge management with LLMs');
  });

  it('gatherMorningData returns "No weekly goals set." when Friday journal lacks the section', () => {
    // Seed all vault files, but overwrite the Friday journal to remove its goals.
    seedAllVaultFiles();
    writeVaultFixture('journals/2026_04_03.md', '# 2026-04-03\n\nNo weekly review happened this week.\n');

    const data = gatherMorningData();

    expect(data.weeklyGoals).toBe('No weekly goals set.');
    expect(data.weeklyGoalsSource).toBeNull();
  });

  it('formatMorningPrepFallback produces correct structure with weekly goals at top', () => {
    const data = {
      weeklyGoals: '1. Ship Aura\n2. Sleep more',
      weeklyGoalsSource: '2026_04_03.md',
      priorities: '- Task A\n- Task B',
      study: '- Read chapter 4',
      writing: '- Blog post draft',
      yesterdayFile: '2026_04_08.md',
      dayOfWeek: 'Wednesday',
    };

    const output = formatMorningPrepFallback(data);

    expect(output).toContain('### Weekly Goals (from 2026-04-03)');
    expect(output).toContain('1. Ship Aura');
    expect(output).toContain('### Priorities Recap');
    expect(output).toContain('- Task A');
    expect(output).not.toContain('### Workout');
    expect(output).toContain('### Study');
    expect(output).toContain('- Read chapter 4');
    expect(output).toContain('### Writing Focus');
    expect(output).toContain('- Blog post draft');
    expect(output.indexOf('### Weekly Goals')).toBeLessThan(output.indexOf('### Priorities Recap'));
  });
});
