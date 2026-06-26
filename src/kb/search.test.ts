import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../config.js', () => ({
  default: { VAULT_DIR: '/test/vault' },
}));

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

const { execFileSync } = await import('node:child_process');
const searchModule = await import('./search.js');
const { searchVault } = searchModule;
const searchRepo = (searchModule as unknown as {
  searchRepo?: (query: string, options: { repoPath: string; maxResults?: number }) => Array<{
    file: string;
    line: number;
    content: string;
  }>;
}).searchRepo;

const execMock = execFileSync as unknown as ReturnType<typeof vi.fn>;

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
