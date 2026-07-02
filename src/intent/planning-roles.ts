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
 *           → Rune seeds context.md
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
import { plannedOutcomeToArtifact } from './planning-artifact.js';
import type { PlanCritique, PlanningCritiqueResult } from './planning-critique.js';
import type { PmSpecApprovalArtifact, SpecArtifact } from './planner.js';
import { runSelfReview } from './self-review.js';
import config from '../config.js';
import { loadModelPolicy, resolveModel, type ModelEntry } from './model-policy.js';
import type { RoleName } from '../roles/loader.js';
import { createLogger } from '../utils/logger.js';
import { scrubAbsolutePaths } from '../utils/sanitize-paths.js';

const log = createLogger('planning-roles');

/** Per-task test strategy the tech lead assigns during sizing (spec §"Task test
 *  strategy"). Drives whether QA writes code tests, records a no-code-test
 *  rationale, or owns the tests as the deliverable. */
export type TestStrategy =
  | 'code-tests-required'
  | 'docs-or-config-only'
  | 'tests-as-deliverable'
  | 'manual-live-gate';

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
  /** Repaired tech spec when PM can reconcile the mismatch without changing the approved spec. */
  repairedTechSpec?: string;
  /** Repaired task breakdown when PM can reconcile the mismatch without changing the approved spec. */
  repairedTasks?: SizedTask[];
  /** Human-readable summary of the PM repair. */
  repairSummary?: string;
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
  /** Phase 9: the Rune-owned cross-model critique pass — runs AFTER the
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

export type PlanningProgressStage =
  | 'tech-lead-breakdown'
  | 'pm-review-match'
  | 'claude-critique'
  | 'codex-critique'
  | 'context-seed'
  | 'scaffold';

export interface PlanningProgress {
  stage?: PlanningProgressStage;
  warning?: string;
  terminal?: string;
  success?: string;
}

export interface PlanningDownstreamErrorDetails {
  stage: PlanningProgressStage;
  reason: string;
  mismatches?: string[];
  retryable: boolean;
}

export class PlanningDownstreamError extends Error implements PlanningDownstreamErrorDetails {
  readonly stage: PlanningProgressStage;
  readonly reason: string;
  readonly mismatches?: string[];
  readonly retryable: boolean;
  readonly cause?: unknown;

  constructor(details: PlanningDownstreamErrorDetails, options: { cause?: unknown } = {}) {
    super(details.reason);
    this.name = 'PlanningDownstreamError';
    this.stage = details.stage;
    this.reason = details.reason;
    this.mismatches = details.mismatches;
    this.retryable = details.retryable;
    this.cause = options.cause;
  }
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

  const reviewedPlan = applyPmReviewRepair(techLead, review);

  // Gate 2: PM-flagged spec/tech-spec drift without a repair → surface it, do
  // NOT pass it through and do NOT seed context (planning did not complete).
  // A PM-provided repair is treated as the corrected coherent plan, so critique
  // can sharpen it instead of dead-ending an approved spec.
  if (!review.match) {
    if (reviewedPlan !== null) {
      log.info('PM review repaired planning mismatch', {
        product: input.product,
        mismatches: review.mismatches.map((mismatch) => scrubAbsolutePaths(mismatch)),
        ...(review.repairSummary ? { repairSummary: scrubAbsolutePaths(review.repairSummary) } : {}),
      });
    } else {
      return {
        kind: 'spec-mismatch',
        spec,
        assumptions,
        techSpec: techLead.techSpec,
        tasks: techLead.tasks,
        mismatches: review.mismatches,
      };
    }
  }
  const matchedTechLead = reviewedPlan ?? techLead;

  // Phase 9: cross-model critique pass over the assembled spec/tech-spec/tasks,
  // AFTER the match gate and BEFORE the context seed, so its revision feeds both
  // the seed and the human approval surface (every critique change stays
  // human-gated). Optional seam: when absent the plan passes through unchanged.
  let critiquedSpec = spec;
  let critiquedTechSpec = matchedTechLead.techSpec;
  let critiquedTasks = matchedTechLead.tasks;
  let codexCritiqueSkipped = false;
  if (deps.critiquePlan) {
    const critique = await deps.critiquePlan({
      spec,
      techSpec: matchedTechLead.techSpec,
      tasks: matchedTechLead.tasks,
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
    perProjectExemplars: matchedTechLead.perProjectExemplars,
    codexCritiqueSkipped,
  };
}

/**
 * Post-approval downstream planning. Starts from the already-approved PM-only spec and runs only
 * the automated tail needed to assemble the full scaffold artifact.
 */
