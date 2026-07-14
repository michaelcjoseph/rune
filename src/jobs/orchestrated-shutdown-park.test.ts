/**
 * parkInFlightOrchestratedRuns — the shutdown() step that keeps an in-flight
 * orchestrated run's work from being discarded by a process restart
 * (docs/projects/bugs.md — orchestrated-run restart safety 1/2, durability).
 *
 * Contract under test:
 * - a running orchestrated run WITHOUT a resumable cursor is parked: system
 *   cancel, best-effort WIP commit of a dirty worktree, then a
 *   completed+parked:true terminal (branch/baseBranch/operatorWorktreePath,
 *   preserveBranch/preserveWorktree) via writeRecoveredTerminalMutation;
 * - a run WITH a resumable cursor is left `running` for boot recovery;
 * - a missing worktree skips the park (nothing to preserve);
 * - WIP preservation is best-effort — a git failure never blocks the park;
 * - one bad run never aborts parking the rest.
 */
import { describe, it, expect, vi } from 'vitest';

import type { CancelReason, MutationDescriptor, MutationEvent, RunHandle } from '../transport/mutations.js';
import type { OrchestrationRunCursor } from '../intent/project-orchestrator.js';

vi.hoisted(() => {
  process.env['TELEGRAM_BOT_TOKEN'] = 'test-token';
  process.env['TELEGRAM_USER_ID'] = '12345';
  process.env['VAULT_DIR'] = '/tmp/test-vault';
  process.env['WORKSPACE_DIR'] = '/tmp/test-workspace';
});

import { parkInFlightOrchestratedRuns, type ShutdownParkDeps } from './orchestrated-work-runner.js';

const WORKTREE = '/tmp/rune-worktrees/rune/21-parallel-product-chats';

function runningDescriptor(overrides: Partial<MutationDescriptor> = {}): MutationDescriptor {
  return {
    id: 'mut-orch-shutdown',
    kind: 'orchestrated-work',
    source: 'webview',
    target: { type: 'orchestrated-work', ref: '21-parallel-product-chats' },
    preview: { summary: 'orchestrated-work on 21-parallel-product-chats' },
    payload: { projectSlug: '21-parallel-product-chats', product: 'rune' },
    createdAt: '2026-07-08T16:22:18.000Z',
    status: 'running',
    ...overrides,
  } as MutationDescriptor;
}

function handleFor(descriptor: MutationDescriptor): RunHandle & { cancel: ReturnType<typeof vi.fn<(reason?: CancelReason) => void>> } {
  return { descriptor, cancel: vi.fn<(reason?: CancelReason) => void>(), settled: Promise.resolve() };
}

function resumableCursor(runId: string): OrchestrationRunCursor {
  return {
    runId,
    product: 'rune',
    project: '21-parallel-product-chats',
    branch: 'rune-work/21-parallel-product-chats',
    baseBranch: 'main',
    worktreePath: WORKTREE,
    resumeMarker: 'resumable',
    cursor: { completedTaskIds: ['task-1'], currentTaskId: null, nextTaskId: 'task-2' },
  };
}

/** Git stub for a dirty worktree: status → dirty, add/commit ok, rev-parse → sha. */
function dirtyGitStub(): ReturnType<typeof vi.fn> {
  return vi.fn(async (args: string[]) => {
    if (args[0] === 'status') return { stdout: ' M src/index.ts\n', stderr: '' };
    if (args[0] === 'rev-parse') return { stdout: 'abcdef1234567890\n', stderr: '' };
    return { stdout: '', stderr: '' };
  });
}

function makeDeps(overrides: Partial<ShutdownParkDeps> = {}): ShutdownParkDeps & {
  writeTerminal: ReturnType<typeof vi.fn>;
  runGit: ReturnType<typeof vi.fn>;
} {
  return {
    listActiveRuns: () => [],
    preflightRecovery: vi.fn(async () => ({ kind: 'not-resumable' as const, reason: 'missing cursor' })),
    runGit: dirtyGitStub(),
    worktreeExists: vi.fn(() => true),
    writeTerminal: vi.fn(),
    resolveBaseBranch: vi.fn(() => 'main'),
    resolveWorktreePath: vi.fn(() => WORKTREE),
    ...overrides,
  } as unknown as ShutdownParkDeps & { writeTerminal: ReturnType<typeof vi.fn>; runGit: ReturnType<typeof vi.fn> };
}

