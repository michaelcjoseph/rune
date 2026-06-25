/**
 * Test suite for `src/jobs/work-run-finalizer.ts` — the shared finalizer state
 * machine (project 15). test-plan.md §4 (hold mode). §6/§7 (gated-merge,
 * failure path) land with their phases.
 *
 * Written TEST-FIRST: the scaffold's `runFinalizer` throws `notImplemented(...)`,
 * so every test here is RED until the P0.4a impl task fills in `hold` mode. The
 * expected failure is the thrown notImplemented (or a clean assertion once the
 * body lands) — never a module-resolution / syntax error.
 *
 * Hold-mode contract pinned here (spec req 11, 17):
 *   classify → flush transcript → write summary/index → resolve worktree
 *   (remove, branch left intact) → terminal supervision write. NEVER merges,
 *   pushes, or deletes the branch; supervision ends terminal, never `running`.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// work-run-finalizer.ts is type-only at the scaffold stage, but the P0.4a impl
// will import config-bearing modules (mutations/classify/store). Mock config so
// the suite keeps loading cleanly once those imports land.
vi.mock('../config.js', () => ({
  default: {
    LOGS_DIR: '/tmp',
    VAULT_DIR: '/test/vault',
    WORKSPACE_DIR: '/test/workspace',
    PROJECT_ROOT: '/test/project',
    SUPERVISED_RUNS_FILE: '/tmp/supervised-runs.json',
    MUTATIONS_LOG_FILE: '/tmp/mutations.jsonl',
    WORK_RUNS_DIR: '/tmp/work-runs',
    WORK_RUNS_INDEX_FILE: '/tmp/work-runs/index.jsonl',
    TELEGRAM_BOT_TOKEN: 'test-token',
    TELEGRAM_USER_ID: 42,
  },
  PROJECT_ROOT: '/test/project',
}));

import type { MutationEvent } from '../transport/mutations.js';
import {
  runFinalizer,
  type FinalizerEffects,
  type FinalizerInput,
  type FinalizerPhase,
  type GateFailReason,
  type GateResult,
} from './work-run-finalizer.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Shared so the input's runId and the fixture events' mutationId can't drift. */
const DEFAULT_RUN_ID = 'mut-final-hold';

function holdInput(over: Partial<FinalizerInput> = {}): FinalizerInput {
  return {
    mode: 'hold',
    runId: DEFAULT_RUN_ID,
    project: '15-work-run-finalizer',
    product: 'jarvis',
    branch: 'jarvis-work/15-work-run-finalizer',
    baseBranch: 'main',
    ...over,
  };
}

/** A classified terminal event: clean branch-complete (5 commits, no tasks left). */
function branchCompleteEvent(): MutationEvent {
  return {
    mutationId: DEFAULT_RUN_ID,
    ts: '2026-06-07T00:00:00.000Z',
    kind: 'completed',
    data: {
      outcome: 'branch-complete',
      reason: '5 commit(s), all original tasks checked',
      workProduct: {
        commitCount: 5,
        commitShas: ['a1', 'b2', 'c3', 'd4', 'e5'],
        filesChanged: ['src/foo.ts'],
        diffstat: '1 file changed',
        dirty: false,
        untracked: false,
        transitions: { tasksNewlyChecked: 3, tasksRemaining: 0, tasksAdded: 0, tasksRemoved: 0 },
      },
      exit: { exitCode: 0, signal: null, cancelled: false, durationMs: 5000 },
    },
  };
}

function branchCompleteEventWithFindings(findingsLedger: Array<Record<string, unknown>>): MutationEvent {
  const ev = branchCompleteEvent();
  ev.data = {
    ...(ev.data as Record<string, unknown>),
    findingsLedger,
  };
  return ev;
}

/** A classified terminal event for a failed run. */
function failedEvent(): MutationEvent {
  return {
    mutationId: DEFAULT_RUN_ID,
    ts: '2026-06-07T00:00:00.000Z',
    kind: 'failed',
    data: {
      outcome: 'failed',
      reason: 'exited with code 1',
      exit: { exitCode: 1, signal: null, cancelled: false, durationMs: 3000 },
    },
  };
}

/** A classified terminal event for an arbitrary non-merge outcome. `failed`
 *  carries event kind `'failed'`; every other WorkOutcome carries `'completed'`
 *  (mirrors `finalizeWorkRun`: kind = outcome === 'failed' ? 'failed' :
 *  'completed'). `cancelled` is a `failed` outcome whose reason is "cancelled". */
function outcomeEvent(
  outcome: 'partial' | 'noop' | 'dirty-uncommitted' | 'failed',
  reason: string = outcome,
): MutationEvent {
  return {
    mutationId: DEFAULT_RUN_ID,
    ts: '2026-06-07T00:00:00.000Z',
    kind: outcome === 'failed' ? 'failed' : 'completed',
    data: {
      outcome,
      reason,
      exit: {
        exitCode: outcome === 'failed' ? 1 : 0,
        signal: null,
        cancelled: reason === 'cancelled',
        durationMs: 3000,
      },
    },
  };
}

function noopAllTasksCheckedEvent(): MutationEvent {
  const ev = outcomeEvent('noop', 'no commits, all original tasks checked, clean tree');
  ev.data = {
    ...(ev.data as Record<string, unknown>),
    workProduct: {
      commitCount: 0,
      commitShas: [],
      filesChanged: [],
      diffstat: '',
      dirty: false,
      untracked: false,
      transitions: { tasksNewlyChecked: 2, tasksRemaining: 0, tasksAdded: 0, tasksRemoved: 0 },
    },
  };
  return ev;
}

/** Effects bag: every seam a spy, the durable phase store an array. */
function makeEffects(terminalEvent: MutationEvent, over: Partial<FinalizerEffects> = {}) {
  const phases: FinalizerPhase[] = [];
  const effects: FinalizerEffects = {
    classify: vi.fn(async () => terminalEvent),
    flushTranscript: vi.fn(async () => {}),
    writeSummary: vi.fn(),
    appendIndexRow: vi.fn(),
    writeSupervisionTerminal: vi.fn(),
    removeWorktree: vi.fn(async () => {}),
    recordPhase: vi.fn((p: FinalizerPhase) => { phases.push(p); }),
    // Fresh run by default — recovery resume tests (P0.4) override this.
    readLastPhase: vi.fn((): FinalizerPhase | null => null),
    gate: vi.fn(async (): Promise<GateResult> => ({ ok: true })),
    alert: vi.fn(),
    mergeBranch: vi.fn(async () => {}),
    pushBranch: vi.fn(async () => {}),
    deleteBranch: vi.fn(async () => {}),
    ...over,
  };
  return { effects, phases };
}

function gatedMergeInput(over: Partial<FinalizerInput> = {}): FinalizerInput {
  return holdInput({ mode: 'gated-merge', ...over });
}

function mergeSuccessPublicationKey(): string {
  return `${DEFAULT_RUN_ID}:merge-success:jarvis-work/15-work-run-finalizer:pushed-not-deleted`;
}

type MarkProjectIndexDoneInText = (
  content: string,
  slug: string,
) =>
  | { kind: 'updated' | 'already-done'; content: string }
  | {
      kind: 'ambiguous';
      reason: 'malformed-table' | 'no-match' | 'multiple-matches';
      content: string;
    };

async function loadMarkProjectIndexDoneInText(): Promise<MarkProjectIndexDoneInText> {
  const mod = await import('./work-run-finalizer.js') as typeof import('./work-run-finalizer.js') & {
    markProjectIndexDoneInText?: unknown;
  };
  expect(mod.markProjectIndexDoneInText).toEqual(expect.any(Function));
  return mod.markProjectIndexDoneInText as MarkProjectIndexDoneInText;
}

type MarkProjectDoneOnBranch = (opts: {
  worktreePath: string;
  project: string;
  commitMessage?: string;
}) => Promise<{
  kind: 'committed' | 'already-done' | 'skipped' | 'ambiguous';
  reason?: string;
  commitSha?: string | null;
  changedTokens?: string[];
}>;

async function loadMarkProjectDoneOnBranch(): Promise<MarkProjectDoneOnBranch> {
  const mod = await import('./work-run-finalizer.js') as typeof import('./work-run-finalizer.js') & {
    markProjectDoneOnBranch?: unknown;
  };
  expect(mod.markProjectDoneOnBranch).toEqual(expect.any(Function));
  return mod.markProjectDoneOnBranch as MarkProjectDoneOnBranch;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  }).trim();
}

// ---------------------------------------------------------------------------
// Phase 15 — Project index Done writer. WRITE-FIRST: this export does not exist
// yet, so these fail as a clean missing-symbol assertion until the pure writer
// lands. The finalizer wiring tests below prove this writer is invoked as a
// finalizer phase after branch-complete classification and before the gate.
// ---------------------------------------------------------------------------

