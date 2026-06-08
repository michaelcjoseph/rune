import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  orchestratedWorkApplier,
  __setOrchestratedRuntimeForTest,
  __resetOrchestratedRuntimeForTest,
} from './orchestrated-work-runner.js';
import type { MutationDescriptor, MutationEvent } from '../transport/mutations.js';
import type { OrchestrationResult } from '../intent/project-orchestrator.js';
import type { SandboxSpec } from '../intent/sandbox.js';

// ---------------------------------------------------------------------------
// Phase 5 orchestrated applier (project 14): the mutation applier that runs
// the multi-task orchestration loop in a sandboxed worktree and maps its
// terminal OrchestrationResult onto a single MutationEvent. Effects are
// injected so the apply→event mapping + worktree lifecycle are exercised
// without git, fs, or a live model call.
// ---------------------------------------------------------------------------

/** Build a temp worktree containing docs/projects/demo/{spec,tasks,context}.md
 *  so the applier's real `findProjectDir` + `buildOrchestrationDeps` resolve
 *  against a genuine tree (the orchestration loop itself is injected). */
function makeWorktree(): { sandbox: SandboxSpec; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'orch-wt-'));
  const projDir = join(dir, 'docs', 'projects', 'demo');
  mkdirSync(projDir, { recursive: true });
  writeFileSync(join(projDir, 'spec.md'), '# Spec\n', 'utf8');
  writeFileSync(join(projDir, 'tasks.md'), '- [ ] task one\n', 'utf8');
  writeFileSync(join(projDir, 'context.md'), '# Project Context\n', 'utf8');
  return {
    sandbox: {
      product: 'jarvis',
      project: 'demo',
      worktree: dir,
      egressAllowlist: [],
      baseSha: 'abc123',
      resumed: false,
    },
    dir,
  };
}

function makeDescriptor(
  payload: { projectSlug: string; product?: string } = { projectSlug: 'demo', product: 'jarvis' },
): MutationDescriptor<{ projectSlug: string; product?: string }> {
  return {
    id: 'mut-1',
    kind: 'orchestrated-work',
    source: 'webview',
    target: { type: 'orchestrated-work', ref: 'demo' },
    preview: { summary: 'orchestrated-work on demo' },
    payload,
    createdAt: new Date().toISOString(),
    status: 'running',
  };
}

