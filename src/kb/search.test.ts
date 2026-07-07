import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../config.js', () => ({
  default: { VAULT_DIR: '/test/vault' },
}));

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

vi.mock('node:fs', () => ({
  readFileSync: vi.fn(() => {
    throw new Error('not mocked');
  }),
}));

const { execFileSync } = await import('node:child_process');
const { readFileSync } = await import('node:fs');
const searchModule = await import('./search.js');
const { searchVault, rankWikiPages, searchInFiles } = searchModule;
const searchRepo = (searchModule as unknown as {
  searchRepo?: (query: string, options: { repoPath: string; maxResults?: number }) => Array<{
    file: string;
    line: number;
    content: string;
  }>;
}).searchRepo;

const execMock = execFileSync as unknown as ReturnType<typeof vi.fn>;
const readFileMock = readFileSync as unknown as ReturnType<typeof vi.fn>;

/** Mock `rg -il` per term: args[1][4] is the fixed-string term. */
function mockFileListsByTerm(filesByTerm: Record<string, string[]>): void {
  execMock.mockImplementation((_bin: string, args: string[]) => {
    const term = args[4]!;
    const files = filesByTerm[term];
    if (!files || files.length === 0) throw new Error('no matches');
    return Buffer.from(files.join('\n') + '\n');
  });
}

describe('kb/search', () => {
  beforeEach(() => {
    execMock.mockReset();
  });

  it('parses ripgrep JSON output into SearchResult[]', () => {
    const rgOutput = [
      JSON.stringify({
        type: 'match',
        data: { path: { text: '/test/vault/notes/a.md' }, line_number: 10, lines: { text: 'match A' } },
      }),
      JSON.stringify({
        type: 'match',
        data: { path: { text: '/test/vault/wiki/b.md' }, line_number: 5, lines: { text: 'match B' } },
      }),
    ].join('\n');

    execMock.mockReturnValue(Buffer.from(rgOutput));
    const results = searchVault('test');
    expect(results).toEqual([
      { file: 'notes/a.md', line: 10, content: 'match A' },
      { file: 'wiki/b.md', line: 5, content: 'match B' },
    ]);
  });

  it('returns empty array when rg throws (no matches)', () => {
    execMock.mockImplementation(() => { throw new Error('no matches'); });
    expect(searchVault('nothing')).toEqual([]);
  });

  it('respects maxResults option', () => {
    const matches = Array.from({ length: 30 }, (_, i) =>
      JSON.stringify({
        type: 'match',
        data: { path: { text: `/test/vault/f${i}.md` }, line_number: 1, lines: { text: `m${i}` } },
      }),
    ).join('\n');

    execMock.mockReturnValue(Buffer.from(matches));
    expect(searchVault('q', { maxResults: 5 })).toHaveLength(5);
  });

  it('passes subdirectory to rg', () => {
    execMock.mockReturnValue(Buffer.from(''));
    searchVault('q', { directory: 'knowledge/wiki' });
    expect(execMock).toHaveBeenCalledWith(
      'rg',
      expect.arrayContaining(['/test/vault/knowledge/wiki']),
      expect.any(Object),
    );
  });

  it('skips non-match JSON lines', () => {
    const rgOutput = [
      JSON.stringify({ type: 'begin', data: {} }),
      JSON.stringify({
        type: 'match',
        data: { path: { text: '/test/vault/f.md' }, line_number: 1, lines: { text: 'hit' } },
      }),
      JSON.stringify({ type: 'end', data: {} }),
    ].join('\n');

    execMock.mockReturnValue(Buffer.from(rgOutput));
    expect(searchVault('q')).toHaveLength(1);
  });

  it('searchRepo searches the active product repo and returns repo-relative snippets', () => {
    expect(
      searchRepo,
      'src/kb/search.ts must export searchRepo for product-scoped repo chat search',
    ).toEqual(expect.any(Function));

    const rgOutput = [
      JSON.stringify({
        type: 'match',
        data: {
          path: { text: '/workspace/rune/src/server/webview.ts' },
          line_number: 42,
          lines: { text: 'handleApiProducts reads the product deep view' },
        },
      }),
      JSON.stringify({
        type: 'match',
        data: {
          path: { text: '/workspace/rune/docs/projects/17-cockpit-redesign/spec.md' },
          line_number: 330,
          lines: { text: 'per-product chat search is repo plus vault' },
        },
      }),
    ].join('\n');

    execMock.mockReturnValue(Buffer.from(rgOutput));

    expect(searchRepo!('product deep view', {
      repoPath: '/workspace/rune',
      maxResults: 5,
    })).toEqual([
      { file: 'src/server/webview.ts', line: 42, content: 'handleApiProducts reads the product deep view' },
      {
        file: 'docs/projects/17-cockpit-redesign/spec.md',
        line: 330,
        content: 'per-product chat search is repo plus vault',
      },
    ]);
    expect(execMock).toHaveBeenCalledWith(
      'rg',
      expect.arrayContaining(['/workspace/rune']),
      expect.any(Object),
    );
    expect(execMock).not.toHaveBeenCalledWith(
      'rg',
      expect.arrayContaining(['/test/vault']),
      expect.any(Object),
    );
  });
});

