import { execFileSync } from 'node:child_process';
import config from '../config.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('git');

const execOpts = {
  cwd: config.VAULT_DIR,
  timeout: 15_000,
  stdio: 'pipe' as const,
};

export function gitCommitAndPush(message: string): void {
  try {
    execFileSync('git', ['add', '-A'], execOpts);
    execFileSync('git', ['commit', '-m', message], execOpts);
  } catch (err) {
    const stderr = (err as { stderr?: Buffer })?.stderr?.toString() || '';
    if (!stderr.includes('nothing to commit')) {
      log.error('Git commit error', { error: (err as Error).message });
    }
    return;
  }

  try {
    execFileSync('git', ['push'], execOpts);
  } catch (err) {
    log.error('Git push error', { error: (err as Error).message });
  }
}
