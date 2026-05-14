import { describe, it, expect, vi } from 'vitest';

vi.mock('../config.js', () => ({
  default: {
    VAULT_DIR: '/test/vault',
    WORKSPACE_DIR: '/test/workspace',
  },
  PROJECT_ROOT: '/test/project',
}));

const { formatToolUse } = await import('./tool-labels.js');

describe('formatToolUse', () => {
  it('formats Read with a vault-relative path', () => {
    expect(formatToolUse('Read', { file_path: '/test/vault/knowledge/index.md' }))
      .toBe('Read: knowledge/index.md');
  });

  it('formats Read with a workspace-relative path', () => {
    expect(formatToolUse('Read', { file_path: '/test/workspace/foo/bar.ts' }))
      .toBe('Read: foo/bar.ts');
  });

  it('formats Read with a project-relative path', () => {
    expect(formatToolUse('Read', { file_path: '/test/project/src/foo.ts' }))
      .toBe('Read: src/foo.ts');
  });

  it('leaves a foreign absolute path unchanged', () => {
    expect(formatToolUse('Read', { file_path: '/etc/hosts' })).toBe('Read: /etc/hosts');
  });

  it('formats Edit and Write the same way as Read', () => {
    expect(formatToolUse('Edit', { file_path: '/test/vault/x.md' })).toBe('Edit: x.md');
    expect(formatToolUse('Write', { file_path: '/test/vault/x.md' })).toBe('Write: x.md');
  });

  it('formats Grep and Glob with their pattern', () => {
    expect(formatToolUse('Grep', { pattern: 'capital markets' })).toBe('Grep: capital markets');
    expect(formatToolUse('Glob', { pattern: 'projects/**/*.md' })).toBe('Glob: projects/**/*.md');
  });

  it('formats WebSearch and WebFetch', () => {
    expect(formatToolUse('WebSearch', { query: 'recent EU policy' }))
      .toBe('WebSearch: recent EU policy');
    expect(formatToolUse('WebFetch', { url: 'https://www.nytimes.com/2026/05/article' }))
      .toBe('WebFetch: www.nytimes.com');
  });

  it('falls back to raw URL when WebFetch URL is malformed', () => {
    expect(formatToolUse('WebFetch', { url: 'not-a-url' })).toBe('WebFetch: not-a-url');
  });

  it('formats Bash with the command', () => {
    expect(formatToolUse('Bash', { command: 'ls -la' })).toBe('Bash: ls -la');
  });

  it('formats jarvis-kb MCP tools with friendly prefixes', () => {
    expect(formatToolUse('mcp__jarvis-kb__kb_query', { query: 'capital flows' }))
      .toBe('KB query: capital flows');
    expect(formatToolUse('mcp__jarvis-kb__kb_search', { query: 'X' })).toBe('KB search: X');
    expect(formatToolUse('mcp__jarvis-kb__kb_stats', {})).toBe('KB stats');
    expect(formatToolUse('mcp__jarvis-kb__kb_lint', {})).toBe('KB lint');
  });

  it('formats other MCP tools with a generic MCP prefix', () => {
    expect(formatToolUse('mcp__linear__list_issues', {})).toBe('MCP: linear__list_issues');
  });

  it('formats Task agent invocation', () => {
    expect(formatToolUse('Task', { subagent_type: 'kb-query', description: 'find X' }))
      .toBe('Agent: kb-query');
  });

  it('truncates long detail strings', () => {
    const longQuery = 'a'.repeat(200);
    const out = formatToolUse('WebSearch', { query: longQuery });
    expect(out.length).toBeLessThanOrEqual(80);
    expect(out.endsWith('…')).toBe(true);
  });

  it('falls back to JSON preview for unknown tools', () => {
    expect(formatToolUse('SomeUnknownTool', { foo: 'bar' }))
      .toBe('SomeUnknownTool: {"foo":"bar"}');
  });
});
