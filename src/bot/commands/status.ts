import TelegramBot from 'node-telegram-bot-api';
import { getAllSessions } from '../../vault/sessions.js';

const startTime = Date.now();

export async function handleStatus(bot: TelegramBot, chatId: number): Promise<void> {
  const uptimeMs = Date.now() - startTime;
  const hours = Math.floor(uptimeMs / 3_600_000);
  const minutes = Math.floor((uptimeMs % 3_600_000) / 60_000);

  const sessions = getAllSessions();

  const lines = [
    `Uptime: ${hours}h ${minutes}m`,
    `Active sessions: ${sessions.length}`,
  ];

  await bot.sendMessage(chatId, lines.join('\n'));
}
