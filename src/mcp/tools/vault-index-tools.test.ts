import { describe, expect, it, vi } from 'vitest';

interface VaultIndexStatus {
  ready: boolean;
  status: string;
  lastRebuild: {
    files: number;
    lines: number;
    bytes: number;
    heapUsed: number;
    buildMs: number;
  } | null;
}

interface McpTextResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

interface RefreshVaultIndexDeps {
  refreshVaultIndex: () => void;
  getVaultIndexStatus: () => VaultIndexStatus;
}

type RefreshVaultIndexTool = (deps: RefreshVaultIndexDeps) => Promise<McpTextResult>;

async function requireVaultIndexToolsModule(): Promise<{
  refreshVaultIndexTool: RefreshVaultIndexTool;
}> {
  const specifier = './vault-index-tools' + '.js';
  try {
    const mod = (await import(/* @vite-ignore */ specifier)) as Record<string, unknown>;
    if (typeof mod.refreshVaultIndexTool === 'function') {
      return { refreshVaultIndexTool: mod.refreshVaultIndexTool as RefreshVaultIndexTool };
    }
    expect.fail('src/mcp/tools/vault-index-tools.ts must export refreshVaultIndexTool');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    expect.fail(`src/mcp/tools/vault-index-tools.ts implementation pending: ${message}`);
  }
}

describe('refresh_vault_index tool', () => {
  it('triggers a rebuild and returns readiness plus build stats as structured text', async () => {
    const { refreshVaultIndexTool } = await requireVaultIndexToolsModule();
    const deps: RefreshVaultIndexDeps = {
      refreshVaultIndex: vi.fn(),
      getVaultIndexStatus: vi.fn().mockReturnValue({
        ready: true,
        status: 'ready',
        lastRebuild: {
          files: 12,
          lines: 345,
          bytes: 67_890,
          heapUsed: 4_567_890,
          buildMs: 123,
        },
      } satisfies VaultIndexStatus),
    };

    const result = await refreshVaultIndexTool(deps);

    expect(deps.refreshVaultIndex).toHaveBeenCalledTimes(1);
    expect(deps.getVaultIndexStatus).toHaveBeenCalledTimes(1);
    expect(result.isError).toBeFalsy();
    expect(result.content).toHaveLength(1);
    expect(result.content[0]?.type).toBe('text');

    const payload = JSON.parse(result.content[0]!.text) as VaultIndexStatus;
    expect(payload).toEqual({
      ready: true,
      status: 'ready',
      lastRebuild: {
        files: 12,
        lines: 345,
        bytes: 67_890,
        heapUsed: 4_567_890,
        buildMs: 123,
      },
    });
  });

  it('returns a tool error when refresh fails and still reports the retained prior index status', async () => {
    const { refreshVaultIndexTool } = await requireVaultIndexToolsModule();
    const deps: RefreshVaultIndexDeps = {
      refreshVaultIndex: vi.fn(() => {
        throw new Error('disk read failed');
      }),
      getVaultIndexStatus: vi.fn().mockReturnValue({
        ready: true,
        status: 'stale',
        lastRebuild: {
          files: 8,
          lines: 200,
          bytes: 10_000,
          heapUsed: 3_000_000,
          buildMs: 90,
        },
      } satisfies VaultIndexStatus),
    };

    const result = await refreshVaultIndexTool(deps);

    expect(result.isError).toBe(true);
    expect(deps.getVaultIndexStatus).toHaveBeenCalledTimes(1);
    const text = result.content[0]?.text ?? '';
    expect(text).toContain('refresh_vault_index failed');
    expect(text).toMatch(/"status"\s*:\s*"stale"/);
    expect(text).not.toContain('/Users/');
  });
});
