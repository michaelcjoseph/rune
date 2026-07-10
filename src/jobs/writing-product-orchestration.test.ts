import { describe, expect, it, vi } from 'vitest';

type WritingRunPlan = {
  product: string;
  topic: string;
  slug: string;
  branch: string;
  routePaths: string[];
  workRunPayload: {
    product: string;
    projectSlug: string;
    target?: { kind: string; slug: string };
  };
  surfaceStates: string[];
};

type StartedWritingRun = WritingRunPlan & {
  branchStatus: 'created' | 'resumed';
  publish: {
    mode: 'branch-commit';
    externalDeployment: false;
    commitSha: string;
  };
};

type WritingStartDeps = {
  createWritingWorktree: (input: {
    product: 'writing';
    project: string;
    branch: string;
  }) => Promise<{ worktree: string; resumed?: boolean }>;
  runWritingPipeline: (input: {
    topic: string;
    requestedBy: 'blog' | 'writing-critique';
    branch: string;
    worktree: string;
  }) => Promise<{
    state: string;
    committed?: boolean;
    commitSha?: string;
    branch: string;
  }>;
  deployExternal: (input: { branch: string; routePath: string }) => Promise<void>;
};

async function requireWritingOrchestration(): Promise<{
  planWritingProductRun: (input: { topic: string }) => WritingRunPlan;
  startWritingProductRun: (
    input:
      | { command: 'blog'; chatId: number; topic: string }
      | {
        command: 'writing-critique';
        chatId: number;
        target: string;
        outputPath: string;
        revisionRequested?: boolean;
      },
    deps: WritingStartDeps,
  ) => Promise<StartedWritingRun>;
}> {
  const specifier = './writing-product-orchestration' + '.js';
  try {
    const mod = await import(/* @vite-ignore */ specifier) as Record<string, unknown>;
    if (typeof mod.planWritingProductRun === 'function' && typeof mod.startWritingProductRun === 'function') {
      return {
        planWritingProductRun: mod.planWritingProductRun as (input: { topic: string }) => WritingRunPlan,
        startWritingProductRun: mod.startWritingProductRun as (
          input:
            | { command: 'blog'; chatId: number; topic: string }
            | {
              command: 'writing-critique';
              chatId: number;
              target: string;
              outputPath: string;
              revisionRequested?: boolean;
            },
          deps: WritingStartDeps,
        ) => Promise<StartedWritingRun>,
      };
    }
  } catch {
    // Fall through to a clean assertion failure below.
  }
  expect.fail(
    'src/jobs/writing-product-orchestration.ts must export planWritingProductRun and startWritingProductRun before implementation can pass',
  );
}

function makeStartDeps(overrides: Partial<WritingStartDeps> = {}) {
  const deps: WritingStartDeps = {
    createWritingWorktree: vi.fn(async () => ({
      worktree: '/tmp/rune-writing-operating-from-memory',
      resumed: false,
    })),
    runWritingPipeline: vi.fn(async (input) => ({
      state: 'committed',
      committed: true,
      commitSha: 'abc1234',
      branch: input.branch,
    })),
    deployExternal: vi.fn(async () => {
      throw new Error('V1 writing publish must not deploy externally');
    }),
    ...overrides,
  };
  return deps;
}

