# Rune

Always-on personal second brain server. TypeScript/Node.js. A single Node.js process that connects a Telegram bot to the **pkms vault** (`~/workspace/pkms`) via the Claude Code CLI, and doubles as an autonomous product-team orchestration platform.

> **Maintenance note:** A line earns its place in this file only if it changes what Claude *does* in a typical session — a convention/invariant that prevents wrong code, a map that orients navigation, or a pointer to where detail lives. Forensic history ("project 13 Phase 1c"), exhaustive parameter/endpoint enumeration, and per-file mechanics belong in `docs/architecture/`, not here. Keep this file lean (~15KB); it is loaded into every session and every spawned subagent.

## Architecture

A single Node.js process handles everything:

- **Telegram bot** (polling) — chat, commands, content triage, photos; free-form messages are classified by a Haiku resolver and routed to a skill, else fall through to multi-turn conversation.
- **HTTP server** (localhost:3847) — health endpoint, session capture, Whoop OAuth, and the **webview/cockpit** at `/` (cookie auth + host-guard): a vanilla HTML/JS chat UI plus a cockpit sidebar (per-product/project lifecycle + run status + action buttons), backlog drawer, planning panel, pending-approvals, product deep-view, and a real-time run-feed. REST + WebSocket.
- **Chat scoping** (`src/vault/sessions.ts` `buildSessionSystemPrompt`) — a **global** chat (Telegram / cockpit Home) is the read-only vault thinking-partner. A **product** chat (cockpit per-product chat, webview-only — TG never gets product scope) is a write-enabled development agent for that product: repo-root cwd + `PRODUCT_CHAT_TOOLS` (Edit/Write/Bash). **Containment is soft, not OS-enforced:** the spawn uses `--dangerously-skip-permissions`, under which `--add-dir`/`writableRoots` do NOT restrict writes and Bash has full filesystem access — so the narrowed `writableRoots` (`repoPath/scopePath` for scoped products) and the `product-chat` env scrub (`scrubProductChatEnv`, drops Rune secrets + personal env) are *defense-in-depth*, not boundaries. Vault-write and Rune-secret protection rest on the system prompt + the vault's git recoverability; the vault is read-only via the `rune-kb` MCP. **This is a deliberate, accepted posture** (single-user, localhost, cookie-authed surface — same access level as the operator running Claude Code): the product chat is intentionally a full-trust local agent, NOT a sandboxed one. A hard OS guarantee would need `sandbox-exec` (deny vault writes + secret-file reads); intentionally not wired. Don't "fix" the soft boundary as if it were an oversight — re-decide with the operator first.
- **MCP daemon** (localhost:3848) — standalone Streamable HTTP MCP service at `/mcp` plus daemon `/health`, with separate OAuth config/store so cockpit restarts do not drop Claude App MCP sessions.
- **MCP watchdog** — a 60s main-process tick probes the daemon's `/health` + trailing metrics history and alerts via Telegram on daemon-down/degraded/error-spike/tool-failures (6h cooldown, one-time recovery notices); the cockpit's redesigned monitoring tab renders the same composed state via `GET /api/mcp/monitoring`. → `docs/architecture/subsystems.md`.
- **In-flight op tracking** — every `execClaude()` spawn registers an `InFlightOp` and emits bus frames; TG shows a "🤔 · /cancel" tracker, the webview a cancellable pill. → `docs/architecture/subsystems.md`.
- **Mutation pipeline** (`src/transport/mutations.ts`) — the central registry for autonomous codebase ops. Appliers: `workRunApplier` (legacy `/work --auto`), `genEvalLoopApplier`, `orchestratedWorkApplier` (product-team agents), `workRunReleaseApplier`. Every transition logs to `logs/mutations.jsonl` and drives `supervision-store.ts`. → `docs/architecture/subsystems.md`.
- **Work-run lifecycle** — work runs stream a durable transcript, classify on work product, and finalize through a gated-merge finalizer (project 11/13/15). Supervision + stall-check monitor liveness; parked runs wait for a human release. → `docs/architecture/subsystems.md`; full `/plan`→merged stage-by-stage map (agents/gates/criteria) → `docs/architecture/project-lifecycle.md`.
- **Scheduled jobs** (node-cron) — morning prep, Whoop sync, the 18-step nightly orchestrator, review nudges.
- **Review system** — interview-based reviews (daily/weekly/monthly/quarterly/yearly) + health/blog + PM-led planning conversations (`/plan`). Free-form text routes to an active planning or review session, else to Socratic chat. → `docs/architecture/reviews-kb-vault.md`.
- **Knowledge base engine** — Karpathy-style LLM wiki (raw sources → compiled wiki pages); two-layer search (LLM index → ripgrep), no vector DB; exposed locally via the `rune-kb` stdio MCP server.

