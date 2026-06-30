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
import { join } from 'node:path';

import { askClaudeWithContext, cleanupSession } from '../ai/claude.js';
import { scrubPathsInText } from '../ai/tool-labels.js';
import { PROJECT_ROOT } from '../config.js';
import { composeRoleContext, type RoleName } from '../roles/loader.js';
import { loadModelPolicy, resolveModel, type ModelPolicy } from '../intent/model-policy.js';
import { extractFencedJson } from '../intent/planning-roles-wiring.js';
import { runGateTriggeredLearning } from '../intent/gate-learning.js';
import { writeGateLearningLesson } from '../intent/learning-write-path.js';
import { runPostMortem } from '../intent/postmortem.js';
import type { FeedbackRecord, RoleStage } from '../intent/feedback-record.js';
import {
  mapObjectionSeverityToOutcome,
  runTeamTaskWorkflow,
  type ObjectionClass,
  type ObjectionFinding,
  type ObjectionSeverity,
  type FindingVerification,
  type FindingsLedgerEntry,
  type QaResult,
  type GateRejectionFeedback,
  type GateVerdict,
  type GateOutcome,
  type ReviewerVerdict,
  type TaskEvidence,
  type TeamTaskDeps,
  type WorkflowActivityEvent,
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
import { redactSecrets } from './work-run-transcript.js';
import { createLogger } from '../utils/logger.js';
import { formatProtectedLocalServicesWarning } from '../utils/protected-local-services.js';

const log = createLogger('team-task-deps');
const PROTECTED_LOCAL_SERVICES_WARNING = formatProtectedLocalServicesWarning();

// One shape for the (model, provider, format) triple — defined at the
// executor boundary, re-exported here so both layers share it.
export type { RoleModelBinding } from './execution-agent.js';

/** Per-task round cap for the inner workflow loop (coder → review gates).
 *  Phase 14 drives severity convergence up to the four-round hard budget. */
const DEFAULT_ROUND_CAP = 4;

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
  'outbound',
  'cost-perf',
]);
const OBJECTION_SEVERITIES: ReadonlySet<string> = new Set(['low', 'medium', 'high', 'critical']);
const GATE_OUTCOMES: ReadonlySet<string> = new Set([
  'pass',
  'pass-with-warnings',
  'fail',
]);
const OBJECTION_SEVERITY_RANK: Record<ObjectionSeverity, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

