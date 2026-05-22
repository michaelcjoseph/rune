import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the modules that the CLI dynamically imports
vi.mock('../src/kb/engine.js', () => ({
  initKB: vi.fn(),
  queryKB: vi.fn(),
  ingestSource: vi.fn(),
  lintKB: vi.fn(),
  getKBStats: vi.fn(),
  processIngestionQueue: vi.fn().mockResolvedValue({ processed: 0, errors: 0 }),
}));

vi.mock('../src/kb/queue.js', () => ({
  getQueue: vi.fn().mockReturnValue([]),
}));

vi.mock('../src/kb/search.js', () => ({
  searchWithFilter: vi.fn(),
}));

vi.mock('../src/bot/commands/study.js', () => ({
  handleStudy: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../src/study/sr-session.js', () => ({
  hasActiveSRSession: vi.fn().mockReturnValue(false),
  handleSRMessage: vi.fn().mockResolvedValue(undefined),
}));

// Import the mocked modules to configure return values per test
const { initKB, queryKB, ingestSource, lintKB, getKBStats, processIngestionQueue } = await import('../src/kb/engine.js');
const initKBMock = initKB as unknown as ReturnType<typeof vi.fn>;
const processQueueMock = processIngestionQueue as unknown as ReturnType<typeof vi.fn>;
const { searchWithFilter } = await import('../src/kb/search.js');
const { getQueue } = await import('../src/kb/queue.js');
const getQueueMock = getQueue as unknown as ReturnType<typeof vi.fn>;

const queryMock = queryKB as unknown as ReturnType<typeof vi.fn>;
const ingestMock = ingestSource as unknown as ReturnType<typeof vi.fn>;
const lintMock = lintKB as unknown as ReturnType<typeof vi.fn>;
const statsMock = getKBStats as unknown as ReturnType<typeof vi.fn>;
const searchMock = searchWithFilter as unknown as ReturnType<typeof vi.fn>;

const { handleStudy } = await import('../src/bot/commands/study.js');
const { hasActiveSRSession } = await import('../src/study/sr-session.js');
const handleStudyMock = handleStudy as unknown as ReturnType<typeof vi.fn>;
const hasActiveSRSessionMock = hasActiveSRSession as unknown as ReturnType<typeof vi.fn>;

let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;
let originalArgv: string[];

beforeEach(() => {
  vi.clearAllMocks();
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  originalArgv = process.argv;
  process.exitCode = undefined;
});

afterEach(() => {
  logSpy.mockRestore();
  errorSpy.mockRestore();
  process.argv = originalArgv;
  process.exitCode = undefined;
});

/**
 * Run the CLI by dynamically importing the module after resetting the module cache.
 * Each import triggers the module-level main().catch(...) call.
 */
