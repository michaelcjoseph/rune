import { join } from 'node:path';
import { readVaultFile, listVaultDirEntries } from './files.js';
import type { WhoopDailyData } from '../integrations/whoop/types.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('vault/whoop-recent');
const WHOOP_DIR = 'health/whoop';
const DATE_FILE_PATTERN = /^\d{4}-\d{2}-\d{2}\.json$/;

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

  const days: WhoopDailyData[] = [];
  for (const filename of filenames) {
    const content = readVaultFile(join(WHOOP_DIR, filename));
    if (content === null) continue;
    let parsed: WhoopDailyData;
    try {
      parsed = JSON.parse(content) as WhoopDailyData;
    } catch (err) {
      log.debug('Skipping unparseable Whoop file', { filename, err: String(err) });
      continue;
    }
    if (typeof parsed?.date !== 'string') {
      log.debug('Skipping Whoop file with missing date field', { filename });
      continue;
    }
    days.push(parsed);
  }
  return days;
}