All AI operations use the Claude Code CLI (Max subscription, no API key). Custom agents in `.claude/agents/` handle structured operations; multi-model dispatch can route to Codex for cross-model work.

**Agent split:** this repo's `.claude/agents/` holds **generic tooling agents** (no personal specifics, public). The pkms vault's `.claude/agents/` holds **personal-specifics agents** (review-writer, journal-scanner, project-scanner). `loadAgentDef` checks this repo's dir first, then the vault's.

## Reference docs

Detailed reference, read on demand (not loaded every session):

- `docs/architecture/module-reference.md` — per-file annotations for every `src/` module + project-phase history.
- `docs/architecture/subsystems.md` — deep mechanics: mutation pipeline, supervision/stall-check, work-run lifecycle + gated-merge finalizer, orchestrated work + product-team roles, observation loop, MCP/OAuth.
- `docs/architecture/project-lifecycle.md` — end-to-end project lifecycle `/plan`→merged: every stage's primary agent, reviewing gate, and advance-criteria (planning pipeline, per-task role workflow, closeout, merge gate, terminal states).
- `docs/architecture/reviews-kb-vault.md` — review→post-agent flow, worldview/playbook write rules, KB raw-source routing, writer/role memory loops.
- `docs/architecture/configuration.md` — full env-var reference + `logs/` file inventory + `policies/` files.
- `docs/projects/index.md` — numbered build log (01–18); per-project `spec.md` / `tasks.md` / `test-plan.md`.
- `docs/projects/templates/planning-checklist.md` — pre-implementation decomposition pass for new projects/phases.

## Module map

`src/` layout (deep per-file detail → `docs/architecture/module-reference.md`):

- **`index.ts`, `config.ts`** — entry point (boot + recovery sequence) + typed env config.
- **`ai/`** — all Claude/Codex CLI spawning (`claude.ts` is the only Claude spawn chokepoint) + tool labels.
- **`bot/`** — Telegram bot, slash-command handlers (`commands/`), free-form resolver, skill registry.
- **`transport/`** — `MessageSender` (TG + webview), notification bus, mutation pipeline, in-flight op tracking, approval actions.
- **`reviews/`** — session-based reviews (daily…yearly, health, blog) + planning sessions.
- **`server/`** — HTTP, webview/cockpit + REST API, MCP transport + OAuth, auth, snapshots.
- **`kb/`** — knowledge base engine (ingest/query/lint/search/queue/seed + deterministic index repair).
- **`jobs/`** — scheduler, nightly, work-run runners + finalizer + classify/transcript/forensics/GC, supervision, stall-check, gen-eval-loop, orchestrated-work, sandbox runtime, learning loop.
- **`intent/`** — registry, planner, orchestration (orch-*, team-task, project-orchestrator), backlog, promotions, multi-model dispatch, observation loop, sandbox/egress/model/escalation policy, cockpit projection.
- **`mcp/`** — MCP server factory + per-tool handlers (`tools/`) + call metrics/history.
- **`study/`** — spaced-repetition engine.
- **`health/`** — workout-generation pipeline + last-workout artifact, shared by `/workout`/`/done-workout` and the MCP health tools.
- **`integrations/`** — telegram / whoop / readwise clients.
- **`vault/`, `workspace/`** — guarded file accessors (`readVaultFile`/`writeVaultFile` etc.), journal, git, sessions, voice.
- **`writer/`, `roles/`** — role-agent SOUL + memory loaders (writer + six product-team roles).
- **`utils/`** — time (America/Chicago), logging, path scrubbing, telemetry logs.
- **`cli/`** — local CLI · **`scripts/`** — dev tools (evals, intent-scan, backfill) · **`policies/`** — model/escalation/products config.

## Commands

One file per command in `src/bot/commands/`. Free-form messages are classified against this set by the Haiku resolver (slash form is always a fallback/override).

