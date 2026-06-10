/**
 * Production dependency binding for the `log_idea` MCP tool handler.
 *
 * Kept separate from ./log-idea.ts (the pure handler) because this module
 * pulls src/config.ts, which requires env vars at import time — the handler
 * module must stay importable config-free so its unit suite runs anywhere.
 * src/mcp/server.ts imports THIS module lazily (dynamic import inside the
 * tool handler) so building the MCP server never forces a config load.
 */

import { existsSync, readFileSync, appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import config from '../../config.js';
import { readProductsConfig } from '../../jobs/sandbox-runtime.js';
import {
  readFiledIdeas,
  appendFiledIdeas,
  LOOP_FILED_HEADER,
  LOOP_FILED_SECTION_RE,
} from '../../intent/observation-ideas-io.js';
import { withFileLock } from '../../intent/backlog-write-lock.js';
import { gitCommitAndPushOrThrow } from '../../vault/git.js';
import { redactSecrets } from '../../jobs/work-run-transcript.js';
import { scrubAbsolutePaths } from '../../utils/sanitize-paths.js';
import type { LogIdeaDeps } from './log-idea.js';

/** Ensure `ideasPath` exists and contains the `## Loop-filed` section that
 *  `appendFiledIdeas` appends under. The vault's projects/ideas.md predates
 *  this tool, so the section is created on first use rather than treated as
 *  an error (mirrors the journal primitive initializing a missing file). */
export function ensureLoopFiledSection(ideasPath: string): void {
  if (!existsSync(ideasPath)) {
    writeFileSync(ideasPath, `${LOOP_FILED_HEADER}\n`, 'utf8');
    return;
  }
  const raw = readFileSync(ideasPath, 'utf8');
  if (!raw.split('\n').some((line) => LOOP_FILED_SECTION_RE.test(line))) {
    const sep = raw.endsWith('\n') ? '\n' : '\n\n';
    appendFileSync(ideasPath, `${sep}${LOOP_FILED_HEADER}\n`, 'utf8');
  }
}

/** Error-text sanitizer for messages that surface to the (eventually
 *  remote) App caller: strip vault/project absolute paths, redact secrets
 *  (git push stderr can carry credential URLs). */
function sanitizeError(message: string): string {
  return redactSecrets(scrubAbsolutePaths(message));
}

/** Build the live deps bag: vault projects/ideas.md (tech-spec R3 — the
 *  same git history the nightly pipeline reads), products.json routing, and
 *  the strict (throwing) vault commit helper. Reads config at call time.
 *
 *  The ensure+append pair runs under a per-file mutex: the MCP endpoint is
 *  callable concurrently and appendFiledIdeas is read-modify-write — an
 *  unlocked interleaving silently drops a bullet. (The dedupe read in the
 *  handler stays outside the lock; worst case there is a benign duplicate,
 *  never a lost write.) */
export function buildProductionLogIdeaDeps(): LogIdeaDeps {
  const ideasPath = join(config.VAULT_DIR, 'projects', 'ideas.md');
  return {
    ideasPath,
    loadKnownProducts: () => Object.keys(readProductsConfig(config.PRODUCTS_CONFIG_FILE)),
    readFiledIdeas,
    appendFiledIdeas: (path, markdown) =>
      withFileLock(path, async () => {
        ensureLoopFiledSection(path);
        appendFiledIdeas(path, markdown);
      }),
    commitAndPush: async (message) => {
      await gitCommitAndPushOrThrow(message);
    },
    sanitizeError,
  };
}
