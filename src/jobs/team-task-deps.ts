/**
 * Production TeamTaskDeps factory (project 14, Phase 8 — live execution binding).
 *
 * Binds ALL EIGHT role seams of the team-task workflow to real executors —
 * the live role-spawn binding the original Phase 5 closeout left stubbed:
 *
 *   - ARTIFACT roles (coder, QA test authoring) → the execution-agent
 *     primitive (`runExecutionAgent`): a worktree-scoped CLI session on the
 *     role's policy-resolved model that returns the captured `git diff`.
 *   - JUDGMENT roles (tech-lead test/diff review, reviewer verdict, designer,
 *     PM wrap-up) → the `/plan` text round-trip pattern: charter-composed
 *     two-channel prompt (SOUL → system, memory → reference fence), one
 *     throwaway session per invocation, fenced-JSON verdict parsing that
 *     FAILS CLOSED (an unparseable verdict never passes a gate).
 *   - `resolveReviewerProvider` → the model-policy resolver: the reviewer is
 *     resolved `distinctFromProvider: coder.provider`; when no distinct-
 *     provider model exists the binding is null and the workflow blocks
 *     (independence is fail-closed, never a same-provider review).
 *
 * `createProductionTaskWorkflowRunner` is the `OrchestrationDeps.runTaskWorkflow`
 * production binding the orchestrated applier mounts — it maps the selected
 * `tasks.md` task onto a `SizedTask` (conservative defaults: tasks.md carries
 * no sizing metadata, so `code-tests-required` + no designer), resolves the
 * role models, and drives `runTeamTaskWorkflow`. A missing policy or a failed
 * resolution returns durable `blocked` evidence with a truthful reason —
 * never a fake run.
 *
 * Every seam is injectable (`TeamTaskSeams`) so the whole binding is
 * fixture-testable with no live model call. See team-task-deps.test.ts and
 * docs/projects/14-product-team-agents/spec.md §Phase 8.
 */

import { randomUUID } from 'node:crypto';

import { askClaudeWithContext, cleanupSession } from '../ai/claude.js';
import { scrubPathsInText } from '../ai/tool-labels.js';
import { composeRoleContext, type RoleName } from '../roles/loader.js';
import { loadModelPolicy, resolveModel, type ModelPolicy } from '../intent/model-policy.js';
import { extractFencedJson } from '../intent/planning-roles-wiring.js';
import {
  runTeamTaskWorkflow,
  type ObjectionClass,
  type ObjectionFinding,
  type ObjectionSeverity,
  type QaResult,
  type ReviewerVerdict,
  type TaskEvidence,
  type TeamTaskDeps,
} from '../intent/team-task-workflow.js';
import {
  runExecutionAgent,
  type ExecutionAgentIO,
  type ExecutionAgentOpts,
  type ExecutionAgentResult,
  type RoleModelBinding,
} from './execution-agent.js';
import type { DispatchProvider } from '../intent/dispatch.js';
import type { SelectedTask } from '../intent/orch-task-select.js';
import type { SizedTask } from '../intent/planning-roles.js';
import type { SandboxSpec } from '../intent/sandbox.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('team-task-deps');

// One shape for the (model, provider, format) triple — defined at the
// executor boundary, re-exported here so both layers share it.
export type { RoleModelBinding } from './execution-agent.js';

/** Per-task round cap for the inner workflow loop (coder → review rounds).
 *  Mirrors the orchestrator's outer attempt cap and gen-eval-loop's default. */
const DEFAULT_ROUND_CAP = 3;

/** Cap on free-text fields lifted from model output into evidence. */
const NOTE_MAX_CHARS = 2_000;

// ---------------------------------------------------------------------------
// Role-model resolution (Phase 8 model map)
// ---------------------------------------------------------------------------

/** The six product-team roles' resolved model bindings. `reviewer` is null
 *  when no distinct-provider reviewer can be resolved — the fail-closed
 *  independence signal the workflow blocks on. */
export interface TeamRoleModels {
  pm: RoleModelBinding;
  techLead: RoleModelBinding;
  qa: RoleModelBinding;
  coder: RoleModelBinding;
  reviewer: RoleModelBinding | null;
  designer: RoleModelBinding;
}

