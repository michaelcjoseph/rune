# Configuration Reference

Full environment-variable descriptions, the `logs/` file inventory, and `policies/` files. `CLAUDE.md` carries a name + one-line table; the detailed semantics live here.

Env vars are loaded from `.env.local` via `--env-file-if-exists` in npm scripts (no dotenv dependency). Defaults live in `src/config.ts`.

---

## Required

- **`TELEGRAM_BOT_TOKEN`** — from @BotFather.
- **`TELEGRAM_USER_ID`** — numeric ID from @userinfobot.
- **`VAULT_DIR`** — path to Obsidian vault.

## Integrations (optional)

- **`FAMILY_NAMES`** — comma-separated names scanned by `/family` (e.g. `Alice,Bob`). Empty disables the command.
- **`IMPLICIT_CRM_NAMES`** — comma-separated wikilink slugs (e.g. `sam,jude`) the nightly daily-tags analyzer treats as implicit CRM references — a journal mention like `[[sam]]` produces a CRM update for that contact even without an explicit `#crm` tag. Empty disables the rule.
- **`WHOOP_CLIENT_ID`**, **`WHOOP_CLIENT_SECRET`** — Whoop OAuth credentials.
- **`READWISE_TOKEN`** — Readwise Reader API.
- **`LENNY_MCP_TOKEN`** — JWT Bearer token for the Lenny MCP server (`https://mcp.lennysdata.com/mcp`). Required for `/library-sync` and the nightly Library sync step.

## HTTP / webview

- **`RUNE_HTTP_SECRET`** — shared secret for authenticated HTTP endpoints.
- **`MCP_ISSUER_URL`** — legacy pinned issuer base URL for the old web-process `/mcp` OAuth metadata. The standalone MCP daemon uses `RUNE_MCP_ISSUER_URL`.
- **`OBSIDIAN_VAULT_NAME`** — optional, defaults to basename of `VAULT_DIR`; injected into webview `<meta>` tag for Obsidian wikilink resolution.
- **`RUNE_ALLOWED_HOSTS`** — optional, defaults to `localhost,127.0.0.1`; host-guard allowlist for webview endpoints (`isAllowedHost`).

## Standalone MCP daemon

- **`RUNE_MCP_SECRET`** — human-approval gate secret for the standalone MCP daemon OAuth consent flow.
- **`RUNE_MCP_ISSUER_URL`** — pinned public issuer base URL for standalone MCP OAuth metadata (the Tailscale Funnel/Serve HTTPS hostname). Empty = metadata falls back to the request Host header for local use.
- **`RUNE_MCP_OAUTH_STORE_FILE`** — OAuth client/token store for the standalone MCP daemon; defaults to `logs/rune-mcp-oauth-store.json`.
- **`RUNE_MCP_HOST`** — bind host for the standalone MCP daemon; defaults to `127.0.0.1`.
- **`RUNE_MCP_PORT`** — bind port for the standalone MCP daemon; defaults to `3848`.

## Resolver

- **`RESOLVER_CONFIDENCE_THRESHOLD`** — minimum confidence for resolver to dispatch a skill (default `0.7`).
- **`RESOLVER_MIN_WORDS`** — minimum word count before resolver runs (default `5`).

## Workspace & autonomous work

