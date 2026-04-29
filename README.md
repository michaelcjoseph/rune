# Jarvis

Always-on personal second brain server. Connects a Telegram bot to your Obsidian vault through Claude Code CLI.

A single Node.js process that combines a Telegram bot, an LLM-powered knowledge base, scheduled daily workflows, and deep vault awareness — all backed by Claude Code with no API keys required.

## What it does

**Chat with your vault.** Send a message via Telegram and get a vault-aware response. Multi-turn conversations persist across messages. Send `/fresh` to summarize, log to your journal, and reset.

**Build a knowledge base.** Ingest articles, conversations, and notes into a [Karpathy-style](https://karpathy.ai/blog/wikipedia.html) LLM wiki. Raw sources are compiled into interlinked wiki pages organized by entities, concepts, topics, and comparisons. Query the wiki with natural language and get synthesized answers with citations.

**Run structured reviews.** Interview-based weekly, monthly, quarterly, and yearly reviews conducted through Telegram. Prep agents scan your journals and vault systems silently, then Claude conducts a real conversation — surfacing quotes, challenging narratives, and producing write-ups appended to your journal.

**Automate daily operations.** Morning journal prep (priorities, study plan, writing topic), end-of-day tag processing (`#books`, `#crm`, `#workout`, etc. to JSON data stores), nightly session capture, and review nudges on a schedule.

## Architecture

```
┌─────────────────────────────────────────────┐
│                 Node.js Process              │
│                                              │
│  ┌──────────┐  ┌──────────┐  ┌───────────┐  │
│  │ Telegram  │  │   HTTP   │  │ Scheduler │  │
│  │   Bot     │  │  Server  │  │ (cron)    │  │
│  └────┬──┬──┘  └────┬─────┘  └─────┬─────┘  │
│       │  │          │              │          │
│  ┌────┴──┴──────────┴──────────────┴──────┐  │
│  │           Claude Code CLI              │  │
│  │  (spawned as child process per call)   │  │
│  └────────────────┬───────────────────────┘  │
│                   │                          │
│  ┌────────────────┴───────────────────────┐  │
│  │          Obsidian Vault (iCloud)       │  │
│  │  journals/ pages/ knowledge/ health/   │  │
│  └────────────────────────────────────────┘  │
└─────────────────────────────────────────────┘
```

- **Telegram bot** (polling) — chat, commands, multi-turn sessions, review interviews
- **HTTP server** (localhost:3847) — health check, session capture endpoint
- **Scheduler** (node-cron) — morning prep, nightly processing, review nudges
- **Knowledge base** — two-layer search (LLM index scan + ripgrep), no vector DB
- **Claude Code CLI** — all AI operations, no API key needed (runs on Max subscription)

## Commands

### Core
| Command | Description |
|---------|-------------|
| `/fresh` | Summarize conversation, log to journal, reset session |
| `/journal <text>` | Append timestamped entry to today's journal |
| `/ask <question>` | One-shot vault query |
| `/status` | Uptime, active sessions, last job runs |

### Knowledge Base
| Command | Description |
|---------|-------------|
| `/kb <question>` | Query the knowledge base |
| `/kb stats` | Page counts by category |
| `/ingest [path]` | Ingest source into wiki (or process queue) |
| `/lint` | Run wiki health check |

### Reviews
| Command | Description |
|---------|-------------|
| `/daily` | End-of-day tag processing and JSON updates |
| `/weekly` | Interview-based weekly review (~30 min). Post-approval, updates project pages, playbook entries, world-view files, and psychology profile via specialist agents. |
| `/monthly` | Monthly theme check-in and reflection |
| `/quarterly` | 3-month patterns and strategic decisions |
| `/yearly` | Annual reflection with 7 Questions framework |

### Vault Operations
| Command | Description |
|---------|-------------|
| `/priorities` | Today's priorities from yesterday's journal |
| `/workout [home\|gym] [focus]` | Generate a tailored workout (warmup → main → cooldown) from goals, equipment, recent training, and Whoop recovery |
| `/done-workout` | Append the last generated workout to today's journal with a `#workout` tag |
| `/study` | Current study progress and assignments |
| `/think <topic>` | Thinking partner mode |
| `/health` | Health coaching session |
| `/family` | 14-day journal scan for configured family-name mentions (requires `FAMILY_NAMES` env) |
| `/blog <topic>` | Interview-based blog drafting |
| `/lenny <topic>` / `/pg <topic>` | Library search (Lenny's Podcast / Paul Graham essays) |

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

## Vault Content Model

The vault has four LLM-mutable content layers with **different write semantics**. They stay distinct on purpose — each has its own cadence, tone, and audit trail.

| Layer | Write semantics | Updater agent | Trigger |
|---|---|---|---|
| `knowledge/` | Wiki with `last-verified` + `valid-until` — pages decay | `wiki-compiler` | KB ingestion queue (nightly + on-demand) |
| `world-view/*.md` | First-person essays with `### [[YYYY_MM_DD]]` changelog — beliefs evolve with audit trail | `worldview-updater` | Review outline approval (propose-only) |
| `pages/playbook.md` | Append-only tactical entries with stable anchors | `playbook-proposer` + `playbook-updater` | `#playbook` journal tag → nightly queue → next review approval |
| `projects/*.md` | Living logs: status + thesis + decisions + weekly summaries | `project-updater` | Review outline approval (authoritative) |

`knowledge/` is the neutral reference layer — wiki pages *cite* the other three (via `knowledge/raw/{world-view,playbook,projects}/`). The flow is one-way: human-authored layers feed the KB as raw sources; the KB does not own them.

After a review, files touched by the post-agents are auto-enqueued for the next nightly KB ingestion so wiki citations stay fresh. See `CLAUDE.md` for the full mechanics (review→post-agent flow, worldview-drift detection, KB raw-source routing).

## Agents

Custom Claude Code agents handle structured operations. Agents live in `.claude/agents/` in this repo (generic tooling, public) with fallback to `$VAULT_DIR/.claude/agents/` (personal content, private). `loadAgentDef` in `src/ai/claude.ts` checks Jarvis first, then the vault.

**Jarvis-local (generic tooling):**

| Agent | Purpose |
|-------|---------|
| wiki-compiler | Compile raw sources into wiki pages |
| kb-query | Search wiki + vault, synthesize answers |
| wiki-linter | Health-check wiki integrity |
| morning-prep | Gather vault data into a structured morning journal section |
| session-summarizer | Rich session summaries with vault context |
| release-notes | Generate changelog from git history |
| content-triager | Classify URLs/text → kb-ingest, readwise, journal, or skip |
| photo-classifier | Classify photos → book, receipt, whiteboard, etc. with routing |
| system-scanner | Review prep: summarize state of health/study/psychology/etc. |
| project-updater | Post-review: apply approved updates to `projects/*.md` |
| playbook-proposer | Nightly: draft playbook entries from `#playbook`-tagged journals |
| playbook-updater | Post-review: append approved drafts to `pages/playbook.md` |
| worldview-updater | Post-review: apply approved diffs to `world-view/*.md` with changelog entry (propose-only semantics enforced upstream) |
| psychology-updater | Post-review: scoped updates to `pages/psychology.md` |
| json-updater | Post-review / nightly: apply updates to JSON data stores |

**Vault-resident (personal specifics kept out of the public repo):**

| Agent | Purpose |
|-------|---------|
| journal-scanner | Review prep: scan journals by date range + focus areas |
| project-scanner | Review prep: compare project pages against recent journal activity |
| review-writer | Review writeup: append formatted review to the journal |

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
TELEGRAM_BOT_TOKEN=your-bot-token
TELEGRAM_USER_ID=your-numeric-user-id
VAULT_DIR=/path/to/your/obsidian/vault

# Optional
FAMILY_NAMES=Alice,Bob          # enables /family
WHOOP_CLIENT_ID=...
WHOOP_CLIENT_SECRET=...
READWISE_TOKEN=...
JARVIS_HTTP_SECRET=...          # required if you use the authenticated HTTP endpoints
```

`LOGS_DIR` is not configurable — it's hardcoded to `<project-root>/logs/` (gitignored).

### Run

```bash
npm run dev    # Development (hot reload)
npm run start  # Production
```

The server starts the Telegram bot (polling), HTTP server on port 3847, and cron scheduler.

### Initialize the Knowledge Base

Send `/ingest` via Telegram with a path to any markdown file in your vault. The wiki-compiler agent will process it and create your first wiki pages. The `knowledge/` directory is created automatically on first ingestion.

## Project Structure

```
src/
├── index.ts              # Entry: boots HTTP, Telegram, scheduler
├── config.ts             # Typed env vars and constants
├── ai/claude.ts          # Claude CLI spawning (ask, one-shot, agent)
├── bot/
│   ├── telegram.ts       # Bot init and polling
│   ├── handlers/text.ts  # Command routing + conversation handler
│   └── commands/         # One file per command
├── kb/
│   ├── engine.ts         # Ingest/query/lint orchestration
│   ├── ingest.ts         # Source → raw/ → wiki-compiler agent
│   ├── query.ts          # Search + kb-query agent → answer
│   ├── search.ts         # ripgrep full-text search
│   └── queue.ts          # JSON-file ingestion queue
├── jobs/
│   ├── nightly.ts        # Capture → KB queue → daily tags → playbook extract → Whoop → lint → commit
│   ├── playbook-extract.ts # Scan #playbook tags → draft entries into playbook-queue.json
│   ├── morning-prep.ts   # Morning journal preparation
│   └── whoop-sync.ts     # Whoop sleep/activity sync
├── reviews/
│   ├── interview.ts      # Multi-phase interview state machine, post-agent dispatch
│   ├── worldview-drift.ts # Detect world-view changes affecting active projects
│   └── {weekly,monthly,quarterly,yearly,daily,...}.ts
├── vault/
│   ├── files.ts          # Read/write/list vault files
│   ├── journal.ts        # Journal append + morning prep
│   ├── git.ts            # Git commit/push helpers
│   └── sessions.ts       # Telegram session persistence
└── utils/
    ├── time.ts           # America/Chicago timezone helpers
    └── logger.ts         # Structured JSON logging
```

## How It Works

### AI Runtime

All AI operations spawn Claude Code CLI as a child process. No API keys, no token counting, no cost management — it runs on your Max subscription.

```
askClaude(message, sessionId)   → multi-turn conversation
askClaudeOneShot(message)       → one-shot query
runAgent(name, prompt)          → structured agent operation
```

Per-session request queues prevent concurrent writes. The CLI runs with `cwd` set to your vault directory, so Claude automatically loads your vault's `CLAUDE.md` for context.

### Session Management

Each Telegram conversation gets a persistent session (UUID-based). Sessions survive bot restarts via JSON file persistence. Send `/fresh` to summarize and archive a session to your journal.

### Vault Integration

Jarvis treats the vault as a shared filesystem with a layered write model — see `CLAUDE.md` → "Vault Content Model" for the full breakdown:

- `knowledge/` is LLM-owned — `wiki-compiler` reads and writes freely.
- `world-view/`, `pages/playbook.md`, `projects/*.md`, `pages/psychology.md` and JSON data stores have **dedicated updater agents** (`worldview-updater`, `playbook-updater`, `project-updater`, `psychology-updater`, `json-updater`) that write under specific approval semantics (propose-only for world-view; append-on-approval for playbook; authoritative for projects/JSON).
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

MVP is implemented end-to-end: Telegram bot, knowledge base, morning prep, nightly job, content triage, all review commands (daily / weekly / monthly / quarterly / yearly), Whoop integration, vault commands, and the multi-layer vault content updaters (project / playbook / worldview / psychology / JSON). Active maintenance and iteration on top.

See `docs/projects/01-mvp/` for the original spec and task breakdown.

## Build Your Own

Want to build something like Jarvis without cloning this repo? See [`docs/idea.md`](docs/idea.md) — a self-contained blueprint you can hand to an AI coding agent to recreate the entire system from scratch.

## License

MIT
