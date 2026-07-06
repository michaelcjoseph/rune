/**
 * Production dependency binding for the health read tool handlers.
 *
 * Kept separate from ./health-read.ts (the pure handlers) because this module
 * pulls src/config.ts transitively (vault files, whoop sync, Chicago time),
 * which requires env vars at import time — the handler module must stay
 * importable config-free so its unit suite runs anywhere. src/mcp/server.ts
 * imports THIS module lazily (dynamic import inside the tool handler) so
 * building the MCP server never forces a config load.
 */

import { readVaultFile } from '../../vault/files.js';
import { readWhoopRange } from '../../vault/whoop-recent.js';
import { readRecentWorkouts } from '../../vault/workouts.js';
import { ensureWhoopSyncedForToday } from '../../jobs/whoop-sync.js';
import { getTodayDate } from '../../utils/time.js';
import { sanitizeMcpError } from './sanitize.js';
import type { HealthReadDeps } from './health-read.js';

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Read + parse `health/whoop/{date}.json`; null on bad date, missing file,
 *  or corrupt/mis-shaped JSON (a data gap is a normal state, not an error). */
function readWhoopDay(date: string): unknown | null {
  if (!ISO_DATE_RE.test(date)) return null;
  const raw = readVaultFile(`health/whoop/${date}.json`);
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : null;
}

export function buildProductionHealthReadDeps(): HealthReadDeps {
  return {
    ensureSynced: () => ensureWhoopSyncedForToday(),
    readWhoopDay: async (date) => readWhoopDay(date),
    readWhoopRange: async (start, end) => readWhoopRange(start, end),
    readRecentWorkouts: async (days) => readRecentWorkouts(days),
    readVaultDoc: async (relPath) => readVaultFile(relPath),
    getTodayDate,
    sanitizeError: sanitizeMcpError,
  };
}
