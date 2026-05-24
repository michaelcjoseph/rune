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
import { proposeSpec, type PlanningStatus, type SpecArtifact } from '../intent/planner.js';
import { createLogger } from '../utils/logger.js';
import {
  getActivePlanningSession,
  updatePlanningSession,
  type StoredPlanningSession,
} from './planning.js';

const log = createLogger('planning-handler');

/** What the scoping primitive can return on a single turn. */
export type ScopingResult =
  | { kind: 'question'; text: string }
  | { kind: 'spec'; text: string; artifact: SpecArtifact };

/** Per-turn scoping primitive — production wraps Claude; tests inject a mock. */
export type ScopingTurn = (input: {
  session: StoredPlanningSession;
  userMessage: string;
}) => Promise<ScopingResult>;

export interface PlanningHandlerDeps {
  scopingTurn: ScopingTurn;
}

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
    // Transition via the pure planner state machine — it throws when the
    // session is not in `scoping`, which protects against a second spec
    // signal on an already spec-proposed conversation.
    updatePlanningSession(chatId, (sess) => ({
      ...sess,
      planning: proposeSpec(sess.planning, result.artifact),
    }));
    return { reply: result.text, status: 'spec-proposed' };
  }

  // A scoping question — no status change, but refresh lastActivity by
  // updating with an identity transform.
  updatePlanningSession(chatId, (sess) => sess);
  return { reply: result.text, status: 'scoping' };
}

// ---------------------------------------------------------------------------
// Default scopingTurn — production LLM integration
// ---------------------------------------------------------------------------

/** System prompt that guides Claude's per-turn output. Live verification
 *  will refine the exact wording and the artifact-fence convention. */
const SCOPING_SYSTEM_PROMPT = [
  'You are the Planner, the deliberative intent layer for project execution.',
  'Your job is to turn a fuzzy idea into an approved spec through conversation.',
  '',
  'On every turn, do ONE of two things:',
  '',
  '1. ASK ONE SCOPING QUESTION. Keep it short, specific, and the next-most-useful',
  '   question to narrow the spec. Surface assumptions when they matter; do not',
  '   stack multiple questions in one turn.',
  '',
  '2. PROPOSE THE SPEC when you have enough to write spec.md, tasks.md (with a',
  '   per-phase "Tests (write first)" block), and test-plan.md. To propose, emit',
  '   a fenced code block tagged `spec-artifact` containing a JSON object with',
  '   keys: product, title, spec, tasks, testPlan. Place a one-line user-facing',
  '   message before the fence summarizing what you propose; place nothing after.',
  '',
  'Example proposal:',
  '',
  'Here is the proposed spec — approve to scaffold the project.',
  '```spec-artifact',
  '{"product": "aura", "title": "...", "spec": "...", "tasks": "...", "testPlan": "..."}',
  '```',
].join('\n');

const ARTIFACT_FENCE = /```spec-artifact\s*\n([\s\S]*?)\n```/;

/**
 * Production scopingTurn — calls Claude with the planning session's
 * claudeSessionId for multi-turn continuity, parses the response into a
 * `ScopingResult`. A response containing a fenced `spec-artifact` JSON
 * is a spec proposal; anything else is a scoping question.
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
