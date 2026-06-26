import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../config.js', () => ({
  default: { VAULT_DIR: '/test/vault', TIMEZONE: 'America/Chicago' },
}));

vi.mock('./ingest.js', () => ({ ingestSource: vi.fn() }));
vi.mock('./query.js', () => ({ queryKB: vi.fn() }));
vi.mock('./lint.js', () => ({ lintKB: vi.fn(async () => ({ report: 'lint clean' })) }));
vi.mock('./queue.js', () => ({
  getQueue: vi.fn(),
  dequeue: vi.fn(),
  // The real getPriority is a pure function; re-export a lightweight stub so
  // engine.ts's priority-of fallback for legacy entries returns 0 by default.
  getPriority: vi.fn((source: string) => {
    if (source.startsWith('world-view/') || source.startsWith('journals/')) return 100;
    if (source === 'pages/playbook.md') return 80;
    if (source.startsWith('projects/') && !source.startsWith('projects/archive/')) return 60;
    if (source.startsWith('Readwise/')) return 40;
    if (source.includes('conversation')) return 20;
    return 0;
  }),
}));
vi.mock('../vault/files.js', () => ({
  listVaultFiles: vi.fn(),
  readVaultFile: vi.fn(),
  appendVaultFile: vi.fn(),
}));

const { ingestSource } = await import('./ingest.js');
const { getQueue, dequeue } = await import('./queue.js');
const { listVaultFiles, readVaultFile, appendVaultFile } = await import('../vault/files.js');
const { lintKB } = await import('./lint.js');
const { processIngestionQueue, getKBStats, INGESTS_PER_CHECKPOINT } = await import('./engine.js');

const ingestMock = ingestSource as unknown as ReturnType<typeof vi.fn>;
const queueMock = getQueue as unknown as ReturnType<typeof vi.fn>;
const dequeueMock = dequeue as unknown as ReturnType<typeof vi.fn>;
const listMock = listVaultFiles as unknown as ReturnType<typeof vi.fn>;
const readMock = readVaultFile as unknown as ReturnType<typeof vi.fn>;
const lintMock = lintKB as unknown as ReturnType<typeof vi.fn>;
const appendMock = appendVaultFile as unknown as ReturnType<typeof vi.fn>;

