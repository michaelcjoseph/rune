import { deleteSession, getSession, type Transport } from '../../vault/sessions.js';
import { hasActiveReview } from '../../reviews/orchestrator.js';
import { createLogger } from '../../utils/logger.js';
import type { MessageSender } from '../../transport/sender.js';

const log = createLogger('clear');

export async function handleClear(
  sender: MessageSender,
  userId: number,
  transport: Transport,
): Promise<void> {
  const session = getSession(userId, transport);
  if (!session) {
    await sender.send(userId, 'No active session to clear.');
    return;
  }
  if (hasActiveReview(userId)) {
    await sender.send(userId, 'Active review in progress — use /fresh to close it first.');
    return;
  }
  deleteSession(userId, transport);
  log.info('Session cleared', { userId, transport });
  await sender.send(userId, 'Session cleared.');
}
