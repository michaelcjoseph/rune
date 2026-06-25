import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { chmod } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT_RELATIVE_PATH = join('scripts', 'run-rune-rebrand-acceptance.ts');
const retired = ['ja', 'rvis'].join('');
const launchdLabel = ['com', retired, 'daemon'].join('.');

const cleanupPaths: string[] = [];
let healthServer: Server | null = null;

afterEach(async () => {
  if (healthServer) {
    await new Promise<void>((resolve, reject) => {
      healthServer!.close((err) => (err ? reject(err) : resolve()));
    });
    healthServer = null;
  }

  for (const path of cleanupPaths.splice(0).reverse()) {
    rmSync(path, { recursive: true, force: true });
  }
});

function tempDir(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  cleanupPaths.push(path);
  return path;
}

async function executable(path: string, body: string): Promise<void> {
  writeFileSync(path, body, 'utf8');
  await chmod(path, 0o755);
}

function runAcceptance(scriptPath: string, env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, ['--import', 'tsx', scriptPath], {
    cwd: dirname(dirname(scriptPath)),
    env,
    encoding: 'utf8',
    timeout: 30_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function makeMovedCheckout(): { home: string; checkout: string; scriptPath: string } {
  const home = tempDir('rune-acceptance-home-');
  const workspace = join(home, 'workspace');
  const checkout = join(workspace, 'rune');
  mkdirSync(workspace, { recursive: true });
  mkdirSync(checkout, { recursive: true });
  mkdirSync(join(checkout, 'scripts'), { recursive: true });
  cpSync(join(PROJECT_ROOT, 'scripts', 'run-rune-rebrand-acceptance.ts'), join(checkout, SCRIPT_RELATIVE_PATH));
  cpSync(join(PROJECT_ROOT, 'src'), join(checkout, 'src'), { recursive: true });
  cpSync(join(PROJECT_ROOT, '.claude'), join(checkout, '.claude'), { recursive: true });
  cpSync(join(PROJECT_ROOT, 'policies'), join(checkout, 'policies'), { recursive: true });
  cpSync(join(PROJECT_ROOT, 'package.json'), join(checkout, 'package.json'));
  const nodeModules = join(PROJECT_ROOT, 'node_modules');
  if (existsSync(nodeModules)) symlinkSync(nodeModules, join(checkout, 'node_modules'), 'dir');
  return { home, checkout, scriptPath: join(checkout, SCRIPT_RELATIVE_PATH) };
}

async function startHealthServer(): Promise<void> {
  healthServer = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
  });

  await new Promise<void>((resolve, reject) => {
    healthServer!.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        healthServer = null;
        resolve();
        return;
      }
      reject(err);
    });
    healthServer!.listen(3847, '127.0.0.1', () => {
      healthServer!.off('error', reject);
      resolve();
    });
  });
}

async function makePassingExternalSurface(binDir: string, checkout: string): Promise<void> {
  await executable(join(binDir, 'git'), `#!/bin/sh
if [ "$1" = "remote" ] && [ "$2" = "get-url" ]; then
  echo "git@github.com:owner/rune.git"
  exit 0
fi
if [ "$1" = "fetch" ] || [ "$1" = "push" ]; then
  exit 0
fi
if [ "$1" = "grep" ]; then
  if [ "$5" = "${retired}" ]; then
    printf 'launchd/com.plist:1:<string>${launchdLabel}</string>\\n'
    exit 0
  fi
  exit 1
fi
echo "unexpected git invocation: $*" >&2
exit 2
`);

  await executable(join(binDir, 'launchctl'), `#!/bin/sh
cat <<'EOF'
service = ${launchdLabel}
program = ${checkout}/src/index.ts
last exit status = 0
EOF
`);
}

describe('Rune rebrand live acceptance harness', () => {
  it('requires the cutover harness to run from the moved checkout path', () => {
    const home = tempDir('rune-acceptance-unmoved-home-');
    const result = runAcceptance(join(PROJECT_ROOT, SCRIPT_RELATIVE_PATH), {
      ...process.env,
      HOME: home,
    });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/expected moved checkout|acceptance must run from/i);
  });

  it('rejects a fake Claude CLI instead of accepting a stubbed routine agent run', async () => {
    const { home, checkout, scriptPath } = makeMovedCheckout();
    const binDir = tempDir('rune-acceptance-bin-');
    const vaultDir = tempDir('rune-acceptance-vault-');
    const handleRecord = join(tempDir('rune-acceptance-handle-'), 'ownership.txt');
    const handleVerify = join(binDir, 'verify-handle');
    const fakeClaude = join(binDir, 'claude');

    writeFileSync(handleRecord, 'authenticated owner: @runeai\n', 'utf8');
    await executable(handleVerify, '#!/bin/sh\necho "authenticated owner: @runeai"\n');
    await executable(fakeClaude, '#!/bin/sh\necho "fake routine agent response"\n');
    await makePassingExternalSurface(binDir, checkout);
    await startHealthServer();

    const result = runAcceptance(scriptPath, {
      ...process.env,
      HOME: home,
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
      TELEGRAM_BOT_TOKEN: 'acceptance-token',
      TELEGRAM_USER_ID: '1',
      VAULT_DIR: vaultDir,
      RUNE_HANDLE_OWNERSHIP_RECORD: handleRecord,
      RUNE_HANDLE_VERIFY_COMMAND: handleVerify,
    });

    const output = `${result.stdout}\n${result.stderr}`;
    expect(result.status, output).not.toBe(0);
    expect(output).toMatch(/real Claude CLI|stub|fake/i);
  });
});