- **`RUNE_WORKSPACE_DIR`** — absolute path to the workspace root (e.g. `/Users/you/workspace`, **not** `~/workspace` — the value is passed to `realpathSync`, which does not expand `~`). Read by `config.WORKSPACE_DIR` (falls back to `PROJECT_ROOT` when unset). When set, agents receive it as context and as the `RUNE_WORKSPACE_DIR` env var so they can read project files outside the vault.
- **`ORCHESTRATED_WORK_ENABLED`** — global toggle for the orchestrated-work dispatch path (default off — `false`); when `true`, the cockpit Start action routes to the `orchestrated-work` applier instead of the legacy `work-run` applier. A per-product `orchestratedMode: true/false` in `policies/products.json` overrides this default for that product. Read at dispatch time by `src/jobs/work-dispatch.ts` so no restart is needed when `products.json` is edited; config.ts reads the env var at boot.
- **`WORK_RUN_PER_PROJECT_CAP`** — max concurrent `work-run` mutations per project slug (default `1`, min `1`); also caps `orchestrated-work` runs.
- **`WORK_RUN_GLOBAL_CAP`** — max concurrent `work-run` mutations across all projects (default `2`, min `1`); also caps `orchestrated-work` runs.
- **`WORK_RUN_RETENTION_MAX_RUNS`** — max terminal work-run artifact dirs to keep under `logs/work-runs/` (default `3`, min `1`); enforced by `gcWorkRuns`.
- **`WORK_RUN_RETENTION_MAX_BYTES`** — max total bytes of terminal work-run artifact dirs (default `200 MB`, min `1`); pruning stops when both caps are satisfied.
- **`WORK_RUN_TERMINAL_DRAIN_MS`** — after a `/work --auto` agent emits a terminal `result`, how long (ms) the watchdog waits for the child to exit on its own before reaping the process group (default `30000`, min `1`); the child is never killed on `result` itself, only if it wedges past this window (project 15 P0.2).
- **`WORK_RUN_REAP_GRACE_MS`** — SIGTERM→SIGKILL grace (ms) when reaping a work-run process group (default `5000`, min `1`).
- **`WORK_RUN_QUIET_CANCEL_AFTER_MS`** — how long (ms) a run may stay quiet past the first quiet nudge before the backstop escalates to cancel/reap/finalize (default `1200000` = 20 min, min `1`; project 15 P2.7).
- **`WORK_RUN_MAX_RUNTIME_MS`** — hard ceiling (ms) after which a run is group-killed and finalized regardless of apparent liveness (default `7200000` = 2 h, min `1`; project 15 P2.7).
- **`WORK_RUN_GATE_COMMAND_TIMEOUT_MS`** — per validation-command budget (ms) in the gated-merge finalizer; a timeout is a red gate result, not a wedge (default `600000` = 10 min, min `1`; project 15 P1.5).
- **`PARKED_RUN_NUDGE_AFTER_MS`** — how long (ms) a parked (`blocked-on-human`) run may stay unreleased before the stall-check runner sends a ONE-TIME staleness nudge (default `86400000` = 24 h, min `1`; never triggers an auto-release; project 13 Phase 1b).
- **`WORKTREE_ROOT`** — directory where git worktrees are created per product/project (default `<project-root>/.worktrees`, gitignored); exposed via `config.WORKTREE_ROOT` (a getter — reads the env var at access time, so a process that sets it after config is first imported still sees the override).
- **`PRODUCTS_CONFIG_FILE`** — override for the per-product config path (default `<project-root>/policies/products.json`); exposed via `config.PRODUCTS_CONFIG_FILE` (a getter). Lets the live-acceptance harness point at a throwaway products.json; production leaves it unset.
- **`LAUNCHD_LABEL`** — launchd service label the cockpit "Restart server" button kickstarts (default `com.jarvis.daemon`); exposed via `config.LAUNCHD_LABEL`. Override if the daemon is loaded under a different label.

---

## `logs/` file inventory

`LOGS_DIR` is hardcoded to `<project-root>/logs/` (gitignored).