const REVIEWER_INSTRUCTION = [
  'You are the independent code reviewer for one task. Review the diff against the',
  'spec, the QA tests, the task, and the project context below. You see the',
  'artifacts only — never the coder\'s reasoning.',
  '',
  'You have NO tools and NO repository access: no file system, no grep, no ability',
  'to open or search files. You see ONLY the artifacts in this prompt. Never claim',
  'to have grepped, searched, read files, or "verified on disk / on the tree" —',
  'you cannot, and any such claim is a fabrication that invalidates your verdict.',
  '',
  'The diff is a PARTIAL view: changed hunks only, not the whole repository or',
  'the whole branch. A symbol, export, import, type, field, or call site that is',
  'not visible in the diff may still exist elsewhere in the repo, or may already',
  'have landed in an earlier commit on this branch. When present, the `## Project',
  'context / tree-state evidence` block below shows what is already on the branch',
  'before this task diff; treat a deliverable as satisfied when the diff, spec, or',
  'that tree-state evidence shows it exists. Do NOT raise an objection that',
  'asserts something is absent or unsatisfied — "exported nowhere", "defined',
  'nowhere", "never invoked", "field missing", "unwired", "won\'t compile" — when',
  'that conclusion rests only on its absence from this task diff while the',
  'provided context/spec/tree-state evidence shows it already exists. If a',
  'suspected defect cannot be confirmed from the artifacts you were actually',
  'given, withhold the objection: report it as a non-objection note on a fail or',
  'pass-with-warnings outcome, never as an objection-class finding.',
  '',
  'If an open findings ledger is present, review in this order:',
  '1. Regression pass: verify every prior finding by id before looking for new',
  '   issues. For each prior finding, return a `verifiedFindings` entry with',
  '   status exactly resolved, open, or regressed and cite what you checked.',
  '2. Discovery pass: only after the regression pass, look for new findings in',
  '   the current diff.',
  '',
  'Weight your review toward OBJECTION-CLASS defects normal usage cannot surface:',
  'security, privacy, data-integrity, concurrency, outbound, cost-perf.',
  'Raise an objection ONLY for those classes; ordinary quality problems are a',
  'fail outcome without objections.',
  '',
  'Respond with EXACTLY ONE fenced ```reviewer-verdict block containing JSON,',
  'and nothing after the fence. The verdict must carry exactly one `outcome`',
  'value: pass, pass-with-warnings, or fail:',
  '```reviewer-verdict',
  '{"outcome": "pass", "notes": "<short non-objection feedback>", "verifiedFindings": [{"id": "finding-...", "status": "resolved", "notes": "<what you verified>"}], "findings": [{"class": "security", "severity": "high", "location": "<file:line>", "rationale": "<why>", "reversible": true}]}',
  '```',
  'An empty findings array means no objection-class finding.',
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
  'You have NO tools and NO repository access: no file system, no grep, no ability',
  'to open or search files. You see ONLY the artifacts in this prompt. Never claim',
  'to have grepped, searched, read files, or verified on disk.',
  '',
  'The diff is a PARTIAL view: changed hunks only, not the whole repository or',
  'the whole branch. A task deliverable may already exist on the branch even if',
  'it is absent from this task diff. Judge completeness against the provided',
  'task, spec, project context / tree-state evidence, and diff together. Do NOT',
  'fail or raise a finding solely because a deliverable is missing-from-this-diff',
  'when the provided context/spec indicates it already exists on the tree. Only',
  'treat a deliverable as missing when it is absent from both the current diff and',
  'the provided tree-state/context evidence, or when the diff regresses it.',
  '',
  'Respond with EXACTLY ONE fenced ```tl-diff-review block containing JSON:',
  '```tl-diff-review',
  '{"outcome": "pass", "findings": [{"class": "data-integrity", "severity": "low", "location": "<file:line>", "rationale": "<why>", "reversible": true}], "notes": "<short reason>"}',
  '```',
].join('\n');

const DESIGNER_INSTRUCTION = [
  'You are the designer. The task was sized front-end / designer-needed — review',
  'the diff below for UX/UI quality and consistency.',
  '',
  'Respond with EXACTLY ONE fenced ```designer-review block containing JSON:',
  '```designer-review',
  '{"outcome": "pass", "findings": [{"class": "cost-perf", "severity": "low", "location": "<file:line>", "rationale": "<why>", "reversible": true}], "notes": "<short reason>"}',
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
  '{"resolved": true, "rationale": "<required non-empty if resolved true>", "notes": "<short reason if resolved false>"}',
  '```',
].join('\n');

const GATE_LESSON_DRAFT_INSTRUCTION = [
  'You are the rejecting product-team role. Draft ONE candidate craft lesson for',
  'the rejected counterpart role from the structured gate rejection below.',
  'Do not write memory. Do not include names, links, paths, or project-specific',
  'facts; keep the lesson abstract and reusable.',
  '',
  'Respond with EXACTLY ONE fenced ```gate-lesson-candidate block containing JSON:',
  '```gate-lesson-candidate',
  '{"kind":"candidate-lesson","draftedBy":"<your-role>","targetRole":"<counterpart-role>","lesson":"<abstract lesson>"}',
  '```',
].join('\n');

/** Fail-closed: unparseable ⇒ outcome:fail (a verdict that cannot be read never
 *  passes a gate). Malformed objection entries are dropped — an invalid entry
 *  must not hard-block on garbage, and the outcome still gates the round. */
