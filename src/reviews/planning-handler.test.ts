/**
 * Test suite for `src/reviews/planning-handler.ts` — the per-turn
 * orchestration that drives one round of the Planner's Socratic
 * conversation (Phase 6 A4.2). Mutates the store from A4.1.
 *
 * The scoping primitive (`scopingTurn`) is injectable: tests mock it
 * with deterministic return values; production wires `askClaudeWithContext`
 * with a system prompt that guides Claude to either ask a question or
 * emit a fenced spec-artifact JSON.
 *
 * Written test-first.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// --- Mocks ---

vi.mock('../utils/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const { mockConfig, mockCleanupSession } = vi.hoisted(() => ({
  mockConfig: {
    PLANNING_SESSIONS_FILE: '/test/planning-sessions.json',
    PLANNING_ARTIFACTS_DIR: '/test/planning-artifacts',
  },
  mockCleanupSession: vi.fn(),
}));
vi.mock('../config.js', () => ({ default: mockConfig }));
vi.mock('../ai/claude.js', () => ({
  cleanupSession: mockCleanupSession,
}));

// --- Imports under test ---

import {
  createPlanningSession,
  deletePlanningSession,
  getPlanningSession,
  restorePlanningSessions,
} from './planning.js';
import { handlePlanningTurn, type ScopingTurn } from './planning-handler.js';
import type { SpecArtifact } from '../intent/planner.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'jarvis-planning-handler-test-'));
  mockConfig.PLANNING_SESSIONS_FILE = join(tmpDir, 'planning-sessions.json');
  mockConfig.PLANNING_ARTIFACTS_DIR = join(tmpDir, 'planning-artifacts');
  restorePlanningSessions();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

const SAMPLE_ARTIFACT: SpecArtifact = {
  product: 'aura',
  title: 'Test project',
  spec: 'The spec body.',
  tasks: '## Phase 1\n- [ ] task',
  testPlan: '## §1\n- [ ] test',
};

describe('handlePlanningTurn — scoping turn (LLM asks a question)', () => {
  it('returns the LLM question and keeps status scoping', async () => {
    createPlanningSession(1, 'fuzzy idea', 'chat', 'aura');
    const scopingTurn: ScopingTurn = vi.fn(async () => ({
      kind: 'question' as const,
      text: 'What user problem does this solve?',
    }));

    const result = await handlePlanningTurn({ scopingTurn }, 1, 'help me plan');
    expect(result.reply).toBe('What user problem does this solve?');
    expect(result.status).toBe('scoping');

    const stored = getPlanningSession(1)!;
    expect(stored.planning.status).toBe('scoping');
    expect(stored.planning.artifact).toBeUndefined();
  });

  it('passes the user message and current state to scopingTurn', async () => {
    createPlanningSession(1, 'fuzzy idea', 'chat', 'aura');
    const scopingTurn = vi.fn<ScopingTurn>(async () => ({
      kind: 'question',
      text: 'next question',
    }));

    await handlePlanningTurn({ scopingTurn }, 1, 'my answer');

    expect(scopingTurn).toHaveBeenCalledOnce();
    const [arg] = scopingTurn.mock.calls[0]!;
    expect(arg.userMessage).toBe('my answer');
    expect(arg.session.chatId).toBe(1);
    expect(arg.session.planning.idea).toBe('fuzzy idea');
  });
});

describe('handlePlanningTurn — spec-ready turn (LLM emits an artifact)', () => {
  it('records the artifact via proposeSpec and transitions to spec-proposed', async () => {
    createPlanningSession(2, 'idea', 'chat', 'aura');
    const scopingTurn: ScopingTurn = vi.fn(async () => ({
      kind: 'spec' as const,
      text: 'Here is the proposed spec — please approve.',
      artifact: SAMPLE_ARTIFACT,
    }));

    const result = await handlePlanningTurn({ scopingTurn }, 2, 'go for it');
    expect(result.reply).toBe('Here is the proposed spec — please approve.');
    expect(result.status).toBe('spec-proposed');

    const stored = getPlanningSession(2)!;
    expect(stored.planning.status).toBe('spec-proposed');
    expect(stored.planning.artifact).toEqual(SAMPLE_ARTIFACT);
  });

  it('refuses to overwrite an existing artifact on a second spec-ready turn', async () => {
    // After spec-proposed, the conversation is awaiting approval — another
    // spec-ready signal shouldn't transition again (the planner state
    // machine in intent/planner.ts already throws; handler surfaces it).
    createPlanningSession(3, 'idea', 'chat', 'aura');
    const turn1: ScopingTurn = vi.fn(async () => ({
      kind: 'spec' as const, text: 'first', artifact: SAMPLE_ARTIFACT,
    }));
    await handlePlanningTurn({ scopingTurn: turn1 }, 3, 'msg');

    const turn2: ScopingTurn = vi.fn(async () => ({
      kind: 'spec' as const, text: 'second', artifact: SAMPLE_ARTIFACT,
    }));
    await expect(
      handlePlanningTurn({ scopingTurn: turn2 }, 3, 'msg2'),
    ).rejects.toThrow(/proposeSpec|scoping/i);
  });
});

describe('handlePlanningTurn — error paths', () => {
  it('throws when no active planning session exists for the chatId', async () => {
    const scopingTurn: ScopingTurn = vi.fn();
    await expect(
      handlePlanningTurn({ scopingTurn }, 999, 'hi'),
    ).rejects.toThrow(/no.*active|session/i);
    expect(scopingTurn).not.toHaveBeenCalled();
  });

  it('throws when the session has already been approved', async () => {
    createPlanningSession(4, 'idea', 'chat', 'aura');
    // Force the session into approved state via the store.
    const { updatePlanningSession } = await import('./planning.js');
    updatePlanningSession(4, (sess) => ({
      ...sess,
      planning: { ...sess.planning, status: 'approved' as const },
    }));
    const scopingTurn: ScopingTurn = vi.fn();
    await expect(
      handlePlanningTurn({ scopingTurn }, 4, 'hi'),
    ).rejects.toThrow(/no.*active|approved|session/i);
    expect(scopingTurn).not.toHaveBeenCalled();
  });

  it('throws when the session has been abandoned', async () => {
    createPlanningSession(5, 'idea', 'chat', 'aura');
    deletePlanningSession(5);
    const scopingTurn: ScopingTurn = vi.fn();
    await expect(
      handlePlanningTurn({ scopingTurn }, 5, 'hi'),
    ).rejects.toThrow(/no.*active|session/i);
  });

  it('propagates scopingTurn errors with a clear message', async () => {
    createPlanningSession(6, 'idea', 'chat', 'aura');
    const scopingTurn: ScopingTurn = vi.fn(async () => {
      throw new Error('LLM unreachable');
    });
    await expect(
      handlePlanningTurn({ scopingTurn }, 6, 'msg'),
    ).rejects.toThrow(/LLM unreachable/);
  });
});