- **`logs/last-workout.json`** — most recent generated workout, written by `/workout`, consumed by `/done-workout`; exposed via `config.LAST_WORKOUT_FILE`.
- **`logs/agent-runs.jsonl`** — rolling JSONL log of every `runAgent()` invocation (`{agent, startedAt, durationMs, status}`), consumed by `getStateSnapshot()`.
- **`logs/mutations.jsonl`** — rolling JSONL log of every `MutationDescriptor` state transition, written by `src/jobs/mutations-log.ts`.
- **`logs/registry.json`** — intent-layer product/project registry, exposed via `config.REGISTRY_FILE`; always rebuildable (not source of truth).
- **`logs/intent-proposal-queue.json`** — journal-to-intent proposal queue (project 08), exposed via `config.INTENT_PROPOSAL_QUEUE_FILE`; pending entries surface in the webview's Pending Approvals panel and in review prep. Approving routes through `dispatchApprovalStatus` → `actionApprovedIntentProposal` (vault-intake appends a journal-sourced bullet to `projects/<product>.md`; roadmap/register-product paths throw "wire-up deferred" and leave the entry pending for retry).
- **`logs/egress-denials.jsonl`** — append-only audit of denied egress attempts (`src/jobs/egress-policy.ts`), exposed via `config.EGRESS_DENIAL_LOG`; advisory while `EGRESS_ENFORCEMENT_MODE` is `documented-gap`.
- **`logs/supervised-runs.json`** — persistent store for current `SupervisedRun[]` state (`src/jobs/supervision-store.ts`), exposed via `config.SUPERVISED_RUNS_FILE`; holds current state per run (not events) and is always rebuildable.
- **`logs/observation-interactions.jsonl`** — append-only per-interaction signals (`src/utils/observation-log.ts`); consumed by the observation sensor reader; `detail` must carry only structured metadata.
- **`logs/dispatch-log.jsonl`** — append-only audit of every multi-model dispatch attempt (`src/jobs/dispatch-runtime.ts`), exposed via `config.DISPATCH_LOG_FILE`.
- **`logs/planning-sessions.json`** — persistent store for active `StoredPlanningSession[]` (`src/reviews/planning.ts`), exposed via `config.PLANNING_SESSIONS_FILE`; restored at startup via `restorePlanningSessions()`.
- **`logs/work-runs/`** — root for per-work-run durable artifacts (project 11) — each run gets `<id>/` holding `transcript.jsonl`, `summary.json`, and (project 15) a `phase` file; exposed via `config.WORK_RUNS_DIR`.
- **`logs/work-runs/index.jsonl`** — rolling recent-work-runs index (one JSON row per terminated run); exposed via `config.WORK_RUNS_INDEX_FILE`.
- **`logs/backlog-mutations.jsonl`** — append-only audit of backlog `+` writes; written best-effort; exposed via `config.BACKLOG_MUTATIONS_FILE`.
- **`logs/promotions.jsonl`** — append-only durable promotion-job log (09-expand-cockpit), exposed via `config.PROMOTIONS_FILE`. **Unlike the best-effort audit logs it is the restart-replay source of truth** (a scaffolded-but-not-marked promotion is re-driven from it), so `appendPromotion` throws on a disk failure rather than swallowing it.
- **`logs/feedback.jsonl`** — machine-readable product-team feedback records (project 14 Phase 6), consumed nightly by `stepLearningLoop`; exposed via `config.FEEDBACK_FILE`.
- **`logs/feedback-processed.json`** — JSON Set of content-hash ids the learning loop has already post-mortemed (exactly-once); exposed via `config.FEEDBACK_PROCESSED_FILE`.
- **`logs/mcp-oauth-store.json`** — legacy web-process `/mcp` OAuth state, 0600, atomic; exposed via `config.MCP_OAUTH_STORE_FILE`.
- **`logs/rune-mcp-oauth-store.json`** — standalone MCP daemon OAuth state (clients + bearer tokens), 0600, atomic; exposed via `config.RUNE_MCP_OAUTH_STORE_FILE`. Revoke all = delete the file + restart the MCP daemon.

---

## `policies/`

Committed config (not runtime state) — editing it is not a deploy.

- **`policies/model-policy.json`** — declarative model registry + routing rules (aliases, providers, role-defaults, global-fallback); exposed via `config.MODEL_POLICY_FILE`. Carries fable (anthropic/claude) and gpt-5.5 (openai/codex) with product-team roleDefaults: judgment roles (pm, tech-lead, reviewer, designer) → fable; artifact roles (qa, coder) → gpt-5.5; reviewer/coder provider distinctness is enforced fail-closed at resolution time in `team-task-deps.ts`. `src/index.ts` loads and validates the policy at startup, failing fast on a malformed file. A missing file is tolerated — `runAgent()` falls back to `def.model ?? config.AGENT_MODEL`.
- **`policies/escalation-policy.json`** — declarative escalation rules; the escalation decision module (`src/intent/escalation.ts`) is pure over `(change, policy)` and **fails closed** on a missing/malformed file (escalates, never permits).
- **`policies/products.json`** — per-product sandbox config (repo path, base branch, credentials file, egress allowlist, optional `orchestratedMode` boolean); exposed via `config.PRODUCTS_CONFIG_FILE`; read at runtime by `src/jobs/sandbox-runtime.ts`.
