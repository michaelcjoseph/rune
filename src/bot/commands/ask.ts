import type { MessageSender } from '../../transport/sender.js';
import { askClaudeOneShot } from '../../ai/claude.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('cmd-ask');

export async function handleAsk(sender: MessageSender, userId: number, question: string): Promise<void> {
  sender.startTyping(userId, 'Asking Claude');
  try {
    const result = await askClaudeOneShot(question, undefined, 'ask', true);
    sender.stopTyping(userId);

    if (result.error) {
      log.error('Ask error', { error: result.error });
      await sender.send(userId, `Error: ${result.error}`);
      return;
    }

    await sender.send(userId, result.text!);
  } catch (err) {
    sender.stopTyping(userId);
    log.error('Ask exception', { error: (err as Error).message });
    await sender.send(userId, `Error: ${(err as Error).message}`);
  }
}
