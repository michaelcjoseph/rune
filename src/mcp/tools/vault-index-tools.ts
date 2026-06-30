import { getVaultIndexStatus, refreshVaultIndex } from '../../kb/vault-index.js';
import { errText, err, ok, type McpTextResult } from './types.js';
import { sanitizeMcpError } from './sanitize.js';

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

export interface RefreshVaultIndexDeps {
  refreshVaultIndex: () => void;
  getVaultIndexStatus: () => VaultIndexStatus;
  sanitizeError?: (message: string) => string;
}

function withStableStats(status: VaultIndexStatus): VaultIndexStatus {
  if (status.lastRebuild !== null) return status;
  return {
    ...status,
    lastRebuild: {
      files: 0,
      lines: 0,
      bytes: 0,
      heapUsed: process.memoryUsage().heapUsed,
      buildMs: 0,
    },
  };
}

export async function refreshVaultIndexTool(
  deps: RefreshVaultIndexDeps,
): Promise<McpTextResult> {
  const clean = deps.sanitizeError ?? ((s: string) => s);
  try {
    deps.refreshVaultIndex();
    return ok(JSON.stringify(withStableStats(deps.getVaultIndexStatus()), null, 2));
  } catch (unexpected) {
    const status = withStableStats(deps.getVaultIndexStatus());
    return err(`refresh_vault_index failed: ${clean(errText(unexpected))}\n${JSON.stringify(status, null, 2)}`);
  }
}

export function buildProductionRefreshVaultIndexDeps(): RefreshVaultIndexDeps {
  return { refreshVaultIndex, getVaultIndexStatus, sanitizeError: sanitizeMcpError };
}
