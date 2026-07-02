/**
 * Per-turn orchestration for the Planner's Socratic conversation (Phase 6
 * A4.2). Mutates the planning-session store from A4.1.
 *
 * One turn = the user sends a message → the handler asks the PM role to either
 * pose one scoping question or emit a PM spec approval artifact → the handler
 * either records the question (status stays `scoping`) or transitions via
 * `proposeSpec` (status → `spec-proposed`) → the reply text is returned for
 * the bot/webview to send.
 *
 * The `scopingTurn` callable is injectable — tests mock it deterministically,
 * production wires `defaultScopingTurn` which calls `askClaudeWithContext`
 * with a system prompt guiding the LLM's output shape.
 */

import { askClaudeWithContext } from '../ai/claude.js';
import config from '../config.js';
import { loadModelPolicy, resolveModel, type ModelEntry } from '../intent/model-policy.js';
import { proposeSpec, type PlanningStatus, type SpecArtifact } from '../intent/planner.js';
import { runSelfReview } from '../intent/self-review.js';
import { composeRoleContext } from '../roles/loader.js';
import { createLogger } from '../utils/logger.js';
import {
  getActivePlanningSession,
  updatePlanningSession,
  type StoredPlanningSession,
} from './planning.js';

const log = createLogger('planning-handler');

/** What the scoping primitive can return on a single turn.
 *  - `question` — keep scoping, no status change.
 *  - `spec` — a directly-supplied PM spec approval artifact, transitioned
 *    straight to spec-proposed. */
export type ScopingResult =
  | { kind: 'question'; text: string }
  | { kind: 'spec'; text: string; artifact: PmSpecArtifact };

export interface PmSpecArtifact {
  version: 2;
  kind: 'pm-spec';
  product: string;
  title: string;
  spec: string;
  assumptions?: string[];
  selfReview?: unknown;
}

/** Per-turn scoping primitive — production wraps Claude; tests inject a mock. */
export type ScopingTurn = (input: {
  session: StoredPlanningSession;
  userMessage: string;
}) => Promise<ScopingResult>;

export interface PlanningHandlerDeps {
  scopingTurn: ScopingTurn;
  /** Retired project-14 seam kept only so stale tests/callers fail explicitly. */
  runRoles?: unknown;
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
    // Direct artifact (legacy single-shot path / tests). Transition via the
    // pure planner state machine — it throws when the session is not in
    // `scoping`, which protects against a second spec signal on an already
    // spec-proposed conversation.
    return transitionToSpec(chatId, result.artifact, result.text);
  }

  if (result.kind !== 'question') {
    throw new Error(
      'handlePlanningTurn: retired ready/planning handoff is no longer valid on /plan; ' +
        'the PM must emit a versioned pm-spec artifact directly',
    );
  }

  // A scoping question — no status change, but refresh lastActivity by
  // updating with an identity transform.
  updatePlanningSession(chatId, (sess) => sess);
  return { reply: result.text, status: 'scoping' };
}

/** Transition an in-flight session to `spec-proposed` with the given artifact. */
async function transitionToSpec(
  chatId: number,
  artifact: PmSpecArtifact,
  reply: string,
): Promise<PlanningTurnResult> {
  const session = getActivePlanningSession(chatId);
  if (!session) {
    throw new Error(
      `transitionToSpec: no active planning session for chatId ${chatId}`,
    );
  }
  if (session.planning.status !== 'scoping') {
    throw new Error(
      `proposeSpec: a spec can only be proposed while scoping — session status is '${session.planning.status}'`,
    );
  }

  const reviewed = await reviewPmSpecArtifact(artifact);
  const approvalReply = formatPmSpecApprovalReply(reply, reviewed.artifact);
  updatePlanningSession(chatId, (sess) => ({
    ...sess,
    planning: proposeSpec(sess.planning, reviewed.artifact as unknown as SpecArtifact),
  }));
  return { reply: approvalReply, status: 'spec-proposed' };
}

