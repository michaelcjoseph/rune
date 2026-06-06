/**
 * Writer-memory seed helper (project 12, Phase 1).
 *
 * The seed baseline is mined ONCE, by the implementation agent, from the
 * human-supplied links under `spec.md` → **Seed sources**. This module owns the
 * deterministic scaffolding around that one-time mining:
 *   - parse the supplied links out of the spec,
 *   - enforce the 20-50 supplied-link range (fewer → prerequisite error;
 *     more → cap error),
 *   - cap the distilled output at ≤20 provenance-stamped bullets,
 *   - stamp a bullet in the canonical provenance format,
 *   - plan which links to mine and which to skip-with-a-note (unfetchable).
 *
 * The actual URL→lesson distillation is the agent's job (web fetch + judgment),
 * not a runtime function — this module makes the surrounding contract testable.
 *
 * SCAFFOLD: bodies throw `notImplemented(...)` so the Phase 1 seed test suite is
 * RED until the seed implementation task lands.
 */

/** Minimum supplied seed links (human prerequisite, spec Phase 0). */
export const SEED_MIN_LINKS = 20;
/** Maximum supplied seed links (input cap). */
export const SEED_MAX_LINKS = 50;
/** Maximum distilled memory bullets the seed may emit (output cap). */
export const SEED_BULLET_CAP = 20;

/** Canonical provenance stamp: `- [YYYY-MM-DD · source: <slug>] <lesson>`.
 *  The `m` flag anchors `^` to each line so the same regex validates a single
 *  stamped bullet AND scans a multi-line `memory.md` (Phase 2 dedup). */
export const PROVENANCE_RE =
  /^- \[\d{4}-\d{2}-\d{2} · source: [a-z0-9][a-z0-9-]{2,80}\] .+/m;

/** Fewer than SEED_MIN_LINKS supplied links — the human prerequisite is unmet. */
export class SeedPrerequisiteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SeedPrerequisiteError';
  }
}

/** More than SEED_MAX_LINKS supplied links — the input cap is exceeded. */
export class SeedCapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SeedCapError';
  }
}

export interface SeedFetchOutcome {
  url: string;
  fetched: boolean;
}

export interface SeedMiningPlan {
  /** Links that fetched and should be distilled. */
  toMine: string[];
  /** Links skipped because they were unfetchable, each with a note. */
  skipped: { url: string; note: string }[];
}

function notImplemented(fn: string): never {
  throw new Error(`writer/seed: ${fn} not implemented (project 12 Phase 1 pending)`);
}

/** Extract the http(s) links under the `### Seed sources` section of spec.md. */
export function extractSeedLinks(_specContent: string): string[] {
  return notImplemented('extractSeedLinks');
}

/** Throw SeedPrerequisiteError (<20) or SeedCapError (>50); otherwise return. */
export function assertSeedSourceCount(_links: string[]): void {
  return notImplemented('assertSeedSourceCount');
}

/** Cap distilled bullets to ≤ SEED_BULLET_CAP (keeps the first N). */
export function capSeedBullets(_bullets: string[]): string[] {
  return notImplemented('capSeedBullets');
}

/** Stamp a lesson in the canonical provenance format. */
export function stampSeedLesson(_lesson: string, _sourceSlug: string, _date: string): string {
  return notImplemented('stampSeedLesson');
}

/** Split links into fetchable (toMine) and unfetchable (skipped-with-note). */
export function planSeedMining(
  _links: string[],
  _outcomes: SeedFetchOutcome[],
): SeedMiningPlan {
  return notImplemented('planSeedMining');
}
