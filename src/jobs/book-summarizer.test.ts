import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../config.js', () => ({
  default: { VAULT_DIR: '/test/vault', TIMEZONE: 'America/Chicago' },
}));

vi.mock('../ai/claude.js', () => ({
  askClaudeOneShot: vi.fn(),
}));

const { askClaudeOneShot } = await import('../ai/claude.js');
const { summarizeBook } = await import('./book-summarizer.js');

const askMock = askClaudeOneShot as unknown as ReturnType<typeof vi.fn>;

describe('jobs/book-summarizer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns a summary when the LLM recognizes the book', async () => {
    askMock.mockResolvedValue({
      text: 'A coming-of-age story about a young wizard at a magical school.',
      error: null,
    });

    const summary = await summarizeBook('Harry Potter', 'J.K. Rowling');
    expect(summary).toBe('A coming-of-age story about a young wizard at a magical school.');
    expect(askMock).toHaveBeenCalledWith(expect.stringContaining('Harry Potter'));
    expect(askMock).toHaveBeenCalledWith(expect.stringContaining('J.K. Rowling'));
  });

  it('omits the author clause when author is not provided', async () => {
    askMock.mockResolvedValue({ text: 'A satirical novel.', error: null });

    await summarizeBook('Catch-22');

    const prompt = askMock.mock.calls[0]![0] as string;
    expect(prompt).toContain('"Catch-22"');
    expect(prompt).not.toContain(' by ');
  });

  it('returns null when the LLM responds with exactly "UNKNOWN"', async () => {
    askMock.mockResolvedValue({ text: 'UNKNOWN', error: null });
    const summary = await summarizeBook('Some Obscure Self-Published Title');
    expect(summary).toBeNull();
  });

  it('returns null when the LLM returns an error', async () => {
    askMock.mockResolvedValue({ text: null, error: 'timeout' });
    const summary = await summarizeBook('Any Book');
    expect(summary).toBeNull();
  });

  it('returns null when the LLM returns empty text', async () => {
    askMock.mockResolvedValue({ text: '', error: null });
    const summary = await summarizeBook('Any Book');
    expect(summary).toBeNull();
  });

  it('returns null for an empty title', async () => {
    const summary = await summarizeBook('');
    expect(summary).toBeNull();
    expect(askMock).not.toHaveBeenCalled();
  });

  it('trims surrounding whitespace from the LLM response', async () => {
    askMock.mockResolvedValue({ text: '   A minimalist thriller.   \n', error: null });
    const summary = await summarizeBook('Some Book');
    expect(summary).toBe('A minimalist thriller.');
  });
});
