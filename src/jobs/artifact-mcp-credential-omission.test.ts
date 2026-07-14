import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SandboxSpec } from '../intent/sandbox.js';

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: spawnMock,
}));

vi.mock('../ai/claude.js', () => ({
  registerActiveProcess: vi.fn(),
  unregisterActiveProcess: vi.fn(),
}));

import { buildArtifactMcpConfig } from './artifact-mcp.js';

const roots: string[] = [];

afterEach(() => {
  vi.clearAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('artifact MCP credential omission', () => {
  it('does not invent Telegram credentials for the broker or model-facing relay', async () => {
    const child = new EventEmitter() as EventEmitter & {
      pid: number;
      exitCode: number | null;
      signalCode: NodeJS.Signals | null;
      stdin: { end: (value: string) => void };
      stdout: EventEmitter;
      stderr: EventEmitter & { resume: () => void };
    };
    child.pid = 424242;
    child.exitCode = null;
    child.signalCode = null;
    child.stdout = new EventEmitter();
    child.stderr = Object.assign(new EventEmitter(), { resume: vi.fn() });
    child.stdin = { end: () => queueMicrotask(() => child.stdout.emit('data', Buffer.from('READY\n'))) };
    spawnMock.mockReturnValue(child);

    const root = mkdtempSync(join(tmpdir(), 'artifact-mcp-credentials-'));
    roots.push(root);
    const vault = join(root, 'vault');
    mkdirSync(vault);
    const products = join(root, 'products.json');
    writeFileSync(products, JSON.stringify({
      writing: { repoPath: join(root, 'repo'), artifactMcp: 'rune-kb-readonly' },
    }));
    const projectRoot = fileURLToPath(new URL('../..', import.meta.url));
    const sandbox = {
      product: 'writing', project: 'one', worktree: join(root, 'worktree'),
      egressAllowlist: [], resumed: false,
    } as SandboxSpec;

    const config = await buildArtifactMcpConfig(sandbox, {
      productsConfigPath: products,
      projectRoot,
      vaultDir: vault,
      nodePath: process.execPath,
    });
    try {
      const brokerOptions = spawnMock.mock.calls[0]![2] as { env: Record<string, string> };
      const claude = JSON.parse(config!.claudeArgs[2]!) as {
        mcpServers: Record<string, { env: Record<string, string> }>;
      };
      const relayEnv = claude.mcpServers['rune-kb']!.env;

      expect(brokerOptions.env).not.toHaveProperty('TELEGRAM_BOT_TOKEN');
      expect(brokerOptions.env).not.toHaveProperty('TELEGRAM_USER_ID');
      expect(relayEnv).not.toHaveProperty('TELEGRAM_BOT_TOKEN');
      expect(relayEnv).not.toHaveProperty('TELEGRAM_USER_ID');
    } finally {
      child.exitCode = 0;
      child.emit('exit', 0, null);
      await config?.stop();
    }
  });
});
