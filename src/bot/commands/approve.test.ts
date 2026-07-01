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
  updatePlanningSession: vi.fn(),
  approveActivePlanningSession: vi.fn(),
  deletePlanningSession: vi.fn(),
}));

vi.mock('../../intent/planning-roles.js', () => ({
  runDownstreamPlan: vi.fn(),
}));

vi.mock('../../jobs/scaffold-approval.js', () => ({
  runScaffoldApproval: vi.fn(),
}));

vi.mock('../../transport/in-flight.js', () => ({
  registerOp: vi.fn(),
  unregisterOp: vi.fn(),
  isCancelled: vi.fn(() => false),
}));

const { approveActivePlanningSession, deletePlanningSession, getPlanningSession, updatePlanningSession } = await import('../../reviews/planning.js');
const { runDownstreamPlan } = await import('../../intent/planning-roles.js');
const { runScaffoldApproval } = await import('../../jobs/scaffold-approval.js');
const { registerOp, unregisterOp, isCancelled } = await import('../../transport/in-flight.js');
const { handleApprove } = await import('./approve.js');

const approveActivePlanningSessionMock = approveActivePlanningSession as unknown as ReturnType<typeof vi.fn>;
const deletePlanningSessionMock = deletePlanningSession as unknown as ReturnType<typeof vi.fn>;
const getPlanningSessionMock = getPlanningSession as unknown as ReturnType<typeof vi.fn>;
const updatePlanningSessionMock = updatePlanningSession as unknown as ReturnType<typeof vi.fn>;
const runDownstreamPlanMock = runDownstreamPlan as unknown as ReturnType<typeof vi.fn>;
const runScaffoldApprovalMock = runScaffoldApproval as unknown as ReturnType<typeof vi.fn>;
const registerOpMock = registerOp as unknown as ReturnType<typeof vi.fn>;
const unregisterOpMock = unregisterOp as unknown as ReturnType<typeof vi.fn>;
const isCancelledMock = isCancelled as unknown as ReturnType<typeof vi.fn>;

const POST_APPROVAL_OP = {
  opId: 'op-post-approval-plan',
  kind: 'agent' as const,
  label: 'planning approval',
  userId: 100,
  startedAt: 1,
  startedAtIso: '2026-07-01T12:00:00.000Z',
  child: { kill: vi.fn() },
  cancelled: false,
};

beforeEach(() => {
  registerOpMock.mockReturnValue(POST_APPROVAL_OP);
  isCancelledMock.mockReturnValue(false);
});

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

const PM_SPEC_ARTIFACT = {
  version: 2,
  kind: 'pm-spec',
  product: 'rune',
  title: 'Test Project',
  spec: 'A spec.',
  assumptions: ['existing users keep access'],
  selfReview: { revised: false, summary: 'Spec is internally consistent.' },
};

const DOWNSTREAM_ARTIFACT = {
  product: 'rune',
  title: 'Test Project',
  spec: 'A spec.',
  techSpec: 'tech spec',
  tasks: 'tasks',
  testPlan: 'tp',
  context: 'context',
};

function approvedSession(over: Record<string, unknown> = {}) {
  return {
    ...BASE_SESSION,
    planning: { ...BASE_SESSION.planning, status: 'approved' as const },
    ...over,
  };
}

