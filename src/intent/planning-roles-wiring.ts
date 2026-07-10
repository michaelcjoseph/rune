/**
 * Production wiring from the planner-role flow to the Phase 1 charter loader
 * (project 14, Phase 2).
 *
 * Kept SEPARATE from `planning-roles.ts` so the orchestration core stays
 * import-pure (no disk reads, no model calls). This module is the production
 * side: it turns each role's charter into a two-channel prompt — SOUL →
 * system-prompt authority, `memory.md` → low-authority reference fence — via
 * `composeRoleContext`, then drives a real (or injected) model call and parses
 * the reply into the typed result the orchestration core consumes.
 *
 * `defaultPlanningRoleDeps()` wires the three real role seams the live `/plan`
 * handler runs on. Every seam is FAIL-CLOSED: a PM assessment it cannot parse
 * blocks for interview rather than fabricating a spec; a PM review it cannot
 * parse reports a mismatch rather than silently passing drift; only the
 * tech-lead breakdown throws, because an empty plan must never reach scaffolding
 * as if it were a real one.
 */

import { randomUUID } from 'node:crypto';

import config from '../config.js';
import { ROLE_NAMES, composeRoleContext, type RoleContext, type RoleName } from '../roles/loader.js';
import { loadModelPolicy, resolveModel, type ModelEntry } from './model-policy.js';
import { createLogger } from '../utils/logger.js';
import type {
  PlanningRoleDeps,
  PmSpecResult,
  SizedTask,
  SpecMatchResult,
  TechLeadResult,
  TestStrategy,
  PerProjectExemplars,
} from './planning-roles.js';
import {
  runPlanningCritique,
  type PlanCritique,
  type PlanningCritiqueResult,
} from './planning-critique.js';

const log = createLogger('planning-roles-wiring');

/** Build the PM-role two-channel prompt from the `agents/pm` charter. */
export function buildPmRolePrompt(baseInstructions: string): RoleContext {
  return composeRoleContext('pm', baseInstructions);
}

/** Build the tech-lead-role two-channel prompt from the `agents/tech-lead` charter. */
export function buildTechLeadRolePrompt(baseInstructions: string): RoleContext {
  return composeRoleContext('tech-lead', baseInstructions);
}

// ---------------------------------------------------------------------------
// Role model-call seam
// ---------------------------------------------------------------------------

/** One role model invocation: SOUL carries system-prompt authority, the fenced
 *  `memory.md` reference + the task instruction ride the user turn. Returns the
 *  raw reply text. Injected in tests so the whole flow runs with no live call. */
export interface RoleModelCall {
  (input: {
    role: RoleName;
    systemPrompt: string;
    message: string;
    model?: string;
    provider?: string;
    format?: ModelEntry['format'];
  }): Promise<string>;
}

/**
 * Production role model call. Each invocation gets its OWN throwaway session id
 * so role calls are independent fresh contexts (no cross-role conversation
 * bleed) — the spec's "fresh execution context" principle at planning time. The
 * session is cleaned up immediately; it is never resumed.
 */
const defaultRoleModelCall: RoleModelCall = async ({ role, systemPrompt, message, model, format }) => {
  if (format === 'codex') {
    const [{ runCodex }, { getBaseEnv }] = await Promise.all([
      import('../ai/codex.js'),
      import('../jobs/credential-injector.js'),
    ]);
    const result = await runCodex(`${systemPrompt}\n\n${message}`, {
      ...(model ? { model } : {}),
      sandboxMode: 'read-only',
      env: getBaseEnv(['OPENAI_API_KEY', 'CODEX_HOME', 'HOME', 'PATH', 'TMPDIR']),
    });
    if (result.error) {
      throw new Error(`planner role '${role}' model call failed: ${result.error}`);
    }
    return result.text ?? '';
  }
  if (format !== undefined && format !== 'claude') {
    throw new Error(`planner role '${role}' model format '${format}' has no wired executor`);
  }

  const sessionId = randomUUID();
  const { askClaudeWithContext, cleanupSession } = await import('../ai/claude.js');
  try {
    const result = await askClaudeWithContext(message, sessionId, systemPrompt, {
      ...(model ? { model } : {}),
      opLabel: `planner:${role}`,
    });
    if (result.error) {
      throw new Error(`planner role '${role}' model call failed: ${result.error}`);
    }
    return result.text ?? '';
  } finally {
    cleanupSession(sessionId);
  }
};

