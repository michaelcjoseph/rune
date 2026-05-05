# Jarvis

Always-on personal second brain server. TypeScript/Node.js.

## Architecture

Single Node.js process handles everything:
- **Telegram bot** (polling mode) — chat, commands, content triage, photos
- **HTTP server** (localhost:3847) — health endpoint, session capture for nightly; webview UI (Phase B) serves a vanilla HTML/JS chat interface at `/` with cookie auth, REST endpoints (`POST /api/mutations`, `POST /api/mutations/:id/cancel`), and a WebSocket for real-time messaging
- **Mutation pipeline** — `src/transport/mutations.ts` is the central registry for autonomous codebase operations (MutationDescriptor, applier registry, createMutation/cancelMutation). `workRunApplier` in `src/jobs/work-runner.ts` is the first applier: spawns Claude CLI with `spec.md + tasks.md + /work --auto` for a project slug. Mutations are logged append-only to `logs/mutations.jsonl`; orphaned `running` entries are flipped to `failed` at startup via `reconcileOrphans()`.
- **Scheduled jobs** (node-cron) — morning prep, Whoop sync, nightly processing, review nudges
- **Review system** — multi-phase session-based reviews (daily/weekly/monthly/quarterly/yearly) + health/blog sessions. Free-form Telegram messages default to a multi-turn Socratic chat (`handleConversation` in `src/bot/handlers/text.ts`) — `/fresh` or a journal write closes the thread.
- **Knowledge base engine** — Karpathy-style LLM wiki (raw sources → compiled wiki pages)

All AI operations use Claude Code CLI (Max subscription, no API key needed). Custom agents in `.claude/agents/` handle structured KB operations (wiki-compiler, kb-query, wiki-linter).

The server reads/writes to an Obsidian vault synced via iCloud. The vault has four distinct LLM-mutable content layers (knowledge/, world-view/, pages/playbook.md, projects/) plus JSON data stores and `pages/psychology.md`, each with its own write semantics and updater agent. See the **Vault Content Model** section below.

## Project Structure

