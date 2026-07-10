import { startWritingProductRun } from '../../jobs/writing-product-orchestration.js';
import { createLogger } from '../../utils/logger.js';
import type { MessageSender } from '../../transport/sender.js';

const log = createLogger('cmd-writing-critique');

function parseWritingCritiqueArgs(args: string): { target: string; revisionRequested: boolean } {
  const trimmed = args.trim();
  const revisionMatch = trimmed.match(/^--(?:revise|revision)\s+(.+)$/i);
  if (!revisionMatch) {
    return { target: trimmed, revisionRequested: false };
  }
  return { target: (revisionMatch[1] ?? '').trim(), revisionRequested: true };
}

function critiqueOutputPath(target: string): string {
  const basename = target.trim().replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? target;
  const withoutExtension = basename.replace(/\.[a-z0-9]+$/i, '');
  const slug = withoutExtension
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!slug) {
    throw new Error('handleWritingCritique: target must include at least one alphanumeric character');
  }
  return `docs/rune/critiques/${slug}.md`;
}

export async function handleWritingCritique(
  sender: MessageSender,
  userId: number,
  args: string,
): Promise<void> {
  const { target, revisionRequested } = parseWritingCritiqueArgs(args);
  if (!target) {
    await sender.send(userId, 'Usage: /writing-critique <target>');
    return;
  }

  const outputPath = critiqueOutputPath(target);
  log.info('Starting writing product critique run', { userId, outputPath });
  await startWritingProductRun({
    command: 'writing-critique',
    chatId: userId,
    target,
    outputPath,
    revisionRequested,
  });
}
