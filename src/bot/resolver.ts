import config from '../config.js';
import { classifyIntent as callClassifier } from '../ai/claude.js';
import { createLogger } from '../utils/logger.js';
import type { SkillEntry } from './skill-registry.js';

const log = createLogger('resolver');

/** Result of classifying a free-form message against the skill registry.
 *  `ambiguous` is derived (top-1 and top-2 within RESOLVER_AMBIGUITY_DELTA)
 *  rather than asked of the classifier — the classifier returns raw scores;
 *  this module decides routing rules. */
export interface ClassifyResult {
  skill: string | null;
  args: string;
  confidence: number;
  second_skill: string | null;
  second_confidence: number;
  ambiguous: boolean;
  /** Raw classifier text, preserved for intent-log debugging when parsing
   *  fails. Not guaranteed to be valid JSON. */
  raw: string;
}

/** Shape the classifier is prompted to emit. Only used inside parse — callers
 *  see ClassifyResult. */
interface RawClassify {
  skill?: unknown;
  args?: unknown;
  confidence?: unknown;
  second_skill?: unknown;
  second_confidence?: unknown;
}

/** Build the compact prompt shown to Haiku. The registry is rendered as a
 *  terse list of skill descriptors (name, description, triggers, examples)
 *  followed by the user message and strict JSON instructions. */
export function buildResolverPrompt(message: string, registry: SkillEntry[]): string {
  const lines: string[] = [];
  lines.push('You are an intent classifier for a personal assistant.');
  lines.push('Given a user message and a list of skills, pick the best skill.');
  lines.push('');
  lines.push('Skills:');
  for (const s of registry) {
    lines.push(`- ${s.name} (${s.kind}): ${s.description}`);
    if (s.triggers && s.triggers.length > 0) {
      lines.push(`  Triggers: ${s.triggers.map(t => `"${t}"`).join(', ')}`);
    }
    if (s.examples && s.examples.length > 0) {
      for (const ex of s.examples) {
        const label = ex.expected_skill
          ? `→ ${ex.expected_skill}`
          : '→ (not this skill)';
        lines.push(`  Example: "${ex.message}" ${label}`);
      }
    }
  }
  lines.push('');
  lines.push(`User message: ${JSON.stringify(message)}`);
  lines.push('');
  lines.push('Return JSON only. No prose, no code fences. Shape:');
  lines.push('{');
  lines.push('  "skill": "<skill name or null if none fit>",');
  lines.push('  "args": "<text to pass to the skill; strip any directive prefix; empty string if none>",');
  lines.push('  "confidence": <number 0.0 to 1.0>,');
  lines.push('  "second_skill": "<second-best skill name or null>",');
  lines.push('  "second_confidence": <number 0.0 to 1.0>');
  lines.push('}');
  return lines.join('\n');
}

/** Parse the classifier's raw text into a ClassifyResult. Strips whitespace,
 *  tolerates a leading/trailing code fence, validates types. On any parse
 *  error returns a low-confidence result so routing falls through to the
 *  freeform handler rather than silent-failing. */
export function parseClassifyResponse(raw: string): ClassifyResult {
  const trimmed = stripFences(raw.trim());
  let parsed: RawClassify;
  try {
    parsed = JSON.parse(trimmed) as RawClassify;
  } catch {
    log.warn('Classifier returned invalid JSON', { raw: trimmed.slice(0, 200) });
    return zeroResult(raw);
  }

  const skill = typeof parsed.skill === 'string' && parsed.skill.length > 0 ? parsed.skill : null;
  const args = typeof parsed.args === 'string' ? parsed.args : '';
  const confidence = clampConfidence(parsed.confidence);
  const second_skill =
    typeof parsed.second_skill === 'string' && parsed.second_skill.length > 0
      ? parsed.second_skill
      : null;
  const second_confidence = clampConfidence(parsed.second_confidence);

  const ambiguous =
    skill !== null &&
    second_skill !== null &&
    Math.abs(confidence - second_confidence) < config.RESOLVER_AMBIGUITY_DELTA;

  return { skill, args, confidence, second_skill, second_confidence, ambiguous, raw };
}

/** Strip a single leading ```json / ``` fence if present. Haiku sometimes
 *  wraps JSON even when told not to. */
function stripFences(s: string): string {
  if (!s.startsWith('```')) return s;
  const withoutOpen = s.replace(/^```(?:json)?\n?/, '');
  return withoutOpen.replace(/\n?```\s*$/, '');
}

function clampConfidence(v: unknown): number {
  if (typeof v !== 'number' || Number.isNaN(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

function zeroResult(raw: string): ClassifyResult {
  return {
    skill: null,
    args: '',
    confidence: 0,
    second_skill: null,
    second_confidence: 0,
    ambiguous: false,
    raw,
  };
}

/** Classify a free-form user message against the provided skill registry.
 *  Returns a ClassifyResult with routing-ready fields. Errors from the Haiku
 *  call collapse to a zero-confidence result — the caller falls through. */
export async function classifyIntent(message: string, registry: SkillEntry[]): Promise<ClassifyResult> {
  const prompt = buildResolverPrompt(message, registry);
  const result = await callClassifier(prompt);
  if (result.error || result.text === null) {
    log.warn('Classifier call failed; falling through to freeform', { error: result.error });
    return zeroResult('');
  }
  return parseClassifyResponse(result.text);
}
