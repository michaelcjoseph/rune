import TelegramBot from 'node-telegram-bot-api';
import config from '../../config.js';
import { getSession, createSession, updateSession, setSessionModel } from '../../vault/sessions.js';
import { askClaudeWithContext, runAgent } from '../../ai/claude.js';
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
import { handleDoneWorkout } from '../commands/done-workout.js';
import { handleStudy } from '../commands/study.js';
import { handleFamily } from '../commands/family.js';
import { handleCareer } from '../commands/career.js';
import { handlePrep } from '../commands/prep.js';
import { handleDaily } from '../commands/daily.js';
import { handleWeekly } from '../commands/weekly.js';
import { handleMonthly } from '../commands/monthly.js';
import { handleQuarterly } from '../commands/quarterly.js';
import { handleYearly } from '../commands/yearly.js';
import { handleHealth } from '../commands/health.js';
import { handleBlog } from '../commands/blog.js';
import { handleLenny } from '../commands/lenny.js';
import { handlePG } from '../commands/pg.js';
import { handleSeed } from '../commands/seed.js';
import { handleLearn } from '../commands/learn.js';
import { handleLearnList } from '../commands/learn-list.js';
import { hasActiveReview, handleReviewMessage } from '../../reviews/orchestrator.js';
import { containsURL, handleURLMessage } from './url.js';
import { isConfigured, getAuthorizationURL, getAccessToken, describeTokenError } from '../../integrations/whoop/client.js';
import { WHOOP_REDIRECT_URI } from '../../server/http.js';
import { getStoredTokens } from '../../integrations/whoop/keychain.js';
import { classifyIntent, type ClassifyResult } from '../resolver.js';
import { getSkillRegistry, type SkillEntry } from '../skill-registry.js';
import { appendIntent, type IntentOutcome } from '../../utils/intent-log.js';

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
  if (text.startsWith('/priorities')) return handlePriorities(bot, chatId, text.slice('/priorities'.length).trim());
  // /done-workout must come before /workout so the longer prefix wins.
  if (text.startsWith('/done-workout')) return handleDoneWorkout(bot, chatId);
  if (text.startsWith('/workout')) return handleWorkout(bot, chatId, text.slice('/workout'.length).trim());
  if (text.startsWith('/study')) return handleStudy(bot, chatId);
  if (text.startsWith('/family')) return handleFamily(bot, chatId);
  if (text.startsWith('/career')) return handleCareer(bot, chatId);
  if (text.startsWith('/health')) return handleHealth(bot, chatId, text.slice('/health'.length).trim());
  if (text.startsWith('/blog')) return handleBlog(bot, chatId, text.slice('/blog'.length).trim());
  if (text.startsWith('/lenny')) return handleLenny(bot, chatId, text.slice('/lenny'.length).trim());
  if (text.startsWith('/pg')) return handlePG(bot, chatId, text.slice('/pg'.length).trim());
  // /learn-list must come before /learn so the longer prefix wins.
  if (text.startsWith('/learn-list')) return handleLearnList(bot, chatId);
  if (text === '/learn' || text.startsWith('/learn ')) return handleLearn(bot, chatId, text.slice('/learn'.length).trim());
  if (text.startsWith('/prep')) return handlePrep(bot, chatId);
  if (text.startsWith('/seed')) return handleSeed(bot, chatId, text.slice('/seed'.length).trim());
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

  // Resolver: classify free-form messages against the skill registry. Skipped
  // for short messages (rarely encode a routable intent) to save the Haiku
  // call. Slash commands already short-circuited above; active-session above.
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  if (wordCount >= config.RESOLVER_MIN_WORDS) {
    const routed = await tryResolveAndDispatch(bot, chatId, text);
    if (routed) return;
    // Fall through — the resolver already logged the intent-log entry.
  }

  // Default: multi-turn conversation
  return handleConversation(bot, chatId, text);
}

/** Run the resolver and, if confidence ≥ threshold and the top-2 aren't
 *  ambiguous, invoke the routed skill. Always appends one entry to the
 *  intent log when the classifier runs. Returns true if a skill was invoked
 *  (caller should stop); false if the caller should fall through to the
 *  freeform handler. Any thrown error — including from getSkillRegistry or
 *  classifyIntent itself — is caught and treated as "not routed" so the
 *  Telegram polling handler never sees an uncaught rejection. */
