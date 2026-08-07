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
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { assembleTaskContext } from './orch-context-assembly.js';
import { buildTaskRunRecord, type TaskRunRecord } from './orch-run-record.js';
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
const INTENT_DIR = dirname(fileURLToPath(import.meta.url));

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
      preCloseoutValidation: {
        version: 1,
        receiptId: 'a'.repeat(64),
        durationMs: 1_250,
        outcome: 'passed',
        reuseDecision: 'reused',
      },
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
    expect(rec.preCloseoutValidation).toEqual({
      version: 1,
      receiptId: 'a'.repeat(64),
      durationMs: 1_250,
      outcome: 'passed',
      reuseDecision: 'reused',
    });
    expect(rec.contextOutcome).toBe('updated');
    expect(rec.gates.objectionOpen).toBe(false);
    expect(rec.outcome).toBe('ready-for-closeout');
  });

  it('carries pass-with-warnings findings and low-severity acceptance rationales as task evidence', () => {
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
        'Accepting because the remaining concern is low severity and the task contract is satisfied.',
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

  it('bounds and defensively copies judgment batch outcomes for durable evidence', () => {
    const judgmentOutcomes = [
      {
        role: 'reviewer' as const,
        status: 'failed' as const,
        summary: 'x'.repeat(750),
      },
      { role: 'tech-lead' as const, status: 'cancelled' as const },
      { role: 'designer' as const, status: 'reject' as const },
      { role: 'reviewer' as const, status: 'reject' as const },
    ];
    const rec = buildTaskRunRecord({
      taskId: 'judgment-evidence',
      taskText: 'Persist judgment evidence',
      attemptId: 'a-judgment',
      rolesInvoked: ['qa', 'coder', 'reviewer', 'tech-lead', 'designer'],
      transcriptIds: [],
      modelChoices: {},
      commitSha: null,
      verdicts: {},
      judgmentOutcomes,
      contextOutcome: 'unchanged',
      gates: { objectionOpen: false },
      outcome: 'failed',
    });

    // Bounded to one per dispatchable judgment role — reviewer, tech lead, and
    // designer. The fourth entry is dropped.
    expect(rec.judgmentOutcomes).toHaveLength(3);
    expect(rec.judgmentOutcomes?.[0]?.summary).toHaveLength(500);
    expect(rec.judgmentOutcomes).not.toBe(judgmentOutcomes);
    expect(rec.judgmentOutcomes?.[0]).not.toBe(judgmentOutcomes[0]);
  });

  it('persists bounded adjudication and downgrade evidence with path scrubbing', () => {
    const adjudications = [{
      round: 1,
      dissentingRole: 'reviewer' as const,
      concurringRole: 'tech-lead' as const,
      signature: 'security/high @ /Users/operator/private/auth.ts:8',
      upheld: 'pass' as const,
      rationale: 'The guard at /Users/operator/private/auth.ts:8 settles the dispute.',
      escalated: false,
      executedModelAlias: 'gpt-5.6-terra',
      executedProvider: 'openai' as const,
    }];
    const downgradedFindings = [{
      finding: {
        class: 'security' as const,
        severity: 'medium' as const,
        location: '/Users/operator/private/export.ts:9',
        rationale: 'The export concern lacks a reproducible path.',
      },
      sourceGate: 'reviewer' as const,
      round: 1,
      gaps: ['location' as const],
      reason: 'missing evidence at /Users/operator/private/export.ts:9',
      rePrompted: true,
    }];
    const rec = buildTaskRunRecord({
      taskId: 'durable-decisions',
      taskText: 'Persist decisions',
      attemptId: 'a-decisions',
      rolesInvoked: ['reviewer', 'tech-lead', 'adjudicator'],
      transcriptIds: [],
      modelChoices: {},
      commitSha: 'abc4444',
      verdicts: { reviewer: 'fail', 'tech-lead': 'pass' },
      adjudications,
      downgradedFindings,
      contextOutcome: 'updated',
      gates: { objectionOpen: false },
      outcome: 'ready-for-closeout',
    });

    expect(rec.adjudications).toHaveLength(1);
    expect(rec.downgradedFindings).toHaveLength(1);
    expect(rec.adjudications).not.toBe(adjudications);
    expect(rec.adjudications?.[0]).toMatchObject({
      executedModelAlias: 'gpt-5.6-terra',
      executedProvider: 'openai',
    });
    expect(rec.downgradedFindings).not.toBe(downgradedFindings);
    expect(JSON.stringify({
      adjudications: rec.adjudications,
      downgradedFindings: rec.downgradedFindings,
    })).not.toContain('/Users/operator');
  });

  it('scrubs and defensively copies the accepted-with-rationale overridden verdict', () => {
    const acceptance = {
      actor: 'pm' as const,
      decision: 'accepted-with-rationale' as const,
      rationale: 'Accepted at /Users/operator/private/decision.md because the risk is low.',
      dissentingRole: 'tech-lead' as const,
      overriddenVerdict: {
        outcome: 'fail' as const,
        findings: [{
          class: 'cost-perf' as const,
          severity: 'low' as const,
          location: '/Users/operator/private/store.ts:12',
          rationale: 'Extra churn seen at /Users/operator/private/store.ts:12',
          suggestedChange: 'Batch the write at /Users/operator/private/store.ts:12',
        }],
        notes: 'Dissent recorded at /Users/operator/private/store.ts:12',
        suggestedChange: 'See /Users/operator/private/store.ts:12',
      },
    };

    const rec = buildTaskRunRecord({
      taskId: 'overridden-verdict',
      taskText: 'Persist the overridden verdict',
      attemptId: 'a-overridden',
      rolesInvoked: ['tech-lead', 'pm'],
      transcriptIds: [],
      modelChoices: {},
      commitSha: 'abc9999',
      verdicts: { reviewer: 'pass' },
      acceptance,
      contextOutcome: 'updated',
      gates: { objectionOpen: false },
      outcome: 'ready-for-closeout',
    });

    expect(rec.acceptance?.dissentingRole).toBe('tech-lead');
    expect(rec.acceptance?.overriddenVerdict).not.toBe(acceptance.overriddenVerdict);
    expect(rec.acceptance?.overriddenVerdict?.findings).not.toBe(acceptance.overriddenVerdict.findings);
    expect(rec.acceptance?.overriddenVerdict?.findings[0]).not.toBe(acceptance.overriddenVerdict.findings[0]);
    expect(rec.acceptance?.overriddenVerdict).toMatchObject({
      outcome: 'fail',
      findings: [expect.objectContaining({ class: 'cost-perf', severity: 'low' })],
    });

    const serialized = JSON.stringify(rec.acceptance);
    expect(serialized).not.toContain('/Users/operator');
    expect(serialized).toContain('<path>');
  });

  it('bounds coderSelfReviews to at most 4 rounds and truncates notes/changedPaths for durable evidence', () => {
    const manyPaths = Array.from({ length: 250 }, (_, i) => `src/file-${i}.ts`);
    const longNotes = 'x'.repeat(2_500);
    const coderSelfReviews = Array.from({ length: 6 }, (_, i) => ({
      round: i + 1,
      outcome: (i % 2 === 0 ? 'confirmed' : 'revised') as 'confirmed' | 'revised',
      notes: i === 0 ? longNotes : `round ${i + 1} notes`,
      canonicalHash: `hash-${i + 1}`,
      changedPaths: i === 0 ? manyPaths : ['src/x.ts'],
      artifactAttempts: [{
        attempt: 1,
        status: 'parsed' as const,
        provider: 'openai' as const,
        progressCount: 2,
        candidateCount: 1,
        diagnostic: 'x'.repeat(2_500),
      }],
    }));

    const rec: TaskRunRecord = buildTaskRunRecord({
      taskId: 't4',
      taskText: 'Bound self-review evidence',
      attemptId: 'a4',
      rolesInvoked: ['qa', 'coder', 'reviewer', 'tech-lead'],
      transcriptIds: ['tr-4'],
      modelChoices: { coder: 'claude' },
      commitSha: 'deadbee',
      verdicts: { reviewer: 'pass' },
      coderSelfReviews,
      contextOutcome: 'updated',
      gates: { objectionOpen: false },
      outcome: 'ready-for-closeout',
    });

    // Only the first 4 rounds are retained — repeat self-review after later
    // coder passes must not grow the durable record without bound.
    expect(rec.coderSelfReviews).toHaveLength(4);
    expect(rec.coderSelfReviews?.map((r) => r.round)).toEqual([1, 2, 3, 4]);
    expect(rec.coderSelfReviews?.[0]?.notes).toHaveLength(2_000);
    expect(rec.coderSelfReviews?.[0]?.notes).toBe(longNotes.slice(0, 2_000));
    expect(rec.coderSelfReviews?.[0]?.changedPaths).toHaveLength(200);
    expect(rec.coderSelfReviews?.[0]?.changedPaths).toEqual(manyPaths.slice(0, 200));
    expect(rec.coderSelfReviews?.[0]?.artifactAttempts?.[0]?.diagnostic).toHaveLength(2_000);
    expect(rec.coderSelfReviews?.[0]?.artifactAttempts?.[0]).not.toHaveProperty('artifact');
  });

  it('defensively copies coderSelfReviews so mutating the caller array/objects cannot alter the durable record', () => {
    const review = {
      round: 1,
      outcome: 'confirmed' as const,
      notes: 'clean pass',
      canonicalHash: 'hash-1',
      changedPaths: ['src/x.ts'],
    };
    const coderSelfReviews = [review];

    const rec: TaskRunRecord = buildTaskRunRecord({
      taskId: 't5',
      taskText: 'Defensive copy of self-review evidence',
      attemptId: 'a5',
      rolesInvoked: ['coder'],
      transcriptIds: ['tr-5'],
      modelChoices: { coder: 'claude' },
      commitSha: 'abc1111',
      verdicts: {},
      coderSelfReviews,
      contextOutcome: 'updated',
      gates: { objectionOpen: false },
      outcome: 'ready-for-closeout',
    });

    expect(rec.coderSelfReviews).toEqual([review]);
    expect(rec.coderSelfReviews).not.toBe(coderSelfReviews);
    expect(rec.coderSelfReviews?.[0]).not.toBe(review);
    expect(rec.coderSelfReviews?.[0]?.changedPaths).not.toBe(review.changedPaths);
  });

  it('omits coderSelfReviews entirely when the caller does not supply it, keeping historical records readable', () => {
    const rec: TaskRunRecord = buildTaskRunRecord({
      taskId: 't6',
      taskText: 'No self-review evidence on this record',
      attemptId: 'a6',
      rolesInvoked: ['coder'],
      transcriptIds: ['tr-6'],
      modelChoices: { coder: 'claude' },
      commitSha: 'abc2222',
      verdicts: {},
      contextOutcome: 'updated',
      gates: { objectionOpen: false },
      outcome: 'ready-for-closeout',
    });

    expect(rec.coderSelfReviews).toBeUndefined();
    expect('coderSelfReviews' in rec).toBe(false);
  });

  it('persists bounded scrubbed artifact-contract failures on durable task records', () => {
    const diagnostic = 'invalid artifact at /Users/operator/private';
    const artifactAttempts = [{
      attempt: 1,
      status: 'malformed' as const,
      provider: 'openai' as const,
      progressCount: 1,
      candidateCount: 1,
      diagnostic,
    }];
    const executionFailure = {
      taskId: 't-failure',
      role: 'coder',
      provider: 'openai' as const,
      format: 'codex' as const,
      model: 'gpt-test',
      workflowStage: 'coder-self-review',
      checkpointedAt: '2026-07-30T00:00:00.000Z',
      artifactAttempts,
      failureStage: 'artifact-contract' as const,
      diagnostic,
      retryable: false,
      attempts: [{
        attempt: 1,
        startedAt: '2026-07-30T00:00:00.000Z',
        endedAt: '2026-07-30T00:00:01.000Z',
        failureStage: 'artifact-contract' as const,
        diagnostic,
        retryable: false,
        artifactAttempts,
      }],
      retryDisposition: 'exhausted' as const,
    };

    const rec = buildTaskRunRecord({
      taskId: 't-failure',
      taskText: 'Persist artifact failure',
      attemptId: 'a-failure',
      rolesInvoked: ['coder'],
      transcriptIds: [],
      modelChoices: { coder: 'gpt-test' },
      commitSha: null,
      verdicts: {},
      executionFailure,
      contextOutcome: 'unchanged',
      gates: { objectionOpen: false },
      outcome: 'failed',
    });

    expect(rec.executionFailure).toMatchObject({
      failureStage: 'artifact-contract',
      retryDisposition: 'exhausted',
      artifactAttempts: [expect.objectContaining({ status: 'malformed' })],
    });
    expect(JSON.stringify(rec.executionFailure)).not.toContain('/Users/operator');
    expect(rec.executionFailure).not.toBe(executionFailure);
  });

  it('allowlists durable execution-failure fields instead of cloning runtime extras', () => {
    const diagnostic = 'invalid artifact at /Users/operator/private';
    const executionFailure = {
      taskId: 't-failure',
      role: 'coder',
      provider: 'openai' as const,
      format: 'codex' as const,
      model: 'gpt-test',
      workflowStage: 'coder-self-review',
      checkpointedAt: '2026-07-30T00:00:00.000Z',
      failureStage: 'artifact-contract' as const,
      diagnostic,
      retryable: false,
      attempts: [{
        attempt: 1,
        startedAt: '2026-07-30T00:00:00.000Z',
        endedAt: '2026-07-30T00:00:01.000Z',
        failureStage: 'artifact-contract' as const,
        diagnostic,
        retryable: false,
        rawArtifact: '```coder-self-review\nsecret\n```',
      }],
      retryDisposition: 'exhausted' as const,
      rawArtifact: '```coder-self-review\nsecret\n```',
    };

    const rec = buildTaskRunRecord({
      taskId: 't-failure',
      taskText: 'Persist allowlisted artifact failure',
      attemptId: 'a-failure',
      rolesInvoked: ['coder'],
      transcriptIds: [],
      modelChoices: { coder: 'gpt-test' },
      commitSha: null,
      verdicts: {},
      executionFailure,
      contextOutcome: 'unchanged',
      gates: { objectionOpen: false },
      outcome: 'failed',
    });

    expect(rec.executionFailure).not.toHaveProperty('rawArtifact');
    expect(rec.executionFailure?.attempts[0]).not.toHaveProperty('rawArtifact');
    expect(JSON.stringify(rec.executionFailure)).not.toContain('```coder-self-review');
  });

  it('carries a successful related-test fallback diagnostic into durable task evidence', () => {
    const relatedTestDiagnostic = {
      state: 'related-fallback-passed' as const,
      initial: {
        selectedPaths: ['src/x.ts'],
        argv: ['npx', 'vitest', 'related', '--run', 'src/x.ts'],
        command: '"npx" "vitest" "related" "--run" "src/x.ts"',
        validationCwd: '.',
        result: {
          exitCode: 1,
          timedOut: false,
          outputHead: '',
          outputTail: 'structured host conflict',
          diagnosticArtifacts: [],
        },
        compatibleMode: false,
      },
      conflictEvidence: [{
        kind: 'nested-seatbelt-sandbox-apply' as const,
        source: 'vitest-json' as const,
        scope: 'suite' as const,
        file: 'src/x.test.ts',
        message: 'sandbox_apply: Operation not permitted',
        syscall: 'sandbox_apply' as const,
      }],
      fallback: {
        selectedPaths: ['src/x.ts'],
        argv: ['npx', 'vitest', 'related', '--run', 'src/x.ts'],
        command: '"npx" "vitest" "related" "--run" "src/x.ts"',
        validationCwd: '.',
        result: {
          exitCode: 0,
          timedOut: false,
          outputHead: '',
          outputTail: '',
          diagnosticArtifacts: [],
        },
        compatibleMode: true,
      },
    };
    const rec = buildTaskRunRecord({
      taskId: 't7',
      taskText: 'Confirm a host-conflicted related selection',
      attemptId: 'a7',
      rolesInvoked: ['qa', 'coder', 'reviewer', 'tech-lead'],
      transcriptIds: ['tr-7'],
      modelChoices: { coder: 'claude' },
      commitSha: 'abc3333',
      verdicts: { reviewer: 'pass' },
      relatedTestDiagnostic,
      contextOutcome: 'updated',
      gates: { objectionOpen: false },
      outcome: 'ready-for-closeout',
    });

    expect(rec.relatedTestDiagnostic).toEqual(relatedTestDiagnostic);
    expect(rec.relatedTestDiagnostic).not.toBe(relatedTestDiagnostic);
    expect(rec.relatedTestDiagnostic?.initial.selectedPaths).not.toBe(
      relatedTestDiagnostic.initial.selectedPaths,
    );
  });

  it('keeps historical task records without related-test diagnostics readable', () => {
    const rec = buildTaskRunRecord({
      taskId: 't8',
      taskText: 'Historical task',
      attemptId: 'a8',
      rolesInvoked: ['coder'],
      transcriptIds: [],
      modelChoices: { coder: 'claude' },
      commitSha: 'abc4444',
      verdicts: {},
      contextOutcome: 'updated',
      gates: { objectionOpen: false },
      outcome: 'ready-for-closeout',
    });

    expect(rec.relatedTestDiagnostic).toBeUndefined();
    expect('relatedTestDiagnostic' in rec).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Attempt caps — removed outer cap, no human terminal
// ---------------------------------------------------------------------------

describe('outer attempt cap removal', () => {
  it('does not leave the obsolete decideAttemptOutcome module on disk', () => {
    expect(existsSync(join(INTENT_DIR, 'orch-attempt-cap.ts'))).toBe(false);
  });

  it('does not import decideAttemptOutcome from the project orchestrator', () => {
    const source = readFileSync(join(INTENT_DIR, 'project-orchestrator.ts'), 'utf8');
    expect(source).not.toMatch(/decideAttemptOutcome|orch-attempt-cap/);
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
      product: 'rune',
      branch: 'rune-work/14-x',
      baseBranch: 'main',
      taskRecords: records,
    });
    expect(h.branch).toBe('rune-work/14-x');
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
      product: 'rune',
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
      product: 'rune',
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
