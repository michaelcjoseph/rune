import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

function required(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env var: ${name}`);
  return val.startsWith('~/') ? join(homedir(), val.slice(2)) : val;
}

/** Parse an optional numeric env var with a safe fallback. A missing or
 *  malformed value (NaN, infinite, out of range) falls back to `fallback`
 *  rather than propagating as NaN, which would silently invert guard checks
 *  (e.g. `x < NaN` is always false). */
function parseNumericEnv(
  name: string,
  fallback: number,
  opts: { min?: number; max?: number; integer?: boolean } = {},
): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  if (opts.min !== undefined && parsed < opts.min) return fallback;
  if (opts.max !== undefined && parsed > opts.max) return fallback;
  return opts.integer ? Math.floor(parsed) : parsed;
}

export const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const config = {
  TELEGRAM_BOT_TOKEN: required('TELEGRAM_BOT_TOKEN'),
  TELEGRAM_USER_ID: Number(required('TELEGRAM_USER_ID')),

  VAULT_DIR: required('VAULT_DIR'),

  READWISE_TOKEN: process.env['READWISE_TOKEN'] || '',

  WHOOP_CLIENT_ID: process.env['WHOOP_CLIENT_ID'] || '',
  WHOOP_CLIENT_SECRET: process.env['WHOOP_CLIENT_SECRET'] || '',

  JARVIS_HTTP_SECRET: process.env['JARVIS_HTTP_SECRET'] || '',

  FAMILY_NAMES: (process.env['FAMILY_NAMES'] || '')
    .split(',').map(s => s.trim()).filter(Boolean),

  LOGS_DIR: join(PROJECT_ROOT, 'logs'),

  get SESSIONS_FILE() {
    return join(this.LOGS_DIR, 'tg-sessions.json');
  },

  get KNOWLEDGE_DIR() {
    return join(this.VAULT_DIR, 'knowledge');
  },

  get INGESTION_QUEUE_FILE() {
    return join(this.LOGS_DIR, 'kb-ingestion-queue.json');
  },

  get PLAYBOOK_QUEUE_FILE() {
    return join(this.LOGS_DIR, 'playbook-queue.json');
  },

  get REVIEW_SESSIONS_FILE() {
    return join(this.LOGS_DIR, 'review-sessions.json');
  },

  HTTP_PORT: 3847,
  HTTP_HOST: '127.0.0.1',

  CLAUDE_TIMEOUT_MS: 300_000,
  CLAUDE_LINT_TIMEOUT_MS: 300_000,
  /** wiki-compiler ingests can be heavy on real-sized journals + project files
   *  (read source + index + schema + analyze + write multiple wiki pages + log).
   *  Empirically 5 min isn't enough; 15 min gives generous headroom. */
  CLAUDE_INGEST_TIMEOUT_MS: 900_000,
  /** Short timeout for the resolver's inline classify call — users feel this
   *  latency on every non-slash TG message. If Haiku hasn't returned in 20s,
   *  we fall through to the existing freeform handler. */
  CLASSIFIER_TIMEOUT_MS: 20_000,
  DEFAULT_CHAT_MODEL: 'haiku',
  CONVERSATION_MODEL: 'opus',
  ONESHOT_MODEL: 'sonnet',
  AGENT_MODEL: 'opus',
  CLASSIFIER_MODEL: 'haiku',

  /** Resolver routes to a skill when confidence ≥ this threshold; otherwise
   *  falls through to the freeform conversation handler. Falls back to the
   *  default when the env var parses to NaN or lands outside [0, 1], so a bad
   *  config doesn't silently disable the confidence gate. */
  RESOLVER_CONFIDENCE_THRESHOLD: parseNumericEnv('RESOLVER_CONFIDENCE_THRESHOLD', 0.7, { min: 0, max: 1 }),
  /** If top-1 and top-2 are within this delta, the resolver treats the call
   *  as ambiguous and falls through. */
  RESOLVER_AMBIGUITY_DELTA: 0.05,
  /** Resolver is skipped for messages with fewer than this many words —
   *  short messages rarely encode a routable intent and aren't worth the
   *  Haiku call. */
  RESOLVER_MIN_WORDS: parseNumericEnv('RESOLVER_MIN_WORDS', 5, { min: 0, integer: true }),
  TG_MAX_MESSAGE_LENGTH: 4096,
  TIMEZONE: 'America/Chicago',
} as const;

export default config;
