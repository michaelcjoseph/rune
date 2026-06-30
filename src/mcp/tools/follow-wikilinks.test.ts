import { describe, expect, it, vi } from 'vitest';

interface McpTextResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

interface IndexedLine {
  file: string;
  line: number;
  content: string;
}

interface FollowWikilinksInput {
  sourceFile?: string;
  text?: string;
  maxDepth?: number;
  maxResults?: number;
}

interface FollowWikilinksDeps {
  getVaultIndexStatus: () => { ready: boolean; status: string };
  queryVaultIndex: (
    query: string,
    options?: { directory?: string; maxResults?: number },
  ) => IndexedLine[];
  sanitizeError?: (message: string) => string;
}

interface FollowWikilinksPayload {
  source: 'warm';
  maxDepth: number;
  maxResults: number;
  results: Array<{
    link: string;
    targetFile: string;
    depth: number;
    content: string;
  }>;
  unresolvedLinks: string[];
}

type FollowWikilinksFn = (
  input: FollowWikilinksInput,
  deps: FollowWikilinksDeps,
) => Promise<McpTextResult>;

async function requireFollowWikilinksModule(): Promise<{ followWikilinks: FollowWikilinksFn }> {
  const specifier = './follow-wikilinks' + '.js';
  try {
    const mod = (await import(/* @vite-ignore */ specifier)) as Record<string, unknown>;
    if (typeof mod.followWikilinks === 'function') {
      return { followWikilinks: mod.followWikilinks as FollowWikilinksFn };
    }
    expect.fail('src/mcp/tools/follow-wikilinks.ts must export followWikilinks');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    expect.fail(`src/mcp/tools/follow-wikilinks.ts implementation pending: ${message}`);
  }
}

function makeDeps(overrides: Partial<FollowWikilinksDeps> = {}): FollowWikilinksDeps {
  return {
    getVaultIndexStatus: vi.fn().mockReturnValue({ ready: true, status: 'ready' }),
    queryVaultIndex: vi.fn().mockReturnValue([]),
    sanitizeError: (message) => message.replace(/\/Users\/[^/]+\/workspace\/pkms/g, '[vault]'),
    ...overrides,
  };
}

function parsePayload(result: McpTextResult): FollowWikilinksPayload {
  expect(result.isError).toBeFalsy();
  expect(result.content).toHaveLength(1);
  expect(result.content[0]?.type).toBe('text');
  return JSON.parse(result.content[0]!.text) as FollowWikilinksPayload;
}

