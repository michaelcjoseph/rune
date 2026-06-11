/**
 * File persistence for the /mcp OAuth state (project 16) — the production
 * binding for createMcpOAuth's loadState/saveState seam. Keeps registered
 * clients + issued tokens across a daemon restart so the Claude App
 * authenticates ONCE and survives every cockpit-restart until the operator
 * explicitly revokes (delete the store file + restart).
 *
 * The store holds bearer tokens, so the file is written 0600 and lives under
 * the gitignored logs/ dir. Both functions are best-effort: a read failure
 * starts empty, a write failure degrades to in-memory-only (works until the
 * next restart) — neither throws into the request path.
 */

import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import type { PersistedOAuthState } from './mcp-oauth.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('mcp-oauth-store');

const FILE_MODE = 0o600;

export function readOAuthStore(path: string): PersistedOAuthState | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    // Shape guard — a corrupt store starts empty rather than crashing.
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      !Array.isArray((parsed as PersistedOAuthState).clients) ||
      !Array.isArray((parsed as PersistedOAuthState).tokens)
    ) {
      log.warn('OAuth store has unexpected shape; starting empty', { path });
      return null;
    }
    const raw = parsed as PersistedOAuthState;
    // Per-element validation: drop malformed entries so a corrupt/hand-edited
    // store can never inject a token whose non-numeric expiresAt would slip the
    // `expiresAt <= now()` check (NaN comparison) and read as never-expiring.
    const clients = raw.clients.filter(
      (c) =>
        c && typeof c.clientId === 'string' && Array.isArray(c.redirectUris) &&
        c.redirectUris.every((u) => typeof u === 'string'),
    );
    const tokens = raw.tokens.filter(
      (t) =>
        t && typeof t.token === 'string' && typeof t.userId === 'string' &&
        (t.expiresAt === null || typeof t.expiresAt === 'number'),
    );
    return { clients, tokens };
  } catch (err) {
    log.warn('Failed to read OAuth store; starting empty', { path, error: (err as Error).message });
    return null;
  }
}

export function writeOAuthStore(path: string, state: PersistedOAuthState): void {
  try {
    const tmp = `${path}.tmp`;
    // Atomic temp-then-rename; 0600 on the temp file carries through the rename.
    writeFileSync(tmp, JSON.stringify(state), { mode: FILE_MODE });
    renameSync(tmp, path);
  } catch (err) {
    log.error('Failed to write OAuth store (tokens kept in memory only)', {
      path,
      error: (err as Error).message,
    });
  }
}
