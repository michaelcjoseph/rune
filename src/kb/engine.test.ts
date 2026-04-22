import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../config.js', () => ({
  default: { VAULT_DIR: '/test/vault', TIMEZONE: 'America/Chicago' },
}));

vi.mock('./ingest.js', () => ({ ingestSource: vi.fn() }));
vi.mock('./query.js', () => ({ queryKB: vi.fn() }));
vi.mock('./lint.js', () => ({ lintKB: vi.fn() }));
vi.mock('./queue.js', () => ({ getQueue: vi.fn() }));
vi.mock('../vault/files.js', () => ({
  listVaultFiles: vi.fn(),
  readVaultFile: vi.fn(),
}));

const { ingestSource } = await import('./ingest.js');
const { getQueue } = await import('./queue.js');
const { listVaultFiles, readVaultFile } = await import('../vault/files.js');
const { processIngestionQueue, getKBStats } = await import('./engine.js');

const ingestMock = ingestSource as unknown as ReturnType<typeof vi.fn>;
const queueMock = getQueue as unknown as ReturnType<typeof vi.fn>;
const listMock = listVaultFiles as unknown as ReturnType<typeof vi.fn>;
const readMock = readVaultFile as unknown as ReturnType<typeof vi.fn>;

describe('kb/engine', () => {
  beforeEach(() => vi.clearAllMocks());

  describe('processIngestionQueue', () => {
    const ZERO = { created: 0, updated: 0 };

    it('returns zeros when queue is empty', async () => {
      queueMock.mockReturnValue([]);
      expect(await processIngestionQueue()).toEqual({ processed: 0, errors: 0, created: 0, updated: 0 });
      expect(ingestMock).not.toHaveBeenCalled();
    });

    it('processes all queued sources', async () => {
      queueMock.mockReturnValue([
        { source: 'raw/a.md', addedAt: '' },
        { source: 'raw/b.md', addedAt: '', guidance: 'focus on X' },
      ]);
      ingestMock.mockResolvedValue({ success: true, output: 'ok', counts: ZERO });

      expect(await processIngestionQueue()).toEqual({ processed: 2, errors: 0, created: 0, updated: 0 });
      expect(ingestMock).toHaveBeenCalledWith('raw/b.md', { guidance: 'focus on X' });
    });

    it('counts errors separately', async () => {
      queueMock.mockReturnValue([
        { source: 'raw/good.md', addedAt: '' },
        { source: 'raw/bad.md', addedAt: '' },
      ]);
      ingestMock
        .mockResolvedValueOnce({ success: true, output: 'ok', counts: ZERO })
        .mockResolvedValueOnce({ success: false, output: 'failed', counts: ZERO });

      expect(await processIngestionQueue()).toEqual({ processed: 1, errors: 1, created: 0, updated: 0 });
    });

    it('aggregates created and updated counts across queued sources', async () => {
      queueMock.mockReturnValue([
        { source: 'raw/a.md', addedAt: '' },
        { source: 'raw/b.md', addedAt: '' },
        { source: 'raw/c.md', addedAt: '' },
      ]);
      ingestMock
        .mockResolvedValueOnce({ success: true, output: 'ok', counts: { created: 2, updated: 1 } })
        .mockResolvedValueOnce({ success: true, output: 'ok', counts: { created: 0, updated: 3 } })
        .mockResolvedValueOnce({ success: true, output: 'ok', counts: { created: 1, updated: 0 } });

      expect(await processIngestionQueue()).toEqual({
        processed: 3,
        errors: 0,
        created: 3,
        updated: 4,
      });
    });

    it('still includes counts from failed ingests (e.g., boundary violations)', async () => {
      queueMock.mockReturnValue([
        { source: 'raw/good.md', addedAt: '' },
        { source: 'raw/violation.md', addedAt: '' },
      ]);
      ingestMock
        .mockResolvedValueOnce({ success: true, output: 'ok', counts: { created: 2, updated: 0 } })
        .mockResolvedValueOnce({ success: false, output: 'boundary violation', counts: { created: 1, updated: 0 } });

      expect(await processIngestionQueue()).toEqual({
        processed: 1,
        errors: 1,
        created: 3,
        updated: 0,
      });
    });
  });

  describe('getKBStats', () => {
    it('counts pages by category', () => {
      listMock.mockImplementation((dir: string) => {
        if (dir.includes('entities')) return ['a.md', 'b.md'];
        if (dir.includes('concepts')) return ['c.md'];
        if (dir.includes('topics')) return ['d.md', 'e.md', 'f.md'];
        return [];
      });
      readMock.mockReturnValue('');

      const stats = getKBStats();
      expect(stats.entities).toBe(2);
      expect(stats.concepts).toBe(1);
      expect(stats.topics).toBe(3);
      expect(stats.comparisons).toBe(0);
      expect(stats.totalPages).toBe(6);
    });

    it('extracts recent log entries starting with [', () => {
      listMock.mockReturnValue([]);
      readMock.mockReturnValue(
        '# Log\n\n[2026-04-01] [INGEST] Added file\n[2026-04-02] [QUERY] Asked\nNot a log line\n',
      );

      const stats = getKBStats();
      expect(stats.recentLog).toHaveLength(2);
      expect(stats.recentLog[0]).toContain('INGEST');
    });

    it('handles missing log file', () => {
      listMock.mockReturnValue([]);
      readMock.mockReturnValue(null);
      expect(getKBStats().recentLog).toEqual([]);
    });
  });
});
