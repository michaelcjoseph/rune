# Jarvis

Always-on personal second brain server. Connects a Telegram bot to your Obsidian vault through Claude Code CLI.

A single Node.js process that combines a Telegram bot, a local webview UI, an LLM-powered knowledge base, scheduled daily workflows, autonomous codebase ops, and deep vault awareness — all backed by Claude Code with no API keys required.

## What it does

**Chat with your vault.** Send a message via Telegram (or the local webview) and get a vault-aware response. Free-form messages are classified by a Haiku skill resolver and routed to the matching command; the slash form is always available as a fallback. Multi-turn conversations persist across messages. Send `/fresh` to summarize, log to your journal, and reset.

**Build a knowledge base.** Ingest articles, conversations, and notes into a [Karpathy-style](https://karpathy.ai/blog/wikipedia.html) LLM wiki. Raw sources are compiled into interlinked wiki pages organized by entities, concepts, topics, and comparisons. Query the wiki with natural language and get synthesized answers with citations — from inside Jarvis or from any other Claude Code session via the bundled MCP server.

**Run structured reviews.** Interview-based weekly, monthly, quarterly, and yearly reviews conducted through Telegram or the webview. Prep agents scan your journals and vault systems silently, then Claude conducts a real conversation — surfacing quotes, challenging narratives, and producing write-ups appended to your journal. Post-approval, specialist agents update project pages, the playbook, world-view, and psychology profile.

**Automate daily operations.** Morning journal prep (priorities, study plan, writing topic), end-of-day tag processing (`#books`, `#crm`, `#workout`, etc. to JSON data stores), nightly session capture, Whoop sync, and review nudges on a schedule.

**Run autonomous codebase work.** The mutation pipeline + work-runner spawns Claude with `/work --auto` against a project's `spec.md` + `tasks.md`; transitions stream to the webview as cancellable in-flight ops, and the full state-transition log lives in `logs/mutations.jsonl`.

## Architecture

```
┌──────────────────────────────────────────────────────┐
│                   Node.js Process                     │
│                                                       │
│  ┌──────────┐  ┌──────────────┐  ┌──────────────┐    │
│  │ Telegram │  │ HTTP server  │  │  Scheduler   │    │
│  │   Bot    │  │ API + WS +   │  │   (cron)     │    │
│  │ (polling)│  │   webview    │  │              │    │
│  └────┬─────┘  └──────┬───────┘  └──────┬───────┘    │
│       │               │                 │             │
│  ┌────┴───────────────┴─────────────────┴────────┐   │
│  │   Transport: senders, in-flight ops, mutations │   │
│  └───────────────────────┬────────────────────────┘   │
│                          │                            │
│  ┌───────────────────────┴────────────────────────┐   │
│  │             Claude Code CLI                    │   │
│  │  (spawned per call; ops are cancellable;       │   │
│  │   prose-producing calls inject writing voice)  │   │
│  └────┬───────────────────────┬───────────────────┘   │
│       │                       │                       │
│  ┌────┴──────────────┐  ┌─────┴────────────────┐      │
│  │   MCP: jarvis-kb  │  │ Obsidian Vault (iCloud)│    │
│  │ (KB tools exposed │  │ journals/ pages/      │    │
│  │  to other Claude  │  │ knowledge/ projects/  │    │
│  │  Code sessions)   │  │ world-view/ health/   │    │
│  └───────────────────┘  └───────────────────────┘    │
└──────────────────────────────────────────────────────┘
```

- **Telegram bot** (polling) — chat, commands, multi-turn sessions, review interviews, photo + URL triage
- **HTTP server** (localhost:3847) — REST API, WebSocket, and a vanilla HTML/JS **webview** at `/` with cookie auth and host-guard allowlist
- **Scheduler** (node-cron) — morning prep, Whoop sync, nightly processing, review nudges, intent-scan
- **Transport** — `MessageSender` abstraction (TG + webview), in-flight op tracker (`/cancel`), mutation pipeline (autonomous ops with append-only `logs/mutations.jsonl`)
- **Knowledge base** — two-layer search (LLM reads compact index → ripgrep full-text), no vector DB; also exposed via MCP (`jarvis-kb`) to other Claude Code sessions
- **Claude Code CLI** — all AI operations; no API key needed (runs on Max subscription); prose-producing callers opt into a writing-voice prepend from `writing/voice.md`

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
| `/status` | Uptime, active sessions, recent agent runs |

### Knowledge Base
| Command | Description |
|---------|-------------|
| `/kb <question>` | Query the knowledge base |
| `/kb stats` | Page counts and recent ingestion log |
| `/ingest [path]` | Ingest a vault source into the wiki (or process queue) |
| `/seed` | Bulk-seed the KB from existing vault files |
| `/library-sync` | Pull new Lenny posts + podcasts via MCP into `library/lenny/` |

### Reviews
| Command | Description |
|---------|-------------|
| `/daily` | End-of-day tag processing and JSON updates |
| `/weekly` | Interview-based weekly review (~30 min). Post-approval, updates project pages, playbook entries, world-view files, and psychology profile via specialist agents. |
| `/monthly` | Monthly theme check-in and reflection |
| `/quarterly` | 3-month patterns and strategic decisions |
| `/yearly` | Annual reflection with 7 Questions framework |
| `/health` | Health coaching session (multi-turn, Whoop-aware) |
| `/blog <topic>` | Interview-based blog drafting (matches your writing voice) |
| `/new-project [topic]` | Product-style interview that drafts a project brief + spec/tasks/test-plan files |

### Vault Operations
| Command | Description |
|---------|-------------|
| `/prep` | Run morning prep (priorities, weekly goals, study, writing) into today's journal |
| `/priorities` | Show `#priorities` from a given journal (today, yesterday, or day-of-week) |
| `/workout [home\|gym] [focus]` | Generate a tailored workout (warmup → main → cooldown) from goals, equipment, recent training, and Whoop recovery |
| `/done-workout` | Append the last generated workout to today's journal with a `#workout` tag |
| `/study` | Current study progress and syllabus |
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

**MCP server.** The KB is also exposed as an MCP server (`jarvis-kb`) so any Claude Code session — not just Jarvis — can query, search, ingest, or lint via the tools `kb_query`, `kb_search`, `kb_ingest`, `kb_stats`, and `kb_lint`. Standalone entry: `npx tsx --env-file-if-exists=.env.local src/mcp/index.ts`.

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

`writing/voice.md` is read on every prose-producing Claude call (chat replies, summaries, reviews, drafts) so the assistant writes in your voice — see `CLAUDE.md` → *Writing voice* for the exact opt-in list and char budget.

After a review, files touched by the post-agents are auto-enqueued for the next nightly KB ingestion so wiki citations stay fresh. See `CLAUDE.md` for the full mechanics (review→post-agent flow, worldview-drift detection, KB raw-source routing).

## Agents

Custom Claude Code agents handle structured operations. Agents live in `.claude/agents/` in this repo (generic tooling, public) with fallback to `$VAULT_DIR/.claude/agents/` (personal content, private). `loadAgentDef` in `src/ai/claude.ts` checks Jarvis first, then the vault.

**Runtime agents (spawned by Jarvis):**

| Agent | Purpose |
|-------|---------|
| wiki-compiler | Compile raw sources into wiki pages |
| kb-query | Search wiki + vault, synthesize answers with `[[wikilink]]` citations |
| wiki-linter | Health-check wiki integrity |
| morning-prep | Gather vault data into a structured morning journal section |
| content-triager | Classify URLs/text → kb-ingest, readwise, journal, or skip |
| photo-classifier | Classify photos → book, receipt, whiteboard, etc. with routing |
| system-scanner | Review prep: summarize state of health/study/psychology/etc. |
| workout-generator | One-shot daily workout tailored to goals, equipment, recent load, Whoop recovery |
| lenny-sync | Pull new Lenny posts + podcasts via MCP, update sync state |
| intent-scan | Weekly Ask-Twice scan that drafts skill/cron proposals from `logs/intent-log.jsonl` |
| daily-content-updater | Nightly: apply daily-journal updates to `health/nutrition.md`, `projects/ideas.md`, `writing/topics.md` |

**Post-review agents (run after user approval of a review outline):**

| Agent | Purpose |
|-------|---------|
| project-updater | Apply approved updates to `projects/*.md` (status, thesis, decisions, summaries) |
| playbook-proposer | Nightly: draft playbook entries from `#playbook`-tagged journals into the queue |
| playbook-updater | Append approved drafts from queue to `pages/playbook.md` |
| worldview-updater | Apply approved diffs to `world-view/*.md` with dated changelog (propose-only) |
| psychology-updater | Scoped updates to `pages/psychology.md` (observation / pattern_check / reassessment / rewrite) |
| json-updater | Apply updates to JSON data stores (books, CRM, places, workouts, applications, investments, study) |
| proposal-updater | Action approved Ask-Twice proposals: create new agent files, register cron frontmatter, mark queue |
| project-setup-writer | Generate `spec.md` + `tasks.md` + `test-plan.md` for an approved new-project brief |

**Vault-resident (personal specifics kept out of the public repo):**

| Agent | Purpose |
|-------|---------|
| journal-scanner | Review prep: scan journals by date range + focus areas |
| project-scanner | Review prep: compare project pages against recent journal activity |
| review-writer | Review writeup: append formatted review to the journal (matches your writing voice) |

**Dev-tooling agents (used by `/work` and `/review` skills, not spawned at runtime):**

| Agent | Purpose |
|-------|---------|
| test-specialist | Write/run vitest tests; bootstrap test infra |
| code-reviewer | Review code changes for bugs, security, TS strictness, Jarvis conventions |
| security-auditor | Audit changes for secrets, PII, vault leaks, path traversal, unsafe shell |
| architecture-reviewer | Review for vault boundaries, module boundaries, graceful shutdown, cron safety |
| code-simplifier | Check for dead code, over-abstraction, duplication |
| docs-sync | Update `CLAUDE.md` and project docs after structural changes |
| release-notes | Generate changelog from recent git history |
| session-summarizer | Summarize a Claude Code session transcript with vault context |

## Setup

### Prerequisites

- Node.js >= 22
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated (Max subscription)
- An Obsidian vault (local or iCloud-synced)
- A Telegram bot token (from [@BotFather](https://t.me/BotFather))
- Your Telegram user ID (from [@userinfobot](https://t.me/userinfobot))

### Install

```bash
git clone https://github.com/yourusername/jarvis.git
cd jarvis
npm install
```

### Configure

```bash
cp .env.example .env
```

Edit `.env`:
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

# Optional — webview / HTTP
JARVIS_HTTP_SECRET=...                   # required to enable webview auth
OBSIDIAN_VAULT_NAME=my-vault             # display name in the webview header (defaults to basename of VAULT_DIR)
JARVIS_ALLOWED_HOSTS=localhost,127.0.0.1 # host-guard allowlist for webview endpoints

# Optional — workspace (autonomous codebase ops)
WORKSPACE_DIR=/path/to/workspace         # root for /work mutations (agents get read access)
WORK_RUN_PER_PROJECT_CAP=1               # max concurrent work-run mutations per project slug
WORK_RUN_GLOBAL_CAP=2                    # max concurrent work-run mutations across projects

# Optional — resolver
RESOLVER_CONFIDENCE_THRESHOLD=0.7        # min confidence for the Haiku resolver to dispatch a skill
RESOLVER_MIN_WORDS=5                     # skip resolver for shorter messages

# Optional — commands
FAMILY_NAMES=Alice,Bob                   # enables /family
```

`LOGS_DIR` is not configurable — it's hardcoded to `<project-root>/logs/` (gitignored).

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
```

The server starts the Telegram bot (polling), HTTP server on port 3847, the MCP server (`jarvis-kb`), and the cron scheduler. With `JARVIS_HTTP_SECRET` set, the webview is reachable at `http://localhost:3847/`.

### Initialize the Knowledge Base

Send `/ingest` via Telegram with a path to any markdown file in your vault, or run `/seed` to bulk-enqueue every eligible vault file. The wiki-compiler agent processes the queue and creates your first wiki pages. The `knowledge/` directory is created automatically on first ingestion.

## Project Structure

```
src/
├── index.ts                 # Entry: boots HTTP, Telegram, scheduler, MCP
├── config.ts                # Typed env vars and constants
├── ai/
│   ├── claude.ts            # Claude CLI spawning (askClaude, askClaudeWithContext, askClaudeOneShot, runAgent) — with in-flight op tracking + writing-voice opt-in
│   └── tool-labels.ts       # Friendly labels for streaming tool-use events
├── bot/
│   ├── telegram.ts          # Bot init + handler wiring
│   ├── resolver.ts          # Haiku skill classifier for free-form messages
│   ├── skill-registry.ts    # Slash + agent skill metadata for the resolver
│   ├── handlers/            # text.ts (routing + conversation), url.ts, photo.ts
│   └── commands/            # One file per slash command
├── transport/
│   ├── sender.ts            # MessageSender interface (TG + webview)
│   ├── telegram-sender.ts   # TG sender + in-flight tracker messages
│   ├── webview-sender.ts    # WS fan-out to connected webview clients
│   ├── notification-bus.ts  # Typed event bus (message / agent-event / mutation-event / op-event)
│   ├── in-flight.ts         # In-flight Claude-op registry + cancel
│   ├── mutations.ts         # Mutation pipeline + applier registry
│   └── op-labels.ts         # Friendly op labels for the status pill
├── server/
│   ├── http.ts              # HTTP server: health, session capture, Whoop OAuth
│   ├── webview.ts           # Webview routes: /, /static/*, /api/*, /api/ws
│   ├── auth.ts              # Cookie + host-guard auth helpers
│   ├── webview-bootstrap.ts # Thin adapter from webview into the TG dispatcher
│   ├── state-snapshot.ts    # GET /api/state — sessions, mutations, in-flight ops
│   ├── projects-snapshot.ts # Project task progress for the webview
│   └── static/              # Vanilla HTML/JS/CSS webview
├── kb/
│   ├── engine.ts            # Ingest/query/lint orchestration
│   ├── ingest.ts            # Source → raw/ → wiki-compiler agent
│   ├── query.ts             # Search + kb-query agent → answer
│   ├── entity-extract.ts    # Wikilink bare mentions from JSON + family names
│   ├── search.ts            # ripgrep full-text search
│   ├── queue.ts             # JSON-file ingestion queue
│   ├── seed.ts              # Bulk-enumerate vault files into the queue
│   ├── schema.ts            # Wiki schema constants
│   ├── init.ts              # First-run KB scaffolding
│   └── lint.ts              # Wiki health check
├── mcp/
│   ├── server.ts            # MCP server registering kb_query/search/ingest/stats/lint
│   └── index.ts             # Standalone stdio entry point
├── jobs/
│   ├── scheduler.ts         # node-cron registration
│   ├── nightly.ts           # Capture → daily tags → birthdays → playbook → meetings → KB queue → Whoop → lint → commit
│   ├── morning-prep.ts      # Morning journal preparation
│   ├── capture.ts           # Session capture (used by nightly + HTTP)
│   ├── whoop-sync.ts        # Whoop sleep/activity sync + trends
│   ├── playbook-extract.ts  # Scan #playbook tags → draft entries into queue
│   ├── meeting-extract.ts   # Scan #meeting blocks → structured Meeting[]
│   ├── book-summarizer.ts   # 1–2 sentence book summary via Claude
│   ├── intent-scan.ts       # Weekly Ask-Twice scan → skill/cron proposals
│   ├── proposal-queue.ts    # Proposal queue CRUD
│   ├── lenny-sync.ts        # Library sync runner
│   ├── work-runner.ts       # `work-run` mutation applier (autonomous /work)
│   ├── mutations-log.ts     # Append-only JSONL log + orphan reconciliation
│   └── nudges.ts            # Weekly/review nudge hooks
├── reviews/
│   ├── orchestrator.ts      # Review handler registry + dispatch
│   ├── session.ts           # ReviewSession lifecycle
│   ├── interview.ts         # Multi-phase interview state machine + post-agent dispatch
│   ├── worldview-drift.ts   # Flag projects whose thesis cites a recently-shifted worldview topic
│   ├── kb-activity.ts       # Recent KB-ingest digest for prep context
│   ├── blog.ts, health.ts, new-project.ts # Topical interview handlers
│   └── {daily,weekly,monthly,quarterly,yearly}.ts
├── vault/
│   ├── files.ts             # Read/write/list vault files (path-guarded)
│   ├── journal.ts           # Journal append + morning prep
│   ├── git.ts               # Git commit/push helpers
│   ├── sessions.ts          # TG session persistence + crash recovery
│   ├── learnings.ts         # /learn JSONL store + prompt prepend
│   ├── voice.ts             # writing/voice.md → prompt-prepend section
│   ├── equipment.ts         # Parse health/equipment.md for /workout
│   ├── whoop-recent.ts      # Recent Whoop days for /workout
│   └── watcher.ts           # FSWatcher for Readwise notifications + KB enqueue
├── workspace/
│   └── files.ts             # Read/write/append/list workspace files (path-guarded)
├── integrations/
│   ├── telegram/client.ts   # Message chunking, typing indicators
│   ├── whoop/               # Whoop OAuth + API client + keychain storage
│   └── readwise/client.ts   # Readwise Reader API
└── utils/
    ├── time.ts              # America/Chicago timezone helpers
    ├── intent-log.ts        # Ask-Twice telemetry → logs/intent-log.jsonl
    └── logger.ts            # Structured JSON logging
```

## How It Works

### AI Runtime

All AI operations spawn Claude Code CLI as a child process. No API keys, no token counting, no cost management — it runs on your Max subscription.

```
askClaude(message, sessionId, ...)        → multi-turn conversation
askClaudeWithContext(msg, sid, sys, opts) → multi-turn + system prompt (options bag)
askClaudeOneShot(message, ...)            → one-shot query (no session)
runAgent(name, prompt, ...)               → structured agent invocation
askHaikuOneShot(prompt, ...)              → classifier (resolver, intent-scan)
```

Every spawn registers an in-flight op so the user can `/cancel` (TG tracker message or webview pill). Per-session request queues prevent concurrent writes. The CLI runs with `cwd` set to your vault directory, so Claude automatically loads your vault's `CLAUDE.md` for context. Prose-producing call sites opt into a writing-voice prepend; classifiers and structured-data agents stay deterministic.

### Session Management

Each Telegram conversation gets a persistent session (UUID-based). Sessions survive bot restarts via JSON file persistence. Send `/fresh` to summarize and archive a session to your journal, `/fresh-full` to log the verbatim transcript, or `/clear` to drop the session without journaling.

### Skill resolver

Free-form Telegram or webview messages get classified against the skill registry (slash commands + agent skills) by a Haiku one-shot. If the top match's confidence ≥ `RESOLVER_CONFIDENCE_THRESHOLD`, the message is routed to that handler; otherwise it falls through to multi-turn conversation. Messages shorter than `RESOLVER_MIN_WORDS` skip the classifier entirely. `/learn` is the runtime knob — entries get prepended to every future agent invocation, so you can correct routing or shape behavior without touching code.

### Webview

`http://localhost:3847/` hosts a vanilla HTML/JS chat UI that mirrors the TG dispatcher in real time. Auth is a `JARVIS_HTTP_SECRET` cookie behind a host-guard allowlist (`JARVIS_ALLOWED_HOSTS`). The page is a thin shell over a WebSocket (`/api/ws`) plus REST endpoints (`/api/chat`, `/api/state`, `/api/mutations`, `/api/ops/:id/cancel`). It surfaces session messages, in-flight Claude ops with friendly labels, and active + recent mutations from the work-runner.

### MCP server

The KB is exposed as an MCP server (`jarvis-kb`) registered in `.claude/settings.json`, so any Claude Code session on the machine — not just Jarvis — can use `kb_query`, `kb_search`, `kb_ingest`, `kb_stats`, and `kb_lint` as tools.

### Mutation pipeline

Autonomous codebase operations go through `src/transport/mutations.ts`. The first applier is `work-runner` (`src/jobs/work-runner.ts`): given a project slug, it spawns Claude with `/work --auto` against the project's `spec.md` + `tasks.md`, streams stdout/stderr as `MutationEvent` frames, and enforces per-project and global concurrency caps. State transitions are logged append-only to `logs/mutations.jsonl`; orphaned `running` entries are flipped to `failed` on startup. The webview shows active + recent mutations and lets you cancel.

### Vault Integration

Jarvis treats the vault as a shared filesystem with a layered write model — see `CLAUDE.md` → "Vault Content Model" for the full breakdown:

- `knowledge/` is LLM-owned — `wiki-compiler` reads and writes freely.
- `world-view/`, `pages/playbook.md`, `projects/*.md`, `pages/psychology.md` and JSON data stores have **dedicated updater agents** (`worldview-updater`, `playbook-updater`, `project-updater`, `psychology-updater`, `json-updater`) that write under specific approval semantics (propose-only for world-view; append-on-approval for playbook; authoritative for projects/JSON).
- `writing/voice.md` is read on every prose-producing Claude call so the assistant matches your voice in replies, summaries, reviews, and drafts.
- All other directories are human-owned — Jarvis reads for context only.
- All writes go through `readVaultFile`/`writeVaultFile` helpers in `src/vault/files.ts`, which assert paths stay within the vault boundary.
- Git commits happen at key moments (morning prep, `/fresh`, post-review, nightly).

## Development

```bash
npm run dev      # Start with tsx watch (hot reload on file changes)
npm run build    # Type-check only (no emit)
```

The project uses ESM (`"type": "module"`) with `.js` import extensions. TypeScript runs directly via `tsx` — no build step needed.

## Status

Core surface is mature: Telegram bot + webview, knowledge base + MCP exposure, morning prep + nightly job, content + photo triage, all review commands, Whoop integration, vault commands, and the multi-layer vault content updaters (project / playbook / worldview / psychology / JSON). Recent additions: mutation pipeline + work-runner for autonomous `/work` runs, in-flight op cancellation, skill resolver for free-form routing, and writing-voice injection. Active iteration on the webview, MCP tooling, and spaced-repetition project.

See `docs/projects/index.md` for the current project board and `docs/projects/01-mvp/` for the original spec and task breakdown.

## Build Your Own

Want to build something like Jarvis without cloning this repo? See [`docs/idea.md`](docs/idea.md) — a self-contained blueprint you can hand to an AI coding agent to recreate the entire system from scratch.

## License

MIT
