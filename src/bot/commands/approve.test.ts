import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MessageSender } from '../../transport/sender.js';

vi.mock('../../config.js', () => ({
  default: { VAULT_DIR: '/test/vault', TIMEZONE: 'America/Chicago', TELEGRAM_USER_ID: 12345 },
  PROJECT_ROOT: '/tmp/test-project',
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

vi.mock('../../intent/planner.js', () => ({
  buildSetupWriterBrief: vi.fn(() => '# Project Brief: Test\n...'),
}));

vi.mock('../../ai/claude.js', () => ({
  runAgent: vi.fn(),
}));

const { approveActivePlanningSession, deletePlanningSession, getPlanningSession } = await import('../../reviews/planning.js');
const { buildSetupWriterBrief } = await import('../../intent/planner.js');
const { runAgent } = await import('../../ai/claude.js');
const { handleApprove } = await import('./approve.js');

const approveActivePlanningSessionMock = approveActivePlanningSession as unknown as ReturnType<typeof vi.fn>;
const deletePlanningSessionMock = deletePlanningSession as unknown as ReturnType<typeof vi.fn>;
const getPlanningSessionMock = getPlanningSession as unknown as ReturnType<typeof vi.fn>;
const buildSetupWriterBriefMock = buildSetupWriterBrief as unknown as ReturnType<typeof vi.fn>;
const runAgentMock = runAgent as unknown as ReturnType<typeof vi.fn>;

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
    product: 'jarvis',
    idea: 'build something cool',
    surface: 'chat' as const,
    history: [],
    createdAt: new Date().toISOString(),
    artifact: {
      product: 'jarvis',
      title: 'Test Project',
      spec: 'A spec.',
      tasks: 'Some tasks.',
      testPlan: 'A test plan.',
    },
  },
  createdAt: new Date().toISOString(),
  lastActivity: new Date().toISOString(),
};

describe('handleApprove', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    buildSetupWriterBriefMock.mockReturnValue('# Project Brief: Test\n...');
    // clearAllMocks resets call state but preserves mockReturnValue, so
    // re-prime the retry-path probe to "no approved session" by default.
    getPlanningSessionMock.mockReturnValue(null);
  });

  it('sends "Nothing to approve." when approveActivePlanningSession returns no-session', async () => {
    approveActivePlanningSessionMock.mockReturnValue({ ok: false, reason: 'no-session' });
    const sender = makeSender();

    await handleApprove(sender, 100);

    const reply = vi.mocked(sender.send).mock.calls[0]![1] as string;
    expect(reply).toMatch(/nothing|no active/i);
    expect(runAgentMock).not.toHaveBeenCalled();
    expect(deletePlanningSessionMock).not.toHaveBeenCalled();
  });

  it('sends a scoping-state reply when approveActivePlanningSession returns wrong-status scoping', async () => {
    approveActivePlanningSessionMock.mockReturnValue({
      ok: false,
      reason: 'wrong-status',
      status: 'scoping',
    });
    const sender = makeSender();

    await handleApprove(sender, 100);

    const reply = vi.mocked(sender.send).mock.calls[0]![1] as string;
    expect(reply).toMatch(/scoping|spec proposed/i);
    expect(runAgentMock).not.toHaveBeenCalled();
    expect(deletePlanningSessionMock).not.toHaveBeenCalled();
  });

  it('does not mutate state on wrong-status — approveActivePlanningSession is the only write', async () => {
    // approveActivePlanningSession is the gating call — when it returns wrong-status,
    // nothing else in the approve path should run.
    approveActivePlanningSessionMock.mockReturnValue({
      ok: false,
      reason: 'wrong-status',
      status: 'scoping',
    });
    const sender = makeSender();

    await handleApprove(sender, 100);

    // Only approveActivePlanningSession was called (mocked as the gating call)
    expect(approveActivePlanningSessionMock).toHaveBeenCalledWith(100);
    // Nothing downstream executed
    expect(buildSetupWriterBriefMock).not.toHaveBeenCalled();
    expect(runAgentMock).not.toHaveBeenCalled();
    expect(deletePlanningSessionMock).not.toHaveBeenCalled();
  });

  it('happy path: calls runAgent and deletePlanningSession on agent success', async () => {
    const approvedSession = {
      ...BASE_SESSION,
      planning: { ...BASE_SESSION.planning, status: 'approved' as const },
    };
    approveActivePlanningSessionMock.mockReturnValue({ ok: true, session: approvedSession });
    runAgentMock.mockResolvedValue({
      text: 'Created docs/projects/09-test-project/spec.md',
      error: null,
    });

    const sender = makeSender();
    await handleApprove(sender, 100);

    // buildSetupWriterBrief must have been called with the approved session's planning state
    expect(buildSetupWriterBriefMock).toHaveBeenCalledWith(approvedSession.planning);
    // runAgent must have been called with the project-setup-writer agent
    expect(runAgentMock).toHaveBeenCalledWith(
      'project-setup-writer',
      '# Project Brief: Test\n...',
    );
    // Success path deletes the session
    expect(deletePlanningSessionMock).toHaveBeenCalledWith(100);
    // Agent output is surfaced to the user
    const sendCalls = vi.mocked(sender.send).mock.calls;
    const outputSent = sendCalls.some(
      ([, msg]) => typeof msg === 'string' && msg.includes('Created docs/projects/'),
    );
    expect(outputSent).toBe(true);
  });

  it('happy path: passes the brief from buildSetupWriterBrief to runAgent verbatim', async () => {
    const approvedSession = {
      ...BASE_SESSION,
      planning: { ...BASE_SESSION.planning, status: 'approved' as const },
    };
    approveActivePlanningSessionMock.mockReturnValue({ ok: true, session: approvedSession });
    buildSetupWriterBriefMock.mockReturnValue('# Project Brief: Special\nUnique brief content.');
    runAgentMock.mockResolvedValue({ text: 'Done.', error: null });

    const sender = makeSender();
    await handleApprove(sender, 100);

    expect(runAgentMock).toHaveBeenCalledWith(
      'project-setup-writer',
      '# Project Brief: Special\nUnique brief content.',
    );
  });

  it('agent failure: surfaces the error and does NOT call deletePlanningSession', async () => {
    const approvedSession = {
      ...BASE_SESSION,
      planning: { ...BASE_SESSION.planning, status: 'approved' as const },
    };
    approveActivePlanningSessionMock.mockReturnValue({ ok: true, session: approvedSession });
    runAgentMock.mockResolvedValue({ text: null, error: 'agent failed' });

    const sender = makeSender();
    await handleApprove(sender, 100);

    // The error must be surfaced (some message sent to user)
    expect(sender.send).toHaveBeenCalled();
    const sendCalls = vi.mocked(sender.send).mock.calls;
    const errorSurfaced = sendCalls.some(
      ([, msg]) => typeof msg === 'string' && /agent failed|error|fail/i.test(msg),
    );
    expect(errorSurfaced).toBe(true);
    // Session stays in approved state — not deleted
    expect(deletePlanningSessionMock).not.toHaveBeenCalled();
  });

  it('agent failure: session remains in approved state for retry', async () => {
    const approvedSession = {
      ...BASE_SESSION,
      planning: { ...BASE_SESSION.planning, status: 'approved' as const },
    };
    approveActivePlanningSessionMock.mockReturnValue({ ok: true, session: approvedSession });
    runAgentMock.mockResolvedValue({ text: null, error: 'spawn error' });

    const sender = makeSender();
    await handleApprove(sender, 100);

    // deletePlanningSession must NOT have been called — the session stays for retry
    expect(deletePlanningSessionMock).not.toHaveBeenCalled();
    // approveActivePlanningSession was called (it already transitioned to approved)
    expect(approveActivePlanningSessionMock).toHaveBeenCalledWith(100);
  });

  it('passes the correct userId to approveActivePlanningSession', async () => {
    approveActivePlanningSessionMock.mockReturnValue({ ok: false, reason: 'no-session' });
    const sender = makeSender();

    await handleApprove(sender, 99999);

    expect(approveActivePlanningSessionMock).toHaveBeenCalledWith(99999);
  });

  describe('retry path (session already approved from a prior failed /approve)', () => {
    it('picks up an already-approved session via getPlanningSession and re-scaffolds', async () => {
      // A previous /approve transitioned spec-proposed → approved but the
      // agent failed; the session stayed in 'approved' state. A second
      // /approve must find the session and re-run scaffolding — not return
      // "Nothing to approve".
      const approvedSession = {
        ...BASE_SESSION,
        planning: { ...BASE_SESSION.planning, status: 'approved' as const },
      };
      getPlanningSessionMock.mockReturnValue(approvedSession);
      runAgentMock.mockResolvedValue({
        text: 'Created docs/projects/10-retry/spec.md',
        error: null,
      });

      const sender = makeSender();
      await handleApprove(sender, 100);

      // Retry path scaffolds without calling approveActivePlanningSession
      // (the lifecycle is already past spec-proposed).
      expect(approveActivePlanningSessionMock).not.toHaveBeenCalled();
      expect(buildSetupWriterBriefMock).toHaveBeenCalledWith(approvedSession.planning);
      expect(runAgentMock).toHaveBeenCalledWith(
        'project-setup-writer',
        '# Project Brief: Test\n...',
      );
      expect(deletePlanningSessionMock).toHaveBeenCalledWith(100);
    });

    it('retry path: agent failure again leaves the approved session in place', async () => {
      const approvedSession = {
        ...BASE_SESSION,
        planning: { ...BASE_SESSION.planning, status: 'approved' as const },
      };
      getPlanningSessionMock.mockReturnValue(approvedSession);
      runAgentMock.mockResolvedValue({ text: null, error: 'still broken' });

      const sender = makeSender();
      await handleApprove(sender, 100);

      // Session must remain in approved state — not deleted — so the user
      // can retry again.
      expect(deletePlanningSessionMock).not.toHaveBeenCalled();
      // approveActivePlanningSession must NOT have been called on the retry
      // path (the lifecycle is already past spec-proposed).
      expect(approveActivePlanningSessionMock).not.toHaveBeenCalled();
    });

    it('retry path takes priority over normal path — does not double-transition', async () => {
      // Even if approveActivePlanningSession would also succeed, the retry
      // path runs first when the session is already approved.
      const approvedSession = {
        ...BASE_SESSION,
        planning: { ...BASE_SESSION.planning, status: 'approved' as const },
      };
      getPlanningSessionMock.mockReturnValue(approvedSession);
      runAgentMock.mockResolvedValue({ text: 'Created docs/projects/...', error: null });

      const sender = makeSender();
      await handleApprove(sender, 100);

      expect(approveActivePlanningSessionMock).not.toHaveBeenCalled();
    });
  });

  describe('error sanitization', () => {
    it('strips absolute vault and project paths from agent error replies', async () => {
      // The full path is preserved in the log, but the user-facing reply
      // should not expose filesystem layout.
      const approvedSession = {
        ...BASE_SESSION,
        planning: { ...BASE_SESSION.planning, status: 'approved' as const },
      };
      approveActivePlanningSessionMock.mockReturnValue({ ok: true, session: approvedSession });
      runAgentMock.mockResolvedValue({
        text: null,
        error: 'Error reading /test/vault/foo.md and /tmp/test-project/bar.md',
      });

      const sender = makeSender();
      await handleApprove(sender, 100);

      const sendCalls = vi.mocked(sender.send).mock.calls;
      const reply = sendCalls.find(([, msg]) =>
        typeof msg === 'string' && /scaffolding failed/i.test(msg),
      )?.[1] as string | undefined;
      expect(reply).toBeDefined();
      // Vault and project root paths must be replaced with placeholders
      expect(reply).not.toContain('/test/vault');
      expect(reply).not.toContain('/tmp/test-project');
      expect(reply).toContain('<vault>');
      expect(reply).toContain('<project>');
    });
  });
});