export async function runDownstreamPlan(
  approvedSpec: PmSpecApprovalArtifact,
  options: {
    deps?: PlanningRoleDeps;
    progress?: (event: PlanningProgress) => void | Promise<void>;
  } = {},
): Promise<SpecArtifact> {
  const deps = options.deps ?? await loadDefaultPlanningRoleDeps();
  const progress = async (event: PlanningProgress) => {
    await options.progress?.(event);
  };

  const assumptions = approvedSpec.assumptions ?? [];
  const spec = withAssumptionsSection(approvedSpec.spec, assumptions);
  const brief = [`# ${approvedSpec.title}`, '', spec].join('\n');
  let terminalSent = false;

  const startStage = async (stage: PlanningProgressStage) => {
    log.info('downstream planning stage started', { product: approvedSpec.product, stage });
    await progress({ stage });
  };

  const failStage = async (
    stage: PlanningProgressStage,
    reason: string,
    opts: { mismatches?: string[]; retryable: boolean; cause?: unknown },
  ): Promise<never> => {
    const scrubbedReason = scrubAbsolutePaths(reason);
    const scrubbedMismatches = opts.mismatches?.map((mismatch) => scrubAbsolutePaths(mismatch));
    if (!terminalSent) {
      terminalSent = true;
      await progress({ terminal: scrubbedReason });
    }
    log.error('downstream planning failed', {
      product: approvedSpec.product,
      stage,
      reason: scrubbedReason,
      retryable: opts.retryable,
      ...(scrubbedMismatches ? { mismatches: scrubbedMismatches } : {}),
    });
    throw new PlanningDownstreamError({
      stage,
      reason: scrubbedReason,
      ...(scrubbedMismatches ? { mismatches: scrubbedMismatches } : {}),
      retryable: opts.retryable,
    }, { cause: opts.cause });
  };

  await startStage('tech-lead-breakdown');
  let techLead: TechLeadResult;
  try {
    techLead = await deps.techLeadBreakdown({
      brief,
      product: approvedSpec.product,
      spec,
    });
  } catch (err) {
    return await failStage('tech-lead-breakdown', `tech-lead breakdown failed: ${(err as Error).message}`, {
      retryable: true,
      cause: err,
    });
  }
  let reviewedTechLead: TechLeadResult;
  try {
    const selfReviewModel = resolvePlanningSelfReviewModel('tech-lead');
    const selfReview = await runSelfReview({
      role: 'tech-lead',
      artifact: techLead,
      render: renderTechLeadSelfReviewArtifact,
      parse: parseTechLeadSelfReviewArtifact,
      ...(selfReviewModel ? { model: selfReviewModel.model, provider: selfReviewModel.provider } : {}),
      modelCall: async ({ sessionId, systemPrompt, message }) => {
        if (selfReviewModel?.format === 'codex') {
          const [{ runCodex }, { getBaseEnv }] = await Promise.all([
            import('../ai/codex.js'),
            import('../jobs/credential-injector.js'),
          ]);
          const result = await runCodex(`${systemPrompt}\n\n${message}`, {
            model: selfReviewModel.model,
            sandboxMode: 'read-only',
            env: getBaseEnv(['OPENAI_API_KEY', 'CODEX_HOME', 'HOME', 'PATH', 'TMPDIR']),
          });
          if (result.error) {
            throw new Error(`tech-lead self-review failed: ${result.error}`);
          }
          return result.text ?? '';
        }
        const { askClaudeWithContext } = await import('../ai/claude.js');
        const result = await askClaudeWithContext(message, sessionId, systemPrompt, {
          opLabel: 'planning:tech-lead-self-review',
          ...(selfReviewModel?.model ? { model: selfReviewModel.model } : {}),
        });
        if (!result || result.error) {
          throw new Error(`tech-lead self-review failed: ${result?.error ?? 'empty model response'}`);
        }
        return result.text ?? '';
      },
    });
    reviewedTechLead = selfReview.artifact;
  } catch (err) {
    const message = `tech-lead self-review failed: ${(err as Error).message}`;
    return await failStage('tech-lead-breakdown', message, { retryable: true, cause: err });
  }

  await startStage('pm-review-match');
  let review: SpecMatchResult;
  try {
    review = await deps.pmReviewMatch({
      spec,
      techSpec: reviewedTechLead.techSpec,
      tasks: reviewedTechLead.tasks,
    });
  } catch (err) {
    return await failStage('pm-review-match', `PM review failed: ${(err as Error).message}`, {
      retryable: true,
      cause: err,
    });
  }
  if (!review.match) {
    const repaired = applyPmReviewRepair(reviewedTechLead, review);
    if (repaired === null) {
      const message = `PM review mismatch: ${review.mismatches.join('; ')}`;
      return await failStage('pm-review-match', message, {
        mismatches: review.mismatches,
        retryable: false,
      });
    }
    reviewedTechLead = repaired;
    log.info('PM review repaired downstream planning mismatch', {
      product: approvedSpec.product,
      stage: 'pm-review-match',
      mismatches: review.mismatches.map((mismatch) => scrubAbsolutePaths(mismatch)),
      ...(review.repairSummary ? { repairSummary: scrubAbsolutePaths(review.repairSummary) } : {}),
    });
  }

  let critiquedSpec = spec;
  let critiquedTechSpec = reviewedTechLead.techSpec;
  let critiquedTasks = reviewedTechLead.tasks;
  let codexCritiqueSkipped = false;
  if (deps.critiquePlan) {
    await startStage('claude-critique');
    await startStage('codex-critique');
    let critique: PlanningCritiqueResult;
    try {
      critique = await deps.critiquePlan({
        spec,
        techSpec: reviewedTechLead.techSpec,
        tasks: reviewedTechLead.tasks,
      });
    } catch (err) {
      return await failStage('codex-critique', `planning critique failed: ${(err as Error).message}`, {
        retryable: true,
        cause: err,
      });
    }
    critiquedSpec = withAssumptionsSection(critique.plan.spec, assumptions);
    critiquedTechSpec = critique.plan.techSpec;
    critiquedTasks = critique.plan.tasks;
    codexCritiqueSkipped = critique.codexSkipped;
    if (critique.codexSkipped) {
      await progress({ warning: 'Codex critique skipped; continuing with the last coherent plan.' });
    }
  }

  await startStage('context-seed');
  let context: string;
  try {
    const firstTask = critiquedTasks[0];
    context = seedProjectContext({
      product: approvedSpec.product,
      projectTitle: approvedSpec.title,
      specSummary: firstParagraph(critiquedSpec),
      assumptions,
      interfaces: critiquedTechSpec,
      firstTaskHandoff: firstTask ? `Start with: ${firstTask.text}` : undefined,
    });
  } catch (err) {
    const message = `context seed failed: ${(err as Error).message}`;
    return await failStage('context-seed', message, { retryable: true, cause: err });
  }

  return plannedOutcomeToArtifact(approvedSpec.product, {
    kind: 'planned',
    title: approvedSpec.title,
    spec: critiquedSpec,
    assumptions,
    techSpec: critiquedTechSpec,
    tasks: critiquedTasks,
    context,
    perProjectExemplars: reviewedTechLead.perProjectExemplars,
    codexCritiqueSkipped,
  });
}

