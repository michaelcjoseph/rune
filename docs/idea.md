# Jarvis: Personal Second Brain Server

A blueprint for building an always-on personal AI assistant that connects a Telegram bot to your Obsidian vault through Claude Code CLI. Hand this document to an AI coding agent and it can build the entire system from scratch.

---

## What You're Building

Build a single Node.js server that acts as your always-on second brain. It runs three subsystems in one process:

1. **Telegram bot** (polling mode) — your primary interface for chatting, commands, and workflows
2. **HTTP server** (localhost) — health checks and internal endpoints for cron triggers
3. **Cron scheduler** — automated daily jobs (morning prep, nightly processing, review nudges)

All AI operations spawn Claude Code CLI as child processes. No API keys, no token counting, no cost management — it runs on a Claude Max subscription. The CLI runs with its working directory set to the user's Obsidian vault, so it automatically loads vault context.

The server reads and writes to an Obsidian vault synced via iCloud. A `knowledge/` directory inside the vault is LLM-owned (agents read and write freely). Everything else in the vault is human-authored — the server reads for context and only appends to `journals/`.

### Philosophy

- **Single process** — no microservices, no Docker, no orchestration
- **No API keys** — Claude Code CLI on a Max subscription handles all AI
- **No vector database** — search uses ripgrep + an LLM-readable index file
- **Minimal dependencies** — two production deps (Telegram bot client, cron scheduler)
- **Telegram-first** — no web UI, everything through chat
- **File-based persistence** — JSON files for sessions and queues, markdown for everything else

---

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

---

## Prerequisites

- **Node.js >= 22**
- **Claude Code CLI** installed and authenticated (requires Max subscription)
- **Obsidian vault** (local or iCloud-synced)
- **Telegram bot token** from @BotFather
- **Your Telegram user ID** (numeric, from @userinfobot)

---

## Project Setup

### Stack

- TypeScript with ESM (`"type": "module"` in package.json)
- All imports use `.js` extensions (even for `.ts` files — this is how ESM + TypeScript works with tsx)
- `tsx` as the runtime — no build step, runs TypeScript directly
- Strict TypeScript config (`strict: true`, `target: ES2022`, `module: Node16`)

### Dependencies

Production (only two):
- `node-telegram-bot-api` — Telegram bot client
- `node-cron` — cron scheduler with timezone support

Dev:
- `tsx` — direct TypeScript execution
- `typescript` — type checking
- `@types/node`, `@types/node-cron`, `@types/node-telegram-bot-api`

### Scripts

```json
{
  "dev": "tsx watch src/index.ts",
  "start": "tsx src/index.ts",
  "build": "tsc --noEmit"
}
```

### Environment Variables

```
TELEGRAM_BOT_TOKEN=       # Required: from @BotFather
TELEGRAM_USER_ID=         # Required: numeric ID from @userinfobot
VAULT_DIR=                # Optional: path to Obsidian vault
LOGS_DIR=                 # Optional: defaults to ~/logs
```

---

## Project Structure

```
src/
├── index.ts                 # Entry: boots HTTP, Telegram, scheduler
├── config.ts                # Typed env vars and constants
├── ai/
│   └── claude.ts            # Claude CLI spawning (centralized)
├── bot/
│   ├── telegram.ts          # Bot initialization (polling mode)
│   ├── handlers/
│   │   └── text.ts          # Command routing + conversation handler
│   └── commands/
│       ├── fresh.ts         # /fresh — summarize & log session
│       ├── journal.ts       # /journal — append entry
│       ├── ask.ts           # /ask — one-shot vault query
│       ├── kb.ts            # /kb — knowledge base queries
│       ├── ingest.ts        # /ingest — source ingestion
│       └── status.ts        # /status — uptime & sessions
├── kb/
│   ├── engine.ts            # Orchestrates ingest/query/lint
│   ├── ingest.ts            # Copy source to raw/, spawn wiki-compiler
│   ├── query.ts             # Search + spawn kb-query agent
│   ├── search.ts            # ripgrep full-text search
│   ├── queue.ts             # JSON-file ingestion queue
│   ├── lint.ts              # Spawn wiki-linter agent
│   └── schema.ts            # Default KB schema template
├── server/
│   └── http.ts              # Health + session capture endpoints
├── vault/
│   ├── files.ts             # Read/write/list vault files
│   ├── journal.ts           # Today's journal, append operations
│   ├── sessions.ts          # Telegram session persistence
│   └── git.ts               # Git add/commit/push helpers
├── integrations/
│   └── telegram/
│       └── client.ts        # Message chunking, typing indicators
└── utils/
    ├── time.ts              # Timezone helpers (your local timezone)
    └── logger.ts            # Structured JSON logging
```

