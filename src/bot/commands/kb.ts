import { queryKB, getKBStats } from '../../kb/engine.js';
import { createLogger } from '../../utils/logger.js';
import type { MessageSender } from '../../transport/sender.js';

const log = createLogger('cmd-kb');

export async function handleKB(sender: MessageSender, userId: number, args: string): Promise<void> {
  const [subcommand, ...rest] = args.split(' ');
  const body = rest.join(' ').trim();

  switch (subcommand) {
    case 'query':
    case 'q':
      if (!body) {
        await sender.send(userId, 'Usage: /kb query <question>');
        return;
      }
      return handleKBQuery(sender, userId, body);

    case 'stats':
      return handleKBStats(sender, userId);

    case 'recent':
      return handleKBRecent(sender, userId);

    default:
      // If no subcommand, treat the entire args as a query
      if (args.trim()) {
        return handleKBQuery(sender, userId, args.trim());
      }
      await sender.send(userId,
        'KB Commands:\n/kb query <question>\n/kb stats\n/kb recent',
      );
  }
}

async function handleKBQuery(sender: MessageSender, userId: number, question: string): Promise<void> {
  sender.startTyping(userId, 'Querying knowledge base');
  try {
    const result = await queryKB(question);
    sender.stopTyping(userId);
    await sender.send(userId, result.answer);
  } catch (err) {
    sender.stopTyping(userId);
    log.error('KB query error', { error: (err as Error).message });
    await sender.send(userId, `KB query error: ${(err as Error).message}`);
  }
}

async function handleKBStats(sender: MessageSender, userId: number): Promise<void> {
  const stats = getKBStats();
  const lines = [
    'Knowledge Base Stats',
    '',
    `Total pages: ${stats.totalPages}`,
    `  Entities: ${stats.entities}`,
    `  Concepts: ${stats.concepts}`,
    `  Topics: ${stats.topics}`,
    `  Comparisons: ${stats.comparisons}`,
  ];
  await sender.send(userId, lines.join('\n'));
}

async function handleKBRecent(sender: MessageSender, userId: number): Promise<void> {
  const stats = getKBStats();
  if (stats.recentLog.length === 0) {
    await sender.send(userId, 'No recent KB activity.');
    return;
  }
  await sender.send(userId, `Recent KB Activity:\n\n${stats.recentLog.join('\n')}`);
}