describe('followWikilinks', () => {
  it('resolves wikilinks from a text snippet and follows nested links through the warm corpus', async () => {
    const { followWikilinks } = await requireFollowWikilinksModule();
    const deps = makeDeps({
      queryVaultIndex: vi.fn().mockReturnValue([
        { file: 'knowledge/alpha-note.md', line: 1, content: '# Alpha Note' },
        { file: 'knowledge/alpha-note.md', line: 3, content: 'ALPHA_TARGET_MARKER links onward to [[Beta Note]].' },
        { file: 'knowledge/beta-note.md', line: 1, content: '# Beta Note' },
        { file: 'knowledge/beta-note.md', line: 3, content: 'BETA_TARGET_MARKER is the second-hop content.' },
        { file: 'knowledge/unlinked.md', line: 2, content: 'UNLINKED_MARKER_SHOULD_NOT_APPEAR' },
      ]),
    });

    const result = await followWikilinks(
      {
        text: 'Expand [[Alpha Note]] for this draft.',
        maxDepth: 2,
        maxResults: 10,
      },
      deps,
    );

    expect(deps.queryVaultIndex).toHaveBeenCalledWith(
      '',
      expect.objectContaining({ maxResults: expect.any(Number) }),
    );

    const payload = parsePayload(result);
    expect(payload).toMatchObject({
      source: 'warm',
      maxDepth: 2,
      maxResults: 10,
      unresolvedLinks: [],
    });
    expect(payload.results.map((entry) => ({
      link: entry.link,
      targetFile: entry.targetFile,
      depth: entry.depth,
    }))).toEqual([
      { link: 'Alpha Note', targetFile: 'knowledge/alpha-note.md', depth: 1 },
      { link: 'Beta Note', targetFile: 'knowledge/beta-note.md', depth: 2 },
    ]);
    expect(JSON.stringify(payload)).toContain('ALPHA_TARGET_MARKER');
    expect(JSON.stringify(payload)).toContain('BETA_TARGET_MARKER');
    expect(JSON.stringify(payload)).not.toContain('UNLINKED_MARKER_SHOULD_NOT_APPEAR');
  });

  it('extracts links from a warm-indexed source file and resolves alias-form wikilinks', async () => {
    const { followWikilinks } = await requireFollowWikilinksModule();
    const deps = makeDeps({
      queryVaultIndex: vi.fn().mockReturnValue([
        { file: 'journals/2026_06_10.md', line: 1, content: '# 2026-06-10' },
        { file: 'journals/2026_06_10.md', line: 4, content: 'Need the [[Velocity Note|velocity draft]] today.' },
        { file: 'knowledge/velocity-note.md', line: 1, content: '# Velocity Note' },
        { file: 'knowledge/velocity-note.md', line: 3, content: 'VELOCITY_TARGET_MARKER from the target.' },
      ]),
    });

    const result = await followWikilinks(
      {
        sourceFile: 'journals/2026_06_10.md',
        maxDepth: 1,
        maxResults: 5,
      },
      deps,
    );

    const payload = parsePayload(result);
    expect(payload.results).toHaveLength(1);
    expect(payload.results[0]).toMatchObject({
      link: 'Velocity Note',
      targetFile: 'knowledge/velocity-note.md',
      depth: 1,
    });
    expect(payload.results[0]?.content).toContain('VELOCITY_TARGET_MARKER');
  });

  it('honors maxDepth and maxResults as output bounds', async () => {
    const { followWikilinks } = await requireFollowWikilinksModule();
    const deps = makeDeps({
      queryVaultIndex: vi.fn().mockReturnValue([
        { file: 'knowledge/alpha-note.md', line: 1, content: '# Alpha Note' },
        { file: 'knowledge/alpha-note.md', line: 2, content: 'ALPHA_TARGET_MARKER links [[Beta Note]].' },
        { file: 'knowledge/beta-note.md', line: 1, content: '# Beta Note' },
        { file: 'knowledge/beta-note.md', line: 2, content: 'BETA_TARGET_SHOULD_NOT_APPEAR' },
        { file: 'knowledge/gamma-note.md', line: 1, content: '# Gamma Note' },
        { file: 'knowledge/gamma-note.md', line: 2, content: 'GAMMA_TARGET_SHOULD_NOT_APPEAR' },
      ]),
    });

    const result = await followWikilinks(
      {
        text: 'Expand [[Alpha Note]] and [[Gamma Note]].',
        maxDepth: 1,
        maxResults: 1,
      },
      deps,
    );

    const payload = parsePayload(result);
    expect(payload.results).toHaveLength(1);
    expect(payload.results[0]).toMatchObject({
      link: 'Alpha Note',
      targetFile: 'knowledge/alpha-note.md',
      depth: 1,
    });
    expect(JSON.stringify(payload)).toContain('ALPHA_TARGET_MARKER');
    expect(JSON.stringify(payload)).not.toContain('BETA_TARGET_SHOULD_NOT_APPEAR');
    expect(JSON.stringify(payload)).not.toContain('GAMMA_TARGET_SHOULD_NOT_APPEAR');
  });

  it('returns unresolved links without fabricating target content', async () => {
    const { followWikilinks } = await requireFollowWikilinksModule();
    const deps = makeDeps({
      queryVaultIndex: vi.fn().mockReturnValue([
        { file: 'knowledge/alpha-note.md', line: 1, content: '# Alpha Note' },
        { file: 'knowledge/alpha-note.md', line: 2, content: 'ALPHA_TARGET_MARKER' },
      ]),
    });

    const result = await followWikilinks(
      {
        text: 'Expand [[Missing Note]] and [[Alpha Note]].',
        maxDepth: 1,
        maxResults: 5,
      },
      deps,
    );

    const payload = parsePayload(result);
    expect(payload.unresolvedLinks).toEqual(['Missing Note']);
    expect(payload.results.map((entry) => entry.link)).toEqual(['Alpha Note']);
    expect(JSON.stringify(payload)).not.toContain('Missing Note.md');
  });

  it('requires the warm index to be ready and never falls back to cold vault search', async () => {
    const { followWikilinks } = await requireFollowWikilinksModule();
    const deps = makeDeps({
      getVaultIndexStatus: vi.fn().mockReturnValue({ ready: false, status: 'building' }),
    });

    const result = await followWikilinks(
      {
        text: 'Expand [[Alpha Note]].',
        maxDepth: 1,
        maxResults: 5,
      },
      deps,
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/warm index|vault index/i);
    expect(deps.queryVaultIndex).not.toHaveBeenCalled();
  });

  it('rejects missing sources and invalid limits before touching the warm corpus', async () => {
    const { followWikilinks } = await requireFollowWikilinksModule();
    const deps = makeDeps();

    const noSource = await followWikilinks({ maxDepth: 1, maxResults: 5 }, deps);
    const badDepth = await followWikilinks({ text: '[[Alpha Note]]', maxDepth: 0 }, deps);
    const badLimit = await followWikilinks({ text: '[[Alpha Note]]', maxResults: 0 }, deps);

    expect(noSource.isError).toBe(true);
    expect(badDepth.isError).toBe(true);
    expect(badLimit.isError).toBe(true);
    expect(deps.queryVaultIndex).not.toHaveBeenCalled();
  });

  it('sanitizes unexpected warm-corpus errors before returning MCP error text', async () => {
    const { followWikilinks } = await requireFollowWikilinksModule();
    const deps = makeDeps({
      queryVaultIndex: vi.fn(() => {
        throw new Error('/Users/jarvis/workspace/pkms/knowledge/alpha-note.md read failed');
      }),
    });

    const result = await followWikilinks(
      {
        text: 'Expand [[Alpha Note]].',
        maxDepth: 1,
        maxResults: 5,
      },
      deps,
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('[vault]');
    expect(result.content[0]?.text).not.toContain('/Users/jarvis/workspace/pkms');
  });
});
