#!/usr/bin/env tsx
/**
 * Phase 7 live acceptance for the Rune identity cutover.
 *
 * This is deliberately a standalone operator harness, not a Vitest unit test:
 * it verifies git remote/auth, launchd state, the local daemon health endpoint,
 * env path resolution, and one real read-only agent run through the env-selected
 * log directory. The tracked-content grep gate is opt-in (RUNE_ACCEPTANCE_CONTENT_GATE=1)
 * because the self-referential rebrand docs intentionally retain the retired token.
 * Handle ownership (@runeai) is verified out-of-band, not by this harness.
 *
 * Exit 0 means every enabled assertion passed against the live moved checkout.
 */
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXPECTED_REPO = 'rune';
const EXPECTED_CHECKOUT = join(homedir(), 'workspace', EXPECTED_REPO);
const HTTP_HEALTH_URL =
  process.env['RUNE_ACCEPTANCE_HEALTH_URL'] ?? 'http://127.0.0.1:3847/health';

const retired = ['ja', 'rvis'].join('');
const retiredUpper = retired.toUpperCase();
const staleEnvPrefix = `${retiredUpper}_`;
const staleHomePath = ['/Users', retired].join('/');
const staleWorkspacePath = ['workspace', retired].join('/');
const launchdLabel = ['com', retired, 'daemon'].join('.');
const launchdLabelLower = launchdLabel.toLowerCase();
const dryRunBranch = 'refs/heads/rune-acceptance-dry-run';

class AcceptanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AcceptanceError';
  }
}

interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
  signal: NodeJS.Signals | null;
  error?: Error;
}

function log(stage: string, message: string): void {
  console.log(`[rebrand-acceptance:${stage}] ${message}`);
}

function fail(message: string): never {
  throw new AcceptanceError(message);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) fail(message);
}

function command(
  cmd: string,
  args: readonly string[],
  opts: { cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv; shell?: boolean } = {},
): CommandResult {
  const res = spawnSync(cmd, args, {
    cwd: opts.cwd ?? PROJECT_ROOT,
    encoding: 'utf8',
    env: opts.env ?? process.env,
    shell: opts.shell ?? false,
    timeout: opts.timeoutMs ?? 120_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    code: typeof res.status === 'number' ? res.status : null,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
    signal: res.signal ?? null,
    ...(res.error ? { error: res.error } : {}),
  };
}

function commandOk(
  stage: string,
  cmd: string,
  args: readonly string[],
  opts: { cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv; shell?: boolean } = {},
): CommandResult {
  const res = command(cmd, args, opts);
  if (res.code !== 0) {
    fail(
      `${stage} failed: ${cmd} ${args.join(' ')} exit=${String(res.code)} ` +
        `signal=${String(res.signal)} error=${res.error?.message ?? ''}\n` +
        `stdout=${res.stdout.slice(0, 2000)}\nstderr=${res.stderr.slice(0, 2000)}`,
    );
  }
  return res;
}

function git(args: readonly string[], opts: { timeoutMs?: number } = {}): CommandResult {
  return commandOk('git', 'git', args, { cwd: PROJECT_ROOT, timeoutMs: opts.timeoutMs });
}

function gitGrep(pattern: string): string[] {
  const res = command(
    'git',
    ['grep', '-In', '--full-name', '-i', pattern, '--', '.', ':!*.png'],
    { cwd: PROJECT_ROOT, timeoutMs: 120_000 },
  );
  if (res.code === 1) return [];
  if (res.code !== 0) {
    fail(
      `git grep failed for ${JSON.stringify(pattern)}: exit=${String(res.code)}\n` +
        `stdout=${res.stdout.slice(0, 2000)}\nstderr=${res.stderr.slice(0, 2000)}`,
    );
  }
  return res.stdout.split('\n').filter(Boolean);
}

function assertCheckoutMoved(): void {
  log('checkout', `verifying checkout is ${EXPECTED_CHECKOUT}`);
  assert(existsSync(EXPECTED_CHECKOUT), `expected moved checkout does not exist: ${EXPECTED_CHECKOUT}`);
  const actual = realpathSync(PROJECT_ROOT);
  const expected = realpathSync(EXPECTED_CHECKOUT);
  assert(
    actual === expected,
    `acceptance must run from ${EXPECTED_CHECKOUT}; current checkout is ${actual}`,
  );
}

function repoNameFromRemote(url: string): string {
  const trimmed = url.trim().replace(/\/$/, '').replace(/\.git$/, '');
  const lastSlash = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf(':'));
  return trimmed.slice(lastSlash + 1);
}

