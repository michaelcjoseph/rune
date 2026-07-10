import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MessageSender } from '../../transport/sender.js';

const mockCreateMutation = vi.fn<() => Promise<unknown>>();

vi.mock('../../transport/mutations.js', () => ({
  createMutation: mockCreateMutation,
}));

vi.mock('../../utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const { handleWritingCritique } = await import('./writing-critique.js');

function makeSender(): MessageSender {
  return {
    name: 'telegram' as const,
    send: vi.fn().mockResolvedValue(undefined),
    startTyping: vi.fn(),
    stopTyping: vi.fn(),
  };
}

const CHAT_ID = 100;

describe('handleWritingCritique', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateMutation.mockResolvedValue({
      ok: true,
      descriptor: { id: 'abcdef12-3456-7890-abcd-ef1234567890' },
    });
  });

  it('shows usage when no target is provided', async () => {
    const sender = makeSender();

    await handleWritingCritique(sender, CHAT_ID, '');

    expect(sender.send).toHaveBeenCalledWith(CHAT_ID, 'Usage: /writing-critique <target>');
    expect(mockCreateMutation).not.toHaveBeenCalled();
  });

  it('dispatches a writing mutation for critique output and acks immediately', async () => {
    const sender = makeSender();

    await handleWritingCritique(sender, CHAT_ID, 'draft about memory');

    expect(mockCreateMutation).toHaveBeenCalledOnce();
    expect(mockCreateMutation).toHaveBeenCalledWith('writing', {
      command: 'writing-critique',
      chatId: CHAT_ID,
      product: 'writing',
      projectSlug: 'draft-about-memory',
      critiqueTarget: 'draft about memory',
      outputPath: 'docs/rune/critiques/draft-about-memory.md',
      revisionRequested: false,
    }, 'cli');
    const ack = (sender.send as ReturnType<typeof vi.fn>).mock.calls[0]![1] as string;
    expect(ack).toContain('✍️ Critique run started');
    expect(ack).toContain('rune-writing/draft-about-memory');
    expect(ack).toContain('abcdef12');
  });

  it('derives the critique slug from a target path basename — same branch as the draft', async () => {
    const sender = makeSender();

    await handleWritingCritique(sender, CHAT_ID, 'docs/rune/Operating From Memory.md');

    expect(mockCreateMutation).toHaveBeenCalledWith('writing', expect.objectContaining({
      projectSlug: 'operating-from-memory',
      critiqueTarget: 'docs/rune/Operating From Memory.md',
      outputPath: 'docs/rune/critiques/operating-from-memory.md',
      revisionRequested: false,
    }), 'cli');
  });

  it('propagates an explicit revision request without folding the flag into the target slug', async () => {
    const sender = makeSender();

    await handleWritingCritique(sender, CHAT_ID, '--revise docs/rune/Operating From Memory.md');

    expect(mockCreateMutation).toHaveBeenCalledWith('writing', expect.objectContaining({
      critiqueTarget: 'docs/rune/Operating From Memory.md',
      outputPath: 'docs/rune/critiques/operating-from-memory.md',
      revisionRequested: true,
    }), 'cli');
  });

  it('surfaces a validation rejection instead of staying silent', async () => {
    mockCreateMutation.mockResolvedValue({ ok: false, reason: 'outputPath must live under docs/rune/critiques/' });
    const sender = makeSender();

    await handleWritingCritique(sender, CHAT_ID, 'draft about memory');

    expect(sender.send).toHaveBeenCalledWith(
      CHAT_ID,
      expect.stringContaining('Could not start the critique run'),
    );
  });
});
