import { describe, expect, it, vi } from 'vitest';

interface McpTextResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

interface IndexedLine {
  file: string;
  line: number;
  content: string;
}

interface JournalRangeInput {
  startDate: string;
  endDate: string;
}

interface JournalRangeDeps {
  getVaultIndexStatus: () => { ready: boolean; status: string };
  queryVaultIndex: (
    query: string,
    options?: { directory?: string; maxResults?: number },
  ) => IndexedLine[];
  searchVault: (
    query: string,
    options?: { directory?: string; maxResults?: number },
  ) => IndexedLine[];
  sanitizeError?: (message: string) => string;
}

interface JournalRangePayload {
  startDate: string;
  endDate: string;
  source: 'warm' | 'cold';
  maxRangeDays: number;
  entries: Array<{
    date: string;
    file: string;
    content: string;
  }>;
  missingDates: string[];
}

type JournalRangeFn = (
  input: JournalRangeInput,
  deps: JournalRangeDeps,
) => Promise<McpTextResult>;

async function requireJournalRangeModule(): Promise<{ journalRange: JournalRangeFn }> {
  const specifier = './journal-range' + '.js';
  try {
    const mod = (await import(/* @vite-ignore */ specifier)) as Record<string, unknown>;
    if (typeof mod.journalRange === 'function') {
      return { journalRange: mod.journalRange as JournalRangeFn };
    }
    expect.fail('src/mcp/tools/journal-range.ts must export journalRange');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    expect.fail(`src/mcp/tools/journal-range.ts implementation pending: ${message}`);
  }
}

function makeDeps(overrides: Partial<JournalRangeDeps> = {}): JournalRangeDeps {
  return {
    getVaultIndexStatus: vi.fn().mockReturnValue({ ready: true, status: 'ready' }),
    queryVaultIndex: vi.fn().mockReturnValue([]),
    searchVault: vi.fn().mockReturnValue([]),
    sanitizeError: (message) => message.replace(/\/Users\/[^/]+\/workspace\/pkms/g, '[vault]'),
    ...overrides,
  };
}

function parsePayload(result: McpTextResult): JournalRangePayload {
  expect(result.isError).toBeFalsy();
  expect(result.content).toHaveLength(1);
  expect(result.content[0]?.type).toBe('text');
  return JSON.parse(result.content[0]!.text) as JournalRangePayload;
}

