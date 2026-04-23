import { readVaultFile, vaultFileExists } from '../vault/files.js';
import { askClaudeOneShot } from '../ai/claude.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('kb-activity');

/** Threshold for switching from raw grouped output to LLM-summarized output.
 *  Below this, the per-page list is scannable; above, the prep context bloats. */
export const SUMMARIZER_THRESHOLD = 50;

export type PageCategory = 'entity' | 'concept' | 'topic' | 'comparison' | 'raw' | 'other';

export type Direction = 'created' | 'updated';

export interface KBActivityEntry {
  /** Date in ISO format, e.g. "2026-04-21". */
  date: string;
  /** 24-hour time, e.g. "13:20". */
  time: string;
  /** Prose after `[INGEST]` — status + summary. May begin with `Skipped (...)`. */
  rawStatus: string;
  /** Source wikilinks from the `Sources:` line (without the `[[ ]]`). Empty if the line is absent. */
  sources: string[];
  /** Wikilinks from the `Pages touched:` line (without the `[[ ]]`). Empty if `(none)` or missing. */
  pagesTouched: string[];
}

export interface KBActivityDigest {
  /** Start of the scan window, inclusive. ISO `YYYY-MM-DD`. */
  windowStart: string;
  /** End of the scan window, inclusive. ISO `YYYY-MM-DD`. */
  windowEnd: string;
  /** All `[INGEST]` entries whose timestamp falls within the window. */
  entries: KBActivityEntry[];
}

/** Scan `knowledge/log.md` for `[INGEST]` entries whose timestamp falls in `[startDate, endDate]`.
 *  Dates are ISO `YYYY-MM-DD` — string comparison works because the prefix is zero-padded.
 *
 *  This scaffold returns *all* entries in the window (including `Skipped (...)`).
 *  Skipped-vs-ingested filtering and category grouping are added in subsequent tasks. */
export function scanKBActivity(startDate: string, endDate: string): KBActivityDigest {
  const raw = readVaultFile('knowledge/log.md') || '';
  const entries: KBActivityEntry[] = [];

  // Regexes are scoped to this function so their `g`-flag `lastIndex` can't
  // leak across calls via `.test()` / `.exec()` from unrelated callers.
  const anchorRe = /^\[(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})\] \[INGEST\] ?(.*)$/gm;
  // Generic anchor pattern — matches INGEST as well as CHECKPOINT (added by
  // src/kb/engine.ts's mid-queue checkpoint feature). Used only to bound
  // block bodies: if a CHECKPOINT sits between two INGEST entries, its
  // prose must not be attributed to the preceding INGEST.
  const anyAnchorRe = /^\[(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})\] \[[A-Z]+\]/gm;

  const anchors = Array.from(raw.matchAll(anchorRe));
  const allAnchors = Array.from(raw.matchAll(anyAnchorRe));
  for (let i = 0; i < anchors.length; i++) {
    const match = anchors[i]!;
    const date = match[1]!;
    if (date < startDate || date > endDate) continue;

    const time = match[2]!;
    const anchorTail = (match[3] ?? '').trim();

    // Body spans from end of anchor line to the next anchor of any tag type
    // (INGEST or CHECKPOINT), or EOF. Using `allAnchors` instead of
    // `anchors` prevents CHECKPOINT prose from leaking into the previous
    // INGEST block.
    const blockStart = match.index! + match[0].length;
    const nextAnchor = allAnchors.find(a => a.index! > match.index!);
    const blockEnd = nextAnchor !== undefined ? nextAnchor.index! : raw.length;
    const body = raw.slice(blockStart, blockEnd);

    // Status prose may continue on subsequent lines before the first labeled
    // line (`Sources:` / `Pages touched:`). Collect those continuation lines.
    const continuation: string[] = [];
    for (const line of body.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (trimmed.startsWith('Sources:') || trimmed.startsWith('Pages touched:')) break;
      continuation.push(trimmed);
    }
    const rawStatus = [anchorTail, ...continuation].filter(Boolean).join(' ');

    entries.push({
      date,
      time,
      rawStatus,
      sources: parseLineWikilinks(body, 'Sources:'),
      pagesTouched: parseLineWikilinks(body, 'Pages touched:'),
    });
  }

  return { windowStart: startDate, windowEnd: endDate, entries };
}

/** Resolve a wikilink slug to its KB category by file-path inspection.
 *
 *  Prefixed slugs are classified when `raw/` or `wiki/<subdir>/` is the leading path
 *  segment. Any other slash-containing slug returns `'other'`. Bare slugs (no `/`) are
 *  probed against `knowledge/wiki/{entities,concepts,topics,comparisons}/<slug>.md` in
 *  order; first match wins. Unmatched slugs (including empty strings) return `'other'`. */