async function loadDefaultPlanningRoleDeps(): Promise<PlanningRoleDeps> {
  const { defaultPlanningRoleDeps } = await import('./planning-roles-wiring.js');
  return defaultPlanningRoleDeps();
}

/** First non-empty paragraph of a markdown body — a compact Current-State seed. */
function firstParagraph(body: string): string {
  const para = body
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .find((p) => p.length > 0 && !p.startsWith('#'));
  return para ?? body.trim();
}

function renderTechLeadSelfReviewArtifact(artifact: TechLeadResult): string {
  return [
    'Return the corrected-or-confirmed tech lead artifact as exactly these fenced blocks.',
    '',
    '```self-review-artifact',
    JSON.stringify(
      {
        tasks: artifact.tasks,
        ...(artifact.perProjectExemplars ? { perProjectExemplars: artifact.perProjectExemplars } : {}),
      },
      null,
      2,
    ),
    '```',
    '```self-review-tech-spec',
    artifact.techSpec,
    '```',
  ].join('\n');
}

function parseTechLeadSelfReviewArtifact(reply: string): TechLeadResult {
  const parsed = extractJsonFence(reply, 'self-review-artifact');
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('missing self-review-artifact fence');
  }
  const value = parsed as Record<string, unknown>;
  const tasks = parseSelfReviewedTasks(value['tasks']);
  const techSpec = extractTextFence(reply, 'self-review-tech-spec');
  if (!techSpec) {
    throw new Error('missing self-review-tech-spec fence');
  }
  const perProjectExemplars = parseSelfReviewedPerProjectExemplars(value['perProjectExemplars']);
  return {
    techSpec,
    tasks,
    ...(perProjectExemplars ? { perProjectExemplars } : {}),
  };
}

