import type TelegramBot from 'node-telegram-bot-api';
import type { MessageSender } from '../../transport/sender.js';
import config from '../../config.js';
import {
  getSession,
  createSession,
  updateSession,
  setSessionModel,
  appendMessageToSession,
  buildSessionSystemPrompt,
  type Transport,
  type SessionScope,
} from '../../vault/sessions.js';
import { askClaudeWithContext, runAgent } from '../../ai/claude.js';
import { createLogger } from '../../utils/logger.js';
import { handleFresh } from '../commands/fresh.js';
import { handleFreshFull } from '../commands/fresh-full.js';
import { handleClear } from '../commands/clear.js';
import { handleJournal } from '../commands/journal.js';
import { handleAsk } from '../commands/ask.js';
import { handleStatus } from '../commands/status.js';
import { handleKB } from '../commands/kb.js';
import { handleIngest } from '../commands/ingest.js';
import { handlePriorities } from '../commands/priorities.js';
import { handleWorkout } from '../commands/workout.js';
import { handleDoneWorkout } from '../commands/done-workout.js';
import { handleSyllabus } from '../commands/syllabus.js';
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
import { handleNewProject } from '../commands/new-project.js';
import { handlePlan } from '../commands/plan.js';
import { handleApprove } from '../commands/approve.js';
import { handleLibrarySync } from '../commands/library-sync.js';
import { handleSeed } from '../commands/seed.js';
import { handleLearn } from '../commands/learn.js';
import { handleLearnList } from '../commands/learn-list.js';
import { handleCancel } from '../commands/cancel.js';
import { handleCancelReview } from '../commands/cancel-review.js';
import { hasActiveReview, handleReviewMessage } from '../../reviews/orchestrator.js';
import { getActivePlanningSession, type StoredPlanningSession } from '../../reviews/planning.js';
import { handlePlanningTurn, defaultScopingTurn } from '../../reviews/planning-handler.js';
import { hasActiveSRSession, handleSRMessage } from '../../study/sr-session.js';
import { containsURL, handleURLMessage } from './url.js';
import { isConfigured, getAuthorizationURL, getAccessToken, describeTokenError } from '../../integrations/whoop/client.js';
import { WHOOP_REDIRECT_URI } from '../../server/http.js';
import { getStoredTokens } from '../../integrations/whoop/keychain.js';
import { classifyIntent, type ClassifyResult } from '../resolver.js';
import { getSkillRegistry, type SkillEntry } from '../skill-registry.js';
import { appendIntent, type IntentOutcome } from '../../utils/intent-log.js';
import { appendInteraction } from '../../utils/observation-log.js';

const log = createLogger('text-handler');

export async function handleTextMessage(sender: MessageSender, msg: TelegramBot.Message): Promise<void> {
  // Security gate — unauthorized senders produce no observation log entry
  // either (no record of a rejected attempt; the bot is private).
  if (msg.from?.id !== config.TELEGRAM_USER_ID) return;

  const userId = msg.chat.id;
  const text = (msg.text || '').trim();
  if (!text) return;

  // Phase 6 B1.2: one InteractionLogRecord per inbound TG message. `detail`
  // captures the route derived from slash-prefix matching — never the
  // message body. Outcome reflects whether dispatchText returned cleanly.
  const route = routeOf(text);
  let outcome: 'success' | 'failure' = 'success';
  try {
    await dispatchText(sender, userId, text);
  } catch (err) {
    outcome = 'failure';
    throw err;
  } finally {
    try {
      appendInteraction({
        ts: new Date().toISOString(),
        kind: 'tg-message',
        outcome,
        detail: `route=${route}`,
      });
    } catch (logErr) {
      // Logging is best-effort — a disk failure must not crash the handler.
      log.warn('appendInteraction failed', { error: (logErr as Error).message });
    }
  }
}

