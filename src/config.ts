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
  WORKSPACE_DIR: optional('RUNE_WORKSPACE_DIR') ?? PROJECT_ROOT,

  READWISE_TOKEN: process.env['READWISE_TOKEN'] || '',
  LENNY_MCP_TOKEN: process.env['LENNY_MCP_TOKEN'] || '',

  WHOOP_CLIENT_ID: process.env['WHOOP_CLIENT_ID'] || '',
  WHOOP_CLIENT_SECRET: process.env['WHOOP_CLIENT_SECRET'] || '',

  RUNE_HTTP_SECRET: process.env['RUNE_HTTP_SECRET'] || '',

  /** Pinned issuer base URL for the /mcp OAuth metadata (e.g. the public
   *  tunnel hostname, https://rune-mcp.example.com). Empty = fall back to
   *  the request Host header (local use only — the header is caller-controlled). */
  MCP_ISSUER_URL: process.env['MCP_ISSUER_URL'] || '',

  /** Standalone MCP daemon OAuth gate secret. Kept separate from the webview
   *  `RUNE_HTTP_SECRET` so the cockpit process never owns MCP OAuth state. */
  RUNE_MCP_SECRET: process.env['RUNE_MCP_SECRET'] || '',

  /** Pinned public issuer URL for the standalone MCP daemon OAuth metadata. */
  RUNE_MCP_ISSUER_URL: process.env['RUNE_MCP_ISSUER_URL'] || '',

  get OBSIDIAN_VAULT_NAME() {
    return process.env['OBSIDIAN_VAULT_NAME'] || basename(this.VAULT_DIR);
  },

  RUNE_ALLOWED_HOSTS: new Set(
    (process.env['RUNE_ALLOWED_HOSTS'] || 'localhost,127.0.0.1')
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

  LOGS_DIR: optional('RUNE_LOGS_DIR') ?? join(PROJECT_ROOT, 'logs'),

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

  /** Per-user planning conversation state (project 08 Phase 6 A4.1) —
   *  the Planner's multi-turn session store, analogous to review sessions
   *  but for the idea-to-spec conversation. */
  get PLANNING_SESSIONS_FILE() {
    return join(this.LOGS_DIR, 'planning-sessions.json');
  },

  /** Durable snapshots of every distinct SpecArtifact a planning session
   *  produces — one file per revision. The planner store (above) gets
   *  wiped on `deletePlanningSession`; this directory keeps the full
   *  evolution trail so a spec can be recovered if the scaffold step
   *  fails silently. See docs/projects/08-intent-layer/agent-lessons.md
   *  for the incident this addresses. */
  get PLANNING_ARTIFACTS_DIR() {
    return join(this.LOGS_DIR, 'planning-artifacts');
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

  /** Persisted /mcp OAuth state (clients + tokens) so the Claude App
   *  connector survives a daemon restart (project 16). Holds bearer tokens —
   *  written 0600, gitignored. Revoke all access = delete this file + restart. */
  get MCP_OAUTH_STORE_FILE() {
    return join(this.LOGS_DIR, 'mcp-oauth-store.json');
  },

  /** Persisted OAuth state for the standalone MCP daemon. Separate from the
   *  legacy web-process MCP store so the daemon can survive cockpit restarts. */
  get RUNE_MCP_OAUTH_STORE_FILE() {
    return optional('RUNE_MCP_OAUTH_STORE_FILE') ?? join(this.LOGS_DIR, 'rune-mcp-oauth-store.json');
  },

  /** Per-minute MCP daemon metrics history (JSONL) — written by the daemon's
   *  metrics flusher (src/mcp/metrics-history.ts), read by the webview
   *  monitoring endpoint and the MCP watchdog. */
  get RUNE_MCP_METRICS_HISTORY_FILE() {
    return join(this.LOGS_DIR, 'rune-mcp-metrics-history.jsonl');
  },

  /** MCP watchdog alert state — written by the main-process watchdog runner
   *  (src/jobs/mcp-watchdog-runner.ts), read by the cockpit alert badge. */
  get MCP_WATCHDOG_STATE_FILE() {
    return join(this.LOGS_DIR, 'mcp-watchdog-state.json');
  },

  /** Append-only audit log of backlog `+` add writes (09-expand-cockpit). */
  get BACKLOG_MUTATIONS_FILE() {
    return join(this.LOGS_DIR, 'backlog-mutations.jsonl');
  },

  /** Append-only durable promotion job log — the planning→scaffold→mark-source chain
   *  (09-expand-cockpit). Replayed at startup to resume interrupted promotions. */
  get PROMOTIONS_FILE() {
    return join(this.LOGS_DIR, 'promotions.jsonl');
  },

  /** Append-only durable FixAttempt log for the cockpit Fix gate. */
  get FIX_ATTEMPTS_FILE() {
    return join(this.LOGS_DIR, 'fix-attempts.jsonl');
  },

  /** Declarative model selection policy (project 08). A committed repo file, not
   *  runtime state, so it lives under `policies/` rather than `LOGS_DIR`. */
  get MODEL_POLICY_FILE() {
    return join(PROJECT_ROOT, 'policies', 'model-policy.json');
  },

  /** Per-product config (repo path, base branch, credentials file, egress
   *  allowlist) consulted by `src/jobs/sandbox-runtime.ts`. Committed repo file,
   *  same shelf as `model-policy.json`. Overridable via the `PRODUCTS_CONFIG_FILE`
   *  env var (mirrors `WORKTREE_ROOT`) so the project-14 live-acceptance harness
   *  can point the orchestrated applier at a throwaway products.json without
   *  editing the committed file; defaults to `<PROJECT_ROOT>/policies/products.json`. */
  get PRODUCTS_CONFIG_FILE() {
    return optional('PRODUCTS_CONFIG_FILE') ?? join(PROJECT_ROOT, 'policies', 'products.json');
  },

  /** Declarative escalation policy (project 08). Same shelf as
   *  `model-policy.json` and `products.json` — committed repo config, not
   *  runtime state. Consumed by `src/intent/escalation.ts` (decision module)
   *  and `src/jobs/gen-eval-loop-runner.ts` (cap source). */
  get ESCALATION_POLICY_FILE() {
    return join(PROJECT_ROOT, 'policies', 'escalation-policy.json');
  },

  /** Root directory under which Regime B project worktrees live, one subtree
   *  per product (`<WORKTREE_ROOT>/<product>/<project>`). Defaults to
   *  `<PROJECT_ROOT>/.worktrees` (gitignored); override with the `WORKTREE_ROOT`
   *  env var to point at a host-level location (useful when running multiple
   *  Rune instances or when keeping worktrees off the indexed repo tree).
   *  A getter (not an eager property) so a process that sets the env var after
   *  this module is first imported — e.g. the project-14 live-acceptance harness
   *  redirecting worktrees into a temp dir — still sees the override; matches
   *  the `PRODUCTS_CONFIG_FILE` pattern. */
  get WORKTREE_ROOT() {
    return optional('WORKTREE_ROOT') ?? join(PROJECT_ROOT, '.worktrees');
  },

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

  /** Append-only JSONL log of every Layer 5 dispatch
   *  (project 08 Phase 6 A5.2). Written by
   *  `src/intent/dispatch-runtime.ts`'s `dispatchToExecutor` on every
   *  spawn — one line per dispatch with the target, model, provider, and
   *  completed/failed status. Used for cost attribution and the
   *  cross-model adjudication audit trail. */
  get DISPATCH_LOG_FILE() {
    return join(this.LOGS_DIR, 'dispatch-log.jsonl');
  },

  /** Append-only JSONL of machine-readable feedback records that drive the
   *  product-team learning loop (project 14, Phase 6). Each line is one record
   *  ({projectSlug, source, createdAt, issueSummary, evidence, ...}) consumed by
   *  the nightly post-mortem. Read torn-line-tolerantly; malformed records are
   *  skipped with a durable reason, never treated as no-feedback. */
  get FEEDBACK_FILE() {
    return join(this.LOGS_DIR, 'feedback.jsonl');
  },

  /** JSON set of content-hash ids for feedback records the learning loop has
   *  already run a post-mortem on (project 14, Phase 6). Lets the nightly step
   *  process each record exactly once instead of re-firing the post-mortem LLM
   *  call every pass — source-agnostic (id is a hash of the record content). */
  get FEEDBACK_PROCESSED_FILE() {
    return join(this.LOGS_DIR, 'feedback-processed.json');
  },

  /** Root directory for per-work-run durable artifacts (project 11). Each run
   *  gets a `<id>/` subdir holding `transcript.jsonl`, `summary.json`, and
   *  (Phase 3) forensics. Gitignored runtime state. */
  get WORK_RUNS_DIR() {
    return join(this.LOGS_DIR, 'work-runs');
  },

  /** Rolling recent-work-runs index (project 11) — one JSON row per terminated
   *  run, appended by `src/jobs/work-runner.ts`, read torn-line-tolerantly by
   *  `src/jobs/work-run-store.ts`'s `readRecentIndex`. */
  get WORK_RUNS_INDEX_FILE() {
    return join(this.WORK_RUNS_DIR, 'index.jsonl');
  },

  HTTP_PORT: 3847,
  HTTP_HOST: '127.0.0.1',

  RUNE_MCP_HOST: process.env['RUNE_MCP_HOST'] || '127.0.0.1',
  RUNE_MCP_PORT: parseNumericEnv('RUNE_MCP_PORT', 3848, { min: 0, max: 65535, integer: true }),
  RUNE_MCP_TOOL_TIMEOUT_MS: parseNumericEnv('RUNE_MCP_TOOL_TIMEOUT_MS', 30_000, { min: 1, integer: true }),

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
  DEFAULT_CHAT_MODEL: 'gpt-5.6-terra',
  CONVERSATION_MODEL: 'gpt-5.6-terra',
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
  WORK_RUN_GLOBAL_CAP: parseNumericEnv('WORK_RUN_GLOBAL_CAP', 4, { min: 1, integer: true }),

  /** Global default for the orchestrated-work dispatch toggle (project 14,
   *  Phase 5). When true, the cockpit Start action dispatches the Rune-owned
   *  orchestrated loop (`orchestrated-work` applier); when false (the default),
   *  it dispatches the legacy `/work --auto` (`work-run`) applier. A per-product
   *  `orchestratedMode` in `policies/products.json` overrides this default for
   *  that product. Default OFF so existing Start behavior is unchanged until an
   *  operator opts in — the orchestrated path stays the recorded, explicit
   *  choice rather than a silent rollout. */
  ORCHESTRATED_WORK_ENABLED: process.env['ORCHESTRATED_WORK_ENABLED'] === 'true',

  /** Retention caps for per-run work-run artifacts (transcripts + forensics +
   *  branch refs), enforced by `gcWorkRuns` (project 11 Phase 3). The prunable
   *  (terminal, unprotected) set is GC'd oldest-first to stay within BOTH a run
   *  count and a total byte ceiling. Spec open question: start at 3 runs and
   *  tune after use. Bytes default to 200 MB. */
  WORK_RUN_RETENTION_MAX_RUNS: parseNumericEnv('WORK_RUN_RETENTION_MAX_RUNS', 3, { min: 1, integer: true }),
  WORK_RUN_RETENTION_MAX_BYTES: parseNumericEnv('WORK_RUN_RETENTION_MAX_BYTES', 200 * 1024 * 1024, { min: 1, integer: true }),

  /** Work-run finalizer timing constants (project 15). All in ms, positive
   *  integers; an invalid override falls back to the spec default.
   *  - TERMINAL_DRAIN: after the agent emits a terminal `result`, how long to
   *    wait for the child to exit on its own before the watchdog reaps the
   *    group (P0.2). The child is NOT killed on `result` — only if it wedges.
   *  - REAP_GRACE: SIGTERM→SIGKILL grace when reaping the process group.
   *  - QUIET_CANCEL_AFTER: how long a run may stay quiet past the first nudge
   *    before the backstop actuator escalates to cancel/reap/finalize (P2.7).
   *  - MAX_RUNTIME: hard ceiling after which a run is group-killed and finalized
   *    regardless of apparent liveness (P2.7) — the keep-alive ticker can't
   *    defeat it. It is the ONLY total-elapsed backstop; the liveness/output
   *    clocks are recency-based and can't catch an alive-and-active-but-endless
   *    run. Default 8h: high enough not to cut a legitimately long orchestrated
   *    run, low enough to still stop a true runaway overnight. Distinct from the
   *    reconciler's presume-dead staleness (PRESUMED_DEAD_STALE_MS, decoupled so
   *    raising this ceiling doesn't also slow dead-run cleanup).
   *  - CLOSEOUT_COMMAND_TIMEOUT: per-task closeout validation budget.
   *  - GATE_COMMAND_TIMEOUT: per validation-command budget in the merge gate
   *    (P1.5); a timeout is a red gate result, not a wedge. */
  WORK_RUN_TERMINAL_DRAIN_MS: parseNumericEnv('WORK_RUN_TERMINAL_DRAIN_MS', 30_000, { min: 1, integer: true }),
  WORK_RUN_REAP_GRACE_MS: parseNumericEnv('WORK_RUN_REAP_GRACE_MS', 5_000, { min: 1, integer: true }),
  WORK_RUN_QUIET_CANCEL_AFTER_MS: parseNumericEnv('WORK_RUN_QUIET_CANCEL_AFTER_MS', 1_200_000, { min: 1, integer: true }),
  WORK_RUN_MAX_RUNTIME_MS: parseNumericEnv('WORK_RUN_MAX_RUNTIME_MS', 28_800_000, { min: 1, integer: true }),
  /** Project 13, Phase 1b — how long (ms) a parked (`blocked-on-human`) run may
   *  stay unreleased before the stall-check runner sends a ONE-TIME staleness
   *  nudge (never an auto-release; the worktree holds until a human releases it).
   *  Default 24h. */
  PARKED_RUN_NUDGE_AFTER_MS: parseNumericEnv('PARKED_RUN_NUDGE_AFTER_MS', 86_400_000, { min: 1, integer: true }),
  WORK_RUN_CLOSEOUT_COMMAND_TIMEOUT_MS: parseNumericEnv('WORK_RUN_CLOSEOUT_COMMAND_TIMEOUT_MS', 120_000, { min: 1, integer: true }),
  WORK_RUN_GATE_COMMAND_TIMEOUT_MS: parseNumericEnv('WORK_RUN_GATE_COMMAND_TIMEOUT_MS', 600_000, { min: 1, integer: true }),

  /** True when started with `NODE_ENV=production` — read by surfaces that
   *  want to cache static assets (the webview's index.html template) in
   *  prod and re-read on every request in dev so source edits show up
   *  without a server restart. `npm run start` sets NODE_ENV=production
   *  for the user; `npm run dev` deliberately leaves it unset. */
  IS_PRODUCTION: process.env['NODE_ENV'] === 'production',

  /** launchd service label used by the cockpit "Restart server" button to
   *  kickstart a relaunch (`launchctl kickstart -k gui/<uid>/<label>`). The
   *  plist's KeepAlive only respawns on crash, so a clean exit won't restart —
   *  kickstart is the explicit relaunch path. Override via the LAUNCHD_LABEL
   *  env var if the daemon is loaded under a different label. */
  LAUNCHD_LABEL: process.env['LAUNCHD_LABEL'] ?? 'com.jarvis.daemon',
} as const;

export default config;
