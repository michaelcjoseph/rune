import { appendLearning } from '../../vault/learnings.js';
import type { MessageSender } from '../../transport/sender.js';

export async function handleLearn(sender: MessageSender, userId: number, text: string): Promise<void> {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    await sender.send(userId,
      'Usage: /learn <what you want me to remember>\nExample: /learn Prefer terse answers — no trailing recap after a diff.',
    );
    return;
  }
  appendLearning(trimmed);
  await sender.send(userId, 'Logged. I will prepend this to future agent runs.');
}