function resolvePlanningRoleBinding(role: RoleName): {
  model: string;
  provider: string;
  format: ModelEntry['format'];
} | undefined {
  const policy = loadModelPolicy(config.MODEL_POLICY_FILE);
  if (!policy) return undefined;
  const resolution = resolveModel({ role, capabilities: [] }, policy);
  const entry = policy.models.find((candidate) => candidate.alias === resolution.model);
  if (!entry) {
    throw new Error(`planner role '${role}': resolved alias '${resolution.model}' is not in the model registry`);
  }
  return {
    model: resolution.model,
    provider: resolution.provider,
    format: entry.format,
  };
}

/** Compose the user-turn message: the role's memory reference fence (when any)
 *  above the task instruction. SOUL stays on the system channel. */
function roleMessage(ctx: RoleContext, instruction: string): string {
  return ctx.referenceContext ? `${ctx.referenceContext}\n\n${instruction}` : instruction;
}

/** Extract the JSON body of the first ```<tag> fenced block, or null.
 *  Exported for reuse by the team-task judgment-seam parsers (Phase 8),
 *  which follow the same fenced-JSON verdict convention. */
export function extractFencedJson(text: string, tag: string): unknown | null {
  const fence = new RegExp('```' + tag + '\\s*\\n([\\s\\S]*?)\\n```').exec(text);
  if (!fence) return null;
  try {
    return JSON.parse(fence[1]!);
  } catch (err) {
    log.warn('extractFencedJson: malformed JSON in fenced block', {
      tag,
      error: (err as Error).message,
    });
    return null;
  }
}

/**
 * Extract the RAW markdown body of a ```<tag> fenced block, or null.
 *
 * Used for the spec / tech-spec payloads, which carry multi-line markdown with
 * their own quotes and nested ``` code fences. Round-tripping that through a
 * JSON string is the escaping hazard that made the PM seam fail closed on long
 * specs (a single unescaped quote corrupts the whole object). Keeping the
 * markdown in its own fence means it never has to survive JSON-escaping.
 *
 * The body is captured to the LAST closing fence (greedy), so nested ``` code
 * fences inside the markdown survive — the contract is that this block is the
 * final thing in the reply with nothing after it. Returns null if the block is
 * absent or empty.
 */
