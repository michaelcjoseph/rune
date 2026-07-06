import { join } from 'node:path';
import { readVaultFile, listVaultDirEntries } from './files.js';
import type { WhoopDailyData } from '../integrations/whoop/types.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('vault/whoop-recent');
const WHOOP_DIR = 'health/whoop';
const DATE_FILE_PATTERN = /^\d{4}-\d{2}-\d{2}\.json$/;

/** Parse the given `health/whoop/` day filenames (assumed already filtered +
 *  ordered) into WhoopDailyData objects. Files that fail to parse, have an
 *  unexpected shape, or lack a valid `date` field are skipped (logged at
 *  debug). */
function parseWhoopDayFiles(filenames: string[]): WhoopDailyData[] {
  const days: WhoopDailyData[] = [];
  for (const filename of filenames) {
    const content = readVaultFile(join(WHOOP_DIR, filename));
    if (content === null) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (err) {
      log.debug('Skipping unparseable Whoop file', { filename, err: String(err) });
      continue;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      log.debug('Skipping Whoop file with unexpected shape', { filename });
      continue;
    }
    if (typeof (parsed as { date?: unknown }).date !== 'string') {
      log.debug('Skipping Whoop file with missing date field', { filename });
      continue;
    }
    days.push(parsed as WhoopDailyData);
  }
  return days;
}

/** Read the `n` most recent Whoop daily JSONs from `health/whoop/`, ordered
 *  newest-first. Filenames must match `YYYY-MM-DD.json`. Files that fail to
 *  parse or lack a valid `date` field are skipped (logged at debug). Empty /
 *  missing directory → []. */
export function readRecentWhoopDays(n: number): WhoopDailyData[] {
  if (n <= 0) return [];

  const filenames = listVaultDirEntries(WHOOP_DIR)
    .filter((name) => DATE_FILE_PATTERN.test(name))
    .sort()
    .reverse()
    .slice(0, n);

  return parseWhoopDayFiles(filenames);
}

/** Read the Whoop daily JSONs whose filename date falls inside the inclusive
 *  `[start, end]` range (both `YYYY-MM-DD`), ordered newest-first. Corrupt or
 *  shape-invalid files are skipped, matching {@link readRecentWhoopDays};
 *  missing days simply don't appear. Empty / missing directory → []. */
export function readWhoopRange(start: string, end: string): WhoopDailyData[] {
  const filenames = listVaultDirEntries(WHOOP_DIR)
    .filter((name) => DATE_FILE_PATTERN.test(name))
    .filter((name) => {
      const date = name.slice(0, 10);
      return date >= start && date <= end;
    })
    .sort()
    .reverse();

  return parseWhoopDayFiles(filenames);
}
