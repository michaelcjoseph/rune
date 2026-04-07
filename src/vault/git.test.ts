import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../config.js', () => ({
  default: { VAULT_DIR: '/test/vault', TIMEZONE: 'America/Chicago' },
}));

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

const { execFileSync } = await import('node:child_process');
const { gitCommitAndPush } = await import('./git.js');

const execMock = execFileSync as unknown as ReturnType<typeof vi.fn>;

describe('vault/git', () => {
  beforeEach(() => {
    execMock.mockReset();
  });

  it('runs add, commit, push on success', () => {
    gitCommitAndPush('test commit');
    expect(execMock).toHaveBeenCalledTimes(3);
    expect(execMock).toHaveBeenNthCalledWith(1, 'git', ['add', '-A'], expect.objectContaining({ cwd: '/test/vault' }));
    expect(execMock).toHaveBeenNthCalledWith(2, 'git', ['commit', '-m', 'test commit'], expect.any(Object));
    expect(execMock).toHaveBeenNthCalledWith(3, 'git', ['push'], expect.any(Object));
  });

  it('skips push silently when nothing to commit', () => {
    let call = 0;
    execMock.mockImplementation(() => {
      if (++call === 2) {
        const err = new Error('nothing to commit') as any;
        err.stderr = Buffer.from('nothing to commit, working tree clean');
        throw err;
      }
      return Buffer.from('');
    });

    gitCommitAndPush('test');
    expect(execMock).toHaveBeenCalledTimes(2); // add + commit, no push
  });

  it('skips push on unexpected commit error', () => {
    let call = 0;
    execMock.mockImplementation(() => {
      if (++call === 2) {
        const err = new Error('lock') as any;
        err.stderr = Buffer.from('fatal: lock file exists');
        throw err;
      }
      return Buffer.from('');
    });

    gitCommitAndPush('test');
    expect(execMock).toHaveBeenCalledTimes(2);
  });

  it('handles push failure gracefully', () => {
    let call = 0;
    execMock.mockImplementation(() => {
      if (++call === 3) throw new Error('remote rejected');
      return Buffer.from('');
    });

    expect(() => gitCommitAndPush('test')).not.toThrow();
    expect(execMock).toHaveBeenCalledTimes(3);
  });
});