```
src/
├── index.ts                 # Entry point: boots HTTP server, Telegram bot, scheduler
├── config.ts                # Typed env vars and constants
├── ai/claude.ts             # All Claude CLI spawning: askClaude, runAgent, summarizeSession; exports setBus(bus) — called from index.ts so runAgent() can emit BusAgentEvent frames (type-only NotificationBus import avoids circular dep); runAgent() appends {agent, startedAt, durationMs, status} to logs/agent-runs.jsonl after each invocation; exports CLAUDE_BIN (resolved binary path), registerActiveProcess/unregisterActiveProcess (for external spawners like work-runner)
├── bot/
│   ├── telegram.ts          # Bot init: createBot() factory + wireHandlers(bot, sender) wires message events after senders are ready
│   ├── handlers/text.ts     # Command routing + multi-turn conversation handler; handleTextMessage(sender, msg) — no direct bot dependency; exports dispatchText(sender, userId, text) shared with webview
│   ├── handlers/url.ts      # URL detection, fetch, content-triager agent, routing
│   ├── handlers/photo.ts    # Photo download, photo-classifier agent, routing
│   ├── skill-registry.ts    # Resolver skill registry: SkillEntry, SLASH_COMMAND_METADATA, buildSkillRegistry, getSkillRegistry (cached), reloadSkillRegistry
│   ├── resolver.ts          # Classify free-form TG messages against skill registry via Haiku; returns ClassifyResult {skill, args, confidence, second_skill, second_confidence, ambiguous}
│   └── commands/
│       ├── fresh.ts         # /fresh — summarize active chat, append to journal, optionally enqueue KB-worthy summary, commit, reset session. Exports `closeConversation` helper reused by /journal.
│       ├── fresh-full.ts    # /fresh-full — verbatim conversation transcript logging (no summarization)
│       ├── clear.ts         # /clear — discard active session without journaling
│       ├── journal.ts       # /journal — append literal entry to today's journal; if a chat session is active, also calls closeConversation (mirrors /fresh)
│       ├── ask.ts           # /ask — one-shot freeform Claude question (legacy escape hatch; no longer a resolver route)
│       ├── kb.ts            # /kb — one-shot knowledge base query (legacy escape hatch; no longer a resolver route)
│       ├── ingest.ts        # /ingest — enqueue vault file for KB ingestion
│       ├── status.ts        # /status — system health overview
│       ├── prep.ts          # /prep — trigger morning prep
│       ├── priorities.ts    # /priorities — review/set daily priorities
│       ├── daily.ts         # /daily — daily review session
│       ├── weekly.ts        # /weekly — weekly review session
│       ├── monthly.ts       # /monthly — monthly review session
│       ├── quarterly.ts     # /quarterly — quarterly review session
│       ├── yearly.ts        # /yearly — yearly review session
│       ├── health.ts        # /health — health review session
│       ├── blog.ts          # /blog — blog post drafting session
│       ├── workout.ts       # /workout — invoke workout-generator agent with goals/equipment/exercises/Whoop recovery; persist logs/last-workout.json; chunk-send markdown to TG; pre-syncs Whoop via ensureWhoopSyncedForToday()
│       ├── done-workout.ts  # /done-workout — append most recent generated workout to today's journal
│       ├── study.ts         # /study — study session planning
│       ├── family.ts        # /family — family planning/review
│       ├── career.ts        # /career — career reflection/planning
│       ├── learn.ts         # /learn — append a runtime learning; auto-prepended to future agents
│       ├── learn-list.ts    # /learn-list — echo the current prepended learnings
│       ├── library-sync.ts  # /library-sync — trigger on-demand Lenny posts/podcasts sync via lenny-sync agent
│       └── seed.ts          # /seed — bulk-seed KB from vault files via seedAndProcess()
├── transport/
│   ├── sender.ts            # MessageSender interface, SendOpts (approval?: {prompt, options[]}) type, createSenders(bot, bus) factory; subscribes tg/webview to bus 'message', 'agent-event', and 'mutation-event'; returns { tg, webview, destroy }
│   ├── notification-bus.ts  # NotificationBus: typed event bus with publish/on/off; BusEvent = BusMessageEvent | BusAgentEvent | BusMutationEvent; BusMutationEvent has kind 'mutation-event', subKind 'log'|'progress'|'output'|'completed'|'failed'; fault-isolates failing subscribers
│   ├── mutations.ts         # Mutation pipeline: MutationDescriptor/MutationKind/MutationStatus types, applier registry, createMutation(), cancelMutation(), activeRuns map, setMutationBus(); autoApprove appliers start immediately
│   ├── telegram-sender.ts   # TelegramSender implements MessageSender; delegates to sendLongMessage; per-user typing timer map; onMutationEvent() sends one-line TG summary on completed/failed, ignores output/log/progress; shutdown() drains timers
│   └── webview-sender.ts    # WebviewSender implements MessageSender; register(userId, ws), unregister(userId, ws), per-user WS fan-out; onAgentEvent() and onMutationEvent() forward bus frames to connected WS clients
├── reviews/
│   ├── session.ts           # ReviewSession type, persistence, lifecycle management
│   ├── orchestrator.ts      # Review flow orchestrator: start, route messages, handler registry
│   ├── interview.ts         # Interactive interview phase for review sessions
│   ├── worldview-drift.ts   # Detect world-view changelog entries affecting active projects
│   ├── kb-activity.ts       # Scan knowledge/log.md INGEST entries → structured digest for review prep
│   ├── daily.ts             # Daily review handler
│   ├── weekly.ts            # Weekly review handler
│   ├── monthly.ts           # Monthly review handler
│   ├── quarterly.ts         # Quarterly review handler
│   ├── yearly.ts            # Yearly review handler
│   ├── health.ts            # Health review handler
│   └── blog.ts              # Blog drafting handler
├── server/
│   ├── http.ts              # HTTP server: health, session capture, Whoop OAuth callback; mounts webview routes when WebviewDeps provided
│   ├── auth.ts              # verifyAuth(req), isAllowedHost(req), safeCompare(a, b) — cookie + host-guard auth helpers
│   ├── webview.ts           # mountWebviewRoutes(server, deps): GET /, GET /static/*, POST /api/auth-bootstrap, POST /api/chat, GET /api/state, POST /api/mutations, POST /api/mutations/:id/cancel, WS /api/ws
│   ├── webview-bootstrap.ts # handleWebviewMessage(sender, userId, text) — thin adapter over dispatchText for webview
│   ├── projects-snapshot.ts # getProjectSummaries(): reads docs/projects/index.md + tasks.md per project; returns ProjectSummary[] with slug, status, task progress (done/total/perPhase), specPath, lastModified
│   ├── state-snapshot.ts    # StateSnapshot type + getStateSnapshot(): reads logs/agent-runs.jsonl, scheduler-state.json, active session/review, ingestion queue, playbook/proposal counts, project summaries, active+recent mutations; used by GET /api/state
│   └── static/              # Webview frontend: index.html, app.js, app.css (vanilla HTML/JS/CSS)
├── kb/
│   ├── engine.ts            # Orchestrates ingest/query/lint, processes ingestion queue
│   ├── init.ts              # KB directory scaffolding and schema initialization
│   ├── ingest.ts            # Copy source to raw/ → spawn wiki-compiler agent → entity-link touched pages
│   ├── entity-extract.ts    # linkEntities(): build alias map from JSON stores + FAMILY_NAMES, wikilink bare mentions in reference sections, append to related: frontmatter
│   ├── query.ts             # Build context → spawn kb-query agent → synthesized answer
│   ├── lint.ts              # Spawn wiki-linter agent → health report
│   ├── search.ts            # ripgrep-based full-text search across vault + wiki
│   ├── queue.ts             # JSON-file ingestion queue (enqueue/dequeue/clear)
│   ├── schema.ts            # Default schema.md content for new knowledge bases
│   └── seed.ts              # seedAndProcess(): enumerate vault files → enqueue new/mutable sources → process queue
├── jobs/
│   ├── scheduler.ts         # Cron job registration: startScheduler(bot), stopScheduler()
│   ├── morning-prep.ts      # Gather vault data → synthesize morning prep → write to journal
│   ├── nightly.ts           # Nightly orchestrator: capture → daily tags → birthday alerts → playbook extract → journal ingest → meeting extract → KB queue → whoop → lint → mark processed → commit
│   ├── capture.ts           # Session capture logic (used by HTTP endpoint + nightly job)
│   ├── whoop-sync.ts        # Whoop sleep sync (8am) + activity sync (nightly) + trends; ensureWhoopSyncedForToday() best-effort pre-sync for user-triggered handlers
│   ├── playbook-extract.ts  # Scan today's journal for #playbook tags → draft entries into playbook-queue.json
│   ├── meeting-extract.ts   # Scan today's journal for #meeting blocks → structured Meeting[] via askClaudeOneShot
│   ├── book-summarizer.ts   # Generate 1-2 sentence book summary via askClaudeOneShot (returns null on UNKNOWN)
│   ├── intent-scan.ts       # Weekly Ask-Twice scan: reads intent-log.jsonl (last 30 days), groups via Haiku, dedupes against skill registry + pending queue, writes up to 3 proposals to proposal-queue.json
│   ├── proposal-queue.ts    # Proposal queue types + CRUD (logs/proposal-queue.json)
│   ├── mutations-log.ts     # Append-only JSONL log for mutations (logs/mutations.jsonl): appendMutationLine, readRecentMutations, reconcileOrphans (flips stale 'running' entries to 'failed' at startup)
│   ├── work-runner.ts       # workRunApplier: MutationApplier for 'work-run' kind; spawns Claude CLI with spec.md+tasks.md+/work --auto in project dir; streams stdout/stderr as MutationEvents; enforces per-project and global concurrency caps
│   ├── lenny-sync.ts        # Exports runLibrarySync() + LibrarySyncResult; pulls new Lenny posts/podcasts via lenny-sync agent, updates logs/lenny-sync-state.json
│   └── nudges.ts            # Weekly and review nudge stubs
├── mcp/
│   ├── server.ts            # MCP server: exposes KB tools (query, search, ingest, stats, lint)
│   └── index.ts             # Standalone stdio entry point for Claude Code
├── integrations/
│   ├── telegram/client.ts   # Message chunking, typing indicators
│   ├── whoop/types.ts       # Whoop API response types and daily data format
│   ├── whoop/keychain.ts    # macOS Keychain token storage via security CLI
│   ├── whoop/client.ts      # OAuth2 token management + Whoop API calls
│   └── readwise/client.ts   # Save articles to Readwise Reader API
├── vault/
│   ├── files.ts             # Read/write/append/list vault markdown files (assertWithinVault-guarded)
│   ├── journal.ts           # Journal file creation, append, writeMorningPrep, parseTag
│   ├── learnings.ts         # /learn-authored JSONL store + prompt-prepend builder for runAgent
│   ├── git.ts               # git add/commit/push helpers
│   ├── sessions.ts          # TG session Map with JSON persistence + crash recovery
│   ├── equipment.ts         # readEquipment() parses health/equipment.md into {home, gym} raw blocks
│   ├── whoop-recent.ts      # readRecentWhoopDays(n) returns last n parsed WhoopDailyData from health/whoop/
│   └── watcher.ts           # FSWatcher for Readwise article detection, TG notify + enqueue
└── utils/
    ├── time.ts              # America/Chicago timezone helpers (getTodayFilename, getYesterdayFilename, getTimestamp, getDayOfWeek, getRecentFilenames, etc.)
    ├── logger.ts            # Structured JSON logging with component tags
    ├── intent-log.ts        # Ask-Twice telemetry: appendIntent → logs/intent-log.jsonl
    └── markdown.ts          # Markdown parsing utilities (future)
cli/
└── jarvis.ts                # CLI entry point for local interactive use
evals/
└── README.md                # YAML schema + authoring conventions for the MVP eval framework
scripts/
├── run-evals.ts             # Dev tool: parse eval YAMLs, invoke agents via runAgent(), report pass/fail
├── run-evals.test.ts        # Unit tests for the eval runner (vitest)
├── run-intent-scan.ts       # CLI entry point for intent-scan job (npm run intent-scan)
└── library-backfill.ts      # CLI entry point for bulk library-to-KB backfill (npm run library-backfill)
```

