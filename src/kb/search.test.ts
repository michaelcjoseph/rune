import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../config.js', () => ({
  default: { VAULT_DIR: '/test/vault' },
}));

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

const { execFileSync } = await import('node:child_process');
const { searchVault } = await import('./search.js');

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
});
