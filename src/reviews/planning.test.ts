/**
 * Test suite for `src/reviews/planning.ts` — the per-user planning-session
 * store (Phase 6 A4.1). Mirrors `src/reviews/session.ts` for review
 * sessions; wraps the pure `PlanningSession` lifecycle from
 * `src/intent/planner.ts` with chatId-keyed state and JSON persistence.
 *
 * Written test-first; the implementation file does not exist yet.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// --- Mocks (hoisted) ---

vi.mock('../utils/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const { mockConfig, mockCleanupSession } = vi.hoisted(() => ({
  mockConfig: { PLANNING_SESSIONS_FILE: '/test/planning-sessions.json' },
  mockCleanupSession: vi.fn(),
}));
vi.mock('../config.js', () => ({ default: mockConfig }));
vi.mock('../ai/claude.js', () => ({
  cleanupSession: mockCleanupSession,
}));

// --- Imports under test (after mocks) ---

import {
  createPlanningSession,
  deletePlanningSession,
  getActivePlanningSession,
  getAllPlanningSessions,
  getPlanningSession,
  persistPlanningSessions,
  restorePlanningSessions,
  updatePlanningSession,
} from './planning.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'jarvis-planning-store-test-'));
  mockConfig.PLANNING_SESSIONS_FILE = join(tmpDir, 'planning-sessions.json');
  mockCleanupSession.mockReset();
  // Ensure no leftover sessions from previous test runs (in-memory state
  // is module-scoped; the persist file is per-test so a fresh restore
  // brings the in-memory state in sync with the empty file).
  restorePlanningSessions();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('createPlanningSession', () => {
  it('creates a session keyed by chatId with the pure PlanningSession embedded', () => {
    const s = createPlanningSession(42, 'build a thing', 'chat', 'aura');
    expect(s.chatId).toBe(42);
    expect(s.planning.idea).toBe('build a thing');
    expect(s.planning.surface).toBe('chat');
    expect(s.planning.product).toBe('aura');
    expect(s.planning.status).toBe('scoping');
    expect(typeof s.id).toBe('string');
    expect(typeof s.claudeSessionId).toBe('string');
    expect(typeof s.createdAt).toBe('string');
    expect(s.lastActivity).toBe(s.createdAt);
  });

  it('cancels an active planning session when a new one starts for the same chatId', () => {
    const first = createPlanningSession(42, 'idea one', 'chat', 'aura');
    const second = createPlanningSession(42, 'idea two', 'chat', 'aura');
    expect(getPlanningSession(42)?.id).toBe(second.id);
    expect(getPlanningSession(42)?.id).not.toBe(first.id);
  });
});

describe('getPlanningSession / getActivePlanningSession', () => {
  it('getPlanningSession returns the session for a chatId, null if absent', () => {
    expect(getPlanningSession(99)).toBeNull();
    const s = createPlanningSession(99, 'x', 'chat', 'aura');
    expect(getPlanningSession(99)).toEqual(s);
  });

  it('getActivePlanningSession returns the session for an in-flight conversation', () => {
    createPlanningSession(99, 'x', 'chat', 'aura');
    const active = getActivePlanningSession(99);
    expect(active).not.toBeNull();
  });

  it('getActivePlanningSession returns null for an abandoned session', () => {
    createPlanningSession(99, 'x', 'chat', 'aura');
    updatePlanningSession(99, (sess) => ({
      ...sess,
      planning: { ...sess.planning, status: 'abandoned' },
    }));
    expect(getActivePlanningSession(99)).toBeNull();
  });

  it('getActivePlanningSession returns null for an approved session', () => {
    // Approved sessions are terminal — the next stage is scaffolding via
    // project-setup-writer, which the bot handler triggers separately;
    // getActive should not return them as in-flight.
    createPlanningSession(99, 'x', 'chat', 'aura');
    updatePlanningSession(99, (sess) => ({
      ...sess,
      planning: { ...sess.planning, status: 'approved' },
    }));
    expect(getActivePlanningSession(99)).toBeNull();
  });
});

describe('updatePlanningSession', () => {
  it('applies the updater function and refreshes lastActivity', async () => {
    const created = createPlanningSession(7, 'a', 'chat', 'aura');
    // Sleep one ms so the lastActivity timestamp advances.
    await new Promise((r) => setTimeout(r, 5));
    updatePlanningSession(7, (sess) => ({
      ...sess,
      planning: {
        ...sess.planning,
        status: 'spec-proposed',
        artifact: { product: 'aura', title: 't', spec: 's', tasks: 'ts', testPlan: 'tp' },
      },
    }));
    const after = getPlanningSession(7)!;
    expect(after.planning.status).toBe('spec-proposed');
    expect(after.planning.artifact?.title).toBe('t');
    expect(after.lastActivity).not.toBe(created.lastActivity);
  });

  it('is a no-op when the chatId has no session', () => {
    expect(() =>
      updatePlanningSession(999, (sess) => sess),
    ).not.toThrow();
    expect(getPlanningSession(999)).toBeNull();
  });
});

describe('deletePlanningSession', () => {
  it('removes the session and calls cleanupSession with the claudeSessionId', () => {
    const s = createPlanningSession(8, 'a', 'chat', 'aura');
    deletePlanningSession(8);
    expect(getPlanningSession(8)).toBeNull();
    expect(mockCleanupSession).toHaveBeenCalledWith(s.claudeSessionId);
  });

  it('is a no-op when the chatId has no session', () => {
    expect(() => deletePlanningSession(999)).not.toThrow();
    expect(mockCleanupSession).not.toHaveBeenCalled();
  });
});

describe('persistPlanningSessions / restorePlanningSessions', () => {
  it('round-trips a single session through disk', () => {
    const original = createPlanningSession(12, 'an idea', 'cockpit', 'assay');
    // Force a persist (createPlanningSession already persists; this is
    // belt-and-suspenders for the round-trip assertion).
    persistPlanningSessions();
    // Wipe in-memory state by restoring from an empty file would be racy;
    // instead, re-read from the same file.
    restorePlanningSessions();
    const restored = getPlanningSession(12);
    expect(restored).not.toBeNull();
    expect(restored!.id).toBe(original.id);
    expect(restored!.planning.idea).toBe('an idea');
    expect(restored!.planning.surface).toBe('cockpit');
    expect(restored!.planning.product).toBe('assay');
  });

  it('restorePlanningSessions returns silently on a missing file (no throw)', () => {
    // Use a path that doesn't exist.
    mockConfig.PLANNING_SESSIONS_FILE = join(tmpDir, 'no-such-file.json');
    expect(() => restorePlanningSessions()).not.toThrow();
  });
});

describe('getAllPlanningSessions', () => {
  it('returns every session keyed by chatId', () => {
    createPlanningSession(1, 'idea-a', 'chat', 'aura');
    createPlanningSession(2, 'idea-b', 'chat', 'assay');
    const all = getAllPlanningSessions();
    const chatIds = all.map(([chatId]) => chatId);
    expect(chatIds).toContain(1);
    expect(chatIds).toContain(2);
  });
});