function extractFencedText(text: string, tag: string): string | null {
  const open = new RegExp('```' + tag + '[^\\n]*\\n').exec(text);
  if (!open) return null;
  const rest = text.slice(open.index + open[0].length);
  const close = rest.lastIndexOf('\n```');
  if (close < 0) return null;
  const body = rest.slice(0, close).trim();
  return body.length > 0 ? body : null;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

// ---------------------------------------------------------------------------
// PM: assess specified-enough + write spec, or block for interview
// ---------------------------------------------------------------------------

const PM_ASSESS_INSTRUCTION = [
  'A raw project brief follows. As the product manager, judge honestly whether it',
  'is specified enough to write a product spec a builder could execute.',
  '',
  'Put ONLY the small structured fields in the ```pm-assessment JSON block. The',
  'spec markdown goes in a SEPARATE ```pm-spec block after it — NEVER inline the',
  'spec inside the JSON. A multi-line spec carries quotes and ``` code fences that',
  'corrupt a JSON string; keeping it in its own fence means it needs no escaping.',
  '',
  'If it is specified enough, emit BOTH blocks — the JSON first, the spec last,',
  'and nothing after the spec block:',
  '```pm-assessment',
  '{"specifiedEnough": true, "title": "<one-line project title>", "assumptions": ["<each gap you filled>"]}',
  '```',
  '```pm-spec',
  '<full markdown product spec: value, goals, non-goals, requirements, definition of done>',
  '```',
  '',
  'If it is NOT specified enough, do NOT invent the missing intent — emit only the',
  'JSON block and name exactly what you need:',
  '```pm-assessment',
  '{"specifiedEnough": false, "interviewNeeds": ["<each open question that must be answered first>"]}',
  '```',
].join('\n');

/** Fail-closed: anything unparseable blocks for interview — the PM never
 *  fabricates a spec from a reply it could not read. */
function parsePmAssessment(text: string): PmSpecResult {
  const parsed = extractFencedJson(text, 'pm-assessment');
  if (!parsed || typeof parsed !== 'object') {
    return blockedAssessment('The PM produced no parseable assessment.');
  }
  const v = parsed as Record<string, unknown>;

  if (v['specifiedEnough'] === true) {
    // The spec markdown rides its own ```pm-spec fence so it never has to survive
    // JSON-escaping; fall back to a legacy inline `spec` field for older replies.
    const spec =
      extractFencedText(text, 'pm-spec') ??
      (typeof v['spec'] === 'string' ? v['spec'].trim() : '');
    if (typeof v['title'] === 'string' && v['title'].trim() && spec) {
      const assumptions = isStringArray(v['assumptions']) ? v['assumptions'] : [];
      return { specifiedEnough: true, title: v['title'], spec, assumptions };
    }
    // Claimed specified-enough but the title or spec body is missing — fail closed.
    return blockedAssessment('The PM claimed specified-enough but omitted a title or spec body.');
  }

  if (v['specifiedEnough'] === false) {
    const needs = isStringArray(v['interviewNeeds']) ? v['interviewNeeds'] : [];
    return {
      specifiedEnough: false,
      interviewNeeds: needs.length > 0 ? needs : ['The PM blocked without naming what it needs.'],
    };
  }

  return blockedAssessment('The PM assessment omitted the specifiedEnough decision.');
}

function blockedAssessment(reason: string): PmSpecResult {
  return { specifiedEnough: false, interviewNeeds: [reason] };
}

// ---------------------------------------------------------------------------
// Tech lead: break the approved spec into sized tasks
// ---------------------------------------------------------------------------

const TECH_LEAD_INSTRUCTION = [
  'The product spec below is approved. As the tech lead, write the technical spec',
  'and break the work into tasks sized so each fits one fresh execution context.',
  '',
  'Group the tasks into phases / milestones: give every task a `phase` label (e.g.',
  '"Phase 1 - Core", "Phase 2 - UI"). Tasks that share a phase are one milestone.',
  'Emit the tasks in execution order — earlier phases and dependency-prerequisite',
  'tasks first — so the build loop runs them top to bottom.',
  '',
  'Put ONLY the tasks array in the ```tech-breakdown JSON block. The tech-spec',
  'markdown goes in a SEPARATE ```tech-spec block after it — NEVER inline the tech',
  'spec inside the JSON. Its quotes and ``` code fences corrupt a JSON string;',
  'keeping it in its own fence means it needs no escaping. Emit the JSON first,',
  'the tech spec last, and nothing after it:',
  '```tech-breakdown',
  '{"tasks": [{"id": "<stable-slug>", "text": "<what this task delivers>", "phase": "Phase 1 - Core", "testStrategy": "code-tests-required|docs-or-config-only|tests-as-deliverable", "designerNeeded": false, "roles": ["qa", "coder", "reviewer", "tech-lead"]}], "perProjectExemplars": {"qa": "<markdown exemplar for this project, if useful>"}}',
  '```',
  '```tech-spec',
  '<markdown technical spec: interfaces, contracts, data shapes, sequencing>',
  '```',
  '',
  'Set designerNeeded true ONLY for front-end / UX tasks. Every task needs a',
  'testStrategy from the allowed values and a phase label. Use `manual-live-gate`',
  'when the approved spec\'s Definition of Done requires real operator/browser/',
  'integration verification that the automated suite cannot prove; make that task',
  'an explicit release gate instead of pretending automated tests satisfy it.',
  'Include',
  '`perProjectExemplars` only for roles that would benefit from a project-specific',
  'example of good output; keys must be role slugs and values must be markdown.',
].join('\n');

const TEST_STRATEGIES: readonly TestStrategy[] = [
  'code-tests-required',
  'docs-or-config-only',
  'tests-as-deliverable',
  'manual-live-gate',
];

/** Throws on an unparseable breakdown — an empty/garbage plan must never reach
 *  scaffolding dressed as a real one (unlike the PM seams, there is no safe
 *  fail-closed default here: the only safe move is to surface the error). */
function parseTechLeadBreakdown(text: string): TechLeadResult {
  const parsed = extractFencedJson(text, 'tech-breakdown');
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('tech-lead breakdown: no parseable tech-breakdown block in the reply');
  }
  const v = parsed as Record<string, unknown>;
  // The tech spec rides its own ```tech-spec fence so its markdown never has to
  // survive JSON-escaping; fall back to a legacy inline `techSpec` field.
  const techSpec =
    extractFencedText(text, 'tech-spec') ??
    (typeof v['techSpec'] === 'string' ? v['techSpec'].trim() : '');
  if (!techSpec || !Array.isArray(v['tasks'])) {
    throw new Error('tech-lead breakdown: missing techSpec or tasks array');
  }
  const tasks = v['tasks'].map(parseSizedTask);
  if (tasks.length === 0) {
    throw new Error('tech-lead breakdown: produced zero tasks');
  }
  const perProjectExemplars = parsePerProjectExemplars(v['perProjectExemplars']);
  return {
    techSpec,
    tasks,
    ...(perProjectExemplars ? { perProjectExemplars } : {}),
  };
}

