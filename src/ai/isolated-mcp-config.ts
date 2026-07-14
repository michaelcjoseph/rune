/** Provider-equivalent strict registration for one isolated stdio MCP server. */

export interface IsolatedStdioMcpServer {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

export interface IsolatedMcpRegistrationOptions {
  serverName: string;
  server: IsolatedStdioMcpServer;
  enabledTools: readonly string[];
  startupTimeoutSec: number;
  toolTimeoutSec: number;
}

export interface IsolatedMcpRegistration {
  claudeArgs: string[];
  codexConfigOverrides: string[];
}

const tomlString = (value: string): string => JSON.stringify(value);
const tomlArray = (values: readonly string[]): string => `[${values.map(tomlString).join(',')}]`;
const tomlStringTable = (values: Record<string, string>): string =>
  `{${Object.entries(values).map(([key, value]) => `${tomlString(key)}=${tomlString(value)}`).join(',')}}`;

export function buildIsolatedMcpRegistration(
  opts: IsolatedMcpRegistrationOptions,
): IsolatedMcpRegistration {
  if (!opts.serverName.trim()) throw new Error('MCP server name is required.');
  if (opts.enabledTools.length === 0) throw new Error('Isolated MCP registration requires an explicit tool allowlist.');
  if (!opts.server.command.trim()) throw new Error('Isolated MCP server command is required.');
  if (opts.enabledTools.some(tool => !tool.trim())) throw new Error('Isolated MCP tool names must not be blank.');
  if (!Number.isFinite(opts.startupTimeoutSec) || opts.startupTimeoutSec <= 0) {
    throw new Error('Isolated MCP startup timeout must be positive and finite.');
  }
  if (!Number.isFinite(opts.toolTimeoutSec) || opts.toolTimeoutSec <= 0) {
    throw new Error('Isolated MCP tool timeout must be positive and finite.');
  }
  const inlineClaudeConfig = JSON.stringify({
    mcpServers: { [opts.serverName]: opts.server },
  });
  const codexTable = [
    `command=${tomlString(opts.server.command)}`,
    `args=${tomlArray(opts.server.args)}`,
    `cwd=${tomlString(opts.server.cwd)}`,
    `env=${tomlStringTable(opts.server.env)}`,
    'required=true',
    `enabled_tools=${tomlArray(opts.enabledTools)}`,
    `default_tools_approval_mode=${tomlString('approve')}`,
    `startup_timeout_sec=${opts.startupTimeoutSec}`,
    `tool_timeout_sec=${opts.toolTimeoutSec}`,
  ].join(',');
  return {
    claudeArgs: ['--strict-mcp-config', '--mcp-config', inlineClaudeConfig],
    codexConfigOverrides: [`mcp_servers={${tomlString(opts.serverName)}={${codexTable}}}`],
  };
}
