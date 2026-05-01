import { runAgent } from '../ai/claude.js';
import { listVaultFiles, getFileModTime } from '../vault/files.js';
import { enqueue } from '../kb/engine.js';
import { createLogger } from '../utils/logger.js';
import config from '../config.js';

const log = createLogger('lenny-sync');

export interface LibrarySyncResult {
  status: 'success' | 'skipped' | 'error';
  detail: string;
}

export async function runLibrarySync(): Promise<LibrarySyncResult> {
  if (!config.LENNY_MCP_TOKEN) {
    return { status: 'skipped', detail: 'LENNY_MCP_TOKEN not set' };
  }

  const startMs = Date.now();
  const result = await runAgent('lenny-sync', '');

  if (result.error) {
    log.error('lenny-sync agent failed', { error: result.error });
    return { status: 'error', detail: result.error };
  }

  // Enqueue files written by the agent (mtime >= start of this call)
  const newFiles = listVaultFiles('library/lenny').filter((relativePath) => {
    const mtime = getFileModTime(relativePath);
    return mtime !== null && mtime.getTime() >= startMs;
  });

  for (const relativePath of newFiles) {
    enqueue(relativePath);
  }

  const firstLine = result.text?.split('\n')[0] ?? 'Done';
  const suffix = newFiles.length > 0 ? `, ${newFiles.length} file(s) enqueued for KB` : '';
  return { status: 'success', detail: `${firstLine}${suffix}` };
}
