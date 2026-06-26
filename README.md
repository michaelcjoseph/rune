# Rune

Always-on personal second brain server. Connects a Telegram bot to your Obsidian vault through the Claude Code CLI.

A single Node.js process that combines a Telegram bot, a local webview/cockpit UI, an LLM-powered knowledge base, scheduled daily workflows, and an autonomous product-team orchestration platform — all backed by Claude Code with no API keys required.

## What it does

**Chat with your vault.** Send a message via Telegram (or the local webview) and get a vault-aware response. Free-form messages are classified by a Haiku skill resolver and routed to the matching command; the slash form is always available as a fallback. Multi-turn conversations persist across messages. Send `/fresh` to summarize, log to your journal, and reset.

**Build a knowledge base.** Ingest articles, conversations, and notes into a [Karpathy-style](https://karpathy.ai/blog/wikipedia.html) LLM wiki. Raw sources are compiled into interlinked wiki pages organized by entities, concepts, topics, and comparisons. Query the wiki with natural language and get synthesized answers with citations — from inside Rune, from any other Claude Code session via the bundled `rune-kb` MCP server, or remotely from the Claude App via the OAuth-gated `/mcp` connector.

**Run structured reviews.** Interview-based daily, weekly, monthly, quarterly, and yearly reviews conducted through Telegram or the webview. Prep agents scan your journals and vault systems silently, then Claude conducts a real conversation — surfacing quotes, challenging narratives, and producing write-ups appended to your journal. Post-approval, specialist agents update project pages, the playbook, world-view, and psychology profile.

**Automate daily operations.** Morning journal prep (priorities, study plan, writing topic), end-of-day tag processing (`#books`, `#crm`, `#workout`, etc. → JSON data stores), a 15-step nightly orchestrator (session capture, KB ingestion, playbook extraction, Whoop sync, observation + learning loops, KB lint), and review nudges on a schedule.

**Run autonomous codebase work.** A mutation pipeline drives Claude (and optionally Codex) against a project's `spec.md` + `tasks.md`. The legacy work-runner spawns `/work --auto`; the orchestrated path runs a six-role product team (PM, tech-lead, QA, coder, reviewer, designer) through a planned task graph. Runs stream to the cockpit as cancellable, supervised operations with durable transcripts, work-product classification, and a gated-merge finalizer. See [Advanced capabilities](#advanced-capabilities).

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│                     Node.js Process                       │
│                                                           │
│  ┌──────────┐  ┌──────────────┐  ┌──────────────┐        │
│  │ Telegram │  │ HTTP server  │  │  Scheduler   │        │
│  │   Bot    │  │ API + WS +   │  │   (cron)     │        │
│  │ (polling)│  │ cockpit + MCP│  │              │        │
│  └────┬─────┘  └──────┬───────┘  └──────┬───────┘        │
│       │               │                 │                 │
│  ┌────┴───────────────┴─────────────────┴────────────┐   │
│  │ Transport: senders, in-flight ops, mutation        │   │
│  │ pipeline, supervision/stall-check                   │   │
│  └───────────────────────┬─────────────────────────────┘  │
│                          │                                │
│  ┌───────────────────────┴─────────────────────────────┐  │
│  │           Claude Code CLI  (+ Codex, optional)       │  │
│  │  (spawned per call; ops cancellable + supervised;    │  │
│  │   prose calls inject writing voice)                  │  │
│  └────┬───────────────────────┬─────────────────────────┘  │
│       │                       │                            │
│  ┌────┴──────────────┐  ┌─────┴────────────────┐          │
│  │ MCP: rune-kb +    │  │ Obsidian Vault (iCloud)│        │
│  │ /mcp App connector│  │ journals/ pages/        │        │
│  │ (KB tools exposed │  │ knowledge/ projects/    │        │
│  │  locally + remote)│  │ world-view/ health/     │        │
│  └───────────────────┘  └───────────────────────┘          │
└──────────────────────────────────────────────────────────┘
```

- **Telegram bot** (polling) — chat, commands, multi-turn sessions, review/planning interviews, photo + URL triage
- **HTTP server** (localhost:3847) — REST API, WebSocket, the **cockpit/webview** at `/` (cookie auth + host-guard), and an optional OAuth-gated `/mcp` Claude App connector
- **Scheduler** (node-cron) — morning prep, Whoop sync, nightly processing, review nudges, intent-scan
- **Transport** — `MessageSender` abstraction (TG + webview), in-flight op tracker (`/cancel`), mutation pipeline with supervision + stall-check (append-only `logs/mutations.jsonl`)
- **Knowledge base** — two-layer search (LLM reads compact index → ripgrep full-text), no vector DB; exposed via MCP locally and remotely
- **Claude Code CLI** — all AI operations; no API key needed (runs on Max subscription); prose-producing callers opt into a writing-voice prepend from `writing/voice.md`; multi-model dispatch can route to Codex

For the system internals, see [`docs/architecture/`](docs/architecture/) — `subsystems.md` (mutation pipeline, supervision, work-run lifecycle, orchestration, MCP/OAuth), `module-reference.md` (per-file map), `reviews-kb-vault.md`, and `configuration.md`.

## Commands

Free-form messages are classified by a Haiku skill resolver against the slash-command + agent registry. If confidence ≥ `RESOLVER_CONFIDENCE_THRESHOLD`, the message is routed to that handler; otherwise it falls through to multi-turn conversation. The slash form is always available as a fallback or override.

### Core
| Command | Description |
|---------|-------------|
| `/fresh` | Summarize conversation, log to journal, reset session |
| `/fresh-full` | Same as `/fresh` but logs the verbatim transcript (no summary) |
| `/clear` | Discard the active session without journaling |
| `/journal <text>` | Append timestamped entry to today's journal |
| `/ask <question>` | One-shot vault query |
| `/cancel [op-id-prefix]` | SIGTERM an in-flight Claude op (most recent for you, or by id prefix) |
| `/active-context` | Report which session you're in (chat / planning / review / study) and the right escape hatch |
| `/status` | Uptime, active sessions, recent agent runs |

### Knowledge Base
| Command | Description |
|---------|-------------|
| `/kb <question>` | Query the knowledge base |
| `/kb stats` | Page counts and recent ingestion log |
| `/ingest [path]` | Ingest a vault source into the wiki (or process queue) |
| `/seed` | Bulk-seed the KB from existing vault files |
| `/library-sync` | Pull new Lenny posts + podcasts via MCP into `library/lenny/` |

### Reviews & Planning
| Command | Description |
|---------|-------------|
| `/daily` | End-of-day tag processing and JSON updates |
| `/weekly` | Interview-based weekly review (~30 min). Post-approval, updates project pages, playbook entries, world-view files, and psychology profile via specialist agents. |
| `/monthly` | Monthly theme check-in and reflection |
| `/quarterly` | 3-month patterns and strategic decisions |
| `/yearly` | Annual reflection with 7 Questions framework |
| `/health` | Health coaching session (multi-turn, Whoop-aware) |
| `/blog <topic>` | Interview-based blog drafting (matches your writing voice) |
| `/cancel-review` | Cancel an in-progress review session |
| `/new-project [topic]` | Product-style interview that drafts a project brief + spec/tasks/test-plan files |
| `/plan [product]` | Start a Planner conversation scoped to a product (idea → approved spec) |
| `/approve` | Approve a spec-proposed planning session and scaffold the project files |

### Vault Operations
| Command | Description |
|---------|-------------|
| `/prep` | Run morning prep (priorities, weekly goals, study, writing) into today's journal |
| `/priorities` | Show `#priorities` from a given journal (today, yesterday, or day-of-week) |
| `/workout [home\|gym] [focus]` | Generate a tailored workout (warmup → main → cooldown) from goals, equipment, recent training, and Whoop recovery |
| `/done-workout` | Append the last generated workout to today's journal with a `#workout` tag |
| `/study` | Spaced-repetition session: quiz over due wiki concepts |
| `/syllabus` | Current study syllabus progress and assignments |
| `/career` | Active job applications with staleness warnings |
| `/family` | 14-day journal scan for configured family-name mentions (requires `FAMILY_NAMES`) |

### Runtime tuning
| Command | Description |
|---------|-------------|
| `/learn <text>` | Append a runtime learning; auto-prepended to future agent runs |
| `/learn-list` | Echo the current prepended learnings |

## Knowledge Base

The KB follows [Andrej Karpathy's approach](https://karpathy.ai/blog/wikipedia.html) to building a personal wiki with LLMs:

```
knowledge/
├── schema.md            # Rules for all KB operations
├── index.md             # One-line-per-page catalog (LLM-readable)
├── log.md               # Append-only operation log
├── raw/                 # Immutable source material
│   ├── articles/        # Web articles, Readwise highlights
│   ├── conversations/   # Telegram session summaries
│   └── notes/           # Shared notes and ideas
└── wiki/                # LLM-compiled pages
    ├── entities/        # People, companies, projects
    ├── concepts/        # Ideas, frameworks, mental models
    ├── topics/          # Broad topic syntheses
    └── comparisons/     # X vs Y analyses
```

Sources go in, wiki pages come out. The wiki-compiler agent reads raw sources, identifies entities/concepts/topics, creates or updates wiki pages with `[[wikilinks]]`, and maintains the index. No embeddings or vector DB — search uses a two-layer approach: the LLM reads the compact index to find relevant pages, then ripgrep does full-text search for additional matches.

**MCP exposure.** The KB is reachable two ways:
- **Local stdio (`rune-kb`)** — registered in `.claude/settings.json`, so any Claude Code session on the machine can use `kb_query`, `kb_search`, `kb_ingest`, `kb_stats`, `kb_lint`. Standalone entry: `npx tsx --env-file-if-exists=.env.local src/mcp/index.ts`.
- **Remote (`/mcp` Claude App connector)** — a single-user OAuth 2.1 endpoint (RFC 8414 + RFC 9728) serving the six App-surface tools (`kb_query`, `vault_search`, `log_idea`, `crm_lookup`, `get_priorities`, `log_conversation`). The admin `kb_*` tools are never remotely reachable. Mounted only when `RUNE_HTTP_SECRET` is set. See [`docs/architecture/subsystems.md`](docs/architecture/subsystems.md).

## Vault Content Model

The vault has four LLM-mutable content layers with **different write semantics**. They stay distinct on purpose — each has its own cadence, tone, and audit trail.

| Layer | Write semantics | Updater agent | Trigger |
|---|---|---|---|
| `knowledge/` | Wiki with `last-verified` + `valid-until` — pages decay | `wiki-compiler` | KB ingestion queue (nightly + on-demand) |
| `world-view/*.md` | First-person essays with `### [[YYYY_MM_DD]]` changelog — beliefs evolve with audit trail | `worldview-updater` | Review outline approval (propose-only) |
| `pages/playbook.md` | Append-only tactical entries with stable anchors | `playbook-proposer` + `playbook-updater` | `#playbook` journal tag → nightly queue → next review approval |
| `projects/*.md` | Living logs: status + thesis + decisions + weekly summaries | `project-updater` | Review outline approval (authoritative) |
| `writing/voice.md` | Style source of truth — read on every prose-producing Claude call | _(human-edited only)_ | Edit the file; effect is immediate, no restart |

`knowledge/` is the neutral reference layer — wiki pages *cite* the other three (via `knowledge/raw/{world-view,playbook,projects}/`). The flow is one-way: human-authored layers feed the KB as raw sources; the KB does not own them.

After a review, files touched by the post-agents are auto-enqueued for the next nightly KB ingestion so wiki citations stay fresh. See [`docs/architecture/reviews-kb-vault.md`](docs/architecture/reviews-kb-vault.md) for the full mechanics (review→post-agent flow, worldview-drift detection, KB raw-source routing, writer/role memory loops).

## Agents

Custom Claude Code agents handle structured operations. Agents live in `.claude/agents/` in this repo (generic tooling, public) with fallback to `$VAULT_DIR/.claude/agents/` (personal content, private). `loadAgentDef` in `src/ai/claude.ts` checks Rune first, then the vault.

**Runtime agents (spawned by Rune):** wiki-compiler, kb-query, wiki-linter, morning-prep, session-summarizer, content-triager, photo-classifier, system-scanner, workout-generator, lenny-sync, intent-scan, daily-content-updater, sr-question-generator, sr-grader, project-setup-writer.

**Post-review agents (run after user approval of a review outline):** project-updater, playbook-proposer, playbook-updater, worldview-updater, psychology-updater, json-updater, proposal-updater.

**Vault-resident (personal specifics kept out of the public repo):** journal-scanner, project-scanner, review-writer.

**Dev-tooling agents (used by `/work` and `/review` skills):** test-specialist, code-reviewer, security-auditor, architecture-reviewer, code-simplifier, docs-sync, release-notes.

**Product-team roles (autonomous orchestration, `agents/<role>/` with SOUL + memory):** pm, tech-lead, qa, coder, reviewer, designer — plus the writer role (`agents/writer/`) used by `/blog`.

## Advanced capabilities

Beyond the personal-assistant core, Rune runs an autonomous product-team orchestration platform. These features are off by default and gated behind config. Depth lives in [`docs/architecture/subsystems.md`](docs/architecture/subsystems.md).

- **Cockpit.** The webview at `/` includes a cockpit sidebar that renders each registered product's projects with lifecycle status, live run status, and per-project action buttons (start / continue / enter-planning). It also surfaces a backlog drawer (per-product bugs/ideas with Plan buttons + an add chip), a pending-approvals inbox, a per-product deep-view, and a real-time run-feed (transcript + outcome). A production-only "↻ Restart server" button relaunches the launchd daemon.
- **Mutation pipeline + work runs.** Autonomous codebase ops go through `src/transport/mutations.ts`. The legacy `work-runner` spawns Claude with `/work --auto` against a project's `spec.md` + `tasks.md`. Each run streams a durable transcript (`logs/work-runs/<id>/`), classifies its outcome on the actual work product (branch-complete / partial / noop / dirty / failed), exports a forensics bundle, and finalizes through a **gated-merge finalizer** that runs validation in an integration worktree before merging. Supervision + a stall-check loop monitor liveness; a run can **park** for human input and is released from Telegram or the cockpit.
- **Orchestrated product team.** When enabled (`ORCHESTRATED_WORK_ENABLED`, or per-product `orchestratedMode`), Start routes to the orchestrated applier: a six-role team (PM, tech-lead, QA, coder, reviewer, designer) drives a planned task graph with test-first gates, an independent-provider reviewer, and a Rune-owned closeout. It never self-merges — a completed run holds branch-complete for operator merge. Roles carry a SOUL charter + a learning `memory.md` updated by the nightly learning loop.
- **Planning → backlog → promotions.** `/plan` (or a cockpit backlog item's Plan button) opens a Socratic planning conversation that hardens an idea into a spec; `/approve` scaffolds the project files. A durable promotion job (`logs/promotions.jsonl`) survives restarts so a half-scaffolded item is re-driven on boot.
- **Multi-model dispatch.** A model-selection policy (`policies/model-policy.json`) routes each role/agent to a model; cross-model work can dispatch to **Codex** (GPT-5.x) with a fail-closed provider probe. Planning runs an optional sequential cross-model critique pass (Claude then Codex) before the human approval gate.

Live end-to-end proofs: `npm run acceptance:orchestrated` and `npm run acceptance:cockpit-real` (both make real model calls).

## Setup

### Prerequisites

- Node.js >= 22
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated (Max subscription)
- An Obsidian vault (local or iCloud-synced)
- A Telegram bot token (from [@BotFather](https://t.me/BotFather))
- Your Telegram user ID (from [@userinfobot](https://t.me/userinfobot))
- _(optional, for cross-model dispatch)_ the Codex CLI, logged in

### Install

```bash
git clone https://github.com/yourusername/rune.git
cd rune
npm install
```

### Configure

```bash
cp .env.example .env.local
```

Edit `.env.local`:
```
# Required
TELEGRAM_BOT_TOKEN=your-bot-token
TELEGRAM_USER_ID=your-numeric-user-id
VAULT_DIR=/path/to/your/obsidian/vault

# Optional — integrations
WHOOP_CLIENT_ID=...
WHOOP_CLIENT_SECRET=...
READWISE_TOKEN=...                       # for Readwise article scanning
LENNY_MCP_TOKEN=...                      # JWT for the Lenny MCP server (/library-sync)

# Optional — webview / HTTP / MCP connector
RUNE_HTTP_SECRET=...                     # enables webview auth AND the /mcp App connector
MCP_ISSUER_URL=https://rune.example.com  # pinned issuer for /mcp OAuth metadata (public tunnel host)
OBSIDIAN_VAULT_NAME=my-vault             # display name in the webview header (defaults to basename of VAULT_DIR)
RUNE_ALLOWED_HOSTS=localhost,127.0.0.1   # host-guard allowlist for webview endpoints

# Optional — autonomous codebase ops
RUNE_WORKSPACE_DIR=/abs/path/to/workspace  # absolute (no ~) root for /work mutations
ORCHESTRATED_WORK_ENABLED=false          # route Start to the orchestrated product-team applier
WORK_RUN_PER_PROJECT_CAP=1               # max concurrent work runs per project slug
WORK_RUN_GLOBAL_CAP=2                    # max concurrent work runs across projects

# Optional — resolver
RESOLVER_CONFIDENCE_THRESHOLD=0.7        # min confidence for the Haiku resolver to dispatch a skill
RESOLVER_MIN_WORDS=5                     # skip resolver for shorter messages

# Optional — commands
FAMILY_NAMES=Alice,Bob                   # enables /family
```

`LOGS_DIR` is not configurable — it's hardcoded to `<project-root>/logs/` (gitignored). For the full env-var reference, see [`docs/architecture/configuration.md`](docs/architecture/configuration.md).

### Run

```bash
npm run dev               # development (tsx watch, hot reload)
npm run start             # production
npm run build             # type-check only (no emit)
npm run test              # vitest run
npm run cli               # local interactive CLI
npm run evals             # run agent eval YAMLs under evals/
npm run intent-scan       # run the weekly Ask-Twice intent scan manually
npm run library-backfill  # bulk-ingest existing library entries into the KB
npm run dispatch-review   # multi-model dispatch troubleshooting
npm run acceptance:orchestrated  # LIVE orchestrated-work end-to-end proof
npm run acceptance:cockpit-real  # LIVE cockpit + real-product acceptance
```

The server starts the Telegram bot (polling), the HTTP server on port 3847, the local `rune-kb` MCP server, and the cron scheduler. With `RUNE_HTTP_SECRET` set, the cockpit/webview is reachable at `http://localhost:3847/` and the `/mcp` connector is mounted.

### Initialize the Knowledge Base

Send `/ingest` via Telegram with a path to any markdown file in your vault, or run `/seed` to bulk-enqueue every eligible vault file. The wiki-compiler agent processes the queue and creates your first wiki pages. The `knowledge/` directory is created automatically on first ingestion.

## Project Structure

Top-level `src/` areas (per-file detail in [`docs/architecture/module-reference.md`](docs/architecture/module-reference.md)):

```
src/
├── index.ts, config.ts   # Entry (boot/recovery sequence) + typed env config
├── ai/                   # All Claude/Codex CLI spawning (claude.ts is the only Claude chokepoint)
├── bot/                  # Telegram bot, slash-command handlers, resolver, skill registry
├── transport/            # MessageSender, notification bus, mutation pipeline, in-flight ops
├── reviews/              # Session-based reviews + planning sessions
├── server/               # HTTP, webview/cockpit + REST API, MCP transport + OAuth
├── kb/                   # Knowledge base engine (ingest/query/lint/search/queue/seed)
├── jobs/                 # Scheduler, nightly, work-run runners + finalizer, supervision, GC
├── intent/               # Registry, planner, orchestration, backlog, promotions, dispatch, policy
├── mcp/                  # MCP server factory + per-tool handlers
├── study/                # Spaced-repetition engine
├── integrations/         # telegram / whoop / readwise clients
├── vault/, workspace/    # Guarded file accessors, journal, git, sessions, voice
├── writer/, roles/       # Role-agent SOUL + memory loaders
└── utils/                # Time (America/Chicago), logging, path scrubbing, telemetry
cli/   # Local CLI   ·   scripts/  # Dev tools   ·   policies/  # model/escalation/products config
```

## How It Works

### AI Runtime

All AI operations spawn the Claude Code CLI (and optionally Codex) as a child process. No API keys, no token counting, no cost management — it runs on your Max subscription.

```
askClaude(message, sessionId, ...)        → multi-turn conversation
askClaudeWithContext(msg, sid, sys, opts) → multi-turn + system prompt (options bag)
askClaudeOneShot(message, ...)            → one-shot query (no session)
runAgent(name, prompt, ...)               → structured agent invocation (policy-resolved model)
```

Claude CLI spawning is centralized in `src/ai/claude.ts`; Codex spawning in `src/ai/codex.ts`. Every spawn registers an in-flight op so the user can `/cancel` (TG tracker message or webview pill). Per-session request queues prevent concurrent writes. The CLI runs with `cwd` set to your vault directory, so Claude automatically loads your vault's `CLAUDE.md`. Prose-producing call sites opt into a writing-voice prepend; classifiers and structured-data agents stay deterministic.

### Skill resolver

Free-form Telegram or webview messages get classified against the skill registry (slash commands + agent skills) by a Haiku one-shot. If the top match's confidence ≥ `RESOLVER_CONFIDENCE_THRESHOLD`, the message is routed to that handler; otherwise it falls through to multi-turn conversation. Messages shorter than `RESOLVER_MIN_WORDS` skip the classifier. `/learn` is the runtime knob — entries get prepended to every future agent invocation.

### Webview / cockpit

`http://localhost:3847/` hosts a vanilla HTML/JS UI that mirrors the TG dispatcher in real time plus a product-orchestration cockpit. Auth is a `RUNE_HTTP_SECRET` cookie behind a host-guard allowlist (`RUNE_ALLOWED_HOSTS`). It surfaces session messages, in-flight ops, the cockpit sidebar (per-product/project lifecycle + run status + actions), a backlog drawer, a pending-approvals inbox, a per-product deep-view, and a real-time run-feed.

### Vault Integration

Rune treats the vault as a shared filesystem with a layered write model — see [`docs/architecture/reviews-kb-vault.md`](docs/architecture/reviews-kb-vault.md):

- `knowledge/` is LLM-owned — `wiki-compiler` reads and writes freely.
- `world-view/`, `pages/playbook.md`, `projects/*.md`, `pages/psychology.md` and JSON data stores have **dedicated updater agents** that write under specific approval semantics (propose-only for world-view; append-on-approval for playbook; authoritative for projects/JSON).
- `writing/voice.md` is read on every prose-producing Claude call so the assistant matches your voice.
- All other directories are human-owned — Rune reads for context only.
- All writes go through `readVaultFile`/`writeVaultFile` helpers in `src/vault/files.ts`, which assert paths stay within the vault boundary.
- Git commits happen at key moments (morning prep, `/fresh`, post-review, nightly) and only on `main`.

## Status

Core surface is mature: Telegram bot + cockpit/webview, knowledge base + local & remote MCP exposure, morning prep + nightly job, content + photo triage, all review commands, Whoop integration, vault commands, and the multi-layer vault content updaters. The autonomous platform (projects 09–18) adds the cockpit redesign, work-run observability + finalizer, supervision/monitoring, the product-team orchestration path, planning/backlog/promotions, multi-model dispatch, and the `/mcp` Claude App connector. Active iteration on spaced repetition (project 07) and the intent layer (project 08).

See [`docs/projects/index.md`](docs/projects/index.md) for the project board and [`docs/architecture/`](docs/architecture/) for system internals.

## Build Your Own

Want to build something like Rune without cloning this repo? See [`docs/idea.md`](docs/idea.md) — a self-contained blueprint you can hand to an AI coding agent to recreate the system from scratch.

## License

MIT