const SUPPORTED_PROVIDERS: ReadonlySet<string> = new Set(['anthropic', 'openai']);
const SUPPORTED_FORMATS: ReadonlySet<string> = new Set(['claude', 'codex']);

/**
 * Resolve all six roles through the model-policy resolver (pin → role-default
 * → global-fallback). The REVIEWER is resolved with `distinctFromProvider:
 * coder.provider`; a resolver throw (no distinct-provider model registered)
 * maps to a null binding rather than a same-provider downgrade. Any other
 * role failing to resolve throws — the caller turns that into durable
 * `blocked` evidence.
 */
export function resolveTeamRoleModels(policy: ModelPolicy): TeamRoleModels {
  const resolveRole = (role: string, capabilities: string[], distinctFromProvider?: string) => {
    const resolution = resolveModel(
      { role, capabilities, ...(distinctFromProvider !== undefined ? { distinctFromProvider } : {}) },
      policy,
    );
    return toBinding(resolution.model, policy, role);
  };

  const pm = resolveRole('pm', []);
  const techLead = resolveRole('tech-lead', []);
  const designer = resolveRole('designer', []);
  // Artifact roles need a coding-capable executor.
  const qa = resolveRole('qa', ['coding']);
  const coder = resolveRole('coder', ['coding']);

  let reviewer: RoleModelBinding | null = null;
  try {
    reviewer = resolveRole('reviewer', [], coder.provider);
  } catch (err) {
    log.warn('resolveTeamRoleModels: no distinct-provider reviewer — independence fails closed', {
      coderProvider: coder.provider,
      error: (err as Error).message,
    });
  }

  return { pm, techLead, qa, coder, reviewer, designer };
}

/** Join a resolution alias back to its registry entry and narrow provider /
 *  format to what the execution layer actually supports. */
function toBinding(alias: string, policy: ModelPolicy, role: string): RoleModelBinding {
  const entry = policy.models.find((m) => m.alias === alias);
  if (!entry) {
    throw new Error(`role '${role}': resolved alias '${alias}' is not in the model registry`);
  }
  if (!SUPPORTED_PROVIDERS.has(entry.provider)) {
    throw new Error(`role '${role}': provider '${entry.provider}' has no wired executor`);
  }
  if (!SUPPORTED_FORMATS.has(entry.format)) {
    throw new Error(`role '${role}': model format '${entry.format}' has no wired executor`);
  }
  return {
    alias: entry.alias,
    provider: entry.provider as DispatchProvider,
    format: entry.format as RoleModelBinding['format'],
  };
}

// ---------------------------------------------------------------------------
// Injectable seams
// ---------------------------------------------------------------------------

/** One judgment-role model invocation (the `/plan` `defaultRoleModelCall`
 *  pattern plus the policy-resolved model pin). Injected in tests. */
export interface JudgmentModelCall {
  (input: { role: RoleName; model: string; systemPrompt: string; message: string }): Promise<string>;
}

export interface TeamTaskSeams {
  judgmentCall: JudgmentModelCall;
  runExecution: (
    opts: ExecutionAgentOpts,
    io?: Partial<ExecutionAgentIO>,
  ) => Promise<ExecutionAgentResult>;
}

/** Production judgment call: SOUL on the system channel, one throwaway
 *  session per invocation (fresh context, no cross-role bleed), cleaned up
 *  immediately. */
const defaultJudgmentCall: JudgmentModelCall = async ({ role, model, systemPrompt, message }) => {
  const sessionId = randomUUID();
  try {
    const result = await askClaudeWithContext(message, sessionId, systemPrompt, {
      model,
      opLabel: `team:${role}`,
    });
    if (result.error) {
      throw new Error(`team role '${role}' model call failed: ${result.error}`);
    }
    return result.text ?? '';
  } finally {
    cleanupSession(sessionId);
  }
};

const defaultSeams: TeamTaskSeams = {
  judgmentCall: defaultJudgmentCall,
  runExecution: runExecutionAgent,
};

// ---------------------------------------------------------------------------
// Judgment-role instructions + fail-closed parsers
// ---------------------------------------------------------------------------

