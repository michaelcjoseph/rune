import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import config from '../config.js';
import { cleanupSession } from '../ai/claude.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('sessions');

interface Session {
  sessionId: string;
  lastActivity: string;
  messageCount: number;
  firstMessage: string;
  model: string;
}

const sessions = new Map<number, Session>();

export function getSession(chatId: number): Session | null {
  return sessions.get(chatId) || null;
}

export function createSession(chatId: number, firstMessage: string): Session {
  const session: Session = {
    sessionId: randomUUID(),
    lastActivity: new Date().toISOString(),
    messageCount: 1,
    firstMessage: (firstMessage || '').slice(0, 100),
    model: config.DEFAULT_CHAT_MODEL,
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

export function getAllSessions(): [number, Session][] {
  return [...sessions.entries()];
}

export function restoreSessions(): void {
  try {
    const data = readFileSync(config.SESSIONS_FILE, 'utf8');
    const entries = JSON.parse(data) as [number, Session][];
    for (const [chatId, session] of entries) {
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