/** Maximum length of a slash-route token in the observation log — caps
 *  the worst-case detail-field size at a known bound regardless of input.
 *  Real slash commands top out around 15 chars; 32 gives generous headroom
 *  for new commands without admitting pathological inputs. */
const MAX_ROUTE_TOKEN_LEN = 32;

/** Classify an inbound message into a structured route token for the
 *  observation log. Returns `/<command>` for slash commands (truncated to
 *  `MAX_ROUTE_TOKEN_LEN` to bound the detail field) and `conversation`
 *  for free-form text. The return value is structured metadata — never
 *  the message body — so it can safely land in `InteractionLogRecord.detail`.
 *  Mirrors the prefix chain in `dispatchText` but only extracts the route
 *  name; the actual handler is invoked by `dispatchText` itself. */
function routeOf(text: string): string {
  if (!text.startsWith('/')) return 'conversation';
  // Take the first whitespace-delimited token and strip args. Cap the
  // length so a pathological input (e.g., a slash followed by a 10KB
  // run of non-whitespace) can't blow up the observation log entry.
  const head = text.split(/\s+/)[0]!;
  return head.length > MAX_ROUTE_TOKEN_LEN
    ? `${head.slice(0, MAX_ROUTE_TOKEN_LEN)}…`
    : head;
}

/** Phase 6 B1.3: wrap a slash-command handler invocation with an
 *  observation-log emission. Each slash dispatch in `dispatchText` goes
 *  through this so the observation loop sees one `kind:'command'` record
 *  per command invocation, with outcome derived from whether the handler
 *  threw. `detail` carries only the structured command name (`cmd=<name>`)
 *  — never the args, which can contain raw user content. */
async function withCommandLog<T>(name: string, fn: () => Promise<T>): Promise<T> {
  let outcome: 'success' | 'failure' = 'success';
  try {
    return await fn();
  } catch (err) {
    outcome = 'failure';
    throw err;
  } finally {
    try {
      appendInteraction({
        ts: new Date().toISOString(),
        kind: 'command',
        outcome,
        detail: `cmd=${name}`,
      });
    } catch (logErr) {
      log.warn('appendInteraction failed for command', { name, error: (logErr as Error).message });
    }
  }
}

/** Core routing chain shared by TG and webview transports. Auth/userId extraction
 *  happens upstream; callers must pass the verified userId. Transport is taken
 *  from `sender.name` (its discriminant union matches `Transport`) so session
 *  and journal writes are keyed independently per channel. */
