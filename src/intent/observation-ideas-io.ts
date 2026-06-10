/**
 * I/O for the observation loop's `docs/projects/ideas.md` file — project
 * 08-intent-layer Phase 6 B4.2 + B4.3.
 *
 * The file has two sections:
 *
 * - `## User-authored` — hand-written ideas the user maintains; never
 *   touched by the loop, never parsed for dedupe (user entries don't have
 *   the loop's structured `- **Title** — friction` shape).
 * - `## Loop-filed` — bullets the observation loop appends. The reader
 *   parses only this section.
 *
 * `readFiledIdeas` scopes its parse to the Loop-filed section and derives
 * each idea's `id` via {@link deriveIdeaId} — the same construction the
 * `observation-triage` agent uses, so two passes on the same friction
 * collapse via the loop's `isDuplicate` check.
 *
 * `appendFiledIdeas` appends `formatIdeasMarkdown`'s output below the
 * Loop-filed section header, preserving prior entries.
 *
 * See spec.md §"Phase 5" and test-plan.md §16.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createLogger } from '../utils/logger.js';
import type { ProjectIdea } from './observation-loop.js';

const log = createLogger('observation-ideas-io');

/** The Loop-filed section header literal — single source of truth shared
 *  with callers that initialize the section (e.g. the log_idea production
 *  deps' ensureLoopFiledSection). */
export const LOOP_FILED_HEADER = '## Loop-filed';

/** Matches the Loop-filed section header — case-sensitive on the word
 *  because the writer always emits the literal `## Loop-filed`. */
export const LOOP_FILED_SECTION_RE = /^## Loop-filed\b/;

/** Matches a structured bullet of the shape `- **Title** — friction`.
 *  Captures title and friction separately. Uses the em-dash specifically
 *  to match `formatIdeasMarkdown`'s exact output — a hyphen-minus
 *  separator would NOT match, which is intentional: it prevents
 *  user-typed bullets (which won't use the em-dash) from being read as
 *  loop-filed entries even if they slipped under the section header. */
const LOOP_BULLET_RE = /^-\s+\*\*(.+?)\*\*\s+—\s+(.+?)\s*$/;

/** Matches the optional trailing ` → <product>` attribution suffix the
 *  writer emits for ideas carrying a `product` (project 16 R3.13). The
 *  product is a slug (no leading/trailing hyphen — mirrors VALID_SLUG in
 *  sandbox.ts); the suffix is stripped BEFORE the id is derived so
 *  attribution never perturbs dedupe.
 *
 *  KNOWN AMBIGUITY: a friction whose own text ends in ` → <slug>` is
 *  indistinguishable from an attributed bullet and will be parsed as one
 *  (truncated friction + product). The writer constrains what it emits
 *  (formatIdeasMarkdown only writes slug-valid suffixes) but a legacy or
 *  hand-typed bullet ending in the arrow pattern is misread — accepted
 *  tradeoff of the inline format; do not "fix" the regex without checking
 *  the round-trip tests in product-routing.test.ts. */
const PRODUCT_SUFFIX_RE = /^(.*\S)\s+→\s+([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)$/;

/** Maximum id length — matches the observation-triage agent's
 *  construction rule. Two passes on the same friction must produce the
 *  same id, so the truncation length here and in the agent prompt must
 *  stay in sync. */
const ID_MAX_LEN = 60;

/** Derive an idea id from a friction string. The rule matches the
 *  observation-triage agent's prompt verbatim:
 *
 *  1. lowercase
 *  2. replace each run of non-alphanumeric characters with a single hyphen
 *  3. trim leading/trailing hyphens
 *  4. truncate to {@link ID_MAX_LEN} characters
 *
 *  Same friction → same id, across passes. */
export function deriveIdeaId(friction: string): string {
  return friction
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, ID_MAX_LEN);
}

/** Read the `## Loop-filed` section of `ideasPath` and parse each
 *  structured bullet into a `ProjectIdea`. Returns `[]` on missing file,
 *  missing section, or empty section. Malformed bullets are skipped. */
