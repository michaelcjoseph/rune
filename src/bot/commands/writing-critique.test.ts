import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MessageSender } from '../../transport/sender.js';

const mockStartWritingProductRun = vi.fn<() => Promise<void>>();

vi.mock('../../jobs/writing-product-orchestration.js', () => ({
  startWritingProductRun: mockStartWritingProductRun,
}));

vi.mock('../../utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

type WritingCritiqueCommand = {
  handleWritingCritique: (sender: MessageSender, userId: number, args: string) => Promise<void>;
};

async function requireWritingCritiqueCommand(): Promise<WritingCritiqueCommand> {
  const specifier = './writing-critique' + '.js';
  try {
    const mod = await import(/* @vite-ignore */ specifier) as Record<string, unknown>;
    if (typeof mod.handleWritingCritique === 'function') {
      return {
        handleWritingCritique: mod.handleWritingCritique as WritingCritiqueCommand['handleWritingCritique'],
      };
    }
  } catch {
    // Fall through to a clean assertion failure below.
  }
  expect.fail(
    'src/bot/commands/writing-critique.ts must export handleWritingCritique before implementation can pass',
  );
}

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
  beforeEach(() => vi.clearAllMocks());

  it('shows usage when no target is provided', async () => {
    const { handleWritingCritique } = await requireWritingCritiqueCommand();
    const sender = makeSender();

    await handleWritingCritique(sender, CHAT_ID, '');

    expect(sender.send).toHaveBeenCalledWith(CHAT_ID, 'Usage: /writing-critique <target>');
    expect(mockStartWritingProductRun).not.toHaveBeenCalled();
  });

  it('starts the specialized writing product pipeline for critique output', async () => {
    const { handleWritingCritique } = await requireWritingCritiqueCommand();
    mockStartWritingProductRun.mockResolvedValue(undefined);
    const sender = makeSender();

    await handleWritingCritique(sender, CHAT_ID, 'draft about memory');

    expect(mockStartWritingProductRun).toHaveBeenCalledOnce();
    expect(mockStartWritingProductRun).toHaveBeenCalledWith({
      command: 'writing-critique',
      chatId: CHAT_ID,
      target: 'draft about memory',
      outputPath: 'docs/rune/critiques/draft-about-memory.md',
      revisionRequested: false,
    });
    expect(sender.send).not.toHaveBeenCalled();
  });

  it('derives the critique artifact slug from a target path basename', async () => {
    const { handleWritingCritique } = await requireWritingCritiqueCommand();
    mockStartWritingProductRun.mockResolvedValue(undefined);
    const sender = makeSender();

    await handleWritingCritique(sender, CHAT_ID, 'docs/rune/Operating From Memory.md');

    expect(mockStartWritingProductRun).toHaveBeenCalledWith({
      command: 'writing-critique',
      chatId: CHAT_ID,
      target: 'docs/rune/Operating From Memory.md',
      outputPath: 'docs/rune/critiques/operating-from-memory.md',
      revisionRequested: false,
    });
  });

  it('propagates an explicit revision request without folding the flag into the target slug', async () => {
    const { handleWritingCritique } = await requireWritingCritiqueCommand();
    mockStartWritingProductRun.mockResolvedValue(undefined);
    const sender = makeSender();

    await handleWritingCritique(sender, CHAT_ID, '--revise docs/rune/Operating From Memory.md');

    expect(mockStartWritingProductRun).toHaveBeenCalledWith({
      command: 'writing-critique',
      chatId: CHAT_ID,
      target: 'docs/rune/Operating From Memory.md',
      outputPath: 'docs/rune/critiques/operating-from-memory.md',
      revisionRequested: true,
    });
  });
});
