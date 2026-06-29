import { posix as pathPosix } from 'node:path';
import { errText, err, ok, type McpTextResult } from './types.js';

export interface IndexedLine {
  file: string;
  line: number;
  content: string;
}

export interface FollowWikilinksInput {
  sourceFile?: string;
  text?: string;
  maxDepth?: number;
  maxResults?: number;
}

export interface FollowWikilinksDeps {
  getVaultIndexStatus: () => { ready: boolean; status: string };
  queryVaultIndex: (
    query: string,
    options?: { directory?: string; maxResults?: number },
  ) => IndexedLine[];
  sanitizeError?: (message: string) => string;
}

interface FileDoc {
  file: string;
  content: string;
}

interface LinkRef {
  raw: string;
  target: string;
}

const DEFAULT_MAX_DEPTH = 1;
const DEFAULT_MAX_RESULTS = 10;
const MAX_DEPTH_CAP = 5;
const MAX_RESULTS_CAP = 50;
const WARM_CORPUS_LINE_CAP = 250_000;
const WIKILINK_RE = /\[\[([^\]\n]+?)\]\]/g;

function normalizeSourceFile(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith('/') || trimmed.includes('\\')) return null;

  const normalized = pathPosix.normalize(trimmed).replace(/^\/+/, '');
  if (!normalized || normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
    return null;
  }

  return normalized;
}

function normalizeLimit(
  value: number | undefined,
  fallback: number,
  cap: number,
  label: string,
): { value: number } | { error: string } {
  const raw = value ?? fallback;
  if (!Number.isFinite(raw) || Math.floor(raw) !== raw || raw < 1 || raw > cap) {
    return { error: `${label} must be an integer between 1 and ${cap}.` };
  }
  return { value: raw };
}

function normalizeLinkTarget(value: string): string {
  return value.split('|')[0]!.split('#')[0]!.trim();
}

