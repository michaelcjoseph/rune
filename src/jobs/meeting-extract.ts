import { askClaudeOneShot } from '../ai/claude.js';
import { readVaultFile, writeVaultFile } from '../vault/files.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('meeting-extract');

export interface Meeting {
  /** People present at the meeting. Extractor returns whatever the LLM reads
   *  (wikilink slug or raw name); downstream CRM step handles canonicalization. */
  attendees: string[];
  /** Project slug referenced by the meeting (from a `[[project-slug]]` wikilink
   *  or explicit mention). `null` if no project is tagged / ambiguous. */
  project: string | null;
  /** One string per decision discussed. */
  decisions: string[];
}

const MEETING_TAG_RE = /#meeting\b/;
const JSON_FENCE_RE = /```json?\n?|\n?```/g;

/** Max journal content size sent to the LLM. Matches the nightly daily-tags ceiling
 *  (`src/jobs/nightly.ts:60`). Oversized journals are truncated with a marker. */
const MAX_JOURNAL_CHARS = 50_000;

/** Scan a journal for `#meeting` blocks and extract structured meeting data.
 *
 *  Short-circuits without an LLM call if the journal has no `#meeting` tag.
 *  Uses `askClaudeOneShot` with a structured-output prompt; blocks with no
 *  attendees AND no decisions are treated as references (not transcriptions)
 *  and excluded from the output. On any LLM or parse failure, returns `[]`
 *  and logs — a malformed response shouldn't block the nightly. */
export async function extractMeetings(journalContent: string, journalDate: string): Promise<Meeting[]> {
  if (!MEETING_TAG_RE.test(journalContent)) return [];

  const truncatedContent = journalContent.length > MAX_JOURNAL_CHARS
    ? journalContent.slice(0, MAX_JOURNAL_CHARS) + '\n\n[truncated]'
    : journalContent;
  if (truncatedContent !== journalContent) {
    log.warn('Journal truncated for meeting extraction', { journalDate, originalLength: journalContent.length });
  }

  const prompt = `You are extracting structured meeting data from a personal daily journal.

The journal may contain one or more \`#meeting\` blocks interleaved with unrelated content (morning prep, reading notes, project thoughts, workout logs). Find every \`#meeting\` block and return a JSON array of objects.

For each meeting, extract:
- **attendees** (string[]) — people at the meeting. Prefer the wikilink slug form (e.g. \`alice\` from \`[[alice]]\`); if only a name is given, use the name verbatim. Exclude the journal author — they're always present.
- **project** (string | null) — the project slug the meeting is about, from a \`[[project-slug]]\` wikilink, \`[[projects/project-slug]]\`, or an explicit mention. Return \`null\` if no project is clearly associated.
- **decisions** (string[]) — one short sentence per concrete decision or agreement reached in the meeting. Do not list action items or status updates.

**Meeting block boundaries:** a block starts at a line containing \`#meeting\` and ends at the next clearly unrelated content — typically the next major heading, a large time gap, another \`#meeting\`, or the end of the journal. Use your judgment holistically.

**Skip rule:** if a \`#meeting\` block has no attendees AND no decisions, it's a reference (e.g. "I should have a meeting about X") not a transcription. Do not include such blocks in the output.

Return a JSON array only. No prose, no markdown fences, no trailing commentary. Empty array \`[]\` if no transcribable meetings exist.

Journal date: ${journalDate}

Journal content:
---
${truncatedContent}
---`;

  const result = await askClaudeOneShot(prompt);
  if (result.error) {
    log.error('askClaudeOneShot failed', { error: result.error, journalDate });
    return [];
  }
  if (!result.text) {
    log.warn('askClaudeOneShot returned empty text', { journalDate });
    return [];
  }

  const cleaned = result.text.replace(JSON_FENCE_RE, '').trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    log.error('Failed to parse meeting-extract output', { journalDate, snippet: cleaned.slice(0, 200), error: (err as Error).message });
    return [];
  }

  if (!Array.isArray(parsed)) {
    log.error('meeting-extract output was not a JSON array', { journalDate, snippet: JSON.stringify(parsed).slice(0, 200) });
    return [];
  }

  // Validate and normalize each entry. Drop anything that doesn't match the shape.
  const meetings: Meeting[] = [];
  for (const raw of parsed) {
    if (typeof raw !== 'object' || raw === null) continue;
    const candidate = raw as Record<string, unknown>;
    const attendees = Array.isArray(candidate['attendees']) ? candidate['attendees'].filter((a): a is string => typeof a === 'string') : [];
    const decisions = Array.isArray(candidate['decisions']) ? candidate['decisions'].filter((d): d is string => typeof d === 'string') : [];
    const project = typeof candidate['project'] === 'string' ? candidate['project'] : null;
    // Belt-and-suspenders on the skip rule: the prompt asks the LLM to skip empties,
    // but drop them defensively in case it doesn't.
    if (attendees.length === 0 && decisions.length === 0) continue;
    meetings.push({ attendees, project, decisions });
  }

  log.info('Extracted meetings', { journalDate, count: meetings.length });
  return meetings;
}

