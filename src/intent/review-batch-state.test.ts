import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildInvariantChecklistEvidence } from './invariant-review.js';

const MODULE_URL = new URL('./review-batch-state.js', import.meta.url);
const SOURCE_PATH = fileURLToPath(new URL('./review-batch-state.ts', import.meta.url));

type ReviewBatchModule = {
  parseReviewBatchState: (raw: unknown) => unknown;
  serializeReviewBatchState: (state: unknown) => unknown;
  resumeReviewBatchState: (state: unknown, context: Record<string, unknown>) => unknown;
};

async function loadReviewBatchModule(): Promise<ReviewBatchModule> {
  expect(
    existsSync(SOURCE_PATH),
    'durable review batches require src/intent/review-batch-state.ts',
  ).toBe(true);
  return import(MODULE_URL.href) as Promise<ReviewBatchModule>;
}

const IDENTITY = {
  taskId: 'quorum-core',
  baseTree: '1111111111111111111111111111111111111111',
  currentTree: '2222222222222222222222222222222222222222',
  canonicalHash: 'canonical-review-hash',
};

const INVARIANT_CHECKLIST = buildInvariantChecklistEvidence([{
  id: 'INV-1',
  category: 'ownership-and-containment',
  invariant: 'Rune credentials never reach the product child.',
  evidence: [{ path: 'src/jobs/credential-injector.ts', anchor: 'buildChildEnv' }],
  draftIds: ['DRAFT-1'],
}]);

function durableBatch() {
  return {
    version: 1,
    batchId: 'review-batch-1',
    taskId: IDENTITY.taskId,
    taskBaseTree: IDENTITY.baseTree,
    currentReviewTree: IDENTITY.currentTree,
    canonicalHash: IDENTITY.canonicalHash,
    round: 2,
    workflowAttempt: 3,
    createdAt: '2026-08-10T15:00:00.000Z',
    updatedAt: '2026-08-10T15:04:30.000Z',
    quorum: {
      status: 'pending',
    },
    roles: [
      {
        role: 'reviewer',
        quorumEligible: true,
        required: false,
        status: 'verdict',
        attemptsConsumed: 1,
        retryEligible: false,
        attempts: [{
          attemptId: 'reviewer-attempt-1',
          attempt: 1,
          status: 'verdict',
          startedAt: '2026-08-10T15:00:00.000Z',
          endedAt: '2026-08-10T15:01:00.000Z',
          durationMs: 60_000,
          model: 'opus',
          provider: 'anthropic',
          retryEligible: false,
          verdict: { outcome: 'pass', findingCount: 0 },
        }],
      },
      {
        role: 'tech-lead',
        quorumEligible: true,
        required: false,
        status: 'running',
        attemptsConsumed: 1,
        retryEligible: true,
        attempts: [{
          attemptId: 'tech-lead-attempt-1',
          attempt: 1,
          status: 'running',
          startedAt: '2026-08-10T15:01:30.000Z',
          model: 'sonnet',
          provider: 'anthropic',
          retryEligible: true,
        }],
      },
      {
        role: 'security',
        quorumEligible: true,
        required: false,
        status: 'pending',
        attemptsConsumed: 0,
        retryEligible: true,
        attempts: [],
      },
      {
        role: 'designer',
        quorumEligible: false,
        required: true,
        status: 'pending',
        attemptsConsumed: 0,
        retryEligible: false,
        attempts: [],
      },
    ],
    resumeContext: {
      artifactPass: 'coder-retry',
      tests: ['quorum-contract'],
      qa: { kind: 'tests-written', testIds: ['quorum-contract'] },
      coderHandoffNotes: ['review wave ready'],
      invariantChecklistBlock: INVARIANT_CHECKLIST.canonicalBlock,
      invariantChecklist: INVARIANT_CHECKLIST,
    },
  };
}

