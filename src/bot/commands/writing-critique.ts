import { startWritingProductRun } from '../../jobs/writing-product-orchestration.js';
import { createLogger } from '../../utils/logger.js';
import type { MessageSender } from '../../transport/sender.js';

const log = createLogger('cmd-writing-critique');

function slugifyTarget(target: string): string {
  const slug = target
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!slug) {
    throw new Error('handleWritingCritique: target must include at least one alphanumeric character');
  }
  return slug;
}

export async function handleWritingCritique(
  sender: MessageSender,
  userId: number,
  args: string,
): Promise<void> {
  const target = args.trim();
  if (!target) {
    await sender.send(userId, 'Usage: /writing-critique <target>');
    return;
  }

  const outputPath = `docs/rune/critiques/${slugifyTarget(target)}.md`;
  log.info('Starting writing product critique run', { userId, outputPath });
  await startWritingProductRun({
    command: 'writing-critique',
    chatId: userId,
    target,
    outputPath,
    sender,
  });
}
