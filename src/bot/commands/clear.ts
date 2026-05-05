import { deleteSession, getSession } from '../../vault/sessions.js';
import { hasActiveReview } from '../../reviews/orchestrator.js';
import { createLogger } from '../../utils/logger.js';
import type { MessageSender } from '../../transport/sender.js';

const log = createLogger('clear');

export async function handleClear(sender: MessageSender, userId: number): Promise<void> {
  const session = getSession(userId);
  if (!session) {
    await sender.send(userId, 'No active session to clear.');
    return;
  }
  if (hasActiveReview(userId)) {
    await sender.send(userId, 'Active review in progress — use /fresh to close it first.');
    return;
  }
  deleteSession(userId);
  log.info('Session cleared', { userId });
  await sender.send(userId, 'Session cleared.');
}
