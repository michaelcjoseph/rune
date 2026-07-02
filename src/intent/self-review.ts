import { randomUUID } from 'node:crypto';

import { cleanupSession } from '../ai/claude.js';
import { composeRoleContext, type RoleName } from '../roles/loader.js';
import { createLogger } from '../utils/logger.js';
import { scrubAbsolutePaths } from '../utils/sanitize-paths.js';

const log = createLogger('self-review');

export type SelfReviewRole = Extract<RoleName, 'pm' | 'tech-lead' | 'coder'>;

export interface SelfReviewModelCall {
  (input: {
    role: SelfReviewRole;
    sessionId: string;
    systemPrompt: string;
    message: string;
  }): Promise<string>;
}

export interface RunSelfReviewInput<A> {
  role: SelfReviewRole;
  artifact: A;
  render: (artifact: A) => string;
  parse: (reply: string) => A;
  modelCall: SelfReviewModelCall;
  /** Optional resolved model alias when the caller has policy/runtime metadata. */
  model?: string;
  /** Optional resolved provider when the caller has policy/runtime metadata. */
  provider?: string;
}

export interface SelfReviewResult<A> {
  artifact: A;
  revised: boolean;
}

export const SELF_REVIEW_INSTRUCTION = [
  'Self-review the artifact in a fresh context.',
  '',
  'You are reviewing only the artifact provided by the caller. Find and fix',
  'internal inconsistency, missing connective tissue, gaps, and concrete errors',
  'that are visible from the artifact itself.',
  '',
  'Return the corrected-or-confirmed artifact in the requested machine-parseable',
  'format. Do not return a critique-only, flag-only, or status-only response.',
  '',
  'Preserve scope. Do not invent new product direction, requirements, technical',
  'strategy, tests, or implementation behavior that the artifact does not already',
  'contain or clearly imply. Improve the artifact on its own terms.',
].join('\n');

function buildReviewPrompt(renderedArtifact: string): string {
  return [
    'Run one fix-it self-review pass on this artifact.',
    '',
    'Correct issues you can see inside the artifact itself, then return the',
    'corrected-or-confirmed artifact in the same parseable format. Do not return',
    'only findings or a status flag.',
    '',
    'Preserve the artifact scope; do not add new product direction absent from',
    'the artifact.',
    '',
    'Artifact:',
    renderedArtifact,
  ].join('\n');
}

function buildStrictFormatRetryPrompt(renderedArtifact: string): string {
  return [
    'Your previous self-review response was not parseable as the artifact.',
    '',
    'This is a strict format retry only. Return the corrected-or-confirmed',
    'artifact in the required parseable format. Do not return findings, prose,',
    'or a status flag by itself.',
    '',
    'Use the same artifact scope as below; do not add new product direction.',
    '',
    'Artifact:',
    renderedArtifact,
  ].join('\n');
}

function normalizeStringForDelta(value: string): string {
  return value.replace(/\r\n?/g, '\n').trim().replace(/\s+/g, ' ');
}

function normalizeForDelta(value: unknown): unknown {
  if (typeof value === 'string') return normalizeStringForDelta(value);
  if (Array.isArray(value)) return value.map((entry) => normalizeForDelta(entry));
  if (!value || typeof value !== 'object') return value;

  const record = value as Record<string, unknown>;
  return Object.keys(record)
    .sort()
    .reduce<Record<string, unknown>>((acc, key) => {
      acc[key] = normalizeForDelta(record[key]);
      return acc;
    }, {});
}

function normalizedDeltaKey(value: unknown): string {
  return JSON.stringify(normalizeForDelta(value));
}

function parseSelfReviewReply<A>(
  reply: string,
  parse: (reply: string) => A,
): { ok: true; artifact: A } | { ok: false; error: Error } {
  try {
    return { ok: true, artifact: parse(reply) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err : new Error(String(err)) };
  }
}

export async function runSelfReview<A>({
  role,
  artifact,
  render,
  parse,
  modelCall,
  model,
  provider,
}: RunSelfReviewInput<A>): Promise<SelfReviewResult<A>> {
  const ctx = composeRoleContext(role, SELF_REVIEW_INSTRUCTION);
  const sessionId = randomUUID();
  const renderedArtifact = render(artifact);
  const logFields = selfReviewLogFields({ role, model, provider });

  log.info('self-review started', logFields);
  try {
    const firstReply = await modelCall({
      role,
      sessionId,
      systemPrompt: ctx.systemInstructions,
      message: buildReviewPrompt(renderedArtifact),
    });
    const firstParsed = parseSelfReviewReply(firstReply, parse);
    if (firstParsed.ok) {
      const result = resultForParsedArtifact(artifact, firstParsed.artifact);
      log.info('self-review completed', { ...logFields, revised: result.revised });
      return result;
    }

    const retryReply = await modelCall({
      role,
      sessionId,
      systemPrompt: ctx.systemInstructions,
      message: buildStrictFormatRetryPrompt(renderedArtifact),
    });
    const retryParsed = parseSelfReviewReply(retryReply, parse);
    if (retryParsed.ok) {
      const result = resultForParsedArtifact(artifact, retryParsed.artifact);
      log.info('self-review completed', { ...logFields, revised: result.revised });
      return result;
    }

    throw new Error(
      `self-review failed: response was still unparseable after strict-format retry (${retryParsed.error.message})`,
    );
  } catch (err) {
    log.error('self-review failed', {
      ...logFields,
      error: scrubAbsolutePaths((err as Error).message),
    });
    throw err;
  } finally {
    cleanupSession(sessionId);
  }
}

function selfReviewLogFields({
  role,
  model,
  provider,
}: {
  role: SelfReviewRole;
  model?: string;
  provider?: string;
}): { role: SelfReviewRole; model?: string; provider?: string } {
  return {
    role,
    ...(model !== undefined ? { model } : {}),
    ...(provider !== undefined ? { provider } : {}),
  };
}

function resultForParsedArtifact<A>(original: A, parsed: A): SelfReviewResult<A> {
  const revised = normalizedDeltaKey(original) !== normalizedDeltaKey(parsed);
  return {
    artifact: revised ? parsed : original,
    revised,
  };
}
