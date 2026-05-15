import { runAgent } from '../ai/claude.js';
import { readVaultFile } from '../vault/files.js';
import { searchVault, searchWithFilter } from './search.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('kb-query');

/** Infer a wiki page type filter from the question phrasing. */
function inferTypeFilter(question: string): string | undefined {
  const q = question.toLowerCase();
  if (/\bwho is\b|\bwho was\b|\bwhat company\b|\bwhat project\b/.test(q)) return 'entity';
  if (/\bwhat is\b|\bdefine\b|\bexplain the concept\b|\bwhat does .+ mean\b/.test(q)) return 'concept';
  if (/\bcompare\b|\bvs\b|\bdifference between\b/.test(q)) return 'comparison';
  return undefined;
}

/**
 * Query the knowledge base. Searches both wiki and personal vault,
 * then uses the kb-query agent to synthesize an answer.
 */
export async function queryKB(question: string): Promise<{ success: boolean; answer: string }> {
  log.info('Querying KB', { question: question.slice(0, 100) });

  // Filtered wiki search for targeted results
  const typeFilter = inferTypeFilter(question);
  const filteredResults = searchWithFilter(
    question,
    typeFilter ? { type: typeFilter } : undefined,
    { maxResults: 10 },
  );

  // Broader vault search for additional context
  const vaultResults = searchVault(question, { maxResults: 10 });

  const filteredContext = filteredResults.length > 0
    ? `\n\nFiltered wiki results (type: ${typeFilter || 'all'}):\n${filteredResults.map((r) => `- ${r.file}: ${r.content}`).join('\n')}`
    : '';
  const vaultContext = vaultResults.length > 0
    ? `\n\nBroader vault search results:\n${vaultResults.map((r) => `- ${r.file}: ${r.content}`).join('\n')}`
    : '';

  const prompt = `Answer the following question using the knowledge base and vault.

Question: ${question}

Follow the query workflow:
1. Read knowledge/index.md to find relevant wiki pages
2. Read those wiki pages for detailed information — check their YAML frontmatter for related pages to explore
3. Search the vault with grep for additional context from personal notes
4. Synthesize an answer with [[wikilink]] citations to your sources${filteredContext}${vaultContext}`;

  const result = await runAgent('kb-query', prompt, undefined, undefined, true);

  if (result.error) {
    log.error('Query failed', { error: result.error });
    return { success: false, answer: `Query error: ${result.error}` };
  }

  return { success: true, answer: result.text || 'No answer generated.' };
}