async function reviewPmSpecArtifact(artifact: PmSpecArtifact): Promise<{
  artifact: PmSpecArtifact;
  revised: boolean;
}> {
  const selfReviewModel = resolvePlanningSelfReviewModel('pm');
  try {
    return await runSelfReview({
      role: 'pm',
      artifact,
      render: renderPmSpecArtifact,
      parse: parsePmSpecReviewReply,
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
            throw new Error(`PM self-review failed: ${result.error}`);
          }
          return result.text ?? '';
        }
        const result = await askClaudeWithContext(message, sessionId, systemPrompt, {
          opLabel: 'planning:pm-self-review',
          voice: true,
          ...(selfReviewModel?.model ? { model: selfReviewModel.model } : {}),
        });
        if (!result || result.error) {
          throw new Error(`PM self-review failed: ${result?.error ?? 'empty model response'}`);
        }
        return result.text ?? '';
      },
    });
  } catch (err) {
    throw new Error(`planning PM self-review failed: ${(err as Error).message}`);
  }
}

function resolvePlanningSelfReviewModel(role: 'pm'): {
  model: string;
  provider: string;
  format: ModelEntry['format'];
} | undefined {
  const policy = loadModelPolicy(config.MODEL_POLICY_FILE);
  if (!policy) return undefined;
  const resolution = resolveModel({ role, capabilities: [] }, policy);
  const entry = policy.models.find((candidate) => candidate.alias === resolution.model);
  if (!entry) {
    throw new Error(`planning PM self-review: resolved alias '${resolution.model}' is not in the model registry`);
  }
  return { model: resolution.model, provider: resolution.provider, format: entry.format };
}

// ---------------------------------------------------------------------------
// Default scopingTurn — production LLM integration
// ---------------------------------------------------------------------------

const INTERVIEW_INSTRUCTION = [
  'You are the product manager conducting the /plan scoping interview.',
  'Interview the user directly and write the PM spec from first-hand context.',
  '',
  'On every turn, do exactly ONE of two things:',
  '',
  '1. Ask one question at a time: ONE scoping question. Keep it short, specific, and the next-most-useful',
  '   question to narrow product intent. Do not stack multiple questions, hidden',
  '   subquestions, or a checklist into one turn.',
  '',
  '2. Stop interviewing when either condition is true: you are satisfied you have',
  '   enough context to write the PM spec, OR the user signals proceed intent.',
  '   Intent-detect proceed phrases such as "go", "proceed", "ship it", "done",',
  '   and "let\'s go"; do not use a literal exact match or a === "go" check.',
  '',
  'When you stop, emit the finished approval artifact directly as JSON inside a',
  '```pm-spec fenced block. Place a short user-facing approval sentence before',
  'the fence and nothing after it. The artifact is PM-only and versioned;',
  'it is a pm-spec artifact with version: 2 and kind: pm-spec.',
  '',
  '```pm-spec',
  '{',
  '  "version": 2,',
  '  "kind": "pm-spec",',
  '  "product": "<product slug>",',
  '  "title": "<one-line project title>",',
  '  "spec": "<full markdown product spec: value, goals, non-goals, requirements, definition of done>",',
  '  "assumptions": ["<each gap you filled, if any>"],',
  '  "selfReview": "<brief note confirming you reviewed the spec for internal consistency>"',
  '}',
  '```',
  '',
  'Do not emit any downstream tech-spec, tasks, test-plan, or context. Those are',
  'created only after the human approves this PM spec.',
].join('\n');

const PM_SPEC_FENCE = /```pm-spec\s*\n([\s\S]*?)\n```/;

function renderPmSpecArtifact(artifact: PmSpecArtifact): string {
  return [
    '```pm-spec',
    JSON.stringify(artifact, null, 2),
    '```',
  ].join('\n');
}

function parsePmSpecReviewReply(reply: string): PmSpecArtifact {
  const fenced = PM_SPEC_FENCE.exec(reply);
  if (!fenced) {
    throw new Error('missing pm-spec fence');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fenced[1]!);
  } catch (err) {
    throw new Error(`malformed pm-spec JSON: ${(err as Error).message}`);
  }

  const artifact = validatePmSpecArtifact(parsed);
  if (!artifact) {
    throw new Error('pm-spec artifact missing version:2, kind:pm-spec, product, title, or spec');
  }
  return artifact;
}

function formatPmSpecApprovalReply(summary: string, artifact: PmSpecArtifact): string {
  const intro = summary.trim() || 'Proposed spec ready — approve to scaffold.';
  return [intro, '', renderPmSpecArtifact(artifact)].join('\n');
}

