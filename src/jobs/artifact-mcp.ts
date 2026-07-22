import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  accessSync,
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import config, { PROJECT_ROOT } from '../config.js';
import { registerActiveProcess, unregisterActiveProcess } from '../ai/claude.js';
import {
  buildIsolatedMcpRegistration,
  type IsolatedStdioMcpServer,
} from '../ai/isolated-mcp-config.js';
import type { SandboxSpec } from '../intent/sandbox.js';
import { getProductConfig } from './sandbox-runtime.js';

export const ARTIFACT_MCP_SERVER_NAME = 'rune-kb' as const;

export interface ArtifactMcpConfig {
  claudeArgs: string[];
  codexConfigOverrides: string[];
  sandboxProfilePath: string;
  /** Provider-neutral runtime environment for the generated outer sandbox. */
  runtimeEnv: Record<string, string>;
  /** Codex-only auth/runtime environment. Omitted for Claude-format artifact sessions. */
  codexEnv?: Record<string, string>;
  /** Live relay → broker MCP initialize/tools-list handshake. This is invoked
   * by executor preflight before the environment is accepted. */
  verifyRegistration: () => Promise<void>;
  stop: () => Promise<void>;
}

export interface BuildArtifactMcpConfigOpts {
  productsConfigPath: string;
  projectRoot?: string;
  vaultDir?: string;
  nodePath?: string;
  startupTimeoutMs?: number;
  platform?: NodeJS.Platform;
  executor?: 'claude' | 'codex';
  homeDir?: string;
  /** Source Codex home used only to seed auth into the private runtime home. */
  codexHome?: string;
}

function requireAbsoluteFile(path: string, label: string, executable = false): void {
  if (!isAbsolute(path)) throw new Error(`${label} must be an absolute path`);
  if (!existsSync(path) || !statSync(path).isFile()) {
    throw new Error(`${label} is missing: ${path}`);
  }
  accessSync(path, executable ? constants.R_OK | constants.X_OK : constants.R_OK);
}

function requireAbsoluteDirectory(path: string, label: string, accessMask: number): void {
  if (!isAbsolute(path)) throw new Error(`${label} must be an absolute path`);
  if (!existsSync(path) || !statSync(path).isDirectory()) {
    throw new Error(`${label} is not a directory: ${path}`);
  }
  accessSync(path, accessMask);
}

function requireVaultDirectory(path: string): void {
  requireAbsoluteDirectory(path, 'VAULT_DIR', constants.R_OK | constants.X_OK);
}

function requireWorktreeDirectory(path: string): void {
  requireAbsoluteDirectory(
    path,
    'artifact worktree',
    constants.R_OK | constants.W_OK | constants.X_OK,
  );
}

function seedPrivateCodexHome(runtimeDir: string, sourceHome: string): string {
  if (!isAbsolute(sourceHome) || !existsSync(sourceHome) || !statSync(sourceHome).isDirectory()) {
    throw new Error(`Codex home is not a directory: ${sourceHome}`);
  }
  const authSource = join(sourceHome, 'auth.json');
  requireAbsoluteFile(authSource, 'Codex auth file');
  const privateHome = join(runtimeDir, 'codex-home');
  mkdirSync(privateHome, { mode: 0o700 });
  const authTarget = join(privateHome, 'auth.json');
  copyFileSync(authSource, authTarget);
  chmodSync(authTarget, 0o600);
  return privateHome;
}

