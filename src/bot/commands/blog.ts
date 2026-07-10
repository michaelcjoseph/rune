import { startWritingProductRun } from '../../jobs/writing-product-orchestration.js';
import { createLogger } from '../../utils/logger.js';
import type { MessageSender } from '../../transport/sender.js';

const log = createLogger('cmd-blog');

export async function handleBlog(sender: MessageSender, userId: number, args: string): Promise<void> {
  const topic = args.trim();
  if (!topic) {
    await sender.send(userId, 'Usage: /blog <topic>');
    return;
  }

  log.info('Starting writing product blog run', { userId, topic });
  await startWritingProductRun({
    command: 'blog',
    chatId: userId,
    topic,
  });
}
