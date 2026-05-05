import type { MessageSender } from '../transport/sender.js';
import { dispatchText } from '../bot/handlers/text.js';

/** Dispatch entrypoint for the webview transport. Mirrors the TG routing chain
 *  in `handleTextMessage` but takes a pre-authenticated (userId, text) pair
 *  instead of a raw TelegramBot.Message. Auth verification happens upstream at
 *  the HTTP layer. */
export async function handleWebviewMessage(
  sender: MessageSender,
  userId: number,
  text: string,
): Promise<void> {
  return dispatchText(sender, userId, text);
}
