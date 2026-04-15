import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../config.js', () => ({
  default: { VAULT_DIR: '/test/vault', TIMEZONE: 'America/Chicago' },
}));

const mockExecFile = vi.fn().mockResolvedValue({ stdout: '', stderr: '' });

vi.mock('node:child_process', () => ({
  execFile: mockExecFile,
}));

vi.mock('node:util', () => ({
  promisify: (fn: any) => fn,
}));

const { gitCommitAndPush } = await import('./git.js');

describe('vault/git', () => {
  beforeEach(() => {
    mockExecFile.mockReset();
    mockExecFile.mockResolvedValue({ stdout: '', stderr: '' });
  });

  it('runs add, commit, push on success', async () => {
    await gitCommitAndPush('test commit');
    expect(mockExecFile).toHaveBeenCalledTimes(3);
    expect(mockExecFile).toHaveBeenNthCalledWith(1, 'git', ['add', '-A'], expect.objectContaining({ cwd: '/test/vault' }));
    expect(mockExecFile).toHaveBeenNthCalledWith(2, 'git', ['commit', '-m', 'test commit'], expect.any(Object));
    expect(mockExecFile).toHaveBeenNthCalledWith(3, 'git', ['push'], expect.any(Object));
  });

  it('skips push silently when nothing to commit', async () => {
    let call = 0;
    mockExecFile.mockImplementation(async () => {
      if (++call === 2) {
        const err = new Error('nothing to commit') as any;
        err.stderr = 'nothing to commit, working tree clean';
        throw err;
      }
      return { stdout: '', stderr: '' };
    });

    await gitCommitAndPush('test');
    expect(mockExecFile).toHaveBeenCalledTimes(2); // add + commit, no push
  });

  it('skips push on unexpected commit error', async () => {
    let call = 0;
    mockExecFile.mockImplementation(async () => {
      if (++call === 2) {
        const err = new Error('lock') as any;
        err.stderr = 'fatal: lock file exists';
        throw err;
      }
      return { stdout: '', stderr: '' };
    });

    await gitCommitAndPush('test');
    expect(mockExecFile).toHaveBeenCalledTimes(2);
  });

  it('handles push failure gracefully', async () => {
    let call = 0;
    mockExecFile.mockImplementation(async () => {
      if (++call === 3) throw new Error('remote rejected');
      return { stdout: '', stderr: '' };
    });

    await expect(gitCommitAndPush('test')).resolves.toBeUndefined();
    expect(mockExecFile).toHaveBeenCalledTimes(3);
  });
});
