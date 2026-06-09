/**
 * Per-turn orchestration for the Planner's Socratic conversation (Phase 6
 * A4.2). Mutates the planning-session store from A4.1.
 *
 * One turn = the user sends a message → the handler asks the LLM to either
 * pose a scoping question or emit a SpecArtifact → the handler either
 * records the question (status stays `scoping`) or transitions via
 * `proposeSpec` (status → `spec-proposed`) → the reply text is returned for
 * the bot/webview to send.
 *
 * The `scopingTurn` callable is injectable — tests mock it deterministically,
 * production wires `defaultScopingTurn` which calls `askClaudeWithContext`
 * with a system prompt guiding the LLM's output shape.
 */

import { askClaudeWithContext } from '../ai/claude.js';
import { plannedOutcomeToArtifact } from '../intent/planning-artifact.js';
import { runPlannerRoles, type PlanningRolesOutcome } from '../intent/planning-roles.js';
import { defaultPlanningRoleDeps } from '../intent/planning-roles-wiring.js';
import { proposeSpec, type PlanningStatus, type SpecArtifact } from '../intent/planner.js';
import { createLogger } from '../utils/logger.js';
import {
  getActivePlanningSession,
  updatePlanningSession,
  type StoredPlanningSession,
} from './planning.js';

const log = createLogger('planning-handler');

/** What the scoping primitive can return on a single turn.
 *  - `question` — keep scoping, no status change.
 *  - `ready` — the conversation has enough; hand the consolidated `brief` to the
 *    PM + tech-lead role flow (project 14) to author the spec/tech-spec/tasks.
 *  - `spec` — a directly-supplied artifact (legacy single-shot path + tests),
 *    transitioned straight to spec-proposed without the role flow. */
export type ScopingResult =
  | { kind: 'question'; text: string }
  | { kind: 'ready'; text: string; brief: string }
  | { kind: 'spec'; text: string; artifact: SpecArtifact };

/** Per-turn scoping primitive — production wraps Claude; tests inject a mock. */
export type ScopingTurn = (input: {
  session: StoredPlanningSession;
  userMessage: string;
}) => Promise<ScopingResult>;

/** The planner-role flow seam: brief → PM judges specified-enough → tech lead
 *  breaks it down → PM reviews the match → seeded context. Injectable so tests
 *  drive the outcomes deterministically; production wires the live role seams. */
export type RunPlannerRolesFn = (input: {
  brief: string;
  product: string;
}) => Promise<PlanningRolesOutcome>;

export interface PlanningHandlerDeps {
  scopingTurn: ScopingTurn;
  /** Override the planner-role flow. Defaults to the live PM/tech-lead role
   *  seams (`runPlannerRoles` over `defaultPlanningRoleDeps()`). */
  runRoles?: RunPlannerRolesFn;
}

/** Live planner-role flow: drive `runPlannerRoles` over the real role seams. */
const defaultRunRoles: RunPlannerRolesFn = (input) =>
  runPlannerRoles(input, defaultPlanningRoleDeps());

export interface PlanningTurnResult {
  reply: string;
  status: PlanningStatus;
}

/**
 * Drive one turn of the Socratic conversation for `chatId`. Returns the
 * assistant's reply text plus the new planning status so the caller can
 * surface approval prompts on the spec-proposed transition.
 *
 * Throws when there's no active session (caller should `createPlanningSession`
 * first), when the session has reached a terminal state, or when
 * `scopingTurn` itself throws (LLM unavailable, parse failure, etc.).
 */
export async function handlePlanningTurn(
  deps: PlanningHandlerDeps,
  chatId: number,
  userMessage: string,
): Promise<PlanningTurnResult> {
  const session = getActivePlanningSession(chatId);
  if (!session) {
    throw new Error(
      `handlePlanningTurn: no active planning session for chatId ${chatId} — ` +
        'call createPlanningSession before driving turns',
    );
  }

  const result = await deps.scopingTurn({ session, userMessage });

  if (result.kind === 'spec') {
    // Direct artifact (legacy single-shot path / tests). Transition via the
    // pure planner state machine — it throws when the session is not in
    // `scoping`, which protects against a second spec signal on an already
    // spec-proposed conversation.
    return transitionToSpec(chatId, result.artifact, result.text);
  }

  if (result.kind === 'ready') {
    // The conversation has enough — hand the consolidated brief to the PM +
    // tech-lead role flow, which authors the spec/tech-spec/tasks (or blocks).
    return handleRolePlanning(deps, chatId, session.planning.product, result.brief);
  }

  // A scoping question — no status change, but refresh lastActivity by
  // updating with an identity transform.
  updatePlanningSession(chatId, (sess) => sess);
  return { reply: result.text, status: 'scoping' };
}