function parseReviewerVerdict(text: string): ReviewerVerdict {
  const parsed = extractFencedJson(text, 'reviewer-verdict');
  if (!parsed || typeof parsed !== 'object') {
    return { outcome: 'fail', findings: [] };
  }
  const v = parsed as Record<string, unknown>;
  const { findings, malformedReason } = parseFindings(v);
  const verifiedFindings = parseFindingVerifications(v);
  const hasVerifiedFindings = Array.isArray(v['verifiedFindings']);
  const notes = typeof v['notes'] === 'string' ? v['notes'].slice(0, NOTE_MAX_CHARS) : undefined;
  if (malformedReason !== undefined) {
    return {
      outcome: 'fail',
      findings,
      ...(hasVerifiedFindings ? { verifiedFindings } : {}),
      notes: notes ?? malformedReason,
    };
  }
  const legacyPass = typeof v['pass'] === 'boolean' ? v['pass'] : undefined;
  const parsedOutcome = typeof v['outcome'] === 'string' && GATE_OUTCOMES.has(v['outcome'])
    ? v['outcome'] as GateOutcome
    : undefined;
  const outcome = findings.length > 0
    ? outcomeForFindings(findings) ?? 'fail'
    : parsedOutcome ??
      (legacyPass !== undefined
        ? legacyPass === true ? 'pass' : 'fail'
        : 'fail');
  if (parsedOutcome === undefined && legacyPass !== undefined && hasAggregateFixtureFences(text)) {
    return {
      pass: legacyPass,
      objections: findings,
      ...(hasVerifiedFindings ? { verifiedFindings } : {}),
      ...(notes !== undefined ? { notes } : {}),
    };
  }
  return {
    outcome,
    findings,
    ...(hasVerifiedFindings ? { verifiedFindings } : {}),
    ...(notes !== undefined ? { notes } : {}),
  };
}

function hasAggregateFixtureFences(text: string): boolean {
  return text.includes('```tl-test-review') || text.includes('```tl-diff-review') ||
    text.includes('```designer-review') || text.includes('```pm-wrapup');
}

function parseFindings(v: Record<string, unknown>): {
  findings: ObjectionFinding[];
  malformedReason?: string;
} {
  const source = Array.isArray(v['findings'])
    ? v['findings']
    : Array.isArray(v['objections'])
      ? v['objections']
      : [];
  const findings: ObjectionFinding[] = [];
  for (const raw of source as unknown[]) {
    if (!raw || typeof raw !== 'object') continue;
    const o = raw as Record<string, unknown>;
    if (
      typeof o['class'] !== 'string' ||
      typeof o['severity'] !== 'string' ||
      typeof o['location'] !== 'string' ||
      typeof o['rationale'] !== 'string'
    ) {
      return { findings, malformedReason: 'malformed finding shape' };
    }
    if (!OBJECTION_CLASSES.has(o['class'])) {
      return {
        findings,
        malformedReason: `unsupported finding class "${o['class']}"`,
      };
    }
    if (!OBJECTION_SEVERITIES.has(o['severity'])) {
      return {
        findings,
        malformedReason: `unsupported finding severity "${o['severity']}"`,
      };
    }
    findings.push({
      class: o['class'] as ObjectionClass,
      severity: o['severity'] as ObjectionSeverity,
      location: o['location'].slice(0, NOTE_MAX_CHARS),
      rationale: o['rationale'].slice(0, NOTE_MAX_CHARS),
      ...(typeof o['reversible'] === 'boolean' ? { reversible: o['reversible'] } : {}),
    });
  }
  return { findings };
}

