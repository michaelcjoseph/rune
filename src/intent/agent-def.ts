/**
 * Model-agnostic agent definitions — a neutral representation of an agent (its role,
 * tools, constraints, and declared capabilities) that compiles down to a provider format.
 * Jarvis's agents today are `.claude/agents/*.md` (Claude Code's format); to dispatch the
 * same agent to Codex or Gemini, the system needs this neutral representation and a
 * compiler per target.
 *
 * A neutral definition names **no model** — which model runs an agent is the model
 * selection policy's decision (test-plan §5), never an agent property. An agent declares
 * the *capabilities* its role needs; the policy binds those to a model.
 *
 * STATUS: the Claude and Codex paths are implemented. `parseClaudeAgent` reads a
 * `.claude/agents/*.md` into the neutral format, `compileToClaude` emits it back, and
 * `compileToCodex` emits the same neutral definition as a structured markdown agent
 * document for Codex (pinned by `agent-def.test.ts` (§4) and `dispatch.test.ts` (§13)).
 * `compileToGemini` still throws a "deferred to Phase 4" error — Gemini is not in the v1
 * wedge.
 *
 * See docs/projects/08-intent-layer/{spec.md (§"Model-agnostic agent definitions"), test-plan.md (§4)}.
 */

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

/**
 * The neutral, model-agnostic agent definition. Captures role, tools, constraints, and
 * declared capabilities — but never a model name.
 */
export interface NeutralAgentDef {
  /** Agent identifier, e.g. `code-reviewer`. */
  name: string;
  /** What the agent does — its role / description. */
  role: string;
  /** Capability tags the role needs (e.g. `coding`, `long-context`). The policy binds these to a model. */
  capabilities: string[];
  /** Tools the agent may use. */
  tools: string[];
  /** Behavioral constraints (e.g. `read-only`, `must not write outside knowledge/`). */
  constraints: string[];
  /** The agent's system prompt / instructions — the markdown body. */
  instructions: string;
  /**
   * Frontmatter keys outside the neutral format (e.g. Jarvis's `cron` / `cron_chat`
   * scheduling fields), carried opaquely so the Claude compiler round-trips an existing
   * agent with no behavior change. The `model` key is the deliberate exception — it is
   * dropped, never carried here.
   */
  extraFrontmatter?: Record<string, unknown>;
}

/**
 * Frontmatter keys the neutral format owns. Every other key is carried opaquely in
 * `extraFrontmatter`. `model` is owned-but-dropped — a neutral definition names no model.
 */
const NEUTRAL_FRONTMATTER_KEYS = new Set([
  'name',
  'description',
  'model',
  'tools',
  'capabilities',
  'constraints',
]);

/** Leading `---` YAML frontmatter block, then the markdown body. */
const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;

/** Coerce a YAML value to a string array — a missing or non-array value yields `[]`. */
function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => String(item)) : [];
}

/**
 * Parse a Claude agent file (`.claude/agents/*.md`: YAML frontmatter + markdown body) into
 * the neutral representation. The frontmatter `model`, if present, is dropped — a neutral
 * definition names no model. Frontmatter keys outside the neutral format are carried in
 * `extraFrontmatter` so a later compile round-trips them losslessly.
 */
