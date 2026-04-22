import { askClaudeOneShot } from '../ai/claude.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('book-summarizer');

/** Generate a 1-2 sentence summary of a book from Claude's general knowledge.
 *  Returns null if the LLM doesn't recognize the book or the call fails. */
export async function summarizeBook(title: string, author?: string): Promise<string | null> {
  if (!title.trim()) return null;

  const authorPart = author?.trim() ? ` by ${author.trim()}` : '';
  const prompt = `Write a neutral 1-2 sentence summary of the book "${title}"${authorPart}. Focus on the premise and core themes, not a full synopsis.

If you are not confident you know this specific book (distinct titles, minor editions, self-published works, etc.), respond with exactly: UNKNOWN

Output ONLY the summary sentence(s), no preamble, no quotes, no fences. Or "UNKNOWN" if unsure.`;

  const result = await askClaudeOneShot(prompt);
  if (result.error) {
    log.error('summarizeBook failed', { title, author, error: result.error });
    return null;
  }
  const text = result.text?.trim();
  if (!text || text === 'UNKNOWN') return null;
  return text;
}
