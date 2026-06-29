import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

const EXPECTED_STATES = [
  'researching',
  'drafting',
  'critiquing',
  'revising',
  'ready-for-review',
  'committed',
  'failed',
] as const;

type WritingPipelineState = typeof EXPECTED_STATES[number];

type WritingPipelineEvent = {
  state: WritingPipelineState;
  product: string;
  target: { kind: string; slug: string };
  branch: string;
};

type WritingPipelineResult = {
  product: string;
  slug: string;
  branch: string;
  routePath: string;
  state: WritingPipelineState;
  committed?: boolean;
  failed?: boolean;
};

type WritingPipelineDeps = {
  mcp: {
    callTool: (name: string, input: Record<string, unknown>) => Promise<unknown>;
  };
  model: {
    plan: (input: Record<string, unknown>) => Promise<{ outline: string }>;
    draft: (input: Record<string, unknown>) => Promise<{ markdown: string }>;
    critique: (input: Record<string, unknown>) => Promise<{ notes: string }>;
    revise: (input: Record<string, unknown>) => Promise<{ markdown: string }>;
  };
  writeArtifact: (path: string, content: string) => Promise<void>;
  commitArtifact: (input: { branch: string; paths: string[]; message: string }) => Promise<{ sha: string }>;
  emitRunState: (event: WritingPipelineEvent) => void;
  directPkms?: {
    readFile: (path: string) => Promise<string>;
    writeFile: (path: string, content: string) => Promise<void>;
  };
};

async function requireWritingPipeline(): Promise<{
  WRITING_PIPELINE_STATES: readonly WritingPipelineState[];
  runWritingPipeline: (
    input: { topic: string; requestedBy: 'blog' | 'writing-critique' },
    deps: WritingPipelineDeps,
  ) => Promise<WritingPipelineResult>;
}> {
  const specifier = './writing-pipeline' + '.js';
  try {
    const mod = await import(/* @vite-ignore */ specifier) as Record<string, unknown>;
    if (
      Array.isArray(mod.WRITING_PIPELINE_STATES) &&
      typeof mod.runWritingPipeline === 'function'
    ) {
      return {
        WRITING_PIPELINE_STATES: mod.WRITING_PIPELINE_STATES as readonly WritingPipelineState[],
        runWritingPipeline: mod.runWritingPipeline as (
          input: { topic: string; requestedBy: 'blog' | 'writing-critique' },
          deps: WritingPipelineDeps,
        ) => Promise<WritingPipelineResult>,
      };
    }
  } catch {
    // Fall through to a clean assertion failure below.
  }
  expect.fail(
    'src/jobs/writing-pipeline.ts must export WRITING_PIPELINE_STATES and runWritingPipeline for the writing-pipeline-core task',
  );
}

function makeDeps(overrides: Partial<WritingPipelineDeps> = {}) {
  const events: WritingPipelineEvent[] = [];
  const toolCalls: Array<{ name: string; input: Record<string, unknown> }> = [];
  const writes: Array<{ path: string; content: string }> = [];
  const commits: Array<{ branch: string; paths: string[]; message: string }> = [];

  const deps: WritingPipelineDeps = {
    mcp: {
      callTool: vi.fn(async (name: string, input: Record<string, unknown>) => {
        toolCalls.push({ name, input });
        if (name === 'vault_search') {
          return { results: [{ file: 'knowledge/writing.md', line: 3, content: 'public synthesis seed' }] };
        }
        if (name === 'journal_range') {
          return { entries: ['personal raw marker: ZZ_PRIVATE_MARKER_DO_NOT_PUBLISH'] };
        }
        if (name === 'follow_wikilinks') {
          return { pages: [{ file: 'knowledge/product-os.md', content: 'linked context' }] };
        }
        return {};
      }),
    },
    model: {
      plan: vi.fn(async () => ({ outline: '1. Claim\n2. Evidence\n3. Close' })),
      draft: vi.fn(async () => ({ markdown: '# Operating from memory\n\nDraft from synthesized context.' })),
      critique: vi.fn(async () => ({ notes: 'Make the thesis more concrete.' })),
      revise: vi.fn(async () => ({ markdown: '# Operating from memory\n\nRevised public artifact.' })),
    },
    writeArtifact: vi.fn(async (path: string, content: string) => {
      writes.push({ path, content });
    }),
    commitArtifact: vi.fn(async (input) => {
      commits.push(input);
      return { sha: 'abc1234' };
    }),
    emitRunState: vi.fn((event: WritingPipelineEvent) => {
      events.push(event);
    }),
    directPkms: {
      readFile: vi.fn(async (path: string) => {
        throw new Error(`direct pkms read is forbidden: ${path}`);
      }),
      writeFile: vi.fn(async (path: string) => {
        throw new Error(`direct pkms write is forbidden: ${path}`);
      }),
    },
    ...overrides,
  };

  return { deps, events, toolCalls, writes, commits };
}

