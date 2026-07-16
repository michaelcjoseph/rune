import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { MessageSender } from '../../transport/sender.js';

const cleanupCodexThread = vi.hoisted(() => vi.fn());

vi.mock('../../ai/codex-sessions.js', () => ({ cleanupCodexThread }));

interface FixtureInvocation {
  args: string[];
  cwd: string;
  prompt: string;
  resume: boolean;
  sandbox: string | null;
  threadId: string;
}

const root = mkdtempSync(join(tmpdir(), 'rune-product-chat-launch-'));
const binDir = join(root, 'bin');
const logsDir = join(root, 'logs');
const vaultDir = join(root, 'vault');
const fixtureLog = join(root, 'codex-invocations.jsonl');
const claudeFixtureLog = join(root, 'claude-invocations.jsonl');
const productsFile = join(root, 'products.json');
const fallbackRoot = join(root, 'fallback-product-chats');
const priorEnv = new Map<string, string | undefined>();

function setEnv(name: string, value: string): void {
  priorEnv.set(name, process.env[name]);
  process.env[name] = value;
}

function initRepo(name: string): string {
  const repo = join(root, name);
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'README.md'), `# ${name}\n`);
  execFileSync('git', ['init', '-b', 'main'], { cwd: repo });
  execFileSync('git', ['add', 'README.md'], { cwd: repo });
  execFileSync('git', [
    '-c', 'user.name=Rune Test',
    '-c', 'user.email=rune-test@example.invalid',
    'commit', '-m', 'initial',
  ], { cwd: repo });
  return repo;
}

function readInvocations(path: string): FixtureInvocation[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as FixtureInvocation);
}

const invocations = (): FixtureInvocation[] => readInvocations(fixtureLog);
const claudeInvocations = (): FixtureInvocation[] => readInvocations(claudeFixtureLog);

function sender(): MessageSender {
  return {
    name: 'webview',
    send: vi.fn().mockResolvedValue(undefined),
    startTyping: vi.fn(),
    stopTyping: vi.fn(),
  };
}

let demoRepo: string;
let legacyRepo: string;
let claudeRepo: string;
let handleWebviewMessage: typeof import('../../server/webview-bootstrap.js').handleWebviewMessage;
let sessions: typeof import('../../vault/sessions.js');