## Vault Content Model

The vault has four LLM-mutable content layers with **different write semantics**. They stay distinct on purpose — each has its own cadence, tone, and audit trail. Collapsing them would force one schema to handle conflicting temporal models (wiki pages decay; convictions evolve with audit trail; playbook is append-only; projects are living logs).

| Layer | Write semantics | Updater agent | Trigger |
|---|---|---|---|
| `knowledge/` | Wiki with `last-verified` + `valid-until` — pages decay | `wiki-compiler` | KB ingestion queue (nightly + on-demand) |
| `world-view/*.md` | First-person essays with `### [[YYYY_MM_DD]]` changelog — beliefs evolve with audit trail | `worldview-updater` | Review outline approval (propose-only, never auto-writes) |
| `pages/playbook.md` | Append-only tactical entries with stable `<slug>-<YYYY-MM-DD>` anchors | `playbook-proposer` + `playbook-updater` | `#playbook` journal tag → nightly queue → next review approval |
| `projects/*.md` | Living logs: status + dated thesis + decisions log + weekly summaries | `project-updater` | Review outline approval (authoritative) |

Plus `pages/psychology.md` (living profile, updated by `psychology-updater` with scope gradient: `observation` / `pattern_check` / `reassessment` / `full_rewrite`) and JSON data stores (`pages/{books,crm,places}.json`, `health/workouts.json`, `career/applications.json`, `investments/investments.json`, `study/progress.json`) updated by `json-updater`.