describe('kb/engine', () => {
  beforeEach(() => vi.clearAllMocks());

  describe('processIngestionQueue', () => {
    const ZERO = { created: 0, updated: 0 };

    it('returns zeros when queue is empty', async () => {
      queueMock.mockReturnValue([]);
      expect(await processIngestionQueue()).toEqual({ processed: 0, errors: 0, created: 0, updated: 0, checkpoints: 0 });
      expect(ingestMock).not.toHaveBeenCalled();
    });

    it('processes all queued sources', async () => {
      queueMock.mockReturnValue([
        { source: 'raw/a.md', addedAt: '' },
        { source: 'raw/b.md', addedAt: '', guidance: 'focus on X' },
      ]);
      ingestMock.mockResolvedValue({ success: true, output: 'ok', counts: ZERO });

      expect(await processIngestionQueue()).toEqual({ processed: 2, errors: 0, created: 0, updated: 0, checkpoints: 0 });
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

      expect(await processIngestionQueue()).toEqual({ processed: 1, errors: 1, created: 0, updated: 0, checkpoints: 0 });
    });

    it('dequeues sources after successful ingest', async () => {
      queueMock.mockReturnValue([{ source: 'raw/a.md', addedAt: '' }]);
      ingestMock.mockResolvedValue({ success: true, output: 'ok', counts: ZERO });

      await processIngestionQueue();

      expect(dequeueMock).toHaveBeenCalledWith('raw/a.md');
    });

    it('dequeues sources flagged as permanent failures (e.g. missing file)', async () => {
      // Regression: a stuck `projects/rune.md` entry re-failed every nightly
      // because nothing dequeued it. ingestSource now flags missing-file
      // failures with `permanent: true` and the engine acts on that.
      queueMock.mockReturnValue([{ source: 'projects/ghost.md', addedAt: '' }]);
      ingestMock.mockResolvedValue({
        success: false,
        permanent: true,
        output: 'Source file not found: projects/ghost.md',
        counts: ZERO,
      });

      await processIngestionQueue();

      expect(dequeueMock).toHaveBeenCalledWith('projects/ghost.md');
    });

    it('keeps transient failures queued for retry', async () => {
      queueMock.mockReturnValue([{ source: 'raw/timeout.md', addedAt: '' }]);
      ingestMock.mockResolvedValue({
        success: false,
        output: 'agent crashed',
        counts: ZERO,
      });

      await processIngestionQueue();

      expect(dequeueMock).not.toHaveBeenCalled();
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
        checkpoints: 0,
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
        checkpoints: 0,
      });
    });

    it('processes queue in priority order (higher first)', async () => {
      queueMock.mockReturnValue([
        { source: 'Readwise/article.md', addedAt: '', priority: 40 },
        { source: 'world-view/ai.md', addedAt: '', priority: 100 },
        { source: 'projects/foo.md', addedAt: '', priority: 60 },
        { source: 'notes/scratch.md', addedAt: '', priority: 0 },
        { source: 'pages/playbook.md', addedAt: '', priority: 80 },
      ]);
      ingestMock.mockResolvedValue({ success: true, output: 'ok', counts: ZERO });

      await processIngestionQueue();

      const calledSources = ingestMock.mock.calls.map((c: unknown[]) => c[0]);
      expect(calledSources).toEqual([
        'world-view/ai.md',
        'pages/playbook.md',
        'projects/foo.md',
        'Readwise/article.md',
        'notes/scratch.md',
      ]);
    });

    it('preserves FIFO order within the same priority tier', async () => {
      // V8's Array.prototype.sort has been stable since Node 11. Two entries
      // at the same priority must run in their getQueue() order.
      queueMock.mockReturnValue([
        { source: 'world-view/first.md', addedAt: '2026-04-01', priority: 100 },
        { source: 'world-view/second.md', addedAt: '2026-04-02', priority: 100 },
        { source: 'world-view/third.md', addedAt: '2026-04-03', priority: 100 },
      ]);
      ingestMock.mockResolvedValue({ success: true, output: 'ok', counts: ZERO });
      await processIngestionQueue();
      const calledSources = ingestMock.mock.calls.map((c: unknown[]) => c[0]);
      expect(calledSources).toEqual([
        'world-view/first.md',
        'world-view/second.md',
        'world-view/third.md',
      ]);
    });

    it('falls back to getPriority(source) when priority field is absent on legacy entries', async () => {
      queueMock.mockReturnValue([
        { source: 'Readwise/old.md', addedAt: '' }, // no priority
        { source: 'world-view/new.md', addedAt: '' }, // no priority
      ]);
      ingestMock.mockResolvedValue({ success: true, output: 'ok', counts: ZERO });

      await processIngestionQueue();

      const calledSources = ingestMock.mock.calls.map((c: unknown[]) => c[0]);
      expect(calledSources).toEqual(['world-view/new.md', 'Readwise/old.md']);
    });

    it('triggers a checkpoint every 15 successful ingestions', async () => {
      expect(INGESTS_PER_CHECKPOINT).toBe(15);
      const entries = Array.from({ length: 30 }, (_, i) => ({
        source: `raw/s${i}.md`,
        addedAt: '',
      }));
      queueMock.mockReturnValue(entries);
      ingestMock.mockResolvedValue({ success: true, output: 'ok', counts: ZERO });

      const result = await processIngestionQueue();

      expect(result.checkpoints).toBe(2);
      expect(lintMock).toHaveBeenCalledTimes(2);
      expect(appendMock).toHaveBeenCalledTimes(2);
      // Each checkpoint line contains the [CHECKPOINT] marker with a stable shape.
      for (const call of appendMock.mock.calls) {
        const [rel, line] = call as [string, string];
        expect(rel).toBe('knowledge/log.md');
        expect(line).toMatch(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\] \[CHECKPOINT\] /);
      }
    });

    it('does NOT trigger a checkpoint when fewer than 15 successful ingestions', async () => {
      const entries = Array.from({ length: 14 }, (_, i) => ({
        source: `raw/s${i}.md`,
        addedAt: '',
      }));
      queueMock.mockReturnValue(entries);
      ingestMock.mockResolvedValue({ success: true, output: 'ok', counts: ZERO });

      const result = await processIngestionQueue();

      expect(result.checkpoints).toBe(0);
      expect(lintMock).not.toHaveBeenCalled();
      expect(appendMock).not.toHaveBeenCalled();
    });

    it('continues queue processing when a checkpoint itself fails', async () => {
      const entries = Array.from({ length: 16 }, (_, i) => ({
        source: `raw/s${i}.md`,
        addedAt: '',
      }));
      queueMock.mockReturnValue(entries);
      ingestMock.mockResolvedValue({ success: true, output: 'ok', counts: ZERO });
      lintMock.mockRejectedValueOnce(new Error('lint blew up'));

      const result = await processIngestionQueue();
      // All 16 entries still processed; checkpoint count is 0 because the
      // only checkpoint attempt threw.
      expect(result.processed).toBe(16);
      expect(result.checkpoints).toBe(0);
    });

    it('counts only SUCCESSFUL ingestions toward the checkpoint cadence', async () => {
      // 15 entries: every 3rd one fails. Only 10 succeed, so no checkpoint.
      const entries = Array.from({ length: 15 }, (_, i) => ({
        source: `raw/s${i}.md`,
        addedAt: '',
      }));
      queueMock.mockReturnValue(entries);
      for (let i = 0; i < entries.length; i++) {
        if (i % 3 === 2) {
          ingestMock.mockResolvedValueOnce({ success: false, output: 'err', counts: ZERO });
        } else {
          ingestMock.mockResolvedValueOnce({ success: true, output: 'ok', counts: ZERO });
        }
      }

      const result = await processIngestionQueue();
      expect(result.processed).toBe(10);
      expect(result.errors).toBe(5);
      expect(result.checkpoints).toBe(0);
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
