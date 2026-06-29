import { errText, err, ok, type McpTextResult } from './types.js';

export interface IndexedLine {
  file: string;
  line: number;
  content: string;
}

export interface TagDateQueryInput {
  tag?: string;
  startDate?: string;
  endDate?: string;
  maxResults?: number;
}

export interface TagDateQueryDeps {
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
  lines: IndexedLine[];
  frontmatter: string[];
}

interface QueryResult {
  file: string;
  date: string;
  tags: string[];
  content: string;
}

const DEFAULT_MAX_RESULTS = 20;
const MAX_RESULTS_CAP = 50;
const WARM_CORPUS_LINE_CAP = 250_000;
const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const JOURNAL_FILE_RE = /^journals\/(\d{4})_(\d{2})_(\d{2})\.md$/;
const TAG_RE = /(^|[^\p{L}\p{N}_/-])#([\p{L}\p{N}_/-]+)/gu;

function parseIsoDate(value: string): string | null {
  const match = ISO_DATE_RE.exec(value);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
  ) {
    return null;
  }

  return value;
}

function normalizeTag(value: string): string | null {
  const normalized = value.trim().replace(/^#+/, '').toLowerCase();
  if (!normalized || /\s/.test(normalized)) return null;
  return normalized;
}

function normalizeMaxResults(value: number | undefined): { value: number } | { error: string } {
  const raw = value ?? DEFAULT_MAX_RESULTS;
  if (!Number.isFinite(raw) || Math.floor(raw) !== raw || raw < 1) {
    return { error: `maxResults must be an integer between 1 and ${MAX_RESULTS_CAP}.` };
  }
  return { value: Math.min(raw, MAX_RESULTS_CAP) };
}

function dateFromJournalFile(file: string): string | null {
  const match = JOURNAL_FILE_RE.exec(file);
  if (!match) return null;
  return `${match[1]}-${match[2]}-${match[3]}`;
}

function extractFrontmatter(lines: IndexedLine[]): string[] {
  if (lines[0]?.content !== '---') return [];

  const frontmatter: string[] = [];
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i]!.content === '---') return frontmatter;
    frontmatter.push(lines[i]!.content);
  }
  return [];
}

function buildFileDocs(lines: IndexedLine[]): FileDoc[] {
  const grouped = new Map<string, IndexedLine[]>();
  for (const line of lines) {
    const group = grouped.get(line.file) ?? [];
    group.push(line);
    grouped.set(line.file, group);
  }

  const docs: FileDoc[] = [];
  for (const [file, fileLines] of grouped) {
    fileLines.sort((a, b) => a.line - b.line);
    docs.push({
      file,
      lines: fileLines,
      content: fileLines.map((line) => line.content).join('\n'),
      frontmatter: extractFrontmatter(fileLines),
    });
  }

  docs.sort((a, b) => a.file.localeCompare(b.file));
  return docs;
}

function extractInlineTags(text: string): string[] {
  const tags = new Set<string>();
  for (const match of text.matchAll(TAG_RE)) {
    const tag = normalizeTag(match[2]!);
    if (tag) tags.add(tag);
  }
  return [...tags].sort((a, b) => a.localeCompare(b));
}

