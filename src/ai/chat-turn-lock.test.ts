import { describe, expect, it } from 'vitest';
import { withChatTurnLock } from './chat-turn-lock.js';

describe('withChatTurnLock', () => {
  it('serializes turns for one session while allowing distinct sessions to overlap', async () => {
    const events: string[] = [];
    let releaseFirst!: () => void;
    const blocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const first = withChatTurnLock('webview:1', async () => {
      events.push('first:start');
      await blocked;
      events.push('first:end');
    });
    const second = withChatTurnLock('webview:1', async () => { events.push('second'); });
    const other = withChatTurnLock('product:webview:1', async () => { events.push('other'); });
    await other;
    expect(events).toEqual(['first:start', 'other']);
    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual(['first:start', 'other', 'first:end', 'second']);
  });

  it('continues the queue after a failed turn', async () => {
    const first = withChatTurnLock('telegram:2', async () => { throw new Error('failed'); });
    const second = withChatTurnLock('telegram:2', async () => 'recovered');
    await expect(first).rejects.toThrow('failed');
    await expect(second).resolves.toBe('recovered');
  });
});