| Command | Purpose |
|---|---|
| `/fresh`, `/fresh-full`, `/clear` | Close a chat session (summarize+journal / verbatim / discard); all abandon any active planning session |
| `/journal <text>` | Append a literal entry to today's journal |
| `/ask`, `/kb` | One-shot Claude question / KB query (legacy escape hatches) |
| `/ingest`, `/seed`, `/library-sync` | Enqueue a vault file / bulk-seed KB / sync Lenny posts+podcasts |
| `/status`, `/cancel [opId]` | System health / SIGTERM an in-flight op |
| `/prep`, `/priorities` | Morning prep / review-set daily priorities |
| `/daily`…`/yearly`, `/health`, `/blog` | Interview-based review + drafting sessions |
| `/plan [product]`, `/approve` | Start a PM-led scoping conversation → approve the PM spec / run downstream planning + scaffold |
| `/cancel-review`, `/active-context` | Cancel an in-progress review / show active orchestration context |
| `/workout [home\|gym]`, `/done-workout` | Generate a tailored workout / log it to the journal |
| `/study`, `/syllabus` | Spaced-repetition quiz / study syllabus progress |
| `/family`, `/career` | Family scan / career reflection |
| `/learn <text>`, `/learn-list` | Append a runtime learning (auto-prepended to agents) / list them |

`/approve` is wired in `dispatchText` but excluded from `SLASH_COMMAND_METADATA` (approval is an explicit gate, not resolver-inferred).

## Vault Content Model

The vault has four LLM-mutable content layers with **different write semantics**. They stay distinct on purpose — each has its own cadence, tone, and audit trail. Collapsing them would force one schema to handle conflicting temporal models (wiki pages decay; convictions evolve with audit trail; playbook is append-only; projects are living logs).

| Layer | Write semantics | Updater agent | Trigger |
|---|---|---|---|
| `knowledge/` | Wiki with `last-verified` + `valid-until` — pages decay | `wiki-compiler` | KB ingestion queue (nightly + on-demand) |
| `world-view/*.md` | First-person essays with `### [[YYYY_MM_DD]]` changelog — beliefs evolve with audit trail | `worldview-updater` | Review outline approval (propose-only, never auto-writes) |
| `pages/playbook.md` | Append-only tactical entries with stable `<slug>-<YYYY-MM-DD>` anchors | `playbook-proposer` + `playbook-updater` | `#playbook` journal tag → nightly queue → next review approval |
| `projects/*.md` | Living logs: status + dated thesis + decisions log + weekly summaries | `project-updater` | Review outline approval (authoritative) |

Plus `pages/psychology.md` (living profile, `psychology-updater` with scope gradient) and JSON data stores (`pages/{books,crm,places}.json`, `health/workouts.json`, `career/applications.json`, `investments/investments.json`, `study/progress.json`) updated by `json-updater`.

**Relationship:** `knowledge/` is the neutral reference layer and *cites* the other three as raw sources (via `knowledge/raw/{world-view,playbook,projects}/`). The flow is one-way — human-authored layers feed the KB as sources; the KB does not own them.

`writing/voice.md` is the user-authored writing-voice source, read on every prose-producing Claude call. Review→post-agent flow, worldview propose-only rule, playbook extraction, KB raw-source routing, and the writer/product-team memory loops are all in `docs/architecture/reviews-kb-vault.md`.

## Key Conventions

