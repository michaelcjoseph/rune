import { getAllSessions, getSession } from '../../vault/sessions.js';
import type { MessageSender } from '../../transport/sender.js';

export async function handleStatus(sender: MessageSender, userId: number): Promise<void> {
  const uptimeSec = process.uptime();
  const hours = Math.floor(uptimeSec / 3600);
  const minutes = Math.floor((uptimeSec % 3600) / 60);

  const sessions = getAllSessions();

  const currentSession = getSession(userId);

  const lines = [
    `Uptime: ${hours}h ${minutes}m`,
    `Active sessions: ${sessions.length}`,
    `Model: ${currentSession?.model || 'none'}`,
  ];

  await sender.send(userId, lines.join('\n'));
}