describe('journalRange', () => {
  it('returns present journal days in an inclusive date range from the warm index when ready', async () => {
    const { journalRange } = await requireJournalRangeModule();
    const deps = makeDeps({
      queryVaultIndex: vi.fn().mockReturnValue([
        { file: 'journals/2026_06_10.md', line: 1, content: '# 2026-06-10' },
        { file: 'journals/2026_06_10.md', line: 3, content: 'RANGE_START_MARKER wrote the brief.' },
        { file: 'journals/2026_06_11.md', line: 2, content: 'RANGE_END_MARKER revised it.' },
        { file: 'journals/2026_06_12.md', line: 2, content: 'OUTSIDE_RANGE_MARKER later note.' },
        { file: 'knowledge/not-a-journal.md', line: 2, content: 'SHOULD_NOT_APPEAR' },
      ]),
    });

    const result = await journalRange(
      { startDate: '2026-06-10', endDate: '2026-06-11' },
      deps,
    );

    expect(deps.queryVaultIndex).toHaveBeenCalledTimes(1);
    expect(deps.queryVaultIndex).toHaveBeenCalledWith(
      '',
      expect.objectContaining({ directory: 'journals' }),
    );
    expect(deps.searchVault).not.toHaveBeenCalled();

    const payload = parsePayload(result);
    expect(payload).toMatchObject({
      startDate: '2026-06-10',
      endDate: '2026-06-11',
      source: 'warm',
      maxRangeDays: 31,
      missingDates: [],
    });
    expect(payload.entries).toEqual([
      {
        date: '2026-06-10',
        file: 'journals/2026_06_10.md',
        content: '# 2026-06-10\nRANGE_START_MARKER wrote the brief.',
      },
      {
        date: '2026-06-11',
        file: 'journals/2026_06_11.md',
        content: 'RANGE_END_MARKER revised it.',
      },
    ]);
    expect(JSON.stringify(payload)).not.toContain('OUTSIDE_RANGE_MARKER');
    expect(JSON.stringify(payload)).not.toContain('SHOULD_NOT_APPEAR');
  });

  it('records missing dates without treating absent journal files as errors', async () => {
    const { journalRange } = await requireJournalRangeModule();
    const deps = makeDeps({
      queryVaultIndex: vi.fn().mockReturnValue([
        { file: 'journals/2026_06_10.md', line: 1, content: 'START_DAY' },
        { file: 'journals/2026_06_12.md', line: 1, content: 'END_DAY' },
      ]),
    });

    const result = await journalRange(
      { startDate: '2026-06-10', endDate: '2026-06-12' },
      deps,
    );

    const payload = parsePayload(result);
    expect(payload.entries.map((entry) => entry.date)).toEqual(['2026-06-10', '2026-06-12']);
    expect(payload.missingDates).toEqual(['2026-06-11']);
  });

  it('falls back to cold vault search only while the warm index is building', async () => {
    const { journalRange } = await requireJournalRangeModule();
    const deps = makeDeps({
      getVaultIndexStatus: vi.fn().mockReturnValue({ ready: false, status: 'building' }),
      queryVaultIndex: vi.fn().mockReturnValue([]),
      searchVault: vi.fn().mockReturnValue([
        { file: 'journals/2026_06_10.md', line: 1, content: 'COLD_FALLBACK_MARKER' },
      ]),
    });

    const result = await journalRange(
      { startDate: '2026-06-10', endDate: '2026-06-10' },
      deps,
    );

    expect(deps.queryVaultIndex).not.toHaveBeenCalled();
    expect(deps.searchVault).toHaveBeenCalledTimes(1);
    expect(deps.searchVault).toHaveBeenCalledWith(
      '',
      expect.objectContaining({ directory: 'journals' }),
    );
    const payload = parsePayload(result);
    expect(payload.source).toBe('cold');
    expect(payload.entries[0]?.content).toBe('COLD_FALLBACK_MARKER');
  });

  it('does not cold-fallback after index failure because fallback is only a warming behavior', async () => {
    const { journalRange } = await requireJournalRangeModule();
    const deps = makeDeps({
      getVaultIndexStatus: vi.fn().mockReturnValue({ ready: false, status: 'failed' }),
    });

    const result = await journalRange(
      { startDate: '2026-06-10', endDate: '2026-06-10' },
      deps,
    );

    expect(result.isError).toBe(true);
    expect(deps.queryVaultIndex).not.toHaveBeenCalled();
    expect(deps.searchVault).not.toHaveBeenCalled();
    expect(result.content[0]?.text).toMatch(/vault index/i);
  });

  it('rejects invalid ranges before touching warm or cold vault readers', async () => {
    const { journalRange } = await requireJournalRangeModule();
    const deps = makeDeps();

    const badDate = await journalRange({ startDate: '2026/06/10', endDate: '2026-06-10' }, deps);
    const reversed = await journalRange({ startDate: '2026-06-12', endDate: '2026-06-10' }, deps);
    const tooLong = await journalRange({ startDate: '2026-06-01', endDate: '2026-07-02' }, deps);

    expect(badDate.isError).toBe(true);
    expect(reversed.isError).toBe(true);
    expect(tooLong.isError).toBe(true);
    expect(tooLong.content[0]?.text).toMatch(/31/);
    expect(deps.queryVaultIndex).not.toHaveBeenCalled();
    expect(deps.searchVault).not.toHaveBeenCalled();
  });

  it('sanitizes unexpected warm-reader errors before returning MCP error text', async () => {
    const { journalRange } = await requireJournalRangeModule();
    const deps = makeDeps({
      queryVaultIndex: vi.fn(() => {
        throw new Error('/Users/jarvis/workspace/pkms/journals/2026_06_10.md permission denied');
      }),
    });

    const result = await journalRange(
      { startDate: '2026-06-10', endDate: '2026-06-10' },
      deps,
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('[vault]');
    expect(result.content[0]?.text).not.toContain('/Users/jarvis/workspace/pkms');
  });
});
