/** Run-scoped executor prerequisite gate for automated product-team work. */

import { access, mkdtemp, rm, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CLAUDE_BIN,
  probeClaudeAuthentication,
  probeClaudeModelCall,
} from '../ai/claude.js';
import {
  getCodexBin,
  probeCodexAuthentication,
  probeCodexModelCall,
} from '../ai/codex.js';
import type { AiExecutorProbeFailureCode, AiExecutorProbeResult } from '../ai/bounded-process.js';
import { scrubPathsInText } from '../ai/tool-labels.js';
import type {
  ExecutionPreflightFailure,
  ExecutionPreflightFormat,
  ExecutionPreflightPrerequisite,
  ExecutionPreflightResult,
  ExecutionPreflightRole,
  ExecutionPreflightSuccess,
} from '../intent/execution-preflight.js';
import type { SandboxSpec } from '../intent/sandbox.js';
import { scrubAbsolutePaths } from '../utils/sanitize-paths.js';
import { redactSecrets } from '../utils/redact-secrets.js';
import { buildArtifactMcpConfig, type ArtifactMcpConfig } from './artifact-mcp.js';
import { buildSandboxEnv } from './credential-injector.js';
import type { RoleModelBinding } from './execution-agent.js';

export type {
  ExecutionPreflightFailure,
  ExecutionPreflightPrerequisite,
  ExecutionPreflightResult,
  ExecutionPreflightSuccess,
} from '../intent/execution-preflight.js';

export interface ExecutionPreflightRoleModels {
  pm: RoleModelBinding;
  techLead: RoleModelBinding;
  qa: RoleModelBinding;
  coder: RoleModelBinding;
  reviewer: RoleModelBinding | null;
  designer: RoleModelBinding;
}

interface ProbeResult {
  ok: boolean;
  code?: AiExecutorProbeFailureCode;
  diagnostic?: string;
}

export interface ExecutionPreflightIO {
  resolveBinary: (format: ExecutionPreflightFormat) => Promise<
    | { ok: true; path: string }
    | { ok: false; diagnostic: string }
  >;
  buildEnv: (
    sandbox: SandboxSpec,
    opts: { productsConfigPath: string },
  ) => NodeJS.ProcessEnv;
  checkAuthentication: (
    format: ExecutionPreflightFormat,
    binary: string,
    env: NodeJS.ProcessEnv,
    sandboxProfilePath?: string,
  ) => Promise<ProbeResult>;
  probeModel: (
    binding: RoleModelBinding,
    binary: string,
    env: NodeJS.ProcessEnv,
  ) => Promise<ProbeResult>;
  buildArtifactMcp: (
    sandbox: SandboxSpec,
    opts: { productsConfigPath: string; executor: ExecutionPreflightFormat },
  ) => Promise<ArtifactMcpConfig | null> | ArtifactMcpConfig | null;
}

