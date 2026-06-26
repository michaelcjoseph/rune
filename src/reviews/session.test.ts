import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdirSync, writeFileSync, existsSync, unlinkSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpDir = join(tmpdir(), `rune-review-sessions-test-${Date.now()}`);
mkdirSync(tmpDir, { recursive: true });
const reviewSessionsFile = join(tmpDir, 'review-sessions.json');

vi.mock('../config.js', () => ({
  default: { REVIEW_SESSIONS_FILE: reviewSessionsFile, LOGS_DIR: tmpDir, TIMEZONE: 'America/Chicago' },
  // Required by transitively-imported ai/claude.js (module-load const).
  PROJECT_ROOT: '/tmp/test-project',
}));

const {
  createReviewSession,
  getReviewSession,
  getActiveReviewSession,
  updateReviewSession,
  deleteReviewSession,
  persistReviewSessions,
  restoreReviewSessions,
} = await import('./session.js');

// Also verify type exports compile
import type { ReviewSession, ReviewType, ReviewPhase } from './session.js';

describe('reviews/session', () => {
  beforeEach(() => {
    // Clear all sessions between tests
    for (const chatId of [100, 200, 300, 999]) {
      deleteReviewSession(chatId);
    }
    // Clean up persisted file
    if (existsSync(reviewSessionsFile)) unlinkSync(reviewSessionsFile);
  });

  describe('createReviewSession', () => {
    it('creates a session with correct fields', () => {
      const session = createReviewSession(100, 'daily', '2026-04-10');
      expect(session.id).toBeDefined();
      expect(typeof session.id).toBe('string');
      expect(session.chatId).toBe(100);
      expect(session.type).toBe('daily');
      expect(session.targetDate).toBe('2026-04-10');
      expect(session.phase).toBe('prep');
      expect(session.claudeSessionId).toBeDefined();
      expect(typeof session.claudeSessionId).toBe('string');
      expect(session.prepContext).toBeNull();
      expect(session.outline).toBeNull();
      expect(session.createdAt).toBeDefined();
      expect(session.lastActivity).toBeDefined();
    });

    it('overwrites any existing session for the same chatId', () => {
      const first = createReviewSession(100, 'daily', '2026-04-09');
      const second = createReviewSession(100, 'weekly', '2026-04-10');
      expect(second.type).toBe('weekly');
      expect(second.id).not.toBe(first.id);
      // Only one session for chatId 100
      expect(getReviewSession(100)!.id).toBe(second.id);
    });
  });

  describe('getReviewSession', () => {
    it('returns null for unknown chatId', () => {
      expect(getReviewSession(999)).toBeNull();
    });

    it('returns the session for a known chatId', () => {
      const created = createReviewSession(100, 'monthly', '2026-04-01');
      const fetched = getReviewSession(100);
      expect(fetched).not.toBeNull();
      expect(fetched!.id).toBe(created.id);
    });
  });

  describe('getActiveReviewSession', () => {
    it('returns null when phase is done', () => {
      createReviewSession(100, 'daily', '2026-04-10');
      updateReviewSession(100, { phase: 'done' });
      expect(getActiveReviewSession(100)).toBeNull();
    });

    it('returns session when phase is not done', () => {
      createReviewSession(100, 'daily', '2026-04-10');
      updateReviewSession(100, { phase: 'interview' });
      const session = getActiveReviewSession(100);
      expect(session).not.toBeNull();
      expect(session!.phase).toBe('interview');
    });

    it('returns null for unknown chatId', () => {
      expect(getActiveReviewSession(999)).toBeNull();
    });
  });

  describe('updateReviewSession', () => {
    it('can update prepContext', () => {
      createReviewSession(100, 'daily', '2026-04-10');
      updateReviewSession(100, { prepContext: 'some context data' });
      expect(getReviewSession(100)!.prepContext).toBe('some context data');
    });

    it('can update outline', () => {
      createReviewSession(100, 'daily', '2026-04-10');
      updateReviewSession(100, { outline: '## Outline here' });
      expect(getReviewSession(100)!.outline).toBe('## Outline here');
    });

    it('can update phase', () => {
      createReviewSession(100, 'daily', '2026-04-10');
      updateReviewSession(100, { phase: 'approval' });
      expect(getReviewSession(100)!.phase).toBe('approval');
    });

    it('can update multiple fields at once', () => {
      createReviewSession(100, 'daily', '2026-04-10');
      updateReviewSession(100, { prepContext: 'ctx', outline: 'out', phase: 'writeup' });
      const s = getReviewSession(100)!;
      expect(s.prepContext).toBe('ctx');
      expect(s.outline).toBe('out');
      expect(s.phase).toBe('writeup');
    });

    it('updates lastActivity', () => {
      const session = createReviewSession(100, 'daily', '2026-04-10');
      updateReviewSession(100, { prepContext: 'updated' });
      const updated = getReviewSession(100)!;
      expect(updated.lastActivity).toBeDefined();
    });

    it('no-ops for unknown chatId', () => {
      expect(() => updateReviewSession(999, { prepContext: 'nope' })).not.toThrow();
    });
  });

  describe('deleteReviewSession', () => {
    it('removes the session', () => {
      createReviewSession(100, 'daily', '2026-04-10');
      deleteReviewSession(100);
      expect(getReviewSession(100)).toBeNull();
    });

    it('no-ops for unknown chatId', () => {
      expect(() => deleteReviewSession(999)).not.toThrow();
    });
  });

  describe('persistence round-trip', () => {
    it('persistReviewSessions writes and restoreReviewSessions reads back', () => {
      // Create sessions
      createReviewSession(100, 'daily', '2026-04-10');
      createReviewSession(200, 'weekly', '2026-04-07');
      updateReviewSession(100, { prepContext: 'daily-ctx', phase: 'interview' });

      // Verify file was written (createReviewSession calls persist internally)
      expect(existsSync(reviewSessionsFile)).toBe(true);

      // Read what was persisted
      const persisted = JSON.parse(readFileSync(reviewSessionsFile, 'utf8'));
      expect(persisted).toHaveLength(2);

      // Delete in-memory sessions to simulate restart
      deleteReviewSession(100);
      deleteReviewSession(200);
      expect(getReviewSession(100)).toBeNull();
      expect(getReviewSession(200)).toBeNull();

      // Write valid data for restore (deleteReviewSession overwrites the file)
      writeFileSync(reviewSessionsFile, JSON.stringify(persisted));

      // Restore
      restoreReviewSessions();
      const restored100 = getReviewSession(100);
      const restored200 = getReviewSession(200);
      expect(restored100).not.toBeNull();
      expect(restored100!.type).toBe('daily');
      expect(restored100!.prepContext).toBe('daily-ctx');
      expect(restored100!.phase).toBe('interview');
      expect(restored200).not.toBeNull();
      expect(restored200!.type).toBe('weekly');
    });

    it('restoreReviewSessions handles missing file gracefully', () => {
      if (existsSync(reviewSessionsFile)) unlinkSync(reviewSessionsFile);
      expect(() => restoreReviewSessions()).not.toThrow();
    });

    it('restoreReviewSessions handles corrupt file gracefully', () => {
      writeFileSync(reviewSessionsFile, 'not valid json!!!');
      expect(() => restoreReviewSessions()).not.toThrow();
    });
  });

  describe('type exports', () => {
    it('ReviewSession, ReviewType, ReviewPhase types are usable', () => {
      // This test verifies the types compile — runtime check on values
      const session: ReviewSession = createReviewSession(100, 'quarterly', '2026-04-01');
      const type: ReviewType = session.type;
      const phase: ReviewPhase = session.phase;
      expect(type).toBe('quarterly');
      expect(phase).toBe('prep');
    });
  });
});
