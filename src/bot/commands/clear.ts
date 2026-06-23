import { deleteSession, getSession, type Transport, type SessionScope } from '../../vault/sessions.js';
import { hasActiveReview } from '../../reviews/orchestrator.js';
import { abandonActivePlanningSession, getActivePlanningSession } from '../../reviews/planning.js';
import { createLogger } from '../../utils/logger.js';
import type { MessageSender } from '../../transport/sender.js';

const log = createLogger('clear');

function planningMatchesScope(
  planning: ReturnType<typeof getActivePlanningSession>,
  scope?: SessionScope,
): boolean {
  if (!planning) return false;
  if (!scope || scope.kind === 'global') return true;
  return planning.planning.product === scope.product;
}

export async function handleClear(
  sender: MessageSender,
  userId: number,
  transport: Transport,
  scope?: SessionScope,
): Promise<void> {
  // Active planning session is an escape hatch the spec promises (`/clear` or
  // `/fresh` abandons it). Handle it before the chat-session check so a chat
  // with only a planning session — no conversation thread — still has a way
  // to bail out. If a review is also active, surface that explicitly so the
  // user knows the review still needs `/fresh` to close.
  if (planningMatchesScope(getActivePlanningSession(userId), scope)) {
    abandonActivePlanningSession(userId);
    log.info('Planning session abandoned via /clear', { userId, transport });
    const reviewNote = hasActiveReview(userId)
      ? ' You still have an active review — use /fresh to close it.'
      : '';
    await sender.send(userId, `Planning session abandoned.${reviewNote}`);
    return;
  }

  const session = scope ? getSession(userId, transport, scope) : getSession(userId, transport);
  if (!session) {
    await sender.send(userId, 'No active session to clear.');
    return;
  }
  if (hasActiveReview(userId)) {
    await sender.send(userId, 'Active review in progress — use /fresh to close it first.');
    return;
  }
  if (scope) deleteSession(userId, transport, scope);
  else deleteSession(userId, transport);
  log.info('Session cleared', { userId, transport });
  await sender.send(userId, 'Session cleared.');
}
