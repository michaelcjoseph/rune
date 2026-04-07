# Jarvis

Always-on personal second brain server. Connects a Telegram bot to your Obsidian vault through Claude Code CLI.

A single Node.js process that combines a Telegram bot, an LLM-powered knowledge base, scheduled daily workflows, and deep vault awareness — all backed by Claude Code with no API keys required.

## What it does

**Chat with your vault.** Send a message via Telegram and get a vault-aware response. Multi-turn conversations persist across messages. Send `/fresh` to summarize, log to your journal, and reset.

**Build a knowledge base.** Ingest articles, conversations, and notes into a [Karpathy-style](https://karpathy.ai/blog/wikipedia.html) LLM wiki. Raw sources are compiled into interlinked wiki pages organized by entities, concepts, topics, and comparisons. Query the wiki with natural language and get synthesized answers with citations.

**Run structured reviews.** Interview-based weekly, monthly, quarterly, and yearly reviews conducted through Telegram. Prep agents scan your journals and vault systems silently, then Claude conducts a real conversation — surfacing quotes, challenging narratives, and producing write-ups appended to your journal.

**Automate daily operations.** Morning journal prep (priorities, workout, study plan, writing topic), end-of-day tag processing (`#book`, `#crm`, `#workout`, etc. to JSON data stores), nightly session capture, and review nudges on a schedule.

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

### Reviews (planned)
| Command | Description |
|---------|-------------|
| `/daily` | End-of-day tag processing and JSON updates |
| `/weekly` | Interview-based weekly review (~30 min) |
| `/monthly` | Monthly theme check-in and reflection |
| `/quarterly` | 3-month patterns and strategic decisions |
| `/yearly` | Annual reflection with 7 Questions framework |

### Vault Operations (planned)
| Command | Description |
|---------|-------------|
| `/priorities` | Today's priorities from yesterday's journal |
| `/workout` | Today's workout prescription |
| `/study` | Current study progress and assignments |
| `/think <topic>` | Thinking partner mode |
| `/health` | Health coaching session |

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

## Agents

Custom Claude Code agents handle structured operations:

| Agent | Location | Purpose |
|-------|----------|---------|
| wiki-compiler | `.claude/agents/` | Compile raw sources into wiki pages |
| kb-query | `.claude/agents/` | Search wiki + vault, synthesize answers |
| wiki-linter | `.claude/agents/` | Health-check wiki integrity |

The vault can also define its own agents (e.g., journal-scanner, review-writer) that Jarvis invokes for review workflows.

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
VAULT_DIR=/path/to/your/obsidian/vault   # optional, defaults to iCloud path
LOGS_DIR=~/logs                           # optional
```

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
├── jobs/                 # Scheduled cron jobs
├── reviews/              # Review session state machine (planned)
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

Jarvis treats the vault as a shared filesystem:
- `knowledge/` is LLM-owned — agents read and write freely
- Everything else is human-owned — Jarvis reads for context, writes only to `journals/`
- All writes go through `readVaultFile`/`writeVaultFile` helpers
- Git commits happen at key moments (morning prep, `/fresh`, nightly)

## Development

```bash
npm run dev      # Start with tsx watch (hot reload on file changes)
npm run build    # Type-check only (no emit)
```

The project uses ESM (`"type": "module"`) with `.js` import extensions. TypeScript runs directly via `tsx` — no build step needed.

## Status

Phases 0-3 are complete (server, bot, knowledge base). Currently building vault consolidation (phases 4-7): morning prep, review commands, additional vault commands, and scheduled automation.

See `docs/projects/01-mvp/` for the full spec and task breakdown.

## Build Your Own

Want to build something like Jarvis without cloning this repo? See [`docs/idea.md`](docs/idea.md) — a self-contained blueprint you can hand to an AI coding agent to recreate the entire system from scratch.

## License

MIT