export function resolveCategory(slug: string): PageCategory {
  if (!slug) return 'other';
  if (slug.startsWith('raw/')) return 'raw';
  if (slug.startsWith('wiki/entities/')) return 'entity';
  if (slug.startsWith('wiki/concepts/')) return 'concept';
  if (slug.startsWith('wiki/topics/')) return 'topic';
  if (slug.startsWith('wiki/comparisons/')) return 'comparison';
  if (slug.includes('/')) return 'other';
  const probes: Array<[string, PageCategory]> = [
    ['entities', 'entity'],
    ['concepts', 'concept'],
    ['topics', 'topic'],
    ['comparisons', 'comparison'],
  ];
  for (const [dir, category] of probes) {
    if (vaultFileExists(`knowledge/wiki/${dir}/${slug}.md`)) return category;
  }
  return 'other';
}

/** Locate the wiki file for a bare slug. Returns the first hit under
 *  `knowledge/wiki/{entities,concepts,topics,comparisons}/` or null. */
function wikiPathForSlug(slug: string): string | null {
  if (slug.includes('/')) {
    // Prefixed slug — use as-is (prepend `knowledge/` only for `wiki/...` paths).
    if (slug.startsWith('wiki/')) return `knowledge/${slug}.md`;
    return null;
  }
  for (const dir of ['entities', 'concepts', 'topics', 'comparisons']) {
    const path = `knowledge/wiki/${dir}/${slug}.md`;
    if (vaultFileExists(path)) return path;
  }
  return null;
}

/** Classify whether a page was created vs. updated during an ingest on `ingestDate`.
 *  Reads the page's YAML frontmatter and compares its `created:` field to the ingest date.
 *  Falls back to `'updated'` when the page is missing or the frontmatter is unparseable.
 *
 *  Only meaningful for wiki-category slugs (entity / concept / topic / comparison).
 *  `raw/*` and `other` slugs have no frontmatter and will always return `'updated'`. */
export function resolveDirection(slug: string, ingestDate: string): Direction {
  const path = wikiPathForSlug(slug);
  if (!path) return 'updated';
  const content = readVaultFile(path);
  if (!content) return 'updated';
  const match = content.match(/^created:\s*(\d{4}-\d{2}-\d{2})/m);
  if (!match) return 'updated';
  return match[1] === ingestDate ? 'created' : 'updated';
}

/** Extract wikilinks from the line starting with `label` (e.g. "Sources:", "Pages touched:").
 *  Returns an empty array if the line is missing or reads `(none)`. Piped display aliases
 *  (`[[slug|display]]`) are stripped to the slug. */
function parseLineWikilinks(body: string, label: string): string[] {
  const line = body
    .split('\n')
    .find((l) => l.trim().startsWith(label));
  if (!line) return [];
  const after = line.slice(line.indexOf(label) + label.length).trim();
  if (after === '(none)' || after === '') return [];
  const wikilinkRe = /\[\[([^\]]+?)\]\]/g;
  return Array.from(after.matchAll(wikilinkRe), (m) => m[1]!.split('|')[0]!.trim());
}

/** Format a digest as a markdown section for review prep context.
 *
 *  Returns `null` when the digest is empty (no ingested + no skipped entries) so callers
 *  can suppress the section — matches the `formatDriftFlags` convention.
 *
 *  Ingested entries' `pagesTouched` are aggregated by `(category, direction)` and rendered
 *  as grouped sections. Skipped entries (pagesTouched empty) collapse into a footer count.
 *  `raw` and `other` categories are dropped from the output — they're not KB activity.
 *  Dedup across entries: `created` wins over `updated` for the same slug. */
