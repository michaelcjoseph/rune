import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import config from '../config.js';
import { cleanupSession } from '../ai/claude.js';
import { createLogger } from '../utils/logger.js';
import { getTodayDate, getTimestamp } from '../utils/time.js';

const log = createLogger('sessions');

const MAX_SESSION_MESSAGES = 200;

export type Transport = 'telegram' | 'webview';
export type SessionScope =
  | { kind: 'global'; product?: undefined }
  | { kind: 'product'; product: string };

export interface ConversationMessage {
  role: 'user' | 'assistant';
  text: string;
  ts: string;
}

interface Session {
  sessionId: string;
  lastActivity: string;
  messageCount: number;
  firstMessage: string;
  model: string;
  messages: ConversationMessage[];
}

/** Composite key shape: global `${transport}:${userId}`, product
 *  `${product}:${transport}:${userId}`. The two-part global key is retained so
 *  existing on-disk sessions and Telegram/webview global threads keep working. */
function sessionKey(userId: number, transport: Transport, scope: SessionScope = { kind: 'global' }): string {
  if (scope.kind === 'product') return `${scope.product}:${transport}:${userId}`;
  return `${transport}:${userId}`;
}

/** Journal-entry source label used wherever a "[[jarvis]] <label>" line is
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
function parseSessionKey(key: string): { userId: number; transport: Transport; scope: SessionScope } | null {
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
