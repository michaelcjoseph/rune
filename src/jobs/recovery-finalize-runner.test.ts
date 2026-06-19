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
    // Default: no durable phase recorded → hold-mode re-drive (no merge).
    readLastPhase: () => null,
    recordPhase: () => {},
    runGate: vi.fn(async () => ({ ok: true as const })),
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

  it('resumes a crashed gated-merge run from `merged-not-pushed`: completes push then delete, never re-merges (Phase 3.5)', async () => {
    const run = makeRun();
    const gitCalls: string[][] = [];
    const recordedPhases: string[] = [];
    const { io, captured } = makeIO({
      runGit: vi.fn(async (args: string[]) => {
        gitCalls.push([...args]);
        if (args.some(a => a.includes('merge-base'))) return { stdout: 'base000sha\n', stderr: '' };
        if (args.some(a => a.includes('rev-list'))) return { stdout: 'a1\nb2\n', stderr: '' };
        return { stdout: '', stderr: '' };
      }),
      // The project has later-phase unchecked boxes — recovery's absolute count
      // would call this `partial`, but the recorded merge phase is authoritative.
      readTasks: () => '## Phase A\n- [x] Task 1\n## Phase B\n- [ ] Future task\n',
      readLastPhase: () => 'merged-not-pushed',
      recordPhase: (_id, phase) => { recordedPhases.push(phase); },
    });

    const status = await __finalizeStaleRunForTest(run, io);

    expect(status).toBe('completed');
    // The interrupted merge is COMPLETED: push (explicit origin <base>) then
    // branch delete — push BEFORE delete, no re-merge (merge args never appear).
    const pushIdx = gitCalls.findIndex(a => a.includes('push'));
    const deleteIdx = gitCalls.findIndex(a => a.includes('branch') && a.includes('-d'));
    expect(pushIdx).toBeGreaterThanOrEqual(0);
    expect(deleteIdx).toBeGreaterThanOrEqual(0);
    expect(pushIdx).toBeLessThan(deleteIdx);
    expect(gitCalls.some(a => a.includes('merge') && !a.includes('merge-base'))).toBe(false);
    // The push targets the explicit refspec.
    expect(gitCalls[pushIdx]).toEqual(['push', 'origin', 'main']);
    // Forced branch-complete despite the later-phase unchecked box (the merge
    // already landed) so the push wasn't stranded.
    expect(captured.removed).toHaveLength(1);
    expect(recordedPhases).toContain('pushed-not-deleted');
    // The summary is re-stamped post-resume so the cockpit shows merged, not a
    // gate-held branch-complete (the pre-merge summary write was skipped).
    const lastSummary = captured.summaries.at(-1)!.summary;
    expect(lastSummary.merged).toBe(true);
    expect(lastSummary.baseBranch).toBe('main');
  });

  it('resumes from `pushed-not-deleted`: only deletes the branch, never re-merges or re-pushes (Phase 3.5)', async () => {
    const run = makeRun();
    const gitCalls: string[][] = [];
    const { io } = makeIO({
      runGit: vi.fn(async (args: string[]) => {
        gitCalls.push([...args]);
        if (args.some(a => a.includes('merge-base'))) return { stdout: 'base000sha\n', stderr: '' };
        if (args.some(a => a.includes('rev-list'))) return { stdout: 'a1\nb2\n', stderr: '' };
        return { stdout: '', stderr: '' };
      }),
      readLastPhase: () => 'pushed-not-deleted',
    });

    await __finalizeStaleRunForTest(run, io);

    // Push already landed before the crash → never re-push or re-merge; only the
    // branch delete completes.
    expect(gitCalls.some(a => a.includes('push'))).toBe(false);
    expect(gitCalls.some(a => a.includes('merge') && !a.includes('merge-base'))).toBe(false);
    expect(gitCalls.some(a => a.includes('branch') && a.includes('-d'))).toBe(true);
  });

  it('dedupes a second startup pass after `pushed-not-deleted` recovery reaches `finalized`', async () => {
    const run = makeRun();
    const gitCalls: string[][] = [];
    const recordedPhases: string[] = [];
    let lastPhase: string | null = 'pushed-not-deleted';
    const { io, captured } = makeIO({
      runGit: vi.fn(async (args: string[]) => {
        gitCalls.push([...args]);
        if (args.some(a => a.includes('merge-base'))) return { stdout: 'base000sha\n', stderr: '' };
        if (args.some(a => a.includes('rev-list'))) return { stdout: 'a1\nb2\n', stderr: '' };
        return { stdout: '', stderr: '' };
      }),
      readLastPhase: () => lastPhase as never,
      recordPhase: (_id, phase) => {
        recordedPhases.push(phase);
        lastPhase = phase;
      },
    });

    const firstStatus = await __finalizeStaleRunForTest(run, io);
    expect(firstStatus).toBe('completed');
    expect(lastPhase).toBe('finalized');

    const countsAfterFirstPass = {
      branchDeletes: gitCalls.filter(a => a.includes('branch') && a.includes('-d')).length,
      pushes: gitCalls.filter(a => a.includes('push')).length,
      merges: gitCalls.filter(a => a.includes('merge') && !a.includes('merge-base')).length,
      summaries: captured.summaries.length,
      indexRows: captured.indexRows.length,
      supervisionWrites: captured.upserts.length,
      removals: captured.removed.length,
      phases: recordedPhases.length,
    };

    const secondStatus = await __finalizeStaleRunForTest(run, io);

    expect(secondStatus).toBe('completed');
    expect(gitCalls.filter(a => a.includes('branch') && a.includes('-d'))).toHaveLength(
      countsAfterFirstPass.branchDeletes,
    );
    expect(gitCalls.filter(a => a.includes('push'))).toHaveLength(countsAfterFirstPass.pushes);
    expect(gitCalls.filter(a => a.includes('merge') && !a.includes('merge-base'))).toHaveLength(
      countsAfterFirstPass.merges,
    );
    expect(captured.summaries).toHaveLength(countsAfterFirstPass.summaries);
    expect(captured.indexRows).toHaveLength(countsAfterFirstPass.indexRows);
    expect(captured.upserts).toHaveLength(countsAfterFirstPass.supervisionWrites);
    expect(captured.removed).toHaveLength(countsAfterFirstPass.removals);
    expect(recordedPhases).toHaveLength(countsAfterFirstPass.phases);
  });

  it('resumes from `project-marked-done`: skips the already-committed index flip, then gates/merges/pushes/deletes exactly once (Phase 15)', async () => {
    const run = makeRun();
    const gitCalls: string[][] = [];
    const recordedPhases: string[] = [];
    const { io, captured } = makeIO({
      runGit: vi.fn(async (args: string[]) => {
        gitCalls.push([...args]);
        if (args.some(a => a.includes('merge-base'))) return { stdout: 'base000sha\n', stderr: '' };
        // Includes the already-committed project-Done commit; recovery must
        // classify from branch HEAD, not persist stale pre-index-flip facts.
        if (args.some(a => a.includes('rev-list'))) return { stdout: 'a1\nb2\nprojectDone3\n', stderr: '' };
        return { stdout: '', stderr: '' };
      }),
      readLastPhase: () => 'project-marked-done',
      recordPhase: (_id, phase) => { recordedPhases.push(phase); },
    });

    const status = await __finalizeStaleRunForTest(run, io);

    expect(status).toBe('completed');
    // The index flip already committed before the crash, so resume must not
    // record or re-run that phase. It starts from the next durable side effect.
    expect(recordedPhases).not.toContain('project-marked-done');
    expect(recordedPhases).toEqual(expect.arrayContaining([
      'summary-written',
      'index-appended',
      'merged-not-pushed',
      'pushed-not-deleted',
      'worktree-resolved',
      'finalized',
    ]));

    const mergeIdx = gitCalls.findIndex(a => a.includes('merge') && !a.includes('merge-base'));
    const pushIdx = gitCalls.findIndex(a => a.includes('push'));
    const deleteIdx = gitCalls.findIndex(a => a.includes('branch') && a.includes('-d'));
    expect(mergeIdx).toBeGreaterThanOrEqual(0);
    expect(pushIdx).toBeGreaterThanOrEqual(0);
    expect(deleteIdx).toBeGreaterThanOrEqual(0);
    expect(mergeIdx).toBeLessThan(pushIdx);
    expect(pushIdx).toBeLessThan(deleteIdx);
    expect(gitCalls.filter(a => a.includes('merge') && !a.includes('merge-base'))).toHaveLength(1);
    expect(gitCalls.filter(a => a.includes('push'))).toHaveLength(1);

    expect(captured.removed).toHaveLength(1);
    expect(captured.upserts.at(-1)?.status).toBe('completed');
    const lastSummary = captured.summaries.at(-1)!.summary;
    expect(lastSummary.outcome).toBe('branch-complete');
    expect(lastSummary.workProduct.commitCount).toBe(3);
    expect(lastSummary.workProduct.commitShas).toEqual(['a1', 'b2', 'projectDone3']);
    expect(lastSummary.merged).toBe(true);
    expect(lastSummary.branchDeleted).toBe(true);
    expect(lastSummary.baseBranch).toBe('main');
  });

  it('keeps the project-marked-done recovery gate and merge under the same base-branch lock', async () => {
    const runA = makeRun({ id: 'mut-recover-a', project: '15-work-run-finalizer-a' });
    const runB = makeRun({ id: 'mut-recover-b', project: '15-work-run-finalizer-b' });
    let mergeInFlight = false;
    let gateRanDuringMerge = false;
    let mergeStarted!: () => void;
    let releaseMerge!: () => void;
    const mergeStartedPromise = new Promise<void>((resolve) => { mergeStarted = resolve; });
    const releaseMergePromise = new Promise<void>((resolve) => { releaseMerge = resolve; });

    const { io } = makeIO({
      runGit: vi.fn(async (args: string[]) => {
        if (args.some(a => a.includes('merge-base'))) return { stdout: 'base000sha\n', stderr: '' };
        if (args.some(a => a.includes('rev-list'))) return { stdout: 'a1\nb2\nprojectDone3\n', stderr: '' };
        if (args[0] === 'merge') {
          mergeInFlight = true;
          mergeStarted();
          await releaseMergePromise;
          mergeInFlight = false;
        }
        return { stdout: '', stderr: '' };
      }),
      readLastPhase: () => 'project-marked-done',
      runGate: vi.fn(async () => {
        if (mergeInFlight) gateRanDuringMerge = true;
        return { ok: true as const };
      }),
    });

    const first = __finalizeStaleRunForTest(runA, io);
    await mergeStartedPromise;
    const second = __finalizeStaleRunForTest(runB, io);
    await Promise.resolve();
    expect(gateRanDuringMerge).toBe(false);

    releaseMerge();
    await Promise.all([first, second]);
    expect(gateRanDuringMerge).toBe(false);
  });

  it('a run with NO recorded merge phase re-drives in hold mode — never initiates a merge at boot (Phase 3.5)', async () => {
    const run = makeRun();
    const gitCalls: string[][] = [];
    const { io } = makeIO({
      runGit: vi.fn(async (args: string[]) => {
        gitCalls.push([...args]);
        if (args.some(a => a.includes('merge-base'))) return { stdout: 'base000sha\n', stderr: '' };
        if (args.some(a => a.includes('rev-list'))) return { stdout: 'a1\nb2\n', stderr: '' };
        return { stdout: '', stderr: '' };
      }),
      readLastPhase: () => 'index-appended', // crashed BEFORE the merge
    });

    await __finalizeStaleRunForTest(run, io);

    // Recovery only COMPLETES an interrupted merge; it never INITIATES one — no
    // merge/push/delete for a run that hadn't started merging.
    expect(gitCalls.some(a => a.includes('push'))).toBe(false);
    expect(gitCalls.some(a => a.includes('merge') && !a.includes('merge-base'))).toBe(false);
    expect(gitCalls.some(a => a.includes('branch') && a.includes('-d'))).toBe(false);
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
