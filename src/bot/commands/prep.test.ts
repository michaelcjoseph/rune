import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MorningPrepResult } from '../../jobs/morning-prep.js';
import type { MessageSender } from '../../transport/sender.js';

const mockExecuteMorningPrep = vi.fn<() => Promise<MorningPrepResult>>();

vi.mock('../../jobs/morning-prep.js', () => ({
  executeMorningPrep: mockExecuteMorningPrep,
}));

vi.mock('../../utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const { handlePrep } = await import('./prep.js');

function makeSender(): MessageSender {
  return {
    name: 'telegram' as const,
    send: vi.fn().mockResolvedValue(undefined),
    startTyping: vi.fn(),
    stopTyping: vi.fn(),
  };
}

const CHAT_ID = 100;

describe('handlePrep', () => {
  beforeEach(() => vi.clearAllMocks());

  it('sends success message when executeMorningPrep returns written', async () => {
    mockExecuteMorningPrep.mockResolvedValue({ status: 'written', filepath: '/vault/journals/2026_04_09.md' });
    const sender = makeSender();

    await handlePrep(sender, CHAT_ID);

    expect(mockExecuteMorningPrep).toHaveBeenCalledOnce();
    expect(sender.stopTyping).toHaveBeenCalled();
    expect(sender.send).toHaveBeenCalledWith(CHAT_ID, 'Morning prep complete. Your journal is ready.');
  });

  it('sends skipped message when executeMorningPrep returns skipped', async () => {
    mockExecuteMorningPrep.mockResolvedValue({ status: 'skipped', filepath: '/vault/journals/2026_04_09.md' });
    const sender = makeSender();

    await handlePrep(sender, CHAT_ID);

    expect(sender.stopTyping).toHaveBeenCalled();
    expect(sender.send).toHaveBeenCalledWith(CHAT_ID, 'Morning prep already written today.');
  });

  it('sends fallback message with synth error when executeMorningPrep returns fallback', async () => {
    mockExecuteMorningPrep.mockResolvedValue({
      status: 'fallback',
      filepath: '/vault/journals/2026_04_09.md',
      synthError: 'Claude timed out after 120s',
    });
    const sender = makeSender();

    await handlePrep(sender, CHAT_ID);

    expect(sender.stopTyping).toHaveBeenCalled();
    const call = vi.mocked(sender.send).mock.calls[0];
    expect(call?.[0]).toBe(CHAT_ID);
    expect(call?.[1]).toContain('fallback');
    expect(call?.[1]).toContain('Claude timed out after 120s');
  });

  it('sends error message when executeMorningPrep throws', async () => {
    mockExecuteMorningPrep.mockRejectedValue(new Error('vault not found'));
    const sender = makeSender();

    await handlePrep(sender, CHAT_ID);

    expect(sender.stopTyping).toHaveBeenCalled();
    expect(sender.send).toHaveBeenCalledWith(CHAT_ID, 'Morning prep failed: vault not found');
  });

  it('starts typing before executeMorningPrep and stops after', async () => {
    const callOrder: string[] = [];
    const sender: MessageSender = {
      name: 'telegram' as const,
      send: vi.fn().mockResolvedValue(undefined),
      startTyping: vi.fn().mockImplementation(() => { callOrder.push('startTyping'); }),
      stopTyping: vi.fn().mockImplementation(() => { callOrder.push('stopTyping'); }),
    };
    mockExecuteMorningPrep.mockImplementation(async () => {
      callOrder.push('executeMorningPrep');
      return { status: 'written' as const, filepath: '/vault/journals/2026_04_09.md' };
    });

    await handlePrep(sender, CHAT_ID);

    expect(callOrder).toEqual(['startTyping', 'executeMorningPrep', 'stopTyping']);
  });
});
