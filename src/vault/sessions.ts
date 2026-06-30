import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync, renameSync, mkdirSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize } from 'node:path';
import config from '../config.js';
import { cleanupSession } from '../ai/claude.js';
import { createLogger } from '../utils/logger.js';
import { getTodayDate, getTimestamp } from '../utils/time.js';
import { readProductsConfig } from '../jobs/sandbox-runtime.js';

const log = createLogger('sessions');

const MAX_SESSION_MESSAGES = 200;
const PROMPT_CONTEXT_CHAR_LIMIT = 12_000;
const PROMPT_FILE_CHAR_LIMIT = 4_000;
const MAX_PROJECT_CONTEXTS = 5;

export type Transport = 'telegram' | 'webview';
export type SessionScope =
  | { kind: 'global'; product?: undefined }
  | { kind: 'product'; product: string };

export interface ConversationMessage {
  role: 'user' | 'assistant';
  text: string;
  ts: string;
}

export interface ProductPromptDoc {
  path: string;
  content: string;
}

export interface ProductPromptProject {
  slug: string;
  spec: string;
  tasks: string;
}

export interface ProductPromptWorldview {
  path: string;
  anchor?: string;
  content: string;
}

export interface ProductPromptContext {
  product: string;
  repoPath: string;
  scopePath?: string;
  repoDocs: ProductPromptDoc[];
  projects: ProductPromptProject[];
  worldview: ProductPromptWorldview[];
}

export interface BuildSessionSystemPromptInput {
  scope?: SessionScope;
  productContext?: ProductPromptContext;
  workspaceDir?: string;
  /** When true, the product preamble describes Rune as able to edit/run code in
   *  the product repo (Phase 2 write-enabled chat). When false/omitted, it
   *  describes a read-and-reason posture. The actual tool allowlist + writable
   *  dirs are enforced at the spawn (src/bot/handlers/text.ts, src/ai/claude.ts);
   *  this flag only keeps the prompt's stated capability honest. */
  writeEnabled?: boolean;
}

interface Session {
  sessionId: string;
  lastActivity: string;
  messageCount: number;
  firstMessage: string;
  model: string;
  messages: ConversationMessage[];
}