async function tryResolveAndDispatch(bot: TelegramBot, chatId: number, text: string): Promise<boolean> {
  try {
    const registry = getSkillRegistry();
    const result = await classifyIntent(text, registry);

    // Low confidence — fall through without invoking a skill.
    if (result.skill === null || result.confidence < config.RESOLVER_CONFIDENCE_THRESHOLD) {
      logIntent(text, result, 'low_confidence', null);
      return false;
    }

    // Top-2 within delta — ambiguous, note and fall through. Skill names are
    // shown as `/name` to the user; the registry now contains only slash + agent
    // kinds, both of which are user-recognizable as commands.
    if (result.ambiguous) {
      await bot.sendMessage(
        chatId,
        `Couldn't tell if you meant /${result.skill} or /${result.second_skill}. Falling back to chat.`,
      );
      logIntent(text, result, 'ambiguous', null);
      return false;
    }

    const entry = registry.find(s => s.name === result.skill);
    if (!entry) {
      log.warn('Resolver chose a skill not in registry', { skill: result.skill });
      logIntent(text, result, 'failed', result.skill);
      return false;
    }

    try {
      await invokeSkill(bot, chatId, text, entry, result.args);
      logIntent(text, result, 'routed', entry.name);
      return true;
    } catch (err) {
      log.error('Routed skill threw', { skill: entry.name, error: (err as Error).message });
      logIntent(text, result, 'failed', entry.name);
      return false;
    }
  } catch (err) {
    log.error('Resolver path threw before routing could be attempted', {
      error: (err as Error).message,
    });
    return false;
  }
}

function logIntent(
  text: string,
  result: ClassifyResult,
  outcome: IntentOutcome,
  skill_invoked: string | null,
): void {
  appendIntent({
    ts: new Date().toISOString(),
    intent: text,
    args: result.args,
    confidence: result.confidence,
    outcome,
    skill_invoked,
  });
}

/** Dispatch a routed skill to its underlying handler. Kept as a switch rather
 *  than a map because slash-command handler signatures vary (some take args,
 *  some don't) — one place to edit when commands change. */
async function invokeSkill(
  bot: TelegramBot,
  chatId: number,
  message: string,
  skill: SkillEntry,
  args: string,
): Promise<void> {
  if (skill.kind === 'agent') {
    const result = await runAgent(skill.name, args || message);
    if (result.error || !result.text) {
      throw new Error(result.error ?? 'Agent returned empty output');
    }
    await sendLongMessage(bot, chatId, result.text);
    return;
  }
  // Slash-kind dispatch. Mirrors the prefix chain at the top of
  // handleTextMessage. Only commands that make sense as resolver routes are
  // listed — model-switch (/opus, /sonnet, /haiku), auth (/whoop, /start),
  // and admin (/status, /lint, /seed) commands are intentionally omitted.
  switch (skill.name) {
    case 'journal': return handleJournal(bot, chatId, args);
    case 'ingest': return handleIngest(bot, chatId, args);
    case 'priorities': return handlePriorities(bot, chatId, args);
    case 'workout': return handleWorkout(bot, chatId, args);
    case 'done-workout': return handleDoneWorkout(bot, chatId);
    case 'study': return handleStudy(bot, chatId);
    case 'family': return handleFamily(bot, chatId);
    case 'career': return handleCareer(bot, chatId);
    case 'prep': return handlePrep(bot, chatId);
    case 'daily': return handleDaily(bot, chatId, args);
    case 'weekly': return handleWeekly(bot, chatId, args);
    case 'monthly': return handleMonthly(bot, chatId, args);
    case 'quarterly': return handleQuarterly(bot, chatId, args);
    case 'yearly': return handleYearly(bot, chatId, args);
    case 'health': return handleHealth(bot, chatId, args);
    case 'blog': return handleBlog(bot, chatId, args);
    case 'lenny': return handleLenny(bot, chatId, args || message);
    case 'pg': return handlePG(bot, chatId, args || message);
    case 'learn': return handleLearn(bot, chatId, args || message);
    case 'learn-list': return handleLearnList(bot, chatId);
    case 'fresh': return handleFresh(bot, chatId);
    default:
      throw new Error(`No dispatcher for slash skill: ${skill.name}`);
  }
}

