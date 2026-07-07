import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../config.js', () => ({
  default: { VAULT_DIR: '/test/vault', TIMEZONE: 'America/Chicago' },
}));

vi.mock('../ai/claude.js', () => ({ runAgent: vi.fn() }));
vi.mock('./search.js', () => ({ searchVault: vi.fn(), searchWithFilter: vi.fn() }));
vi.mock('../vault/files.js', () => ({ readVaultFile: vi.fn() }));

const { runAgent } = await import('../ai/claude.js');
const { searchVault, searchWithFilter } = await import('./search.js');
const { readVaultFile } = await import('../vault/files.js');
const { queryKB } = await import('./query.js');

const agentMock = runAgent as unknown as ReturnType<typeof vi.fn>;
const searchMock = searchVault as unknown as ReturnType<typeof vi.fn>;
const filterMock = searchWithFilter as unknown as ReturnType<typeof vi.fn>;
const vaultFileMock = readVaultFile as unknown as ReturnType<typeof vi.fn>;

type QueryKBWithDeps = (
  question: string,
  deps?: {
    searchVault?: (
      query: string,
      options?: { directory?: string; maxResults?: number },
    ) => Array<{ file: string; line: number; content: string }>;
    agentTimeoutMs?: number;
  },
) => Promise<{ success: boolean; answer: string }>;

