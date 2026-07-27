/**
 * Context curator — the Rune-owned `context.md` update + validation (project
 * 14, Phase 3).
 *
 * `context.md` is orchestration state, and THIS module is its only writer. Roles
 * emit handoff notes; the curator decides what reaches the file. Every post-task
 * update flows through `applyContextUpdate`, which enforces four invariants:
 *
 *   1. Validation gates — a technical contract change needs tech-lead validation;
 *      a flagged product-intent change needs PM validation. An unvalidated gated
 *      change is refused, not silently applied.
 *   2. Budget — an update's combined new text is bounded; an over-budget update
 *      (a transcript pasted in) is refused.
 *   3. No transcript dumps — a speaker-tagged conversation dump is refused even
 *      under budget; the context is decision-oriented, not a log.
 *   4. Section preservation — the five required sections survive every update.
 *
 * Pure — no I/O. The fs read/write layer (Phase 3 runtime) wraps this; the
 * curator only transforms strings.
 */

import {
  CONTEXT_SECTIONS,
  EMPTY_SECTION_PLACEHOLDER,
  contextHeadingRegExp,
  hasRequiredSections,
  type ContextSection,
} from './project-context.js';
import {
  CONTEXT_CONFLICTING_HEADINGS_MAX,
  CONTEXT_PROPOSED_REPAIR_MAX_CHARS,
  type ContextUpdateFailure,
  type ContextUpdateReason,
} from './context-closeout.js';
export type {
  ContextUpdateFailure,
  ContextUpdateReason,
} from './context-closeout.js';

/** Budget for one update's combined new text (section bodies + handoff notes).
 *  Past this the update is refused as over-budget — the cap that keeps a
 *  transcript paste out of the orchestration state. */
export const CONTEXT_UPDATE_MAX_CHARS = 6000;

/** At/above this many speaker-tagged lines, an update body reads as a transcript
 *  dump rather than a decision summary, and is refused. */
export const TRANSCRIPT_SPEAKER_LINE_THRESHOLD = 6;
const LEGACY_INTERFACES_HEADING = 'Canonical Interfaces';
const CANONICAL_INTERFACES_SECTION = 'Interfaces & Contracts';
const CANONICAL_INTERFACES_HEADING = `## ${CANONICAL_INTERFACES_SECTION}`;

/** Why the curator classified an update — drives whose validation it needs. */
export type ContextUpdateKind = 'neutral' | 'technical' | 'product';

/** A proposed post-task context update. The curator decides whether to apply it. */
export interface ContextUpdate {
  /** Update class — gates which role's validation (if any) is required. */
  kind: ContextUpdateKind;
  /** New body per section. Omitted sections are left as-is. */
  sections: Partial<Record<ContextSection, string>>;
  /** Role handoff notes → appended into Next Task Handoff (roles never write the
   *  file directly; the curator threads their notes). */
  handoffNotes?: string[];
  /** Whether the responsible role (tech-lead for technical, PM for product)
   *  validated this change. Required for a gated change to apply. */
  validated?: boolean;
  /** Whether this product-class change actually alters product intent (only then
   *  is PM validation required). */
  productIntentFlagged?: boolean;
}

export type ContextUpdateResult =
  | { ok: true; content: string }
  | ({ ok: false } & ContextUpdateFailure);

/**
 * Apply a proposed update to `current` context content, or refuse it with a
 * typed reason. Checks run in order: validation gate → budget → transcript-dump
 * → embedded-heading refusal → deterministic migration/upsert → apply →
 * exact-once section preservation. The first failure wins; nothing is applied
 * on a refusal.
 */
