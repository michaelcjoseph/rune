import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../config.js', () => ({
  default: { VAULT_DIR: '/test/vault', TIMEZONE: 'America/Chicago', CLAUDE_INGEST_TIMEOUT_MS: 1_800_000 },
}));

vi.mock('../ai/claude.js', () => ({ runAgent: vi.fn() }));
vi.mock('../vault/files.js', () => ({
  readVaultFile: vi.fn(),
  writeVaultFile: vi.fn(),
  vaultFileExists: vi.fn(),
  getVaultPath: vi.fn((p: string) => `/test/vault/${p}`),
  listVaultFiles: vi.fn(() => []),
  getFileModTime: vi.fn(() => null),
}));
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return { ...actual, copyFileSync: vi.fn(), mkdirSync: vi.fn() };
});

const { runAgent } = await import('../ai/claude.js');
const { readVaultFile, writeVaultFile, vaultFileExists, listVaultFiles, getFileModTime } = await import('../vault/files.js');
const { copyFileSync } = await import('node:fs');
const { ingestSource, determineRawDir, isMutableSource, snapshotProjectsMtimes, snapshotWikiMtimes, diffWikiCounts } = await import('./ingest.js');

const agentMock = runAgent as unknown as ReturnType<typeof vi.fn>;
const readMock = readVaultFile as unknown as ReturnType<typeof vi.fn>;
const writeMock = writeVaultFile as unknown as ReturnType<typeof vi.fn>;
const existsMock = vaultFileExists as unknown as ReturnType<typeof vi.fn>;
const copyMock = copyFileSync as unknown as ReturnType<typeof vi.fn>;
const listMock = listVaultFiles as unknown as ReturnType<typeof vi.fn>;
const mtimeMock = getFileModTime as unknown as ReturnType<typeof vi.fn>;

