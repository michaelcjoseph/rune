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

/**
 * SIGTERM→SIGKILL escalation grace, shortened for tests only.
 *
 * The production default is 5,000ms (`config.ts`), and the reaping/timeout
 * tests in `work-run-gate-runtime.test.ts` wait that full grace on real child
 * processes — real wall-clock, since the waits happen inside spawned children
 * where fake timers cannot reach. Several such waits run concurrently across
 * the suite and starve the time-budgeted attestation tests, whose 30s
 * `ATTESTATION_COMMAND_TIMEOUT_MS` then expires: that is the intermittent
 * "prevents escaped product config…" / "uses the production isolated
 * observer…" failure, which moved between runs because the whole class was
 * marginal rather than one test being wrong.
 *
 * 400ms still proves the escalation semantics (SIGTERM first, SIGKILL after
 * the grace) — only the wait shrinks. Measured: full suite 89s with an
 * intermittent failure → 30s green; `work-run-gate-runtime.test.ts` alone
 * 45.5s → 22.7s. `??=` keeps any explicit override, including a longer grace
 * on a slow machine.
 */
process.env['WORK_RUN_REAP_GRACE_MS'] ??= '400';
