/**
 * Credential injector — builds the spawn-time `env` map for a sandboxed
 * Regime B run.
 *
 * Two invariants this module exists to enforce:
 *
 * 1. **Only the run's own product's credentials reach the child.** Per-product
 *    credentials live in a dotenv-style file at the path declared in
 *    `policies/products.json` (`credentialsFile`). This module reads only
 *    that file for a given sandbox; the `canReachCredential` contract from
 *    `src/intent/sandbox.ts` is asserted at injection time as defense in
 *    depth.
 *
 * 2. **Rune's own secrets in `process.env` never reach the child.** The
 *    parent's environment (TELEGRAM_BOT_TOKEN, READWISE_TOKEN, WHOOP_*, etc.)
 *    is **not** passed through wholesale the way the in-Rune Claude CLI
 *    spawn does. Instead a small allowlist of innocuous shell vars (PATH,
 *    HOME, USER, LANG, ...) is copied over, and the per-product credentials
 *    layer on top of that. A product can override PATH via its credentials
 *    file if needed.
 *
 * The injector is policy-pure and synchronous; it has no spawn responsibility
 * itself. Callers (the future gen-eval-loop runner, A3) merge the returned
 * map into their `spawn(..., { env })` call.
 *
 * See docs/projects/08-intent-layer/{spec.md §"Layer 4", tasks.md Phase 6 A1.2}.
 */

import { readFileSync } from 'node:fs';
import { VALID_SLUG, type SandboxSpec } from '../intent/sandbox.js';
import { getProductConfig, vitestCacheDirFor } from './sandbox-runtime.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('credential-injector');

// ---------------------------------------------------------------------------
// Default base env allowlist
// ---------------------------------------------------------------------------

/**
 * The base set of parent-environment keys copied into a sandboxed child's
 * env. Deliberately conservative — these are shell basics a typical CLI
 * needs, with nothing that carries application secrets. Callers can pass
 * their own `baseEnvKeys` to `buildSandboxEnv` to extend or restrict; a
 * per-product credentials file can add or override anything else.
 *
 * Notably **omitted** by design: Node version-manager keys (`NVM_DIR`,
 * `VOLTA_HOME`, `FNM_DIR`) and Codex-/Anthropic-specific keys
 * (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`). Callers running Node-toolchain or
 * cross-provider workloads should either extend `baseEnvKeys` for the
 * machine-wide case, or place those keys in the product's `.env` file for
 * the per-product case.
 */
export const DEFAULT_BASE_ENV_KEYS = [
  'PATH',
  'HOME',
  'USER',
  'LANG',
  'LC_ALL',
  'TERM',
  'SHELL',
  'TMPDIR',
] as const;

// ---------------------------------------------------------------------------
// Dotenv parser
// ---------------------------------------------------------------------------

/** Env-var key per POSIX convention — uppercase or underscore start, then
 *  uppercase / digit / underscore. Lowercase or mixed-case keys are skipped
 *  to avoid silently smuggling a typo'd key into the child. */
const VALID_ENV_KEY = /^[A-Z_][A-Z0-9_]*$/;

/**
 * Parse a dotenv-style file at `path`. Returns the parsed `{ KEY: VALUE }`
 * map; a missing file (ENOENT) returns `{}` without throwing so a product
 * that has no credentials wired yet still runs. Other I/O errors throw.
 *
 * Lines are tolerant by design:
 * - Blank lines and comment lines (leading `#` after whitespace) are skipped.
 * - Surrounding double or single quotes are stripped from the value.
 * - The line is split on the **first** `=` only, so `FOO=a=b=c` produces
 *   `{ FOO: 'a=b=c' }`.
 * - Malformed lines (no `=`, lowercase key, etc.) are logged and skipped —
 *   a single typo doesn't take down the whole file. Skipped lines surface
 *   as a missing key at the call site, which is the right failure mode.
 */
