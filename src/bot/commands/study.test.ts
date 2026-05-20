import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MessageSender } from '../../transport/sender.js';

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockRunSRSession = vi.fn();
vi.mock('../../study/sr-session.js', () => ({
  runSRSession: mockRunSRSession,
}));

const mockReadSRState = vi.fn();
vi.mock('../../study/sr-state.js', () => ({
  readSRState: mockReadSRState,
}));

const mockReadPool = vi.fn();
vi.mock('../../study/sr-pool.js', () => ({
  readPool: mockReadPool,
}));

const mockSelectDueConcepts = vi.fn();
vi.mock('../../study/sr-select.js', () => ({
  selectDueConcepts: mockSelectDueConcepts,
}));

const mockGetTodayDate = vi.fn().mockReturnValue('2026-05-20');
vi.mock('../../utils/time.js', () => ({
  getTodayDate: mockGetTodayDate,
}));

vi.mock('../../utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  }),
}));

const { handleStudy } = await import('./study.js');

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeSender(): MessageSender {
  return {
    name: 'telegram' as const,
    send: vi.fn().mockResolvedValue(undefined),
    startTyping: vi.fn(),
    stopTyping: vi.fn(),
  };
}

const USER_ID = 42;

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('handleStudy — arg parsing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRunSRSession.mockResolvedValue(undefined);
  });

  describe('no args → default cap 5', () => {
    it('calls runSRSession with source manual and cap 5', async () => {
      const sender = makeSender();
      await handleStudy(sender, USER_ID, '');

      expect(mockRunSRSession).toHaveBeenCalledOnce();
      expect(mockRunSRSession).toHaveBeenCalledWith({
        source: 'manual',
        cap: 5,
        userId: USER_ID,
        sender,
      });
    });

    it('does not send any message before calling runSRSession', async () => {
      const sender = makeSender();
      await handleStudy(sender, USER_ID, '');

      expect(sender.send).not.toHaveBeenCalled();
    });

    it('also works with whitespace-only args string', async () => {
      const sender = makeSender();
      await handleStudy(sender, USER_ID, '   ');

      expect(mockRunSRSession).toHaveBeenCalledOnce();
      expect(mockRunSRSession).toHaveBeenCalledWith(
        expect.objectContaining({ cap: 5 }),
      );
    });
  });

  describe('/study 3 → exact cap, no clamp message', () => {
    it('calls runSRSession with cap 3', async () => {
      const sender = makeSender();
      await handleStudy(sender, USER_ID, '3');

      expect(mockRunSRSession).toHaveBeenCalledOnce();
      expect(mockRunSRSession).toHaveBeenCalledWith({
        source: 'manual',
        cap: 3,
        userId: USER_ID,
        sender,
      });
    });

    it('does NOT send a clamp message', async () => {
      const sender = makeSender();
      await handleStudy(sender, USER_ID, '3');

      expect(sender.send).not.toHaveBeenCalled();
    });
  });

  describe('/study 12 → clamp to 10', () => {
    it('calls runSRSession with cap 10', async () => {
      const sender = makeSender();
      await handleStudy(sender, USER_ID, '12');

      expect(mockRunSRSession).toHaveBeenCalledOnce();
      expect(mockRunSRSession).toHaveBeenCalledWith(
        expect.objectContaining({ cap: 10 }),
      );
    });

    it('sends a clamp note mentioning 10', async () => {
      const sender = makeSender();
      await handleStudy(sender, USER_ID, '12');

      expect(sender.send).toHaveBeenCalledOnce();
      const msg = vi.mocked(sender.send).mock.calls[0]![1] as string;
      expect(msg).toContain('10');
    });

    it('sends the clamp note before calling runSRSession', async () => {
      const callOrder: string[] = [];
      const sender = makeSender();
      vi.mocked(sender.send).mockImplementation(async () => { callOrder.push('send'); });
      mockRunSRSession.mockImplementation(async () => { callOrder.push('session'); });

      await handleStudy(sender, USER_ID, '12');

      expect(callOrder).toEqual(['send', 'session']);
    });
  });

  describe('/study 0 → clamp to 1', () => {
    it('calls runSRSession with cap 1', async () => {
      const sender = makeSender();
      await handleStudy(sender, USER_ID, '0');

      expect(mockRunSRSession).toHaveBeenCalledOnce();
      expect(mockRunSRSession).toHaveBeenCalledWith(
        expect.objectContaining({ cap: 1 }),
      );
    });

    it('sends a clamp note mentioning 1', async () => {
      const sender = makeSender();
      await handleStudy(sender, USER_ID, '0');

      expect(sender.send).toHaveBeenCalledOnce();
      const msg = vi.mocked(sender.send).mock.calls[0]![1] as string;
      expect(msg).toContain('1');
    });
  });

  describe('/study -1 → clamp to 1', () => {
    it('calls runSRSession with cap 1', async () => {
      const sender = makeSender();
      await handleStudy(sender, USER_ID, '-1');

      expect(mockRunSRSession).toHaveBeenCalledOnce();
      expect(mockRunSRSession).toHaveBeenCalledWith(
        expect.objectContaining({ cap: 1 }),
      );
    });

    it('sends a clamp note', async () => {
      const sender = makeSender();
      await handleStudy(sender, USER_ID, '-1');

      expect(sender.send).toHaveBeenCalledOnce();
    });
  });

  describe('/study <non-integer> → integer-format guard sends USAGE', () => {
    it('/study 3foo sends USAGE and does NOT call runSRSession', async () => {
      const sender = makeSender();
      await handleStudy(sender, USER_ID, '3foo');

      expect(sender.send).toHaveBeenCalledOnce();
      const [, msg] = vi.mocked(sender.send).mock.calls[0]!;
      expect(msg).toContain('/study');
      expect(mockRunSRSession).not.toHaveBeenCalled();
    });

    it('/study 3.9 sends USAGE and does NOT call runSRSession', async () => {
      const sender = makeSender();
      await handleStudy(sender, USER_ID, '3.9');

      expect(sender.send).toHaveBeenCalledOnce();
      const [, msg] = vi.mocked(sender.send).mock.calls[0]!;
      expect(msg).toContain('/study');
      expect(mockRunSRSession).not.toHaveBeenCalled();
    });

    it('/study 1.5 sends USAGE and does NOT call runSRSession', async () => {
      const sender = makeSender();
      await handleStudy(sender, USER_ID, '1.5');

      expect(sender.send).toHaveBeenCalledOnce();
      const [, msg] = vi.mocked(sender.send).mock.calls[0]!;
      expect(msg).toContain('/study');
      expect(mockRunSRSession).not.toHaveBeenCalled();
    });

    // `-1` is a valid integer (matches `^-?\d+$`) and is covered by the dedicated `/study -1 → clamp to 1` describe block above.
  });

  describe('/study status → pool size + due-today count', () => {
    beforeEach(() => {
      mockReadPool.mockReturnValue(['concept/a.md', 'concept/b.md', 'concept/c.md']);
      mockReadSRState.mockReturnValue({ concepts: {}, meta: { last_session_at: null, last_session_summary: null } });
      mockSelectDueConcepts.mockReturnValue(['concept/a.md', 'concept/b.md']);
    });

    it('does NOT call runSRSession', async () => {
      const sender = makeSender();
      await handleStudy(sender, USER_ID, 'status');

      expect(mockRunSRSession).not.toHaveBeenCalled();
    });

    it('sends pool size and due-today count', async () => {
      const sender = makeSender();
      await handleStudy(sender, USER_ID, 'status');

      expect(sender.send).toHaveBeenCalledOnce();
      const msg = vi.mocked(sender.send).mock.calls[0]![1] as string;
      expect(msg).toContain('3');  // pool size
      expect(msg).toContain('2');  // due today
    });

    it('reply contains "SR pool" and "due today"', async () => {
      const sender = makeSender();
      await handleStudy(sender, USER_ID, 'status');

      const msg = vi.mocked(sender.send).mock.calls[0]![1] as string;
      expect(msg.toLowerCase()).toContain('sr pool');
      expect(msg.toLowerCase()).toContain('due today');
    });

    it('calls selectDueConcepts with cap equal to pool length', async () => {
      const sender = makeSender();
      await handleStudy(sender, USER_ID, 'status');

      expect(mockSelectDueConcepts).toHaveBeenCalledOnce();
      const opts = mockSelectDueConcepts.mock.calls[0]![0] as { cap: number };
      expect(opts.cap).toBe(3);
    });

    it('is case-insensitive: STATUS works', async () => {
      const sender = makeSender();
      await handleStudy(sender, USER_ID, 'STATUS');

      expect(mockRunSRSession).not.toHaveBeenCalled();
      expect(sender.send).toHaveBeenCalledOnce();
    });

    it('is case-insensitive: Status works', async () => {
      const sender = makeSender();
      await handleStudy(sender, USER_ID, 'Status');

      expect(mockRunSRSession).not.toHaveBeenCalled();
      expect(sender.send).toHaveBeenCalledOnce();
    });

    it('uses the today date from getTodayDate', async () => {
      mockGetTodayDate.mockReturnValue('2026-05-20');
      const sender = makeSender();
      await handleStudy(sender, USER_ID, 'status');

      const opts = mockSelectDueConcepts.mock.calls[0]![0] as { today: string };
      expect(opts.today).toBe('2026-05-20');
    });

    it('shows singular "concept" when pool has exactly 1 entry', async () => {
      mockReadPool.mockReturnValue(['concept/a.md']);
      mockSelectDueConcepts.mockReturnValue([]);

      const sender = makeSender();
      await handleStudy(sender, USER_ID, 'status');

      const msg = vi.mocked(sender.send).mock.calls[0]![1] as string;
      // should say "1 concept" not "1 concepts"
      expect(msg).toMatch(/1 concept[^s]/);
    });

    it('shows plural "concepts" when pool has multiple entries', async () => {
      mockReadPool.mockReturnValue(['a.md', 'b.md']);
      mockSelectDueConcepts.mockReturnValue([]);

      const sender = makeSender();
      await handleStudy(sender, USER_ID, 'status');

      const msg = vi.mocked(sender.send).mock.calls[0]![1] as string;
      expect(msg).toContain('concepts');
    });
  });

  describe('/study status — empty pool short-circuit', () => {
    it('sends zero-count message directly without calling readSRState or selectDueConcepts', async () => {
      mockReadPool.mockReturnValue([]);

      const sender = makeSender();
      await handleStudy(sender, USER_ID, 'status');

      expect(sender.send).toHaveBeenCalledOnce();
      const [, msg] = vi.mocked(sender.send).mock.calls[0]!;
      expect(msg).toBe('SR pool: 0 concepts · due today: 0');
      expect(mockReadSRState).not.toHaveBeenCalled();
      expect(mockSelectDueConcepts).not.toHaveBeenCalled();
    });
  });

  describe('/study status — error handling', () => {
    it('catches readSRState error and sends generic message instead of throwing', async () => {
      mockReadPool.mockReturnValue(['concept/a.md']);
      mockReadSRState.mockImplementation(() => { throw new Error('state file corrupt'); });

      const sender = makeSender();
      await expect(handleStudy(sender, USER_ID, 'status')).resolves.not.toThrow();

      expect(sender.send).toHaveBeenCalledOnce();
      const [, msg] = vi.mocked(sender.send).mock.calls[0]!;
      expect(msg).toBe('Could not read study status — see the logs.');
    });

    it('catches readPool error and sends generic message instead of throwing', async () => {
      mockReadPool.mockImplementation(() => { throw new Error('seed file missing'); });

      const sender = makeSender();
      await expect(handleStudy(sender, USER_ID, 'status')).resolves.not.toThrow();

      expect(sender.send).toHaveBeenCalledOnce();
      const [, msg] = vi.mocked(sender.send).mock.calls[0]!;
      expect(msg).toBe('Could not read study status — see the logs.');
    });
  });

  describe('/study foo → unrecognized non-numeric arg', () => {
    it('sends the USAGE string', async () => {
      const sender = makeSender();
      await handleStudy(sender, USER_ID, 'foo');

      expect(sender.send).toHaveBeenCalledOnce();
      const msg = vi.mocked(sender.send).mock.calls[0]![1] as string;
      expect(msg).toContain('/study');
    });

    it('does NOT call runSRSession', async () => {
      const sender = makeSender();
      await handleStudy(sender, USER_ID, 'foo');

      expect(mockRunSRSession).not.toHaveBeenCalled();
    });

    it('does not throw', async () => {
      const sender = makeSender();
      await expect(handleStudy(sender, USER_ID, 'foo')).resolves.not.toThrow();
    });

    it('also handles mixed-case unrecognized args', async () => {
      const sender = makeSender();
      await handleStudy(sender, USER_ID, 'FOO');

      expect(mockRunSRSession).not.toHaveBeenCalled();
      expect(sender.send).toHaveBeenCalledOnce();
    });
  });
});
