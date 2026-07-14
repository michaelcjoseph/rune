import { describe, expect, it } from 'vitest';
import { buildIsolatedMcpRegistration } from './isolated-mcp-config.js';

describe('buildIsolatedMcpRegistration', () => {
  it('builds provider-equivalent strict configs from one typed registration', () => {
    const result = buildIsolatedMcpRegistration({
      serverName: 'read-only',
      server: {
        command: '/usr/bin/node',
        args: ['entry.ts', 'value with spaces'],
        cwd: '/repo',
        env: { SAFE_SCOPE: 'assay' },
      },
      enabledTools: ['inspect'],
      startupTimeoutSec: 10,
      toolTimeoutSec: 60,
    });

    expect(JSON.parse(result.claudeArgs[2]!)).toEqual({
      mcpServers: {
        'read-only': {
          command: '/usr/bin/node',
          args: ['entry.ts', 'value with spaces'],
          cwd: '/repo',
          env: { SAFE_SCOPE: 'assay' },
        },
      },
    });
    expect(result.codexConfigOverrides).toEqual([
      'mcp_servers={"read-only"={command="/usr/bin/node",args=["entry.ts","value with spaces"],cwd="/repo",env={"SAFE_SCOPE"="assay"},required=true,enabled_tools=["inspect"],default_tools_approval_mode="approve",startup_timeout_sec=10,tool_timeout_sec=60}}',
    ]);
  });

  it('rejects an empty allowlist', () => {
    expect(() => buildIsolatedMcpRegistration({
      serverName: 'read-only',
      server: { command: 'node', args: [], cwd: '/repo', env: {} },
      enabledTools: [],
      startupTimeoutSec: 10,
      toolTimeoutSec: 60,
    })).toThrow(/allowlist/i);
  });

  it.each([
    [{ command: ' ', enabledTools: ['inspect'], startupTimeoutSec: 10, toolTimeoutSec: 60 }, /command/i],
    [{ command: 'node', enabledTools: [' '], startupTimeoutSec: 10, toolTimeoutSec: 60 }, /tool names/i],
    [{ command: 'node', enabledTools: ['inspect'], startupTimeoutSec: 0, toolTimeoutSec: 60 }, /startup timeout/i],
    [{ command: 'node', enabledTools: ['inspect'], startupTimeoutSec: 10, toolTimeoutSec: Infinity }, /tool timeout/i],
  ])('rejects invalid registration fields', (invalid, message) => {
    expect(() => buildIsolatedMcpRegistration({
      serverName: 'read-only',
      server: { command: invalid.command, args: [], cwd: '/repo', env: {} },
      enabledTools: invalid.enabledTools,
      startupTimeoutSec: invalid.startupTimeoutSec,
      toolTimeoutSec: invalid.toolTimeoutSec,
    })).toThrow(message);
  });
});
