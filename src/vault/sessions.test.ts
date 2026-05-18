import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
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
    for (const { userId, transport } of getAllSessions()) {
      deleteSession(userId, transport);
    }
  });

  describe('createSession', () => {
    it('creates a session with UUID and metadata', () => {
      const session = createSession(123, 'telegram', 'hello world');
      expect(session.sessionId).toBeDefined();
      expect(session.messageCount).toBe(1);
      expect(session.firstMessage).toBe('hello world');
      expect(session.lastActivity).toBeDefined();
    });

    it('truncates long first messages to 100 chars', () => {
      const session = createSession(123, 'telegram', 'x'.repeat(200));
      expect(session.firstMessage).toHaveLength(100);
    });
  });

  describe('getSession', () => {
    it('returns null for unknown chat', () => {
      expect(getSession(999, 'telegram')).toBeNull();
    });

    it('returns existing session', () => {
      createSession(123, 'telegram', 'test');
      expect(getSession(123, 'telegram')!.firstMessage).toBe('test');
    });
  });

  describe('updateSession', () => {
    it('increments message count', () => {
      createSession(123, 'telegram', 'test');
      updateSession(123, 'telegram');
      expect(getSession(123, 'telegram')!.messageCount).toBe(2);
    });

    it('no-ops for unknown chat', () => {
      expect(() => updateSession(999, 'telegram')).not.toThrow();
    });
  });

  describe('deleteSession', () => {
    it('removes session', () => {
      createSession(123, 'telegram', 'test');
      deleteSession(123, 'telegram');
      expect(getSession(123, 'telegram')).toBeNull();
    });
  });

  describe('getAllSessions', () => {
    it('returns all active sessions', () => {
      createSession(1, 'telegram', 'one');
      createSession(2, 'telegram', 'two');
      expect(getAllSessions()).toHaveLength(2);
    });

    it('surfaces userId and transport per entry', () => {
      createSession(1, 'telegram', 'tg');
      createSession(1, 'webview', 'web');
      const entries = getAllSessions();
      const sorted = [...entries].sort((a, b) => a.transport.localeCompare(b.transport));
      expect(sorted.map(e => `${e.transport}:${e.userId}`)).toEqual(['telegram:1', 'webview:1']);
    });
  });

  describe('cross-transport isolation', () => {
    it('keeps TG and webview sessions independent under the same userId', () => {
      const tg = createSession(42, 'telegram', 'tg first message');
      const web = createSession(42, 'webview', 'webview first message');
      expect(tg.sessionId).not.toBe(web.sessionId);
      expect(getSession(42, 'telegram')!.firstMessage).toBe('tg first message');
      expect(getSession(42, 'webview')!.firstMessage).toBe('webview first message');
    });

    it('deleting the TG session leaves the webview session intact', () => {
      createSession(42, 'telegram', 'tg');
      const web = createSession(42, 'webview', 'web');
      deleteSession(42, 'telegram');
      expect(getSession(42, 'telegram')).toBeNull();
      expect(getSession(42, 'webview')!.sessionId).toBe(web.sessionId);
    });

    it('appendMessageToSession is scoped per-transport', () => {
      createSession(42, 'telegram', 'tg');
      createSession(42, 'webview', 'web');
      appendMessageToSession(42, 'telegram', 'user', 'tg-only');
      expect(getSessionMessages(42, 'telegram')).toHaveLength(1);
      expect(getSessionMessages(42, 'webview')).toHaveLength(0);
    });
  });

  describe('appendMessageToSession', () => {
    it('appends a user message to an existing session', () => {
      createSession(123, 'telegram', 'hello');
      appendMessageToSession(123, 'telegram', 'user', 'hello world');
      const messages = getSessionMessages(123, 'telegram');
      expect(messages).toHaveLength(1);
      expect(messages[0]!.role).toBe('user');
      expect(messages[0]!.text).toBe('hello world');
    });

    it('appends an assistant message', () => {
      createSession(123, 'telegram', 'hi');
      appendMessageToSession(123, 'telegram', 'assistant', 'Hello there!');
      const messages = getSessionMessages(123, 'telegram');
      expect(messages[0]!.role).toBe('assistant');
      expect(messages[0]!.text).toBe('Hello there!');
    });

    it('appends multiple messages in order', () => {
      createSession(123, 'telegram', 'first');
      appendMessageToSession(123, 'telegram', 'user', 'msg 1');
      appendMessageToSession(123, 'telegram', 'assistant', 'reply 1');
      appendMessageToSession(123, 'telegram', 'user', 'msg 2');
      const messages = getSessionMessages(123, 'telegram');
      expect(messages).toHaveLength(3);
      expect(messages.map(m => m.role)).toEqual(['user', 'assistant', 'user']);
      expect(messages.map(m => m.text)).toEqual(['msg 1', 'reply 1', 'msg 2']);
    });

    it('records a timestamp (ts) on each message', () => {
      createSession(123, 'telegram', 'hi');
      appendMessageToSession(123, 'telegram', 'user', 'timestamped');
      const ts = getSessionMessages(123, 'telegram')[0]!.ts;
      expect(ts).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    });

    it('is a no-op when no session exists for chatId', () => {
      expect(() => appendMessageToSession(999, 'telegram', 'user', 'ghost')).not.toThrow();
      expect(getSessionMessages(999, 'telegram')).toHaveLength(0);
    });
  });

  describe('getSessionMessages', () => {
    it('returns empty array when no session exists', () => {
      expect(getSessionMessages(999, 'telegram')).toEqual([]);
    });

    it('returns empty array for a fresh session with no appended messages', () => {
      createSession(123, 'telegram', 'hello');
      expect(getSessionMessages(123, 'telegram')).toEqual([]);
    });

    it('reflects messages appended after session creation', () => {
      createSession(123, 'telegram', 'hello');
      appendMessageToSession(123, 'telegram', 'user', 'first');
      appendMessageToSession(123, 'telegram', 'assistant', 'second');
      expect(getSessionMessages(123, 'telegram')).toHaveLength(2);
    });

    it('returns empty array after session is deleted', () => {
      createSession(123, 'telegram', 'hello');
      appendMessageToSession(123, 'telegram', 'user', 'something');
      deleteSession(123, 'telegram');
      expect(getSessionMessages(123, 'telegram')).toHaveLength(0);
    });
  });

  describe('persistence', () => {
    it('writes sessions to disk on create', () => {
      createSession(123, 'telegram', 'test');
      expect(existsSync(sessionsFile)).toBe(true);
    });

    it('restores sessions from file', () => {
      const data = [['telegram:123', {
        sessionId: 'restored-uuid',
        lastActivity: '2026-04-07T12:00:00Z',
        messageCount: 5,
        firstMessage: 'restored',
      }]];
      writeFileSync(sessionsFile, JSON.stringify(data));
      restoreSessions();
      const session = getSession(123, 'telegram');
      expect(session).not.toBeNull();
      expect(session!.sessionId).toBe('restored-uuid');
      expect(session!.messageCount).toBe(5);
    });

    it('migrates legacy numeric-keyed entries to telegram:<n>', () => {
      // Legacy format: `[number, Session][]` with no transport prefix.
      const data = [[123, {
        sessionId: 'legacy-uuid',
        lastActivity: '2026-04-07T12:00:00Z',
        messageCount: 3,
        firstMessage: 'legacy',
      }]];
      writeFileSync(sessionsFile, JSON.stringify(data));
      restoreSessions();
      expect(getSession(123, 'telegram')!.sessionId).toBe('legacy-uuid');
      expect(getSession(123, 'webview')).toBeNull();

      // After restore, the file should be rewritten in the new format.
      const persisted = JSON.parse(readFileSync(sessionsFile, 'utf8')) as [string, unknown][];
      expect(persisted.map(([k]) => k)).toEqual(['telegram:123']);
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
