/**
 * Unit tests for `src/jobs/recovery-finalize-runner.ts` — the real
 * `finalizeStaleRun` wiring that index.ts runs at startup (project 15, P0.4).
 *
 * The pure orchestration core (`recoverAndFinalizeStaleRuns`) is covered in
 * supervision-recovery.test.ts with an injected finalizer. THIS suite verifies
 * the production `finalizeStaleRun` itself — classify on work product →
 * hold-mode finalizer → terminal supervision — using injected git/fs/store
 * seams so it runs with no real repo, worktree, or disk.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../config.js', () => ({
  default: {
    LOGS_DIR: '/tmp',
    PROJECT_ROOT: '/test/project',
    VAULT_DIR: '/test/vault',
    WORKSPACE_DIR: '/test/workspace',
    SUPERVISED_RUNS_FILE: '/tmp/supervised-runs.json',
    MUTATIONS_LOG_FILE: '/tmp/mutations.jsonl',
    PRODUCTS_CONFIG_FILE: '/tmp/products.json',
    WORKTREE_ROOT: '/tmp/worktrees',
    WORK_RUNS_DIR: '/tmp/work-runs',
    WORK_RUNS_INDEX_FILE: '/tmp/work-runs/index.jsonl',
    TELEGRAM_BOT_TOKEN: 'test-token',
    TELEGRAM_USER_ID: 42,
  },
  PROJECT_ROOT: '/test/project',
}));

import type { SupervisedRun } from '../intent/supervision.js';
import type { ProductConfig } from './sandbox-runtime.js';
import type { WorkRunSummary, WorkRunIndexRow } from './work-run-store.js';
import { __finalizeStaleRunForTest, type RecoveryFinalizeIO } from './recovery-finalize-runner.js';

function makeRun(over: Partial<SupervisedRun> = {}): SupervisedRun {
  return {
    id: 'mut-recover-1',
    product: 'jarvis',
    project: '15-work-run-finalizer',
    status: 'running',
    startedAt: '2026-06-07T00:00:00.000Z',
    lastHeartbeatAt: '2026-06-07T00:00:00.000Z',
    ...over,
  };
}

const PRODUCT: ProductConfig = {
  repoPath: '/tmp/repo',
  baseBranch: 'main',
  credentialsFile: '/tmp/creds',
  egressAllowlist: ['example.com'],
  validationCommands: [],
};

/** A git stub matching on a key arg, like the work-runner/classify suites. */
function gitStub(responses: Record<string, string>) {
  return vi.fn(async (args: string[]) => {
    for (const [key, stdout] of Object.entries(responses)) {
      if (args.some((a) => a.includes(key))) return { stdout, stderr: '' };
    }
    return { stdout: '', stderr: '' };
  });
}

interface Captured {
  summaries: Array<{ dir: string; summary: WorkRunSummary }>;
  indexRows: Array<{ filePath: string; row: WorkRunIndexRow }>;
  upserts: SupervisedRun[];
  removed: SupervisedRun[];
}

function makeIO(over: Partial<RecoveryFinalizeIO> = {}): { io: RecoveryFinalizeIO; captured: Captured } {
  const captured: Captured = { summaries: [], indexRows: [], upserts: [], removed: [] };
  const io: RecoveryFinalizeIO = {
    runGit: gitStub({
      'merge-base': 'base000sha\n',
      'rev-list': 'a1\nb2\n', // 2 commits ahead of base
      'diff': ' src/foo.ts | 3 +++\n 1 file changed, 3 insertions(+)\n',
      'status': '', // clean tree
    }),
    getProduct: () => PRODUCT,
    worktreeFor: (product, project) => `/tmp/worktrees/${product}/${project}`,
    worktreeExists: () => true,
    readTasks: () => '## Phase A\n- [x] Task 1\n- [x] Task 2\n', // all checked
    writeSummaryFile: (dir, summary) => { captured.summaries.push({ dir, summary }); },
    appendIndex: (filePath, row) => { captured.indexRows.push({ filePath, row }); },
    upsertSupervision: (run) => { captured.upserts.push(run); },
    removeWorktree: async (run) => { captured.removed.push(run); },
    now: () => Date.parse('2026-06-07T01:00:00.000Z'),
    ...over,
  };
  return { io, captured };
}

describe('finalizeStaleRun (P0.4 recovery wiring)', () => {
  it('a clean, complete branch → branch-complete, supervision completed, worktree removed', async () => {
    const run = makeRun();
    const { io, captured } = makeIO();

    const status = await __finalizeStaleRunForTest(run, io);

    expect(status).toBe('completed');
    // Classified on work product: 2 commits + 0 unchecked tasks → branch-complete.
    expect(captured.summaries).toHaveLength(1);
    expect(captured.summaries[0]!.summary.outcome).toBe('branch-complete');
    expect(captured.summaries[0]!.summary.baseSha).toBe('base000sha');
    expect(captured.summaries[0]!.summary.branch).toBe('jarvis-work/15-work-run-finalizer');
    // Index row + terminal supervision upsert + worktree removal all happened.
    expect(captured.indexRows).toHaveLength(1);
    expect(captured.indexRows[0]!.row.outcome).toBe('branch-complete');
    expect(captured.upserts).toHaveLength(1);
    expect(captured.upserts[0]!.status).toBe('completed');
    expect(captured.removed).toHaveLength(1);
  });

  it('a branch with commits but unchecked tasks → partial (still a terminal completed status)', async () => {
    const run = makeRun();
    const { io, captured } = makeIO({
      readTasks: () => '## Phase A\n- [x] Task 1\n- [ ] Task 2\n', // one unchecked
    });

    const status = await __finalizeStaleRunForTest(run, io);

    expect(status).toBe('completed'); // partial is a completed-kind terminal
    expect(captured.summaries[0]!.summary.outcome).toBe('partial');
  });

  it('zero commits + clean tree → noop (terminal), still removes the worktree', async () => {
    const run = makeRun();
    const { io, captured } = makeIO({
      runGit: gitStub({ 'merge-base': 'base000sha\n', 'rev-list': '', 'status': '' }),
      readTasks: () => '',
    });

    const status = await __finalizeStaleRunForTest(run, io);

    expect(status).toBe('completed');
    expect(captured.summaries[0]!.summary.outcome).toBe('noop');
    expect(captured.removed).toHaveLength(1);
  });

  it('throws when the worktree is already gone (caught per-run by the recovery core → unknown fallback)', async () => {
    const run = makeRun();
    const { io } = makeIO({ worktreeExists: () => false });

    await expect(__finalizeStaleRunForTest(run, io)).rejects.toThrow(/worktree absent/i);
  });

  it('throws when there is no merge-base (left for the unknown fallback)', async () => {
    const run = makeRun();
    const { io } = makeIO({ runGit: gitStub({ 'merge-base': '\n' }) });

    await expect(__finalizeStaleRunForTest(run, io)).rejects.toThrow(/merge-base/i);
  });

  it('rejects a tampered run whose id is a path-traversal string (no fs write happens)', async () => {
    // supervised-runs.json is process-writable; a tampered id would otherwise
    // flow into join(WORK_RUNS_DIR, id) for writeSummary. The boundary guard
    // throws → the recovery core catches it → unknown-relabel fallback.
    const run = makeRun({ id: '../../etc/evil' });
    const { io, captured } = makeIO();

    await expect(__finalizeStaleRunForTest(run, io)).rejects.toThrow(/invalid id slug/i);
    expect(captured.summaries).toHaveLength(0);
    expect(captured.removed).toHaveLength(0);
  });
});