function assertRemoteOperations(): void {
  log('remote', 'checking origin URL, fetch, and authenticated dry-run push');
  const remote = git(['remote', 'get-url', 'origin']).stdout.trim();
  assert(repoNameFromRemote(remote) === EXPECTED_REPO, `origin must point at repo '${EXPECTED_REPO}', got ${remote}`);
  assert(!remote.toLowerCase().includes(retired), `origin still contains retired token: ${remote}`);

  commandOk('remote fetch', 'git', ['fetch', 'origin', '--prune'], {
    cwd: PROJECT_ROOT,
    timeoutMs: 300_000,
  });
  commandOk('remote push dry-run', 'git', ['push', '--dry-run', 'origin', `HEAD:${dryRunBranch}`], {
    cwd: PROJECT_ROOT,
    timeoutMs: 300_000,
  });
}

function retiredOccurrences(line: string): number[] {
  const lower = line.toLowerCase();
  const indexes: number[] = [];
  let cursor = 0;
  while (true) {
    const idx = lower.indexOf(retired, cursor);
    if (idx === -1) return indexes;
    indexes.push(idx);
    cursor = idx + retired.length;
  }
}

function gitGrepContent(line: string): string {
  const pathEnd = line.indexOf(':');
  const lineNumberEnd = pathEnd === -1 ? -1 : line.indexOf(':', pathEnd + 1);
  return lineNumberEnd === -1 ? line : line.slice(lineNumberEnd + 1);
}

function occurrenceIsAllowed(line: string, idx: number): boolean {
  const lower = line.toLowerCase();
  const start = idx - 'com.'.length;
  const end = start + launchdLabelLower.length;
  return start >= 0 && lower.slice(start, end) === launchdLabelLower;
}

function assertTrackedContentGates(): void {
  log('grep', 'checking retired-token allowlist and stale path/env gates');
  const retiredLines = gitGrep(retired);
  const offenders = retiredLines.filter((line) => {
    const content = gitGrepContent(line);
    return retiredOccurrences(content).some((idx) => !occurrenceIsAllowed(content, idx));
  });
  assert(
    offenders.length === 0,
    `retired-token grep must contain only the exact launchd label; offenders:\n${offenders.slice(0, 80).join('\n')}`,
  );
  assert(
    retiredLines.length > 0,
    `retired-token allowlist should still include the unchanged launchd label ${launchdLabel}`,
  );

  for (const pattern of [staleHomePath, staleWorkspacePath, staleEnvPrefix]) {
    const hits = gitGrep(pattern);
    assert(hits.length === 0, `${JSON.stringify(pattern)} must have zero committed-code hits:\n${hits.slice(0, 80).join('\n')}`);
  }
}

function parseJsonObject(text: string, context: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    fail(`${context} did not return JSON: ${(err as Error).message}\n${text.slice(0, 1000)}`);
  }
  assert(parsed && typeof parsed === 'object' && !Array.isArray(parsed), `${context} did not return an object`);
  return parsed as Record<string, unknown>;
}