/**
 * Production scopingTurn — calls Claude with the planning session's
 * claudeSessionId for multi-turn continuity, parses the response into a
 * `ScopingResult`. A `pm-spec` fence is the terminal PM approval artifact;
 * anything else is a scoping question unless the reply claims completion but
 * omits the required fence.
 */
export async function defaultScopingTurn(input: {
  session: StoredPlanningSession;
  userMessage: string;
}): Promise<ScopingResult> {
  const ctx = composeRoleContext('pm', INTERVIEW_INSTRUCTION);
  const pmModel = resolvePlanningSelfReviewModel('pm');
  const message = ctx.referenceContext
    ? `${ctx.referenceContext}\n\n${input.userMessage}`
    : input.userMessage;
  if (pmModel?.format !== undefined && pmModel.format !== 'claude') {
    throw new Error(`defaultScopingTurn: PM model format '${pmModel.format}' has no multi-turn planning executor`);
  }
  const result = await askClaudeWithContext(
    message,
    input.session.claudeSessionId,
    ctx.systemInstructions,
    {
      opLabel: 'chat',
      voice: true,
      ...(pmModel?.model ? { model: pmModel.model } : {}),
    },
  );
  if (result.error) {
    throw new Error(`scopingTurn: Claude returned error: ${result.error}`);
  }
  const text = result.text ?? '';

  if (/```\s*planning-brief\b/i.test(text)) {
    throw new Error(
      'scopingTurn: retired planning handoff received; expected a versioned pm-spec fence',
    );
  }

  const fenced = PM_SPEC_FENCE.exec(text);
  if (!fenced) {
    if (looksLikeFinishedSpec(text)) {
      throw new Error('scopingTurn: planning reply looked complete but omitted the pm-spec fence');
    }
    return { kind: 'question', text };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fenced[1]!);
  } catch (err) {
    log.warn('defaultScopingTurn: malformed pm-spec JSON', {
      error: (err as Error).message,
    });
    throw new Error(`scopingTurn: malformed pm-spec JSON: ${(err as Error).message}`);
  }

  const artifact = validatePmSpecArtifact(parsed);
  if (!artifact) {
    log.warn('defaultScopingTurn: pm-spec JSON missing required fields');
    throw new Error('scopingTurn: pm-spec artifact missing version:2, kind:pm-spec, product, title, or spec');
  }

  // Strip the fenced block from the user-facing reply — the structured
  // artifact reaches the planner via proposeSpec, the user sees only the
  // summary line(s) before the fence.
  const summary = text.slice(0, fenced.index).trim();
  return { kind: 'spec', text: summary || 'Proposed spec ready — approve to scaffold.', artifact };
}

function validatePmSpecArtifact(value: unknown): PmSpecArtifact | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (
    v['version'] !== 2 ||
    v['kind'] !== 'pm-spec' ||
    typeof v['product'] !== 'string' ||
    typeof v['title'] !== 'string' ||
    typeof v['spec'] !== 'string'
  ) {
    return null;
  }
  const assumptions = parseOptionalStringArray(v['assumptions']);
  if (assumptions === null) return null;
  return {
    version: 2,
    kind: 'pm-spec',
    product: v['product'],
    title: v['title'],
    spec: v['spec'],
    ...(assumptions ? { assumptions } : {}),
    ...(v['selfReview'] !== undefined ? { selfReview: v['selfReview'] } : {}),
  };
}

function parseOptionalStringArray(value: unknown): string[] | undefined | null {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return null;
  return value.every((entry) => typeof entry === 'string') ? value : null;
}

function looksLikeFinishedSpec(text: string): boolean {
  const trimmed = text.trim();
  return /```pm-spec\b/i.test(trimmed) ||
    /\b(?:spec|proposal|artifact)\s+(?:is\s+)?(?:ready|complete)\s+for\s+(?:approval|review)\b/i.test(trimmed) ||
    /\b(?:spec|proposal|artifact)\s+(?:ready|complete)\s*:/i.test(trimmed) ||
    /\bhere is (?:the )?(?:finished|complete|ready)\s+(?:spec|proposal|artifact)\b/i.test(trimmed);
}
