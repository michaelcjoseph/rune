import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdirSync, writeFileSync, existsSync, unlinkSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpLogs = join(tmpdir(), `rune-intent-scan-test-${Date.now()}`);
mkdirSync(tmpLogs, { recursive: true });
const PROPOSAL_QUEUE_FILE = join(tmpLogs, 'proposal-queue.json');
const INTENT_LOG_FILE = join(tmpLogs, 'intent-log.jsonl');

vi.mock('../config.js', () => ({
  default: {
    VAULT_DIR: '/test/vault',
    LOGS_DIR: tmpLogs,
    PROPOSAL_QUEUE_FILE,
    TIMEZONE: 'America/Chicago',
    TELEGRAM_USER_ID: 42,
    CLAUDE_TIMEOUT_MS: 300_000,
    CLASSIFIER_MODEL: 'haiku',
    CLASSIFIER_TIMEOUT_MS: 20_000,
  },
  PROJECT_ROOT: '/test/project',
}));

vi.mock('../ai/claude.js', () => ({
  askHaikuOneShot: vi.fn(),
}));

vi.mock('../bot/skill-registry.js', () => ({
  getSkillRegistry: vi.fn(() => [
    { name: 'journal', kind: 'slash', description: 'Add to journal.' },
    { name: 'weekly', kind: 'slash', description: 'Weekly review.' },
    { name: 'workout', kind: 'slash', description: 'Generate a workout.' },
  ]),
}));

vi.mock('../utils/intent-log.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/intent-log.js')>();
  return {
    ...actual,
    intentLogPath: vi.fn(() => INTENT_LOG_FILE),
  };
});

vi.mock('../utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const {
  readIntentLog,
  filterRecent,
  buildScanPrompt,
  parseScanResponse,
  dedupeAgainstRegistry,
  dedupeAgainstPending,
  runIntentScan,
  MAX_PROPOSALS_PER_SCAN,
  MIN_ENTRIES_FOR_SCAN,
  INTENT_SCAN_WINDOW_DAYS,
} = await import('./intent-scan.js');
const { askHaikuOneShot } = await import('../ai/claude.js');

function writeSampleLog(entries: object[]): void {
  writeFileSync(INTENT_LOG_FILE, entries.map(e => JSON.stringify(e)).join('\n') + '\n');
}

function wipeLogs(): void {
  if (existsSync(INTENT_LOG_FILE)) unlinkSync(INTENT_LOG_FILE);
  if (existsSync(PROPOSAL_QUEUE_FILE)) unlinkSync(PROPOSAL_QUEUE_FILE);
}

describe('readIntentLog', () => {
  beforeEach(wipeLogs);

  it('returns [] when the file does not exist', () => {
    expect(readIntentLog()).toEqual([]);
  });

  it('parses one JSON line per entry', () => {
    writeSampleLog([
      { ts: '2025-04-01T10:00:00.000Z', intent: 'hi', args: '', confidence: 0.1, outcome: 'low_confidence', skill_invoked: null },
      { ts: '2025-04-02T10:00:00.000Z', intent: 'bye', args: '', confidence: 0.9, outcome: 'routed', skill_invoked: 'weekly' },
    ]);
    const entries = readIntentLog();
    expect(entries).toHaveLength(2);
    expect(entries[0]!.intent).toBe('hi');
  });

  it('skips malformed lines without crashing', () => {
    writeFileSync(
      INTENT_LOG_FILE,
      '{"ts":"2025-04-01T00:00:00.000Z","intent":"valid","args":"","confidence":0.5,"outcome":"routed","skill_invoked":null}\n' +
        'not json\n' +
        '{"partial":true}\n',
    );
    const entries = readIntentLog();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.intent).toBe('valid');
  });
});

describe('filterRecent', () => {
  const now = new Date('2026-04-22T12:00:00.000Z');

  it('keeps entries within the window', () => {
    const entries = [
      { ts: '2026-04-20T00:00:00.000Z', intent: 'recent', args: '', confidence: 0.9, outcome: 'routed' as const, skill_invoked: null },
      // 28 days before `now` — just inside the 30-day window.
      { ts: '2026-03-25T12:00:00.000Z', intent: 'also-recent', args: '', confidence: 0.8, outcome: 'routed' as const, skill_invoked: null },
    ];
    expect(filterRecent(entries, INTENT_SCAN_WINDOW_DAYS, now)).toHaveLength(2);
  });

  it('drops entries older than the window', () => {
    const entries = [
      { ts: '2025-12-01T00:00:00.000Z', intent: 'stale', args: '', confidence: 0.9, outcome: 'routed' as const, skill_invoked: null },
    ];
    expect(filterRecent(entries, INTENT_SCAN_WINDOW_DAYS, now)).toHaveLength(0);
  });

  it('drops entries with malformed timestamps', () => {
    const entries = [
      { ts: 'not-a-date', intent: 'bad', args: '', confidence: 0.9, outcome: 'routed' as const, skill_invoked: null },
    ];
    expect(filterRecent(entries, INTENT_SCAN_WINDOW_DAYS, now)).toHaveLength(0);
  });
});