function parsePerProjectExemplars(raw: unknown): PerProjectExemplars | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out: PerProjectExemplars = {};
  for (const role of ROLE_NAMES) {
    const value = (raw as Record<string, unknown>)[role];
    if (typeof value === 'string' && value.trim()) {
      out[role] = value.trim();
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function parseSizedTask(raw: unknown, index: number): SizedTask {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`tech-lead breakdown: task ${index} is not an object`);
  }
  const t = raw as Record<string, unknown>;
  const id = typeof t['id'] === 'string' && t['id'].trim() ? t['id'] : `task-${index + 1}`;
  if (typeof t['text'] !== 'string' || !t['text'].trim()) {
    throw new Error(`tech-lead breakdown: task ${index} ('${id}') has no text`);
  }
  const testStrategy = TEST_STRATEGIES.includes(t['testStrategy'] as TestStrategy)
    ? (t['testStrategy'] as TestStrategy)
    : 'code-tests-required';
  const phase = typeof t['phase'] === 'string' && t['phase'].trim() ? t['phase'].trim() : undefined;
  return {
    id,
    text: t['text'],
    testStrategy,
    designerNeeded: t['designerNeeded'] === true,
    roles: isStringArray(t['roles']) ? t['roles'] : [],
    ...(phase ? { phase } : {}),
  };
}

// ---------------------------------------------------------------------------
// PM: review the tech spec against the product spec
// ---------------------------------------------------------------------------

const PM_REVIEW_INSTRUCTION = [
  'Below are your approved product spec and the tech lead\'s tech spec + task',
  'breakdown. As the product manager, confirm the technical plan still builds what',
  'the product spec promised. Flag any drift — do not rubber-stamp it and do not',
  'relax the approved spec.',
  '',
  'If the plan misses required scope or a required manual/live operator gate,',
  'REPAIR the tech spec and tasks so they satisfy the approved spec. Add a',
  '`manual-live-gate` task when the Definition of Done requires live operator,',
  'browser, or integration evidence the automated suite cannot prove.',
  '',
  'Respond with EXACTLY ONE fenced ```pm-review block containing a JSON object,',
  'unless you provide a repaired tech spec, in which case put that markdown in a',
  'final ```pm-repaired-tech-spec block after the JSON. For a clean match:',
  '```pm-review',
  '{"match": true, "mismatches": []}',
  '```',
  'When the tech plan drifts from the product intent but you can repair it:',
  '```pm-review',
  '{"match": false, "mismatches": ["<each concrete gap>"], "repairSummary": "<what you changed>", "repairedTasks": [{"id": "<stable-slug>", "text": "<deliverable>", "phase": "Phase 1 - Core", "testStrategy": "code-tests-required|docs-or-config-only|tests-as-deliverable|manual-live-gate", "designerNeeded": false, "roles": ["qa", "coder", "reviewer"]}]}',
  '```',
  '```pm-repaired-tech-spec',
  '<repaired markdown technical spec>',
  '```',
  'Only when the mismatch cannot be reconciled by revising tech spec/tasks:',
  '```pm-review',
  '{"match": false, "mismatches": ["<each concrete way the plan no longer builds the spec>"]}',
  '```',
].join('\n');

