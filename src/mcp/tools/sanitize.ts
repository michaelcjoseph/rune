/**
 * Shared error-text sanitizer for the production deps bindings of the
 * App-surface MCP tools (project 16). Tool results eventually reach a
 * remote Claude App thread: strip absolute vault/project paths and redact
 * secrets (git push stderr can carry credential URLs).
 *
 * CONFIG-REQUIRED (scrubAbsolutePaths reads config) — import only from
 * *-deps.ts modules, never from the pure handlers.
 */

import { redactSecrets } from '../../jobs/work-run-transcript.js';
import { scrubAbsolutePaths } from '../../utils/sanitize-paths.js';

export function sanitizeMcpError(message: string): string {
  return redactSecrets(scrubAbsolutePaths(message));
}
