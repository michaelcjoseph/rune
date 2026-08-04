import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';

// Mock config before any module import that reads it
vi.mock('../config.js', () => ({
  PROJECT_ROOT: '/Users/tester/workspace/rune',
  default: {
    TG_MAX_MESSAGE_LENGTH: 4096,
    TELEGRAM_BOT_TOKEN: 'test-token',
    TELEGRAM_USER_ID: 123,
  },
}));

// Mock the telegram client so we can inspect calls without real I/O
const mockSendLongMessage = vi.fn().mockResolvedValue(undefined);
const mockStartTyping = vi.fn().mockReturnValue(42 as unknown as ReturnType<typeof setInterval>);
const mockStopTyping = vi.fn();

vi.mock('../integrations/telegram/client.js', () => ({
  sendLongMessage: mockSendLongMessage,
  startTyping: mockStartTyping,
  stopTyping: mockStopTyping,
}));

// Mock the logger so the delivery-record assertions read the exact payload
// TelegramSender emits (and so the suite doesn't spray records on stdout).
const mockLogInfo = vi.fn();
const mockLogWarn = vi.fn();
const mockLogError = vi.fn();

vi.mock('../utils/logger.js', () => ({
  createLogger: () => ({
    info: mockLogInfo,
    warn: mockLogWarn,
    error: mockLogError,
    debug: vi.fn(),
  }),
}));

const { TelegramSender } = await import('./telegram-sender.js');

/** The `data` payloads of every `telegram send delivered` info record. */
function deliveryRecords(): Record<string, unknown>[] {
  return mockLogInfo.mock.calls
    .filter((call) => call[0] === 'telegram send delivered')
    .map((call) => call[1] as Record<string, unknown>);
}

const gateReceiptIdentity = {
  version: 1,
  treeOid: 'a'.repeat(40),
  fullTaskReviewHash: 'b'.repeat(64),
  completedAt: '2026-07-30T12:00:00.000Z',
  commandFingerprint: 'c'.repeat(64),
  configurationFingerprint: 'd'.repeat(64),
  dependencyFingerprint: 'e'.repeat(64),
};

function mockBot() {
  return {
    sendMessage: vi.fn().mockResolvedValue({}),
    sendChatAction: vi.fn().mockResolvedValue(true),
  } as any;
}

