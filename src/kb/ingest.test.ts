import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../config.js', () => ({
  default: { VAULT_DIR: '/test/vault', TIMEZONE: 'America/Chicago', CLAUDE_INGEST_TIMEOUT_MS: 900_000 },
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
vi.mock('./queue.js', () => ({ dequeue: vi.fn() }));
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return { ...actual, copyFileSync: vi.fn(), mkdirSync: vi.fn() };
});

const { runAgent } = await import('../ai/claude.js');
const { readVaultFile, vaultFileExists, listVaultFiles, getFileModTime } = await import('../vault/files.js');
const { dequeue } = await import('./queue.js');
const { copyFileSync } = await import('node:fs');
const { ingestSource, determineRawDir, isMutableSource, snapshotProjectsMtimes, snapshotWikiMtimes, diffWikiCounts } = await import('./ingest.js');

const agentMock = runAgent as unknown as ReturnType<typeof vi.fn>;
const readMock = readVaultFile as unknown as ReturnType<typeof vi.fn>;
const existsMock = vaultFileExists as unknown as ReturnType<typeof vi.fn>;
const dequeueMock = dequeue as unknown as ReturnType<typeof vi.fn>;
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

    // Real ingests can run >5 min; wiki-compiler must use the dedicated timeout,
    // not the default CLAUDE_TIMEOUT_MS. (Mocked config sets it to 900_000.)
    expect(agentMock).toHaveBeenCalledWith('wiki-compiler', expect.any(String), 900_000);
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

  it('dequeues source after success', async () => {
    let logCallCount = 0;
    readMock.mockImplementation((path: string) => {
      if (path === 'knowledge/log.md') {
        logCallCount++;
        return logCallCount === 1 ? '# Log' : '# Log\n[2026-04-15] Ingested';
      }
      return 'content';
    });
    agentMock.mockResolvedValue({ text: 'ok', error: null });

    await ingestSource('raw/test.md');
    expect(dequeueMock).toHaveBeenCalledWith('raw/test.md');
  });

  it('returns error when agent fails', async () => {
    readMock.mockReturnValue('content');
    agentMock.mockResolvedValue({ text: null, error: 'agent crashed' });

    const result = await ingestSource('notes/test.md');
    expect(result.success).toBe(false);
    expect(result.output).toBe('agent crashed');
  });

  it('returns error when agent succeeds but writes nothing to log.md', async () => {
    // log.md unchanged before and after agent run = agent did nothing
    readMock.mockReturnValue('content');
    agentMock.mockResolvedValue({ text: 'Done', error: null });

    const result = await ingestSource('notes/test.md');
    expect(result.success).toBe(false);
    expect(result.output).toContain('produced no output');
    expect(dequeueMock).not.toHaveBeenCalled();
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

    it('routes journal files', () => {
      expect(determineRawDir('journals/2026_04_21.md')).toBe('knowledge/raw/journals');
    });

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

  it('overwrites raw copy when re-ingesting an existing journal (same-day edits)', async () => {
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

    await ingestSource('journals/2026_04_21.md');

    expect(copyMock).toHaveBeenCalledWith(
      '/test/vault/journals/2026_04_21.md',
      '/test/vault/knowledge/raw/journals/2026_04_21.md',
    );
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
