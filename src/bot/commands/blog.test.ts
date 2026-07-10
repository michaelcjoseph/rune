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

const { handleBlog } = await import('./blog.js');

function makeSender(name: 'telegram' | 'webview' = 'telegram'): MessageSender {
  return {
    name,
    send: vi.fn().mockResolvedValue(undefined),
    startTyping: vi.fn(),
    stopTyping: vi.fn(),
  } as unknown as MessageSender;
}

const CHAT_ID = 100;

describe('handleBlog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateMutation.mockResolvedValue({
      ok: true,
      descriptor: { id: 'abcdef12-3456-7890-abcd-ef1234567890' },
    });
  });

  it('shows usage when no topic provided', async () => {
    const sender = makeSender();

    await handleBlog(sender, CHAT_ID, '');

    expect(sender.send).toHaveBeenCalledWith(CHAT_ID, 'Usage: /blog <topic>');
    expect(mockCreateMutation).not.toHaveBeenCalled();
  });

  it('rejects a topic with no alphanumeric characters without dispatching', async () => {
    const sender = makeSender();

    await handleBlog(sender, CHAT_ID, '???');

    expect(mockCreateMutation).not.toHaveBeenCalled();
    expect(sender.send).toHaveBeenCalledWith(CHAT_ID, expect.stringContaining('alphanumeric'));
  });

  it('dispatches a writing mutation and acks immediately with branch + short id', async () => {
    const sender = makeSender();

    await handleBlog(sender, CHAT_ID, 'why testing matters');

    expect(mockCreateMutation).toHaveBeenCalledOnce();
    expect(mockCreateMutation).toHaveBeenCalledWith('writing', {
      command: 'blog',
      chatId: CHAT_ID,
      product: 'writing',
      projectSlug: 'why-testing-matters',
      topic: 'why testing matters',
    }, 'cli');
    const ack = (sender.send as ReturnType<typeof vi.fn>).mock.calls[0]![1] as string;
    expect(ack).toContain('✍️ Writing run started for "why testing matters"');
    expect(ack).toContain('rune-writing/why-testing-matters');
    expect(ack).toContain('abcdef12');
  });

  it('uses the webview source when dispatched from the cockpit sender', async () => {
    const sender = makeSender('webview');

    await handleBlog(sender, CHAT_ID, 'topic');

    expect(mockCreateMutation).toHaveBeenCalledWith('writing', expect.anything(), 'webview');
  });

  it('surfaces a validation rejection instead of staying silent', async () => {
    mockCreateMutation.mockResolvedValue({ ok: false, reason: 'blog requires a non-empty topic' });
    const sender = makeSender();

    await handleBlog(sender, CHAT_ID, 'topic');

    expect(sender.send).toHaveBeenCalledWith(
      CHAT_ID,
      expect.stringContaining('Could not start the writing run: blog requires a non-empty topic'),
    );
  });
});
