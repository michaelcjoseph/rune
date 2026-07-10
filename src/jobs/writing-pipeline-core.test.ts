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
  readArtifact?: (path: string) => Promise<string>;
  directPkms?: {
    readFile: (path: string) => Promise<string>;
    writeFile: (path: string, content: string) => Promise<void>;
  };
};

type RunWritingPipelineInput = {
  topic: string;
  requestedBy: 'blog' | 'writing-critique';
  critique?: { slug: string; outputPath: string; revisionRequested: boolean };
};

async function requireWritingPipeline(): Promise<{
  WRITING_PIPELINE_STATES: readonly WritingPipelineState[];
  runWritingPipeline: (
    input: RunWritingPipelineInput,
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
          input: RunWritingPipelineInput,
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

const PLANTED_PRIVATE_MARKER = 'ZZ_PRIVATE_MARKER_DO_NOT_PUBLISH';
const RAW_JOURNAL_EXCERPT = 'raw journal excerpt: therapy sleep score was 47 after a private family call';
const PRIVATE_IDENTIFIER = 'PRIVATE_PERSON_ALPHA';
const PRIVATE_HEALTH_DETAIL = 'health-specific detail: recovery strain note 18.9';
const PRIVATE_PSYCHOLOGY_DETAIL = 'psychology-specific detail: attachment trigger inventory';
const PRIVATE_VAULT_IDENTIFIER = 'PRIVATE_VAULT_SOURCE_ALPHA';
const PRIVATE_WIKILINK_DETAIL = 'health-specific detail: wikilink recovery score 12';

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

  it('does not commit published writing that copies private research source material verbatim', async () => {
    const { runWritingPipeline } = await requireWritingPipeline();
    const { deps, writes, commits } = makeDeps({
      mcp: {
        callTool: vi.fn(async (name: string) => {
          if (name === 'vault_search') {
            return {
              results: [
                {
                  file: 'knowledge/private-writing-seed.md',
                  line: 7,
                  content: `private identifier: ${PRIVATE_VAULT_IDENTIFIER}`,
                },
              ],
            };
          }
          if (name === 'journal_range') {
            return {
              entries: [
                {
                  file: 'journals/2026_06_29.md',
                  content: [
                    `${PLANTED_PRIVATE_MARKER} planted in a private journal source`,
                    RAW_JOURNAL_EXCERPT,
                    `third-party personal name: ${PRIVATE_IDENTIFIER}`,
                    PRIVATE_HEALTH_DETAIL,
                    PRIVATE_PSYCHOLOGY_DETAIL,
                  ].join('\n'),
                },
              ],
            };
          }
          if (name === 'follow_wikilinks') {
            return {
              results: [
                {
                  targetFile: 'pages/psychology.md',
                  content: PRIVATE_WIKILINK_DETAIL,
                },
              ],
            };
          }
          return { results: [] };
        }),
      },
      model: {
        plan: vi.fn(async () => ({ outline: 'Synthesize the private source into a public argument.' })),
        draft: vi.fn(async () => ({ markdown: '# Operating from memory\n\nDraft.' })),
        critique: vi.fn(async () => ({ notes: 'Remove private source material before publishing.' })),
        revise: vi.fn(async () => ({
          markdown: [
            '# Operating from memory',
            '',
            'A public synthesized paragraph.',
            PLANTED_PRIVATE_MARKER,
            RAW_JOURNAL_EXCERPT,
            `I spoke with ${PRIVATE_IDENTIFIER} about this.`,
            PRIVATE_HEALTH_DETAIL,
            PRIVATE_PSYCHOLOGY_DETAIL,
            `private identifier: ${PRIVATE_VAULT_IDENTIFIER}`,
            PRIVATE_WIKILINK_DETAIL,
          ].join('\n'),
        })),
      },
    });

    const result = await runWritingPipeline(
      { topic: 'Operating from memory', requestedBy: 'blog' },
      deps,
    );

    expect(result).toMatchObject({ state: 'committed', committed: true });
    expect(commits).toEqual([
      expect.objectContaining({
        branch: 'rune-writing/operating-from-memory',
        paths: ['docs/rune/operating-from-memory.md'],
      }),
    ]);

    const committedArtifact = writes
      .filter((write) => commits[0]?.paths.includes(write.path))
      .map((write) => write.content)
      .join('\n');
    expect(committedArtifact).not.toContain(PLANTED_PRIVATE_MARKER);
    expect(committedArtifact).not.toContain(RAW_JOURNAL_EXCERPT);
    expect(committedArtifact).not.toContain(PRIVATE_IDENTIFIER);
    expect(committedArtifact).not.toContain(PRIVATE_HEALTH_DETAIL);
    expect(committedArtifact).not.toContain(PRIVATE_PSYCHOLOGY_DETAIL);
    expect(committedArtifact).not.toContain(PRIVATE_VAULT_IDENTIFIER);
    expect(committedArtifact).not.toContain(PRIVATE_WIKILINK_DETAIL);
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

  it('critique mode: critiques the EXISTING artifact under the pre-derived slug and commits only the critique file', async () => {
    const { runWritingPipeline } = await requireWritingPipeline();
    const existingArtifact = '# Operating from memory\n\nThe committed draft under review.';
    const readArtifact = vi.fn(async () => existingArtifact);
    const { deps, events, writes, commits } = makeDeps({ readArtifact });

    // The raw critique target is path-shaped — slugifying it would fork the
    // branch (docs-rune-operating-from-memory). The pre-derived critique.slug
    // must win so critique commits land on the SAME rune-writing/{slug} branch
    // as the original draft (project-19 spec §W4).
    const result = await runWritingPipeline(
      {
        topic: 'docs/rune/Operating From Memory.md',
        requestedBy: 'writing-critique',
        critique: {
          slug: 'operating-from-memory',
          outputPath: 'docs/rune/critiques/operating-from-memory.md',
          revisionRequested: false,
        },
      },
      deps,
    );

    // No drafting/revising — critique-only is a subsequence of the canonical order.
    expect(events.map((event) => event.state)).toEqual([
      'researching',
      'critiquing',
      'ready-for-review',
      'committed',
    ]);
    expect(readArtifact).toHaveBeenCalledWith('docs/rune/operating-from-memory.md');
    // The critique model judges the EXISTING artifact, not a fresh draft.
    expect(deps.model.critique).toHaveBeenCalledWith(
      expect.objectContaining({ markdown: existingArtifact }),
    );
    expect(deps.model.plan).not.toHaveBeenCalled();
    expect(deps.model.draft).not.toHaveBeenCalled();
    expect(deps.model.revise).not.toHaveBeenCalled();
    expect(writes).toEqual([
      expect.objectContaining({ path: 'docs/rune/critiques/operating-from-memory.md' }),
    ]);
    expect(commits).toEqual([
      {
        branch: 'rune-writing/operating-from-memory',
        paths: ['docs/rune/critiques/operating-from-memory.md'],
        message: 'Critique writing page: docs/rune/Operating From Memory.md',
      },
    ]);
    expect(result).toMatchObject({
      slug: 'operating-from-memory',
      branch: 'rune-writing/operating-from-memory',
      state: 'committed',
      committed: true,
      commitSha: 'abc1234',
    });
  });

  it('critique mode with revision: revises the artifact and commits critique + artifact on the same branch', async () => {
    const { runWritingPipeline } = await requireWritingPipeline();
    const readArtifact = vi.fn(async () => '# Existing\n\nDraft to revise.');
    const { deps, events, writes, commits } = makeDeps({ readArtifact });

    const result = await runWritingPipeline(
      {
        topic: 'operating-from-memory',
        requestedBy: 'writing-critique',
        critique: {
          slug: 'operating-from-memory',
          outputPath: 'docs/rune/critiques/operating-from-memory.md',
          revisionRequested: true,
        },
      },
      deps,
    );

    expect(events.map((event) => event.state)).toEqual([
      'researching',
      'critiquing',
      'revising',
      'ready-for-review',
      'committed',
    ]);
    // The revise call gets the existing artifact plus the critique notes.
    expect(deps.model.revise).toHaveBeenCalledWith(
      expect.objectContaining({
        markdown: '# Existing\n\nDraft to revise.',
        critique: 'Make the thesis more concrete.',
      }),
    );
    expect(writes.map((w) => w.path)).toEqual([
      'docs/rune/critiques/operating-from-memory.md',
      'docs/rune/operating-from-memory.md',
    ]);
    expect(commits).toEqual([
      {
        branch: 'rune-writing/operating-from-memory',
        paths: [
          'docs/rune/critiques/operating-from-memory.md',
          'docs/rune/operating-from-memory.md',
        ],
        message: 'Revise writing page: operating-from-memory',
      },
    ]);
    expect(result).toMatchObject({ state: 'committed', committed: true });
  });

  it('critique mode fails honestly when no readArtifact dep is provided (critique targets an EXISTING draft)', async () => {
    const { runWritingPipeline } = await requireWritingPipeline();
    const { deps, events, writes, commits } = makeDeps(); // no readArtifact

    const result = await runWritingPipeline(
      {
        topic: 'operating-from-memory',
        requestedBy: 'writing-critique',
        critique: {
          slug: 'operating-from-memory',
          outputPath: 'docs/rune/critiques/operating-from-memory.md',
          revisionRequested: false,
        },
      },
      deps,
    );

    expect(events.map((event) => event.state)).toEqual(['researching', 'failed']);
    expect(writes).toEqual([]);
    expect(commits).toEqual([]);
    expect(result).toMatchObject({ state: 'failed', failed: true });
  });

  it('critique mode fails when the existing artifact cannot be read', async () => {
    const { runWritingPipeline } = await requireWritingPipeline();
    const readArtifact = vi.fn(async () => {
      throw new Error('ENOENT: no draft on this branch');
    });
    const { deps, commits } = makeDeps({ readArtifact });

    const result = await runWritingPipeline(
      {
        topic: 'operating-from-memory',
        requestedBy: 'writing-critique',
        critique: {
          slug: 'operating-from-memory',
          outputPath: 'docs/rune/critiques/operating-from-memory.md',
          revisionRequested: false,
        },
      },
      deps,
    );

    expect(commits).toEqual([]);
    expect(result).toMatchObject({ state: 'failed', failed: true });
  });

  it('critique mode strips planted private research markers from the committed critique notes', async () => {
    const { runWritingPipeline } = await requireWritingPipeline();
    const readArtifact = vi.fn(async () => '# Existing\n\nDraft.');
    const { deps, writes } = makeDeps({
      readArtifact,
      mcp: {
        callTool: vi.fn(async (name: string) => {
          if (name === 'journal_range') {
            return { entries: [`personal raw marker: ${PLANTED_PRIVATE_MARKER}`, RAW_JOURNAL_EXCERPT] };
          }
          return { results: [] };
        }),
      },
      model: {
        plan: vi.fn(async () => ({ outline: 'outline' })),
        draft: vi.fn(async () => ({ markdown: 'draft' })),
        // A leaky critique model quotes the private research verbatim.
        critique: vi.fn(async () => ({
          notes: `Sharpen the hook.\n${PLANTED_PRIVATE_MARKER}\n${RAW_JOURNAL_EXCERPT}\nTighten the close.`,
        })),
        revise: vi.fn(async () => ({ markdown: 'unused' })),
      },
    });

    const result = await runWritingPipeline(
      {
        topic: 'operating-from-memory',
        requestedBy: 'writing-critique',
        critique: {
          slug: 'operating-from-memory',
          outputPath: 'docs/rune/critiques/operating-from-memory.md',
          revisionRequested: false,
        },
      },
      deps,
    );

    expect(result).toMatchObject({ state: 'committed', committed: true });
    const committedNotes = writes.find((w) => w.path.startsWith('docs/rune/critiques/'))?.content ?? '';
    expect(committedNotes).toContain('Sharpen the hook.');
    expect(committedNotes).toContain('Tighten the close.');
    expect(committedNotes).not.toContain(PLANTED_PRIVATE_MARKER);
    expect(committedNotes).not.toContain('therapy sleep score was 47');
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
