import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

export interface KnowledgeIndexRepairResult {
  added: number;
  addedPages: string[];
  detail: string;
}

interface WikiPage {
  path: string;
  category: string;
  slug: string;
  summary: string;
}

const KNOWN_CATEGORY_DIRS = new Set(['entities', 'concepts', 'topics']);
const CATEGORY_ORDER = ['Entities', 'Concepts', 'Topics', 'Other'];

export function repairKnowledgeIndex(vaultDir: string): KnowledgeIndexRepairResult {
  const wikiPages = listWikiPages(vaultDir);
  const indexPath = join(vaultDir, 'knowledge', 'index.md');
  const original = existsSync(indexPath) ? readFileSync(indexPath, 'utf8') : '# Knowledge Index\n';
  const existingLinks = parseExistingWikiLinks(original);
  const missingPages = wikiPages.filter((page) => !isPageIndexed(page, existingLinks));

  if (missingPages.length === 0) {
    return { added: 0, addedPages: [], detail: 'No missing wiki index entries' };
  }

  const grouped = new Map<string, string[]>();
  for (const page of missingPages) {
    const entries = grouped.get(page.category) ?? [];
    entries.push(`- [[${page.slug}]] — ${page.summary}`);
    grouped.set(page.category, entries);
  }

  let updated = original;
  const categories = [...grouped.keys()].sort((a, b) => categoryRank(a) - categoryRank(b) || a.localeCompare(b));
  for (const category of categories) {
    updated = insertIndexEntries(updated, category, grouped.get(category)!.sort());
  }

  mkdirSync(dirname(indexPath), { recursive: true });
  writeFileSync(indexPath, updated, 'utf8');

  const addedPages = missingPages.map((page) => page.path).sort();
  return {
    added: addedPages.length,
    addedPages,
    detail: `${addedPages.length} missing wiki index entr${addedPages.length === 1 ? 'y' : 'ies'} restored`,
  };
}

function listWikiPages(vaultDir: string): WikiPage[] {
  const root = join(vaultDir, 'knowledge', 'wiki');
  const files: string[] = [];

  function walk(dir: string): void {
    let entries: Dirent<string>[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        files.push(toVaultRelative(vaultDir, fullPath));
      }
    }
  }

  try {
    if (statSync(root).isDirectory()) walk(root);
  } catch {
    return [];
  }

  return files.sort().map((file) => {
    const segments = file.split('/');
    const categoryDir = segments[2] ?? '';
    const slug = segments[segments.length - 1]!.replace(/\.md$/i, '');
    return {
      path: file,
      category: categoryForDir(categoryDir),
      slug,
      summary: summarizePage(join(vaultDir, file), slug),
    };
  });
}

function categoryForDir(dir: string): string {
  if (!KNOWN_CATEGORY_DIRS.has(dir)) return 'Other';
  return titleCase(dir);
}

function titleCase(value: string): string {
  return value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(' ');
}

function summarizePage(fullPath: string, slug: string): string {
  let raw: string;
  try {
    raw = readFileSync(fullPath, 'utf8');
  } catch {
    return slug;
  }
  const content = stripFrontmatter(raw);
  const h1 = /^#\s+(.+?)\s*$/m.exec(content)?.[1];
  if (h1) return cleanSummary(h1) || slug;

  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const sentence = /^(.+?[.!?])(?:\s|$)/.exec(trimmed)?.[1] ?? trimmed;
    const cleaned = cleanSummary(sentence);
    if (cleaned) return cleaned;
  }
  return slug;
}

function stripFrontmatter(raw: string): string {
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(raw);
  return match ? raw.slice(match[0].length) : raw;
}

function cleanSummary(value: string): string {
  return value
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[*_`>#-]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseExistingWikiLinks(indexContent: string): Set<string> {
  const links = new Set<string>();
  const re = /\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(indexContent)) !== null) {
    const normalized = normalizeLinkTarget(match[1]!);
    if (!normalized) continue;
    links.add(normalized);
    links.add(basename(normalized));
    if (normalized.startsWith('wiki/')) links.add(normalized.slice('wiki/'.length));
    links.add(`wiki/${normalized}`);
  }
  return links;
}

function isPageIndexed(page: WikiPage, existingLinks: Set<string>): boolean {
  const wikiPath = page.path.replace(/^knowledge\//, '').replace(/\.md$/i, '');
  const localWikiPath = wikiPath.replace(/^wiki\//, '');
  return (
    existingLinks.has(page.slug) ||
    existingLinks.has(wikiPath) ||
    existingLinks.has(localWikiPath)
  );
}

function normalizeLinkTarget(target: string): string {
  return target
    .trim()
    .replace(/\\/g, '/')
    .replace(/^knowledge\//, '')
    .replace(/\.md$/i, '')
    .replace(/^\/+|\/+$/g, '');
}

function basename(value: string): string {
  const parts = value.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? value;
}

function insertIndexEntries(content: string, category: string, entries: string[]): string {
  const hasTrailingNewline = content.endsWith('\n');
  const lines = content.split(/\r?\n/);
  if (hasTrailingNewline) lines.pop();

  const headingRe = new RegExp(`^##\\s+${escapeRegExp(category)}\\s*$`, 'i');
  const headingIdx = lines.findIndex((line) => headingRe.test(line));
  if (headingIdx === -1) {
    while (lines.length > 0 && lines[lines.length - 1]!.trim() === '') lines.pop();
    if (lines.length > 0) lines.push('');
    lines.push(`## ${category}`, '', ...entries);
    return `${lines.join('\n')}\n`;
  }

  let endIdx = lines.length;
  for (let i = headingIdx + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i]!)) {
      endIdx = i;
      break;
    }
  }
  let insertionIdx = endIdx;
  while (insertionIdx > headingIdx + 1 && lines[insertionIdx - 1]!.trim() === '') {
    insertionIdx--;
  }

  const before = lines.slice(0, insertionIdx);
  const after = lines.slice(insertionIdx);
  const spacer = insertionIdx === headingIdx + 1 ? [''] : [];
  return `${[...before, ...spacer, ...entries, ...after].join('\n')}${hasTrailingNewline ? '\n' : ''}`;
}

function categoryRank(category: string): number {
  const index = CATEGORY_ORDER.indexOf(category);
  return index === -1 ? CATEGORY_ORDER.length : index;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function toVaultRelative(root: string, fullPath: string): string {
  return relative(root, fullPath).split(sep).join('/');
}