function keyFor(value: string): string {
  return value
    .trim()
    .replace(/\.md$/i, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function titleFromContent(content: string): string | null {
  for (const line of content.split('\n')) {
    const match = /^#\s+(.+?)\s*$/.exec(line);
    if (match) return match[1]!.trim();
  }
  return null;
}

function extractLinks(text: string): LinkRef[] {
  const links: LinkRef[] = [];
  const seen = new Set<string>();

  for (const match of text.matchAll(WIKILINK_RE)) {
    const raw = match[0]!;
    const target = normalizeLinkTarget(match[1]!);
    if (!target) continue;

    const dedupeKey = keyFor(target);
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    links.push({ raw, target });
  }

  return links;
}

function buildFileDocs(lines: IndexedLine[]): Map<string, FileDoc> {
  const grouped = new Map<string, IndexedLine[]>();
  for (const line of lines) {
    const group = grouped.get(line.file) ?? [];
    group.push(line);
    grouped.set(line.file, group);
  }

  const docs = new Map<string, FileDoc>();
  for (const [file, fileLines] of grouped) {
    fileLines.sort((a, b) => a.line - b.line);
    docs.set(file, {
      file,
      content: fileLines.map((line) => line.content).join('\n'),
    });
  }
  return docs;
}

function addAlias(aliases: Map<string, FileDoc>, alias: string | null, doc: FileDoc): void {
  if (!alias) return;
  const key = keyFor(alias);
  if (!key || aliases.has(key)) return;
  aliases.set(key, doc);
}

function buildAliasMap(docs: Map<string, FileDoc>): Map<string, FileDoc> {
  const aliases = new Map<string, FileDoc>();
  for (const doc of docs.values()) {
    const withoutExt = doc.file.replace(/\.md$/i, '');
    const base = pathPosix.basename(withoutExt);

    addAlias(aliases, withoutExt, doc);
    addAlias(aliases, base, doc);
    addAlias(aliases, titleFromContent(doc.content), doc);
  }
  return aliases;
}

function validateInput(input: FollowWikilinksInput): {
  sourceFile?: string;
  text?: string;
  maxDepth: number;
  maxResults: number;
} | { error: string } {
  const text = typeof input.text === 'string' ? input.text.trim() : '';
  let sourceFile: string | undefined;

  if (typeof input.sourceFile === 'string' && input.sourceFile.trim()) {
    const normalized = normalizeSourceFile(input.sourceFile);
    if (!normalized) return { error: 'sourceFile must be a vault-relative markdown path.' };
    sourceFile = normalized;
  }

  if (!sourceFile && !text) {
    return { error: 'follow_wikilinks requires either sourceFile or text.' };
  }

  const depth = normalizeLimit(input.maxDepth, DEFAULT_MAX_DEPTH, MAX_DEPTH_CAP, 'maxDepth');
  if ('error' in depth) return depth;

  const results = normalizeLimit(input.maxResults, DEFAULT_MAX_RESULTS, MAX_RESULTS_CAP, 'maxResults');
  if ('error' in results) return results;

  return {
    sourceFile,
    text: text || undefined,
    maxDepth: depth.value,
    maxResults: results.value,
  };
}

export async function followWikilinks(
  input: FollowWikilinksInput,
  deps: FollowWikilinksDeps,
): Promise<McpTextResult> {
  const clean = deps.sanitizeError ?? ((s: string) => s);
  const validated = validateInput(input);
  if ('error' in validated) return err(validated.error);

  const status = deps.getVaultIndexStatus();
  if (!status.ready) {
    return err(`warm vault index is not ready for follow_wikilinks (status: ${status.status}).`);
  }

  try {
    const lines = deps.queryVaultIndex('', { maxResults: WARM_CORPUS_LINE_CAP });
    const docs = buildFileDocs(lines);
    const aliases = buildAliasMap(docs);
    const sourceParts: string[] = [];

    if (validated.text) sourceParts.push(validated.text);
    if (validated.sourceFile) {
      const sourceDoc = docs.get(validated.sourceFile);
      if (!sourceDoc) {
        return err(`sourceFile was not found in the warm vault index: ${validated.sourceFile}`);
      }
      sourceParts.push(sourceDoc.content);
    }

    const initialLinks = extractLinks(sourceParts.join('\n'));
    const unresolvedLinks: string[] = [];
    const unresolvedKeys = new Set<string>();
    const visitedFiles = new Set<string>();
    const queuedKeys = new Set<string>();
    const results: Array<{
      link: string;
      targetFile: string;
      depth: number;
      content: string;
    }> = [];

    const queue = initialLinks.map((link) => ({ link, depth: 1 }));
    for (const item of queue) queuedKeys.add(`${keyFor(item.link.target)}:${item.depth}`);

    for (let index = 0; index < queue.length && results.length < validated.maxResults; index += 1) {
      const { link, depth } = queue[index]!;
      if (depth > validated.maxDepth) continue;

      const targetKey = keyFor(link.target);
      const target = aliases.get(targetKey);
      if (!target) {
        if (!unresolvedKeys.has(targetKey)) {
          unresolvedKeys.add(targetKey);
          unresolvedLinks.push(link.target);
        }
        continue;
      }

      if (visitedFiles.has(target.file)) continue;
      visitedFiles.add(target.file);
      results.push({
        link: link.target,
        targetFile: target.file,
        depth,
        content: target.content,
      });

      if (depth >= validated.maxDepth || results.length >= validated.maxResults) continue;
      for (const nested of extractLinks(target.content)) {
        const nestedKey = `${keyFor(nested.target)}:${depth + 1}`;
        if (queuedKeys.has(nestedKey)) continue;
        queuedKeys.add(nestedKey);
        queue.push({ link: nested, depth: depth + 1 });
      }
    }

    return ok(JSON.stringify({
      source: 'warm',
      sourceFile: validated.sourceFile,
      sourceLinks: initialLinks.map((link) => link.raw),
      maxDepth: validated.maxDepth,
      maxResults: validated.maxResults,
      results,
      unresolvedLinks,
    }, null, 2));
  } catch (unexpected) {
    return err(`follow_wikilinks failed: ${clean(errText(unexpected))}`);
  }
}