export const VAULT_SYSTEM_PROMPT_BASE = `You are Rune, the user's second-brain conversational layer. Your working directory is their Obsidian vault — you have full read access.

DEFAULT POSTURE — thinking partner. Lean Socratic. For strategic, reflective, or open-ended questions, your first move is to ask before you answer. Don't solve the problem for them; help them clarify their own thinking. Open with one or two sharp probing questions grounded in something specific you found in their vault. After they respond, offer your view.

For tactical or factual asks ("find Rory in my CRM", "what's my workout today", "who is X") — answer directly. Skip the thinking ritual. Be brief.

VAULT MAP (read the relevant file(s), don't dump everything):
- CLAUDE.md — identity, "About Me", vault folder structure, tag taxonomy, review cadence, command list. READ THIS FIRST when you don't already know the answer — it's the manifest.
- world-view/world-view.md — the user's explicit belief synthesis across 8 domains (ai, crypto, energy, raw-materials, geopolitics, demographics, governance, education-healthcare). Each domain has a dedicated file in world-view/ with thesis + investment implications + changelog.
- knowledge/index.md — 100+ curated wiki entities/concepts/topics compiled from their reading. For lookups against this file PREFER kb_query (the MCP synthesizer); only Read/Grep directly if you need a verbatim quote from the index or you're looking for a specific named entity by filename.
- knowledge/schema.md — how the KB is organized (raw sources → compiled wiki pages).
- pages/index.md, investments/index.md, health/index.md, career/index.md, study/index.md, writing/index.md — per-domain indices.
- pages/{books,crm,places}.json, health/workouts.json, career/applications.json, investments/investments.json — structured JSON stores. For lookups against these, Read/Grep them directly; no synthesis needed.
- journals/YYYY_MM_DD.md — daily notes (interstitial journaling).

KNOWLEDGE BASE (rune-kb MCP) — your FIRST move for any factual or domain question about the user's world (people, companies, projects, concepts, topics, frameworks they've written about). The KB is the synthesis layer over journals, articles, world-view, projects, and playbook. Don't grep the vault for these — ask the synthesizer.
- kb_query <question>: a synthesized natural-language answer with [[wikilink]] citations. Use for "what is X", "tell me about X", "current state of X", "summarize X strategy". The answer is synthesis-quality — use it directly or adapt minimally for the current conversational context; don't re-query the vault for what the KB already covers.
- kb_search <terms>: targeted full-text search across wiki pages, filtered by type (entity/concept/topic/comparison) or tag. Use when you need specific source pages to read after a kb_query, not a synthesized answer.
- kb_stats: counts + recent ingestion log. Diagnostic only.

WEB SEARCH (WebSearch, WebFetch): External-knowledge tools. Use them ACTIVELY when the question reaches outside the user's vault — current events, news, definitions, third-party docs/APIs, library behavior, market data, anything time-sensitive or factual that isn't already in their notes. Don't treat web as a last resort: if the question is genuinely about the world (not the user), web search is often the right first move alongside KB lookups. Cite sources inline (URL or article title) the way you cite [[wikilinks]] for vault content.

HOW TO ANSWER:
- Pick the mode by question shape, not by length. Strategy/reflection/exploration → ask first. Lookup/tactical/factual → answer directly.
- Route by subject: questions about the user's domain (work projects, companies, investments, frameworks, concepts) → kb_query FIRST. Then optionally Read specific files the KB answer cites for verbatim detail. Questions about the world (current events, third-party tools, external facts) → web first, vault second if relevant. Mixed questions → both, in parallel where possible.
- When to skip the KB: a specific named file the user is editing right now ("what does my projects/foo.md say verbatim"), a structured JSON store (workouts.json, books.json, crm.json — Read these directly), a specific journal date, slash-command dispatch.
- For substantive questions about worldview, investments, projects, or thinking frameworks: READ the relevant index/page first, then either probe (strategy) or answer with specifics (lookup). Cite with [[wikilinks]] where appropriate.
- Probing questions should be specific, not generic. "What's the current state? what flows in?" is exactly what to avoid — it re-elicits context already in the vault. Anchor every question to something concrete you found.
- Surface assumptions the user might be making. Name them explicitly.
- Responses go to Telegram on mobile — be concise. Structure matters more than length.
- Never write files. If the question implies a write, say so and point to the right slash command.
- The user can end the thread with /fresh, or by asking you to log the conversation to the journal.`;

function buildGenericSystemPrompt(workspaceDir: string | undefined): string {
  const workspacePrompt = workspaceDir
    ? `\n\nWORKSPACE: You also have read access to ${workspaceDir}. When the user references workspace files or project code, read them directly from that path.`
    : '';
  return `${VAULT_SYSTEM_PROMPT_BASE}${workspacePrompt}`;
}

/** Identity preamble for a PRODUCT-scoped chat. Unlike the global vault persona,
 *  Rune here is the development agent for one product, working IN that product's
 *  repo; the second brain is reached read-only through the rune-kb MCP, never as
 *  the working directory. `writeEnabled` flips the stated capability between
 *  read-and-reason and edit-and-run (kept in sync with the spawn's tool
 *  allowlist + writable dirs — see src/bot/handlers/text.ts). */