const OBJECTION_CLASSES: ReadonlySet<string> = new Set([
  'security',
  'privacy',
  'data-integrity',
  'concurrency',
  'irreversibility',
  'cost-perf',
]);
const OBJECTION_SEVERITIES: ReadonlySet<string> = new Set(['low', 'medium', 'high', 'critical']);

const REVIEWER_INSTRUCTION = [
  'You are the independent code reviewer for one task. Review the diff against the',
  'spec, the QA tests, the task, and the project context below. You see the',
  'artifacts only — never the coder\'s reasoning.',
  '',
  'Weight your review toward OBJECTION-CLASS defects normal usage cannot surface:',
  'security, privacy, data-integrity, concurrency, irreversibility, cost-perf.',
  'Raise an objection ONLY for those classes; ordinary quality problems are a',
  'pass:false without objections.',
  '',
  'Respond with EXACTLY ONE fenced ```reviewer-verdict block containing JSON,',
  'and nothing after the fence:',
  '```reviewer-verdict',
  '{"pass": true, "objections": [{"class": "security", "severity": "high", "location": "<file:line>", "rationale": "<why>"}]}',
  '```',
  'An empty objections array means no objection-class finding.',
].join('\n');

const TL_TEST_REVIEW_INSTRUCTION = [
  'You are the tech lead. QA\'s test work for the task is below — review the TEST',
  'INTENT before the coder starts: do the tests (or the no-code-test rationale)',
  'actually pin the task\'s contract?',
  '',
  'Respond with EXACTLY ONE fenced ```tl-test-review block containing JSON:',
  '```tl-test-review',
  '{"approved": true, "notes": "<short reason>"}',
  '```',
].join('\n');

const TL_DIFF_REVIEW_INSTRUCTION = [
  'You are the tech lead. Review the diff below for technical coherence with the',
  'task: interfaces, contracts, sequencing, and fit with the existing system.',
  '',
  'Respond with EXACTLY ONE fenced ```tl-diff-review block containing JSON:',
  '```tl-diff-review',
  '{"pass": true, "notes": "<short reason>"}',
  '```',
].join('\n');

const DESIGNER_INSTRUCTION = [
  'You are the designer. The task was sized front-end / designer-needed — review',
  'the diff below for UX/UI quality and consistency.',
  '',
  'Respond with EXACTLY ONE fenced ```designer-review block containing JSON:',
  '```designer-review',
  '{"pass": true, "notes": "<short reason>"}',
  '```',
].join('\n');

const QA_EXEC_INSTRUCTION = [
  'You are QA. Write or update the tests that pin the selected task\'s contract',
  'BEFORE any implementation exists. Derive them from the spec; do NOT implement',
  'the feature. If the task genuinely needs no code test (docs/config-only), make',
  'no file changes and instead print a one-paragraph no-code-test rationale.',
].join('\n');

const CODER_EXEC_INSTRUCTION = [
  'You are the coder. Implement EXACTLY the selected task below — nothing more.',
  'QA\'s tests already pin the contract; make them pass. Follow the conventions',
  'in the repo\'s CLAUDE.md. Do not commit; leave your changes in the worktree.',
].join('\n');

const PM_WRAPUP_INSTRUCTION = [
  'You are the product manager. The team hit the round cap on this task with',
  'non-objection disagreement. Decide whether the current state satisfies the',
  'product intent (resolve) or needs a human (leave unresolved). You CANNOT',
  'clear objection-class findings — those never reach you.',
  '',
  'Respond with EXACTLY ONE fenced ```pm-wrapup block containing JSON:',
  '```pm-wrapup',
  '{"resolved": false, "notes": "<short reason>"}',
  '```',
].join('\n');

/** Fail-closed: unparseable ⇒ pass:false (a verdict that cannot be read never
 *  passes a gate). Malformed objection entries are dropped — an invalid entry
 *  must not hard-block on garbage, and the pass flag still gates the round. */