export function formatKBActivity(digest: KBActivityDigest): string | null {
  if (digest.entries.length === 0) return null;

  const ingested = digest.entries.filter((e) => e.pagesTouched.length > 0);
  const skipCount = digest.entries.length - ingested.length;

  const header = `# KB Activity (${ingested.length} ingested, ${skipCount} skipped, ${digest.windowStart} → ${digest.windowEnd})`;

  // Aggregate pages across all ingested entries. Key uses the resolved vault path
  // so bare slugs and their prefixed form (`alice` vs. `wiki/entities/alice`) dedupe.
  // Value = 'created' wins over 'updated' for the same slug.
  const seen = new Map<string, { slug: string; category: PageCategory; direction: Direction }>();
  for (const entry of ingested) {
    for (const rawSlug of entry.pagesTouched) {
      const category = resolveCategory(rawSlug);
      if (category === 'raw' || category === 'other') continue;
      const direction = resolveDirection(rawSlug, entry.date);
      const key = wikiPathForSlug(rawSlug) ?? `${category}|${rawSlug}`;
      const prev = seen.get(key);
      if (!prev || (direction === 'created' && prev.direction === 'updated')) {
        seen.set(key, { slug: rawSlug, category, direction });
      }
    }
  }

  // Group slugs by category + direction.
  const grouped = new Map<PageCategory, { created: string[]; updated: string[] }>();
  for (const { slug, category, direction } of seen.values()) {
    const bucket = grouped.get(category) || { created: [], updated: [] };
    bucket[direction].push(slug);
    grouped.set(category, bucket);
  }

  const CATEGORY_ORDER: Array<{ cat: PageCategory; label: string }> = [
    { cat: 'entity', label: 'Entities' },
    { cat: 'concept', label: 'Concepts' },
    { cat: 'topic', label: 'Topics' },
    { cat: 'comparison', label: 'Comparisons' },
  ];

  const categoryLines: string[] = [];
  for (const { cat, label } of CATEGORY_ORDER) {
    const bucket = grouped.get(cat);
    if (!bucket || (bucket.created.length === 0 && bucket.updated.length === 0)) continue;
    const parts: string[] = [];
    if (bucket.created.length > 0) {
      parts.push(`${bucket.created.length} created (${bucket.created.map((s) => `[[${s}]]`).join(', ')})`);
    }
    if (bucket.updated.length > 0) {
      parts.push(`${bucket.updated.length} updated (${bucket.updated.map((s) => `[[${s}]]`).join(', ')})`);
    }
    categoryLines.push(`**${label}** — ${parts.join(', ')}`);
  }

  const sections = [header];
  if (categoryLines.length > 0) sections.push(categoryLines.join('\n'));
  if (skipCount > 0) {
    const noun = skipCount === 1 ? 'entry' : 'entries';
    sections.push(`_${skipCount} ${noun} skipped (see knowledge/log.md for reasons)._`);
  }
  return sections.join('\n\n');
}

/** When the digest is large, raw category-grouped output bloats review prep.
 *  This summarizer compresses it via a one-shot LLM call into a 5-10 line synthesis
 *  organized by theme, preserving counts and key wikilinks. Returns null on LLM failure. */
export async function summarizeKBActivity(digest: KBActivityDigest): Promise<string | null> {
  const ingested = digest.entries.filter((e) => e.pagesTouched.length > 0);
  const skipCount = digest.entries.length - ingested.length;
  if (ingested.length === 0 && skipCount === 0) return null;

  // Compact one-line-per-entry input for the LLM. Keep it lossy on prose
  // (rawStatus truncated) but lossless on the wikilinks list.
  const entryLines = ingested.map((e) =>
    `- [${e.date}] ${e.rawStatus.slice(0, 80)} | pages: ${e.pagesTouched.join(', ')}`,
  );

  const prompt = `Summarize this knowledge-base activity log into a 5-10 line synthesis suitable for a review prep context. Group by theme (people, projects, concepts, topics) rather than by date. Keep specific wikilinks (\`[[slug]]\`) for the most-active pages so the user can dig in. Keep the tone neutral and factual. End with a single line stating raw counts: "X ingested, Y skipped".

Window: ${digest.windowStart} → ${digest.windowEnd}
Skipped (duplicates / image-only / already covered): ${skipCount}

Ingested entries (${ingested.length}):
${entryLines.join('\n')}

Output format: a single markdown section starting with the header "# KB Activity (summarized)" and 5-10 bulleted or paragraph lines. No prose preamble, no fences.`;

  const result = await askClaudeOneShot(prompt);
  if (result.error) {
    log.error('summarizeKBActivity failed', { error: result.error, windowStart: digest.windowStart, windowEnd: digest.windowEnd });
    return null;
  }
  if (!result.text) {
    log.warn('summarizeKBActivity returned empty text', { windowStart: digest.windowStart, windowEnd: digest.windowEnd });
    return null;
  }
  return result.text.trim();
}

/** Render a KB activity digest for review prep. Below `SUMMARIZER_THRESHOLD`
 *  total entries, returns the raw grouped output (synchronous). At/above the
 *  threshold, dispatches to the LLM summarizer.
 *
 *  Returns `null` for empty digests so callers can suppress the section. */
export async function renderKBActivitySection(digest: KBActivityDigest): Promise<string | null> {
  if (digest.entries.length < SUMMARIZER_THRESHOLD) {
    return formatKBActivity(digest);
  }
  const summarized = await summarizeKBActivity(digest);
  // Fallback to raw grouped output if the summarizer fails — better to show
  // verbose output than nothing.
  return summarized ?? formatKBActivity(digest);
}
