import { describe, expect, it, vi } from 'vitest';
import type { SupervisedRun } from '../intent/supervision.js';
import { requestWorkRunAnswer, type AnswerRequestDeps } from './work-run-answer.js';

function parkedRun(overrides: Partial<SupervisedRun> = {}): SupervisedRun {
  const now = new Date().toISOString();
  return {
    id: 'run-1',
    kind: 'work-run',
    product: 'rune',
    project: 'demo',
    status: 'blocked-on-human',
    startedAt: now,
    lastHeartbeatAt: now,
    parkedQuestion: {
      source: 'ask-user-question',
      question: 'Pick one',
      options: [{ id: '0', label: 'Yes', value: 'yes' }],
      askedAt: now,
    },
    ...overrides,
  };
}

function deps(run: SupervisedRun | null, overrides: Partial<AnswerRequestDeps> = {}): AnswerRequestDeps {
  return {
    readParkedRun: vi.fn(() => run),
    worktreeFor: vi.fn(() => '/tmp/worktree'),
    worktreeExists: vi.fn(() => true),
    createAnswerMutation: vi.fn(async () => ({ ok: true as const, id: 'answer-1' })),
    ...overrides,
  };
}

describe('requestWorkRunAnswer', () => {
  it('rejects missing parked runs', async () => {
    await expect(requestWorkRunAnswer('run-1', '0', deps(null))).resolves.toEqual({
      kind: 'not-found',
      runId: 'run-1',
      reason: 'run is not parked',
    });
  });

  it('rejects parked runs that are not waiting on a question', async () => {
    const run = parkedRun({ parkedQuestion: undefined });
    const result = await requestWorkRunAnswer('run-1', '0', deps(run));
    expect(result).toEqual({ kind: 'not-found', runId: 'run-1', reason: 'parked run is not waiting on a question' });
  });

  it('rejects invalid option ids and missing worktrees', async () => {
    await expect(requestWorkRunAnswer('run-1', '9', deps(parkedRun()))).resolves.toMatchObject({
      kind: 'not-found',
      reason: 'unknown answer option',
    });
    await expect(requestWorkRunAnswer('run-1', '0', deps(parkedRun(), { worktreeExists: vi.fn(() => false) }))).resolves.toMatchObject({
      kind: 'not-found',
      reason: 'parked worktree is gone',
    });
  });

  it('creates a work-run-answer mutation for a valid answer', async () => {
    const createAnswerMutation = vi.fn(async () => ({ ok: true as const, id: 'answer-1' }));
    const result = await requestWorkRunAnswer('run-1', '0', deps(parkedRun(), { createAnswerMutation }));
    expect(createAnswerMutation).toHaveBeenCalledWith({ runId: 'run-1', optionId: '0' });
    expect(result).toEqual({ kind: 'created', runId: 'run-1', mutationId: 'answer-1' });
  });
});
