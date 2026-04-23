import config from '../config.js';
import { readVaultFile, vaultFileExists } from '../vault/files.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('entity-extract');

/** The entity kind drives where the canonical wiki page lives and whether
 *  match casing is strict. Person names must keep their original casing
 *  (so "Stripe" does not match "stripes" inside "stripes of fabric"); book
 *  titles and place names are looser but still word-boundary-bounded. */
export type EntityKind = 'person' | 'book' | 'place';

export interface AliasEntry {
  /** kebab-case slug rooted at the wiki's entities/ directory, e.g.
   *  "patrick-collison". Used as the bare identifier in `related:`
   *  frontmatter and inside `[[slug]]` wikilinks. */
  canonicalSlug: string;
  /** One or more surface forms the entity appears under in prose. Order
   *  is not significant here — the matcher sorts longest-first across the
   *  whole alias set so "Patrick Collison" beats "Patrick". */
  aliases: string[];
  kind: EntityKind;
}

export interface LinkResult {
  /** Canonical slugs matched in the page's content. Deduped. Order mirrors
   *  the order mentions first appear in the content. */
  related: string[];
  /** The input content with inline wikilink substitutions applied inside
   *  `## References` / `## See also` sections only. Prose is untouched. */
  updatedContent: string;
}

/** Load the alias map from the JSON data stores + FAMILY_NAMES. Missing
 *  or malformed files are skipped with a warning; the caller always gets a
 *  valid (possibly empty) alias array. */
export function loadAliasMap(): AliasEntry[] {
  const entries: AliasEntry[] = [];

  for (const name of config.FAMILY_NAMES) {
    const trimmed = name.trim();
    if (trimmed.length === 0) continue;
    entries.push({
      canonicalSlug: slugify(trimmed),
      aliases: [trimmed],
      kind: 'person',
    });
  }

  entries.push(...readJsonEntities('pages/crm.json', 'name', 'person'));
  entries.push(...readJsonEntities('pages/books.json', 'title', 'book'));
  entries.push(...readJsonEntities('pages/places.json', 'name', 'place'));

  return mergeDuplicates(entries);
}

/** Load a JSON entity file (array-of-objects), extracting `nameField` from
 *  each entry as the alias. Tolerates missing file / malformed JSON /
 *  missing or non-string name field; each failure is logged once and the
 *  offending entry is skipped. */
