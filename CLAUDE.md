# Jarvis

Always-on personal second brain server. TypeScript/Node.js.

## Architecture

Single Node.js process handles everything:
- **Telegram bot** (polling mode) — chat, commands, content triage, photos
- **HTTP server** (localhost:3847) — health endpoint, session capture for nightly
- **Scheduled jobs** (node-cron) — morning prep, Whoop sync, nightly processing, review nudges
- **Review system** — multi-phase session-based reviews (daily/weekly/monthly/quarterly/yearly) + think/health/blog sessions
- **Knowledge base engine** — Karpathy-style LLM wiki (raw sources → compiled wiki pages)

All AI operations use Claude Code CLI (Max subscription, no API key needed). Custom agents in `.claude/agents/` handle structured KB operations (wiki-compiler, kb-query, wiki-linter).

The server reads/writes to an Obsidian vault synced via iCloud. The vault has four distinct LLM-mutable content layers (knowledge/, world-view/, pages/playbook.md, projects/) plus JSON data stores and `pages/psychology.md`, each with its own write semantics and updater agent. See the **Vault Content Model** section below.

## Project Structure

```
src/
├── index.ts                 # Entry point: boots HTTP server, Telegram bot, scheduler
├── config.ts                # Typed env vars and constants
├── ai/claude.ts             # All Claude CLI spawning: askClaude, runAgent, summarizeSession
├── bot/
│   ├── telegram.ts          # Bot init and message dispatch
│   ├── handlers/text.ts     # Command routing + multi-turn conversation handler
│   ├── handlers/url.ts      # URL detection, fetch, content-triager agent, routing
│   ├── handlers/photo.ts    # Photo download, photo-classifier agent, routing
│   └── commands/
│       ├── fresh.ts         # /fresh — clear session, git commit
│       ├── journal.ts       # /journal — append to today's journal
│       ├── ask.ts           # /ask — freeform Claude question
│       ├── kb.ts            # /kb — knowledge base query
│       ├── ingest.ts        # /ingest — enqueue vault file for KB ingestion
│       ├── status.ts        # /status — system health overview
│       ├── prep.ts          # /prep — trigger morning prep
│       ├── priorities.ts    # /priorities — review/set daily priorities
│       ├── daily.ts         # /daily — daily review session
│       ├── weekly.ts        # /weekly — weekly review session
│       ├── monthly.ts       # /monthly — monthly review session
│       ├── quarterly.ts     # /quarterly — quarterly review session
│       ├── yearly.ts        # /yearly — yearly review session
│       ├── think.ts         # /think — open-ended thinking session
│       ├── health.ts        # /health — health review session
│       ├── blog.ts          # /blog — blog post drafting session
│       ├── workout.ts       # /workout — workout planning/review
│       ├── study.ts         # /study — study session planning
│       ├── family.ts        # /family — family planning/review
│       ├── career.ts        # /career — career reflection/planning
│       ├── lenny.ts         # /lenny — library search (Lenny's Newsletter)
│       └── pg.ts            # /pg — library search (Paul Graham essays)
├── reviews/
│   ├── session.ts           # ReviewSession type, persistence, lifecycle management
│   ├── orchestrator.ts      # Review flow orchestrator: start, route messages, handler registry
│   ├── interview.ts         # Interactive interview phase for review sessions
│   ├── worldview-drift.ts   # Detect world-view changelog entries affecting active projects
│   ├── daily.ts             # Daily review handler
│   ├── weekly.ts            # Weekly review handler
│   ├── monthly.ts           # Monthly review handler
│   ├── quarterly.ts         # Quarterly review handler
│   ├── yearly.ts            # Yearly review handler
│   ├── think.ts             # Think session handler
│   ├── health.ts            # Health review handler
│   └── blog.ts              # Blog drafting handler
├── server/
│   └── http.ts              # HTTP server: health, session capture, Whoop OAuth callback
├── kb/
│   ├── engine.ts            # Orchestrates ingest/query/lint, processes ingestion queue
│   ├── init.ts              # KB directory scaffolding and schema initialization
│   ├── ingest.ts            # Copy source to raw/ → spawn wiki-compiler agent
│   ├── query.ts             # Build context → spawn kb-query agent → synthesized answer
│   ├── lint.ts              # Spawn wiki-linter agent → health report
│   ├── search.ts            # ripgrep-based full-text search across vault + wiki
│   ├── queue.ts             # JSON-file ingestion queue (enqueue/dequeue/clear)
│   └── schema.ts            # Default schema.md content for new knowledge bases
├── jobs/
│   ├── scheduler.ts         # Cron job registration: startScheduler(bot), stopScheduler()
│   ├── morning-prep.ts      # Gather vault data → synthesize morning prep → write to journal
│   ├── nightly.ts           # Nightly orchestrator: capture → KB queue → daily tags → playbook extract → whoop → lint → commit
│   ├── capture.ts           # Session capture logic (used by HTTP endpoint + nightly job)
│   ├── whoop-sync.ts        # Whoop sleep sync (8am) + activity sync (nightly) + trends
│   ├── playbook-extract.ts  # Scan today's journal for #playbook tags → draft entries into playbook-queue.json
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
│   ├── files.ts             # Read/write/list vault markdown files
│   ├── journal.ts           # Journal file creation, append, writeMorningPrep, parseTag
│   ├── git.ts               # git add/commit/push helpers
│   ├── sessions.ts          # TG session Map with JSON persistence + crash recovery
│   └── watcher.ts           # FSWatcher for Readwise article detection, TG notify + enqueue
└── utils/
    ├── time.ts              # America/Chicago timezone helpers (getTodayFilename, getYesterdayFilename, getTimestamp, getDayOfWeek, getRecentFilenames, etc.)
    ├── logger.ts            # Structured JSON logging with component tags
    └── markdown.ts          # Markdown parsing utilities (future)
cli/
└── jarvis.ts                # CLI entry point for local interactive use
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

`src/reviews/interview.ts` drives review sessions. After the user approves the outline:
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
- anything with `conversation` in the path → `knowledge/raw/conversations/`
- fallback → `knowledge/raw/notes/`

Mutable sources (world-view, playbook, active projects) **overwrite** the `raw/` copy on every re-ingest (see `isMutableSource()`) so wiki citations reflect current content. Immutable sources (Readwise, conversations) are copied once.

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
- Wiki pages use YAML frontmatter for metadata (type, tags, related, created, last-verified, valid-until) — see `src/kb/schema.ts`

## Running

```bash
npm run dev    # Development with tsx watch mode
npm run start  # Production
npm run cli    # Local CLI interface
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

`LOGS_DIR` is hardcoded to `<project-root>/logs/` (gitignored).

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
| worldview-updater | `.claude/agents/worldview-updater.md` | Post-review: apply approved diffs to world-view/*.md with changelog entry |
| psychology-updater | `.claude/agents/psychology-updater.md` | Post-review: apply scoped updates to pages/psychology.md |
| json-updater | `.claude/agents/json-updater.md` | Post-review / nightly: apply updates to JSON data stores |

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
