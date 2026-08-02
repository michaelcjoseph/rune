import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { PROJECT_ROOT } from './config.js';
import { repoRelativeFiles } from './test/repo-files.js';

const oldName = ['ja', 'rvis'].join('');
const oldLogsEnv = ['JAR', 'VIS_LOGS_DIR'].join('');
const oldPrivateRoot = ['/Users', oldName, 'workspace', oldName].join('/');

/**
 * Walk rather than `git ls-files`: the trusted Vitest observer runs this suite
 * against a materialized reviewed tree with no `.git`, where shelling out to git
 * throws. The walk is a superset of the tracked set, which is what this
 * "no offender exists" assertion wants anyway.
 */
function scannedSourceFiles(): string[] {
  return [...repoRelativeFiles(['src', 'scripts', 'cli']), 'package.json']
    .filter((file) => /\.(?:cjs|js|json|ts|tsx)$/.test(file));
}

describe('Phase 1 path env extraction', () => {
  it('has no code reader left on the stale logs env name', () => {
    const offenders = scannedSourceFiles().filter((file) => {
      const source = readFileSync(join(PROJECT_ROOT, file), 'utf8');
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
      const source = readFileSync(join(PROJECT_ROOT, file), 'utf8');
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
      const source = readFileSync(join(PROJECT_ROOT, file), 'utf8');
      return !source.includes('RUNE_');
    });

    expect(offenders).toEqual([]);
  });
});