describe('kb/query', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns synthesized answer on success', async () => {
    filterMock.mockReturnValue([{ file: 'wiki/ai.md', line: 1, content: 'AI is cool' }]);
    searchMock.mockReturnValue([{ file: 'wiki/ai.md', line: 1, content: 'AI is cool' }]);
    agentMock.mockResolvedValue({ text: 'Here is the answer', error: null });

    const result = await queryKB('what is AI?');
    expect(result).toEqual({ success: true, answer: 'Here is the answer' });
  });

  it('includes search context in agent prompt', async () => {
    filterMock.mockReturnValue([{ file: 'wiki/test.md', line: 5, content: 'relevant' }]);
    searchMock.mockReturnValue([{ file: 'wiki/test.md', line: 5, content: 'relevant' }]);
    agentMock.mockResolvedValue({ text: 'answer', error: null });

    await queryKB('test query');
    expect(searchMock).toHaveBeenCalledWith('test query', { maxResults: 10 });
    expect(agentMock).toHaveBeenCalledWith('kb-query', expect.stringContaining('relevant'), undefined, undefined, true);
  });

  it('uses an injected broad vault search provider for daemon warm-index routing', async () => {
    filterMock.mockReturnValue([]);
    searchMock.mockReturnValue([{ file: 'cold.md', line: 1, content: 'COLD_CONTEXT' }]);
    const injectedBroadSearch = vi.fn().mockReturnValue([
      { file: 'knowledge/warm.md', line: 7, content: 'WARM_DAEMON_CONTEXT' },
    ]);
    agentMock.mockResolvedValue({ text: 'answer', error: null });

    await (queryKB as QueryKBWithDeps)('daemon broad topic', {
      searchVault: injectedBroadSearch,
    });

    expect(injectedBroadSearch).toHaveBeenCalledWith('daemon broad topic', { maxResults: 10 });
    expect(searchMock).not.toHaveBeenCalled();
    const prompt = agentMock.mock.calls[0]?.[1] as string;
    expect(prompt).toContain('WARM_DAEMON_CONTEXT');
    expect(prompt).not.toContain('COLD_CONTEXT');
  });

  it('injects index-row summaries for pre-resolved candidates instead of the full index read', async () => {
    filterMock.mockReturnValue([
      { file: 'knowledge/wiki/entities/test-page.md', line: 3, content: 'first matched line' },
      { file: 'knowledge/wiki/entities/test-page.md', line: 9, content: 'second matched line' },
      { file: 'knowledge/wiki/concepts/other-page.md', line: 1, content: 'other matched line' },
    ]);
    searchMock.mockReturnValue([]);
    vaultFileMock.mockReturnValue(
      '# Knowledge Base Index\n\n## Entities\n\n- [[test-page]] — a short summary of the test page\n\n## Concepts\n\n- [[unrelated-page]] — should not appear\n',
    );
    agentMock.mockResolvedValue({ text: 'answer', error: null });

    await queryKB('candidate question');

    expect(vaultFileMock).toHaveBeenCalledWith('knowledge/index.md');
    const prompt = agentMock.mock.calls[0]?.[1] as string;
    expect(prompt).toContain('Pre-resolved candidate wiki pages');
    expect(prompt).toContain('- [[test-page]] (knowledge/wiki/entities/test-page.md) — a short summary of the test page');
    expect(prompt).toContain('- [[other-page]] (knowledge/wiki/concepts/other-page.md)');
    expect(prompt).toContain('match: "first matched line"');
    expect(prompt).toContain('match: "second matched line"');
    expect(prompt).not.toContain('should not appear');
    expect(prompt).toContain('do NOT read knowledge/index.md');
    expect(prompt).not.toContain('Read knowledge/index.md to find relevant wiki pages');
  });

  it('falls back to a bounded index excerpt when the deterministic search finds nothing', async () => {
    filterMock.mockReturnValue([]);
    searchMock.mockReturnValue([]);
    vaultFileMock.mockReturnValue('## Entities\n- [[INDEX_EXCERPT_MARKER]] — visible in fallback\n');
    agentMock.mockResolvedValue({ text: 'answer', error: null });

    await queryKB('no candidates question');

    const prompt = agentMock.mock.calls[0]?.[1] as string;
    expect(prompt).toContain('No candidate pages were pre-resolved');
    expect(prompt).toContain('INDEX_EXCERPT_MARKER');
    expect(prompt).not.toContain('[index excerpt truncated]');
  });

  it('truncates the fallback index excerpt at the cap', async () => {
    filterMock.mockReturnValue([]);
    searchMock.mockReturnValue([]);
    vaultFileMock.mockReturnValue(`${'A'.repeat(20_000)}ZZZ_BEYOND_CAP`);
    agentMock.mockResolvedValue({ text: 'answer', error: null });

    await queryKB('huge index question');

    const prompt = agentMock.mock.calls[0]?.[1] as string;
    expect(prompt).toContain('[index excerpt truncated]');
    expect(prompt).not.toContain('ZZZ_BEYOND_CAP');
  });

  it('still succeeds when the index is unreadable', async () => {
    filterMock.mockReturnValue([]);
    searchMock.mockReturnValue([]);
    vaultFileMock.mockImplementation(() => {
      throw new Error('index read failed');
    });
    agentMock.mockResolvedValue({ text: 'answer without index', error: null });

    const result = await queryKB('degraded question');

    expect(result).toEqual({ success: true, answer: 'answer without index' });
    const prompt = agentMock.mock.calls[0]?.[1] as string;
    expect(prompt).not.toContain('No candidate pages were pre-resolved');
  });

  it('threads deps.agentTimeoutMs to runAgent as its timeout arg', async () => {
    filterMock.mockReturnValue([]);
    searchMock.mockReturnValue([]);
    agentMock.mockResolvedValue({ text: 'answer', error: null });

    await (queryKB as QueryKBWithDeps)('bounded question', { agentTimeoutMs: 150_000 });

    expect(agentMock).toHaveBeenCalledWith(
      'kb-query',
      expect.any(String),
      150_000,
      undefined,
      true,
    );
  });

  it('infers entity type filter for "who is" questions', async () => {
    filterMock.mockReturnValue([]);
    searchMock.mockReturnValue([]);
    agentMock.mockResolvedValue({ text: 'answer', error: null });

    await queryKB('who is Vitalik Buterin?');
    expect(filterMock).toHaveBeenCalledWith(
      'who is Vitalik Buterin?',
      { type: 'entity' },
      { maxResults: 10 },
    );
  });

  it('works with no search results', async () => {
    filterMock.mockReturnValue([]);
    searchMock.mockReturnValue([]);
    agentMock.mockResolvedValue({ text: 'no info', error: null });

    const result = await queryKB('obscure');
    expect(result.success).toBe(true);
  });

  it('returns error when agent fails', async () => {
    filterMock.mockReturnValue([]);
    searchMock.mockReturnValue([]);
    agentMock.mockResolvedValue({ text: null, error: 'timeout' });

    const result = await queryKB('test');
    expect(result.success).toBe(false);
    expect(result.answer).toContain('timeout');
  });
});