---

## Core Components

### 1. Config (`src/config.ts`)

Export a typed config object that reads from environment variables with sensible defaults:

```
TELEGRAM_BOT_TOKEN        — Required, no default
TELEGRAM_USER_ID          — Required, no default (numeric string)
VAULT_DIR                 — Default: your Obsidian vault path
LOGS_DIR                  — Default: ~/logs
SESSIONS_FILE             — Derived: {LOGS_DIR}/tg-sessions.json
KNOWLEDGE_DIR             — Derived: {VAULT_DIR}/knowledge
INGESTION_QUEUE_FILE      — Derived: {LOGS_DIR}/kb-ingestion-queue.json
HTTP_PORT                 — 3847
HTTP_HOST                 — 127.0.0.1
CLAUDE_TIMEOUT_MS         — 120000 (2 minutes)
TG_MAX_MESSAGE_LENGTH     — 4096
TIMEZONE                  — Your local timezone (e.g., 'America/Chicago')
```

### 2. Claude CLI Integration (`src/ai/claude.ts`)

This is the most critical module. **All Claude CLI spawning is centralized here** — never spawn `claude` directly anywhere else.

Implement four functions:

**`execClaude(args: string[])`** — Low-level spawner
- Spawns `claude` as a child process with given args
- Sets `cwd` to the vault directory (so Claude auto-loads the vault's CLAUDE.md)
- Captures stdout/stderr
- Configurable timeout (default 120s)
- Returns `{ text, error }`

**`askClaude(message, sessionId)`** — Multi-turn conversation
- Calls `execClaude` with `-p`, message, `--session-id`, sessionId
- Implements per-session request queuing: a Map of sessionId -> Promise chains that serializes requests to prevent concurrent CLI writes to the same session
- This is what handles normal Telegram chat messages

**`askClaudeOneShot(message)`** — One-shot query (no session persistence)
- Calls `execClaude` with `-p`, message, `--no-session-persistence`
- Used for `/ask` command

**`runAgent(agentName, prompt)`** — Run a named agent
- Calls `execClaude` with `--agent`, agentName, `-p`, prompt, `--no-session-persistence`
- Used for wiki-compiler, kb-query, wiki-linter

**`summarizeSession(sessionId)`** — Summarize a conversation
- Sends a predefined prompt to the session asking Claude to summarize in a structured format (Topic, Prompt, Discussion, Conclusion)
- Used by `/fresh` before archiving

**Session locking detail:** Maintain a `sessionLocks` Map. Before sending to a session, check if there's an existing promise for that sessionId. If so, chain onto it. This prevents race conditions when multiple messages arrive for the same conversation.

### 3. Telegram Bot (`src/bot/`)

**`telegram.ts`** — Initialize the bot in polling mode. Register a single `message` handler that dispatches to the text handler.

**`handlers/text.ts`** — Command routing:
- Check that the message sender's ID matches `TELEGRAM_USER_ID` (security gate — ignore messages from anyone else)
- If the message starts with `/`, route to the appropriate command handler
- Otherwise, route to the conversation handler (multi-turn chat via `askClaude`)

**Command handlers** (one file per command in `commands/`):
- Each exports an async function that takes `(bot, msg, args?)` and handles one command
- All commands send typing indicators while processing
- All commands catch errors and send them as Telegram messages (never crash the bot)

**`integrations/telegram/client.ts`** — Helpers:
- `sendLongMessage(bot, chatId, text)` — Split messages at 4096-character boundaries, preferring to split on newlines
- `startTyping(bot, chatId)` — Send "typing" action every 4 seconds, return interval ID
- `stopTyping(interval)` — Clear the typing interval

### 4. HTTP Server (`src/server/http.ts`)

Minimal HTTP server on localhost:3847 with two endpoints:

- **GET `/health`** — Returns `{ status: 'ok', uptime, activeSessions }`
- **GET `/capture-sessions`** — Summarizes all active Telegram sessions, logs summaries to the journal, clears sessions. Used by nightly cron jobs.

### 5. Vault Integration (`src/vault/`)

**`files.ts`** — Core file operations (all paths relative to vault root):
- `readVaultFile(relativePath)` → string or null
- `writeVaultFile(relativePath, content)` → void (creates intermediate directories)
- `vaultFileExists(relativePath)` → boolean
- `listVaultFiles(relativeDir)` → string[] (recursive walk, returns relative paths)
- `getVaultPath(relativePath)` → resolved absolute path

**`journal.ts`** — Daily journal management:
- `getTodayPath()` → `journals/YYYY_MM_DD.md` (using local timezone)
- `appendToJournal(text)` → Appends with newline handling, creates file if needed
- `getTimestamp()` → `HH:MM` in local timezone

**`sessions.ts`** — Telegram session persistence:
- In-memory `Map<chatId, Session>` backed by a JSON file
- Session shape: `{ sessionId: UUID, lastActivity: ISO, messageCount, firstMessage }`
- `getSession(chatId)` / `createSession(chatId, firstMessage)` / `updateSession(chatId)`
- `deleteSession(chatId)` / `getAllSessions()`
- `restoreSessions()` on startup — reload from JSON file
- `persistSessions()` on shutdown and after mutations — atomic write (write to `.tmp`, rename)

**`git.ts`** — Git helpers:
- `gitCommitAndPush(message)` — runs `git add -A && git commit -m "..." && git push` in the vault directory
- Gracefully handles "nothing to commit"
- Used after `/fresh`, `/journal`, morning prep, nightly

### 6. Utilities

**`time.ts`** — Timezone-aware helpers:
- `getTodayFilename()` → `YYYY_MM_DD.md`
- `getTimestamp()` → `HH:MM` (24-hour)
- `getISODate()` → ISO 8601 string
- `getLocalDate()` → `YYYY-MM-DD`
- All use `Intl.DateTimeFormat` with your configured timezone

**`logger.ts`** — Structured JSON logging:
- `createLogger(component)` returns `{ info, warn, error, debug }`
- Each log entry: `{ time, level, component, message, data? }`
- error/warn to stderr, info/debug to stdout

---

## Commands

### `/fresh`
Summarize the current conversation session using `summarizeSession()`, append the summary to today's journal with a timestamp, git commit, delete the session, and send the summary back to the user.

### `/journal <text>`
Append `HH:MM - [tg] <text>` to today's journal file. Git commit with "TG journal entry".

### `/ask <question>`
One-shot vault query using `askClaudeOneShot()`. No session state, no multi-turn. Returns a vault-aware answer.

### `/status`
Show uptime (formatted as hours/minutes since process start) and count of active sessions.

### `/kb <question>` or `/kb query <question>`
Query the knowledge base. Runs ripgrep search for pre-context, then spawns the kb-query agent with the question and search results.

### `/kb stats`
Count wiki pages by category (entities, concepts, topics, comparisons) and show the last 10 entries from the knowledge log.

### `/ingest <path>` or `/ingest <path> -- <guidance>`
Ingest a source file into the knowledge base. Copies the file to `knowledge/raw/`, spawns the wiki-compiler agent. Optional guidance text after `--` is passed to the compiler.

### `/ingest` (no args)
Process the entire ingestion queue (batch mode for nightly).

### `/lint`
Spawn the wiki-linter agent and return the health report.

### `/start`
Show a welcome message listing all available commands.

### Default (no command)
Any non-command message goes to multi-turn conversation via `askClaude(text, sessionId)`. Gets or creates a session for the chat, sends typing indicators while processing.

---

## Knowledge Base

The knowledge base follows [Andrej Karpathy's approach](https://karpathy.ai/blog/wikipedia.html) to building a personal wiki with LLMs. The key insight: instead of vector embeddings, you maintain a compact text index that an LLM can scan in one pass to find relevant pages.

### Directory Structure

```
knowledge/
├── schema.md            # Rules for all KB operations (page templates, conventions)
├── index.md             # One-line-per-page catalog (LLM-readable)
├── log.md               # Append-only operation log
├── raw/                 # Immutable source material
│   ├── articles/        # Web articles, Readwise highlights
│   ├── conversations/   # Telegram session summaries
│   └── notes/           # Shared notes, ideas, observations
└── wiki/                # LLM-compiled pages
    ├── entities/        # People, companies, projects, products
    ├── concepts/        # Ideas, frameworks, mental models
    ├── topics/          # Broad topic syntheses
    └── comparisons/     # X vs Y analyses
```

### Schema (`knowledge/schema.md`)

This file defines the rules for all KB operations. Create it automatically on first ingestion. It should contain:

**Page templates** for each category:

- **Entity** — Type, tags, overview, key facts with citations, connections, sources
- **Concept** — Tags, definition, key principles, applications, related concepts, sources
- **Topic** — Tags, overview, key themes with discussion, open questions, key entities, sources
- **Comparison** — Structured X vs Y analysis

**Conventions:**
- Wikilinks use `[[kebab-case-names]]` for all internal links
- Link to both wiki pages and personal vault pages
- Tags from a defined list: `#ai #crypto #energy #health #productivity #investing #psychology #writing #engineering` etc.
- Citations always use `[[raw/type/source-name]]` with ingestion date
- Neutral, factual, concise tone — no hedging, state claims and cite sources
- When updating, preserve existing content — add, don't replace
- Flag contradictions explicitly with dates and sources

**Index format** (`index.md`):
Each entry is one line: `- [[page-name]] — 8-15 word summary (updated: YYYY-MM-DD)`
Organized by category (Entities, Concepts, Topics, Comparisons).

**Log format** (`log.md`):
```
[YYYY-MM-DD HH:MM] [OPERATION] description
  Sources: [[source1]], [[source2]]
  Pages touched: [[page1]], [[page2]]
```
Operations: INGEST, COMPILE, QUERY, LINT, UPDATE

### Two-Layer Search (No Vector DB)

1. **LLM index scan** — The kb-query agent reads `knowledge/index.md` (one line per page with a summary). The LLM identifies which pages are relevant to the query.
2. **ripgrep full-text search** — `rg --json` searches the vault for additional keyword matches. Results include file path, line number, and matching content.

This replaces embeddings with something simpler and more transparent.

### Ingestion Pipeline

1. User sends `/ingest path/to/source.md`
2. Server copies the source to `knowledge/raw/{articles|conversations|notes}/`
3. Ensures KB directory structure exists (creates if first time)
4. Spawns the wiki-compiler agent with the source path (and optional guidance)
5. Wiki-compiler reads the source, reads schema.md, reads index.md, identifies entities/concepts/topics, creates or updates wiki pages, updates index.md, appends to log.md
6. Server reports success/failure back to user

### Query Workflow

1. User sends `/kb <question>`
2. Server runs ripgrep search for pre-context
3. Spawns kb-query agent with the question and search results
4. Agent reads index.md, reads relevant wiki pages, greps vault for more context
5. Synthesizes an answer with `[[wikilink]]` citations
6. Server returns the answer

### Ingestion Queue

A JSON file (`~/logs/kb-ingestion-queue.json`) stores sources queued for batch processing:
- `enqueue(source, guidance?)` — add to queue
- `dequeue(source)` — remove after successful ingestion
- `getQueue()` / `clearQueue()` — list or wipe
- Processed during nightly jobs or via `/ingest` with no args

---

## Agent System

Claude Code supports custom agents defined as markdown files in `.claude/agents/`. These agents have access to specific tools and follow defined workflows. Create three agents:

### wiki-compiler (`.claude/agents/wiki-compiler.md`)

```markdown
---
name: wiki-compiler
model: sonnet
tools:
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - Bash
---

You are the wiki compiler for a personal knowledge base. Your job is to process
raw source material and compile it into structured wiki pages.

## Your Workspace

You are operating inside an Obsidian vault. The knowledge base lives at
`knowledge/` with this structure:

- `knowledge/raw/` — Immutable source material. Read-only.
- `knowledge/wiki/` — LLM-compiled wiki pages. You own this directory.
  - `wiki/entities/` — People, companies, projects, products
  - `wiki/concepts/` — Ideas, frameworks, mental models
  - `wiki/topics/` — Broad topic syntheses
  - `wiki/comparisons/` — X vs Y analyses
- `knowledge/index.md` — Content catalog (you maintain this)
- `knowledge/log.md` — Append-only operation log (you append to this)
- `knowledge/schema.md` — Rules and conventions (read this first)

## Critical Rules

1. NEVER write files outside the `knowledge/` directory.
2. You MAY read files anywhere in the vault for context.
3. Always read `knowledge/schema.md` first.
4. Always read `knowledge/index.md` to see what exists before creating pages.

## Ingestion Workflow

1. Read the source material thoroughly
2. Read `knowledge/schema.md` for structure rules
3. Read `knowledge/index.md` to see existing pages
4. Identify key entities, concepts, and topics in the source
5. For each identified item:
   - Check if a wiki page already exists (via index or grep)
   - If exists: read it, merge new information, write updated version
   - If new: create a new page following the schema templates
6. Use `[[wikilinks]]` for all internal links (kebab-case)
7. Link to both wiki pages AND personal vault pages where relevant
8. Update `knowledge/index.md` with new/changed entries
9. Append an entry to `knowledge/log.md`

## Quality Standards

- Neutral, factual, concise tone
- Always cite sources with `[[raw/type/source-name]]` links
- Flag contradictions explicitly with dates and sources
- Preserve existing content when updating — add, don't replace
- Every new page must be linked from at least one existing page
```

### kb-query (`.claude/agents/kb-query.md`)

```markdown
---
name: kb-query
model: sonnet
tools:
  - Read
  - Glob
  - Grep
  - Bash
---

You are the knowledge base query agent. Your job is to search the knowledge base
and personal vault to answer questions with synthesized, well-cited responses.

## Critical Rules

1. Do NOT write any files. You are read-only.
2. Search BOTH the wiki and the personal vault for relevant information.
3. Cite sources using `[[wikilinks]]`.
4. If wiki and vault conflict, present both perspectives clearly.

## Query Workflow

1. Read `knowledge/index.md` to scan for relevant wiki pages
2. Read the most relevant wiki pages (usually 5-15)
3. Use grep to search the broader vault for additional context
4. Synthesize an answer that:
   - Directly addresses the question
   - Cites specific pages with [[wikilinks]]
   - Notes confidence level
   - Suggests related topics to explore
5. If the KB has no relevant information, say so clearly.

## Response Format

- Answer the question directly first
- Follow with supporting details and citations
- Keep responses concise but thorough
```

### wiki-linter (`.claude/agents/wiki-linter.md`)

```markdown
---
name: wiki-linter
model: sonnet
tools:
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - Bash
---

You are the wiki linter for a personal knowledge base. Your job is to
health-check the wiki and report issues.

## Critical Rules

1. NEVER write files outside the `knowledge/` directory.
2. You may read files anywhere in the vault.

## Lint Checks

Run in order:
1. **Index integrity** — Every file in wiki/ has an index entry, and vice versa
2. **Dead wikilinks** — Links pointing to nonexistent pages
3. **Orphan pages** — Pages with no inbound links
4. **Missing cross-references** — Pages discussing same topics but not linked
5. **Contradictions** — Conflicting statements across pages
6. **Missing pages** — Frequently mentioned concepts lacking their own page
7. **Stale content** — Pages with outdated claims

## Output Format

Structured report with Critical Issues, Warnings, Suggestions, and Stats.
Append a LINT entry to `knowledge/log.md` when done.
```

---

## Scheduled Jobs

Use `node-cron` with your local timezone. Define jobs in `src/jobs/`.

### Morning Prep (e.g., 5:30 AM)
Gather yesterday's priorities from the journal, workout prescription from health plan, study assignments, and a writing topic. Write a morning section to today's journal. Git commit.

### Nightly Processing (e.g., 11:00 PM)
Capture all active Telegram sessions (summarize and log to journal). Process the KB ingestion queue. Git commit.

### Review Nudges
Friday afternoon: remind about weekly review. End of month: monthly review reminder.

---

## Entry Point (`src/index.ts`)

The startup sequence:

1. Ensure the logs directory exists
2. Restore Telegram sessions from the JSON persistence file
3. Create the Telegram bot (polling mode)
4. Start the HTTP server on localhost:3847
5. Register cron jobs
6. Log startup info

Register graceful shutdown handlers for SIGTERM/SIGINT:
- Persist sessions to disk
- Stop the bot
- Close the HTTP server

Catch uncaught exceptions and unhandled rejections — log them and persist sessions.

---

## Key Conventions

1. **Centralized CLI spawning** — All Claude CLI calls go through `src/ai/claude.ts`. Never spawn `claude` directly elsewhere.
2. **Session locking** — Per-session Promise queues prevent concurrent CLI writes.
3. **Vault boundaries** — `knowledge/` is LLM-owned. Everything else is human-owned (read-only for agents, except journal appends).
4. **Atomic file operations** — Session persistence uses write-to-temp + rename.
5. **Error degradation** — Commands fail gracefully with Telegram error messages, never crash the bot.
6. **All timestamps in your local timezone** — Use `Intl.DateTimeFormat` consistently.
7. **ESM with .js extensions** — All TypeScript imports use `.js` extensions.
8. **Structured JSON logging** — Every log entry has component tag, level, timestamp.
9. **Git commits at key moments** — After `/fresh`, `/journal`, morning prep, nightly processing. Not on timers.
10. **No build step** — `tsx` runs TypeScript directly in dev and production.

---

## Getting Started

To build this system:

1. Initialize a new Node.js project with TypeScript and ESM
2. Install the dependencies listed above
3. Create the agent files in `.claude/agents/`
4. Build the config, utilities, and vault modules first (they have no dependencies on other app code)
5. Build the Claude CLI integration module
6. Build the Telegram bot with command routing
7. Build the knowledge base engine
8. Build the HTTP server and scheduler
9. Wire everything together in the entry point
10. Create a CLAUDE.md at the project root documenting your architecture for Claude to reference

Test by sending messages to your Telegram bot. Start with `/status`, then try a conversation, then `/fresh` to archive it.