describe('kb/ingest', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    existsMock.mockReturnValue(false);
    listMock.mockReturnValue([]);
    mtimeMock.mockReturnValue(null);
  });

  it('returns error when source file not found', async () => {
    readMock.mockReturnValue(null);
    const result = await ingestSource('missing.md');
    expect(result.success).toBe(false);
    expect(result.output).toContain('not found');
  });

  it('flags missing-source failures as permanent so the engine can dequeue', async () => {
    // Regression: a stale post-review enqueue (e.g. agent referenced a file it
    // never wrote) used to sit in the queue forever and re-fail on every run.
    // The engine consumes `permanent` to decide whether to dequeue.
    readMock.mockReturnValue(null);
    const result = await ingestSource('projects/ghost.md');
    expect(result.permanent).toBe(true);
  });

  it('runs wiki-compiler agent on valid source', async () => {
    // Simulate log.md changing after agent runs (agent wrote to it)
    let logCallCount = 0;
    readMock.mockImplementation((path: string) => {
      if (path === 'knowledge/log.md') {
        logCallCount++;
        return logCallCount === 1 ? '# Log' : '# Log\n[2026-04-15] Ingested notes/test.md';
      }
      return 'content';
    });
    agentMock.mockResolvedValue({ text: 'Done', error: null });

    const result = await ingestSource('notes/test.md');
    expect(result.success).toBe(true);
    expect(agentMock).toHaveBeenCalledWith('wiki-compiler', expect.stringContaining('notes/test.md'), expect.any(Number));
  });

  it('passes the dedicated CLAUDE_INGEST_TIMEOUT_MS to the wiki-compiler call', async () => {
    let logCallCount = 0;
    readMock.mockImplementation((path: string) => {
      if (path === 'knowledge/log.md') {
        logCallCount++;
        return logCallCount === 1 ? '# Log' : '# Log\n[2026-04-15] Ingested';
      }
      return 'content';
    });
    agentMock.mockResolvedValue({ text: 'ok', error: null });

    await ingestSource('notes/test.md');

    // Real ingests can run long; wiki-compiler uses the dedicated timeout
    // constant so it can diverge from the generic default. (Mocked config sets it to 1_800_000.)
    expect(agentMock).toHaveBeenCalledWith('wiki-compiler', expect.any(String), 1_800_000);
  });

  it('includes guidance in agent prompt', async () => {
    let logCallCount = 0;
    readMock.mockImplementation((path: string) => {
      if (path === 'knowledge/log.md') {
        logCallCount++;
        return logCallCount === 1 ? '# Log' : '# Log\n[2026-04-15] Ingested';
      }
      return 'content';
    });
    agentMock.mockResolvedValue({ text: 'ok', error: null });

    await ingestSource('notes/test.md', { guidance: 'focus on APIs' });
    expect(agentMock).toHaveBeenCalledWith('wiki-compiler', expect.stringContaining('focus on APIs'), expect.any(Number));
  });

  it('returns error when agent fails', async () => {
    readMock.mockReturnValue('content');
    agentMock.mockResolvedValue({ text: null, error: 'agent crashed' });

    const result = await ingestSource('notes/test.md');
    expect(result.success).toBe(false);
    expect(result.output).toBe('agent crashed');
    // Agent failures may be transient (CLI timeout, network); not a permanent
    // failure, so the engine should leave the entry queued for retry.
    expect(result.permanent).toBeFalsy();
  });

  it('returns error when agent succeeds but writes nothing to log.md', async () => {
    // log.md unchanged before and after agent run = agent did nothing
    readMock.mockReturnValue('content');
    agentMock.mockResolvedValue({ text: 'Done', error: null });

    const result = await ingestSource('notes/test.md');
    expect(result.success).toBe(false);
    expect(result.output).toContain('produced no output');
    expect(result.permanent).toBeFalsy();
  });

  it('copies Readwise files to raw/articles/', async () => {
    let logCallCount = 0;
    readMock.mockImplementation((path: string) => {
      if (path === 'knowledge/log.md') {
        logCallCount++;
        return logCallCount === 1 ? '# Log' : '# Log\n[2026-04-15] Ingested';
      }
      return 'content';
    });
    agentMock.mockResolvedValue({ text: 'ok', error: null });

    await ingestSource('Readwise/article.md');
    expect(copyMock).toHaveBeenCalledWith(
      '/test/vault/Readwise/article.md',
      '/test/vault/knowledge/raw/articles/article.md',
    );
  });

  it('skips copy when source already in knowledge/raw/', async () => {
    let logCallCount = 0;
    readMock.mockImplementation((path: string) => {
      if (path === 'knowledge/log.md') {
        logCallCount++;
        return logCallCount === 1 ? '# Log' : '# Log\n[2026-04-15] Ingested';
      }
      return 'content';
    });
    agentMock.mockResolvedValue({ text: 'ok', error: null });

    await ingestSource('knowledge/raw/notes/existing.md');
    expect(copyMock).not.toHaveBeenCalled();
  });

  describe('determineRawDir', () => {
    it('routes Readwise articles', () => {
      expect(determineRawDir('Readwise/foo.md')).toBe('knowledge/raw/articles');
    });

    // Note: journals are special-cased before determineRawDir is reached
    // (split into raw/journals/ and raw/reviews/ inside ingestSource), so
    // there is no determineRawDir branch for journals to test.

    it('routes world-view files', () => {
      expect(determineRawDir('world-view/ai.md')).toBe('knowledge/raw/world-view');
      expect(determineRawDir('world-view/crypto.md')).toBe('knowledge/raw/world-view');
    });

    it('routes playbook.md', () => {
      expect(determineRawDir('pages/playbook.md')).toBe('knowledge/raw/playbook');
    });

    it('routes active projects', () => {
      expect(determineRawDir('projects/project-alpha.md')).toBe('knowledge/raw/projects');
      expect(determineRawDir('projects/project-beta.md')).toBe('knowledge/raw/projects');
    });

    it('routes archived projects to notes', () => {
      expect(determineRawDir('projects/archive/old.md')).toBe('knowledge/raw/notes');
    });

    it('routes conversation files to conversations/', () => {
      expect(determineRawDir('conversations/2026-04-07.md')).toBe('knowledge/raw/conversations');
    });

    it('routes paths containing "conversation" in name to conversations/', () => {
      expect(determineRawDir('notes/conversation-with-alice.md')).toBe('knowledge/raw/conversations');
    });

    it('routes library/lenny/ files to lenny/', () => {
      expect(determineRawDir('library/lenny/episode-42.md')).toBe('knowledge/raw/lenny');
    });

    it('routes legacy library/lennys-podcast/ files to lenny/', () => {
      expect(determineRawDir('library/lennys-podcast/old-episode.md')).toBe('knowledge/raw/lenny');
    });

    it('routes library/graham-essays/ files to articles/', () => {
      expect(determineRawDir('library/graham-essays/hackers-painters.md')).toBe('knowledge/raw/articles');
    });

    it('falls back to notes for unknown paths', () => {
      expect(determineRawDir('misc/something.md')).toBe('knowledge/raw/notes');
    });
  });

  describe('isMutableSource', () => {
    it('marks world-view / playbook / active projects / journals as mutable', () => {
      expect(isMutableSource('world-view/ai.md')).toBe(true);
      expect(isMutableSource('pages/playbook.md')).toBe(true);
      expect(isMutableSource('projects/project-alpha.md')).toBe(true);
      expect(isMutableSource('journals/2026_04_21.md')).toBe(true);
    });

    it('marks Readwise and archived projects as immutable', () => {
      expect(isMutableSource('Readwise/foo.md')).toBe(false);
      expect(isMutableSource('projects/archive/old.md')).toBe(false);
      expect(isMutableSource('misc/notes.md')).toBe(false);
    });

    it('marks library/lenny/ as mutable and library/lennys-podcast/ and library/graham-essays/ as immutable', () => {
      expect(isMutableSource('library/lenny/episode-42.md')).toBe(true);
      expect(isMutableSource('library/lennys-podcast/old-episode.md')).toBe(false);
      expect(isMutableSource('library/graham-essays/hackers-painters.md')).toBe(false);
    });
  });

  it('overwrites raw copy when ingesting a mutable source that already exists', async () => {
    existsMock.mockReturnValue(true);
    let logCallCount = 0;
    readMock.mockImplementation((path: string) => {
      if (path === 'knowledge/log.md') {
        logCallCount++;
        return logCallCount === 1 ? '# Log' : '# Log\n[2026-04-15] Ingested';
      }
      return 'content';
    });
    agentMock.mockResolvedValue({ text: 'ok', error: null });

    await ingestSource('world-view/ai.md');

    expect(copyMock).toHaveBeenCalledWith(
      '/test/vault/world-view/ai.md',
      '/test/vault/knowledge/raw/world-view/ai.md',
    );
  });

  it('writes journal raw copy via writeVaultFile (no copyFileSync) on same-day edits', async () => {
    existsMock.mockReturnValue(true);
    let logCallCount = 0;
    readMock.mockImplementation((path: string) => {
      if (path === 'knowledge/log.md') {
        logCallCount++;
        return logCallCount === 1 ? '# Log' : '# Log\n[2026-04-15] Ingested';
      }
      // No review heading — so the splitter returns review=null and only the
      // journal portion is written.
      return 'just journal prose, no review section';
    });
    agentMock.mockResolvedValue({ text: 'ok', error: null });

    await ingestSource('journals/2026_04_21.md');

    expect(writeMock).toHaveBeenCalledWith(
      'knowledge/raw/journals/2026_04_21.md',
      'just journal prose, no review section',
    );
    // Journal flow no longer goes through copyFileSync.
    expect(copyMock).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('knowledge/raw/journals/'),
    );
  });

  describe('journal review-section split', () => {
    // Stage successful agent run + return given journal content for the source path.
    // log.md must "change" between the snapshot before and after the agent runs so
    // ingestSource considers the run successful (see "Agent completed but wrote nothing"
    // guard in ingest.ts).
    const arrangeAgent = (sourcePath: string, journalContent: string) => {
      let logCallCount = 0;
      readMock.mockImplementation((path: string) => {
        if (path === 'knowledge/log.md') {
          logCallCount++;
          return logCallCount === 1 ? '# Log' : '# Log\n[2026-04-15] Ingested';
        }
        if (path === sourcePath) return journalContent;
        return 'content';
      });
      agentMock.mockResolvedValue({ text: 'ok', error: null });
    };

    it('splits a Friday journal with ## Week in Review into raw/journals/ and raw/reviews/', async () => {
      const journalContent = `# 2026-04-24

Some morning notes.

#priorities
- Ship Aura

## Week in Review

**Reflection:** good week
**Next Week's Goals:**
1. More shipping`;
      arrangeAgent('journals/2026_04_24.md', journalContent);

      await ingestSource('journals/2026_04_24.md');

      // Journal portion: pre-review only, trailing whitespace trimmed.
      expect(writeMock).toHaveBeenCalledWith(
        'knowledge/raw/journals/2026_04_24.md',
        '# 2026-04-24\n\nSome morning notes.\n\n#priorities\n- Ship Aura',
      );
      // Review portion: derived filename includes review type, content includes the heading.
      const reviewCall = writeMock.mock.calls.find(
        (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).startsWith('knowledge/raw/reviews/'),
      );
      expect(reviewCall).toBeDefined();
      expect(reviewCall![0]).toBe('knowledge/raw/reviews/2026_04_24-weekly.md');
      expect(reviewCall![1] as string).toContain('## Week in Review');
      expect(reviewCall![1] as string).toContain('**Reflection:** good week');
    });

    it('writes only journal portion when no review section present', async () => {
      const journalContent = `Plain daily notes.

#priorities
- One thing`;
      arrangeAgent('journals/2026_04_22.md', journalContent);

      await ingestSource('journals/2026_04_22.md');

      const journalWrite = writeMock.mock.calls.find(
        (c: unknown[]) => c[0] === 'knowledge/raw/journals/2026_04_22.md',
      );
      const reviewWrite = writeMock.mock.calls.find(
        (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).startsWith('knowledge/raw/reviews/'),
      );
      expect(journalWrite).toBeDefined();
      expect(journalWrite![1]).toBe(journalContent);
      expect(reviewWrite).toBeUndefined();
    });

    it.each([
      ['weekly', '## Week in Review', '2026_04_24', 'weekly'],
      ['monthly', '# April 2026 Review', '2026_04_30', 'monthly'],
      ['quarterly Q1', '# Q1 2026 Review', '2026_03_31', 'quarterly'],
      ['quarterly Q2', '# Q2 2026 Review', '2026_06_30', 'quarterly'],
      ['quarterly Q3', '# Q3 2026 Review', '2026_09_30', 'quarterly'],
      ['quarterly Q4', '# Q4 2026 Review', '2026_12_31', 'quarterly'],
      ['yearly', '# 2026 Yearly Review', '2026_12_31', 'yearly'],
    ])('produces correct derived filename for %s reviews', async (_label, heading, dateBase, expectedType) => {
      const journalContent = `Notes.\n\n${heading}\n\nbody`;
      arrangeAgent(`journals/${dateBase}.md`, journalContent);

      await ingestSource(`journals/${dateBase}.md`);

      const reviewCall = writeMock.mock.calls.find(
        (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).startsWith('knowledge/raw/reviews/'),
      );
      expect(reviewCall).toBeDefined();
      expect(reviewCall![0]).toBe(`knowledge/raw/reviews/${dateBase}-${expectedType}.md`);
    });

    it('idempotent: re-ingesting the same journal writes the same files', async () => {
      const journalContent = `Notes.\n\n## Week in Review\n\nbody`;
      arrangeAgent('journals/2026_04_24.md', journalContent);

      await ingestSource('journals/2026_04_24.md');
      const firstCalls = writeMock.mock.calls
        .filter((c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).startsWith('knowledge/raw/'))
        .map((c: unknown[]) => [c[0], c[1]]);

      writeMock.mockClear();
      await ingestSource('journals/2026_04_24.md');
      const secondCalls = writeMock.mock.calls
        .filter((c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).startsWith('knowledge/raw/'))
        .map((c: unknown[]) => [c[0], c[1]]);

      expect(secondCalls).toEqual(firstCalls);
    });

    it('skips writing raw/journals/ when pre-review prose is empty (line-0 review heading)', async () => {
      const journalContent = `## Week in Review\n\n**Reflection:** wrote nothing else`;
      arrangeAgent('journals/2026_04_24.md', journalContent);

      await ingestSource('journals/2026_04_24.md');

      const journalCall = writeMock.mock.calls.find(
        (c: unknown[]) => c[0] === 'knowledge/raw/journals/2026_04_24.md',
      );
      const reviewCall = writeMock.mock.calls.find(
        (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).startsWith('knowledge/raw/reviews/'),
      );
      expect(journalCall).toBeUndefined();
      expect(reviewCall).toBeDefined();
    });

    it('agent prompt points at raw/journals/ path (not the live vault path) when journal is split', async () => {
      const journalContent = `Notes.\n\n## Week in Review\n\nbody`;
      arrangeAgent('journals/2026_04_24.md', journalContent);

      await ingestSource('journals/2026_04_24.md');

      const promptArg = (agentMock as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]![1] as string;
      // The agent must read the split raw copy, not the unsplit live journal.
      expect(promptArg).toContain('Source file: knowledge/raw/journals/2026_04_24.md');
      expect(promptArg).not.toMatch(/Source file: journals\/2026_04_24\.md/);
      // Review file must be surfaced as a co-source with the citation-preference reminder.
      expect(promptArg).toContain('knowledge/raw/reviews/2026_04_24-weekly.md');
      expect(promptArg).toContain('weekly review');
      expect(promptArg).toContain('canonical layer');
    });

    it('agent prompt points at raw/reviews/ path when journal pre-review prose is empty', async () => {
      const journalContent = `## Week in Review\n\nbody only`;
      arrangeAgent('journals/2026_04_24.md', journalContent);

      await ingestSource('journals/2026_04_24.md');

      const promptArg = (agentMock as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]![1] as string;
      expect(promptArg).toContain('Source file: knowledge/raw/reviews/2026_04_24-weekly.md');
      // No "Additional source" line when the review file IS the primary source.
      expect(promptArg).not.toContain('Additional source');
    });

    it('agent prompt has no review-related lines when journal has no review section', async () => {
      const journalContent = `Plain daily notes.\n\n#priorities\n- One thing`;
      arrangeAgent('journals/2026_04_22.md', journalContent);

      await ingestSource('journals/2026_04_22.md');

      const promptArg = (agentMock as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]![1] as string;
      expect(promptArg).toContain('Source file: knowledge/raw/journals/2026_04_22.md');
      expect(promptArg).not.toContain('Additional source');
      expect(promptArg).not.toContain('raw/reviews/');
    });
  });

  describe('wiki-compiler boundary guard', () => {
    it('passes when projects/*.md files are unchanged during agent run', async () => {
      listMock.mockImplementation((dir: string) =>
        dir === 'projects' ? ['projects/relay.md', 'projects/watt-data.md'] : [],
      );
      mtimeMock.mockReturnValue(new Date(1000));

      let logCallCount = 0;
      readMock.mockImplementation((path: string) => {
        if (path === 'knowledge/log.md') {
          logCallCount++;
          return logCallCount === 1 ? '# Log' : '# Log\n[2026-04-15] Ingested';
        }
        return 'content';
      });
      agentMock.mockResolvedValue({ text: 'ok', error: null });

      const result = await ingestSource('journals/2026_04_21.md');
      expect(result.success).toBe(true);
    });

    it('flags a boundary violation when a projects/*.md mtime changes during agent run', async () => {
      listMock.mockImplementation((dir: string) => (dir === 'projects' ? ['projects/relay.md'] : []));
      const mtimes: Array<Date | null> = [new Date(1000), new Date(2000)];
      mtimeMock.mockImplementation((path: string) => {
        if (path === 'projects/relay.md') return mtimes.shift() ?? new Date(2000);
        return null;
      });

      readMock.mockReturnValue('content');
      agentMock.mockResolvedValue({ text: 'ok', error: null });

      const result = await ingestSource('journals/2026_04_21.md');
      expect(result.success).toBe(false);
      expect(result.output).toContain('boundary violation');
      expect(result.output).toContain('projects/relay.md');
    });

    it('flags a boundary violation when wiki-compiler creates a new projects/*.md file', async () => {
      let projectsListCallCount = 0;
      listMock.mockImplementation((dir: string) => {
        if (dir !== 'projects') return [];
        projectsListCallCount++;
        return projectsListCallCount === 1 ? [] : ['projects/new-project.md'];
      });
      mtimeMock.mockImplementation((path: string) =>
        path === 'projects/new-project.md' ? new Date(1000) : null,
      );

      readMock.mockReturnValue('content');
      agentMock.mockResolvedValue({ text: 'ok', error: null });

      const result = await ingestSource('journals/2026_04_21.md');
      expect(result.success).toBe(false);
      expect(result.output).toContain('projects/new-project.md');
    });

    it('detects violations even when the agent returns an error', async () => {
      listMock.mockImplementation((dir: string) => (dir === 'projects' ? ['projects/relay.md'] : []));
      const mtimes: Array<Date | null> = [new Date(1000), new Date(2000)];
      mtimeMock.mockImplementation((path: string) => {
        if (path === 'projects/relay.md') return mtimes.shift() ?? new Date(2000);
        return null;
      });

      readMock.mockReturnValue('content');
      agentMock.mockResolvedValue({ text: null, error: 'agent crashed' });

      const result = await ingestSource('journals/2026_04_21.md');
      expect(result.success).toBe(false);
      expect(result.output).toContain('boundary violation');
    });
  });

  describe('wiki counts', () => {
    // Helper: make log.md "change" across before/after so the ingest completes successfully
    const arrangeSuccessfulAgent = () => {
      let logCallCount = 0;
      readMock.mockImplementation((path: string) => {
        if (path === 'knowledge/log.md') {
          logCallCount++;
          return logCallCount === 1 ? '# Log' : '# Log\n[2026-04-15] Ingested';
        }
        return 'content';
      });
      agentMock.mockResolvedValue({ text: 'ok', error: null });
    };

    it('reports 0/0 when wiki is unchanged', async () => {
      arrangeSuccessfulAgent();
      listMock.mockImplementation(() => []);

      const result = await ingestSource('journals/2026_04_21.md');
      expect(result.success).toBe(true);
      expect(result.counts).toEqual({ created: 0, updated: 0 });
    });

    it('reports created count when a new wiki page is added', async () => {
      arrangeSuccessfulAgent();
      let wikiListCallCount = 0;
      listMock.mockImplementation((dir: string) => {
        if (dir !== 'knowledge/wiki') return [];
        wikiListCallCount++;
        return wikiListCallCount === 1
          ? ['knowledge/wiki/entities/alice.md']
          : ['knowledge/wiki/entities/alice.md', 'knowledge/wiki/entities/bob.md'];
      });
      mtimeMock.mockReturnValue(new Date(1000));

      const result = await ingestSource('journals/2026_04_21.md');
      expect(result.counts).toEqual({ created: 1, updated: 0 });
    });

    it('reports updated count when an existing wiki page mtime changes', async () => {
      arrangeSuccessfulAgent();
      listMock.mockImplementation((dir: string) =>
        dir === 'knowledge/wiki' ? ['knowledge/wiki/entities/alice.md'] : [],
      );
      const mtimes: Array<Date | null> = [new Date(1000), new Date(2000)];
      mtimeMock.mockImplementation((path: string) => {
        if (path === 'knowledge/wiki/entities/alice.md') return mtimes.shift() ?? new Date(2000);
        return null;
      });

      const result = await ingestSource('journals/2026_04_21.md');
      expect(result.counts).toEqual({ created: 0, updated: 1 });
    });

    it('reports counts even on boundary violation', async () => {
      const mtimes = new Map<string, Array<Date | null>>([
        ['projects/relay.md', [new Date(100), new Date(200)]],
        ['knowledge/wiki/entities/alice.md', [new Date(500)]],
      ]);
      let wikiListCallCount = 0;
      listMock.mockImplementation((dir: string) => {
        if (dir === 'projects') return ['projects/relay.md'];
        if (dir === 'knowledge/wiki') {
          wikiListCallCount++;
          return wikiListCallCount === 1 ? [] : ['knowledge/wiki/entities/alice.md'];
        }
        return [];
      });
      mtimeMock.mockImplementation((path: string) => mtimes.get(path)?.shift() ?? null);

      readMock.mockReturnValue('content');
      agentMock.mockResolvedValue({ text: 'ok', error: null });

      const result = await ingestSource('journals/2026_04_21.md');
      expect(result.success).toBe(false);
      expect(result.output).toContain('boundary violation');
      expect(result.counts).toEqual({ created: 1, updated: 0 });
    });

    it('returns zero counts when the source file is not found', async () => {
      readMock.mockReturnValue(null);
      const result = await ingestSource('missing.md');
      expect(result.counts).toEqual({ created: 0, updated: 0 });
    });
  });

  describe('diffWikiCounts', () => {
    it('counts new paths as created and changed mtimes as updated', () => {
      const before = new Map([
        ['a.md', 100],
        ['b.md', 100],
      ]);
      const after = new Map([
        ['a.md', 100],      // unchanged
        ['b.md', 200],      // updated
        ['c.md', 300],      // created
      ]);
      expect(diffWikiCounts(before, after)).toEqual({ created: 1, updated: 1 });
    });

    it('ignores deletions', () => {
      const before = new Map([['a.md', 100]]);
      const after = new Map<string, number>();
      expect(diffWikiCounts(before, after)).toEqual({ created: 0, updated: 0 });
    });
  });

  describe('snapshotWikiMtimes', () => {
    it('captures mtimes of all knowledge/wiki/*.md files', () => {
      listMock.mockImplementation((dir: string) =>
        dir === 'knowledge/wiki'
          ? ['knowledge/wiki/entities/alice.md', 'knowledge/wiki/concepts/scaling-laws.md']
          : [],
      );
      mtimeMock.mockImplementation((p: string) =>
        p === 'knowledge/wiki/entities/alice.md' ? new Date(100) : new Date(200),
      );

      const snapshot = snapshotWikiMtimes();
      expect(snapshot.get('knowledge/wiki/entities/alice.md')).toBe(100);
      expect(snapshot.get('knowledge/wiki/concepts/scaling-laws.md')).toBe(200);
    });
  });

  describe('snapshotProjectsMtimes', () => {
    it('captures mtimes of all projects/*.md files', () => {
      listMock.mockReturnValue(['projects/relay.md', 'projects/watt-data.md']);
      mtimeMock.mockImplementation((p: string) =>
        p === 'projects/relay.md' ? new Date(100) : new Date(200),
      );

      const snapshot = snapshotProjectsMtimes();
      expect(snapshot.get('projects/relay.md')).toBe(100);
      expect(snapshot.get('projects/watt-data.md')).toBe(200);
      expect(snapshot.size).toBe(2);
    });

    it('excludes projects/archive/ files', () => {
      listMock.mockReturnValue(['projects/relay.md', 'projects/archive/old.md']);
      mtimeMock.mockReturnValue(new Date(100));

      const snapshot = snapshotProjectsMtimes();
      expect(snapshot.has('projects/relay.md')).toBe(true);
      expect(snapshot.has('projects/archive/old.md')).toBe(false);
    });

    it('returns empty map when projects/ is empty', () => {
      listMock.mockReturnValue([]);
      expect(snapshotProjectsMtimes().size).toBe(0);
    });

    it('skips files whose mtime lookup returns null', () => {
      listMock.mockReturnValue(['projects/relay.md', 'projects/ghost.md']);
      mtimeMock.mockImplementation((p: string) =>
        p === 'projects/relay.md' ? new Date(100) : null,
      );

      const snapshot = snapshotProjectsMtimes();
      expect(snapshot.has('projects/relay.md')).toBe(true);
      expect(snapshot.has('projects/ghost.md')).toBe(false);
    });
  });
});
