import type TelegramBot from 'node-telegram-bot-api';
import { sendLongMessage, startTyping, stopTyping } from '../integrations/telegram/client.js';
import type { MessageSender, SendOpts } from './sender.js';
import type { BusMutationEvent } from './notification-bus.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('telegram-sender');

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

  startTyping(userId: number, _label?: string): void {
    if (this.typingTimers.has(userId)) return;
    this.typingTimers.set(userId, startTyping(this.bot, userId));
  }

  stopTyping(userId: number): void {
    const timer = this.typingTimers.get(userId);
    if (timer === undefined) return;
    stopTyping(timer);
    this.typingTimers.delete(userId);
  }

  /** Send a short summary to Telegram on mutation completed/failed. Ignores output/log/progress. */
  onMutationEvent(event: BusMutationEvent): void {
    if (event.subKind !== 'completed' && event.subKind !== 'failed') return;
    const data = event.data as Record<string, unknown> | undefined;
    const slug = String(data?.['slug'] ?? data?.['projectSlug'] ?? event.mutationId.slice(0, 8));
    const durationMs = typeof data?.['durationMs'] === 'number' ? data['durationMs'] as number : null;
    const durStr = durationMs !== null ? ` in ${(durationMs / 1000).toFixed(1)}s` : '';
    const text = event.subKind === 'completed'
      ? `✅ /work --auto on ${slug} finished${durStr}`
      : `❌ /work --auto on ${slug} failed: ${String(data?.['reason'] ?? 'unknown')}`;
    void this.send(event.userId, text).catch((err: unknown) => {
      log.error('TelegramSender.onMutationEvent send failed', { error: err instanceof Error ? err.message : String(err) });
    });
  }

  /** Drain all active typing timers. Call from shutdown to prevent interval leaks. */
  shutdown(): void {
    for (const [userId, timer] of this.typingTimers) {
      stopTyping(timer);
      this.typingTimers.delete(userId);
    }
  }
}
