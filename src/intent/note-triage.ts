/**
 * Nightly note triage — pure logic (project 23).
 *
 * The nightly "Note triage" step extracts forward-looking items from today's journal via a
 * tool-less agent and files them deterministically: product ideas/bugs into that product repo's
 * `docs/projects/{ideas,bugs}.md`, new-product ideas into the vault's `projects/ideas.md`, and
 * writing/research topics into the writing product's scoped topic files. This module is the
 * no-I/O core: agent-output validation, item→file-plan routing, and the append/dedupe helpers.
 * All filesystem work (locks, guards, atomic writes, audit log) lives in
 * `src/jobs/note-triage.ts`.
 *
 * Deliberately pure-of-config: the products map comes in as a structural
 * {@link NoteTriageProductConfig} record (same no-upward-dep pattern as `BacklogReaderConfig` in
 * backlog-reader.ts), so this stays importable without bootstrapping the runtime config.
 */

import { resolveProductTarget } from './product-routing.js';

export type NoteTriageItemType = 'idea' | 'bug' | 'writing-topic' | 'research-topic';

/** One extracted item, post-validation (the agent's JSON contract). */
export interface NoteTriageItem {
  type: NoteTriageItemType;
  /** Registered product slug, or null when the agent is unsure / the product is new. */
  product: string | null;
  /** Short single-line title. */
  title: string;
  /** 1-3 sentence synthesized description, single line after normalization. */
  detail: string;
}

/** Hard cap on items accepted per pass — a runaway extraction never floods the backlogs. */
export const MAX_ITEMS_PER_PASS = 20;

const ITEM_TYPES: ReadonlySet<string> = new Set(['idea', 'bug', 'writing-topic', 'research-topic']);
const MAX_TITLE_CHARS = 200;
const MAX_DETAIL_CHARS = 1000;

/** Collapse all whitespace runs (including newlines) to single spaces — the single-line
 *  discipline every downstream append format relies on. */
function toSingleLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export type ParseNoteTriageResult =
  | { ok: true; items: NoteTriageItem[] }
  | { ok: false; error: string };

/**
 * Parse + validate raw agent output. Strips ```json fences, rejects non-array JSON, drops
 * malformed elements (wrong shape, unknown type, empty/oversized title or detail) rather than
 * failing the pass, collapses whitespace to keep the single-line discipline, and caps the batch
 * at {@link MAX_ITEMS_PER_PASS}. Never throws.
 */