**Relationship:** `knowledge/` is the neutral reference layer and *cites* the other three as raw sources (via `knowledge/raw/{world-view,playbook,projects}/`). The flow is one-way — human-authored layers feed the KB as sources; the KB does not own them.

### Review → post-agent flow

`src/reviews/interview.ts` drives review sessions. At outline-approval points the interview emits a structured approval signal via `sender.send(userId, text, { approval: { prompt, options } })`. On the webview this renders as clickable button rows; on Telegram the text is the fallback (the `opts` are ignored by TelegramSender). After the user approves the outline:
1. `review-writer` appends the formatted review to today's journal.
2. Dynamic analysis (one-shot LLM call in `runWriteupAndUpdates`) decides which post-agents to run by producing `{projects, psychology, json_updates, worldview, playbook}` booleans.
3. Each post-agent runs in parallel. Failures and missing-agent errors are surfaced in the TG summary (not silent) — see `AGENT_NOT_FOUND_PREFIX` in `src/ai/claude.ts`.
4. Files touched by `project-updater` / `worldview-updater` / `playbook-updater` are auto-enqueued via `enqueueKB()` so the next nightly KB ingestion refreshes wiki citations.

### Worldview preservation — propose-only

`worldview-updater` only applies diffs that appeared in the user-approved outline. The interview surfaces proposed worldview changes inline for approval before the updater runs. This preserves first-person voice and prevents silent rewrites of convictions. The agent must edit additively and always append a `### [[YYYY_MM_DD]]` changelog entry.