export async function dispatchText(
  sender: MessageSender,
  userId: number,
  text: string,
  scope?: SessionScope,
): Promise<void> {
  if (!text) return;
  const transport: Transport = sender.name;

  // Each slash branch wraps its handler in `withCommandLog` so every
  // command invocation produces one `kind:'command'` observation record
  // (Phase 6 B1.3). The `cmd=<name>` detail is structured — never the args.
  if (text.startsWith('/fresh-full')) return withCommandLog('fresh-full', () => (
    scope ? handleFreshFull(sender, userId, transport, scope) : handleFreshFull(sender, userId, transport)
  ));
  if (text.startsWith('/fresh')) return withCommandLog('fresh', () => (
    scope ? handleFresh(sender, userId, transport, scope) : handleFresh(sender, userId, transport)
  ));
  if (text === '/clear' || text.startsWith('/clear ')) return withCommandLog('clear', () => (
    scope ? handleClear(sender, userId, transport, scope) : handleClear(sender, userId, transport)
  ));
  if (text === '/cancel-review') return withCommandLog('cancel-review', () => handleCancelReview(sender, userId));
  if (text === '/cancel' || text.startsWith('/cancel ')) return withCommandLog('cancel', () => handleCancel(sender, userId, text.slice('/cancel'.length).trim()));
  if (text.startsWith('/journal ')) return withCommandLog('journal', () => {
    const journalText = text.slice('/journal '.length).trim();
    return scope
      ? handleJournal(sender, userId, transport, journalText, scope)
      : handleJournal(sender, userId, transport, journalText);
  });
  if (text.startsWith('/ask ')) return withCommandLog('ask', () => handleAsk(sender, userId, text.slice('/ask '.length).trim()));
  if (text.startsWith('/kb ')) return withCommandLog('kb', () => handleKB(sender, userId, text.slice('/kb '.length).trim()));
  if (text.startsWith('/ingest')) return withCommandLog('ingest', () => handleIngest(sender, userId, text.slice('/ingest'.length).trim()));
  if (text.startsWith('/daily')) return withCommandLog('daily', () => handleDaily(sender, userId, text.slice('/daily'.length).trim()));
  if (text.startsWith('/weekly')) return withCommandLog('weekly', () => handleWeekly(sender, userId, text.slice('/weekly'.length).trim()));
  if (text.startsWith('/monthly')) return withCommandLog('monthly', () => handleMonthly(sender, userId, text.slice('/monthly'.length).trim()));
  if (text.startsWith('/quarterly')) return withCommandLog('quarterly', () => handleQuarterly(sender, userId, text.slice('/quarterly'.length).trim()));
  if (text.startsWith('/yearly')) return withCommandLog('yearly', () => handleYearly(sender, userId, text.slice('/yearly'.length).trim()));
  if (text.startsWith('/priorities')) return withCommandLog('priorities', () => handlePriorities(sender, userId, text.slice('/priorities'.length).trim()));
  // /done-workout must come before /workout so the longer prefix wins.
  if (text.startsWith('/done-workout')) return withCommandLog('done-workout', () => handleDoneWorkout(sender, userId));
  if (text.startsWith('/workout')) return withCommandLog('workout', () => handleWorkout(sender, userId, text.slice('/workout'.length).trim()));
  if (text.startsWith('/syllabus')) return withCommandLog('syllabus', () => handleSyllabus(sender, userId));
  if (text.startsWith('/study')) return withCommandLog('study', () => handleStudy(sender, userId, text.slice('/study'.length).trim()));
  if (text.startsWith('/family')) return withCommandLog('family', () => handleFamily(sender, userId));
  if (text.startsWith('/career')) return withCommandLog('career', () => handleCareer(sender, userId));
  if (text.startsWith('/health')) return withCommandLog('health', () => handleHealth(sender, userId, text.slice('/health'.length).trim()));
  if (text.startsWith('/blog')) return withCommandLog('blog', () => handleBlog(sender, userId, text.slice('/blog'.length).trim()));
  if (text.startsWith('/new-project')) return withCommandLog('new-project', () => handleNewProject(sender, userId, text.slice('/new-project'.length).trim()));
  if (text === '/plan' || text.startsWith('/plan ')) return withCommandLog('plan', () => handlePlan(sender, userId, text.slice('/plan'.length).trim()));
  if (text === '/approve' || text.startsWith('/approve ')) return withCommandLog('approve', () => handleApprove(sender, userId));
  if (text.startsWith('/library-sync')) return withCommandLog('library-sync', () => handleLibrarySync(sender, userId));
  // /learn-list must come before /learn so the longer prefix wins.
  if (text.startsWith('/learn-list')) return withCommandLog('learn-list', () => handleLearnList(sender, userId));
  if (text === '/learn' || text.startsWith('/learn ')) return withCommandLog('learn', () => handleLearn(sender, userId, text.slice('/learn'.length).trim()));
  if (text.startsWith('/prep')) return withCommandLog('prep', () => handlePrep(sender, userId));
  if (text.startsWith('/seed')) return withCommandLog('seed', () => handleSeed(sender, userId, text.slice('/seed'.length).trim()));
  if (text.startsWith('/lint')) return withCommandLog('lint', () => handleLint(sender, userId));
  if (text.startsWith('/opus')) return withCommandLog('opus', () => handleModelSwitch(sender, userId, transport, 'opus', scope));
  if (text.startsWith('/sonnet')) return withCommandLog('sonnet', () => handleModelSwitch(sender, userId, transport, 'sonnet', scope));
  if (text.startsWith('/haiku')) return withCommandLog('haiku', () => handleModelSwitch(sender, userId, transport, 'haiku', scope));
  if (text.startsWith('/status')) return withCommandLog('status', () => (
    scope ? handleStatus(sender, userId, transport, scope) : handleStatus(sender, userId, transport)
  ));
  if (text.startsWith('/whoop')) return withCommandLog('whoop', () => handleWhoop(sender, userId));
  if (text.startsWith('/start')) return withCommandLog('start', () => handleStart(sender, userId));

  // Active planning session takes routing priority over the default
  // conversation thread (analogous to active reviews below). Slash commands
  // already short-circuited above, so `/plan`, `/clear`, and `/fresh` reach
  // their handlers; only free-form text falls through here. The planning
  // handler's reply is surfaced raw — the LLM's question is self-contained
  // and the spec-proposed transition will be wrapped by A4.4/C6.
  const activePlanning = getActivePlanningSession(userId);
  if (planningMatchesScope(activePlanning, scope)) return routeToPlanning(sender, userId, text);

  // Active review session takes priority over default conversation
  if (hasActiveReview(userId)) return handleReviewMessage(userId, text, sender);

  // Active spaced-repetition session — route the reply as the answer
  if (hasActiveSRSession(userId)) return handleSRMessage(userId, text, sender);

  // In-flight chat session — skip the resolver and continue the thread.
  // The classifier's job is to route opening intent; continuation messages
  // can read as journal/note status updates and get hijacked at ≥0.7
  // confidence, which closes the active session (handleJournal calls
  // closeConversation when a session exists). Slash escape hatches
  // (/fresh, /journal, /clear) already short-circuited above.
  if (scope ? getSession(userId, transport, scope) : getSession(userId, transport)) {
    return handleConversation(sender, userId, transport, text, scope);
  }

  // URL detection — messages containing URLs go to content triage. Checked
  // AFTER the review/SR/chat-session checks above: a URL shared mid-thread
  // belongs to that thread, so an active chat (which has the WebFetch tool to
  // fetch it), a review interview, or an SR session each absorb the message as
  // normal text rather than having it siphoned off to independent triage.
  // Triage runs only when no conversational context is open.
  if (containsURL(text)) return handleURLMessage(sender, userId, text);

  // Resolver: classify free-form messages against the skill registry. Skipped
  // for short messages (rarely encode a routable intent) to save the Haiku
  // call. Slash commands already short-circuited above; active-session above.
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  if (wordCount >= config.RESOLVER_MIN_WORDS) {
    const routed = await tryResolveAndDispatch(sender, userId, transport, text, scope);
    if (routed) return;
    // Fall through — the resolver already logged the intent-log entry.
  }

  // Default: multi-turn conversation
  return handleConversation(sender, userId, transport, text, scope);
}

