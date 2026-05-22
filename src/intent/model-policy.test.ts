import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fileURLToPath } from 'node:url';

/*
 * Test-first suite for test-plan.md §5 — model selection policy (08-intent-layer, Phase 1).
 *
 * Written BEFORE the implementation. `src/intent/model-policy.ts` currently ships as a
 * contract stub whose functions throw 'not implemented', so every test here is RED. That is
 * the intended, correct state: this is a "Tests (write first)" task — the suite goes green
 * when Phase 1's model-selection-policy implementation tasks land. Do not implement the
 * policy to make these pass; that is a separate task.
 */

// --- Mocks (must precede the module import) ---
// The resolver logs every resolution; the implementation imports createLogger at module
// load. vi.hoisted so mockLog exists before model-policy.ts's module-load createLogger().
const { mockLog } = vi.hoisted(() => ({
  mockLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../utils/logger.js', () => ({ createLogger: () => mockLog }));

import {
  parsePolicy,
  resolveModel,
  loadModelPolicy,
  type ModelPolicy,
} from './model-policy.js';

// --- Fixtures ---

/** A policy spanning two provider families and the three statuses. */
function samplePolicy(overrides: Partial<ModelPolicy> = {}): ModelPolicy {
  return {
    models: [
      { alias: 'sonnet', provider: 'anthropic', format: 'claude', capabilities: ['coding', 'long-context', 'classify'], costTier: 'medium', status: 'preferred' },
      { alias: 'opus', provider: 'anthropic', format: 'claude', capabilities: ['coding', 'long-context', 'deep-reasoning'], costTier: 'high', status: 'active' },
      { alias: 'haiku', provider: 'anthropic', format: 'claude', capabilities: ['classify'], costTier: 'low', status: 'active' },
      { alias: 'codex', provider: 'openai', format: 'codex', capabilities: ['coding', 'long-context'], costTier: 'medium', status: 'active' },
    ],
    globalFallback: 'sonnet',
    roleDefaults: { 'code-reviewer': 'sonnet' },
    evaluatorDistinctFromGenerator: false,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('model selection policy — registry and resolver (test-plan §5)', () => {
  it('resolves deterministically — same request and policy yield the same model, no LLM call', () => {
    const request = { role: 'code-reviewer', capabilities: ['coding'] };
    const a = resolveModel(request, samplePolicy());
    const b = resolveModel(request, samplePolicy());
    expect(a).toEqual(b);
  });

  it('honors precedence: explicit pin beats role default beats global fallback', () => {
    const policy = samplePolicy();
    expect(resolveModel({ role: 'code-reviewer', capabilities: ['coding'], pin: 'opus' }, policy)).toMatchObject({
      model: 'opus',
      rule: 'explicit-pin',
    });
    expect(resolveModel({ role: 'code-reviewer', capabilities: ['coding'] }, policy)).toMatchObject({
      model: 'sonnet',
      rule: 'role-default',
    });
    expect(resolveModel({ role: 'unconfigured-role', capabilities: ['coding'] }, policy)).toMatchObject({
      rule: 'global-fallback',
    });
  });

  it('picks only a model whose capability tags satisfy the role\'s declared needs', () => {
    // Capability satisfaction is a hard filter applied before precedence. The global
    // fallback `sonnet` lacks `deep-reasoning`, so the resolver must pick the eligible
    // model that has it (`opus`) rather than fall back to an unfit model.
    const resolution = resolveModel({ role: 'reasoner', capabilities: ['deep-reasoning'] }, samplePolicy());
    expect(resolution.model).toBe('opus');
  });

  it('references models by alias — the resolved model is a registry alias', () => {
    const policy = samplePolicy();
    const resolution = resolveModel({ role: 'code-reviewer', capabilities: ['coding'] }, policy);
    expect(policy.models.map((m) => m.alias)).toContain(resolution.model);
  });

  it('logs the chosen model and which precedence rule fired on every resolution', () => {
    resolveModel({ role: 'code-reviewer', capabilities: ['coding'] }, samplePolicy());
    expect(mockLog.info).toHaveBeenCalled();
    const logged = mockLog.info.mock.calls.flat().map((a) => JSON.stringify(a)).join(' ');
    expect(logged).toMatch(/sonnet/);
    expect(logged).toMatch(/role-default/);
  });

  it('fails loudly, naming the unmet capability, when no model satisfies the role', () => {
    // No model in the policy has the `vision` capability.
    expect(() => resolveModel({ role: 'looker', capabilities: ['vision'] }, samplePolicy())).toThrow(/vision/i);
  });
});

describe('model selection policy — updating as models change (test-plan §5)', () => {
  it('makes a newly added active model selectable with no code change', () => {
    const policy = samplePolicy({
      models: [
        ...samplePolicy().models,
        { alias: 'gemini-pro', provider: 'google', format: 'gemini', capabilities: ['vision'], costTier: 'medium', status: 'active' },
      ],
    });
    const resolution = resolveModel({ role: 'looker', capabilities: ['vision'] }, policy);
    expect(resolution.model).toBe('gemini-pro');
  });

  it('makes a model a role\'s default when roleDefaults maps the role to its alias', () => {
    // The role default is the per-role `roleDefaults` entry — distinct from a model's
    // lifecycle `status: 'preferred'`. Re-pointing the entry re-points the default.
    const before = resolveModel(
      { role: 'generator', capabilities: ['coding'] },
      samplePolicy({ roleDefaults: { generator: 'sonnet' } }),
    );
    const after = resolveModel(
      { role: 'generator', capabilities: ['coding'] },
      samplePolicy({ roleDefaults: { generator: 'opus' } }),
    );
    expect(before.model).toBe('sonnet');
    expect(after.model).toBe('opus');
  });

  it('never selects a deprecated model, and fails loudly when one is explicitly pinned', () => {
    const policy = samplePolicy({
      models: samplePolicy().models.map((m) => (m.alias === 'opus' ? { ...m, status: 'deprecated' as const } : m)),
    });
    // A role-default/fallback resolution never lands on the deprecated model...
    expect(resolveModel({ role: 'reasoner', capabilities: ['coding'] }, policy).model).not.toBe('opus');
    // ...and explicitly pinning it fails loudly rather than silently rerouting.
    expect(() => resolveModel({ role: 'reasoner', capabilities: ['coding'], pin: 'opus' }, policy)).toThrow(
      /deprecated/i,
    );
  });

  it('fails fast with a clear error when the policy file is malformed or structurally invalid', () => {
    // Beyond bad JSON: a wrong-typed field, a missing required field, and a referential
    // break (globalFallback names a model not in the registry) must all fail at parse time.
    const missingField = JSON.stringify({ models: samplePolicy().models });
    const badReference = JSON.stringify({ ...samplePolicy(), globalFallback: 'ghost-model' });
    for (const corrupt of ['{ not json', '', '{"models":"not-an-array"}', missingField, badReference]) {
      expect(() => parsePolicy(corrupt)).toThrow(
        /malformed|invalid|could not parse|missing|unknown|not a (registered|known) model/i,
      );
    }
  });
});

describe('model selection policy — cross-model adjudication constraint (test-plan §5)', () => {
  it('never resolves the Evaluator to the Generator\'s provider family when distinct is required', () => {
    const policy = samplePolicy({ evaluatorDistinctFromGenerator: true });
    const generator = resolveModel({ role: 'generator', capabilities: ['coding'] }, policy);
    const evaluator = resolveModel(
      { role: 'evaluator', capabilities: ['coding'], distinctFromProvider: generator.provider },
      policy,
    );
    expect(evaluator.provider).not.toBe(generator.provider);
  });

  it('fails loudly when the policy requires evaluator-distinct but no generator provider is supplied', () => {
    const policy = samplePolicy({ evaluatorDistinctFromGenerator: true });
    // The policy mandates evaluator ≠ generator, but the resolution omits distinctFromProvider —
    // the resolver must refuse rather than silently skip the constraint.
    expect(() => resolveModel({ role: 'evaluator', capabilities: ['coding'] }, policy)).toThrow(
      /distinct|constraint|generator|provider/i,
    );
  });

  it('surfaces the conflict when the distinct-provider constraint cannot be satisfied', () => {
    // A policy with only one provider family — the constraint is unsatisfiable.
    const anthropicOnly = samplePolicy({
      models: samplePolicy().models.filter((m) => m.provider === 'anthropic'),
    });
    expect(() =>
      resolveModel(
        { role: 'evaluator', capabilities: ['coding'], distinctFromProvider: 'anthropic' },
        anthropicOnly,
      ),
    ).toThrow(/provider|distinct|constraint|cannot satisfy/i);
  });
});

describe('model selection policy — integration with runAgent (test-plan §5)', () => {
  it('preserves today\'s effective model — an unpinned role resolves to the global fallback', () => {
    // An agent with no frontmatter override gets the global fallback, exactly as
    // `def.model ?? config.AGENT_MODEL` behaves today.
    const resolution = resolveModel({ role: 'some-agent', capabilities: [] }, samplePolicy());
    expect(resolution).toMatchObject({ model: 'sonnet', rule: 'global-fallback' });
  });

  it('lets an agent frontmatter model override win — mapped onto explicit-pin precedence', () => {
    // `model:` in an agent's frontmatter maps to an explicit pin and beats the role default.
    const resolution = resolveModel(
      { role: 'code-reviewer', capabilities: ['coding'], pin: 'opus' },
      samplePolicy(),
    );
    expect(resolution).toMatchObject({ model: 'opus', rule: 'explicit-pin' });
  });
});

describe('model selection policy — loadModelPolicy and the shipped file (test-plan §5)', () => {
  it('loadModelPolicy reads and validates the shipped policies/model-policy.json', () => {
    // Regression guard: a future hand-edit that breaks the policy file fails here, not at
    // runtime. The file is resolved relative to this test, not the cwd.
    const policyPath = fileURLToPath(new URL('../../policies/model-policy.json', import.meta.url));
    const policy = loadModelPolicy(policyPath);
    expect(policy).not.toBeNull();
    const aliases = policy!.models.map((m) => m.alias);
    expect(aliases).toEqual(expect.arrayContaining(['opus', 'sonnet', 'haiku']));
    // The global fallback is `opus` — it preserves today's config.AGENT_MODEL default —
    // and must itself be a registered model.
    expect(policy!.globalFallback).toBe('opus');
    expect(aliases).toContain(policy!.globalFallback);
  });

  it('loadModelPolicy returns null when the policy file is absent', () => {
    // A missing policy file is tolerated — callers fall back to pre-policy behavior — so
    // loadModelPolicy returns null rather than throwing.
    expect(loadModelPolicy('/tmp/jarvis-nonexistent-model-policy.json')).toBeNull();
  });
});
