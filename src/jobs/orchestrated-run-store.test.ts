import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { TaskRunRecord } from '../intent/orch-run-record.js';
import type { OrchestrationRunCursor } from '../intent/project-orchestrator.js';

type AttestedTaskRunRecord = Omit<TaskRunRecord, 'fullSuiteAttestation' | 'validationReceipt'> & {
  fullSuiteAttestation?: Record<string, unknown>;
  validationReceipt?: Record<string, unknown>;
};

vi.hoisted(() => {
  process.env['TELEGRAM_BOT_TOKEN'] = 'test-token';
  process.env['TELEGRAM_USER_ID'] = '12345';
  process.env['VAULT_DIR'] = '/tmp/test-vault';
  process.env['WORKSPACE_DIR'] = '/tmp/test-workspace';
});

import * as runnerModule from './orchestrated-work-runner.js';

type OrchestratedRunStoreExports = {
  appendOrchestratedTaskRunRecord?: (
    baseDir: string,
    runId: string,
    record: TaskRunRecord | AttestedTaskRunRecord,
  ) => void | Promise<void>;
  readOrchestratedTaskRunRecords?: (baseDir: string, runId: string) => TaskRunRecord[] | Promise<TaskRunRecord[]>;
  writeOrchestratedRunCursor?: (baseDir: string, runId: string, cursor: OrchestrationRunCursor) => void | Promise<void>;
  readOrchestratedRunCursor?: (baseDir: string, runId: string) => OrchestrationRunCursor | null | Promise<OrchestrationRunCursor | null>;
  invalidateOrchestratedRunCursor?: (baseDir: string, runId: string, reason: string) => void | Promise<void>;
  claimOrchestratedNotificationPublication?: (
    baseDir: string,
    runId: string,
    publication: {
      kind: 'closeout-progress' | 'merge-success';
      key: string;
      commitSha?: string;
      branch?: string;
      phase?: string;
    },
  ) => { shouldPublish: boolean; key: string } | Promise<{ shouldPublish: boolean; key: string }>;
  recordOrchestratedNotificationPublicationError?: (
    baseDir: string,
    runId: string,
    publication: {
      kind: 'closeout-progress' | 'merge-success';
      key: string;
      error: string;
      commitSha?: string;
      branch?: string;
      phase?: string;
    },
  ) => void | Promise<void>;
  readOrchestratedNotificationPublications?: (
    baseDir: string,
    runId: string,
  ) => Array<{
    kind: 'closeout-progress' | 'merge-success';
    key: string;
    status: 'published' | 'skipped' | 'error';
    commitSha?: string;
    branch?: string;
    phase?: string;
    reason?: string;
    error?: string;
  }> | Promise<Array<{
    kind: 'closeout-progress' | 'merge-success';
    key: string;
    status: 'published' | 'skipped' | 'error';
    commitSha?: string;
    branch?: string;
    phase?: string;
    reason?: string;
    error?: string;
  }>>;
};

const store = runnerModule as OrchestratedRunStoreExports;

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'orchestrated-run-store-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function readyRecord(overrides: Partial<AttestedTaskRunRecord> = {}): AttestedTaskRunRecord {
  return {
    taskId: 'persist-records-and-cursor',
    taskText: 'Persist records and cursor',
    attemptId: 'mut-orch-1-persist-records-and-cursor',
    rolesInvoked: ['qa', 'coder', 'reviewer', 'tech-lead'],
    transcriptIds: ['transcript-1'],
    modelChoices: { coder: 'codex', reviewer: 'claude' },
    commitSha: 'abc1234',
    verdicts: { reviewer: 'pass', 'tech-lead': 'pass' },
    contextOutcome: 'updated',
    gates: { objectionOpen: false },
    outcome: 'ready-for-closeout',
    ...overrides,
  };
}

