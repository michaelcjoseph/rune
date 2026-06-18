/**
 * Planner roles — PM + tech-lead orchestration (project 14, Phase 2).
 *
 * Enriches planning with the two product-team planner roles. The spec's flow:
 *
 *   brief → PM judges "specified enough?"
 *             yes → PM writes spec and emits assumptions
 *             no  → PM enters interview-needed / blocked-on-human state
 *           → tech lead writes tech spec, task breakdown, role sizing, test strategy
 *           → PM reviews tech spec against product spec
 *           → Jarvis seeds context.md
 *
 * This module is the deterministic ORCHESTRATION over three injected role seams.
 * The seams (the actual PM / tech-lead model calls) are injected so the whole
 * flow is testable with fixtures and no live model call — exactly the spec's
 * "automated tests use fixtures" contract. `defaultPlanningRoleDeps()` wires the
 * real role invocations for production.
 *
 * Pure over its seams: it never writes files and never reads disk. Seeding
 * `context.md` to disk is the caller's job (Phase 3 fs layer); this module
 * returns the seeded content. The concrete bridge to the Phase 1 role charters
 * (which reads `agents/<role>/` from disk) lives in `planning-roles-wiring.ts`,
 * kept separate so this core stays import-pure.
 */

import { seedProjectContext } from './project-context.js';
import type { PlanCritique, PlanningCritiqueResult } from './planning-critique.js';
import type { RoleName } from '../roles/loader.js';

/** Per-task test strategy the tech lead assigns during sizing (spec §"Task test
 *  strategy"). Drives whether QA writes code tests, records a no-code-test
 *  rationale, or owns the tests as the deliverable. */
export type TestStrategy = 'code-tests-required' | 'docs-or-config-only' | 'tests-as-deliverable';

/** One sized task from the tech lead's breakdown. `designerNeeded` is the
 *  EXPLICIT front-end / designer-needed flag (spec req 7) so designer routing
 *  (req 24) is deterministic, not inferred at runtime. */
export interface SizedTask {
  /** Stable task id. */
  id: string;
  /** Task description. */
  text: string;
  /** Test strategy for this task. */
  testStrategy: TestStrategy;
  /** Explicit front-end / designer-needed flag. */
  designerNeeded: boolean;
  /** Roles the tech lead sized into this task. */
  roles: string[];
  /** Phase / milestone label this task belongs to (e.g. "Phase 1 - Core").
   *  Tasks sharing a phase render together under one heading with their own
   *  Tests-write-first block. Optional: tasks without one fall under a default
   *  phase, so the orchestration core (which walks tasks linearly) is unaffected. */
  phase?: string;
}

/** Project-local good-output exemplars the tech lead can tailor during planning.
 *  Persisted with the project and later loaded into each role's low-authority
 *  reference channel alongside the permanent baseline exemplars. */
export type PerProjectExemplars = Partial<Record<RoleName, string>>;

/** The PM's assessment of a brief — a discriminated union so the type enforces
 *  what each branch carries. A specified-enough brief yields title + spec +
 *  assumptions; an underspecified one yields the interview needs (the explicit
 *  block) and never a fabricated spec. The union removes the silent
 *  empty-string / product-slug fallbacks a flat optional-field shape invites. */
export type PmSpecResult =
  | {
      specifiedEnough: true;
      /** Project title. */
      title: string;
      /** The spec body. */
      spec: string;
      /** The calls the PM made filling gaps → surfaced as an Assumptions section. */
      assumptions: string[];
    }
  | {
      specifiedEnough: false;
      /** What the PM needs answered before a spec can be written. */
      interviewNeeds: string[];
    };

/** The tech lead's breakdown of an approved spec. */
export interface TechLeadResult {
  techSpec: string;
  tasks: SizedTask[];
  perProjectExemplars?: PerProjectExemplars;
}

/** The PM's review of the tech spec against the product spec. */
export interface SpecMatchResult {
  match: boolean;
  /** Concrete drift items when `match` is false. */
  mismatches: string[];
}

/** The injected planner-role seams. */
export interface PlanningRoleDeps {
  /** PM: judge specified-enough; on yes, write spec + assumptions; on no, name
   *  interview needs. */
  pmAssessAndSpec: (input: { brief: string; product: string }) => Promise<PmSpecResult>;
  /** Tech lead: break the spec into sized tasks with test strategy + designer flag. */
  techLeadBreakdown: (input: {
    brief: string;
    product: string;
    spec: string;
  }) => Promise<TechLeadResult>;
  /** PM: review the tech spec against the product spec, flagging drift. */
  pmReviewMatch: (input: {
    spec: string;
    techSpec: string;
    tasks: SizedTask[];
  }) => Promise<SpecMatchResult>;
  /** Phase 9: the Jarvis-owned cross-model critique pass — runs AFTER the
   *  spec/tech-spec match gate and BEFORE the context seed, refining the
   *  assembled artifacts before the human approval gate. Optional: when absent
   *  the planner skips the critique (plan unchanged) — backward-compatible for
   *  callers that predate Phase 9. The production binding wires
   *  `runPlanningCritique` (planning-critique.ts). */
  critiquePlan?: (plan: PlanCritique) => Promise<PlanningCritiqueResult>;
}

export interface RunPlannerInput {
  brief: string;
  product: string;
}

/** Outcome of the planner-roles flow — a discriminated union over the three exit
 *  points: PM blocked for interview, PM flagged a spec/tech-spec mismatch, or a
 *  completed plan with a seeded context. */