function readJsonEntities(
  path: string,
  nameField: string,
  kind: EntityKind,
): AliasEntry[] {
  const raw = readVaultFile(path);
  if (raw === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    log.warn(`Malformed JSON in ${path}, skipping entities`, { error: (err as Error).message });
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: AliasEntry[] = [];
  for (const item of parsed) {
    if (item === null || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    const name = obj[nameField];
    if (typeof name !== 'string' || name.trim().length === 0) continue;
    out.push({
      canonicalSlug: slugify(name),
      aliases: [name.trim()],
      kind,
    });
  }
  return out;
}

/** If two entries have the same canonical slug, keep one entry with the
 *  union of their aliases. This happens in practice when the same person
 *  is in FAMILY_NAMES and crm.json. */
function mergeDuplicates(entries: AliasEntry[]): AliasEntry[] {
  const byCanonical = new Map<string, AliasEntry>();
  for (const entry of entries) {
    const existing = byCanonical.get(entry.canonicalSlug);
    if (!existing) {
      byCanonical.set(entry.canonicalSlug, { ...entry, aliases: [...entry.aliases] });
      continue;
    }
    for (const alias of entry.aliases) {
      if (!existing.aliases.includes(alias)) existing.aliases.push(alias);
    }
  }
  return [...byCanonical.values()];
}

/** Kebab-case slug from a human name. Lowercases, strips non-alphanumerics
 *  except spaces → dashes, collapses runs of dashes. Matches the wiki's
 *  existing slug convention used across schema.md. */
export function slugify(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip diacritics
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/** Does a canonical wiki page exist anywhere under `knowledge/wiki/` for
 *  this slug? We only link to entity pages that already exist — creating
 *  new entity pages is wiki-compiler's responsibility, not ours. Checks
 *  the three known entity subdirectories. */
function anyCanonicalPageExists(slug: string): boolean {
  return (
    vaultFileExists(`knowledge/wiki/entities/${slug}.md`)
    || vaultFileExists(`knowledge/wiki/books/${slug}.md`)
    || vaultFileExists(`knowledge/wiki/places/${slug}.md`)
  );
}

/** Identify the byte range(s) of fenced `## References` / `## See also`
 *  sections in the page. Returns [] if no such section is present. A
 *  section runs from its heading to the next `##` heading (or end of file). */
export function findReferenceRanges(content: string): { start: number; end: number }[] {
  const ranges: { start: number; end: number }[] = [];
  const headerRe = /^## *(?:references|see also|related|further reading)\s*$/gim;
  let match: RegExpExecArray | null;
  while ((match = headerRe.exec(content)) !== null) {
    const sectionStart = match.index + match[0].length;
    // Find the next `##` heading after this one.
    const nextHeaderRe = /^## /gm;
    nextHeaderRe.lastIndex = sectionStart;
    const next = nextHeaderRe.exec(content);
    const sectionEnd = next !== null ? next.index : content.length;
    ranges.push({ start: sectionStart, end: sectionEnd });
  }
  return ranges;
}

/** Match an alias inside a substring with case-aware word-boundary semantics.
 *  For `kind === 'person'`, the match must preserve the alias's capitalization
 *  exactly (so "Stripe" the company is not confused with "stripes"). For
 *  books and places, case-insensitive matching is used but the word-boundary
 *  guard still applies.
 *
 *  Exported for testing; the main linkEntities flow uses it transitively. */
export function matchAlias(
  haystack: string,
  alias: string,
  kind: EntityKind,
): RegExpExecArray | null {
  const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const flags = kind === 'person' ? '' : 'i';
  // For personal names we ALSO require the first letter of the match to be
  // capitalized — handled implicitly by case-sensitive match since aliases
  // are stored with their original casing. For books/places, flags='i'
  // relaxes casing but the word-boundary \b is still enforced.
  const re = new RegExp(`\\b${escaped}\\b`, flags);
  return re.exec(haystack);
}

/** Replace bare alias mentions inside the given range with `[[slug]]`
 *  wikilinks. Only plain occurrences — mentions already inside `[[...]]`
 *  are skipped. Returns the rewritten substring. */
function replaceInRange(
  haystack: string,
  start: number,
  end: number,
  entries: AliasEntry[],
): string {
  let region = haystack.slice(start, end);
  // Process aliases longest-first so "Patrick Collison" is substituted
  // before "Patrick".
  const flattened: { canonicalSlug: string; alias: string; kind: EntityKind }[] = [];
  for (const entry of entries) {
    for (const alias of entry.aliases) {
      flattened.push({ canonicalSlug: entry.canonicalSlug, alias, kind: entry.kind });
    }
  }
  flattened.sort((a, b) => b.alias.length - a.alias.length);

  for (const { canonicalSlug, alias, kind } of flattened) {
    const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const flags = kind === 'person' ? 'g' : 'gi';
    // Skip mentions already inside `[[...]]` — negative lookbehind for `[[`
    // is not portable; use a two-pass approach. Pattern: word-boundary +
    // alias + word-boundary, but NOT if immediately preceded by `[[`.
    const re = new RegExp(`(^|[^\\[])\\b${escaped}\\b(?!\\]\\])`, flags);
    region = region.replace(re, (_match, prefix: string) => `${prefix}[[${canonicalSlug}]]`);
  }
  return region;
}

/** Main entry: scan a wiki page's content for alias mentions, append
 *  matched canonical slugs to the `related:` frontmatter, and rewrite
 *  bare mentions inside `## References` / `## See also` sections to
 *  `[[wikilinks]]`. Prose content is not modified.
 *
 *  Returns `{related, updatedContent}`. If no aliases match, `related`
 *  is the unchanged existing frontmatter list and `updatedContent === content`. */
export function linkEntities(
  _pagePath: string,
  content: string,
  aliasMap: AliasEntry[] = loadAliasMap(),
): LinkResult {
  // 1. Find all matches across the whole page (for `related:`).
  const matched: string[] = []; // canonical slugs, in first-mention order
  const matchedSet = new Set<string>();
  for (const entry of aliasMap) {
    if (!anyCanonicalPageExists(entry.canonicalSlug)) continue;
    // Longest alias first — later aliases that are substrings of earlier
    // matches still count as a match against the same canonical page.
    const byLen = [...entry.aliases].sort((a, b) => b.length - a.length);
    let pageMatched = false;
    for (const alias of byLen) {
      if (matchAlias(content, alias, entry.kind) !== null) {
        pageMatched = true;
        break;
      }
    }
    if (pageMatched && !matchedSet.has(entry.canonicalSlug)) {
      matchedSet.add(entry.canonicalSlug);
      matched.push(entry.canonicalSlug);
    }
  }

  if (matched.length === 0) {
    return { related: extractExistingRelated(content), updatedContent: content };
  }

  // 2. Rewrite bare mentions inside References/See also regions only.
  const ranges = findReferenceRanges(content);
  let updated = content;
  // Apply rewrites right-to-left so earlier indices remain valid.
  for (const range of [...ranges].reverse()) {
    const region = updated.slice(range.start, range.end);
    const rewritten = replaceInRange(
      updated,
      range.start,
      range.end,
      aliasMap.filter(e => matchedSet.has(e.canonicalSlug) && anyCanonicalPageExists(e.canonicalSlug)),
    );
    if (rewritten !== region) {
      updated = updated.slice(0, range.start) + rewritten + updated.slice(range.end);
    }
  }

  // 3. Merge matched slugs into `related:` frontmatter (dedup).
  const existing = extractExistingRelated(updated);
  const merged: string[] = [...existing];
  for (const slug of matched) {
    if (!merged.includes(slug)) merged.push(slug);
  }
  updated = applyRelatedFrontmatter(updated, merged);

  return { related: merged, updatedContent: updated };
}

/** Extract the current `related:` list from a page's YAML frontmatter.
 *  Supports the inline form `related: [a, b]` and the block form:
 *    related:
 *      - a
 *      - b
 *  Returns [] if frontmatter is missing or the field is absent. */
export function extractExistingRelated(content: string): string[] {
  const fm = extractFrontmatter(content);
  if (fm === null) return [];
  const inline = fm.match(/^related:[ \t]*\[([^\]]*)\]\s*$/m);
  if (inline) {
    return inline[1]!
      .split(',')
      .map(s => s.trim())
      .filter(s => s.length > 0)
      .map(s => s.replace(/^["']|["']$/g, ''));
  }
  const block = fm.match(/^related:\n((?:[ \t]*-\s+.+\n?)+)/m);
  if (block) {
    const items: string[] = [];
    for (const line of block[1]!.split('\n')) {
      const m = line.match(/^[ \t]*-\s+(.+?)\s*$/);
      if (m) items.push(m[1]!.replace(/^["']|["']$/g, ''));
    }
    return items;
  }
  return [];
}

/** Replace (or insert) the `related:` field in the page's frontmatter with
 *  the given inline list. If no frontmatter exists, the content is returned
 *  unchanged (an unframed wiki page isn't our problem to fix). */
export function applyRelatedFrontmatter(content: string, related: string[]): string {
  const fmBody = extractFrontmatter(content);
  if (fmBody === null) return content;
  const fmLength = content.indexOf('\n---\n', 4) + '\n---\n'.length;
  const rendered = related.length === 0
    ? 'related: []'
    : `related: [${related.join(', ')}]`;
  // Replace an existing related line (inline, block, or bare key), else append.
  let newFm: string;
  if (/^related:[ \t]*\[[^\]]*\]\s*$/m.test(fmBody)) {
    newFm = fmBody.replace(/^related:[ \t]*\[[^\]]*\]\s*$/m, rendered);
  } else if (/^related:\n(?:[ \t]*-\s+.+\n?)+/m.test(fmBody)) {
    newFm = fmBody.replace(/^related:\n(?:[ \t]*-\s+.+\n?)+/m, rendered + '\n');
  } else if (/^related:[ \t]*$/m.test(fmBody)) {
    // Bare key with no value (e.g. `related:` alone on a line) — replace in
    // place. Without this branch we would fall through to append and produce
    // two `related:` keys, which is ambiguous YAML.
    newFm = fmBody.replace(/^related:[ \t]*$/m, rendered);
  } else {
    newFm = fmBody + '\n' + rendered;
  }
  return `---\n${newFm}\n---\n` + content.slice(fmLength);
}

function extractFrontmatter(content: string): string | null {
  const m = content.match(/^---\n([\s\S]*?)\n---\n/);
  return m ? m[1]! : null;
}