/** Run the resolver and, if confidence ≥ threshold and the top-2 aren't
 *  ambiguous, invoke the routed skill. Always appends one entry to the
 *  intent log when the classifier runs. Returns true if a skill was invoked
 *  (caller should stop); false if the caller should fall through to the
 *  freeform handler. Any thrown error — including from getSkillRegistry or
 *  classifyIntent itself — is caught and treated as "not routed" so the
 *  Telegram polling handler never sees an uncaught rejection. */
async function tryResolveAndDispatch(
  sender: MessageSender,
  userId: number,
  transport: Transport,
  text: string,
  scope?: SessionScope,
): Promise<boolean> {
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
      await sender.send(
        userId,
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
      await invokeSkill(sender, userId, transport, text, entry, result.args, scope);
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
  sender: MessageSender,
  userId: number,
  transport: Transport,
  message: string,
  skill: SkillEntry,
  args: string,
  scope?: SessionScope,
): Promise<void> {
  if (skill.kind === 'agent') {
    // No explicit label here — runAgent's op-event:start arrives within ms
    // and fills the pill with the agent's friendly phrase from op-labels.ts.
    sender.startTyping(userId);
    try {
      const result = await runAgent(skill.name, args || message);
      if (result.error || !result.text) {
        throw new Error(result.error ?? 'Agent returned empty output');
      }
      await sender.send(userId, result.text);
    } finally {
      sender.stopTyping(userId);
    }
    return;
  }
  // Slash-kind dispatch. Mirrors the prefix chain at the top of
  // handleTextMessage. Only commands that make sense as resolver routes are
  // listed — model-switch (/opus, /sonnet, /haiku), auth (/whoop, /start),
  // and admin (/status, /lint, /seed) commands are intentionally omitted.
  switch (skill.name) {
    case 'journal': return scope
      ? handleJournal(sender, userId, transport, args, scope)
      : handleJournal(sender, userId, transport, args);
    case 'ingest': return handleIngest(sender, userId, args);
    case 'priorities': return handlePriorities(sender, userId, args);
    case 'workout': return handleWorkout(sender, userId, args);
    case 'done-workout': return handleDoneWorkout(sender, userId);
    case 'syllabus': return handleSyllabus(sender, userId);
    case 'study': return handleStudy(sender, userId, args);
    case 'family': return handleFamily(sender, userId);
    case 'career': return handleCareer(sender, userId);
    case 'prep': return handlePrep(sender, userId);
    case 'daily': return handleDaily(sender, userId, args);
    case 'weekly': return handleWeekly(sender, userId, args);
    case 'monthly': return handleMonthly(sender, userId, args);
    case 'quarterly': return handleQuarterly(sender, userId, args);
    case 'yearly': return handleYearly(sender, userId, args);
    case 'health': return handleHealth(sender, userId, args);
    case 'blog': return handleBlog(sender, userId, args);
    case 'library-sync': return handleLibrarySync(sender, userId);
    case 'learn': return handleLearn(sender, userId, args || message);
    case 'learn-list': return handleLearnList(sender, userId);
    case 'fresh': return scope
      ? handleFresh(sender, userId, transport, scope)
      : handleFresh(sender, userId, transport);
    case 'fresh-full': return scope
      ? handleFreshFull(sender, userId, transport, scope)
      : handleFreshFull(sender, userId, transport);
    case 'plan': return handlePlan(sender, userId, args);
    // No 'approve' case — /approve is an explicit gate, not resolver-inferred.
    default:
      throw new Error(`No dispatcher for slash skill: ${skill.name}`);
  }
}

function planningMatchesScope(
  planning: StoredPlanningSession | null,
  scope?: SessionScope,
): planning is StoredPlanningSession {
  if (!planning) return false;
  if (!scope || scope.kind === 'global') return true;
  return planning.planning.product === scope.product;
}

/** Drive one turn of an active planning conversation. Surfaces the LLM's
 *  scoping question verbatim; for the spec-proposed transition, appends a
 *  one-line footer telling the user how to /approve or /clear (until the
 *  inline-button approval round-trip lands in C6). Failures fall back to a
 *  clear error message rather than crashing the polling handler. */
async function routeToPlanning(
  sender: MessageSender,
  userId: number,
  text: string,
): Promise<void> {
  sender.startTyping(userId, 'Planning');
  try {
    const result = await handlePlanningTurn(
      { scopingTurn: defaultScopingTurn },
      userId,
      text,
    );
    const reply = result.status === 'spec-proposed'
      ? `${result.reply}\n\n— spec proposed · /approve to scaffold · /clear to abandon`
      : result.reply;
    await sender.send(userId, reply);
  } catch (err) {
    log.error('Planning turn exception', { error: (err as Error).message });
    await sender.send(userId, `Planning error: ${(err as Error).message}`);
  } finally {
    sender.stopTyping(userId);
  }
}

// Read-only by design: chat must never modify the vault. The "never write
// files" instruction in the session system prompt is reinforced here by
// omitting Write / Edit / Bash / NotebookEdit. If you find yourself wanting
// to add a write tool, route the operation through a slash command instead.
const CONVERSATION_TOOLS = [
  'Read',
  'Glob',
  'Grep',
  'WebSearch',
  'WebFetch',
  'mcp__jarvis-kb__repo_search',
  'mcp__jarvis-kb__kb_query',
  'mcp__jarvis-kb__kb_search',
  'mcp__jarvis-kb__kb_stats',
];

async function handleConversation(
  sender: MessageSender,
  userId: number,
  transport: Transport,
  text: string,
  scope?: SessionScope,
): Promise<void> {
  let session = scope ? getSession(userId, transport, scope) : getSession(userId, transport);
  if (!session) {
    session = scope
      ? createSession(userId, transport, text, config.CONVERSATION_MODEL, scope)
      : createSession(userId, transport, text, config.CONVERSATION_MODEL);
  }

  if (scope) appendMessageToSession(userId, transport, 'user', text, scope);
  else appendMessageToSession(userId, transport, 'user', text);

  sender.startTyping(userId, 'Asking Claude');
  try {
    const result = await askClaudeWithContext(
      text,
      session.sessionId,
      buildSessionSystemPrompt({ scope }),
      { model: session.model, allowedTools: CONVERSATION_TOOLS, opLabel: 'chat', voice: true },
    );

    if (result.error) {
      log.error('Conversation error', { error: result.error, sessionId: session.sessionId });
      await sender.send(userId, `Error: ${result.error}`);
      return;
    }

    const rawReply = result.text!;
    if (scope) {
      appendMessageToSession(userId, transport, 'assistant', rawReply, scope);
      updateSession(userId, transport, scope);
    } else {
      appendMessageToSession(userId, transport, 'assistant', rawReply);
      updateSession(userId, transport);
    }
    // Mode visibility: every conversation reply is suffixed so the user can
    // tell at a glance they are in a multi-turn thread (vs. a routed task
    // action, which has no such marker).
    const reply = `${rawReply}\n\n_— chatting · /fresh to end_`;
    await sender.send(userId, reply);
  } catch (err) {
    log.error('Conversation exception', { error: (err as Error).message });
    await sender.send(userId, `Error: ${(err as Error).message}`);
  } finally {
    sender.stopTyping(userId);
  }
}

async function handleLint(sender: MessageSender, userId: number): Promise<void> {
  const { lintKB } = await import('../../kb/engine.js');
  sender.startTyping(userId, 'Checking knowledge base');
  try {
    const result = await lintKB();
    await sender.send(userId, result.report);
  } catch (err) {
    log.error('Lint error', { error: (err as Error).message });
    await sender.send(userId, `Lint error: ${(err as Error).message}`);
  } finally {
    sender.stopTyping(userId);
  }
}

async function handleWhoop(sender: MessageSender, userId: number): Promise<void> {
  if (!isConfigured()) {
    await sender.send(userId, 'Whoop not configured. Set WHOOP_CLIENT_ID and WHOOP_CLIENT_SECRET in .env.local.');
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
    await sender.send(
      userId,
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
    await sender.send(
      userId,
      `Whoop connected (refreshed).\nAccess token expires in ${hours}h ${minutes}m (${expiryStr} ${config.TIMEZONE}).`,
    );
    return;
  }

  const detail = describeTokenError(result);
  if (result.reason === 'no_refresh_token' || result.reason === 'refresh_rejected') {
    const url = getAuthorizationURL(WHOOP_REDIRECT_URI);
    await sender.send(userId, `${detail}\n\nOpen this link to re-authorize:\n\n${url}`);
  } else {
    await sender.send(userId, detail);
  }
}

async function handleModelSwitch(
  sender: MessageSender,
  userId: number,
  transport: Transport,
  model: string,
  scope?: SessionScope,
): Promise<void> {
  const session = scope ? getSession(userId, transport, scope) : getSession(userId, transport);
  if (!session) {
    if (scope) {
      createSession(userId, transport, `/${model}`, undefined, scope);
      setSessionModel(userId, transport, model, scope);
    } else {
      createSession(userId, transport, `/${model}`);
      setSessionModel(userId, transport, model);
    }
    await sender.send(userId, `Switched to ${model}. New session started.`);
    return;
  }
  if (scope) setSessionModel(userId, transport, model, scope);
  else setSessionModel(userId, transport, model);
  await sender.send(userId, `Switched to ${model}.`);
}

async function handleStart(sender: MessageSender, userId: number): Promise<void> {
  const text = `# Jarvis — Second Brain

Send any message to start a multi-turn chat with your vault. Jarvis leans Socratic — expect questions before answers on strategy/reflection. \`/fresh\` ends the thread; logging to journal also ends it.

**Conversation**

- \`/fresh\` — log conversation to journal, reset session
- \`/fresh-full\` — log full verbatim transcript to journal with speaker labels, reset session
- \`/clear\` — discard active session without journaling
- \`/journal <text>\` — append entry to today's journal
- \`/cancel [opId-prefix]\` — kill an in-flight Claude operation (most recent for you, or by id prefix)

**Ask & search**

- \`/ask <question>\` — one-shot vault query
- \`/kb <question>\` — query the knowledge base

**Knowledge base**

- \`/ingest [path]\` — ingest source into knowledge base
- \`/seed [--dry-run]\` — bulk-seed KB from vault content
- \`/lint\` — run wiki health check
- \`/library-sync\` — pull new Lenny posts and podcasts into the vault

**Daily flow**

- \`/priorities\` — yesterday's priorities
- \`/prep\` — run morning prep now
- \`/status\` — show uptime and session info

**Planning**

- \`/plan [product]\` — Socratic planning conversation scoped to a product; produces a spec for approval
- \`/approve\` — approve the proposed spec and scaffold \`docs/projects/<NN-slug>/{spec,tasks,test-plan}.md\`
- \`/new-project [topic]\` — product interview → spec/tasks/test-plan for a new Jarvis project

**Reviews**

- \`/daily [date]\` — process journal tags into JSON updates
- \`/weekly [date]\` — end-of-week review interview
- \`/monthly [month]\` — monthly review interview
- \`/quarterly [Q1-Q4]\` — quarterly review interview
- \`/yearly [year]\` — yearly review (7 Questions)
- \`/cancel-review\` — clear a stuck review session (when an interview never reached writeup)

**Coaching sessions**

- \`/health [focus]\` — health coaching session
- \`/blog <topic>\` — blog writing session

**Fitness**

- \`/workout [home|gym] [mobility|endurance|strength|speed|power]\` — generate a tailored workout from goals, equipment, recent training, and Whoop recovery
- \`/done-workout\` — log the last generated workout to today's journal

**Study**

- \`/syllabus\` — current study progress and assignments
- \`/study [N|status]\` — spaced-repetition quiz over due wiki concepts

**People**

- \`/family\` — 14-day family mention scan
- \`/career\` — active job applications

**Learning notes**

- \`/learn <text>\` — append a runtime learning (auto-prepended to future agents)
- \`/learn-list\` — show current prepended learnings

**Integrations**

- \`/whoop\` — Whoop connection status or auth link

**Model** (conversation defaults to opus)

- \`/opus\` — max capability
- \`/sonnet\` — balanced
- \`/haiku\` — fast responses`;

  await sender.send(userId, text);
}
