/**
 * Pure parser for a project's `tasks.md` checkbox tally. Operates on the file's
 * text so both callers — the cockpit's live rune-local read
 * (`src/server/projects-snapshot.ts`) and the cross-product registry scanner
 * (`src/jobs/registry-rebuild.ts`) — share one implementation instead of two
 * drifting copies. No filesystem or runtime-config dependency: callers read the
 * file and pass the text in.
 */

/** Per-phase done/total, grouped by `## Phase …` headers in `tasks.md`. */
export interface PhaseProgress {
  phase: string;
  done: number;
  total: number;
}

/** A project's task tally: overall done/total plus the per-phase breakdown. */
export interface TaskProgress {
  done: number;
  total: number;
  perPhase: PhaseProgress[];
}

/**
 * Count `- [x]` (done) and `- [ ]` (not done) checkbox lines in a `tasks.md`
 * body, grouped by `Phase` headers. Lines outside any phase header fall under a
 * synthetic `General` group. Returns zero counts for empty/checkbox-free text.
 */
export function parseTaskProgress(content: string): TaskProgress {
  const perPhase: PhaseProgress[] = [];
  let currentPhase = 'General';
  let phaseDone = 0;
  let phaseTotal = 0;

  function flushPhase() {
    if (phaseTotal > 0) {
      perPhase.push({ phase: currentPhase, done: phaseDone, total: phaseTotal });
    }
  }

  for (const line of content.split('\n')) {
    const phaseMatch = line.match(/^#+\s+(Phase\s+\S+.*)/i);
    if (phaseMatch) {
      if (phaseTotal > 0) flushPhase();
      currentPhase = phaseMatch[1]!.trim();
      phaseDone = 0;
      phaseTotal = 0;
      continue;
    }
    if (line.match(/^- \[x\]/i)) {
      phaseDone++;
      phaseTotal++;
    } else if (line.match(/^- \[ \]/)) {
      phaseTotal++;
    }
  }
  if (phaseTotal > 0) flushPhase();

  const totalDone = perPhase.reduce((sum, p) => sum + p.done, 0);
  const totalAll = perPhase.reduce((sum, p) => sum + p.total, 0);
  return { done: totalDone, total: totalAll, perPhase };
}
