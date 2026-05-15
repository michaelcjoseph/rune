import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MessageSender } from '../../transport/sender.js';

vi.mock('../../utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../../ai/claude.js', () => ({
  askClaudeOneShot: vi.fn(),
}));

const { askClaudeOneShot } = await import('../../ai/claude.js');
const { handleAsk } = await import('./ask.js');

function makeSender(): MessageSender {
  return {
    name: 'telegram' as const,
    send: vi.fn().mockResolvedValue(undefined),
    startTyping: vi.fn(),
    stopTyping: vi.fn(),
  };
}

const USER_ID = 42;

describe('handleAsk', () => {
  beforeEach(() => vi.clearAllMocks());

  it('calls startTyping with "Asking Claude" label before invoking askClaudeOneShot', async () => {
    vi.mocked(askClaudeOneShot).mockResolvedValue({ text: 'answer', error: null });
    const sender = makeSender();

    await handleAsk(sender, USER_ID, 'what is the meaning of life');

    expect(sender.startTyping).toHaveBeenCalledWith(USER_ID, 'Asking Claude');
  });

  it('calls stopTyping after askClaudeOneShot resolves', async () => {
    vi.mocked(askClaudeOneShot).mockResolvedValue({ text: 'answer', error: null });
    const sender = makeSender();

    await handleAsk(sender, USER_ID, 'question');

    expect(sender.stopTyping).toHaveBeenCalledWith(USER_ID);
  });

  it('sends the answer text on success', async () => {
    vi.mocked(askClaudeOneShot).mockResolvedValue({ text: '42 is the answer', error: null });
    const sender = makeSender();

    await handleAsk(sender, USER_ID, 'ultimate question');

    expect(sender.send).toHaveBeenCalledWith(USER_ID, '42 is the answer');
  });

  it('sends an error message when result.error is set', async () => {
    vi.mocked(askClaudeOneShot).mockResolvedValue({ text: null, error: 'Claude timed out' });
    const sender = makeSender();

    await handleAsk(sender, USER_ID, 'question');

    expect(sender.send).toHaveBeenCalledWith(USER_ID, 'Error: Claude timed out');
  });

  it('calls stopTyping and sends error message when askClaudeOneShot throws', async () => {
    vi.mocked(askClaudeOneShot).mockRejectedValue(new Error('spawn failed'));
    const sender = makeSender();

    await handleAsk(sender, USER_ID, 'question');

    expect(sender.stopTyping).toHaveBeenCalledWith(USER_ID);
    expect(sender.send).toHaveBeenCalledWith(USER_ID, 'Error: spawn failed');
  });

  it('passes the question through to askClaudeOneShot with the "ask" opLabel', async () => {
    vi.mocked(askClaudeOneShot).mockResolvedValue({ text: 'ok', error: null });
    const sender = makeSender();

    await handleAsk(sender, USER_ID, 'how does photosynthesis work');

    expect(askClaudeOneShot).toHaveBeenCalledWith(
      'how does photosynthesis work',
      undefined,
      'ask',
      true,
    );
  });
});
