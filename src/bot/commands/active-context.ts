import { getActivePlanningSession } from '../../reviews/planning.js';
import { hasActiveReview } from '../../reviews/orchestrator.js';
import { hasActiveSRSession } from '../../study/sr-session.js';

/**
 * When `/fresh` or `/fresh-full` finds no chat session, the user may still be
 * in a non-chat conversational context that routes ahead of the chat path in
 * `dispatchText` — a planning session, a review interview, or a spaced-
 * repetition session. Each replies conversationally but never creates a chat
 * `Session`, so the bare "No active conversation to log." reads as a bug.
 *
 * Returns a context-specific message pointing at the right escape hatch, or
 * `null` when the user genuinely has nothing open (so the caller falls back to
 * the plain no-conversation reply). Escape hatches mirror `handleClear` and
 * `handleCancelReview`.
 */
export function describeActiveNonChatContext(userId: number): string | null {
  if (getActivePlanningSession(userId)) {
    return "You're in a planning session, not a chat — /approve to scaffold the spec, or /clear to abandon it.";
  }
  if (hasActiveReview(userId)) {
    return "You're in an active review — finish the interview, or /cancel-review to clear it.";
  }
  if (hasActiveSRSession(userId)) {
    return "You're in a study session — answer the question, or /clear to end it.";
  }
  return null;
}