export function parseClaudeAgent(markdown: string): NeutralAgentDef {
  const match = markdown.match(FRONTMATTER_RE);
  if (!match) {
    throw new Error('parseClaudeAgent: missing YAML frontmatter — expected a leading `---` block');
  }
  const [, rawFrontmatter, body] = match;
  let parsed: unknown;
  try {
    parsed = parseYaml(rawFrontmatter ?? '') ?? {};
  } catch (err) {
    throw new Error(`parseClaudeAgent: malformed YAML frontmatter — ${(err as Error).message}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('parseClaudeAgent: frontmatter is not a YAML mapping');
  }
  const frontmatter = parsed as Record<string, unknown>;

  // Every non-neutral key is carried opaquely so a later compile round-trips it.
  const extraFrontmatter: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(frontmatter)) {
    if (!NEUTRAL_FRONTMATTER_KEYS.has(key)) extraFrontmatter[key] = value;
  }

  const def: NeutralAgentDef = {
    name: typeof frontmatter['name'] === 'string' ? frontmatter['name'] : '',
    role: typeof frontmatter['description'] === 'string' ? frontmatter['description'] : '',
    capabilities: toStringArray(frontmatter['capabilities']),
    tools: toStringArray(frontmatter['tools']),
    constraints: toStringArray(frontmatter['constraints']),
    instructions: (body ?? '').trim(),
  };
  // Only attach extraFrontmatter when there is something to carry, so an agent with no
  // extra keys round-trips to an identical definition.
  if (Object.keys(extraFrontmatter).length > 0) def.extraFrontmatter = extraFrontmatter;
  return def;
}

/**
 * Compile a neutral definition to Claude agent-file content (`.claude/agents/*.md`). The
 * output carries no hardcoded `model` line — model resolution is the policy's job — but
 * re-emits every `extraFrontmatter` key. Throws a clear error naming the field when a
 * required field is missing.
 */
/**
 * Assert the neutral definition carries the required non-empty fields: `name`, `role`, and
 * `instructions`. `tools` / `capabilities` / `constraints` may legitimately be empty. Used
 * by every compiler target so the error message names the caller and the missing field.
 */
function assertRequiredFields(def: NeutralAgentDef, caller: string): void {
  for (const field of ['name', 'role', 'instructions'] as const) {
    if (typeof def[field] !== 'string' || def[field].trim() === '') {
      throw new Error(`${caller}: required field '${field}' is missing or empty`);
    }
  }
}

export function compileToClaude(def: NeutralAgentDef): string {
  assertRequiredFields(def, 'compileToClaude');

  // Neutral keys first, then the opaque extras. `model` is never emitted.
  const frontmatter: Record<string, unknown> = { name: def.name, description: def.role };
  if (def.tools.length > 0) frontmatter['tools'] = def.tools;
  if (def.capabilities.length > 0) frontmatter['capabilities'] = def.capabilities;
  if (def.constraints.length > 0) frontmatter['constraints'] = def.constraints;
  for (const [key, value] of Object.entries(def.extraFrontmatter ?? {})) {
    frontmatter[key] = value;
  }

  // lineWidth: 0 disables line folding, so a long description stays on one line and the
  // parse → compile → parse round-trip is exact.
  const yaml = stringifyYaml(frontmatter, { lineWidth: 0 });
  return `---\n${yaml}---\n\n${def.instructions.trim()}\n`;
}

/**
 * Compile a neutral definition to the Codex target — a structured markdown agent document
 * Codex consumes. It carries the agent's role, declared capabilities, tools, constraints,
 * and instructions; like the Claude target it names no model (model resolution is the
 * policy's job). Claude-specific `extraFrontmatter` keys (e.g. Jarvis's cron fields) are
 * not emitted — those apply only to Jarvis-internal Claude agents, not a Codex executor.
 * Throws naming any missing required field, mirroring `compileToClaude`.
 */
export function compileToCodex(def: NeutralAgentDef): string {
  assertRequiredFields(def, 'compileToCodex');
  // Newlines stripped from `name` so it cannot inject a section header into the H1; `role`
  // and `instructions` each sit in their own labeled `##` section, so multi-line content is
  // unambiguous and never bleeds into a sibling section.
  const safeName = def.name.replace(/\n/g, ' ');
  const lines: string[] = [`# Agent: ${safeName}`, '', '## Role', '', def.role.trim()];
  const section = (heading: string, items: string[]): void => {
    if (items.length > 0) lines.push('', `## ${heading}`, ...items.map((item) => `- ${item}`));
  };
  section('Capabilities', def.capabilities);
  section('Tools', def.tools);
  section('Constraints', def.constraints);
  lines.push('', '## Instructions', '', def.instructions.trim());
  return `${lines.join('\n')}\n`;
}

/**
 * Compile a neutral definition to the Gemini target. The Gemini target is built in Phase 4
 * (multi-model dispatch); until then this throws a clear "deferred to Phase 4" error and
 * does not affect the Claude path.
 */
export function compileToGemini(_def: NeutralAgentDef): string {
  throw new Error(
    'compileToGemini: deferred to Phase 4 — the Gemini compiler target is built in Phase 4 (multi-model dispatch)',
  );
}
