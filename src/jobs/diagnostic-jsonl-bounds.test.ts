import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readRecentIndexBounded } from './work-run-store.js';
import { readRecentOrchestratedTaskRunRecords } from './task-run-record-store.js';
import { readAllRunsBounded } from './supervision-store.js';

describe('bounded diagnostic JSONL readers', () => {
  it('reads only the recent index byte tail and returns newest rows first', () => {
    const root = mkdtempSync(join(tmpdir(), 'rune-index-tail-'));
    const path = join(root, 'index.jsonl');
    const row = (id: string, padding = '') => JSON.stringify({
      id, project: 'p', outcome: 'failed', durationMs: 1,
      startedAt: '2026-01-01T00:00:00Z', endedAt: '2026-01-01T00:00:01Z', padding,
    });
    writeFileSync(path, `${row('old-run', 'x'.repeat(4_000))}\n${row('new-run-1')}\n${row('new-run-2')}\n`);
    try {
      expect(readRecentIndexBounded(path, 2, 512).map(item => item.id)).toEqual(['new-run-2', 'new-run-1']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('bounds task-record reads and rejects traversal ids before joining paths', () => {
    const root = mkdtempSync(join(tmpdir(), 'rune-task-tail-'));
    const runId = 'valid-run-1234';
    const dir = join(root, runId);
    mkdirSync(dir);
    const record = (taskId: string, padding = '') => JSON.stringify({ taskId, rolesInvoked: [], padding });
    writeFileSync(join(dir, 'task-records.jsonl'), `${record('old', 'x'.repeat(4_000))}\n${record('new-1')}\n${record('new-2')}\n`);
    try {
      expect(readRecentOrchestratedTaskRunRecords(root, runId, 2, 512).map(item => item.taskId))
        .toEqual(['new-1', 'new-2']);
      expect(readRecentOrchestratedTaskRunRecords(root, 'abcdefgh-../../foreign', 20)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('marks an oversized supervision source incomplete and preserves every bounded entry', () => {
    const root = mkdtempSync(join(tmpdir(), 'rune-supervision-bound-'));
    const path = join(root, 'supervised-runs.json');
    const runs = Array.from({ length: 4 }, (_, index) => ({
      id: `run-${index}`, product: 'assay', project: 'p', status: 'running',
      startedAt: `2026-01-0${index + 1}T00:00:00Z`, lastHeartbeatAt: '2026-01-01T00:00:00Z',
    }));
    writeFileSync(path, JSON.stringify(runs));
    try {
      expect(readAllRunsBounded(path, 10)).toEqual({ runs: [], complete: false });
      expect(readAllRunsBounded(path, 10_000)).toEqual({ runs, complete: true });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('drops malformed nested diagnostic records before projection', () => {
    const root = mkdtempSync(join(tmpdir(), 'rune-diagnostic-validation-'));
    const runId = 'valid-run-1234';
    const dir = join(root, runId);
    const supervisionPath = join(root, 'supervised-runs.json');
    mkdirSync(dir);
    writeFileSync(join(dir, 'task-records.jsonl'), [
      JSON.stringify({ taskId: 'bad-warning', rolesInvoked: ['qa'], warnings: [null] }),
      JSON.stringify({ taskId: 'good', rolesInvoked: ['qa'], warnings: [] }),
      '',
    ].join('\n'));
    writeFileSync(supervisionPath, JSON.stringify([{
      id: runId, product: 'assay', project: 'p', status: 'blocked-on-human',
      startedAt: '2026-01-01T00:00:00Z', lastHeartbeatAt: '2026-01-01T00:00:00Z',
      parkedQuestion: { question: 'bad', options: [null], askedAt: '2026-01-01T00:00:00Z' },
    }]));
    try {
      expect(readRecentOrchestratedTaskRunRecords(root, runId, 20).map(item => item.taskId))
        .toEqual(['good']);
      expect(readAllRunsBounded(supervisionPath)).toEqual({
        runs: [expect.not.objectContaining({ parkedQuestion: expect.anything() })],
        complete: true,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('marks a snapshot incomplete when a base supervision record is malformed', () => {
    const root = mkdtempSync(join(tmpdir(), 'rune-supervision-malformed-'));
    const path = join(root, 'supervised-runs.json');
    writeFileSync(path, JSON.stringify([{
      id: 'run-valid', product: 'assay', project: 'p', status: 'not-a-status',
      startedAt: '2026-01-01T00:00:00Z', lastHeartbeatAt: '2026-01-01T00:00:00Z',
    }]));
    try {
      expect(readAllRunsBounded(path)).toEqual({ runs: [], complete: false });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
