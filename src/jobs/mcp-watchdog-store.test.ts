/**
 * Tests for src/jobs/mcp-watchdog-store.ts — tolerant load + round-trip
 * persistence for the MCP watchdog state.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultWatchdogState, type McpWatchdogState } from './mcp-watchdog.js';
import { loadWatchdogState, saveWatchdogState } from './mcp-watchdog-store.js';

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mcp-watchdog-store-'));
  file = join(dir, 'mcp-watchdog-state.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function sampleState(): McpWatchdogState {
  return {
    consecutiveDownTicks: 2,
    consecutiveDegradedTicks: 0,
    active: [
      {
        kind: 'daemon-down',
        key: 'daemon-down',
        message: 'MCP daemon unreachable for 2+ minutes — check `npm run mcp:start` / launchd.',
        firstDetectedAt: '2026-07-06T12:01:00.000Z',
        lastDetectedAt: '2026-07-06T12:02:00.000Z',
      },
      {
        kind: 'tool-failures',
        key: 'tool-failures:kb_query',
        message: 'MCP tool "kb_query" failing: 3 errors in the last 15 min.',
        firstDetectedAt: '2026-07-06T12:02:00.000Z',
        lastDetectedAt: '2026-07-06T12:02:00.000Z',
      },
    ],
    lastNotifiedAt: {
      'daemon-down': 1783771320000,
      'tool-failures:kb_query': 1783771380000,
    },
  };
}

describe('loadWatchdogState — tolerant load', () => {
  it('returns the default state for a missing file', () => {
    expect(loadWatchdogState(file)).toEqual(defaultWatchdogState());
  });

  it('returns the default state for malformed JSON', () => {
    writeFileSync(file, '{not json!!', 'utf8');
    expect(loadWatchdogState(file)).toEqual(defaultWatchdogState());
  });

  it('returns the default state for a non-object root', () => {
    writeFileSync(file, JSON.stringify(['nope']), 'utf8');
    expect(loadWatchdogState(file)).toEqual(defaultWatchdogState());
  });

  it('returns the default state when required fields are missing', () => {
    writeFileSync(file, JSON.stringify({ consecutiveDownTicks: 1 }), 'utf8');
    expect(loadWatchdogState(file)).toEqual(defaultWatchdogState());
  });

  it('returns the default state when active contains a malformed alert', () => {
    const bad = { ...sampleState(), active: [{ kind: 'daemon-down' }] };
    writeFileSync(file, JSON.stringify(bad), 'utf8');
    expect(loadWatchdogState(file)).toEqual(defaultWatchdogState());
  });

  it('returns the default state when an alert kind is unknown', () => {
    const state = sampleState();
    const bad = {
      ...state,
      active: [{ ...state.active[0], kind: 'not-a-kind' }],
    };
    writeFileSync(file, JSON.stringify(bad), 'utf8');
    expect(loadWatchdogState(file)).toEqual(defaultWatchdogState());
  });

  it('returns the default state when lastNotifiedAt holds non-numbers', () => {
    const bad = { ...sampleState(), lastNotifiedAt: { 'daemon-down': 'yesterday' } };
    writeFileSync(file, JSON.stringify(bad), 'utf8');
    expect(loadWatchdogState(file)).toEqual(defaultWatchdogState());
  });
});

describe('saveWatchdogState + round-trip', () => {
  it('round-trips a populated state', () => {
    const state = sampleState();
    saveWatchdogState(file, state);
    expect(loadWatchdogState(file)).toEqual(state);
  });

  it('round-trips the default state', () => {
    saveWatchdogState(file, defaultWatchdogState());
    expect(loadWatchdogState(file)).toEqual(defaultWatchdogState());
  });

  it('overwrites a previous state', () => {
    saveWatchdogState(file, sampleState());
    saveWatchdogState(file, defaultWatchdogState());
    expect(loadWatchdogState(file)).toEqual(defaultWatchdogState());
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(defaultWatchdogState());
  });

  it('never throws when the target directory does not exist', () => {
    const missing = join(dir, 'no-such-dir', 'state.json');
    expect(() => saveWatchdogState(missing, sampleState())).not.toThrow();
    expect(loadWatchdogState(missing)).toEqual(defaultWatchdogState());
  });
});