async function drain(gen: AsyncIterable<MutationEvent>): Promise<MutationEvent[]> {
  const out: MutationEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

const ctx = { bus: { publish: vi.fn() } as any, cancel: () => false };

describe('orchestratedWorkApplier', () => {
  it('is a non-auto-approve? — registered as autoApprove work applier kind', () => {
    expect(orchestratedWorkApplier.kind).toBe('orchestrated-work');
    expect(orchestratedWorkApplier.autoApprove).toBe(true);
  });

  describe('validate', () => {
    it('rejects a missing projectSlug', () => {
      const r = orchestratedWorkApplier.validate({} as never);
      expect(r.ok).toBe(false);
    });

    it('rejects an invalid slug (path traversal)', () => {
      const r = orchestratedWorkApplier.validate({ projectSlug: '../etc' } as never);
      expect(r.ok).toBe(false);
    });

    it('rejects an invalid product slug', () => {
      const r = orchestratedWorkApplier.validate({ projectSlug: 'demo', product: '../x' } as never);
      expect(r.ok).toBe(false);
    });
  });

  describe('apply — maps OrchestrationResult to a terminal event', () => {
    let created: boolean;
    let destroyed: boolean;
    let wtDir: string | null;

    beforeEach(() => {
      created = false;
      destroyed = false;
      wtDir = null;
    });

    afterEach(() => {
      __resetOrchestratedRuntimeForTest();
      if (wtDir) rmSync(wtDir, { recursive: true, force: true });
    });

    function inject(result: OrchestrationResult): void {
      __setOrchestratedRuntimeForTest({
        createWorktree: async () => {
          created = true;
          const { sandbox, dir } = makeWorktree();
          wtDir = dir;
          return sandbox;
        },
        destroyWorktree: async () => {
          destroyed = true;
        },
        runOrchestration: async () => result,
      });
    }

    it('finalized → completed terminal event tagged orchestrated', async () => {
      inject({ kind: 'finalized', outcome: 'branch-complete' });
      const events = await drain(orchestratedWorkApplier.apply(makeDescriptor(), ctx));
      const terminal = events.find((e) => e.kind === 'completed' || e.kind === 'failed');
      expect(terminal?.kind).toBe('completed');
      const data = terminal?.data as Record<string, unknown>;
      expect(data['dispatchMode']).toBe('orchestrated');
      expect(data['projectSlug']).toBe('demo');
      expect(created).toBe(true);
      expect(destroyed).toBe(true);
    });

    it('held (finalizer unavailable) → completed terminal event flagged held, never self-merge', async () => {
      inject({
        kind: 'held',
        handoff: {
          runId: 'mut-1',
          project: 'demo',
          product: 'jarvis',
          branch: 'jarvis-work/demo',
          taskRecords: [],
        },
      });
      const events = await drain(orchestratedWorkApplier.apply(makeDescriptor(), ctx));
      const terminal = events.find((e) => e.kind === 'completed' || e.kind === 'failed');
      // A held run is a legitimate durable terminal (branch-complete, awaiting
      // the Project 15 finalizer) — not a failure.
      expect(terminal?.kind).toBe('completed');
      const data = terminal?.data as Record<string, unknown>;
      expect(data['held']).toBe(true);
      expect(destroyed).toBe(true);
    });

    it('blocked → failed terminal event carrying the block reason', async () => {
      inject({
        kind: 'blocked',
        reason: 'closeout checks failed',
        task: { id: 't1', text: 'task one', section: 'Phase 1' },
      });
      const events = await drain(orchestratedWorkApplier.apply(makeDescriptor(), ctx));
      const terminal = events.find((e) => e.kind === 'completed' || e.kind === 'failed');
      expect(terminal?.kind).toBe('failed');
      const data = terminal?.data as Record<string, unknown>;
      expect(String(data['reason'])).toContain('closeout checks failed');
      expect(destroyed).toBe(true);
    });

    it('Phase 1b scope (project 13): a blocked orchestrated run is FAILED + worktree destroyed, never parked', async () => {
      // Parking is the legacy `work-run` applier's behavior ONLY. The
      // orchestrated applier never spawns the `/work --auto` process the
      // JARVIS_WORK_RUN_SENTINEL rides on, and it maps a human-block to `failed`
      // + unconditional worktree teardown in its finally. This documents the
      // legacy-only boundary (spec.md Background §6 / Non-Goals) — a
      // verify-not-implement regression, green today.
      inject({
        kind: 'blocked',
        reason: 'a task needs a human decision',
        task: { id: 't1', text: 'task one', section: 'Phase 1' },
      });
      const events = await drain(orchestratedWorkApplier.apply(makeDescriptor(), ctx));
      const terminal = events.find((e) => e.kind === 'completed' || e.kind === 'failed');
      expect(terminal?.kind).toBe('failed');
      const data = (terminal?.data ?? {}) as Record<string, unknown>;
      // NOT parked: no parked metadata, no operator path, no sentinel payload.
      expect(data['parked']).toBeUndefined();
      expect(data['pendingCheck']).toBeUndefined();
      expect(data['operatorWorktreePath']).toBeUndefined();
      // The worktree is unconditionally torn down (never left live for a human).
      expect(destroyed).toBe(true);
    });

    it('worktree-create failure → failed terminal event, no destroy of a non-existent tree', async () => {
      __setOrchestratedRuntimeForTest({
        createWorktree: async () => {
          throw new Error('worktree add failed');
        },
        destroyWorktree: async () => {
          destroyed = true;
        },
        runOrchestration: async () => ({ kind: 'finalized', outcome: 'x' }),
      });
      const events = await drain(orchestratedWorkApplier.apply(makeDescriptor(), ctx));
      const terminal = events.find((e) => e.kind === 'completed' || e.kind === 'failed');
      expect(terminal?.kind).toBe('failed');
      expect(destroyed).toBe(false);
    });
  });
});
