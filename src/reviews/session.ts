import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import config from '../config.js';
import { cleanupSession } from '../ai/claude.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('review-session');

export type ReviewType = 'daily' | 'weekly' | 'monthly' | 'quarterly' | 'yearly' | 'health' | 'blog';
export type ReviewPhase = 'prep' | 'interview' | 'outline' | 'approval' | 'writeup' | 'updates' | 'done';

export interface ReviewSession {
  id: string;
  chatId: number;
  type: ReviewType;
  targetDate: string;
  phase: ReviewPhase;
  claudeSessionId: string;
  topic: string | null;
  prepContext: string | null;
  outline: string | null;
  createdAt: string;
  lastActivity: string;
}

const sessions = new Map<number, ReviewSession>();

export function getReviewSession(chatId: number): ReviewSession | null {
  return sessions.get(chatId) || null;
}

export function getActiveReviewSession(chatId: number): ReviewSession | null {
  const session = sessions.get(chatId);
  if (!session || session.phase === 'done') return null;
  return session;
}

export function createReviewSession(chatId: number, type: ReviewType, targetDate: string, topic?: string): ReviewSession {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) {
    throw new Error(`Invalid targetDate format: ${targetDate} (expected YYYY-MM-DD)`);
  }
  const existing = getActiveReviewSession(chatId);
  if (existing) {
    log.info('Cancelling active review to start new one', { chatId, oldType: existing.type, oldPhase: existing.phase, newType: type });
  }
  const now = new Date().toISOString();
  const session: ReviewSession = {
    id: randomUUID(),
    chatId,
    type,
    targetDate,
    phase: 'prep',
    claudeSessionId: randomUUID(),
    topic: topic ?? null,
    prepContext: null,
    outline: null,
    createdAt: now,
    lastActivity: now,
  };
  sessions.set(chatId, session);
  persistReviewSessions();
  return session;
}

export function updateReviewSession(chatId: number, updates: Partial<Pick<ReviewSession, 'prepContext' | 'outline' | 'phase'>>): void {
  const session = sessions.get(chatId);
  if (!session) return;
  Object.assign(session, updates);
  session.lastActivity = new Date().toISOString();
  persistReviewSessions();
}

const sessionDeletedCallbacks: ((claudeSessionId: string) => void)[] = [];

export function onReviewSessionDeleted(cb: (claudeSessionId: string) => void): void {
  sessionDeletedCallbacks.push(cb);
}

export function deleteReviewSession(chatId: number): void {
  const session = sessions.get(chatId);
  if (session) {
    cleanupSession(session.claudeSessionId);
    for (const cb of sessionDeletedCallbacks) cb(session.claudeSessionId);
  }
  sessions.delete(chatId);
  persistReviewSessions();
}

export function restoreReviewSessions(): void {
  try {
    const data = readFileSync(config.REVIEW_SESSIONS_FILE, 'utf8');
    const entries = JSON.parse(data) as [number, ReviewSession][];
    for (const [chatId, session] of entries) {
      sessions.set(Number(chatId), session);
    }
    log.info(`Restored ${sessions.size} review session(s) from disk`);
  } catch {
    // Missing or corrupt file — start fresh
  }
}

export function persistReviewSessions(): void {
  try {
    mkdirSync(dirname(config.REVIEW_SESSIONS_FILE), { recursive: true });
    const tmp = config.REVIEW_SESSIONS_FILE + '.tmp';
    writeFileSync(tmp, JSON.stringify([...sessions.entries()], null, 2));
    renameSync(tmp, config.REVIEW_SESSIONS_FILE);
  } catch (err) {
    log.error('Failed to persist review sessions', { error: (err as Error).message });
  }
}
