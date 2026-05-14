import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdirSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpDir = join(tmpdir(), `jarvis-sessions-test-${Date.now()}`);
mkdirSync(tmpDir, { recursive: true });
const sessionsFile = join(tmpDir, 'tg-sessions.json');

vi.mock('../config.js', () => ({
  default: { SESSIONS_FILE: sessionsFile, LOGS_DIR: tmpDir, TIMEZONE: 'America/Chicago' },
  // Required by transitively-imported ai/claude.js, which builds an MCP
  // config path at module load.
  PROJECT_ROOT: '/tmp/test-project',
}));

const {
  getSession,
  createSession,
  updateSession,
  deleteSession,
  getAllSessions,
  restoreSessions,
  appendMessageToSession,
  getSessionMessages,
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

  describe('appendMessageToSession', () => {
    it('appends a user message to an existing session', () => {
      createSession(123, 'hello');
      appendMessageToSession(123, 'user', 'hello world');
      const messages = getSessionMessages(123);
      expect(messages).toHaveLength(1);
      expect(messages[0]!.role).toBe('user');
      expect(messages[0]!.text).toBe('hello world');
    });

    it('appends an assistant message', () => {
      createSession(123, 'hi');
      appendMessageToSession(123, 'assistant', 'Hello there!');
      const messages = getSessionMessages(123);
      expect(messages[0]!.role).toBe('assistant');
      expect(messages[0]!.text).toBe('Hello there!');
    });

    it('appends multiple messages in order', () => {
      createSession(123, 'first');
      appendMessageToSession(123, 'user', 'msg 1');
      appendMessageToSession(123, 'assistant', 'reply 1');
      appendMessageToSession(123, 'user', 'msg 2');
      const messages = getSessionMessages(123);
      expect(messages).toHaveLength(3);
      expect(messages.map(m => m.role)).toEqual(['user', 'assistant', 'user']);
      expect(messages.map(m => m.text)).toEqual(['msg 1', 'reply 1', 'msg 2']);
    });

    it('records a timestamp (ts) on each message', () => {
      createSession(123, 'hi');
      appendMessageToSession(123, 'user', 'timestamped');
      const ts = getSessionMessages(123)[0]!.ts;
      expect(ts).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    });

    it('is a no-op when no session exists for chatId', () => {
      expect(() => appendMessageToSession(999, 'user', 'ghost')).not.toThrow();
      expect(getSessionMessages(999)).toHaveLength(0);
    });
  });

  describe('getSessionMessages', () => {
    it('returns empty array when no session exists', () => {
      expect(getSessionMessages(999)).toEqual([]);
    });

    it('returns empty array for a fresh session with no appended messages', () => {
      createSession(123, 'hello');
      expect(getSessionMessages(123)).toEqual([]);
    });

    it('reflects messages appended after session creation', () => {
      createSession(123, 'hello');
      appendMessageToSession(123, 'user', 'first');
      appendMessageToSession(123, 'assistant', 'second');
      expect(getSessionMessages(123)).toHaveLength(2);
    });

    it('returns empty array after session is deleted', () => {
      createSession(123, 'hello');
      appendMessageToSession(123, 'user', 'something');
      deleteSession(123);
      expect(getSessionMessages(123)).toHaveLength(0);
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
