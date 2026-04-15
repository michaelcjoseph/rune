import TelegramBot from 'node-telegram-bot-api';
import config from '../../config.js';
import { getSession, createSession, updateSession, setSessionModel } from '../../vault/sessions.js';
import { askClaude } from '../../ai/claude.js';
import { sendLongMessage, startTyping, stopTyping } from '../../integrations/telegram/client.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('text-handler');
import { handleFresh } from '../commands/fresh.js';
import { handleJournal } from '../commands/journal.js';
import { handleAsk } from '../commands/ask.js';
import { handleStatus } from '../commands/status.js';
import { handleKB } from '../commands/kb.js';
import { handleIngest } from '../commands/ingest.js';
import { handlePriorities } from '../commands/priorities.js';
import { handleWorkout } from '../commands/workout.js';
import { handleStudy } from '../commands/study.js';
import { handleFamily } from '../commands/family.js';
import { handleCareer } from '../commands/career.js';
import { handlePrep } from '../commands/prep.js';
import { handleDaily } from '../commands/daily.js';
import { handleWeekly } from '../commands/weekly.js';
import { handleMonthly } from '../commands/monthly.js';
import { handleQuarterly } from '../commands/quarterly.js';
import { handleYearly } from '../commands/yearly.js';
import { handleThink } from '../commands/think.js';
import { handleHealth } from '../commands/health.js';
import { handleBlog } from '../commands/blog.js';
import { handleLenny } from '../commands/lenny.js';
import { handlePG } from '../commands/pg.js';
import { hasActiveReview, handleReviewMessage } from '../../reviews/orchestrator.js';
import { containsURL, handleURLMessage } from './url.js';
import { isConfigured, getAuthorizationURL } from '../../integrations/whoop/client.js';
import { WHOOP_REDIRECT_URI } from '../../server/http.js';
import { getStoredTokens } from '../../integrations/whoop/keychain.js';

export async function handleTextMessage(bot: TelegramBot, msg: TelegramBot.Message): Promise<void> {
  // Security gate
  if (msg.from?.id !== config.TELEGRAM_USER_ID) return;

  const chatId = msg.chat.id;
  const text = (msg.text || '').trim();
  if (!text) return;

  if (text.startsWith('/fresh')) return handleFresh(bot, chatId);
  if (text.startsWith('/journal ')) return handleJournal(bot, chatId, text.slice('/journal '.length).trim());
  if (text.startsWith('/ask ')) return handleAsk(bot, chatId, text.slice('/ask '.length).trim());
  if (text.startsWith('/kb ')) return handleKB(bot, chatId, text.slice('/kb '.length).trim());
  if (text.startsWith('/ingest')) return handleIngest(bot, chatId, text.slice('/ingest'.length).trim());
  if (text.startsWith('/daily')) return handleDaily(bot, chatId, text.slice('/daily'.length).trim());
  if (text.startsWith('/weekly')) return handleWeekly(bot, chatId, text.slice('/weekly'.length).trim());
  if (text.startsWith('/monthly')) return handleMonthly(bot, chatId, text.slice('/monthly'.length).trim());
  if (text.startsWith('/quarterly')) return handleQuarterly(bot, chatId, text.slice('/quarterly'.length).trim());
  if (text.startsWith('/yearly')) return handleYearly(bot, chatId, text.slice('/yearly'.length).trim());
  if (text.startsWith('/priorities')) return handlePriorities(bot, chatId);
  if (text.startsWith('/workout')) return handleWorkout(bot, chatId);
  if (text.startsWith('/study')) return handleStudy(bot, chatId);
  if (text.startsWith('/family')) return handleFamily(bot, chatId);
  if (text.startsWith('/career')) return handleCareer(bot, chatId);
  if (text.startsWith('/think')) return handleThink(bot, chatId, text.slice('/think'.length).trim());
  if (text.startsWith('/health')) return handleHealth(bot, chatId, text.slice('/health'.length).trim());
  if (text.startsWith('/blog')) return handleBlog(bot, chatId, text.slice('/blog'.length).trim());
  if (text.startsWith('/lenny')) return handleLenny(bot, chatId, text.slice('/lenny'.length).trim());
  if (text.startsWith('/pg')) return handlePG(bot, chatId, text.slice('/pg'.length).trim());
  if (text.startsWith('/prep')) return handlePrep(bot, chatId);
  if (text.startsWith('/lint')) return handleLint(bot, chatId);
  if (text.startsWith('/opus')) return handleModelSwitch(bot, chatId, 'opus');
  if (text.startsWith('/sonnet')) return handleModelSwitch(bot, chatId, 'sonnet');
  if (text.startsWith('/haiku')) return handleModelSwitch(bot, chatId, 'haiku');
  if (text.startsWith('/status')) return handleStatus(bot, chatId);
  if (text.startsWith('/whoop')) return handleWhoop(bot, chatId);
  if (text.startsWith('/start')) return handleStart(bot, chatId);

  // URL detection — messages containing URLs go to content triage
  if (containsURL(text)) return handleURLMessage(bot, chatId, text);

  // Active review session takes priority over default conversation
  if (hasActiveReview(chatId)) return handleReviewMessage(chatId, text, bot);

  // Default: multi-turn conversation
  return handleConversation(bot, chatId, text);
}

