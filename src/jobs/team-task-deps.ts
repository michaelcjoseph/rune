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
import { runCodex } from '../ai/codex.js';
import {
  cancelCorrelatedOps,
  clearCorrelatedCancellation,
  forceCancelCorrelatedOps,
} from '../transport/in-flight.js';
import { scrubPathsInText } from '../ai/tool-labels.js';
import { scrubAbsolutePaths } from '../utils/sanitize-paths.js';
import config, { PROJECT_ROOT } from '../config.js';
import { composeRoleContext, type RoleName } from '../roles/loader.js';
import { loadModelPolicy, resolveModel, type ModelPolicy } from '../intent/model-policy.js';
import { extractFencedJson } from '../intent/planning-roles-wiring.js';
import { runGateTriggeredLearning } from '../intent/gate-learning.js';
import { writeGateLearningLesson } from '../intent/learning-write-path.js';
import { runPostMortem } from '../intent/postmortem.js';
import type { FeedbackRecord, RoleStage } from '../intent/feedback-record.js';
import {
  mapObjectionSeverityToOutcome,
  ExecutionFailureError,
  RoleCancellationError,
  ValidationProfileUnavailableError,
  runTeamTaskWorkflow,
  SELF_REVIEW_NOTE_MAX_CHARS,
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
  type CoderResult,
  type CoderSelfReviewOutcome,
  type CanonicalReviewState,
  type TeamTaskDeps,
  type TechLeadTestRepairResult,
  type TestRepairRedCheck,
  type WorkflowActivityEvent,
} from '../intent/team-task-workflow.js';
import type { ExecutionPreflightFailure } from '../intent/execution-preflight.js';
import { defaultRunGit, type GitRunner } from './sandbox-runtime.js';
import {
  captureCanonicalReviewState,
  defaultRunCanonicalGit,
} from './canonical-git.js';
import {
  probeValidationProfile,
  runValidationCommands,
} from './work-run-gate-runtime.js';
import type { ValidationAdapter } from '../intent/full-suite-attestation.js';
import {
  planValidationProfiles,
  type ValidationCommandProfile,
} from '../intent/validation-profiles.js';
import {
  runExecutionAgent,
  type ExecutionAgentIO,
  type ExecutionAgentOpts,
  type ExecutionAgentResult,
  type RoleModelBinding,
  type TerminalArtifactResult,
} from './execution-agent.js';
import {
  adjacentExecutionFailure,
  executionFailureSummary,
  sanitizeExecutionDiagnostic,
  type ArtifactAttemptEvidence,
  type ExecutionAttempt,
  type ExecutionCheckpoint,
  type ExecutionFailure,
} from '../intent/execution-failure.js';
import type { DispatchProvider } from '../intent/dispatch.js';
import type { SelectedTask } from '../intent/orch-task-select.js';
import type { TaskBaseRecord } from '../intent/project-orchestrator.js';
import type { SizedTask } from '../intent/planning-roles.js';
import { MANUAL_LIVE_GATE_MARKER } from '../intent/planning-artifact.js';
import type { SandboxSpec } from '../intent/sandbox.js';
import { redactSecrets } from './work-run-transcript.js';
import { getBaseEnv } from './credential-injector.js';
import { createLogger } from '../utils/logger.js';
import { formatProtectedLocalServicesWarning } from '../utils/protected-local-services.js';
import {
  boundExecutionPreflightText,
  preflightExecution,
  sanitizeExecutionPreflightFailure,
  type ExecutionPreflightResult,
  type PreflightExecutionArgs,
} from './execution-preflight.js';
import {
  resolveValidationCwd,
  parseValidationCommand,
  validateTaskValidationAdmission,
} from './task-validation.js';
import type { TaskValidationFailure } from '../intent/task-validation.js';

export type {
  ExecutionPreflightFailure,
  ExecutionPreflightPrerequisite,
  ExecutionPreflightResult,
  ExecutionPreflightSuccess,
} from './execution-preflight.js';

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
  (input: {
    role: RoleName;
    model: string;
    provider?: DispatchProvider;
    format?: RoleModelBinding['format'];
    product?: string;
    systemPrompt: string;
    message: string;
    sessionId?: string;
    judgmentBatchId?: string;
  }): Promise<string>;
}

export interface TeamTaskSeams {
  /** Run-scoped prerequisite gate, invoked after policy resolution and before
   * dependency construction or any role workflow call. */
  preflightExecution: (args: PreflightExecutionArgs) => Promise<ExecutionPreflightResult>;
  judgmentCall: JudgmentModelCall;
  runExecution: (
    opts: ExecutionAgentOpts,
    io?: Partial<ExecutionAgentIO>,
  ) => Promise<ExecutionAgentResult>;
  /** Legacy test seam retained for fixture compatibility. Product-influenced
   * repair staging uses `runCanonicalGit`. */
  runGit: GitRunner;
  /** Credential-stripped/network-denied Git for product-influenced staging. */
  runCanonicalGit: GitRunner;
  /** Validation-command runner for the post-repair confirm-red check. */
  runRepairValidation: typeof runValidationCommands;
  /** Revalidate the configured command directory immediately before a command
   * run so role writes cannot turn a previously safe path into a symlink escape. */
  resolveValidationCwd: typeof resolveValidationCwd;
}

/** Production judgment call: SOUL on the system channel, one throwaway
 *  session per invocation (fresh context, no cross-role bleed), cleaned up
 *  immediately. */
const defaultJudgmentCall: JudgmentModelCall = async ({
  role,
  model,
  format = 'claude',
  systemPrompt,
  message,
  product,
  sessionId: providedSessionId,
  judgmentBatchId,
}) => {
  if (format === 'codex') {
    const result = await runCodex(`${systemPrompt}\n\n${message}`, {
      model,
      sandboxMode: 'read-only',
      opLabel: `team:${role}`,
      opKind: 'agent',
      agentName: role,
      ...(product !== undefined ? { product } : {}),
      env: getBaseEnv(['OPENAI_API_KEY', 'CODEX_HOME', 'HOME', 'PATH', 'TMPDIR']),
      ...(judgmentBatchId !== undefined ? { batchId: judgmentBatchId } : {}),
    });
    if (result.cancellation !== undefined) {
      throw new RoleCancellationError(role, result.cancellation);
    }
    if (result.error) {
      throw new Error(`team role '${role}' model call failed: ${result.error}`);
    }
    return result.text ?? '';
  }

  const sessionId = providedSessionId ?? randomUUID();
  const ownsSession = providedSessionId === undefined;
  try {
    const result = await askClaudeWithContext(message, sessionId, systemPrompt, {
      model,
      opLabel: `team:${role}`,
      opKind: 'agent',
      agentName: role,
      ...(product !== undefined ? { product } : {}),
      ...(judgmentBatchId !== undefined ? { batchId: judgmentBatchId } : {}),
    });
    if (result.cancellation !== undefined) {
      throw new RoleCancellationError(role, result.cancellation);
    }
    if (result.error) {
      throw new Error(`team role '${role}' model call failed: ${result.error}`);
    }
    return result.text ?? '';
  } finally {
    if (ownsSession) {
      cleanupSession(sessionId);
    }
  }
};

const defaultSeams: TeamTaskSeams = {
  preflightExecution,
  judgmentCall: defaultJudgmentCall,
  runExecution: runExecutionAgent,
  runGit: defaultRunGit,
  runCanonicalGit: defaultRunCanonicalGit,
  runRepairValidation: runValidationCommands,
  resolveValidationCwd,
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
  'The diff is the COMPLETE implementation for this task relative to its durable',
  'pre-mutation task-base tree. It includes task-owned changes from earlier coder',
  'rounds and role-created commits even when HEAD advanced. Absence from this',
  'artifact is therefore a genuine signal that the task did not implement it.',
  'The diff is not the whole repository: pre-existing code outside this task may',
  'still satisfy dependencies described by the spec or project context.',
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
  'For every finding, include `suggestedChange`: the concrete change that would',
  'clear that finding. For a fail outcome without findings, include a verdict-',
  'level `suggestedChange` that tells the coder what to change.',
  '',
  'Test-deletion guardrail: when the diff deletes or weakens a test (a deleted',
  'test file, a removed or skipped case, an assertion gutted to keep it green),',
  'pass it ONLY when the `## Coder handoff notes` below justify the removal —',
  'an external/live dependency the sandbox cannot run, or a demonstrated flake.',
  'An unjustified test deletion or weakening is a fail outcome (ordinary',
  'quality, not an objection class): name the test and require it restored.',
  '',
  'Respond with EXACTLY ONE fenced ```reviewer-verdict block containing JSON,',
  'and nothing after the fence. The verdict must carry exactly one `outcome`',
  'value: pass, pass-with-warnings, or fail:',
  '```reviewer-verdict',
  '{"outcome": "pass", "notes": "<short non-objection feedback>", "suggestedChange": "<concrete change for non-finding fail, omit when not needed>", "verifiedFindings": [{"id": "finding-...", "status": "resolved", "notes": "<what you verified>"}], "findings": [{"class": "security", "severity": "high", "location": "<file:line>", "rationale": "<why>", "suggestedChange": "<concrete change that clears this finding>", "reversible": true}]}',
  '```',
  'An empty findings array means no objection-class finding.',
].join('\n');