function parseFindingVerifications(v: Record<string, unknown>): FindingVerification[] {
  const source = Array.isArray(v['verifiedFindings']) ? v['verifiedFindings'] : [];
  return source.flatMap((raw): FindingVerification[] => {
    if (!raw || typeof raw !== 'object') return [];
    const o = raw as Record<string, unknown>;
    if (
      typeof o['id'] !== 'string' ||
      !isFindingStatus(o['status']) ||
      typeof o['notes'] !== 'string'
    ) {
      return [];
    }
    return [{
      id: o['id'].slice(0, NOTE_MAX_CHARS),
      status: o['status'],
      notes: o['notes'].slice(0, NOTE_MAX_CHARS),
    }];
  });
}

function isFindingStatus(status: unknown): status is FindingVerification['status'] {
  return status === 'open' || status === 'resolved' || status === 'regressed';
}

function parseGateVerdict(text: string, tag: string): GateVerdict {
  const parsed = extractFencedJson(text, tag);
  if (!parsed || typeof parsed !== 'object') {
    return { outcome: 'fail', findings: [], notes: `unparseable ${tag} verdict — failing closed` };
  }
  const v = parsed as Record<string, unknown>;
  const notes = typeof v['notes'] === 'string' ? v['notes'].slice(0, NOTE_MAX_CHARS) : undefined;
  const rawOutcome = typeof v['outcome'] === 'string' ? v['outcome'] : undefined;
  const outcome = typeof v['outcome'] === 'string' && GATE_OUTCOMES.has(v['outcome'])
    ? v['outcome'] as GateOutcome
    : undefined;
  const legacyPass = typeof v['pass'] === 'boolean' ? v['pass'] : undefined;
  const { findings, malformedReason } = parseFindings(v);
  if (malformedReason !== undefined) {
    return {
      outcome: 'fail',
      findings,
      notes: notes ?? malformedReason,
    };
  }
  const normalizedFindings =
    rawOutcome === 'block'
      ? findings
      : findings.map((finding) => ({
          ...finding,
          reversible: finding.reversible ?? false,
        }));
  return {
    outcome: normalizedFindings.length > 0
      ? outcomeForFindings(normalizedFindings) ?? 'fail'
      : outcome ??
        (legacyPass !== undefined
          ? legacyPass === true ? 'pass' : 'fail'
          : 'fail'),
    findings: normalizedFindings,
    ...(notes !== undefined ? { notes } : {}),
  };
}

function outcomeForFindings(findings: ObjectionFinding[]): GateOutcome | undefined {
  if (findings.length === 0) return undefined;
  return strictestReviewerOutcome(
    findings.map((finding) => mapObjectionSeverityToOutcome(finding.severity)),
  );
}

function strictestReviewerOutcome(outcomes: GateOutcome[]): GateOutcome {
  return outcomes.reduce(
    (strictest, outcome) =>
      reviewerOutcomeRank[outcome] > reviewerOutcomeRank[strictest] ? outcome : strictest,
    'pass',
  );
}

const reviewerOutcomeRank: Record<GateOutcome, number> = {
  pass: 0,
  'pass-with-warnings': 1,
  fail: 2,
};

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

function parsePmWrapup(text: string): { resolved: boolean; rationale?: string } {
  const parsed = extractFencedJson(text, 'pm-wrapup');
  if (!parsed || typeof parsed !== 'object') {
    return { resolved: false };
  }
  const v = parsed as Record<string, unknown>;
  const resolved = v['resolved'] === true;
  const rationale = typeof v['rationale'] === 'string'
    ? v['rationale'].slice(0, NOTE_MAX_CHARS)
    : undefined;
  return {
    resolved,
    ...(rationale !== undefined ? { rationale } : {}),
  };
}

// ---------------------------------------------------------------------------
// The factory
// ---------------------------------------------------------------------------

export interface BuildTeamTaskDepsArgs {
  sandbox: SandboxSpec;
  productsConfigPath: string;
  models: TeamRoleModels;
  /** Optional activity sink; production uses this to attribute artifact
   * executor output with the invoking role/model before it reaches the
   * mutation stream. */
  emit?: (event: WorkflowActivityEvent) => void;
}

