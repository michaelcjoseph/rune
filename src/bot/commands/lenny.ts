import TelegramBot from 'node-telegram-bot-api';
import { searchVault } from '../../kb/search.js';
import { askClaudeOneShot } from '../../ai/claude.js';
import { sendLongMessage, startTyping, stopTyping } from '../../integrations/telegram/client.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('cmd-lenny');

export async function handleLenny(bot: TelegramBot, chatId: number, topic: string): Promise<void> {
  if (!topic) {
    await bot.sendMessage(chatId, 'Usage: /lenny <topic>');
    return;
  }

  const typing = startTyping(bot, chatId);
  try {
    const results = searchVault(topic, {
      directory: 'library/lennys-podcast',
      maxResults: 15,
    });

    if (results.length === 0) {
      stopTyping(typing);
      await bot.sendMessage(chatId, `No matches for "${topic}" in Lenny's Podcast transcripts.`);
      return;
    }

    const context = results
      .map((r) => `[${r.file}] ${r.content}`)
      .join('\n');

    const prompt = `Search Lenny's Podcast transcripts for insights on: ${topic}

Search results (${results.length} matches):
${context}

Synthesize the key insights on this topic from the search results. Include direct quotes where possible, attributed to the episode or guest. Be concise.`;

    const result = await askClaudeOneShot(prompt);
    stopTyping(typing);

    if (result.error) {
      log.error('Lenny synthesis failed', { error: result.error });
      await bot.sendMessage(chatId, `Error: ${result.error}`);
      return;
    }

    await sendLongMessage(bot, chatId, result.text || 'No synthesis generated.');
  } catch (err) {
    stopTyping(typing);
    log.error('Lenny error', { error: (err as Error).message });
    await bot.sendMessage(chatId, `Error: ${(err as Error).message}`);
  }
}
