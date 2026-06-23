import type { MessageSender } from '../transport/sender.js';
import { dispatchText } from '../bot/handlers/text.js';
import type { SessionScope } from '../vault/sessions.js';

/** Dispatch entrypoint for the webview transport. Mirrors the TG routing chain
 *  in `handleTextMessage` but takes a pre-authenticated (userId, text) pair
 *  instead of a raw TelegramBot.Message. Auth verification happens upstream at
 *  the HTTP layer. */
export async function handleWebviewMessage(
  sender: MessageSender,
  userId: number,
  text: string,
  scope?: SessionScope,
): Promise<void> {
  return scope
    ? dispatchText(sender, userId, text, scope)
    : dispatchText(sender, userId, text);
}