- **TypeScript** runs directly through `node --import ./scripts/register-ts.mjs` (a local `module.registerHooks()` loader) — no build step for dev or prod. **ESM** (`"type": "module"`) — all imports use `.js` extensions.
- All timestamps use `America/Chicago` (`src/utils/time.ts`). Config reads from env vars; defaults in `src/config.ts`.
- **Claude CLI spawning is centralized in `src/ai/claude.ts`** — never spawn `claude` directly elsewhere. `CLAUDE_BIN`, `registerActiveProcess`, and `unregisterActiveProcess` keep binary resolution + shutdown tracking centralized for external spawners. Codex spawns go through `src/ai/codex.ts`.
- **Message delivery uses the `MessageSender` interface** (`src/transport/sender.ts`) — handlers and commands never import `TelegramBot` directly for sending; bot is only passed where needed for file downloads (photo handler).
- Vault files use `readVaultFile` / `writeVaultFile` / `appendVaultFile` (`src/vault/files.ts`) — paths relative to vault root, boundary-asserted. Workspace files use the `src/workspace/files.ts` equivalents. KB agents **must not** write outside `knowledge/`.
- **Autonomous codebase operations go through the mutation pipeline** (`src/transport/mutations.ts`) — register a `MutationApplier`, call `createMutation()`; never spawn Claude CLI for project work directly. Supervision writes are fail-safe (errors logged, never propagated).
- Model selection is policy-driven (`src/intent/model-policy.ts`, `policies/model-policy.json`) — which model runs an agent is declared, not hardcoded. A missing policy falls back to `def.model ?? config.AGENT_MODEL`.
- MCP tool timeouts are per-call via `RUNE_MCP_TOOL_TIMEOUT_MS` (default 30s); a tool needing longer runtime (e.g. one that spawns an agent) registers an override in `TOOL_TIMEOUT_OVERRIDES_MS` (`src/mcp/metrics.ts`) rather than raising the global default.
- Session locks prevent concurrent CLI writes to the same session ID. Git commits happen at key moments (morning prep, `/fresh`, nightly), not on timers.
- Project work is **test-first**: QA authors required tests at the start of each task before the coder implements it; each task lands green before closeout. See `docs/projects/templates/`.
- **User-reachability is the definition of done.** A task is complete only when a user can trigger it from a real surface (cockpit, Telegram, cron, CLI) and observe its outcome — not when its tests pass against a pure module. Before drafting `tasks.md`/`test-plan.md` for a new project or phase, run through `docs/projects/templates/planning-checklist.md`. The retrospective at `docs/projects/08-intent-layer/agent-lessons.md` is the case study.

### Invariants (any change must preserve these)

- **Credentials:** only a run's own product credentials reach a sandboxed child; Rune's own secrets (`TELEGRAM_BOT_TOKEN`, etc.) never reach the child (`src/jobs/credential-injector.ts`).
- **No personal content over trust boundaries:** dispatch handoff `context` must never carry vault personal content when target is `codex` (`src/intent/dispatch.ts`); observation-log `detail` carries only structured metadata, never raw user content (`src/utils/observation-log.ts`).
- **Path scrubbing:** scrub absolute paths via `scrubAbsolutePaths` before surfacing any message to a user surface (chat reply, HTTP error body — `src/utils/sanitize-paths.ts`); scrub host paths before classification reaches `mutations.jsonl`/bus. The un-scrubbed `operatorWorktreePath` is **local-operator-only** — it must never reach `mutations.jsonl`/summary/index/transcript/forensics (it is delivered verbatim only to Telegram `TELEGRAM_USER_ID` and the localhost cockpit WS).
- **Durability:** `appendPromotion` (`src/intent/promotions.ts`) **throws** on disk failure — `logs/promotions.jsonl` is the restart-replay source of truth, distinct from every other best-effort JSONL log.
- **Single writers / branch guards:** `context-curator.ts` is the ONLY writer of `context.md`. Git commits happen only on `main` (single-chokepoint branch guard in `src/vault/git.ts`, mirrored in the writer/role commit helpers). `supervision-store.upsertRun` field-merges so a heartbeat can't clear `quietNudgedAt`.

### Dev rules

- **Adding a nightly step:** update `nightly.test.ts`'s step-count + ordered step-name snapshot (and any positional `steps[i]` index), and check `nightly.nosleep.test.ts`'s narrow `node:child_process` mock (it stubs `spawn` only — a step that transitively imports `execFile` makes the whole module fail to import as "0 test").
- **Structural changes** (new module/command/agent/env var/script) → run the `docs-sync` agent: it maintains `docs/architecture/module-reference.md` and the area-level module map + command list here, never a per-file tree in this file.

## Running

```bash
npm run dev          # node --watch + local TS loader
npm run start        # production
npm run mcp:start    # standalone MCP daemon
npm run build        # type-check only (no emit)
npm run test         # vitest run
npm run cli          # local CLI interface
npm run evals        # run agent eval YAMLs
npm run intent-scan       # Ask-Twice intent scan
npm run library-backfill  # bulk-ingest library entries into the KB
npm run dispatch-review   # multi-model dispatch troubleshooting
npm run acceptance:orchestrated  # LIVE orchestrated-work end-to-end proof (real models; exit 0 = pass)
npm run acceptance:cockpit-real  # LIVE cockpit + real-product acceptance
```

## Environment Variables

Loaded from `.env.local` via `--env-file-if-exists`. Defaults in `src/config.ts`. Full descriptions → `docs/architecture/configuration.md`. `LOGS_DIR` is hardcoded to `<project-root>/logs/` (gitignored).