describe('rankWikiPages', () => {
  beforeEach(() => {
    execMock.mockReset();
    readFileMock.mockReset();
    readFileMock.mockImplementation(() => {
      throw new Error('not mocked');
    });
  });

  it('a rare term outweighs a generic term matching many files', () => {
    mockFileListsByTerm({
      genestoux: ['/test/vault/knowledge/wiki/entities/julien-genestoux.md'],
      notes: [
        '/test/vault/knowledge/wiki/topics/noise-a.md',
        '/test/vault/knowledge/wiki/topics/noise-b.md',
        '/test/vault/knowledge/wiki/topics/noise-c.md',
      ],
    });

    const ranked = rankWikiPages(['notes', 'genestoux']);

    expect(ranked[0]!.file).toBe('knowledge/wiki/entities/julien-genestoux.md');
    expect(ranked[0]!.score).toBeCloseTo(1);
    expect(ranked[1]!.score).toBeCloseTo(1 / 3);
    expect(ranked).toHaveLength(4);
  });

  it('distinct-term coverage accumulates per file', () => {
    mockFileListsByTerm({
      peter: [
        '/test/vault/knowledge/wiki/entities/peter-watts.md',
        '/test/vault/knowledge/wiki/entities/peter-roth.md',
      ],
      watts: [
        '/test/vault/knowledge/wiki/entities/peter-watts.md',
        '/test/vault/knowledge/wiki/topics/energy-units.md',
      ],
    });

    const ranked = rankWikiPages(['peter', 'watts']);

    expect(ranked[0]).toMatchObject({
      file: 'knowledge/wiki/entities/peter-watts.md',
      matchedTerms: ['peter', 'watts'],
    });
    expect(ranked[0]!.score).toBeCloseTo(1);
  });

  it('caps at maxResults and skips terms whose rg call fails', () => {
    mockFileListsByTerm({
      // 'missing' is absent → its rg call throws and is skipped
      common: Array.from({ length: 12 }, (_, i) => `/test/vault/knowledge/wiki/topics/t${i}.md`),
    });

    const ranked = rankWikiPages(['missing', 'common'], { maxResults: 5 });
    expect(ranked).toHaveLength(5);
  });

  it('applies the frontmatter type filter to the ranked list', () => {
    mockFileListsByTerm({
      relay: [
        '/test/vault/knowledge/wiki/topics/relay-topic.md',
        '/test/vault/knowledge/wiki/entities/relay.md',
      ],
    });
    readFileMock.mockImplementation((path: string) => {
      if (String(path).includes('entities/relay.md')) return '---\ntype: entity\n---\nbody';
      return '---\ntype: topic\n---\nbody';
    });

    const ranked = rankWikiPages(['relay'], { type: 'entity' });

    expect(ranked).toEqual([
      expect.objectContaining({ file: 'knowledge/wiki/entities/relay.md' }),
    ]);
  });

  it('returns [] for empty terms without spawning rg', () => {
    expect(rankWikiPages([])).toEqual([]);
    expect(execMock).not.toHaveBeenCalled();
  });
});

describe('searchInFiles', () => {
  beforeEach(() => {
    execMock.mockReset();
  });

  it('fetches match lines from the given vault-relative files', () => {
    const rgOutput = JSON.stringify({
      type: 'match',
      data: {
        path: { text: '/test/vault/knowledge/wiki/entities/x.md' },
        line_number: 7,
        lines: { text: 'the matching line' },
      },
    });
    execMock.mockReturnValue(Buffer.from(rgOutput));

    const results = searchInFiles('pattern', ['knowledge/wiki/entities/x.md'], { maxPerFile: 2 });

    expect(results).toEqual([
      { file: 'knowledge/wiki/entities/x.md', line: 7, content: 'the matching line' },
    ]);
    expect(execMock).toHaveBeenCalledWith(
      'rg',
      expect.arrayContaining(['--max-count', '2', '/test/vault/knowledge/wiki/entities/x.md']),
      expect.any(Object),
    );
  });

  it('returns [] for an empty file list without spawning rg', () => {
    expect(searchInFiles('pattern', [])).toEqual([]);
    expect(execMock).not.toHaveBeenCalled();
  });

  it('drops file paths that escape the vault', () => {
    expect(searchInFiles('pattern', ['../../etc/passwd'])).toEqual([]);
    expect(execMock).not.toHaveBeenCalled();
  });
});