describe('durable review-batch state', () => {
  it('round-trips versioned identity, resume context, quorum, and every role transition', async () => {
    const stateModule = await loadReviewBatchModule();
    const original: Record<string, any> = durableBatch();

    const parsed = stateModule.parseReviewBatchState(
      stateModule.serializeReviewBatchState(original),
    );

    expect(parsed).toEqual(original);
    expect(parsed).not.toBe(original);
  });

  it('round-trips the ratified invariant checklist needed by a resumed security task', async () => {
    const stateModule = await loadReviewBatchModule();
    const original: Record<string, any> = durableBatch();
    const checklist = INVARIANT_CHECKLIST;
    original.resumeContext = {
      ...original.resumeContext,
      invariantChecklistBlock: checklist.canonicalBlock,
      invariantChecklist: checklist,
    };

    const parsed = stateModule.parseReviewBatchState(
      stateModule.serializeReviewBatchState(original),
    ) as typeof original;

    expect(parsed.resumeContext.invariantChecklist).toEqual(checklist);
  });

  it('rejects a resume snapshot whose rendered invariant block diverges from typed evidence', async () => {
    const stateModule = await loadReviewBatchModule();
    const original: Record<string, any> = durableBatch();
    original.resumeContext.invariantChecklistBlock = '## Different checklist';

    expect(stateModule.parseReviewBatchState(original)).toBeUndefined();
  });

  it('keeps legacy checkpoints readable when no versioned review batch is present', async () => {
    const stateModule = await loadReviewBatchModule();

    expect(stateModule.parseReviewBatchState(undefined)).toBeUndefined();
    expect(stateModule.parseReviewBatchState({
      taskId: IDENTITY.taskId,
      role: 'judgment-batch',
      judgmentBatch: {
        batchId: 'legacy-batch',
        members: [{ role: 'reviewer', model: 'opus', provider: 'anthropic' }],
      },
    })).toBeUndefined();
  });

  it.each([
    [{ status: 'satisfied' }, 'satisfied without a role'],
    [{ status: 'objected' }, 'objected without a role'],
    [{ status: 'pending', satisfyingRole: 'reviewer' }, 'pending with a satisfying role'],
    [{ status: 'failed', objectingRole: 'security' }, 'failed with an objecting role'],
    [{ status: 'satisfied', satisfyingRole: 'reviewer', objectingRole: 'security' },
      'satisfied with an objecting role'],
  ])('rejects incoherent durable quorum state: %s (%s)', async (quorum, _label) => {
    const stateModule = await loadReviewBatchModule();
    const state: Record<string, any> = durableBatch();
    state.quorum = quorum;

    expect(stateModule.parseReviewBatchState(state)).toBeUndefined();
  });

  it('rejects role metadata that could make designer count toward quorum', async () => {
    const stateModule = await loadReviewBatchModule();
    const state: Record<string, any> = durableBatch();
    const designer = state.roles.find((role: { role: string }) => role.role === 'designer');
    designer.quorumEligible = true;

    expect(stateModule.parseReviewBatchState(state)).toBeUndefined();
  });

  it('rejects a satisfied durable quorum whose named role has no passing verdict', async () => {
    const stateModule = await loadReviewBatchModule();
    const state: Record<string, any> = durableBatch();
    state.quorum = { status: 'satisfied', satisfyingRole: 'tech-lead' };

    expect(stateModule.parseReviewBatchState(state)).toBeUndefined();
  });

  it.each([
    ['latest status mismatch', (role: Record<string, any>) => { role.status = 'running'; }],
    ['non-sequential attempt number', (role: Record<string, any>) => { role.attempts[0].attempt = 2; }],
    ['verdict marked retryable', (role: Record<string, any>) => { role.retryEligible = true; }],
    ['verdict without evidence', (role: Record<string, any>) => { delete role.attempts[0].verdict; }],
  ])('rejects incoherent durable role state: %s', async (_label, mutate) => {
    const stateModule = await loadReviewBatchModule();
    const state: Record<string, any> = durableBatch();
    mutate(state.roles.find((role: { role: string }) => role.role === 'reviewer'));

    expect(stateModule.parseReviewBatchState(state)).toBeUndefined();
  });

  it('rejects a pending role whose consumed budget could launch attempt three', async () => {
    const stateModule = await loadReviewBatchModule();
    const state: Record<string, any> = durableBatch();
    const security = state.roles.find((role: { role: string }) => role.role === 'security');
    security.status = 'pending';
    security.attemptsConsumed = 2;
    security.retryEligible = true;
    security.attempts = [1, 2].map((attempt) => ({
      attemptId: `security-attempt-${attempt}`,
      attempt,
      status: 'operational-failure',
      startedAt: `2026-08-10T15:0${attempt}:00.000Z`,
      endedAt: `2026-08-10T15:0${attempt}:30.000Z`,
      durationMs: 30_000,
      model: attempt === 1 ? 'opus' : 'security-escalation',
      provider: 'anthropic',
      failureCategory: 'provider',
      retryEligible: attempt === 1,
    }));

    expect(stateModule.parseReviewBatchState(state)).toBeUndefined();
  });

  it('rejects a reusable normalized verdict without strict finding evidence', async () => {
    const stateModule = await loadReviewBatchModule();
    const state: Record<string, any> = durableBatch();
    const reviewer = state.roles.find((role: { role: string }) => role.role === 'reviewer');
    reviewer.attempts[0].verdict.normalizedVerdict = { outcome: 'pass' };

    expect(stateModule.parseReviewBatchState(state)).toBeUndefined();
  });

  it('rejects unrecognized fields nested inside normalized finding evidence', async () => {
    const stateModule = await loadReviewBatchModule();
    const state: Record<string, any> = durableBatch();
    const reviewer = state.roles.find((role: { role: string }) => role.role === 'reviewer');
    reviewer.attempts[0].verdict = {
      outcome: 'fail',
      findingCount: 1,
      normalizedVerdict: {
        outcome: 'fail',
        findings: [{
          class: 'data-integrity',
          severity: 'high',
          location: 'src/intent/review-batch-state.ts:445',
          rationale: 'durable evidence must not preserve an undeclared raw model field',
          rawPrompt: 'sensitive unbounded model input',
        }],
      },
    };

    expect(stateModule.parseReviewBatchState(state)).toBeUndefined();
  });

  it.each([
    ['oversized string tests', (context: Record<string, any>) => { context.tests = 'x'.repeat(32_001); }],
    ['too many test IDs', (context: Record<string, any>) => {
      context.qa.testIds = Array.from({ length: 257 }, (_, index) => `test-${index}`);
    }],
    ['too many handoff notes', (context: Record<string, any>) => {
      context.coderHandoffNotes = Array.from({ length: 65 }, () => 'note');
    }],
  ])('rejects unbounded resume context: %s', async (_label, mutate) => {
    const stateModule = await loadReviewBatchModule();
    const state: Record<string, any> = durableBatch();
    mutate(state.resumeContext);

    expect(stateModule.parseReviewBatchState(state)).toBeUndefined();
  });

  it('reuses exact-tree verdicts, preserves pending roles, and converts prior running work to interrupted failure', async () => {
    const stateModule = await loadReviewBatchModule();
    const resumed = stateModule.resumeReviewBatchState(durableBatch(), {
      ...IDENTITY,
      interruptedAt: '2026-08-10T15:05:00.000Z',
    }) as ReturnType<typeof durableBatch>;

    const roles = Object.fromEntries(resumed.roles.map((role) => [role.role, role]));
    expect(roles['reviewer']).toMatchObject({
      status: 'verdict',
      attemptsConsumed: 1,
      attempts: [expect.objectContaining({
        verdict: { outcome: 'pass', findingCount: 0 },
      })],
    });
    expect(roles['security']).toMatchObject({
      status: 'pending',
      attemptsConsumed: 0,
    });
    expect(roles['tech-lead']).toMatchObject({
      status: 'operational-failure',
      attemptsConsumed: 1,
      retryEligible: true,
      attempts: [expect.objectContaining({
        attemptId: 'tech-lead-attempt-1',
        status: 'operational-failure',
        failureCategory: 'interrupted',
        retryEligible: true,
        endedAt: '2026-08-10T15:05:00.000Z',
        durationMs: 210_000,
      })],
    });
  });

  it.each([
    ['taskId', 'another-task'],
    ['baseTree', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
    ['currentTree', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'],
    ['canonicalHash', 'different-review-hash'],
  ])('rejects resume when %s drifts from the durable review surface', async (field, value) => {
    const stateModule = await loadReviewBatchModule();

    expect(() => stateModule.resumeReviewBatchState(durableBatch(), {
      ...IDENTITY,
      [field]: value,
      interruptedAt: '2026-08-10T15:05:00.000Z',
    })).toThrow(expect.objectContaining({
      category: field === 'taskId' ? 'task-mismatch' : 'review-surface-drift',
    }));
  });

  it('preserves escalation binding consumption so restart cannot reset the retry bound', async () => {
    const stateModule = await loadReviewBatchModule();
    const state: Record<string, any> = durableBatch();
    const techLeadIndex = state.roles.findIndex((role: { role: string }) => role.role === 'tech-lead');
    state.roles[techLeadIndex] = {
      role: 'tech-lead',
      quorumEligible: true,
      required: false,
      status: 'operational-failure',
      attemptsConsumed: 2,
      retryEligible: false,
      attempts: [{
        attemptId: 'tech-lead-attempt-1',
        attempt: 1,
        status: 'operational-failure',
        startedAt: '2026-08-10T15:00:00.000Z',
        endedAt: '2026-08-10T15:01:00.000Z',
        durationMs: 60_000,
        model: 'sonnet',
        provider: 'anthropic',
        failureCategory: 'provider',
        retryEligible: false,
      }, {
        attemptId: 'tech-lead-attempt-2',
        attempt: 2,
        status: 'operational-failure',
        startedAt: '2026-08-10T15:01:00.000Z',
        endedAt: '2026-08-10T15:02:00.000Z',
        durationMs: 60_000,
        model: 'codex-review-escalation',
        provider: 'openai',
        failureCategory: 'provider',
        retryEligible: false,
      }],
    };

    const parsed = stateModule.parseReviewBatchState(
      stateModule.serializeReviewBatchState(state),
    ) as ReturnType<typeof durableBatch>;

    const parsedTechLead = parsed.roles.find((role) => role.role === 'tech-lead');
    expect(parsedTechLead).toMatchObject({
      attemptsConsumed: 2,
      retryEligible: false,
      attempts: [
        expect.objectContaining({ attempt: 1, model: 'sonnet', provider: 'anthropic' }),
        expect.objectContaining({
          attempt: 2,
          model: 'codex-review-escalation',
          provider: 'openai',
        }),
      ],
    });
  });

  it('scrubs host paths from bounded operational diagnostics', async () => {
    const stateModule = await loadReviewBatchModule();
    const state: Record<string, any> = durableBatch();
    const techLead = state.roles.find((role: { role: string }) => role.role === 'tech-lead');
    techLead.status = 'operational-failure';
    techLead.attempts[0] = {
      ...techLead.attempts[0],
      status: 'operational-failure',
      endedAt: '2026-08-10T15:02:00.000Z',
      durationMs: 30_000,
      failureCategory: 'executor-exit',
      diagnostic: 'aborted_streaming while reading /Users/operator/workspace/product/private.ts',
    };

    const parsed = stateModule.parseReviewBatchState(
      stateModule.serializeReviewBatchState(state),
    ) as ReturnType<typeof durableBatch>;
    const diagnostic = (parsed.roles
      .find((role) => role.role === 'tech-lead')
      ?.attempts[0] as { diagnostic?: string } | undefined)?.diagnostic;

    expect(diagnostic).toMatch(/<(?:project|absolute-path)>/);
    expect(diagnostic).not.toContain('/Users/operator');
    expect(diagnostic!.length).toBeLessThanOrEqual(500);
  });
});