function parseReviewerVerdict(text: string): ReviewerVerdict {
  const parsed = extractFencedJson(text, 'reviewer-verdict');
  if (!parsed || typeof parsed !== 'object') {
    return { pass: false, objections: [] };
  }
  const v = parsed as Record<string, unknown>;
  const objections: ObjectionFinding[] = Array.isArray(v['objections'])
    ? (v['objections'] as unknown[]).flatMap((raw): ObjectionFinding[] => {
        if (!raw || typeof raw !== 'object') return [];
        const o = raw as Record<string, unknown>;
        if (
          typeof o['class'] !== 'string' ||
          !OBJECTION_CLASSES.has(o['class']) ||
          typeof o['severity'] !== 'string' ||
          !OBJECTION_SEVERITIES.has(o['severity']) ||
          typeof o['location'] !== 'string' ||
          typeof o['rationale'] !== 'string'
        ) {
          return [];
        }
        return [
          {
            class: o['class'] as ObjectionClass,
            severity: o['severity'] as ObjectionSeverity,
            location: o['location'].slice(0, NOTE_MAX_CHARS),
            rationale: o['rationale'].slice(0, NOTE_MAX_CHARS),
          },
        ];
      })
    : [];
  return { pass: v['pass'] === true, objections };
}

/** Fail-closed boolean-flag parser shared by the tl/designer/pm verdicts. */
function parseFlagVerdict(
  text: string,
  tag: string,
  flag: string,
): { value: boolean; notes?: string } {
  const parsed = extractFencedJson(text, tag);
  if (!parsed || typeof parsed !== 'object') {
    return { value: false, notes: `unparseable ${tag} verdict — failing closed` };
  }
  const v = parsed as Record<string, unknown>;
  const notes = typeof v['notes'] === 'string' ? v['notes'].slice(0, NOTE_MAX_CHARS) : undefined;
  return { value: v[flag] === true, ...(notes !== undefined ? { notes } : {}) };
}

// ---------------------------------------------------------------------------
// The factory
// ---------------------------------------------------------------------------

export interface BuildTeamTaskDepsArgs {
  sandbox: SandboxSpec;
  productsConfigPath: string;
  models: TeamRoleModels;
}

/** Compose a judgment role's two-channel charter prompt and run one call. */
function makeJudge(seams: TeamTaskSeams) {
  return (role: RoleName, binding: RoleModelBinding, instruction: string, body: string) => {
    const ctx = composeRoleContext(role, instruction);
    const message = ctx.referenceContext ? `${ctx.referenceContext}\n\n${body}` : body;
    return seams.judgmentCall({
      role,
      model: binding.alias,
      systemPrompt: ctx.systemInstructions,
      message,
    });
  };
}

/** Pull the changed-file paths out of a unified diff (`+++ b/<path>` lines). */
function filesFromDiff(diff: string): string[] {
  const files = new Set<string>();
  for (const match of diff.matchAll(/^\+\+\+ b\/(.+)$/gm)) {
    files.add(match[1]!);
  }
  return [...files];
}

/** A compact handoff note from the executor's textual output — the tail only,
 *  so a verbose CLI transcript can never become a context-curator dump. */
function tailNote(output: string): string[] {
  const trimmed = output.trim();
  if (trimmed === '') return [];
  return [trimmed.slice(-300)];
}

/**
 * Build the production TeamTaskDeps: all eight seams live. Tests inject
 * `seams`; production omits it and gets the real judgment call + execution
 * agent.
 */