export function readFiledIdeas(ideasPath: string): ProjectIdea[] {
  if (!existsSync(ideasPath)) return [];
  let raw: string;
  try {
    raw = readFileSync(ideasPath, 'utf8');
  } catch (err) {
    log.warn('readFiledIdeas: read failed', { ideasPath, error: (err as Error).message });
    return [];
  }
  const lines = raw.split('\n');
  // Find the Loop-filed section. Scope parsing to lines AFTER its header
  // and BEFORE the next H2 (so a future section below doesn't get parsed).
  let inSection = false;
  const ideas: ProjectIdea[] = [];
  for (const line of lines) {
    if (LOOP_FILED_SECTION_RE.test(line)) {
      inSection = true;
      continue;
    }
    if (!inSection) continue;
    if (/^##\s+/.test(line)) {
      // Hit the next H2 — Loop-filed section ended.
      break;
    }
    const m = LOOP_BULLET_RE.exec(line);
    if (!m) continue;
    const title = m[1]!.trim();
    let friction = m[2]!.trim();
    if (!title || !friction) continue;
    // Split off a trailing ` → <product>` attribution suffix; the friction
    // (and therefore the id) excludes it. Legacy bullets have no suffix.
    const suffixMatch = PRODUCT_SUFFIX_RE.exec(friction);
    let product: string | undefined;
    if (suffixMatch) {
      friction = suffixMatch[1]!; // group ends on \S — no trim needed
      product = suffixMatch[2]!;
    }
    ideas.push({
      title,
      friction,
      id: deriveIdeaId(friction),
      ...(product !== undefined ? { product } : {}),
    });
  }
  return ideas;
}

/** Append `markdown` to `ideasPath`'s `## Loop-filed` section. The
 *  caller produces `markdown` via `formatIdeasMarkdown` (which emits
 *  zero or more `- **Title** — friction\n` lines).
 *
 *  Behavior:
 *  - Empty `markdown` (the quiet-pass case) is a no-op — the file is
 *    not rewritten.
 *  - Missing Loop-filed section throws (the caller forgot B4.1's
 *    structuring; surfacing the error is better than silently writing
 *    to an unstructured file).
 *  - The append goes at the END of the Loop-filed section (after any
 *    prior loop entries and any HTML comment marker), so the section
 *    grows append-only. */
export function appendFiledIdeas(ideasPath: string, markdown: string): void {
  if (markdown === '') return;

  const raw = readFileSync(ideasPath, 'utf8');
  const lines = raw.split('\n');
  let sectionIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (LOOP_FILED_SECTION_RE.test(lines[i]!)) {
      sectionIdx = i;
      break;
    }
  }
  if (sectionIdx === -1) {
    throw new Error(
      `appendFiledIdeas: ideas file at ${ideasPath} has no "## Loop-filed" section header`,
    );
  }

  // Find the end of the Loop-filed section — next H2, or EOF. Trim
  // trailing empty lines inside the section so the appended content
  // attaches cleanly (one blank line between any prior entry and the
  // append, no orphan blank lines piling up).
  let endIdx = lines.length;
  for (let i = sectionIdx + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i]!)) {
      endIdx = i;
      break;
    }
  }
  const sectionEnd = endIdx;
  let insertionIdx = sectionEnd;
  while (insertionIdx > sectionIdx + 1 && lines[insertionIdx - 1]!.trim() === '') {
    insertionIdx--;
  }

  const toInsert = markdown.endsWith('\n') ? markdown.slice(0, -1) : markdown;
  const before = lines.slice(0, insertionIdx);
  const after = lines.slice(insertionIdx);
  // Always one blank line between the prior content and the appended
  // markdown — keeps the file readable across multiple appends.
  const newLines = [...before, '', ...toInsert.split('\n'), ...after];
  writeFileSync(ideasPath, newLines.join('\n'), 'utf8');
}