/** Fail-closed: an unparseable review reports a mismatch — unverified drift
 *  blocks completion rather than silently passing. */
function parsePmReview(text: string): SpecMatchResult {
  const parsed = extractFencedJson(text, 'pm-review');
  if (!parsed || typeof parsed !== 'object') {
    return { match: false, mismatches: ['The PM review was unparseable; treating as unverified drift.'] };
  }
  const v = parsed as Record<string, unknown>;
  if (v['match'] === true) {
    return { match: true, mismatches: [] };
  }
  const mismatches = isStringArray(v['mismatches']) ? v['mismatches'] : [];
  const repairedTasks = Array.isArray(v['repairedTasks'])
    ? parseRepairedTasks(v['repairedTasks'])
    : undefined;
  const repairedTechSpec =
    extractFencedText(text, 'pm-repaired-tech-spec') ??
    (typeof v['repairedTechSpec'] === 'string' && v['repairedTechSpec'].trim()
      ? v['repairedTechSpec'].trim()
      : undefined);
  const repairSummary = typeof v['repairSummary'] === 'string' && v['repairSummary'].trim()
    ? v['repairSummary'].trim()
    : undefined;
  return {
    match: false,
    mismatches: mismatches.length > 0 ? mismatches : ['The PM flagged a mismatch without detail.'],
    ...(repairedTechSpec && repairedTasks && repairedTasks.length > 0
      ? {
          repairedTechSpec,
          repairedTasks,
          ...(repairSummary ? { repairSummary } : {}),
        }
      : {}),
  };
}