describe('buildScanPrompt', () => {
  it('embeds every intent message', () => {
    const prompt = buildScanPrompt(
      [
        { ts: '2026-04-01T00:00:00.000Z', intent: 'first-intent', args: '', confidence: 0.3, outcome: 'low_confidence', skill_invoked: null },
        { ts: '2026-04-02T00:00:00.000Z', intent: 'second-intent', args: '', confidence: 0.4, outcome: 'low_confidence', skill_invoked: null },
      ],
      ['journal', 'weekly'],
    );
    expect(prompt).toContain('first-intent');
    expect(prompt).toContain('second-intent');
  });

  it('includes the known-skills list for dedupe hint', () => {
    const prompt = buildScanPrompt([], ['journal', 'weekly', 'workout']);
    expect(prompt).toContain('journal, weekly, workout');
  });

  it('caps proposals via the MAX_PROPOSALS_PER_SCAN constant', () => {
    const prompt = buildScanPrompt([], []);
    expect(prompt).toContain(`Propose at most ${MAX_PROPOSALS_PER_SCAN}`);
  });
});

describe('parseScanResponse', () => {
  it('parses a valid array of proposals', () => {
    const raw = JSON.stringify([
      { title: 'Weekly strain trend', rationale: 'Asked 6x', suggested_cron: '0 9 * * 1' },
      { title: 'New capability', rationale: 'Asked 4x', suggested_skill: 'Summarize my overnight HRV' },
    ]);
    const result = parseScanResponse(raw);
    expect(result).toHaveLength(2);
    expect(result[0]!.suggested_cron).toBe('0 9 * * 1');
    expect(result[1]!.suggested_skill).toBe('Summarize my overnight HRV');
  });

  it('tolerates a ```json code fence', () => {
    const raw = '```json\n' + JSON.stringify([
      { title: 't', rationale: 'r', suggested_skill: 's' },
    ]) + '\n```';
    expect(parseScanResponse(raw)).toHaveLength(1);
  });

  it('drops proposals with invalid cron expressions', () => {
    const raw = JSON.stringify([
      { title: 'Bad cron', rationale: 'r', suggested_cron: 'not a cron' },
    ]);
    expect(parseScanResponse(raw)).toHaveLength(0);
  });

  it('drops proposals with 6-field cron (seconds not supported by scheduler)', () => {
    const raw = JSON.stringify([
      { title: 'Seconds cron', rationale: 'r', suggested_cron: '0 0 12 * * *' },
    ]);
    expect(parseScanResponse(raw)).toHaveLength(0);
  });

  it('drops proposals with neither suggested_skill nor suggested_cron', () => {
    const raw = JSON.stringify([
      { title: 'Empty', rationale: 'r' },
    ]);
    expect(parseScanResponse(raw)).toHaveLength(0);
  });

  it('drops proposals with missing or empty title', () => {
    const raw = JSON.stringify([
      { rationale: 'r', suggested_skill: 's' },
      { title: '', rationale: 'r', suggested_skill: 's' },
    ]);
    expect(parseScanResponse(raw)).toHaveLength(0);
  });

  it('caps result length at MAX_PROPOSALS_PER_SCAN', () => {
    const raw = JSON.stringify(
      Array.from({ length: 10 }, (_, i) => ({
        title: `p${i}`,
        rationale: 'r',
        suggested_skill: 's',
      })),
    );
    expect(parseScanResponse(raw)).toHaveLength(MAX_PROPOSALS_PER_SCAN);
  });

  it('returns [] on malformed JSON', () => {
    expect(parseScanResponse('not json at all')).toEqual([]);
  });

  it('returns [] when output is not an array', () => {
    expect(parseScanResponse(JSON.stringify({ not: 'array' }))).toEqual([]);
  });

  it('skips null elements in the parsed array without crashing', () => {
    const raw = JSON.stringify([
      null,
      { title: 'ok', rationale: 'r', suggested_skill: 's' },
      null,
    ]);
    const result = parseScanResponse(raw);
    expect(result).toHaveLength(1);
    expect(result[0]!.title).toBe('ok');
  });

  it('skips non-object primitive elements in the parsed array', () => {
    const raw = JSON.stringify([
      42,
      'string',
      { title: 'ok', rationale: 'r', suggested_skill: 's' },
    ]);
    const result = parseScanResponse(raw);
    expect(result).toHaveLength(1);
  });
});

