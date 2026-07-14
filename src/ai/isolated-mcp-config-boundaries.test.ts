import { describe, expect, it } from 'vitest';
import { buildIsolatedMcpRegistration } from './isolated-mcp-config.js';

describe('isolated MCP config encoding boundaries', () => {
  it('escapes provider config metacharacters identically without widening the allowlist', () => {
    const result = buildIsolatedMcpRegistration({
      serverName: 'quoted"server',
      server: {
        command: '/path/with space/node',
        args: ['quote"arg', 'back\\slash', 'line\nbreak'],
        cwd: '/repo with space',
        env: { 'KEY"NAME': 'value\\with\ncontrols' },
      },
      enabledTools: ['tool"one', 'tool\\two'],
      startupTimeoutSec: 7,
      toolTimeoutSec: 11,
    });

    expect(JSON.parse(result.claudeArgs[2]!)).toEqual({
      mcpServers: {
        'quoted"server': {
          command: '/path/with space/node',
          args: ['quote"arg', 'back\\slash', 'line\nbreak'],
          cwd: '/repo with space',
          env: { 'KEY"NAME': 'value\\with\ncontrols' },
        },
      },
    });
    expect(result.codexConfigOverrides).toEqual([
      'mcp_servers={"quoted\\"server"={command="/path/with space/node",args=["quote\\"arg","back\\\\slash","line\\nbreak"],cwd="/repo with space",env={"KEY\\"NAME"="value\\\\with\\ncontrols"},required=true,enabled_tools=["tool\\"one","tool\\\\two"],default_tools_approval_mode="approve",startup_timeout_sec=7,tool_timeout_sec=11}}',
    ]);
  });

  it('rejects an empty server name before emitting either provider config', () => {
    expect(() => buildIsolatedMcpRegistration({
      serverName: '   ',
      server: { command: 'node', args: [], cwd: '/repo', env: {} },
      enabledTools: ['inspect'],
      startupTimeoutSec: 10,
      toolTimeoutSec: 60,
    })).toThrow(/server name/i);
  });
});
