import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/*
 * Test suite for test-plan.md §4 — model-agnostic agent definitions (08-intent-layer,
 * Phase 1).
 *
 * Written test-first; `src/intent/agent-def.ts` now implements `parseClaudeAgent` and
 * `compileToClaude`, so the suite is green. `compileToCodex` / `compileToGemini` throw
 * their "deferred to Phase 4" error until the Codex/Gemini targets are built in Phase 4 —
 * asserted by the deferred-targets test.
 */

import {
  parseClaudeAgent,
  compileToClaude,
  compileToCodex,
  compileToGemini,
  type NeutralAgentDef,
} from './agent-def.js';

// --- Fixtures ---

/** A representative `.claude/agents/*.md` file: YAML frontmatter + markdown body. */
const SAMPLE_AGENT = `---
name: sample-reviewer
description: Reviews things for issues.
model: sonnet
tools:
  - Read
  - Grep
---

You are the sample reviewer. You are read-only — you report findings, never modify files.
`;

/** A complete neutral definition literal. */
function neutralDef(overrides: Partial<NeutralAgentDef> = {}): NeutralAgentDef {
  return {
    name: 'sample-reviewer',
    role: 'Reviews things for issues.',
    capabilities: ['coding'],
    tools: ['Read', 'Grep'],
    constraints: ['read-only'],
    instructions: 'You are the sample reviewer. You are read-only — you report findings, never modify files.',
    ...overrides,
  };
}

/** The real Claude agents directory — resolved relative to this file, not the cwd. */
const AGENTS_DIR = fileURLToPath(new URL('../../.claude/agents', import.meta.url));

describe('model-agnostic agent definitions — neutral format (test-plan §4)', () => {
  it('the neutral format captures role, tools, constraints, and declared capabilities', () => {
    const def = parseClaudeAgent(SAMPLE_AGENT);
    expect(def.role).toBe('Reviews things for issues.');
    expect(def.tools).toEqual(['Read', 'Grep']);
    // Real agents carry no `capabilities:` / `constraints:` frontmatter — the parser must
    // default both to [], never undefined.
    expect(Array.isArray(def.capabilities)).toBe(true);
    expect(Array.isArray(def.constraints)).toBe(true);
  });

  it('a neutral definition names no model — model choice is left to the policy (§5)', () => {
    // SAMPLE_AGENT has `model: sonnet`; parsing must drop it.
    const def = parseClaudeAgent(SAMPLE_AGENT);
    expect(def).not.toHaveProperty('model');
  });

  it('the compiled Claude agent carries no hardcoded model line', () => {
    const compiled = compileToClaude(neutralDef());
    expect(compiled).not.toMatch(/^model:/m);
  });
});

describe('model-agnostic agent definitions — Claude compiler (test-plan §4)', () => {
  it('compiles a neutral definition to valid Claude frontmatter (name, description, tools)', () => {
    const compiled = compileToClaude(neutralDef());
    expect(compiled).toMatch(/^name:\s*sample-reviewer$/m);
    // The neutral field is `role`; Claude's frontmatter key is `description` — the
    // compiler must map between them.
    expect(compiled).toMatch(/^description:\s*Reviews things for issues\./m);
    expect(compiled).toMatch(/Read/);
    expect(compiled).toMatch(/Grep/);
  });

  it('round-trips a representative agent — parse → compile → parse is idempotent', () => {
    const once = parseClaudeAgent(SAMPLE_AGENT);
    const twice = parseClaudeAgent(compileToClaude(once));
    expect(twice).toEqual(once);
  });

  it('preserves frontmatter outside the neutral format (e.g. cron) across a round-trip', () => {
    const withCron = SAMPLE_AGENT.replace('model: sonnet\n', 'model: sonnet\ncron: "0 20 * * 6"\n');
    const once = parseClaudeAgent(withCron);
    expect(once.extraFrontmatter?.['cron']).toBe('0 20 * * 6');
    const twice = parseClaudeAgent(compileToClaude(once));
    expect(twice).toEqual(once);
  });

  it('reproduces every existing .claude/agents/*.md with no behavior change', () => {
    const files = readdirSync(AGENTS_DIR).filter((f) => f.endsWith('.md'));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const markdown = readFileSync(join(AGENTS_DIR, file), 'utf8');
      const once = parseClaudeAgent(markdown);
      const twice = parseClaudeAgent(compileToClaude(once));
      // The behaviorally-significant fields survive the round-trip unchanged.
      expect(twice, `agent ${file} must round-trip unchanged`).toEqual(once);
    }
  });

  it('fails compilation with a clear error naming a missing required field', () => {
    // name / role / instructions are the required non-empty fields; tools, capabilities,
    // and constraints may legitimately be empty arrays (many agents declare no tools).
    for (const field of ['name', 'role', 'instructions'] as const) {
      const broken = neutralDef({ [field]: '' });
      expect(() => compileToClaude(broken)).toThrow(new RegExp(field, 'i'));
    }
  });
});

describe('model-agnostic agent definitions — deferred targets (test-plan §4)', () => {
  // NOTE: when the Phase 4 Layer-5 task implements `compileToCodex`, drop the `compileToCodex`
  // assertion below (keep `compileToGemini` — Gemini stays deferred). `dispatch.test.ts`
  // (test-plan §13) pins `compileToCodex`'s implemented behavior.
  it('the Codex and Gemini compiler targets are deferred to Phase 4', () => {
    expect(() => compileToCodex(neutralDef())).toThrow(/deferred|phase 4/i);
    expect(() => compileToGemini(neutralDef())).toThrow(/deferred|phase 4/i);
  });
});
