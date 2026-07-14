import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { TaskRunRecord } from '../intent/orch-run-record.js';
import type { OrchestrationRunCursor } from '../intent/project-orchestrator.js';

vi.hoisted(() => {
  process.env['TELEGRAM_BOT_TOKEN'] = 'test-token';
  process.env['TELEGRAM_USER_ID'] = '12345';
  process.env['VAULT_DIR'] = '/tmp/test-vault';
  process.env['WORKSPACE_DIR'] = '/tmp/test-workspace';
});

import * as runnerModule from './orchestrated-work-runner.js';

type OrchestratedRunStoreExports = {
  appendOrchestratedTaskRunRecord?: (baseDir: string, runId: string, record: TaskRunRecord) => void | Promise<void>;
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

function readyRecord(overrides: Partial<TaskRunRecord> = {}): TaskRunRecord {
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
    });

    await store.appendOrchestratedTaskRunRecord!(tmpDir, 'mut-orch-1', record);

    await expect(readRecords(tmpDir, 'mut-orch-1')).resolves.toEqual([
      expect.objectContaining({
        verdicts: { reviewer: 'pass-with-warnings' },
        warnings: [warning],
        acceptance,
      }),
    ]);
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