export function applyContextUpdate(current: string, update: ContextUpdate): ContextUpdateResult {
  // Gate 1: validation. A gated change without its role's validation is refused.
  if (update.kind === 'technical' && !update.validated) {
    return failure(
      'needs-tech-lead-validation',
      'Have the tech lead validate the technical context update, then retry closeout.',
    );
  }
  if (update.kind === 'product' && update.productIntentFlagged && !update.validated) {
    return failure(
      'needs-pm-validation',
      'Have the PM validate the product-intent context update, then retry closeout.',
    );
  }

  const newTexts: string[] = [
    ...Object.values(update.sections).filter((b): b is string => typeof b === 'string'),
    ...(update.handoffNotes ?? []),
  ];

  // Gate 2: budget.
  const totalNew = newTexts.reduce((n, t) => n + t.length, 0);
  if (totalNew > CONTEXT_UPDATE_MAX_CHARS) {
    return failure(
      'over-budget',
      `Reduce the proposed context update to at most ${CONTEXT_UPDATE_MAX_CHARS} characters.`,
    );
  }

  // Gate 3: transcript-dump heuristic.
  if (newTexts.some(looksLikeTranscript)) {
    return failure(
      'transcript-dump',
      'Replace transcript-style content with a concise decision and handoff summary.',
    );
  }

  // Gate 3b: a body that embeds a `## <required-section>` header would create a
  // duplicate header on apply, forking the document so later section replacements
  // target the wrong copy. Refuse it — section bodies are content, not structure.
  const embeddedHeading = newTexts
    .map(findManagedHeading)
    .find((heading): heading is ManagedHeadingMatch => heading !== undefined);
  if (embeddedHeading !== undefined) {
    return failure(
      'embedded-section-header',
      'Remove the managed heading from the update body and provide body content only.',
      embeddedHeading.canonicalHeading,
      [embeddedHeading.foundHeading],
    );
  }

  const normalized = normalizeManagedSections(current);
  if (!normalized.ok) {
    return normalized;
  }

  // Apply section replacements, then thread handoff notes into Next Task Handoff.
  let content = normalized.content;
  for (const section of CONTEXT_SECTIONS) {
    const body = update.sections[section];
    if (typeof body === 'string') {
      content = replaceSection(content, section, body);
    }
  }
  if (update.handoffNotes && update.handoffNotes.length > 0) {
    const notes = update.handoffNotes.map((n) => `- ${n}`).join('\n');
    content = replaceSection(content, 'Next Task Handoff', notes);
  }

  // Gate 4: every required section survived.
  if (!hasRequiredSections(content)) {
    const missing = CONTEXT_SECTIONS.find((section) =>
      !contextHeadingRegExp(section, 'm').test(content),
    );
    return failure(
      'missing-section',
      `Add exactly one \`## ${missing ?? CONTEXT_SECTIONS[0]}\` section and retry closeout.`,
      `## ${missing ?? CONTEXT_SECTIONS[0]}`,
    );
  }

  return { ok: true, content };
}

interface ManagedHeadingMatch {
  canonicalHeading: string;
  foundHeading: string;
}

type NormalizedManagedSections =
  | { ok: true; content: string }
  | Extract<ContextUpdateResult, { ok: false }>;

function failure(
  reason: ContextUpdateReason,
  proposedRepair: string,
  canonicalHeading?: string,
  conflictingHeadings?: string[],
  conflictingHeadingCount?: number,
): { ok: false } & ContextUpdateFailure {
  const conflictCount = conflictingHeadingCount ?? conflictingHeadings?.length;
  const boundedConflicts = conflictingHeadings?.slice(0, CONTEXT_CONFLICTING_HEADINGS_MAX);
  return {
    ok: false,
    reason,
    ...(canonicalHeading !== undefined ? { canonicalHeading } : {}),
    ...(boundedConflicts !== undefined ? { conflictingHeadings: boundedConflicts } : {}),
    ...(conflictCount !== undefined &&
      boundedConflicts !== undefined &&
      conflictCount > boundedConflicts.length
      ? { conflictingHeadingCount: conflictCount }
      : {}),
    proposedRepair: proposedRepair.slice(0, CONTEXT_PROPOSED_REPAIR_MAX_CHARS),
  };
}

function findManagedHeading(text: string): ManagedHeadingMatch | undefined {
  for (const section of CONTEXT_SECTIONS) {
    const found = text.match(
      contextHeadingRegExp(section, 'm'),
    )?.[0]?.trim();
    if (found !== undefined) {
      return {
        canonicalHeading: `## ${section}`,
        foundHeading: found,
      };
    }
  }
  const legacy = text.match(
    contextHeadingRegExp(LEGACY_INTERFACES_HEADING, 'm'),
  )?.[0]?.trim();
  return legacy === undefined
    ? undefined
    : {
        canonicalHeading: CANONICAL_INTERFACES_HEADING,
        foundHeading: legacy,
      };
}

/**
 * Deterministically migrate/upsert the managed document shape before applying
 * section bodies. Ambiguous documents fail with repair metadata rather than
 * guessing how competing bodies should be merged.
 */