beforeAll(async () => {
  mkdirSync(binDir, { recursive: true });
  mkdirSync(logsDir, { recursive: true });
  mkdirSync(vaultDir, { recursive: true });
  mkdirSync(fallbackRoot, { recursive: true });
  demoRepo = initRepo('demo-repo');
  legacyRepo = initRepo('legacy-repo');
  claudeRepo = initRepo('claude-repo');

  const fixturePath = join(binDir, 'codex');
  writeFileSync(fixturePath, `#!/usr/bin/env node
const { appendFileSync, mkdirSync, writeFileSync } = require('node:fs');
const { basename, join } = require('node:path');
const { execFileSync } = require('node:child_process');
const args = process.argv.slice(2);
const resume = args[0] === 'exec' && args[1] === 'resume';
const sandboxIndex = args.indexOf('-s');
const configSandbox = args.find((arg, index) => (
  args[index - 1] === '-c' && arg.startsWith('sandbox_mode=')
));
const sandbox = sandboxIndex >= 0
  ? args[sandboxIndex + 1]
  : configSandbox
    ? JSON.parse(configSandbox.slice('sandbox_mode='.length))
    : null;
const prompt = args[args.length - 1] || '';
const threadId = resume ? args[args.length - 2] : 'thread-' + basename(process.cwd());
appendFileSync(process.env.CHAT_FIXTURE_LOG, JSON.stringify({
  args, cwd: process.cwd(), prompt, resume, sandbox, threadId,
}) + '\\n');
if (sandbox === 'danger-full-access') {
  mkdirSync(join(process.cwd(), 'src'), { recursive: true });
  writeFileSync(
    join(process.cwd(), 'src', 'product-chat-proof.ts'),
    'export const productChatProof = ' + (resume ? '2' : '1') + ';\\n',
  );
  execFileSync('git', ['add', 'src/product-chat-proof.ts']);
  execFileSync('git', [
    '-c', 'user.name=Rune Product Chat',
    '-c', 'user.email=rune-product-chat@example.invalid',
    'commit', '-m', resume ? 'resumed product chat proof' : 'product chat proof',
  ]);
} else if (sandbox === 'workspace-write') {
  writeFileSync(
    join(process.cwd(), 'fallback-product-chat-proof.txt'),
    resume ? 'resumed workspace write\\n' : 'initial workspace write\\n',
  );
} else {
  process.stderr.write('fixture received unexpected sandbox: ' + String(sandbox));
  process.exit(2);
}
process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: threadId }) + '\\n');
process.stdout.write(JSON.stringify({
  type: 'item.completed',
  item: { type: 'agent_message', text: resume ? 'resumed product chat' : 'edited and committed' },
}) + '\\n');
`);
  chmodSync(fixturePath, 0o755);

  const claudeFixturePath = join(binDir, 'claude');
  writeFileSync(claudeFixturePath, `#!/usr/bin/env node
const { appendFileSync, mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { execFileSync } = require('node:child_process');
const args = process.argv.slice(2);
const resume = args.includes('--resume');
const sessionFlag = resume ? '--resume' : '--session-id';
const sessionIndex = args.indexOf(sessionFlag);
const threadId = args[sessionIndex + 1];
const promptIndex = args.indexOf('-p');
const prompt = promptIndex >= 0 ? args[promptIndex + 1] : '';
appendFileSync(process.env.CLAUDE_FIXTURE_LOG, JSON.stringify({
  args, cwd: process.cwd(), prompt, resume, sandbox: null, threadId,
}) + '\\n');
if (!args.includes('--dangerously-skip-permissions')) {
  process.stderr.write('fixture requires dangerously-skip-permissions');
  process.exit(2);
}
mkdirSync(join(process.cwd(), 'src'), { recursive: true });
writeFileSync(
  join(process.cwd(), 'src', 'claude-product-chat-proof.ts'),
  'export const claudeProductChatProof = ' + (resume ? '2' : '1') + ';\\n',
);
execFileSync('git', ['add', 'src/claude-product-chat-proof.ts']);
execFileSync('git', [
  '-c', 'user.name=Rune Product Chat',
  '-c', 'user.email=rune-product-chat@example.invalid',
  'commit', '-m', resume ? 'resumed claude product chat proof' : 'claude product chat proof',
]);
process.stdout.write(JSON.stringify({ type: 'result', result: 'edited and committed' }) + '\\n');
`);
  chmodSync(claudeFixturePath, 0o755);

  writeFileSync(productsFile, JSON.stringify({
    demo: {
      class: 'internal',
      repoPath: demoRepo,
      baseBranch: 'main',
      credentialsFile: join(root, 'demo.env'),
      egressAllowlist: [],
    },
    legacy: {
      class: 'internal',
      repoPath: legacyRepo,
      baseBranch: 'main',
      credentialsFile: join(root, 'legacy.env'),
      egressAllowlist: [],
    },
    claude: {
      class: 'internal',
      repoPath: claudeRepo,
      baseBranch: 'main',
      credentialsFile: join(root, 'claude.env'),
      egressAllowlist: [],
    },
  }));

  setEnv('PATH', `${binDir}:${process.env['PATH'] ?? ''}`);
  setEnv('VAULT_DIR', vaultDir);
  setEnv('TELEGRAM_USER_ID', '42');
  setEnv('RUNE_LOGS_DIR', logsDir);
  setEnv('RUNE_WORKSPACE_DIR', root);
  setEnv('RUNE_PRODUCT_CHAT_FALLBACK_ROOT', fallbackRoot);
  setEnv('PRODUCTS_CONFIG_FILE', productsFile);
  setEnv('CHAT_FIXTURE_LOG', fixtureLog);
  setEnv('CLAUDE_FIXTURE_LOG', claudeFixtureLog);

  ({ handleWebviewMessage } = await import('../../server/webview-bootstrap.js'));
  sessions = await import('../../vault/sessions.js');
});

