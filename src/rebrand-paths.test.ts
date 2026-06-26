import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const oldName = ['ja', 'rvis'].join('');
const oldLogsEnv = ['JAR', 'VIS_LOGS_DIR'].join('');
const oldPrivateRoot = ['/Users', oldName, 'workspace', oldName].join('/');

function trackedSourceFiles(): string[] {
  return execFileSync('git', ['ls-files', 'src', 'scripts', 'cli', 'package.json'], {
    encoding: 'utf8',
  })
    .split('\n')
    .filter((file) => /\.(?:cjs|js|json|ts|tsx)$/.test(file));
}

describe('Phase 1 path env extraction', () => {
  it('has no code reader left on the stale logs env name', () => {
    const offenders = trackedSourceFiles().filter((file) => {
      const source = readFileSync(file, 'utf8');
      return source.includes(oldLogsEnv);
    });

    expect(offenders).toEqual([]);
  });

  it('removes private checkout paths from the known holdout files', () => {
    const holdouts = [
      'scripts/hooks/block-nonresponse.cjs',
      'src/server/static/product-deep-view-client.test.ts',
    ];

    const offenders = holdouts.filter((file) => {
      const source = readFileSync(file, 'utf8');
      return source.includes(oldPrivateRoot);
    });

    expect(offenders).toEqual([]);
  });

  it('routes the known holdout files through the new path env layer', () => {
    const holdouts = [
      'scripts/hooks/block-nonresponse.cjs',
      'src/server/static/product-deep-view-client.test.ts',
    ];

    const offenders = holdouts.filter((file) => {
      const source = readFileSync(file, 'utf8');
      return !source.includes('RUNE_');
    });

    expect(offenders).toEqual([]);
  });
});
