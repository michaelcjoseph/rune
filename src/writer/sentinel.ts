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
 *
 * SCAFFOLD: the body throws `notImplemented(...)` so the Phase 2 test suite is
 * RED until the sentinel implementation lands.
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

function notImplemented(fn: string): never {
  throw new Error(`writer/sentinel: ${fn} not implemented (project 12 Phase 2 pending)`);
}

/** Detect a final-line completion sentinel and return the cleaned text.
 *  A sentinel that appears only earlier in the prose does NOT count. */
export function detectCompletionSentinel(_text: string): SentinelDetection {
  return notImplemented('detectCompletionSentinel');
}