/** Transition an in-flight session to `spec-proposed` with the given artifact. */
function transitionToSpec(
  chatId: number,
  artifact: SpecArtifact,
  reply: string,
): PlanningTurnResult {
  updatePlanningSession(chatId, (sess) => ({
    ...sess,
    planning: proposeSpec(sess.planning, artifact),
  }));
  return { reply, status: 'spec-proposed' };
}

/**
 * Drive the PM + tech-lead role flow for a ready brief and map its three
 * outcomes onto the planning conversation:
 *  - `planned` → serialize to an artifact and transition to spec-proposed.
 *  - `blocked-for-interview` → surface the PM's open questions, stay scoping.
 *  - `spec-mismatch` → surface the PM-flagged drift, stay scoping so the next
 *    user turn can refine the brief and re-plan.
 */
async function handleRolePlanning(
  deps: PlanningHandlerDeps,
  chatId: number,
  product: string,
  brief: string,
): Promise<PlanningTurnResult> {
  const runRoles = deps.runRoles ?? defaultRunRoles;
  const outcome = await runRoles({ brief, product });

  if (outcome.kind === 'planned') {
    const artifact = plannedOutcomeToArtifact(product, outcome);
    log.info('planner-role flow produced a spec', {
      chatId,
      product,
      taskCount: outcome.tasks.length,
    });
    return transitionToSpec(chatId, artifact, formatPlannedReply(outcome));
  }

  // Both non-happy outcomes keep the conversation in `scoping`.
  updatePlanningSession(chatId, (sess) => sess);
  if (outcome.kind === 'blocked-for-interview') {
    return { reply: formatInterviewReply(outcome.interviewNeeds), status: 'scoping' };
  }
  return { reply: formatMismatchReply(outcome.mismatches), status: 'scoping' };
}

type PlannedOutcome = Extract<PlanningRolesOutcome, { kind: 'planned' }>;

/** User-facing summary of a completed plan — concise (Telegram), names the
 *  artifacts produced and prompts for approval. */
function formatPlannedReply(outcome: PlannedOutcome): string {
  const lines = [
    `📋 *${outcome.title}* — spec, tech spec, and ${outcome.tasks.length} task(s) ready.`,
  ];
  if (outcome.assumptions.length > 0) {
    lines.push('', 'Assumptions I made:', ...outcome.assumptions.map((a) => `• ${a}`));
  }
  lines.push('', 'Approve to scaffold the project.');
  return lines.join('\n');
}

/** User-facing reply when the PM blocks for interview — the open questions
 *  become the next scoping turn. */
function formatInterviewReply(needs: readonly string[]): string {
  return ['I need a bit more before I can write the spec:', '', ...needs.map((n) => `• ${n}`)].join(
    '\n',
  );
}