const TL_TEST_REVIEW_INSTRUCTION = [
  'You are the tech lead. QA\'s test work for the task is below — review the TEST',
  'INTENT before the coder starts: do the tests (or the no-code-test rationale)',
  'actually pin the task\'s contract?',
  'If you reject the test intent, include `suggestedChange`: the concrete test',
  'or rationale change that would clear the rejection. Also include `repairable`:',
  'set it to false ONLY when the tests need structural rework or expose a spec',
  'ambiguity you cannot resolve alone; a bounded gap (a missing or weak',
  'assertion) is repairable — you will patch it yourself.',
  '',
  'Respond with EXACTLY ONE fenced ```tl-test-review block containing JSON:',
  '```tl-test-review',
  '{"approved": true, "notes": "<short reason>", "suggestedChange": "<concrete change if approved is false>", "repairable": true}',
  '```',
].join('\n');

const TL_TEST_REPAIR_INSTRUCTION = [
  'You are the tech lead. You rejected QA\'s test intent for the task below —',
  'repair the TESTS yourself: add or adjust the assertions named in your',
  'rejection so the tests pin the task\'s contract.',
  '',
  'Edit ONLY test files (*.test.ts / *.test.tsx). Do NOT implement the product',
  'feature, do NOT touch product source, and do not commit — any change outside',
  'the test files is reverted mechanically.',
  '',
  'The coder has not run yet, so the tests must still FAIL against the current',
  'tree; do not weaken them into passing vacuously.',
  '',
  'If the tests need structural rework or the spec is ambiguous, change nothing',
  'and print one paragraph explaining why.',
].join('\n');

const TL_DIFF_REVIEW_INSTRUCTION = [
  'You are the tech lead. Review the diff below for technical coherence with the',
  'task: interfaces, contracts, sequencing, and fit with the existing system.',
  '',
  'You have NO tools and NO repository access: no file system, no grep, no ability',
  'to open or search files. You see ONLY the artifacts in this prompt. Never claim',
  'to have grepped, searched, read files, or verified on disk.',
  '',
  'The diff is the COMPLETE implementation for this task relative to its durable',
  'pre-mutation task-base tree. It includes task-owned changes from earlier coder',
  'rounds and role-created commits even when HEAD advanced. Treat a required',
  'deliverable as missing when it is absent from this full-task artifact and is',
  'not pre-existing behavior established by the spec or project context.',
  'For every finding, include `suggestedChange`: the concrete change that would',
  'clear that finding. For a fail outcome without findings, include a verdict-',
  'level `suggestedChange` that tells the coder what to change.',
  '',
  'Test-deletion guardrail: a diff that deletes or weakens a test (deleted test',
  'file, removed or skipped case, gutted assertion) passes only when the',
  '`## Coder handoff notes` below justify it — an external/live dependency the',
  'sandbox cannot run, or a demonstrated flake. Unjustified deletion or',
  'weakening of a test is a fail outcome: name the test and require it restored.',
  '',
  'Test integrity: you are the only gate on the tests after implementation, so',
  'answer all three of these against the QA tests you reviewed before the coder',
  'started. Any finding you raise from them MUST cite the offending test file.',
  '1. Did this diff delete, weaken, or RETARGET a QA-authored test — including',
  '   pointing an assertion at a different value, symbol, or code path so it',
  '   passes against this implementation rather than the agreed contract?',
  '2. Is there behavior in this diff that no test touches?',
  '3. Does the implementation satisfy a test\'s SHAPE without its INTENT — for',
  '   example special-casing the asserted input, or returning a literal that',
  '   makes the assertion true without implementing the behavior?',
  '',
  'Respond with EXACTLY ONE fenced ```tl-diff-review block containing JSON:',
  '```tl-diff-review',
  '{"outcome": "pass", "findings": [{"class": "data-integrity", "severity": "low", "location": "<file:line>", "rationale": "<why>", "suggestedChange": "<concrete change that clears this finding>", "reversible": true}], "notes": "<short reason>", "suggestedChange": "<concrete change for non-finding fail, omit when not needed>"}',
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
  '',
  'Before you finish: run EVERY command in the `## Validation commands` section',
  'below from the worktree root and iterate (fix → re-run) until ALL exit 0.',
  'Full-suite green is your definition of done — a diff that breaks a sibling',
  'test is not done even when the QA tests pass; closeout re-runs the same',
  'commands and hard-blocks on red. If no validation commands are listed, skip',
  'this step.',
  'Last resort: a test that CANNOT pass in this sandbox (external/live',
  'dependency) or is demonstrably flaky may be removed — prefer converting it',
  'to the manual-live-gate strategy over deleting it. Record every removal as',
  'a final output line `TEST-REMOVED: <path> — <reason>`; the reviewer and',
  'tech lead fail unexplained test deletions. NEVER remove or weaken a test',
  'because your implementation fails it.',
].join('\n');

