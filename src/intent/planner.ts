/**
 * Planner — Layer 1 of the intent layer's execution engine. It turns a fuzzy idea into an
 * approved spec artifact through conversation: it asks questions, surfaces assumptions, and
 * scopes — it never accepts a one-line task and dispatches it. Nothing is dispatched or
 * scaffolded before the spec artifact is approved.
 *
 * This module is the **lifecycle state machine** behind that conversation. The conversation
 * itself (the questions, the LLM scoping, the product-scoped retrieval via the overlay
 * index) is orchestration; what is pinned here is the lifecycle — scoping → spec-proposed →
 * approved | abandoned — and the gate that nothing is scaffold-ready before approval. The
 * Planner runs identically on the `chat` and `cockpit` surfaces.
 *
 * STATUS: contract stub. The type surface and signatures below are the contract pinned by
 * the test-first suite in `planner.test.ts` (test-plan.md §9). The function bodies are
 * intentionally unimplemented — a Phase 3 Planner task fills them in. Until then the suite
 * is RED by design.
 *
 * See docs/projects/08-intent-layer/{spec.md (§"Layer 1"), test-plan.md (§9)}.
 */

/** Lifecycle of a planning conversation. */
export type PlanningStatus = 'scoping' | 'spec-proposed' | 'approved' | 'abandoned';

/** Where the planning conversation runs — the Planner behaves identically on both. */
export type PlanningSurface = 'chat' | 'cockpit';

/** The spec artifact a planning conversation produces — scaffolded into a project's files. */
export interface SpecArtifact {
  /** The product this project belongs to. */
  product: string;
  /** One-line project title. */
  title: string;
  /** The scoped spec — scaffolded into `spec.md`. */
  spec: string;
  /** The phased task breakdown — scaffolded into `tasks.md`; each phase opens with a
   *  Tests (write first) block. */
  tasks: string;
  /** The test plan — scaffolded into `test-plan.md`. */
  testPlan: string;
}

/** A planning conversation in progress — the unit the Planner state machine transitions. */
export interface PlanningSession {
  /** The raw, possibly-fuzzy idea the conversation started from. */
  idea: string;
  /** The surface the conversation runs on. */
  surface: PlanningSurface;
  /** The product the project is scoped to — drives product-scoped retrieval (overlay §3). */
  product: string;
  /** Lifecycle status. */
  status: PlanningStatus;
  /** The proposed spec artifact — set once the Planner proposes it (status `spec-proposed`+). */
  artifact?: SpecArtifact;
}

const NOT_IMPLEMENTED =
  'planner: not implemented — a Phase 3 Planner task (docs/projects/08-intent-layer) fills this in';

/**
 * Begin a planning conversation from a fuzzy idea. The session starts in `scoping`: the
 * Planner has questions to ask before any spec exists — it never jumps straight to a spec.
 */
export function startPlanning(
  _idea: string,
  _surface: PlanningSurface,
  _product: string,
): PlanningSession {
  throw new Error(NOT_IMPLEMENTED);
}

/**
 * Record the spec artifact the Planner has scoped (`scoping` → `spec-proposed`). Throws if
 * the session is not in `scoping` — a spec is proposed once, from an active conversation.
 */
export function proposeSpec(_session: PlanningSession, _artifact: SpecArtifact): PlanningSession {
  throw new Error(NOT_IMPLEMENTED);
}

/**
 * Approve the proposed spec (`spec-proposed` → `approved`). Throws if no spec has been
 * proposed yet — nothing is approved before the artifact exists. Approval is the gate:
 * only an `approved` session is scaffold-ready (see {@link isScaffoldReady}).
 */
export function approvePlan(_session: PlanningSession): PlanningSession {
  throw new Error(NOT_IMPLEMENTED);
}

/**
 * Abandon a planning conversation (`scoping` or `spec-proposed` → `abandoned`). Scoping
 * writes no project files, so an abandoned session leaves nothing half-written. Throws if
 * the session is already in a terminal state (`approved` / `abandoned`).
 */
export function abandonPlan(_session: PlanningSession): PlanningSession {
  throw new Error(NOT_IMPLEMENTED);
}

/**
 * Whether the session's spec artifact may be scaffolded into project files (via
 * `project-setup-writer`) and the project dispatched. True only for an `approved` session —
 * the hard gate that nothing is dispatched before approval.
 */
export function isScaffoldReady(_session: PlanningSession): boolean {
  throw new Error(NOT_IMPLEMENTED);
}
