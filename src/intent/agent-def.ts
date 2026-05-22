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
 * STATUS: contract stub. `parseClaudeAgent` and `compileToClaude` are stubs that throw
 * 'not implemented' — Phase 1's agent-definition tasks fill them in. `compileToCodex` and
 * `compileToGemini` are *not* stubs: they throw a "deferred to Phase 4" error, which is
 * their correct, intended behavior until the Codex/Gemini targets are built in Phase 4.
 * The test-first suite in `agent-def.test.ts` (test-plan.md §4) is RED by design except
 * for the deferred-targets test, which is green because deferral is genuinely in place.
 *
 * See docs/projects/08-intent-layer/{spec.md (§"Model-agnostic agent definitions"), test-plan.md (§4)}.
 */

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

const NOT_IMPLEMENTED =
  'agent-def: not implemented — Phase 1 agent-definition tasks (docs/projects/08-intent-layer) fill this in';

/**
 * Parse a Claude agent file (`.claude/agents/*.md`: YAML frontmatter + markdown body) into
 * the neutral representation. The frontmatter `model`, if present, is dropped — a neutral
 * definition names no model. Frontmatter keys outside the neutral format are carried in
 * `extraFrontmatter` so a later compile round-trips them losslessly.
 */
export function parseClaudeAgent(_markdown: string): NeutralAgentDef {
  throw new Error(NOT_IMPLEMENTED);
}

/**
 * Compile a neutral definition to Claude agent-file content (`.claude/agents/*.md`). The
 * output carries no hardcoded `model` line — model resolution is the policy's job — but
 * re-emits every `extraFrontmatter` key. Throws a clear error naming the field when a
 * required field is missing.
 */
export function compileToClaude(_def: NeutralAgentDef): string {
  throw new Error(NOT_IMPLEMENTED);
}

/**
 * Compile a neutral definition to the Codex target. The Codex target is built in Phase 4
 * (multi-model dispatch); until then this throws a clear "deferred to Phase 4" error and
 * does not affect the Claude path.
 */
export function compileToCodex(_def: NeutralAgentDef): string {
  throw new Error(
    'compileToCodex: deferred to Phase 4 — the Codex compiler target is built in Phase 4 (multi-model dispatch)',
  );
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
