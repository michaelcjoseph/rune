import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../config.js', () => ({
  default: { VAULT_DIR: '/test/vault', TIMEZONE: 'America/Chicago' },
}));

vi.mock('../ai/claude.js', () => ({ runAgent: vi.fn() }));
vi.mock('./search.js', () => ({ searchVault: vi.fn(), searchWithFilter: vi.fn() }));
vi.mock('../vault/files.js', () => ({ readVaultFile: vi.fn() }));

const { runAgent } = await import('../ai/claude.js');
const { searchVault, searchWithFilter } = await import('./search.js');
const { queryKB } = await import('./query.js');

const agentMock = runAgent as unknown as ReturnType<typeof vi.fn>;
const searchMock = searchVault as unknown as ReturnType<typeof vi.fn>;
const filterMock = searchWithFilter as unknown as ReturnType<typeof vi.fn>;

type QueryKBWithDeps = (
  question: string,
  deps?: {
    searchVault?: (
      query: string,
      options?: { directory?: string; maxResults?: number },
    ) => Array<{ file: string; line: number; content: string }>;
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
