import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MessageSender } from '../../transport/sender.js';

// Mock logger
vi.mock('../../utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Mock in-flight so we don't spin up real child processes
const mockCancelMostRecentForUser = vi.fn();
const mockCancelByPrefix = vi.fn();

vi.mock('../../transport/in-flight.js', () => ({
  cancelMostRecentForUser: mockCancelMostRecentForUser,
  cancelByPrefix: mockCancelByPrefix,
  CANCEL_PREFIX_MIN_CHARS: 4,
}));

const { handleCancel } = await import('./cancel.js');

function mockSender(): MessageSender {
  return {
    name: 'telegram' as const,
    send: vi.fn().mockResolvedValue(undefined),
    startTyping: vi.fn(),
    stopTyping: vi.fn(),
  };
}

function makePublicOp(overrides: Record<string, unknown> = {}) {
  return {
    opId: 'abc123de-dead-beef-0000-000000000000',
    kind: 'agent' as const,
    label: 'wiki-compiler',
    userId: 42,
    startedAt: '2026-05-14T12:00:00.000Z',
    elapsedMs: 3500,
    ...overrides,
  };
}

describe('handleCancel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCancelMostRecentForUser.mockReturnValue(null);
    mockCancelByPrefix.mockReturnValue(null);
  });

  describe('bare /cancel (no prefix)', () => {
    it('calls cancelMostRecentForUser with the userId', async () => {
      const sender = mockSender();
      await handleCancel(sender, 42, '');
      expect(mockCancelMostRecentForUser).toHaveBeenCalledOnce();
      expect(mockCancelMostRecentForUser).toHaveBeenCalledWith(42);
    });

    it('does not call cancelByPrefix when arg is empty', async () => {
      await handleCancel(mockSender(), 42, '');
      expect(mockCancelByPrefix).not.toHaveBeenCalled();
    });

    it('sends "No active operations." when no ops are active', async () => {
      mockCancelMostRecentForUser.mockReturnValue(null);
      const sender = mockSender();
      await handleCancel(sender, 42, '');
      expect(sender.send).toHaveBeenCalledOnce();
      expect(sender.send).toHaveBeenCalledWith(42, 'No active operations.');
    });

    it('sends a confirmation message including the op label and short id', async () => {
      const op = makePublicOp({ label: 'wiki-compiler', opId: 'abc123de-dead-beef-0000-000000000000' });
      mockCancelMostRecentForUser.mockReturnValue(op);
      const sender = mockSender();
      await handleCancel(sender, 42, '');
      const msg = vi.mocked(sender.send).mock.calls[0]![1] as string;
      expect(msg).toContain('wiki-compiler');
      expect(msg).toContain('abc123de'); // first 8 chars of opId
    });

    it('handles arg with whitespace only as bare cancel', async () => {
      // '   '.trim() === '' so it should behave like bare /cancel
      await handleCancel(mockSender(), 42, '   ');
      expect(mockCancelMostRecentForUser).toHaveBeenCalledWith(42);
      expect(mockCancelByPrefix).not.toHaveBeenCalled();
    });
  });

  describe('/cancel <prefix>', () => {
    it('calls cancelByPrefix with the trimmed prefix', async () => {
      const sender = mockSender();
      await handleCancel(sender, 42, 'abc123de');
      expect(mockCancelByPrefix).toHaveBeenCalledOnce();
      expect(mockCancelByPrefix).toHaveBeenCalledWith('abc123de');
    });

    it('does not call cancelMostRecentForUser when a prefix is given', async () => {
      await handleCancel(mockSender(), 42, 'abc123de');
      expect(mockCancelMostRecentForUser).not.toHaveBeenCalled();
    });

    it('sends a "no matching op" message when cancelByPrefix returns null', async () => {
      mockCancelByPrefix.mockReturnValue(null);
      const sender = mockSender();
      await handleCancel(sender, 42, 'xyz9');
      const msg = vi.mocked(sender.send).mock.calls[0]![1] as string;
      expect(msg).toContain('xyz9');
      expect(msg).toContain('No active operation matching');
    });

    it('sends a confirmation when cancelByPrefix finds a match', async () => {
      const op = makePublicOp({ label: 'kb-query', opId: 'ff00aa11-bbcc-ddee-0011-223344556677' });
      mockCancelByPrefix.mockReturnValue(op);
      const sender = mockSender();
      await handleCancel(sender, 42, 'ff00aa11');
      const msg = vi.mocked(sender.send).mock.calls[0]![1] as string;
      expect(msg).toContain('kb-query');
      expect(msg).toContain('ff00aa11'); // first 8 chars of opId
    });
  });
});
