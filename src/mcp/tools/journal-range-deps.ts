import { searchVault } from '../../kb/search.js';
import { getVaultIndexStatus, queryVaultIndex } from '../../kb/vault-index.js';
import { sanitizeMcpError } from './sanitize.js';
import type { JournalRangeDeps } from './journal-range.js';

export function buildProductionJournalRangeDeps(): JournalRangeDeps {
  return {
    getVaultIndexStatus,
    queryVaultIndex,
    searchVault,
    sanitizeError: sanitizeMcpError,
  };
}