export function buildProductionTeamTaskDeps(
  args: BuildTeamTaskDepsArgs,
  seamOverrides: Partial<TeamTaskSeams> = {},
): TeamTaskDeps {
  const seams: TeamTaskSeams = { ...defaultSeams, ...seamOverrides };
  const { sandbox, productsConfigPath, models } = args;
  const judge = makeJudge(seams);

  // Two-channel split for artifact roles too: the role framing (SOUL + static
  // instruction) rides the executor's system channel; memory reference + task
  // body ride the prompt. (codex degrades to prepend — see ExecutionAgentOpts.)
  const execute = async (
    role: 'qa' | 'coder',
    binding: RoleModelBinding,
    instruction: string,
    body: string,
  ): Promise<ExecutionAgentResult> => {
    const ctx = composeRoleContext(role, instruction);
    return seams.runExecution({
      systemPrompt: ctx.systemInstructions,
      prompt: ctx.referenceContext ? `${ctx.referenceContext}\n\n${body}` : body,
      sandbox,
      model: binding,
      productsConfigPath,
    });
  };

  return {
    // NOTE: artifact seams (qaWriteTests, coder) THROW on executor failure —
    // runTeamTaskWorkflow's outer catch turns the throw into structured
    // `failed` evidence with failureReason. That is the error-flow contract.
    qaWriteTests: async ({ task, spec }) => {
      const body = [`## Task\n\n${task.text}`, '', `## Spec\n\n${spec}`].join('\n');
      const result = await execute('qa', models.qa, QA_EXEC_INSTRUCTION, body);
      if (!result.ok) {
        throw new Error(`QA execution failed: ${result.error}`);
      }
      if (result.diff.trim() === '') {
        const rationale =
          result.output.trim().slice(0, NOTE_MAX_CHARS) ||
          'QA made no changes and reported no rationale';
        return { kind: 'no-code-test-rationale', rationale } satisfies QaResult;
      }
      return { kind: 'tests-written', testIds: filesFromDiff(result.diff) } satisfies QaResult;
    },

    techLeadReviewTests: async ({ task, qa }) => {
      const body = [
        `## Task\n\n${task.text}`,
        '',
        qa.kind === 'tests-written'
          ? `## QA tests\n\n${qa.testIds.join('\n')}`
          : `## QA no-code-test rationale\n\n${qa.rationale}`,
      ].join('\n');
      const reply = await judge('tech-lead', models.techLead, TL_TEST_REVIEW_INSTRUCTION, body);
      const { value, notes } = parseFlagVerdict(reply, 'tl-test-review', 'approved');
      return { approved: value, ...(notes !== undefined ? { notes } : {}) };
    },

    coder: async ({ task, spec, context, tests }) => {
      const testsBlock = Array.isArray(tests) ? tests.join('\n') : tests;
      const body = [
        `## Task\n\n${task.text}`,
        '',
        `## Spec\n\n${spec}`,
        '',
        // Scrub host paths from context.md before it leaves the process to an
        // external provider (the coder is the cross-provider executor).
        `## Project context\n\n${scrubPathsInText(context)}`,
        '',
        `## QA tests\n\n${testsBlock}`,
      ].join('\n');
      const result = await execute('coder', models.coder, CODER_EXEC_INSTRUCTION, body);
      if (!result.ok) {
        throw new Error(`coder execution failed: ${result.error}`);
      }
      return { diff: result.diff, handoffNotes: tailNote(result.output) };
    },

    // `reviewerProvider` from ReviewerInput is intentionally unused here: the
    // provider identity is baked into `models.reviewer` at construction time
    // (resolved distinct-from-coder); the workflow's Gate 0 is the authority.
    reviewer: async ({ diff, spec, tests, task, context }) => {
      const testsBlock = Array.isArray(tests) ? tests.join('\n') : tests;
      if (models.reviewer === null) {
        // Deliberate belt-and-suspenders: Gate 0 normally blocks first, but a
        // reviewer verdict must never be fabricable without a resolved
        // independent reviewer, even if a future caller skips the gate.
        return { pass: false, objections: [] };
      }
      const body = [
        `## Task\n\n${task.text}`,
        '',
        `## Diff\n\n${diff}`,
        '',
        `## Spec\n\n${spec}`,
        '',
        `## Tests\n\n${testsBlock}`,
        '',
        `## Project context\n\n${scrubPathsInText(context)}`,
      ].join('\n');
      const reply = await judge('reviewer', models.reviewer, REVIEWER_INSTRUCTION, body);
      return parseReviewerVerdict(reply);
    },

    techLeadReviewDiff: async ({ task, diff }) => {
      const body = [`## Task\n\n${task.text}`, '', `## Diff\n\n${diff}`].join('\n');
      const reply = await judge('tech-lead', models.techLead, TL_DIFF_REVIEW_INSTRUCTION, body);
      const { value, notes } = parseFlagVerdict(reply, 'tl-diff-review', 'pass');
      return { pass: value, ...(notes !== undefined ? { notes } : {}) };
    },

    designer: async ({ task, diff }) => {
      const body = [`## Task\n\n${task.text}`, '', `## Diff\n\n${diff}`].join('\n');
      const reply = await judge('designer', models.designer, DESIGNER_INSTRUCTION, body);
      const { value, notes } = parseFlagVerdict(reply, 'designer-review', 'pass');
      return { pass: value, ...(notes !== undefined ? { notes } : {}) };
    },

    pmWrapup: async ({ task, reason }) => {
      const body = [`## Task\n\n${task.text}`, '', `## Situation\n\n${reason}`].join('\n');
      const reply = await judge('pm', models.pm, PM_WRAPUP_INSTRUCTION, body);
      const { value } = parseFlagVerdict(reply, 'pm-wrapup', 'resolved');
      return { resolved: value };
    },

    resolveReviewerProvider: (coderProvider) =>
      models.reviewer !== null && models.reviewer.provider !== coderProvider
        ? models.reviewer.provider
        : null,
  };
}