### Nightly playbook extraction

`src/jobs/playbook-extract.ts` (wired into `src/jobs/nightly.ts` between `Daily tags` and `Whoop activity`) scans today's journal for `#playbook` tags. On hit, it calls the `playbook-proposer` agent to draft formatted entries and appends them to `logs/playbook-queue.json` with `status: 'pending'`. Pending drafts auto-surface in the prep context of the next dynamic review, where the user approves/rejects them.

### Worldview-drift flag

`src/reviews/worldview-drift.ts`: during weekly prep (`extraPrepContext` hook in `weekly.ts`), scans `world-view/*.md` changelog entries in the review window. For each recently-shifted topic, greps `projects/*.md` (excluding `archive/`) for citations and flags any project whose thesis references the shifted topic. Flagged projects are raised in the interview so the user can decide whether to re-examine the thesis.

### KB raw-source routing

`src/kb/ingest.ts` `determineRawDir()`:
- `Readwise/*` → `knowledge/raw/articles/`
- `journals/*` → `knowledge/raw/journals/`
- `world-view/*` → `knowledge/raw/world-view/`
- `pages/playbook.md` → `knowledge/raw/playbook/`
- `projects/*` (excluding `projects/archive/`) → `knowledge/raw/projects/`
- `library/lenny/*` → `knowledge/raw/lenny/` (mutable — Lenny posts can be re-published upstream)
- `library/lennys-podcast/*` → `knowledge/raw/lenny/` (legacy folder; immutable — one-time backfill)
- `library/graham-essays/*` → `knowledge/raw/articles/` (immutable — one-time backfill)
- anything with `conversation` in the path → `knowledge/raw/conversations/`
- fallback → `knowledge/raw/notes/`

Mutable sources (world-view, playbook, active projects, journals, library/lenny) **overwrite** the `raw/` copy on every re-ingest (see `isMutableSource()`) so wiki citations reflect current content. Immutable sources (Readwise, conversations, library/lennys-podcast, library/graham-essays) are copied once.

## Key Conventions

- **TypeScript** with `tsx` runner — no build step needed for dev or prod
- **ESM** (`"type": "module"` in package.json) — all imports use `.js` extensions
- All timestamps use `America/Chicago` timezone
- Config reads from env vars; defaults in `src/config.ts`
- Claude CLI spawning is centralized in `src/ai/claude.ts` — never spawn `claude` directly elsewhere
- Message delivery uses the `MessageSender` interface (`src/transport/sender.ts`) — handlers and commands never import `TelegramBot` directly for sending; bot is only passed where needed for file downloads (photo handler)
- Session locks prevent concurrent CLI writes to the same session ID
- Git commits happen at key moments (morning prep, /fresh, nightly), not on timers
- Vault files use `readVaultFile` / `writeVaultFile` / `appendVaultFile` from `src/vault/files.ts` — paths are relative to vault root
- KB agents **must not** write outside `knowledge/`
- Wiki pages use YAML frontmatter for metadata (type, tags, related, created, last-verified, valid-until) — see `src/kb/schema.ts`
- Autonomous codebase operations go through the mutation pipeline (`src/transport/mutations.ts`) — register a `MutationApplier`, call `createMutation()`, never spawn Claude CLI for project work directly. `CLAUDE_BIN`, `registerActiveProcess`, and `unregisterActiveProcess` from `src/ai/claude.ts` keep binary resolution and shutdown tracking centralized for external spawners.