function buildProductIdentityPreamble(
  product: string,
  repoPath: string | undefined,
  scopePath: string | undefined,
  writeEnabled: boolean,
): string {
  const repoSentence = repoPath
    ? `Your working repo is ${repoPath}${scopePath ? ` (focused on ${scopePath})` : ''}.`
    : `Your working repo is this product's repository.`;
  const capability = writeEnabled
    ? `WORKING IN THIS REPO: You can read, edit, and run code in this repo (Read/Edit/Write/Bash, plus repo_search). Act directly on small, well-scoped changes. You CANNOT write anywhere outside this repo — the vault and other repos are read-only. For anything multi-step, risky, or that should land on main through review, dispatch a work run instead of hand-editing; restate the product and the target, and get the user's go before dispatching.`
    : `WORKING IN THIS REPO: In this chat you read and reason about ${product} — its code, specs, and how it works. You don't edit files from this chat; for changes, point the user to the work-run/Fix flow.`;
  const actLine = writeEnabled
    ? `For development questions and small changes, act directly: read the repo, make the change, run the check.`
    : `For development and factual questions, answer directly from the repo.`;
  return `You are Rune, the development agent for the ${product} product. ${repoSentence} ${actLine}

${capability}

SECOND BRAIN (read-only): You understand the user's second brain — journals, world-view, knowledge base, projects, playbook — and you reach it through the rune-kb MCP, READ-ONLY. kb_query gives a synthesized answer with [[wikilink]] citations; kb_search returns specific source pages; repo_search searches code. The vault is NOT your working directory and you never write to it — it is maintained by dedicated agents and scheduled jobs, not from this chat.

DEFAULT POSTURE — a capable engineer paired with the user on ${product}. For development/lookup questions, answer directly and act. For strategic or open-ended product questions, probe first: ask one or two sharp questions grounded in something specific you found in the repo or the second brain, then give your view.

KNOWLEDGE BASE (rune-kb MCP) is your first move for any question about the user's world (people, companies, concepts, frameworks, prior decisions). Don't grep the vault — ask the synthesizer.

WEB SEARCH (WebSearch, WebFetch): use actively for anything outside the repo and the second brain — library/API docs, third-party behavior, current events. Cite sources inline.

HOW TO ANSWER:
- Pick mode by shape: development/lookup → act directly; strategy/reflection → probe first.
- Route by subject: code/this-repo → repo tools; the user's domain (concepts, people, prior thinking) → kb_query first; the outside world → web.
- Responses may render on mobile — be concise; structure over length.
- The user can end the thread with /fresh.`;
}

function limitText(text: string, limit = PROMPT_FILE_CHAR_LIMIT): string {
  const trimmed = text.trim();
  return trimmed.length > limit ? `${trimmed.slice(0, limit)}\n...[truncated]` : trimmed;
}

function formatDocs(docs: ProductPromptDoc[]): string {
  if (docs.length === 0) return '(no repo docs loaded)';
  return docs.map(doc => `### ${doc.path}\n${limitText(doc.content)}`).join('\n\n');
}

function formatProjects(projects: ProductPromptProject[]): string {
  if (projects.length === 0) return '(no project specs/tasks loaded)';
  return projects.map(project => [
    `### ${project.slug}`,
    `spec.md:\n${limitText(project.spec)}`,
    `tasks.md:\n${limitText(project.tasks)}`,
  ].join('\n')).join('\n\n');
}

function formatWorldview(entries: ProductPromptWorldview[]): string {
  if (entries.length === 0) return '(no relevant worldview loaded)';
  return entries.map(entry => {
    const label = entry.anchor ? `${entry.path}#${entry.anchor}` : entry.path;
    return `### ${label}\n${limitText(entry.content)}`;
  }).join('\n\n');
}

function buildProductContextPrompt(scope: Extract<SessionScope, { kind: 'product' }>, context: ProductPromptContext): string {
  if (context.product !== scope.product) {
    throw new Error(
      `Product context mismatch: session scope is '${scope.product}' but loaded product context is '${context.product}'`,
    );
  }
  return [
    `PRODUCT CHAT: Active product: ${scope.product}.`,
    `Product repo: ${context.repoPath}`,
    ...(context.scopePath ? [`Product repo scope: ${context.scopePath}`] : []),
    'Ground this conversation in the loaded product context below. Search the active product repo, and the second brain via the rune-kb MCP, before answering product-specific development questions.',
    `REPO + KB ROUTING: code/project questions route to the active product repo (${context.repoPath}${context.scopePath ? `, scoped to ${context.scopePath}` : ''}) with repo_search/Read/Grep. Concept/people questions route to the KB with kb_query first, then kb_search for source pages. Mixed questions should use both.`,
    '',
    '## Loaded Repo Docs',
    formatDocs(context.repoDocs),
    '',
    '## Loaded Project Specs and Tasks',
    formatProjects(context.projects),
    '',
    '## Relevant Worldview',
    formatWorldview(context.worldview),
  ].join('\n');
}

