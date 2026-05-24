import { basename, dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

function required(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env var: ${name}`);
  return val.startsWith('~/') ? join(homedir(), val.slice(2)) : val;
}

function optional(name: string): string | undefined {
  const val = process.env[name];
  if (!val) return undefined;
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
  WORKSPACE_DIR: optional('WORKSPACE_DIR'),

  READWISE_TOKEN: process.env['READWISE_TOKEN'] || '',
  LENNY_MCP_TOKEN: process.env['LENNY_MCP_TOKEN'] || '',

  WHOOP_CLIENT_ID: process.env['WHOOP_CLIENT_ID'] || '',
  WHOOP_CLIENT_SECRET: process.env['WHOOP_CLIENT_SECRET'] || '',

  JARVIS_HTTP_SECRET: process.env['JARVIS_HTTP_SECRET'] || '',

  get OBSIDIAN_VAULT_NAME() {
    return process.env['OBSIDIAN_VAULT_NAME'] || basename(this.VAULT_DIR);
  },

  JARVIS_ALLOWED_HOSTS: new Set(
    (process.env['JARVIS_ALLOWED_HOSTS'] || 'localhost,127.0.0.1')
      .split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
  ),

  FAMILY_NAMES: (process.env['FAMILY_NAMES'] || '')
    .split(',').map(s => s.trim()).filter(Boolean),

  /** Wikilink slugs (e.g. `sam,jude`) the daily-tags analyzer treats as
   *  implicit CRM references — a journal mention like `[[sam]]` produces a
   *  CRM update for that contact even without an explicit `#crm` tag. Empty
   *  disables the rule. Keep names out of source so the repo stays shareable. */
  IMPLICIT_CRM_NAMES: (process.env['IMPLICIT_CRM_NAMES'] || '')
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

  get PROPOSAL_QUEUE_FILE() {
    return join(this.LOGS_DIR, 'proposal-queue.json');
  },

  get REVIEW_SESSIONS_FILE() {
    return join(this.LOGS_DIR, 'review-sessions.json');
  },

  get LAST_WORKOUT_FILE() {
    return join(this.LOGS_DIR, 'last-workout.json');
  },

  get CLAUDE_STREAM_LOG() {
    return join(this.LOGS_DIR, 'claude-stream.jsonl');
  },

  get REGISTRY_FILE() {
    return join(this.LOGS_DIR, 'registry.json');
  },

  /** Declarative model selection policy (project 08). A committed repo file, not
   *  runtime state, so it lives under `policies/` rather than `LOGS_DIR`. */
  get MODEL_POLICY_FILE() {
    return join(PROJECT_ROOT, 'policies', 'model-policy.json');
  },

  /** Per-product config (repo path, base branch, credentials file, egress
   *  allowlist) consulted by `src/jobs/sandbox-runtime.ts`. Committed repo file,
   *  same shelf as `model-policy.json`. */
  get PRODUCTS_CONFIG_FILE() {
    return join(PROJECT_ROOT, 'policies', 'products.json');
  },

  /** Root directory under which Regime B project worktrees live, one subtree
   *  per product (`<WORKTREE_ROOT>/<product>/<project>`). Defaults to
   *  `<PROJECT_ROOT>/.worktrees` (gitignored); override with the `WORKTREE_ROOT`
   *  env var to point at a host-level location (useful when running multiple
   *  jarvis instances or when keeping worktrees off the indexed repo tree). */
  WORKTREE_ROOT: optional('WORKTREE_ROOT') ?? join(PROJECT_ROOT, '.worktrees'),

  /** Journal-to-intent proposal queue (project 08) — runtime state, gitignored. */
  get INTENT_PROPOSAL_QUEUE_FILE() {
    return join(this.LOGS_DIR, 'intent-proposal-queue.json');
  },

  /** Audit log for denied egress attempts from sandboxed Regime B runs
   *  (project 08 Phase 6 A1.3). Written by `src/jobs/egress-policy.ts`
   *  on every `checkEgress` deny. While the enforcement mode is
   *  `documented-gap`, this is also the telemetry signal that decides
   *  when to promote to `proxy-enforced`. */
  get EGRESS_DENIAL_LOG() {
    return join(this.LOGS_DIR, 'egress-denials.jsonl');
  },

  /** Persistent store of the current SupervisedRun[] state
   *  (project 08 Phase 6 A2.1). Written by `src/jobs/supervision-store.ts`
   *  on every run state transition; read by the visibility surface and the
   *  startup recovery pass. Holds current state per run, not events. */
  get SUPERVISED_RUNS_FILE() {
    return join(this.LOGS_DIR, 'supervised-runs.json');
  },

  HTTP_PORT: 3847,
  HTTP_HOST: '127.0.0.1',

  CLAUDE_TIMEOUT_MS: 1_800_000,
  CLAUDE_LINT_TIMEOUT_MS: 300_000,
  /** wiki-compiler ingests can be heavy on real-sized journals + project files
   *  (read source + index + schema + analyze + write multiple wiki pages + log).
   *  Matches CLAUDE_TIMEOUT_MS today but kept as a separate knob so ingest
   *  timeouts can diverge from the generic default without touching everything. */
  CLAUDE_INGEST_TIMEOUT_MS: 1_800_000,
  /** Resolver's inline classify call runs on every non-slash TG message —
   *  users feel this latency. 60s gives Opus room to respond; if it hasn't
   *  returned by then we fall through to the existing freeform handler. */
  CLASSIFIER_TIMEOUT_MS: 60_000,
  /** Timeout for the weekly intent-scan Haiku one-shot. Offline, so longer
   *  than the resolver, but much shorter than CLAUDE_TIMEOUT_MS (which is
   *  scoped to Opus agent runs that read/write vault files). */
  HAIKU_SCAN_TIMEOUT_MS: 60_000,
  DEFAULT_CHAT_MODEL: 'opus',
  CONVERSATION_MODEL: 'opus',
  ONESHOT_MODEL: 'opus',
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

  WORK_RUN_PER_PROJECT_CAP: parseNumericEnv('WORK_RUN_PER_PROJECT_CAP', 1, { min: 1, integer: true }),
  WORK_RUN_GLOBAL_CAP: parseNumericEnv('WORK_RUN_GLOBAL_CAP', 2, { min: 1, integer: true }),
} as const;

export default config;
