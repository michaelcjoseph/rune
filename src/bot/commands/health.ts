import { startReview } from '../../reviews/orchestrator.js';
import { getTodayDate } from '../../utils/time.js';
import { createLogger } from '../../utils/logger.js';
import type { MessageSender } from '../../transport/sender.js';

// Side-effect import: registers the health review handler
import '../../reviews/health.js';

const log = createLogger('cmd-health');

export async function handleHealth(sender: MessageSender, userId: number, args: string): Promise<void> {
  log.info('Starting health session', { userId, focus: args || 'general' });
  await startReview(userId, 'health', getTodayDate(), sender, args || undefined);
}
