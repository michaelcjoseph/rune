import { spawn } from 'node:child_process';
import config from '../config.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('server-restart');

export type RestartResult = { ok: true } | { ok: false; reason: string };

/**
 * Restart the Rune daemon by asking launchd to kill + relaunch it.
 *
 * The launchd plist sets `KeepAlive = { SuccessfulExit: false }`, so a clean
 * `process.exit(0)` would NOT respawn the server — only crashes respawn. The
 * explicit relaunch path is `launchctl kickstart -k gui/<uid>/<label>`, which
 * SIGTERMs the running job (→ our graceful shutdown in src/index.ts), then
 * relaunches it regardless of exit code.
 *
 * The launchctl child is spawned detached + unref'd so it outlives our own
 * SIGTERM — once it has handed the request to launchd, launchd drives the
 * kill+relaunch independently.
 *
 * Production-only: under `npm run dev` there is no launchd job for this
 * process, and the command would target the real prod daemon.
 */
export function restartServer(): RestartResult {
  if (!config.IS_PRODUCTION) return { ok: false, reason: 'not-production' };
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (uid === null) return { ok: false, reason: 'no-uid' };
  const target = `gui/${uid}/${config.LAUNCHD_LABEL}`;
  try {
    const child = spawn('launchctl', ['kickstart', '-k', target], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    log.info(`kickstart issued for ${target}`);
    return { ok: true };
  } catch (err) {
    log.error(`kickstart failed: ${String(err)}`);
    return { ok: false, reason: 'spawn-failed' };
  }
}
