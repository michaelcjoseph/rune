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
 * STATUS: implemented. `parsePolicy` validates the declarative policy file
 * (`policies/model-policy.json`); `resolveModel` is the deterministic resolver. The
 * contract is pinned by the test suite in `model-policy.test.ts` (test-plan.md §5).
 *
 * See docs/projects/08-intent-layer/{spec.md (§"Model selection policy"), test-plan.md (§5)}.
 */

import { readFileSync } from 'node:fs';
import { createLogger } from '../utils/logger.js';

const log = createLogger('model-policy');

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

/** Validated model policies by path. A cached `null` means a known-absent file;
 *  `undefined` (a Map miss) means not yet looked up — hence the `!== undefined` check.
 *  A malformed file is never cached: `parsePolicy` throws before the `set`. */
const policyCache = new Map<string, ModelPolicy | null>();

/**
 * Load and validate the declarative model policy from `policyPath`. Returns `null` when
 * the file is absent — callers fall back to pre-policy behavior rather than failing. A
 * present-but-malformed file throws (via {@link parsePolicy}): a broken policy fails fast
 * and loudly, it is never silently treated as a permissive default. The path is injected
 * by the caller so this module stays free of config and the cwd. The result is cached per
 * path; the startup load warms the cache so per-`runAgent` resolution does not re-read.
 */
export function loadModelPolicy(policyPath: string): ModelPolicy | null {
  const cached = policyCache.get(policyPath);
  if (cached !== undefined) return cached;
  let raw: string;
  try {
    raw = readFileSync(policyPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      policyCache.set(policyPath, null);
      return null;
    }
    // Pathless on purpose — this message can reach the user via a runAgent error result.
    throw new Error(
      `model policy file is unreadable (${(err as NodeJS.ErrnoException).code ?? 'I/O error'})`,
    );
  }
  const policy = parsePolicy(raw);
  policyCache.set(policyPath, policy);
  return policy;
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
export function resolveModel(request: ResolveRequest, policy: ModelPolicy): Resolution {
  // The cross-model adjudication constraint: when it is set, an evaluator resolution must
  // declare the generator's provider so the resolver can exclude it. Refuse loudly rather
  // than silently skip the constraint.
  if (
    policy.evaluatorDistinctFromGenerator &&
    request.role === 'evaluator' &&
    request.distinctFromProvider === undefined
  ) {
    throw new Error(
      'model policy: the evaluator.distinct_from constraint is set — an evaluator ' +
        "resolution must supply distinctFromProvider (the generator's provider)",
    );
  }

  // Explicit pin — highest precedence. A pin must name a registered, non-deprecated model;
  // a deprecated pin fails loudly rather than silently rerouting.
  if (request.pin !== undefined) {
    const pinned = policy.models.find((m) => m.alias === request.pin);
    if (!pinned) {
      throw new Error(`model policy: pinned model '${request.pin}' is not a registered model`);
    }
    if (pinned.status === 'deprecated') {
      throw new Error(`model policy: pinned model '${request.pin}' is deprecated`);
    }
    // A pin still cannot silently violate a declared distinct-provider constraint —
    // honoring it would defeat the cross-model adjudication the caller asked for.
    if (request.distinctFromProvider !== undefined && pinned.provider === request.distinctFromProvider) {
      throw new Error(
        `model policy: pinned model '${request.pin}' (provider '${pinned.provider}') ` +
          'violates the evaluator.distinct_from constraint',
      );
    }
    return logResolution(request.role, {
      model: pinned.alias,
      provider: pinned.provider,
      rule: 'explicit-pin',
    });
  }

  // Capability satisfaction, non-deprecated status, and the distinct-provider filter are a
  // hard filter applied first; precedence then orders selection within the eligible set.
  const capabilityFit = policy.models.filter(
    (m) =>
      m.status !== 'deprecated' && request.capabilities.every((cap) => m.capabilities.includes(cap)),
  );
  const eligible = capabilityFit.filter(
    (m) => request.distinctFromProvider === undefined || m.provider !== request.distinctFromProvider,
  );

  if (eligible.length === 0) {
    // Diagnose why nothing is eligible so the error names the actual blocker.
    if (capabilityFit.length > 0 && request.distinctFromProvider !== undefined) {
      throw new Error(
        'model policy: cannot satisfy the evaluator.distinct_from constraint — every ' +
          `capability-fit model is provider '${request.distinctFromProvider}'`,
      );
    }
    const unmet = request.capabilities.filter(
      (cap) => !policy.models.some((m) => m.status !== 'deprecated' && m.capabilities.includes(cap)),
    );
    throw new Error(
      unmet.length > 0
        ? `model policy: no registered model satisfies the required capabilities: ${unmet.join(', ')}`
        : 'model policy: no registered model satisfies all required capabilities ' +
          `simultaneously: ${request.capabilities.join(', ')}`,
    );
  }

  // Role default — the per-role preferred alias, when it is itself eligible.
  const roleDefaultAlias = policy.roleDefaults[request.role];
  if (roleDefaultAlias !== undefined) {
    const candidate = eligible.find((m) => m.alias === roleDefaultAlias);
    if (candidate) {
      return logResolution(request.role, {
        model: candidate.alias,
        provider: candidate.provider,
        rule: 'role-default',
      });
    }
  }

  // Global fallback — when it is eligible; otherwise the first eligible model. The fallback
  // being unfit still beats failing, since an eligible model satisfies every hard filter.
  const fallback = eligible.find((m) => m.alias === policy.globalFallback) ?? eligible[0]!;
  return logResolution(request.role, {
    model: fallback.alias,
    provider: fallback.provider,
    rule: 'global-fallback',
  });
}

/** Log a resolution with the chosen model and the precedence rule that fired, then return it. */
function logResolution(role: string, resolution: Resolution): Resolution {
  log.info('model resolved', { role, ...resolution });
  return resolution;
}
