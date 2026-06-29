import { getVaultIndexStatus, queryVaultIndex } from '../../kb/vault-index.js';
import { sanitizeMcpError } from './sanitize.js';
import type { TagDateQueryDeps } from './tag-date-query.js';

export function buildProductionTagDateQueryDeps(): TagDateQueryDeps {
  return {
    getVaultIndexStatus,
    queryVaultIndex,
    sanitizeError: sanitizeMcpError,
  };
}
