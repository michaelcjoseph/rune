import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { SizedTask } from '../intent/planning-roles.js';
import type { SandboxSpec } from '../intent/sandbox.js';
import type { OperationCancellation } from '../cancellation.js';
import type { RoleModelBinding, TeamRoleModels } from './team-task-deps.js';

const { mockAskClaudeWithContext, mockCleanupSession, mockRunCodex } = vi.hoisted(() => ({
  mockAskClaudeWithContext: vi.fn(),
  mockCleanupSession: vi.fn(),
  mockRunCodex: vi.fn(),
}));

vi.mock('../ai/claude.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../ai/claude.js')>(),
  askClaudeWithContext: mockAskClaudeWithContext,
  cleanupSession: mockCleanupSession,
}));

vi.mock('../ai/codex.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../ai/codex.js')>(),
  runCodex: mockRunCodex,
}));

const { buildProductionTeamTaskDeps } = await import('./team-task-deps.js');
const { RoleCancellationError } = await import('../intent/team-task-workflow.js');

const cancellation: OperationCancellation = {
  operationId: '12345678-1234-1234-1234-123456789abc',
  source: 'cockpit',
  requestedAt: '2026-07-13T12:34:56.000Z',
};

const claudeModel: RoleModelBinding = {
  alias: 'claude-test',
  provider: 'anthropic',
  format: 'claude',
};
const codexModel: RoleModelBinding = {
  alias: 'codex-test',
  provider: 'openai',
  format: 'codex',
};

const sandbox: SandboxSpec = {
  product: 'rune',
  project: 'demo',
  worktree: '/tmp/fake-worktree',
  egressAllowlist: [],
  resumed: false,
} as SandboxSpec;

const task: SizedTask = {
  id: 'demo-task',
  text: 'demo task',
  testStrategy: 'code-tests-required',
  designerNeeded: false,
  roles: ['qa', 'coder', 'reviewer', 'tech-lead'],
};

function models(overrides: Partial<TeamRoleModels> = {}): TeamRoleModels {
  return {
    pm: claudeModel,
    techLead: claudeModel,
    qa: codexModel,
    coder: codexModel,
    reviewer: claudeModel,
    designer: claudeModel,
    ...overrides,
  };
}

function deps(roleModels: TeamRoleModels) {
  return buildProductionTeamTaskDeps({
    sandbox,
    productsConfigPath: '/nonexistent/products.json',
    models: roleModels,
  });
}

beforeEach(() => {
  mockAskClaudeWithContext.mockReset();
  mockCleanupSession.mockReset();
  mockRunCodex.mockReset();
});

describe('production judgment cancellation conversion', () => {
  it('converts Claude tech-lead cancellation metadata into a typed role cancellation', async () => {
    mockAskClaudeWithContext.mockResolvedValue({
      text: null,
      error: 'Cancelled by user',
      cancellation,
    });

    const pending = deps(models()).techLeadReviewTests({
      task,
      qa: { kind: 'tests-written', testIds: ['src/demo.test.ts'] },
    });

    await expect(pending).rejects.toMatchObject({
      name: RoleCancellationError.name,
      cancellation: { role: 'tech-lead', ...cancellation },
    });
    expect(mockAskClaudeWithContext).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.any(String),
      expect.objectContaining({
        model: claudeModel.alias,
        opLabel: 'team:tech-lead',
        opKind: 'agent',
        agentName: 'tech-lead',
        product: 'rune',
      }),
    );
    expect(mockCleanupSession).toHaveBeenCalledOnce();
    expect(mockRunCodex).not.toHaveBeenCalled();
  });

  it('converts Codex reviewer cancellation metadata into a typed role cancellation', async () => {
    mockRunCodex.mockResolvedValue({
      text: null,
      error: 'Cancelled by user',
      cancellation,
    });

    const pending = deps(models({ reviewer: codexModel })).reviewer({
      diff: 'diff',
      spec: 'spec',
      tests: ['src/demo.test.ts'],
      task,
      context: 'context',
      reviewerProvider: 'openai',
    });

    await expect(pending).rejects.toMatchObject({
      name: RoleCancellationError.name,
      cancellation: { role: 'reviewer', ...cancellation },
    });
    expect(mockRunCodex).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        model: codexModel.alias,
        sandboxMode: 'read-only',
        opLabel: 'team:reviewer',
        opKind: 'agent',
        agentName: 'reviewer',
        product: 'rune',
      }),
    );
    expect(mockAskClaudeWithContext).not.toHaveBeenCalled();
    expect(mockCleanupSession).not.toHaveBeenCalled();
  });
});
