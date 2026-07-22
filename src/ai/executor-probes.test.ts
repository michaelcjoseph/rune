import { describe, expect, it } from 'vitest';
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { probeClaudeModelCall } from './claude.js';
import { probeCodexModelCall } from './codex.js';

describe('centralized executor probes', () => {
  it('contains Codex host reads and removes its private runtime', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-probe-containment-'));
    const binary = join(dir, 'codex-fixture');
    const home = join(dir, 'home');
    const codexHome = join(dir, 'codex-home');
    const secret = join(home, 'secret');
    const before = new Set((await readdir(tmpdir()))
      .filter((name) => name.startsWith('rune-codex-preflight-')));
    try {
      await mkdir(home);
      await mkdir(codexHome);
      await writeFile(join(codexHome, 'auth.json'), '{}');
      await writeFile(secret, 'private-host-value');
      await writeFile(binary, [
        '#!/bin/sh',
        `if /bin/cat '${secret}' >/dev/null 2>&1; then`,
        "  printf '%s\\n' '{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"OK\"}}'",
        'else',
        '  exit 7',
        'fi',
      ].join('\n'));
      await chmod(binary, 0o700);

      const result = await probeCodexModelCall({
        binaryPath: binary,
        cwd: dir,
        env: { PATH: '/usr/bin:/bin', HOME: home, CODEX_HOME: codexHome },
        timeoutMs: 2_000,
        model: 'fixture-model',
      });

      expect(result).toEqual({ ok: false, code: 'nonzero-exit' });
      const after = (await readdir(tmpdir()))
        .filter((name) => name.startsWith('rune-codex-preflight-'));
      expect(after.filter((name) => !before.has(name))).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns a stable Claude failure code without surfacing raw CLI output', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'claude-probe-diagnostic-'));
    const binary = join(dir, 'claude-fixture');
    try {
      await writeFile(binary, [
        '#!/bin/sh',
        "printf '%s\\n' 'sk-raw-secret /Users/operator/private' >&2",
        'exit 7',
      ].join('\n'));
      await chmod(binary, 0o700);

      const result = await probeClaudeModelCall({
        binaryPath: binary,
        cwd: dir,
        env: { PATH: '/usr/bin:/bin', HOME: dir },
        timeoutMs: 2_000,
        model: 'fixture-model',
      });

      expect(result).toEqual({ ok: false, code: 'nonzero-exit' });
      expect(JSON.stringify(result)).not.toContain('sk-raw-secret');
      expect(JSON.stringify(result)).not.toContain('/Users/operator');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