function parseRepairedTasks(raw: unknown[]): SizedTask[] | undefined {
  try {
    const tasks = raw.map(parseSizedTask);
    return tasks.length > 0 ? tasks : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Planning critique pass (Phase 9) — Rune-owned neutral cross-model step
// ---------------------------------------------------------------------------

/** Neutral system framing — the critique is NOT a role; it critiques the whole
 *  plan because no role critiques its own write-up. */
const CRITIQUE_SYSTEM = [
  'You are a neutral senior reviewer hardening a project plan before a human approves it.',
  'You are not any single role — you critique the whole plan (product spec, tech spec, and',
  'task breakdown together), because the question spans artifacts no single role owns.',
].join('\n');

const CRITIQUE_INSTRUCTION = [
  'Below are the assembled product spec, tech spec, and task breakdown. Run this critique IN ORDER:',
  '1. Restate, in one or two sentences, the goal the spec and tasks define.',
  '2. Check whether the defined scope actually ACHIEVES that goal. Fix the scope if it falls short.',
  '3. Check whether the task list is comprehensive enough that completing EVERY task leaves a',
  '   project a real user can actually USE (done AND usable). Add the missing tasks if it is not.',
  '4. Critique the spec and tasks for coherence and fix what you find.',
  '',
  'Then return the REVISED artifacts — even if you changed nothing (a no-op is fine). Emit EXACTLY',
  'three fenced blocks, the JSON first and nothing after the last block. Keep each task object shaped',
  'like the input tasks (id, text, optional phase, testStrategy one of',
  'code-tests-required|docs-or-config-only|tests-as-deliverable|manual-live-gate, designerNeeded boolean, roles array).',
  'Preserve `manual-live-gate` tasks, and add one if real-user usability depends',
  'on live/operator/browser/integration verification that automated tests cannot prove:',
  '```critique-tasks',
  '{"tasks": [{"id": "<stable-slug>", "text": "<deliverable>", "phase": "Phase 1 - Core", "testStrategy": "code-tests-required", "designerNeeded": false, "roles": ["qa", "coder", "reviewer"]}]}',
  '```',
  '```critique-spec',
  '<revised product spec markdown>',
  '```',
  '```critique-tech-spec',
  '<revised tech spec markdown>',
  '```',
].join('\n');

/** Render the assembled plan into the critique prompt body. */
function renderPlanForCritique(plan: PlanCritique): string {
  const taskJson = JSON.stringify({ tasks: plan.tasks }, null, 2);
  return [
    '## Product spec',
    '',
    plan.spec,
    '',
    '## Tech spec',
    '',
    plan.techSpec,
    '',
    '## Tasks (JSON)',
    '',
    '```json',
    taskJson,
    '```',
  ].join('\n');
}

/**
 * Extract a fenced block body within a bounded window [opening fence, hardEnd).
 * Greedy to the LAST closing fence INSIDE that window, so nested ``` code fences
 * in the body survive while a SUBSEQUENT block can't bleed in. (Plain
 * `extractFencedText` is greedy to the last fence in the WHOLE reply — correct
 * only for the final block; the critique reply has two markdown blocks, so the
 * earlier one must be bounded before the next block's opening fence.)
 */
function extractFencedBlock(text: string, tag: string, hardEnd: number): string | null {
  const open = new RegExp('```' + tag + '[^\\n]*\\n').exec(text);
  if (!open || open.index >= hardEnd) return null;
  const bodyStart = open.index + open[0].length;
  const region = text.slice(bodyStart, hardEnd);
  const close = region.lastIndexOf('\n```');
  if (close < 0) return null;
  const body = region.slice(0, close).trim();
  return body.length > 0 ? body : null;
}

/**
 * Parse a critic reply into a revised plan, or `null` when NO recognizable block
 * is present (unparseable → the orchestrator keeps the pre-critique plan rather
 * than dropping content). A partially-parseable reply keeps the `fallback`
 * value for any artifact whose block is missing/malformed — the critique can
 * sharpen, never silently delete.
 *
 * The reply order is critique-tasks (JSON) → critique-spec (md) → critique-tech-spec
 * (md). The spec block is bounded to BEFORE the tech-spec opening fence so the
 * tech-spec markdown can't bleed into the spec field; the tech-spec block (last)
 * is greedy to the reply's end.
 */
export function parseCritiqueReply(text: string, fallback: PlanCritique): PlanCritique | null {
  const techOpen = /```critique-tech-spec[^\n]*\n/.exec(text);
  const specHardEnd = techOpen ? techOpen.index : text.length;
  const spec = extractFencedBlock(text, 'critique-spec', specHardEnd);
  const techSpec = extractFencedBlock(text, 'critique-tech-spec', text.length);
  const tasksJson = extractFencedJson(text, 'critique-tasks');
  if (spec === null && techSpec === null && tasksJson === null) return null;

  let tasks = fallback.tasks;
  if (tasksJson && typeof tasksJson === 'object' && Array.isArray((tasksJson as { tasks?: unknown }).tasks)) {
    try {
      const parsed = (tasksJson as { tasks: unknown[] }).tasks.map(parseSizedTask);
      if (parsed.length > 0) tasks = parsed;
    } catch {
      // Malformed task objects → keep the fallback tasks rather than dropping them.
      tasks = fallback.tasks;
    }
  }
  return {
    spec: spec ?? fallback.spec,
    techSpec: techSpec ?? fallback.techSpec,
    tasks,
  };
}

/** Injectable critique model seams (tests fake these; production uses the live
 *  Claude + Codex calls). `codexCall` returns null on an executor failure
 *  (fail-closed → the orchestrator keeps the Claude-revised plan). */
export interface CritiquePlanSeams {
  claudeCall?: (system: string, message: string) => Promise<string>;
  codexCall?: (message: string) => Promise<string | null>;
  isCodexAvailable?: () => Promise<boolean>;
}

/** Non-throwing: a Claude critique miss (CLI error or empty output) degrades to
 *  the pre-critique plan — the critique is a best-effort hardening pass, it must
 *  never hard-block a `/plan` turn. Returns '' on failure so `parseCritiqueReply`
 *  yields null and the orchestrator keeps the prior plan. */
const defaultCritiqueClaudeCall = async (system: string, message: string): Promise<string> => {
  const sessionId = randomUUID();
  const { askClaudeWithContext, cleanupSession } = await import('../ai/claude.js');
  try {
    const result = await askClaudeWithContext(message, sessionId, system, {
      opLabel: 'planner:critique-claude',
    });
    if (result.error) {
      log.warn('planning critique (claude) failed; degrading to the pre-critique plan', {
        error: result.error,
      });
      return '';
    }
    if (!result.text) {
      log.warn('planning critique (claude) returned empty output; degrading to the pre-critique plan');
      return '';
    }
    return result.text;
  } catch (err) {
    log.warn('planning critique (claude) threw; degrading to the pre-critique plan', {
      error: (err as Error).message,
    });
    return '';
  } finally {
    cleanupSession(sessionId);
  }
};

/** Resolve the `/plan` cross-model critique model from the policy — never a
 *  hardcoded alias. `distinctFromProvider: 'anthropic'` is a hard filter, not a
 *  preference: this call goes to `runCodex` and exists to second-opinion a
 *  Claude-authored plan, so a Claude model is both unrunnable here and
 *  self-defeating. Returns null when no policy is present or the resolved model
 *  is not Codex-executable — the caller degrades to the Claude-revised plan
 *  rather than spawning an unintended model. */
function resolveCritiqueCodexModel(): string | null {
  const policy = loadModelPolicy(config.MODEL_POLICY_FILE);
  if (!policy) {
    log.warn('planning critique (codex) skipped; no model policy to resolve a critique model from');
    return null;
  }
  let resolution;
  try {
    resolution = resolveModel(
      { role: 'planning-critique', capabilities: ['coding'], distinctFromProvider: 'anthropic' },
      policy,
    );
  } catch (err) {
    log.warn('planning critique (codex) skipped; no non-anthropic coding model resolved', {
      error: (err as Error).message,
    });
    return null;
  }
  const entry = policy.models.find((candidate) => candidate.alias === resolution.model);
  if (entry?.format !== 'codex') {
    log.warn('planning critique (codex) skipped; resolved model is not Codex-executable', {
      model: resolution.model,
      format: entry?.format,
    });
    return null;
  }
  return resolution.model;
}

const defaultCritiqueCodexCall = async (message: string): Promise<string | null> => {
  const model = resolveCritiqueCodexModel();
  if (model === null) return null;
  // read-only sandbox: the critique only returns text, it never edits the repo.
  // Slim env (defense-in-depth): a text-only internal critique has no need for
  // Rune's Telegram/HTTP secrets — pass only what the Codex CLI itself needs.
  const [{ runCodex }, { getBaseEnv }] = await Promise.all([
    import('../ai/codex.js'),
    import('../jobs/credential-injector.js'),
  ]);
  let result;
  try {
    result = await runCodex(message, {
      model,
      sandboxMode: 'read-only',
      env: getBaseEnv(['OPENAI_API_KEY', 'CODEX_HOME', 'HOME', 'PATH', 'TMPDIR']),
    });
  } catch (err) {
    log.warn('planning critique (codex) threw; degrading to the Claude-revised plan', {
      error: (err as Error).message,
    });
    return null;
  }
  if (result.error) {
    log.warn('planning critique (codex) failed; degrading to the Claude-revised plan', {
      error: result.error,
    });
    return null;
  }
  return result.text;
};

/**
 * Build the production `critiquePlan` seam: the sequential Claude→Codex critique
 * over `runPlanningCritique`, with real model calls + fenced-artifact parsing.
 * Every model seam is injectable so the wiring is unit-testable with no live call.
 */
export function buildProductionCritiquePlan(
  seams: CritiquePlanSeams = {},
): (plan: PlanCritique) => Promise<PlanningCritiqueResult> {
  const claudeCall = seams.claudeCall ?? defaultCritiqueClaudeCall;
  const codexCall = seams.codexCall ?? defaultCritiqueCodexCall;
  const isCodexAvailable =
    seams.isCodexAvailable ??
    (async () => {
      const { probeCodexProvider } = await import('../ai/codex.js');
      return (await probeCodexProvider()).available;
    });

  return (plan) =>
    runPlanningCritique(plan, {
      critiqueWithClaude: async (p) => {
        const reply = await claudeCall(
          CRITIQUE_SYSTEM,
          `${CRITIQUE_INSTRUCTION}\n\n${renderPlanForCritique(p)}`,
        );
        return parseCritiqueReply(reply, p);
      },
      critiqueWithCodex: async (p) => {
        // Codex has no separate system channel — fold CRITIQUE_SYSTEM into the
        // single prompt so the injected seam and the production default receive
        // the same self-contained message (no asymmetric double-prepend).
        const reply = await codexCall(
          `${CRITIQUE_SYSTEM}\n\n${CRITIQUE_INSTRUCTION}\n\n${renderPlanForCritique(p)}`,
        );
        return reply === null ? null : parseCritiqueReply(reply, p);
      },
      isCodexAvailable,
    });
}

// ---------------------------------------------------------------------------
// Wiring factory
// ---------------------------------------------------------------------------

/**
 * Wire the three live planner-role seams the production `/plan` flow runs on.
 * The model call is injectable so the seams can be unit-tested against canned
 * replies with no live model call; production omits it and gets
 * `defaultRoleModelCall` (a fresh throwaway session per role invocation).
 */
export function defaultPlanningRoleDeps(
  modelCall: RoleModelCall = defaultRoleModelCall,
): PlanningRoleDeps {
  return {
    pmAssessAndSpec: async ({ brief }) => {
      const ctx = buildPmRolePrompt(PM_ASSESS_INSTRUCTION);
      const binding = resolvePlanningRoleBinding('pm');
      const reply = await modelCall({
        role: 'pm',
        systemPrompt: ctx.systemInstructions,
        message: roleMessage(ctx, `## Brief\n\n${brief}`),
        ...(binding ?? {}),
      });
      return parsePmAssessment(reply);
    },

    techLeadBreakdown: async ({ spec }) => {
      const ctx = buildTechLeadRolePrompt(TECH_LEAD_INSTRUCTION);
      const binding = resolvePlanningRoleBinding('tech-lead');
      const reply = await modelCall({
        role: 'tech-lead',
        systemPrompt: ctx.systemInstructions,
        message: roleMessage(ctx, `## Approved product spec\n\n${spec}`),
        ...(binding ?? {}),
      });
      return parseTechLeadBreakdown(reply);
    },

    pmReviewMatch: async ({ spec, techSpec, tasks }) => {
      const ctx = buildPmRolePrompt(PM_REVIEW_INSTRUCTION);
      const binding = resolvePlanningRoleBinding('pm');
      const taskList = tasks.map((t) => `- ${t.id}: ${t.text}`).join('\n');
      const reply = await modelCall({
        role: 'pm',
        systemPrompt: ctx.systemInstructions,
        message: roleMessage(
          ctx,
          `## Product spec\n\n${spec}\n\n## Tech spec\n\n${techSpec}\n\n## Tasks\n\n${taskList}`,
        ),
        ...(binding ?? {}),
      });
      return parsePmReview(reply);
    },

    // Phase 9: the Rune-owned cross-model critique pass (Claude → Codex,
    // degrade-to-Claude when Codex is unavailable). Wired with the live model
    // calls; runPlannerRoles invokes it after the spec/tech-spec match gate.
    critiquePlan: buildProductionCritiquePlan(),
  };
}