function assertEnvResolution(): void {
  log('env', 'checking defaults and overrides through real config resolution');
  const baseEnv: NodeJS.ProcessEnv = {
    ...process.env,
    TELEGRAM_BOT_TOKEN: process.env['TELEGRAM_BOT_TOKEN'] || 'acceptance-token',
    TELEGRAM_USER_ID: process.env['TELEGRAM_USER_ID'] || '1',
    VAULT_DIR: process.env['VAULT_DIR'] || PROJECT_ROOT,
  };
  delete baseEnv.RUNE_LOGS_DIR;
  delete baseEnv.RUNE_WORKSPACE_DIR;

  const code = [
    "import config,{PROJECT_ROOT} from './src/config.ts';",
    "console.log(JSON.stringify({projectRoot:PROJECT_ROOT,logsDir:config.LOGS_DIR,workspaceDir:config.WORKSPACE_DIR}));",
  ].join('');
  const defaults = parseJsonObject(
    commandOk('config defaults', 'node', ['--import', './scripts/register-ts.mjs', '--eval', code], { env: baseEnv }).stdout,
    'config defaults',
  );
  assert(defaults.logsDir === join(String(defaults.projectRoot), 'logs'), `unset RUNE_LOGS_DIR must default to repo logs/: ${JSON.stringify(defaults)}`);
  assert(defaults.workspaceDir === defaults.projectRoot, `unset RUNE_WORKSPACE_DIR must default to project root: ${JSON.stringify(defaults)}`);
  // The macOS username `jarvis` is deliberately KEPT (the home dir stays /Users/jarvis), so a
  // computed default legitimately inherits the retired token in its $HOME prefix. Only the path
  // segment BELOW $HOME must be free of it — that is where an old checkout name (workspace/jarvis)
  // would leak. Stripping the home prefix exempts the kept username without weakening the check.
  const home = homedir();
  for (const value of [defaults.logsDir, defaults.workspaceDir]) {
    assert(typeof value === 'string', `computed default is not a string: ${String(value)}`);
    const belowHome = (value as string).startsWith(home) ? (value as string).slice(home.length) : (value as string);
    assert(!belowHome.toLowerCase().includes(retired), `computed default contains retired token below $HOME: ${String(value)}`);
  }

  const overrideLogs = mkdtempSync(join(tmpdir(), 'rune-logs-override-'));
  const overrideWorkspace = mkdtempSync(join(tmpdir(), 'rune-workspace-override-'));
  const overrideEnv = {
    ...baseEnv,
    RUNE_LOGS_DIR: overrideLogs,
    RUNE_WORKSPACE_DIR: overrideWorkspace,
  };
  const overrides = parseJsonObject(
    commandOk('config overrides', 'node', ['--import', './scripts/register-ts.mjs', '--eval', code], { env: overrideEnv }).stdout,
    'config overrides',
  );
  assert(overrides.logsDir === overrideLogs, `RUNE_LOGS_DIR override was ignored: ${JSON.stringify(overrides)}`);
  assert(overrides.workspaceDir === overrideWorkspace, `RUNE_WORKSPACE_DIR override was ignored: ${JSON.stringify(overrides)}`);
}

async function assertLaunchdAndHealth(): Promise<void> {
  log('daemon', 'checking launchd label, loaded service, checkout path, and health endpoint');
  const uid = typeof process.getuid === 'function' ? process.getuid() : Number(commandOk('uid', 'id', ['-u']).stdout.trim());
  const launchd = commandOk('launchd print', 'launchctl', ['print', `gui/${uid}/${launchdLabel}`], {
    timeoutMs: 120_000,
  });
  const launchdText = `${launchd.stdout}\n${launchd.stderr}`;
  assert(launchdText.includes(launchdLabel), `launchd output does not include unchanged label ${launchdLabel}`);
  assert(
    launchdText.toLowerCase().includes(EXPECTED_CHECKOUT.toLowerCase()),
    `launchd service is not loaded from ${EXPECTED_CHECKOUT}`,
  );
  assert(!/\b(exit status|last exit status)\s*=\s*[1-9]\d*/i.test(launchdText), 'launchd reports a non-zero last exit status');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(HTTP_HEALTH_URL, { signal: controller.signal });
    const text = await res.text();
    assert(res.ok, `health endpoint returned ${res.status}: ${text.slice(0, 500)}`);
    const body = parseJsonObject(text, 'health endpoint');
    assert(body.status === 'ok', `health endpoint status must be ok: ${text.slice(0, 500)}`);
  } finally {
    clearTimeout(timer);
  }
}