## Running

```bash
npm run dev          # Development with tsx watch mode
npm run start        # Production
npm run cli          # Local CLI interface
npm run intent-scan       # Run Ask-Twice intent scan manually
npm run library-backfill  # Bulk-ingest library entries into the KB (project 05)
```

## Environment Variables

Loaded from `.env.local` via `--env-file-if-exists` in npm scripts (no dotenv dependency).

Required:
- `TELEGRAM_BOT_TOKEN` — from @BotFather
- `TELEGRAM_USER_ID` — numeric ID from @userinfobot
- `VAULT_DIR` — path to Obsidian vault

Optional:
- `FAMILY_NAMES` — comma-separated names scanned by `/family` (e.g. `Alice,Bob`). Empty disables the command.
- `WHOOP_CLIENT_ID`, `WHOOP_CLIENT_SECRET` — Whoop OAuth credentials
- `READWISE_TOKEN` — Readwise Reader API
- `JARVIS_HTTP_SECRET` — shared secret for authenticated HTTP endpoints
- `RESOLVER_CONFIDENCE_THRESHOLD` — minimum confidence for resolver to dispatch a skill (default `0.7`)
- `RESOLVER_MIN_WORDS` — minimum word count before resolver runs (default `5`)
- `WORKSPACE_DIR` — path to workspace root (e.g. `~/workspace`). When set, agents receive it as context and as `JARVIS_WORKSPACE_DIR` env var so they can read project files outside the vault.
- `LENNY_MCP_TOKEN` — JWT Bearer token for the Lenny MCP server (`https://mcp.lennysdata.com/mcp`). Required for `/library-sync` and the nightly Library sync step.
- `OBSIDIAN_VAULT_NAME` — optional, defaults to basename of `VAULT_DIR`; injected into webview `<meta>` tag for Obsidian wikilink resolution
- `JARVIS_ALLOWED_HOSTS` — optional, defaults to `localhost,127.0.0.1`; host-guard allowlist for webview endpoints (`isAllowedHost`)
- `WORK_RUN_PER_PROJECT_CAP` — max concurrent `work-run` mutations per project slug (default `1`, min `1`)
- `WORK_RUN_GLOBAL_CAP` — max concurrent `work-run` mutations across all projects (default `2`, min `1`)

`LOGS_DIR` is hardcoded to `<project-root>/logs/` (gitignored). `logs/last-workout.json` (the most recent generated workout, written by `/workout` and consumed by `/done-workout`) is exposed via `config.LAST_WORKOUT_FILE`. `logs/agent-runs.jsonl` is a rolling JSONL log of every `runAgent()` invocation (`{agent, startedAt, durationMs, status}`), consumed by `getStateSnapshot()` in `src/server/state-snapshot.ts`. `logs/mutations.jsonl` is a rolling JSONL log of every `MutationDescriptor` state transition, written by `src/jobs/mutations-log.ts`.

## Agents

### Runtime Agents (spawned by Jarvis via `runAgent()`)

