import TelegramBot from 'node-telegram-bot-api';
import { seedAndProcess } from '../../kb/seed.js';
import { sendLongMessage, startTyping, stopTyping } from '../../integrations/telegram/client.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('cmd-seed');

export async function handleSeed(bot: TelegramBot, chatId: number, args: string): Promise<void> {
  const dryRun = args.trim() === '--dry-run';

  await bot.sendMessage(
    chatId,
    dryRun ? 'Scanning vault for seed sources...' : 'Seeding KB: discovering and enqueuing vault files...',
  );
  const typing = startTyping(bot, chatId);

  try {
    const result = await seedAndProcess(
      undefined,
      async (msg) => {
        await bot.sendMessage(chatId, msg);
      },
      { dryRun, processAfter: !dryRun },
    );

    stopTyping(typing);

    const summary = [
      `Seed complete.`,
      `Discovered: ${result.seed.discovered}`,
      `Already ingested: ${result.seed.skippedAlreadyIngested}`,
      `Enqueued: ${result.seed.enqueued}`,
    ];

    if (!dryRun) {
      summary.push(`Processed: ${result.processed}`, `Errors: ${result.errors}`);
    }

    await sendLongMessage(bot, chatId, summary.join('\n'));
  } catch (err) {
    stopTyping(typing);
    log.error('Seed error', { error: (err as Error).message });
    await bot.sendMessage(chatId, `Seed error: ${(err as Error).message}`);
  }
}
