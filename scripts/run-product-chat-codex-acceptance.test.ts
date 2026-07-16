import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const OPT_IN = 'RUNE_ACCEPTANCE_LIVE_CODEX_PRODUCT_CHAT';

describe('live Codex product-chat acceptance harness', () => {
  it('fails before making live model calls unless explicitly opted in', () => {
    const env = { ...process.env };
    delete env[OPT_IN];

    const result = spawnSync(
      process.execPath,
      [
        '--import',
        './scripts/register-ts.mjs',
        join('scripts', 'run-product-chat-codex-acceptance.ts'),
      ],
      {
        cwd: PROJECT_ROOT,
        env,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    const output = `${result.stdout}\n${result.stderr}`;
    expect(result.status).not.toBe(0);
    expect(output).toContain(
      `live Codex acceptance is opt-in; set ${OPT_IN}=1`,
    );
    expect(output).not.toContain('[product-chat-codex:resolved]');
  });
});
