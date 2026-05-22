/**
 * Model selection policy — a declarative policy that decides which model runs a given
 * dispatch, and a deterministic (non-LLM) resolver over it.
 *
 * The policy is data, not code: adding, swapping, or retiring a model is an edit to the
 * policy file, never a deploy. It has a **model registry** (the dispatchable models, each
 * by stable alias), **role-to-capability binding** (an agent declares the capabilities its
 * role needs — see `NeutralAgentDef` in agent-def.ts — never a model), and a **resolver**
 * that maps (role, capabilities, policy) to a concrete model.
 *
 * Resolution precedence, highest first: explicit pin → role default → global fallback.
 * Every resolution is logged with the chosen model and the rule that fired.
 *
 * STATUS: contract stub. The type surface and signatures below are the contract pinned by
 * the test-first suite in `model-policy.test.ts` (test-plan.md §5). The function bodies are
 * intentionally unimplemented — Phase 1's model-selection-policy tasks fill them in. Until
 * then the suite is RED by design.
 *
 * See docs/projects/08-intent-layer/{spec.md (§"Model selection policy"), test-plan.md (§5)}.
 */

/** Lifecycle status of a model in the registry. */
export type ModelStatus = 'preferred' | 'active' | 'deprecated';

/** One dispatchable model — referenced by stable alias, never a pinned version ID. */
export interface ModelEntry {
  /** Stable alias, e.g. `sonnet`, `opus`, `codex`. Never a pinned version string. */
  alias: string;
  /** Provider family, e.g. `anthropic`, `openai`, `google`. */
  provider: string;
  /** Agent-definition format this model compiles to. */
  format: 'claude' | 'codex' | 'gemini';
  /** Capability tags this model offers (e.g. `coding`, `long-context`, `deep-reasoning`). */
  capabilities: string[];
  /** Coarse cost tier. */
  costTier: 'low' | 'medium' | 'high';
  /** Lifecycle status. `deprecated` models are never selected. */
  status: ModelStatus;
}

/** The declarative model policy — registry plus routing rules. */
export interface ModelPolicy {
  /** The model registry — every dispatchable model. */
  models: ModelEntry[];
  /** Alias of the global fallback model, used when nothing more specific resolves. */
  globalFallback: string;
  /** Per-role preferred model alias. */
  roleDefaults: Record<string, string>;
  /**
   * When true, the resolver requires every `evaluator`-role resolution to carry
   * `distinctFromProvider` (the Generator's provider) and fails loudly if it is missing —
   * so the cross-model adjudication constraint can never be silently skipped.
   */
  evaluatorDistinctFromGenerator: boolean;
}

/** A model-resolution request. */
export interface ResolveRequest {
  /** The role being dispatched, e.g. `code-reviewer`, `generator`. */
  role: string;
  /** The capability tags the role declares it needs. */
  capabilities: string[];
  /** An explicit pinned model alias (e.g. an agent's frontmatter `model:` override). Highest precedence. */
  pin?: string;
  /** When set, exclude models of this provider family — enforces `evaluator.distinct_from: generator`. */
  distinctFromProvider?: string;
}

/** The outcome of a resolution — the chosen model and the precedence rule that fired. */
export interface Resolution {
  /** Chosen model alias. */
  model: string;
  /** Provider family of the chosen model. */
  provider: string;
  /** Which precedence rule produced this resolution. */
  rule: 'explicit-pin' | 'role-default' | 'global-fallback';
}

const NOT_IMPLEMENTED =
  'model-policy: not implemented — Phase 1 model-selection-policy tasks (docs/projects/08-intent-layer) fill this in';

/**
 * Parse and validate a model policy from its declarative file content. Throws a clear
 * error — fast, at load time — when the content is malformed or structurally invalid; a
 * broken policy is never silently replaced with a default. Validation includes referential
 * integrity: `globalFallback` and every `roleDefaults` entry must name a model that exists
 * in the registry.
 */
export function parsePolicy(_raw: string): ModelPolicy {
  throw new Error(NOT_IMPLEMENTED);
}

/**
 * Deterministically resolve a request to a concrete model — no LLM call.
 *
 * Capability satisfaction is a **hard filter applied first**: only non-deprecated models
 * whose capability tags satisfy the role's declared needs (and that pass the
 * `distinctFromProvider` filter) are eligible. Precedence (explicit pin → role default →
 * global fallback) then orders selection *within* that eligible set. When the global
 * fallback is itself unfit, the resolver still picks an eligible model rather than failing.
 * It throws a clear error naming the unmet capability only when no model can satisfy the
 * role.
 *
 * When the policy's `evaluatorDistinctFromGenerator` is set, an `evaluator`-role request
 * must include `distinctFromProvider`; the resolver throws if it does not. Every
 * resolution logs the chosen model and the precedence rule that fired.
 */
export function resolveModel(_request: ResolveRequest, _policy: ModelPolicy): Resolution {
  throw new Error(NOT_IMPLEMENTED);
}
