import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../config.js', () => ({
  default: { VAULT_DIR: '/test/vault', TIMEZONE: 'America/Chicago' },
}));

vi.mock('../ai/claude.js', () => ({ runAgent: vi.fn(), runBackgroundAgent: vi.fn() }));
vi.mock('./search.js', () => ({
  searchVault: vi.fn(),
  searchWithFilter: vi.fn(),
  rankWikiPages: vi.fn(),
  searchInFiles: vi.fn(),
}));
vi.mock('../vault/files.js', () => ({ readVaultFile: vi.fn() }));

const { runAgent, runBackgroundAgent } = await import('../ai/claude.js');
const { searchVault, searchWithFilter, rankWikiPages, searchInFiles } = await import('./search.js');
const { readVaultFile } = await import('../vault/files.js');
const { queryKB } = await import('./query.js');

const agentMock = runAgent as unknown as ReturnType<typeof vi.fn>;
const backgroundAgentMock = runBackgroundAgent as unknown as ReturnType<typeof vi.fn>;
const searchMock = searchVault as unknown as ReturnType<typeof vi.fn>;
const filterMock = searchWithFilter as unknown as ReturnType<typeof vi.fn>;
const rankMock = rankWikiPages as unknown as ReturnType<typeof vi.fn>;
const inFilesMock = searchInFiles as unknown as ReturnType<typeof vi.fn>;
const vaultFileMock = readVaultFile as unknown as ReturnType<typeof vi.fn>;

function ranked(...files: string[]): Array<{ file: string; score: number; matchedTerms: string[] }> {
  return files.map((file, i) => ({ file, score: 1 / (i + 1), matchedTerms: [] }));
}

type QueryKBWithDeps = (
  question: string,
  deps?: {
    searchVault?: (
      query: string,
      options?: { directory?: string; maxResults?: number },
    ) => Array<{ file: string; line: number; content: string }>;
    agentTimeoutMs?: number;
    agentUserVisible?: boolean;
  },
) => Promise<{ success: boolean; answer: string }>;

