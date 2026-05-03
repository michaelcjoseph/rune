import type TelegramBot from 'node-telegram-bot-api';
import { sendLongMessage, startTyping, stopTyping } from '../integrations/telegram/client.js';
import type { MessageSender, SendOpts } from './sender.js';

/** TelegramSender implements MessageSender by delegating to the existing telegram
 *  client helpers. Maintains per-user typing timers so callers just call
 *  startTyping/stopTyping with a userId rather than managing interval handles. */
export class TelegramSender implements MessageSender {
  readonly name = 'telegram' as const;

  private typingTimers = new Map<number, ReturnType<typeof setInterval>>();

  constructor(private bot: TelegramBot) {}

  async send(userId: number, text: string, _opts?: SendOpts): Promise<void> {
    await sendLongMessage(this.bot, userId, text);
  }

  startTyping(userId: number): void {
    if (this.typingTimers.has(userId)) return;
    this.typingTimers.set(userId, startTyping(this.bot, userId));
  }

  stopTyping(userId: number): void {
    const timer = this.typingTimers.get(userId);
    if (timer === undefined) return;
    stopTyping(timer);
    this.typingTimers.delete(userId);
  }

  /** Drain all active typing timers. Call from shutdown to prevent interval leaks. */
  shutdown(): void {
    for (const [userId, timer] of this.typingTimers) {
      stopTyping(timer);
      this.typingTimers.delete(userId);
    }
  }
}
