import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockVaultFileExists = vi.fn();
const mockListVaultFiles = vi.fn();
const mockEnqueue = vi.fn();
const mockGetQueue = vi.fn<() => Array<{ source: string; addedAt: string; guidance?: string }>>().mockReturnValue([]);
const mockInitKB = vi.fn();
const mockProcessIngestionQueue = vi.fn().mockResolvedValue({ processed: 0, errors: 0 });

vi.mock('../vault/files.js', () => ({
  vaultFileExists: (...args: unknown[]) => mockVaultFileExists(...args),
  listVaultFiles: (...args: unknown[]) => mockListVaultFiles(...args),
}));

vi.mock('./queue.js', () => ({
  enqueue: (...args: unknown[]) => mockEnqueue(...args),
  getQueue: () => mockGetQueue(),
}));

vi.mock('./init.js', () => ({
  initKB: () => mockInitKB(),
}));

vi.mock('./engine.js', () => ({
  processIngestionQueue: () => mockProcessIngestionQueue(),
}));

vi.mock('./ingest.js', () => ({
  determineRawDir: (path: string) => {
    if (path.startsWith('Readwise/')) return 'knowledge/raw/articles';
    if (path.includes('conversation')) return 'knowledge/raw/conversations';
    return 'knowledge/raw/notes';
  },
}));

const { seedKB, seedAndProcess } = await import('./seed.js');

describe('kb/seed', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetQueue.mockReturnValue([]);
  });

  describe('isAlreadyIngested logic', () => {
    it('skips files that exist in raw/ and are not in the queue', async () => {
      mockVaultFileExists.mockImplementation((path: string) => {
        if (path === 'pages/playbook.md') return true;
        if (path === 'knowledge/raw/notes/playbook.md') return true;
        return false;
      });
      mockListVaultFiles.mockReturnValue([]);

      const result = await seedKB(
        [{ path: 'pages/playbook.md', guidance: 'test' }],
      );

      expect(result.skippedAlreadyIngested).toBe(1);
      expect(result.enqueued).toBe(0);
      expect(mockEnqueue).not.toHaveBeenCalled();
    });

    it('re-enqueues files that are in raw/ but still in the queue (failed ingestion)', async () => {
      mockVaultFileExists.mockImplementation((path: string) => {
        if (path === 'pages/playbook.md') return true;
        if (path === 'knowledge/raw/notes/playbook.md') return true;
        return false;
      });
      mockListVaultFiles.mockReturnValue([]);
      mockGetQueue.mockReturnValue([
        { source: 'pages/playbook.md', addedAt: '2026-04-15T00:00:00Z', guidance: 'test' },
      ]);

      const result = await seedKB(
        [{ path: 'pages/playbook.md', guidance: 'test' }],
      );

      expect(result.skippedAlreadyIngested).toBe(0);
      expect(result.enqueued).toBe(1);
      expect(mockEnqueue).toHaveBeenCalledWith('pages/playbook.md', 'test');
    });

    it('enqueues files not yet in raw/', async () => {
      mockVaultFileExists.mockImplementation((path: string) => {
        if (path === 'pages/playbook.md') return true;
        return false; // not in raw/
      });
      mockListVaultFiles.mockReturnValue([]);

      const result = await seedKB(
        [{ path: 'pages/playbook.md', guidance: 'test' }],
      );

      expect(result.skippedAlreadyIngested).toBe(0);
      expect(result.enqueued).toBe(1);
    });
  });

  describe('--force flag', () => {
    it('re-enqueues files even when they exist in raw/ and are not in queue', async () => {
      mockVaultFileExists.mockImplementation((path: string) => {
        if (path === 'pages/playbook.md') return true;
        if (path === 'knowledge/raw/notes/playbook.md') return true;
        return false;
      });
      mockListVaultFiles.mockReturnValue([]);

      const result = await seedKB(
        [{ path: 'pages/playbook.md', guidance: 'test' }],
        undefined,
        { force: true },
      );

      expect(result.skippedAlreadyIngested).toBe(0);
      expect(result.enqueued).toBe(1);
      expect(mockEnqueue).toHaveBeenCalledWith('pages/playbook.md', 'test');
    });

    it('force dry-run shows all files would be enqueued', async () => {
      mockVaultFileExists.mockImplementation((path: string) => {
        if (path === 'pages/playbook.md') return true;
        if (path === 'knowledge/raw/notes/playbook.md') return true;
        return false;
      });
      mockListVaultFiles.mockReturnValue([]);

      const messages: string[] = [];
      const result = await seedAndProcess(
        [{ path: 'pages/playbook.md', guidance: 'test' }],
        (msg) => messages.push(msg),
        { dryRun: true, force: true },
      );

      expect(result.seed.skippedAlreadyIngested).toBe(0);
      expect(result.seed.discovered).toBe(1);
    });
  });

  describe('directory source discovery', () => {
    it('discovers all files in a directory source', async () => {
      mockVaultFileExists.mockReturnValue(false);
      mockListVaultFiles.mockImplementation((dir: string) => {
        if (dir === 'world-view') return ['world-view/ai.md', 'world-view/crypto.md'];
        return [];
      });

      const result = await seedKB(
        [{ path: 'world-view', guidance: 'worldview essays' }],
      );

      expect(result.discovered).toBe(2);
      expect(result.enqueued).toBe(2);
    });
  });
});