describe('kb/query', () => {
  beforeEach(() => {
    // Full reset (implementations too) so a mockReturnValue/mockImplementation
    // set in one test can never leak into the next; then safe defaults.
    vi.resetAllMocks();
    searchMock.mockReturnValue([]);
    filterMock.mockReturnValue([]);
    rankMock.mockReturnValue([]);
    inFilesMock.mockReturnValue([]);
  });

  it('returns synthesized answer on success', async () => {
    filterMock.mockReturnValue([{ file: 'wiki/ai.md', line: 1, content: 'AI is cool' }]);
    searchMock.mockReturnValue([{ file: 'wiki/ai.md', line: 1, content: 'AI is cool' }]);
    agentMock.mockResolvedValue({ text: 'Here is the answer', error: null });

    const result = await queryKB('what is AI?');
    expect(result).toEqual({ success: true, answer: 'Here is the answer' });
  });

  it('includes ranked-candidate snippets in the agent prompt', async () => {
    rankMock.mockReturnValue(ranked('wiki/test.md'));
    inFilesMock.mockReturnValue([{ file: 'wiki/test.md', line: 5, content: 'relevant' }]);
    agentMock.mockResolvedValue({ text: 'answer', error: null });

    await queryKB('test query');
    expect(searchMock).toHaveBeenCalledWith('test|query', { maxResults: 10 });
    expect(inFilesMock).toHaveBeenCalledWith('test|query', ['wiki/test.md'], { maxPerFile: 2 });
    expect(agentMock).toHaveBeenCalledWith('kb-query', expect.stringContaining('relevant'), undefined, undefined, true);
  });

  it('ranks candidates by content terms instead of searching the raw question', async () => {
    agentMock.mockResolvedValue({ text: 'answer', error: null });

    await queryKB('Who is Paul Graham and what does he know about startups?');

    expect(rankMock).toHaveBeenCalledWith(['paul', 'graham', 'startups'], { type: 'entity', maxResults: 10 });
    expect(searchMock).toHaveBeenCalledWith('paul|graham|startups', { maxResults: 10 });
    expect(filterMock).not.toHaveBeenCalled();
  });

  it('falls back to the raw-question filtered search when only stopwords remain', async () => {
    agentMock.mockResolvedValue({ text: 'answer', error: null });

    await queryKB('who is it?');

    expect(rankMock).not.toHaveBeenCalled();
    expect(filterMock).toHaveBeenCalledWith('who is it?', { type: 'entity' }, { maxResults: 10 });
    expect(searchMock).toHaveBeenCalledWith('who is it?', { maxResults: 10 });
  });

  it('clips oversized matched lines before they reach the prompt', async () => {
    rankMock.mockReturnValue(ranked('knowledge/wiki/entities/huge.md'));
    inFilesMock.mockReturnValue([
      { file: 'knowledge/wiki/entities/huge.md', line: 1, content: `${'S'.repeat(10_000)}SNIPPET_TAIL_MARKER` },
    ]);
    searchMock.mockReturnValue([
      { file: 'pages/crm.json', line: 1, content: `${'V'.repeat(10_000)}VAULT_TAIL_MARKER` },
    ]);
    agentMock.mockResolvedValue({ text: 'answer', error: null });

    await queryKB('huge snippet question');

    const prompt = agentMock.mock.calls[0]?.[1] as string;
    expect(prompt).not.toContain('SNIPPET_TAIL_MARKER');
    expect(prompt).not.toContain('VAULT_TAIL_MARKER');
    expect(prompt).toContain(`${'S'.repeat(300)}…`);
    expect(prompt).toContain(`${'V'.repeat(300)}…`);
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

    expect(injectedBroadSearch).toHaveBeenCalledWith('daemon|broad|topic', { maxResults: 10 });
    expect(searchMock).not.toHaveBeenCalled();
    const prompt = agentMock.mock.calls[0]?.[1] as string;
    expect(prompt).toContain('WARM_DAEMON_CONTEXT');
    expect(prompt).not.toContain('COLD_CONTEXT');
  });

  it('injects index-row summaries and pre-fetched page bodies for the candidates', async () => {
    rankMock.mockReturnValue(ranked(
      'knowledge/wiki/entities/test-page.md',
      'knowledge/wiki/concepts/other-page.md',
    ));
    inFilesMock.mockReturnValue([
      { file: 'knowledge/wiki/entities/test-page.md', line: 3, content: 'first matched line' },
      { file: 'knowledge/wiki/entities/test-page.md', line: 9, content: 'second matched line' },
      { file: 'knowledge/wiki/concepts/other-page.md', line: 1, content: 'other matched line' },
    ]);
    vaultFileMock.mockImplementation((path: string) => {
      if (path === 'knowledge/index.md') {
        return '# Knowledge Base Index\n\n## Entities\n\n- [[test-page]] — a short summary of the test page\n\n## Concepts\n\n- [[unrelated-page]] — should not appear\n';
      }
      if (path === 'knowledge/wiki/entities/test-page.md') return 'TEST_PAGE_BODY full content';
      if (path === 'knowledge/wiki/concepts/other-page.md') return 'OTHER_PAGE_BODY details';
      return null;
    });
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
    expect(prompt).toContain('=== knowledge/wiki/entities/test-page.md ([[test-page]]) ===');
    expect(prompt).toContain('TEST_PAGE_BODY full content');
    expect(prompt).toContain('OTHER_PAGE_BODY details');
    // Single-pass synthesis instructions replaced the agent-side retrieval workflow.
    expect(prompt).toContain('you have no tools');
    expect(prompt).not.toContain('Read knowledge/index.md to find relevant wiki pages');
    expect(prompt).not.toContain('Search the vault with grep');
  });

  it('caps each pre-fetched body and stops at the page limit', async () => {
    rankMock.mockReturnValue(ranked(
      ...Array.from({ length: 10 }, (_, i) => `knowledge/wiki/topics/page-${i}.md`),
    ));
    vaultFileMock.mockImplementation((path: string) => {
      if (path === 'knowledge/index.md') return null;
      if (path === 'knowledge/wiki/topics/page-0.md') return `${'B'.repeat(8_000)}BEYOND_PAGE_CAP`;
      if (path.startsWith('knowledge/wiki/topics/page-')) return `BODY_OF_${path}`;
      return null;
    });
    agentMock.mockResolvedValue({ text: 'answer', error: null });

    await queryKB('many candidates');

    const prompt = agentMock.mock.calls[0]?.[1] as string;
    expect(prompt).toContain('[page body truncated]');
    expect(prompt).not.toContain('BEYOND_PAGE_CAP');
    expect(prompt).toContain('BODY_OF_knowledge/wiki/topics/page-7.md');
    expect(prompt).not.toContain('BODY_OF_knowledge/wiki/topics/page-8.md');
    // Un-fetched pages remain listed as candidates.
    expect(prompt).toContain('- [[page-8]] (knowledge/wiki/topics/page-8.md)');
  });

  it('stops pre-fetching bodies when the total budget is exhausted', async () => {
    rankMock.mockReturnValue(ranked(
      ...Array.from({ length: 8 }, (_, i) => `knowledge/wiki/topics/big-${i}.md`),
    ));
    vaultFileMock.mockImplementation((path: string) => {
      if (path === 'knowledge/index.md') return null;
      return 'C'.repeat(8_000); // six of these exhaust the 48k total budget
    });
    agentMock.mockResolvedValue({ text: 'answer', error: null });

    await queryKB('big pages');

    const prompt = agentMock.mock.calls[0]?.[1] as string;
    expect(prompt).toContain('=== knowledge/wiki/topics/big-5.md');
    expect(prompt).not.toContain('=== knowledge/wiki/topics/big-6.md');
  });

  it('lists a candidate without a body when its page read fails', async () => {
    rankMock.mockReturnValue(ranked('knowledge/wiki/entities/ghost.md'));
    vaultFileMock.mockImplementation(() => {
      throw new Error('read failed');
    });
    agentMock.mockResolvedValue({ text: 'answer', error: null });

    const result = await queryKB('ghost question');

    expect(result.success).toBe(true);
    const prompt = agentMock.mock.calls[0]?.[1] as string;
    expect(prompt).toContain('- [[ghost]] (knowledge/wiki/entities/ghost.md)');
    expect(prompt).not.toContain('Pre-fetched wiki page bodies');
  });

  it('kb-query SOUL declares the tool-less frontmatter the single-pass prompt promises', async () => {
    // The prompt tells the agent "you have no tools" — pin the real SOUL file
    // so a future edit can't silently restore retrieval tools.
    const { readFileSync } = await import('node:fs');
    const soul = readFileSync(new URL('../../.claude/agents/kb-query.md', import.meta.url), 'utf8');
    const frontmatter = soul.split('---')[1] ?? '';
    expect(frontmatter).toMatch(/^tools: \[\]$/m);
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

  it('uses the explicit background-agent path for a scoped MCP query', async () => {
    backgroundAgentMock.mockResolvedValue({ text: 'scoped answer', error: null });

    const result = await queryKB('scoped question', {
      agentTimeoutMs: 150_000,
      agentUserVisible: false,
    });

    expect(result).toEqual({ success: true, answer: 'scoped answer' });
    expect(backgroundAgentMock).toHaveBeenCalledWith(
      'kb-query',
      expect.any(String),
      { timeoutMs: 150_000, voice: true },
    );
    expect(agentMock).not.toHaveBeenCalled();
  });

  it('infers entity type filter for "who is" questions', async () => {
    filterMock.mockReturnValue([]);
    searchMock.mockReturnValue([]);
    agentMock.mockResolvedValue({ text: 'answer', error: null });

    await queryKB('who is Vitalik Buterin?');
    expect(rankMock).toHaveBeenCalledWith(
      ['vitalik', 'buterin'],
      { type: 'entity', maxResults: 10 },
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
