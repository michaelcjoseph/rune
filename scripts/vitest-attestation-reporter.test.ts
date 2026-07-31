import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// @ts-expect-error JavaScript reporter has no declaration file by design.
import ReporterImplementation from './vitest-attestation-reporter.mjs';

type TestState = 'passed' | 'failed' | 'pending' | 'skipped';

interface ReporterInstance {
  onTestModuleCollected(module: unknown): void;
  onTestRunEnd(modules: unknown[], errors: unknown[], reason: string): void;
}

type ReporterConstructor = new (options?: {
  output?: string;
  capability?: string;
  root?: string;
}) => ReporterInstance;

const Reporter = ReporterImplementation as unknown as ReporterConstructor;

function testCase(state: TestState, mode: 'run' | 'skip' | 'todo' = 'run') {
  return {
    name: '/Users/operator/private/secret test name',
    options: { mode },
    result: () => ({ state }),
  };
}

function moduleFixture(
  id: string,
  tests: ReturnType<typeof testCase>[],
  errors: unknown[] = [],
  state = 'passed',
  suites: Array<{ state(): string; name?: string }> = [],
) {
  return {
    moduleId: id,
    state: () => state,
    errors: () => errors,
    children: {
      allTests: () => tests,
      allSuites: () => suites,
    },
  };
}

let dir: string;
let output: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rune-vitest-reporter-test-'));
  output = join(dir, 'manifest.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function makeReporter(): ReporterInstance {
  return new Reporter({
    output,
    capability: 'a'.repeat(64),
  });
}

function readManifest(): Record<string, unknown> {
  const envelope = JSON.parse(readFileSync(output, 'utf8')) as Record<string, unknown>;
  expect(envelope['authentication']).toMatch(/^[0-9a-f]{64}$/);
  return envelope['manifest'] as Record<string, unknown>;
}

describe('trusted Vitest attestation reporter lifecycle', () => {
  it('rejects collected modules outside its reviewed-tree root', () => {
    const root = join(dir, 'reviewed');
    const outside = join(dir, 'outside.test.js');
    const inside = join(root, 'inside.test.js');
    mkdirSync(root);
    writeFileSync(inside, '');
    writeFileSync(outside, '');
    const reporter = new Reporter({
      output,
      capability: 'a'.repeat(64),
      root,
    });

    reporter.onTestModuleCollected(moduleFixture(inside, [testCase('passed')]));
    expect(() =>
      reporter.onTestModuleCollected(moduleFixture(outside, [testCase('passed')]))
    ).toThrow(/escaped/);
  });

  it('records discovery separately from reconciled completion buckets', () => {
    const passing = moduleFixture('/Users/operator/private/a.test.ts', [
      testCase('passed'),
      testCase('skipped', 'skip'),
      testCase('skipped', 'todo'),
    ]);
    const failing = moduleFixture('/Users/operator/private/b.test.ts', [
      testCase('failed'),
      testCase('pending'),
    ]);
    const reporter = makeReporter();
    reporter.onTestModuleCollected(passing);
    reporter.onTestModuleCollected(failing);
    reporter.onTestRunEnd([passing, failing], [], 'passed');

    const manifest = readManifest();
    expect(manifest).toEqual({
      version: 1,
      runner: 'vitest',
      completedNormally: true,
      collectionErrors: 0,
      discovered: { suites: 2, tests: 5 },
      completed: {
        suites: 2,
        tests: 5,
        passed: 1,
        failed: 1,
        skipped: 1,
        todo: 1,
        cancelled: 1,
      },
    });
  });

  it('counts nested suites from lifecycle data without persisting their names', () => {
    const module = moduleFixture(
      '/Users/operator/private/nested.test.ts',
      [testCase('passed')],
      [],
      'passed',
      [
        { name: 'private nested suite', state: () => 'passed' },
        { name: 'TOKEN-secret nested suite', state: () => 'passed' },
      ],
    );
    const reporter = makeReporter();
    reporter.onTestModuleCollected(module);
    reporter.onTestRunEnd([module], [], 'passed');

    const raw = readFileSync(output, 'utf8');
    expect(JSON.parse(raw)).toMatchObject({
      manifest: {
      discovered: { suites: 3, tests: 1 },
      completed: { suites: 3, tests: 1, passed: 1 },
      },
    });
    expect(raw).not.toContain('private nested suite');
    expect(raw).not.toContain('TOKEN-secret');
  });

  it('makes interruption, collection errors, and partial completion explicit', () => {
    const collected = moduleFixture('collected.test.ts', [testCase('passed'), testCase('passed')]);
    const partial = moduleFixture('collected.test.ts', [testCase('passed')], [new Error('collection failed')]);
    const reporter = makeReporter();
    reporter.onTestModuleCollected(collected);
    reporter.onTestRunEnd([partial], [new Error('unhandled')], 'interrupted');

    expect(readManifest()).toMatchObject({
      completedNormally: false,
      collectionErrors: 2,
      discovered: { suites: 1, tests: 2 },
      completed: { suites: 1, tests: 1, passed: 1, cancelled: 0 },
    });
  });

  it('never writes test names, file paths, errors, environment, or secret-shaped data', () => {
    const module = moduleFixture(
      '/Users/operator/private/TOKEN-secret.test.ts',
      [testCase('failed')],
      [new Error('TELEGRAM_BOT_TOKEN=supersecret')],
    );
    const reporter = makeReporter();
    reporter.onTestModuleCollected(module);
    reporter.onTestRunEnd([module], [new Error('/private/tmp/secret')], 'passed');

    const raw = readFileSync(output, 'utf8');
    expect(raw).not.toContain('/Users/');
    expect(raw).not.toContain('/private/tmp');
    expect(raw).not.toContain('secret test name');
    expect(raw).not.toContain('TELEGRAM_BOT_TOKEN');
    expect(raw.length).toBeLessThan(2_000);
  });

  it('keeps reporter authentication material in private instance fields', () => {
    const reporter = makeReporter() as unknown as Record<string, unknown>;
    expect(reporter['output']).toBeUndefined();
    expect(reporter['capability']).toBeUndefined();
    expect(Object.keys(reporter)).not.toContain('output');
    expect(Object.keys(reporter)).not.toContain('capability');
  });
});
