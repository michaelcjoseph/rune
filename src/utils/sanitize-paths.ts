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

/** Replace configured host roots with stable user-facing placeholders. */
export function scrubAbsolutePaths(raw: string): string {
  let s = raw;
  if (config.VAULT_DIR) s = s.split(config.VAULT_DIR).join('<vault>');
  for (const projectPath of projectPathScrubCandidates()) {
    s = s.split(projectPath).join('<project>');
  }
  if (config.WORKSPACE_DIR) s = s.split(config.WORKSPACE_DIR).join('<workspace>');
  if (config.PRODUCT_CHAT_FALLBACK_ROOT) {
    s = s.split(config.PRODUCT_CHAT_FALLBACK_ROOT).join('<product-chat-workspace>');
  }
  const home = homedir();
  if (home) s = s.split(home).join('<home>');
  return s;
}

/** Replace remaining host-shaped Unix/Windows paths that are not one of Rune's
 * configured roots. The Unix prefixes are deliberately bounded so product
 * routes such as `/api/users` survive in model-authored prose.
 *
 * The `(?=\/|terminator|$)` lookahead after the prefix alternation is
 * load-bearing, not decoration. Without it the trailing `(?:\/…)?` group is
 * optional, so the engine happily matches a bare *prefix* of a longer segment
 * and stops: `/homelab/private-notes/secret.md` became
 * `<path>lab/private-notes/secret.md`, splicing the placeholder mid-word and
 * letting the rest of the path through. That is strictly worse than no
 * scrubbing at all, because the output *looks* redacted and so defeats visual
 * inspection. The lookahead forces the keyword to be a complete path segment;
 * ordered alternation still backtracks `repo` → `repos` when the longer
 * alternative is the real segment. A first segment that merely starts with a
 * reserved word (`/homelab`, `/repository`, `/etcd`) is not a host root and is
 * left alone, exactly like `/api/users`. */
export function scrubGenericAbsolutePaths(raw: string): string {
  return raw
    .replace(
      /(^|[\s([{:="'`,;])(?:file:\/\/\/[A-Za-z0-9._-]+(?:\/[^\s)\]}>,”,"'`;]*)?|\/(?:Users|home|private|tmp|var|opt|Volumes|Applications|usr|etc|workspace|workspaces|repo|repos)(?=\/|[\s)\]}>,”"'`;]|$)(?:\/[^\s)\]}>,”,"'`;]*)?)/g,
      '$1<path>',
    )
    .replace(/\b[A-Za-z]:\\[^\\\s]+(?:\\[^\s]*)?/g, '<path>');
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