describe('writing-pipeline-core', () => {
  it('declares the operations/runs states exactly as the writing product contract', async () => {
    const { WRITING_PIPELINE_STATES } = await requireWritingPipeline();

    expect(WRITING_PIPELINE_STATES).toEqual(EXPECTED_STATES);
  });

  it('runs the writer pipeline against product=writing, in branch/route scope for the topic, and surfaces every non-failure state in order', async () => {
    const { runWritingPipeline } = await requireWritingPipeline();
    const { deps, events, writes, commits } = makeDeps();

    const result = await runWritingPipeline(
      { topic: 'Operating from memory', requestedBy: 'blog' },
      deps,
    );

    expect(events.map((event) => event.state)).toEqual([
      'researching',
      'drafting',
      'critiquing',
      'revising',
      'ready-for-review',
      'committed',
    ]);
    expect(events.every((event) => event.product === 'writing')).toBe(true);
    expect(events.every((event) => event.target.kind === 'writing-page')).toBe(true);
    expect(events.every((event) => event.target.slug === 'operating-from-memory')).toBe(true);
    expect(events.every((event) => event.branch === 'rune-writing/operating-from-memory')).toBe(true);

    expect(writes).toEqual([
      expect.objectContaining({
        path: 'docs/rune/operating-from-memory.md',
        content: expect.stringContaining('Revised public artifact.'),
      }),
    ]);
    expect(commits).toEqual([
      expect.objectContaining({
        branch: 'rune-writing/operating-from-memory',
        paths: ['docs/rune/operating-from-memory.md'],
      }),
    ]);
    expect(result).toMatchObject({
      product: 'writing',
      slug: 'operating-from-memory',
      branch: 'rune-writing/operating-from-memory',
      routePath: '/rune/operating-from-memory',
      state: 'committed',
      committed: true,
    });
  });

  it('uses MCP tools as the only pkms read boundary and does not publish raw personal source markers', async () => {
    const { runWritingPipeline } = await requireWritingPipeline();
    const { deps, toolCalls, writes } = makeDeps();

    await runWritingPipeline(
      { topic: 'Operating from memory', requestedBy: 'blog' },
      deps,
    );

    expect(toolCalls.map((call) => call.name)).toEqual(expect.arrayContaining([
      'vault_search',
      'journal_range',
      'follow_wikilinks',
    ]));
    expect(deps.directPkms?.readFile).not.toHaveBeenCalled();
    expect(deps.directPkms?.writeFile).not.toHaveBeenCalled();
    expect(writes.map((write) => write.content).join('\n')).not.toContain('ZZ_PRIVATE_MARKER_DO_NOT_PUBLISH');
  });

  it('surfaces failed and does not commit when a pipeline stage throws', async () => {
    const { runWritingPipeline } = await requireWritingPipeline();
    const { deps, events, commits } = makeDeps({
      model: {
        plan: vi.fn(async () => ({ outline: 'outline' })),
        draft: vi.fn(async () => ({ markdown: 'draft' })),
        critique: vi.fn(async () => {
          throw new Error('critique model unavailable');
        }),
        revise: vi.fn(async () => ({ markdown: 'revision should not happen' })),
      },
    });

    const result = await runWritingPipeline(
      { topic: 'Operating from memory', requestedBy: 'blog' },
      deps,
    );

    expect(events.map((event) => event.state)).toEqual([
      'researching',
      'drafting',
      'critiquing',
      'failed',
    ]);
    expect(commits).toEqual([]);
    expect(result).toMatchObject({
      product: 'writing',
      slug: 'operating-from-memory',
      branch: 'rune-writing/operating-from-memory',
      routePath: '/rune/operating-from-memory',
      state: 'failed',
      failed: true,
    });
  });

  it('does not import direct vault/pkms file access in the pipeline module', () => {
    const sourcePath = 'src/jobs/writing-pipeline.ts';
    expect(existsSync(sourcePath), `${sourcePath} should exist`).toBe(true);

    const source = readFileSync(sourcePath, 'utf8');
    expect(source).not.toMatch(/from ['"]\.\.\/vault\/files\.js['"]/);
    expect(source).not.toContain('readVaultFile');
    expect(source).not.toContain('writeVaultFile');
    expect(source).not.toContain('appendVaultFile');
    expect(source).not.toContain('VAULT_DIR');
    expect(source).not.toMatch(/workspace\/pkms|~\/workspace\/pkms/);
  });
});
