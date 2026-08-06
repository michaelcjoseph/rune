/**
 * Phase 2 test suite for `src/jobs/work-run-store.ts` — run store persistence
 * (test-plan §2, project 11 work-run-observability).
 *
 * Written TEST-FIRST. Every body in the scaffold throws `notImplemented(...)`,
 * so all tests here must be RED until the Phase 2 implementation tasks complete.
 *
 * Expected failure mode: assertion failure or "work-run-store: <fn> not
 * implemented (project 11 Phase 2 pending)" throw. NEVER a module-resolution
 * error, syntax error, or "Missing env var" crash.
 *
 * Uses real tmpdir + real fs — no fs mocking needed for these tests.
 *
 * See: docs/projects/11-work-run-observability/test-plan.md §2
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  mkdirSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  writeSummary,
  appendIndexRow,
  readRecentIndex,
  readWorkRunSummaryResult,
  readWorkRunSummary,
  readGateValidationReceipt,
  writeGateValidationReceipt,
} from './work-run-store.js';
import type { WorkRunSummary, WorkRunIndexRow } from './work-run-store.js';
import type { ContextCloseoutFailure } from '../intent/context-closeout.js';
import {
  EXECUTION_DIAGNOSTIC_MAX_CHARS,
  executionFailureSummary,
  type ExecutionFailure,
} from '../intent/execution-failure.js';

const gateReceiptIdentity = {
  version: 1 as const,
  treeOid: 'a'.repeat(40),
  fullTaskReviewHash: 'b'.repeat(64),
  completedAt: '2026-07-30T12:00:00.000Z',
  commandFingerprint: 'c'.repeat(64),
  configurationFingerprint: 'd'.repeat(64),
  dependencyFingerprint: 'e'.repeat(64),
};

// ---------------------------------------------------------------------------
// Temp dir management — one fresh dir per test
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'work-run-store-test-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers / fixtures
// ---------------------------------------------------------------------------

function makeSummary(overrides: Partial<WorkRunSummary> = {}): WorkRunSummary {
  return {
    id: 'mut-test-001',
    project: '11-work-run-observability',
    product: 'rune',
    outcome: 'noop',
    reason: 'zero commits + clean tree',
    exit: { exitCode: 0, signal: null, cancelled: false, durationMs: 1200 },
    workProduct: {
      commitCount: 0,
      commitShas: [],
      filesChanged: [],
      diffstat: '',
      dirty: false,
      untracked: false,
      transitions: {
        tasksNewlyChecked: 0,
        tasksRemaining: 0,
        tasksAdded: 0,
        tasksRemoved: 0,
      },
    },
    baseSha: 'deadbeef1234567890abcdef1234567890abcdef',
    branch: 'rune-gen-eval/mut-test-001',
    startedAt: '2026-05-30T10:00:00.000Z',
    endedAt: '2026-05-30T10:00:01.200Z',
    transcriptPath: '/tmp/logs/work-runs/mut-test-001/transcript.jsonl',
    forensicsPath: '/tmp/logs/work-runs/mut-test-001',
    ...overrides,
  };
}

function makeIndexRow(overrides: Partial<WorkRunIndexRow> = {}): WorkRunIndexRow {
  return {
    id: 'mut-test-001',
    project: '11-work-run-observability',
    outcome: 'noop',
    durationMs: 1200,
    startedAt: '2026-05-30T10:00:00.000Z',
    endedAt: '2026-05-30T10:00:01.200Z',
    ...overrides,
  };
}

function makeContextFailureSummary(
  id: string,
  contextFailure: ContextCloseoutFailure,
  overrides: Partial<WorkRunSummary> = {},
): WorkRunSummary {
  const wipSha = contextFailure.checkpoint.kind === 'committed'
    ? contextFailure.checkpoint.sha
    : undefined;
  return makeSummary({
    id,
    outcome: 'failed',
    reason: 'context update rejected',
    exit: {
      exitCode: 1,
      signal: null,
      cancelled: false,
      durationMs: 1200,
      exitFact: 'execution-failure',
    },
    trigger: { kind: 'failure', reason: 'context update rejected' },
    disposition: {
      kind: 'preserved',
      reason: 'worktree preserved after context closeout failure',
      ...(wipSha !== undefined ? { wipSha } : {}),
    },
    contextFailure,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// §2 writeSummary — atomic temp-then-rename
// ---------------------------------------------------------------------------

describe('writeSummary', () => {
  it(
    // test-plan §2 (🟡): summary.json is written atomically (temp-then-rename);
    // write a WorkRunSummary to a tmpdir, read it back, assert it round-trips.
    'writes summary.json and it round-trips correctly',
    () => {
      const runDir = tmpDir;
      const summary = makeSummary();

      writeSummary(runDir, summary);

      const summaryPath = join(runDir, 'summary.json');
      expect(existsSync(summaryPath)).toBe(true);

      const parsed: WorkRunSummary = JSON.parse(readFileSync(summaryPath, 'utf8'));
      expect(parsed).toEqual(summary);
    },
  );

  it('round-trips structured trigger and disposition records', () => {
    const summary = makeSummary({
      outcome: 'failed',
      reason: 'coder failed at provider: temporary outage',
      trigger: {
        kind: 'failure',
        reason: 'coder failed at provider: temporary outage',
        executionFailure: {
          taskId: 'task-one', role: 'coder', provider: 'openai', format: 'codex',
          model: 'gpt-test', workflowStage: 'coder-implementation',
          checkpointedAt: '2026-07-22T00:00:00.000Z', failureStage: 'provider',
          diagnostic: 'temporary outage', retryable: true, attempts: [{
            attempt: 1,
            startedAt: '2026-07-22T00:00:00.000Z',
            endedAt: '2026-07-22T00:00:01.000Z',
            failureStage: 'provider',
            diagnostic: 'temporary outage',
            retryable: true,
          }],
          retryDisposition: 'exhausted',
        },
      },
      disposition: { kind: 'parked', reason: 'WIP preserved', wipSha: 'deadbeef' },
    });
    writeSummary(join(tmpDir, summary.id), summary);
    expect(readWorkRunSummary(tmpDir, summary.id)).toEqual(summary);
  });

  it('round-trips actionable context-closeout failure evidence', () => {
    const contextFailure = {
      reason: 'managed-heading-collision' as const,
      file: 'docs/projects/resolved-assay/context.md',
      canonicalHeading: '## Interfaces & Contracts',
      conflictingHeadings: ['## Interfaces & Contracts', '## Canonical Interfaces'],
      proposedRepair: 'Merge the bodies into the canonical section and remove the legacy heading.',
      checkpoint: {
        kind: 'committed' as const,
        sha: 'abcdef1234567',
      },
    };
    const summary = makeContextFailureSummary('mut-test-001', contextFailure);

    writeSummary(join(tmpDir, summary.id), summary);

    expect(readWorkRunSummary(tmpDir, summary.id)).toMatchObject({
      trigger: { kind: 'failure' },
      disposition: { kind: 'preserved', wipSha: 'abcdef1234567' },
      contextFailure,
    });
  });

  it('round-trips related-test fallback evidence while keeping legacy summaries readable', () => {
    const legacy = makeSummary({ id: 'legacy-without-related-diagnostic' });
    writeSummary(join(tmpDir, legacy.id), legacy);
    expect(readWorkRunSummary(tmpDir, legacy.id)).toEqual(legacy);
    expect(readWorkRunSummary(tmpDir, legacy.id)).not.toHaveProperty('relatedTestDiagnostic');

    const relatedTestDiagnostic = {
      state: 'related-fallback-failed' as const,
      initial: {
        selectedPaths: ['src/feature.ts'],
        argv: ['npx', 'vitest', 'related', '--run', 'src/feature.ts'],
        command: '"npx" "vitest" "related" "--run" "src/feature.ts"',
        validationCwd: '.',
        result: {
          exitCode: 1,
          timedOut: false,
          outputTail: 'structured host conflict',
          diagnosticArtifacts: [],
          structuredErrorsTotal: 1,
          structuredErrorsComplete: true,
          structuredErrors: [{
            source: 'vitest-json' as const,
            scope: 'suite' as const,
            file: 'src/nested.test.ts',
            message: 'sandbox_apply: Operation not permitted',
          }],
        },
        compatibleMode: false,
      },
      conflictEvidence: [{
        kind: 'nested-seatbelt-sandbox-apply' as const,
        source: 'vitest-json' as const,
        scope: 'suite' as const,
        file: 'src/nested.test.ts',
        message: 'sandbox_apply: Operation not permitted',
        syscall: 'sandbox_apply' as const,
      }],
      fallback: {
        selectedPaths: ['src/feature.ts'],
        argv: ['npx', 'vitest', 'related', '--run', 'src/feature.ts'],
        command: '"npx" "vitest" "related" "--run" "src/feature.ts"',
        validationCwd: '.',
        result: {
          exitCode: null,
          timedOut: true,
          outputTail: 'confirmation timed out',
          diagnosticArtifacts: ['validation-timeout-1.txt'],
          structuredErrorsTotal: 0,
          structuredErrorsComplete: true,
          structuredErrors: [],
        },
        compatibleMode: true,
      },
    };
    const current = makeSummary({
      id: 'current-with-related-diagnostic',
      outcome: 'failed',
      relatedTestDiagnostic,
      relatedTestDiagnostics: [{
        taskId: 'build-the-feature',
        diagnostic: relatedTestDiagnostic,
      }],
    });
    writeSummary(join(tmpDir, current.id), current);

    expect(readWorkRunSummary(tmpDir, current.id)).toMatchObject({
      relatedTestDiagnostic: {
        state: 'related-fallback-failed',
        fallback: { result: { timedOut: true } },
      },
      relatedTestDiagnostics: [{
        taskId: 'build-the-feature',
        diagnostic: {
          state: 'related-fallback-failed',
          fallback: { result: { timedOut: true } },
        },
      }],
    });
  });

  it('round-trips a compact merge-gate receipt and drops malformed optional evidence', () => {
    const receipt = {
      ...gateReceiptIdentity,
      outcome: 'passed' as const,
      commands: [
        { command: 'npm run build', outcome: 'passed' as const, coverage: 'unsupported' as const },
        {
          command: 'npm test',
          outcome: 'passed' as const,
          coverage: 'complete' as const,
          discovered: { suites: 1, tests: 2 },
          completed: {
            suites: 1, tests: 2, passed: 2, failed: 0,
            skipped: 0, todo: 0, cancelled: 0,
          },
        },
      ],
    };
    const summary = makeSummary({
      id: 'merge-gate-attested',
      gateValidationReceipt: receipt,
    });
    writeSummary(join(tmpDir, summary.id), summary);
    expect(readWorkRunSummary(tmpDir, summary.id)).toMatchObject({
      gateValidationReceipt: receipt,
    });

    const malformed = makeSummary({ id: 'merge-gate-malformed' }) as unknown as Record<string, unknown>;
    malformed['gateValidationReceipt'] = {
      outcome: 'passed',
      commands: [{
        command: 'npm test --reporter=/Users/operator/private/reporter.mjs',
        outcome: 'passed',
        coverage: 'complete',
      }],
      output: 'TELEGRAM_BOT_TOKEN=secret',
    };
    mkdirSync(join(tmpDir, 'merge-gate-malformed'), { recursive: true });
    writeFileSync(
      join(tmpDir, 'merge-gate-malformed', 'summary.json'),
      JSON.stringify(malformed),
    );

    const restored = readWorkRunSummary(tmpDir, 'merge-gate-malformed');
    expect(restored).not.toHaveProperty('gateValidationReceipt');
    expect(JSON.stringify(restored)).not.toContain('/Users/operator');
    expect(JSON.stringify(restored)).not.toContain('TELEGRAM_BOT_TOKEN');
  });

  it('round-trips typed adjudication failure evidence and rejects malformed variants', () => {
    const adjudicationFailure = {
      code: 'adjudication-output-invalid' as const,
      cause: 'invalid-artifact' as const,
      attempts: [
        { attempt: 1 as const, code: 'missing-fence' as const },
        { attempt: 2 as const, code: 'blank-rationale' as const },
      ],
      executedModelAlias: 'gpt-adjudicator',
      executedProvider: 'openai' as const,
    };
    const summary = makeSummary({
      id: 'adjudication-output-invalid',
      outcome: 'failed',
      reason: 'Adjudication operational hold: adjudication-output-invalid',
      adjudicationFailure,
    });
    writeSummary(join(tmpDir, summary.id), summary);

    expect(readWorkRunSummary(tmpDir, summary.id)).toMatchObject({ adjudicationFailure });

    const malformed = makeSummary({ id: 'adjudication-output-malformed' }) as unknown as Record<string, unknown>;
    malformed['adjudicationFailure'] = {
      ...adjudicationFailure,
      attempts: [{ attempt: 3, code: 'raw-output-secret' }],
    };
    mkdirSync(join(tmpDir, 'adjudication-output-malformed'), { recursive: true });
    writeFileSync(
      join(tmpDir, 'adjudication-output-malformed', 'summary.json'),
      JSON.stringify(malformed),
    );
    expect(readWorkRunSummaryResult(tmpDir, 'adjudication-output-malformed')).toEqual({
      status: 'invalid',
    });
  });

  it('round-trips the adjudicator-upheld-fail marker and fails closed on abuse of it', () => {
    const upheld = makeSummary({
      id: 'adjudication-upheld-fail',
      outcome: 'failed',
      reason: "orchestration blocked on \"task\": adjudicator upheld reviewer's fail: leaks",
      adjudicationUpheldFail: true,
    });
    writeSummary(join(tmpDir, upheld.id), upheld);
    expect(readWorkRunSummary(tmpDir, upheld.id)).toMatchObject({ adjudicationUpheldFail: true });

    // Only the literal `true` is admissible — a truthy string must not ride
    // through the summary spread and light up the Cockpit label.
    const truthy = makeSummary({ id: 'adjudication-upheld-truthy' }) as unknown as Record<string, unknown>;
    truthy['adjudicationUpheldFail'] = 'yes';
    mkdirSync(join(tmpDir, 'adjudication-upheld-truthy'), { recursive: true });
    writeFileSync(
      join(tmpDir, 'adjudication-upheld-truthy', 'summary.json'),
      JSON.stringify(truthy),
    );
    expect(readWorkRunSummaryResult(tmpDir, 'adjudication-upheld-truthy')).toEqual({
      status: 'invalid',
    });

    // The two terminal adjudication states are mutually exclusive.
    const both = makeSummary({ id: 'adjudication-both' }) as unknown as Record<string, unknown>;
    both['adjudicationUpheldFail'] = true;
    both['adjudicationFailure'] = {
      code: 'adjudication-output-invalid',
      cause: 'unavailable',
      attempts: [],
    };
    mkdirSync(join(tmpDir, 'adjudication-both'), { recursive: true });
    writeFileSync(join(tmpDir, 'adjudication-both', 'summary.json'), JSON.stringify(both));
    expect(readWorkRunSummaryResult(tmpDir, 'adjudication-both')).toEqual({ status: 'invalid' });
  });

  it('round-trips a bounded conflict sample with its larger total count', () => {
    const id = 'bounded-context-conflicts';
    const checkpoint = { kind: 'committed' as const, sha: 'abcdef1234567' };
    const contextFailure = {
      reason: 'duplicate-managed-section' as const,
      file: 'docs/projects/resolved-assay/context.md',
      canonicalHeading: '## Known Risks',
      conflictingHeadings: Array.from({ length: 10 }, () => '## Known Risks'),
      conflictingHeadingCount: 11,
      proposedRepair: 'Merge all competing bodies and retain one managed section.',
      checkpoint,
    };
    const summary = makeContextFailureSummary(id, contextFailure);

    writeSummary(join(tmpDir, id), summary);

    expect(readWorkRunSummary(tmpDir, id)?.contextFailure).toEqual(contextFailure);
  });

  it.each([
    {
      name: 'successful outcome',
      override: { outcome: 'branch-complete' as const },
    },
    {
      name: 'success trigger',
      override: { trigger: { kind: 'success' as const, reason: 'done' } },
    },
    {
      name: 'non-execution-failure exit facts',
      override: {
        exit: {
          exitCode: 0,
          signal: null,
          cancelled: false,
          durationMs: 1200,
          exitFact: 'clean-exit' as const,
        },
      },
    },
    {
      name: 'missing exit facts',
      override: {
        exit: undefined,
      },
    },
    {
      name: 'removed disposition',
      override: {
        disposition: { kind: 'removed' as const, reason: 'worktree removed' },
      },
    },
    {
      name: 'mismatched disposition WIP SHA',
      override: {
        disposition: {
          kind: 'preserved' as const,
          reason: 'worktree preserved',
          wipSha: 'deadbeef12345',
        },
      },
    },
  ])('rejects context failure with contradictory $name', ({ name, override }) => {
    const id = `invalid-context-${name.replaceAll(' ', '-')}`;
    const checkpoint = { kind: 'committed' as const, sha: 'abcdef1234567' };
    const summary = makeContextFailureSummary(id, {
      reason: 'managed-heading-collision',
      file: 'docs/projects/resolved-assay/context.md',
      proposedRepair: 'Merge the competing bodies.',
      checkpoint,
    }, override);

    writeSummary(join(tmpDir, id), summary);

    expect(readWorkRunSummaryResult(tmpDir, id)).toEqual({ status: 'invalid' });
  });

  it('rejects unknown context reasons and canonicalizes displayed checkpoint fields', () => {
    const runDir = join(tmpDir, 'context-shape-run');
    const summary = makeContextFailureSummary('context-shape-run', {
      reason: 'managed-heading-collision',
      file: 'docs/projects/assay/context.md',
      canonicalHeading: '## Interfaces & Contracts',
      proposedRepair: 'Merge the bodies.',
      checkpoint: { kind: 'committed', sha: 'abcdef1234567' },
    });
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, 'summary.json'), JSON.stringify({
      ...summary,
      contextFailure: {
        ...summary.contextFailure,
        injectedHostPath: '/Users/operator/private',
        checkpoint: {
          ...summary.contextFailure!.checkpoint,
          subject: '/Users/operator/private task',
          injected: 'secret',
        },
      },
    }));

    const read = readWorkRunSummary(tmpDir, summary.id);
    expect(read?.contextFailure).toEqual(summary.contextFailure);
    expect(JSON.stringify(read?.contextFailure)).not.toContain('/Users/');

    writeFileSync(join(runDir, 'summary.json'), JSON.stringify({
      ...summary,
      contextFailure: {
        ...summary.contextFailure,
        reason: 'invented-context-reason',
      },
    }));
    expect(readWorkRunSummaryResult(tmpDir, summary.id)).toEqual({ status: 'invalid' });
  });

  it('scrubs host paths from every displayed context-failure string', () => {
    const id = 'context-display-scrub';
    const runDir = join(tmpDir, id);
    const summary = makeContextFailureSummary(id, {
      reason: 'managed-heading-collision',
      file: 'docs/projects/assay/context.md',
      proposedRepair: 'Repair the managed context sections.',
      checkpoint: { kind: 'failed', diagnostic: 'git failed' },
    });
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, 'summary.json'), JSON.stringify({
      ...summary,
      contextFailure: {
        reason: 'managed-heading-collision',
        file: 'docs/projects/assay//Users/operator/private/context.md',
        canonicalHeading: '## Interfaces /Users/operator/private',
        conflictingHeadings: ['## Canonical /Users/operator/private'],
        proposedRepair: 'Repair /Users/operator/private/context.md.',
        checkpoint: {
          kind: 'failed',
          diagnostic: 'git failed at /Users/operator/private/.git/index.lock',
        },
      },
    }));

    const read = readWorkRunSummary(tmpDir, id);

    expect(read?.contextFailure).toBeDefined();
    expect(JSON.stringify(read?.contextFailure)).not.toContain('/Users/');
  });

  it.each([
    'missing-section',
    'duplicate-managed-section',
    'managed-heading-collision',
    'embedded-section-header',
    'over-budget',
    'transcript-dump',
    'needs-tech-lead-validation',
    'needs-pm-validation',
  ] as const)('accepts the exact durable context reason enum: %s', (reason) => {
    const id = `context-reason-${reason}`;
    const summary = makeContextFailureSummary(id, {
      reason,
      file: 'docs/projects/assay/context.md',
      proposedRepair: 'Apply the bounded repair and retry closeout.',
      checkpoint: { kind: 'already-clean' },
    });

    writeSummary(join(tmpDir, id), summary);

    expect(readWorkRunSummaryResult(tmpDir, id)).toMatchObject({
      status: 'found',
      summary: {
        contextFailure: {
          reason,
          checkpoint: { kind: 'already-clean' },
        },
      },
    });
  });

  it('round-trips a trigger composed from a maximum-size execution diagnostic', () => {
    const executionFailure: ExecutionFailure = {
      taskId: 'task-one', role: 'coder', provider: 'openai', format: 'codex',
      model: 'gpt-test', workflowStage: 'coder-implementation',
      checkpointedAt: '2026-07-22T00:00:00.000Z', failureStage: 'provider',
      diagnostic: 'x'.repeat(EXECUTION_DIAGNOSTIC_MAX_CHARS),
      retryable: true,
      attempts: [{
        attempt: 1,
        startedAt: '2026-07-22T00:00:00.000Z',
        endedAt: '2026-07-22T00:00:01.000Z',
        failureStage: 'provider',
        diagnostic: 'x'.repeat(EXECUTION_DIAGNOSTIC_MAX_CHARS),
        retryable: true,
      }],
      retryDisposition: 'exhausted',
    };
    const reason = executionFailureSummary(executionFailure);
    const summary = makeSummary({
      id: 'max-diagnostic-run',
      outcome: 'failed',
      reason,
      trigger: { kind: 'failure', reason, executionFailure },
    });

    writeSummary(join(tmpDir, summary.id), summary);

    expect(reason.length).toBeLessThanOrEqual(EXECUTION_DIAGNOSTIC_MAX_CHARS);
    expect(readWorkRunSummary(tmpDir, summary.id)).toEqual(summary);
  });

  it(
    // Atomicity: no leftover .tmp file should remain after a successful write.
    'leaves no leftover .tmp file in the dir after write',
    () => {
      const runDir = tmpDir;
      const summary = makeSummary();

      writeSummary(runDir, summary);

      const files = readdirSync(runDir);
      const tmpFiles = files.filter(f => f.endsWith('.tmp'));
      expect(tmpFiles).toHaveLength(0);
    },
  );

  it(
    // Different run dirs produce isolated summary.json files
    'write to two different dirs produces two independent summary.json files',
    () => {
      const dirA = mkdtempSync(join(tmpdir(), 'wrs-a-'));
      const dirB = mkdtempSync(join(tmpdir(), 'wrs-b-'));

      try {
        const summaryA = makeSummary({ id: 'mut-a', outcome: 'noop' });
        const summaryB = makeSummary({ id: 'mut-b', outcome: 'branch-complete' });

        writeSummary(dirA, summaryA);
        writeSummary(dirB, summaryB);

        const parsedA: WorkRunSummary = JSON.parse(readFileSync(join(dirA, 'summary.json'), 'utf8'));
        const parsedB: WorkRunSummary = JSON.parse(readFileSync(join(dirB, 'summary.json'), 'utf8'));

        expect(parsedA.id).toBe('mut-a');
        expect(parsedB.id).toBe('mut-b');
        expect(parsedA.outcome).toBe('noop');
        expect(parsedB.outcome).toBe('branch-complete');
      } finally {
        rmSync(dirA, { recursive: true, force: true });
        rmSync(dirB, { recursive: true, force: true });
      }
    },
  );
});

describe('readWorkRunSummaryResult', () => {
  it('distinguishes missing, invalid, and valid ownership evidence', () => {
    expect(readWorkRunSummaryResult(tmpDir, 'missing-run')).toEqual({ status: 'missing' });

    const invalidDir = join(tmpDir, 'invalid-run');
    mkdirSync(invalidDir);
    writeFileSync(join(invalidDir, 'summary.json'), '{bad json');
    expect(readWorkRunSummaryResult(tmpDir, 'invalid-run')).toEqual({ status: 'invalid' });

    const nullTargetDir = join(tmpDir, 'null-target-run');
    mkdirSync(nullTargetDir);
    writeFileSync(join(nullTargetDir, 'summary.json'), JSON.stringify({
      ...makeSummary({ id: 'null-target-run' }),
      target: null,
    }));
    expect(readWorkRunSummaryResult(tmpDir, 'null-target-run')).toEqual({ status: 'invalid' });

    const valid = makeSummary({ id: 'valid-run' });
    writeSummary(join(tmpDir, 'valid-run'), valid);
    expect(readWorkRunSummaryResult(tmpDir, 'valid-run')).toEqual({ status: 'found', summary: valid });
  });

  it('round-trips a valid nested-role cancellation through the typed reader', () => {
    const summary = makeSummary({
      id: 'nested-cancel-run',
      cancellation: {
        role: 'reviewer',
        operationId: 'abc12345-1234-1234-1234-123456789abc',
        source: 'telegram',
        requestedAt: '2026-07-13T12:34:56.000Z',
      },
    });
    writeSummary(join(tmpDir, summary.id), summary);
    const summaryPath = join(tmpDir, summary.id, 'summary.json');
    const persisted = JSON.parse(readFileSync(summaryPath, 'utf8'));
    persisted.cancellation.unexpected = 'not part of the diagnostic DTO';
    writeFileSync(summaryPath, JSON.stringify(persisted));

    expect(readWorkRunSummaryResult(tmpDir, summary.id)).toEqual({
      status: 'found',
      summary,
    });
  });

  it('rejects a persisted cancellation with an unknown source', () => {
    const id = 'invalid-cancellation-run';
    const runDir = join(tmpDir, id);
    mkdirSync(runDir);
    writeFileSync(join(runDir, 'summary.json'), JSON.stringify({
      ...makeSummary({ id }),
      cancellation: {
        role: 'reviewer',
        operationId: 'abc12345-1234-1234-1234-123456789abc',
        source: 'web',
        requestedAt: '2026-07-13T12:34:56.000Z',
      },
    }));

    expect(readWorkRunSummaryResult(tmpDir, id)).toEqual({ status: 'invalid' });
  });

  it('accepts a legacy persisted "qa" judgment outcome but drops it, keeping reviewer/tech-lead evidence', () => {
    // Runs recorded before QA's post-implementation diff-revalidation gate was
    // removed carry a `qa` entry in judgmentOutcomes. The role is no longer a
    // valid JudgmentRole, but the row as a whole must still be accepted so the
    // reviewer/tech-lead evidence beside it survives a restart/read.
    const id = 'legacy-qa-judgment-run';
    const runDir = join(tmpDir, id);
    mkdirSync(runDir);
    writeFileSync(join(runDir, 'summary.json'), JSON.stringify({
      ...makeSummary({ id }),
      judgmentOutcomes: [
        { role: 'qa', status: 'reject', summary: 'legacy diff-revalidation reject' },
        { role: 'reviewer', status: 'pass' },
        { role: 'tech-lead', status: 'reject', summary: 'still rejecting' },
      ],
    }));

    const result = readWorkRunSummaryResult(tmpDir, id);
    expect(result.status).toBe('found');
    expect(result.status === 'found' ? result.summary.judgmentOutcomes : undefined).toEqual([
      { role: 'reviewer', status: 'pass' },
      { role: 'tech-lead', status: 'reject', summary: 'still rejecting' },
    ]);
  });

  it('rejects judgmentOutcomes carrying an unrecognized role entirely', () => {
    const id = 'unknown-role-judgment-run';
    const runDir = join(tmpDir, id);
    mkdirSync(runDir);
    writeFileSync(join(runDir, 'summary.json'), JSON.stringify({
      ...makeSummary({ id }),
      judgmentOutcomes: [{ role: 'coder', status: 'pass' }],
    }));

    expect(readWorkRunSummaryResult(tmpDir, id)).toEqual({ status: 'invalid' });
  });
});

describe('merge-gate validation receipt', () => {
  const receipt = {
    ...gateReceiptIdentity,
    outcome: 'passed' as const,
    commands: [{
      command: 'npm test',
      outcome: 'passed' as const,
      coverage: 'complete' as const,
      discovered: { suites: 2, tests: 5 },
      completed: {
        suites: 2,
        tests: 5,
        passed: 4,
        failed: 0,
        skipped: 1,
        todo: 0,
        cancelled: 0,
      },
    }],
  };

  it('atomically restores the bounded receipt written before merge', () => {
    writeGateValidationReceipt(tmpDir, 'mut-gate-1', receipt);

    expect(readGateValidationReceipt(tmpDir, 'mut-gate-1')).toEqual(receipt);
    expect(readdirSync(join(tmpDir, 'mut-gate-1'))).toEqual(['gate-validation.json']);
  });

  it('drops malformed historical evidence and rejects invalid writes', () => {
    const runDir = join(tmpDir, 'mut-gate-2');
    mkdirSync(runDir);
    writeFileSync(join(runDir, 'gate-validation.json'), '{"outcome":"passed"}', 'utf8');

    expect(readGateValidationReceipt(tmpDir, 'mut-gate-2')).toBeUndefined();
    expect(() => writeGateValidationReceipt(
      tmpDir,
      'mut-gate-3',
      { ...gateReceiptIdentity, outcome: 'passed', commands: [] } as never,
    )).toThrow('invalid merge-gate validation receipt');
    expect(() => writeGateValidationReceipt(tmpDir, 'mut-gate-4', {
      ...gateReceiptIdentity,
      outcome: 'failed',
      commands: [{
        command: 'npm test',
        outcome: 'failed',
        coverage: 'unsupported',
      }],
    } as never)).toThrow('merge-gate authorization receipt is not green');
    expect(() => writeGateValidationReceipt(tmpDir, 'mut-gate-5', {
      ...gateReceiptIdentity,
      outcome: 'passed',
      commands: [{
        command: 'npm test',
        outcome: 'passed',
        coverage: 'complete',
        discovered: { suites: 1, tests: 2 },
        completed: {
          suites: 1,
          tests: 2,
          passed: 1,
          failed: 1,
          skipped: 0,
          todo: 0,
          cancelled: 0,
        },
      }],
    } as never)).toThrow('invalid merge-gate validation receipt');
  });

  it('does not follow a symlinked durable receipt', () => {
    const outside = join(tmpDir, 'outside-receipt.json');
    writeFileSync(outside, JSON.stringify(receipt), 'utf8');
    const runDir = join(tmpDir, 'mut-gate-symlink');
    mkdirSync(runDir);
    symlinkSync(outside, join(runDir, 'gate-validation.json'));

    expect(readGateValidationReceipt(tmpDir, 'mut-gate-symlink')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// §2 appendIndexRow + readRecentIndex — round-trip + torn-line handling
// ---------------------------------------------------------------------------

describe('appendIndexRow / readRecentIndex', () => {
  it(
    // test-plan §2 (🟡): appendIndexRow then readRecentIndex round-trips
    'appendIndexRow then readRecentIndex round-trips a single row',
    () => {
      const indexPath = join(tmpDir, 'index.jsonl');
      const row = makeIndexRow();

      appendIndexRow(indexPath, row);

      const rows = readRecentIndex(indexPath, 10);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual(row);
    },
  );

  it(
    // Multiple rows appended should all be readable
    'appending three rows and reading them back returns all three',
    () => {
      const indexPath = join(tmpDir, 'index.jsonl');
      const rowA = makeIndexRow({ id: 'mut-a', outcome: 'noop' });
      const rowB = makeIndexRow({ id: 'mut-b', outcome: 'partial' });
      const rowC = makeIndexRow({ id: 'mut-c', outcome: 'branch-complete' });

      appendIndexRow(indexPath, rowA);
      appendIndexRow(indexPath, rowB);
      appendIndexRow(indexPath, rowC);

      const rows = readRecentIndex(indexPath, 10);
      expect(rows).toHaveLength(3);
    },
  );

  it(
    // test-plan §2 (🟡): readRecentIndex returns rows newest-first
    'readRecentIndex returns rows newest-first',
    () => {
      const indexPath = join(tmpDir, 'index.jsonl');
      const rowA = makeIndexRow({ id: 'mut-first', startedAt: '2026-05-30T10:00:00.000Z' });
      const rowB = makeIndexRow({ id: 'mut-second', startedAt: '2026-05-30T11:00:00.000Z' });
      const rowC = makeIndexRow({ id: 'mut-third', startedAt: '2026-05-30T12:00:00.000Z' });

      appendIndexRow(indexPath, rowA);
      appendIndexRow(indexPath, rowB);
      appendIndexRow(indexPath, rowC);

      const rows = readRecentIndex(indexPath, 10);
      // Newest-first: last appended is first returned
      expect(rows[0]!.id).toBe('mut-third');
      expect(rows[1]!.id).toBe('mut-second');
      expect(rows[2]!.id).toBe('mut-first');
    },
  );

  it(
    // test-plan §2 (🟡): n cap is respected — readRecentIndex with n=2 returns
    // at most 2 rows
    'readRecentIndex respects the n cap',
    () => {
      const indexPath = join(tmpDir, 'index.jsonl');
      for (let i = 0; i < 5; i++) {
        appendIndexRow(indexPath, makeIndexRow({ id: `mut-${i}` }));
      }

      const rows = readRecentIndex(indexPath, 2);
      expect(rows).toHaveLength(2);
    },
  );

  it(
    // test-plan §2 (🟡): torn trailing line — file has 3 valid rows + a 4th
    // torn/garbage line; readRecentIndex returns the 3 valid rows newest-first
    // and does NOT throw.
    '3 valid rows + torn trailing line → 3 valid rows returned, no throw',
    () => {
      const indexPath = join(tmpDir, 'index.jsonl');
      const rowA = makeIndexRow({ id: 'mut-a' });
      const rowB = makeIndexRow({ id: 'mut-b' });
      const rowC = makeIndexRow({ id: 'mut-c' });

      // Write 3 valid JSON lines
      const validLines = [rowA, rowB, rowC].map(r => JSON.stringify(r)).join('\n');
      // Append a 4th torn/garbage line (partial JSON, no newline at end — crash mid-append)
      const torn = '\n{"id":"mut-d","project":"partial JSON without closing';
      writeFileSync(indexPath, validLines + torn, 'utf8');

      let rows: WorkRunIndexRow[];
      expect(() => {
        rows = readRecentIndex(indexPath, 10);
      }).not.toThrow();

      // The 3 valid rows are returned
      expect(rows!).toHaveLength(3);

      // Verify the torn line was not included
      const ids = rows!.map(r => r.id);
      expect(ids).not.toContain('mut-d');
    },
  );

  it(
    // Edge: readRecentIndex on a non-existent file should return [] gracefully
    // (mirrors the skip-malformed pattern from readRecentMutations).
    // The scaffold throws notImplemented, so this test will be RED until the
    // implementation handles a missing file by returning an empty array.
    'readRecentIndex on non-existent file returns [] (graceful, does not throw)',
    () => {
      const missingPath = join(tmpDir, 'nonexistent-index.jsonl');
      // The implementation must return an empty array for a missing file —
      // readers calling this at startup must not crash if no index exists yet.
      const rows = readRecentIndex(missingPath, 10);
      expect(Array.isArray(rows)).toBe(true);
      expect(rows).toHaveLength(0);
    },
  );

  it(
    // test-plan §2 (🟡): mutation status stays in existing enum after
    // appendIndexRow — the index row has outcome, not status, so it cannot
    // corrupt the status enum. This test verifies the index row never gains
    // a status field (which would conflict with MutationStatus).
    'index rows carry outcome, not status — no status field on index rows',
    () => {
      const indexPath = join(tmpDir, 'index.jsonl');
      const row = makeIndexRow({ outcome: 'failed' });
      appendIndexRow(indexPath, row);

      const rows = readRecentIndex(indexPath, 10);
      expect(rows).toHaveLength(1);
      const retrieved = rows[0]!;

      // outcome is present
      expect(retrieved.outcome).toBe('failed');
      // status must NOT appear on index rows (it is a MutationDescriptor field,
      // not a WorkRunIndexRow field)
      expect(Object.prototype.hasOwnProperty.call(retrieved, 'status')).toBe(false);
    },
  );
});
