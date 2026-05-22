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
 * STATUS: implemented. The lifecycle state machine — `startPlanning` / `proposeSpec` /
 * `approvePlan` / `abandonPlan` / `isScaffoldReady` — is live; the contract is pinned by
 * the test suite in `planner.test.ts` (test-plan.md §9). The conversation that drives these
 * transitions (the LLM scoping, the project-setup-writer scaffolding, overlay retrieval) is
 * orchestration built on top.
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

/**
 * Begin a planning conversation from a fuzzy idea. The session starts in `scoping`: the
 * Planner has questions to ask before any spec exists — it never jumps straight to a spec.
 */
export function startPlanning(
  idea: string,
  surface: PlanningSurface,
  product: string,
): PlanningSession {
  return { idea, surface, product, status: 'scoping' };
}

/**
 * Record the spec artifact the Planner has scoped (`scoping` → `spec-proposed`). Throws if
 * the session is not in `scoping` — a spec is proposed once, from an active conversation.
 */
export function proposeSpec(session: PlanningSession, artifact: SpecArtifact): PlanningSession {
  if (session.status !== 'scoping') {
    throw new Error(
      `proposeSpec: a spec can only be proposed while scoping — session status is '${session.status}'`,
    );
  }
  return { ...session, status: 'spec-proposed', artifact };
}

/**
 * Approve the proposed spec (`spec-proposed` → `approved`). Throws if no spec has been
 * proposed yet — nothing is approved before the artifact exists. Approval is the gate:
 * only an `approved` session is scaffold-ready (see {@link isScaffoldReady}).
 */
export function approvePlan(session: PlanningSession): PlanningSession {
  if (session.status !== 'spec-proposed') {
    throw new Error(
      `approvePlan: cannot approve — no spec has been proposed (session status is '${session.status}')`,
    );
  }
  return { ...session, status: 'approved' };
}

/**
 * Abandon a planning conversation (`scoping` or `spec-proposed` → `abandoned`). Scoping
 * writes no project files, so an abandoned session leaves nothing half-written. Throws if
 * the session is already in a terminal state (`approved` / `abandoned`).
 */
export function abandonPlan(session: PlanningSession): PlanningSession {
  if (session.status === 'approved' || session.status === 'abandoned') {
    throw new Error(
      `abandonPlan: cannot abandon — session is already in a terminal state ('${session.status}')`,
    );
  }
  return { ...session, status: 'abandoned' };
}

/**
 * Whether the session's spec artifact may be scaffolded into project files (via
 * `project-setup-writer`) and the project dispatched. True only for an `approved` session —
 * the hard gate that nothing is dispatched before approval.
 */
export function isScaffoldReady(session: PlanningSession): boolean {
  return session.status === 'approved';
}

/**
 * Build the project brief that the `project-setup-writer` agent consumes to scaffold
 * `spec.md`, `tasks.md`, and `test-plan.md` for the approved plan — the wiring from an
 * approved planning session to project scaffolding. The brief carries the artifact's spec,
 * tasks (with its per-phase Tests blocks intact), and test plan. Throws unless the session
 * is scaffold-ready (approved): nothing is scaffolded before approval.
 */
export function buildSetupWriterBrief(session: PlanningSession): string {
  const { artifact } = session;
  if (!isScaffoldReady(session) || artifact === undefined) {
    throw new Error(
      `buildSetupWriterBrief: the plan is not approved — nothing is scaffolded before ` +
        `approval (session status is '${session.status}')`,
    );
  }
  return [
    `# Project Brief: ${artifact.title}`,
    '',
    `Product: ${artifact.product}`,
    '',
    '## Spec',
    artifact.spec,
    '',
    '## Tasks',
    artifact.tasks,
    '',
    '## Test Plan',
    artifact.testPlan,
  ].join('\n');
}
