import { describe, it, expect } from 'vitest';

/*
 * Test suite for test-plan.md §13 — multi-model dispatch, Layer 5 (08-intent-layer,
 * Phase 4).
 *
 * Written test-first. `compileToCodex` (in `agent-def.ts`) is implemented, so its 3 tests
 * are green; the dispatch core (`buildHandoff`, `recordDispatch`) is still a contract stub,
 * so the other 6 tests stay RED until the next Phase 4 task lands.
 *
 * Scope note: actually spawning a Claude or Codex executor, and the "worktree intact for
 * retry" property of a failed dispatch, are integration concerns. This suite pins the
 * deterministic core — the structured handoff, the Codex compiler target, and the log record.
 */

import { buildHandoff, recordDispatch, type DispatchHandoff } from './dispatch.js';
import { compileToClaude, compileToCodex, type NeutralAgentDef } from './agent-def.js';

// --- Fixtures ---

/** A dispatch handoff; override any field per test. */
function handoff(overrides: Partial<DispatchHandoff> = {}): DispatchHandoff {
  return {
    target: 'codex',
    agent: 'code-reviewer',
    product: 'aura',
    project: '02-growth',
    objective: 'Add seat-based pricing tiers to the pricing module.',
    context: 'The pricing module lives in src/pricing/; tiers are defined in tiers.ts.',
    ...overrides,
  };
}

/** A neutral agent definition for cross-target compilation. */
function neutralDef(): NeutralAgentDef {
  return {
    name: 'code-reviewer',
    role: 'Reviews code changes for bugs and convention violations.',
    capabilities: ['coding'],
    tools: ['Read', 'Grep'],
    constraints: ['read-only'],
    instructions: 'Review the diff and report findings by severity.',
  };
}

describe('multi-model dispatch — structured handoff (test-plan §13)', () => {
  it('builds a structured handoff carrying every field the executor needs', () => {
    const h = buildHandoff(handoff());
    expect(h).toMatchObject({
      target: 'codex',
      agent: 'code-reviewer',
      product: 'aura',
      project: '02-growth',
    });
    expect(h.objective).toBeTruthy();
    expect(h.context).toBeTruthy();
  });

  it('rejects a handoff with no explicit context — a dispatch never relies on compaction', () => {
    expect(() => buildHandoff(handoff({ context: '' }))).toThrow(/context/i);
  });

  it('rejects a handoff with no objective', () => {
    expect(() => buildHandoff(handoff({ objective: '' }))).toThrow(/objective/i);
  });

  it('builds a handoff for either target', () => {
    expect(buildHandoff(handoff({ target: 'claude' })).target).toBe('claude');
    expect(buildHandoff(handoff({ target: 'codex' })).target).toBe('codex');
  });
});

describe('multi-model dispatch — Codex compiler target (test-plan §13)', () => {
  it('compiles a neutral agent definition to the Codex target', () => {
    const out = compileToCodex(neutralDef());
    expect(out.length).toBeGreaterThan(0);
    // The neutral definition's instructions survive into the Codex output.
    expect(out).toContain('Review the diff and report findings by severity.');
  });

  it('names no model in the Codex output — model choice is the policy\'s, not the agent\'s', () => {
    expect(compileToCodex(neutralDef())).not.toMatch(/\bmodel\s*:/i);
  });
});

describe('multi-model dispatch — cross-target equivalence (test-plan §13)', () => {
  it('produces an equivalent agent on both the Claude and Codex targets', () => {
    const def = neutralDef();
    // The same neutral definition's role and instructions survive into both targets.
    for (const out of [compileToClaude(def), compileToCodex(def)]) {
      expect(out).toContain(def.role);
      expect(out).toContain(def.instructions);
    }
  });
});

describe('multi-model dispatch — dispatch log (test-plan §13)', () => {
  it('records the model and provider that executed a completed dispatch', () => {
    const entry = recordDispatch(handoff(), {
      model: 'gpt-5-codex',
      provider: 'openai',
      status: 'completed',
    });
    expect(entry).toMatchObject({
      target: 'codex',
      model: 'gpt-5-codex',
      provider: 'openai',
      status: 'completed',
    });
  });

  it('records a provider-unavailable dispatch as a clean failure with a clear reason', () => {
    const entry = recordDispatch(handoff(), {
      model: 'gpt-5-codex',
      provider: 'openai',
      status: 'failed',
      failureReason: 'openai provider unavailable',
    });
    expect(entry).toMatchObject({
      status: 'failed',
      failureReason: expect.stringMatching(/unavailable/i),
    });
  });
});
