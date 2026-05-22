/**
 * Friction-detection extension to the existing Ask-Twice intent telemetry (Phase 5,
 * project 08). The existing `src/utils/intent-log.ts` captures Ask-Twice events; this
 * module **extends** that telemetry by aggregating friction signals — recurring friction,
 * fixed bugs, and failed or mis-routed interactions — into a deduped, frequency-sorted
 * list the observation loop can triage. It does not modify or duplicate `intent-log.ts`.
 *
 * The **detection** half — categorizing raw events into the three friction classes — is
 * upstream integration (LLM or heuristic) that produces `FrictionSignal[]`. This module
 * owns the deterministic **aggregation** half: dedupe by stable id, count occurrences, sort
 * most-frequent-first so the noisiest friction surfaces ahead of one-offs.
 *
 * See docs/projects/08-intent-layer/{spec.md (§"Phase 5"), test-plan.md (§16)}.
 */

/** A classified friction observation. */
export interface FrictionSignal {
  /** The friction class. */
  category: 'recurring-friction' | 'bug-fixed' | 'failed-interaction';
  /** Stable id derived from the underlying friction — same friction → same id (the
   *  aggregation key). */
  id: string;
  /** Short, structured description of the friction. */
  description: string;
}

/** An aggregated friction — one entry per distinct id, with an occurrence count. */
export interface AggregatedFriction extends FrictionSignal {
  /** How many raw observations rolled into this entry. */
  occurrences: number;
}

/**
 * Aggregate raw friction signals: collapse same-id repeats into one entry with an
 * occurrence count, and sort the result most-frequent-first so the noisiest friction
 * surfaces ahead of one-offs. Within ties, the order in which an id first appeared in the
 * input is preserved (Array.sort is stable in modern V8 / Node 18+).
 *
 * Same-id signals are assumed to share the same `category` and `description` — the upstream
 * detector derives the id from those fields. When they happen to differ, the first
 * observation wins (first-wins); the divergent later observations only bump the occurrence
 * count.
 */
export function aggregateFrictions(raw: FrictionSignal[]): AggregatedFriction[] {
  const groups = new Map<string, AggregatedFriction>();
  for (const signal of raw) {
    const existing = groups.get(signal.id);
    if (existing) {
      existing.occurrences += 1;
    } else {
      groups.set(signal.id, { ...signal, occurrences: 1 });
    }
  }
  return [...groups.values()].sort((a, b) => b.occurrences - a.occurrences);
}