describe('parkInFlightOrchestratedRuns', () => {
  it('parks a no-cursor running run: system cancel, WIP commit, completed+parked terminal', async () => {
    const descriptor = runningDescriptor();
    const handle = handleFor(descriptor);
    const deps = makeDeps({ listActiveRuns: () => [handle] });

    const result = await parkInFlightOrchestratedRuns(deps);

    expect(result).toEqual({ parked: ['mut-orch-shutdown'], resumable: [], skipped: [] });
    expect(handle.cancel).toHaveBeenCalledWith('system');

    // WIP commit sequence on the dirty worktree, all cwd'd to the worktree.
    const gitCalls = deps.runGit.mock.calls.map((c: unknown[]) => (c[0] as string[]).join(' '));
    expect(gitCalls).toEqual(['status --porcelain', 'add -A', expect.stringMatching(/^commit -m rune\(rune\): WIP — shutdown park — 21-parallel-product-chats$/), 'rev-parse HEAD']);
    for (const call of deps.runGit.mock.calls) {
      expect((call as unknown[])[1]).toEqual({ cwd: WORKTREE });
    }

    // Parked terminal shape — writeRecoveredTerminalMutation handles the
    // mutations.jsonl snapshot + blocked-on-human supervision downstream.
    expect(deps.writeTerminal).toHaveBeenCalledTimes(1);
    const [terminalDescriptor, event] = deps.writeTerminal.mock.calls[0] as [MutationDescriptor, MutationEvent];
    expect(terminalDescriptor).toBe(descriptor);
    expect(event.kind).toBe('completed');
    expect(event.data).toMatchObject({
      projectSlug: '21-parallel-product-chats',
      product: 'rune',
      parked: true,
      operatorWorktreePath: WORKTREE,
      branch: 'rune-work/21-parallel-product-chats',
      baseBranch: 'main',
      preserveBranch: true,
      preserveWorktree: true,
    });
    expect((event.data as { reason: string }).reason).toContain('parked at shutdown');
    expect((event.data as { reason: string }).reason).toContain('WIP preserved as abcdef1');
  });

  it('leaves a resumable-cursor run un-parked so boot recovery resumes it', async () => {
    const descriptor = runningDescriptor();
    const handle = handleFor(descriptor);
    const deps = makeDeps({
      listActiveRuns: () => [handle],
      preflightRecovery: vi.fn(async () => ({
        kind: 'recoverable' as const,
        cursor: resumableCursor(descriptor.id),
        reconstruction: { completedTaskIds: [], nextTask: null, drift: false },
      })),
    });

    const result = await parkInFlightOrchestratedRuns(deps);

    expect(result).toEqual({ parked: [], resumable: ['mut-orch-shutdown'], skipped: [] });
    expect(deps.writeTerminal).not.toHaveBeenCalled();
    expect(deps.runGit).not.toHaveBeenCalled();
    // The mutation must stay `running` on disk — recovery reads only running.
    expect(descriptor.status).toBe('running');
  });

  it('parks a clean worktree without a WIP commit; reason carries no sha', async () => {
    const descriptor = runningDescriptor();
    const deps = makeDeps({
      listActiveRuns: () => [handleFor(descriptor)],
      runGit: vi.fn(async () => ({ stdout: '', stderr: '' })),
    });

    const result = await parkInFlightOrchestratedRuns(deps);

    expect(result.parked).toEqual(['mut-orch-shutdown']);
    const gitCalls = deps.runGit.mock.calls.map((c: unknown[]) => (c[0] as string[])[0]);
    expect(gitCalls).toEqual(['status']);
    const [, event] = deps.writeTerminal.mock.calls[0] as [MutationDescriptor, MutationEvent];
    const reason = (event.data as { reason: string }).reason;
    expect(reason).toContain('parked at shutdown');
    expect(reason).not.toContain('WIP preserved');
  });

  it('skips a run whose worktree is missing on disk — nothing to preserve', async () => {
    const descriptor = runningDescriptor();
    const deps = makeDeps({
      listActiveRuns: () => [handleFor(descriptor)],
      worktreeExists: vi.fn(() => false),
    });

    const result = await parkInFlightOrchestratedRuns(deps);

    expect(result).toEqual({ parked: [], resumable: [], skipped: ['mut-orch-shutdown'] });
    expect(deps.runGit).not.toHaveBeenCalled();
    expect(deps.writeTerminal).not.toHaveBeenCalled();
  });

  it('still parks when the WIP commit fails — preservation is best-effort', async () => {
    const descriptor = runningDescriptor();
    const deps = makeDeps({
      listActiveRuns: () => [handleFor(descriptor)],
      runGit: vi.fn(async (args: string[]) => {
        if (args[0] === 'status') return { stdout: ' M src/index.ts\n', stderr: '' };
        throw new Error('git commit failed: index.lock exists');
      }),
    });

    const result = await parkInFlightOrchestratedRuns(deps);

    expect(result.parked).toEqual(['mut-orch-shutdown']);
    const [, event] = deps.writeTerminal.mock.calls[0] as [MutationDescriptor, MutationEvent];
    expect((event.data as { reason: string }).reason).not.toContain('WIP preserved');
  });

  it('ignores non-orchestrated and non-running handles', async () => {
    const legacy = handleFor(runningDescriptor({ id: 'mut-legacy', kind: 'work-run' } as Partial<MutationDescriptor>));
    const pending = handleFor(runningDescriptor({ id: 'mut-pending', status: 'pending' } as Partial<MutationDescriptor>));
    const deps = makeDeps({ listActiveRuns: () => [legacy, pending] });

    const result = await parkInFlightOrchestratedRuns(deps);

    expect(result).toEqual({ parked: [], resumable: [], skipped: [] });
    expect(legacy.cancel).not.toHaveBeenCalled();
    expect(pending.cancel).not.toHaveBeenCalled();
    expect(deps.writeTerminal).not.toHaveBeenCalled();
  });

  it('a per-run failure is recorded as skipped and does not abort parking the rest', async () => {
    const bad = handleFor(runningDescriptor({ id: 'mut-bad' } as Partial<MutationDescriptor>));
    const good = handleFor(runningDescriptor({ id: 'mut-good' } as Partial<MutationDescriptor>));
    const deps = makeDeps({
      listActiveRuns: () => [bad, good],
      preflightRecovery: vi.fn(async (mutation) => {
        if (mutation.id === 'mut-bad') throw new Error('cursor read exploded');
        return { kind: 'not-resumable' as const, reason: 'missing cursor' };
      }),
    });

    const result = await parkInFlightOrchestratedRuns(deps);

    expect(result.skipped).toEqual(['mut-bad']);
    expect(result.parked).toEqual(['mut-good']);
    expect(deps.writeTerminal).toHaveBeenCalledTimes(1);
  });
});