| Variable | Purpose |
|---|---|
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_USER_ID`, `VAULT_DIR` | **Required** — bot token, your numeric ID, vault path |
| `FAMILY_NAMES`, `IMPLICIT_CRM_NAMES` | Enable `/family` / implicit-CRM journal mentions |
| `WHOOP_CLIENT_ID`/`_SECRET`, `READWISE_TOKEN`, `LENNY_MCP_TOKEN` | Integration credentials |
| `RUNE_HTTP_SECRET` | Webview auth |
| `RUNE_MCP_SECRET`, `RUNE_MCP_ISSUER_URL`, `RUNE_MCP_OAUTH_STORE_FILE`, `RUNE_MCP_HOST`, `RUNE_MCP_PORT`, `RUNE_MCP_TOOL_TIMEOUT_MS` | Standalone MCP daemon auth/store/bind/metrics config |
| `MCP_ISSUER_URL` | Legacy web-process MCP issuer setting; standalone daemon uses `RUNE_MCP_ISSUER_URL` |
| `OBSIDIAN_VAULT_NAME`, `RUNE_ALLOWED_HOSTS` | Webview vault display name / host-guard allowlist |
| `RESOLVER_CONFIDENCE_THRESHOLD`, `RESOLVER_MIN_WORDS` | Resolver dispatch threshold / min word count |
| `RUNE_WORKSPACE_DIR` | Absolute workspace root for autonomous ops (no `~` expansion) |
| `ORCHESTRATED_WORK_ENABLED` | Global toggle for orchestrated-work dispatch (default off; per-product `orchestratedMode` overrides) |
| `WORK_RUN_*` | Concurrency caps, retention GC, reaping/drain grace, quiet-cancel + max-runtime ceilings, gate timeout |
| `PARKED_RUN_NUDGE_AFTER_MS` | One-time staleness nudge for a parked run (never auto-releases) |
| `WORKTREE_ROOT`, `PRODUCTS_CONFIG_FILE`, `LAUNCHD_LABEL` | Worktree root / per-product config path / launchd label (all getters) |

## Agents

Runtime agents are spawned by Rune via `runAgent()`; dev-tooling agents are used by `/work` and `/review`. Full purposes are in each `.claude/agents/*.md` file.

**Runtime (generic tooling, this repo):** wiki-compiler, kb-query, wiki-linter, morning-prep, session-summarizer, release-notes, content-triager, note-triage, photo-classifier, system-scanner, project-updater, playbook-proposer, playbook-updater, proposal-updater, worldview-updater, psychology-updater, json-updater, daily-content-updater, intent-scan, workout-generator, lenny-sync, sr-question-generator, sr-grader, project-setup-writer.

**Vault-resident (personal specifics, `$VAULT_DIR/.claude/agents/`):** journal-scanner, project-scanner, review-writer.

**Dev tooling (`/work` + `/review` skills):** test-specialist, code-reviewer, security-auditor, architecture-reviewer, code-simplifier, docs-sync.

**Product-team roles (project 14, `agents/<role>/` SOUL + memory):** pm, tech-lead, qa, coder, reviewer, designer. Plus the writer role (`agents/writer/`). → `docs/architecture/subsystems.md` and `reviews-kb-vault.md`.

## MCP Server

- **Local (`rune-kb`)** — the KB is exposed as a stdio MCP server registered in `.claude/settings.json`, so any Claude Code session on the machine can use `kb_query`, `kb_search`, `kb_ingest`, `kb_stats`, `kb_lint` plus the health/workout tool set (`HEALTH_TOOLS`, 15 tools total). Standalone: `node --env-file-if-exists=.env.local --import ./scripts/register-ts.mjs src/mcp/index.ts`.
- **Remote (`/mcp` Claude App connector)** — standalone daemon serving App-surface plus W1 content/utility plus health/workout tools (20 tools total; kb_* admin tools never remotely reachable) over Streamable HTTP with single-user OAuth 2.1, plus metrics-history persistence + watchdog alerting. → `docs/architecture/subsystems.md`.

## Reference

- `_old/` contains the original JS implementation — use as reference, do not modify. `_old/docs/system/` has subsystem docs (telegram-bot, whoop-sync, morning-prep, nightly-processing, readwise-scanner, infrastructure).
