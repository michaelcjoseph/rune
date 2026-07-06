import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

describe('scripts/register-ts.mjs', () => {
  it('loads TypeScript through registerHooks without module.register deprecations', () => {
    const result = spawnSync(
      process.execPath,
      [
        '--trace-deprecation',
        '--import',
        './scripts/register-ts.mjs',
        'scripts/fixtures/register-ts-entry.ts',
      ],
      {
        cwd: PROJECT_ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('loader-ok:42:register-ts-entry.ts');
    expect(result.stderr).not.toContain('DEP0205');
    expect(result.stderr).not.toContain('module.register()');
    expect(result.stderr).not.toMatch(/registerHooks.*(?:invalid|error|misuse)/i);
  });
});
