/**
 * Failing tests for `src/intent/observation-callbacks.ts` — project
 * 08-intent-layer Phase 6 B3.3.
 *
 * `diarize` and `triage` are the production adapters that wrap
 * `runAgent` and parse the agent reply as JSON. They feed the
 * `synthesizeDigest` and `runObservationLoop` orchestration cores —
 * adapters keep those cores LLM-free for unit-testability.
 *
 * Written test-first; the module does not exist yet.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../utils/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../ai/claude.js', () => ({
  runAgent: vi.fn(),
}));

const { runAgent } = await import('../ai/claude.js');
const runAgentMock = runAgent as unknown as ReturnType<typeof vi.fn>;

const { diarize, triage } = await import('./observation-callbacks.js');

import type { SensorSignal } from './observation-loop.js';

const SAMPLE_SIGNALS: SensorSignal[] = [
  { source: 'vault', content: '- 10am #friction the resolver mis-routed twice', ts: '2026-05-24T15:00:00.000Z' },
  { source: 'interaction', content: 'kind=command 4 failures in last 24h', ts: '2026-05-25T12:00:00.000Z' },
];

describe('diarize', () => {
  beforeEach(() => vi.clearAllMocks());

  it('happy path: parses the agent reply JSON and returns the signals array', async () => {
    const reply = JSON.stringify({
      signals: [{ source: 'vault', content: 'compacted resolver friction', ts: '2026-05-25T12:00:00.000Z' }],
    });
    runAgentMock.mockResolvedValue({ text: reply, error: null });

    const out = await diarize(SAMPLE_SIGNALS);
    expect(out).toHaveLength(1);
    expect(out[0]!.content).toBe('compacted resolver friction');
  });

  it('passes the input signals to runAgent as JSON in the prompt', async () => {
    runAgentMock.mockResolvedValue({ text: JSON.stringify({ signals: [] }), error: null });
    await diarize(SAMPLE_SIGNALS);
    expect(runAgentMock).toHaveBeenCalledOnce();
    const [agentName, prompt] = runAgentMock.mock.calls[0] as [string, string];
    expect(agentName).toBe('observation-diarizer');
    expect(prompt).toContain('"resolver mis-routed"'.slice(1, -1)); // partial match
    // The signals are serialized somewhere in the prompt.
    expect(prompt).toContain('signals');
  });

  it('agent error → returns the input unchanged (safe fallback)', async () => {
    runAgentMock.mockResolvedValue({ text: null, error: 'agent unavailable' });
    const out = await diarize(SAMPLE_SIGNALS);
    expect(out).toEqual(SAMPLE_SIGNALS);
  });

  it('malformed JSON reply → returns the input unchanged', async () => {
    runAgentMock.mockResolvedValue({ text: 'not json {', error: null });
    const out = await diarize(SAMPLE_SIGNALS);
    expect(out).toEqual(SAMPLE_SIGNALS);
  });

  it('missing signals key → returns the input unchanged', async () => {
    runAgentMock.mockResolvedValue({ text: JSON.stringify({ other: [] }), error: null });
    const out = await diarize(SAMPLE_SIGNALS);
    expect(out).toEqual(SAMPLE_SIGNALS);
  });

  it('empty input → does not call the agent (caller short-circuits in synthesis layer too)', async () => {
    const out = await diarize([]);
    expect(out).toEqual([]);
    expect(runAgentMock).not.toHaveBeenCalled();
  });

  it('strips markdown fences from agent reply if present (LLM lapses gracefully)', async () => {
    const reply = '```json\n' + JSON.stringify({
      signals: [{ source: 'telemetry', content: 'x', ts: '2026-05-25T12:00:00.000Z' }],
    }) + '\n```';
    runAgentMock.mockResolvedValue({ text: reply, error: null });
    const out = await diarize(SAMPLE_SIGNALS);
    expect(out).toHaveLength(1);
    expect(out[0]!.content).toBe('x');
  });
});

describe('triage', () => {
  beforeEach(() => vi.clearAllMocks());

  const SAMPLE_SIGNAL: SensorSignal = {
    source: 'vault',
    content: '- 10am #friction resolver mis-routed twice',
    ts: '2026-05-24T15:00:00.000Z',
  };

  it('happy path — file verdict: parses {file:true, idea:{...}}', async () => {
    const reply = JSON.stringify({
      file: true,
      idea: { title: 'Fix resolver routing', friction: 'resolver mis-routes', id: 'resolver-mis-routes' },
    });
    runAgentMock.mockResolvedValue({ text: reply, error: null });

    const out = await triage(SAMPLE_SIGNAL);
    expect(out.file).toBe(true);
    if (out.file) {
      expect(out.idea.title).toBe('Fix resolver routing');
      expect(out.idea.id).toBe('resolver-mis-routes');
    }
  });

  it('happy path — discard verdict: parses {file:false, reason:"..."}', async () => {
    const reply = JSON.stringify({ file: false, reason: 'not Rune friction' });
    runAgentMock.mockResolvedValue({ text: reply, error: null });

    const out = await triage(SAMPLE_SIGNAL);
    expect(out.file).toBe(false);
    if (!out.file) {
      expect(out.reason).toBe('not Rune friction');
    }
  });

  it('passes the input signal to runAgent in the prompt', async () => {
    runAgentMock.mockResolvedValue({ text: JSON.stringify({ file: false, reason: 'x' }), error: null });
    await triage(SAMPLE_SIGNAL);
    expect(runAgentMock).toHaveBeenCalledOnce();
    const [agentName, prompt] = runAgentMock.mock.calls[0] as [string, string];
    expect(agentName).toBe('observation-triage');
    expect(prompt).toContain('signal');
    expect(prompt).toContain('resolver mis-routed');
  });

  it('agent error → discard verdict with a safe reason', async () => {
    runAgentMock.mockResolvedValue({ text: null, error: 'agent unavailable' });
    const out = await triage(SAMPLE_SIGNAL);
    expect(out.file).toBe(false);
    if (!out.file) {
      expect(out.reason).toMatch(/agent|error|unavailable/i);
    }
  });

  it('malformed JSON reply → discard verdict with a safe reason (never silently files)', async () => {
    runAgentMock.mockResolvedValue({ text: 'not json {', error: null });
    const out = await triage(SAMPLE_SIGNAL);
    expect(out.file).toBe(false);
  });

  it('file:true without a valid idea object → discard verdict (never files a malformed idea)', async () => {
    const reply = JSON.stringify({ file: true, idea: { title: 'x' /* missing friction + id */ } });
    runAgentMock.mockResolvedValue({ text: reply, error: null });
    const out = await triage(SAMPLE_SIGNAL);
    expect(out.file).toBe(false);
  });

  it('strips markdown fences from agent reply (LLM lapses gracefully)', async () => {
    const reply = '```json\n' + JSON.stringify({ file: false, reason: 'ok' }) + '\n```';
    runAgentMock.mockResolvedValue({ text: reply, error: null });
    const out = await triage(SAMPLE_SIGNAL);
    expect(out.file).toBe(false);
  });
});