function normalizeManagedSections(current: string): NormalizedManagedSections {
  const lines = current.split('\n');
  const headingOccurrences = new Map<string, { count: number; firstIndex?: number }>();
  const managedNames = [...CONTEXT_SECTIONS, LEGACY_INTERFACES_HEADING];
  for (const heading of managedNames) headingOccurrences.set(heading, { count: 0 });

  for (let index = 0; index < lines.length; index++) {
    for (const heading of managedNames) {
      if (contextHeadingRegExp(heading).test(lines[index]!)) {
        const occurrence = headingOccurrences.get(heading)!;
        occurrence.count += 1;
        occurrence.firstIndex ??= index;
      }
    }
  }

  const canonicalInterfaces = headingOccurrences.get(CANONICAL_INTERFACES_SECTION)!;
  const legacyInterfaces = headingOccurrences.get(LEGACY_INTERFACES_HEADING)!;
  if (canonicalInterfaces.count > 0 && legacyInterfaces.count > 0) {
    const conflictCount = canonicalInterfaces.count + legacyInterfaces.count;
    return failure(
      'managed-heading-collision',
      'Merge all competing bodies, retain exactly one `## Interfaces & Contracts` section, and remove every legacy heading.',
      CANONICAL_INTERFACES_HEADING,
      headingSample([
        [CANONICAL_INTERFACES_HEADING, canonicalInterfaces.count],
        [`## ${LEGACY_INTERFACES_HEADING}`, legacyInterfaces.count],
      ]),
      conflictCount,
    );
  }

  for (const section of CONTEXT_SECTIONS) {
    const occurrences = headingOccurrences.get(section)!;
    if (occurrences.count > 1) {
      return failure(
        'duplicate-managed-section',
        `Merge the competing bodies and keep exactly one \`## ${section}\` section.`,
        `## ${section}`,
        headingSample([[`## ${section}`, occurrences.count]]),
        occurrences.count,
      );
    }
  }
  if (legacyInterfaces.count > 1) {
    return failure(
      'duplicate-managed-section',
      'Merge the competing legacy interface bodies and keep exactly one canonical `## Interfaces & Contracts` section.',
      CANONICAL_INTERFACES_HEADING,
      headingSample([[`## ${LEGACY_INTERFACES_HEADING}`, legacyInterfaces.count]]),
      legacyInterfaces.count,
    );
  }

  if (legacyInterfaces.count === 1) {
    lines[legacyInterfaces.firstIndex!] = CANONICAL_INTERFACES_HEADING;
  }

  let content = lines.join('\n');
  for (const section of CONTEXT_SECTIONS) {
    const count = content.match(
      contextHeadingRegExp(section, 'gm'),
    )?.length ?? 0;
    if (count === 0) {
      content = `${content.trimEnd()}\n\n## ${section}\n\n${EMPTY_SECTION_PLACEHOLDER}\n`;
    }
  }
  return { ok: true, content: content.trimEnd() + '\n' };
}

function headingSample(groups: ReadonlyArray<readonly [string, number]>): string[] {
  const sample: string[] = [];
  for (const [heading, count] of groups) {
    const remaining = CONTEXT_CONFLICTING_HEADINGS_MAX - sample.length;
    if (remaining <= 0) break;
    sample.push(...Array.from({ length: Math.min(count, remaining) }, () => heading));
  }
  return sample;
}

/** A body reads as a transcript when it carries many speaker-tagged lines
 *  (`User:`, `Assistant:`, `System:`, `Human:`, `AI:`). Decision summaries don't. */
function looksLikeTranscript(text: string): boolean {
  const speakerLines = text
    .split('\n')
    .filter((line) => /^\s*(user|assistant|system|human|ai)\s*:/i.test(line));
  return speakerLines.length >= TRANSCRIPT_SPEAKER_LINE_THRESHOLD;
}

/**
 * Replace the body of a normalized `## <section>` block with `body`, preserving
 * every other section. Normalization guarantees the header exists exactly once;
 * the append fallback keeps this helper safe if called independently later.
 */
function replaceSection(content: string, section: ContextSection, body: string): string {
  const lines = content.split('\n');
  const headerRe = contextHeadingRegExp(section);
  const headerIdx = lines.findIndex((l) => headerRe.test(l));

  if (headerIdx === -1) {
    return `${content.trimEnd()}\n\n## ${section}\n\n${body}\n`;
  }

  let nextIdx = lines.length;
  for (let i = headerIdx + 1; i < lines.length; i++) {
    if (/^##[ \t]/.test(lines[i]!)) {
      nextIdx = i;
      break;
    }
  }

  const rebuilt = [...lines.slice(0, headerIdx + 1), '', body, '', ...lines.slice(nextIdx)];
  return rebuilt.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}
