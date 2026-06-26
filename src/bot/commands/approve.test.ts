import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MessageSender } from '../../transport/sender.js';

/*
 * approve.ts is now a thin orchestrator: it gates (normal vs retry path) and maps the shared
 * `runScaffoldApproval` outcome to a chat reply + a delete-vs-keep decision. The heavy lifting
 * (target-repo resolution, agent spawn, scaffold-result cross-check, promotion driving, on-disk
 * verification) lives in `src/jobs/scaffold-approval.ts` and is covered by its own suite. Here we
 * mock that helper and assert approve.ts's gating + outcome mapping.
 */

vi.mock('../../config.js', () => ({
  default: { VAULT_DIR: '/test/vault', WORKSPACE_DIR: '/test/ws', TIMEZONE: 'America/Chicago', TELEGRAM_USER_ID: 12345 },
  PROJECT_ROOT: '/test/project',
}));

vi.mock('../../utils/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../../reviews/planning.js', () => ({
  getActivePlanningSession: vi.fn(() => null),
  getPlanningSession: vi.fn(() => null),
  approveActivePlanningSession: vi.fn(),
  deletePlanningSession: vi.fn(),
}));

vi.mock('../../jobs/scaffold-approval.js', () => ({
  runScaffoldApproval: vi.fn(),
}));

const { approveActivePlanningSession, deletePlanningSession, getPlanningSession } = await import('../../reviews/planning.js');
const { runScaffoldApproval } = await import('../../jobs/scaffold-approval.js');
const { handleApprove } = await import('./approve.js');

const approveActivePlanningSessionMock = approveActivePlanningSession as unknown as ReturnType<typeof vi.fn>;
const deletePlanningSessionMock = deletePlanningSession as unknown as ReturnType<typeof vi.fn>;
const getPlanningSessionMock = getPlanningSession as unknown as ReturnType<typeof vi.fn>;
const runScaffoldApprovalMock = runScaffoldApproval as unknown as ReturnType<typeof vi.fn>;

function makeSender(): MessageSender {
  return {
    name: 'telegram' as const,
    send: vi.fn().mockResolvedValue(undefined),
    startTyping: vi.fn(),
    stopTyping: vi.fn(),
  };
}

const BASE_SESSION = {
  id: 'plan-sess-approve',
  chatId: 100,
  claudeSessionId: 'claude-approve',
  planning: {
    status: 'spec-proposed' as const,
    product: 'rune',
    idea: 'build something cool',
    surface: 'chat' as const,
    artifact: { product: 'rune', title: 'Test Project', spec: 'A spec.', tasks: 'tasks', testPlan: 'tp' },
  },
  createdAt: new Date().toISOString(),
  lastActivity: new Date().toISOString(),
};

function approvedSession(over: Record<string, unknown> = {}) {
  return {
    ...BASE_SESSION,
    planning: { ...BASE_SESSION.planning, status: 'approved' as const },
    ...over,
  };
}

function okOutcome(over: Record<string, unknown> = {}) {
  return { ok: true, slug: '09-test', agentText: 'Created docs/projects/09-test/spec.md', promotion: 'none', ...over };
}

describe('handleApprove — gating', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getPlanningSessionMock.mockReturnValue(null);
  });

  it('sends "Nothing to approve." on no-session and never scaffolds', async () => {
    approveActivePlanningSessionMock.mockReturnValue({ ok: false, reason: 'no-session' });
    const sender = makeSender();
    await handleApprove(sender, 100);
    expect((vi.mocked(sender.send).mock.calls[0]![1] as string)).toMatch(/nothing|no active/i);
    expect(runScaffoldApprovalMock).not.toHaveBeenCalled();
    expect(deletePlanningSessionMock).not.toHaveBeenCalled();
  });

  it('sends a scoping reply on wrong-status and never scaffolds', async () => {
    approveActivePlanningSessionMock.mockReturnValue({ ok: false, reason: 'wrong-status', status: 'scoping' });
    const sender = makeSender();
    await handleApprove(sender, 100);
    expect((vi.mocked(sender.send).mock.calls[0]![1] as string)).toMatch(/scoping|spec proposed/i);
    expect(runScaffoldApprovalMock).not.toHaveBeenCalled();
    expect(deletePlanningSessionMock).not.toHaveBeenCalled();
  });

  it('passes the correct userId to approveActivePlanningSession', async () => {
    approveActivePlanningSessionMock.mockReturnValue({ ok: false, reason: 'no-session' });
    await handleApprove(makeSender(), 99999);
    expect(approveActivePlanningSessionMock).toHaveBeenCalledWith(99999);
  });
});

