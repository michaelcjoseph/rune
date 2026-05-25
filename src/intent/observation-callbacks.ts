/**
 * Adapter callables for the observation loop's LLM-driven stages —
 * project 08-intent-layer Phase 6 B3.3.
 *
 * `synthesizeDigest` (`src/intent/observation-synthesis.ts`) and
 * `runObservationLoop` (`src/intent/observation-loop.ts`) both inject
 * callables for the LLM-driven half so the orchestration cores stay
 * deterministic and unit-testable. This module supplies the production
 * implementations:
 *
 * - `diarize(signals)` wraps `runAgent('observation-diarizer', ...)`
 *   and parses the agent reply as JSON. On any failure (agent error,
 *   malformed JSON, missing fields), returns the input unchanged so the
 *   loop sees raw signal rather than nothing — the next pass can try
 *   again.
 *
 * - `triage(signal)` wraps `runAgent('observation-triage', ...)` and
 *   parses the agent reply as a `TriageVerdict`. On any failure,
 *   returns a `{file:false, reason}` discard rather than silently
 *   filing something — bad files pollute `docs/projects/ideas.md`,
 *   bad discards just delay surfacing a recurring friction by one
 *   pass.
 *
 * Both helpers tolerate an LLM that wraps its JSON reply in a markdown
 * fence (`\`\`\`json ... \`\`\``) — a frequent lapse worth defending
 * against once at the adapter layer.
 *
 * See spec.md §"Phase 5" and test-plan.md §16.
 */

import { runAgent } from '../ai/claude.js';
import { createLogger } from '../utils/logger.js';
import type { SensorSignal, TriageVerdict, ProjectIdea } from './observation-loop.js';

const log = createLogger('observation-callbacks');

/** Pre-compiled fence regex — captures the JSON body from a `\`\`\`json
 *  ... \`\`\`` or bare `\`\`\` ... \`\`\`` wrapper. The match is on the
 *  whole reply so we only strip when the entire reply is wrapped. */
const FENCE_RE = /^\s*```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/;

/** Strip a markdown fence around the agent reply if present. The
 *  observation agents are instructed not to use fences, but LLMs lapse;
 *  defending at the adapter layer keeps every caller from re-implementing
 *  the strip. Returns the raw reply when no fence is found. */
function stripFence(reply: string): string {
  const m = FENCE_RE.exec(reply);
  return m ? m[1]! : reply;
}

/** Tighter-typed JSON.parse that returns null on any failure. */
function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Shape-check a single sensor signal — guards against an LLM that
 *  returns the right keys but the wrong types. */
function isSensorSignalShape(value: unknown): value is SensorSignal {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    (v['source'] === 'vault' || v['source'] === 'telemetry' || v['source'] === 'interaction') &&
    typeof v['content'] === 'string' &&
    typeof v['ts'] === 'string'
  );
}

/** Shape-check a project idea — friction + id are required; the
 *  observation-triage agent's id-construction rule is enforced in the
 *  prompt, but the adapter checks the field is present and non-empty. */
function isProjectIdeaShape(value: unknown): value is ProjectIdea {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v['title'] === 'string' && v['title'].length > 0 &&
    typeof v['friction'] === 'string' && v['friction'].length > 0 &&
    typeof v['id'] === 'string' && v['id'].length > 0
  );
}

/**
 * Production diarizer: send raw sensor signals to `observation-diarizer`
 * and parse the compacted result. Returns the input verbatim on any
 * adapter failure so the loop sees the raw signal rather than nothing.
 *
 * Short-circuits on empty input — the agent doesn't need to be invoked
 * for a quiet pass.
 */
export async function diarize(signals: SensorSignal[]): Promise<SensorSignal[]> {
  if (signals.length === 0) return [];

  const prompt = JSON.stringify({ signals });
  const result = await runAgent('observation-diarizer', prompt);
  if (result.error !== null || result.text === null) {
    log.warn('diarize: agent error; returning input unchanged', { error: result.error ?? 'no text' });
    return signals;
  }

  const parsed = safeParse(stripFence(result.text));
  if (parsed === null || typeof parsed !== 'object') {
    log.warn('diarize: malformed JSON reply; returning input unchanged');
    return signals;
  }
  const payload = parsed as Record<string, unknown>;
  const out = payload['signals'];
  if (!Array.isArray(out)) {
    log.warn('diarize: reply missing signals array; returning input unchanged');
    return signals;
  }

  // Filter to shape-valid entries — an LLM that returns mostly-correct
  // entries plus one with a missing field shouldn't poison the digest.
  const valid = out.filter(isSensorSignalShape);
  if (valid.length === 0) {
    log.warn('diarize: reply had no shape-valid signals; returning input unchanged');
    return signals;
  }
  return valid;
}

/**
 * Production triage: send one sensor signal to `observation-triage`
 * and parse the verdict. Returns a `{file:false, reason}` discard on
 * any adapter failure rather than silently filing — bad files pollute
 * `docs/projects/ideas.md`, bad discards just delay surfacing a
 * recurring friction by one pass.
 */
export async function triage(signal: SensorSignal): Promise<TriageVerdict> {
  const prompt = JSON.stringify({ signal });
  const result = await runAgent('observation-triage', prompt);
  if (result.error !== null || result.text === null) {
    log.warn('triage: agent error; discarding', { error: result.error ?? 'no text' });
    return { file: false, reason: `triage agent error: ${result.error ?? 'no text'}` };
  }

  const parsed = safeParse(stripFence(result.text));
  if (parsed === null || typeof parsed !== 'object') {
    log.warn('triage: malformed JSON reply; discarding');
    return { file: false, reason: 'triage reply was not valid JSON' };
  }
  const payload = parsed as Record<string, unknown>;

  if (payload['file'] === true) {
    if (!isProjectIdeaShape(payload['idea'])) {
      log.warn('triage: file:true but idea object is malformed; discarding');
      return { file: false, reason: 'triage reply had file:true but a malformed idea object' };
    }
    return { file: true, idea: payload['idea'] };
  }
  if (payload['file'] === false) {
    const reason = typeof payload['reason'] === 'string' ? payload['reason'] : 'no reason given';
    return { file: false, reason };
  }
  log.warn('triage: reply missing or invalid file field; discarding');
  return { file: false, reason: 'triage reply missing or invalid file field' };
}
