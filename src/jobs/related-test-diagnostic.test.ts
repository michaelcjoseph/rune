import { describe, expect, it } from 'vitest';

import { PROJECT_ROOT } from '../config.js';
import {
  diagnoseRelatedTestFallback,
  diagnoseRelatedTestResult,
  type DiagnoseRelatedTestInput,
} from './related-test-diagnostic.js';
import {
  collectRelatedTestTaskDiagnostics,
  isRelatedTestDiagnostic,
  RELATED_TEST_ARGUMENT_MAX_CHARS,
  RELATED_TEST_ARGUMENTS_TOTAL_MAX_CHARS,
  RELATED_TEST_STRUCTURED_ERRORS_MAX,
  RELATED_TEST_TASK_DIAGNOSTICS_MAX,
  type RelatedTestDiagnostic,
} from '../intent/related-test-diagnostic.js';

const argv = [
  'npx',
  'vitest',
  'related',
  '--run',
  '--passWithNoTests',
  'src/feature.ts',
];

function input(
  overrides: Partial<DiagnoseRelatedTestInput['result']> = {},
): DiagnoseRelatedTestInput {
  const structuredErrors = overrides.structuredErrors;
  return {
    selectedPaths: ['src/feature.ts'],
    argv,
    validationCwd: '.',
    result: {
      exitCode: 1,
      timedOut: false,
      outputHead: '',
      outputTail: 'Vitest failed',
      diagnosticArtifacts: [],
      ...(structuredErrors !== undefined
        ? {
            structuredErrorsTotal:
              overrides.structuredErrorsTotal ?? structuredErrors.length,
            structuredErrorsComplete:
              overrides.structuredErrorsComplete ?? true,
          }
        : {}),
      ...overrides,
    },
  };
}

