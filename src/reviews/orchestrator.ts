import TelegramBot from 'node-telegram-bot-api';
import { createReviewSession, getActiveReviewSession, deleteReviewSession } from './session.js';
import type { ReviewSession, ReviewType } from './session.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('orchestrator');

export interface ReviewTypeHandler {
  /** Run the prep phase and initial setup (automated, no user input needed) */
  start(session: ReviewSession, bot: TelegramBot): Promise<void>;
  /** Handle a user message during an active review session */
  handleMessage(session: ReviewSession, text: string, bot: TelegramBot): Promise<void>;
}

const handlers = new Map<ReviewType, ReviewTypeHandler>();

export function registerReviewHandler(type: ReviewType, handler: ReviewTypeHandler): void {
  handlers.set(type, handler);
}

/** Start a new review — creates session, calls handler.start() */
export async function startReview(chatId: number, type: ReviewType, targetDate: string, bot: TelegramBot): Promise<void> {
  const handler = handlers.get(type);
  if (!handler) {
    log.error('No handler registered for review type', { type });
    await bot.sendMessage(chatId, `Review type "${type}" is not yet implemented.`);
    return;
  }

  const existing = getActiveReviewSession(chatId);
  if (existing) {
    await bot.sendMessage(chatId, `Cancelling your in-progress ${existing.type} review to start a new one.`);
  }

  const session = createReviewSession(chatId, type, targetDate);
  log.info('Starting review', { chatId, type, targetDate, sessionId: session.id });

  try {
    await handler.start(session, bot);
  } catch (err) {
    log.error('Review start failed', { type, chatId, error: (err as Error).message });
    deleteReviewSession(chatId);
    await bot.sendMessage(chatId, `Error starting ${type} review: ${(err as Error).message}`);
  }
}

/** Dispatch a user message to the active review's handler */
export async function handleReviewMessage(chatId: number, text: string, bot: TelegramBot): Promise<void> {
  const session = getActiveReviewSession(chatId);
  if (!session) {
    log.warn('handleReviewMessage called with no active session', { chatId });
    return;
  }

  const handler = handlers.get(session.type);
  if (!handler) {
    log.error('No handler for active review session type', { type: session.type, chatId });
    await bot.sendMessage(chatId, `Review type "${session.type}" handler is missing.`);
    deleteReviewSession(chatId);
    return;
  }

  try {
    await handler.handleMessage(session, text, bot);
  } catch (err) {
    log.error('Review message handling failed', { type: session.type, phase: session.phase, chatId, error: (err as Error).message });
    await bot.sendMessage(chatId, `Error during ${session.type} review: ${(err as Error).message}`);
  }
}

/** Check if a chatId has an active review (for text.ts routing) */
export function hasActiveReview(chatId: number): boolean {
  return getActiveReviewSession(chatId) !== null;
}