function extractJsonFence(text: string, tag: string): unknown | null {
  const fence = new RegExp('```' + tag + '\\s*\\n([\\s\\S]*?)\\n```').exec(text);
  if (!fence) return null;
  try {
    return JSON.parse(fence[1]!);
  } catch {
    return null;
  }
}

function extractTextFence(text: string, tag: string): string | null {
  const open = new RegExp('```' + tag + '[^\\n]*\\n').exec(text);
  if (!open) return null;
  const rest = text.slice(open.index + open[0].length);
  const close = rest.lastIndexOf('\n```');
  if (close < 0) return null;
  const body = rest.slice(0, close).trim();
  return body.length > 0 ? body : null;
}

function parseSelfReviewedTasks(raw: unknown): SizedTask[] {
  if (!Array.isArray(raw)) {
    throw new Error('self-review-artifact missing tasks array');
  }
  return raw.map((entry, index) => parseSelfReviewedTask(entry, index));
}

function parseSelfReviewedTask(raw: unknown, index: number): SizedTask {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`self-review-artifact task ${index} is not an object`);
  }
  const task = raw as Record<string, unknown>;
  const id = typeof task['id'] === 'string' && task['id'].trim()
    ? task['id'].trim()
    : `task-${index + 1}`;
  if (typeof task['text'] !== 'string' || !task['text'].trim()) {
    throw new Error(`self-review-artifact task ${index} ('${id}') has no text`);
  }
  const testStrategy = isTestStrategy(task['testStrategy'])
    ? task['testStrategy']
    : 'code-tests-required';
  const roles = Array.isArray(task['roles'])
    ? task['roles'].filter((role): role is string => typeof role === 'string')
    : [];
  const phase = typeof task['phase'] === 'string' && task['phase'].trim()
    ? task['phase'].trim()
    : undefined;
  return {
    id,
    text: task['text'].trim(),
    testStrategy,
    designerNeeded: task['designerNeeded'] === true,
    roles,
    ...(phase ? { phase } : {}),
  };
}

function isTestStrategy(value: unknown): value is TestStrategy {
  return value === 'code-tests-required' ||
    value === 'docs-or-config-only' ||
    value === 'tests-as-deliverable' ||
    value === 'manual-live-gate';
}

function resolvePlanningSelfReviewModel(role: 'tech-lead'): {
  model: string;
  provider: string;
  format: ModelEntry['format'];
} | undefined {
  const policy = loadModelPolicy(config.MODEL_POLICY_FILE);
  if (!policy) return undefined;
  const resolution = resolveModel({ role, capabilities: [] }, policy);
  const entry = policy.models.find((candidate) => candidate.alias === resolution.model);
  if (!entry) {
    throw new Error(`planning tech-lead self-review: resolved alias '${resolution.model}' is not in the model registry`);
  }
  return { model: resolution.model, provider: resolution.provider, format: entry.format };
}

function applyPmReviewRepair(original: TechLeadResult, review: SpecMatchResult): TechLeadResult | null {
  if (review.match) return original;
  if (!review.repairedTechSpec || !review.repairedTasks || review.repairedTasks.length === 0) {
    return null;
  }
  return {
    techSpec: review.repairedTechSpec,
    tasks: review.repairedTasks,
    ...(original.perProjectExemplars ? { perProjectExemplars: original.perProjectExemplars } : {}),
  };
}

function parseSelfReviewedPerProjectExemplars(raw: unknown): PerProjectExemplars | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const exemplars: PerProjectExemplars = {};
  for (const [role, value] of Object.entries(raw)) {
    if (isRoleName(role) && typeof value === 'string' && value.trim()) {
      exemplars[role] = value.trim();
    }
  }
  return Object.keys(exemplars).length > 0 ? exemplars : undefined;
}

function isRoleName(value: string): value is RoleName {
  return value === 'pm' ||
    value === 'tech-lead' ||
    value === 'qa' ||
    value === 'coder' ||
    value === 'reviewer' ||
    value === 'designer';
}