/** User-facing reply when the PM flags spec/tech-spec drift. */
function formatMismatchReply(mismatches: readonly string[]): string {
  return [
    'The technical plan drifted from the spec, so I held it:',
    '',
    ...mismatches.map((m) => `• ${m}`),
    '',
    'Refine the brief and I\'ll re-plan.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Default scopingTurn — production LLM integration
// ---------------------------------------------------------------------------

/** System prompt that guides Claude's per-turn output. The Planner conducts the
 *  scoping interview; the PM + tech-lead role flow (project 14) authors the
 *  actual spec from the brief this hands off. */
const SCOPING_SYSTEM_PROMPT = [
  'You are the Planner, the deliberative intent layer for project execution.',
  'Your job is to scope a fuzzy idea into a clear brief through conversation. You',
  'do NOT write the spec yourself — once the idea is scoped, a product manager and',
  'tech lead turn your brief into the spec, tech spec, and tasks.',
  '',
  'On every turn, do ONE of two things:',
  '',
  '1. ASK ONE SCOPING QUESTION. Keep it short, specific, and the next-most-useful',
  '   question to narrow the idea. Surface assumptions when they matter; do not',
  '   stack multiple questions in one turn.',
  '',
  '2. SIGNAL READY when the idea is scoped enough for the product team to write the',
  '   spec. Emit a fenced code block tagged `planning-brief` containing a thorough,',
  '   self-contained brief: the idea, the scope decisions made in this conversation,',
  '   constraints, and the success definition. Write the BRIEF, not the spec — the',
  '   product manager writes the spec. Place a one-line user-facing message before',
  '   the fence; place nothing after it.',
  '',
  'Example ready signal:',
  '',
  'I have enough to hand this to the product team.',
  '```planning-brief',
  'Build a streak tracker for the aura home screen. Scope: ... Constraints: ...',
  'Success: ...',
  '```',
].join('\n');

const BRIEF_FENCE = /```planning-brief\s*\n([\s\S]*?)\n```/;
/** Legacy single-shot artifact fence — still parsed so a directly-supplied
 *  `spec-artifact` keeps working, but the production prompt now emits a
 *  `planning-brief` that routes through the role flow instead. */
const ARTIFACT_FENCE = /```spec-artifact\s*\n([\s\S]*?)\n```/;

/**
 * Production scopingTurn — calls Claude with the planning session's
 * claudeSessionId for multi-turn continuity, parses the response into a
 * `ScopingResult`. A `planning-brief` fence is a ready signal (routes to the
 * role flow); a legacy `spec-artifact` fence is a direct artifact; anything
 * else is a scoping question.
 */
export async function defaultScopingTurn(input: {
  session: StoredPlanningSession;
  userMessage: string;
}): Promise<ScopingResult> {
  const result = await askClaudeWithContext(
    input.userMessage,
    input.session.claudeSessionId,
    SCOPING_SYSTEM_PROMPT,
    { opLabel: 'chat', voice: true },
  );
  if (result.error) {
    throw new Error(`scopingTurn: Claude returned error: ${result.error}`);
  }
  const text = result.text ?? '';

  // A consolidated brief → hand off to the PM + tech-lead role flow.
  const briefFenced = BRIEF_FENCE.exec(text);
  if (briefFenced) {
    const brief = briefFenced[1]!.trim();
    if (brief) {
      const summary = text.slice(0, briefFenced.index).trim();
      return {
        kind: 'ready',
        text: summary || 'Scoping complete — handing off to the product team.',
        brief,
      };
    }
    log.warn('defaultScopingTurn: empty planning-brief block; treating as question');
    return { kind: 'question', text };
  }

  // Legacy: a directly-supplied spec-artifact still transitions straight through.
  const fenced = ARTIFACT_FENCE.exec(text);
  if (!fenced) {
    return { kind: 'question', text };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fenced[1]!);
  } catch (err) {
    log.warn('defaultScopingTurn: malformed spec-artifact JSON; treating as question', {
      error: (err as Error).message,
    });
    return { kind: 'question', text };
  }

  const artifact = validateArtifact(parsed);
  if (!artifact) {
    log.warn('defaultScopingTurn: spec-artifact JSON missing required fields; treating as question');
    return { kind: 'question', text };
  }

  // Strip the fenced block from the user-facing reply — the structured
  // artifact reaches the planner via proposeSpec, the user sees only the
  // summary line(s) before the fence.
  const summary = text.slice(0, fenced.index).trim();
  return { kind: 'spec', text: summary || 'Proposed spec ready — approve to scaffold.', artifact };
}

function validateArtifact(value: unknown): SpecArtifact | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (
    typeof v['product'] !== 'string' ||
    typeof v['title'] !== 'string' ||
    typeof v['spec'] !== 'string' ||
    typeof v['tasks'] !== 'string' ||
    typeof v['testPlan'] !== 'string'
  ) {
    return null;
  }
  return {
    product: v['product'],
    title: v['title'],
    spec: v['spec'],
    tasks: v['tasks'],
    testPlan: v['testPlan'],
  };
}
