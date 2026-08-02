import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env['TELEGRAM_BOT_TOKEN'] ??= 'test-token';
process.env['TELEGRAM_USER_ID'] ??= '12345';
process.env['VAULT_DIR'] ??= '/tmp/rune-test-vault';
process.env['RUNE_HTTP_SECRET'] ??= 'test-secret';

/**
 * Tests must never persist run state into the real repository's `logs/`.
 *
 * `logs/` is gitignored, so it does NOT exist in the trusted Vitest observer's
 * materialized reviewed tree, and that tree is read-only under the observer's
 * Seatbelt profile. A test that writes supervision or mutation state there
 * therefore passes in the worktree and fails only under the observer — the
 * exact divergence that made every full-suite receipt red while `npm test` was
 * green.
 *
 * One fixed directory rather than a per-file temp dir: files already shared a
 * single `logs/`, so this preserves the existing semantics exactly and cannot
 * leak a new directory per test file. `??=` keeps any explicit override, and
 * `config.test.ts` deletes the variable outright when it asserts the default.
 */
process.env['RUNE_LOGS_DIR'] ??= join(tmpdir(), 'rune-test-logs');
mkdirSync(process.env['RUNE_LOGS_DIR']!, { recursive: true });
