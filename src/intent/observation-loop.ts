/**
 * Observation loop — Phase 5's operational self-improvement core. Rune observes its own
 * operation: a sensor layer (vault signals, product telemetry, logged interactions) feeds a
 * synthesis stage that diarizes raw signal into a compact, structured digest; the loop
 * reasons over that digest and **triages** each signal — discarding noise, or filing a
 * worthwhile friction as a project (into `docs/projects/ideas.md`) and dispatching the
 * existing project-execution engine to run it. The loop de-dupes: the same friction observed
 * repeatedly never files a new project each time.
 *
 * This module is the deterministic core: the triage walk with the LLM triage decision
 * injected as a callback, the dedupe check, and the quiet-period gate. The sensor layer and
 * the synthesis stage (LLM-driven) are upstream and produce the diarized `SensorSignal[]`
 * this loop consumes; the project-execution dispatch is downstream orchestration.
 *
 * STATUS: implemented. `isDuplicate` and `runObservationLoop` are live; the contract is
 * pinned by the test suite in `observation-loop.test.ts` (test-plan.md §16). The LLM
 * triage decision is injected as a callback; the actual dispatch of filed projects to the
 * execution engine is downstream orchestration (`observation-dispatch.ts`,
 * `observation-nightly.ts`).
 *
 * See docs/projects/08-intent-layer/{spec.md (§"Phase 5"), test-plan.md (§16)}.
 */

/** The three sensor sources the loop observes. */
export type SensorSource = 'vault' | 'telemetry' | 'interaction';

/**
 * A diarized sensor signal — the synthesis stage's output, not a raw log line. The loop
 * never consumes raw logs directly; this is what reaches the triage step.
 */
export interface SensorSignal {
  source: SensorSource;
  /** A short, structured description of the friction observed. */
  content: string;
  /** ISO-8601 timestamp of the observation. */
  ts: string;
}

/** A project the loop filed as a worthwhile friction — what lands in `docs/projects/ideas.md`. */
export interface ProjectIdea {
  /** Project title. */
  title: string;
  /** The friction the project addresses. */
  friction: string;
  /** Stable id derived from the friction — same friction → same id (for de-dupe). */
  id: string;
  /** Product attribution (project 16 R3.13) — shared schema between loop-filed
   *  and App-filed ideas. Rendered as a ` → <product>` bullet suffix; absent on
   *  legacy bullets. Never part of the id derivation. */
  product?: string;
}

/** The triage decision for one signal — file a project or discard. */
export type TriageVerdict =
  | { file: true; idea: ProjectIdea }
  | { file: false; reason: string };

/** The outcome of one loop iteration on one signal (or the whole batch when quiet). */
export type LoopOutcome =
  | { kind: 'filed'; idea: ProjectIdea }
  | { kind: 'discarded'; reason: string }
  | { kind: 'duplicate'; existingId: string }
  | { kind: 'quiet' };

/**
 * Whether `idea` matches an already-filed idea by id — the loop's de-dupe primitive. Same
 * friction always yields the same `ProjectIdea.id`, so an exact id match is the dedupe check.
 */
export function isDuplicate(idea: ProjectIdea, existingIdeas: ProjectIdea[]): boolean {
  return existingIdeas.some((e) => e.id === idea.id);
}

/**
 * Run one pass of the observation loop over a batch of diarized signals. An empty batch is
 * the quiet case — the loop returns `[{ kind: 'quiet' }]` (a single sentinel element, never
 * an empty array) and files/runs nothing. For each signal, the injected `triage` callback
 * (LLM-driven) decides file-or-discard; a file decision is deduped against `existingIdeas`
 * and against any idea already filed earlier in this same batch (the same friction in two
 * signals does not file twice). The actual dispatch of the filed project to the execution
 * engine is downstream orchestration; this returns the decisions.
 */
export function runObservationLoop(
  signals: SensorSignal[],
  existingIdeas: ProjectIdea[],
  triage: (signal: SensorSignal) => TriageVerdict,
): LoopOutcome[] {
  if (signals.length === 0) return [{ kind: 'quiet' }];
  const outcomes: LoopOutcome[] = [];
  const filedThisBatch: ProjectIdea[] = [];
  for (const signal of signals) {
    const verdict = triage(signal);
    if (!verdict.file) {
      outcomes.push({ kind: 'discarded', reason: verdict.reason });
      continue;
    }
    if (isDuplicate(verdict.idea, existingIdeas) || isDuplicate(verdict.idea, filedThisBatch)) {
      outcomes.push({ kind: 'duplicate', existingId: verdict.idea.id });
      continue;
    }
    outcomes.push({ kind: 'filed', idea: verdict.idea });
    filedThisBatch.push(verdict.idea);
  }
  return outcomes;
}