const VAULT_SYSTEM_PROMPT = `You are Jarvis, the user's second-brain conversational layer. Your working directory is their Obsidian vault — you have full read access.

DEFAULT POSTURE — thinking partner. Lean Socratic. For strategic, reflective, or open-ended questions, your first move is to ask before you answer. Don't solve the problem for them; help them clarify their own thinking. Open with one or two sharp probing questions grounded in something specific you found in their vault. After they respond, offer your view.

For tactical or factual asks ("find Rory in my CRM", "what's my workout today", "who is X") — answer directly. Skip the thinking ritual. Be brief.

VAULT MAP (read the relevant file(s), don't dump everything):
- CLAUDE.md — identity, "About Me", vault folder structure, tag taxonomy, review cadence, command list. READ THIS FIRST when you don't already know the answer — it's the manifest.
- world-view/world-view.md — the user's explicit belief synthesis across 8 domains (ai, crypto, energy, raw-materials, geopolitics, demographics, governance, education-healthcare). Each domain has a dedicated file in world-view/ with thesis + investment implications + changelog.
- knowledge/index.md — 100+ curated wiki entities/concepts/topics compiled from their reading. Large file — grep or scan rather than full-read unless needed.
- knowledge/schema.md — how the KB is organized (raw sources → compiled wiki pages).
- pages/index.md, investments/index.md, health/index.md, career/index.md, study/index.md, writing/index.md — per-domain indices.
- pages/{books,crm,places}.json, health/workouts.json, career/applications.json, investments/investments.json — structured JSON stores. For lookups against these, Read/Grep them directly; no synthesis needed.
- journals/YYYY_MM_DD.md — daily notes (interstitial journaling).

MCP TOOLS (jarvis-kb): kb_query (synthesized KB answer), kb_search (wiki search with type/tag filters), kb_stats (counts + recent log). Use for structured lookups when grep is awkward.

WEB SEARCH (WebSearch, WebFetch): External-knowledge tools. Use them ACTIVELY when the question reaches outside the user's vault — current events, news, definitions, third-party docs/APIs, library behavior, market data, anything time-sensitive or factual that isn't already in their notes. Don't treat web as a last resort: if the question is genuinely about the world (not the user), web search is often the right first move alongside KB lookups. Cite sources inline (URL or article title) the way you cite [[wikilinks]] for vault content.

HOW TO ANSWER:
- Pick the mode by question shape, not by length. Strategy/reflection/exploration → ask first. Lookup/tactical/factual → answer directly.
- Route by subject: questions about the user (worldview, investments, projects, frameworks) → vault/KB first. Questions about the world (current state, external facts, third-party tools/topics) → web first, vault second if relevant. Mixed questions → both, in parallel where possible.
- For substantive questions about worldview, investments, projects, or thinking frameworks: READ the relevant index/page first, then either probe (strategy) or answer with specifics (lookup). Cite with [[wikilinks]] where appropriate.
- Probing questions should be specific, not generic. "What's the current state? what flows in?" is exactly what to avoid — it re-elicits context already in the vault. Anchor every question to something concrete you found.
- Surface assumptions the user might be making. Name them explicitly.
- Responses go to Telegram on mobile — be concise. Structure matters more than length.
- Never write files. If the question implies a write, say so and point to the right slash command.
- The user can end the thread with /fresh, or by asking you to log the conversation to the journal.`;

const CONVERSATION_TOOLS = [
  'Read',
  'Glob',
  'Grep',
  'WebSearch',
  'WebFetch',
  'mcp__jarvis-kb__kb_query',
  'mcp__jarvis-kb__kb_search',
  'mcp__jarvis-kb__kb_stats',
];