afterAll(() => {
  for (const [name, value] of priorEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

describe('webview product-chat launch authority', () => {
  it('keeps Claude product chat on its full-trust repository launch posture', async () => {
    const scope = { kind: 'product' as const, product: 'claude' };
    sessions.createSession(303, 'webview', 'claude start', 'opus', scope);

    await handleWebviewMessage(sender(), 303, 'make the edit', scope);

    const invocation = claudeInvocations()[0]!;
    expect(invocation).toMatchObject({
      cwd: realpathSync(claudeRepo),
      resume: false,
    });
    expect(invocation.args).toContain('--dangerously-skip-permissions');
    expect(invocation.args).toContain('--add-dir');
    expect(invocation.args).toContain(realpathSync(claudeRepo));
    expect(invocation.args).toContain('Edit');
    expect(invocation.args).toContain('Write');
    expect(invocation.args).toContain('Bash');
    expect(existsSync(join(claudeRepo, 'src', 'claude-product-chat-proof.ts'))).toBe(true);
    expect(execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: claudeRepo, encoding: 'utf8' }).trim()).toBe('2');

    await handleWebviewMessage(sender(), 303, 'make another edit', scope);

    const resumed = claudeInvocations()[1]!;
    expect(resumed).toMatchObject({
      cwd: realpathSync(claudeRepo),
      resume: true,
    });
    expect(resumed.args).toContain('--dangerously-skip-permissions');
    expect(readFileSync(join(claudeRepo, 'src', 'claude-product-chat-proof.ts'), 'utf8')).toContain('= 2');
    expect(execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: claudeRepo, encoding: 'utf8' }).trim()).toBe('3');
  });

  it('edits and commits from a full-access repository cwd, then resumes the bound thread', async () => {
    const scope = { kind: 'product' as const, product: 'demo' };
    const invocationStart = invocations().length;

    await handleWebviewMessage(sender(), 101, 'make a small edit', scope);

    const first = invocations()[invocationStart]!;
    expect(first).toMatchObject({
      cwd: realpathSync(demoRepo),
      resume: false,
      sandbox: 'danger-full-access',
      threadId: `thread-${basename(demoRepo)}`,
    });
    expect(existsSync(join(demoRepo, 'src', 'product-chat-proof.ts'))).toBe(true);
    expect(execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: demoRepo, encoding: 'utf8' }).trim()).toBe('2');
    expect(sessions.getSession(101, 'webview', scope)?.executor).toEqual({
      format: 'codex',
      sessionId: `thread-${basename(demoRepo)}`,
      authority: 'product-full-access',
      cwd: realpathSync(demoRepo),
      writableRoot: realpathSync(demoRepo),
    });

    await handleWebviewMessage(sender(), 101, 'continue now', scope);

    const second = invocations()[invocationStart + 1]!;
    expect(second).toMatchObject({
      cwd: realpathSync(demoRepo),
      resume: true,
      sandbox: 'danger-full-access',
      threadId: `thread-${basename(demoRepo)}`,
    });
    expect(second.args).toContain('resume');
    expect(second.args).not.toContain('-s');
    expect(second.args).toContain('sandbox_mode="danger-full-access"');
    expect(readFileSync(join(demoRepo, 'src', 'product-chat-proof.ts'), 'utf8')).toContain('= 2');
    expect(execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: demoRepo, encoding: 'utf8' }).trim()).toBe('3');
  });

  it('writes inside the configured fallback workspace on initial and resumed turns', async () => {
    const scope = { kind: 'product' as const, product: 'unresolved' };
    const invocationStart = invocations().length;
    const fallbackWorkspace = sessions.resolveProductFallbackWorkspace('unresolved').workRoot;

    await handleWebviewMessage(sender(), 404, 'write a fallback proof', scope);

    const first = invocations()[invocationStart]!;
    expect(first).toMatchObject({
      cwd: realpathSync(fallbackWorkspace),
      resume: false,
      sandbox: 'workspace-write',
      threadId: `thread-${basename(fallbackWorkspace)}`,
    });
    expect(first.args).toContain('-s');
    expect(first.args).not.toContain('danger-full-access');
    expect(first.args).toContain('--ignore-user-config');
    expect(first.args).toContain('--ignore-rules');
    expect(first.args).toContain('--strict-config');
    expect(first.args).toContain('mcp_servers={}');
    expect(first.args).toContain('features.hooks=false');
    expect(first.args.join(' ')).not.toContain('cockpit_inspect_run');
    expect(readFileSync(join(fallbackWorkspace, 'fallback-product-chat-proof.txt'), 'utf8')).toBe('initial workspace write\n');
    expect(sessions.getSession(404, 'webview', scope)?.executor).toEqual({
      format: 'codex',
      sessionId: `thread-${basename(fallbackWorkspace)}`,
      authority: 'product-workspace-write',
      cwd: fallbackWorkspace,
      writableRoot: fallbackWorkspace,
    });

    await handleWebviewMessage(sender(), 404, 'update the fallback proof', scope);

    const second = invocations()[invocationStart + 1]!;
    expect(second).toMatchObject({
      cwd: realpathSync(fallbackWorkspace),
      resume: true,
      sandbox: 'workspace-write',
      threadId: `thread-${basename(fallbackWorkspace)}`,
    });
    expect(second.args).not.toContain('-s');
    expect(second.args).toContain('sandbox_mode="workspace-write"');
    expect(readFileSync(join(fallbackWorkspace, 'fallback-product-chat-proof.txt'), 'utf8')).toBe('resumed workspace write\n');
  });

  it('rotates a seeded legacy read-only executor instead of resuming it', async () => {
    const scope = { kind: 'product' as const, product: 'legacy' };
    const invocationStart = invocations().length;
    sessions.createSession(202, 'webview', 'legacy start', 'gpt-5.6-terra', scope);
    sessions.appendMessageToSession(202, 'webview', 'assistant', 'legacy context to replay', scope);
    sessions.setSessionExecutor(202, 'webview', {
      format: 'codex',
      sessionId: 'legacy-read-only-thread',
      writeEnabled: false,
    }, scope);

    await handleWebviewMessage(sender(), 202, 'make the edit', scope);

    const rotated = invocations()[invocationStart]!;
    expect(rotated).toMatchObject({
      cwd: realpathSync(legacyRepo),
      resume: false,
      sandbox: 'danger-full-access',
      threadId: `thread-${basename(legacyRepo)}`,
    });
    expect(rotated.args).not.toContain('legacy-read-only-thread');
    expect(rotated.prompt).toContain('legacy context to replay');
    expect(cleanupCodexThread).toHaveBeenCalledWith('legacy-read-only-thread');
    expect(execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: legacyRepo, encoding: 'utf8' }).trim()).toBe('2');
  });
});