export interface PreflightExecutionArgs {
  models: ExecutionPreflightRoleModels;
  sandbox: SandboxSpec;
  productsConfigPath: string;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
export const PREFLIGHT_FIELD_MAX_CHARS = 600;
const MODEL_LIST_MAX_CHARS = 300;

function makeDefaultIo(timeoutMs: number): ExecutionPreflightIO {
  return {
    resolveBinary: async (format) => {
      try {
        const path = format === 'claude' ? CLAUDE_BIN : getCodexBin();
        const info = await stat(path);
        if (!info.isFile()) return { ok: false, diagnostic: `${format} CLI is not a file` };
        await access(path, constants.X_OK);
        return { ok: true, path };
      } catch {
        return { ok: false, diagnostic: `${format} CLI is missing or not executable` };
      }
    },
    buildEnv: buildSandboxEnv,
    checkAuthentication: async (format, binary, env, sandboxProfilePath) => {
      const opts = {
        binaryPath: binary,
        cwd: tmpdir(),
        env,
        timeoutMs,
        ...(sandboxProfilePath !== undefined ? { sandboxProfilePath } : {}),
      };
      return format === 'claude'
        ? probeClaudeAuthentication(opts)
        : probeCodexAuthentication(opts);
    },
    probeModel: async (binding, binary, env) => {
      const probeCwd = await mkdtemp(join(tmpdir(), 'rune-executor-preflight-'));
      try {
        const opts = {
          binaryPath: binary,
          cwd: probeCwd,
          env,
          timeoutMs,
          model: binding.alias,
        };
        return binding.format === 'claude'
          ? probeClaudeModelCall(opts)
          : probeCodexModelCall(opts);
      } finally {
        await rm(probeCwd, { recursive: true, force: true });
      }
    },
    buildArtifactMcp: buildArtifactMcpConfig,
  };
}

/** Fail closed on the first unmet prerequisite. Successful callers may cache
 * the result for the lifetime of one production workflow-runner closure. */
export async function preflightExecution(
  args: PreflightExecutionArgs,
  ioOverrides: Partial<ExecutionPreflightIO> = {},
): Promise<ExecutionPreflightResult> {
  const io: ExecutionPreflightIO = {
    ...makeDefaultIo(args.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    ...ioOverrides,
  };
  const bindings = groupBindings(args.models);
  const executors = groupExecutors(bindings);
  const binaries = new Map<ExecutionPreflightFormat, string>();
  let fullEnv: NodeJS.ProcessEnv;
  try {
    fullEnv = io.buildEnv(args.sandbox, { productsConfigPath: args.productsConfigPath });
  } catch {
    return failure(executors[0]!, 'authentication', 'executor environment could not be prepared');
  }
  const executorEnvs = new Map<ExecutionPreflightFormat, NodeJS.ProcessEnv>();

  for (const executor of executors) {
    let binary: Awaited<ReturnType<ExecutionPreflightIO['resolveBinary']>>;
    try {
      binary = await io.resolveBinary(executor.format);
    } catch {
      binary = { ok: false, diagnostic: `${executor.format} CLI resolution failed` };
    }
    if (!binary.ok) return failure(executor, 'binary', binary.diagnostic);
    binaries.set(executor.format, binary.path);

    const env = providerProbeEnv(fullEnv, executor.format);
    executorEnvs.set(executor.format, env);
    const auth = await safeProbe(
      () => io.checkAuthentication(executor.format, binary.path, env),
      'authentication probe failed unexpectedly',
    );
    if (!auth.ok) return failure(executor, 'authentication', probeDiagnostic(executor.format, auth));
  }

  for (const binding of bindings) {
    const probe = await safeProbe(
      () => io.probeModel(
        binding.binding,
        binaries.get(binding.format)!,
        executorEnvs.get(binding.format)!,
      ),
      'exact-model probe failed unexpectedly',
    );
    if (!probe.ok) return failure(binding, 'model-call', probeDiagnostic(binding.format, probe));
  }

  const artifactGroups = artifactExecutorGroups(bindings);
  const artifactFormats: ExecutionPreflightFormat[] = [];
  let artifactMcp: ExecutionPreflightSuccess['artifactMcp'] = 'not-required';
  for (const group of artifactGroups) {
    const scratch = await mkdtemp(join(tmpdir(), 'rune-artifact-preflight-'));
    const scratchSandbox = { ...args.sandbox, worktree: scratch };
    let config: ArtifactMcpConfig | null = null;
    try {
      config = await io.buildArtifactMcp(scratchSandbox, {
        productsConfigPath: args.productsConfigPath,
        executor: group.format,
      });
      if (config === null) break;
      const artifactEnv = buildArtifactProbeEnv(
        executorEnvs.get(group.format)!,
        config,
        group.format,
      );
      const auth = await safeProbe(
        () => io.checkAuthentication(
          group.format,
          binaries.get(group.format)!,
          artifactEnv,
          config!.sandboxProfilePath,
        ),
        'artifact executor authentication probe failed unexpectedly',
      );
      if (!auth.ok) {
        return failure(group, 'artifact-mcp', probeDiagnostic(group.format, auth));
      }
      await config.verifyRegistration();
      artifactMcp = 'validated';
      artifactFormats.push(group.format);
    } catch (err) {
      return failure(group, 'artifact-mcp', stableArtifactDiagnostic(err));
    } finally {
      let cleanupError: unknown;
      if (config !== null) {
        try { await config.stop(); } catch (err) { cleanupError = err; }
      }
      try { await rm(scratch, { recursive: true, force: true }); } catch (err) { cleanupError ??= err; }
      if (cleanupError !== undefined) {
        return failure(group, 'artifact-mcp', 'artifact MCP cleanup failed');
      }
    }
  }

  return {
    status: 'success',
    bindings: bindings.map(({ roles, provider, format, model }) => ({ roles, provider, format, model })),
    artifactMcp,
    artifactFormats,
  };
}

interface BindingGroup {
  roles: ExecutionPreflightRole[];
  provider: RoleModelBinding['provider'];
  format: ExecutionPreflightFormat;
  models: string[];
  model: string;
  binding: RoleModelBinding;
}

function groupBindings(models: ExecutionPreflightRoleModels): BindingGroup[] {
  const entries: Array<[ExecutionPreflightRole, RoleModelBinding | null]> = [
    ['pm', models.pm], ['tech-lead', models.techLead], ['qa', models.qa],
    ['coder', models.coder], ['reviewer', models.reviewer], ['designer', models.designer],
  ];
  const groups = new Map<string, BindingGroup>();
  for (const [role, binding] of entries) {
    if (binding === null) continue;
    const key = `${binding.provider}\0${binding.format}\0${binding.alias}`;
    const existing = groups.get(key);
    if (existing) existing.roles.push(role);
    else groups.set(key, {
      roles: [role], provider: binding.provider, format: binding.format,
      models: [binding.alias], model: binding.alias, binding,
    });
  }
  return [...groups.values()];
}

function mergeGroup(groups: Map<string, BindingGroup>, key: string, binding: BindingGroup, roles: ExecutionPreflightRole[]): void {
  const existing = groups.get(key);
  if (existing) {
    existing.roles.push(...roles);
    existing.models = [...new Set([...existing.models, ...binding.models])];
    existing.model = boundedList(existing.models);
  } else {
    groups.set(key, { ...binding, roles: [...roles], models: [...binding.models] });
  }
}

function groupExecutors(bindings: BindingGroup[]): BindingGroup[] {
  const groups = new Map<string, BindingGroup>();
  for (const binding of bindings) {
    mergeGroup(groups, `${binding.provider}\0${binding.format}`, binding, binding.roles);
  }
  return [...groups.values()];
}

function artifactExecutorGroups(bindings: BindingGroup[]): BindingGroup[] {
  const groups = new Map<string, BindingGroup>();
  for (const binding of bindings) {
    const roles = binding.roles.filter((role) => role === 'qa' || role === 'coder');
    if (roles.length > 0) mergeGroup(groups, binding.format, binding, roles);
  }
  return [...groups.values()];
}

function boundedList(values: string[]): string {
  return [...new Set(values)].join(', ').slice(0, MODEL_LIST_MAX_CHARS);
}

function failure(
  group: Pick<BindingGroup, 'roles' | 'provider' | 'format' | 'model'>,
  prerequisite: ExecutionPreflightPrerequisite,
  diagnostic: string,
): ExecutionPreflightFailure {
  return sanitizeExecutionPreflightFailure({
    status: 'failed',
    roles: [...new Set(group.roles)],
    provider: group.provider,
    format: group.format,
    model: group.model,
    prerequisite,
    diagnostic,
    remediation: remediationFor(group.format, prerequisite, diagnostic),
  });
}

function remediationFor(
  format: ExecutionPreflightFormat,
  prerequisite: ExecutionPreflightPrerequisite,
  diagnostic: string,
): string {
  if (prerequisite === 'binary') return `install the ${format} CLI and ensure it is executable on Rune's PATH`;
  if (prerequisite === 'authentication') {
    return format === 'codex'
      ? 'run `codex login` as the Rune service user, then retry the run'
      : 'run `claude auth login` as the Rune service user, then retry the run';
  }
  if (prerequisite === 'model-call') {
    if (/\bENOENT\b.*\bBun\b|\bBun\b.*\bENOENT\b/i.test(diagnostic)) {
      return 'inspect the Rune service Claude runtime directories reported above, then retry the run';
    }
    return 'verify the resolved model id and account access, then retry the run';
  }
  return 'repair the product artifact-MCP, Seatbelt, relay, or executor-auth configuration, then retry the run';
}

function providerProbeEnv(env: NodeJS.ProcessEnv, format: ExecutionPreflightFormat): NodeJS.ProcessEnv {
  const keys = [
    'PATH', 'HOME', 'USER', 'LANG', 'LC_ALL', 'TERM', 'SHELL', 'TMPDIR',
    ...(format === 'codex' ? ['CODEX_HOME'] : ['CLAUDE_CONFIG_DIR']),
  ];
  const out: NodeJS.ProcessEnv = {};
  for (const key of keys) if (env[key] !== undefined) out[key] = env[key];
  return out;
}

function buildArtifactProbeEnv(
  base: NodeJS.ProcessEnv,
  config: ArtifactMcpConfig,
  format: ExecutionPreflightFormat,
): NodeJS.ProcessEnv {
  return {
    ...base,
    ...config.runtimeEnv,
    ...(format === 'codex' ? config.codexEnv ?? {} : {}),
  };
}

async function safeProbe(run: () => Promise<ProbeResult>, fallback: string): Promise<ProbeResult> {
  try { return await run(); } catch { return { ok: false, diagnostic: fallback }; }
}

function probeDiagnostic(format: ExecutionPreflightFormat, result: ProbeResult): string {
  if (result.diagnostic) {
    return `${format} ${classifyProbeDiagnostic(result.diagnostic)}: ${result.diagnostic}`;
  }
  const messages: Record<AiExecutorProbeFailureCode, string> = {
    'not-authenticated': `${format} CLI reported no active subscription login`,
    timeout: `${format} probe exceeded its bounded timeout`,
    'spawn-failed': `${format} probe process could not start`,
    'nonzero-exit': `${format} probe exited unsuccessfully`,
    'invalid-response': `${format} probe returned an invalid completion`,
    'tool-attempt': `${format} model attempted a forbidden tool during preflight`,
    'sandbox-unavailable': 'Codex preflight requires macOS Seatbelt',
    'sandbox-setup-failed': 'Codex read-deny preflight sandbox could not be prepared',
    'cleanup-failed': 'Codex preflight sandbox cleanup failed',
  };
  return result.code ? messages[result.code] : `${format} probe failed`;
}

function classifyProbeDiagnostic(diagnostic: string): string {
  if (/api[_ -]?key|environment variable|config(?:uration)?/i.test(diagnostic)) {
    return 'configuration error';
  }
  if (/model.{0,40}(?:not found|unsupported|invalid|unavailable)|unknown model/i.test(diagnostic)) {
    return 'model availability error';
  }
  if (/rate limit|too many requests|overloaded|capacity/i.test(diagnostic)) {
    return 'rate-limit error';
  }
  if (/permission|not authorized|forbidden|subscription|billing|credit|entitlement/i.test(diagnostic)) {
    return 'account access error';
  }
  return 'CLI error';
}

function stableArtifactDiagnostic(err: unknown): string {
  const message = String((err as Error)?.message ?? err);
  if (/cleanup|SIGKILL/i.test(message)) return 'artifact MCP cleanup failed';
  if (/authentication|logged in|auth/i.test(message)) return 'artifact executor authentication failed';
  if (/relay|initialize|tools\/list|registration|socket/i.test(message)) {
    return 'artifact MCP relay registration handshake failed';
  }
  if (/Seatbelt|sandbox|profile/i.test(message)) return 'artifact MCP Seatbelt setup failed';
  if (/broker|ready|exited before/i.test(message)) return 'artifact MCP broker startup failed';
  return 'artifact MCP environment setup failed';
}

export function boundExecutionPreflightText(raw: string): string {
  return redactSecrets(scrubAbsolutePaths(scrubPathsInText(String(raw))))
    .replace(/[\r\n\t]+/g, ' ')
    .trim()
    .slice(0, PREFLIGHT_FIELD_MAX_CHARS) || 'probe failed without a diagnostic';
}

export function sanitizeExecutionPreflightFailure(
  value: ExecutionPreflightFailure,
): ExecutionPreflightFailure {
  return {
    ...value,
    roles: [...new Set(value.roles)],
    model: boundExecutionPreflightText(value.model),
    diagnostic: boundExecutionPreflightText(value.diagnostic),
    remediation: boundExecutionPreflightText(value.remediation),
  };
}