export function buildSessionSystemPrompt(input: BuildSessionSystemPromptInput = {}): string {
  const scope = input.scope ?? { kind: 'global' };
  // Global (Telegram / cockpit Home) chat keeps the vault thinking-partner
  // persona. Product chats get a product-development identity instead (working
  // repo = the product repo; second brain read-only via the rune-kb MCP).
  if (scope.kind !== 'product') {
    return buildGenericSystemPrompt(input.workspaceDir ?? config.WORKSPACE_DIR);
  }

  const writeEnabled = input.writeEnabled ?? false;
  const context = input.productContext ?? loadProductPromptContext(scope.product);
  if (!context) {
    const preamble = buildProductIdentityPreamble(scope.product, undefined, undefined, writeEnabled);
    return `${preamble}\n\nPRODUCT CHAT: Active product: ${scope.product}. Product context could not be loaded; fail closed by asking the user to clarify rather than assuming another product's context. Search the active product repo, and the second brain via the rune-kb MCP, before answering product-specific development questions.`;
  }

  const preamble = buildProductIdentityPreamble(scope.product, context.repoPath, context.scopePath, writeEnabled);
  const productPrompt = buildProductContextPrompt(scope, context);
  const available = Math.max(0, PROMPT_CONTEXT_CHAR_LIMIT - preamble.length - 2);
  const boundedProductPrompt = productPrompt.length > available
    ? `${productPrompt.slice(0, available)}\n...[truncated product context]`
    : productPrompt;
  return `${preamble}\n\n${boundedProductPrompt}`;
}

/** Resolve the absolute working-directory (git repo root) for a product chat,
 *  or null when the product is unknown or has no repo configured (projection-
 *  only entries have an empty repoPath). The chat handler uses this to set the
 *  spawn cwd so Rune operates from the product repo, not the vault. Returns the
 *  repo root even for scoped products (scopePath narrows focus, not the repo). */
export function resolveProductRepoCwd(product: string): string | null {
  const context = loadProductPromptContext(product);
  if (!context || !context.repoPath) return null;
  return context.repoPath;
}

function readIfExists(absPath: string, relPath: string): ProductPromptDoc | null {
  try {
    if (!existsSync(absPath) || !statSync(absPath).isFile()) return null;
    return { path: relPath, content: readFileSync(absPath, 'utf8') };
  } catch {
    return null;
  }
}

function normalizeScopePath(scopePath: string | undefined): string | undefined {
  if (!scopePath) return undefined;
  const normalized = normalize(scopePath);
  if (isAbsolute(normalized) || normalized === '..' || normalized.startsWith('../')) return undefined;
  return normalized === '.' ? undefined : normalized;
}

function pathInProductScope(relPath: string, scopePath: string | undefined): string {
  return scopePath ? join(scopePath, relPath) : relPath;
}

function loadRepoDocs(repoPath: string, scopePath?: string): ProductPromptDoc[] {
  const root = scopePath ? join(repoPath, scopePath) : repoPath;
  const candidates = [
    'CLAUDE.md',
    'AGENTS.md',
    'README.md',
    join('docs', 'README.md'),
    join('docs', 'operations.md'),
  ];
  return candidates
    .map(rel => readIfExists(join(root, rel), pathInProductScope(rel, scopePath)))
    .filter((doc): doc is ProductPromptDoc => Boolean(doc));
}

function loadProjectContexts(repoPath: string, scopePath?: string): ProductPromptProject[] {
  const root = scopePath ? join(repoPath, scopePath) : repoPath;
  const projectsRel = scopePath ? 'projects' : join('docs', 'projects');
  const projectsDir = join(root, projectsRel);
  try {
    if (!existsSync(projectsDir) || !statSync(projectsDir).isDirectory()) return [];
    return readdirSync(projectsDir)
      .filter(slug => {
        try {
          return statSync(join(projectsDir, slug)).isDirectory();
        } catch {
          return false;
        }
      })
      .sort()
      .slice(0, MAX_PROJECT_CONTEXTS)
      .map(slug => ({
        slug,
        spec: readIfExists(
          join(projectsDir, slug, 'spec.md'),
          pathInProductScope(join(projectsRel, slug, 'spec.md'), scopePath),
        )?.content ?? '',
        tasks: readIfExists(
          join(projectsDir, slug, 'tasks.md'),
          pathInProductScope(join(projectsRel, slug, 'tasks.md'), scopePath),
        )?.content ?? '',
      }))
      .filter(project => project.spec || project.tasks);
  } catch {
    return [];
  }
}

