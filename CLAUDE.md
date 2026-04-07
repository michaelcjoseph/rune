# Jarvis

Always-on personal second brain server. TypeScript/Node.js.

## Architecture

Single Node.js process handles everything:
- **Telegram bot** (polling mode) — chat, commands, content triage, photos
- **HTTP server** (localhost:3847) — health endpoint, session capture for nightly
- **Scheduled jobs** (node-cron) — morning prep, Whoop sync, nightly processing, review nudges
- **Knowledge base engine** — Karpathy-style LLM wiki (raw sources → compiled wiki pages)

All AI operations use Claude Code CLI (Max subscription, no API key needed). Custom agents in `.claude/agents/` handle structured KB operations (wiki-compiler, kb-query, wiki-linter).

The server reads/writes to an Obsidian vault synced via iCloud. The `knowledge/` directory inside the vault is LLM-owned; everything else is human-authored and read-only for agents.

## Project Structure

```
src/
├── index.ts                 # Entry point: boots HTTP server, Telegram bot, scheduler
├── config.ts                # Typed env vars and constants
├── ai/claude.ts             # All Claude CLI spawning: askClaude, runAgent, summarizeSession
├── bot/
│   ├── telegram.ts          # Bot init and message dispatch
│   ├── handlers/text.ts     # Command routing + multi-turn conversation handler
│   └── commands/            # One file per command: fresh, journal, ask, kb, ingest, status
├── kb/
│   ├── engine.ts            # Orchestrates ingest/query/lint, processes ingestion queue
│   ├── ingest.ts            # Copy source to raw/ → spawn wiki-compiler agent
│   ├── query.ts             # Build context → spawn kb-query agent → synthesized answer
│   ├── lint.ts              # Spawn wiki-linter agent → health report
│   ├── search.ts            # ripgrep-based full-text search across vault + wiki
│   ├── queue.ts             # JSON-file ingestion queue (enqueue/dequeue/clear)
│   └── schema.ts            # Default schema.md content for new knowledge bases
├── jobs/                    # Scheduled cron jobs (morning-prep, whoop, nightly, nudges)
├── integrations/
│   ├── telegram/client.ts   # Message chunking, typing indicators
│   ├── whoop/               # OAuth2 + Whoop API (future)
│   └── readwise/            # Readwise API (future)
├── vault/
│   ├── files.ts             # Read/write/list vault markdown files
│   ├── journal.ts           # Today's journal file creation + append
│   ├── git.ts               # git add/commit/push helpers
│   ├── sessions.ts          # TG session Map with JSON persistence + crash recovery
│   └── watcher.ts           # FSWatcher for Readwise article detection (future)
└── utils/
    ├── time.ts              # America/Chicago timezone helpers (getTodayFilename, getTimestamp)
    ├── logger.ts            # Structured JSON logging with component tags
    └── markdown.ts          # Markdown parsing utilities (future)
```

## Key Conventions

- **TypeScript** with `tsx` runner — no build step needed for dev or prod
- **ESM** (`"type": "module"` in package.json) — all imports use `.js` extensions
- All timestamps use `America/Chicago` timezone
- Config reads from env vars; defaults in `src/config.ts`
- Claude CLI spawning is centralized in `src/ai/claude.ts` — never spawn `claude` directly elsewhere
- Session locks prevent concurrent CLI writes to the same session ID
- Git commits happen at key moments (morning prep, /fresh, nightly), not on timers
- Vault files use `readVaultFile`/`writeVaultFile` from `src/vault/files.ts` — paths are relative to vault root
- KB agents **must not** write outside `knowledge/`

## Running

```bash
npm run dev    # Development with tsx watch mode
npm run start  # Production
npm run cli    # Local CLI interface (future)
```

## Environment Variables

Required:
- `TELEGRAM_BOT_TOKEN` — from @BotFather
- `TELEGRAM_USER_ID` — numeric ID from @userinfobot

Optional:
- `VAULT_DIR` — defaults to `~/Library/Mobile Documents/iCloud~md~obsidian/Documents/your-vault-name`
- `LOGS_DIR` — defaults to `~/logs`

## Agents

| Agent | File | Purpose |
|---|---|---|
| wiki-compiler | `.claude/agents/wiki-compiler.md` | Ingest raw sources → create/update wiki pages |
| kb-query | `.claude/agents/kb-query.md` | Search wiki + vault → synthesized answer |
| wiki-linter | `.claude/agents/wiki-linter.md` | Health-check wiki for issues |

## Reference

- `_old/` contains the original JS implementation — use as reference, do not modify
- `_old/docs/system/` has detailed docs for each subsystem (telegram-bot, whoop-sync, morning-prep, nightly-processing, readwise-scanner, infrastructure)
