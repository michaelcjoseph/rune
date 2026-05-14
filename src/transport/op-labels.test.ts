import { describe, it, expect } from 'vitest';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { formatOpLabel } from './op-labels.js';

describe('formatOpLabel', () => {
  it('maps a known agent name to its friendly phrase', () => {
    expect(formatOpLabel('agent', 'wiki-compiler', 'wiki-compiler')).toBe('Compiling wiki entry');
    expect(formatOpLabel('agent', 'kb-query', 'kb-query')).toBe('Querying knowledge base');
    expect(formatOpLabel('agent', 'wiki-linter', 'wiki-linter')).toBe('Checking knowledge base');
  });

  it('titlecases an unknown agent name', () => {
    expect(formatOpLabel('agent', 'unknown-agent', 'unknown-agent')).toBe('Unknown Agent');
    expect(formatOpLabel('agent', 'my_custom_agent', 'my_custom_agent')).toBe('My Custom Agent');
  });

  it('maps a known call label to its friendly phrase', () => {
    expect(formatOpLabel('chat', 'chat')).toBe('Asking Claude');
    expect(formatOpLabel('one-shot', 'ask')).toBe('Asking Claude');
    expect(formatOpLabel('chat', 'review:weekly')).toBe('Weekly review');
    expect(formatOpLabel('chat', 'review:health')).toBe('Health session');
    expect(formatOpLabel('one-shot', 'review:daily-routing')).toBe('Choosing daily review updates');
  });

  it('titlecases an unknown call label', () => {
    expect(formatOpLabel('chat', 'custom:label')).toBe('Custom Label');
    expect(formatOpLabel('one-shot', 'foobar')).toBe('Foobar');
  });

  it('falls back to call-label mapping when opKind is agent but agentName is absent', () => {
    // Defensive: in practice runAgent always sets both, but if it didn't,
    // the raw label still goes through the call-label path.
    expect(formatOpLabel('agent', 'chat')).toBe('Asking Claude');
    expect(formatOpLabel('agent', 'unmapped')).toBe('Unmapped');
  });

  // Regression guard — every agent file shipped in jarvis's own
  // .claude/agents/ should have a curated friendly phrase, not just a
  // titleCase fallback. Vault-resident agents (journal-scanner, etc.) and
  // dev-tooling agents (test-specialist, etc.) live elsewhere so they're not
  // filesystem-discoverable from here and are listed manually in op-labels.
  it('every Jarvis-resident agent has a curated entry in AGENT_LABELS', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const agentsDir = join(here, '..', '..', '.claude', 'agents');
    const agents = readdirSync(agentsDir)
      .filter(f => f.endsWith('.md'))
      .map(f => f.replace(/\.md$/, ''));

    expect(agents.length).toBeGreaterThan(0);

    const missing: string[] = [];
    for (const agent of agents) {
      const friendly = formatOpLabel('agent', agent, agent);
      // titleCase yields a space-separated capitalized version of the slug.
      // Equality with that fallback means there's no curated entry.
      const fallback = agent
        .split(/[-_:]/)
        .filter(Boolean)
        .map(p => p.charAt(0).toUpperCase() + p.slice(1))
        .join(' ');
      if (friendly === fallback) missing.push(agent);
    }

    expect(missing).toEqual([]);
  });
});