const CODER_SELF_REVIEW_EXEC_INSTRUCTION = [
  'You are the coder performing one fresh-context self-review of the implementation',
  'currently checked out in this worktree. Inspect the actual files and staged Git',
  'state. Fix any issue you find directly in the worktree, run the listed validation',
  'commands, and do not commit.',
  '',
  'Last resort: a test that CANNOT pass in this sandbox (external/live dependency)',
  'or is demonstrably flaky may be removed — prefer converting it to the',
  'manual-live-gate strategy over deleting it. NEVER remove or weaken a test',
  'because the implementation fails it. This pass emits no free-form output, so',
  'record every removal inside `notes` as `TEST-REMOVED: <path> — <reason>`; those',
  'notes reach the reviewer and tech lead, who fail unexplained test deletions.',
  '',
  'Your final output must be EXACTLY ONE fenced ```coder-self-review JSON block',
  'and nothing else. Report `confirmed` only when you made no worktree change in',
  'this pass. Report `revised` only when you edited the worktree in this pass.',
  'The object contains exactly `outcome` and `notes`; never include a diff, patch,',
  'replacement artifact, or extra field.',
  '',
  '```coder-self-review',
  '{"outcome":"confirmed","notes":"<brief concrete reason>"}',
  '```',
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
  const suggestedChange = typeof v['suggestedChange'] === 'string'
    ? v['suggestedChange'].slice(0, NOTE_MAX_CHARS)
    : undefined;
  if (malformedReason !== undefined) {
    return {
      outcome: 'fail',
      findings,
      ...(hasVerifiedFindings ? { verifiedFindings } : {}),
      notes: notes ?? malformedReason,
      ...(suggestedChange !== undefined ? { suggestedChange } : {}),
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
      ...(suggestedChange !== undefined ? { suggestedChange } : {}),
    };
  }
  return {
    outcome,
    findings,
    ...(hasVerifiedFindings ? { verifiedFindings } : {}),
    ...(notes !== undefined ? { notes } : {}),
    ...(suggestedChange !== undefined ? { suggestedChange } : {}),
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
      ...(typeof o['suggestedChange'] === 'string'
        ? { suggestedChange: o['suggestedChange'].slice(0, NOTE_MAX_CHARS) }
        : {}),
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
  const suggestedChange = typeof v['suggestedChange'] === 'string'
    ? v['suggestedChange'].slice(0, NOTE_MAX_CHARS)
    : undefined;
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
      ...(suggestedChange !== undefined ? { suggestedChange } : {}),
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
    ...(suggestedChange !== undefined ? { suggestedChange } : {}),
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

/** Fail-closed boolean-flag parser shared by the tl-test-review and
 *  qa-diff-revalidation verdicts. */
function parseFlagVerdict(
  text: string,
  tag: string,
  flag: string,
): { value: boolean; notes?: string; suggestedChange?: string; repairable?: boolean } {
  const parsed = extractFencedJson(text, tag);
  if (!parsed || typeof parsed !== 'object') {
    return { value: false, notes: `unparseable ${tag} verdict — failing closed` };
  }
  const v = parsed as Record<string, unknown>;
  const notes = typeof v['notes'] === 'string' ? v['notes'].slice(0, NOTE_MAX_CHARS) : undefined;
  const suggestedChange = typeof v['suggestedChange'] === 'string'
    ? v['suggestedChange'].slice(0, NOTE_MAX_CHARS)
    : undefined;
  return {
    value: v[flag] === true,
    ...(notes !== undefined ? { notes } : {}),
    ...(suggestedChange !== undefined ? { suggestedChange } : {}),
    ...(typeof v['repairable'] === 'boolean' ? { repairable: v['repairable'] } : {}),
  };
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

const CODER_SELF_REVIEW_FENCE =
  /^\s*```coder-self-review[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*\s*$/;
const DIFF_OR_PATCH_CONTENT =
  /(^|\n)(?:diff --git |--- (?:a\/|\/dev\/null)|\+\+\+ (?:b\/|\/dev\/null)|@@(?: |$)|```(?:diff|patch)\b)/m;

export function parseCoderSelfReviewResult(reply: string): {
  outcome: CoderSelfReviewOutcome;
  notes: string;
} {
  const match = CODER_SELF_REVIEW_FENCE.exec(reply);
  if (match === null) {
    throw new Error('coder self-review must return exactly one coder-self-review fence');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[1]!);
  } catch {
    throw new Error('coder-self-review fence contains invalid JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('coder-self-review JSON must be an object');
  }
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== 2 || keys[0] !== 'notes' || keys[1] !== 'outcome') {
    throw new Error('coder-self-review JSON must contain only outcome and notes');
  }
  if (record['outcome'] !== 'confirmed' && record['outcome'] !== 'revised') {
    throw new Error('coder-self-review outcome must be confirmed or revised');
  }
  if (typeof record['notes'] !== 'string' || record['notes'].trim() === '') {
    throw new Error('coder-self-review notes must be non-empty');
  }
  const notes = record['notes'].trim();
  if (notes.length > SELF_REVIEW_NOTE_MAX_CHARS) {
    throw new Error(
      `coder-self-review notes exceed ${SELF_REVIEW_NOTE_MAX_CHARS} characters`,
    );
  }
  if (DIFF_OR_PATCH_CONTENT.test(notes)) {
    throw new Error('coder-self-review notes must not contain diff or patch content');
  }
  return {
    outcome: record['outcome'],
    notes: redactSecrets(scrubAbsolutePaths(scrubPathsInText(notes))),
  };
}

function terminalArtifactFromExecution(
  result: Extract<ExecutionAgentResult, { ok: true }>,
  binding: RoleModelBinding,
): TerminalArtifactResult {
  if (result.terminalArtifact !== undefined) return result.terminalArtifact;
  const artifact = result.output.trim();
  const candidateCount = artifact.match(/```coder-self-review\b/g)?.length ?? 0;
  const tagged = candidateCount > 0;
  const captured = CODER_SELF_REVIEW_FENCE.test(artifact);
  return {
    provider: binding.provider,
    artifactKind: 'coder-self-review',
    status: candidateCount > 1
      ? 'ambiguous'
      : captured
        ? 'captured'
        : (tagged ? 'malformed' : 'missing'),
    progressCount: 0,
    candidateCount,
    diagnostic: candidateCount > 1
      ? 'legacy injected terminal output contained multiple coder-self-review candidates'
      : captured
      ? 'captured legacy injected terminal output'
      : 'legacy injected terminal output was not one complete coder-self-review fence',
    ...(captured && candidateCount === 1 ? { artifact } : {}),
  };
}

function artifactAttemptEvidence(
  attempt: number,
  terminal: TerminalArtifactResult,
  status: ArtifactAttemptEvidence['status'] = terminal.status,
  diagnostic: unknown = terminal.diagnostic,
): ArtifactAttemptEvidence {
  return {
    attempt,
    status,
    provider: terminal.provider,
    progressCount: Math.max(0, Math.min(10_000, terminal.progressCount)),
    candidateCount: Math.max(0, Math.min(10_000, terminal.candidateCount)),
    diagnostic: sanitizeExecutionDiagnostic(diagnostic),
  };
}

function artifactContractFailure(
  checkpoint: ExecutionCheckpoint,
  artifactAttempts: readonly ArtifactAttemptEvidence[],
  executionAttempts: readonly ExecutionAttempt[],
  disposition: ExecutionFailure['retryDisposition'],
  cancellation?: import('../cancellation.js').OperationCancellation,
): ExecutionFailure {
  const latest = artifactAttempts.at(-1)!;
  const diagnostic = latest.diagnostic;
  return {
    ...checkpoint,
    artifactAttempts: artifactAttempts.map((attempt) => ({ ...attempt })),
    failureStage: 'artifact-contract',
    diagnostic,
    retryable: false,
    attempts: executionAttempts.map((attempt) => ({
      ...attempt,
      artifactAttempts: attempt.artifactAttempts?.map((item) => ({ ...item })),
    })),
    retryDisposition: disposition,
    ...(cancellation !== undefined ? { cancellation } : {}),
  };
}

function artifactExecutionAttempt(
  checkpoint: ExecutionCheckpoint,
  evidence: ArtifactAttemptEvidence,
  retryable: boolean,
  endedAt: string,
  artifactAttempts: readonly ArtifactAttemptEvidence[],
): ExecutionAttempt {
  return {
    attempt: evidence.attempt,
    startedAt: checkpoint.checkpointedAt,
    endedAt,
    failureStage: 'artifact-contract',
    diagnostic: evidence.diagnostic,
    retryable,
    artifactAttempts: artifactAttempts.map((attempt) => ({ ...attempt })),
  };
}

function executionFailureArtifactEvidence(
  attempt: number,
  provider: DispatchProvider,
  diagnostic: unknown,
): ArtifactAttemptEvidence {
  return artifactAttemptEvidence(attempt, {
    provider,
    artifactKind: 'coder-self-review',
    status: 'rejected',
    progressCount: 0,
    candidateCount: 0,
    diagnostic: sanitizeExecutionDiagnostic(diagnostic),
  });
}

// ---------------------------------------------------------------------------
// The factory
// ---------------------------------------------------------------------------

export interface BuildTeamTaskDepsArgs {
  sandbox: SandboxSpec;
  productsConfigPath: string;
  models: TeamRoleModels;
  /** Durable tree captured before QA/coder mutation for this task. */
  taskBaseTree: string;
  /** The product's `validationCommands` (products.json), rendered into the
   *  coder prompt so the coder self-gates on full-suite green before handback;
   *  closeout re-runs the same commands as the confirming backstop. Optional
   *  so fixture callers compile; absent/empty ⇒ no validation section in the
   *  coder body (prior behavior). */
  validationCommands?: string[];
  validationCommandProfiles?: ValidationCommandProfile[];
  validationAdapters?: ValidationAdapter[];
  /** Already boundary-validated directory used by mechanical command runners. */
  validationCommandCwd?: string;
  /** Worktree-relative label rendered in the coder prompt. */
  validationCwdLabel?: string;
  /** Optional activity sink; production uses this to attribute artifact
   * executor output with the invoking role/model before it reaches the
   * mutation stream. */
  emit?: (event: WorkflowActivityEvent) => void;
  /** Persisted before each artifact-role child is invoked. A failed write
   * blocks before spawn so restart attribution never lies. */
  persistExecutionCheckpoint?: (checkpoint: ExecutionCheckpoint) => Promise<void>;
  cancellationDuringBackoff?: () => import('../cancellation.js').OperationCancellation | undefined;
}

function executionCheckpoint(
  taskId: string,
  role: RoleName,
  binding: RoleModelBinding,
  workflowStage: string,
  artifactAttempts?: readonly ArtifactAttemptEvidence[],
): ExecutionCheckpoint {
  return {
    taskId,
    role,
    provider: binding.provider,
    format: binding.format,
    model: binding.alias,
    workflowStage,
    checkpointedAt: new Date().toISOString(),
    ...(artifactAttempts !== undefined && artifactAttempts.length > 0
      ? {
          artifactAttempts: artifactAttempts.map((attempt) => ({
            ...attempt,
          })),
        }
      : {}),
  };
}

function judgmentBatchCheckpoint(
  task: SizedTask,
  batchId: string,
  models: TeamRoleModels,
): ExecutionCheckpoint {
  if (models.reviewer === null) {
    throw new Error('judgment batch requires an independent reviewer binding');
  }
  const members = [
    {
      role: 'qa',
      binding: models.qa,
      workflowStage: 'qa-diff-revalidation',
    },
    {
      role: 'reviewer',
      binding: models.reviewer,
      workflowStage: 'reviewer-review',
    },
    {
      role: 'tech-lead',
      binding: models.techLead,
      workflowStage: 'tech-lead-diff-review',
    },
    ...(task.designerNeeded
      ? [{
          role: 'designer',
          binding: models.designer,
          workflowStage: 'designer-review',
        }]
      : []),
  ];
  return {
    taskId: task.id,
    role: 'judgment-batch',
    provider: models.qa.provider,
    format: models.qa.format,
    model: models.qa.alias,
    workflowStage: 'post-coder-judgments',
    checkpointedAt: new Date().toISOString(),
    judgmentBatch: {
      batchId,
      members: members.map(({ role, binding, workflowStage }) => ({
        role,
        provider: binding.provider,
        format: binding.format,
        model: binding.alias,
        workflowStage,
      })),
    },
  };
}

async function runCheckpointed<T>(
  checkpoint: ExecutionCheckpoint,
  persist: BuildTeamTaskDepsArgs['persistExecutionCheckpoint'],
  call: () => Promise<T>,
): Promise<T> {
  try {
    await persist?.(checkpoint);
    return await call();
  } catch (err) {
    if (err instanceof RoleCancellationError || err instanceof ExecutionFailureError) throw err;
    throw new ExecutionFailureError(adjacentExecutionFailure(checkpoint, err));
  }
}

/** Compose a judgment role's two-channel charter prompt and run one call. */
function makeJudge(
  seams: TeamTaskSeams,
  projectExemplarsDir: string,
  product: string,
  persistExecutionCheckpoint?: (checkpoint: ExecutionCheckpoint) => Promise<void>,
  persistJudgmentBatchCheckpoint?: (
    batchId: string,
    checkpoint: ExecutionCheckpoint,
  ) => Promise<void>,
) {
  return async <T = string>(
    role: RoleName,
    binding: RoleModelBinding,
    instruction: string,
    body: string,
    taskId = 'orchestration',
    workflowStage = `${role}-judgment`,
    judgmentBatchId?: string,
    parse?: (reply: string) => T,
    batchCheckpoint?: ExecutionCheckpoint,
  ): Promise<T> => {
    const ctx = composeRoleContext(role, instruction, { projectExemplarsDir });
    const message = ctx.referenceContext ? `${ctx.referenceContext}\n\n${body}` : body;
    const checkpoint = executionCheckpoint(taskId, role, binding, workflowStage);
    return runCheckpointed(
      checkpoint,
      batchCheckpoint === undefined ? persistExecutionCheckpoint : undefined,
      async () => {
        if (batchCheckpoint !== undefined && judgmentBatchId !== undefined) {
          await persistJudgmentBatchCheckpoint?.(judgmentBatchId, batchCheckpoint);
        }
        const reply = await seams.judgmentCall({
          role,
          model: binding.alias,
          provider: binding.provider,
          format: binding.format,
          product,
          systemPrompt: withProtectedLocalServicesWarning(ctx.systemInstructions),
          message,
          ...(judgmentBatchId !== undefined ? { judgmentBatchId } : {}),
        });
        return parse === undefined ? reply as T : parse(reply);
      },
    );
  };
}

function requireFlagVerdict(text: string, tag: string, flag: string): void {
  const parsed = extractFencedJson(text, tag);
  if (!parsed || typeof parsed !== 'object' || typeof (parsed as Record<string, unknown>)[flag] !== 'boolean') {
    throw new Error(`malformed ${tag}: expected one fenced object with boolean ${flag}`);
  }
}

function requireGateVerdict(text: string, tag: string): void {
  const parsed = extractFencedJson(text, tag);
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`malformed ${tag}: expected one fenced verdict object`);
  }
  const value = parsed as Record<string, unknown>;
  const validOutcome =
    typeof value['outcome'] === 'string' &&
    (GATE_OUTCOMES.has(value['outcome']) || value['outcome'] === 'block');
  if (!validOutcome && typeof value['pass'] !== 'boolean') {
    throw new Error(`malformed ${tag}: expected a supported outcome`);
  }
  if (value['findings'] !== undefined && !Array.isArray(value['findings'])) {
    throw new Error(`malformed ${tag}: findings must be an array`);
  }
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

/** The one place the full-task artifact header is rendered. Every judgment role
 * (QA revalidation, reviewer, tech lead, designer) must see byte-identical
 * base/current/hash identities for a given pass, so they cannot be hand-built
 * per call site. QA additionally gets a `pass:` line — it is the only role that
 * distinguishes a first-pass artifact from a retry-derived one. */
function formatFullTaskReviewArtifact(
  diff: string,
  reviewState?: Omit<CanonicalReviewState, 'diff'>,
  artifactPass?: string,
): string {
  return [
    '## Complete task implementation relative to durable task base',
    '',
    ...(artifactPass !== undefined ? [`pass: ${artifactPass}`] : []),
    `task-base-tree: ${reviewState?.baseTree ?? 'unavailable'}`,
    `current-review-tree: ${reviewState?.currentTree ?? 'unavailable'}`,
    `full-task-review-hash: ${reviewState?.hash ?? 'unavailable'}`,
    '',
    diff,
  ].join('\n');
}

/** Keep-the-end cap on the confirm-red output tail carried into the re-review
 *  prompt (the failure summary lives at the end of a test-runner's output). */
const REPAIR_RED_TAIL_MAX_CHARS = 4_000;

/** Parse `git diff-tree -r -z --name-status --no-renames` output:
 *  NUL-separated `<status>\0<path>` pairs. */
function parseNameStatusZ(stdout: string): Array<{ status: string; path: string }> {
  const parts = stdout.split('\0').filter((part) => part !== '');
  const entries: Array<{ status: string; path: string }> = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    entries.push({ status: parts[i]!, path: parts[i + 1]! });
  }
  return entries;
}

/** The repair guard's allowlist: test files ONLY. Deliberately NOT widened to
 *  QA's diff paths (`qa.testIds`) — those are every path QA touched, so a QA
 *  stray into product source would silently license the tech-lead to edit the
 *  same source (codex review finding, 2026-07-08). A repair that needs a
 *  non-test-file change is structural by definition — that's the QA bounce. */
function isAllowedRepairPath(path: string): boolean {
  return /\.test\.tsx?$/.test(path);
}

/** A compact handoff note from the executor's textual output — the tail only,
 *  so a verbose CLI transcript can never become a context-curator dump. */
function tailNote(output: string): string[] {
  const trimmed = output.trim();
  if (trimmed === '') return [];
  return [trimmed.slice(-300)];
}

/** The coder's handoff notes rendered for the reviewer/tech-lead bodies —
 *  the artifact channel the test-deletion guardrail reads TEST-REMOVED
 *  justifications from. Empty string when there are no notes. */
function formatCoderHandoffNotes(notes: string[] | undefined): string {
  if (notes === undefined || notes.length === 0) return '';
  return `## Coder handoff notes\n\n${scrubPathsInText(notes.map((note) => `- ${note}`).join('\n'))}`;
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

function formatFindingsLedger(
  findingsLedger: readonly FindingsLedgerEntry[] | undefined,
): string {
  if (findingsLedger === undefined || findingsLedger.length === 0) return '';
  const sortedLedger = [...findingsLedger].sort(
    (a, b) => OBJECTION_SEVERITY_RANK[b.severity] - OBJECTION_SEVERITY_RANK[a.severity],
  );
  return scrubPathsInText([
    '## Open findings ledger for this round',
    '',
    ...sortedLedger.flatMap((finding, index) => [
      `${index + 1}. ${finding.id}: ${finding.sourceGate} ${finding.class}/${finding.severity} at ` +
        `${finding.location}`,
      `Status: ${finding.status}; reversible: ${finding.reversible ? 'yes' : 'no'}`,
      `Rationale: ${finding.rationale.slice(0, NOTE_MAX_CHARS)}`,
      ...(finding.suggestedChange !== undefined && finding.suggestedChange.trim() !== ''
        ? [`Suggested change: ${finding.suggestedChange.slice(0, NOTE_MAX_CHARS)}`]
        : []),
      '',
    ]),
  ].join('\n').trim());
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
  const validationCommands = args.validationCommands ?? [];
  const validationCommandCwd = args.validationCommandCwd ?? sandbox.worktree;
  const validationCwdLabel = args.validationCwdLabel?.trim() || '.';
  const projectExemplarsDir = join(PROJECT_ROOT, 'docs', 'projects', sandbox.project, 'examples');
  const batchCheckpoints = new Map<string, ExecutionCheckpoint>();
  const batchCheckpointWrites = new Map<string, Promise<void>>();
  const persistJudgmentBatchCheckpoint = (
    batchId: string,
    checkpoint: ExecutionCheckpoint,
  ): Promise<void> => {
    const existing = batchCheckpointWrites.get(batchId);
    if (existing !== undefined) return existing;
    const pending = Promise.resolve().then(
      () => args.persistExecutionCheckpoint?.(checkpoint),
    );
    batchCheckpointWrites.set(batchId, pending);
    return pending;
  };
  const getJudgmentBatchCheckpoint = (
    task: SizedTask,
    batchId: string | undefined,
  ): ExecutionCheckpoint | undefined => {
    if (batchId === undefined) return undefined;
    const existing = batchCheckpoints.get(batchId);
    if (existing !== undefined) return existing;
    const checkpoint = judgmentBatchCheckpoint(task, batchId, models);
    batchCheckpoints.set(batchId, checkpoint);
    return checkpoint;
  };
  const judge = makeJudge(
    seams,
    projectExemplarsDir,
    sandbox.product,
    args.persistExecutionCheckpoint,
    persistJudgmentBatchCheckpoint,
  );

  // The QA work product, retained so the tech-lead reviews actual test
  // content rather than bare file paths (QaResult carries only testIds).
  // Deps are built per task invocation, so this never leaks across tasks.
  let lastQaDiff = '';
  // Confirm-red evidence from the last test-intent repair, rendered into the
  // re-review body so the tech-lead judges red-for-the-right-reason. Cleared
  // on the next QA attempt — a fresh QA diff invalidates repair evidence.
  let lastRepairRedCheck: TestRepairRedCheck | undefined;

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
      if (err instanceof RoleCancellationError) throw err;
      log.warn('Gate-triggered learning failed', { error: (err as Error).message });
    }
  };

  // Two-channel split for artifact roles too: the role framing (SOUL + static
  // instruction) rides the executor's system channel; memory reference + task
  // body ride the prompt. (codex degrades to prepend — see ExecutionAgentOpts.)
  const execute = async (
    role: 'qa' | 'coder' | 'tech-lead',
    binding: RoleModelBinding,
    taskId: string,
    workflowStage: string,
    instruction: string,
    body: string,
    executionOpts: {
      artifactAttempts?: readonly ArtifactAttemptEvidence[];
      preserveCancellationResult?: boolean;
      onCheckpoint?: (checkpoint: ExecutionCheckpoint) => void;
    } = {},
  ): Promise<ExecutionAgentResult> => {
    const ctx = composeRoleContext(role, instruction, { projectExemplarsDir });
    const emit = args.emit
      ? attributeRoleEvents(args.emit, role, binding)
      : undefined;
    const checkpoint = executionCheckpoint(
      taskId,
      role,
      binding,
      workflowStage,
      executionOpts.artifactAttempts,
    );
    executionOpts.onCheckpoint?.(checkpoint);
    try {
      await args.persistExecutionCheckpoint?.(checkpoint);
    } catch (err) {
      return { ok: false, failure: adjacentExecutionFailure(
        checkpoint,
        `execution checkpoint write failed: ${(err as Error).message}`,
      ) };
    }
    const result = await seams.runExecution({
      systemPrompt: withProtectedLocalServicesWarning(ctx.systemInstructions),
      prompt: ctx.referenceContext ? `${ctx.referenceContext}\n\n${body}` : body,
      sandbox,
      model: binding,
      role,
      taskId,
      workflowStage,
      checkpoint,
      productsConfigPath,
      ...(emit !== undefined ? { emit } : {}),
    }, args.cancellationDuringBackoff === undefined ? undefined : {
      cancellationDuringBackoff: args.cancellationDuringBackoff,
    });
    if (
      !result.ok &&
      result.cancellation !== undefined &&
      executionOpts.preserveCancellationResult !== true
    ) {
      throw new RoleCancellationError(role, result.cancellation);
    }
    return result;
  };

  return {
    // NOTE: artifact seams (qaWriteTests, coder) THROW on executor failure —
    // runTeamTaskWorkflow's outer catch turns the throw into structured
    // `failed` evidence with failureReason. That is the error-flow contract.
    qaWriteTests: async ({ task, spec, rejectionFeedback }) => {
      lastRepairRedCheck = undefined;
      const feedbackBlock = formatRejectionFeedback(rejectionFeedback);
      const body = [
        `## Task\n\n${task.text}`,
        '',
        `## Spec\n\n${spec}`,
        ...(feedbackBlock !== '' ? ['', feedbackBlock] : []),
      ].join('\n');
      const result = await execute('qa', models.qa, task.id, 'qa-tests', QA_EXEC_INSTRUCTION, body);
      if (!result.ok) {
        throw new ExecutionFailureError(result.failure);
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
      const redCheckSection = lastRepairRedCheck === undefined
        ? undefined
        : lastRepairRedCheck.kind === 'red'
          ? '## Confirm-red evidence (post-repair)\n\nThe patched tests were run before ' +
            `this review: \`${lastRepairRedCheck.command}\` exited ` +
            `${lastRepairRedCheck.exitCode} (red, as required pre-implementation — judge ` +
            'whether the failure is the expected one). Output tail:\n\n' +
            lastRepairRedCheck.outputTail
          : `## Confirm-red evidence (post-repair)\n\nRed-check skipped: ${lastRepairRedCheck.reason}`;
      const body = [
        `## Task\n\n${task.text}`,
        '',
        qa.kind === 'tests-written'
          ? `## QA tests\n\n${qa.testIds.join('\n')}\n\n## QA test diff\n\n${lastQaDiff}`
          : `## QA no-code-test rationale\n\n${qa.rationale}`,
        ...(redCheckSection !== undefined ? ['', redCheckSection] : []),
      ].join('\n');
      const reply = await judge('tech-lead', models.techLead, TL_TEST_REVIEW_INSTRUCTION, body, task.id, 'tech-lead-test-review');
      const { value, notes, suggestedChange, repairable } = parseFlagVerdict(
        reply,
        'tl-test-review',
        'approved',
      );
      return {
        approved: value,
        ...(notes !== undefined ? { notes } : {}),
        ...(suggestedChange !== undefined ? { suggestedChange } : {}),
        ...(repairable !== undefined ? { repairable } : {}),
      };
    },

    techLeadRepairTests: async ({ task, spec, qa, rejection }) => {
      const cwd = sandbox.worktree;
      const git = (gitArgs: string[]) => seams.runCanonicalGit(gitArgs, { cwd });
      const notRepaired = (reason: string): TechLeadTestRepairResult => ({
        kind: 'not-repaired',
        reason,
      });
      // Revert a set of delta entries back to the pre-repair snapshot: paths
      // the repair ADDED are removed (they don't exist in the snapshot tree);
      // everything else is restored from it. Load-bearing, not cosmetic:
      // closeout later stages `git add -A`, so a stray write that survives
      // here would be committed with the task.
      const revertEntries = async (
        preTree: string,
        entries: Array<{ status: string; path: string }>,
      ): Promise<void> => {
        for (const entry of entries) {
          if (entry.status === 'A') {
            await git(['rm', '-f', '--', entry.path]);
          } else {
            await git(['restore', '--source', preTree, '--staged', '--worktree', '--', entry.path]);
          }
        }
        await git(['add', '-A']);
      };

      // The whole repair is best-effort by contract: every failure degrades to
      // `not-repaired` (the workflow falls back to the QA bounce), never a
      // task-fatal throw.
      try {
        // 1. Snapshot BEFORE spending an executor call. `write-tree` after
        //    `add -A` captures untracked files too (`git stash create` would
        //    not), and QA's uncommitted work stays untouched in the worktree.
        await git(['add', '-A']);
        const preTree = (await git(['write-tree'])).stdout.trim();
        if (preTree === '') {
          return notRepaired('pre-repair snapshot produced no tree');
        }

        // 2. The tech-lead patches the tests in the worktree. Point it only
        //    at paths the guard will accept — a QA stray (e.g. product source
        //    in QA's diff) must not be advertised as an editable test file.
        const editableTestFiles = qa.testIds.filter((path) => isAllowedRepairPath(path));
        const body = [
          `## Task\n\n${task.text}`,
          '',
          `## Spec\n\n${spec}`,
          '',
          `## QA test files\n\n${editableTestFiles.join('\n')}`,
          '',
          `## Your rejection\n\n${rejection.reason}`,
          ...(rejection.suggestedChange !== undefined
            ? ['', `## Suggested change\n\n${rejection.suggestedChange}`]
            : []),
          '',
          `## Current QA test diff\n\n${lastQaDiff}`,
        ].join('\n');
        const result = await execute(
          'tech-lead',
          models.techLead,
          task.id,
          'tech-lead-test-repair',
          TL_TEST_REPAIR_INSTRUCTION,
          body,
        );

        // 3. The repair delta is computed with git against the snapshot — the
        //    executor's returned diff is scrubbed AND includes QA's uncommitted
        //    changes, so it cannot drive the guard.
        await git(['add', '-A']);
        const postTree = (await git(['write-tree'])).stdout.trim();
        const delta = postTree === preTree
          ? []
          : parseNameStatusZ(
              (await git([
                'diff-tree', '-r', '-z', '--name-status', '--no-renames', preTree, postTree,
              ])).stdout,
            );
        if (!result.ok) {
          await revertEntries(preTree, delta);
          throw new ExecutionFailureError(result.failure);
        }
        if (delta.length === 0) {
          return notRepaired('tech-lead made no changes');
        }

        // 4. Path guard: revert anything outside the test allowlist.
        const violations = delta.filter(
          (entry) => !isAllowedRepairPath(entry.path),
        );
        const surviving = delta.filter(
          (entry) => isAllowedRepairPath(entry.path),
        );
        if (violations.length > 0) {
          await revertEntries(preTree, violations);
        }
        if (surviving.length === 0) {
          return notRepaired('repair touched only non-test paths — reverted');
        }

        // 5. Confirm-red: the patched tests must still fail against the
        //    not-yet-written implementation, or the gate would approve a
        //    vacuous/green test.
        let redCheck: TestRepairRedCheck;
        if (validationCommands.length === 0) {
          redCheck = { kind: 'skipped', reason: 'no validation commands configured' };
        } else {
          let commandCwd = validationCommandCwd;
          if (args.validationCwdLabel !== undefined) {
            const refreshed = seams.resolveValidationCwd(
              sandbox.worktree,
              validationCwdLabel === '.' ? undefined : validationCwdLabel,
            );
            if (!refreshed.ok) {
              await revertEntries(preTree, surviving);
              return notRepaired(
                `validation directory became invalid: ${refreshed.failure.validationCwd ?? validationCwdLabel}`,
              );
            }
            commandCwd = refreshed.cwd;
          }
          const validation = await seams.runRepairValidation(
            validationCommands,
            commandCwd,
            config.WORK_RUN_GATE_COMMAND_TIMEOUT_MS,
            undefined,
            undefined,
            (args.validationCommandProfiles?.length ?? 0) > 0
              ? {
                  commandProfiles: args.validationCommandProfiles!,
                  adapters: args.validationAdapters ?? [],
                }
              : undefined,
          );
          if (validation.ok) {
            await revertEntries(preTree, surviving);
            return notRepaired(
              'patched tests pass with no implementation — vacuous or behavior-pinning; routing back to QA',
            );
          }
          if (validation.result.timedOut) {
            await revertEntries(preTree, surviving);
            return notRepaired(`confirm-red run timed out on: ${validation.command}`);
          }
          if (validation.result.failureClass === 'profile-unavailable') {
            await revertEntries(preTree, surviving);
            throw new ValidationProfileUnavailableError({
              kind: 'profile-unavailable',
              command: validation.command,
              prerequisite: validation.result.profile ?? 'validation profile',
              exitCode: null,
              timedOut: false,
              diagnostics: 'required validation capability became unavailable during confirm-red',
            });
          }
          redCheck = {
            kind: 'red',
            command: validation.command,
            exitCode: validation.result.exitCode,
            outputTail: redactSecrets(
              scrubPathsInText(validation.result.outputTail.slice(-REPAIR_RED_TAIL_MAX_CHARS)),
            ),
          };
        }

        // 6. Land the repair in the seam state: the re-review and
        //    qaRevalidateDiff read `lastQaDiff`, so it must reflect the
        //    patched tests (same capture + scrubbing as the execution agent).
        const diffResult = await git(['diff', 'HEAD']);
        lastQaDiff = redactSecrets(scrubPathsInText(diffResult.stdout));
        lastRepairRedCheck = redCheck;
        const testIds = [
          ...new Set([
            ...qa.testIds,
            ...surviving.filter((entry) => entry.status !== 'D').map((entry) => entry.path),
          ]),
        ];
        return { kind: 'repaired', testIds, redCheck };
      } catch (err) {
        if (
          err instanceof ExecutionFailureError ||
          err instanceof RoleCancellationError ||
          err instanceof ValidationProfileUnavailableError
        ) throw err;
        return notRepaired(`tech-lead repair failed: ${(err as Error).message}`);
      }
    },

    coder: async ({ task, spec, context, tests, rejectionFeedback, findingsLedger }) => {
      const testsBlock = Array.isArray(tests) ? tests.join('\n') : tests;
      const feedbackBlock = formatRejectionFeedback(rejectionFeedback);
      const findingsBlock = formatFindingsLedger(findingsLedger);
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
        ...(validationCommands.length > 0
          ? [
              '',
              `## Validation commands (run all from \`${validationCwdLabel}\` relative to the worktree; drive green before handback)\n\n` +
                validationCommands.join('\n'),
            ]
          : []),
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
      const result = await execute('coder', models.coder, task.id, 'coder-implementation', CODER_EXEC_INSTRUCTION, body);
      if (!result.ok) {
        throw new ExecutionFailureError(result.failure);
      }
      return { diff: result.diff, handoffNotes: tailNote(result.output) };
    },

    coderSelfReview: async ({
      task,
      artifact,
      spec,
      context,
      tests,
      qa,
      rejectionFeedback,
      findingsLedger,
    }) => {
      const cwd = sandbox.worktree;
      try {
        const testsBlock = Array.isArray(tests) ? tests.join('\n') : tests;
        const qaIntent = qa.kind === 'tests-written'
          ? `tests-written:\n${qa.testIds.join('\n')}`
          : `no-code-test-rationale:\n${qa.rationale}`;
        const feedbackBlock = formatRejectionFeedback(rejectionFeedback);
        const findingsBlock = formatFindingsLedger(findingsLedger);
        const handoffBlock = formatCoderHandoffNotes(artifact.handoffNotes);
        const body = [
          `## Task\n\n${task.text}`,
          '',
          `## Spec\n\n${spec}`,
          '',
          `## Project context\n\n${scrubPathsInText(context)}`,
          '',
          `## QA intent\n\n${qaIntent}`,
          '',
          `## QA tests or rationale\n\n${testsBlock}`,
          ...(validationCommands.length > 0
            ? [
                '',
                `## Validation commands (run all from \`${validationCwdLabel}\` relative to the worktree)\n\n` +
                  validationCommands.join('\n'),
              ]
            : []),
          ...(handoffBlock !== '' ? ['', handoffBlock] : []),
          ...(feedbackBlock !== '' ? ['', feedbackBlock] : []),
          // Same prioritization the implementation pass gets: this is a fix-it
          // pass over the same ledger, so it must not spend itself on residue.
          ...(findingsBlock !== ''
            ? [
                '',
                'Fix open findings highest-severity-first; do not spend the pass on lower-severity ' +
                  'residue before higher-severity findings are addressed.',
              ]
            : []),
          ...(findingsBlock !== '' ? ['', findingsBlock] : []),
        ].join('\n');
        const artifactAttempts: ArtifactAttemptEvidence[] = [];
        const executionAttempts: ExecutionAttempt[] = [];
        const emitArtifactActivity = (data: Record<string, unknown>): void => {
          try {
            args.emit?.({ kind: 'activity', data });
          } catch (err) {
            log.warn('coder self-review activity emission failed', {
              error: sanitizeExecutionDiagnostic(err),
            });
          }
        };
        const emitArtifactEvidence = (evidence: ArtifactAttemptEvidence): void => {
          emitArtifactActivity({
            event: 'terminal-artifact',
            artifactKind: 'coder-self-review',
            artifactAttempt: evidence.attempt,
            ...evidence,
            line: `coder-self-review artifact ${evidence.status}: ${evidence.diagnostic}`,
          });
        };
        const runCoderSelfReviewAttempt = async (attempt: number): Promise<{
          checkpoint: ExecutionCheckpoint;
          changed: boolean;
          endedAt: string;
        } & (
          | { kind: 'returned'; result: ExecutionAgentResult }
          | { kind: 'threw'; executorError: unknown }
        )> => {
          await seams.runCanonicalGit(['add', '-A'], { cwd });
          const preTree = (
            await seams.runCanonicalGit(['write-tree'], { cwd })
          ).stdout.trim();
          if (preTree === '') {
            throw new Error('canonical pre-self-review snapshot produced no tree');
          }

          let checkpoint: ExecutionCheckpoint | undefined;
          let outcome:
            | { kind: 'returned'; result: ExecutionAgentResult }
            | { kind: 'threw'; executorError: unknown };
          try {
            const result = await execute(
              'coder',
              models.coder,
              task.id,
              'coder-self-review',
              CODER_SELF_REVIEW_EXEC_INSTRUCTION,
              body,
              {
                artifactAttempts,
                preserveCancellationResult: true,
                onCheckpoint: (value) => { checkpoint = value; },
              },
            );
            outcome = { kind: 'returned', result };
          } catch (err) {
            // Hold every throw until after the post snapshot so edits made
            // before a failed return cannot bypass canonical adjudication.
            outcome = { kind: 'threw', executorError: err };
          }

          await seams.runCanonicalGit(['add', '-A'], { cwd });
          const postTree = (
            await seams.runCanonicalGit(['write-tree'], { cwd })
          ).stdout.trim();
          if (postTree === '') {
            throw new Error('canonical post-self-review snapshot produced no tree');
          }
          return {
            checkpoint: checkpoint ?? executionCheckpoint(
              task.id,
              'coder',
              models.coder,
              'coder-self-review',
              artifactAttempts,
            ),
            changed: preTree !== postTree,
            endedAt: new Date().toISOString(),
            ...outcome,
          };
        };

        for (let attempt = 1; attempt <= 2; attempt++) {
          const execution = await runCoderSelfReviewAttempt(attempt);
          const {
            checkpoint,
            changed,
            endedAt,
          } = execution;
          const terminalFailure:
            | { kind: 'threw'; error: unknown }
            | { kind: 'failed'; result: Extract<ExecutionAgentResult, { ok: false }> }
            | undefined = execution.kind === 'threw'
              ? { kind: 'threw', error: execution.executorError }
              : !execution.result.ok
                ? { kind: 'failed', result: execution.result }
                : undefined;
          if (terminalFailure !== undefined) {
            const failure = terminalFailure.kind === 'failed'
              ? terminalFailure.result.failure
              : terminalFailure.error instanceof ExecutionFailureError
                ? terminalFailure.error.failure
                : undefined;
            const cancellation = (
              (terminalFailure.kind === 'failed'
                ? terminalFailure.result.cancellation
                : terminalFailure.error instanceof RoleCancellationError
                  ? terminalFailure.error.cancellation
                  : undefined)
            ) ?? failure?.cancellation;
            if (
              artifactAttempts.length === 0 &&
              cancellation === undefined
            ) {
              if (terminalFailure.kind === 'threw') throw terminalFailure.error;
              throw new ExecutionFailureError(terminalFailure.result.failure);
            }
            const diagnostic = cancellation !== undefined
              ? 'coder self-review was cancelled before terminal artifact acceptance'
              : failure !== undefined
                ? executionFailureSummary(failure)
                : terminalFailure.kind === 'threw'
                  ? terminalFailure.error
                  : 'coder self-review executor failed without typed evidence';
            const rejected = executionFailureArtifactEvidence(
              attempt,
              models.coder.provider,
              diagnostic,
            );
            artifactAttempts.push(rejected);
            executionAttempts.push(artifactExecutionAttempt(
              checkpoint,
              rejected,
              false,
              endedAt,
              artifactAttempts,
            ));
            emitArtifactEvidence(rejected);
            throw new ExecutionFailureError(artifactContractFailure(
              checkpoint,
              artifactAttempts,
              executionAttempts,
              changed
                ? 'worktree-changed'
                : cancellation !== undefined
                  ? 'cancelled'
                  : 'exhausted',
              cancellation,
            ));
          }

          if (execution.kind !== 'returned' || !execution.result.ok) {
            throw new Error('coder self-review attempt terminal state was not handled');
          }
          const result = execution.result;
          const terminal = terminalArtifactFromExecution(result, models.coder);
          let parsed: ReturnType<typeof parseCoderSelfReviewResult> | undefined;
          let contractEvidence: ArtifactAttemptEvidence | undefined;
          if (terminal.status !== 'captured' || terminal.artifact === undefined) {
            contractEvidence = artifactAttemptEvidence(attempt, terminal);
          } else {
            try {
              parsed = parseCoderSelfReviewResult(terminal.artifact);
            } catch (err) {
              contractEvidence = artifactAttemptEvidence(
                attempt,
                terminal,
                'rejected',
                err,
              );
            }
          }

          if (contractEvidence !== undefined) {
            artifactAttempts.push(contractEvidence);
            const retryable = !changed && attempt === 1;
            executionAttempts.push(artifactExecutionAttempt(
              checkpoint,
              contractEvidence,
              retryable,
              endedAt,
              artifactAttempts,
            ));
            emitArtifactEvidence(contractEvidence);
            if (changed) {
              throw new ExecutionFailureError(artifactContractFailure(
                checkpoint,
                artifactAttempts,
                executionAttempts,
                'worktree-changed',
              ));
            }
            if (retryable) {
              emitArtifactActivity({
                event: 'artifact-retry',
                artifactKind: 'coder-self-review',
                attempt,
                nextAttempt: 2,
                line: 'coder-self-review artifact contract failed; retrying self-review with a fresh checkpoint',
              });
              continue;
            }
            throw new ExecutionFailureError(artifactContractFailure(
              checkpoint,
              artifactAttempts,
              executionAttempts,
              'exhausted',
            ));
          }

          const parsedResult = parsed!;
          if (parsedResult.outcome === 'confirmed' && changed) {
            const rejected = artifactAttemptEvidence(
              attempt,
              terminal,
              'rejected',
              'coder self-review reported confirmed but canonical Git changed',
            );
            artifactAttempts.push(rejected);
            executionAttempts.push(artifactExecutionAttempt(
              checkpoint,
              rejected,
              false,
              endedAt,
              artifactAttempts,
            ));
            emitArtifactEvidence(rejected);
            throw new ExecutionFailureError(artifactContractFailure(
              checkpoint,
              artifactAttempts,
              executionAttempts,
              'worktree-changed',
            ));
          }
          if (parsedResult.outcome === 'revised' && !changed) {
            const rejected = artifactAttemptEvidence(
              attempt,
              terminal,
              'rejected',
              'coder self-review reported revised but canonical Git was unchanged',
            );
            artifactAttempts.push(rejected);
            executionAttempts.push(artifactExecutionAttempt(
              checkpoint,
              rejected,
              false,
              endedAt,
              artifactAttempts,
            ));
            emitArtifactEvidence(rejected);
            throw new ExecutionFailureError(artifactContractFailure(
              checkpoint,
              artifactAttempts,
              executionAttempts,
              'exhausted',
            ));
          }
          const parsedEvidence = artifactAttemptEvidence(
            attempt,
            terminal,
            'parsed',
            'coder-self-review terminal artifact parsed and matched canonical Git',
          );
          artifactAttempts.push(parsedEvidence);
          emitArtifactEvidence(parsedEvidence);
          const reviewState = await captureCanonicalReviewState(
            seams.runCanonicalGit,
            cwd,
            args.taskBaseTree,
          );
          return {
            ...parsedResult,
            reviewState,
            artifactAttempts: artifactAttempts.map((item) => ({ ...item })),
          };
        }
        throw new Error('coder self-review artifact attempt loop exhausted unexpectedly');
      } catch (err) {
        if (err instanceof RoleCancellationError) throw err;
        if (err instanceof ExecutionFailureError) throw err;
        throw new Error(`coder self-review failed: ${(err as Error).message}`);
      }
    },

    // `reviewerProvider` from ReviewerInput is intentionally unused here: the
    // provider identity is baked into `models.reviewer` at construction time
    // (resolved distinct-from-coder); the workflow's Gate 0 is the authority.
    reviewer: async ({
      diff,
      spec,
      tests,
      task,
      context,
      findingsLedger,
      coderHandoffNotes,
      reviewState,
      judgmentContext,
      judgmentBatchId,
    }) => {
      const testsBlock = Array.isArray(tests) ? tests.join('\n') : tests;
      const findingsBlock = formatFindingsLedger(findingsLedger);
      const handoffNotesBlock = formatCoderHandoffNotes(coderHandoffNotes);
      if (models.reviewer === null) {
        // Deliberate belt-and-suspenders: Gate 0 normally blocks first, but a
        // reviewer verdict must never be fabricable without a resolved
        // independent reviewer, even if a future caller skips the gate.
        return { outcome: 'fail', findings: [] };
      }
      const body = [
        `## Task\n\n${task.text}`,
        '',
        formatFullTaskReviewArtifact(diff, reviewState, judgmentContext?.artifactPass),
        '',
        `## Spec\n\n${spec}`,
        '',
        `## Tests\n\n${testsBlock}`,
        '',
        `## Project context\n\n${scrubPathsInText(context)}`,
        ...(handoffNotesBlock !== '' ? ['', handoffNotesBlock] : []),
        ...(findingsBlock !== '' ? ['', findingsBlock] : []),
      ].join('\n');
      return judge(
        'reviewer',
        models.reviewer,
        REVIEWER_INSTRUCTION,
        body,
        task.id,
        'reviewer-review',
        judgmentBatchId,
        (reply) => {
          requireGateVerdict(reply, 'reviewer-verdict');
          return parseReviewerVerdict(reply);
        },
        getJudgmentBatchCheckpoint(task, judgmentBatchId),
      );
    },

    techLeadReviewDiff: async ({
      task,
      diff,
      spec,
      context,
      findingsLedger,
      coderHandoffNotes,
      reviewState,
      judgmentContext,
      judgmentBatchId,
    }) => {
      const findingsBlock = formatFindingsLedger(findingsLedger);
      const handoffNotesBlock = formatCoderHandoffNotes(coderHandoffNotes);
      const body = [
        `## Task\n\n${task.text}`,
        '',
        formatFullTaskReviewArtifact(diff, reviewState, judgmentContext?.artifactPass),
        ...(spec !== undefined ? ['', `## Spec\n\n${spec}`] : []),
        ...(context !== undefined ? ['', `## Project context / tree-state evidence\n\n${scrubPathsInText(context)}`] : []),
        ...(handoffNotesBlock !== '' ? ['', handoffNotesBlock] : []),
        ...(findingsBlock !== '' ? ['', findingsBlock] : []),
      ].join('\n');
      return judge(
        'tech-lead',
        models.techLead,
        TL_DIFF_REVIEW_INSTRUCTION,
        body,
        task.id,
        'tech-lead-diff-review',
        judgmentBatchId,
        (reply) => {
          requireGateVerdict(reply, 'tl-diff-review');
          return parseGateVerdict(reply, 'tl-diff-review');
        },
        getJudgmentBatchCheckpoint(task, judgmentBatchId),
      );
    },

    designer: async ({
      task,
      diff,
      spec,
      context,
      tests,
      coderHandoffNotes,
      findingsLedger,
      reviewState,
      judgmentContext,
      judgmentBatchId,
    }) => {
      const findingsBlock = formatFindingsLedger(findingsLedger);
      const testsBlock = Array.isArray(tests) ? tests.join('\n') : tests;
      const handoffNotesBlock = formatCoderHandoffNotes(coderHandoffNotes);
      const body = [
        `## Task\n\n${task.text}`,
        '',
        formatFullTaskReviewArtifact(diff, reviewState, judgmentContext?.artifactPass),
        ...(spec !== undefined ? ['', `## Spec\n\n${spec}`] : []),
        ...(testsBlock !== undefined ? ['', `## Tests\n\n${testsBlock}`] : []),
        ...(context !== undefined
          ? ['', `## Project context\n\n${scrubPathsInText(context)}`]
          : []),
        ...(handoffNotesBlock !== '' ? ['', handoffNotesBlock] : []),
        ...(findingsBlock !== '' ? ['', findingsBlock] : []),
      ].join('\n');
      return judge(
        'designer',
        models.designer,
        DESIGNER_INSTRUCTION,
        body,
        task.id,
        'designer-review',
        judgmentBatchId,
        (reply) => {
          requireGateVerdict(reply, 'designer-review');
          return parseGateVerdict(reply, 'designer-review');
        },
        getJudgmentBatchCheckpoint(task, judgmentBatchId),
      );
    },

    pmWrapup: async ({ task, reason }) => {
      const body = [`## Task\n\n${task.text}`, '', `## Situation\n\n${reason}`].join('\n');
      const reply = await judge('pm', models.pm, PM_WRAPUP_INSTRUCTION, body, task.id, 'pm-wrapup');
      return parsePmWrapup(reply);
    },

    onGateRejection: learnFromGateRejection,

    resolveReviewerProvider: (coderProvider) =>
      models.reviewer !== null && models.reviewer.provider !== coderProvider
        ? models.reviewer.provider
        : null,
    cancelJudgmentBatch: (batchId) => {
      cancelCorrelatedOps(batchId, 'internal', {
        userId: config.TELEGRAM_USER_ID,
        scope: sandbox.product,
      });
    },
    forceCancelJudgmentBatch: (batchId) => {
      forceCancelCorrelatedOps(batchId, {
        userId: config.TELEGRAM_USER_ID,
        scope: sandbox.product,
      });
    },
    finishJudgmentBatch: async (batchId) => {
      const batchCheckpoint = batchCheckpoints.get(batchId);
      clearCorrelatedCancellation(batchId, {
        userId: config.TELEGRAM_USER_ID,
        scope: sandbox.product,
      });
      batchCheckpoints.delete(batchId);
      batchCheckpointWrites.delete(batchId);
      if (batchCheckpoint !== undefined) {
        const { judgmentBatch: _completedBatch, ...checkpoint } = batchCheckpoint;
        await args.persistExecutionCheckpoint?.({
          ...checkpoint,
          role: 'orchestrator',
          workflowStage: 'post-coder-judgments-complete',
          checkpointedAt: new Date().toISOString(),
        });
      }
    },
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
  /** The product's `validationCommands`, forwarded into the coder prompt so
   *  the coder drives the full suite green before handback. Production passes
   *  the list `buildOrchestrationDeps` already resolved for closeout. */
  validationCommands?: string[];
  validationCommandProfiles?: ValidationCommandProfile[];
  validationAdapters?: ValidationAdapter[];
  /** Optional worktree-relative command directory from products.json. */
  validationCwd?: string;
  /** Inner per-task round cap; defaults to {@link DEFAULT_ROUND_CAP}. */
  cap?: number;
  /** Optional live activity sink forwarded into runTeamTaskWorkflow. */
  emit?: (event: WorkflowActivityEvent) => void;
  persistExecutionCheckpoint?: (checkpoint: ExecutionCheckpoint) => Promise<void>;
  persistTaskValidationFailure?: (failure: TaskValidationFailure) => Promise<void>;
  cancellationDuringBackoff?: () => import('../cancellation.js').OperationCancellation | undefined;
}

/** Map a selected `tasks.md` task onto the workflow's SizedTask. tasks.md
 *  carries no sizing metadata, so v1 uses conservative defaults: tests
 *  required, no designer (spec req 24's non-flagged default). */
function toSizedTask(task: SelectedTask): SizedTask {
  const manualLiveGate = isManualLiveGateTask(task);
  return {
    id: task.id,
    text: task.text,
    testStrategy: manualLiveGate ? 'manual-live-gate' : 'code-tests-required',
    validationPolicy: task.validationPolicy ?? 'required',
    designerNeeded: false,
    roles: manualLiveGate ? ['human'] : ['qa', 'tech-lead', 'coder', 'reviewer'],
  };
}

function blockedEvidence(
  task: SelectedTask,
  reason: string,
  executionPreflight?: ExecutionPreflightFailure,
  taskValidationFailure?: TaskValidationFailure,
): TaskEvidence {
  return {
    taskId: task.id,
    outcome: 'blocked',
    rolesInvoked: [],
    objectionOpen: false,
    handoffNotes: [],
    blockedReason: reason,
    ...(executionPreflight !== undefined ? { executionPreflight } : {}),
    ...(taskValidationFailure !== undefined ? { taskValidationFailure } : {}),
    findingsLedger: [],
    loopExitReason: 'operational',
  };
}

function formatTaskValidationBlockedReason(failure: TaskValidationFailure): string {
  switch (failure.kind) {
    case 'missing-commands':
      return 'needs-validation: required validationCommands are absent or empty';
    case 'malformed-command':
      return `needs-validation: malformed command \`${failure.command}\` (prerequisite: ${failure.prerequisite})`;
    case 'invalid-validation-cwd':
      return `needs-validation: invalid validation directory \`${failure.validationCwd ?? '.'}\``;
    case 'missing-executable':
      return `needs-validation: required executable \`${failure.executable ?? 'unknown'}\` is unavailable for \`${failure.command}\``;
    case 'profile-unavailable':
      return `needs-validation: validation capability profile is unavailable for \`${failure.command}\``;
    case 'command-failed':
    case 'timeout':
      return `needs-validation: \`${failure.command}\` ${failure.timedOut ? 'timed out' : `exited ${failure.exitCode ?? 'unknown'}`}`;
  }
}

function isManualLiveGateTask(task: SelectedTask): boolean {
  return task.text.includes(MANUAL_LIVE_GATE_MARKER);
}

function manualLiveGateEvidence(task: SelectedTask): TaskEvidence {
  return blockedEvidence(
    task,
    'manual/live release gate requires operator evidence; automated QA/coder/reviewer workflow is intentionally skipped',
  );
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
  ctx: {
    handoff: string;
    contextMd: string;
    taskBase: TaskBaseRecord;
    workflowAttempt: number;
    rejectionFeedback?: GateRejectionFeedback;
  },
) => Promise<TaskEvidence> {
  const seams: TeamTaskSeams = { ...defaultSeams, ...seamOverrides };
  let preflightPassed = false;
  let pendingPreflight: Promise<ExecutionPreflightResult> | null = null;

  return async (task, ctx) => {
    let latestCheckpoint: ExecutionCheckpoint | undefined;
    if (isManualLiveGateTask(task)) {
      return manualLiveGateEvidence(task);
    }

    const validationAdmission = validateTaskValidationAdmission({
      policy: task.validationPolicy ?? 'required',
      commands: args.validationCommands ?? [],
      worktree: args.sandbox.worktree,
      ...(args.validationCwd !== undefined ? { validationCwd: args.validationCwd } : {}),
    });
    if (!validationAdmission.ok) {
      await args.persistTaskValidationFailure?.(validationAdmission.failure);
      return blockedEvidence(
        task,
        formatTaskValidationBlockedReason(validationAdmission.failure),
        undefined,
        validationAdmission.failure,
      );
    }
    if ((args.validationCommandProfiles?.length ?? 0) > 0) {
      let plan;
      try {
        plan = planValidationProfiles({
          commands: args.validationCommands ?? [],
          commandProfiles: args.validationCommandProfiles ?? [],
          adapters: args.validationAdapters ?? [],
          parseCommand: parseValidationCommand,
        });
      } catch {
        const failure: TaskValidationFailure = {
          kind: 'profile-unavailable',
          command: 'validation profile plan',
          prerequisite: 'validationCommandProfiles',
          exitCode: null,
          timedOut: false,
          diagnostics: 'validation profile plan is invalid',
        };
        await args.persistTaskValidationFailure?.(failure);
        return blockedEvidence(task, formatTaskValidationBlockedReason(failure), undefined, failure);
      }
      for (const profile of [...new Set(plan.shards.map((shard) => shard.profile))]) {
        const probe = await probeValidationProfile(
          profile,
          validationAdmission.cwd,
          config.WORK_RUN_CLOSEOUT_COMMAND_TIMEOUT_MS,
        );
        if (probe.outcome !== 'passed') {
          const failure: TaskValidationFailure = {
            kind: 'profile-unavailable',
            command: `validation profile ${profile}`,
            prerequisite: profile,
            exitCode: null,
            timedOut: false,
            diagnostics: 'required validation capability is unavailable',
          };
          await args.persistTaskValidationFailure?.(failure);
          return blockedEvidence(task, formatTaskValidationBlockedReason(failure), undefined, failure);
        }
      }
    }

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

    if (!preflightPassed) {
      if (pendingPreflight === null) {
        pendingPreflight = seams.preflightExecution({
          models,
          sandbox: args.sandbox,
          productsConfigPath: args.productsConfigPath,
        }).then((result) => {
          if (result.status === 'success') {
            preflightPassed = true;
            emitPreflight(args.emit, result);
          }
          return result;
        });
      }
      let preflight: ExecutionPreflightResult;
      try {
        preflight = await pendingPreflight;
      } catch (err) {
        pendingPreflight = null;
        return blockedEvidence(
          task,
          boundedPreflightReason(`executor preflight failed unexpectedly: ${(err as Error).message}`),
        );
      }
      pendingPreflight = null;
      if (preflight.status === 'failed') {
        const evidence = sanitizeExecutionPreflightFailure(preflight);
        emitPreflight(args.emit, evidence);
        return blockedEvidence(task, formatPreflightBlockedReason(evidence), evidence);
      }
    }

    const deps = buildProductionTeamTaskDeps(
      {
        sandbox: args.sandbox,
        productsConfigPath: args.productsConfigPath,
        models,
        taskBaseTree: ctx.taskBase.treeOid,
        ...(args.validationCommands !== undefined
          ? { validationCommands: args.validationCommands }
          : {}),
        ...(args.validationCommandProfiles !== undefined
          ? { validationCommandProfiles: args.validationCommandProfiles }
          : {}),
        ...(args.validationAdapters !== undefined
          ? { validationAdapters: args.validationAdapters }
          : {}),
        validationCommandCwd: validationAdmission.cwd,
        validationCwdLabel: args.validationCwd ?? '.',
        ...(args.emit !== undefined ? { emit: args.emit } : {}),
        persistExecutionCheckpoint: async (checkpoint) => {
          await args.persistExecutionCheckpoint?.(checkpoint);
          latestCheckpoint = checkpoint;
        },
        ...(args.cancellationDuringBackoff !== undefined
          ? { cancellationDuringBackoff: args.cancellationDuringBackoff }
          : {}),
      },
      seams,
    );
    const emit = args.emit !== undefined
      ? attributeWorkflowEvents(args.emit, models)
      : undefined;

    const evidence = await runTeamTaskWorkflow(
      toSizedTask(task),
      {
        // The orchestrator's bounded handoff (task + context.md + spec slices)
        // IS the per-task spec input — the fresh-context principle.
        spec: ctx.handoff,
        contextMd: ctx.contextMd,
        coderProvider: models.coder.provider,
        workflowAttempt: ctx.workflowAttempt,
        ...(ctx.rejectionFeedback !== undefined
          ? { rejectionFeedback: ctx.rejectionFeedback }
          : {}),
        ...(emit !== undefined ? { emit } : {}),
        cap: args.cap ?? DEFAULT_ROUND_CAP,
      },
      deps,
    );
    if (
      evidence.outcome === 'failed' &&
      evidence.executionFailure === undefined &&
      latestCheckpoint !== undefined
    ) {
      const failure = adjacentExecutionFailure(
        latestCheckpoint,
        evidence.failureReason ?? 'workflow failed after role boundary',
      );
      return {
        ...evidence,
        executionFailure: failure,
        failureReason: failure.diagnostic,
      };
    }
    return evidence;
  };
}

const PREFLIGHT_REASON_MAX_CHARS = 2_000;

function boundedPreflightReason(value: string): string {
  return redactSecrets(scrubAbsolutePaths(scrubPathsInText(value))).replace(/[\r\n\t]+/g, ' ').trim()
    .slice(0, PREFLIGHT_REASON_MAX_CHARS);
}

function formatPreflightBlockedReason(failure: ExecutionPreflightFailure): string {
  return boundedPreflightReason(
    `executor preflight ${failure.prerequisite} failed for roles ` +
      `${failure.roles.join(', ')} (${failure.provider}/${failure.format}, model ${failure.model}): ` +
      `${failure.diagnostic}. Remediation: ${failure.remediation}`,
  );
}

function emitPreflight(
  emit: TaskWorkflowRunnerArgs['emit'],
  result: ExecutionPreflightResult,
): void {
  if (emit === undefined) return;
  const data = result.status === 'success'
    ? {
        event: 'executor-preflight',
        status: 'success',
        bindings: result.bindings.map((binding) => ({
          roles: binding.roles,
          provider: binding.provider,
          format: binding.format,
          model: boundExecutionPreflightText(binding.model),
        })),
        artifactMcp: result.artifactMcp,
        artifactFormats: result.artifactFormats,
        line: boundedPreflightReason(
          `executor preflight passed (${result.bindings.length} model binding` +
          `${result.bindings.length === 1 ? '' : 's'}; artifact MCP ${result.artifactMcp})`,
        ),
      }
    : {
        event: 'executor-preflight',
        status: 'failed',
        roles: result.roles,
        provider: result.provider,
        format: result.format,
        model: boundExecutionPreflightText(result.model),
        prerequisite: result.prerequisite,
        diagnostic: boundExecutionPreflightText(result.diagnostic),
        remediation: boundExecutionPreflightText(result.remediation),
        line: formatPreflightBlockedReason(result),
      };
  try {
    emit({ kind: 'activity', data });
  } catch {
    /* transcript/activity sinks are observability-only. */
  }
}