/** Compose a judgment role's two-channel charter prompt and run one call. */
function makeJudge(seams: TeamTaskSeams, projectExemplarsDir: string) {
  return (role: RoleName, binding: RoleModelBinding, instruction: string, body: string) => {
    const ctx = composeRoleContext(role, instruction, { projectExemplarsDir });
    const message = ctx.referenceContext ? `${ctx.referenceContext}\n\n${body}` : body;
    return seams.judgmentCall({
      role,
      model: binding.alias,
      systemPrompt: withProtectedLocalServicesWarning(ctx.systemInstructions),
      message,
    });
  };
}

function withProtectedLocalServicesWarning(systemInstructions: string): string {
  return `${systemInstructions}\n\n${PROTECTED_LOCAL_SERVICES_WARNING}`;
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

function formatRejectionFeedback(
  feedback: GateRejectionFeedback | GateRejectionFeedback[] | undefined,
): string {
  if (feedback === undefined) return '';
  const items = Array.isArray(feedback) ? feedback : [feedback];
  if (items.length === 0) return '';
  return [
    '## Rejection feedback for this retry',
    '',
    ...items.flatMap((item, index) => [
      `${index + 1}. ${item.rejectingRole} rejected ${item.rejectedRole}'s ${item.rejectedArtifact}.`,
      `What failed: ${item.whatFailed}`,
      `Actionable notes: ${item.actionableNotes.join('; ')}`,
      '',
    ]),
  ].join('\n').trim();
}

function formatFindingsLedger(findingsLedger: FindingsLedgerEntry[] | undefined): string {
  if (findingsLedger === undefined || findingsLedger.length === 0) return '';
  const sortedLedger = [...findingsLedger].sort(
    (a, b) => OBJECTION_SEVERITY_RANK[b.severity] - OBJECTION_SEVERITY_RANK[a.severity],
  );
  return [
    '## Open findings ledger for this round',
    '',
    ...sortedLedger.flatMap((finding, index) => [
      `${index + 1}. ${finding.id}: ${finding.sourceGate} ${finding.class}/${finding.severity} at ` +
        `${finding.location}`,
      `Status: ${finding.status}; reversible: ${finding.reversible ? 'yes' : 'no'}`,
      `Rationale: ${finding.rationale.slice(0, NOTE_MAX_CHARS)}`,
      '',
    ]),
  ].join('\n').trim();
}

function formatGateLearningRejection(feedback: GateRejectionFeedback): string {
  return [
    '<gate-rejection>',
    `rejectingRole: ${feedback.rejectingRole}`,
    `counterpartRole: ${feedback.counterpartRole}`,
    `rejectedRole: ${feedback.rejectedRole}`,
    `artifact: ${feedback.artifact}`,
    `rejectedArtifact: ${feedback.rejectedArtifact}`,
    `reason: ${feedback.reason}`,
    `whatFailed: ${feedback.whatFailed}`,
    `notes: ${feedback.notes.join('; ')}`,
    `actionableNotes: ${feedback.actionableNotes.join('; ')}`,
    '</gate-rejection>',
  ].join('\n');
}

function stageForGateRejection(feedback: GateRejectionFeedback): RoleStage | undefined {
  if (feedback.rejectedArtifact === 'test-intent' || feedback.rejectedRole === 'qa') return 'test';
  if (feedback.rejectedArtifact === 'implementation-diff' || feedback.rejectedRole === 'coder') {
    return 'implementation';
  }
  if (feedback.rejectedArtifact === 'design-review' || feedback.rejectedRole === 'designer') return 'design';
  if (feedback.rejectedRole === 'reviewer') return 'review';
  if (feedback.rejectedRole === 'tech-lead') return 'tech-spec';
  if (feedback.rejectedRole === 'pm') return 'spec';
  return undefined;
}

function gateRejectionFeedbackRecord(
  projectSlug: string,
  rejection: GateRejectionFeedback,
  candidateLesson: string,
): FeedbackRecord {
  return {
    projectSlug,
    source: `gate:${rejection.rejectingRole}:${rejection.rejectedArtifact}`,
    createdAt: new Date().toISOString(),
    issueSummary: `${rejection.rejectingRole} rejected ${rejection.rejectedRole}'s ${rejection.rejectedArtifact}: ${rejection.whatFailed}`,
    evidence: [
      formatGateLearningRejection(rejection),
      '',
      '<candidate-lesson>',
      candidateLesson,
      '</candidate-lesson>',
    ].join('\n'),
    expectedBehavior: rejection.actionableNotes.join('; '),
    actualBehavior: rejection.reason,
    reporterStage: stageForGateRejection(rejection),
  };
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
  const projectExemplarsDir = join(PROJECT_ROOT, 'docs', 'projects', sandbox.project, 'examples');
  const judge = makeJudge(seams, projectExemplarsDir);

  // The QA work product, retained so the tech-lead reviews actual test
  // content rather than bare file paths (QaResult carries only testIds).
  // Deps are built per task invocation, so this never leaks across tasks.
  let lastQaDiff = '';

  const learnFromGateRejection = async (rejection: GateRejectionFeedback): Promise<void> => {
    try {
      await runGateTriggeredLearning(rejection, {
        draftLesson: async ({ rejection: inputRejection }) => {
          const binding = bindingForRole(models, inputRejection.rejectingRole);
          if (binding === null) return null;
          const reply = await judge(
            inputRejection.rejectingRole,
            binding,
            GATE_LESSON_DRAFT_INSTRUCTION,
            formatGateLearningRejection(inputRejection),
          );
          return extractFencedJson(reply, 'gate-lesson-candidate');
        },
        validateLesson: async ({ rejection: inputRejection, candidate }) => {
          const sessionId = randomUUID();
          try {
            return await runPostMortem(
              gateRejectionFeedbackRecord(sandbox.project, inputRejection, candidate.lesson),
              {
                ask: (prompt) =>
                  askClaudeWithContext(prompt, sessionId, '', {
                    model: models.pm.alias,
                    opLabel: 'learning-postmortem',
                  }),
              },
            );
          } finally {
            cleanupSession(sessionId);
          }
        },
        writeLesson: async (role, lesson, inputRejection) => {
          const result = await writeGateLearningLesson({
            role,
            lesson,
            projectSlug: sandbox.project,
            rejection: inputRejection,
          });
          return {
            committed: result.committed,
            ...(result.captured !== undefined ? { captured: result.captured } : {}),
          };
        },
      });
    } catch (err) {
      log.warn('Gate-triggered learning failed', { error: (err as Error).message });
    }
  };

  // Two-channel split for artifact roles too: the role framing (SOUL + static
  // instruction) rides the executor's system channel; memory reference + task
  // body ride the prompt. (codex degrades to prepend — see ExecutionAgentOpts.)
  const execute = async (
    role: 'qa' | 'coder',
    binding: RoleModelBinding,
    instruction: string,
    body: string,
  ): Promise<ExecutionAgentResult> => {
    const ctx = composeRoleContext(role, instruction, { projectExemplarsDir });
    const emit = args.emit
      ? attributeRoleEvents(args.emit, role, binding)
      : undefined;
    return seams.runExecution({
      systemPrompt: withProtectedLocalServicesWarning(ctx.systemInstructions),
      prompt: ctx.referenceContext ? `${ctx.referenceContext}\n\n${body}` : body,
      sandbox,
      model: binding,
      productsConfigPath,
      ...(emit !== undefined ? { emit } : {}),
    });
  };

  return {
    // NOTE: artifact seams (qaWriteTests, coder) THROW on executor failure —
    // runTeamTaskWorkflow's outer catch turns the throw into structured
    // `failed` evidence with failureReason. That is the error-flow contract.
    qaWriteTests: async ({ task, spec, rejectionFeedback }) => {
      const feedbackBlock = formatRejectionFeedback(rejectionFeedback);
      const body = [
        `## Task\n\n${task.text}`,
        '',
        `## Spec\n\n${spec}`,
        ...(feedbackBlock !== '' ? ['', feedbackBlock] : []),
      ].join('\n');
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
      lastQaDiff = result.diff;
      return { kind: 'tests-written', testIds: filesFromDiff(result.diff) } satisfies QaResult;
    },

    techLeadReviewTests: async ({ task, qa }) => {
      const body = [
        `## Task\n\n${task.text}`,
        '',
        qa.kind === 'tests-written'
          ? `## QA tests\n\n${qa.testIds.join('\n')}\n\n## QA test diff\n\n${lastQaDiff}`
          : `## QA no-code-test rationale\n\n${qa.rationale}`,
      ].join('\n');
      const reply = await judge('tech-lead', models.techLead, TL_TEST_REVIEW_INSTRUCTION, body);
      const { value, notes } = parseFlagVerdict(reply, 'tl-test-review', 'approved');
      return { approved: value, ...(notes !== undefined ? { notes } : {}) };
    },

    coder: async ({ task, spec, context, tests, rejectionFeedback, findingsLedger }) => {
      const testsBlock = Array.isArray(tests) ? tests.join('\n') : tests;
      const feedbackBlock = formatRejectionFeedback(rejectionFeedback);
      const findingsBlock = scrubPathsInText(formatFindingsLedger(findingsLedger));
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
        ...(feedbackBlock !== '' ? ['', feedbackBlock] : []),
        ...(findingsBlock !== ''
          ? [
              '',
              'Fix open findings highest-severity-first; do not spend the round on lower-severity ' +
                'residue before higher-severity findings are addressed.',
            ]
          : []),
        ...(findingsBlock !== '' ? ['', findingsBlock] : []),
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
    reviewer: async ({ diff, spec, tests, task, context, findingsLedger }) => {
      const testsBlock = Array.isArray(tests) ? tests.join('\n') : tests;
      const findingsBlock = scrubPathsInText(formatFindingsLedger(findingsLedger));
      if (models.reviewer === null) {
        // Deliberate belt-and-suspenders: Gate 0 normally blocks first, but a
        // reviewer verdict must never be fabricable without a resolved
        // independent reviewer, even if a future caller skips the gate.
        return { outcome: 'fail', findings: [] };
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
        ...(findingsBlock !== '' ? ['', findingsBlock] : []),
      ].join('\n');
      const reply = await judge('reviewer', models.reviewer, REVIEWER_INSTRUCTION, body);
      return parseReviewerVerdict(reply);
    },

    techLeadReviewDiff: async ({ task, diff, spec, context, findingsLedger }) => {
      const findingsBlock = scrubPathsInText(formatFindingsLedger(findingsLedger));
      const body = [
        `## Task\n\n${task.text}`,
        '',
        `## Diff\n\n${diff}`,
        ...(spec !== undefined ? ['', `## Spec\n\n${spec}`] : []),
        ...(context !== undefined ? ['', `## Project context / tree-state evidence\n\n${scrubPathsInText(context)}`] : []),
        ...(findingsBlock !== '' ? ['', findingsBlock] : []),
      ].join('\n');
      const reply = await judge('tech-lead', models.techLead, TL_DIFF_REVIEW_INSTRUCTION, body);
      return parseGateVerdict(reply, 'tl-diff-review');
    },

    designer: async ({ task, diff, findingsLedger }) => {
      const findingsBlock = scrubPathsInText(formatFindingsLedger(findingsLedger));
      const body = [
        `## Task\n\n${task.text}`,
        '',
        `## Diff\n\n${diff}`,
        ...(findingsBlock !== '' ? ['', findingsBlock] : []),
      ].join('\n');
      const reply = await judge('designer', models.designer, DESIGNER_INSTRUCTION, body);
      return parseGateVerdict(reply, 'designer-review');
    },

    pmWrapup: async ({ task, reason }) => {
      const body = [`## Task\n\n${task.text}`, '', `## Situation\n\n${reason}`].join('\n');
      const reply = await judge('pm', models.pm, PM_WRAPUP_INSTRUCTION, body);
      return parsePmWrapup(reply);
    },

    onGateRejection: learnFromGateRejection,

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
  /** Optional live activity sink forwarded into runTeamTaskWorkflow. */
  emit?: (event: WorkflowActivityEvent) => void;
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
    findingsLedger: [],
    loopExitReason: 'operational',
  };
}

function bindingForRole(models: TeamRoleModels, role: string): RoleModelBinding | null {
  switch (role) {
    case 'pm':
      return models.pm;
    case 'tech-lead':
      return models.techLead;
    case 'qa':
      return models.qa;
    case 'coder':
      return models.coder;
    case 'reviewer':
      return models.reviewer;
    case 'designer':
      return models.designer;
    default:
      return null;
  }
}

function attributedLine(role: RoleName, binding: RoleModelBinding, line: string): string {
  const displayLine = redactSecrets(scrubPathsInText(line));
  return `${role} | ${binding.provider} | ${binding.alias} | ${displayLine}`;
}

function attributeRoleEvent(
  event: WorkflowActivityEvent,
  role: RoleName,
  binding: RoleModelBinding,
): WorkflowActivityEvent {
  const data: Record<string, unknown> = {
    ...(event.data ?? {}),
    role,
    provider: binding.provider,
    model: binding.alias,
  };
  if (typeof data['line'] === 'string') {
    data['line'] = attributedLine(role, binding, data['line']);
  }
  return { kind: event.kind, data };
}

function attributeRoleEvents(
  emit: (event: WorkflowActivityEvent) => void,
  role: RoleName,
  binding: RoleModelBinding,
): (event: WorkflowActivityEvent) => void {
  return (event) => {
    try {
      emit(attributeRoleEvent(event, role, binding));
    } catch {
      /* activity sinks are observability-only; they must not fail role execution. */
    }
  };
}

function attributeWorkflowEvents(
  emit: (event: WorkflowActivityEvent) => void,
  models: TeamRoleModels,
): (event: WorkflowActivityEvent) => void {
  return (event) => {
    const role = typeof event.data?.['role'] === 'string' ? event.data['role'] : undefined;
    const binding = role === undefined ? null : bindingForRole(models, role);
    if (role === undefined || binding === null) {
      emit(event);
      return;
    }
    emit(attributeRoleEvent(event, role as RoleName, binding));
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
): (
  task: SelectedTask,
  ctx: { handoff: string; contextMd: string; rejectionFeedback?: GateRejectionFeedback },
) => Promise<TaskEvidence> {
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
      {
        sandbox: args.sandbox,
        productsConfigPath: args.productsConfigPath,
        models,
        ...(args.emit !== undefined ? { emit: args.emit } : {}),
      },
      seamOverrides,
    );
    const emit = args.emit !== undefined
      ? attributeWorkflowEvents(args.emit, models)
      : undefined;

    return runTeamTaskWorkflow(
      toSizedTask(task),
      {
        // The orchestrator's bounded handoff (task + context.md + spec slices)
        // IS the per-task spec input — the fresh-context principle.
        spec: ctx.handoff,
        contextMd: ctx.contextMd,
        coderProvider: models.coder.provider,
        ...(ctx.rejectionFeedback !== undefined
          ? { rejectionFeedback: ctx.rejectionFeedback }
          : {}),
        ...(emit !== undefined ? { emit } : {}),
        cap: args.cap ?? DEFAULT_ROUND_CAP,
      },
      deps,
    );
  };
}
