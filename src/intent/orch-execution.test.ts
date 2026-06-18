/**
 * Phase 3 test suite for the orchestrator execution substrate (project 14,
 * test-plan §3): bounded per-task context assembly, task run records, attempt
 * caps + escalation, the finalizer handoff payload + injectable adapter, and the
 * rollout/fallback (orchestrated vs legacy) config.
 *
 * Written TEST-FIRST — RED until the matching modules land in later `/work` runs.
 *
 * See: docs/projects/14-product-team-agents/test-plan.md §3, §5
 */

import { describe, it, expect } from 'vitest';

import { assembleTaskContext } from './orch-context-assembly.js';
import { buildTaskRunRecord, type TaskRunRecord } from './orch-run-record.js';
import { decideAttemptOutcome } from './orch-attempt-cap.js';
import {
  buildFinalizerHandoff,
  runFinalizerHandoff,
  type FinalizerAdapter,
} from './finalizer-handoff.js';
import { resolveDispatchMode } from './orch-config.js';
import { seedProjectContext } from './project-context.js';

const CONTEXT_MD = seedProjectContext({
  product: 'aura',
  projectTitle: 'Streaks',
  specSummary: 'Track daily streaks.',
  assumptions: ['Reset at local midnight'],
});

// ---------------------------------------------------------------------------
// Bounded context assembly — task N+1 gets a bounded slice, NOT a transcript
// ---------------------------------------------------------------------------

describe('orch-context-assembly — bounded handoff', () => {
  const task = { id: 't2', text: 'Build the streak API route', section: 'Phase 2' };

  it('includes the selected task text and the project context', () => {
    const asm = assembleTaskContext({ task, contextMd: CONTEXT_MD, spec: 'spec body' });
    expect(asm.handoff).toContain('Build the streak API route');
    expect(asm.handoff).toContain('Reset at local midnight');
  });

  it('does NOT carry a prior task transcript or accumulated conversation', () => {
    const priorTranscript = 'User: hi\nAssistant: working\n'.repeat(50);
    const asm = assembleTaskContext({
      task,
      contextMd: CONTEXT_MD,
      spec: 'spec body',
      // Even if a transcript is offered, the assembler must not splice it in.
      priorTranscript,
    });
    expect(asm.handoff).not.toContain('User: hi');
  });

  it('bounds the handoff size', () => {
    const asm = assembleTaskContext({ task, contextMd: CONTEXT_MD, spec: 'x'.repeat(100000) });
    expect(asm.handoff.length).toBeLessThanOrEqual(asm.budget);
  });
});

// ---------------------------------------------------------------------------
// Task run records — carry the full required field set
// ---------------------------------------------------------------------------

describe('orch-run-record — required fields', () => {
  it('builds a record with every required field', () => {
    const rec: TaskRunRecord = buildTaskRunRecord({
      taskId: 't2',
      taskText: 'Build the streak API route',
      attemptId: 'a1',
      rolesInvoked: ['qa', 'coder', 'reviewer', 'tech-lead'],
      transcriptIds: ['tr-1', 'tr-2'],
      modelChoices: { coder: 'claude', reviewer: 'codex' },
      commitSha: 'def5678',
      verdicts: { reviewer: 'pass', techLead: 'pass' },
      contextOutcome: 'updated',
      gates: { objectionOpen: false },
      outcome: 'ready-for-closeout',
    });
    expect(rec.taskId).toBe('t2');
    expect(rec.attemptId).toBe('a1');
    expect(rec.rolesInvoked).toContain('reviewer');
    expect(rec.transcriptIds).toEqual(['tr-1', 'tr-2']);
    expect(rec.modelChoices.coder).toBe('claude');
    expect(rec.modelChoices.reviewer).toBe('codex');
    expect(rec.commitSha).toBe('def5678');
    expect(rec.verdicts.reviewer).toBe('pass');
    expect(rec.contextOutcome).toBe('updated');
    expect(rec.gates.objectionOpen).toBe(false);
    expect(rec.outcome).toBe('ready-for-closeout');
  });

  it('carries pass-with-warnings findings and accepted-block rationales as task evidence', () => {
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

    const warnings = [warning];
    const rec: TaskRunRecord = buildTaskRunRecord({
      taskId: 't3',
      taskText: 'Cache repeated reads',
      attemptId: 'a2',
      rolesInvoked: ['qa', 'coder', 'reviewer', 'tech-lead', 'pm'],
      transcriptIds: ['tr-3'],
      modelChoices: { coder: 'claude', reviewer: 'codex' },
      commitSha: 'abc1234',
      verdicts: { reviewer: 'pass-with-warnings' },
      warnings,
      acceptance,
      contextOutcome: 'updated',
      gates: { objectionOpen: false },
      outcome: 'ready-for-closeout',
    });

    expect(rec.verdicts.reviewer).toBe('pass-with-warnings');
    expect(rec.warnings).toEqual([warning]);
    expect(rec.acceptance).toEqual(acceptance);
    expect(rec.gates.objectionOpen).toBe(false);

    // The run record is durable evidence; callers must not be able to mutate it
    // through the input arrays/objects they passed to the builder.
    expect(rec.warnings).not.toBe(warnings);
    expect(rec.warnings?.[0]).not.toBe(warning);
    expect(rec.acceptance).not.toBe(acceptance);
  });
});

