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

/** Replace VAULT_DIR / PROJECT_ROOT / WORKSPACE_DIR occurrences with `<vault>` / `<project>` /
 *  `<workspace>` placeholders. */
export function scrubAbsolutePaths(raw: string): string {
  let s = raw;
  if (config.VAULT_DIR) s = s.split(config.VAULT_DIR).join('<vault>');
  if (PROJECT_ROOT) s = s.split(PROJECT_ROOT).join('<project>');
  if (config.WORKSPACE_DIR) s = s.split(config.WORKSPACE_DIR).join('<workspace>');
  return s;
}
