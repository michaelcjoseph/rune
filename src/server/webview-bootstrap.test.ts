import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MessageSender } from '../transport/sender.js';

vi.mock('../bot/handlers/text.js', () => ({ dispatchText: vi.fn() }));

const { dispatchText } = await import('../bot/handlers/text.js');
const { handleWebviewMessage } = await import('./webview-bootstrap.js');

function sender(): MessageSender {
  return {
    name: 'webview',
    send: vi.fn().mockResolvedValue(undefined),
    startTyping: vi.fn(),
    stopTyping: vi.fn(),
  };
}

describe('server/webview-bootstrap', () => {
  beforeEach(() => vi.clearAllMocks());

  it('forwards product scope from webview frames into the shared text dispatcher', async () => {
    const scope = { kind: 'product' as const, product: 'jarvis' };

    await (handleWebviewMessage as any)(sender(), 42, 'hello from product chat', scope);

    expect(dispatchText).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'webview' }),
      42,
      'hello from product chat',
      scope,
    );
  });
});
