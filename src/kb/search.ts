import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import config from '../config.js';

interface SearchResult {
  file: string;
  line: number;
  content: string;
}

interface WikiFrontmatter {
  type?: string;
  tags?: string[];
  related?: string[];
  created?: string;
  'last-verified'?: string;
  'valid-until'?: string;
}

interface FilteredSearchResult extends SearchResult {
  frontmatter?: WikiFrontmatter;
}

/**
 * Full-text search across the vault using ripgrep.
 * Returns matching file paths with line content.
 */
export function searchVault(
  query: string,
  options?: { directory?: string; maxResults?: number },
): SearchResult[] {
  const searchDir = options?.directory
    ? join(config.VAULT_DIR, options.directory)
    : config.VAULT_DIR;

  // Containment guard: `directory` must stay inside the vault. Production
  // callers pass fixed literals (and the MCP vault_search schema is
  // enum-locked), but this function is now reachable from a remote surface —
  // it must be safe regardless of caller.
  const resolvedRoot = resolve(config.VAULT_DIR);
  const resolvedDir = resolve(searchDir);
  if (resolvedDir !== resolvedRoot && !resolvedDir.startsWith(resolvedRoot + sep)) {
    return [];
  }

  const maxResults = options?.maxResults ?? 20;

  try {
    const output = execFileSync(
      'rg',
      ['--json', '-i', '--max-count', '3', '--glob', '*.md', query, searchDir],
      { timeout: 10_000, maxBuffer: 1024 * 1024 },
    ).toString();

    const results: SearchResult[] = [];

    for (const line of output.split('\n')) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as {
          type: string;
          data?: {
            path?: { text?: string };
            line_number?: number;
            lines?: { text?: string };
          };
        };
        if (parsed.type === 'match' && parsed.data) {
          const filePath = parsed.data.path?.text || '';
          // Convert to relative path
          const relative = filePath.startsWith(config.VAULT_DIR)
            ? filePath.slice(config.VAULT_DIR.length + 1)
            : filePath;
          results.push({
            file: relative,
            line: parsed.data.line_number || 0,
            content: (parsed.data.lines?.text || '').trim(),
          });
        }
      } catch {
        // Skip unparseable lines
      }
    }

    return results.slice(0, maxResults);
  } catch {
    return []; // No matches or rg not available
  }
}

/**
 * Full-text search across one product repository using ripgrep.
 * Returns repo-relative matching file paths with line content.
 */
export function searchRepo(
  query: string,
  options: { repoPath: string; maxResults?: number },
): SearchResult[] {
  const resolvedRoot = resolve(options.repoPath);
  const maxResults = options.maxResults ?? 20;

  try {
    const output = execFileSync(
      'rg',
      ['--json', '-i', '--max-count', '3', query, resolvedRoot],
      { timeout: 10_000, maxBuffer: 1024 * 1024 },
    ).toString();

    const results: SearchResult[] = [];

    for (const line of output.split('\n')) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as {
          type: string;
          data?: {
            path?: { text?: string };
            line_number?: number;
            lines?: { text?: string };
          };
        };
        if (parsed.type !== 'match' || !parsed.data) continue;

        const filePath = parsed.data.path?.text || '';
        const resolvedFile = resolve(filePath);
        if (resolvedFile !== resolvedRoot && !resolvedFile.startsWith(resolvedRoot + sep)) {
          continue;
        }

        const relative = resolvedFile === resolvedRoot
          ? filePath
          : resolvedFile.slice(resolvedRoot.length + 1);
        results.push({
          file: relative,
          line: parsed.data.line_number || 0,
          content: (parsed.data.lines?.text || '').trim(),
        });
      } catch {
        // Skip unparseable lines
      }
    }

    return results.slice(0, maxResults);
  } catch {
    return [];
  }
}

export interface RankedWikiPage {
  /** Vault-relative path (knowledge/wiki/<category>/<slug>.md). */
  file: string;
  score: number;
  matchedTerms: string[];
}

/**
 * Rank wiki pages by weighted distinct-term coverage. Each term is matched
 * with a fast `rg -il` file-list search over knowledge/wiki; a term's weight
 * is 1 / (number of files it matches), so rare, distinctive terms dominate
 * and near-ubiquitous words contribute almost nothing. This is what keeps a
 * long multi-clause question's generic words ("notes", "conversations") from
 * drowning its rare ones ("calldata", a person's surname) — an unweighted
 * alternation search returns whatever files ripgrep walks first.
 */
