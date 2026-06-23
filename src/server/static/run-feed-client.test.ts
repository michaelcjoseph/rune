import { describe, expect, it, vi } from 'vitest';

const RUN_ID = 'run-live-001';
const OTHER_RUN_ID = 'run-live-002';

class FakeWebSocket {
  private readonly listeners = new Map<string, Set<(event: any) => unknown>>();

  addEventListener(type: string, listener: (event: any) => unknown) {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: (event: any) => unknown) {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type: string, event: any) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }

  listenerCount(type: string) {
    return this.listeners.get(type)?.size ?? 0;
  }
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    runId: RUN_ID,
    product: 'aura',
    target: { kind: 'project', slug: '01-mvp' },
    state: 'running',
    tasks: { done: 3, total: 7 },
    elapsedMs: 65_000,
    worktreePath: '/test/worktrees/aura-01-mvp',
    agents: [{ role: 'qa', active: true, model: 'claude' }],
    lastLogLines: ['qa started'],
    ts: '2026-06-23T12:01:05.000Z',
    ...overrides,
  };
}

describe('run-feed client subscription module (cockpit redesign Phase 2)', () => {
  it('parses run-event websocket frames and ignores unrelated frames', async () => {
    const { parseRunFeedFrame } = await import('./run-feed-client.js');
    const event = {
      kind: 'run-event',
      subKind: 'progress',
      runId: RUN_ID,
      product: 'aura',
      target: { kind: 'project', slug: '01-mvp' },
      tasks: { done: 4, total: 7 },
      ts: '2026-06-23T12:01:10.000Z',
    };

    expect(parseRunFeedFrame(JSON.stringify(event))).toEqual(event);
    expect(parseRunFeedFrame(JSON.stringify({ kind: 'message', text: 'hello' }))).toBeNull();
    expect(parseRunFeedFrame('{not json')).toBeNull();
  });

  it('merges a live snapshot with streamed run events into one per-run state', async () => {
    const { createRunFeedState } = await import('./run-feed-client.js');
    const feed = createRunFeedState();

    feed.applySnapshot(snapshot());
    feed.applyEvent({
      kind: 'run-event',
      subKind: 'progress',
      runId: RUN_ID,
      product: 'aura',
      target: { kind: 'project', slug: '01-mvp' },
      tasks: { done: 4, total: 7 },
      ts: '2026-06-23T12:01:10.000Z',
    });
    feed.applyEvent({
      kind: 'run-event',
      subKind: 'agents',
      runId: RUN_ID,
      product: 'aura',
      target: { kind: 'project', slug: '01-mvp' },
      agents: [
        { role: 'qa', active: false, model: 'claude' },
        { role: 'coder', active: true, model: 'codex' },
      ],
      ts: '2026-06-23T12:01:12.000Z',
    } as any);
    feed.applyEvent({
      kind: 'run-event',
      subKind: 'log',
      runId: RUN_ID,
      product: 'aura',
      target: { kind: 'project', slug: '01-mvp' },
      lines: ['coder edited src/server/webview.ts'],
      ts: '2026-06-23T12:01:13.000Z',
    });
    feed.applyEvent({
      kind: 'run-event',
      subKind: 'state',
      runId: RUN_ID,
      product: 'aura',
      target: { kind: 'project', slug: '01-mvp' },
      state: 'completed',
      elapsedMs: 75_000,
      outcome: 'completed',
      ts: '2026-06-23T12:01:15.000Z',
    });

    expect(feed.getRun(RUN_ID)).toMatchObject({
      runId: RUN_ID,
      tasks: { done: 4, total: 7 },
      agents: [
        { role: 'qa', active: false, model: 'claude' },
        { role: 'coder', active: true, model: 'codex' },
      ],
      lastLogLines: ['qa started', 'coder edited src/server/webview.ts'],
      state: 'completed',
      elapsedMs: 75_000,
      outcome: 'completed',
    });
  });

  it('refetches /live on reconnect and ignores older duplicate task transitions', async () => {
    const { createRunFeedSubscription } = await import('./run-feed-client.js');
    const fetchLive = vi.fn()
      .mockResolvedValueOnce(snapshot({ tasks: { done: 3, total: 7 }, lastLogLines: ['qa started'] }))
      .mockResolvedValueOnce(snapshot({
        tasks: { done: 4, total: 7 },
        lastLogLines: ['qa started', 'coder edited src/server/webview.ts'],
        ts: '2026-06-23T12:01:20.000Z',
      }));
    const openStream = vi.fn(() => ({ close: vi.fn() }));
    const onState = vi.fn();

    const subscription = createRunFeedSubscription({ runId: RUN_ID, fetchLive, openStream, onState });
    await subscription.connect();
    subscription.applyEvent({
      kind: 'run-event',
      subKind: 'progress',
      runId: RUN_ID,
      product: 'aura',
      target: { kind: 'project', slug: '01-mvp' },
      tasks: { done: 4, total: 7 },
      ts: '2026-06-23T12:01:10.000Z',
    });

    await subscription.reconnect();
    subscription.applyEvent({
      kind: 'run-event',
      subKind: 'progress',
      runId: RUN_ID,
      product: 'aura',
      target: { kind: 'project', slug: '01-mvp' },
      tasks: { done: 3, total: 7 },
      ts: '2026-06-23T12:01:10.000Z',
    });

    expect(fetchLive).toHaveBeenCalledTimes(2);
    expect(openStream).toHaveBeenCalledTimes(2);
    expect(subscription.getState()).toMatchObject({
      runId: RUN_ID,
      tasks: { done: 4, total: 7 },
      lastLogLines: ['qa started', 'coder edited src/server/webview.ts'],
    });
    expect(onState).toHaveBeenCalledWith(expect.objectContaining({
      runId: RUN_ID,
      tasks: { done: 4, total: 7 },
    }));
  });

  it('uses the existing websocket and fetches the /live snapshot URL on connect and reconnect', async () => {
    const { createRunFeedSubscription } = await import('./run-feed-client.js');
    const socket = new FakeWebSocket();
    const fetchJson = vi.fn()
      .mockResolvedValueOnce(snapshot({ tasks: { done: 1, total: 7 }, lastLogLines: ['snapshot one'] }))
      .mockResolvedValueOnce(snapshot({
        tasks: { done: 5, total: 7 },
        lastLogLines: ['snapshot two'],
        ts: '2026-06-23T12:01:30.000Z',
      }));
    const onState = vi.fn();

    const subscription = (createRunFeedSubscription as any)({
      runId: RUN_ID,
      socket,
      fetchJson,
      onState,
    });

    await subscription.connect();

    expect(fetchJson).toHaveBeenCalledWith(`/api/work-runs/${RUN_ID}/live`);
    expect(socket.listenerCount('message')).toBe(1);
    expect(subscription.getState()).toMatchObject({
      runId: RUN_ID,
      tasks: { done: 1, total: 7 },
      lastLogLines: ['snapshot one'],
    });

    socket.emit('message', {
      data: JSON.stringify({
        kind: 'run-event',
        subKind: 'progress',
        runId: OTHER_RUN_ID,
        product: 'aura',
        target: { kind: 'bug', slug: 'BUG-9' },
        tasks: { done: 99, total: 99 },
        ts: '2026-06-23T12:01:09.000Z',
      }),
    });
    await flushMicrotasks();

    expect(onState).toHaveBeenCalledTimes(1);
    expect(subscription.getState()).toMatchObject({
      runId: RUN_ID,
      tasks: { done: 1, total: 7 },
    });

    socket.emit('message', {
      data: JSON.stringify({
        kind: 'run-event',
        subKind: 'progress',
        runId: RUN_ID,
        product: 'aura',
        target: { kind: 'project', slug: '01-mvp' },
        tasks: { done: 2, total: 7 },
        ts: '2026-06-23T12:01:10.000Z',
      }),
    });
    await flushMicrotasks();

    expect(subscription.getState()).toMatchObject({ tasks: { done: 2, total: 7 } });

    await subscription.reconnect();

    expect(fetchJson).toHaveBeenCalledTimes(2);
    expect(fetchJson).toHaveBeenLastCalledWith(`/api/work-runs/${RUN_ID}/live`);
    expect(socket.listenerCount('message')).toBe(1);
    expect(subscription.getState()).toMatchObject({
      runId: RUN_ID,
      tasks: { done: 5, total: 7 },
      lastLogLines: ['snapshot two'],
    });
  });

  it('keeps per-run state isolated and bounds live log tails to the configured line count', async () => {
    const { createRunFeedState } = await import('./run-feed-client.js');
    const feed = (createRunFeedState as any)({ maxLogLines: 3 });

    feed.applySnapshot(snapshot({ lastLogLines: ['line 1', 'line 2'] }));
    feed.applySnapshot(snapshot({
      runId: OTHER_RUN_ID,
      target: { kind: 'bug', slug: 'BUG-9' },
      tasks: { done: 0, total: 1 },
      lastLogLines: ['other run line'],
    }));
    feed.applyEvent({
      kind: 'run-event',
      subKind: 'log',
      runId: RUN_ID,
      product: 'aura',
      target: { kind: 'project', slug: '01-mvp' },
      lines: ['line 3', 'line 4', 'line 5'],
      ts: '2026-06-23T12:01:20.000Z',
    });

    expect(feed.getRun(RUN_ID)).toMatchObject({
      runId: RUN_ID,
      lastLogLines: ['line 3', 'line 4', 'line 5'],
    });
    expect(feed.getRun(OTHER_RUN_ID)).toMatchObject({
      runId: OTHER_RUN_ID,
      target: { kind: 'bug', slug: 'BUG-9' },
      lastLogLines: ['other run line'],
    });
  });
});
