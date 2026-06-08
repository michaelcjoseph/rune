/**
 * `context.md` schema + planning-time seed (project 14).
 *
 * `docs/projects/<project>/context.md` is Jarvis-owned ORCHESTRATION STATE that
 * carries high-signal continuity between fresh per-task execution contexts. It is
 * NOT role memory and NOT a seventh role: roles may read a bounded slice of it as
 * low-authority reference and emit handoff notes, but they never author the file —
 * Jarvis's context curator owns every write.
 *
 * This module owns the section SCHEMA and the planning-time SEED (Phase 2). The
 * post-task update / budget / validation helpers and the fs read/write layer land
 * in Phase 3 on top of these same five sections, so the contract is pinned here
 * once and shared.
 *
 * Pure — no I/O. The fs layer is Phase 3's concern.
 */

import { VALID_SLUG } from './sandbox.js';

/** Hard cap on the project title length woven into the seeded document — bounds
 *  the generated file against a pathologically long free-form title. */
export const PROJECT_TITLE_MAX_CHARS = 200;

/** The five required `context.md` sections, in canonical document order. Both the
 *  seed and the Phase 3 update path hold this contract: a context that drops a
 *  section is invalid. */
export const CONTEXT_SECTIONS = [
  'Current State',
  'Key Decisions',
  'Interfaces & Contracts',
  'Known Risks',
  'Next Task Handoff',
] as const;

export type ContextSection = (typeof CONTEXT_SECTIONS)[number];

/** Inputs the planner has on hand when it seeds the initial context. Everything
 *  but product + title is optional — a bare project still seeds all five sections
 *  with explicit placeholders rather than dropping a header. */
export interface ContextSeedInput {
  /** The product this project belongs to. */
  product: string;
  /** One-line project title. */
  projectTitle: string;
  /** Short description of what is being built → seeds Current State. */
  specSummary?: string;
  /** PM assumptions → seeded into Key Decisions (they are decisions-by-default). */
  assumptions?: string[];
  /** Known interfaces / contracts at planning time → Interfaces & Contracts. */
  interfaces?: string;
  /** Risks the tech lead flagged → Known Risks. */
  risks?: string[];
  /** Handoff note for the first unchecked task → Next Task Handoff. */
  firstTaskHandoff?: string;
}

/** Placeholder body for a section with no seeded content — keeps the header
 *  present (so `hasRequiredSections` holds) without faking detail. */
const EMPTY_SECTION_PLACEHOLDER = '_None yet._';

function bulletList(items: readonly string[] | undefined): string | undefined {
  if (!items || items.length === 0) return undefined;
  return items.map((i) => `- ${i}`).join('\n');
}

function sectionBody(content: string | undefined): string {
  const trimmed = content?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : EMPTY_SECTION_PLACEHOLDER;
}

/**
 * Seed the initial `context.md` for a freshly-planned project. Produces a
 * markdown document with all five required sections (empty ones carrying an
 * explicit placeholder), a header naming the product + title, and the
 * curator-ownership note so a reader knows roles do not author it.
 */
export function seedProjectContext(input: ContextSeedInput): string {
  // Slug-guard the product at the boundary (same convention as the rest of the
  // intent layer) — the product is interpolated into the document and will reach
  // disk via the Phase 3 fs layer. A non-slug product is a programming error.
  if (!VALID_SLUG.test(input.product)) {
    throw new Error(`seedProjectContext: invalid product slug '${input.product}'`);
  }
  // Bound the free-form title so a pathological value can't bloat the file.
  const title =
    input.projectTitle.length > PROJECT_TITLE_MAX_CHARS
      ? input.projectTitle.slice(0, PROJECT_TITLE_MAX_CHARS) + '…'
      : input.projectTitle;

  const bodies: Record<ContextSection, string> = {
    'Current State': sectionBody(
      input.specSummary ?? 'Planning complete; no tasks executed yet.',
    ),
    // Key Decisions seeds from PM assumptions; with none, an explicit placeholder.
    'Key Decisions': sectionBody(bulletList(input.assumptions)),
    'Interfaces & Contracts': sectionBody(input.interfaces),
    'Known Risks': sectionBody(bulletList(input.risks)),
    'Next Task Handoff': sectionBody(input.firstTaskHandoff),
  };

  const lines: string[] = [
    `# Project Context: ${title}`,
    '',
    `> Orchestration state for the \`${input.product}\` project "${title}".`,
    '> Owned by Jarvis\'s context curator — roles read a bounded slice and emit handoff',
    '> notes; they do not author this file directly.',
    '',
  ];

  for (const section of CONTEXT_SECTIONS) {
    lines.push(`## ${section}`, '', bodies[section], '');
  }

  return lines.join('\n').trimEnd() + '\n';
}

/**
 * Whether `content` contains every required section header. The minimal
 * structural gate both the seed and the Phase 3 update path must satisfy — a
 * context update that silently drops a section is rejected on this predicate.
 */
export function hasRequiredSections(content: string): boolean {
  return CONTEXT_SECTIONS.every((section) =>
    new RegExp(`^##\\s+${escapeRegExp(section)}\\s*$`, 'm').test(content),
  );
}

/** Escape a literal string for use inside a `RegExp`. Exported so the context
 *  curator reuses the one copy rather than duplicating it. */
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