function approvedPmSpecReadySession(over: Record<string, unknown> = {}) {
  return approvedSession({
    planning: {
      status: 'approved' as const,
      product: 'rune',
      idea: 'build something cool',
      surface: 'chat' as const,
      approvedSpec: PM_SPEC_ARTIFACT,
      downstreamArtifact: DOWNSTREAM_ARTIFACT,
    },
    ...over,
  });
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

  it('sends a restart-planning reply on a legacy proposed artifact and never scaffolds', async () => {
    approveActivePlanningSessionMock.mockReturnValue({ ok: false, reason: 'legacy-artifact' });
    const sender = makeSender();
    await handleApprove(sender, 100);
    expect((vi.mocked(sender.send).mock.calls[0]![1] as string)).toMatch(/restart planning|pm-spec/i);
    expect(runDownstreamPlanMock).not.toHaveBeenCalled();
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
    runDownstreamPlanMock.mockResolvedValue(DOWNSTREAM_ARTIFACT);
  });

  it('success: passes the approved session to the helper, surfaces output, deletes the session', async () => {
    const session = approvedPmSpecReadySession();
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
    approveActivePlanningSessionMock.mockReturnValue({ ok: true, session: approvedPmSpecReadySession() });
    runScaffoldApprovalMock.mockResolvedValue(okOutcome({ promotion: 'mark-source-error' }));

    const sender = makeSender();
    await handleApprove(sender, 100);

    expect(deletePlanningSessionMock).toHaveBeenCalledWith(100);
    const warned = vi.mocked(sender.send).mock.calls.some(([, m]) => typeof m === 'string' && /couldn.t be marked|retry/i.test(m));
    expect(warned).toBe(true);
  });

  it('failure: surfaces the error and does NOT delete the session', async () => {
    approveActivePlanningSessionMock.mockReturnValue({ ok: true, session: approvedPmSpecReadySession() });
    runScaffoldApprovalMock.mockResolvedValue({ ok: false, reason: 'agent', message: 'agent failed' });

    const sender = makeSender();
    await handleApprove(sender, 100);

    expect(deletePlanningSessionMock).not.toHaveBeenCalled();
    const errored = vi.mocked(sender.send).mock.calls.some(([, m]) => typeof m === 'string' && /scaffolding failed|agent failed/i.test(m));
    expect(errored).toBe(true);
  });

  it('verify failure echoes the agent reply text', async () => {
    approveActivePlanningSessionMock.mockReturnValue({ ok: true, session: approvedPmSpecReadySession() });
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

describe('handleApprove — PM-spec approval persistence (project 20 test-plan §1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getPlanningSessionMock.mockReturnValue(null);
    runDownstreamPlanMock.mockResolvedValue(DOWNSTREAM_ARTIFACT);
    runScaffoldApprovalMock.mockResolvedValue(okOutcome());
  });

  it('runs downstream planning from the approved PM spec, persists the full artifact, then scaffolds', async () => {
    const session = approvedSession({
      planning: {
        status: 'approved' as const,
        product: 'rune',
        idea: 'build something cool',
        surface: 'chat' as const,
        approvedSpec: PM_SPEC_ARTIFACT,
      },
    });
    approveActivePlanningSessionMock.mockReturnValue({ ok: true, session });

    const sender = makeSender();
    await handleApprove(sender, 100);

    expect(runDownstreamPlanMock).toHaveBeenCalledWith(PM_SPEC_ARTIFACT, expect.any(Object));
    expect(updatePlanningSessionMock).toHaveBeenCalledWith(100, expect.any(Function));
    expect(updatePlanningSessionMock.mock.invocationCallOrder[0]!).toBeLessThan(
      runScaffoldApprovalMock.mock.invocationCallOrder[0]!,
    );
    const scaffoldedSession = runScaffoldApprovalMock.mock.calls[0]![0] as any;
    expect(scaffoldedSession.planning.approvedSpec).toEqual(PM_SPEC_ARTIFACT);
    expect(scaffoldedSession.planning.downstreamArtifact).toEqual(DOWNSTREAM_ARTIFACT);
    expect(deletePlanningSessionMock).toHaveBeenCalledWith(100);
  });

  it('streams downstream progress, critique warnings, scaffold stage, and scaffold success through the sender', async () => {
    const session = approvedSession({
      planning: {
        status: 'approved' as const,
        product: 'rune',
        idea: 'build something cool',
        surface: 'chat' as const,
        approvedSpec: PM_SPEC_ARTIFACT,
      },
    });
    approveActivePlanningSessionMock.mockReturnValue({ ok: true, session });
    runDownstreamPlanMock.mockImplementation(async (_approvedSpec: unknown, options: any) => {
      if (typeof options.progress === 'function') {
        await options.progress({ stage: 'tech-lead-breakdown' });
        await options.progress({ stage: 'pm-review-match' });
        await options.progress({ stage: 'claude-critique' });
        await options.progress({ stage: 'codex-critique' });
        await options.progress({
          warning: 'Codex critique skipped after reading /test/project/private-plan.md; continuing with the last coherent plan.',
        });
        await options.progress({ stage: 'context-seed' });
      }
      return DOWNSTREAM_ARTIFACT;
    });
    runScaffoldApprovalMock.mockResolvedValue(okOutcome({ slug: '09-test' }));

    const sender = makeSender();
    await handleApprove(sender, 100);

    expect(runDownstreamPlanMock).toHaveBeenCalledWith(
      PM_SPEC_ARTIFACT,
      expect.objectContaining({ progress: expect.any(Function) }),
    );
    const messages = vi.mocked(sender.send).mock.calls.map(([, message]) => String(message));
    expect(messages.filter((message) => /^Planning progress: tech[- ]lead breakdown\.$/i.test(message))).toHaveLength(1);
    expect(messages.filter((message) => /^Planning progress: PM review\.$/i.test(message))).toHaveLength(1);
    expect(messages.filter((message) => /^Planning progress: Claude critique\.$/i.test(message))).toHaveLength(1);
    expect(messages.filter((message) => /^Planning progress: Codex critique\.$/i.test(message))).toHaveLength(1);
    const warning = messages.find((message) => /codex.*skipped/i.test(message));
    expect(warning).toBeDefined();
    expect(warning).toMatch(/^Planning warning:/);
    expect(warning).not.toContain('/test/project');
    expect(warning).toContain('<project>');
    expect(messages.filter((message) => /^Planning progress: context seed\.$/i.test(message))).toHaveLength(1);
    expect(messages.filter((message) => /^Planning progress: scaffold\.$/i.test(message))).toHaveLength(1);
    const success = messages.find((message) => /^Planning succeeded:/i.test(message));
    expect(success).toBeDefined();
    expect(success).toMatch(/09-test/);
    expect(success).toMatch(/Created docs\/projects\/09-test\/spec\.md/i);
    expect(vi.mocked(sender.send).mock.calls.every((call) => call[2]?.approval === undefined)).toBe(true);
  });

  it('surfaces a scrubbed terminal line and leaves the session resumable when downstream planning fails', async () => {
    const session = approvedSession({
      planning: {
        status: 'approved' as const,
        product: 'rune',
        idea: 'build something cool',
        surface: 'chat' as const,
        approvedSpec: PM_SPEC_ARTIFACT,
      },
    });
    approveActivePlanningSessionMock.mockReturnValue({ ok: true, session });
    runDownstreamPlanMock.mockRejectedValue(
      new Error('PM review mismatch after reading /test/project/private-plan.md'),
    );

    const sender = makeSender();
    await expect(handleApprove(sender, 100)).resolves.toBeUndefined();

    expect(runScaffoldApprovalMock).not.toHaveBeenCalled();
    expect(updatePlanningSessionMock).not.toHaveBeenCalled();
    expect(deletePlanningSessionMock).not.toHaveBeenCalled();
    const messages = vi.mocked(sender.send).mock.calls.map(([, message]) => String(message));
    const terminal = messages.find((message) => /Planning stopped:.*PM review mismatch/i.test(message));
    expect(terminal).toBeDefined();
    expect(terminal).not.toContain('/test/project');
    expect(terminal).toContain('<project>');
    expect(messages.some((message) => /run \/approve again/i.test(message))).toBe(true);
  });

  it('surfaces a scrubbed context-seed terminal line when downstream planning fails during context seed', async () => {
    const session = approvedSession({
      planning: {
        status: 'approved' as const,
        product: 'rune',
        idea: 'build something cool',
        surface: 'chat' as const,
        approvedSpec: PM_SPEC_ARTIFACT,
      },
    });
    approveActivePlanningSessionMock.mockReturnValue({ ok: true, session });
    runDownstreamPlanMock.mockImplementation(async (_approvedSpec: unknown, options: any) => {
      await options.progress({ stage: 'tech-lead-breakdown' });
      await options.progress({ stage: 'pm-review-match' });
      await options.progress({ stage: 'claude-critique' });
      await options.progress({ stage: 'codex-critique' });
      await options.progress({ stage: 'context-seed' });
      throw new Error('context seed failed while reading /test/project/docs/projects/20/context.md');
    });

    const sender = makeSender();
    await expect(handleApprove(sender, 100)).resolves.toBeUndefined();

    expect(runScaffoldApprovalMock).not.toHaveBeenCalled();
    expect(updatePlanningSessionMock).not.toHaveBeenCalled();
    expect(deletePlanningSessionMock).not.toHaveBeenCalled();
    const messages = vi.mocked(sender.send).mock.calls.map(([, message]) => String(message));
    expect(messages.filter((message) => /^Planning progress: context seed\.$/i.test(message))).toHaveLength(1);
    const terminal = messages.find((message) => /Planning stopped:.*context seed/i.test(message));
    expect(terminal).toBeDefined();
    expect(terminal).not.toContain('/test/project');
    expect(terminal).toContain('<project>');
    expect(messages.some((message) => /run \/approve again/i.test(message))).toBe(true);
  });

  it('keeps the approved session resumable with downstreamArtifact when scaffold fails after downstream planning', async () => {
    const session = approvedSession({
      planning: {
        status: 'approved' as const,
        product: 'rune',
        idea: 'build something cool',
        surface: 'chat' as const,
        approvedSpec: PM_SPEC_ARTIFACT,
      },
    });
    approveActivePlanningSessionMock.mockReturnValue({ ok: true, session });
    runScaffoldApprovalMock.mockResolvedValue({
      ok: false,
      reason: 'agent',
      message: 'scaffold failed after downstream planning',
    });

    const sender = makeSender();
    await handleApprove(sender, 100);

    expect(runDownstreamPlanMock).toHaveBeenCalledOnce();
    expect(updatePlanningSessionMock).toHaveBeenCalledWith(100, expect.any(Function));
    expect(runScaffoldApprovalMock).toHaveBeenCalledOnce();
    expect(deletePlanningSessionMock).not.toHaveBeenCalled();
    const messages = vi.mocked(sender.send).mock.calls.map(([, message]) => String(message));
    expect(messages.some((message) => /Planning stopped:.*scaffold/i.test(message))).toBe(true);
    const reply = vi.mocked(sender.send).mock.calls.find(([, m]) => typeof m === 'string' && /retry/i.test(m))?.[1];
    expect(reply).toMatch(/run \/approve again/i);
  });

  it('retries an approved-but-unscaffolded session with persisted downstreamArtifact without re-running downstream planning', async () => {
    const session = approvedSession({
      planning: {
        status: 'approved' as const,
        product: 'rune',
        idea: 'build something cool',
        surface: 'chat' as const,
        approvedSpec: PM_SPEC_ARTIFACT,
        downstreamArtifact: DOWNSTREAM_ARTIFACT,
      },
    });
    getPlanningSessionMock.mockReturnValue(session);

    await handleApprove(makeSender(), 100);

    expect(approveActivePlanningSessionMock).not.toHaveBeenCalled();
    expect(runDownstreamPlanMock).not.toHaveBeenCalled();
    expect(updatePlanningSessionMock).not.toHaveBeenCalled();
    expect(runScaffoldApprovalMock).toHaveBeenCalledWith(session);
  });

  it('hard-fails legacy approved sessions that lack the versioned pm-spec discriminant', async () => {
    approveActivePlanningSessionMock.mockReturnValue({
      ok: true,
      session: approvedSession(),
    });

    const sender = makeSender();
    await handleApprove(sender, 100);

    expect(runDownstreamPlanMock).not.toHaveBeenCalled();
    expect(runScaffoldApprovalMock).not.toHaveBeenCalled();
    expect(deletePlanningSessionMock).not.toHaveBeenCalled();
    const reply = vi.mocked(sender.send).mock.calls.find(([, m]) => typeof m === 'string' && /restart planning/i.test(m))?.[1];
    expect(reply).toBeDefined();
  });

  it('hard-fails stored approvals with version 2 but no pm-spec kind discriminant', async () => {
    approveActivePlanningSessionMock.mockReturnValue({
      ok: true,
      session: approvedSession({
        planning: {
          status: 'approved' as const,
          product: 'rune',
          idea: 'old plan',
          surface: 'chat' as const,
          approvedSpec: {
            version: 2,
            product: 'rune',
            title: 'Legacy Version-Only Plan',
            spec: 'This has a version field but no kind discriminant.',
          },
        },
      }),
    });

    const sender = makeSender();
    await handleApprove(sender, 100);

    expect(runDownstreamPlanMock).not.toHaveBeenCalled();
    expect(runScaffoldApprovalMock).not.toHaveBeenCalled();
    expect(deletePlanningSessionMock).not.toHaveBeenCalled();
    const reply = vi.mocked(sender.send).mock.calls.find(([, m]) => typeof m === 'string' && /restart planning/i.test(m))?.[1];
    expect(reply).toBeDefined();
  });
});

