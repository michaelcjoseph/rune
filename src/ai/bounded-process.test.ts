import { describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runBoundedProcess } from './bounded-process.js';

async function processIsTerminated(pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      const state = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'state='], {
        encoding: 'utf8',
      }).trim();
      if (state.startsWith('Z')) return true;
    } catch { return true; }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

describe('runBoundedProcess', () => {
  it('SIGKILLs a stubborn detached grandchild and unregisters the leader after timeout', async () => {
    if (process.platform === 'win32') return;
    const dir = await mkdtemp(join(tmpdir(), 'bounded-process-test-'));
    const script = join(dir, 'stubborn.sh');
    const register = vi.fn();
    const unregister = vi.fn();
    try {
      await writeFile(script, [
        '#!/bin/sh',
        "trap '' TERM",
        "/bin/sh -c 'trap \"\" TERM; while :; do /bin/sleep 1; done' &",
        'printf \'%s\\n\' "$!"',
        'while :; do /bin/sleep 1; done',
      ].join('\n'));
      await chmod(script, 0o700);

      const result = await runBoundedProcess(script, [], {
        cwd: dir,
        env: { PATH: '/usr/bin:/bin' },
        timeoutMs: 50,
        reapGraceMs: 50,
        register,
        unregister,
      });

      expect(result.status).toBe('timed-out');
      expect(register).toHaveBeenCalledOnce();
      expect(unregister).toHaveBeenCalledOnce();
      const grandchildPid = Number(result.status === 'timed-out' ? result.stdout.trim() : '');
      expect(Number.isSafeInteger(grandchildPid)).toBe(true);
      expect(await processIsTerminated(grandchildPid)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('bounds retained stdout and stderr tails', async () => {
    const result = await runBoundedProcess('/bin/sh', [
      '-c',
      "printf '123456789'; printf 'abcdefghi' >&2",
    ], {
      cwd: tmpdir(),
      env: { PATH: '/usr/bin:/bin' },
      timeoutMs: 1_000,
      outputLimitBytes: 5,
    });

    expect(result).toMatchObject({
      status: 'completed',
      stdout: '56789',
      stderr: 'efghi',
    });
  });
});
