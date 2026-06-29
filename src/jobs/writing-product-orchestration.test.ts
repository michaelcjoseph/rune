import { describe, expect, it } from 'vitest';

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

async function requireWritingOrchestration(): Promise<{
  planWritingProductRun: (input: { topic: string }) => WritingRunPlan;
}> {
  const specifier = './writing-product-orchestration' + '.js';
  try {
    const mod = await import(/* @vite-ignore */ specifier) as Record<string, unknown>;
    if (typeof mod.planWritingProductRun === 'function') {
      return {
        planWritingProductRun: mod.planWritingProductRun as (input: { topic: string }) => WritingRunPlan,
      };
    }
  } catch {
    // Fall through to a clean assertion failure below.
  }
  expect.fail(
    'src/jobs/writing-product-orchestration.ts must export planWritingProductRun before implementation can pass',
  );
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
});
