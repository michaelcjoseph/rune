/**
 * Writer-memory seed helper (project 12, Phase 1).
 *
 * The seed baseline is mined ONCE, by the implementation agent, from the
 * human-supplied links under `spec.md` → **Seed sources**. This module owns the
 * deterministic scaffolding around that one-time mining:
 *   - parse the supplied links out of the spec,
 *   - enforce the 20-50 supplied-link range (fewer → prerequisite error;
 *     more → cap error),
 *   - cap the distilled output at ≤20 provenance-stamped bullets,
 *   - stamp a bullet in the canonical provenance format,
 *   - plan which links to mine and which to skip-with-a-note (unfetchable).
 *
 * The actual URL→lesson distillation is the agent's job (web fetch + judgment),
 * not a runtime function — this module makes the surrounding contract testable.
 */

/** Minimum supplied seed links (human prerequisite, spec Phase 0). */
export const SEED_MIN_LINKS = 20;
/** Maximum supplied seed links (input cap). */
export const SEED_MAX_LINKS = 50;
/** Maximum distilled memory bullets the seed may emit (output cap). */
export const SEED_BULLET_CAP = 20;

/** Canonical provenance stamp: `- [YYYY-MM-DD · source: <slug>] <lesson>`.
 *  The `m` flag anchors `^` to each line so the same regex validates a single
 *  stamped bullet AND scans a multi-line `memory.md` (Phase 2 dedup). */
export const PROVENANCE_RE =
  /^- \[\d{4}-\d{2}-\d{2} · source: [a-z0-9][a-z0-9-]{2,80}\] .+/m;

/** Fewer than SEED_MIN_LINKS supplied links — the human prerequisite is unmet. */
export class SeedPrerequisiteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SeedPrerequisiteError';
  }
}

/** More than SEED_MAX_LINKS supplied links — the input cap is exceeded. */
export class SeedCapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SeedCapError';
  }
}

export interface SeedFetchOutcome {
  url: string;
  fetched: boolean;
}

export interface SeedMiningPlan {
  /** Links that fetched and should be distilled. */
  toMine: string[];
  /** Links skipped because they were unfetchable, each with a note. */
  skipped: { url: string; note: string }[];
}

/** Header that opens the seed-source list in spec.md. */
const SEED_SECTION_RE = /^###\s+Seed sources\b/m;
/** Next `##`-or-higher header — bounds the section end (excludes `###`/`####`). */
const SEED_SECTION_END_RE = /^##\s+/m;
/** Any http(s) URL token, stopping at whitespace or a closing markdown paren. */
const URL_RE = /https?:\/\/[^\s)]+/g;
/** Sentence punctuation stripped from a URL's tail so a link embedded in prose
 *  (`see https://x.com.`) yields the bare URL, not one with a trailing dot. */
const TRAILING_PUNCT_RE = /[.,;:!?]+$/;

/** Extract the http(s) links under the `### Seed sources` section of spec.md.
 *  Scopes extraction to that section only — the section runs from its `###`
 *  header to the next `##`-or-higher header (matched as `## `, which excludes
 *  the `### `/`#### ` subheaders inside) or end of file, so the `####` category
 *  subheaders inside it are kept and surrounding prose links excluded. */
export function extractSeedLinks(specContent: string): string[] {
  const startMatch = SEED_SECTION_RE.exec(specContent);
  if (!startMatch) return [];

  // Section body begins after the header line.
  const afterHeader = specContent.slice(startMatch.index + startMatch[0].length);
  // Terminate at the next h2 (`## `) header — `###`/`####` headers stay in scope.
  const endMatch = SEED_SECTION_END_RE.exec(afterHeader);
  const section = endMatch ? afterHeader.slice(0, endMatch.index) : afterHeader;

  return (section.match(URL_RE) ?? []).map((url) => url.replace(TRAILING_PUNCT_RE, ''));
}

/** Throw SeedPrerequisiteError (<20) or SeedCapError (>50); otherwise return. */
export function assertSeedSourceCount(links: string[]): void {
  if (links.length < SEED_MIN_LINKS) {
    throw new SeedPrerequisiteError(
      `Seed prerequisite unmet: ${links.length} links supplied, need at least ${SEED_MIN_LINKS}.`,
    );
  }
  if (links.length > SEED_MAX_LINKS) {
    throw new SeedCapError(
      `Seed input cap exceeded: ${links.length} links supplied, max ${SEED_MAX_LINKS}.`,
    );
  }
}

/** Cap distilled bullets to ≤ SEED_BULLET_CAP (keeps the first N). */
export function capSeedBullets(bullets: string[]): string[] {
  return bullets.slice(0, SEED_BULLET_CAP);
}

/** Stamp a lesson in the canonical provenance format
 *  `- [YYYY-MM-DD · source: <slug>] <lesson>`. The caller owns slug/date
 *  validity (a lowercase slug matching PROVENANCE_RE, a `YYYY-MM-DD` date); only
 *  the empty-lesson case is guarded here, since it would silently produce a stamp
 *  that fails PROVENANCE_RE's trailing `.+`. */
export function stampSeedLesson(lesson: string, sourceSlug: string, date: string): string {
  if (!lesson.trim()) {
    throw new Error('stampSeedLesson: lesson must be non-empty');
  }
  return `- [${date} · source: ${sourceSlug}] ${lesson}`;
}

/** Strips the canonical provenance prefix off a stamped line, leaving the trimmed
 *  lesson body. The inverse of `stampSeedLesson`. Co-located with `PROVENANCE_RE`
 *  so the parse and the format stay in one place — both learning loops (writer
 *  capture + role memory writer) dedup through this single extractor rather than
 *  carrying a private copy of the strip regex that could drift from the stamp. */
const LESSON_BODY_STRIP_RE = /^- \[\d{4}-\d{2}-\d{2} · source: [^\]]+\]\s+/;
export function extractLessonBody(line: string): string {
  return line.replace(LESSON_BODY_STRIP_RE, '').trim();
}

/** Split links into fetchable (toMine) and unfetchable (skipped-with-note).
 *  Decisions key off `outcomes`; a link with no matching outcome is treated as
 *  unfetchable (skipped) so a missing fetch result never silently mines nothing. */
export function planSeedMining(
  links: string[],
  outcomes: SeedFetchOutcome[],
): SeedMiningPlan {
  const fetchedByUrl = new Map(outcomes.map((o) => [o.url, o.fetched]));
  const plan: SeedMiningPlan = { toMine: [], skipped: [] };

  for (const url of links) {
    if (fetchedByUrl.get(url) === true) {
      plan.toMine.push(url);
    } else {
      plan.skipped.push({ url, note: 'unfetchable — skipped during seed mining' });
    }
  }
  return plan;
}
