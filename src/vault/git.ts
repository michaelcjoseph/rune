import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import config from '../config.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('git');

const execFile = promisify(execFileCb);

const execOpts = {
  cwd: config.VAULT_DIR,
  timeout: 15_000,
};

export async function gitCommitAndPush(message: string): Promise<void> {
  try {
    await execFile('git', ['add', '-A'], execOpts);
    await execFile('git', ['commit', '-m', message], execOpts);
  } catch (err) {
    const stderr = (err as { stderr?: string })?.stderr || '';
    if (!stderr.includes('nothing to commit')) {
      log.error('Git commit error', { error: (err as Error).message });
    }
    return;
  }

  try {
    await execFile('git', ['push'], execOpts);
  } catch (err) {
    log.error('Git push error', { error: (err as Error).message });
  }
}
