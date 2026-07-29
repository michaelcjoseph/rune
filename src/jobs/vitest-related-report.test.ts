import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PROJECT_ROOT } from '../config.js';
import { diagnoseRelatedTestResult } from './related-test-diagnostic.js';
import {
  MAX_VITEST_ERROR_MESSAGE_CHARS,
  parseVitestRelatedReport,
} from './vitest-related-report.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'vitest-related-report-test-'));
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

function writeReport(name: string, report: unknown): string {
  const path = join(root, name);
  writeFileSync(path, JSON.stringify(report), 'utf8');
  return path;
}

function diagnoseParsed(path: string) {
  const parsed = parseVitestRelatedReport(path, root);
  if (parsed === undefined) return undefined;
  return diagnoseRelatedTestResult({
    selectedPaths: ['src/feature.ts'],
    argv: ['npx', 'vitest', 'related', '--run', 'src/feature.ts'],
    validationCwd: '.',
    result: {
      exitCode: 1,
      timedOut: false,
      outputTail: '',
      diagnosticArtifacts: [],
      structuredErrors: parsed.errors,
      structuredErrorsTotal: parsed.total,
      structuredErrorsComplete: parsed.complete,
    },
  });
}

async function parseInChildWithDeadline(
  reportPath: string,
  deadlineMs = 750,
): Promise<{ timedOut: boolean; stdout: string; code: number | null }> {
  const source = [
    `const mod=await import('./src/jobs/vitest-related-report.ts');`,
    `const result=mod.parseVitestRelatedReport(${JSON.stringify(reportPath)},${JSON.stringify(root)});`,
    `process.stdout.write(result===undefined?'undefined':JSON.stringify(result));`,
  ].join('');
  return await new Promise((resolve) => {
    const child = spawn(process.execPath, [
      '--import',
      './scripts/register-ts.mjs',
      '--input-type=module',
      '-e',
      source,
    ], {
      cwd: PROJECT_ROOT,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let stdout = '';
    let settled = false;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      resolve({ timedOut: true, stdout, code: null });
    }, deadlineMs);
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ timedOut: false, stdout, code });
    });
  });
}

describe('bounded Vitest related report parser security boundary', () => {
  it.each(['passed', 'pending', 'skipped', 'todo'])(
    'keeps a supported host conflict complete when another assertion is %s',
    (nonFailureStatus) => {
      const path = writeReport(`non-failure-${nonFailureStatus}.json`, {
        testResults: [{
          name: join(root, 'src', 'server.test.ts'),
          status: 'failed',
          assertionResults: [
            {
              fullName: `${nonFailureStatus} coverage`,
              status: nonFailureStatus,
              failureMessages: [],
            },
            {
              fullName: 'starts a loopback fixture',
              status: 'failed',
              failureMessages: [
                'listen EPERM: operation not permitted 127.0.0.1',
              ],
            },
          ],
        }],
      });
      const parsed = parseVitestRelatedReport(path, root);

      expect(parsed).toMatchObject({
        complete: true,
        total: 1,
        errors: [expect.objectContaining({
          message: 'listen EPERM: operation not permitted 127.0.0.1',
        })],
      });
      expect(diagnoseParsed(path)?.state)
        .toBe('related-validation-host-conflict');
    },
  );

  it.runIf(process.platform === 'darwin' || process.platform === 'linux')(
    'rejects a FIFO promptly instead of blocking on product-controlled special-file input',
    async () => {
      const fifo = join(root, 'report.json');
      execFileSync('mkfifo', [fifo]);

      const result = await parseInChildWithDeadline(fifo);

      expect(result).toEqual({ timedOut: false, stdout: 'undefined', code: 0 });
    },
    5_000,
  );

  it('rejects symlinked and other non-regular report paths', () => {
    const target = writeReport('target.json', {
      testResults: [{
        name: join(root, 'src', 'server.test.ts'),
        status: 'failed',
        message: 'listen EPERM: operation not permitted 127.0.0.1',
      }],
    });
    const symlink = join(root, 'symlink.json');
    symlinkSync(target, symlink);
    const directory = join(root, 'directory.json');
    mkdirSync(directory);

    expect(parseVitestRelatedReport(symlink, root)).toBeUndefined();
    expect(parseVitestRelatedReport(directory, root)).toBeUndefined();
  });

  it('redacts secrets and host paths before applying field truncation', () => {
    const secret = '123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi';
    vi.stubEnv('TELEGRAM_BOT_TOKEN', secret);
    const secretBoundary = 's'.repeat(MAX_VITEST_ERROR_MESSAGE_CHARS - 10) + secret;
    const pathBoundary =
      'p'.repeat(MAX_VITEST_ERROR_MESSAGE_CHARS - 10) + PROJECT_ROOT + '/private.ts';
    const path = writeReport('boundary.json', {
      testResults: [{
        name: join(root, 'src', 'boundary.test.ts'),
        status: 'failed',
        assertionResults: [{
          fullName: 'does not leak at a truncation boundary',
          status: 'failed',
          failureMessages: [secretBoundary, pathBoundary],
        }],
      }],
    });

    const parsed = parseVitestRelatedReport(path, root);
    const serialized = JSON.stringify(parsed);

    expect(parsed?.complete).toBe(false);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain('123456789:');
    expect(serialized).not.toContain(PROJECT_ROOT);
    expect(serialized).not.toContain(PROJECT_ROOT.slice(0, 10));
  });

  it.each([
    {
      label: 'malformed testResults entry',
      testResults: [
        null,
        {
          name: 'src/server.test.ts',
          status: 'failed',
          message: 'listen EPERM: operation not permitted 127.0.0.1',
        },
      ],
    },
    {
      label: 'non-array assertionResults',
      testResults: [{
        name: 'src/server.test.ts',
        status: 'failed',
        message: 'listen EPERM: operation not permitted 127.0.0.1',
        assertionResults: { malformed: true },
      }],
    },
    {
      label: 'malformed assertionResults entry',
      testResults: [{
        name: 'src/server.test.ts',
        status: 'failed',
        message: 'listen EPERM: operation not permitted 127.0.0.1',
        assertionResults: [null],
      }],
    },
    {
      label: 'non-string failureMessages entry',
      testResults: [{
        name: 'src/server.test.ts',
        status: 'failed',
        assertionResults: [{
          fullName: 'starts the server',
          status: 'failed',
          failureMessages: [
            { malformed: true },
            'listen EPERM: operation not permitted 127.0.0.1',
          ],
        }],
      }],
    },
  ])('marks $label incomplete so host-conflict classification fails closed', ({
    testResults,
  }) => {
    const path = writeReport('malformed-nested.json', { testResults });
    const parsed = parseVitestRelatedReport(path, root);

    expect(parsed?.complete).toBe(false);
    expect(diagnoseParsed(path)?.state).toBe('related-test-failure');
  });
});