describe('writing-product-orchestration (project 19 Phase 6)', () => {
  it('plans a writing-product work run that publishes /rune and /rune/{topic} on a rune-writing branch', async () => {
    const { planWritingProductRun } = await requireWritingOrchestration();

    const plan = planWritingProductRun({ topic: 'Operating from memory' });

    expect(plan).toMatchObject({
      product: 'writing',
      topic: 'Operating from memory',
      slug: 'operating-from-memory',
      branch: 'rune-writing/operating-from-memory',
      workRunPayload: {
        product: 'writing',
        projectSlug: 'operating-from-memory',
        target: { kind: 'writing-page', slug: 'operating-from-memory' },
      },
    });
    expect(plan.branch).not.toMatch(/^rune-work\//);
    expect(plan.routePaths).toEqual(['/rune', '/rune/operating-from-memory']);
  });

  it('declares the writing surface states that draft/publish runs must expose', async () => {
    const { planWritingProductRun } = await requireWritingOrchestration();

    const plan = planWritingProductRun({ topic: 'Rune product OS' });

    expect(plan.surfaceStates).toEqual([
      'researching',
      'drafting',
      'critiquing',
      'revising',
      'ready-for-review',
      'committed',
      'failed',
    ]);
  });

  it('declares that only forward-looking ideas migrate into the writing repo', async () => {
    const { planWritingProductRun } = await requireWritingOrchestration();

    const plan = planWritingProductRun({ topic: 'Operating from memory' }) as WritingRunPlan & {
      migration?: unknown;
    };

    expect(plan.migration).toMatchObject({
      ideas: {
        sourceVaultPath: 'writing/topics.md',
        destinationRepoPath: 'docs/rune/writing-ideas.md',
      },
      voice: {
        sourceVaultPath: 'writing/voice.md',
        access: 'mcp',
      },
      historicalContent: {
        staysInPkms: true,
        migrates: false,
      },
    });
  });

  it('copies voice guidelines into the writing product and uses them as a required pipeline input', async () => {
    const { planWritingProductRun } = await requireWritingOrchestration();

    const plan = planWritingProductRun({ topic: 'Operating from memory' }) as WritingRunPlan & {
      migration?: {
        voice?: {
          sourceVaultPath?: string;
          destinationRepoPath?: string;
          access?: string;
          copiedIntoProduct?: boolean;
        };
      };
      pipelineInputs?: {
        voiceGuidelines?: {
          repoPath?: string;
          required?: boolean;
        };
      };
    };

    const voice = plan.migration?.voice;
    expect(voice).toMatchObject({
      sourceVaultPath: 'writing/voice.md',
      access: 'mcp',
      copiedIntoProduct: true,
    });
    expect(voice?.destinationRepoPath).toMatch(/^docs\/rune\/.*voice.*\.md$/);
    expect(plan.pipelineInputs?.voiceGuidelines).toMatchObject({
      repoPath: voice?.destinationRepoPath,
      required: true,
    });
  });

  it('requires writing work runs to read pkms source material only through MCP tools', async () => {
    const { planWritingProductRun } = await requireWritingOrchestration();

    const plan = planWritingProductRun({ topic: 'Operating from memory' }) as WritingRunPlan & {
      sourceAccess?: unknown;
    };

    expect(plan.sourceAccess).toMatchObject({
      pkms: {
        mode: 'mcp-only',
        disallowDirectVaultReads: true,
        requiredTools: expect.arrayContaining([
          'vault_search',
          'journal_range',
          'follow_wikilinks',
        ]),
      },
    });
    const serialized = JSON.stringify(plan);
    expect(serialized).not.toContain('VAULT_DIR');
    expect(serialized).not.toContain('readVaultFile');
    expect(serialized).not.toContain('writeVaultFile');
  });

  it('/blog starts a new deterministic rune-writing/{slug} branch when the topic branch does not exist', async () => {
    const { startWritingProductRun } = await requireWritingOrchestration();
    const deps = makeStartDeps({
      createWritingWorktree: vi.fn(async () => ({
        worktree: '/tmp/rune-writing-operating-from-memory',
        resumed: false,
      })),
    });

    const result = await startWritingProductRun({
      command: 'blog',
      chatId: 100,
      topic: 'Operating from memory',
    }, deps);

    expect(deps.createWritingWorktree).toHaveBeenCalledOnce();
    expect(deps.createWritingWorktree).toHaveBeenCalledWith(expect.objectContaining({
      product: 'writing',
      project: 'operating-from-memory',
      branch: 'rune-writing/operating-from-memory',
    }));
    expect(deps.runWritingPipeline).toHaveBeenCalledWith(expect.objectContaining({
      topic: 'Operating from memory',
      requestedBy: 'blog',
      branch: 'rune-writing/operating-from-memory',
      worktree: '/tmp/rune-writing-operating-from-memory',
    }));
    expect(result).toMatchObject({
      product: 'writing',
      slug: 'operating-from-memory',
      branch: 'rune-writing/operating-from-memory',
      branchStatus: 'created',
    });
  });

  it('/blog resumes the existing deterministic topic branch instead of creating a new branch name', async () => {
    const { startWritingProductRun } = await requireWritingOrchestration();
    const deps = makeStartDeps({
      createWritingWorktree: vi.fn(async () => ({
        worktree: '/tmp/rune-writing-operating-from-memory-resume',
        resumed: true,
      })),
    });

    const result = await startWritingProductRun({
      command: 'blog',
      chatId: 100,
      topic: 'Operating from memory',
    }, deps);

    expect(deps.createWritingWorktree).toHaveBeenCalledWith(expect.objectContaining({
      product: 'writing',
      project: 'operating-from-memory',
      branch: 'rune-writing/operating-from-memory',
    }));
    expect(deps.runWritingPipeline).toHaveBeenCalledWith(expect.objectContaining({
      branch: 'rune-writing/operating-from-memory',
      worktree: '/tmp/rune-writing-operating-from-memory-resume',
    }));
    expect(result).toMatchObject({
      branch: 'rune-writing/operating-from-memory',
      branchStatus: 'resumed',
    });
  });

  it('treats V1 publish as a commit on the writing branch and does not call external deployment', async () => {
    const { startWritingProductRun } = await requireWritingOrchestration();
    const deps = makeStartDeps();

    const result = await startWritingProductRun({
      command: 'blog',
      chatId: 100,
      topic: 'Operating from memory',
    }, deps);

    expect(deps.runWritingPipeline).toHaveBeenCalledWith(expect.objectContaining({
      branch: 'rune-writing/operating-from-memory',
    }));
    expect(deps.deployExternal).not.toHaveBeenCalled();
    expect(result.publish).toEqual({
      mode: 'branch-commit',
      externalDeployment: false,
      commitSha: 'abc1234',
    });
  });

  it('/writing-critique revision requests run on the same deterministic rune-writing/{slug} branch', async () => {
    const { startWritingProductRun } = await requireWritingOrchestration();
    const deps = makeStartDeps({
      createWritingWorktree: vi.fn(async () => ({
        worktree: '/tmp/rune-writing-operating-from-memory-resume',
        resumed: true,
      })),
    });

    const result = await startWritingProductRun({
      command: 'writing-critique',
      chatId: 100,
      target: 'docs/rune/Operating From Memory.md',
      outputPath: 'docs/rune/critiques/operating-from-memory.md',
      revisionRequested: true,
    }, deps);

    expect(deps.createWritingWorktree).toHaveBeenCalledWith(expect.objectContaining({
      product: 'writing',
      project: 'operating-from-memory',
      branch: 'rune-writing/operating-from-memory',
    }));
    expect(deps.runWritingPipeline).toHaveBeenCalledWith(expect.objectContaining({
      topic: 'docs/rune/Operating From Memory.md',
      requestedBy: 'writing-critique',
      branch: 'rune-writing/operating-from-memory',
      worktree: '/tmp/rune-writing-operating-from-memory-resume',
      critiqueOutputPath: 'docs/rune/critiques/operating-from-memory.md',
      revisionRequested: true,
    }));
    expect(result).toMatchObject({
      product: 'writing',
      slug: 'operating-from-memory',
      branch: 'rune-writing/operating-from-memory',
      branchStatus: 'resumed',
      publish: {
        mode: 'branch-commit',
        externalDeployment: false,
        commitSha: 'abc1234',
      },
    });
    expect(deps.deployExternal).not.toHaveBeenCalled();
  });
});
