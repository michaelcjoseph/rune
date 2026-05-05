import { runLibrarySync } from '../../jobs/lenny-sync.js';
import type { MessageSender } from '../../transport/sender.js';

export async function handleLibrarySync(sender: MessageSender, userId: number): Promise<void> {
  await sender.send(userId, 'Syncing Lenny library...');
  sender.startTyping(userId);
  try {
    const result = await runLibrarySync();
    const msg = result.status === 'error'
      ? `Library sync failed: ${result.detail}`
      : `Library sync complete: ${result.detail}`;
    await sender.send(userId, msg);
  } finally {
    sender.stopTyping(userId);
  }
}