function seatbeltString(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

function existingSensitiveSubpaths(homeDir: string, sourceCodexHome?: string): string[] {
  const candidates = [
    sourceCodexHome,
    join(homeDir, '.codex'),
    join(homeDir, '.claude'),
    join(homeDir, '.ssh'),
    join(homeDir, '.aws'),
    join(homeDir, '.config'),
    join(homeDir, '.gnupg'),
  ].filter((value): value is string => value !== undefined && value !== '');
  return [...new Set(candidates
    .filter((path) => isAbsolute(path) && existsSync(path))
    .flatMap((path) => [path, realpathSync(path)]))];
}

function sensitiveLiterals(paths: readonly string[]): string[] {
  const filenames = ['.env', '.env.local', '.env.production', '.npmrc', '.netrc'];
  return [...new Set(paths.flatMap((base) => filenames.map((name) => join(base, name)))
    .filter((path) => isAbsolute(path) && existsSync(path))
    .flatMap((path) => [path, realpathSync(path)]))];
}

function preflightArtifactSandbox(
  profilePath: string,
  worktree: string,
  runtimeDir: string,
): void {
  const probePath = join(worktree, `.rune-artifact-preflight-${randomUUID()}`);
  const args = [
    '-f', profilePath,
    '/bin/sh', '-c',
    'pwd >/dev/null\n: > "$1"\nrm -f "$1"',
    'sh', probePath,
  ];
  try {
    const probe = spawnSync('/usr/bin/sandbox-exec', args, {
      cwd: worktree,
      env: { PATH: '/usr/bin:/bin', TMPDIR: runtimeDir },
      encoding: 'utf8',
      timeout: 5_000,
    });
    if (probe.status !== 0 || probe.error) {
      throw new Error('artifact sandbox preflight failed: shell startup or worktree write denied');
    }
  } finally {
    // If the profile or shell fails after creating the probe but before its
    // in-sandbox rm, the operator process still restores the worktree.
    rmSync(probePath, { force: true });
  }
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

const ARTIFACT_TOOL_NAMES = ['vault_search', 'journal_range', 'follow_wikilinks'] as const;

function verifyRelayRegistration(opts: {
  nodePath: string;
  loaderPath: string;
  relayPath: string;
  socketPath: string;
  profilePath: string;
  projectRoot: string;
  runtimeDir: string;
  timeoutMs: number;
}): Promise<void> {
  return new Promise((resolve, reject) => {
    const relay = spawn('/usr/bin/sandbox-exec', [
      '-f', opts.profilePath,
      opts.nodePath, '--import', opts.loaderPath, opts.relayPath, opts.socketPath,
    ], {
      cwd: opts.projectRoot,
      env: { TMPDIR: opts.runtimeDir },
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    registerActiveProcess(relay);
    let stdout = '';
    let terminalError: Error | null = null;
    let stopping = false;
    let killTimer: NodeJS.Timeout | undefined;
    let timeout: NodeJS.Timeout;

    const killGroup = (signal: NodeJS.Signals): void => {
      if (relay.pid === undefined) return;
      try { process.kill(-relay.pid, signal); } catch { /* already exited */ }
    };
    const stop = (err: Error | null): void => {
      if (stopping) return;
      stopping = true;
      terminalError = err;
      clearTimeout(timeout);
      relay.stdin?.end();
      killGroup('SIGTERM');
      killTimer = setTimeout(() => killGroup('SIGKILL'), 1_000);
      killTimer.unref();
    };
    const fail = (): void => stop(new Error('artifact MCP relay registration handshake failed'));

    const send = (message: Record<string, unknown>): void => {
      relay.stdin?.write(`${JSON.stringify(message)}\n`);
    };
    const handleLine = (line: string): void => {
      if (!line.trim() || stopping) return;
      let response: Record<string, unknown>;
      try { response = JSON.parse(line) as Record<string, unknown>; } catch { fail(); return; }
      if (response['id'] === 1 && response['result'] && typeof response['result'] === 'object') {
        send({ jsonrpc: '2.0', method: 'notifications/initialized' });
        send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
        return;
      }
      if (response['id'] !== 2) return;
      const result = response['result'];
      const tools = result && typeof result === 'object'
        ? (result as Record<string, unknown>)['tools']
        : undefined;
      if (!Array.isArray(tools)) { fail(); return; }
      const names = tools.map((tool) => tool && typeof tool === 'object'
        ? (tool as Record<string, unknown>)['name']
        : undefined).filter((name): name is string => typeof name === 'string').sort();
      const expected = [...ARTIFACT_TOOL_NAMES].sort();
      if (JSON.stringify(names) !== JSON.stringify(expected)) { fail(); return; }
      stop(null);
    };

    relay.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      let newline = stdout.indexOf('\n');
      while (newline !== -1) {
        const line = stdout.slice(0, newline).replace(/\r$/, '');
        stdout = stdout.slice(newline + 1);
        handleLine(line);
        newline = stdout.indexOf('\n');
      }
    });
    relay.stderr?.resume();
    relay.once('error', fail);
    relay.once('close', () => {
      clearTimeout(timeout);
      if (killTimer !== undefined) clearTimeout(killTimer);
      unregisterActiveProcess(relay);
      if (!stopping) {
        reject(new Error('artifact MCP relay registration handshake failed'));
      } else if (terminalError !== null) {
        reject(terminalError);
      } else {
        resolve();
      }
    });
    timeout = setTimeout(fail, opts.timeoutMs);
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'rune-executor-preflight', version: '1' },
      },
    });
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
  requireWorktreeDirectory(sandbox.worktree);
  requireAbsoluteFile(nodePath, 'Node executable', true);
  requireAbsoluteFile('/usr/bin/sandbox-exec', 'Seatbelt executable', true);
  requireAbsoluteFile(loaderPath, 'TypeScript loader');
  requireAbsoluteFile(brokerPath, 'read-only MCP broker');
  requireAbsoluteFile(relayPath, 'read-only MCP relay');

  const runtimeDir = mkdtempSync(join(tmpdir(), 'rune-artifact-mcp-'));
  const socketPath = join(runtimeDir, 'broker.sock');
  const profilePath = join(runtimeDir, 'artifact.sb');
  const executor = opts.executor ?? 'codex';
  const homeDir = opts.homeDir ?? homedir();
  const sourceCodexHome = executor === 'codex'
    ? opts.codexHome ?? process.env['CODEX_HOME'] ?? join(homeDir, '.codex')
    : undefined;
  const vaultPaths = [...new Set([vaultDir, realpathSync(vaultDir)])];
  const worktreePaths = [...new Set([sandbox.worktree, realpathSync(sandbox.worktree)])];
  const runtimePaths = [...new Set([runtimeDir, realpathSync(runtimeDir)])];
  const profilePaths = [...new Set([profilePath, join(realpathSync(runtimeDir), 'artifact.sb')])];
  const deniedSensitiveSubpaths = existingSensitiveSubpaths(homeDir, sourceCodexHome);
  const deniedSensitiveLiterals = sensitiveLiterals([projectRoot, sandbox.worktree, homeDir]);
  const runtimeEnv: Record<string, string> = { TMPDIR: runtimeDir };
  let codexEnv: Record<string, string> | undefined;
  try {
    if (executor === 'codex') {
      const privateCodexHome = seedPrivateCodexHome(runtimeDir, sourceCodexHome!);
      codexEnv = { HOME: runtimeDir, CODEX_HOME: privateCodexHome };
    }
    writeFileSync(profilePath, [
      '(version 1)',
      '(allow default)',
      '(deny file-write*)',
      ...worktreePaths.map((path) =>
        `(allow file-write* (subpath "${seatbeltString(path)}"))`),
      ...runtimePaths.map((path) =>
        `(allow file-write* (subpath "${seatbeltString(path)}"))`),
      '(allow file-write* (subpath "/dev"))',
      // The relay is the only sanctioned local vault transport. Provider
      // internet remains available for the model CLI, but raw local TCP
      // access to Rune/daemon surfaces is denied.
      '(deny network-outbound (remote ip "localhost:*"))',
      `(allow network-outbound (remote unix-socket (path "${seatbeltString(socketPath)}")))`,
      ...deniedSensitiveSubpaths.map((path) =>
        `(deny file-read* (subpath "${seatbeltString(path)}"))`),
      ...deniedSensitiveLiterals.map((path) =>
        `(deny file-read* (literal "${seatbeltString(path)}"))`),
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
    preflightArtifactSandbox(profilePath, sandbox.worktree, runtimeDir);
  } catch (err) {
    rmSync(runtimeDir, { recursive: true, force: true });
    throw err;
  }

  const broker = spawn(nodePath, ['--import', loaderPath, brokerPath, socketPath], {
    cwd: projectRoot,
    env: {},
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

  const env = {};
  const server: IsolatedStdioMcpServer = {
    command: nodePath,
    args: ['--import', loaderPath, relayPath, socketPath],
    cwd: projectRoot,
    env,
  };
  const registration = buildIsolatedMcpRegistration({
    serverName: ARTIFACT_MCP_SERVER_NAME,
    server,
    enabledTools: ['vault_search', 'journal_range', 'follow_wikilinks'],
    startupTimeoutSec: 10,
    toolTimeoutSec: 60,
  });
  return {
    ...registration,
    codexConfigOverrides: [
      ...registration.codexConfigOverrides,
      // The Codex CLI itself needs CODEX_HOME to read the copied auth.json,
      // but model-generated shell commands do not. Keep tool subprocesses
      // from inheriting HOME/CODEX_HOME or scoped credentials from the CLI
      // environment while preserving the explicit MCP server env table above.
      'shell_environment_policy.inherit="none"',
    ],
    sandboxProfilePath: profilePath,
    runtimeEnv,
    ...(codexEnv !== undefined ? { codexEnv } : {}),
    verifyRegistration: () => verifyRelayRegistration({
      nodePath,
      loaderPath,
      relayPath,
      socketPath,
      profilePath,
      projectRoot,
      runtimeDir,
      timeoutMs: opts.startupTimeoutMs ?? 10_000,
    }),
    stop,
  };
}
