import { describe, it, expect, vi } from 'vitest';

/*
 * Test suite for the nightly observation-loop composer (08-intent-layer, Phase 5). This
 * wires the Phase 5 pieces — sensor readers → synthesis → loop → triage/dispatch/format —
 * into one pass. All upstream dependencies (readers, diarizer, triage, escalation
 * decision) are injected so the composition is unit-testable; cron registration and the
 * real LLM/IO callbacks are integration that fills them in.
 */

import { runNightlyObservation } from './observation-nightly.js';
import type { SensorSignal, ProjectIdea, TriageVerdict } from './observation-loop.js';
import type { SignalReader } from './observation-sensor.js';

const empty: SignalReader = () => [];
const sig = (content: string): SensorSignal => ({ source: 'vault', content, ts: '2026-01-15T00:00:00.000Z' });
const idea = (id: string, title = 'A project'): ProjectIdea => ({ title, friction: `${id}-friction`, id });

describe('observation nightly — runNightlyObservation', () => {
  it('reports quiet and skips downstream work when every reader is empty', () => {
    const triage = vi.fn();
    const result = runNightlyObservation({
      readers: { vault: empty, telemetry: empty, interactions: empty },
      diarize: (s) => s,
      triage,
      decideEscalation: () => 'proceed',
      existingIdeas: [],
    });
    expect(result.outcomes).toEqual([{ kind: 'quiet' }]);
    expect(result.dispatchPlans).toEqual([]);
    expect(result.ideasMarkdown).toBe('');
    expect(triage).not.toHaveBeenCalled();
  });

  it('files a worthwhile signal, drafts a dispatch plan, and formats the ideas markdown', () => {
    const i = idea('fix-the-thing', 'Fix the thing');
    const result = runNightlyObservation({
      readers: { vault: () => [sig('a friction')], telemetry: empty, interactions: empty },
      diarize: (s) => s,
      triage: (): TriageVerdict => ({ file: true, idea: i }),
      decideEscalation: () => 'proceed',
      existingIdeas: [],
    });
    expect(result.outcomes).toEqual([{ kind: 'filed', idea: i }]);
    expect(result.dispatchPlans).toEqual([{ action: 'dispatch', projectSlug: 'fix-the-thing' }]);
    expect(result.ideasMarkdown).toContain('Fix the thing');
  });

  it('holds for approval when the escalation policy flags a filed self-generated spec', () => {
    const i = idea('risky');
    const result = runNightlyObservation({
      readers: { vault: () => [sig('a friction')], telemetry: empty, interactions: empty },
      diarize: (s) => s,
      triage: (): TriageVerdict => ({ file: true, idea: i }),
      decideEscalation: () => 'escalate',
      existingIdeas: [],
    });
    expect(result.dispatchPlans).toEqual([
      { action: 'await-approval', reason: expect.stringMatching(/escalat|approval/i) },
    ]);
  });

  it('produces no dispatch plan and no markdown for a discarded outcome', () => {
    const result = runNightlyObservation({
      readers: { vault: () => [sig('noise')], telemetry: empty, interactions: empty },
      diarize: (s) => s,
      triage: (): TriageVerdict => ({ file: false, reason: 'noise' }),
      decideEscalation: () => 'proceed',
      existingIdeas: [],
    });
    expect(result.outcomes).toEqual([{ kind: 'discarded', reason: 'noise' }]);
    expect(result.dispatchPlans).toEqual([]);
    expect(result.ideasMarkdown).toBe('');
  });

  it('dedupes against the existingIdeas baseline — a known friction is not re-dispatched', () => {
    const i = idea('known-friction');
    const result = runNightlyObservation({
      readers: { vault: () => [sig('a friction')], telemetry: empty, interactions: empty },
      diarize: (s) => s,
      triage: (): TriageVerdict => ({ file: true, idea: i }),
      decideEscalation: () => 'proceed',
      existingIdeas: [i],
    });
    expect(result.outcomes).toEqual([{ kind: 'duplicate', existingId: 'known-friction' }]);
    expect(result.dispatchPlans).toEqual([]);
  });
});