export type PlanningRolesOutcome =
  | { kind: 'blocked-for-interview'; interviewNeeds: string[] }
  | {
      kind: 'spec-mismatch';
      spec: string;
      assumptions: string[];
      techSpec: string;
      tasks: SizedTask[];
      mismatches: string[];
    }
  | {
      kind: 'planned';
      title: string;
      spec: string;
      assumptions: string[];
      techSpec: string;
      tasks: SizedTask[];
      context: string;
      perProjectExemplars?: PerProjectExemplars;
      /** Phase 9: true when the cross-model critique degraded to the Claude pass
       *  alone (Codex unavailable). Surfaced so the planning record can note it. */
      codexCritiqueSkipped: boolean;
    };

/**
 * Ensure a spec carries an `## Assumptions` section listing the PM's calls.
 * Silent PM invention is the risk the assumptions section exists to surface — so
 * this guarantees the section deterministically regardless of how the PM
 * formatted its spec body. No-op when there are no assumptions; idempotent when
 * an Assumptions heading already exists (it does not double-append).
 */
export function withAssumptionsSection(spec: string, assumptions: readonly string[]): string {
  if (assumptions.length === 0) return spec;
  if (/^##\s+Assumptions\s*$/im.test(spec)) return spec;

  const section = ['## Assumptions', '', ...assumptions.map((a) => `- ${a}`)].join('\n');
  const trimmed = spec.trimEnd();
  return `${trimmed}\n\n${section}\n`;
}

/**
 * Drive the PM + tech-lead planning flow over the injected seams. Returns one of
 * three outcomes; never writes files. The order is the gate: an underspecified
 * brief blocks BEFORE the tech lead is invoked, and a PM-flagged spec/tech-spec
 * mismatch stops BEFORE the context is seeded.
 */
export async function runPlannerRoles(
  input: RunPlannerInput,
  deps: PlanningRoleDeps,
): Promise<PlanningRolesOutcome> {
  const pm = await deps.pmAssessAndSpec({ brief: input.brief, product: input.product });

  // Gate 1: underspecified brief → block for interview, never fabricate a spec.
  if (!pm.specifiedEnough) {
    return {
      kind: 'blocked-for-interview',
      interviewNeeds: pm.interviewNeeds,
    };
  }

  // pm is narrowed to the specified-enough branch — title/spec/assumptions present.
  const { assumptions, title } = pm;
  // Guarantee the Assumptions section on the spec the team will build against.
  const spec = withAssumptionsSection(pm.spec, assumptions);

  const techLead = await deps.techLeadBreakdown({
    brief: input.brief,
    product: input.product,
    spec,
  });

  const review = await deps.pmReviewMatch({
    spec,
    techSpec: techLead.techSpec,
    tasks: techLead.tasks,
  });

  // Gate 2: PM-flagged spec/tech-spec drift → surface it, do NOT pass it through
  // and do NOT seed context (planning did not complete). The critique never
  // runs on a mismatched plan — it sharpens a coherent plan, not a broken one.
  if (!review.match) {
    return {
      kind: 'spec-mismatch',
      spec,
      assumptions,
      techSpec: techLead.techSpec,
      tasks: techLead.tasks,
      mismatches: review.mismatches,
    };
  }

  // Phase 9: cross-model critique pass over the assembled spec/tech-spec/tasks,
  // AFTER the match gate and BEFORE the context seed, so its revision feeds both
  // the seed and the human approval surface (every critique change stays
  // human-gated). Optional seam: when absent the plan passes through unchanged.
  let critiquedSpec = spec;
  let critiquedTechSpec = techLead.techSpec;
  let critiquedTasks = techLead.tasks;
  let codexCritiqueSkipped = false;
  if (deps.critiquePlan) {
    const critique = await deps.critiquePlan({
      spec,
      techSpec: techLead.techSpec,
      tasks: techLead.tasks,
    });
    // Re-guarantee the Assumptions section in case the critique reshaped the
    // spec body (req 6 holds regardless of how the critic formatted its output).
    critiquedSpec = withAssumptionsSection(critique.plan.spec, assumptions);
    critiquedTechSpec = critique.plan.techSpec;
    critiquedTasks = critique.plan.tasks;
    codexCritiqueSkipped = critique.codexSkipped;
  }

  // Planning complete → seed the initial context.md from the CRITIQUED artifacts.
  // `firstParagraph` skips heading lines, so it lands on the product description
  // even though `spec` carries an appended Assumptions section.
  const firstTask = critiquedTasks[0];
  const context = seedProjectContext({
    product: input.product,
    projectTitle: title,
    specSummary: firstParagraph(critiquedSpec),
    assumptions,
    // The tech spec seeds the Interfaces & Contracts section; the Phase 3 update
    // path refines it as tasks establish concrete contracts.
    interfaces: critiquedTechSpec,
    firstTaskHandoff: firstTask ? `Start with: ${firstTask.text}` : undefined,
  });

  return {
    kind: 'planned',
    title,
    spec: critiquedSpec,
    assumptions,
    techSpec: critiquedTechSpec,
    tasks: critiquedTasks,
    context,
    perProjectExemplars: techLead.perProjectExemplars,
    codexCritiqueSkipped,
  };
}

/** First non-empty paragraph of a markdown body — a compact Current-State seed. */
function firstParagraph(body: string): string {
  const para = body
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .find((p) => p.length > 0 && !p.startsWith('#'));
  return para ?? body.trim();
}
