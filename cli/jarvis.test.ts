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
});
