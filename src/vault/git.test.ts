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

const { gitCommitAndPush, gitCommitAndPushOrThrow } = await import('./git.js');

// The first git call in gitCommitAndPush is the branch guard (rev-parse). By
// default return 'main' so the happy path proceeds; individual tests override.
function onBranch(branch: string) {
  mockExecFile.mockImplementation(async (_cmd: string, args: string[]) => {
    if (args[0] === 'rev-parse') return { stdout: `${branch}\n`, stderr: '' };
    return { stdout: '', stderr: '' };
  });
}

describe('vault/git', () => {
  beforeEach(() => {
    mockExecFile.mockReset();
    onBranch('main');
  });

  it('checks branch, then runs add, commit, push on success', async () => {
    await gitCommitAndPush('test commit');
    expect(mockExecFile).toHaveBeenCalledTimes(4);
    expect(mockExecFile).toHaveBeenNthCalledWith(1, 'git', ['rev-parse', '--abbrev-ref', 'HEAD'], expect.objectContaining({ cwd: '/test/vault' }));
    expect(mockExecFile).toHaveBeenNthCalledWith(2, 'git', ['add', '-A'], expect.objectContaining({ cwd: '/test/vault' }));
    expect(mockExecFile).toHaveBeenNthCalledWith(3, 'git', ['commit', '-m', 'test commit'], expect.any(Object));
    expect(mockExecFile).toHaveBeenNthCalledWith(4, 'git', ['push'], expect.any(Object));
  });

  it('switches back to main before committing when on a stray branch', async () => {
    onBranch('feat/planning-recovery');
    await gitCommitAndPush('test commit');
    expect(mockExecFile).toHaveBeenNthCalledWith(1, 'git', ['rev-parse', '--abbrev-ref', 'HEAD'], expect.any(Object));
    expect(mockExecFile).toHaveBeenNthCalledWith(2, 'git', ['checkout', 'main'], expect.any(Object));
    expect(mockExecFile).toHaveBeenNthCalledWith(3, 'git', ['add', '-A'], expect.any(Object));
    expect(mockExecFile).toHaveBeenNthCalledWith(4, 'git', ['commit', '-m', 'test commit'], expect.any(Object));
    expect(mockExecFile).toHaveBeenNthCalledWith(5, 'git', ['push'], expect.any(Object));
  });

  it('refuses to commit if it cannot switch back to main', async () => {
    mockExecFile.mockImplementation(async (_cmd: string, args: string[]) => {
      if (args[0] === 'rev-parse') return { stdout: 'feat/stray\n', stderr: '' };
      if (args[0] === 'checkout') throw new Error('checkout conflict');
      return { stdout: '', stderr: '' };
    });
    await gitCommitAndPush('test commit');
    // rev-parse + failed checkout only; no add/commit/push
    expect(mockExecFile).toHaveBeenCalledTimes(2);
    expect(mockExecFile).not.toHaveBeenCalledWith('git', ['add', '-A'], expect.any(Object));
  });

  it('refuses to commit if the branch check itself fails', async () => {
    mockExecFile.mockImplementation(async (_cmd: string, args: string[]) => {
      if (args[0] === 'rev-parse') throw new Error('not a git repo');
      return { stdout: '', stderr: '' };
    });
    await gitCommitAndPush('test commit');
    expect(mockExecFile).toHaveBeenCalledTimes(1);
  });

  it('skips push silently when nothing to commit', async () => {
    mockExecFile.mockImplementation(async (_cmd: string, args: string[]) => {
      if (args[0] === 'rev-parse') return { stdout: 'main\n', stderr: '' };
      if (args[0] === 'commit') {
        const err = new Error('nothing to commit') as any;
        err.stderr = 'nothing to commit, working tree clean';
        throw err;
      }
      return { stdout: '', stderr: '' };
    });

    await gitCommitAndPush('test');
    expect(mockExecFile).toHaveBeenCalledTimes(3); // rev-parse + add + commit, no push
  });

  it('swallows unexpected commit error without pushing', async () => {
    mockExecFile.mockImplementation(async (_cmd: string, args: string[]) => {
      if (args[0] === 'rev-parse') return { stdout: 'main\n', stderr: '' };
      if (args[0] === 'commit') {
        const err = new Error('lock') as any;
        err.stderr = 'fatal: lock file exists';
        throw err;
      }
      return { stdout: '', stderr: '' };
    });

    await gitCommitAndPush('test');
    expect(mockExecFile).toHaveBeenCalledTimes(3);
  });

  it('handles push failure gracefully', async () => {
    mockExecFile.mockImplementation(async (_cmd: string, args: string[]) => {
      if (args[0] === 'rev-parse') return { stdout: 'main\n', stderr: '' };
      if (args[0] === 'push') throw new Error('remote rejected');
      return { stdout: '', stderr: '' };
    });

    await expect(gitCommitAndPush('test')).resolves.toBeUndefined();
    expect(mockExecFile).toHaveBeenCalledTimes(4);
  });
});

describe('vault/git — gitCommitAndPushOrThrow (strict variant)', () => {
  beforeEach(() => {
    mockExecFile.mockReset();
    onBranch('main');
  });

  it('resolves on the happy path (add, commit, push)', async () => {
    await expect(gitCommitAndPushOrThrow('strict commit')).resolves.toBe('pushed');
    expect(mockExecFile).toHaveBeenCalledTimes(4);
  });

  it('throws when not on main and checkout fails', async () => {
    mockExecFile.mockImplementation(async (_cmd: string, args: string[]) => {
      if (args[0] === 'rev-parse') return { stdout: 'feat/stray\n', stderr: '' };
      if (args[0] === 'checkout') throw new Error('checkout conflict');
      return { stdout: '', stderr: '' };
    });
    await expect(gitCommitAndPushOrThrow('strict')).rejects.toThrow(/not on main/);
    expect(mockExecFile).not.toHaveBeenCalledWith('git', ['add', '-A'], expect.any(Object));
  });

  it('throws on an unexpected commit error', async () => {
    mockExecFile.mockImplementation(async (_cmd: string, args: string[]) => {
      if (args[0] === 'rev-parse') return { stdout: 'main\n', stderr: '' };
      if (args[0] === 'commit') {
        const err = new Error('lock') as any;
        err.stderr = 'fatal: lock file exists';
        throw err;
      }
      return { stdout: '', stderr: '' };
    });
    await expect(gitCommitAndPushOrThrow('strict')).rejects.toThrow(/git commit failed/);
  });

  it('throws on push failure', async () => {
    mockExecFile.mockImplementation(async (_cmd: string, args: string[]) => {
      if (args[0] === 'rev-parse') return { stdout: 'main\n', stderr: '' };
      if (args[0] === 'push') throw new Error('remote rejected');
      return { stdout: '', stderr: '' };
    });
    await expect(gitCommitAndPushOrThrow('strict')).rejects.toThrow(/git push failed/);
  });

  it('resolves benignly on nothing-to-commit (no push attempted)', async () => {
    mockExecFile.mockImplementation(async (_cmd: string, args: string[]) => {
      if (args[0] === 'rev-parse') return { stdout: 'main\n', stderr: '' };
      if (args[0] === 'commit') {
        const err = new Error('nothing to commit') as any;
        err.stderr = 'nothing to commit, working tree clean';
        throw err;
      }
      return { stdout: '', stderr: '' };
    });
    await expect(gitCommitAndPushOrThrow('strict')).resolves.toBe('nothing-to-commit');
    expect(mockExecFile).toHaveBeenCalledTimes(3); // rev-parse + add + commit, no push
  });
});
