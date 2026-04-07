import { runAgent } from '../ai/claude.js';
import { readVaultFile } from '../vault/files.js';
import { searchVault } from './search.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('kb-query');

/**
 * Query the knowledge base. Searches both wiki and personal vault,
 * then uses the kb-query agent to synthesize an answer.
 */
export async function queryKB(question: string): Promise<{ success: boolean; answer: string }> {
  log.info('Querying KB', { question: question.slice(0, 100) });

  // Pre-search to give the agent hints about relevant files
  const searchResults = searchVault(question, { maxResults: 10 });
  const searchContext = searchResults.length > 0
    ? `\n\nPre-search results (files that may be relevant):\n${searchResults.map((r) => `- ${r.file}: ${r.content}`).join('\n')}`
    : '';

  const prompt = `Answer the following question using the knowledge base and vault.

Question: ${question}

Follow the query workflow:
1. Read knowledge/index.md to find relevant wiki pages
2. Read those wiki pages for detailed information
3. Search the vault with grep for additional context from personal notes
4. Synthesize an answer with [[wikilink]] citations to your sources${searchContext}`;

  const result = await runAgent('kb-query', prompt);

  if (result.error) {
    log.error('Query failed', { error: result.error });
    return { success: false, answer: `Query error: ${result.error}` };
  }

  return { success: true, answer: result.text || 'No answer generated.' };
}
