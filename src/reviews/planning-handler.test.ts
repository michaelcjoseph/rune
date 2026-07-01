/**
 * Test suite for `src/reviews/planning-handler.ts` — the per-turn
 * orchestration that drives one round of the `/plan` scoping conversation.
 * Mutates the store from A4.1.
 *
 * The scoping primitive (`scopingTurn`) is injectable: tests mock it with
 * deterministic return values; production wires `defaultScopingTurn` to the
 * PM role and parses either a one-question-at-a-time interview turn or a
 * fenced pm-spec approval artifact.
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

const { mockConfig, mockAskClaudeWithContext, mockCleanupSession, mockComposeRoleContext } = vi.hoisted(() => ({
  mockConfig: {
    PLANNING_SESSIONS_FILE: '/test/planning-sessions.json',
    PLANNING_ARTIFACTS_DIR: '/test/planning-artifacts',
  },
  mockAskClaudeWithContext: vi.fn(),
  mockCleanupSession: vi.fn(),
  mockComposeRoleContext: vi.fn(),
}));
vi.mock('../config.js', () => ({ default: mockConfig }));
vi.mock('../ai/claude.js', () => ({
  askClaudeWithContext: mockAskClaudeWithContext,
  cleanupSession: mockCleanupSession,
}));
vi.mock('../roles/loader.js', () => ({
  composeRoleContext: mockComposeRoleContext,
}));

// --- Imports under test ---

import {
  createPlanningSession,
  deletePlanningSession,
  getPlanningSession,
  restorePlanningSessions,
} from './planning.js';
import {
  defaultScopingTurn,
  handlePlanningTurn,
  type ScopingTurn,
} from './planning-handler.js';
import type { SpecArtifact } from '../intent/planner.js';

type PmSpecApprovalArtifact = {
  version: 2;
  kind: 'pm-spec';
  product: string;
  title: string;
  spec: string;
  assumptions?: string[];
  selfReview?: string | { revised: boolean };
};

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'rune-planning-handler-test-'));
  mockConfig.PLANNING_SESSIONS_FILE = join(tmpDir, 'planning-sessions.json');
  mockConfig.PLANNING_ARTIFACTS_DIR = join(tmpDir, 'planning-artifacts');
  vi.clearAllMocks();
  mockComposeRoleContext.mockReturnValue({
    systemInstructions: 'PM ROLE SYSTEM PROMPT',
    referenceContext: '<pm-memory>reference only</pm-memory>',
  });
  restorePlanningSessions();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

const SAMPLE_ARTIFACT = {
  version: 2,
  kind: 'pm-spec',
  product: 'aura',
  title: 'Test project',
  spec: 'The spec body.',
  assumptions: ['Assume Telegram first.'],
  selfReview: 'Confirmed the scope is internally consistent.',
} satisfies PmSpecApprovalArtifact;

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
  it('records the PM-only approval artifact via proposeSpec and transitions to spec-proposed', async () => {
    createPlanningSession(2, 'idea', 'chat', 'aura');
    const scopingTurn: ScopingTurn = vi.fn(async () => ({
      kind: 'spec' as const,
      text: 'Here is the proposed spec — please approve.',
      artifact: SAMPLE_ARTIFACT as unknown as SpecArtifact,
    }));
    const runRoles = vi.fn();

    const result = await handlePlanningTurn({ scopingTurn, runRoles }, 2, 'go for it');
    expect(result.reply).toBe('Here is the proposed spec — please approve.');
    expect(result.status).toBe('spec-proposed');
    expect(runRoles).not.toHaveBeenCalled();

    const stored = getPlanningSession(2)!;
    expect(stored.planning.status).toBe('spec-proposed');
    expect(stored.planning.artifact).toEqual(SAMPLE_ARTIFACT);
    expect(stored.planning.artifact).toMatchObject({
      version: 2,
      kind: 'pm-spec',
      product: 'aura',
      title: 'Test project',
      assumptions: ['Assume Telegram first.'],
      selfReview: 'Confirmed the scope is internally consistent.',
    });
  });

  it('refuses to overwrite an existing PM spec on a second spec-ready turn', async () => {
    // After spec-proposed, the conversation is awaiting approval — another
    // spec-ready signal shouldn't transition again (the planner state
    // machine in intent/planner.ts already throws; handler surfaces it).
    createPlanningSession(3, 'idea', 'chat', 'aura');
    const turn1: ScopingTurn = vi.fn(async () => ({
      kind: 'spec' as const, text: 'first', artifact: SAMPLE_ARTIFACT as unknown as SpecArtifact,
    }));
    await handlePlanningTurn({ scopingTurn: turn1 }, 3, 'msg');

    const turn2: ScopingTurn = vi.fn(async () => ({
      kind: 'spec' as const, text: 'second', artifact: SAMPLE_ARTIFACT as unknown as SpecArtifact,
    }));
    await expect(
      handlePlanningTurn({ scopingTurn: turn2 }, 3, 'msg2'),
    ).rejects.toThrow(/proposeSpec|scoping/i);
  });

  it('rejects the retired ready/planning-brief handoff instead of running planner roles', async () => {
    createPlanningSession(7, 'idea', 'chat', 'aura');
    const scopingTurn = vi.fn(async () => ({
      kind: 'ready' as const,
      text: 'Handing off to the product team.',
      brief: 'retired planning brief',
    }));
    const runRoles = vi.fn(async () => ({
      kind: 'blocked-for-interview' as const,
      interviewNeeds: ['This retired gate must not be reachable.'],
    }));

    await expect(
      handlePlanningTurn(
        { scopingTurn: scopingTurn as unknown as ScopingTurn, runRoles },
        7,
        'go',
      ),
    ).rejects.toThrow(/ready|planning-brief|retired|pm-spec/i);
    expect(runRoles).not.toHaveBeenCalled();

    const stored = getPlanningSession(7)!;
    expect(stored.planning.status).toBe('scoping');
    expect(stored.planning.artifact).toBeUndefined();
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

describe('defaultScopingTurn — PM-led interview contract', () => {
  it('runs the turn as the PM role on the persistent planning session and asks one question at a time', async () => {
    const session = createPlanningSession(20, 'make product planning less lossy', 'chat', 'aura');
    mockAskClaudeWithContext.mockResolvedValue({
      text: 'What user-visible outcome should the first version prove?',
    });

    const result = await defaultScopingTurn({ session, userMessage: 'I want to improve /plan' });

    expect(result).toEqual({
      kind: 'question',
      text: 'What user-visible outcome should the first version prove?',
    });
    expect(mockComposeRoleContext).toHaveBeenCalledOnce();
    expect(mockComposeRoleContext).toHaveBeenCalledWith(
      'pm',
      expect.stringMatching(/one question/i),
    );

    const [, sessionId, systemPrompt, opts] = mockAskClaudeWithContext.mock.calls[0]!;
    expect(sessionId).toBe(session.claudeSessionId);
    expect(systemPrompt).toBe('PM ROLE SYSTEM PROMPT');
    expect(systemPrompt).not.toMatch(/You are the Planner|planning-brief/i);
    expect(opts).toMatchObject({ opLabel: 'chat', voice: true });
  });

  it('keeps multi-turn PM interview state on the planning session id', async () => {
    const session = createPlanningSession(25, 'make product planning less lossy', 'chat', 'aura');
    mockAskClaudeWithContext
      .mockResolvedValueOnce({ text: 'What user-visible outcome should the first version prove?' })
      .mockResolvedValueOnce({ text: 'What should be explicitly out of scope?' });

    await defaultScopingTurn({ session, userMessage: 'I want to improve /plan' });
    await defaultScopingTurn({ session, userMessage: 'Telegram first, no webview yet' });

    expect(mockAskClaudeWithContext).toHaveBeenCalledTimes(2);
    expect(mockAskClaudeWithContext.mock.calls[0]?.[1]).toBe(session.claudeSessionId);
    expect(mockAskClaudeWithContext.mock.calls[1]?.[1]).toBe(session.claudeSessionId);
  });

  it('instructs the PM to stop on satisfaction or proceed intent and emit a pm-spec fence, not a planning-brief', async () => {
    const session = createPlanningSession(21, 'scope an idea', 'chat', 'aura');
    mockAskClaudeWithContext.mockResolvedValue({ text: 'What is the first user-visible slice?' });

    await defaultScopingTurn({ session, userMessage: "let's go" });

    expect(mockComposeRoleContext).toHaveBeenCalledOnce();
    const [, baseInstructions] = mockComposeRoleContext.mock.calls[0]!;
    expect(baseInstructions).toMatch(/PM|product manager/i);
    expect(baseInstructions).toMatch(/satisfied|enough context/i);
    expect(baseInstructions).toMatch(/intent[- ]detect|detect.*intent/i);
    expect(baseInstructions).toMatch(/go|proceed|ship it|done/i);
    expect(baseInstructions).toMatch(/not.*literal|not.*exact|not.*===\s*['"]go['"]/i);
    expect(baseInstructions).toMatch(/```pm-spec/i);
    expect(baseInstructions).not.toMatch(/```planning-brief|Planner/i);
  });

  it('parses a completed PM spec as a versioned PM-only ScopingResult', async () => {
    const session = createPlanningSession(22, 'scope an idea', 'chat', 'aura');
    mockAskClaudeWithContext.mockResolvedValue({
      text: [
        'I have enough for approval.',
        '```pm-spec',
        JSON.stringify({
          version: 2,
          kind: 'pm-spec',
          product: 'aura',
          title: 'PM-led planning',
          spec: 'The PM conducts the interview and presents one approval artifact.',
          assumptions: ['Approval happens before downstream tech planning.'],
          selfReview: 'Fixed an ambiguity about the approval boundary.',
        }),
        '```',
      ].join('\n'),
    });

    const result = await defaultScopingTurn({ session, userMessage: 'ship it' });

    expect(result.kind).toBe('spec');
    if (result.kind !== 'spec') throw new Error('expected spec result');
    expect(result.text).toBe('I have enough for approval.');
    expect(result.artifact).toMatchObject({
      version: 2,
      kind: 'pm-spec',
      product: 'aura',
      title: 'PM-led planning',
      spec: 'The PM conducts the interview and presents one approval artifact.',
      assumptions: ['Approval happens before downstream tech planning.'],
      selfReview: 'Fixed an ambiguity about the approval boundary.',
    });
    expect(result.artifact).not.toHaveProperty('tasks');
    expect(result.artifact).not.toHaveProperty('testPlan');
  });

  it('rejects the retired planning-brief ready handoff instead of returning a ready result', async () => {
    const session = createPlanningSession(23, 'scope an idea', 'chat', 'aura');
    mockAskClaudeWithContext.mockResolvedValue({
      text: ['I have enough to hand this to the product team.', '```planning-brief', 'Brief text.', '```'].join('\n'),
    });

    await expect(defaultScopingTurn({ session, userMessage: 'go' })).rejects.toThrow(
      /planning-brief|pm-spec|retired/i,
    );
  });

  it('surfaces a clear planning failure for a malformed pm-spec fence', async () => {
    const session = createPlanningSession(24, 'scope an idea', 'chat', 'aura');
    mockAskClaudeWithContext.mockResolvedValue({
      text: ['Spec ready.', '```pm-spec', '{ "version": 2, "kind": "pm-spec",', '```'].join('\n'),
    });

    await expect(defaultScopingTurn({ session, userMessage: 'proceed' })).rejects.toThrow(
      /pm-spec|malformed|planning/i,
    );
  });

  it('surfaces a clear planning failure when a completed spec omits the pm-spec fence', async () => {
    const session = createPlanningSession(26, 'scope an idea', 'chat', 'aura');
    mockAskClaudeWithContext.mockResolvedValue({
      text: 'Spec ready for approval: build a PM-led planning flow.',
    });

    await expect(defaultScopingTurn({ session, userMessage: 'done' })).rejects.toThrow(
      /pm-spec|fence|planning/i,
    );
  });
});
