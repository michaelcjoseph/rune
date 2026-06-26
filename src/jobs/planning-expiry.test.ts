/**
 * Test suite for `src/jobs/planning-expiry.ts` — the periodic TTL check that
 * scans persisted StoredPlanningSessions for entries whose `lastActivity` has
 * gone past the inactivity threshold and returns the chatIds that should be
 * expired.
 *
 * Written test-first (A4.5); the implementation file does not exist yet —
 * every test must fail with a missing-module / missing-export error until the
 * module is created.
 *
 * The suite tests the pure `findExpiredPlanningSessions` core only; the
 * setInterval runner glue is not tested here (mirrors stall-check.test.ts
 * pattern).
 */

import { describe, it, expect, vi } from 'vitest';
import type { StoredPlanningSession } from '../reviews/planning.js';

vi.mock('../utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  }),
}));

import {
  findExpiredPlanningSessions,
  PLANNING_EXPIRY_TTL_MS,
  PLANNING_EXPIRY_TICK_INTERVAL_MS,
} from './planning-expiry.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeSession(chatId: number, lastActivityIso: string): StoredPlanningSession {
  return {
    id: `sess-${chatId}`,
    chatId,
    claudeSessionId: `claude-${chatId}`,
    planning: { status: 'scoping' as const, product: 'rune', idea: '', surface: 'chat' as const },
    createdAt: '2026-01-01T00:00:00.000Z',
    lastActivity: lastActivityIso,
  };
}

const NOW = 2_000_000_000_000; // fixed epoch ms used across tests

/** ISO string that is `ageMs` old relative to NOW. */
function activityAge(ageMs: number): string {
  return new Date(NOW - ageMs).toISOString();
}

