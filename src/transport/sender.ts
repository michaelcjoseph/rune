import type TelegramBot from 'node-telegram-bot-api';
import { createLogger } from '../utils/logger.js';
import type { NotificationBus, BusMessageEvent, BusAgentEvent, BusMutationEvent } from './notification-bus.js';
import { TelegramSender } from './telegram-sender.js';
import { WebviewSender } from './webview-sender.js';

const log = createLogger('sender');

export interface SendOpts {
  approval?: { prompt: string; options: { value: string; label: string }[] };
}

export interface MessageSender {
  name: 'telegram' | 'webview';
  send(userId: number, text: string, opts?: SendOpts): Promise<void>;
  startTyping(userId: number): void;
  stopTyping(userId: number): void;
}

/** Instantiate both senders and subscribe them to the notification bus.
 *  Returns concrete types so Phase B callers can call register/unregister on WebviewSender.
 *  Call destroy() on shutdown to remove the bus subscription and drain typing timers. */
export function createSenders(
  bot: TelegramBot,
  bus: NotificationBus,
): { tg: TelegramSender; webview: WebviewSender; destroy: () => void } {
  const tg = new TelegramSender(bot);
  const webview = new WebviewSender();

  // never log event.userId or event.text — contains PII
  const handler = (event: BusMessageEvent) => {
    void tg.send(event.userId, event.text).catch((err: unknown) => {
      log.error('TelegramSender.send failed on bus message', { error: err instanceof Error ? err.message : String(err) });
    });
    void webview.send(event.userId, event.text).catch((err: unknown) => {
      log.error('WebviewSender.send failed on bus message', { error: err instanceof Error ? err.message : String(err) });
    });
  };

  bus.on('message', handler);

  const agentEventHandler = (event: BusAgentEvent) => {
    webview.onAgentEvent(event);
  };
  bus.on('agent-event', agentEventHandler);

  const mutationEventHandler = (event: BusMutationEvent) => {
    webview.onMutationEvent(event);
    tg.onMutationEvent(event);
  };
  bus.on('mutation-event', mutationEventHandler);

  const destroy = () => {
    bus.off('message', handler);
    bus.off('agent-event', agentEventHandler);
    bus.off('mutation-event', mutationEventHandler);
    tg.shutdown();
    webview.shutdown();
  };

  return { tg, webview, destroy };
}
