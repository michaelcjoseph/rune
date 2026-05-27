/**
 * Test suite for `src/jobs/stall-check.ts` — the periodic check that scans
 * persisted SupervisedRuns for stalled entries and emits a Telegram nudge
 * for newly-stalled ones (without re-spamming on subsequent passes).
 *
 * Written test-first; the implementation file does not exist yet — every
 * test must fail with a missing-module / missing-export error.
 *
 * The suite focuses on the pure `checkStalledRuns` core; the setInterval
 * wrapper is glue and isn't tested here.
 */

import { describe, it, expect, vi } from 'vitest';
import type { SupervisedRun } from '../intent/supervision.js';

import { checkStalledRuns, formatStallNudge, STALL_THRESHOLD_MS } from './stall-check.js';

function makeRun(id: string, overrides: Partial<SupervisedRun> = {}): SupervisedRun {
  return {
    id,
    product: 'aura',
    project: '01-test',
    status: 'running',
    startedAt: '2026-01-01T00:00:00.000Z',
    lastHeartbeatAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const NOW = 2_000_000_000_000; // some fixed epoch ms

/** A heartbeat string that is `ageMs` old relative to NOW. */
function heartbeatAge(ageMs: number): string {
  return new Date(NOW - ageMs).toISOString();
}

describe('checkStalledRuns', () => {
  it('returns the same nudged-set and sends no nudges when no run is stalled', () => {
    const readRuns = () => [
      makeRun('run-a', { lastHeartbeatAt: heartbeatAge(60_000) }), // 1 min old, fresh
    ];
    const sendNudge = vi.fn();
    const alreadyNudged = new Set<string>();

    const next = checkStalledRuns({
      readRuns,
      now: NOW,
      stallThresholdMs: STALL_THRESHOLD_MS,
      alreadyNudged,
      sendNudge,
    });

    expect(sendNudge).not.toHaveBeenCalled();
    expect(next.size).toBe(0);
  });

  it('sends a nudge for a newly-stalled run and adds its id to the nudged set', () => {
    const readRuns = () => [
      makeRun('run-stale', { lastHeartbeatAt: heartbeatAge(10 * 60_000) }), // 10 min — stalled
    ];
    const sendNudge = vi.fn();
    const alreadyNudged = new Set<string>();

    const next = checkStalledRuns({
      readRuns,
      now: NOW,
      stallThresholdMs: STALL_THRESHOLD_MS,
      alreadyNudged,
      sendNudge,
    });

    expect(sendNudge).toHaveBeenCalledOnce();
    const [arg] = sendNudge.mock.calls[0]!;
    expect((arg as SupervisedRun).id).toBe('run-stale');
    expect(next.has('run-stale')).toBe(true);
  });

  it('does NOT re-nudge a run that is already in the nudged set', () => {
    const readRuns = () => [
      makeRun('run-stale', { lastHeartbeatAt: heartbeatAge(10 * 60_000) }),
    ];
    const sendNudge = vi.fn();
    const alreadyNudged = new Set<string>(['run-stale']);

    const next = checkStalledRuns({
      readRuns,
      now: NOW,
      stallThresholdMs: STALL_THRESHOLD_MS,
      alreadyNudged,
      sendNudge,
    });

    expect(sendNudge).not.toHaveBeenCalled();
    // The id stays in the nudged set — still stalled, still tracked
    expect(next.has('run-stale')).toBe(true);
  });

  it('removes a run from the nudged set when it is no longer stalled (so re-stall re-nudges)', () => {
    // Run was nudged previously; this pass shows it as recently-active again.
    const readRuns = () => [
      makeRun('run-stale', { lastHeartbeatAt: heartbeatAge(30_000) }), // 30s — fresh
    ];
    const sendNudge = vi.fn();
    const alreadyNudged = new Set<string>(['run-stale']);

    const next = checkStalledRuns({
      readRuns,
      now: NOW,
      stallThresholdMs: STALL_THRESHOLD_MS,
      alreadyNudged,
      sendNudge,
    });

    expect(sendNudge).not.toHaveBeenCalled();
    expect(next.has('run-stale')).toBe(false);
  });

  it('removes a run from the nudged set when it has reached a terminal state', () => {
    const readRuns = () => [
      makeRun('run-was-stalled', {
        status: 'completed',
        lastHeartbeatAt: heartbeatAge(10 * 60_000),
      }),
    ];
    const sendNudge = vi.fn();
    const alreadyNudged = new Set<string>(['run-was-stalled']);

    const next = checkStalledRuns({
      readRuns,
      now: NOW,
      stallThresholdMs: STALL_THRESHOLD_MS,
      alreadyNudged,
      sendNudge,
    });

    expect(sendNudge).not.toHaveBeenCalled();
    expect(next.has('run-was-stalled')).toBe(false);
  });

  it('handles multiple newly-stalled runs in one pass', () => {
    const readRuns = () => [
      makeRun('run-a', { lastHeartbeatAt: heartbeatAge(10 * 60_000) }),
      makeRun('run-b', { lastHeartbeatAt: heartbeatAge(20 * 60_000) }),
      makeRun('run-c', { lastHeartbeatAt: heartbeatAge(60_000) }), // fresh
    ];
    const sendNudge = vi.fn();
    const alreadyNudged = new Set<string>();

    const next = checkStalledRuns({
      readRuns,
      now: NOW,
      stallThresholdMs: STALL_THRESHOLD_MS,
      alreadyNudged,
      sendNudge,
    });

    expect(sendNudge).toHaveBeenCalledTimes(2);
    expect(next.has('run-a')).toBe(true);
    expect(next.has('run-b')).toBe(true);
    expect(next.has('run-c')).toBe(false);
  });

  it('does not throw when readRuns throws — returns the current nudged set unchanged', () => {
    const readRuns = () => {
      throw new Error('disk failure');
    };
    const sendNudge = vi.fn();
    const alreadyNudged = new Set<string>(['run-x']);

    const next = checkStalledRuns({
      readRuns,
      now: NOW,
      stallThresholdMs: STALL_THRESHOLD_MS,
      alreadyNudged,
      sendNudge,
    });

    expect(sendNudge).not.toHaveBeenCalled();
    expect(next).toBe(alreadyNudged);
  });

  it('formatStallNudge handles a corrupt lastHeartbeatAt with `?` instead of NaN', () => {
    // isStalled treats an unparseable lastHeartbeatAt as stalled, so a
    // corrupt entry can reach formatStallNudge. The Telegram message must
    // not contain "NaNmin".
    const corrupt = makeRun('run-corrupt', { lastHeartbeatAt: 'not a date' });
    const text = formatStallNudge(corrupt, NOW);
    expect(text).not.toContain('NaN');
    expect(text).toContain('?');
  });

  it('does NOT nudge when lastHeartbeatAt is stale but lastChildAliveAt is fresh', () => {
    // The whole point of the new field: a long quiet LLM call (no output
    // events for >5min) should NOT trip the stall nudge as long as the
    // child process is still alive (the in-runner ticker keeps
    // lastChildAliveAt fresh). isStalled prefers lastChildAliveAt.
    const readRuns = () => [
      makeRun('run-quiet-llm', {
        lastHeartbeatAt: heartbeatAge(10 * 60_000), // 10min — LLM quiet
        lastChildAliveAt: heartbeatAge(30_000), // 30s — process alive
      }),
    ];
    const sendNudge = vi.fn();
    const alreadyNudged = new Set<string>();

    const next = checkStalledRuns({
      readRuns,
      now: NOW,
      stallThresholdMs: STALL_THRESHOLD_MS,
      alreadyNudged,
      sendNudge,
    });

    expect(sendNudge).not.toHaveBeenCalled();
    expect(next.has('run-quiet-llm')).toBe(false);
  });

  it('does not throw when sendNudge throws — continues to the next run and still records the id', () => {
    const readRuns = () => [
      makeRun('run-a', { lastHeartbeatAt: heartbeatAge(10 * 60_000) }),
      makeRun('run-b', { lastHeartbeatAt: heartbeatAge(20 * 60_000) }),
    ];
    const sendNudge = vi.fn().mockImplementationOnce(() => {
      throw new Error('bot send failed');
    });
    const alreadyNudged = new Set<string>();

    const next = checkStalledRuns({
      readRuns,
      now: NOW,
      stallThresholdMs: STALL_THRESHOLD_MS,
      alreadyNudged,
      sendNudge,
    });

    expect(sendNudge).toHaveBeenCalledTimes(2);
    // Both ids tracked so a transient nudge failure doesn't cause repeated
    // attempts on every subsequent tick.
    expect(next.has('run-a')).toBe(true);
    expect(next.has('run-b')).toBe(true);
  });
});