export function rankWikiPages(
  terms: string[],
  opts?: { type?: string; maxResults?: number },
): RankedWikiPage[] {
  const maxResults = opts?.maxResults ?? 10;
  const wikiDir = join(config.VAULT_DIR, 'knowledge', 'wiki');
  const scores = new Map<string, { score: number; matchedTerms: string[] }>();

  for (const term of terms) {
    let output: string;
    try {
      output = execFileSync(
        'rg',
        ['-il', '--glob', '*.md', '--fixed-strings', term, wikiDir],
        { timeout: 10_000, maxBuffer: 1024 * 1024 },
      ).toString();
    } catch {
      continue; // no matches for this term, or rg unavailable
    }
    const files = output.split('\n').filter(Boolean);
    if (files.length === 0) continue;
    const weight = 1 / files.length;
    for (const filePath of files) {
      const relative = filePath.startsWith(config.VAULT_DIR)
        ? filePath.slice(config.VAULT_DIR.length + 1)
        : filePath;
      const entry = scores.get(relative) ?? { score: 0, matchedTerms: [] };
      entry.score += weight;
      entry.matchedTerms.push(term);
      scores.set(relative, entry);
    }
  }

  const ranked = [...scores.entries()]
    .map(([file, entry]) => ({ file, ...entry }))
    .sort((a, b) => b.score - a.score);

  if (!opts?.type) return ranked.slice(0, maxResults);

  const filtered: RankedWikiPage[] = [];
  for (const page of ranked) {
    if (parseFrontmatter(page.file)?.type !== opts.type) continue;
    filtered.push(page);
    if (filtered.length >= maxResults) break;
  }
  return filtered;
}

/**
 * Fetch matching lines from a specific set of vault-relative files (used to
 * pull snippets for already-ranked candidate pages, rather than whatever
 * files a vault-wide search happens to visit first).
 */
export function searchInFiles(
  pattern: string,
  files: string[],
  options?: { maxPerFile?: number },
): SearchResult[] {
  if (files.length === 0) return [];
  const maxPerFile = options?.maxPerFile ?? 2;
  const resolvedRoot = resolve(config.VAULT_DIR);
  const targets: string[] = [];
  for (const file of files) {
    const full = resolve(join(config.VAULT_DIR, file));
    if (full !== resolvedRoot && !full.startsWith(resolvedRoot + sep)) continue;
    targets.push(full);
  }
  if (targets.length === 0) return [];

  try {
    const output = execFileSync(
      'rg',
      ['--json', '-i', '--max-count', String(maxPerFile), pattern, ...targets],
      { timeout: 10_000, maxBuffer: 1024 * 1024 },
    ).toString();

    const results: SearchResult[] = [];
    for (const line of output.split('\n')) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as {
          type: string;
          data?: {
            path?: { text?: string };
            line_number?: number;
            lines?: { text?: string };
          };
        };
        if (parsed.type !== 'match' || !parsed.data) continue;
        const filePath = parsed.data.path?.text || '';
        const relative = filePath.startsWith(config.VAULT_DIR)
          ? filePath.slice(config.VAULT_DIR.length + 1)
          : filePath;
        results.push({
          file: relative,
          line: parsed.data.line_number || 0,
          content: (parsed.data.lines?.text || '').trim(),
        });
      } catch {
        // Skip unparseable lines
      }
    }
    return results;
  } catch {
    return [];
  }
}

/**
 * Parse YAML frontmatter from a markdown file.
 * Returns undefined if no frontmatter found.
 */
export function parseFrontmatter(filePath: string): WikiFrontmatter | undefined {
  try {
    const fullPath = filePath.startsWith('/')
      ? filePath
      : join(config.VAULT_DIR, filePath);
    const content = readFileSync(fullPath, 'utf-8');

    if (!content.startsWith('---')) return undefined;
    const endIdx = content.indexOf('---', 3);
    if (endIdx === -1) return undefined;

    const yaml = content.slice(3, endIdx).trim();
    const fm: WikiFrontmatter = {};

    for (const line of yaml.split('\n')) {
      const colonIdx = line.indexOf(':');
      if (colonIdx === -1) continue;
      const key = line.slice(0, colonIdx).trim();
      const rawVal = line.slice(colonIdx + 1).trim();

      if (key === 'type') {
        fm.type = rawVal;
      } else if (key === 'tags' || key === 'related') {
        // Parse YAML array: [a, b, c]
        const match = rawVal.match(/^\[(.+)\]$/);
        if (match) {
          fm[key] = match[1]!.split(',').map((s) => s.trim());
        }
      } else if (key === 'created' || key === 'last-verified' || key === 'valid-until') {
        fm[key] = rawVal;
      }
    }

    return fm;
  } catch {
    return undefined;
  }
}

/**
 * Search the wiki with optional metadata filtering.
 * Filters results by type and/or tags using YAML frontmatter.
 */
export function searchWithFilter(
  query: string,
  filters?: { type?: string; tags?: string[] },
  options?: { maxResults?: number },
): FilteredSearchResult[] {
  // Search only within the wiki directory
  const results = searchVault(query, {
    directory: 'knowledge/wiki',
    maxResults: (options?.maxResults ?? 20) * 3, // Over-fetch to account for filtering
  });

  if (!filters?.type && !filters?.tags?.length) {
    return results.slice(0, options?.maxResults ?? 20);
  }

  const filtered: FilteredSearchResult[] = [];

  for (const result of results) {
    const fm = parseFrontmatter(result.file);
    if (!fm) continue;

    if (filters.type && fm.type !== filters.type) continue;

    if (filters.tags?.length) {
      const pageTags = fm.tags || [];
      const hasMatchingTag = filters.tags.some((t) => pageTags.includes(t));
      if (!hasMatchingTag) continue;
    }

    filtered.push({ ...result, frontmatter: fm });
    if (filtered.length >= (options?.maxResults ?? 20)) break;
  }

  return filtered;
}
