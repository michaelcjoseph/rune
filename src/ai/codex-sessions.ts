import { existsSync, readdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

const THREAD_ID = /^[A-Za-z0-9-]{8,128}$/;

/** Remove Codex rollout files for a thread Rune is deliberately forgetting.
 * Codex has no CLI delete command; filenames include the thread UUID. */
export function cleanupCodexThread(
  threadId: string,
  codexHome = process.env['CODEX_HOME'] || join(homedir(), '.codex'),
): number {
  if (!THREAD_ID.test(threadId)) return 0;
  const root = join(codexHome, 'sessions');
  if (!existsSync(root)) return 0;
  let removed = 0;
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && basename(path).includes(threadId)) {
        rmSync(path, { force: true });
        removed += 1;
      }
    }
  };
  try {
    walk(root);
  } catch {
    // Cleanup is best-effort. Losing a chat must never break /fresh or /clear.
  }
  return removed;
}
