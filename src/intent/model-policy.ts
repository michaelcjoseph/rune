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
 * STATUS: partially implemented. `parsePolicy` validates the declarative policy file
 * (`policies/model-policy.json`). `resolveModel` remains a contract stub, filled in by the
 * Phase 1 model-selection-policy resolver task; its tests in `model-policy.test.ts`
 * (test-plan.md §5) stay RED until then.
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

const MODEL_FORMATS = new Set(['claude', 'codex', 'gemini']);
const COST_TIERS = new Set(['low', 'medium', 'high']);
const MODEL_STATUSES = new Set(['preferred', 'active', 'deprecated']);

/** Validate one raw registry entry into a `ModelEntry`, throwing a clear, indexed error. */
function parseModelEntry(value: unknown, index: number): ModelEntry {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`model policy is invalid — models[${index}] is not an object`);
  }
  const m = value as Record<string, unknown>;
  const requireString = (field: string): string => {
    const v = m[field];
    if (typeof v !== 'string' || v === '') {
      throw new Error(`model policy is invalid — models[${index}].${field} is missing or not a string`);
    }
    return v;
  };
  const requireEnum = (field: string, allowed: Set<string>): string => {
    const v = requireString(field);
    if (!allowed.has(v)) {
      throw new Error(
        `model policy is invalid — models[${index}].${field} '${v}' is not one of ${[...allowed].join('|')}`,
      );
    }
    return v;
  };
  const alias = requireString('alias');
  const provider = requireString('provider');
  const format = requireEnum('format', MODEL_FORMATS) as ModelEntry['format'];
  const costTier = requireEnum('costTier', COST_TIERS) as ModelEntry['costTier'];
  const status = requireEnum('status', MODEL_STATUSES) as ModelStatus;
  if (!Array.isArray(m['capabilities']) || !m['capabilities'].every((c) => typeof c === 'string')) {
    throw new Error(`model policy is invalid — models[${index}].capabilities must be a string array`);
  }
  return { alias, provider, format, capabilities: m['capabilities'] as string[], costTier, status };
}

/**
 * Parse and validate a model policy from its declarative file content. Throws a clear
 * error — fast, at load time — when the content is malformed or structurally invalid; a
 * broken policy is never silently replaced with a default. Validation includes referential
 * integrity: `globalFallback` and every `roleDefaults` entry must name a model that exists
 * in the registry.
 */
export function parsePolicy(raw: string): ModelPolicy {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`model policy is malformed — could not parse: ${(err as Error).message}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('model policy is malformed — expected a JSON object');
  }
  const p = parsed as Record<string, unknown>;

  if (!Array.isArray(p['models'])) {
    throw new Error('model policy is invalid — `models` must be an array');
  }
  const models = p['models'].map((entry, index) => parseModelEntry(entry, index));
  if (models.length === 0) {
    throw new Error('model policy is invalid — `models` must contain at least one entry');
  }

  if (typeof p['globalFallback'] !== 'string' || p['globalFallback'] === '') {
    throw new Error('model policy is invalid — `globalFallback` is missing or not a string');
  }
  const globalFallback = p['globalFallback'];

  const rawRoleDefaults = p['roleDefaults'];
  if (typeof rawRoleDefaults !== 'object' || rawRoleDefaults === null || Array.isArray(rawRoleDefaults)) {
    throw new Error('model policy is invalid — `roleDefaults` is missing or not an object');
  }
  const roleDefaults: Record<string, string> = {};
  for (const [role, alias] of Object.entries(rawRoleDefaults)) {
    if (typeof alias !== 'string') {
      throw new Error(`model policy is invalid — roleDefaults['${role}'] must be a model alias string`);
    }
    roleDefaults[role] = alias;
  }

  if (typeof p['evaluatorDistinctFromGenerator'] !== 'boolean') {
    throw new Error('model policy is invalid — `evaluatorDistinctFromGenerator` is missing or not a boolean');
  }
  const evaluatorDistinctFromGenerator = p['evaluatorDistinctFromGenerator'];

  // Aliases must be unique — a duplicate makes resolution ambiguous (structural invalidity).
  const aliases = new Set<string>();
  for (const model of models) {
    if (aliases.has(model.alias)) {
      throw new Error(`model policy is invalid — duplicate model alias '${model.alias}'`);
    }
    aliases.add(model.alias);
  }

  // Referential integrity: globalFallback and every roleDefault must name a registered model.
  if (!aliases.has(globalFallback)) {
    throw new Error(`model policy is invalid — globalFallback '${globalFallback}' is not a registered model`);
  }
  for (const [role, alias] of Object.entries(roleDefaults)) {
    if (!aliases.has(alias)) {
      throw new Error(`model policy is invalid — roleDefaults['${role}'] '${alias}' is not a registered model`);
    }
  }

  return { models, globalFallback, roleDefaults, evaluatorDistinctFromGenerator };
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
