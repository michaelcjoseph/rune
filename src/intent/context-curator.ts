/**
 * Context curator — the Jarvis-owned `context.md` update + validation (project
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
  escapeRegExp,
  hasRequiredSections,
  type ContextSection,
} from './project-context.js';

/** Budget for one update's combined new text (section bodies + handoff notes).
 *  Past this the update is refused as over-budget — the cap that keeps a
 *  transcript paste out of the orchestration state. */
export const CONTEXT_UPDATE_MAX_CHARS = 6000;

/** At/above this many speaker-tagged lines, an update body reads as a transcript
 *  dump rather than a decision summary, and is refused. */
export const TRANSCRIPT_SPEAKER_LINE_THRESHOLD = 6;

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

export type ContextUpdateReason =
  | 'missing-section'
  | 'embedded-section-header'
  | 'over-budget'
  | 'transcript-dump'
  | 'needs-tech-lead-validation'
  | 'needs-pm-validation';

export type ContextUpdateResult =
  | { ok: true; content: string }
  | { ok: false; reason: ContextUpdateReason };

/**
 * Apply a proposed update to `current` context content, or refuse it with a
 * typed reason. Checks run in order: validation gate → budget → transcript-dump
 * → apply → section-preservation. The first failure wins; nothing is applied on
 * a refusal.
 */
export function applyContextUpdate(current: string, update: ContextUpdate): ContextUpdateResult {
  // Gate 1: validation. A gated change without its role's validation is refused.
  if (update.kind === 'technical' && !update.validated) {
    return { ok: false, reason: 'needs-tech-lead-validation' };
  }
  if (update.kind === 'product' && update.productIntentFlagged && !update.validated) {
    return { ok: false, reason: 'needs-pm-validation' };
  }

  const newTexts: string[] = [
    ...Object.values(update.sections).filter((b): b is string => typeof b === 'string'),
    ...(update.handoffNotes ?? []),
  ];

  // Gate 2: budget.
  const totalNew = newTexts.reduce((n, t) => n + t.length, 0);
  if (totalNew > CONTEXT_UPDATE_MAX_CHARS) {
    return { ok: false, reason: 'over-budget' };
  }

  // Gate 3: transcript-dump heuristic.
  if (newTexts.some(looksLikeTranscript)) {
    return { ok: false, reason: 'transcript-dump' };
  }

  // Gate 3b: a body that embeds a `## <required-section>` header would create a
  // duplicate header on apply, forking the document so later section replacements
  // target the wrong copy. Refuse it — section bodies are content, not structure.
  if (newTexts.some(containsRequiredSectionHeader)) {
    return { ok: false, reason: 'embedded-section-header' };
  }

  // Apply section replacements, then thread handoff notes into Next Task Handoff.
  let content = current;
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
    return { ok: false, reason: 'missing-section' };
  }

  return { ok: true, content };
}

/** Matches a line that is exactly a required-section header (`## Known Risks`). */
const REQUIRED_SECTION_HEADER_RE = new RegExp(
  `^##\\s+(?:${CONTEXT_SECTIONS.map(escapeRegExp).join('|')})\\s*$`,
  'm',
);

/** Whether a body embeds a `## <required-section>` header line — which would
 *  duplicate the header on apply. */
function containsRequiredSectionHeader(text: string): boolean {
  return REQUIRED_SECTION_HEADER_RE.test(text);
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
 * Replace the body of a `## <section>` block with `body`, preserving every other
 * section. When the header is absent (a malformed base), the section is appended
 * rather than silently swallowing the update — the caller's section-preservation
 * gate still catches a base that was already missing a different required header.
 */
function replaceSection(content: string, section: ContextSection, body: string): string {
  const lines = content.split('\n');
  const headerRe = new RegExp(`^##\\s+${escapeRegExp(section)}\\s*$`);
  const headerIdx = lines.findIndex((l) => headerRe.test(l));

  if (headerIdx === -1) {
    return `${content.trimEnd()}\n\n## ${section}\n\n${body}\n`;
  }

  let nextIdx = lines.length;
  for (let i = headerIdx + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i]!)) {
      nextIdx = i;
      break;
    }
  }

  const rebuilt = [...lines.slice(0, headerIdx + 1), '', body, '', ...lines.slice(nextIdx)];
  return rebuilt.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}