describe('dedupeAgainstRegistry', () => {
  it('drops proposals whose title or skill overlaps a known skill name', () => {
    const items = [
      { title: 'Daily journal summary', rationale: 'r', suggested_skill: 'journal again' },
      { title: 'Sleep debt tracker', rationale: 'r', suggested_skill: 'Track sleep debt' },
    ];
    const result = dedupeAgainstRegistry(items, ['journal', 'weekly']);
    expect(result).toHaveLength(1);
    expect(result[0]!.title).toBe('Sleep debt tracker');
  });

  it('ignores 1-char skill names to avoid false-positive substring matches', () => {
    // Single-char names would match almost any title. Two-char names like
    // `pg` and `kb` are real skills and DO participate in dedupe (see the
    // test below).
    const items = [
      { title: 'Gym routine tracker', rationale: 'r', suggested_skill: 's' },
    ];
    expect(dedupeAgainstRegistry(items, ['g'])).toHaveLength(1);
  });

  it('is case-insensitive', () => {
    const items = [
      { title: 'JOURNAL export', rationale: 'r', suggested_skill: 's' },
    ];
    expect(dedupeAgainstRegistry(items, ['journal'])).toHaveLength(0);
  });

  it('dedupes against real two-char skills like kb and pg (threshold is >= 2)', () => {
    // Two-char skill names collide correctly; threshold is >= 2 (not > 2).
    const items = [
      { title: 'PG summarizer', rationale: 'r', suggested_skill: 's' },
      { title: 'KB export', rationale: 'r', suggested_skill: 's' },
    ];
    expect(dedupeAgainstRegistry(items, ['pg', 'kb'])).toHaveLength(0);
  });
});

describe('dedupeAgainstPending', () => {
  it('drops proposals whose title matches a pending queue entry', async () => {
const items = [
      { title: 'Weekly whoop trend', rationale: 'r', suggested_skill: 's' },
      { title: 'Novel pattern', rationale: 'r', suggested_skill: 's' },
    ];
    const existing = [
      {
        draftedAt: '2026-04-15T00:00:00.000Z',
        type: 'skill_or_cron' as const,
        title: 'Weekly whoop trend',
        rationale: 'Asked 6x',
        status: 'pending' as const,
      },
    ];
    const result = dedupeAgainstPending(items, existing);
    expect(result).toHaveLength(1);
    expect(result[0]!.title).toBe('Novel pattern');
  });

  it('ignores non-pending entries in the queue', async () => {
const items = [
      { title: 'Rejected one', rationale: 'r', suggested_skill: 's' },
      { title: 'Approved one', rationale: 'r', suggested_skill: 's' },
    ];
    const existing = [
      {
        draftedAt: '2026-04-15T00:00:00.000Z',
        type: 'skill_or_cron' as const,
        title: 'Rejected one',
        rationale: 'r',
        status: 'rejected' as const,
      },
      {
        draftedAt: '2026-04-15T00:00:00.000Z',
        type: 'skill_or_cron' as const,
        title: 'Approved one',
        rationale: 'r',
        status: 'approved' as const,
      },
    ];
    // Neither is 'pending', so both proposals survive.
    expect(dedupeAgainstPending(items, existing)).toHaveLength(2);
  });

  it('is case-insensitive on title comparison', async () => {
const items = [{ title: 'WEEKLY Whoop Trend', rationale: 'r', suggested_skill: 's' }];
    const existing = [
      {
        draftedAt: '2026-04-15T00:00:00.000Z',
        type: 'skill_or_cron' as const,
        title: 'weekly whoop trend',
        rationale: 'r',
        status: 'pending' as const,
      },
    ];
    expect(dedupeAgainstPending(items, existing)).toHaveLength(0);
  });
});

