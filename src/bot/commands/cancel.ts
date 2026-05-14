import type { MessageSender } from '../../transport/sender.js';
import { cancelMostRecentForUser, cancelByPrefix, CANCEL_PREFIX_MIN_CHARS } from '../../transport/in-flight.js';

/** /cancel              — kill the user's most-recently-started Claude op
 *  /cancel <opId-prefix> — kill by id prefix (≥4 chars). */
export async function handleCancel(sender: MessageSender, userId: number, arg: string): Promise<void> {
  const prefix = arg.trim();
  if (prefix && prefix.length < CANCEL_PREFIX_MIN_CHARS) {
    await sender.send(userId, `Op ID prefix must be at least ${CANCEL_PREFIX_MIN_CHARS} characters.`);
    return;
  }
  const cancelled = prefix
    ? cancelByPrefix(prefix)
    : cancelMostRecentForUser(userId);

  if (!cancelled) {
    await sender.send(userId, prefix
      ? `No active operation matching \`${prefix}\`.`
      : 'No active operations.');
    return;
  }
  await sender.send(userId, `Cancelled ${cancelled.label} (${cancelled.opId.slice(0, 8)}).`);
}
