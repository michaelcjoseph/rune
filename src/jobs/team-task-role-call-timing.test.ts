import { describe, it, expect, vi, beforeEach } from 'vitest';

// The wrapper builds its logger at module load, so the mock must be hoisted.
const { roleCallLog } = vi.hoisted(() => ({
  roleCallLog: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));
vi.mock('../utils/logger.js', () => ({ createLogger: () => roleCallLog }));

const { askClaudeWithContext, cleanupSession } = vi.hoisted(() => ({
  askClaudeWithContext: vi.fn(),
  cleanupSession: vi.fn(),
}));
vi.mock('../ai/claude.js', () => ({ askClaudeWithContext, cleanupSession }));

import { defaultJudgmentCall } from './team-task-deps.js';

const CALL = {
  role: 'tech-lead' as const,
  model: 'fable',
  systemPrompt: 'SOUL: you are the tech lead. SECRET-PROMPT-MARKER',
  message: 'Review this diff. SECRET-MESSAGE-MARKER',
  taskId: 'argv-command-executor',
  workflowStage: 'tech-lead-test-review',
};

/** Every `role-call` record emitted during the current test. */
function roleCallRecords(): Record<string, unknown>[] {
  return roleCallLog.info.mock.calls
    .filter((call) => call[0] === 'role-call')
    .map((call) => call[1] as Record<string, unknown>);
}

describe('role-call timing record', () => {
  beforeEach(() => {
    roleCallLog.info.mockClear();
    roleCallLog.error.mockClear();
    askClaudeWithContext.mockReset();
    cleanupSession.mockReset();
  });

  it('stamps one attributed record on a successful call', async () => {
    askClaudeWithContext.mockResolvedValueOnce({ text: 'verdict', error: null });

    await expect(defaultJudgmentCall(CALL)).resolves.toBe('verdict');

    const records = roleCallRecords();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      role: 'tech-lead',
      model: 'fable',
      format: 'claude',
      outcome: 'ok',
      taskId: 'argv-command-executor',
      workflowStage: 'tech-lead-test-review',
    });
    expect(records[0]!['durationMs']).toEqual(expect.any(Number));
    expect(records[0]!['durationMs'] as number).toBeGreaterThanOrEqual(0);
  });

  it('stamps a record when the model call fails, and still rethrows', async () => {
    askClaudeWithContext.mockResolvedValueOnce({
      text: null,
      error: 'Claude exited with code 1',
    });

    await expect(defaultJudgmentCall(CALL)).rejects.toThrow(/model call failed/);

    const records = roleCallRecords();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      role: 'tech-lead',
      outcome: 'error',
      workflowStage: 'tech-lead-test-review',
    });
    expect(records[0]!['durationMs']).toEqual(expect.any(Number));
  });

  it('distinguishes a cancellation from a failure', async () => {
    askClaudeWithContext.mockResolvedValueOnce({
      text: null,
      error: 'Cancelled by user',
      cancellation: {
        operationId: 'abc12345',
        source: 'cockpit',
        requestedAt: '2026-08-05T00:00:00.000Z',
      },
    });

    await expect(defaultJudgmentCall(CALL)).rejects.toThrow();

    expect(roleCallRecords()).toHaveLength(1);
    expect(roleCallRecords()[0]).toMatchObject({ outcome: 'cancelled' });
  });

  it('carries structured attribution only — never prompt or reply content', async () => {
    askClaudeWithContext.mockResolvedValueOnce({
      text: 'SECRET-REPLY-MARKER',
      error: null,
    });

    await defaultJudgmentCall(CALL);

    const serialized = JSON.stringify(roleCallRecords());
    expect(serialized).not.toContain('SECRET-PROMPT-MARKER');
    expect(serialized).not.toContain('SECRET-MESSAGE-MARKER');
    expect(serialized).not.toContain('SECRET-REPLY-MARKER');
  });

  it('omits attribution keys the caller did not supply', async () => {
    askClaudeWithContext.mockResolvedValueOnce({ text: 'ok', error: null });

    await defaultJudgmentCall({
      role: 'reviewer',
      model: 'opus',
      systemPrompt: 's',
      message: 'm',
    });

    const record = roleCallRecords()[0]!;
    expect(record).not.toHaveProperty('taskId');
    expect(record).not.toHaveProperty('workflowStage');
    expect(record).toMatchObject({ role: 'reviewer', outcome: 'ok' });
  });
});