const FRESH = activityAge(PLANNING_EXPIRY_TTL_MS - 1); // 1 ms before expiry
const STALE = activityAge(PLANNING_EXPIRY_TTL_MS + 1); // 1 ms past expiry

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('findExpiredPlanningSessions', () => {
  it('1: returns [] when the session store is empty', () => {
    const result = findExpiredPlanningSessions({
      readSessions: () => [],
      now: NOW,
      ttlMs: PLANNING_EXPIRY_TTL_MS,
    });
    expect(result).toEqual([]);
  });

  it('2: returns [] when all sessions are within the TTL (fresh)', () => {
    const result = findExpiredPlanningSessions({
      readSessions: () => [
        [101, makeSession(101, activityAge(60_000))],        // 1 min old
        [102, makeSession(102, activityAge(24 * 60 * 60_000))], // 1 day old
      ],
      now: NOW,
      ttlMs: PLANNING_EXPIRY_TTL_MS,
    });
    expect(result).toEqual([]);
  });

  it('3: returns all chatIds when all sessions are past the TTL (stale)', () => {
    const result = findExpiredPlanningSessions({
      readSessions: () => [
        [201, makeSession(201, activityAge(8 * 24 * 60 * 60_000))],  // 8 days
        [202, makeSession(202, activityAge(30 * 24 * 60 * 60_000))], // 30 days
      ],
      now: NOW,
      ttlMs: PLANNING_EXPIRY_TTL_MS,
    });
    expect(result).toContain(201);
    expect(result).toContain(202);
    expect(result).toHaveLength(2);
  });

  it('4: mixed — only returns chatIds of stale sessions, filters out fresh ones', () => {
    const result = findExpiredPlanningSessions({
      readSessions: () => [
        [301, makeSession(301, STALE)],   // expired
        [302, makeSession(302, FRESH)],   // fresh
        [303, makeSession(303, STALE)],   // expired
        [304, makeSession(304, activityAge(60_000))], // very fresh
      ],
      now: NOW,
      ttlMs: PLANNING_EXPIRY_TTL_MS,
    });
    expect(result).toContain(301);
    expect(result).toContain(303);
    expect(result).not.toContain(302);
    expect(result).not.toContain(304);
    expect(result).toHaveLength(2);
  });

  it('5a: boundary — lastActivity exactly at (now - ttlMs) is NOT expired', () => {
    const exactThreshold = new Date(NOW - PLANNING_EXPIRY_TTL_MS).toISOString();
    const result = findExpiredPlanningSessions({
      readSessions: () => [[401, makeSession(401, exactThreshold)]],
      now: NOW,
      ttlMs: PLANNING_EXPIRY_TTL_MS,
    });
    expect(result).not.toContain(401);
    expect(result).toHaveLength(0);
  });

  it('5b: boundary — lastActivity 1 ms older than threshold IS expired', () => {
    const oneOverThreshold = new Date(NOW - PLANNING_EXPIRY_TTL_MS - 1).toISOString();
    const result = findExpiredPlanningSessions({
      readSessions: () => [[402, makeSession(402, oneOverThreshold)]],
      now: NOW,
      ttlMs: PLANNING_EXPIRY_TTL_MS,
    });
    expect(result).toContain(402);
    expect(result).toHaveLength(1);
  });

  it('6: corrupt lastActivity — invalid ISO string is treated as expired (fail toward cleanup)', () => {
    const corrupt = makeSession(501, 'not-a-valid-date');
    const result = findExpiredPlanningSessions({
      readSessions: () => [[501, corrupt]],
      now: NOW,
      ttlMs: PLANNING_EXPIRY_TTL_MS,
    });
    expect(result).toContain(501);
  });

  it('6b: missing lastActivity — undefined/empty is treated as expired', () => {
    const noActivity = {
      ...makeSession(502, ''),
      lastActivity: undefined as unknown as string,
    };
    const result = findExpiredPlanningSessions({
      readSessions: () => [[502, noActivity]],
      now: NOW,
      ttlMs: PLANNING_EXPIRY_TTL_MS,
    });
    expect(result).toContain(502);
  });

  it('7: readSessions throws — does not propagate; returns [] (runner must not crash)', () => {
    // Single assertion that both proves no-throw and pins the return value;
    // toEqual on a synchronous call inherently verifies non-throw.
    const result = findExpiredPlanningSessions({
      readSessions: () => {
        throw new Error('disk read failed');
      },
      now: NOW,
      ttlMs: PLANNING_EXPIRY_TTL_MS,
    });
    expect(result).toEqual([]);
  });

  it('8: status-agnostic — sessions in any status are subject to expiry', () => {
    const statuses = ['scoping', 'spec-proposed', 'approved', 'abandoned'] as const;
    const sessions: Array<[number, StoredPlanningSession]> = statuses.map((status, i) => {
      const chatId = 600 + i;
      const sess: StoredPlanningSession = {
        ...makeSession(chatId, STALE),
        planning: {
          status,
          product: 'rune',
          idea: '',
          surface: 'chat' as const,
        },
      };
      return [chatId, sess];
    });

    const result = findExpiredPlanningSessions({
      readSessions: () => sessions,
      now: NOW,
      ttlMs: PLANNING_EXPIRY_TTL_MS,
    });

    // All four chatIds must appear — no status is exempted
    for (const [chatId] of sessions) {
      expect(result).toContain(chatId);
    }
    expect(result).toHaveLength(4);
  });

  it('9: multiple expired — chatIds returned in input order (stable, deterministic)', () => {
    const result = findExpiredPlanningSessions({
      readSessions: () => [
        [701, makeSession(701, STALE)],
        [702, makeSession(702, STALE)],
        [703, makeSession(703, STALE)],
      ],
      now: NOW,
      ttlMs: PLANNING_EXPIRY_TTL_MS,
    });
    expect(result).toEqual([701, 702, 703]);
  });

  it('10a: PLANNING_EXPIRY_TTL_MS equals 7 days in milliseconds (604800000)', () => {
    expect(PLANNING_EXPIRY_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it('10b: PLANNING_EXPIRY_TICK_INTERVAL_MS equals 1 hour in milliseconds (3600000)', () => {
    expect(PLANNING_EXPIRY_TICK_INTERVAL_MS).toBe(60 * 60 * 1000);
  });
});
