import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import config from '../config.js';
import { cleanupSession } from '../ai/claude.js';
import { createLogger } from '../utils/logger.js';
import { getTodayDate, getTimestamp } from '../utils/time.js';

const log = createLogger('sessions');

const MAX_SESSION_MESSAGES = 200;

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

const sessions = new Map<number, Session>();

export function getSession(chatId: number): Session | null {
  return sessions.get(chatId) || null;
}

export function createSession(chatId: number, firstMessage: string, model?: string): Session {
  const session: Session = {
    sessionId: randomUUID(),
    lastActivity: new Date().toISOString(),
    messageCount: 1,
    firstMessage: (firstMessage || '').slice(0, 100),
    model: model || config.DEFAULT_CHAT_MODEL,
    messages: [],
  };
  sessions.set(chatId, session);
  persistSessions();
  return session;
}

export function updateSession(chatId: number): void {
  const session = sessions.get(chatId);
  if (!session) return;
  session.lastActivity = new Date().toISOString();
  session.messageCount++;
  persistSessions();
}

export function setSessionModel(chatId: number, model: string): void {
  const session = sessions.get(chatId);
  if (!session) return;
  session.model = model;
  persistSessions();
}

export function deleteSession(chatId: number): void {
  const session = sessions.get(chatId);
  if (session) cleanupSession(session.sessionId);
  sessions.delete(chatId);
  persistSessions();
}

export function appendMessageToSession(chatId: number, role: 'user' | 'assistant', text: string): void {
  const session = sessions.get(chatId);
  if (!session) return;
  if (session.messages.length >= MAX_SESSION_MESSAGES) session.messages.shift();
  session.messages.push({ role, text, ts: `${getTodayDate()} ${getTimestamp()}` });
  // Persistence is deferred to updateSession to avoid 3 synchronous disk writes per turn.
}

export function getSessionMessages(chatId: number): ConversationMessage[] {
  return sessions.get(chatId)?.messages ?? [];
}

export function getAllSessions(): [number, Session][] {
  return [...sessions.entries()];
}

export function restoreSessions(): void {
  try {
    const data = readFileSync(config.SESSIONS_FILE, 'utf8');
    const entries = JSON.parse(data) as [number, Session][];
    for (const [chatId, session] of entries) {
      if (!session.messages) session.messages = [];
      sessions.set(Number(chatId), session);
    }
    log.info(`Restored ${sessions.size} session(s) from disk`);
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
