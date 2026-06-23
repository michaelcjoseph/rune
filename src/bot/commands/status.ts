import { getAllSessions, getSession, type Transport, type SessionScope } from '../../vault/sessions.js';
import type { MessageSender } from '../../transport/sender.js';

export async function handleStatus(
  sender: MessageSender,
  userId: number,
  transport: Transport,
  scope?: SessionScope,
): Promise<void> {
  const uptimeSec = process.uptime();
  const hours = Math.floor(uptimeSec / 3600);
  const minutes = Math.floor((uptimeSec % 3600) / 60);

  const sessions = getAllSessions();
  const currentSession = scope ? getSession(userId, transport, scope) : getSession(userId, transport);

  const lines = [
    `Uptime: ${hours}h ${minutes}m`,
    `Active sessions: ${sessions.length}`,
    `Model: ${currentSession?.model || 'none'}`,
  ];

  await sender.send(userId, lines.join('\n'));
}