function durableAttestation(): Record<string, unknown> {
  return {
    version: 1,
    treeOid: '1'.repeat(40),
    fullTaskReviewHash: 'a'.repeat(64),
    validationCwd: '.',
    configuredArgv: [['npm', 'test']],
    adapter: { runner: 'vitest', version: 1 },
    commandFingerprint: 'c'.repeat(64),
    configurationFingerprint: 'd'.repeat(64),
    dependencyFingerprint: 'e'.repeat(64),
    startedAt: '2026-07-30T12:00:00.000Z',
    completedAt: '2026-07-30T12:00:05.000Z',
    durationMs: 5_000,
    execution: { outcome: 'passed', exitCode: 0, timedOut: false, cancelled: false },
    coverage: {
      status: 'complete',
      manifest: {
        version: 1,
        runner: 'vitest',
        completedNormally: true,
        collectionErrors: 0,
        discovered: { suites: 3, tests: 7 },
        completed: {
          suites: 3, tests: 7, passed: 4, failed: 0, skipped: 1, todo: 2, cancelled: 0,
        },
      },
    },
  };
}

function cursor(overrides: Partial<OrchestrationRunCursor> = {}): OrchestrationRunCursor {
  return {
    runId: 'mut-orch-1',
    product: 'rune',
    project: '14-product-team-agents',
    branch: 'rune-work/14-product-team-agents',
    baseBranch: 'main',
    worktreePath: '/tmp/rune-worktrees/rune/14-product-team-agents',
    resumeMarker: 'resumable',
    cursor: {
      completedTaskIds: ['persist-records-and-cursor'],
      currentTaskId: null,
      nextTaskId: 'resume-boot',
    },
    ...overrides,
  };
}

async function readRecords(baseDir: string, runId: string): Promise<TaskRunRecord[]> {
  return Promise.resolve(store.readOrchestratedTaskRunRecords!(baseDir, runId));
}

async function readCursor(baseDir: string, runId: string): Promise<OrchestrationRunCursor | null> {
  return Promise.resolve(store.readOrchestratedRunCursor!(baseDir, runId));
}

async function readPublications(baseDir: string, runId: string) {
  return Promise.resolve(store.readOrchestratedNotificationPublications!(baseDir, runId));
}

