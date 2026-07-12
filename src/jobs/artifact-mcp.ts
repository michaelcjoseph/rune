import { spawn, type ChildProcess } from 'node:child_process';
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import config, { PROJECT_ROOT } from '../config.js';
import { registerActiveProcess, unregisterActiveProcess } from '../ai/claude.js';
import type { SandboxSpec } from '../intent/sandbox.js';
import { getProductConfig } from './sandbox-runtime.js';

export const ARTIFACT_MCP_SERVER_NAME = 'rune-kb' as const;

export interface ArtifactMcpConfig {
  claudeArgs: string[];
  codexConfigOverrides: string[];
  sandboxProfilePath: string;
  stop: () => Promise<void>;
}

export interface BuildArtifactMcpConfigOpts {
  productsConfigPath: string;
  projectRoot?: string;
  vaultDir?: string;
  nodePath?: string;
  startupTimeoutMs?: number;
  platform?: NodeJS.Platform;
}

type StdioServerConfig = {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
};

function requireAbsoluteFile(path: string, label: string, executable = false): void {
  if (!isAbsolute(path)) throw new Error(`${label} must be an absolute path`);
  if (!existsSync(path) || !statSync(path).isFile()) {
    throw new Error(`${label} is missing: ${path}`);
  }
  accessSync(path, executable ? constants.R_OK | constants.X_OK : constants.R_OK);
}