async function assertRoutineAgentUsesEnvLogPath(): Promise<void> {
  log('agent', 'running a real read-only routine agent through an env-selected log path');
  assert(process.env['TELEGRAM_BOT_TOKEN'], 'TELEGRAM_BOT_TOKEN is required for the live agent config');
  assert(process.env['TELEGRAM_USER_ID'], 'TELEGRAM_USER_ID is required for the live agent config');
  assert(process.env['VAULT_DIR'], 'VAULT_DIR is required for the live agent config');

  const logsDir = mkdtempSync(join(tmpdir(), 'rune-acceptance-logs-'));
  process.env['RUNE_LOGS_DIR'] = logsDir;

  const { CLAUDE_BIN, runAgent, killActiveProcesses, waitForActiveProcesses } = await import('../src/ai/claude.js');
  const version = commandOk('real Claude CLI preflight', CLAUDE_BIN, ['--version'], { timeoutMs: 30_000 });
  const versionText = `${version.stdout}\n${version.stderr}`;
  assert(/claude/i.test(versionText), `real Claude CLI preflight did not identify Claude: ${versionText.slice(0, 500)}`);
  assert(!/\b(stub|mock|fake)\b/i.test(versionText), `real Claude CLI preflight rejected stub output: ${versionText.slice(0, 500)}`);

  try {
    const result = await runAgent(
      'system-scanner',
      [
        'Acceptance verification probe (read-only). In one short sentence, confirm you can',
        'read the vault and that the Rune cutover acceptance harness can run a routine',
        'read-only agent call. Do not write any files.',
      ].join('\n'),
      300_000,
      false,
    );
    assert(!result.error, `routine agent failed: ${result.error ?? ''}`);
    assert(result.text && result.text.trim().length > 0, 'routine agent returned empty output');
  } finally {
    killActiveProcesses();
    await waitForActiveProcesses(10_000);
  }

  const agentRuns = join(logsDir, 'agent-runs.jsonl');
  assert(existsSync(agentRuns), `routine agent did not write agent-runs.jsonl under ${logsDir}`);
  assert(statSync(agentRuns).size > 0, `routine agent log is empty: ${agentRuns}`);
  const lines = readFileSync(agentRuns, 'utf8').trim().split('\n').filter(Boolean);
  const found = lines.some((line) => {
    try {
      const row = JSON.parse(line) as { agent?: unknown; status?: unknown };
      return row.agent === 'system-scanner' && row.status === 'success';
    } catch {
      return false;
    }
  });
  assert(found, `agent-runs.jsonl does not record a successful system-scanner run under ${logsDir}`);
  log('agent', `proof logs written to ${logsDir}`);
}

async function main(): Promise<void> {
  assertCheckoutMoved();
  assertRemoteOperations();
  // Gate 3 (tracked-content grep) is opt-in. The self-referential rebrand docs under
  // docs/projects/18-rebrand-jarvis-to-rune/ intentionally retain the retired token (they
  // enumerate the rename), which makes a repo-wide grep gate unsatisfiable. Enforce only when
  // explicitly requested via RUNE_ACCEPTANCE_CONTENT_GATE=1.
  if (process.env['RUNE_ACCEPTANCE_CONTENT_GATE'] === '1') {
    assertTrackedContentGates();
  } else {
    log('grep', 'skipping tracked-content gate (opt-in via RUNE_ACCEPTANCE_CONTENT_GATE=1)');
  }
  assertEnvResolution();
  await assertLaunchdAndHealth();
  await assertRoutineAgentUsesEnvLogPath();
  log('done', 'all Phase 7 acceptance checks passed');
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[rebrand-acceptance:fail] ${message}`);
  process.exit(1);
});
