/**
 * Phase 12 gate-time neutral validation regression.
 *
 * The production gate-learning binding must reuse Jarvis's neutral
 * `runPostMortem` attribution seam at gate time. A bespoke role prompt can
 * look equivalent, but it bypasses the post-mortem guard the spec names.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const candidateLesson =
    'When redaction tests guard a secret boundary, use a raw secret-shaped fixture and assert the raw value is absent.';
  const validatedLesson =
    'When testing redaction boundaries, use raw secret-shaped fixtures and assert raw-value absence plus redacted-shape presence.';
  return {
    candidateLesson,
    validatedLesson,
    runPostMortem: vi.fn(),
    writeGateLearningLesson: vi.fn(),
  };
});

vi.mock('../config.js', () => ({
  PROJECT_ROOT: '/test/project',
  default: {
    WORKSPACE_DIR: '/test/workspace',
    LOGS_DIR: '/test/logs',
  },
}));

vi.mock('../roles/loader.js', () => ({
  ROLE_NAMES: ['pm', 'tech-lead', 'qa', 'coder', 'reviewer', 'designer'],
  composeRoleContext: vi.fn((role: string, baseInstructions: string) => ({
    systemInstructions: [`SOUL ${role}`, baseInstructions].join('\n\n'),
    referenceContext: '',
  })),
}));

vi.mock('../intent/postmortem.js', () => ({
  runPostMortem: h.runPostMortem,
}));

vi.mock('../intent/learning-write-path.js', () => ({
  writeGateLearningLesson: h.writeGateLearningLesson,
}));

vi.mock('../ai/claude.js', () => ({
  CLAUDE_BIN: '/bin/claude',
  askClaudeWithContext: vi.fn(),
  cleanupSession: vi.fn(),
  getProjectMcpArgs: vi.fn(() => []),
  registerActiveProcess: vi.fn(),
  unregisterActiveProcess: vi.fn(),
}));

vi.mock('../ai/codex.js', () => ({
  runCodex: vi.fn(),
}));

vi.mock('../ai/tool-labels.js', () => ({
  scrubPathsInText: (text: string) => text,
}));

vi.mock('./execution-agent.js', () => ({
  runExecutionAgent: vi.fn(),
}));

import {
  buildProductionTeamTaskDeps,
  type JudgmentModelCall,
  type RoleModelBinding,
  type TeamRoleModels,
} from './team-task-deps.js';
import type { GateRejectionFeedback } from '../intent/team-task-workflow.js';
import type { SandboxSpec } from '../intent/sandbox.js';

const openai: RoleModelBinding = { alias: 'gpt-5.5', provider: 'openai', format: 'codex' };
const anthropic: RoleModelBinding = { alias: 'opus', provider: 'anthropic', format: 'claude' };

const models: TeamRoleModels = {
  pm: anthropic,
  techLead: anthropic,
  qa: openai,
  coder: openai,
  reviewer: anthropic,
  designer: anthropic,
};

function sandbox(): SandboxSpec {
  return {
    product: 'jarvis',
    project: 'demo',
    worktree: '/tmp/fake-worktree',
    egressAllowlist: [],
    resumed: false,
  } as SandboxSpec;
}

function rejection(overrides: Partial<GateRejectionFeedback> = {}): GateRejectionFeedback {
  return {
    rejectingRole: 'tech-lead',
    counterpartRole: 'qa',
    rejectedRole: 'qa',
    artifact: 'test-intent',
    rejectedArtifact: 'test-intent',
    reason: 'tests asserted the redacted placeholder instead of proving the raw token is absent',
    whatFailed: 'the test intent would pass even if raw secret-shaped input leaked',
    notes: ['Use a raw token-shaped fixture.'],
    actionableNotes: ['Assert raw token absence and redacted-shape presence.'],
    ...overrides,
  };
}

function draftOnlyJudgment(): JudgmentModelCall {
  return vi.fn(async ({ role, message }) => {
    if (role !== 'tech-lead' || !message.includes('<gate-rejection>')) {
      throw new Error('gate-time validation must run through runPostMortem, not a bespoke role prompt');
    }
    return [
      '```gate-lesson-candidate',
      JSON.stringify({
        kind: 'candidate-lesson',
        draftedBy: 'tech-lead',
        targetRole: 'qa',
        lesson: h.candidateLesson,
      }),
      '```',
    ].join('\n');
  });
}

describe('buildProductionTeamTaskDeps - gate-time runPostMortem validation', () => {
  beforeEach(() => {
    h.runPostMortem.mockReset();
    h.writeGateLearningLesson.mockReset();
  });

  it('validates the drafted lesson through runPostMortem before writing to counterpart memory', async () => {
    const record = rejection();
    h.runPostMortem.mockResolvedValueOnce({
      kind: 'lesson',
      stage: 'test',
      role: 'qa',
      lesson: h.validatedLesson,
    });
    h.writeGateLearningLesson.mockResolvedValueOnce({
      committed: true,
      captured: `- [2026-06-17 · source: demo-gate-test-intent] ${h.validatedLesson}`,
    });

    const deps = buildProductionTeamTaskDeps(
      { sandbox: sandbox(), productsConfigPath: '/nonexistent/products.json', models },
      { judgmentCall: draftOnlyJudgment() },
    );

    await deps.onGateRejection?.(record);

    expect(h.runPostMortem).toHaveBeenCalledTimes(1);
    expect(h.runPostMortem).toHaveBeenCalledWith(
      expect.objectContaining({
        projectSlug: 'demo',
        source: expect.stringContaining('gate'),
        issueSummary: expect.stringContaining(record.whatFailed),
        evidence: expect.stringContaining(h.candidateLesson),
      }),
      expect.anything(),
    );
    expect(h.writeGateLearningLesson).toHaveBeenCalledTimes(1);
    expect(h.writeGateLearningLesson).toHaveBeenCalledWith({
      role: 'qa',
      lesson: h.validatedLesson,
      projectSlug: 'demo',
      rejection: record,
    });
  });

  it('treats a runPostMortem no-lesson as terminal and never writes memory', async () => {
    h.runPostMortem.mockResolvedValueOnce({
      kind: 'no-lesson',
      rationale: 'candidate was too specific to this rejection',
    });

    const deps = buildProductionTeamTaskDeps(
      { sandbox: sandbox(), productsConfigPath: '/nonexistent/products.json', models },
      { judgmentCall: draftOnlyJudgment() },
    );

    await deps.onGateRejection?.(rejection());

    expect(h.runPostMortem).toHaveBeenCalledTimes(1);
    expect(h.writeGateLearningLesson).not.toHaveBeenCalled();
  });
});