describe('orchestrated run store', () => {
  it('appends TaskRunRecords as JSONL and reads them back in append order', async () => {
    expect(typeof store.appendOrchestratedTaskRunRecord).toBe('function');
    expect(typeof store.readOrchestratedTaskRunRecords).toBe('function');

    const first = readyRecord({ taskId: 'first-task', attemptId: 'mut-orch-1-first-task' });
    const second = readyRecord({ taskId: 'second-task', attemptId: 'mut-orch-1-second-task', commitSha: 'def5678' });

    await store.appendOrchestratedTaskRunRecord!(tmpDir, 'mut-orch-1', first);
    await store.appendOrchestratedTaskRunRecord!(tmpDir, 'mut-orch-1', second);

    const recordsPath = join(tmpDir, 'mut-orch-1', 'task-records.jsonl');
    expect(existsSync(recordsPath)).toBe(true);
    expect(readFileSync(recordsPath, 'utf8').trimEnd().split('\n')).toHaveLength(2);

    await expect(readRecords(tmpDir, 'mut-orch-1')).resolves.toEqual([first, second]);
  });

  it('persists pass-with-warnings findings and accepted-block rationales in TaskRunRecords', async () => {
    expect(typeof store.appendOrchestratedTaskRunRecord).toBe('function');
    expect(typeof store.readOrchestratedTaskRunRecords).toBe('function');

    const warning = {
      class: 'cost-perf',
      severity: 'low',
      location: 'src/cache.ts:44',
      rationale: 'follow-up can reduce duplicate reads; correctness is unaffected',
    } as const;
    const acceptance = {
      actor: 'pm',
      decision: 'accepted-with-rationale',
      rationale:
        'Accepting because the remaining concern is non-blocking and the task contract is satisfied.',
    } as const;
    const record = readyRecord({
      verdicts: { reviewer: 'pass-with-warnings' },
      warnings: [warning],
      acceptance,
      coderSelfReviews: [{
        round: 1,
        outcome: 'revised',
        notes: 'Corrected the staged retry guard.',
        canonicalHash: 'canonical-hash',
        changedPaths: ['src/cache.ts'],
        artifactAttempts: [{
          attempt: 1,
          status: 'parsed',
          provider: 'openai',
          progressCount: 2,
          candidateCount: 1,
          diagnostic: 'terminal artifact parsed',
        }],
      }],
    });

    await store.appendOrchestratedTaskRunRecord!(tmpDir, 'mut-orch-1', record);

    await expect(readRecords(tmpDir, 'mut-orch-1')).resolves.toEqual([
      expect.objectContaining({
        verdicts: { reviewer: 'pass-with-warnings' },
        warnings: [warning],
        acceptance,
        coderSelfReviews: [{
          round: 1,
          outcome: 'revised',
          notes: 'Corrected the staged retry guard.',
          canonicalHash: 'canonical-hash',
          changedPaths: ['src/cache.ts'],
          artifactAttempts: [{
            attempt: 1,
            status: 'parsed',
            provider: 'openai',
            progressCount: 2,
            candidateCount: 1,
            diagnostic: 'terminal artifact parsed',
          }],
        }],
      }),
    ]);
  });

  it('keeps historical TaskRunRecords without coderSelfReviews readable', async () => {
    const legacy = readyRecord();
    delete legacy.coderSelfReviews;

    await store.appendOrchestratedTaskRunRecord!(tmpDir, 'mut-orch-legacy', legacy);

    await expect(readRecords(tmpDir, 'mut-orch-legacy')).resolves.toEqual([legacy]);
  });

  it('round-trips a bounded full-suite attestation and compact receipt across restart', async () => {
    const record = readyRecord({
      fullSuiteAttestation: durableAttestation(),
      validationReceipt: {
        provenance: 'full-suite-ran',
        command: 'npm test',
        treeOid: '1'.repeat(40),
        outcome: 'passed',
        coverage: 'complete',
        discovered: { suites: 3, tests: 7 },
        completed: { suites: 3, tests: 7, passed: 4, failed: 0, skipped: 1, todo: 2, cancelled: 0 },
      },
    });

    await store.appendOrchestratedTaskRunRecord!(tmpDir, 'mut-attested', record);

    await expect(readRecords(tmpDir, 'mut-attested')).resolves.toEqual([record]);
    const persisted = readFileSync(
      join(tmpDir, 'mut-attested', 'task-records.jsonl'),
      'utf8',
    );
    expect(persisted).not.toContain('/Users/');
    expect(persisted).not.toContain('TELEGRAM_BOT_TOKEN');
    expect(persisted).not.toContain('outputTail');
  });

  it('keeps a legacy task record readable but drops a malformed historical attestation', async () => {
    const malformed = readyRecord({
      fullSuiteAttestation: {
        ...durableAttestation(),
        validationCwd: '/Users/operator/private/rune',
        environment: { TELEGRAM_BOT_TOKEN: 'secret' },
      },
      validationReceipt: {
        provenance: 'related-ran',
        command: 'npx vitest --config=/Users/operator/private/vitest.config.ts',
        treeOid: '1'.repeat(40),
        outcome: 'passed',
        coverage: 'unsupported',
      },
    });
    mkdirSync(join(tmpDir, 'mut-malformed-attestation'), { recursive: true });
    writeFileSync(
      join(tmpDir, 'mut-malformed-attestation', 'task-records.jsonl'),
      JSON.stringify(malformed) + '\n',
      'utf8',
    );

    const [restored] = await readRecords(tmpDir, 'mut-malformed-attestation') as AttestedTaskRunRecord[];
    expect(restored).toMatchObject({ taskId: malformed.taskId });
    expect(restored).not.toHaveProperty('fullSuiteAttestation');
    expect(restored).not.toHaveProperty('validationReceipt');
    expect(JSON.stringify(restored)).not.toContain('/Users/operator');
    expect(JSON.stringify(restored)).not.toContain('secret');
  });

  it('skips a torn trailing TaskRunRecord line without throwing or losing earlier records', async () => {
    expect(typeof store.readOrchestratedTaskRunRecords).toBe('function');

    const first = readyRecord({ taskId: 'first-task', attemptId: 'mut-orch-1-first-task' });
    const second = readyRecord({ taskId: 'second-task', attemptId: 'mut-orch-1-second-task' });
    mkdirSync(join(tmpDir, 'mut-orch-1'), { recursive: true });
    const recordsPath = join(tmpDir, 'mut-orch-1', 'task-records.jsonl');
    writeFileSync(
      recordsPath,
      `${JSON.stringify(first)}\n${JSON.stringify(second)}\n{"taskId":"third-task","attemptId"`,
      'utf8',
    );

    await expect(readRecords(tmpDir, 'mut-orch-1')).resolves.toEqual([first, second]);
  });

  it('writes the run cursor atomically with the resumable marker and reads it back', async () => {
    expect(typeof store.writeOrchestratedRunCursor).toBe('function');
    expect(typeof store.readOrchestratedRunCursor).toBe('function');

    const runCursor = cursor();

    await store.writeOrchestratedRunCursor!(tmpDir, 'mut-orch-1', runCursor);

    const runDir = join(tmpDir, 'mut-orch-1');
    const cursorPath = join(runDir, 'cursor.json');
    expect(existsSync(cursorPath)).toBe(true);
    expect(JSON.parse(readFileSync(cursorPath, 'utf8'))).toEqual(runCursor);
    expect(readdirSync(runDir).filter((name) => name.includes('cursor.json') && name.endsWith('.tmp'))).toEqual([]);

    await expect(readCursor(tmpDir, 'mut-orch-1')).resolves.toEqual(runCursor);
  });

  it('round-trips an execution checkpoint while continuing to accept legacy cursors without one', async () => {
    const legacy = cursor();
    await store.writeOrchestratedRunCursor!(tmpDir, 'mut-orch-1', legacy);
    await expect(readCursor(tmpDir, 'mut-orch-1')).resolves.toEqual(legacy);

    const checkpointed = cursor({
      executionCheckpoint: {
        taskId: 'task-one',
        role: 'coder',
        provider: 'openai',
        format: 'codex',
        model: 'gpt-test',
        workflowStage: 'coder-implementation',
        checkpointedAt: '2026-07-22T00:00:00.000Z',
      },
    });
    await store.writeOrchestratedRunCursor!(tmpDir, 'mut-orch-1', checkpointed);
    await expect(readCursor(tmpDir, 'mut-orch-1')).resolves.toEqual(checkpointed);
  });

  it('round-trips a task base while rejecting malformed or cross-task identities', async () => {
    const taskBase = {
      taskId: 'persist-records-and-cursor',
      treeOid: '1111111111111111111111111111111111111111',
    };
    const checkpointed = cursor({
      cursor: {
        completedTaskIds: [],
        currentTaskId: taskBase.taskId,
        nextTaskId: taskBase.taskId,
      },
      taskBase,
    });
    await store.writeOrchestratedRunCursor!(tmpDir, checkpointed.runId, checkpointed);
    expect(store.readOrchestratedRunCursor!(tmpDir, checkpointed.runId)).toEqual(
      checkpointed,
    );

    const cursorPath = join(tmpDir, checkpointed.runId, 'cursor.json');
    writeFileSync(
      cursorPath,
      JSON.stringify({ ...checkpointed, taskBase: { ...taskBase, treeOid: '/Users/private/tree' } }),
    );
    expect(store.readOrchestratedRunCursor!(tmpDir, checkpointed.runId)).toBeNull();
    writeFileSync(
      cursorPath,
      JSON.stringify({ ...checkpointed, taskBase: { ...taskBase, taskId: 'other-task' } }),
    );
    expect(store.readOrchestratedRunCursor!(tmpDir, checkpointed.runId)).toBeNull();
  });

  it('does not return a cursor unless the on-disk marker is explicitly resumable for that run', async () => {
    expect(typeof store.readOrchestratedRunCursor).toBe('function');

    const runDir = join(tmpDir, 'mut-orch-1');
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, 'cursor.json'), JSON.stringify({ ...cursor(), resumeMarker: 'running' }), 'utf8');

    await expect(readCursor(tmpDir, 'mut-orch-1')).resolves.toBeNull();

    writeFileSync(join(runDir, 'cursor.json'), JSON.stringify(cursor({ runId: 'different-run' })), 'utf8');

    await expect(readCursor(tmpDir, 'mut-orch-1')).resolves.toBeNull();
  });

  it('returns null for a missing cursor file so recovery can orphan instead of crashing', async () => {
    expect(typeof store.readOrchestratedRunCursor).toBe('function');

    await expect(readCursor(tmpDir, 'mut-orch-1')).resolves.toBeNull();
  });

  it('atomically invalidates a resumable cursor before terminal worktree removal', async () => {
    expect(typeof store.invalidateOrchestratedRunCursor).toBe('function');
    await store.writeOrchestratedRunCursor!(tmpDir, 'mut-orch-1', cursor());

    await store.invalidateOrchestratedRunCursor!(tmpDir, 'mut-orch-1', 'terminal worktree cleanup');

    const runDir = join(tmpDir, 'mut-orch-1');
    const persisted = JSON.parse(readFileSync(join(runDir, 'cursor.json'), 'utf8')) as Record<string, unknown>;
    expect(persisted).toMatchObject({ runId: 'mut-orch-1', reason: 'terminal worktree cleanup' });
    expect(persisted).toHaveProperty('invalidatedAt');
    expect(persisted).not.toHaveProperty('resumeMarker');
    expect(readdirSync(runDir).filter((name) => name.includes('cursor.json') && name.endsWith('.tmp'))).toEqual([]);
    await expect(readCursor(tmpDir, 'mut-orch-1')).resolves.toBeNull();
  });

  it('claims closeout progress publication by commit sha once and records a durable duplicate skip', async () => {
    expect(typeof store.claimOrchestratedNotificationPublication).toBe('function');
    expect(typeof store.readOrchestratedNotificationPublications).toBe('function');

    const publication = {
      kind: 'closeout-progress' as const,
      key: 'closeout-progress:abc1234',
      commitSha: 'abc1234',
    };

    await expect(
      Promise.resolve(store.claimOrchestratedNotificationPublication!(tmpDir, 'mut-orch-1', publication)),
    ).resolves.toEqual({ shouldPublish: true, key: publication.key });
    await expect(
      Promise.resolve(store.claimOrchestratedNotificationPublication!(tmpDir, 'mut-orch-1', publication)),
    ).resolves.toEqual({ shouldPublish: false, key: publication.key });

    await expect(readPublications(tmpDir, 'mut-orch-1')).resolves.toEqual([
      expect.objectContaining({
        kind: 'closeout-progress',
        key: publication.key,
        commitSha: 'abc1234',
        status: 'published',
      }),
      expect.objectContaining({
        kind: 'closeout-progress',
        key: publication.key,
        commitSha: 'abc1234',
        status: 'skipped',
        reason: expect.stringMatching(/duplicate|already/i),
      }),
    ]);
  });

  it('records merge-success publication errors under the run artifact directory without clearing the published claim', async () => {
    expect(typeof store.claimOrchestratedNotificationPublication).toBe('function');
    expect(typeof store.recordOrchestratedNotificationPublicationError).toBe('function');
    expect(typeof store.readOrchestratedNotificationPublications).toBe('function');

    const publication = {
      kind: 'merge-success' as const,
      key: 'mut-orch-1:merge-success:rune-work/demo:pushed-not-deleted',
      branch: 'rune-work/demo',
      phase: 'pushed-not-deleted',
    };

    await store.claimOrchestratedNotificationPublication!(tmpDir, 'mut-orch-1', publication);
    await store.recordOrchestratedNotificationPublicationError!(tmpDir, 'mut-orch-1', {
      ...publication,
      error: 'operator event bus down',
    });

    await expect(readPublications(tmpDir, 'mut-orch-1')).resolves.toEqual([
      expect.objectContaining({
        kind: 'merge-success',
        key: publication.key,
        branch: 'rune-work/demo',
        phase: 'pushed-not-deleted',
        status: 'published',
      }),
      expect.objectContaining({
        kind: 'merge-success',
        key: publication.key,
        branch: 'rune-work/demo',
        phase: 'pushed-not-deleted',
        status: 'error',
        error: 'operator event bus down',
      }),
    ]);
  });
});