describe('handleApprove — normal path outcome mapping', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getPlanningSessionMock.mockReturnValue(null);
  });

  it('success: passes the approved session to the helper, surfaces output, deletes the session', async () => {
    const session = approvedSession();
    approveActivePlanningSessionMock.mockReturnValue({ ok: true, session });
    runScaffoldApprovalMock.mockResolvedValue(okOutcome());

    const sender = makeSender();
    await handleApprove(sender, 100);

    expect(runScaffoldApprovalMock).toHaveBeenCalledWith(session);
    expect(deletePlanningSessionMock).toHaveBeenCalledWith(100);
    const sent = vi.mocked(sender.send).mock.calls.some(([, m]) => typeof m === 'string' && m.includes('Created docs/projects/'));
    expect(sent).toBe(true);
  });

  it('mark-source-error: still deletes the session but warns about the unmarked bullet', async () => {
    approveActivePlanningSessionMock.mockReturnValue({ ok: true, session: approvedSession() });
    runScaffoldApprovalMock.mockResolvedValue(okOutcome({ promotion: 'mark-source-error' }));

    const sender = makeSender();
    await handleApprove(sender, 100);

    expect(deletePlanningSessionMock).toHaveBeenCalledWith(100);
    const warned = vi.mocked(sender.send).mock.calls.some(([, m]) => typeof m === 'string' && /couldn.t be marked|retry/i.test(m));
    expect(warned).toBe(true);
  });

  it('failure: surfaces the error and does NOT delete the session', async () => {
    approveActivePlanningSessionMock.mockReturnValue({ ok: true, session: approvedSession() });
    runScaffoldApprovalMock.mockResolvedValue({ ok: false, reason: 'agent', message: 'agent failed' });

    const sender = makeSender();
    await handleApprove(sender, 100);

    expect(deletePlanningSessionMock).not.toHaveBeenCalled();
    const errored = vi.mocked(sender.send).mock.calls.some(([, m]) => typeof m === 'string' && /scaffolding failed|agent failed/i.test(m));
    expect(errored).toBe(true);
  });

  it('verify failure echoes the agent reply text', async () => {
    approveActivePlanningSessionMock.mockReturnValue({ ok: true, session: approvedSession() });
    runScaffoldApprovalMock.mockResolvedValue({
      ok: false, reason: 'verify', message: 'scaffold verification failed: no-new-project-dir',
      agentText: 'I have a few clarifying questions before I start...',
    });

    const sender = makeSender();
    await handleApprove(sender, 100);

    expect(deletePlanningSessionMock).not.toHaveBeenCalled();
    const reply = vi.mocked(sender.send).mock.calls.find(([, m]) => typeof m === 'string' && /scaffolding failed/i.test(m))?.[1] as string | undefined;
    expect(reply).toBeDefined();
    expect(reply).toContain('I have a few clarifying questions');
  });
});

describe('handleApprove — retry path (session already approved)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getPlanningSessionMock.mockReturnValue(null);
  });

  it('picks up an already-approved session via getPlanningSession and re-scaffolds without re-approving', async () => {
    const session = approvedSession();
    getPlanningSessionMock.mockReturnValue(session);
    runScaffoldApprovalMock.mockResolvedValue(okOutcome({ slug: '10-retry' }));

    const sender = makeSender();
    await handleApprove(sender, 100);

    expect(approveActivePlanningSessionMock).not.toHaveBeenCalled();
    expect(runScaffoldApprovalMock).toHaveBeenCalledWith(session);
    expect(deletePlanningSessionMock).toHaveBeenCalledWith(100);
  });

  it('retry path: helper failure again leaves the approved session in place', async () => {
    getPlanningSessionMock.mockReturnValue(approvedSession());
    runScaffoldApprovalMock.mockResolvedValue({ ok: false, reason: 'agent', message: 'still broken' });

    const sender = makeSender();
    await handleApprove(sender, 100);

    expect(deletePlanningSessionMock).not.toHaveBeenCalled();
    expect(approveActivePlanningSessionMock).not.toHaveBeenCalled();
  });
});

describe('handleApprove — error sanitization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getPlanningSessionMock.mockReturnValue(null);
  });

  it('strips absolute vault and project paths from the failure reply', async () => {
    approveActivePlanningSessionMock.mockReturnValue({ ok: true, session: approvedSession() });
    runScaffoldApprovalMock.mockResolvedValue({
      ok: false, reason: 'agent',
      message: 'Error reading /test/vault/foo.md and /test/project/bar.md',
    });

    const sender = makeSender();
    await handleApprove(sender, 100);

    const reply = vi.mocked(sender.send).mock.calls.find(([, m]) => typeof m === 'string' && /scaffolding failed/i.test(m))?.[1] as string | undefined;
    expect(reply).toBeDefined();
    expect(reply).not.toContain('/test/vault');
    expect(reply).not.toContain('/test/project');
    expect(reply).toContain('<vault>');
    expect(reply).toContain('<project>');
  });
});