async function handleConversation(bot: TelegramBot, chatId: number, text: string): Promise<void> {
  let session = getSession(chatId);
  if (!session) {
    session = createSession(chatId, text, config.CONVERSATION_MODEL);
  }

  const typing = startTyping(bot, chatId);
  try {
    const result = await askClaudeWithContext(
      text,
      session.sessionId,
      VAULT_SYSTEM_PROMPT,
      session.model,
      CONVERSATION_TOOLS,
    );
    stopTyping(typing);

    if (result.error) {
      log.error('Conversation error', { error: result.error, sessionId: session.sessionId });
      await bot.sendMessage(chatId, `Error: ${result.error}`);
      return;
    }

    updateSession(chatId);
    // Mode visibility: every conversation reply is suffixed so the user can
    // tell at a glance they are in a multi-turn thread (vs. a routed task
    // action, which has no such marker).
    const reply = `${result.text!}\n\n_— chatting · /fresh to end_`;
    await sendLongMessage(bot, chatId, reply);
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

  const stored = getStoredTokens();
  const hasRefresh = !!stored.refreshToken;
  const now = Date.now();

  // Cached access token still valid → no network call needed
  if (stored.accessToken && stored.expiresAt > now) {
    const hours = Math.floor((stored.expiresAt - now) / 3_600_000);
    const minutes = Math.floor(((stored.expiresAt - now) % 3_600_000) / 60_000);
    const expiresIn = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
    const expiryStr = new Date(stored.expiresAt).toLocaleString('en-US', { timeZone: config.TIMEZONE });
    await bot.sendMessage(
      chatId,
      `Whoop connected.\nAccess token expires in ${expiresIn} (${expiryStr} ${config.TIMEZONE}).\nRefresh token present: ${hasRefresh ? 'yes' : 'no'}`,
    );
    return;
  }

  // Expired or missing — attempt a live refresh to diagnose
  const result = await getAccessToken();
  if (result.ok) {
    const { expiresAt } = getStoredTokens();
    const hours = Math.floor((expiresAt - Date.now()) / 3_600_000);
    const minutes = Math.floor(((expiresAt - Date.now()) % 3_600_000) / 60_000);
    const expiryStr = new Date(expiresAt).toLocaleString('en-US', { timeZone: config.TIMEZONE });
    await bot.sendMessage(
      chatId,
      `Whoop connected (refreshed).\nAccess token expires in ${hours}h ${minutes}m (${expiryStr} ${config.TIMEZONE}).`,
    );
    return;
  }

  const detail = describeTokenError(result);
  if (result.reason === 'no_refresh_token' || result.reason === 'refresh_rejected') {
    const url = getAuthorizationURL(WHOOP_REDIRECT_URI);
    await bot.sendMessage(chatId, `${detail}\n\nOpen this link to re-authorize:\n\n${url}`);
  } else {
    await bot.sendMessage(chatId, detail);
  }
}

async function handleModelSwitch(bot: TelegramBot, chatId: number, model: string): Promise<void> {
  const session = getSession(chatId);
  if (!session) {
    createSession(chatId, `/${model}`);
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
    'Send any message to start a multi-turn chat with your vault. Jarvis leans Socratic — expect questions before answers on strategy/reflection. /fresh ends the thread; logging to journal also ends it.',
    '',
    'Commands:',
    '/priorities — yesterday\'s priorities',
    '/workout [home|gym] [mobility|endurance|strength|speed|power] — generate a tailored workout from goals, equipment, recent training, and Whoop recovery',
    '/done-workout — log the last generated workout to today\'s journal',
    '/study — current study progress and assignments',
    '/family — 14-day family mention scan',
    '/career — active job applications',
    '/fresh — log conversation to journal, reset session',
    '/journal <text> — append entry to today\'s journal',
    '/ask <question> — one-shot vault query',
    '/kb <question> — query the knowledge base',
    '/ingest [path] — ingest source into knowledge base',
    '/seed [--dry-run] — bulk-seed KB from vault content',
    '/lint — run wiki health check',
    '/prep — run morning prep now',
    '/status — show uptime and session info',
    '/learn <text> — append a runtime learning (auto-prepended to future agents)',
    '/learn-list — show current prepended learnings',
    '',
    'Sessions:',
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
    'Model (conversation defaults to opus):',
    '/opus — max capability',
    '/sonnet — balanced',
    '/haiku — fast responses',
  ];

  await bot.sendMessage(chatId, lines.join('\n'));
}
