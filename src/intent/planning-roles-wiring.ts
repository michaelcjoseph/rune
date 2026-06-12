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

import { askClaudeWithContext, cleanupSession } from '../ai/claude.js';
import { composeRoleContext, type RoleContext, type RoleName } from '../roles/loader.js';
import { createLogger } from '../utils/logger.js';
import type {
  PlanningRoleDeps,
  PmSpecResult,
  SizedTask,
  SpecMatchResult,
  TechLeadResult,
  TestStrategy,
} from './planning-roles.js';

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
  (input: { role: RoleName; systemPrompt: string; message: string }): Promise<string>;
}

/**
 * Production role model call. Each invocation gets its OWN throwaway session id
 * so role calls are independent fresh contexts (no cross-role conversation
 * bleed) — the spec's "fresh execution context" principle at planning time. The
 * session is cleaned up immediately; it is never resumed.
 */
const defaultRoleModelCall: RoleModelCall = async ({ role, systemPrompt, message }) => {
  const sessionId = randomUUID();
  try {
    const result = await askClaudeWithContext(message, sessionId, systemPrompt, {
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
  '{"tasks": [{"id": "<stable-slug>", "text": "<what this task delivers>", "phase": "Phase 1 - Core", "testStrategy": "code-tests-required|docs-or-config-only|tests-as-deliverable", "designerNeeded": false, "roles": ["qa", "coder", "reviewer", "tech-lead"]}]}',
  '```',
  '```tech-spec',
  '<markdown technical spec: interfaces, contracts, data shapes, sequencing>',
  '```',
  '',
  'Set designerNeeded true ONLY for front-end / UX tasks. Every task needs a',
  'testStrategy from the three allowed values and a phase label.',
].join('\n');

const TEST_STRATEGIES: readonly TestStrategy[] = [
  'code-tests-required',
  'docs-or-config-only',
  'tests-as-deliverable',
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
  return { techSpec, tasks };
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
  'the product spec promised. Flag any drift — do not rubber-stamp it.',
  '',
  'Respond with EXACTLY ONE fenced ```pm-review block containing a JSON object,',
  'and nothing after the fence:',
  '```pm-review',
  '{"match": true, "mismatches": []}',
  '```',
  'or, when the tech plan drifts from the product intent:',
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
  return {
    match: false,
    mismatches: mismatches.length > 0 ? mismatches : ['The PM flagged a mismatch without detail.'],
  };
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
      const reply = await modelCall({
        role: 'pm',
        systemPrompt: ctx.systemInstructions,
        message: roleMessage(ctx, `## Brief\n\n${brief}`),
      });
      return parsePmAssessment(reply);
    },

    techLeadBreakdown: async ({ spec }) => {
      const ctx = buildTechLeadRolePrompt(TECH_LEAD_INSTRUCTION);
      const reply = await modelCall({
        role: 'tech-lead',
        systemPrompt: ctx.systemInstructions,
        message: roleMessage(ctx, `## Approved product spec\n\n${spec}`),
      });
      return parseTechLeadBreakdown(reply);
    },

    pmReviewMatch: async ({ spec, techSpec, tasks }) => {
      const ctx = buildPmRolePrompt(PM_REVIEW_INSTRUCTION);
      const taskList = tasks.map((t) => `- ${t.id}: ${t.text}`).join('\n');
      const reply = await modelCall({
        role: 'pm',
        systemPrompt: ctx.systemInstructions,
        message: roleMessage(
          ctx,
          `## Product spec\n\n${spec}\n\n## Tech spec\n\n${techSpec}\n\n## Tasks\n\n${taskList}`,
        ),
      });
      return parsePmReview(reply);
    },
  };
}
