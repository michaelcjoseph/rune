import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdirSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpDir = join(tmpdir(), `jarvis-sessions-test-${Date.now()}`);
mkdirSync(tmpDir, { recursive: true });
const sessionsFile = join(tmpDir, 'tg-sessions.json');

vi.mock('../config.js', () => ({
  default: { SESSIONS_FILE: sessionsFile, LOGS_DIR: tmpDir, TIMEZONE: 'America/Chicago' },
}));

const {
  getSession,
  createSession,
  updateSession,
  deleteSession,
  getAllSessions,
  restoreSessions,
} = await import('./sessions.js');

describe('vault/sessions', () => {
  beforeEach(() => {
    for (const [chatId] of getAllSessions()) {
      deleteSession(chatId);
    }
  });

  describe('createSession', () => {
    it('creates a session with UUID and metadata', () => {
      const session = createSession(123, 'hello world');
      expect(session.sessionId).toBeDefined();
      expect(session.messageCount).toBe(1);
      expect(session.firstMessage).toBe('hello world');
      expect(session.lastActivity).toBeDefined();
    });

    it('truncates long first messages to 100 chars', () => {
      const session = createSession(123, 'x'.repeat(200));
      expect(session.firstMessage).toHaveLength(100);
    });
  });

  describe('getSession', () => {
    it('returns null for unknown chat', () => {
      expect(getSession(999)).toBeNull();
    });

    it('returns existing session', () => {
      createSession(123, 'test');
      expect(getSession(123)!.firstMessage).toBe('test');
    });
  });

  describe('updateSession', () => {
    it('increments message count', () => {
      createSession(123, 'test');
      updateSession(123);
      expect(getSession(123)!.messageCount).toBe(2);
    });

    it('no-ops for unknown chat', () => {
      expect(() => updateSession(999)).not.toThrow();
    });
  });

  describe('deleteSession', () => {
    it('removes session', () => {
      createSession(123, 'test');
      deleteSession(123);
      expect(getSession(123)).toBeNull();
    });
  });

  describe('getAllSessions', () => {
    it('returns all active sessions', () => {
      createSession(1, 'one');
      createSession(2, 'two');
      expect(getAllSessions()).toHaveLength(2);
    });
  });

  describe('persistence', () => {
    it('writes sessions to disk on create', () => {
      createSession(123, 'test');
      expect(existsSync(sessionsFile)).toBe(true);
    });

    it('restores sessions from file', () => {
      const data = [[123, {
        sessionId: 'restored-uuid',
        lastActivity: '2026-04-07T12:00:00Z',
        messageCount: 5,
        firstMessage: 'restored',
      }]];
      writeFileSync(sessionsFile, JSON.stringify(data));
      restoreSessions();
      const session = getSession(123);
      expect(session).not.toBeNull();
      expect(session!.sessionId).toBe('restored-uuid');
      expect(session!.messageCount).toBe(5);
    });

    it('handles corrupt file gracefully', () => {
      writeFileSync(sessionsFile, 'not json!!!');
      expect(() => restoreSessions()).not.toThrow();
    });

    it('handles missing file gracefully', () => {
      if (existsSync(sessionsFile)) unlinkSync(sessionsFile);
      expect(() => restoreSessions()).not.toThrow();
    });
  });
});