async function handleConversation(bot: TelegramBot, chatId: number, text: string): Promise<void> {
  let session = getSession(chatId);
  if (!session) {
    session = createSession(chatId, text);
  }

  const typing = startTyping(bot, chatId);
  try {
    const result = await askClaude(text, session.sessionId, session.model);
    stopTyping(typing);

    if (result.error) {
      log.error('Conversation error', { error: result.error, sessionId: session.sessionId });
      await bot.sendMessage(chatId, `Error: ${result.error}`);
      return;
    }

    updateSession(chatId);
    await sendLongMessage(bot, chatId, result.text!);
  } catch (err) {
    stopTyping(typing);
    log.error('Conversation exception', { error: (err as Error).message });
    await bot.sendMessage(chatId, `Error: ${(err as Error).message}`);
  }
}

async function handleLint(bot: TelegramBot, chatId: number): Promise<void> {
  const { lintKB } = await import('../../kb/engine.js');
  const typing = startTyping(bot, chatId);
  try {
    const result = await lintKB();
    stopTyping(typing);
    await sendLongMessage(bot, chatId, result.report);
  } catch (err) {
    stopTyping(typing);
    log.error('Lint error', { error: (err as Error).message });
    await bot.sendMessage(chatId, `Lint error: ${(err as Error).message}`);
  }
}

async function handleWhoop(bot: TelegramBot, chatId: number): Promise<void> {
  if (!isConfigured()) {
    await bot.sendMessage(chatId, 'Whoop not configured. Set WHOOP_CLIENT_ID and WHOOP_CLIENT_SECRET in .env.local.');
    return;
  }

  const { accessToken, expiresAt } = getStoredTokens();
  if (accessToken && expiresAt > Date.now()) {
    const expiresIn = Math.round((expiresAt - Date.now()) / 3_600_000);
    await bot.sendMessage(chatId, `Whoop is connected. Token expires in ~${expiresIn}h.`);
    return;
  }

  const url = getAuthorizationURL(WHOOP_REDIRECT_URI);
  await bot.sendMessage(chatId, `Whoop needs authorization. Open this link:\n\n${url}`);
}

async function handleModelSwitch(bot: TelegramBot, chatId: number, model: string): Promise<void> {
  const session = getSession(chatId);
  if (!session) {
    const newSession = createSession(chatId, `/${model}`);
    setSessionModel(chatId, model);
    await bot.sendMessage(chatId, `Switched to ${model}. New session started.`);
    return;
  }
  setSessionModel(chatId, model);
  await bot.sendMessage(chatId, `Switched to ${model}.`);
}

async function handleStart(bot: TelegramBot, chatId: number): Promise<void> {
  const lines = [
    'Jarvis — Second Brain',
    '',
    'Send any message to chat with your vault.',
    '',
    'Commands:',
    '/priorities — yesterday\'s priorities',
    '/workout — today\'s workout prescription',
    '/study — current study progress and assignments',
    '/family — 14-day family mention scan',
    '/career — active job applications',
    '/fresh — log conversation to journal, reset session',
    '/journal <text> — append entry to today\'s journal',
    '/ask <question> — one-shot vault query',
    '/kb <question> — query the knowledge base',
    '/ingest [path] — ingest source into knowledge base',
    '/lint — run wiki health check',
    '/prep — run morning prep now',
    '/status — show uptime and session info',
    '',
    'Sessions:',
    '/think <topic> — thinking partner mode',
    '/health [focus] — health coaching session',
    '/blog <topic> — blog writing session',
    '',
    'Library:',
    '/lenny <topic> — search Lenny\'s Podcast transcripts',
    '/pg <topic> — search Paul Graham essays',
    '',
    'Reviews:',
    '/daily [date] — process journal tags into JSON updates',
    '/weekly [date] — end-of-week review interview',
    '/monthly [month] — monthly review interview',
    '/quarterly [Q1-Q4] — quarterly review interview',
    '/yearly [year] — yearly review (7 Questions)',
    '',
    'Health:',
    '/whoop — Whoop connection status or auth link',
    '',
    'Model:',
    '/haiku — fast responses (default)',
    '/sonnet — balanced',
    '/opus — max capability',
  ];

  await bot.sendMessage(chatId, lines.join('\n'));
}
