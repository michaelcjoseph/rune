import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../config.js', () => ({
  default: { VAULT_DIR: '/test/vault', TIMEZONE: 'America/Chicago' },
}));

vi.mock('../ai/claude.js', () => ({ runAgent: vi.fn() }));

const { runAgent } = await import('../ai/claude.js');
const { lintKB } = await import('./lint.js');

const agentMock = runAgent as unknown as ReturnType<typeof vi.fn>;

describe('kb/lint', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns health report on success', async () => {
    agentMock.mockResolvedValue({ text: 'All good', error: null });
    const result = await lintKB();
    expect(result).toEqual({ success: true, report: 'All good' });
  });

  it('uses wiki-linter agent', async () => {
    agentMock.mockResolvedValue({ text: 'ok', error: null });
    await lintKB();
    expect(agentMock).toHaveBeenCalledWith('wiki-linter', expect.any(String));
  });

  it('returns error when agent fails', async () => {
    agentMock.mockResolvedValue({ text: null, error: 'agent error' });
    const result = await lintKB();
    expect(result.success).toBe(false);
    expect(result.report).toContain('agent error');
  });
});