describe('TelegramSender', () => {
  let bot: ReturnType<typeof mockBot>;
  let sender: InstanceType<typeof TelegramSender>;

  beforeEach(() => {
    bot = mockBot();
    sender = new TelegramSender(bot);
    vi.clearAllMocks();
    // Re-apply default implementation after clearAllMocks
    mockSendLongMessage.mockResolvedValue(undefined);
    mockStartTyping.mockReturnValue(42 as unknown as ReturnType<typeof setInterval>);
  });

  describe('send() delegates to sendLongMessage', () => {
    it('calls sendLongMessage with the bot, userId, and text', async () => {
      await sender.send(100, 'hello world');
      expect(mockSendLongMessage).toHaveBeenCalledOnce();
      expect(mockSendLongMessage).toHaveBeenCalledWith(bot, 100, 'hello world');
    });

    it('passes through for short messages (under 4096 chars)', async () => {
      const text = 'a'.repeat(100);
      await sender.send(100, text);
      expect(mockSendLongMessage).toHaveBeenCalledWith(bot, 100, text);
    });

    it('passes through for a message exactly 4096 chars', async () => {
      const text = 'b'.repeat(4096);
      await sender.send(100, text);
      expect(mockSendLongMessage).toHaveBeenCalledWith(bot, 100, text);
    });

    it('passes through for a message longer than 4096 chars (chunking handled by sendLongMessage)', async () => {
      const text = 'c'.repeat(5000);
      await sender.send(100, text);
      expect(mockSendLongMessage).toHaveBeenCalledWith(bot, 100, text);
    });

    it('awaits the promise returned by sendLongMessage', async () => {
      let resolved = false;
      mockSendLongMessage.mockImplementation(() =>
        new Promise<void>((res) => {
          setTimeout(() => { resolved = true; res(); }, 0);
        }),
      );
      await sender.send(100, 'delayed');
      expect(resolved).toBe(true);
    });
  });

  // Chunking correctness is already covered by src/integrations/telegram/client.test.ts.
  // TelegramSender.send delegates 100% to sendLongMessage, so there is nothing additional to test here.

  describe('startTyping', () => {
    it('calls startTyping from the client with bot and userId', () => {
      sender.startTyping(100);
      expect(mockStartTyping).toHaveBeenCalledWith(bot, 100);
    });

    it('accepts an optional label and ignores it (Telegram uses the native typing indicator)', () => {
      sender.startTyping(100, 'Running agent…');
      // Telegram client is called with only bot and userId — label is not forwarded
      expect(mockStartTyping).toHaveBeenCalledWith(bot, 100);
    });

    it('stores the returned interval so stopTyping can clear it', () => {
      const fakeHandle = 99 as unknown as ReturnType<typeof setInterval>;
      mockStartTyping.mockReturnValue(fakeHandle);

      sender.startTyping(100);
      sender.stopTyping(100);

      expect(mockStopTyping).toHaveBeenCalledWith(fakeHandle);
    });

    it('is idempotent — double startTyping does not create a second interval', () => {
      sender.startTyping(100);
      sender.startTyping(100); // Should be a no-op

      expect(mockStartTyping).toHaveBeenCalledOnce();
    });

    it('manages typing timers per userId independently', () => {
      const handle1 = 1 as unknown as ReturnType<typeof setInterval>;
      const handle2 = 2 as unknown as ReturnType<typeof setInterval>;
      mockStartTyping
        .mockReturnValueOnce(handle1)
        .mockReturnValueOnce(handle2);

      sender.startTyping(100);
      sender.startTyping(200);

      expect(mockStartTyping).toHaveBeenCalledTimes(2);

      sender.stopTyping(100);
      expect(mockStopTyping).toHaveBeenCalledWith(handle1);

      sender.stopTyping(200);
      expect(mockStopTyping).toHaveBeenCalledWith(handle2);
    });
  });

  describe('stopTyping', () => {
    it('calls stopTyping from the client with the stored interval', () => {
      const fakeHandle = 77 as unknown as ReturnType<typeof setInterval>;
      mockStartTyping.mockReturnValue(fakeHandle);

      sender.startTyping(100);
      sender.stopTyping(100);

      expect(mockStopTyping).toHaveBeenCalledWith(fakeHandle);
    });

    it('removes the timer so a subsequent stopTyping is a no-op', () => {
      sender.startTyping(100);
      sender.stopTyping(100);
      vi.clearAllMocks();

      sender.stopTyping(100); // Already cleared
      expect(mockStopTyping).not.toHaveBeenCalled();
    });

    it('is a no-op when the userId is not typing', () => {
      sender.stopTyping(999); // Never started
      expect(mockStopTyping).not.toHaveBeenCalled();
    });
  });

  // ---- op-event tracker tests (onOpEvent) ----

  const TS = '2026-05-14T12:00:00.000Z';

  function makeOpEventStart(overrides: Record<string, unknown> = {}) {
    return {
      kind: 'op-event' as const,
      subKind: 'start' as const,
      opId: 'test-op-id-1234',
      userId: 100,
      opKind: 'agent' as const,
      label: 'wiki-compiler',
      startedAt: TS,
      elapsedMs: 0,
      ...overrides,
    };
  }

  function makeOpEventProgress(opId = 'test-op-id-1234', overrides: Record<string, unknown> = {}) {
    return {
      kind: 'op-event' as const,
      subKind: 'progress' as const,
      opId,
      userId: 100,
      opKind: 'agent' as const,
      label: 'wiki-compiler',
      startedAt: TS,
      elapsedMs: 5000,
      ...overrides,
    };
  }

  function makeOpEventEnd(opId = 'test-op-id-1234', overrides: Record<string, unknown> = {}) {
    return {
      kind: 'op-event' as const,
      subKind: 'end' as const,
      opId,
      userId: 100,
      opKind: 'agent' as const,
      label: 'wiki-compiler',
      startedAt: TS,
      elapsedMs: 12000,
      status: 'success' as const,
      ...overrides,
    };
  }

  describe('onMutationEvent — work-run outcome rendering', () => {
    /** Build a work-run terminal BusMutationEvent. */
    function workRunEvent(subKind: 'completed' | 'failed', data: Record<string, unknown>) {
      return {
        kind: 'mutation-event' as const,
        mutationId: 'abcd1234-5678-90ab-cdef-1234567890ab',
        mutationKind: 'work-run',
        subKind,
        ts: new Date().toISOString(),
        data: { projectSlug: 'demo', ...data },
        userId: 123,
      } as any;
    }

    const noopWorkProduct = {
      commitCount: 0,
      commitShas: [],
      filesChanged: [],
      diffstat: '',
      dirty: false,
      untracked: false,
      transitions: { tasksNewlyChecked: 0, tasksRemaining: 0, tasksAdded: 0, tasksRemoved: 0 },
    };

    /** Wait one macrotask so the fire-and-forget `void this.send()` resolves. */
    async function flush() {
      await new Promise((r) => setTimeout(r, 0));
    }

    it('a noop outcome never renders as "finished" success', async () => {
      sender.onMutationEvent(
        workRunEvent('completed', { outcome: 'noop', reason: 'no commits, no task transitions, clean tree', workProduct: noopWorkProduct }),
      );
      await flush();
      expect(mockSendLongMessage).toHaveBeenCalledOnce();
      const text = mockSendLongMessage.mock.calls[0]![2] as string;
      expect(text).not.toMatch(/finished/i);
      expect(text.toLowerCase()).toContain('no-op');
      expect(text).toContain('demo');
    });

    it('a dirty-uncommitted outcome reads as a warning, not success', async () => {
      sender.onMutationEvent(
        workRunEvent('completed', {
          outcome: 'dirty-uncommitted',
          reason: 'no commits but the working tree is dirty/untracked',
          workProduct: { ...noopWorkProduct, dirty: true },
        }),
      );
      await flush();
      const text = mockSendLongMessage.mock.calls[0]![2] as string;
      expect(text).not.toMatch(/finished/i);
      expect(text.toLowerCase()).toMatch(/dirty|uncommitted/);
    });

    it('a branch-complete outcome notes all tasks checked on the branch (not yet on main)', async () => {
      sender.onMutationEvent(
        workRunEvent('completed', {
          outcome: 'branch-complete',
          reason: '2 commit(s), all original tasks checked',
          workProduct: { ...noopWorkProduct, commitCount: 2, transitions: { tasksNewlyChecked: 3, tasksRemaining: 0, tasksAdded: 0, tasksRemoved: 0 } },
        }),
      );
      await flush();
      const text = mockSendLongMessage.mock.calls[0]![2] as string;
      expect(text).toContain('✅');
      expect(text.toLowerCase()).toMatch(/branch|not yet|main/);
    });

    it('a branch-complete run MERGED to main reads as merged, not "not yet on main" (Phase 3.5)', async () => {
      sender.onMutationEvent(
        workRunEvent('completed', {
          outcome: 'branch-complete',
          reason: '2 commit(s), all original tasks checked',
          workProduct: { ...noopWorkProduct, commitCount: 2, transitions: { tasksNewlyChecked: 3, tasksRemaining: 0, tasksAdded: 0, tasksRemoved: 0 } },
          merged: true,
          branchDeleted: true,
          gateValidationReceipt: {
            ...gateReceiptIdentity,
            outcome: 'passed',
            commands: [{
              command: 'npm test',
              outcome: 'passed',
              coverage: 'unsupported',
            }],
          },
        }),
      );
      await flush();
      const text = mockSendLongMessage.mock.calls[0]![2] as string;
      expect(text).toContain('✅');
      expect(text.toLowerCase()).toContain('merged to main');
      expect(text.toLowerCase()).toContain('validation passed (1 command)');
      // A merged run must NOT read as "not yet on main".
      expect(text.toLowerCase()).not.toContain('not yet');
    });

    it('an orchestrated terminal after gated merge does not itself claim the branch landed (Phase 15)', async () => {
      sender.onMutationEvent({
        ...workRunEvent('completed', {
          outcome: 'branch-complete',
          reason: '2 commit(s), all original tasks checked',
          workProduct: { ...noopWorkProduct, commitCount: 2, transitions: { tasksNewlyChecked: 3, tasksRemaining: 0, tasksAdded: 0, tasksRemoved: 0 } },
          merged: true,
          branchDeleted: true,
          baseBranch: 'trunk',
        }),
        mutationKind: 'orchestrated-work',
      });
      await flush();

      expect(mockSendLongMessage).toHaveBeenCalledOnce();
      const [sentBot, userId, text] = mockSendLongMessage.mock.calls[0]!;
      expect(sentBot).toBe(bot);
      expect(userId).toBe(123);
      expect(text.toLowerCase()).not.toContain('merged to trunk');
      expect(text.toLowerCase()).not.toContain('finished');
      expect(bot.sendMessage).not.toHaveBeenCalled();
    });

    it('delivers the orchestrated merge-success landing claim as a separate operator notification (Phase 15)', async () => {
      sender.onMutationEvent({
        ...workRunEvent('completed', {}),
        mutationKind: 'orchestrated-work',
        subKind: 'progress',
        data: {
          event: 'merge-success',
          projectSlug: 'demo',
          product: 'rune',
          baseBranch: 'trunk',
          branch: 'rune-work/demo',
        },
      } as any);
      await flush();

      expect(mockSendLongMessage).toHaveBeenCalledOnce();
      const text = mockSendLongMessage.mock.calls[0]![2] as string;
      expect(text.toLowerCase()).toContain('demo');
      expect(text.toLowerCase()).toContain('merged to trunk');
      expect(text.toLowerCase()).not.toContain('branch-complete');
      expect(text.toLowerCase()).not.toContain('finished');
    });

    it('a branch-complete run HELD at the gate surfaces the held reason (never a silent drop) (Phase 3.5)', async () => {
      sender.onMutationEvent(
        workRunEvent('completed', {
          outcome: 'branch-complete',
          reason: '2 commit(s), all original tasks checked',
          workProduct: { ...noopWorkProduct, commitCount: 2, transitions: { tasksNewlyChecked: 3, tasksRemaining: 0, tasksAdded: 0, tasksRemoved: 0 } },
          merged: false,
          gateHeldReason: 'tests-red',
          gateValidationReceipt: {
            ...gateReceiptIdentity,
            outcome: 'failed',
            commands: [{
              command: 'npm test',
              outcome: 'failed',
              coverage: 'unsupported',
            }],
          },
        }),
      );
      await flush();
      const text = mockSendLongMessage.mock.calls[0]![2] as string;
      // The operator sees the run held off main AND why.
      expect(text.toLowerCase()).toMatch(/held|not yet|off main/);
      expect(text).toContain('tests-red');
      expect(text.toLowerCase()).toContain('validation failed (1 command)');
      expect(text.toLowerCase()).not.toContain('merged to main');
    });

    it('a held gate surfaces "capability unavailable" and the profiles tried for a profile-unavailable receipt', async () => {
      sender.onMutationEvent(
        workRunEvent('completed', {
          outcome: 'branch-complete',
          reason: '2 commit(s), all original tasks checked',
          workProduct: { ...noopWorkProduct, commitCount: 2, transitions: { tasksNewlyChecked: 3, tasksRemaining: 0, tasksAdded: 0, tasksRemoved: 0 } },
          merged: false,
          gateHeldReason: 'profile-unavailable',
          gateValidationReceipt: {
            ...gateReceiptIdentity,
            version: 2,
            outcome: 'profile-unavailable',
            // The launcher emits `commands` and `profileOutcomes` from the same
            // per-shard execution list, so a two-shard plan yields two command
            // entries. The isolated shard passed; the unavailable
            // sandbox-integration shard exits null, which reads as `failed`.
            commands: [
              { command: 'npm test', outcome: 'passed', coverage: 'unsupported' },
              { command: 'npm test', outcome: 'failed', coverage: 'unsupported' },
            ],
            profilePlan: {
              version: 1,
              definitionFingerprint: 'f'.repeat(64),
              shards: [
                { command: 'npm test', argv: ['npm', 'test'], profile: 'isolated' },
                { command: 'npm test', argv: ['npm', 'test'], profile: 'sandbox-integration' },
              ],
            },
            profileOutcomes: [
              {
                profile: 'isolated',
                outcome: 'passed',
                probe: {
                  profile: 'isolated',
                  definitionFingerprint: '1'.repeat(64),
                  confinementOwner: 'validation-launcher',
                  outcome: 'passed',
                  startedAt: '2026-07-30T12:00:00.000Z',
                  completedAt: '2026-07-30T12:00:01.000Z',
                },
              },
              {
                profile: 'sandbox-integration',
                outcome: 'profile-unavailable',
                probe: {
                  profile: 'sandbox-integration',
                  definitionFingerprint: '2'.repeat(64),
                  confinementOwner: 'sandbox-broker',
                  outcome: 'unavailable',
                  failureClass: 'profile-unavailable',
                  startedAt: '2026-07-30T12:00:01.000Z',
                  completedAt: '2026-07-30T12:00:02.000Z',
                },
              },
            ],
          },
        }),
      );
      await flush();
      const text = mockSendLongMessage.mock.calls[0]![2] as string;
      expect(text.toLowerCase()).toContain('validation capability unavailable (operational hold) (2 commands)');
      expect(text).toContain('profiles isolated/sandbox-integration');
      expect(text.toLowerCase()).not.toContain('merged to main');
    });

    it('a partial outcome carries the commits + tasks X/Y summary', async () => {
      sender.onMutationEvent(
        workRunEvent('completed', {
          outcome: 'partial',
          reason: '1 commit(s), 2 task(s) still unchecked',
          workProduct: { ...noopWorkProduct, commitCount: 1, transitions: { tasksNewlyChecked: 1, tasksRemaining: 2, tasksAdded: 0, tasksRemoved: 0 } },
        }),
      );
      await flush();
      const text = mockSendLongMessage.mock.calls[0]![2] as string;
      expect(text).not.toMatch(/finished/i);
      // commits + remaining tasks surfaced
      expect(text).toMatch(/1/);
      expect(text).toMatch(/2/);
    });

    it('an outcome-less completed work-run terminal never reads as bare "finished"', async () => {
      // Early-exit terminals (worktree-create / project-not-found) carry no
      // classified outcome — they must NOT fall through to "✅ finished in Ns",
      // which would let a work run read as success without a verified outcome.
      sender.onMutationEvent(workRunEvent('completed', {})); // no `outcome` key
      await flush();
      const text = mockSendLongMessage.mock.calls[0]![2] as string;
      expect(text).not.toMatch(/finished/i);
      expect(text).toContain('demo'); // the run is still labelled by slug
      expect(text).toContain('no outcome recorded');
    });

    it('an outcome-less failed work-run terminal renders the reason (early-exit failure)', async () => {
      sender.onMutationEvent(workRunEvent('failed', { reason: 'worktree create failed: boom' }));
      await flush();
      const text = mockSendLongMessage.mock.calls[0]![2] as string;
      expect(text).toContain('❌');
      expect(text).toContain('worktree create failed: boom');
      expect(text).not.toMatch(/finished/i);
    });

    it('a failed outcome renders the reason', async () => {
      sender.onMutationEvent(
        workRunEvent('failed', { outcome: 'failed', reason: 'exited with code 1' }),
      );
      await flush();
      const text = mockSendLongMessage.mock.calls[0]![2] as string;
      expect(text).toContain('❌');
      expect(text).toContain('exited with code 1');
    });

    it('a send failure does not propagate out of onMutationEvent (alert failure never blocks teardown)', async () => {
      // test-plan §4 🟢: a notification-bus / Telegram send failure must not
      // block the run's teardown — onMutationEvent fires the send fire-and-forget
      // and swallows a rejection, so the caller (the bus publish loop) is never
      // interrupted and the run still persists its outcome downstream.
      mockSendLongMessage.mockRejectedValueOnce(new Error('telegram 500'));
      expect(() =>
        sender.onMutationEvent(workRunEvent('completed', { outcome: 'noop', workProduct: noopWorkProduct })),
      ).not.toThrow();
      await flush(); // let the rejected send settle; must not surface as unhandled
    });

    it('ignores work-run output events (only terminals + progress pings are sent)', async () => {
      sender.onMutationEvent(workRunEvent('completed', { outcome: 'noop', workProduct: noopWorkProduct }));
      // override subKind to a plain output event — not a terminal, not a ping
      sender.onMutationEvent({ ...workRunEvent('completed', {}), subKind: 'output', data: { line: 'x' } } as any);
      await flush();
      // only the terminal event produced a message
      expect(mockSendLongMessage).toHaveBeenCalledOnce();
    });

    it('delivers a work-run progress ping (commit poll) as a Telegram message', async () => {
      // Requirement 22: the throttled commit-poll progress ping reaches the user.
      sender.onMutationEvent({
        ...workRunEvent('completed', {}),
        subKind: 'progress',
        data: { line: '📊 add the widget · 1/2 tasks' },
      } as any);
      await flush();
      expect(mockSendLongMessage).toHaveBeenCalledOnce();
      expect(mockSendLongMessage.mock.calls[0]![2]).toContain('add the widget');
    });

    it('delivers an orchestrated closeout-commit progress alert with task and remaining counts', async () => {
      sender.onMutationEvent({
        ...workRunEvent('completed', {}),
        mutationKind: 'orchestrated-work',
        subKind: 'progress',
        data: {
          event: 'closeout-commit',
          projectSlug: 'demo',
          taskText: 'Render the streak card',
          commitSha: 'abc123456789',
          shortSha: 'abc1234',
          commitSubject: 'rune(rune): closeout — Render the streak card',
          tasksDone: 3,
          tasksTotal: 12,
          tasksRemaining: 9,
        },
      } as any);
      await flush();

      expect(mockSendLongMessage).toHaveBeenCalledOnce();
      const text = mockSendLongMessage.mock.calls[0]![2] as string;
      expect(text).toContain('Render the streak card');
      expect(text).toContain('abc1234');
      expect(text).toMatch(/3\/12 done/i);
      expect(text).toMatch(/9 remaining/i);
      expect(text).toContain('rune(rune): closeout');
    });

    it('does not deliver a progress event for a non-work-run mutation', async () => {
      sender.onMutationEvent({
        kind: 'mutation-event',
        mutationId: 'x',
        mutationKind: 'gen-eval-loop',
        subKind: 'progress',
        ts: new Date().toISOString(),
        data: { line: 'should be ignored' },
        userId: 123,
      } as any);
      await flush();
      expect(mockSendLongMessage).not.toHaveBeenCalled();
    });

    // --- Writing-run terminals (/blog, /writing-critique) ---
    function writingEvent(subKind: 'completed' | 'failed', data: Record<string, unknown>) {
      return {
        kind: 'mutation-event' as const,
        mutationId: 'wrt12345-6789-90ab-cdef-1234567890ab',
        mutationKind: 'writing',
        subKind,
        ts: new Date().toISOString(),
        data,
        userId: 123,
      } as any;
    }

    it('a committed /blog writing terminal renders branch, short sha, and route — never "/work --auto finished"', async () => {
      sender.onMutationEvent(writingEvent('completed', {
        command: 'blog',
        topic: 'operating from memory',
        slug: 'operating-from-memory',
        branch: 'rune-writing/operating-from-memory',
        commitSha: 'abc1234567890def',
        routePath: '/rune/operating-from-memory',
        outcome: 'branch-complete',
      }));
      await flush();
      const text = mockSendLongMessage.mock.calls[0]![2] as string;
      expect(text).toContain('✍️ /blog "operating from memory" committed');
      expect(text).toContain('rune-writing/operating-from-memory @ abc1234');
      expect(text).toContain('/rune/operating-from-memory');
      expect(text).not.toMatch(/\/work --auto/);
    });

    it('a committed /writing-critique terminal surfaces the critique output path', async () => {
      sender.onMutationEvent(writingEvent('completed', {
        command: 'writing-critique',
        critiqueTarget: 'docs/rune/Operating From Memory.md',
        branch: 'rune-writing/operating-from-memory',
        commitSha: 'abc1234567890def',
        outputPath: 'docs/rune/critiques/operating-from-memory.md',
        outcome: 'branch-complete',
      }));
      await flush();
      const text = mockSendLongMessage.mock.calls[0]![2] as string;
      expect(text).toContain('/writing-critique');
      expect(text).toContain('docs/rune/critiques/operating-from-memory.md');
    });

    it('a failed writing terminal renders the reason', async () => {
      sender.onMutationEvent(writingEvent('failed', {
        command: 'blog',
        topic: 'operating from memory',
        reason: 'writing pipeline failed at draft: model call failed',
      }));
      await flush();
      const text = mockSendLongMessage.mock.calls[0]![2] as string;
      expect(text).toContain('💥 writing run "operating from memory" failed');
      expect(text).toContain('failed at draft');
      expect(text).not.toMatch(/\/work --auto/);
    });

    // --- Project 13, Phase 1a: run-start notification delivery ---
    /** Build a work-run `start` BusMutationEvent (project 13). */
    function workRunStart(data: Record<string, unknown>) {
      return {
        kind: 'mutation-event' as const,
        mutationId: 'run-1234',
        mutationKind: 'work-run',
        subKind: 'start',
        ts: new Date().toISOString(),
        data,
        userId: 123,
      } as any;
    }

    it('sends a start message carrying the un-scrubbed worktree path + run id', async () => {
      // The operator path is a LOCAL-OPERATOR field — Telegram (to TELEGRAM_USER_ID)
      // is a local surface, so the raw `cd`-able path is delivered verbatim. Use a
      // synthetic `/tmp` fixture (never a real `/Users/<name>` host path) so this
      // committed test leaks no OS username.
      const worktree = '/tmp/worktrees/rune/06-webview';
      sender.onMutationEvent(
        workRunStart({ operatorWorktreePath: worktree, runId: 'run-1234', projectSlug: '06-webview', product: 'rune' }),
      );
      await flush();
      expect(mockSendLongMessage).toHaveBeenCalledOnce();
      const text = mockSendLongMessage.mock.calls[0]![2] as string;
      // Michael can copy the path straight out of the alert (un-scrubbed).
      expect(text).toContain(worktree);
      expect(text).toContain('06-webview');
      expect(text).toContain('run-1234');
    });

    it('ignores a start event for a non-work-run mutation kind', async () => {
      sender.onMutationEvent({
        ...workRunStart({ operatorWorktreePath: '/x', runId: 'r' }),
        mutationKind: 'gen-eval-loop',
      });
      await flush();
      expect(mockSendLongMessage).not.toHaveBeenCalled();
    });

    it('does not send an empty start alert when the worktree path is absent', async () => {
      // Defensive: a work-run start always carries the path, but never surface a
      // pathless alert if one ever arrives malformed.
      sender.onMutationEvent(workRunStart({ runId: 'run-1234', projectSlug: '06-webview' }));
      await flush();
      expect(mockSendLongMessage).not.toHaveBeenCalled();
    });

    // --- Project 13, Phase 1b: parked terminal rendering (test-plan §2 "Cap") ---
    // A parked run terminates the mutation normally (subKind completed) but
    // carries `parked: true` + the sentinel payload. `formatWorkRunTerminal` must
    // render the PARKED state, NOT the underlying `outcome` (partial/noop) — a
    // run paused for a human must never read as "did nothing / no-op success".
    // Project 13 Phase 1c: a parked terminal also gets a one-tap Release button,
    // so it goes through the inline-keyboard (`bot.sendMessage`) path, not the
    // plain `sendLongMessage` path.
    it('renders a parked run via a parked-aware branch, with a one-tap Release button', async () => {
      sender.onMutationEvent(
        workRunEvent('completed', {
          parked: true,
          operatorWorktreePath: '/tmp/worktrees/rune/demo',
          pendingCheck: 'Run the interactive Codex check and confirm the result',
          command: 'npm run codex-check',
          reason: 'needs a human at the keyboard',
          trigger: { kind: 'failure', reason: 'coder failed at provider' },
          disposition: { kind: 'parked', reason: 'WIP preserved after failure', wipSha: 'deadbeef' },
          // Underlying classification — must NOT be the headline for a parked run.
          outcome: 'noop',
          workProduct: noopWorkProduct,
        }),
      );
      await flush();
      // Parked terminal routes through the approval-keyboard path, not sendLongMessage.
      expect(mockSendLongMessage).not.toHaveBeenCalled();
      expect(bot.sendMessage).toHaveBeenCalledOnce();
      const [, text, opts] = bot.sendMessage.mock.calls[0]! as [number, string, { reply_markup?: { inline_keyboard: { text: string; callback_data: string }[][] } }];
      // Parked branch wins — never the no-op "did nothing" headline.
      expect(text.toLowerCase()).not.toContain('no-op');
      expect(text.toLowerCase()).toMatch(/park|paused|needs you|blocked on you|awaiting/);
      // Carries the pending check + the un-scrubbed operator path so Michael can act.
      expect(text).toContain('Run the interactive Codex check and confirm the result');
      expect(text).toContain('/tmp/worktrees/rune/demo');
      expect(text).toContain('coder failed at provider');
      expect(text).toContain('WIP preserved after failure');
      expect(text).toContain('deadbeef');
      // The Release button's callback id routes through the shared release runtime.
      const button = opts.reply_markup!.inline_keyboard[0]![0]!;
      expect(button.callback_data).toMatch(/^work-run-release:/);
    });

    it('renders a related-test host conflict as an operational hold, not a product failure', async () => {
      sender.onMutationEvent(
        workRunEvent('completed', {
          held: true,
          reason:
            'related-test infrastructure validation conflict; compatible confirmation failed',
          relatedTestDiagnostic: { state: 'related-fallback-failed' },
          outcome: 'partial',
          workProduct: {
            commitCount: 1,
            commitShas: ['abcdef1234567'],
            filesChanged: ['src/feature.ts'],
            diffstat: '1 file changed',
          },
        }),
      );
      await flush();

      expect(mockSendLongMessage).toHaveBeenCalledOnce();
      const text = mockSendLongMessage.mock.calls[0]![2] as string;
      expect(text).toMatch(/operational hold/i);
      expect(text).toMatch(/validation-host conflict/i);
      expect(text).toMatch(/compatible confirmation did not pass/i);
      expect(text).not.toMatch(/tests failed|coder failed|repair attempt/i);
    });

    it('renders AskUserQuestion parks with answer buttons instead of Release', async () => {
      sender.onMutationEvent(
        workRunEvent('completed', {
          parked: true,
          operatorWorktreePath: '/tmp/worktrees/rune/demo',
          pendingCheck: 'Answer required: Which implementation?',
          parkedQuestion: {
            source: 'ask-user-question',
            question: 'Which implementation?',
            askedAt: new Date().toISOString(),
            options: [
              { id: '0', label: 'Small patch', value: 'small' },
              { id: '1', label: 'Full fix', value: 'full' },
            ],
          },
        }),
      );
      await flush();

      expect(bot.sendMessage).toHaveBeenCalledOnce();
      const [, text, opts] = bot.sendMessage.mock.calls[0]! as [number, string, { reply_markup?: { inline_keyboard: { text: string; callback_data: string }[][] } }];
      expect(text).toContain('Which implementation?');
      const buttons = opts.reply_markup!.inline_keyboard[0]!;
      expect(buttons.map((button) => button.text)).toEqual(['Small patch', 'Full fix']);
      expect(buttons.map((button) => button.callback_data)).toEqual([
        'work-run-answer:abcd1234-5678-90ab-cdef-1234567890ab:0',
        'work-run-answer:abcd1234-5678-90ab-cdef-1234567890ab:1',
      ]);
      expect(buttons.map((button) => button.callback_data).join(' ')).not.toContain('work-run-release');
    });
  });

  // Every successful send lands one structured record in logs/rune.log so
  // "did Rune actually tell me?" is answerable without tracing emit site →
  // publication ledger → drain loop → bus → sender.
  describe('delivery logging', () => {
    const MUTATION_ID = 'abcd1234-5678-90ab-cdef-1234567890ab';

    function mutationEvent(over: Record<string, unknown>) {
      return {
        kind: 'mutation-event' as const,
        mutationId: MUTATION_ID,
        mutationKind: 'work-run',
        subKind: 'completed',
        ts: new Date().toISOString(),
        data: {},
        userId: 123,
        ...over,
      } as any;
    }

    async function flush() {
      await new Promise((r) => setTimeout(r, 0));
    }

    // A PM acceptance override travels the same orchestrated-progress path as a
    // closeout commit, so it must both render and leave a delivery record — the
    // operator's only proof that "the machine shipped something a gate objected
    // to" actually reached them.
    it('records a pm-acceptance override alert', async () => {
      sender.onMutationEvent(mutationEvent({
        mutationKind: 'orchestrated-work',
        subKind: 'progress',
        data: {
          event: 'pm-acceptance',
          projectSlug: 'demo',
          taskId: 'task-2',
          taskText: 'Wire the streak card',
          actor: 'pm',
          overriddenRole: 'reviewer',
          rationale: 'The helper shape is a style preference; behavior is correct.',
        },
      }));
      await flush();

      const sent = mockSendLongMessage.mock.calls[0]![2] as string;
      expect(sent).toContain('accepted over');
      expect(sent).toContain('reviewer');
      expect(sent).toContain('Wire the streak card');

      const records = deliveryRecords();
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        kind: 'orchestrated-progress',
        mutationKind: 'orchestrated-work',
        chars: sent.length,
      });
    });

    it('scrubs absolute paths from pm-acceptance alerts before delivery', async () => {
      sender.onMutationEvent(mutationEvent({
        mutationKind: 'orchestrated-work',
        subKind: 'progress',
        data: {
          event: 'pm-acceptance',
          taskText: 'Inspect /Users/operator/private/task.ts',
          actor: 'pm',
          overriddenRole: 'reviewer',
          rationale: 'Accepted based on /Users/operator/private/review.ts:9.',
        },
      }));
      await flush();

      const sent = mockSendLongMessage.mock.calls[0]![2] as string;
      expect(sent).not.toContain('/Users/operator');
      expect(sent).toContain('<path>');
    });

    it('records an orchestrated closeout-commit alert exactly once, naming the kind and target chat', async () => {
      sender.onMutationEvent(mutationEvent({
        mutationKind: 'orchestrated-work',
        subKind: 'progress',
        data: {
          event: 'closeout-commit',
          projectSlug: 'demo',
          taskText: 'Render the streak card',
          shortSha: 'abc1234',
          commitSubject: 'rune(rune): closeout — Render the streak card',
          tasksDone: 3,
          tasksTotal: 12,
          tasksRemaining: 9,
        },
      }));
      await flush();

      const sent = mockSendLongMessage.mock.calls[0]![2] as string;
      const records = deliveryRecords();
      expect(records).toHaveLength(1);
      expect(records[0]).toEqual({
        kind: 'orchestrated-progress',
        mutationId: MUTATION_ID,
        mutationKind: 'orchestrated-work',
        chatId: 123,
        chars: sent.length,
      });
      expect(mockLogError).not.toHaveBeenCalled();
    });

    it('records a work-run terminal', async () => {
      sender.onMutationEvent(mutationEvent({
        data: { projectSlug: 'demo', outcome: 'branch-complete', workProduct: { commitCount: 2 } },
      }));
      await flush();

      const records = deliveryRecords();
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        kind: 'terminal',
        mutationId: MUTATION_ID,
        mutationKind: 'work-run',
        chatId: 123,
      });
    });

    it('records the work-run start and progress kinds distinctly', async () => {
      sender.onMutationEvent(mutationEvent({
        subKind: 'start',
        data: { projectSlug: 'demo', runId: 'run-7', operatorWorktreePath: '/Users/tester/worktrees/rune/demo' },
      }));
      sender.onMutationEvent(mutationEvent({
        subKind: 'progress',
        data: { line: '📊 add the widget · 1/2 tasks' },
      }));
      await flush();

      expect(deliveryRecords().map((record) => record['kind'])).toEqual([
        'work-run-start',
        'work-run-progress',
      ]);
    });

    it('never carries the message body — no vault content, no un-scrubbed worktree path', async () => {
      const worktree = '/Users/tester/workspace/.worktrees/rune/24-execution-profiles';
      sender.onMutationEvent(mutationEvent({
        data: {
          projectSlug: 'demo',
          parked: true,
          operatorWorktreePath: worktree,
          pendingCheck: 'Answer required: Which implementation?',
          parkedQuestion: {
            source: 'ask-user-question',
            question: 'Which implementation?',
            askedAt: new Date().toISOString(),
            options: [{ id: '0', label: 'Small patch', value: 'small' }],
          },
        },
      }));
      await flush();

      const records = deliveryRecords();
      expect(records).toHaveLength(1);
      const serialized = JSON.stringify(records[0]);
      expect(serialized).not.toContain(worktree);
      expect(serialized).not.toContain('worktrees');
      expect(serialized).not.toContain('Which implementation?');
      expect(serialized).not.toContain('demo');
      expect(Object.keys(records[0]!).sort()).toEqual(
        ['chars', 'chatId', 'kind', 'mutationId', 'mutationKind'],
      );
    });

    it('records an approval-keyboard send (parked Release button) exactly once', async () => {
      sender.onMutationEvent(mutationEvent({
        data: { projectSlug: 'demo', parked: true, operatorWorktreePath: '/tmp/worktrees/rune/demo' },
      }));
      await flush();

      expect(bot.sendMessage).toHaveBeenCalledOnce();
      expect(deliveryRecords()).toHaveLength(1);
      expect(deliveryRecords()[0]).toMatchObject({ kind: 'terminal' });
    });

    it('a failed send records the error and no success record', async () => {
      mockSendLongMessage.mockRejectedValueOnce(new Error('Telegram 429'));
      sender.onMutationEvent(mutationEvent({
        data: { projectSlug: 'demo', outcome: 'branch-complete', workProduct: { commitCount: 1 } },
      }));
      await flush();

      expect(deliveryRecords()).toHaveLength(0);
      expect(mockLogError).toHaveBeenCalledWith(
        'TelegramSender.onMutationEvent send failed',
        { error: 'Telegram 429' },
      );
    });

    it('records a plain send (chat reply / bus-published job alert) with no mutation id', async () => {
      await sender.send(456, 'Nightly processing complete.');

      const records = deliveryRecords();
      expect(records).toHaveLength(1);
      expect(records[0]).toEqual({
        kind: 'message',
        chatId: 456,
        chars: 'Nightly processing complete.'.length,
      });
    });
  });

  describe('onOpEvent — classifier filter', () => {
    it('ignores start events for classifier ops', () => {
      const event = makeOpEventStart({ opKind: 'classifier' });
      sender.onOpEvent(event as any);
      expect(bot.sendMessage).not.toHaveBeenCalled();
    });

    it('ignores progress events for classifier ops', () => {
      const event = makeOpEventProgress('x', { opKind: 'classifier' });
      sender.onOpEvent(event as any);
      expect(bot.sendMessage).not.toHaveBeenCalled();
    });

    it('ignores end events for classifier ops', () => {
      const event = makeOpEventEnd('x', { opKind: 'classifier' });
      sender.onOpEvent(event as any);
      expect(bot.sendMessage).not.toHaveBeenCalled();
    });
  });

  describe('onOpEvent — start sends tracker message', () => {
    it('calls bot.sendMessage with a formatted tracker text on start', () => {
      const event = makeOpEventStart();
      sender.onOpEvent(event as any);
      expect(bot.sendMessage).toHaveBeenCalledOnce();
      const [userId, text] = (bot.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]!;
      expect(userId).toBe(100);
      expect(text).toContain('wiki-compiler');
      expect(text).toContain('/cancel');
    });

    it('formats elapsed seconds from elapsedMs', async () => {
      const event = makeOpEventStart({ elapsedMs: 15000 });
      sender.onOpEvent(event as any);
      expect(bot.sendMessage).toHaveBeenCalledOnce();
      const [, text] = (bot.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]!;
      expect(text).toContain('15s');
    });
  });

  describe('onOpEvent — progress edits tracker message (throttled)', () => {
    it('does not edit when no tracker exists for that opId', async () => {
      const event = makeOpEventProgress('unknown-op');
      sender.onOpEvent(event as any);
      expect(bot.editMessageText).toBeUndefined();
    });

    it('does not call editMessageText before throttle window expires', async () => {
      // The bot already has sendMessage from mockBot().
      // Ensure editMessageText is defined on bot so we can spy on it.
      bot.editMessageText = vi.fn().mockResolvedValue({});

      const start = makeOpEventStart();
      sender.onOpEvent(start as any);
      // Flush microtasks so the sendMessage .then() callback fires and stores the tracker.
      await new Promise(r => setTimeout(r, 0));

      // Immediately send a progress event — the tracker was just stored but
      // lastEditTs was set to Date.now() at creation, so the 10s throttle
      // prevents any edit call this soon.
      const progress = makeOpEventProgress(start.opId, { elapsedMs: 100 });
      sender.onOpEvent(progress as any);
      expect(bot.editMessageText).not.toHaveBeenCalled();
    });
  });

  describe('onOpEvent — end deletes tracker message', () => {
    it('does not call deleteMessage when no tracker exists for that opId', async () => {
      bot.deleteMessage = vi.fn().mockResolvedValue(true);
      const event = makeOpEventEnd('unknown-op-id');
      sender.onOpEvent(event as any);
      expect(bot.deleteMessage).not.toHaveBeenCalled();
    });

    it('calls deleteMessage after start+end sequence (async resolve)', async () => {
      bot.sendMessage = vi.fn().mockResolvedValue({ message_id: 999 });
      bot.deleteMessage = vi.fn().mockResolvedValue(true);

      const start = makeOpEventStart({ opId: 'del-op-1' });
      sender.onOpEvent(start as any);

      // Flush microtasks so the .then() callback runs and tracker is stored
      await new Promise(r => setTimeout(r, 0));

      const end = makeOpEventEnd('del-op-1');
      sender.onOpEvent(end as any);

      // Flush again for the delete promise
      await new Promise(r => setTimeout(r, 0));

      expect(bot.deleteMessage).toHaveBeenCalledOnce();
      const [chatId, msgId] = (bot.deleteMessage as ReturnType<typeof vi.fn>).mock.calls[0]!;
      expect(chatId).toBe(100); // userId
      expect(msgId).toBe(999);  // message_id from sendMessage
    });
  });

  describe('shutdown — trackers cleared', () => {
    it('clears trackers map without throwing', () => {
      // Just verify shutdown doesn't throw even with pending trackers
      sender.onOpEvent(makeOpEventStart() as any);
      expect(() => sender.shutdown()).not.toThrow();
    });
  });
});
