import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../config.js', () => ({
  default: { VAULT_DIR: '/test/vault', TIMEZONE: 'America/Chicago' },
}));

vi.mock('../ai/claude.js', () => ({ runAgent: vi.fn() }));
vi.mock('../vault/files.js', () => ({
  readVaultFile: vi.fn(),
  writeVaultFile: vi.fn(),
  vaultFileExists: vi.fn(),
  getVaultPath: vi.fn((p: string) => `/test/vault/${p}`),
}));
vi.mock('./queue.js', () => ({ dequeue: vi.fn() }));
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return { ...actual, copyFileSync: vi.fn(), mkdirSync: vi.fn() };
});

const { runAgent } = await import('../ai/claude.js');
const { readVaultFile, vaultFileExists } = await import('../vault/files.js');
const { dequeue } = await import('./queue.js');
const { copyFileSync } = await import('node:fs');
const { ingestSource } = await import('./ingest.js');

const agentMock = runAgent as unknown as ReturnType<typeof vi.fn>;
const readMock = readVaultFile as unknown as ReturnType<typeof vi.fn>;
const existsMock = vaultFileExists as unknown as ReturnType<typeof vi.fn>;
const dequeueMock = dequeue as unknown as ReturnType<typeof vi.fn>;
const copyMock = copyFileSync as unknown as ReturnType<typeof vi.fn>;

describe('kb/ingest', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    existsMock.mockReturnValue(false);
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
    expect(agentMock).toHaveBeenCalledWith('wiki-compiler', expect.stringContaining('notes/test.md'));
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
    expect(agentMock).toHaveBeenCalledWith('wiki-compiler', expect.stringContaining('focus on APIs'));
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
});