describe('handleApprove — post-approval in-flight op (project 20 test-plan §2)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getPlanningSessionMock.mockReturnValue(null);
    registerOpMock.mockReturnValue(POST_APPROVAL_OP);
    isCancelledMock.mockReturnValue(false);
    runDownstreamPlanMock.mockResolvedValue(DOWNSTREAM_ARTIFACT);
    runScaffoldApprovalMock.mockResolvedValue(okOutcome({ slug: '20-inflight-plan' }));
  });

  it('registers one cancellable in-flight op for the planning user around downstream planning and scaffold, then marks success after the scaffold-success line', async () => {
    const session = approvedSession({
      planning: {
        status: 'approved' as const,
        product: 'rune',
        idea: 'build something cool',
        surface: 'chat' as const,
        approvedSpec: PM_SPEC_ARTIFACT,
      },
    });
    approveActivePlanningSessionMock.mockReturnValue({ ok: true, session });
    runScaffoldApprovalMock.mockResolvedValue(okOutcome({
      slug: '20-inflight-plan',
      agentText: 'Created docs/projects/20-inflight-plan/spec.md',
    }));

    const sender = makeSender();
    await handleApprove(sender, 100);

    expect(registerOpMock).toHaveBeenCalledOnce();
    expect(registerOpMock).toHaveBeenCalledWith(expect.objectContaining({
      userId: 100,
      label: expect.stringMatching(/planning|approve|scaffold/i),
      child: expect.objectContaining({ kill: expect.any(Function) }),
    }));
    expect(registerOpMock.mock.invocationCallOrder[0]!).toBeLessThan(
      runDownstreamPlanMock.mock.invocationCallOrder[0]!,
    );
    expect(runDownstreamPlanMock.mock.invocationCallOrder[0]!).toBeLessThan(
      runScaffoldApprovalMock.mock.invocationCallOrder[0]!,
    );

    const sendMock = vi.mocked(sender.send);
    const successIndex = sendMock.mock.calls.findIndex(([, message]) =>
      /^Planning succeeded:.*20-inflight-plan/i.test(String(message)),
    );
    expect(successIndex).toBeGreaterThanOrEqual(0);
    expect(String(sendMock.mock.calls[successIndex]![1])).toMatch(/Created docs\/projects\/20-inflight-plan\/spec\.md/i);
    expect(unregisterOpMock).toHaveBeenCalledWith('op-post-approval-plan', 'success');
    expect(unregisterOpMock.mock.invocationCallOrder[0]!).toBeGreaterThan(
      sendMock.mock.invocationCallOrder[successIndex]!,
    );
    expect(deletePlanningSessionMock).toHaveBeenCalledWith(100);
  });

  it('marks the in-flight op as error on downstream terminal failure and leaves the approved session resumable', async () => {
    const session = approvedSession({
      planning: {
        status: 'approved' as const,
        product: 'rune',
        idea: 'build something cool',
        surface: 'chat' as const,
        approvedSpec: PM_SPEC_ARTIFACT,
      },
    });
    approveActivePlanningSessionMock.mockReturnValue({ ok: true, session });
    runDownstreamPlanMock.mockRejectedValue(
      new Error('PM review mismatch after reading /test/project/private-plan.md'),
    );

    const sender = makeSender();
    await expect(handleApprove(sender, 100)).resolves.toBeUndefined();

    expect(runScaffoldApprovalMock).not.toHaveBeenCalled();
    expect(deletePlanningSessionMock).not.toHaveBeenCalled();
    const terminal = vi.mocked(sender.send).mock.calls.find(([, message]) =>
      /Planning stopped:.*PM review mismatch/i.test(String(message)),
    )?.[1] as string | undefined;
    expect(terminal).toBeDefined();
    expect(terminal).not.toContain('/test/project');
    expect(terminal).toContain('<project>');
    expect(unregisterOpMock).toHaveBeenCalledWith(
      'op-post-approval-plan',
      'error',
      expect.stringMatching(/PM review mismatch.*<project>/i),
    );
  });

  it('marks the in-flight op as error on scaffold terminal failure after downstream planning was persisted', async () => {
    const session = approvedSession({
      planning: {
        status: 'approved' as const,
        product: 'rune',
        idea: 'build something cool',
        surface: 'chat' as const,
        approvedSpec: PM_SPEC_ARTIFACT,
      },
    });
    approveActivePlanningSessionMock.mockReturnValue({ ok: true, session });
    runScaffoldApprovalMock.mockResolvedValue({
      ok: false,
      reason: 'agent',
      message: 'project-setup-writer failed while writing /test/project/docs/projects/20-inflight-plan/spec.md',
    });

    const sender = makeSender();
    await handleApprove(sender, 100);

    expect(updatePlanningSessionMock).toHaveBeenCalledWith(100, expect.any(Function));
    expect(deletePlanningSessionMock).not.toHaveBeenCalled();
    const terminal = vi.mocked(sender.send).mock.calls.find(([, message]) =>
      /Planning stopped:.*scaffold/i.test(String(message)),
    )?.[1] as string | undefined;
    expect(terminal).toBeDefined();
    expect(terminal).not.toContain('/test/project');
    expect(terminal).toContain('<project>');
    expect(unregisterOpMock).toHaveBeenCalledWith(
      'op-post-approval-plan',
      'error',
      expect.stringMatching(/scaffold.*<project>/i),
    );
  });

  it('cooperatively cancels at the next downstream stage boundary, emits a terminal line, and keeps the session resumable', async () => {
    const session = approvedSession({
      planning: {
        status: 'approved' as const,
        product: 'rune',
        idea: 'build something cool',
        surface: 'chat' as const,
        approvedSpec: PM_SPEC_ARTIFACT,
      },
    });
    approveActivePlanningSessionMock.mockReturnValue({ ok: true, session });
    let completedStageBoundaries = 0;
    isCancelledMock.mockImplementation(() => completedStageBoundaries >= 1);
    runDownstreamPlanMock.mockImplementation(async (_approvedSpec: unknown, options: any) => {
      await options.progress({ stage: 'tech-lead-breakdown' });
      completedStageBoundaries += 1;
      await options.progress({ stage: 'pm-review-match' });
      return DOWNSTREAM_ARTIFACT;
    });

    const sender = makeSender();
    await handleApprove(sender, 100);

    expect(runScaffoldApprovalMock).not.toHaveBeenCalled();
    expect(updatePlanningSessionMock).not.toHaveBeenCalled();
    expect(deletePlanningSessionMock).not.toHaveBeenCalled();
    const messages = vi.mocked(sender.send).mock.calls.map(([, message]) => String(message));
    expect(messages.filter((message) => /^Planning progress: tech[- ]lead breakdown\.$/i.test(message))).toHaveLength(1);
    expect(messages.some((message) => /^Planning progress: PM review\.$/i.test(message))).toBe(false);
    expect(messages.some((message) => /Planning stopped:.*cancelled/i.test(message))).toBe(true);
    expect(messages.some((message) => /run \/approve again/i.test(message))).toBe(true);
    expect(unregisterOpMock).toHaveBeenCalledWith('op-post-approval-plan', 'cancelled');
  });
});

