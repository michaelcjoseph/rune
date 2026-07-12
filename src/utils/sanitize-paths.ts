/**
 * Strip Rune's absolute host paths from a string before it is surfaced to a user (a chat reply,
 * an HTTP error body, the cockpit drawer). The full message is preserved in the structured logs;
 * this only scrubs the *user-facing* copy so the filesystem layout (and the host username embedded
 * in it) never leaks. Reads config at call-time so a test's config mock applies.
 *
 * Shared by the Telegram `/approve` path (`src/bot/commands/approve.ts`) and the webview approve
 * route (`src/server/webview.ts`), which previously each carried their own copy.
 */

import config, { PROJECT_ROOT } from '../config.js';
import { homedir } from 'node:os';

/** Replace VAULT_DIR / PROJECT_ROOT / WORKSPACE_DIR occurrences with `<vault>` / `<project>` /
 *  `<workspace>` placeholders. */
export function scrubAbsolutePaths(raw: string): string {
  let s = raw;
  if (config.VAULT_DIR) s = s.split(config.VAULT_DIR).join('<vault>');
  for (const projectPath of projectPathScrubCandidates()) {
    s = s.split(projectPath).join('<project>');
  }
  if (config.WORKSPACE_DIR) s = s.split(config.WORKSPACE_DIR).join('<workspace>');
  const home = homedir();
  if (home) s = s.split(home).join('<home>');
  return s;
}

function projectPathScrubCandidates(): string[] {
  const candidates = new Set<string>();
  if (PROJECT_ROOT) {
    candidates.add(PROJECT_ROOT);
    const worktreeMarker = '/.worktrees/';
    const markerIndex = PROJECT_ROOT.indexOf(worktreeMarker);
    if (markerIndex > 0) candidates.add(PROJECT_ROOT.slice(0, markerIndex));
  }
  return [...candidates].sort((a, b) => b.length - a.length);
}