describe('markProjectIndexDoneInText — Phase 15 project completion writer', () => {
  it('sets the matching project to Done in both the table Status cell and section heading', async () => {
    const markProjectIndexDoneInText = await loadMarkProjectIndexDoneInText();
    const before = [
      '# Projects',
      '',
      '| Project | Status | Summary |',
      '| --- | --- | --- |',
      '| [Product Team](14-product-team-agents/) | Active | Simulated team loop |',
      '| [Other](99-other/) | Active | Leave alone |',
      '',
      '## 14-product-team-agents — Active (reopened 2026-06-14)',
      '',
      'Section body stays byte-for-byte.',
      '',
      '## 99-other — Active',
      '',
    ].join('\n');

    const result = markProjectIndexDoneInText(before, '14-product-team-agents');

    expect(result.kind).toBe('updated');
    expect(result.content).toContain(
      '| [Product Team](14-product-team-agents/) | Done | Simulated team loop |',
    );
    expect(result.content).toContain('## 14-product-team-agents — Done (reopened 2026-06-14)');
    expect(result.content).toContain('| [Other](99-other/) | Active | Leave alone |');
    expect(result.content).toContain('## 99-other — Active');
    expect(result.content).toContain('Section body stays byte-for-byte.');
  });

  it('changes only the matched project status tokens, preserving unrelated rows even when their summaries mention the project', async () => {
    const markProjectIndexDoneInText = await loadMarkProjectIndexDoneInText();
    const before = [
      '# Projects',
      '',
      'Introductory copy stays untouched.',
      '',
      '| Project | Status | Summary |',
      '| :--- | :---: | ---: |',
      '| [Product Team](14-product-team-agents/) | In Progress | Simulated product-team loop |',
      '| [Release Notes](99-release-notes/) | Active | Mentions [Product Team](14-product-team-agents/) as related work |',
      '| [Other](98-other/) | Paused | Leave this row byte-for-byte |',
      '',
      '## 14-product-team-agents — In Progress (reopened 2026-06-14)',
      '',
      'Body text says In Progress and Active; those words are not status tokens.',
      '',
      '## 99-release-notes — Active',
      '',
      'Unrelated section body links to [Product Team](14-product-team-agents/) and stays unchanged.',
      '',
    ].join('\n');
    const expected = [
      '# Projects',
      '',
      'Introductory copy stays untouched.',
      '',
      '| Project | Status | Summary |',
      '| :--- | :---: | ---: |',
      '| [Product Team](14-product-team-agents/) | Done | Simulated product-team loop |',
      '| [Release Notes](99-release-notes/) | Active | Mentions [Product Team](14-product-team-agents/) as related work |',
      '| [Other](98-other/) | Paused | Leave this row byte-for-byte |',
      '',
      '## 14-product-team-agents — Done (reopened 2026-06-14)',
      '',
      'Body text says In Progress and Active; those words are not status tokens.',
      '',
      '## 99-release-notes — Active',
      '',
      'Unrelated section body links to [Product Team](14-product-team-agents/) and stays unchanged.',
      '',
    ].join('\n');

    const result = markProjectIndexDoneInText(before, '14-product-team-agents');

    expect(result.kind).toBe('updated');
    expect(result.content).toBe(expected);
  });

  it('is idempotent for an already-Done project: returns unchanged content and no update signal', async () => {
    const markProjectIndexDoneInText = await loadMarkProjectIndexDoneInText();
    const alreadyDone = [
      '| Project | Status | Summary |',
      '| --- | --- | --- |',
      '| [Product Team](14-product-team-agents/) | Done | Simulated team loop |',
      '',
      '## 14-product-team-agents — Done (reopened 2026-06-14)',
      '',
    ].join('\n');

    const result = markProjectIndexDoneInText(alreadyDone, '14-product-team-agents');

    expect(result.kind).toBe('already-done');
    expect(result.content).toBe(alreadyDone);
  });

  it.each([
    {
      label: 'matching table row but no matching section heading',
      content: [
        '| Project | Status | Summary |',
        '| --- | --- | --- |',
        '| [Product Team](14-product-team-agents/) | Active | Simulated team loop |',
        '',
        '## 99-other — Active',
        '',
      ].join('\n'),
    },
    {
      label: 'matching section heading but no matching table row',
      content: [
        '| Project | Status | Summary |',
        '| --- | --- | --- |',
        '| [Other](99-other/) | Active | Leave alone |',
        '',
        '## 14-product-team-agents — Active (reopened 2026-06-14)',
        '',
      ].join('\n'),
    },
  ] as const)(
    '$label is ambiguous and does not make a one-sided best-effort edit',
    async ({ content }) => {
      const markProjectIndexDoneInText = await loadMarkProjectIndexDoneInText();

      const result = markProjectIndexDoneInText(content, '14-product-team-agents');

      expect(result.kind).toBe('ambiguous');
      if (result.kind !== 'ambiguous') return;
      expect(result.reason).toBe('no-match');
      expect(result.content).toBe(content);
    },
  );

  it.each([
    {
      label: 'present-but-malformed table',
      reason: 'malformed-table',
      content: [
        '| Project | Summary |',
        '| --- | --- |',
        '| [Product Team](14-product-team-agents/) | Simulated team loop |',
        '',
        '## 14-product-team-agents — Active (reopened 2026-06-14)',
        '',
      ].join('\n'),
    },
    {
      label: 'zero matching rows/headings',
      reason: 'no-match',
      content: [
        '| Project | Status | Summary |',
        '| --- | --- | --- |',
        '| [Other](99-other/) | Active | Leave alone |',
        '',
        '## 99-other — Active',
        '',
      ].join('\n'),
    },
    {
      label: 'multiple matching rows/headings',
      reason: 'multiple-matches',
      content: [
        '| Project | Status | Summary |',
        '| --- | --- | --- |',
        '| [Product Team](14-product-team-agents/) | Active | First duplicate |',
        '| [Product Team again](14-product-team-agents/) | Active | Second duplicate |',
        '',
        '## 14-product-team-agents — Active (reopened 2026-06-14)',
        'First section body.',
        '',
        '## 14-product-team-agents — In Progress',
        'Second section body.',
        '',
      ].join('\n'),
    },
  ] as const)(
    '$label returns an ambiguous result and leaves index content untouched',
    async ({ content, reason }) => {
      const markProjectIndexDoneInText = await loadMarkProjectIndexDoneInText();

      const result = markProjectIndexDoneInText(content, '14-product-team-agents');

      expect(result.kind).toBe('ambiguous');
      if (result.kind !== 'ambiguous') return;
      expect(result.reason).toBe(reason);
      expect(result.content).toBe(content);
    },
  );
});

