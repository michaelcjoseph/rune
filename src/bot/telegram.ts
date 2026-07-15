import TelegramBot from 'node-telegram-bot-api';
import type { MessageSender } from '../transport/sender.js';
import config from '../config.js';
import { createLogger } from '../utils/logger.js';
import { handleTextMessage, dispatchText } from './handlers/text.js';
import { handlePhotoMessage } from './handlers/photo.js';
import { dispatchApprovalStatus, parseApprovalId } from '../transport/approval-actions.js';
import { parseWorkRunReleaseCallback, dispatchTelegramWorkRunRelease } from './work-run-release-callback.js';

const log = createLogger('telegram');

export function createBot(opts: { polling?: boolean } = {}): TelegramBot {
  return new TelegramBot(config.TELEGRAM_BOT_TOKEN, { polling: opts.polling ?? true });
}

/** Wire message handlers to an already-created bot. Called after senders are ready. */
export function wireHandlers(bot: TelegramBot, sender: MessageSender): void {
  bot.on('message', (msg) => {
    if (msg.text) {
      handleTextMessage(sender, msg).catch((err) => {
        log.error('Unhandled error in text handler', { error: (err as Error).message });
      });
    } else if (msg.photo) {
      handlePhotoMessage(bot, sender, msg).catch((err) => {
        log.error('Unhandled error in photo handler', { error: (err as Error).message });
      });
    }
  });

  bot.on('polling_error', (err: any) => {
    const cause = err.cause;
    log.error('Polling error', {
      code: err.code,
      causeCode: cause?.code,
      causeMessage: cause?.message,
      statusCode: err.response?.statusCode,
    });
  });

  // Phase 6 C6.2: route inline-button presses through the shared approval
  // actioning path (`dispatchApprovalStatus`) so a proposal acted on in
  // Telegram lands in the same queue mutation as one acted on via the
  // cockpit inbox. Two payload shapes:
  //   - composite approval id (e.g. `intent-proposal:0`, `playbook:2`,
  //     `ask-twice:1`) — parseable via `parseApprovalId`; routes through
  //     `dispatchApprovalStatus` with a status derived from the leading
  //     `approve-`/`reject-`/`approved`/`rejected` token, or a bare id
  //     defaulting to `approved`.
  //   - conversational value (e.g. `yes`, `cancel`, `approve`, `refine`,
  //     `abandon`) — fed back as a synthetic text message via
  //     `dispatchText` so the active review/planning session sees it as
  //     the user's reply.
  // Every branch acks the callback first so the Telegram client's spinner
  // stops, then runs the routed action.
  bot.on('callback_query', (query: TelegramBot.CallbackQuery) => {
    const data = query.data ?? '';
    const userId = query.from.id;
    // Auth — only the configured user can act on inline buttons.
    if (userId !== config.TELEGRAM_USER_ID) {
      void bot.answerCallbackQuery(query.id, { text: 'Unauthorized' }).catch((err: unknown) => {
        log.warn('answerCallbackQuery failed (unauthorized branch)', { error: (err as Error).message });
      });
      return;
    }
    void bot.answerCallbackQuery(query.id).catch((err: unknown) => {
      log.warn('answerCallbackQuery failed', { error: (err as Error).message });
    });

    // Work-run release route (project 13, Phase 1c) — `work-run-release:<id>` /
    // `work-run-release-confirm:<id>`. Delegates to the ONE shared release
    // runtime so this surface can't drift from the cockpit route / inbox row.
    if (parseWorkRunReleaseCallback(data)) {
      void dispatchTelegramWorkRunRelease((uid, text) => sender.send(uid, text), userId, data).catch(
        (err: unknown) => {
          log.error('work-run-release callback failed', { error: (err as Error).message });
          void sender.send(userId, 'Failed to action release — internal error.').catch(() => { /* swallow */ });
        },
      );
      return;
    }

    // Composite-id route (cockpit-inbox-shared path).
    const { status, idCandidate } = parseCallbackData(data);
    const parsed = parseApprovalId(idCandidate);
    if (parsed) {
      // dispatchApprovalStatus is synchronous and writes JSON files via
      // writeFileSync — wrap in try/catch so a disk-write failure can't
      // bubble out of this EventEmitter listener and crash the process.
      // dispatchApprovalStatus is async in C8 — it awaits the consumer
      // side-effect before flipping queue status. Wrap in an IIFE so the
      // outer EventEmitter listener stays sync; the promise rejection is
      // caught and converted to a user-facing message.
      void (async () => {
        let result: Awaited<ReturnType<typeof dispatchApprovalStatus>>;
        try {
          result = await dispatchApprovalStatus(idCandidate, status);
        } catch (err: unknown) {
          log.error('dispatchApprovalStatus threw', { error: (err as Error).message });
          void sender.send(userId, `Failed to action ${idCandidate} — internal error.`).catch(() => { /* swallow */ });
          return;
        }
        const reply = result === 'ok'
          ? `${status === 'approved' ? '✅' : '✖️'} ${idCandidate} ${status}`
          : result === 'error'
            ? `Failed to action ${idCandidate} — write error (check server logs).`
            : `Could not action ${idCandidate} — already actioned or unknown.`;
        void sender.send(userId, reply).catch((err: unknown) => {
          log.warn('callback_query reply send failed', { error: (err as Error).message });
        });
      })();
      return;
    }

    // Conversational fallback — treat the value as user text input so an
    // active review/planning session can consume it as the user's reply.
    // Slash-prefixed values are rejected: callback_data should never be a
    // slash command (today's callers use values like 'yes' / 'cancel' /
    // 'approve' / 'refine' / 'abandon'). The guard prevents a future
    // upstream caller from accidentally turning an inline button into a
    // destructive command dispatch like `/clear` or `/fresh`.
    if (data.startsWith('/')) {
      log.warn('callback_query: ignoring slash-prefixed conversational fallback', { len: data.length });
      return;
    }
    void dispatchText(sender, userId, data).catch((err: unknown) => {
      log.error('callback_query dispatchText failed', { error: (err as Error).message });
    });
  });

  log.info('Telegram bot started (polling mode)');
}

/** Parse a callback_data payload into (status, idCandidate). Supports:
 *   - `approve:<id>` / `reject:<id>` — explicit status prefix
 *   - `approved:<id>` / `rejected:<id>` — already-tense alias
 *   - bare composite id (`intent-proposal:0`) — defaults to `approved`
 *
 *  Composite ids contain a `:` themselves, so detection is order-sensitive:
 *  the leading `approve`/`reject` prefix is consumed first, leaving the
 *  remainder for `parseApprovalId` to validate. */
function parseCallbackData(data: string): { status: 'approved' | 'rejected'; idCandidate: string } {
  if (data.startsWith('approve:')) return { status: 'approved', idCandidate: data.slice('approve:'.length) };
  if (data.startsWith('approved:')) return { status: 'approved', idCandidate: data.slice('approved:'.length) };
  if (data.startsWith('reject:')) return { status: 'rejected', idCandidate: data.slice('reject:'.length) };
  if (data.startsWith('rejected:')) return { status: 'rejected', idCandidate: data.slice('rejected:'.length) };
  return { status: 'approved', idCandidate: data };
}