export function parseNoteTriageOutput(raw: string): ParseNoteTriageResult {
  let parsed: unknown;
  try {
    const cleaned = raw.replace(/```json?\n?|\n?```/g, '').trim();
    parsed = JSON.parse(cleaned);
  } catch (err) {
    return { ok: false, error: `invalid JSON: ${(err as Error).message}` };
  }
  if (!Array.isArray(parsed)) {
    return { ok: false, error: 'expected a JSON array' };
  }

  const items: NoteTriageItem[] = [];
  for (const element of parsed) {
    if (items.length >= MAX_ITEMS_PER_PASS) break;
    if (typeof element !== 'object' || element === null) continue;
    const candidate = element as Record<string, unknown>;
    if (typeof candidate.type !== 'string' || !ITEM_TYPES.has(candidate.type)) continue;
    if (typeof candidate.title !== 'string' || typeof candidate.detail !== 'string') continue;
    const title = toSingleLine(candidate.title);
    const detail = toSingleLine(candidate.detail);
    if (title === '' || detail === '') continue;
    if (title.length > MAX_TITLE_CHARS || detail.length > MAX_DETAIL_CHARS) continue;
    const product = typeof candidate.product === 'string' && candidate.product.trim() !== ''
      ? candidate.product.trim()
      : null;
    items.push({ type: candidate.type as NoteTriageItemType, product, title, detail });
  }
  return { ok: true, items };
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

/** Structural subset of ProductConfig — repoPath pre-tilde-expanded by readProductsConfig. */
export interface NoteTriageProductConfig {
  repoPath: string;
  scopePath?: string;
  containerCapabilities?: { bugs?: boolean; ideas?: boolean };
}

/** The writing product's registered slug — its idea surface IS the topic file, so ideas claimed
 *  for it coerce to writing topics. */
const WRITING_PRODUCT = 'writing';

export type NoteFilePlan =
  | { kind: 'product-idea'; product: string; repoPath: string; relPath: 'docs/projects/ideas.md'; title: string; text: string }
  | { kind: 'product-bug'; product: string; repoPath: string; relPath: 'docs/projects/bugs.md'; title: string; text: string }
  | { kind: 'vault-idea'; relPath: 'projects/ideas.md'; title: string; detail: string; sourceDate: string }
  | { kind: 'topic'; topic: 'writing' | 'research'; product: string; repoPath: string; scopePath: string;
      relPath: string; title: string; detail: string; sourceDate: string };

export type NoteSkipReason = 'no-writing-product';

export interface RouteNotesResult {
  plans: NoteFilePlan[];
  skipped: Array<{ item: NoteTriageItem; reason: NoteSkipReason }>;
}

/** `[[YYYY_MM_DD]]` wikilink form of an ISO date, for Source pointers. */
function toSourceLink(date: string): string {
  return date.replace(/-/g, '_');
}

/** The single-line bullet text for a product backlog item. The trailing `)` matters: a bare
 *  ` → token` tail would false-positive as a promotion marker in the backlog parser. */
function productBulletText(item: NoteTriageItem, date: string): string {
  return `${item.title} — ${item.detail} (journal ${date})`;
}

/**
 * Deterministic item→file-plan routing. Every LLM-claimed product is re-validated against the
 * products map via {@link resolveProductTarget} — an invented or non-registered name degrades to
 * the vault new-product path, never a write to an unregistered repo. `date` is ISO YYYY-MM-DD.
 */
export function routeNoteItems(
  items: NoteTriageItem[],
  products: Record<string, NoteTriageProductConfig>,
  date: string,
): RouteNotesResult {
  const plans: NoteFilePlan[] = [];
  const skipped: RouteNotesResult['skipped'] = [];
  const loadKnownProducts = () => Object.keys(products);

  const writing = products[WRITING_PRODUCT];
  const writingScope = writing?.scopePath?.trim() || null;

  const pushTopic = (item: NoteTriageItem, topic: 'writing' | 'research'): void => {
    if (!writing || !writingScope) {
      skipped.push({ item, reason: 'no-writing-product' });
      return;
    }
    const basename = topic === 'writing' ? 'writing-ideas.md' : 'research-topics.md';
    plans.push({
      kind: 'topic',
      topic,
      product: WRITING_PRODUCT,
      repoPath: writing.repoPath,
      scopePath: writingScope,
      relPath: `${writingScope}/${basename}`,
      title: item.title,
      detail: item.detail,
      sourceDate: toSourceLink(date),
    });
  };

  const pushVaultIdea = (item: NoteTriageItem, titlePrefix = ''): void => {
    plans.push({
      kind: 'vault-idea',
      relPath: 'projects/ideas.md',
      title: `${titlePrefix}${item.title}`,
      detail: item.detail,
      sourceDate: toSourceLink(date),
    });
  };

  for (const item of items) {
    switch (item.type) {
      case 'writing-topic':
        pushTopic(item, 'writing');
        break;
      case 'research-topic':
        pushTopic(item, 'research');
        break;
      case 'idea': {
        const route = resolveProductTarget(item.product ?? undefined, loadKnownProducts);
        if (!route.routed) {
          pushVaultIdea(item);
          break;
        }
        if (route.product === WRITING_PRODUCT) {
          // The writing product's idea surface IS the topic file.
          pushTopic(item, 'writing');
          break;
        }
        const productConfig = products[route.product];
        if (!productConfig || productConfig.containerCapabilities?.ideas === false) {
          // Ideas container disabled for this product — fail closed to the vault.
          pushVaultIdea(item);
          break;
        }
        plans.push({
          kind: 'product-idea',
          product: route.product,
          repoPath: productConfig.repoPath,
          relPath: 'docs/projects/ideas.md',
          title: item.title,
          text: productBulletText(item, date),
        });
        break;
      }
      case 'bug': {
        const route = resolveProductTarget(item.product ?? undefined, loadKnownProducts);
        const productConfig = route.routed ? products[route.product] : undefined;
        if (!route.routed || !productConfig || productConfig.containerCapabilities?.bugs === false) {
          // Unroutable bug — fail closed to the vault, durably, with an explicit marker.
          pushVaultIdea(item, '[Bug — unrouted] ');
          break;
        }
        plans.push({
          kind: 'product-bug',
          product: route.product,
          repoPath: productConfig.repoPath,
          relPath: 'docs/projects/bugs.md',
          title: item.title,
          text: productBulletText(item, date),
        });
        break;
      }
    }
  }
  return { plans, skipped };
}

// ---------------------------------------------------------------------------
// Project-page hints (product identification)
// ---------------------------------------------------------------------------

/** One journal wikilink that matched a vault `projects/<page>.md` page. `product` is the
 *  registered product of the same name, or null when the page has no registered product (the
 *  prompt labels those explicitly so the classifier never guess-maps them). */
export interface ProjectPageHint {
  page: string;
  product: string | null;
}

// Wikilink target: `[[page]]`, `[[page|alias]]`, `[[page#section]]` — capture the target only.
const WIKILINK_RE = /\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g;

/**
 * Scan the journal for `[[name]]` wikilinks whose target case-insensitively matches a vault
 * `projects/*.md` page name. Both link forms count: the bare `[[relay]]` and the path form
 * `[[projects/relay|relay]]` the journal digests use. Returns one hint per distinct page, in
 * first-mention order. `pageNames` are basenames without `.md`; `productNames` are registered
 * product slugs.
 */
export function extractProjectPageHints(
  journal: string,
  pageNames: string[],
  productNames: string[],
): ProjectPageHint[] {
  const pagesByLower = new Map(pageNames.map((p) => [p.toLowerCase(), p]));
  const productsByLower = new Map(productNames.map((p) => [p.toLowerCase(), p]));
  const hints: ProjectPageHint[] = [];
  const seen = new Set<string>();
  for (const match of journal.matchAll(WIKILINK_RE)) {
    const target = match[1]!.trim().toLowerCase().replace(/^projects\//, '');
    const page = pagesByLower.get(target);
    if (page === undefined || seen.has(page)) continue;
    seen.add(page);
    hints.push({ page, product: productsByLower.get(target) ?? null });
  }
  return hints;
}

// ---------------------------------------------------------------------------
// Dedupe + append helpers
// ---------------------------------------------------------------------------

/** Lowercase, non-alphanumeric runs → single space, trim — the dedupe normal form (mirrors
 *  observation-ideas-io's private normalizeIdeaTitle). */
export function normalizeNoteTitle(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** True when any line of `content`, normalized the same way, contains the normalized title.
 *  Format-agnostic on purpose: works across `- [ ] T…`, `- **T** — …`, and `### T` alike. */
export function containsNoteTitle(content: string, title: string): boolean {
  const needle = normalizeNoteTitle(title);
  if (needle === '') return false;
  return content.split('\n').some((line) => normalizeNoteTitle(line).includes(needle));
}

/**
 * Collect the titles of items already filed from `date`'s journal in one target file — the
 * lines carrying a `(journal YYYY-MM-DD)` suffix (product backlogs) or a `[[YYYY_MM_DD]]`
 * source link (topic files; vault `### Title` blocks via their `*Source:*` line). Injected into
 * the extraction prompt as a do-not-re-emit list, because LLM re-extraction phrases the same
 * note under a different title and the normalized-title guard alone can't catch that (observed
 * live: a forced second pass filed 10 near-duplicate ideas).
 */
export function collectFiledTitles(content: string, date: string): string[] {
  const marks = [`(journal ${date})`, `[[${toSourceLink(date)}]]`];
  const titles: string[] = [];
  let lastHeading: string | null = null;
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    const heading = /^###\s+(.+)$/.exec(line);
    if (heading) lastHeading = heading[1]!.trim();
    if (!marks.some((m) => line.includes(m))) continue;
    if (line.startsWith('*Source:')) {
      if (lastHeading) titles.push(lastHeading);
      continue;
    }
    let text = line.replace(/^- \[[ xX]\] /, '').replace(/^- /, '');
    const emDash = text.indexOf(' — ');
    if (emDash > 0) text = text.slice(0, emDash);
    text = text.replace(/^\*\*(.*)\*\*$/, '$1').trim();
    if (text !== '') titles.push(text);
  }
  return titles;
}

const IDEAS_HEADING_RE = /^##\s+Ideas\s*$/im;

/** Render one vault idea block. */
function vaultIdeaBlock(block: { title: string; detail: string; sourceDate: string }): string {
  return `### ${block.title}\n${block.detail}\n*Source: [[${block.sourceDate}]]*`;
}

/**
 * Insert `### Title` idea blocks at the END of the vault ideas file's `## Ideas` section —
 * before the next `##` heading (the live file has a trailing `## Supersession audit` section, so
 * EOF-append is wrong). Creates the `## Ideas` heading at EOF when absent. Dedupes by normalized
 * title against existing `###` headings and earlier blocks in the same batch.
 */
export function appendVaultIdeaBlocks(
  content: string,
  blocks: Array<{ title: string; detail: string; sourceDate: string }>,
): { content: string; appended: number } {
  const existingTitles = new Set<string>();
  for (const line of content.split('\n')) {
    const heading = /^###\s+(.+)$/.exec(line);
    if (heading) existingTitles.add(normalizeNoteTitle(heading[1]!));
  }

  const fresh: string[] = [];
  for (const block of blocks) {
    const normalized = normalizeNoteTitle(block.title);
    if (normalized === '' || existingTitles.has(normalized)) continue;
    existingTitles.add(normalized);
    fresh.push(vaultIdeaBlock(block));
  }
  if (fresh.length === 0) return { content, appended: 0 };

  const insertion = fresh.join('\n\n');
  const headingMatch = IDEAS_HEADING_RE.exec(content);
  if (!headingMatch) {
    const sep = content === '' || content.endsWith('\n') ? '' : '\n';
    return {
      content: `${content}${sep}\n## Ideas\n\n${insertion}\n`,
      appended: fresh.length,
    };
  }

  // Find the next `##` heading AFTER the Ideas heading; insert just before it.
  const afterHeading = headingMatch.index + headingMatch[0].length;
  const nextHeading = /^##\s/m.exec(content.slice(afterHeading));
  if (!nextHeading) {
    const sep = content.endsWith('\n') ? '' : '\n';
    return { content: `${content}${sep}\n${insertion}\n`, appended: fresh.length };
  }
  const insertAt = afterHeading + nextHeading.index;
  const before = content.slice(0, insertAt).replace(/\n+$/, '\n');
  const after = content.slice(insertAt);
  return {
    content: `${before}\n${insertion}\n\n${after}`,
    appended: fresh.length,
  };
}

/**
 * Append `- **Title** — detail Source: [[YYYY_MM_DD]]` topic lines at EOF. `content === null`
 * (file missing) seeds `# <header>` first — the parser skips an H1 as prose, so the seeded file
 * still cockpit-parses its bullets as user-authored ideas. Dedupes by normalized title against
 * the existing content and earlier lines in the same batch.
 */
export function appendTopicLines(
  content: string | null,
  header: string,
  lines: Array<{ title: string; detail: string; sourceDate: string }>,
): { content: string; appended: number } {
  let base = content ?? `# ${header}\n`;
  const seen = new Set<string>();
  let appended = 0;
  for (const line of lines) {
    const normalized = normalizeNoteTitle(line.title);
    if (normalized === '' || seen.has(normalized) || containsNoteTitle(base, line.title)) continue;
    seen.add(normalized);
    const sep = base.endsWith('\n') ? '' : '\n';
    const detail = /[.!?]$/.test(line.detail) ? line.detail : `${line.detail}.`;
    base = `${base}${sep}- **${line.title}** — ${detail} Source: [[${line.sourceDate}]]\n`;
    appended += 1;
  }
  return { content: base, appended };
}