// ---------------------------------------------------------------------------
// OrchestrationDeps.runTaskWorkflow production binding
// ---------------------------------------------------------------------------

export interface TaskWorkflowRunnerArgs {
  sandbox: SandboxSpec;
  productsConfigPath: string;
  /** Path to `policies/model-policy.json` — loaded on first use and cached
   *  for the process lifetime (loadModelPolicy caches per path; a mid-run
   *  policy edit needs a restart to apply). */
  modelPolicyPath: string;
  /** Inner per-task round cap; defaults to {@link DEFAULT_ROUND_CAP}. */
  cap?: number;
}

/** Map a selected `tasks.md` task onto the workflow's SizedTask. tasks.md
 *  carries no sizing metadata, so v1 uses conservative defaults: tests
 *  required, no designer (spec req 24's non-flagged default). */
function toSizedTask(task: SelectedTask): SizedTask {
  return {
    id: task.id,
    text: task.text,
    testStrategy: 'code-tests-required',
    designerNeeded: false,
    roles: ['qa', 'tech-lead', 'coder', 'reviewer'],
  };
}

function blockedEvidence(task: SelectedTask, reason: string): TaskEvidence {
  return {
    taskId: task.id,
    outcome: 'blocked',
    rolesInvoked: [],
    objectionOpen: false,
    handoffNotes: [],
    blockedReason: reason,
  };
}

/**
 * The production `OrchestrationDeps.runTaskWorkflow` factory the orchestrated
 * applier mounts. Resolution failures block durably with a truthful reason —
 * the run is explicit and recorded, never a fabricated success or a silent
 * legacy fallback.
 */
export function createProductionTaskWorkflowRunner(
  args: TaskWorkflowRunnerArgs,
  seamOverrides: Partial<TeamTaskSeams> = {},
): (task: SelectedTask, ctx: { handoff: string; contextMd: string }) => Promise<TaskEvidence> {
  return async (task, ctx) => {
    let policy: ModelPolicy | null;
    try {
      policy = loadModelPolicy(args.modelPolicyPath);
    } catch (err) {
      return blockedEvidence(task, `model policy unreadable: ${(err as Error).message}`);
    }
    if (policy === null) {
      return blockedEvidence(
        task,
        'model policy not found — orchestrated execution requires policies/model-policy.json',
      );
    }

    let models: TeamRoleModels;
    try {
      models = resolveTeamRoleModels(policy);
    } catch (err) {
      return blockedEvidence(task, `role model resolution failed: ${(err as Error).message}`);
    }

    const deps = buildProductionTeamTaskDeps(
      { sandbox: args.sandbox, productsConfigPath: args.productsConfigPath, models },
      seamOverrides,
    );

    return runTeamTaskWorkflow(
      toSizedTask(task),
      {
        // The orchestrator's bounded handoff (task + context.md + spec slices)
        // IS the per-task spec input — the fresh-context principle.
        spec: ctx.handoff,
        contextMd: ctx.contextMd,
        coderProvider: models.coder.provider,
        cap: args.cap ?? DEFAULT_ROUND_CAP,
      },
      deps,
    );
  };
}