function loadWorldviewContext(): ProductPromptWorldview[] {
  const worldviewDir = join(config.VAULT_DIR, 'world-view');
  try {
    if (!existsSync(worldviewDir) || !statSync(worldviewDir).isDirectory()) return [];
    return readdirSync(worldviewDir)
      .filter(name => name.endsWith('.md'))
      .sort()
      .slice(0, 4)
      .map(name => {
        const rel = join('world-view', name);
        const doc = readIfExists(join(worldviewDir, name), rel);
        return doc ? { path: doc.path, content: doc.content } : null;
      })
      .filter((entry): entry is ProductPromptWorldview => Boolean(entry));
  } catch {
    return [];
  }
}

function loadProductPromptContext(product: string): ProductPromptContext | null {
  try {
    const productConfig = readProductsConfig(config.PRODUCTS_CONFIG_FILE)[product];
    if (!productConfig) return null;
    const scopePath = normalizeScopePath(productConfig.scopePath);
    return {
      product,
      repoPath: productConfig.repoPath,
      ...(scopePath ? { scopePath } : {}),
      repoDocs: loadRepoDocs(productConfig.repoPath, scopePath),
      projects: loadProjectContexts(productConfig.repoPath, scopePath),
      worldview: loadWorldviewContext(),
    };
  } catch (err) {
    log.warn('Failed to load product prompt context', { product, error: (err as Error).message });
    return null;
  }
}

/** Composite key shape: global `${transport}:${userId}`, product
 *  `${product}:${transport}:${userId}`. The two-part global key is retained so
 *  existing on-disk sessions and Telegram/webview global threads keep working. */
function sessionKey(userId: number, transport: Transport, scope: SessionScope = { kind: 'global' }): string {
  if (scope.kind === 'product') return `${scope.product}:${transport}:${userId}`;
  return `${transport}:${userId}`;
}

/** Journal-entry source label used wherever a "[[rune]] <label>" line is
 *  written for a transport. Centralized so the four call sites (fresh,
 *  fresh-full, journal, capture) stay in sync if a third transport is added. */
export function transportLabel(transport: Transport): string {
  return transport === 'webview' ? 'webview chat' : 'telegram chat';
}

const sessions = new Map<string, Session>();

export function getSession(
  userId: number,
  transport: Transport,
  scope: SessionScope = { kind: 'global' },
): Session | null {
  return sessions.get(sessionKey(userId, transport, scope)) || null;
}

export function createSession(
  userId: number,
  transport: Transport,
  firstMessage: string,
  model?: string,
  scope: SessionScope = { kind: 'global' },
): Session {
  const session: Session = {
    sessionId: randomUUID(),
    lastActivity: new Date().toISOString(),
    messageCount: 1,
    firstMessage: (firstMessage || '').slice(0, 100),
    model: model || config.DEFAULT_CHAT_MODEL,
    messages: [],
  };
  sessions.set(sessionKey(userId, transport, scope), session);
  persistSessions();
  return session;
}

export function updateSession(
  userId: number,
  transport: Transport,
  scope: SessionScope = { kind: 'global' },
): void {
  const session = sessions.get(sessionKey(userId, transport, scope));
  if (!session) return;
  session.lastActivity = new Date().toISOString();
  session.messageCount++;
  persistSessions();
}

export function setSessionModel(
  userId: number,
  transport: Transport,
  model: string,
  scope: SessionScope = { kind: 'global' },
): void {
  const session = sessions.get(sessionKey(userId, transport, scope));
  if (!session) return;
  session.model = model;
  persistSessions();
}

