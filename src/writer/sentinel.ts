/**
 * Writer completion sentinel (project 12, Phase 2).
 *
 * Session closure is SERVER-owned: `src/reviews/blog.ts` only ends a session on
 * *user* text `/done`, and model output is otherwise just relayed. So the writer
 * signals it is finished by emitting a completion sentinel as the FINAL line of
 * its output; `blogHandler` detects that sentinel, strips it from the
 * user-visible reply, runs capture once, and closes the session.
 *
 * Only a final-line sentinel counts — earlier appearances in prose are ignored,
 * so the model discussing the sentinel mid-conversation never triggers closure.
 */

/** The exact sentinel the writer emits on its own final line to signal done. */
export const WRITER_COMPLETION_SENTINEL = '[[WRITER_MEMORY_COMPLETE]]';

export interface SentinelDetection {
  /** True only when the sentinel is the final non-empty line of `text`. */
  complete: boolean;
  /** `text` with the final-line sentinel removed and trailing whitespace
   *  trimmed. Equals the original `text` when `complete` is false. */
  cleaned: string;
}

/** Detect a final-line completion sentinel and return the cleaned text.
 *  A sentinel that appears only earlier in the prose does NOT count — only the
 *  last non-empty line is checked, and trailing blank lines after it are ignored. */
export function detectCompletionSentinel(text: string): SentinelDetection {
  const lines = text.split('\n');

  // Index of the last non-empty (trimmed) line — trailing blank lines are skipped.
  let lastIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i]!.trim() !== '') {
      lastIdx = i;
      break;
    }
  }

  // Compare the trimmed last line: incidental indentation/CR around the sentinel
  // still counts. A missed real sentinel (false negative) forces the user to type
  // /done, which is worse than the near-impossible false positive of the model
  // emitting an indented sentinel it did not mean as the final line.
  if (lastIdx === -1 || lines[lastIdx]!.trim() !== WRITER_COMPLETION_SENTINEL) {
    return { complete: false, cleaned: text };
  }

  // Drop the sentinel line and any trailing whitespace it left behind.
  const cleaned = lines.slice(0, lastIdx).join('\n').trimEnd();
  return { complete: true, cleaned };
}
