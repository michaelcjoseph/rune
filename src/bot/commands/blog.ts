import { startReview } from '../../reviews/orchestrator.js';
import { getTodayDate } from '../../utils/time.js';
import { createLogger } from '../../utils/logger.js';
import type { MessageSender } from '../../transport/sender.js';

// Side-effect import: registers the blog review handler
import '../../reviews/blog.js';

const log = createLogger('cmd-blog');

export async function handleBlog(sender: MessageSender, userId: number, args: string): Promise<void> {
  if (!args) {
    await sender.send(userId, 'Usage: /blog <topic>');
    return;
  }

  log.info('Starting blog session', { userId, topic: args });
  await startReview(userId, 'blog', getTodayDate(), sender, args);
}