export function deleteSession(
  userId: number,
  transport: Transport,
  scope: SessionScope = { kind: 'global' },
): void {
  const key = sessionKey(userId, transport, scope);
  const session = sessions.get(key);
  if (session) cleanupSession(session.sessionId);
  sessions.delete(key);
  persistSessions();
}

export function appendMessageToSession(
  userId: number,
  transport: Transport,
  role: 'user' | 'assistant',
  text: string,
  scope: SessionScope = { kind: 'global' },
): void {
  const session = sessions.get(sessionKey(userId, transport, scope));
  if (!session) return;
  if (session.messages.length >= MAX_SESSION_MESSAGES) session.messages.shift();
  session.messages.push({ role, text, ts: `${getTodayDate()} ${getTimestamp()}` });
  // Persistence is deferred to updateSession to avoid 3 synchronous disk writes per turn.
}

export function getSessionMessages(
  userId: number,
  transport: Transport,
  scope: SessionScope = { kind: 'global' },
): ConversationMessage[] {
  return sessions.get(sessionKey(userId, transport, scope))?.messages ?? [];
}

export interface SessionEntry {
  userId: number;
  transport: Transport;
  scope?: SessionScope;
  session: Session;
}

/** Snapshot of every active session. Callers that need to act on a specific
 *  session (e.g. nightly capture deletes after summarizing) get the
 *  destructured pair so they don't have to parse the composite key. */
export function getAllSessions(): SessionEntry[] {
  const out: SessionEntry[] = [];
  for (const [key, session] of sessions.entries()) {
    const parsed = parseSessionKey(key);
    if (!parsed) continue;
    out.push({ ...parsed, session });
  }
  return out;
}

/** Parse a composite key. Returns null for malformed keys so callers can skip
 *  rather than throw — useful during the legacy-format migration. */
export function parseSessionKey(key: string): { userId: number; transport: Transport; scope: SessionScope } | null {
  const parts = key.split(':');
  if (parts.length === 2) {
    const [transport, rawUserId] = parts;
    if (transport !== 'telegram' && transport !== 'webview') return null;
    const userId = Number(rawUserId);
    if (!Number.isFinite(userId)) return null;
    return { userId, transport, scope: { kind: 'global' } };
  }
  if (parts.length !== 3) return null;
  const [product, transport, rawUserId] = parts;
  if (!product) return null;
  if (transport !== 'telegram' && transport !== 'webview') return null;
  const userId = Number(rawUserId);
  if (!Number.isFinite(userId)) return null;
  return { userId, transport, scope: { kind: 'product', product } };
}

export function restoreSessions(): void {
  try {
    const data = readFileSync(config.SESSIONS_FILE, 'utf8');
    const entries = JSON.parse(data) as [string | number, Session][];
    let migrated = 0;
    for (const [rawKey, session] of entries) {
      if (!session.messages) session.messages = [];
      // Legacy format: bare numeric key with no transport prefix. Treat
      // these as 'telegram' since they predate the webview transport.
      let key: string;
      if (typeof rawKey === 'number') {
        key = sessionKey(rawKey, 'telegram');
        migrated++;
      } else if (parseSessionKey(rawKey)) {
        key = rawKey;
      } else {
        // Unrecognized string key — log it rather than dropping silently so
        // hand-edited or partially-migrated files surface in operator logs.
        log.warn('Skipping session with unrecognized key', { rawKey });
        continue;
      }
      sessions.set(key, session);
    }
    if (migrated > 0) {
      log.info(`Restored ${sessions.size} session(s) from disk (${migrated} migrated from legacy format)`);
      // Persist immediately so the file is in the new format from here on.
      persistSessions();
    } else {
      log.info(`Restored ${sessions.size} session(s) from disk`);
    }
  } catch {
    // Missing or corrupt file — start fresh
  }
}

export function persistSessions(): void {
  try {
    mkdirSync(dirname(config.SESSIONS_FILE), { recursive: true });
    const tmp = config.SESSIONS_FILE + '.tmp';
    writeFileSync(tmp, JSON.stringify([...sessions.entries()], null, 2));
    renameSync(tmp, config.SESSIONS_FILE);
  } catch (err) {
    log.error('Failed to persist sessions', { error: (err as Error).message });
  }
}