export interface DecisionAppendResult {
  status: 'success' | 'skipped' | 'error';
  appended: number;
  detail: string;
}

const DECISIONS_HEADING_RE = /^##\s+Decisions Log\b/i;

/** Append meeting decisions to a project's Decisions Log section.
 *
 *  Inserts new `### [[YYYY_MM_DD]]: <decision>` entries at the top of the section,
 *  after the heading and any italic intro lines. Skips when the project file or
 *  Decisions Log section is missing — does not create either. */
export function appendProjectDecisions(slug: string, journalDate: string, decisions: string[]): DecisionAppendResult {
  if (decisions.length === 0) {
    return { status: 'skipped', appended: 0, detail: 'no decisions to append' };
  }
  const path = `projects/${slug}.md`;
  const content = readVaultFile(path);
  if (content === null) {
    return { status: 'skipped', appended: 0, detail: `${path} not found` };
  }

  const lines = content.split('\n');
  const headingIdx = lines.findIndex((l) => DECISIONS_HEADING_RE.test(l));
  if (headingIdx === -1) {
    return { status: 'skipped', appended: 0, detail: `${path} has no Decisions Log section` };
  }

  // Insert after the heading + any blank lines or italic intro lines.
  // Italic = `*text*` (single asterisks). Excludes `**bold**` and `* bullet`.
  const ITALIC_LINE_RE = /^\*[^*\s].*[^*\s]\*$|^\*[^*\s]\*$/;
  let insertIdx = headingIdx + 1;
  while (insertIdx < lines.length) {
    const trimmed = lines[insertIdx]!.trim();
    if (trimmed === '' || ITALIC_LINE_RE.test(trimmed)) {
      insertIdx++;
    } else {
      break;
    }
  }

  const ref = journalDate.replace(/-/g, '_');
  const newEntries: string[] = [];
  for (const d of decisions) {
    newEntries.push(`### [[${ref}]]: ${d}`);
    newEntries.push('');
  }
  // Drop the trailing blank if the next existing line is already blank — avoids
  // a double-blank between the last new entry and existing content.
  if (newEntries.length > 0 && lines[insertIdx]?.trim() === '') {
    newEntries.pop();
  }

  const updated = [...lines.slice(0, insertIdx), ...newEntries, ...lines.slice(insertIdx)].join('\n');
  try {
    writeVaultFile(path, updated);
  } catch (err) {
    log.error('Failed to write project decisions', { path, error: (err as Error).message });
    return { status: 'error', appended: 0, detail: `write failed: ${(err as Error).message}` };
  }

  log.info('Appended decisions to project', { path, count: decisions.length });
  return { status: 'success', appended: decisions.length, detail: `${decisions.length} decision(s) appended to ${path}` };
}
