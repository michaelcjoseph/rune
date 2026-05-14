import type TelegramBot from 'node-telegram-bot-api';
import { sendLongMessage, startTyping, stopTyping } from '../integrations/telegram/client.js';
import type { MessageSender, SendOpts } from './sender.js';
import type { BusMutationEvent, BusOpEvent } from './notification-bus.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('telegram-sender');

interface TrackerEntry {
  userId: number;
  messageId: number;
  lastEditTs: number;
}

const TRACKER_EDIT_THROTTLE_MS = 10_000;

/** TelegramSender implements MessageSender by delegating to the existing telegram
 *  client helpers. Maintains per-user typing timers so callers just call
 *  startTyping/stopTyping with a userId rather than managing interval handles. */
export class TelegramSender implements MessageSender {
  readonly name = 'telegram' as const;

  private typingTimers = new Map<number, ReturnType<typeof setInterval>>();
  private trackers = new Map<string, TrackerEntry>();
  // Pending sendMessage promises keyed by opId. editTracker / deleteTracker
  // await these before reading `trackers`, so progress/end events for
  // fast ops can't race ahead of the initial send and become orphaned.
  private pendingSends = new Map<string, Promise<void>>();

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

  /** Render a tracker message per in-flight Claude op: send on start, edit
   *  elapsed every ~10s, delete on end. Skipped for sub-second classifier ops
   *  so the resolver doesn't spam the chat. */
  onOpEvent(event: BusOpEvent): void {
    if (event.opKind === 'classifier') return;
    if (event.subKind === 'start') {
      this.sendTracker(event);
    } else if (event.subKind === 'progress') {
      void this.editTracker(event);
    } else {
      void this.deleteTracker(event);
    }
  }

  private formatTracker(event: BusOpEvent): string {
    const elapsedSec = Math.floor(event.elapsedMs / 1000);
    return `🤔 ${event.label} · ${elapsedSec}s · /cancel`;
  }

  private sendTracker(event: BusOpEvent): void {
    const text = this.formatTracker(event);
    const send = this.bot.sendMessage(event.userId, text)
      .then((msg) => {
        this.trackers.set(event.opId, {
          userId: event.userId,
          messageId: msg.message_id,
          lastEditTs: Date.now(),
        });
      })
      .catch((err: unknown) => {
        log.warn('tracker send failed', { error: err instanceof Error ? err.message : String(err) });
      });
    this.pendingSends.set(event.opId, send);
    void send.finally(() => {
      if (this.pendingSends.get(event.opId) === send) this.pendingSends.delete(event.opId);
    });
  }

  private async editTracker(event: BusOpEvent): Promise<void> {
    await this.pendingSends.get(event.opId);
    const entry = this.trackers.get(event.opId);
    if (!entry) return;
    const now = Date.now();
    if (now - entry.lastEditTs < TRACKER_EDIT_THROTTLE_MS) return;
    const text = this.formatTracker(event);
    entry.lastEditTs = now;
    await this.bot.editMessageText(text, { chat_id: entry.userId, message_id: entry.messageId })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        // Telegram returns 400 with these messages when the user has already
        // deleted the tracker or the text matches what's currently rendered.
        if (msg.includes('message is not modified') || msg.includes('message to edit not found')) return;
        log.warn('tracker edit failed', { error: msg });
      });
  }

  private async deleteTracker(event: BusOpEvent): Promise<void> {
    await this.pendingSends.get(event.opId);
    const entry = this.trackers.get(event.opId);
    if (!entry) return;
    this.trackers.delete(event.opId);
    await this.bot.deleteMessage(entry.userId, entry.messageId)
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('message to delete not found')) return;
        log.warn('tracker delete failed', { error: msg });
      });
  }

  /** Drain typing timers and best-effort delete in-flight tracker messages.
   *  Without the delete pass, orphaned "🤔 …" messages would linger in the
   *  chat after a restart with no way to cancel the (already-dead) op. */
  shutdown(): void {
    for (const [userId, timer] of this.typingTimers) {
      stopTyping(timer);
      this.typingTimers.delete(userId);
    }
    for (const [, entry] of this.trackers) {
      void this.bot.deleteMessage(entry.userId, entry.messageId).catch(() => {
        // Best-effort — restart already in progress, swallow errors
      });
    }
    this.trackers.clear();
    this.pendingSends.clear();
  }
}
