import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MorningPrepResult } from '../../jobs/morning-prep.js';

const mockExecuteMorningPrep = vi.fn<() => Promise<MorningPrepResult>>();
const mockStartTyping = vi.fn(() => setInterval(() => {}, 99999));
const mockStopTyping = vi.fn((i: NodeJS.Timeout) => clearInterval(i));

vi.mock('../../jobs/morning-prep.js', () => ({
  executeMorningPrep: mockExecuteMorningPrep,
}));

vi.mock('../../integrations/telegram/client.js', () => ({
  startTyping: mockStartTyping,
  stopTyping: mockStopTyping,
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

function mockBot() {
  return { sendMessage: vi.fn().mockResolvedValue(undefined) } as any;
}

const CHAT_ID = 100;

describe('handlePrep', () => {
  beforeEach(() => vi.clearAllMocks());

  it('sends success message when executeMorningPrep returns written', async () => {
    mockExecuteMorningPrep.mockResolvedValue({ status: 'written', filepath: '/vault/journals/2026_04_09.md' });
    const bot = mockBot();

    await handlePrep(bot, CHAT_ID);

    expect(mockExecuteMorningPrep).toHaveBeenCalledOnce();
    expect(mockStopTyping).toHaveBeenCalled();
    expect(bot.sendMessage).toHaveBeenCalledWith(CHAT_ID, 'Morning prep complete. Your journal is ready.');
  });

  it('sends skipped message when executeMorningPrep returns skipped', async () => {
    mockExecuteMorningPrep.mockResolvedValue({ status: 'skipped', filepath: '/vault/journals/2026_04_09.md' });
    const bot = mockBot();

    await handlePrep(bot, CHAT_ID);

    expect(mockStopTyping).toHaveBeenCalled();
    expect(bot.sendMessage).toHaveBeenCalledWith(CHAT_ID, 'Morning prep already written today.');
  });

  it('sends error message when executeMorningPrep throws', async () => {
    mockExecuteMorningPrep.mockRejectedValue(new Error('vault not found'));
    const bot = mockBot();

    await handlePrep(bot, CHAT_ID);

    expect(mockStopTyping).toHaveBeenCalled();
    expect(bot.sendMessage).toHaveBeenCalledWith(CHAT_ID, 'Morning prep failed: vault not found');
  });

  it('starts typing before executeMorningPrep and stops after', async () => {
    const callOrder: string[] = [];
    mockStartTyping.mockImplementation((..._args: any[]) => {
      callOrder.push('startTyping');
      return setInterval(() => {}, 99999);
    });
    mockExecuteMorningPrep.mockImplementation(async () => {
      callOrder.push('executeMorningPrep');
      return { status: 'written' as const, filepath: '/vault/journals/2026_04_09.md' };
    });
    mockStopTyping.mockImplementation((..._args: any[]) => {
      callOrder.push('stopTyping');
    });
    const bot = mockBot();

    await handlePrep(bot, CHAT_ID);

    expect(callOrder).toEqual(['startTyping', 'executeMorningPrep', 'stopTyping']);
  });
});
