import { afterEach, describe, expect, it } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { defaultRunCanonicalGit } from './canonical-git.js';
import { defaultRunGit } from './sandbox-runtime.js';
import {
  VALIDATION_COMPATIBLE_MODE_ENV,
  VALIDATION_COMPATIBLE_MODE_VALUE,
} from '../utils/validation-confinement.js';

const roots: string[] = [];
const originalToken = process.env['TELEGRAM_BOT_TOKEN'];
const originalCompatibleMode = process.env[VALIDATION_COMPATIBLE_MODE_ENV];

afterEach(() => {
  if (originalToken === undefined) delete process.env['TELEGRAM_BOT_TOKEN'];
  else process.env['TELEGRAM_BOT_TOKEN'] = originalToken;
  if (originalCompatibleMode === undefined) {
    delete process.env[VALIDATION_COMPATIBLE_MODE_ENV];
  } else {
    process.env[VALIDATION_COMPATIBLE_MODE_ENV] = originalCompatibleMode;
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('canonical Git security boundary', () => {
  it.each(['--local', '--worktree'])(
    'refuses a product-controlled %s clean filter before staging can execute it',
    async (scope) => {
      const repo = mkdtempSync(join(tmpdir(), 'canonical-git-filter-'));
      roots.push(repo);
      const leak = join(repo, 'leak.txt');
      const filter = join(repo, 'filter.sh');
      writeFileSync(
        filter,
        '#!/bin/sh\nprintf "%s" "${TELEGRAM_BOT_TOKEN-}" > "$1"\ncat\n',
      );
      chmodSync(filter, 0o755);
      writeFileSync(join(repo, '.gitattributes'), 'payload.txt filter=probe\n');
      writeFileSync(join(repo, 'payload.txt'), 'payload\n');
      await defaultRunGit(['init', '--initial-branch', 'main'], { cwd: repo });
      if (scope === '--worktree') {
        await defaultRunGit(['config', 'extensions.worktreeConfig', 'true'], { cwd: repo });
      }
      await defaultRunGit(['config', scope, 'filter.probe.clean', `${filter} ${leak}`], { cwd: repo });
      process.env['TELEGRAM_BOT_TOKEN'] = 'rune-parent-secret';

      await expect(defaultRunCanonicalGit(['add', '-A'], { cwd: repo })).rejects.toThrow(
        /refuses external repository drivers.*filter\.probe\.clean/i,
      );
      expect(existsSync(leak)).toBe(false);
    },
  );

  it('reuses inherited validation confinement while retaining Git-driver rejection', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'canonical-git-inherited-'));
    roots.push(repo);
    await defaultRunGit(['init', '--initial-branch', 'main'], { cwd: repo });
    writeFileSync(join(repo, 'payload.txt'), 'payload\n');
    await defaultRunGit(
      ['config', '--local', 'diff.probe.textconv', '/usr/bin/false'],
      { cwd: repo },
    );
    process.env[VALIDATION_COMPATIBLE_MODE_ENV] =
      VALIDATION_COMPATIBLE_MODE_VALUE;

    await expect(
      defaultRunCanonicalGit(['add', '-A'], { cwd: repo }),
    ).rejects.toThrow(/refuses external repository drivers.*diff\.probe\.textconv/i);
  });
});
