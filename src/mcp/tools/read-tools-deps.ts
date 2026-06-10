/**
 * Production dependency bindings for the read-tools trio handlers.
 *
 * Separate from ./read-tools.ts (the pure handlers) because these imports
 * pull src/config.ts (env-var-required at import); src/mcp/server.ts loads
 * this module only via dynamic import inside each tool handler.
 */

import { searchVault } from '../../kb/search.js';
import { readVaultFile } from '../../vault/files.js';
import { getTodayFilename, getYesterdayFilename } from '../../utils/time.js';
import { sanitizeMcpError } from './sanitize.js';
import type { VaultSearchDeps, CrmLookupDeps, GetPrioritiesDeps } from './read-tools.js';

export function buildProductionVaultSearchDeps(): VaultSearchDeps {
  return { searchVault, sanitizeError: sanitizeMcpError };
}

export function buildProductionCrmLookupDeps(): CrmLookupDeps {
  return { readVaultFile, sanitizeError: sanitizeMcpError };
}

export function buildProductionGetPrioritiesDeps(): GetPrioritiesDeps {
  return { readVaultFile, getTodayFilename, getYesterdayFilename, sanitizeError: sanitizeMcpError };
}
