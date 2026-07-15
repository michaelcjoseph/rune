/**
 * Launchd-safe PATH construction, shared by every child-process spawn
 * surface: sandboxed product agents (`jobs/credential-injector.ts`), gate
 * validation commands (`jobs/work-run-gate-runtime.ts`), and the legacy
 * `/work --auto` spawn (`jobs/work-runner.ts`). It lives in `utils/` — not
 * in the credential injector — because it has no secret-handling role and
 * is consumed by both sandboxed and non-sandboxed spawn paths.
 */

import { existsSync } from 'node:fs';
import { delimiter, dirname } from 'node:path';

/**
 * Construct a launchd-safe command path for spawned product processes.
 *
 * launchd commonly starts Rune with a sparse PATH, even when the Node process
 * itself came from a version manager. Put that Node installation first so its
 * sibling npm/npx remain available, retain the inherited custom path, and add
 * the conventional macOS tool locations used by Homebrew and system tools
 * (including rg). No secret-bearing environment variables are involved.
 */
export function buildToolchainPath(inheritedPath = process.env['PATH'] ?? ''): string {
  const preferred = [
    dirname(process.execPath),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
  ].filter(existsSync);
  const inherited = inheritedPath.split(delimiter).filter(Boolean);
  return [...new Set([...preferred, ...inherited])].join(delimiter);
}
