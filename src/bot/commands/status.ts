import TelegramBot from 'node-telegram-bot-api';
import { getAllSessions, getSession } from '../../vault/sessions.js';

export async function handleStatus(bot: TelegramBot, chatId: number): Promise<void> {
  const uptimeSec = process.uptime();
  const hours = Math.floor(uptimeSec / 3600);
  const minutes = Math.floor((uptimeSec % 3600) / 60);

  const sessions = getAllSessions();

  const currentSession = getSession(chatId);

  const lines = [
    `Uptime: ${hours}h ${minutes}m`,
    `Active sessions: ${sessions.length}`,
    `Model: ${currentSession?.model || 'none'}`,
  ];

  await bot.sendMessage(chatId, lines.join('\n'));
}