async function runCLI(...args: string[]): Promise<void> {
  process.argv = ['node', 'jarvis', ...args];
  // Reset module registry so the CLI module re-executes on import
  vi.resetModules();
  // Re-register mocks after resetModules (resetModules clears the mock registry too)
  vi.doMock('../src/kb/engine.js', () => ({
    initKB: initKBMock,
    queryKB: queryMock,
    ingestSource: ingestMock,
    lintKB: lintMock,
    getKBStats: statsMock,
    processIngestionQueue: processQueueMock,
  }));
  vi.doMock('../src/kb/queue.js', () => ({
    getQueue: getQueueMock,
  }));
  vi.doMock('../src/kb/search.js', () => ({
    searchWithFilter: searchMock,
  }));
  vi.doMock('../src/bot/commands/study.js', () => ({
    handleStudy: handleStudyMock,
  }));
  vi.doMock('../src/study/sr-session.js', () => ({
    hasActiveSRSession: hasActiveSRSessionMock,
    handleSRMessage: vi.fn().mockResolvedValue(undefined),
  }));
  // Import the CLI module — this triggers main()
  await import('./jarvis.js');
  // Allow any microtasks (the main().catch() promise) to settle
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('cli/jarvis', () => {
  describe('help output', () => {
    it('prints help when no command is given', async () => {
      await runCLI();

      expect(logSpy).toHaveBeenCalledWith(
        'Jarvis CLI — Knowledge base operations from the terminal\n',
      );
      expect(logSpy).toHaveBeenCalledWith('Usage: jarvis <command> [args]\n');
      expect(logSpy).toHaveBeenCalledWith('Commands:');
      expect(process.exitCode).toBeUndefined();
    });

    it('prints help when "help" command is given', async () => {
      await runCLI('help');

      expect(logSpy).toHaveBeenCalledWith(
        'Jarvis CLI — Knowledge base operations from the terminal\n',
      );
      expect(process.exitCode).toBeUndefined();
    });

    it('prints help when "--help" flag is given', async () => {
      await runCLI('--help');

      expect(logSpy).toHaveBeenCalledWith(
        'Jarvis CLI — Knowledge base operations from the terminal\n',
      );
      expect(process.exitCode).toBeUndefined();
    });
  });

  describe('per-command help', () => {
    it('prints help when --help is passed to a command', async () => {
      await runCLI('query', '--help');

      expect(logSpy).toHaveBeenCalledWith(
        'Jarvis CLI — Knowledge base operations from the terminal\n',
      );
      expect(queryMock).not.toHaveBeenCalled();
      expect(process.exitCode).toBeUndefined();
    });
  });

  describe('unknown command', () => {
    it('prints error and sets exitCode=1 for unknown command', async () => {
      await runCLI('frobnicate');

      expect(errorSpy).toHaveBeenCalledWith('Unknown command: frobnicate\n');
      expect(process.exitCode).toBe(1);
    });
  });

  describe('initialization', () => {
    it('calls initKB before running any command', async () => {
      statsMock.mockReturnValue({
        totalPages: 0, entities: 0, concepts: 0, topics: 0, comparisons: 0, recentLog: [],
      });

      await runCLI('status');

      expect(initKBMock).toHaveBeenCalled();
    });
  });

  describe('query command', () => {
    it('prints usage error when no question is provided', async () => {
      await runCLI('query');

      expect(errorSpy).toHaveBeenCalledWith('Usage: jarvis query <question>');
      expect(process.exitCode).toBe(1);
    });

    it('calls queryKB and prints the answer on success', async () => {
      queryMock.mockResolvedValue({ success: true, answer: 'The answer is 42.' });

      await runCLI('query', 'what', 'is', 'the', 'meaning');

      expect(queryMock).toHaveBeenCalledWith('what is the meaning');
      expect(logSpy).toHaveBeenCalledWith('The answer is 42.');
      expect(process.exitCode).toBeUndefined();
    });

    it('prints error and sets exitCode=1 when query fails', async () => {
      queryMock.mockResolvedValue({ success: false, answer: 'No relevant pages found' });

      await runCLI('query', 'something');

      expect(errorSpy).toHaveBeenCalledWith('Query failed:', 'No relevant pages found');
      expect(process.exitCode).toBe(1);
    });
  });

  describe('ingest command', () => {
    it('shows empty queue message when no path and queue is empty', async () => {
      await runCLI('ingest');

      expect(logSpy).toHaveBeenCalledWith(
        'Ingestion queue is empty. Usage: jarvis ingest <vault-relative-path> [--guidance "..."]',
      );
    });

    it('calls ingestSource with path and prints output on success', async () => {
      ingestMock.mockResolvedValue({ success: true, output: 'Ingested successfully' });

      await runCLI('ingest', 'knowledge/raw/test.md');

      expect(ingestMock).toHaveBeenCalledWith('knowledge/raw/test.md', { guidance: undefined });
      expect(logSpy).toHaveBeenCalledWith('Ingested successfully');
      expect(process.exitCode).toBeUndefined();
    });

    it('passes --guidance flag to ingestSource', async () => {
      ingestMock.mockResolvedValue({ success: true, output: 'Done' });

      await runCLI('ingest', 'knowledge/raw/test.md', '--guidance', 'focus on key concepts');

      expect(ingestMock).toHaveBeenCalledWith('knowledge/raw/test.md', {
        guidance: 'focus on key concepts',
      });
    });

    it('prints error and sets exitCode=1 when ingestion fails', async () => {
      ingestMock.mockResolvedValue({ success: false, output: 'File not found' });

      await runCLI('ingest', 'nonexistent.md');

      expect(errorSpy).toHaveBeenCalledWith('Ingestion failed:', 'File not found');
      expect(process.exitCode).toBe(1);
    });
  });

  describe('lint command', () => {
    it('calls lintKB and prints report on success', async () => {
      lintMock.mockResolvedValue({ success: true, report: 'All pages healthy' });

      await runCLI('lint');

      expect(lintMock).toHaveBeenCalled();
      expect(logSpy).toHaveBeenCalledWith('All pages healthy');
      expect(process.exitCode).toBeUndefined();
    });

    it('prints error and sets exitCode=1 when lint fails', async () => {
      lintMock.mockResolvedValue({ success: false, report: 'Lint error occurred' });

      await runCLI('lint');

      expect(errorSpy).toHaveBeenCalledWith('Lint failed:', 'Lint error occurred');
      expect(process.exitCode).toBe(1);
    });
  });

  describe('status command', () => {
    it('calls getKBStats and prints formatted output', async () => {
      statsMock.mockReturnValue({
        totalPages: 42,
        entities: 20,
        concepts: 10,
        topics: 8,
        comparisons: 4,
        recentLog: ['[2026-04-14] Ingested test.md', '[2026-04-13] Compiled wiki page'],
      });

      await runCLI('status');

      expect(statsMock).toHaveBeenCalled();
      expect(logSpy).toHaveBeenCalledWith('Knowledge Base Status\n');
      expect(logSpy).toHaveBeenCalledWith('  Pages:  42 total');
      expect(logSpy).toHaveBeenCalledWith(
        '          20 entities, 10 concepts, 8 topics, 4 comparisons',
      );
      expect(logSpy).toHaveBeenCalledWith('\nRecent Activity:');
      expect(logSpy).toHaveBeenCalledWith('  [2026-04-14] Ingested test.md');
      expect(logSpy).toHaveBeenCalledWith('  [2026-04-13] Compiled wiki page');
    });

    it('prints "(no recent activity)" when recentLog is empty', async () => {
      statsMock.mockReturnValue({
        totalPages: 0,
        entities: 0,
        concepts: 0,
        topics: 0,
        comparisons: 0,
        recentLog: [],
      });

      await runCLI('status');

      expect(logSpy).toHaveBeenCalledWith('  (no recent activity)');
    });
  });

  describe('search command', () => {
    it('prints usage error when no search term is provided', async () => {
      await runCLI('search');

      expect(errorSpy).toHaveBeenCalledWith(
        'Usage: jarvis search <term> [--type entity|concept|topic|comparison]',
      );
      expect(process.exitCode).toBe(1);
    });

    it('calls searchWithFilter and prints results', async () => {
      searchMock.mockReturnValue([
        {
          file: 'knowledge/wiki/entities/transformers.md',
          line: 5,
          content: 'Transformers are...',
        },
        {
          file: 'knowledge/wiki/concepts/attention.md',
          line: 12,
          content: 'Attention mechanism',
        },
      ]);

      await runCLI('search', 'transformers');

      expect(searchMock).toHaveBeenCalledWith(
        'transformers',
        { type: undefined },
        { maxResults: 20 },
      );
      expect(logSpy).toHaveBeenCalledWith(
        'knowledge/wiki/entities/transformers.md:5  Transformers are...',
      );
      expect(logSpy).toHaveBeenCalledWith(
        'knowledge/wiki/concepts/attention.md:12  Attention mechanism',
      );
    });

    it('passes --type filter to searchWithFilter without polluting query', async () => {
      searchMock.mockReturnValue([
        { file: 'knowledge/wiki/entities/test.md', line: 1, content: 'Test entity' },
      ]);

      await runCLI('search', 'test', '--type', 'entity');

      expect(searchMock).toHaveBeenCalledWith(
        'test',
        { type: 'entity' },
        { maxResults: 20 },
      );
    });

    it('prints "No results found." when search returns empty', async () => {
      searchMock.mockReturnValue([]);

      await runCLI('search', 'nonexistent');

      expect(logSpy).toHaveBeenCalledWith('No results found.');
    });

    it('handles multi-word query with --type flag', async () => {
      searchMock.mockReturnValue([]);

      await runCLI('search', 'multi', 'word', 'query', '--type', 'concept');

      expect(searchMock).toHaveBeenCalledWith(
        'multi word query',
        { type: 'concept' },
        { maxResults: 20 },
      );
    });
  });

  describe('study command', () => {
    let originalIsTTY: boolean | undefined;

    beforeEach(() => {
      originalIsTTY = (process.stdin as unknown as { isTTY?: boolean }).isTTY;
    });

    afterEach(() => {
      (process.stdin as unknown as { isTTY?: boolean }).isTTY = originalIsTTY;
    });

    it('calls handleStudy with joined positional args and exits cleanly when no session is created', async () => {
      // Set isTTY so the TTY guard passes for a session-start call (no arg)
      (process.stdin as unknown as { isTTY?: boolean }).isTTY = true;
      // hasActiveSRSession returns false → cmdStudy exits before the readline loop
      handleStudyMock.mockResolvedValue(undefined);
      hasActiveSRSessionMock.mockReturnValue(false);

      await runCLI('study');

      expect(handleStudyMock).toHaveBeenCalledOnce();
      expect(process.exitCode).toBeUndefined();
    });

    it('passes the N argument to handleStudy as a joined string', async () => {
      // Set isTTY so the TTY guard passes for a session-start call (numeric arg)
      (process.stdin as unknown as { isTTY?: boolean }).isTTY = true;
      handleStudyMock.mockResolvedValue(undefined);
      hasActiveSRSessionMock.mockReturnValue(false);

      await runCLI('study', '3');

      expect(handleStudyMock).toHaveBeenCalledOnce();
      // Second arg (after sender and userId) is the args string
      const argsArg = handleStudyMock.mock.calls[0]![2] as string;
      expect(argsArg).toBe('3');
    });

    it('passes "status" argument to handleStudy without requiring a TTY', async () => {
      // isTTY is falsy (default in test runner) — status is exempt from the guard
      (process.stdin as unknown as { isTTY?: boolean }).isTTY = false;
      handleStudyMock.mockResolvedValue(undefined);
      hasActiveSRSessionMock.mockReturnValue(false);

      await runCLI('study', 'status');

      const argsArg = handleStudyMock.mock.calls[0]![2] as string;
      expect(argsArg).toBe('status');
    });

    it('uses userId=0 (the CLI stub sentinel value)', async () => {
      // Set isTTY so the TTY guard passes for a session-start call
      (process.stdin as unknown as { isTTY?: boolean }).isTTY = true;
      handleStudyMock.mockResolvedValue(undefined);
      hasActiveSRSessionMock.mockReturnValue(false);

      await runCLI('study');

      const userIdArg = handleStudyMock.mock.calls[0]![1] as number;
      expect(userIdArg).toBe(0);
    });

    it('does NOT call handleStudy, sets exitCode=1, and prints an error when arg is non-status and stdin is not a TTY', async () => {
      (process.stdin as unknown as { isTTY?: boolean }).isTTY = false;
      handleStudyMock.mockResolvedValue(undefined);
      hasActiveSRSessionMock.mockReturnValue(false);

      await runCLI('study', '3');

      expect(handleStudyMock).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
      expect(errorSpy).toHaveBeenCalledWith(
        '`jarvis study` needs an interactive terminal — use `jarvis study status` for a non-interactive summary.',
      );
    });
  });
});