| Agent | File | Purpose |
|---|---|---|
| wiki-compiler | `.claude/agents/wiki-compiler.md` | Ingest raw sources → create/update wiki pages |
| kb-query | `.claude/agents/kb-query.md` | Search wiki + vault → synthesized answer |
| wiki-linter | `.claude/agents/wiki-linter.md` | Health-check wiki for issues |
| morning-prep | `.claude/agents/morning-prep.md` | Gather vault data → structured morning journal section |
| session-summarizer | `.claude/agents/session-summarizer.md` | Rich session summaries with vault context |
| release-notes | `.claude/agents/release-notes.md` | Generate changelog from git history |
| content-triager | `.claude/agents/content-triager.md` | Classify URLs/text → kb-ingest, readwise, journal, or skip |
| photo-classifier | `.claude/agents/photo-classifier.md` | Classify photos → book, receipt, whiteboard, etc. with routing |
| system-scanner | `.claude/agents/system-scanner.md` | Review prep: summarize current state of health/study/psychology/etc. |
| project-updater | `.claude/agents/project-updater.md` | Post-review: apply approved updates to projects/*.md |
| playbook-proposer | `.claude/agents/playbook-proposer.md` | Nightly: draft playbook entries from `#playbook`-tagged journals |
| playbook-updater | `.claude/agents/playbook-updater.md` | Post-review: append approved drafts to pages/playbook.md |
| proposal-updater | `.claude/agents/proposal-updater.md` | Post-review: action approved Ask-Twice proposals — creates new agent files under `.claude/agents/` and/or registers cron frontmatter on existing agents; marks actioned entries in `logs/proposal-queue.json` |
| worldview-updater | `.claude/agents/worldview-updater.md` | Post-review: apply approved diffs to world-view/*.md with changelog entry |
| psychology-updater | `.claude/agents/psychology-updater.md` | Post-review: apply scoped updates to pages/psychology.md |
| json-updater | `.claude/agents/json-updater.md` | Post-review / nightly: apply updates to JSON data stores |
| daily-content-updater | `.claude/agents/daily-content-updater.md` | Nightly daily-tags: apply updates to markdown content stores (`health/nutrition.md`, `projects/ideas.md`, `writing/topics.md`) |
| intent-scan | `.claude/agents/intent-scan.md` | Saturday 3pm cron: runs `npm run intent-scan` to process intent-log and write skill proposals |
| workout-generator | `.claude/agents/workout-generator.md` | Generates a one-shot daily workout (warmup → main → cooldown) tailored to goals, equipment, recent training load, Whoop recovery, and exercise preferences |
| lenny-sync | `.claude/agents/lenny-sync.md` | Pull new Lenny posts/podcasts via MCP into library/lenny/, update logs/lenny-sync-state.json |

### Vault-resident agents (personal content, loaded from `$VAULT_DIR/.claude/agents/`)

`loadAgentDef` in `src/ai/claude.ts` checks Jarvis's agents dir first, then falls back to the vault. The following agents live only in the vault because their instructions encode personal specifics (family names, employer, project codenames) that don't belong in a public repo:

| Agent | Purpose |
|---|---|
| journal-scanner | Review prep: scan journals by date range + focus areas |
| project-scanner | Review prep: compare project pages against recent journal activity |
| review-writer | Review writeup: append formatted review to journal |

### Dev Tooling Agents (used by `/work` skill)

| Agent | File | Purpose |
|---|---|---|
| test-specialist | `.claude/agents/test-specialist.md` | Bootstrap vitest, write tests, run them |
| code-reviewer | `.claude/agents/code-reviewer.md` | Review for bugs, security, convention violations |
| security-auditor | `.claude/agents/security-auditor.md` | Audit for secrets, PII exposure, vault leaks, server security |
| architecture-reviewer | `.claude/agents/architecture-reviewer.md` | Review for system-level architectural issues |
| code-simplifier | `.claude/agents/code-simplifier.md` | Check for dead code, over-abstraction, duplication |
| docs-sync | `.claude/agents/docs-sync.md` | Update CLAUDE.md and docs after structural changes |
| json-updater | `.claude/agents/json-updater.md` | Update JSON config files programmatically |

## MCP Server

The knowledge base is exposed as an MCP server so any Claude Code session can query, search, ingest, and lint the KB.

**Config**: `.claude/settings.json` registers `jarvis-kb` MCP server.

**Tools exposed**:
| Tool | Description |
|---|---|
| `kb_query` | Synthesized answer from KB with wikilink citations |
| `kb_search` | Search wiki with optional type/tag filtering |
| `kb_ingest` | Ingest a vault file into the KB |
| `kb_stats` | Page counts and recent log entries |
| `kb_lint` | Health check report |

**Running standalone**: `npx tsx --env-file-if-exists=.env.local src/mcp/index.ts`

## Reference

- `_old/` contains the original JS implementation — use as reference, do not modify
- `_old/docs/system/` has detailed docs for each subsystem (telegram-bot, whoop-sync, morning-prep, nightly-processing, readwise-scanner, infrastructure)