describe('related-test diagnostics', () => {
  it.each([
    {
      label: 'nested Seatbelt sandbox_apply',
      structuredErrors: [{
        source: 'vitest-json' as const,
        scope: 'suite' as const,
        file: 'src/nested-sandbox.test.ts',
        message: 'sandbox-exec: sandbox_apply: Operation not permitted',
      }],
      expected: {
        kind: 'nested-seatbelt-sandbox-apply',
        syscall: 'sandbox_apply',
      },
    },
    {
      label: 'IPv4 loopback listen',
      structuredErrors: [{
        source: 'vitest-json' as const,
        scope: 'assertion' as const,
        file: 'src/server.test.ts',
        testName: 'starts its fixture server',
        message: 'Error: listen EPERM: operation not permitted 127.0.0.1:43127',
      }],
      expected: {
        kind: 'loopback-listen-denied',
        code: 'EPERM',
        syscall: 'listen',
        address: '127.0.0.1',
      },
    },
    {
      label: 'IPv6 loopback listen',
      structuredErrors: [{
        source: 'vitest-json' as const,
        scope: 'suite' as const,
        file: 'src/server.test.ts',
        message: 'listen EACCES: permission denied ::1:43127',
      }],
      expected: {
        kind: 'loopback-listen-denied',
        code: 'EACCES',
        syscall: 'listen',
        address: '::1',
      },
    },
  ])('classifies structured $label failures as validation-host conflicts', ({
    structuredErrors,
    expected,
  }) => {
    const diagnostic = diagnoseRelatedTestResult(input({ structuredErrors }));

    expect(diagnostic).toMatchObject({
      state: 'related-validation-host-conflict',
      initial: {
        selectedPaths: ['src/feature.ts'],
        argv,
        validationCwd: '.',
        compatibleMode: false,
      },
      conflictEvidence: [expect.objectContaining(expected)],
    });
  });

  it('does not promote arbitrary console text without structured Vitest evidence', () => {
    const diagnostic = diagnoseRelatedTestResult(input({
      outputHead: 'listen EPERM: operation not permitted 127.0.0.1:43127',
      outputTail: 'sandbox_apply: Operation not permitted',
      structuredErrors: undefined,
    }));

    expect(diagnostic).toMatchObject({
      state: 'related-test-failure',
      conflictEvidence: [],
    });
  });

  it('fails closed when structured host-conflict evidence was incompletely retained', () => {
    const diagnostic = diagnoseRelatedTestResult(input({
      structuredErrors: [{
        source: 'vitest-json',
        scope: 'suite',
        file: 'src/server.test.ts',
        message: 'listen EPERM: operation not permitted 127.0.0.1:43127',
      }],
      structuredErrorsTotal: 12,
      structuredErrorsComplete: false,
    }));

    expect(diagnostic).toMatchObject({
      state: 'related-test-failure',
      initial: {
        result: {
          structuredErrorsTotal: 12,
          structuredErrorsComplete: false,
        },
      },
      conflictEvidence: [],
    });
  });

  it('keeps mixed assertion and host-conflict failures repairable as a genuine test failure', () => {
    const diagnostic = diagnoseRelatedTestResult(input({
      structuredErrors: [
        {
          source: 'vitest-json',
          scope: 'suite',
          file: 'src/server.test.ts',
          message: 'listen EPERM: operation not permitted localhost:43127',
        },
        {
          source: 'vitest-json',
          scope: 'assertion',
          file: 'src/feature.test.ts',
          testName: 'computes the total',
          message: 'AssertionError: expected 3 to be 2',
        },
      ],
    }));

    expect(diagnostic.state).toBe('related-test-failure');
    expect(diagnostic.conflictEvidence).toEqual([
      expect.objectContaining({ kind: 'loopback-listen-denied' }),
    ]);
  });

  it.each([
    {
      label: 'timed-out initial run',
      overrides: {
        timedOut: true,
        exitCode: null,
        structuredErrors: [{
          source: 'vitest-json' as const,
          scope: 'suite' as const,
          file: 'src/server.test.ts',
          message: 'listen EPERM: operation not permitted 127.0.0.1:43127',
        }],
      },
    },
    {
      label: 'unsupported direct sandbox failure',
      overrides: {
        structuredErrors: [{
          source: 'vitest-json' as const,
          scope: 'suite' as const,
          file: 'src/server.test.ts',
          message: 'sandbox-exec: invalid profile, nested sandbox unsupported',
        }],
      },
    },
    {
      label: 'empty structured report',
      overrides: { structuredErrors: [] },
    },
  ])('fails closed as an ordinary related-test failure for $label', ({ overrides }) => {
    expect(diagnoseRelatedTestResult(input(overrides))).toMatchObject({
      state: 'related-test-failure',
      conflictEvidence: [],
    });
  });

  it('passes only after a confirmed conflict has a green compatible rerun of the exact selection', () => {
    const conflict = diagnoseRelatedTestResult(input({
      structuredErrors: [{
        source: 'vitest-json',
        scope: 'suite',
        file: 'src/nested-sandbox.test.ts',
        message: 'sandbox_apply: Operation not permitted',
      }],
    }));
    const fallback = diagnoseRelatedTestFallback(conflict, input({
      exitCode: 0,
      timedOut: false,
      outputTail: '',
      structuredErrors: [],
    }));

    expect(fallback).toMatchObject({
      state: 'related-fallback-passed',
      initial: { selectedPaths: ['src/feature.ts'], argv, compatibleMode: false },
      fallback: { selectedPaths: ['src/feature.ts'], argv, compatibleMode: true },
    });
  });

  it.each([
    { label: 'red', exitCode: 1, timedOut: false, structuredErrors: [] },
    { label: 'timed out', exitCode: null, timedOut: true, structuredErrors: [] },
    {
      label: 'missing structured confirmation',
      exitCode: 0,
      timedOut: false,
      structuredErrors: undefined,
    },
    {
      label: 'internally inconsistent structured confirmation',
      exitCode: 0,
      timedOut: false,
      structuredErrors: [{
        source: 'vitest-json' as const,
        scope: 'assertion' as const,
        file: 'src/feature.test.ts',
        message: 'AssertionError: expected 3 to be 2',
      }],
    },
  ])('fails a $label compatible confirmation', ({
    exitCode,
    timedOut,
    structuredErrors,
  }) => {
    const conflict = diagnoseRelatedTestResult(input({
      structuredErrors: [{
        source: 'vitest-json',
        scope: 'suite',
        file: 'src/nested-sandbox.test.ts',
        message: 'sandbox_apply: Permission denied',
      }],
    }));
    const fallback = diagnoseRelatedTestFallback(conflict, input({
      exitCode,
      timedOut,
      outputTail: 'fallback did not confirm',
      structuredErrors,
    }));

    expect(fallback).toMatchObject({
      state: 'related-fallback-failed',
      fallback: {
        result: { exitCode, timedOut },
        compatibleMode: true,
      },
    });
  });

  it('scrubs paths and secrets from invocation, evidence, and fallback results', () => {
    const secret = '123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi';
    const conflict = diagnoseRelatedTestResult({
      selectedPaths: [`${PROJECT_ROOT}/src/feature.ts`],
      argv: [...argv.slice(0, -1), `${PROJECT_ROOT}/src/feature.ts`],
      validationCwd: PROJECT_ROOT,
      result: {
        exitCode: 1,
        timedOut: false,
        outputHead: `at ${PROJECT_ROOT}/src/server.test.ts token ${secret}`,
        outputTail: `sandbox_apply: Operation not permitted ${secret}`,
        diagnosticArtifacts: [`${PROJECT_ROOT}/validation-timeout.json`],
        structuredErrorsTotal: 1,
        structuredErrorsComplete: true,
        structuredErrors: [{
          source: 'vitest-json',
          scope: 'suite',
          file: `${PROJECT_ROOT}/src/server.test.ts`,
          message: `sandbox_apply: Operation not permitted ${secret}`,
        }],
      },
    });
    const fallback = diagnoseRelatedTestFallback(conflict, {
      ...input(),
      result: {
        exitCode: 0,
        timedOut: false,
        outputTail: `${PROJECT_ROOT} ${secret}`,
        diagnosticArtifacts: [],
      },
    });
    const serialized = JSON.stringify(fallback);

    expect(serialized).not.toContain(PROJECT_ROOT);
    expect(serialized).not.toContain(secret);
  });

  it('rejects contradictory durable state/fallback combinations and result invariants', () => {
    const conflict = diagnoseRelatedTestResult(input({
      structuredErrors: [{
        source: 'vitest-json',
        scope: 'suite',
        file: 'src/nested-sandbox.test.ts',
        message: 'sandbox_apply: Operation not permitted',
      }],
    }));
    const passed = diagnoseRelatedTestFallback(conflict, input({
      exitCode: 0,
      timedOut: false,
      outputTail: '',
      structuredErrors: [],
    }));
    const failed = diagnoseRelatedTestFallback(conflict, input({
      exitCode: 1,
      timedOut: false,
      outputTail: 'still red',
      structuredErrors: [],
    }));

    expect(isRelatedTestDiagnostic(conflict)).toBe(true);
    expect(isRelatedTestDiagnostic(passed)).toBe(true);
    expect(isRelatedTestDiagnostic(failed)).toBe(true);

    const contradictory = [
      { ...conflict, conflictEvidence: [] },
      { ...conflict, fallback: passed.fallback },
      { ...passed, fallback: undefined },
      { ...passed, fallback: { ...passed.fallback!, compatibleMode: false } },
      {
        ...passed,
        fallback: {
          ...passed.fallback!,
          result: { ...passed.fallback!.result, timedOut: true },
        },
      },
      {
        ...passed,
        fallback: {
          ...passed.fallback!,
          result: { ...passed.fallback!.result, exitCode: 1 },
        },
      },
      {
        ...failed,
        fallback: {
          ...failed.fallback!,
          result: {
            ...failed.fallback!.result,
            exitCode: 0,
            timedOut: false,
            structuredErrors: [],
            structuredErrorsTotal: 0,
            structuredErrorsComplete: true,
          },
        },
      },
      {
        ...passed,
        fallback: {
          ...passed.fallback!,
          selectedPaths: ['src/different.ts'],
        },
      },
    ];

    for (const candidate of contradictory) {
      expect(isRelatedTestDiagnostic(candidate)).toBe(false);
    }
  });

  it('selects the last bounded task diagnostics before cloning discarded records', () => {
    const diagnostic = diagnoseRelatedTestResult(input({
      structuredErrors: [{
        source: 'vitest-json',
        scope: 'assertion',
        file: 'src/feature.test.ts',
        message: 'AssertionError: expected 3 to be 2',
      }],
    }));
    const discardedUncloneable = {
      ...diagnostic,
      productControlledExtra: () => 'must never be cloned',
    } as unknown as RelatedTestDiagnostic;
    const records = [
      { taskId: 'discarded-prefix', relatedTestDiagnostic: discardedUncloneable },
      ...Array.from({ length: RELATED_TEST_TASK_DIAGNOSTICS_MAX }, (_, index) => ({
        taskId: `retained-${index}`,
        relatedTestDiagnostic: diagnostic,
      })),
    ];

    expect(() => collectRelatedTestTaskDiagnostics(records)).not.toThrow();
    expect(collectRelatedTestTaskDiagnostics(records).map((entry) => entry.taskId))
      .toEqual(Array.from(
        { length: RELATED_TEST_TASK_DIAGNOSTICS_MAX },
        (_, index) => `retained-${index}`,
      ));
  });

  it('rejects diagnostics whose invocation selections or command exceed durable bounds', () => {
    const diagnostic = diagnoseRelatedTestResult(input({
      structuredErrors: [{
        source: 'vitest-json',
        scope: 'assertion',
        file: 'src/feature.test.ts',
        message: 'AssertionError: expected 3 to be 2',
      }],
    }));
    const huge = 'x'.repeat(100_000);
    const tooMany = Array.from({ length: 1_000 }, (_, index) => `src/${index}.ts`);
    const candidates = [
      {
        ...diagnostic,
        initial: { ...diagnostic.initial, selectedPaths: tooMany },
      },
      {
        ...diagnostic,
        initial: { ...diagnostic.initial, selectedPaths: [huge] },
      },
      {
        ...diagnostic,
        initial: { ...diagnostic.initial, argv: tooMany },
      },
      {
        ...diagnostic,
        initial: { ...diagnostic.initial, argv: [huge] },
      },
      {
        ...diagnostic,
        initial: { ...diagnostic.initial, command: huge },
      },
    ];

    for (const candidate of candidates) {
      expect(isRelatedTestDiagnostic(candidate)).toBe(false);
    }
  });

  it('generates a durable-valid diagnostic for an admitted near-limit selection', () => {
    const selectedPaths = Array.from(
      {
        length:
          Math.floor(
            RELATED_TEST_ARGUMENTS_TOTAL_MAX_CHARS /
              RELATED_TEST_ARGUMENT_MAX_CHARS,
          ) - 1,
      },
      (_, index) =>
        `${String(index).padStart(4, '0')}${'x'.repeat(
          RELATED_TEST_ARGUMENT_MAX_CHARS - 4,
        )}`,
    );
    const generated = diagnoseRelatedTestResult({
      selectedPaths,
      argv: [
        'npx',
        'vitest',
        'related',
        '--run',
        '--passWithNoTests',
        ...selectedPaths,
      ],
      validationCwd: '.',
      result: input({
        structuredErrors: [{
          source: 'vitest-json',
          scope: 'assertion',
          file: 'src/feature.test.ts',
          message: 'AssertionError: expected 3 to be 2',
        }],
      }).result,
    });

    expect(generated.state).toBe('related-test-failure');
    expect(isRelatedTestDiagnostic(generated)).toBe(true);
  });

  it('retains a durable-valid bounded projection for an over-total producer input', () => {
    const selectedPaths = Array.from(
      { length: 61 },
      (_, index) =>
        `${String(index).padStart(4, '0')}${'x'.repeat(
          RELATED_TEST_ARGUMENT_MAX_CHARS - 4,
        )}`,
    );
    const generated = diagnoseRelatedTestResult({
      selectedPaths,
      argv: [
        'npx',
        'vitest',
        'related',
        '--run',
        '--passWithNoTests',
        ...selectedPaths,
      ],
      validationCwd: '.',
      result: input({
        structuredErrors: [{
          source: 'vitest-json',
          scope: 'assertion',
          file: 'src/feature.test.ts',
          message: 'AssertionError: expected 3 to be 2',
        }],
      }).result,
    });

    expect(generated.initial.selectionComplete).toBe(false);
    expect(
      generated.initial.selectedPaths.reduce(
        (total, path) => total + path.length,
        0,
      ),
    ).toBeLessThanOrEqual(RELATED_TEST_ARGUMENTS_TOTAL_MAX_CHARS);
    expect(
      generated.initial.argv.reduce(
        (total, arg) => total + arg.length,
        0,
      ),
    ).toBeLessThanOrEqual(RELATED_TEST_ARGUMENTS_TOTAL_MAX_CHARS);
    expect(isRelatedTestDiagnostic(generated)).toBe(true);
  });

  it('bounds conflict evidence when an oversized structured-error result fails closed', () => {
    const hostConflicts = Array.from(
      { length: RELATED_TEST_STRUCTURED_ERRORS_MAX + 1 },
      (_, index) => ({
        source: 'vitest-json' as const,
        scope: 'suite' as const,
        file: `src/server-${index}.test.ts`,
        message: 'listen EPERM: operation not permitted 127.0.0.1',
      }),
    );
    const generated = diagnoseRelatedTestResult(input({
      structuredErrors: [
        ...hostConflicts,
        {
          source: 'vitest-json',
          scope: 'assertion',
          file: 'src/assertion.test.ts',
          message: 'AssertionError: expected 3 to be 2',
        },
      ],
    }));

    expect(generated.state).toBe('related-test-failure');
    expect(generated.conflictEvidence.length)
      .toBeLessThanOrEqual(RELATED_TEST_STRUCTURED_ERRORS_MAX);
    expect(isRelatedTestDiagnostic(generated)).toBe(true);
  });
});
