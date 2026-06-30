import { askClaudeOneShot } from '../ai/claude.js';
import type { SupersessionCandidate, SupersessionDecision } from './knowledge-supersession.js';

export async function conservativeSupersessionAdjudicator(
  candidate: SupersessionCandidate,
): Promise<SupersessionDecision> {
  const result = await askClaudeOneShot(buildSupersessionPrompt(candidate), undefined, 'kb-supersession-adjudicator');
  if (result.error || !result.text?.trim()) {
    return {
      status: 'ambiguous',
      rationale: result.error
        ? `LLM adjudication failed: ${result.error}`
        : 'LLM adjudication returned empty output; treating as ambiguous.',
    };
  }

  return parseDecision(result.text);
}

function buildSupersessionPrompt(candidate: SupersessionCandidate): string {
  const evidence = candidate.newerSources
    .map((source) => `- ${source.file}:${source.line}: ${source.content}`)
    .join('\n');

  return `You are a conservative knowledge-freshness adjudicator.

The candidate below was already surfaced by the deterministic finder because it contains the superseded token and newer evidence mentions the replacement. Do not search. Do not discover new contradictions. Only adjudicate this candidate.

Accept only if the candidate is a current-state fact and is clearly superseded by the newer evidence. Historical references, rename history, quotations, lineage notes, and ambiguous copy must be ambiguous or rejected and left unchanged.

Return only JSON with this shape:
{
  "status": "accepted" | "rejected" | "ambiguous",
  "replacement": "exact replacement line, required only for accepted",
  "rationale": "short reason"
}

Supersession:
${candidate.supersession.from} -> ${candidate.supersession.to}

Candidate:
${candidate.file}:${candidate.line}: ${candidate.text}

Newer evidence:
${evidence}`;
}

function parseDecision(raw: string): SupersessionDecision {
  const parsed = parseJsonObject(raw);
  if (!parsed) {
    return {
      status: 'ambiguous',
      rationale: 'Malformed LLM adjudication output; conservative fallback to ambiguous.',
    };
  }

  const status = parsed['status'];
  const replacement = parsed['replacement'];
  const rationale = parsed['rationale'];

  if (status !== 'accepted' && status !== 'rejected' && status !== 'ambiguous') {
    return {
      status: 'ambiguous',
      rationale: 'Invalid LLM adjudication status; conservative fallback to ambiguous.',
    };
  }

  if (typeof rationale !== 'string' || rationale.trim().length === 0) {
    return {
      status: 'ambiguous',
      rationale: 'Invalid LLM adjudication rationale; conservative fallback to ambiguous.',
    };
  }

  if (status === 'accepted') {
    if (typeof replacement !== 'string' || replacement.trim().length === 0) {
      return {
        status: 'ambiguous',
        rationale: 'Invalid accepted LLM adjudication: missing replacement; conservative fallback to ambiguous.',
      };
    }
    return {
      status,
      replacement,
      rationale,
    };
  }

  return {
    status,
    rationale,
  };
}

function parseJsonObject(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim();
  const json = trimmed.startsWith('{') ? trimmed : extractFirstJsonObject(trimmed);
  if (!json) return null;

  try {
    const parsed = JSON.parse(json) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return null;
  }

  return null;
}

function extractFirstJsonObject(raw: string): string | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  return raw.slice(start, end + 1);
}
