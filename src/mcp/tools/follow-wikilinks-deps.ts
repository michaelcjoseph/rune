import { getVaultIndexStatus, queryVaultIndex } from '../../kb/vault-index.js';
import { sanitizeMcpError } from './sanitize.js';
import type { FollowWikilinksDeps } from './follow-wikilinks.js';

export function buildProductionFollowWikilinksDeps(): FollowWikilinksDeps {
  return {
    getVaultIndexStatus,
    queryVaultIndex,
    sanitizeError: sanitizeMcpError,
  };
}