describe('handleApprove — retry path (session already approved)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getPlanningSessionMock.mockReturnValue(null);
    runDownstreamPlanMock.mockResolvedValue(DOWNSTREAM_ARTIFACT);
  });

  it('picks up an already-approved session via getPlanningSession and re-scaffolds without re-approving', async () => {
    const session = approvedSession({
      planning: {
        status: 'approved' as const,
        product: 'rune',
        idea: 'build something cool',
        surface: 'chat' as const,
        approvedSpec: PM_SPEC_ARTIFACT,
        downstreamArtifact: DOWNSTREAM_ARTIFACT,
      },
    });
    getPlanningSessionMock.mockReturnValue(session);
    runScaffoldApprovalMock.mockResolvedValue(okOutcome({ slug: '10-retry' }));

    const sender = makeSender();
    await handleApprove(sender, 100);

    expect(approveActivePlanningSessionMock).not.toHaveBeenCalled();
    expect(runDownstreamPlanMock).not.toHaveBeenCalled();
    expect(updatePlanningSessionMock).not.toHaveBeenCalled();
    expect(runScaffoldApprovalMock).toHaveBeenCalledWith(session);
    expect(deletePlanningSessionMock).toHaveBeenCalledWith(100);
  });

  it('retry path: approvedSpec only reruns downstream planning, persists it, then scaffolds', async () => {
    const session = approvedSession({
      planning: {
        status: 'approved' as const,
        product: 'rune',
        idea: 'build something cool',
        surface: 'chat' as const,
        approvedSpec: PM_SPEC_ARTIFACT,
      },
    });
    getPlanningSessionMock.mockReturnValue(session);
    runScaffoldApprovalMock.mockResolvedValue(okOutcome({ slug: '11-retry-after-downstream' }));

    await handleApprove(makeSender(), 100);

    expect(approveActivePlanningSessionMock).not.toHaveBeenCalled();
    expect(runDownstreamPlanMock).toHaveBeenCalledOnce();
    expect(runDownstreamPlanMock).toHaveBeenCalledWith(PM_SPEC_ARTIFACT, expect.any(Object));
    expect(updatePlanningSessionMock).toHaveBeenCalledWith(100, expect.any(Function));
    expect(updatePlanningSessionMock.mock.invocationCallOrder[0]!).toBeLessThan(
      runScaffoldApprovalMock.mock.invocationCallOrder[0]!,
    );
    const scaffoldedSession = runScaffoldApprovalMock.mock.calls[0]![0] as any;
    expect(scaffoldedSession.planning.approvedSpec).toEqual(PM_SPEC_ARTIFACT);
    expect(scaffoldedSession.planning.downstreamArtifact).toEqual(DOWNSTREAM_ARTIFACT);
    expect(deletePlanningSessionMock).toHaveBeenCalledWith(100);
  });

  it('hard-fails legacy approved retry sessions that have no versioned pm-spec approval artifact', async () => {
    const legacySession = approvedSession({
      planning: {
        status: 'approved' as const,
        product: 'rune',
        idea: 'old plan',
        surface: 'chat' as const,
        artifact: {
          product: 'rune',
          title: 'Legacy Full Plan',
          spec: 'Old approved spec.',
          techSpec: 'Old tech spec.',
          tasks: 'Old tasks.',
          testPlan: 'Old tests.',
        },
      },
    });
    getPlanningSessionMock.mockReturnValue(legacySession);

    const sender = makeSender();
    await handleApprove(sender, 100);

    expect(approveActivePlanningSessionMock).not.toHaveBeenCalled();
    expect(runDownstreamPlanMock).not.toHaveBeenCalled();
    expect(runScaffoldApprovalMock).not.toHaveBeenCalled();
    expect(deletePlanningSessionMock).not.toHaveBeenCalled();
    const reply = vi.mocked(sender.send).mock.calls.find(([, m]) => typeof m === 'string' && /restart planning/i.test(m))?.[1];
    expect(reply).toBeDefined();
  });

  it('retry path: helper failure again leaves the approved session in place', async () => {
    getPlanningSessionMock.mockReturnValue(approvedSession({
      planning: {
        status: 'approved' as const,
        product: 'rune',
        idea: 'build something cool',
        surface: 'chat' as const,
        approvedSpec: PM_SPEC_ARTIFACT,
        downstreamArtifact: DOWNSTREAM_ARTIFACT,
      },
    }));
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
    approveActivePlanningSessionMock.mockReturnValue({ ok: true, session: approvedPmSpecReadySession() });
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