function requireVaultDirectory(path: string): void {
  if (!isAbsolute(path)) throw new Error('VAULT_DIR must be an absolute path');
  if (!existsSync(path) || !statSync(path).isDirectory()) {
    throw new Error(`VAULT_DIR is not a directory: ${path}`);
  }
  accessSync(path, constants.R_OK | constants.X_OK);
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlArray(values: string[]): string {
  return `[${values.map(tomlString).join(',')}]`;
}

function tomlStringTable(values: Record<string, string>): string {
  return `{${Object.entries(values)
    .map(([key, value]) => `${tomlString(key)}=${tomlString(value)}`)
    .join(',')}}`;
}

function codexMcpOverride(server: StdioServerConfig): string {
  const table = [
    `command=${tomlString(server.command)}`,
    `args=${tomlArray(server.args)}`,
    `cwd=${tomlString(server.cwd)}`,
    `env=${tomlStringTable(server.env)}`,
    'required=true',
    `enabled_tools=${tomlArray(['vault_search', 'journal_range', 'follow_wikilinks'])}`,
    `default_tools_approval_mode=${tomlString('approve')}`,
    'startup_timeout_sec=10',
    'tool_timeout_sec=60',
  ].join(',');
  return `mcp_servers={${tomlString(ARTIFACT_MCP_SERVER_NAME)}={${table}}}`;
}

function seatbeltString(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

function waitForBrokerReady(child: ChildProcess, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (err?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout?.off('data', onStdout);
      child.stderr?.off('data', onStderr);
      child.off('error', onError);
      child.off('exit', onExit);
      if (!err) child.stderr?.resume();
      if (err) reject(err);
      else resolve();
    };
    const onStdout = (chunk: Buffer): void => {
      stdout += chunk.toString('utf8');
      if (stdout.includes('READY\n')) finish();
    };
    const onStderr = (chunk: Buffer): void => {
      stderr = `${stderr}${chunk.toString('utf8')}`.slice(-2_000);
    };
    const onError = (err: Error): void => finish(err);
    const onExit = (code: number | null): void => {
      finish(new Error(`read-only MCP broker exited before ready (${code ?? 'signal'}): ${stderr.trim()}`));
    };
    const timer = setTimeout(() => {
      finish(new Error(`read-only MCP broker did not become ready within ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout?.on('data', onStdout);
    child.stderr?.on('data', onStderr);
    child.once('error', onError);
    child.once('exit', onExit);
  });
}

/** Start the privileged read-only broker and return model-safe MCP config.
 * The vault path crosses only the broker's stdin; it is absent from the
 * model's argv, environment, prompt, and MCP registration. */
export async function buildArtifactMcpConfig(
  sandbox: SandboxSpec,
  opts: BuildArtifactMcpConfigOpts,
): Promise<ArtifactMcpConfig | null> {
  const product = getProductConfig(sandbox.product, opts.productsConfigPath);
  if (product.artifactMcp === undefined) return null;
  if ((opts.platform ?? process.platform) !== 'darwin') {
    throw new Error('rune-kb artifact MCP requires macOS Seatbelt');
  }

  const projectRoot = opts.projectRoot ?? PROJECT_ROOT;
  const vaultDir = opts.vaultDir ?? config.VAULT_DIR;
  const nodePath = opts.nodePath ?? process.execPath;
  const loaderPath = join(projectRoot, 'scripts', 'register-ts.mjs');
  const brokerPath = join(projectRoot, 'src', 'mcp', 'artifact-readonly.ts');
  const relayPath = join(projectRoot, 'src', 'mcp', 'artifact-readonly-relay.ts');

  if (!isAbsolute(projectRoot)) throw new Error('project root must be an absolute path');
  requireVaultDirectory(vaultDir);
  requireAbsoluteFile(nodePath, 'Node executable', true);
  requireAbsoluteFile('/usr/bin/sandbox-exec', 'Seatbelt executable', true);
  requireAbsoluteFile(loaderPath, 'TypeScript loader');
  requireAbsoluteFile(brokerPath, 'read-only MCP broker');
  requireAbsoluteFile(relayPath, 'read-only MCP relay');

  const runtimeDir = mkdtempSync(join(tmpdir(), 'rune-artifact-mcp-'));
  const socketPath = join(runtimeDir, 'broker.sock');
  const profilePath = join(runtimeDir, 'artifact.sb');
  const vaultPaths = [...new Set([vaultDir, realpathSync(vaultDir)])];
  const profilePaths = [...new Set([profilePath, join(realpathSync(runtimeDir), 'artifact.sb')])];
  writeFileSync(profilePath, [
    '(version 1)',
    '(allow default)',
    ...vaultPaths.flatMap((path) => [
      `(deny file-read* (subpath "${seatbeltString(path)}"))`,
      `(deny file-write* (subpath "${seatbeltString(path)}"))`,
    ]),
    ...profilePaths.flatMap((path) => [
      `(deny file-read* (literal "${seatbeltString(path)}"))`,
      `(deny file-write* (literal "${seatbeltString(path)}"))`,
    ]),
  ].join('\n'), { mode: 0o600 });
  chmodSync(runtimeDir, 0o700);

  const broker = spawn(nodePath, ['--import', loaderPath, brokerPath, socketPath], {
    cwd: projectRoot,
    env: {
      PATH: process.env['PATH'] ?? '',
      TELEGRAM_BOT_TOKEN: 'artifact-mcp-readonly',
      TELEGRAM_USER_ID: '0',
    },
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
  });
  registerActiveProcess(broker);
  let brokerExited = false;
  const markExited = (): void => {
    if (brokerExited) return;
    brokerExited = true;
    unregisterActiveProcess(broker);
  };
  broker.once('exit', markExited);
  broker.once('error', markExited);
  const waitForExit = (timeoutMs: number): Promise<boolean> => new Promise((resolve) => {
    if (brokerExited || broker.exitCode !== null || broker.signalCode !== null) {
      resolve(true);
      return;
    }
    const onExit = (): void => { clearTimeout(timer); resolve(true); };
    const timer = setTimeout(() => {
      broker.off('exit', onExit);
      resolve(false);
    }, timeoutMs);
    broker.once('exit', onExit);
  });
  const killGroup = (signal: NodeJS.Signals): void => {
    if (broker.pid === undefined) return;
    try { process.kill(-broker.pid, signal); } catch { /* already gone */ }
  };
  let stopPromise: Promise<void> | undefined;
  const stop = async (): Promise<void> => {
    if (stopPromise) return stopPromise;
    stopPromise = (async () => {
      if (!brokerExited && broker.exitCode === null && broker.signalCode === null) {
        killGroup('SIGTERM');
        if (!(await waitForExit(1_000))) {
          killGroup('SIGKILL');
          if (!(await waitForExit(1_000))) {
            throw new Error('read-only MCP broker did not exit after SIGKILL');
          }
        }
      }
      markExited();
      rmSync(runtimeDir, { recursive: true, force: true });
    })();
    return stopPromise;
  };

  try {
    broker.stdin?.end(`${JSON.stringify(vaultDir)}\n`);
    await waitForBrokerReady(broker, opts.startupTimeoutMs ?? 10_000);
  } catch (err) {
    await stop().catch(() => {
      // Preserve the setup failure. A broker that somehow survives SIGKILL
      // stays registered with Rune's shutdown supervisor.
    });
    throw err;
  }

  const env = {
    TELEGRAM_BOT_TOKEN: 'artifact-mcp-readonly',
    TELEGRAM_USER_ID: '0',
  };
  const server: StdioServerConfig = {
    command: nodePath,
    args: ['--import', loaderPath, relayPath, socketPath],
    cwd: projectRoot,
    env,
  };
  const inlineClaudeConfig = JSON.stringify({
    mcpServers: { [ARTIFACT_MCP_SERVER_NAME]: server },
  });
  return {
    claudeArgs: ['--strict-mcp-config', '--mcp-config', inlineClaudeConfig],
    codexConfigOverrides: [codexMcpOverride(server)],
    sandboxProfilePath: profilePath,
    stop,
  };
}
