/**
 * Project 13 Phase 1c — the Telegram `work-run-release:<id>` callback (test-plan
 * §3). It delegates to the SAME shared release runtime (`requestWorkRunRelease`)
 * the cockpit route and inbox row use, so the two surfaces can't drift.
 *
 * Written TEST-FIRST: `dispatchTelegramWorkRunRelease` is a no-op stub until the
 * implementation lands, so the delegation + reply cases are RED; the
 * `parseWorkRunReleaseCallback` parser cases pass (it is implemented up-front so
 * the callback wiring can route).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// The shared release runtime is the surface the callback delegates to; mock it
// so the test asserts delegation without the real supervision/mutation chain.
const mockRequestWorkRunRelease = vi.fn();
const mockFormatReply = vi.fn((o: { kind: string }) => `reply:${o.kind}`);
vi.mock('../jobs/work-run-release.js', () => ({
  requestWorkRunRelease: mockRequestWorkRunRelease,
  formatReleaseRequestReply: mockFormatReply,
  defaultReleaseRequestDeps: vi.fn(() => ({})),
}));

const { parseWorkRunReleaseCallback, dispatchTelegramWorkRunRelease } = await import('./work-run-release-callback.js');

describe('parseWorkRunReleaseCallback', () => {
  it('parses a plain release callback as confirmDirty:false', () => {
    expect(parseWorkRunReleaseCallback('work-run-release:run-1')).toEqual({ runId: 'run-1', confirmDirty: false });
  });

  it('parses a -confirm release callback as confirmDirty:true', () => {
    expect(parseWorkRunReleaseCallback('work-run-release-confirm:run-1')).toEqual({ runId: 'run-1', confirmDirty: true });
  });

  it('returns null for an unrelated callback (falls through to other routing)', () => {
    expect(parseWorkRunReleaseCallback('intent-proposal:0')).toBeNull();
    expect(parseWorkRunReleaseCallback('work-run-release:')).toBeNull();
  });
});

describe('dispatchTelegramWorkRunRelease', () => {
  beforeEach(() => {
    mockRequestWorkRunRelease.mockReset();
    mockFormatReply.mockClear();
  });

  it('delegates a plain release callback to the shared runtime and replies', async () => {
    mockRequestWorkRunRelease.mockResolvedValue({ kind: 'created', runId: 'run-1', mutationId: 'rel-1' });
    const send = vi.fn(async (_u: number, _t: string) => {});
    await dispatchTelegramWorkRunRelease(send, 42, 'work-run-release:run-1');
    expect(mockRequestWorkRunRelease).toHaveBeenCalledOnce();
    expect(mockRequestWorkRunRelease.mock.calls[0]![0]).toBe('run-1');
    // confirmDirty:false for a plain (non-confirm) callback.
    expect(mockRequestWorkRunRelease.mock.calls[0]![1]).toEqual({ confirmDirty: false });
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]![1]).toContain('created');
  });

  it('passes confirmDirty:true for a -confirm callback', async () => {
    mockRequestWorkRunRelease.mockResolvedValue({ kind: 'created', runId: 'run-1', mutationId: 'rel-2' });
    const send = vi.fn(async (_u: number, _t: string) => {});
    await dispatchTelegramWorkRunRelease(send, 42, 'work-run-release-confirm:run-1');
    expect(mockRequestWorkRunRelease.mock.calls[0]![1]).toEqual({ confirmDirty: true });
  });
});