export function readCredentials(path: string): Record<string, string> {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }

  const out: Record<string, string> = {};
  for (const [i, rawLine] of raw.split('\n').entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const eq = line.indexOf('=');
    if (eq <= 0) {
      // eq === -1 (no `=`) and eq === 0 (empty key, e.g. `=VALUE`) both
      // reach here — neither is a valid env-var declaration.
      log.warn('readCredentials: skipping malformed line (no key)', { path, line: i + 1 });
      continue;
    }

    const key = line.slice(0, eq).trim();
    if (!VALID_ENV_KEY.test(key)) {
      // Key name omitted from the log to avoid disclosing key conventions
      // from a credentials file (the file itself is `0o600`, but the log
      // doesn't have to be).
      log.warn('readCredentials: skipping malformed line (invalid key)', { path, line: i + 1 });
      continue;
    }

    let value = line.slice(eq + 1).trim();
    // Length guard: a single-character value that IS a quote (e.g. `FOO="`)
    // must be preserved as the literal quote, not stripped to ''.
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Base env filter
// ---------------------------------------------------------------------------

/**
 * Return the subset of `process.env` whose keys are in `allowlist`. Keys not
 * present in `process.env` are omitted (no `KEY: undefined` entries).
 *
 * This is the gate that keeps Rune's own secrets (TELEGRAM_BOT_TOKEN,
 * READWISE_TOKEN, …) from reaching a sandboxed child — anything not in the
 * allowlist is dropped.
 */
export function getBaseEnv(allowlist: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of allowlist) {
    const value = process.env[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// buildSandboxEnv — the public injector
// ---------------------------------------------------------------------------

export interface BuildSandboxEnvOpts {
  /** Path to `policies/products.json`. */
  productsConfigPath: string;
  /** Override the base env allowlist. Default `DEFAULT_BASE_ENV_KEYS`. */
  baseEnvKeys?: readonly string[];
}

/**
 * Build the `env` map for a sandboxed run. Reads the product's credentials
 * file (per `policies/products.json`), filters `process.env` through the
 * allowlist, and merges — credentials win on key collision so a product
 * can override PATH or similar shell vars.
 *
 * **Synchronous by design.** This function is meant to be called during
 * pre-spawn setup (before `spawn()`), not from inside an async streaming
 * loop — the file reads would briefly block the shared event loop. The
 * gen-eval-loop runner (A3) calls this once per spawned run, at spawn time.
 *
 * Defense in depth: rejects a malformed `sandbox.product` slug before any
 * disk read. The `SandboxSpec` contract already constrains the slug via the
 * registry, but a hand-constructed spec with a traversal-laden or empty
 * product would otherwise reach `getProductConfig` and surface as a less
 * useful "product not found" error.
 */
export function buildSandboxEnv(
  sandbox: SandboxSpec,
  opts: BuildSandboxEnvOpts,
): Record<string, string> {
  // Catch a hand-constructed SandboxSpec with a bad product slug at the
  // boundary, not deep in the file-loading path.
  if (!VALID_SLUG.test(sandbox.product)) {
    throw new Error(
      `buildSandboxEnv: invalid sandbox.product slug '${sandbox.product}' — ` +
        'must be non-empty lowercase alphanumeric/hyphen with an alphanumeric first character',
    );
  }

  const product = getProductConfig(sandbox.product, opts.productsConfigPath);
  const baseEnvKeys = opts.baseEnvKeys ?? DEFAULT_BASE_ENV_KEYS;
  const baseEnv = getBaseEnv(baseEnvKeys);

  // An empty credentialsFile (the field was omitted from products.json) is
  // a distinct case from "file declared but missing on disk" — the former is
  // explicit no-credentials, the latter is "not wired yet." Don't conflate
  // them via the readCredentials ENOENT path.
  const creds = product.credentialsFile
    ? readCredentials(product.credentialsFile)
    : {};

  return {
    ...baseEnv,
    ...creds,
    // Rune owns this value: inherited/product values must never couple runs.
    RUNE_VITEST_CACHE_DIR: vitestCacheDirFor(sandbox.worktree),
  };
}
