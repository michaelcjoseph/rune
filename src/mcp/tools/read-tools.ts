/**
 * Read-tools trio for the Claude App connector — project 16, Phase 1
 * (spec R2, tech-spec tool table, test-plan §5):
 *
 * - `vault_search` — search markdown content across the whole vault.
 * - `crm_lookup`   — look up a person/company from pages/crm.json.
 * - `get_priorities` — today's (falling back to yesterday's) `#priorities`
 *   block, reusing the parseTag parsing the /priorities command uses. The
 *   day resolution deliberately departs from the command's yesterday
 *   default: a mid-thread App call wants the freshest priorities.
 *
 * PURE MODULE: effects are injected per-handler; production bindings live
 * in ./read-tools-deps.ts (config-required), loaded lazily by server.ts.
 */

import { parseTag } from '../../vault/journal-parse.js';
import { errText, ok, err, type McpTextResult } from './types.js';

// ---------------------------------------------------------------------------
// vault_search
// ---------------------------------------------------------------------------

export type VaultSearchType = string;

export interface VaultSearchInput {
  query: string;
  types?: VaultSearchType[];
  maxResults?: number;
}

export interface VaultSearchDeps {
  /** The existing src/kb/search.ts searchVault (ripgrep over the vault). */
  searchVault: (
    query: string,
    options?: { directory?: string; maxResults?: number },
  ) => Array<{ file: string; line: number; content: string }>;
  /** Optional error-text sanitizer (production binds sanitizeMcpError). */
  sanitizeError?: (message: string) => string;
}

function cleanTopLevelPrefix(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('/') || trimmed === '.' || trimmed === '..') return null;
  if (trimmed.includes('/') || trimmed.includes('\\')) return null;
  return trimmed;
}

export async function vaultSearch(
  input: VaultSearchInput,
  deps: VaultSearchDeps,
): Promise<McpTextResult> {
  const clean = deps.sanitizeError ?? ((s: string) => s);
  const query = typeof input.query === 'string' ? input.query.trim() : '';
  if (query === '') {
    return err('Missing or empty query — nothing was searched.');
  }

  try {
    const lines: string[] = [];
    if (!input.types || input.types.length === 0) {
      const results = deps.searchVault(query, {
        maxResults: input.maxResults,
      });
      for (const r of results) {
        lines.push(`${r.file}:${r.line} — ${r.content}`);
      }
    } else {
      const directories = Array.from(
        new Set(input.types.map(cleanTopLevelPrefix).filter((t): t is string => t !== null)),
      );
      for (const directory of directories) {
        const results = deps.searchVault(query, {
          directory,
          maxResults: input.maxResults,
        });
        for (const r of results) {
          lines.push(`${r.file}:${r.line} — ${r.content}`);
        }
      }
    }

    if (lines.length === 0) return ok('No results found.');
    // maxResults caps the TOTAL output (the per-call forward is an
    // efficiency hint) — a caller asking for 5 must not get 15.
    const capped = input.maxResults !== undefined ? lines.slice(0, input.maxResults) : lines;
    return ok(capped.join('\n'));
  } catch (unexpected) {
    return err(`vault_search failed: ${clean(errText(unexpected))}`);
  }
}

// ---------------------------------------------------------------------------
// crm_lookup
// ---------------------------------------------------------------------------

export interface CrmLookupInput {
  name: string;
}

export interface CrmLookupDeps {
  /** Vault file reader (src/vault/files.ts readVaultFile in production). */
  readVaultFile: (rel: string) => string | null;
  /** Optional error-text sanitizer (production binds sanitizeMcpError). */
  sanitizeError?: (message: string) => string;
}

const CRM_PATH = 'pages/crm.json';
const NO_CRM_MATCH = 'No CRM match found.';

export async function crmLookup(input: CrmLookupInput, deps: CrmLookupDeps): Promise<McpTextResult> {
  const clean = deps.sanitizeError ?? ((s: string) => s);
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (name === '') {
    return err('Missing or empty name — nothing was looked up.');
  }

  try {
    const raw = deps.readVaultFile(CRM_PATH);
    if (raw === null) return ok(NO_CRM_MATCH);

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return ok(`${NO_CRM_MATCH} (CRM data could not be parsed.)`);
    }
    if (!Array.isArray(parsed)) return ok(NO_CRM_MATCH);

    const needle = name.toLowerCase();
    const matches = parsed.filter((entry) => {
      if (entry === null || typeof entry !== 'object') return false;
      const entryName = (entry as Record<string, unknown>).name;
      return typeof entryName === 'string' && entryName.toLowerCase().includes(needle);
    });

    if (matches.length === 0) return ok(NO_CRM_MATCH);
    return ok(JSON.stringify(matches, null, 2));
  } catch (unexpected) {
    return err(`crm_lookup failed: ${clean(errText(unexpected))}`);
  }
}

// ---------------------------------------------------------------------------
// get_priorities
// ---------------------------------------------------------------------------

export interface GetPrioritiesDeps {
  /** Vault file reader (readVaultFile in production). */
  readVaultFile: (rel: string) => string | null;
  getTodayFilename: () => string;
  getYesterdayFilename: () => string;
  /** Optional error-text sanitizer (production binds sanitizeMcpError). */
  sanitizeError?: (message: string) => string;
}

/** Read a journal file and extract its #priorities block, or null. */
function prioritiesFrom(deps: GetPrioritiesDeps, filename: string): string | null {
  const content = deps.readVaultFile(`journals/${filename}`);
  if (!content?.trim()) return null;
  // parseTag returns trimmed text or null; '' (empty block) is falsy → null.
  return parseTag(content, 'priorities') || null;
}

export async function getPriorities(deps: GetPrioritiesDeps): Promise<McpTextResult> {
  const clean = deps.sanitizeError ?? ((s: string) => s);
  try {
    const today = prioritiesFrom(deps, deps.getTodayFilename());
    if (today !== null) return ok(`Today's priorities:\n\n${today}`);

    const yesterday = prioritiesFrom(deps, deps.getYesterdayFilename());
    if (yesterday !== null) return ok(`Yesterday's priorities (none set today):\n\n${yesterday}`);

    return ok('No priorities found in today\'s or yesterday\'s journal.');
  } catch (unexpected) {
    return err(`get_priorities failed: ${clean(errText(unexpected))}`);
  }
}
