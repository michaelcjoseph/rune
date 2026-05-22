/**
 * Nightly observation-loop composer (Phase 5, project 08). Wires the Phase 5 pieces —
 * the sensor layer, the synthesis stage, the observation loop, the triage-to-dispatch
 * adapter, and the ideas.md formatter — into one pass that runs as a nightly step.
 *
 * Every upstream dependency is **injected**: the source readers, the LLM diarizer, the LLM
 * triage, the escalation decision. The integration layer (the nightly cron job in
 * `src/jobs/nightly.ts`, the real LLM and file readers, and the actual createMutation
 * dispatch when a plan says `dispatch`) fills these in. This module is pure and unit-
 * testable so the wiring itself is verified independently of the LLM and I/O specifics.
 *
 * See docs/projects/08-intent-layer/{spec.md (§"Phase 5"), test-plan.md (§16)}.
 */

import type { LoopOutcome, ProjectIdea, TriageVerdict, SensorSignal } from './observation-loop.js';
import { runObservationLoop } from './observation-loop.js';
import type { SensorReaders } from './observation-sensor.js';
import { readSensors } from './observation-sensor.js';
import type { Diarizer } from './observation-synthesis.js';
import { synthesizeDigest } from './observation-synthesis.js';
import type { DispatchPlan } from './observation-dispatch.js';
import { planEngineDispatch } from './observation-dispatch.js';
import { formatIdeasMarkdown } from './observation-triage.js';

/** Everything the nightly composer needs — fully injectable for tests. */
export interface NightlyObservationDeps {
  readers: SensorReaders;
  diarize: Diarizer;
  triage: (signal: SensorSignal) => TriageVerdict;
  decideEscalation: (idea: ProjectIdea) => 'proceed' | 'escalate';
  /** The projects already filed in docs/projects/ideas.md — fed to the loop's dedupe. */
  existingIdeas: ProjectIdea[];
}

/** The composer's report for one nightly pass. */
export interface NightlyObservationResult {
  /** The per-signal outcomes (filed / discarded / duplicate / quiet). */
  outcomes: LoopOutcome[];
  /** One plan per filed outcome — `dispatch` or `await-approval` per the escalation policy. */
  dispatchPlans: DispatchPlan[];
  /** Markdown to append to `docs/projects/ideas.md` for newly-filed projects. */
  ideasMarkdown: string;
}

/**
 * Run one pass of the nightly observation loop. Sensors → synthesis → loop → triage. Filed
 * outcomes are turned into dispatch plans (gated on the escalation decision) and formatted
 * into markdown ready to append to `docs/projects/ideas.md`. A quiet pass — no signals
 * from any reader — short-circuits cleanly: no LLM calls, no plans, no markdown.
 */
export function runNightlyObservation(deps: NightlyObservationDeps): NightlyObservationResult {
  const signals = readSensors(deps.readers);
  const digest = synthesizeDigest(signals, deps.diarize);
  const outcomes = runObservationLoop(digest, deps.existingIdeas, deps.triage);
  const dispatchPlans: DispatchPlan[] = [];
  for (const outcome of outcomes) {
    if (outcome.kind === 'filed') {
      dispatchPlans.push(planEngineDispatch(outcome.idea, deps.decideEscalation));
    }
  }
  return { outcomes, dispatchPlans, ideasMarkdown: formatIdeasMarkdown(outcomes) };
}