// ---------------------------------------------------------------------------
// Attempt caps — bounded retry, then escalation
// ---------------------------------------------------------------------------

describe('orch-attempt-cap — bounded retry', () => {
  it('retries below the cap on a non-objection failure', () => {
    const d = decideAttemptOutcome({ attempts: 1, cap: 3, outcome: 'failed', objectionOpen: false });
    expect(d.action).toBe('retry');
  });

  it('routes non-objection disagreement at the cap to PM wrap-up', () => {
    const d = decideAttemptOutcome({ attempts: 3, cap: 3, outcome: 'blocked', objectionOpen: false });
    expect(d.action).toBe('pm-wrapup');
  });

  it('routes an open objection-class finding to blocked-on-human, even below cap', () => {
    const d = decideAttemptOutcome({ attempts: 1, cap: 3, outcome: 'blocked', objectionOpen: true });
    expect(d.action).toBe('blocked-on-human');
  });

  it('never retries past the cap', () => {
    const d = decideAttemptOutcome({ attempts: 5, cap: 3, outcome: 'failed', objectionOpen: false });
    expect(d.action).not.toBe('retry');
  });

  it('proceeds on a successful attempt, even on the final allowed attempt', () => {
    const d = decideAttemptOutcome({
      attempts: 3,
      cap: 3,
      outcome: 'ready-for-closeout',
      objectionOpen: false,
    });
    expect(d.action).toBe('proceed');
  });

  it('an open objection blocks even a successful attempt', () => {
    const d = decideAttemptOutcome({
      attempts: 1,
      cap: 3,
      outcome: 'ready-for-closeout',
      objectionOpen: true,
    });
    expect(d.action).toBe('blocked-on-human');
  });
});

// ---------------------------------------------------------------------------
// Finalizer handoff — payload + injectable adapter; no self-merge
// ---------------------------------------------------------------------------

describe('finalizer-handoff — payload + adapter', () => {
  const records: TaskRunRecord[] = [
    buildTaskRunRecord({
      taskId: 't1',
      taskText: 'First',
      attemptId: 'a1',
      rolesInvoked: ['coder'],
      transcriptIds: ['x'],
      modelChoices: { coder: 'claude' },
      commitSha: 'aaa',
      verdicts: { reviewer: 'pass' },
      contextOutcome: 'updated',
      gates: { objectionOpen: false },
      outcome: 'ready-for-closeout',
    }),
  ];

  it('builds a handoff carrying branch/run facts for the finalizer', () => {
    const h = buildFinalizerHandoff({
      runId: 'run-1',
      project: '14-product-team-agents',
      product: 'jarvis',
      branch: 'jarvis-work/14-x',
      baseBranch: 'main',
      taskRecords: records,
    });
    expect(h.branch).toBe('jarvis-work/14-x');
    expect(h.baseBranch).toBe('main');
    expect(h.taskRecords).toHaveLength(1);
  });

  it('calls the injected finalizer adapter rather than self-merging', async () => {
    let called = false;
    const adapter: FinalizerAdapter = async () => {
      called = true;
      return { kind: 'finalized', outcome: 'branch-complete' };
    };
    const h = buildFinalizerHandoff({
      runId: 'run-1',
      project: 'p',
      product: 'jarvis',
      branch: 'b',
      baseBranch: 'main',
      taskRecords: records,
    });
    const res = await runFinalizerHandoff(h, adapter);
    expect(called).toBe(true);
    expect(res.kind).toBe('finalized');
  });

  it('when the finalizer is unavailable, records the payload and stops (no self-merge)', async () => {
    const unavailable: FinalizerAdapter = async () => ({ kind: 'unavailable', reason: 'finalizer not wired' });
    const h = buildFinalizerHandoff({
      runId: 'run-1',
      project: 'p',
      product: 'jarvis',
      branch: 'b',
      baseBranch: 'main',
      taskRecords: records,
    });
    const res = await runFinalizerHandoff(h, unavailable);
    expect(res.kind).toBe('held');
    if (res.kind === 'held') {
      // The payload is preserved for retry; the run stops branch-complete/blocked.
      expect(res.handoff.branch).toBe('b');
    }
  });
});

// ---------------------------------------------------------------------------
// Rollout / fallback — orchestrated vs legacy dispatch
// ---------------------------------------------------------------------------

describe('orch-config — dispatch mode', () => {
  it('defaults to orchestrated when the toggle is on', () => {
    const m = resolveDispatchMode({ orchestratedEnabled: true });
    expect(m.mode).toBe('orchestrated');
  });

  it('falls back to legacy with a recorded reason when disabled', () => {
    const m = resolveDispatchMode({ orchestratedEnabled: false });
    expect(m.mode).toBe('legacy');
    expect(m.fallbackReason).toBeTruthy();
  });

  it('falls back to legacy with a reason when explicitly forced', () => {
    const m = resolveDispatchMode({ orchestratedEnabled: true, forceLegacy: true, forceLegacyReason: 'operator override' });
    expect(m.mode).toBe('legacy');
    expect(m.fallbackReason).toBe('operator override');
  });
});
