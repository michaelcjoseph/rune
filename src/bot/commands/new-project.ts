import { startReview } from '../../reviews/orchestrator.js';
import { getTodayDate } from '../../utils/time.js';
import { createLogger } from '../../utils/logger.js';
import type { MessageSender } from '../../transport/sender.js';

// Side-effect import: registers the new-project review handler
import '../../reviews/new-project.js';

const log = createLogger('cmd-new-project');

export async function handleNewProject(sender: MessageSender, userId: number, args: string): Promise<void> {
  const date = getTodayDate();
  const topic = args.trim() || undefined;
  log.info('Starting new project interview', { userId, topic });
  await startReview(userId, 'new-project', date, sender, topic);
}
