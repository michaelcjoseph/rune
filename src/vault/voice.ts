import { readVaultFile } from './files.js';

export const VOICE_FILENAME = 'writing/voice.md';

/** Soft cap on the voice content embedded in a prompt. Voice.md is user-owned
 *  and may grow over time; the cap protects every opted-in prompt from silent
 *  context-window inflation. Mirrors LEARNINGS_PROMPT_CHAR_BUDGET. The on-disk
 *  file is never modified. */
export const VOICE_PROMPT_CHAR_BUDGET = 8000;

/** Read writing/voice.md and wrap it as a prompt-prepend block. Returns '' if
 *  the file is missing or empty so callers can concatenate unconditionally.
 *  Re-reads on every call — the file is small and the user expects edits to
 *  take effect immediately without a process restart. Truncates with a
 *  trailing marker if the trimmed file exceeds VOICE_PROMPT_CHAR_BUDGET. */
export function buildVoicePromptSection(
  charBudget: number = VOICE_PROMPT_CHAR_BUDGET,
): string {
  const trimmed = readVaultFile(VOICE_FILENAME)?.trim() ?? '';
  if (!trimmed) return '';
  const body = trimmed.length > charBudget
    ? `${trimmed.slice(0, charBudget)}\n\n…(truncated — voice.md exceeds ${charBudget}-char prompt budget)`
    : trimmed;
  return `## Writing Voice

When writing prose I'll read (replies, journal entries, summaries, reviews, drafts), match the voice described below. This is the source of truth and will evolve over time — apply it; don't quote or summarize it back at me.

${body}

---

`;
}