describe('runIntentScan', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    wipeLogs();
  });

  it('skips when the intent log has fewer than MIN_ENTRIES_FOR_SCAN entries', async () => {
    writeSampleLog([
      { ts: '2026-04-20T00:00:00.000Z', intent: 'one', args: '', confidence: 0.9, outcome: 'routed', skill_invoked: null },
    ]);
    const result = await runIntentScan();
    expect(result.status).toBe('skipped');
    expect(result.queued).toHaveLength(0);
    expect(askHaikuOneShot).not.toHaveBeenCalled();
  });

  it('calls Haiku when the log is large enough and writes proposals to the queue', async () => {
    const nowIso = new Date().toISOString();
    writeSampleLog(
      Array.from({ length: 10 }, (_, i) => ({
        ts: nowIso,
        intent: `question ${i}`,
        args: '',
        confidence: 0.5,
        outcome: 'low_confidence' as const,
        skill_invoked: null,
      })),
    );
    vi.mocked(askHaikuOneShot).mockResolvedValue({
      text: JSON.stringify([
        { title: 'Pattern A', rationale: 'Asked 4x', suggested_skill: 'Answer pattern A' },
      ]),
      error: null,
    });

    const result = await runIntentScan();
    expect(result.status).toBe('success');
    expect(result.queued).toHaveLength(1);
    expect(result.queued[0]!.title).toBe('Pattern A');
    expect(result.queued[0]!.status).toBe('pending');
    expect(result.queued[0]!.type).toBe('skill_or_cron');

    const onDisk = JSON.parse(readFileSync(PROPOSAL_QUEUE_FILE, 'utf8'));
    expect(onDisk).toHaveLength(1);
    expect(onDisk[0].title).toBe('Pattern A');
  });

  it('dedupes Haiku output against the live skill registry', async () => {
    const nowIso = new Date().toISOString();
    writeSampleLog(
      Array.from({ length: 10 }, (_, i) => ({
        ts: nowIso,
        intent: `q ${i}`,
        args: '',
        confidence: 0.5,
        outcome: 'low_confidence' as const,
        skill_invoked: null,
      })),
    );
    vi.mocked(askHaikuOneShot).mockResolvedValue({
      // Both proposals collide with existing "journal" and "weekly" skills.
      text: JSON.stringify([
        { title: 'Journal helper', rationale: 'r', suggested_skill: 'journal again' },
        { title: 'Weekly roundup', rationale: 'r', suggested_skill: 'weekly thing' },
      ]),
      error: null,
    });

    const result = await runIntentScan();
    expect(result.status).toBe('skipped');
    expect(result.queued).toHaveLength(0);
  });

  it('returns error status when the Haiku call fails', async () => {
    const nowIso = new Date().toISOString();
    writeSampleLog(
      Array.from({ length: 10 }, (_, i) => ({
        ts: nowIso,
        intent: `q ${i}`,
        args: '',
        confidence: 0.5,
        outcome: 'low_confidence' as const,
        skill_invoked: null,
      })),
    );
    vi.mocked(askHaikuOneShot).mockResolvedValue({ text: null, error: 'timeout' });
    const result = await runIntentScan();
    expect(result.status).toBe('error');
    expect(result.detail).toContain('timeout');
  });

  it('publishes the summary to the bus when bus is provided and proposals were queued', async () => {
    const nowIso = new Date().toISOString();
    writeSampleLog(
      Array.from({ length: 10 }, (_, i) => ({
        ts: nowIso,
        intent: `q ${i}`,
        args: '',
        confidence: 0.5,
        outcome: 'low_confidence' as const,
        skill_invoked: null,
      })),
    );
    vi.mocked(askHaikuOneShot).mockResolvedValue({
      text: JSON.stringify([
        { title: 'New pattern', rationale: 'Asked 4x', suggested_cron: '0 9 * * 1' },
      ]),
      error: null,
    });

    const bus = { publish: vi.fn() } as any;
    await runIntentScan(bus);
    expect(bus.publish).toHaveBeenCalledOnce();
    const { text } = bus.publish.mock.calls[0][0] as { kind: string; userId: number; text: string };
    expect(text).toContain('New pattern');
    expect(text).toContain('Review in your next /weekly');
  });

  it('does NOT publish when bus is undefined', async () => {
    const nowIso = new Date().toISOString();
    writeSampleLog(
      Array.from({ length: 10 }, (_, i) => ({
        ts: nowIso,
        intent: `q ${i}`,
        args: '',
        confidence: 0.5,
        outcome: 'low_confidence' as const,
        skill_invoked: null,
      })),
    );
    vi.mocked(askHaikuOneShot).mockResolvedValue({
      text: JSON.stringify([
        { title: 'X', rationale: 'r', suggested_skill: 's' },
      ]),
      error: null,
    });
    const result = await runIntentScan();
    expect(result.status).toBe('success');
    expect(result.queued.length).toBeGreaterThan(0);
  });

  it('confirms MIN_ENTRIES_FOR_SCAN is the documented threshold', () => {
    expect(MIN_ENTRIES_FOR_SCAN).toBe(5);
  });
});
