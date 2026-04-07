import TelegramBot from 'node-telegram-bot-api';
import { ingestSource, processIngestionQueue } from '../../kb/engine.js';
import { getQueue } from '../../kb/queue.js';
import { sendLongMessage, startTyping, stopTyping } from '../../integrations/telegram/client.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('cmd-ingest');

export async function handleIngest(bot: TelegramBot, chatId: number, args: string): Promise<void> {
  const trimmed = args.trim();

  // If no args, process the ingestion queue
  if (!trimmed) {
    const queue = getQueue();
    if (queue.length === 0) {
      await bot.sendMessage(chatId, 'Ingestion queue is empty. Usage: /ingest <path-to-source>');
      return;
    }

    await bot.sendMessage(chatId, `Processing ${queue.length} queued source(s)...`);
    const typing = startTyping(bot, chatId);
    const { processed, errors } = await processIngestionQueue();
    stopTyping(typing);
    await bot.sendMessage(chatId, `Ingestion complete. Processed: ${processed}, Errors: ${errors}`);
    return;
  }

  // Parse: /ingest <path> [guidance after --]
  let sourcePath = trimmed;
  let guidance: string | undefined;
  const dashIdx = trimmed.indexOf(' -- ');
  if (dashIdx !== -1) {
    sourcePath = trimmed.slice(0, dashIdx).trim();
    guidance = trimmed.slice(dashIdx + 4).trim();
  }

  const typing = startTyping(bot, chatId);
  try {
    const result = await ingestSource(sourcePath, { guidance });
    stopTyping(typing);

    if (result.success) {
      await sendLongMessage(bot, chatId, `Ingested successfully.\n\n${result.output}`);
    } else {
      await bot.sendMessage(chatId, `Ingestion failed: ${result.output}`);
    }
  } catch (err) {
    stopTyping(typing);
    log.error('Ingest error', { error: (err as Error).message, source: sourcePath });
    await bot.sendMessage(chatId, `Ingest error: ${(err as Error).message}`);
  }
}