describe('markProjectDoneOnBranch — Phase 15 branch-owned project completion commit', () => {
  let tmpRoot: string | null = null;

  afterEach(() => {
    if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
    tmpRoot = null;
  });

  function makeRepo(indexContent: string): { repoPath: string; branch: string; baseSha: string } {
    tmpRoot = mkdtempSync(join(tmpdir(), 'jarvis-project-done-branch-test-'));
    const repoPath = join(tmpRoot, 'repo');
    const branch = 'jarvis-work/14-product-team-agents';
    mkdirSync(join(repoPath, 'docs/projects'), { recursive: true });
    git(tmpRoot, 'init', '-q', '-b', 'main', repoPath);
    writeFileSync(join(repoPath, 'docs/projects/index.md'), indexContent, 'utf8');
    git(repoPath, 'add', '.');
    git(repoPath, 'commit', '-q', '-m', 'seed project index');
    const baseSha = git(repoPath, 'rev-parse', 'main');

    git(repoPath, 'checkout', '-q', '-b', branch);
    writeFileSync(join(repoPath, 'feature.txt'), 'feature work\n', 'utf8');
    git(repoPath, 'add', '.');
    git(repoPath, 'commit', '-q', '-m', 'feature work');

    return { repoPath, branch, baseSha };
  }

  it('commits the Status→Done edit on the checked-out feature branch, leaving base untouched and the worktree clean', async () => {
    const markProjectDoneOnBranch = await loadMarkProjectDoneOnBranch();
    const { repoPath, branch, baseSha } = makeRepo([
      '# Projects',
      '',
      '| Project | Status | Summary |',
      '| --- | --- | --- |',
      '| [Product Team](14-product-team-agents/) | Active | Simulated team loop |',
      '',
      '## 14-product-team-agents — Active (reopened 2026-06-14)',
      '',
    ].join('\n'));
    const featureHeadBefore = git(repoPath, 'rev-parse', 'HEAD');

    const result = await markProjectDoneOnBranch({
      worktreePath: repoPath,
      project: '14-product-team-agents',
      commitMessage: 'Mark 14-product-team-agents Done in project index',
    });

    const featureHeadAfter = git(repoPath, 'rev-parse', 'HEAD');
    expect(result.kind).toBe('committed');
    expect(result.commitSha).toBe(featureHeadAfter);
    expect(featureHeadAfter).not.toBe(featureHeadBefore);
    expect(git(repoPath, 'rev-parse', 'HEAD^')).toBe(featureHeadBefore);
    expect(git(repoPath, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(branch);
    expect(git(repoPath, 'rev-parse', 'main')).toBe(baseSha);
    expect(git(repoPath, 'status', '--porcelain')).toBe('');
    expect(git(repoPath, 'diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD')).toBe(
      'docs/projects/index.md',
    );
    expect(git(repoPath, 'show', '--format=%s', '--no-patch', 'HEAD')).toBe(
      'Mark 14-product-team-agents Done in project index',
    );
    expect(readFileSync(join(repoPath, 'docs/projects/index.md'), 'utf8')).toContain(
      '| [Product Team](14-product-team-agents/) | Done | Simulated team loop |',
    );
    expect(git(repoPath, 'show', `${branch}:docs/projects/index.md`)).toContain(
      '## 14-product-team-agents — Done (reopened 2026-06-14)',
    );
    expect(git(repoPath, 'show', 'main:docs/projects/index.md')).toContain(
      '## 14-product-team-agents — Active (reopened 2026-06-14)',
    );
  });

  it('on an ambiguous index writer failure, leaves no unstaged project-index edit behind', async () => {
    const markProjectDoneOnBranch = await loadMarkProjectDoneOnBranch();
    const ambiguousIndex = [
      '# Projects',
      '',
      '| Project | Status | Summary |',
      '| --- | --- | --- |',
      '| [Product Team](14-product-team-agents/) | Active | First duplicate |',
      '| [Product Team again](14-product-team-agents/) | Active | Second duplicate |',
      '',
      '## 14-product-team-agents — Active',
      '',
      '## 14-product-team-agents — In Progress',
      '',
    ].join('\n');
    const { repoPath } = makeRepo(ambiguousIndex);
    const headBefore = git(repoPath, 'rev-parse', 'HEAD');

    const result = await markProjectDoneOnBranch({
      worktreePath: repoPath,
      project: '14-product-team-agents',
    });

    expect(result.kind).toBe('ambiguous');
    expect(result.commitSha ?? null).toBeNull();
    expect(git(repoPath, 'rev-parse', 'HEAD')).toBe(headBefore);
    expect(git(repoPath, 'status', '--porcelain')).toBe('');
    expect(readFileSync(join(repoPath, 'docs/projects/index.md'), 'utf8')).toBe(ambiguousIndex);
  });

  it('skips gracefully when the worktree has no docs/projects/index.md', async () => {
    const markProjectDoneOnBranch = await loadMarkProjectDoneOnBranch();
    tmpRoot = mkdtempSync(join(tmpdir(), 'jarvis-project-done-branch-test-'));
    const repoPath = join(tmpRoot, 'repo');
    git(tmpRoot, 'init', '-q', '-b', 'main', repoPath);
    writeFileSync(join(repoPath, 'README.md'), 'no project index here\n', 'utf8');
    git(repoPath, 'add', '.');
    git(repoPath, 'commit', '-q', '-m', 'seed repo');
    git(repoPath, 'checkout', '-q', '-b', 'jarvis-work/no-index');
    const headBefore = git(repoPath, 'rev-parse', 'HEAD');

    const result = await markProjectDoneOnBranch({
      worktreePath: repoPath,
      project: '14-product-team-agents',
    });

    expect(result.kind).toBe('skipped');
    expect(result.commitSha ?? null).toBeNull();
    expect(git(repoPath, 'rev-parse', 'HEAD')).toBe(headBefore);
    expect(git(repoPath, 'status', '--porcelain')).toBe('');
    expect(existsSync(join(repoPath, 'docs/projects/index.md'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// §4 — Finalizer hold mode
// ---------------------------------------------------------------------------

describe('runFinalizer — hold mode (P0.4a)', () => {
  it('writes summary + index + terminal supervision for a branch-complete run, and NEVER merges/pushes/deletes', async () => {
    const ev = branchCompleteEvent();
    const { effects } = makeEffects(ev);

    const result = await runFinalizer(holdInput(), effects);

    expect(effects.writeSummary).toHaveBeenCalledWith(ev);
    expect(effects.appendIndexRow).toHaveBeenCalledWith(ev);
    expect(effects.writeSupervisionTerminal).toHaveBeenCalledWith('completed', ev);
    // The whole point of hold mode: never touches `main`.
    expect(effects.mergeBranch).not.toHaveBeenCalled();
    expect(effects.pushBranch).not.toHaveBeenCalled();
    expect(effects.deleteBranch).not.toHaveBeenCalled();
    expect(result.outcome).toBe('branch-complete');
    expect(result.merged).toBe(false);
    expect(result.branchDeleted).toBe(false);
  });

  it('removes the worktree, records the decision, and never leaves supervision running', async () => {
    const ev = branchCompleteEvent();
    const { effects } = makeEffects(ev);

    const result = await runFinalizer(holdInput(), effects);

    expect(effects.removeWorktree).toHaveBeenCalledOnce();
    expect(result.worktreeRemoved).toBe(true);
    // Terminal supervision — never a quiet-pinging `running`.
    expect(result.supervisionStatus).toBe('completed');
  });

  it('flushes the transcript before writing summary/index (terminal-write ordering)', async () => {
    const ev = branchCompleteEvent();
    const { effects } = makeEffects(ev);

    await runFinalizer(holdInput(), effects);

    const flushOrder = vi.mocked(effects.flushTranscript).mock.invocationCallOrder[0]!;
    const summaryOrder = vi.mocked(effects.writeSummary).mock.invocationCallOrder[0]!;
    const indexOrder = vi.mocked(effects.appendIndexRow).mock.invocationCallOrder[0]!;
    expect(flushOrder).toBeLessThan(summaryOrder);
    expect(flushOrder).toBeLessThan(indexOrder);
  });

  it('records the exact ordered hold-mode phase sequence (durable resume checkpoints), with no gated-merge phases', async () => {
    const ev = branchCompleteEvent();
    const { effects, phases } = makeEffects(ev);

    const result = await runFinalizer(holdInput(), effects);

    // A phase is recorded after EACH mutating step so a crash-resume (P0.4) can
    // skip exactly the steps already committed — the gated-merge-only
    // checkpoints (`merged-not-pushed`/`pushed-not-deleted`) never appear.
    expect(phases).toEqual([
      'classified',
      'transcript-flushed',
      'summary-written',
      'index-appended',
      'worktree-resolved',
      'finalized',
    ]);
    expect(result.phases).toEqual(phases);
  });

  it('a worktree-removal failure does NOT block the terminal supervision write (never left running)', async () => {
    // req 17: a cleanup failure must never strand the run as a quiet-pinging
    // `running`. Worktree removal is best-effort inside hold mode.
    const ev = branchCompleteEvent();
    const { effects } = makeEffects(ev, {
      removeWorktree: vi.fn(async () => { throw new Error('worktree busy'); }),
    });

    const result = await runFinalizer(holdInput(), effects);

    // The run still reaches a real terminal supervision status.
    expect(effects.writeSupervisionTerminal).toHaveBeenCalledWith('completed', ev);
    expect(result.supervisionStatus).toBe('completed');
    // The decision is recorded truthfully: the worktree was NOT removed.
    expect(result.worktreeRemoved).toBe(false);
  });

  it('on a failed run writes failed supervision, never merges, and still resolves the worktree', async () => {
    const ev = failedEvent();
    const { effects } = makeEffects(ev);

    const result = await runFinalizer(holdInput(), effects);

    expect(result.outcome).toBe('failed');
    expect(result.supervisionStatus).toBe('failed');
    expect(effects.writeSupervisionTerminal).toHaveBeenCalledWith('failed', ev);
    expect(effects.mergeBranch).not.toHaveBeenCalled();
    expect(result.merged).toBe(false);
    // Failure path still reaps/tears down — never left quiet-pinging running.
    expect(effects.removeWorktree).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// §6 — Gated-merge mode state machine (P1.5). WRITE-FIRST: gated-merge throws
// notImplemented, so these are RED until the P1.5 impl. The per-gate-condition
// matrix + lock + resume are separate Phase 3 test tasks.
// ---------------------------------------------------------------------------

describe('runFinalizer — gated-merge mode (P1.5)', () => {
  it('branch-complete project completion marks docs/projects/index.md Done exactly once after gate and merge but before summary/index persistence (Phase 15)', async () => {
    const ev = branchCompleteEvent();
    const markProjectDone = vi.fn(async () => ({
      kind: 'committed',
      commitSha: 'done-commit-sha',
      changedTokens: ['table-status', 'section-heading-status'],
    }));
    const { effects, phases } = makeEffects(ev, { markProjectDone } as never);

    await runFinalizer(gatedMergeInput(), effects);

    expect(markProjectDone).toHaveBeenCalledOnce();
    expect(markProjectDone).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'gated-merge',
        runId: DEFAULT_RUN_ID,
        project: '15-work-run-finalizer',
        product: 'jarvis',
        branch: 'jarvis-work/15-work-run-finalizer',
        baseBranch: 'main',
      }),
      ev,
    );
    const markOrder = markProjectDone.mock.invocationCallOrder[0]!;
    const classifyOrder = vi.mocked(effects.classify).mock.invocationCallOrder[0]!;
    const summaryOrder = vi.mocked(effects.writeSummary).mock.invocationCallOrder[0]!;
    const indexOrder = vi.mocked(effects.appendIndexRow).mock.invocationCallOrder[0]!;
    const gateOrder = vi.mocked(effects.gate!).mock.invocationCallOrder[0]!;
    const mergeOrder = vi.mocked(effects.mergeBranch!).mock.invocationCallOrder[0]!;
    expect(classifyOrder).toBeLessThan(markOrder);
    expect(gateOrder).toBeLessThan(markOrder);
    expect(mergeOrder).toBeLessThan(markOrder);
    expect(markOrder).toBeLessThan(summaryOrder);
    expect(markOrder).toBeLessThan(indexOrder);

    const recorded = phases as string[];
    expect(recorded).toContain('project-marked-done');
    expect(recorded.indexOf('classified')).toBeLessThan(recorded.indexOf('project-marked-done'));
    expect(recorded.indexOf('merged-not-pushed')).toBeLessThan(recorded.indexOf('project-marked-done'));
    expect(recorded.indexOf('project-marked-done')).toBeLessThan(recorded.indexOf('summary-written'));
    expect(recorded.indexOf('project-marked-done')).toBeLessThan(recorded.indexOf('index-appended'));
  });

  it('clean run orders finalizer effects: classify → gate → merge → index-Done commit → refreshed persistence → push → cleanup → notify → run-end (Phase 15)', async () => {
    const ev = branchCompleteEvent();
    const order: string[] = [];
    const classify = vi.fn(async () => {
      order.push('eligibility-classify');
      return ev;
    });
    const markProjectDone = vi.fn(async () => {
      order.push('index-done-commit');
      return {
        kind: 'committed' as const,
        commitSha: 'project-done-head-sha',
        changedTokens: ['table-status', 'section-heading-status'],
      };
    });
    const writeSummary = vi.fn((terminalEvent: MutationEvent) => {
      order.push('refreshed-summary-write');
      expect(terminalEvent.data).toMatchObject({
        workProduct: {
          commitCount: 6,
          commitShas: ['a1', 'b2', 'c3', 'd4', 'e5', 'project-done-head-sha'],
        },
      });
    });
    const appendIndexRow = vi.fn((terminalEvent: MutationEvent) => {
      order.push('refreshed-index-write');
      expect(terminalEvent.data).toMatchObject({
        workProduct: {
          commitCount: 6,
          commitShas: ['a1', 'b2', 'c3', 'd4', 'e5', 'project-done-head-sha'],
        },
      });
    });
    const gate = vi.fn(async () => {
      order.push('gate');
      return { ok: true } as GateResult;
    });
    const mergeBranch = vi.fn(async () => {
      order.push('merge');
    });
    const pushBranch = vi.fn(async () => {
      order.push('push');
    });
    const removeWorktree = vi.fn(async () => {
      order.push('remove-worktree');
    });
    const deleteBranch = vi.fn(async () => {
      order.push('delete-branch');
    });
    const onLanded = vi.fn(() => {
      order.push('success-notify');
    });
    const writeSupervisionTerminal = vi.fn(() => {
      order.push('run-end');
    });
    const { effects } = makeEffects(ev, {
      classify,
      markProjectDone,
      writeSummary,
      appendIndexRow,
      gate,
      mergeBranch,
      pushBranch,
      removeWorktree,
      deleteBranch,
      onLanded,
      writeSupervisionTerminal,
    } as Partial<FinalizerEffects> & { onLanded: typeof onLanded });

    await runFinalizer(gatedMergeInput(), effects);

    expect(order).toEqual([
      'eligibility-classify',
      'gate',
      'merge',
      'index-done-commit',
      'refreshed-summary-write',
      'refreshed-index-write',
      'push',
      'remove-worktree',
      'delete-branch',
      'success-notify',
      'run-end',
    ]);
  });

  it('success notification receives the run/project/base payload after push and cleanup (Phase 15)', async () => {
    const ev = branchCompleteEvent();
    const onLanded = vi.fn();
    const { effects } = makeEffects(ev, { onLanded } as Partial<FinalizerEffects>);

    await runFinalizer(gatedMergeInput(), effects);

    expect(onLanded).toHaveBeenCalledOnce();
    expect(onLanded).toHaveBeenCalledWith({
      event: 'merge-success',
      runId: DEFAULT_RUN_ID,
      projectSlug: '15-work-run-finalizer',
      product: 'jarvis',
      branch: 'jarvis-work/15-work-run-finalizer',
      baseBranch: 'main',
    });
    const pushOrder = vi.mocked(effects.pushBranch!).mock.invocationCallOrder[0]!;
    const cleanupOrder = vi.mocked(effects.removeWorktree).mock.invocationCallOrder[0]!;
    const notifyOrder = onLanded.mock.invocationCallOrder[0]!;
    const terminalOrder = vi.mocked(effects.writeSupervisionTerminal).mock.invocationCallOrder[0]!;
    expect(pushOrder).toBeLessThan(notifyOrder);
    expect(cleanupOrder).toBeLessThan(notifyOrder);
    expect(notifyOrder).toBeLessThan(terminalOrder);
  });

  it('records the merge-success publication claim before publishing the operator notification (Phase 15)', async () => {
    const ev = branchCompleteEvent();
    const order: string[] = [];
    const recordNotificationPublication = vi.fn(() => {
      order.push('record-published');
    });
    const onLanded = vi.fn(() => {
      order.push('publish-event');
    });
    const { effects } = makeEffects(ev, {
      onLanded,
      recordNotificationPublication,
    } as Partial<FinalizerEffects>);

    await runFinalizer(gatedMergeInput(), effects);

    expect(recordNotificationPublication).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'merge-success',
      key: mergeSuccessPublicationKey(),
      status: 'published',
    }));
    expect(onLanded).toHaveBeenCalledOnce();
    expect(order).toEqual(['record-published', 'publish-event']);
  });

  it('on pushed-phase replay skips an already-published merge-success notification and records skip metadata (Phase 15)', async () => {
    const ev = branchCompleteEvent();
    const key = mergeSuccessPublicationKey();
    const readNotificationPublication = vi.fn(() => ({
      kind: 'merge-success',
      key,
      status: 'published',
    }));
    const recordNotificationPublication = vi.fn();
    const onLanded = vi.fn();
    const { effects } = makeEffects(ev, {
      readLastPhase: vi.fn(() => 'pushed-not-deleted' as FinalizerPhase),
      onLanded,
      recordNotificationPublication,
    } as Partial<FinalizerEffects>);
    Object.assign(effects, { readNotificationPublication });

    await runFinalizer(gatedMergeInput(), effects);

    expect(readNotificationPublication).toHaveBeenCalledWith(key);
    expect(onLanded).not.toHaveBeenCalled();
    expect(recordNotificationPublication).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'merge-success',
      key,
      status: 'skipped',
      reason: expect.stringMatching(/duplicate|already/i),
    }));
    expect(effects.writeSupervisionTerminal).toHaveBeenCalledWith('completed', ev);
  });

  it('records durable merge-success publication error metadata and still finalizes when the success notification publish fails (Phase 15)', async () => {
    const ev = branchCompleteEvent();
    const recordNotificationPublication = vi.fn();
    const onLanded = vi.fn(() => {
      throw new Error('operator event bus down');
    });
    const { effects } = makeEffects(ev, {
      onLanded,
      recordNotificationPublication,
    } as Partial<FinalizerEffects>);

    const result = await runFinalizer(gatedMergeInput(), effects);

    expect(result).toMatchObject({
      outcome: 'branch-complete',
      merged: true,
      branchDeleted: true,
      supervisionStatus: 'completed',
    });
    expect(effects.writeSupervisionTerminal).toHaveBeenCalledWith('completed', ev);
    expect(recordNotificationPublication).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'merge-success',
      key: expect.stringMatching(new RegExp(`${DEFAULT_RUN_ID}.*jarvis-work/15-work-run-finalizer.*pushed-not-deleted`)),
      status: 'error',
      error: expect.stringMatching(/operator event bus down/),
    }));
  });

  it('refreshes terminal work-product facts after the project-Done commit before summary/index/terminal persistence (Phase 15)', async () => {
    const ev = branchCompleteEvent();
    const markProjectDone = vi.fn(async () => ({
      kind: 'committed',
      commitSha: 'project-done-head-sha',
      changedTokens: ['table-status', 'section-heading-status'],
    }));
    const { effects } = makeEffects(ev, { markProjectDone } as never);

    const result = await runFinalizer(gatedMergeInput(), effects);

    const persistedEvents = [
      vi.mocked(effects.writeSummary).mock.calls[0]?.[0],
      vi.mocked(effects.appendIndexRow).mock.calls[0]?.[0],
      vi.mocked(effects.writeSupervisionTerminal).mock.calls[0]?.[1],
      result.terminalEvent,
    ];

    for (const event of persistedEvents) {
      expect(event).toBeDefined();
      expect(event!.data).toMatchObject({
        workProduct: {
          commitCount: 6,
          commitShas: ['a1', 'b2', 'c3', 'd4', 'e5', 'project-done-head-sha'],
        },
      });
    }
  });

  it('already-Done projects are idempotent: finalizer checks once, records no empty commit, and still gates/merges (Phase 15)', async () => {
    const ev = branchCompleteEvent();
    const markProjectDone = vi.fn(async () => ({
      kind: 'already-done',
      commitSha: null,
      changedTokens: [],
    }));
    const { effects } = makeEffects(ev, { markProjectDone } as never);

    const result = await runFinalizer(gatedMergeInput(), effects);

    expect(markProjectDone).toHaveBeenCalledOnce();
    expect(effects.gate).toHaveBeenCalledOnce();
    expect(effects.mergeBranch).toHaveBeenCalledOnce();
    expect(effects.pushBranch).toHaveBeenCalledOnce();
    expect(result.merged).toBe(true);
  });

  it('noop with all original tasks checked skips project-index Done flip and never merges (Phase 15)', async () => {
    const ev = noopAllTasksCheckedEvent();
    const markProjectDone = vi.fn(async () => ({
      kind: 'committed',
      commitSha: 'must-not-happen',
      changedTokens: ['table-status', 'section-heading-status'],
    }));
    const { effects, phases } = makeEffects(ev, { markProjectDone } as never);

    const result = await runFinalizer(gatedMergeInput(), effects);

    expect(markProjectDone).not.toHaveBeenCalled();
    expect(effects.gate).not.toHaveBeenCalled();
    expect(effects.mergeBranch).not.toHaveBeenCalled();
    expect(effects.pushBranch).not.toHaveBeenCalled();
    expect(effects.deleteBranch).not.toHaveBeenCalled();
    expect(effects.writeSummary).toHaveBeenCalledWith(ev);
    expect(effects.appendIndexRow).toHaveBeenCalledWith(ev);
    expect(effects.writeSupervisionTerminal).toHaveBeenCalledWith('completed', ev);
    expect(phases).not.toContain('project-marked-done');
    expect(phases).not.toContain('merged-not-pushed');
    expect(result.outcome).toBe('noop');
    expect(result.merged).toBe(false);
    expect(result.branchDeleted).toBe(false);
  });

  it('branch-complete with open non-reversible high residue HOLDs before project-index Done and work-run index writes (Phase 15)', async () => {
    const ev = branchCompleteEventWithFindings([
      {
        id: 'finding-auth-bypass',
        severity: 'high',
        reversible: false,
        status: 'open',
        rationale: 'remaining non-reversible high terminal residue',
      },
    ]);
    const markProjectDone = vi.fn(async () => ({
      kind: 'committed',
      commitSha: 'must-not-happen',
      changedTokens: ['table-status', 'section-heading-status'],
    }));
    const { effects, phases } = makeEffects(ev, { markProjectDone } as never);

    const result = await runFinalizer(gatedMergeInput(), effects);

    expect(markProjectDone).not.toHaveBeenCalled();
    expect(effects.gate).not.toHaveBeenCalled();
    expect(effects.mergeBranch).not.toHaveBeenCalled();
    expect(effects.pushBranch).not.toHaveBeenCalled();
    expect(effects.deleteBranch).not.toHaveBeenCalled();
    expect(effects.writeSummary).not.toHaveBeenCalled();
    expect(effects.appendIndexRow).not.toHaveBeenCalled();
    expect(effects.removeWorktree).not.toHaveBeenCalled();
    expect(effects.writeSupervisionTerminal).toHaveBeenCalledWith('completed', ev);
    expect(phases).not.toContain('project-marked-done');
    expect(phases).not.toContain('summary-written');
    expect(phases).not.toContain('index-appended');
    expect(phases).not.toContain('merged-not-pushed');
    expect(result.outcome).toBe('branch-complete');
    expect(result.merged).toBe(false);
    expect(result.branchDeleted).toBe(false);
    expect(result.worktreeRemoved).toBe(false);
  });

  it('resolved non-reversible high findings do not trigger the pre-merge HOLD heuristic (Phase 15)', async () => {
    const ev = branchCompleteEventWithFindings([
      {
        id: 'finding-resolved-auth-bypass',
        severity: 'high',
        reversible: false,
        status: 'resolved',
        rationale: 'stale terminal residue verified resolved',
      },
    ]);
    const markProjectDone = vi.fn(async () => ({
      kind: 'committed',
      commitSha: 'resolved-finding-project-done-commit',
      changedTokens: ['table-status', 'section-heading-status'],
    }));
    const { effects } = makeEffects(ev, { markProjectDone } as never);

    const result = await runFinalizer(gatedMergeInput(), effects);

    expect(markProjectDone).toHaveBeenCalledOnce();
    expect(effects.gate).toHaveBeenCalledOnce();
    expect(effects.mergeBranch).toHaveBeenCalledOnce();
    expect(effects.pushBranch).toHaveBeenCalledOnce();
    expect(result.merged).toBe(true);
  });

  it('absent docs/projects/index.md gracefully skips the project-Done commit and still merges (Phase 15)', async () => {
    const ev = branchCompleteEvent();
    const markProjectDone = vi.fn(async () => ({
      kind: 'skipped',
      commitSha: null,
      changedTokens: [],
    }));
    const { effects, phases } = makeEffects(ev, { markProjectDone } as never);

    const result = await runFinalizer(gatedMergeInput(), effects);

    expect(markProjectDone).toHaveBeenCalledOnce();
    expect(effects.alert).not.toHaveBeenCalled();
    expect(effects.gate).toHaveBeenCalledOnce();
    expect(effects.mergeBranch).toHaveBeenCalledOnce();
    expect(effects.pushBranch).toHaveBeenCalledOnce();
    expect(effects.deleteBranch).toHaveBeenCalledOnce();
    expect(result.outcome).toBe('branch-complete');
    expect(result.merged).toBe(true);
    expect(result.branchDeleted).toBe(true);
    expect(result.supervisionStatus).toBe('completed');
    expect(phases).not.toContain('project-marked-done');
  });

  it('ambiguous docs/projects/index.md after a clean gate/merge produces an operational HOLD before push, with worktree preserved (Phase 15)', async () => {
    const ev = branchCompleteEvent();
    const markProjectDone = vi.fn(async () => ({
      kind: 'ambiguous',
      reason: 'multiple-matches',
      commitSha: null,
      changedTokens: [],
    }));
    const { effects, phases } = makeEffects(ev, { markProjectDone } as never);

    const result = await runFinalizer(gatedMergeInput(), effects);

    expect(markProjectDone).toHaveBeenCalledOnce();
    expect(effects.gate).toHaveBeenCalledOnce();
    expect(effects.mergeBranch).toHaveBeenCalledOnce();
    expect(effects.pushBranch).not.toHaveBeenCalled();
    expect(effects.deleteBranch).not.toHaveBeenCalled();
    expect(effects.writeSummary).not.toHaveBeenCalled();
    expect(effects.appendIndexRow).not.toHaveBeenCalled();
    expect(effects.removeWorktree).not.toHaveBeenCalled();
    expect(result.outcome).toBe('branch-complete');
    expect(result.merged).toBe(true);
    expect(result.branchDeleted).toBe(false);
    expect(result.worktreeRemoved).toBe(false);
    expect(phases).not.toContain('project-marked-done');
    expect(phases).not.toContain('summary-written');
    expect(phases).not.toContain('index-appended');
    expect(phases).toContain('merged-not-pushed');
  });

  it('happy path: classify branch-complete → gate green → merge → push → branch delete → terminal merged', async () => {
    const ev = branchCompleteEvent();
    const { effects } = makeEffects(ev);

    const result = await runFinalizer(gatedMergeInput(), effects);

    // Gate consulted; all merge steps fired; no operator alert.
    expect(effects.gate).toHaveBeenCalledOnce();
    expect(effects.mergeBranch).toHaveBeenCalledOnce();
    expect(effects.pushBranch).toHaveBeenCalledOnce();
    expect(effects.deleteBranch).toHaveBeenCalledOnce();
    expect(effects.removeWorktree).toHaveBeenCalledOnce();
    expect(effects.alert).not.toHaveBeenCalled();
    expect(effects.writeSupervisionTerminal).toHaveBeenCalledWith('completed', ev);
    // Result reflects the landed merge. `outcome` stays the work-product
    // classification (branch-complete); the merge DISPOSITION is signalled by
    // `result.merged` (no `merged` value is added to the WorkOutcome enum — that
    // would ripple across the cockpit/projection/formatters).
    expect(result.outcome).toBe('branch-complete');
    expect(result.merged).toBe(true);
    expect(result.branchDeleted).toBe(true);
    expect(result.worktreeRemoved).toBe(true);
    expect(result.supervisionStatus).toBe('completed');
  });

  it('records the exact ordered gated-merge phase sequence (push-before-delete durable checkpoints)', async () => {
    const { effects, phases } = makeEffects(branchCompleteEvent());
    await runFinalizer(gatedMergeInput(), effects);
    expect(phases).toEqual([
      'classified',
      'transcript-flushed',
      'merged-not-pushed',
      'project-marked-done',
      'summary-written',
      'index-appended',
      'pushed-not-deleted',
      'worktree-resolved',
      'finalized',
    ]);
  });

  it('push failure → branch is NOT deleted (origin lacks the work; recovery resumes from merged-not-pushed) (P2.8)', async () => {
    // The don't-delete-prematurely guard: if the push fails after a successful
    // merge, the local branch MUST survive (it's the only copy not on origin) so
    // the P0.4 recovery path can resume the push. The merge recorded
    // `merged-not-pushed`; the push throws BEFORE `pushed-not-deleted`, so the
    // delete (in the shared tail, gated on a reached push) never runs.
    const { effects, phases } = makeEffects(branchCompleteEvent(), {
      pushBranch: vi.fn(async () => { throw new Error('git push failed: network down'); }),
    });

    await expect(runFinalizer(gatedMergeInput(), effects)).rejects.toThrow(/push failed/);

    expect(effects.mergeBranch).toHaveBeenCalledOnce();
    expect(effects.pushBranch).toHaveBeenCalledOnce();
    // Crucially: the branch is NOT deleted — its work isn't on origin yet.
    expect(effects.deleteBranch).not.toHaveBeenCalled();
    // The durable phase stops at `merged-not-pushed` (never `pushed-not-deleted`)
    // so a recovery resume retries the push, never skips to delete.
    expect(phases).toContain('merged-not-pushed');
    expect(phases).not.toContain('pushed-not-deleted');
  });

  it('index merge conflict at apply time aborts the merge and operationally holds with the branch/worktree preserved (Phase 15)', async () => {
    // The gate's dry-run merge can pass, then a concurrent finalizer can update
    // docs/projects/index.md on the base before the real merge applies. That
    // conflict must be treated as an operational HOLD, not as a thrown finalizer
    // failure and never as a landed merge.
    const abortMerge = vi.fn(async () => {});
    const { effects, phases } = makeEffects(branchCompleteEvent(), {
      mergeBranch: vi.fn(async () => {
        throw new Error([
          'git merge failed: CONFLICT (content): Merge conflict in docs/projects/index.md',
          'Automatic merge failed; fix conflicts and then commit the result.',
        ].join('\n'));
      }),
      abortMerge,
    } as never);

    const result = await runFinalizer(gatedMergeInput(), effects);

    expect(effects.gate).toHaveBeenCalledOnce();
    expect(effects.mergeBranch).toHaveBeenCalledOnce();
    expect(abortMerge).toHaveBeenCalledOnce();
    expect(effects.alert).toHaveBeenCalledWith('merge-conflict');

    expect(effects.pushBranch).not.toHaveBeenCalled();
    expect(effects.deleteBranch).not.toHaveBeenCalled();
    expect(effects.removeWorktree).not.toHaveBeenCalled();
    expect(phases).not.toContain('merged-not-pushed');
    expect(phases).not.toContain('pushed-not-deleted');

    expect(result.outcome).toBe('branch-complete');
    expect(result.merged).toBe(false);
    expect(result.branchDeleted).toBe(false);
    expect(result.worktreeRemoved).toBe(false);
    expect(result.supervisionStatus).toBe('completed');
    expect(effects.writeSupervisionTerminal).toHaveBeenCalledWith('completed', expect.objectContaining({
      data: expect.objectContaining({
        outcome: 'branch-complete',
      }),
    }));
  });

  it('operational HOLD from an index merge conflict does not record or persist the project-Done flip (Phase 15)', async () => {
    const ev = branchCompleteEvent();
    const markProjectDone = vi.fn(async () => ({
      kind: 'committed',
      commitSha: 'project-done-commit-must-not-survive-hold',
      changedTokens: ['table-status', 'section-heading-status'],
    }));
    const { effects, phases } = makeEffects(ev, {
      markProjectDone,
      mergeBranch: vi.fn(async () => {
        throw new Error([
          'git merge failed: CONFLICT (content): Merge conflict in docs/projects/index.md',
          'Automatic merge failed; fix conflicts and then commit the result.',
        ].join('\n'));
      }),
      abortMerge: vi.fn(async () => {}),
    } as never);

    const result = await runFinalizer(gatedMergeInput(), effects);

    expect(markProjectDone).not.toHaveBeenCalled();
    expect(result.merged).toBe(false);
    expect(result.worktreeRemoved).toBe(false);
    expect(effects.alert).toHaveBeenCalledWith('merge-conflict');
    expect(phases).not.toContain('project-marked-done');
    expect(effects.writeSummary).not.toHaveBeenCalled();
    expect(effects.appendIndexRow).not.toHaveBeenCalled();
    expect(effects.writeSupervisionTerminal).toHaveBeenCalledWith('completed', result.terminalEvent);
    expect(result.terminalEvent.data).toMatchObject({
      outcome: 'branch-complete',
      workProduct: {
        commitCount: 5,
        commitShas: ['a1', 'b2', 'c3', 'd4', 'e5'],
      },
    });
    expect(JSON.stringify(result.terminalEvent.data)).not.toContain('project-done-commit-must-not-survive-hold');
  });

  it('every HOLD path prevents a surviving project-Done commit and skips merge-success notification (Phase 15 selected task)', async () => {
    type HoldCase = {
      label: string;
      event: MutationEvent;
      effects?: Partial<FinalizerEffects>;
      expectMarkAttempt?: boolean;
    };

    const terminalOperationalHold = branchCompleteEvent();
    terminalOperationalHold.data = {
      ...(terminalOperationalHold.data as Record<string, unknown>),
      held: true,
      preserveBranch: true,
      preserveWorktree: true,
      reason: 'checkpoint-persist-failure',
    };

    const cases: HoldCase[] = [
      {
        label: 'finding HOLD',
        event: branchCompleteEventWithFindings([
          {
            id: 'finding-high-nonreversible',
            severity: 'high',
            reversible: false,
            status: 'open',
          },
        ]),
      },
      {
        label: 'operational HOLD',
        event: terminalOperationalHold,
      },
      {
        label: 'gate-fail HOLD',
        event: branchCompleteEvent(),
        effects: {
          gate: vi.fn(async (): Promise<GateResult> => ({ ok: false, reason: 'tests-red' })),
        },
      },
      {
        label: 'ambiguous-index HOLD',
        event: branchCompleteEvent(),
        effects: {
          markProjectDone: vi.fn(async () => ({
            kind: 'ambiguous',
            reason: 'multiple-matches',
            commitSha: null,
            changedTokens: [],
          })),
        },
        expectMarkAttempt: true,
      },
      {
        label: 'merge-conflict HOLD',
        event: branchCompleteEvent(),
        effects: {
          mergeBranch: vi.fn(async () => {
            throw new Error('CONFLICT (content): Merge conflict in docs/projects/index.md');
          }),
          abortMerge: vi.fn(async () => {}),
        },
      },
    ];

    for (const holdCase of cases) {
      const projectDoneCommitSha = `${holdCase.label.replaceAll(/[^a-z]+/g, '-')}-done-commit`;
      const markProjectDone = holdCase.effects?.markProjectDone ?? vi.fn(async () => ({
        kind: 'committed' as const,
        commitSha: projectDoneCommitSha,
        changedTokens: ['table-status', 'section-heading-status'],
      }));
      const onLanded = vi.fn();
      const { effects, phases } = makeEffects(holdCase.event, {
        markProjectDone,
        onLanded,
        ...holdCase.effects,
      } as Partial<FinalizerEffects>);

      const result = await runFinalizer(gatedMergeInput(), effects);

      expect(result.merged, holdCase.label).toBe(holdCase.label === 'ambiguous-index HOLD');
      expect(result.branchDeleted, holdCase.label).toBe(false);
      expect(onLanded, holdCase.label).not.toHaveBeenCalled();
      expect(phases, holdCase.label).not.toContain('project-marked-done');
      expect(JSON.stringify(result.terminalEvent.data ?? {}), holdCase.label).not.toContain(projectDoneCommitSha);
      if (holdCase.expectMarkAttempt) {
        expect(markProjectDone, holdCase.label).toHaveBeenCalledOnce();
      } else {
        expect(markProjectDone, holdCase.label).not.toHaveBeenCalled();
      }
    }
  });

  it('pushes BEFORE deleting the branch (origin is the durable backup)', async () => {
    const { effects } = makeEffects(branchCompleteEvent());
    await runFinalizer(gatedMergeInput(), effects);
    // Legible failure if a step never fired (vs a confusing NaN comparison).
    expect(effects.mergeBranch).toHaveBeenCalledOnce();
    expect(effects.pushBranch).toHaveBeenCalledOnce();
    expect(effects.deleteBranch).toHaveBeenCalledOnce();
    const mergeOrder = vi.mocked(effects.mergeBranch!).mock.invocationCallOrder[0]!;
    const pushOrder = vi.mocked(effects.pushBranch!).mock.invocationCallOrder[0]!;
    const deleteOrder = vi.mocked(effects.deleteBranch!).mock.invocationCallOrder[0]!;
    expect(mergeOrder).toBeLessThan(pushOrder);
    expect(pushOrder).toBeLessThan(deleteOrder);
  });

  it('gated-merge requires the gate/merge/push/delete effects — rejects if a caller omits them', async () => {
    // The optional-on-the-interface effects MUST be present in gated-merge mode;
    // the impl guards so a missing `gate` can never silently skip verification.
    const ev = branchCompleteEvent();
    const { effects } = makeEffects(ev);
    const withoutGate: FinalizerEffects = { ...effects, gate: undefined };
    await expect(runFinalizer(gatedMergeInput(), withoutGate)).rejects.toThrow(/gated-merge.*require|require.*gate/i);
  });

  it('a failed gate STOPS at branch-complete: alert, no merge/push/delete, main untouched', async () => {
    const ev = branchCompleteEvent();
    const { effects } = makeEffects(ev, {
      gate: vi.fn(async (): Promise<GateResult> => ({ ok: false, reason: 'tests-red' })),
    });

    const result = await runFinalizer(gatedMergeInput(), effects);

    expect(effects.alert).toHaveBeenCalledWith('tests-red');
    expect(effects.mergeBranch).not.toHaveBeenCalled();
    expect(effects.pushBranch).not.toHaveBeenCalled();
    expect(effects.deleteBranch).not.toHaveBeenCalled();
    expect(result.merged).toBe(false);
    expect(result.branchDeleted).toBe(false);
    // Still reaches a terminal supervision status (branch-complete held on a branch).
    expect(result.outcome).toBe('branch-complete');
    expect(effects.writeSupervisionTerminal).toHaveBeenCalledWith('completed', ev);
    // The worktree is removed (the branch ref persists for inspection/retry),
    // matching the hold-mode non-merge policy — never left orphaned.
    expect(effects.removeWorktree).toHaveBeenCalledOnce();
    expect(result.worktreeRemoved).toBe(true);
  });

  it('never merges a non-branch-complete run (partial/failed): the gate is not even consulted', async () => {
    const ev = failedEvent();
    const { effects } = makeEffects(ev);

    const result = await runFinalizer(gatedMergeInput(), effects);

    expect(effects.gate).not.toHaveBeenCalled();
    expect(effects.mergeBranch).not.toHaveBeenCalled();
    expect(result.merged).toBe(false);
    expect(result.supervisionStatus).toBe('failed');
    expect(effects.removeWorktree).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// §6 — Gate: EACH failing condition stops at branch-complete, main unchanged
// (P1.5, this Phase-3 test task). WRITE-FIRST: gated-merge throws
// notImplemented, so every case is RED until the P1.5 impl. The PURE per-reason
// gate DECISION (`evaluateGate(facts) → reason`) is pinned separately in
// work-run-gate.test.ts; this block pins the FINALIZER-LEVEL contract — that for
// EVERY gate-fail reason the gated-merge finalizer stops at `branch-complete`,
// alerts with that exact reason, and never mutates the base branch (no
// merge/push/delete), so a red gate can never land broken work on `main`.
//
// At the spy level "main unchanged" == merge/push/delete never fire; the
// byte-for-byte temp-repo `main`-unchanged proof is a separate Phase-3 task
// (test-plan §6 "Gate checks run in an integration worktree").
// ---------------------------------------------------------------------------

describe('runFinalizer — gated-merge gate: each condition stops at branch-complete (P1.5)', () => {
  // Every typed GateFailReason — if a new reason is added to the union without a
  // case here, this list (and the alert/no-merge contract) must be updated too.
  const FAIL_REASONS: GateFailReason[] = [
    'tests-red',
    'dirty-tree',
    'tasks-remaining',
    'merge-conflict',
    'concurrent-run',
    'missing-validation-command',
    'validation-timeout',
  ];

  it.each(FAIL_REASONS)(
    'gate fails with %s → stop at branch-complete, alert(reason), no merge/push/delete, main untouched',
    async (reason) => {
      const ev = branchCompleteEvent();
      const { effects } = makeEffects(ev, {
        gate: vi.fn(async (): Promise<GateResult> => ({ ok: false, reason })),
      });

      const result = await runFinalizer(gatedMergeInput(), effects);

      // The gate WAS consulted (the run is branch-complete) and refused.
      expect(effects.gate).toHaveBeenCalledOnce();
      // Operator is alerted with the precise reason — never a silent hold.
      expect(effects.alert).toHaveBeenCalledWith(reason);
      // `main` is byte-for-byte untouched: not one ref-mutating step fired.
      expect(effects.mergeBranch).not.toHaveBeenCalled();
      expect(effects.pushBranch).not.toHaveBeenCalled();
      expect(effects.deleteBranch).not.toHaveBeenCalled();
      // The run holds on its branch: outcome stays the work-product
      // classification, nothing merged or deleted.
      expect(result.outcome).toBe('branch-complete');
      expect(result.merged).toBe(false);
      expect(result.branchDeleted).toBe(false);
      // Still reaches a real terminal supervision status — never quiet-pinging.
      expect(result.supervisionStatus).toBe('completed');
      expect(effects.writeSupervisionTerminal).toHaveBeenCalledWith('completed', ev);
      // The worktree is reaped (branch ref persists for inspection/retry),
      // matching the hold-mode non-merge policy — never left orphaned.
      expect(effects.removeWorktree).toHaveBeenCalledOnce();
      expect(result.worktreeRemoved).toBe(true);
    },
  );

  it('a failed gate records exactly the hold-mode phase sequence — no gated-merge-only checkpoints', async () => {
    // A run that stops at the gate must record the SAME phases as hold mode and
    // never the push-before-delete checkpoints — otherwise a crash-resume would
    // wrongly believe a merge landed and skip straight to push/delete on a
    // branch that never merged. Pinning the full sequence (not just the absent
    // ones) also catches a regression that drops an earlier phase like
    // `index-appended` on the gate-fail path.
    const ev = branchCompleteEvent();
    const { effects, phases } = makeEffects(ev, {
      gate: vi.fn(async (): Promise<GateResult> => ({ ok: false, reason: 'tasks-remaining' })),
    });

    await runFinalizer(gatedMergeInput(), effects);

    // Exact equality pins both the order AND the absence of the gated-merge-only
    // checkpoints (`merged-not-pushed`/`pushed-not-deleted`) — if either leaked
    // onto the gate-fail path this fails first with a clear diff.
    expect(phases).toEqual([
      'classified',
      'transcript-flushed',
      'summary-written',
      'index-appended',
      'worktree-resolved',
      'finalized',
    ]);
  });
});

// ---------------------------------------------------------------------------
// §6 — Gated-merge crash-resume matrix (P1.5). WRITE-FIRST: gated-merge throws
// notImplemented, so these are RED until the P1.5 impl consults
// `readLastPhase()` at the top of `runFinalizer` and skips already-committed
// steps. The contract (spec req 15, test-plan §6 "Concurrency + durability"):
// a crash mid-finalize resumes at the RIGHT step — the merge is applied
// EXACTLY ONCE and push always happens before branch delete, so a resume can
// never re-merge an already-merged branch or delete a branch whose work isn't
// yet on origin.
// ---------------------------------------------------------------------------

describe('runFinalizer — gated-merge crash-resume matrix (P1.5)', () => {
  it('resume from `merged-not-pushed`: does NOT re-merge — completes push then delete (exactly-once merge)', async () => {
    const { effects } = makeEffects(branchCompleteEvent(), {
      readLastPhase: vi.fn((): FinalizerPhase => 'merged-not-pushed'),
    });

    const result = await runFinalizer(gatedMergeInput(), effects);

    // The merge already landed before the crash — never re-merge.
    expect(effects.mergeBranch).not.toHaveBeenCalled();
    // Crash happened immediately after the local merge checkpoint; summary and
    // index persistence had not necessarily happened yet in the new order.
    expect(effects.appendIndexRow).toHaveBeenCalledOnce();
    // Resume completes the remaining mutating steps, push BEFORE delete.
    expect(effects.pushBranch).toHaveBeenCalledOnce();
    expect(effects.deleteBranch).toHaveBeenCalledOnce();
    const pushOrder = vi.mocked(effects.pushBranch!).mock.invocationCallOrder[0]!;
    const deleteOrder = vi.mocked(effects.deleteBranch!).mock.invocationCallOrder[0]!;
    expect(pushOrder).toBeLessThan(deleteOrder);
    expect(result.merged).toBe(true);
    expect(result.branchDeleted).toBe(true);
  });

  it('resume from `merged-not-pushed` completes push/delete even if the reclassified terminal carries a hold signal', async () => {
    const ev = branchCompleteEventWithFindings([
      {
        id: 'finding-late-terminal-hold',
        severity: 'critical',
        reversible: false,
        status: 'open',
        rationale: 'terminal reclassification still carries severe residue',
      },
    ]);
    const markProjectDone = vi.fn(async () => ({
      kind: 'committed',
      commitSha: 'must-not-happen-on-resume',
      changedTokens: ['table-status'],
    }));
    const { effects } = makeEffects(ev, {
      readLastPhase: vi.fn((): FinalizerPhase => 'merged-not-pushed'),
      markProjectDone,
    } as never);

    const result = await runFinalizer(gatedMergeInput(), effects);

    expect(markProjectDone).not.toHaveBeenCalled();
    expect(effects.gate).not.toHaveBeenCalled();
    expect(effects.mergeBranch).not.toHaveBeenCalled();
    expect(effects.appendIndexRow).toHaveBeenCalledOnce();
    expect(effects.pushBranch).toHaveBeenCalledOnce();
    expect(effects.deleteBranch).toHaveBeenCalledOnce();
    expect(result.merged).toBe(true);
    expect(result.branchDeleted).toBe(true);
    expect(result.worktreeRemoved).toBe(true);
  });

  it('resume from `pushed-not-deleted`: does NOT re-merge OR re-push — only completes the branch delete', async () => {
    // The push already put the work on origin (the durable backup); a resume
    // must finish the delete WITHOUT re-merging or re-pushing.
    const { effects } = makeEffects(branchCompleteEvent(), {
      readLastPhase: vi.fn((): FinalizerPhase => 'pushed-not-deleted'),
    });

    const result = await runFinalizer(gatedMergeInput(), effects);

    expect(effects.mergeBranch).not.toHaveBeenCalled();
    expect(effects.pushBranch).not.toHaveBeenCalled();
    expect(effects.appendIndexRow).not.toHaveBeenCalled();
    expect(effects.deleteBranch).toHaveBeenCalledOnce();
    expect(result.merged).toBe(true);
    expect(result.branchDeleted).toBe(true);
  });

  it('resume from `index-appended` (post-merge): skips gate/merge/index and completes push/delete', async () => {
    // In the new order the index row is written after the local merge and
    // project-Done phase. Resume must not re-run any already-recorded step; it
    // only pushes the local merge and deletes the branch.
    const { effects } = makeEffects(branchCompleteEvent(), {
      readLastPhase: vi.fn((): FinalizerPhase => 'index-appended'),
    });

    const result = await runFinalizer(gatedMergeInput(), effects);

    expect(effects.appendIndexRow).not.toHaveBeenCalled();
    expect(effects.gate).not.toHaveBeenCalled();
    expect(effects.mergeBranch).not.toHaveBeenCalled();
    expect(effects.pushBranch).toHaveBeenCalledOnce();
    expect(effects.deleteBranch).toHaveBeenCalledOnce();
    expect(result.merged).toBe(true);
  });

  it('fresh run (no prior phase) merges EXACTLY once — the resume guard never double-applies a fresh merge', async () => {
    const { effects } = makeEffects(branchCompleteEvent(), {
      readLastPhase: vi.fn((): FinalizerPhase | null => null),
    });

    await runFinalizer(gatedMergeInput(), effects);

    expect(effects.mergeBranch).toHaveBeenCalledOnce();
    expect(effects.pushBranch).toHaveBeenCalledOnce();
    expect(effects.deleteBranch).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// §7 — Failure / partial / cancelled path (P1.6). These outcomes NEVER merge,
// so they finalize through `hold` mode (already implemented in P0.4a) — the
// finalizer guarantees: always flush transcript + write summary, always reap the
// worktree, NEVER merge/push/delete, and ALWAYS reach a terminal supervision
// status (never a quiet-pinging `running`), with the branch retained for
// inspection. These are the regression guards for the §7 invariant; the P1.6
// impl task wires the LIVE work-runner failure/cancelled paths through this same
// finalizer (a runtime concern). The "OR mark explicit blocked-on-human" option
// reuses the EXISTING persisted supervision status — no new status enum (§7 🟢).
// ---------------------------------------------------------------------------

describe('runFinalizer — failure / partial / cancelled path (P1.6)', () => {
  // Every non-merge outcome, including a cancelled run (failed + reason
  // "cancelled"), routed through hold mode.
  const NON_MERGE_CASES: Array<{ label: string; ev: () => MutationEvent; supervision: 'completed' | 'failed' }> = [
    { label: 'failed', ev: () => outcomeEvent('failed'), supervision: 'failed' },
    { label: 'cancelled (failed + reason cancelled)', ev: () => outcomeEvent('failed', 'cancelled'), supervision: 'failed' },
    { label: 'partial', ev: () => outcomeEvent('partial'), supervision: 'completed' },
    { label: 'noop', ev: () => outcomeEvent('noop'), supervision: 'completed' },
    { label: 'dirty-uncommitted', ev: () => outcomeEvent('dirty-uncommitted'), supervision: 'completed' },
  ];

  it.each(NON_MERGE_CASES)(
    '$label: always reaps + flushes, NEVER merges, ends terminal (never running), branch retained',
    async ({ ev, supervision }) => {
      const event = ev();
      const { effects } = makeEffects(event);

      const result = await runFinalizer(holdInput(), effects);

      // Never merges — no path to `main` for a non-branch-complete run.
      expect(effects.mergeBranch).not.toHaveBeenCalled();
      expect(effects.pushBranch).not.toHaveBeenCalled();
      expect(effects.deleteBranch).not.toHaveBeenCalled();
      // Always flushes the transcript and writes the summary + index row
      // (forensics durable — the index row must not be dropped on the failure path).
      expect(effects.flushTranscript).toHaveBeenCalledOnce();
      expect(effects.writeSummary).toHaveBeenCalledWith(event);
      expect(effects.appendIndexRow).toHaveBeenCalledWith(event);
      // Always reaps the worktree.
      expect(effects.removeWorktree).toHaveBeenCalledOnce();
      // ALWAYS terminal — never left a quiet-pinging `running`.
      expect(effects.writeSupervisionTerminal).toHaveBeenCalledWith(supervision, event);
      expect(result.supervisionStatus).toBe(supervision);
      // The merge never happened and the branch is retained for inspection.
      expect(result.merged).toBe(false);
      expect(result.branchDeleted).toBe(false);
    },
  );

  it('flushes the transcript BEFORE writing the summary on the failure path too', async () => {
    const { effects } = makeEffects(outcomeEvent('failed'));

    await runFinalizer(holdInput(), effects);

    const flushOrder = vi.mocked(effects.flushTranscript).mock.invocationCallOrder[0]!;
    const summaryOrder = vi.mocked(effects.writeSummary).mock.invocationCallOrder[0]!;
    expect(flushOrder).toBeLessThan(summaryOrder);
  });

  it('a worktree-reap failure on the failure path still reaches a terminal supervision status (never left running)', async () => {
    // req 17 again, for the failure path: a cleanup hiccup must not strand the
    // run as a quiet-pinging `running`.
    const { effects } = makeEffects(outcomeEvent('failed'), {
      removeWorktree: vi.fn(async () => { throw new Error('worktree busy'); }),
    });

    const result = await runFinalizer(holdInput(), effects);

    expect(result.supervisionStatus).toBe('failed');
    expect(effects.writeSupervisionTerminal).toHaveBeenCalled();
    expect(result.worktreeRemoved).toBe(false);
  });
});
