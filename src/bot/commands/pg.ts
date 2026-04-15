import TelegramBot from 'node-telegram-bot-api';
import { searchVault } from '../../kb/search.js';
import { askClaudeOneShot } from '../../ai/claude.js';
import { sendLongMessage, startTyping, stopTyping } from '../../integrations/telegram/client.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('cmd-pg');

export async function handlePG(bot: TelegramBot, chatId: number, topic: string): Promise<void> {
  if (!topic) {
    await bot.sendMessage(chatId, 'Usage: /pg <topic>');
    return;
  }

  const typing = startTyping(bot, chatId);
  try {
    const results = searchVault(topic, {
      directory: 'library/graham-essays',
      maxResults: 15,
    });

    if (results.length === 0) {
      stopTyping(typing);
      await bot.sendMessage(chatId, `No matches for "${topic}" in Paul Graham's essays.`);
      return;
    }

    const context = results
      .map((r) => `[${r.file}] ${r.content}`)
      .join('\n');

    const prompt = `Search Paul Graham's essays for insights on: ${topic}

Search results (${results.length} matches):
${context}

Synthesize the key insights on this topic from the search results. Include direct quotes where possible, attributed to the essay. Be concise.`;

    const result = await askClaudeOneShot(prompt);
    stopTyping(typing);

    if (result.error) {
      log.error('PG synthesis failed', { error: result.error });
      await bot.sendMessage(chatId, `Error: ${result.error}`);
      return;
    }

    await sendLongMessage(bot, chatId, result.text || 'No synthesis generated.');
  } catch (err) {
    stopTyping(typing);
    log.error('PG error', { error: (err as Error).message });
    await bot.sendMessage(chatId, `Error: ${(err as Error).message}`);
  }
}
