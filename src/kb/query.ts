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

/** Bounds on the pre-fetched candidate page bodies stuffed into the synthesis
 *  prompt: at most N pages, per-page cap, and an overall budget so a run of
 *  large pages can't blow up the prompt. */
const MAX_PREFETCH_PAGES = 8;
const MAX_PAGE_BODY_CHARS = 8_000;
const MAX_TOTAL_BODY_CHARS = 48_000;

/** Question words and glue that carry no search signal. */
const STOPWORDS = new Set([
  'who', 'what', 'when', 'where', 'why', 'how', 'which', 'whose',
  'is', 'are', 'was', 'were', 'be', 'been', 'does', 'did', 'has', 'have', 'had',
  'the', 'a', 'an', 'of', 'in', 'on', 'at', 'to', 'from', 'by', 'for', 'with',
  'and', 'or', 'not', 'but', 'about', 'into', 'over', 'under', 'between',
  'my', 'me', 'i', 'you', 'your', 'it', 'its', 'his', 'her', 'their', 'our',
  'this', 'that', 'these', 'those', 'there', 'here',
  'do', 'can', 'could', 'should', 'would', 'will', 'may', 'might',
  'tell', 'explain', 'define', 'describe', 'compare', 'know', 'mean', 'use',
]);

/** Distill a natural-language question into a ripgrep alternation of its
 *  content-bearing terms (`paul|graham`). A raw question almost never appears
 *  verbatim in page text, so searching it literally resolves nothing — the
 *  alternation is what gives the deterministic retrieval real recall. Returns
 *  null when no content-bearing term survives (callers fall back to the raw
 *  question). */
function searchPatternFor(question: string): string | null {
  const terms = question
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
  if (terms.length === 0) return null;
  return [...new Set(terms)]
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
}

/** Wiki page slug for a vault-relative path: basename minus `.md`. */
function slugOf(file: string): string {
  const base = file.split('/').at(-1) ?? file;
  return base.replace(/\.md$/i, '');
}

/** Best-effort vault read; null when missing or unreadable. */
function readVaultFileSafe(relativePath: string): string | null {
  try {
    return readVaultFile(relativePath) ?? null;
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
  const searchPattern = searchPatternFor(question) ?? question;
  const filteredResults = searchWithFilter(
    searchPattern,
    typeFilter ? { type: typeFilter } : undefined,
    { maxResults: 10 },
  );

  // Broader vault search for additional context
  const vaultResults = deps.searchVault
    ? await deps.searchVault(searchPattern, { maxResults: 10 })
    : searchVault(searchPattern, { maxResults: 10 });

  // Retrieval happens entirely here, deterministically: candidates from the
  // filtered search (with their index-row summaries looked up in-process),
  // full bodies of the top candidate pages, and broad-vault snippets are all
  // stuffed into the prompt. The tool-less kb-query agent then synthesizes in
  // a single pass — it never reads the ~185K-token knowledge/index.md or
  // re-does retrieval with its own tools. Only when the search finds nothing
  // does the prompt carry a bounded index excerpt instead.
  let candidateContext = '';
  let bodiesContext = '';
  let indexFallbackContext = '';
  if (filteredResults.length > 0) {
    const candidateFiles = [...new Set(filteredResults.map((r) => r.file))];
    const indexContent = readVaultFileSafe('knowledge/index.md');
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
    candidateContext = `\n\nPre-resolved candidate wiki pages (deterministic index search, type: ${typeFilter || 'all'}):\n${candidateLines.join('\n')}`;

    const bodySections: string[] = [];
    let bodyBudget = MAX_TOTAL_BODY_CHARS;
    for (const file of candidateFiles.slice(0, MAX_PREFETCH_PAGES)) {
      if (bodyBudget <= 0) break;
      const body = readVaultFileSafe(file);
      if (!body) continue;
      const cap = Math.min(MAX_PAGE_BODY_CHARS, bodyBudget);
      const truncated = body.length > cap;
      const excerpt = truncated ? body.slice(0, cap) : body;
      bodyBudget -= excerpt.length;
      bodySections.push(`=== ${file} ([[${slugOf(file)}]]) ===\n${excerpt}${truncated ? '\n[page body truncated]' : ''}`);
    }
    if (bodySections.length > 0) {
      bodiesContext = `\n\nPre-fetched wiki page bodies:\n\n${bodySections.join('\n\n')}`;
    }
  } else {
    const indexContent = readVaultFileSafe('knowledge/index.md');
    if (indexContent && indexContent.trim() !== '') {
      const truncated = indexContent.length > MAX_INDEX_FALLBACK_CHARS;
      const excerpt = truncated ? indexContent.slice(0, MAX_INDEX_FALLBACK_CHARS) : indexContent;
      indexFallbackContext = `\n\nNo candidate pages were pre-resolved. This ${truncated ? 'truncated ' : ''}excerpt of knowledge/index.md names pages that exist but whose content is not in your context:\n${excerpt}${truncated ? '\n[index excerpt truncated]' : ''}`;
    }
  }

  const vaultContext = vaultResults.length > 0
    ? `\n\nBroader vault search results:\n${vaultResults.map((r) => `- ${r.file}: ${r.content}`).join('\n')}`
    : '';

  const prompt = `Answer the following question using ONLY the pre-retrieved knowledge base and vault context below.

Question: ${question}

Instructions:
1. Synthesize the answer in a single pass from the provided context — you have no tools; retrieval has already been done for you
2. Cite specific pages with [[wikilink]] citations
3. Note confidence (well-documented vs. sparse coverage) and call out conflicting or insufficient context
4. If the context contains no relevant information, say so clearly — don't make things up${candidateContext}${bodiesContext}${indexFallbackContext}${vaultContext}`;

  const result = await runAgent('kb-query', prompt, deps.agentTimeoutMs, undefined, true);

  if (result.error) {
    log.error('Query failed', { error: result.error });
    return { success: false, answer: `Query error: ${result.error}` };
  }

  return { success: true, answer: result.text || 'No answer generated.' };
}