function parseFrontmatterTags(frontmatter: string[]): string[] {
  const tags = new Set<string>();

  for (let i = 0; i < frontmatter.length; i += 1) {
    const line = frontmatter[i]!;
    const inline = /^tags:\s*\[(.*)\]\s*$/.exec(line);
    if (inline) {
      for (const raw of inline[1]!.split(',')) {
        const tag = normalizeTag(raw.trim().replace(/^['"]|['"]$/g, ''));
        if (tag) tags.add(tag);
      }
      continue;
    }

    const scalar = /^tags:\s*(\S.*?)\s*$/.exec(line);
    if (scalar) {
      const tag = normalizeTag(scalar[1]!.replace(/^['"]|['"]$/g, ''));
      if (tag) tags.add(tag);
      continue;
    }

    if (/^tags:\s*$/.test(line)) {
      for (let j = i + 1; j < frontmatter.length; j += 1) {
        const listItem = /^\s*-\s*(\S.*?)\s*$/.exec(frontmatter[j]!);
        if (!listItem) break;
        const tag = normalizeTag(listItem[1]!.replace(/^['"]|['"]$/g, ''));
        if (tag) tags.add(tag);
        i = j;
      }
    }
  }

  return [...tags].sort((a, b) => a.localeCompare(b));
}

function parseFrontmatterDate(frontmatter: string[]): string | null {
  for (const line of frontmatter) {
    const match = /^date:\s*['"]?(\d{4}-\d{2}-\d{2})['"]?\s*$/.exec(line);
    if (match) return parseIsoDate(match[1]!) ?? null;
  }
  return null;
}

function mergeTags(...tagLists: string[][]): string[] {
  const tags = new Set<string>();
  for (const list of tagLists) {
    for (const tag of list) tags.add(tag);
  }
  return [...tags].sort((a, b) => a.localeCompare(b));
}

function withinRange(
  date: string,
  startDate: string | undefined,
  endDate: string | undefined,
): boolean {
  if (startDate && date < startDate) return false;
  if (endDate && date > endDate) return false;
  return true;
}

function stripFrontmatter(doc: FileDoc): string {
  if (doc.frontmatter.length === 0) return doc.content;
  const endLine = doc.frontmatter.length + 2;
  return doc.lines
    .filter((line) => line.line > endLine)
    .map((line) => line.content)
    .join('\n');
}

function validateInput(input: TagDateQueryInput): {
  tag?: string;
  startDate?: string;
  endDate?: string;
  maxResults: number;
} | { error: string } {
  let tag: string | undefined;
  if (typeof input.tag === 'string' && input.tag.trim()) {
    const normalized = normalizeTag(input.tag);
    if (!normalized) return { error: 'tag must be a single tag name, with or without a leading #.' };
    tag = normalized;
  }

  let startDate: string | undefined;
  if (typeof input.startDate === 'string' && input.startDate.trim()) {
    const parsed = parseIsoDate(input.startDate);
    if (!parsed) return { error: 'startDate must be a valid ISO date in YYYY-MM-DD format.' };
    startDate = parsed;
  }

  let endDate: string | undefined;
  if (typeof input.endDate === 'string' && input.endDate.trim()) {
    const parsed = parseIsoDate(input.endDate);
    if (!parsed) return { error: 'endDate must be a valid ISO date in YYYY-MM-DD format.' };
    endDate = parsed;
  }

  if (startDate && endDate && startDate > endDate) {
    return { error: 'startDate must be on or before endDate.' };
  }

  if (!tag && !startDate && !endDate) {
    return { error: 'tag_date_query requires at least one of tag, startDate, or endDate.' };
  }

  const maxResults = normalizeMaxResults(input.maxResults);
  if ('error' in maxResults) return maxResults;

  return {
    tag,
    startDate,
    endDate,
    maxResults: maxResults.value,
  };
}

function buildFilters(validated: {
  tag?: string;
  startDate?: string;
  endDate?: string;
}): { tag?: string; startDate?: string; endDate?: string } {
  const filters: { tag?: string; startDate?: string; endDate?: string } = {};
  if (validated.tag) filters.tag = validated.tag;
  if (validated.startDate) filters.startDate = validated.startDate;
  if (validated.endDate) filters.endDate = validated.endDate;
  return filters;
}

function matchingResults(
  docs: FileDoc[],
  filters: { tag?: string; startDate?: string; endDate?: string },
  maxResults: number,
): { results: QueryResult[]; truncated: boolean } {
  const results: QueryResult[] = [];
  let matchedCount = 0;

  for (const doc of docs) {
    const fileDate = parseFrontmatterDate(doc.frontmatter) ?? dateFromJournalFile(doc.file);
    const frontmatterTags = parseFrontmatterTags(doc.frontmatter);
    const fileTags = mergeTags(frontmatterTags, extractInlineTags(doc.content));

    if (frontmatterTags.length > 0 || doc.frontmatter.length > 0) {
      if (fileDate && withinRange(fileDate, filters.startDate, filters.endDate)) {
        const matchesTag = !filters.tag || fileTags.includes(filters.tag);
        if (matchesTag) {
          matchedCount += 1;
          if (results.length < maxResults) {
            results.push({
              file: doc.file,
              date: fileDate,
              tags: fileTags,
              content: stripFrontmatter(doc),
            });
          }
        }
      }
      continue;
    }

    if (!fileDate || !withinRange(fileDate, filters.startDate, filters.endDate)) continue;

    if (!filters.tag) {
      matchedCount += 1;
      if (results.length < maxResults) {
        results.push({
          file: doc.file,
          date: fileDate,
          tags: fileTags,
          content: doc.content,
        });
      }
      continue;
    }

    const matchingLines = doc.lines.filter((line) => extractInlineTags(line.content).includes(filters.tag!));
    if (matchingLines.length === 0) continue;

    matchedCount += 1;
    if (results.length < maxResults) {
      results.push({
        file: doc.file,
        date: fileDate,
        tags: mergeTags(...matchingLines.map((line) => extractInlineTags(line.content))),
        content: matchingLines.map((line) => line.content).join('\n'),
      });
    }
  }

  return {
    results,
    truncated: matchedCount > results.length,
  };
}

export async function tagDateQuery(
  input: TagDateQueryInput,
  deps: TagDateQueryDeps,
): Promise<McpTextResult> {
  const clean = deps.sanitizeError ?? ((s: string) => s);
  const validated = validateInput(input);
  if ('error' in validated) return err(validated.error);

  const status = deps.getVaultIndexStatus();
  if (!status.ready) {
    return err(`warm vault index is not ready for tag_date_query (status: ${status.status}).`);
  }

  try {
    const lines = deps.queryVaultIndex('', { maxResults: WARM_CORPUS_LINE_CAP });
    const filters = buildFilters(validated);
    const { results, truncated } = matchingResults(
      buildFileDocs(lines),
      filters,
      validated.maxResults,
    );

    return ok(JSON.stringify({
      source: 'warm',
      filters,
      maxResults: validated.maxResults,
      truncated,
      results,
    }, null, 2));
  } catch (unexpected) {
    return err(`tag_date_query failed: ${clean(errText(unexpected))}`);
  }
}
