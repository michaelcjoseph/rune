import { executeMorningPrep } from '../../jobs/morning-prep.js';
import { createLogger } from '../../utils/logger.js';
import type { MessageSender } from '../../transport/sender.js';

const log = createLogger('cmd-prep');

export async function handlePrep(sender: MessageSender, userId: number): Promise<void> {
  sender.startTyping(userId);
  try {
    const result = await executeMorningPrep();
    sender.stopTyping(userId);

    if (result.status === 'written') {
      await sender.send(userId, 'Morning prep complete. Your journal is ready.');
    } else if (result.status === 'fallback') {
      await sender.send(userId,
        `Morning prep wrote a fallback — Claude synth failed: ${result.synthError}. Review and edit.`
      );
    } else if (result.status === 'skipped') {
      await sender.send(userId, 'Morning prep already written today.');
    }
  } catch (err) {
    sender.stopTyping(userId);
    log.error('Prep command error', { error: (err as Error).message });
    await sender.send(userId, `Morning prep failed: ${(err as Error).message}`);
  }
}
