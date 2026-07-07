import { runAgent } from '../ai/claude.js';
import { readVaultFile } from '../vault/files.js';
import { searchVault, searchWithFilter } from './search.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('kb-query');

interface SearchResult {
  file: string;
  line: number;
  content: string;
}

export interface QueryKBDeps {
  searchVault?: (
    query: string,
    options?: { directory?: string; maxResults?: number },
  ) => SearchResult[] | Promise<SearchResult[]>;
  /** Agent timeout override in ms — default undefined (runAgent falls back to
   *  config.CLAUDE_TIMEOUT_MS, 30 min). MCP callers size this under their
   *  TOOL_TIMEOUT_OVERRIDES_MS wrapper ceiling so the agent's own timeout
   *  kills the child and surfaces cleanly instead of orphaning it. */
  agentTimeoutMs?: number;
}

/** Infer a wiki page type filter from the question phrasing. */
function inferTypeFilter(question: string): string | undefined {
  const q = question.toLowerCase();
  if (/\bwho is\b|\bwho was\b|\bwhat company\b|\bwhat project\b/.test(q)) return 'entity';
  if (/\bwhat is\b|\bdefine\b|\bexplain the concept\b|\bwhat does .+ mean\b/.test(q)) return 'concept';
  if (/\bcompare\b|\bvs\b|\bdifference between\b/.test(q)) return 'comparison';
  return undefined;
}

/** Cap on the index.md excerpt injected when no candidates were pre-resolved —
 *  the full index is ~740KB/185K tokens, which is the cost this bounds. */
const MAX_INDEX_FALLBACK_CHARS = 20_000;

/** Wiki page slug for a vault-relative path: basename minus `.md`. */
function slugOf(file: string): string {
  const base = file.split('/').at(-1) ?? file;
  return base.replace(/\.md$/i, '');
}

/** Best-effort read of knowledge/index.md; null when missing or unreadable. */
function readKnowledgeIndex(): string | null {
  try {
    return readVaultFile('knowledge/index.md') ?? null;
  } catch {
    return null;
  }
}

/** Map each candidate slug to its index-row summary (the text after the
 *  em-dash of its `- [[slug]] — summary` line; the whole row if no dash). */
function extractIndexSummaries(indexContent: string, slugs: string[]): Map<string, string> {
  const wanted = new Set(slugs.map((s) => s.toLowerCase()));
  const summaries = new Map<string, string>();
  for (const line of indexContent.split('\n')) {
    const link = line.match(/\[\[([^\]|#]+)/);
    if (!link) continue;
    const slug = link[1]!.trim().toLowerCase();
    if (!wanted.has(slug) || summaries.has(slug)) continue;
    const dash = line.indexOf('—');
    summaries.set(slug, (dash >= 0 ? line.slice(dash + 1) : line).trim());
  }
  return summaries;
}

/**
 * Query the knowledge base. Searches both wiki and personal vault,
 * then uses the kb-query agent to synthesize an answer.
 */
export async function queryKB(
  question: string,
  deps: QueryKBDeps = {},
): Promise<{ success: boolean; answer: string }> {
  log.info('Querying KB', { question: question.slice(0, 100) });

  // Filtered wiki search for targeted results
  const typeFilter = inferTypeFilter(question);
  const filteredResults = searchWithFilter(
    question,
    typeFilter ? { type: typeFilter } : undefined,
    { maxResults: 10 },
  );

  // Broader vault search for additional context
  const vaultResults = deps.searchVault
    ? await deps.searchVault(question, { maxResults: 10 })
    : searchVault(question, { maxResults: 10 });

  // Pre-resolve the candidate page set for the agent so it never has to read
  // the full knowledge/index.md (~185K tokens) itself. Candidates come from
  // the deterministic filtered search; their index-row summaries are looked
  // up in-process. Only when the search finds nothing does the prompt carry a
  // bounded index excerpt instead.
  let candidateContext = '';
  let indexFallbackContext = '';
  if (filteredResults.length > 0) {
    const candidateFiles = [...new Set(filteredResults.map((r) => r.file))];
    const indexContent = readKnowledgeIndex();
    const summaries = indexContent
      ? extractIndexSummaries(indexContent, candidateFiles.map(slugOf))
      : new Map<string, string>();
    const candidateLines = candidateFiles.map((file) => {
      const slug = slugOf(file);
      const summary = summaries.get(slug.toLowerCase());
      const header = summary ? `- [[${slug}]] (${file}) — ${summary}` : `- [[${slug}]] (${file})`;
      const matches = filteredResults
        .filter((r) => r.file === file)
        .map((r) => `  - match: "${r.content}"`);
      return [header, ...matches].join('\n');
    });
    candidateContext = `\n\nPre-resolved candidate wiki pages (deterministic index search, type: ${typeFilter || 'all'}) — read these directly; do NOT read knowledge/index.md:\n${candidateLines.join('\n')}`;
  } else {
    const indexContent = readKnowledgeIndex();
    if (indexContent && indexContent.trim() !== '') {
      const truncated = indexContent.length > MAX_INDEX_FALLBACK_CHARS;
      const excerpt = truncated ? indexContent.slice(0, MAX_INDEX_FALLBACK_CHARS) : indexContent;
      indexFallbackContext = `\n\nNo candidate pages were pre-resolved. Pick pages from this ${truncated ? 'truncated ' : ''}excerpt of knowledge/index.md instead of reading the full index:\n${excerpt}${truncated ? '\n[index excerpt truncated]' : ''}`;
    }
  }

  const vaultContext = vaultResults.length > 0
    ? `\n\nBroader vault search results:\n${vaultResults.map((r) => `- ${r.file}: ${r.content}`).join('\n')}`
    : '';

  const prompt = `Answer the following question using the knowledge base and vault.

Question: ${question}

Follow the query workflow:
1. Identify relevant wiki pages from the pre-resolved candidates or index excerpt below — do NOT read knowledge/index.md (it is very large; the relevant rows are already provided). If neither is present, locate pages with grep/glob over knowledge/wiki/
2. Read those wiki pages for detailed information — check their YAML frontmatter for related pages to explore
3. Search the vault with grep for additional context from personal notes
4. Synthesize an answer with [[wikilink]] citations to your sources${candidateContext}${indexFallbackContext}${vaultContext}`;

  const result = await runAgent('kb-query', prompt, deps.agentTimeoutMs, undefined, true);

  if (result.error) {
    log.error('Query failed', { error: result.error });
    return { success: false, answer: `Query error: ${result.error}` };
  }

  return { success: true, answer: result.text || 'No answer generated.' };
}
