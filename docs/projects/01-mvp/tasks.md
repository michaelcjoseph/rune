# Jarvis MVP — Tasks

In progress. See [spec.md](spec.md) for details.

## Phase 0: Project Scaffold

- [x] Initialize TypeScript project (package.json, tsconfig.json, tsx runner)
- [x] Create typed config module from env vars (config.ts)
- [x] Create utility modules (time.ts, logger.ts)
- [x] Create .env.example, .gitignore, CLAUDE.md

## Phase 1: Core Server + Telegram Bot

- [x] HTTP server with /health and /capture-sessions endpoints
- [x] Telegram bot init with polling and message dispatch
- [x] Text handler with command routing
- [x] /fresh command — summarize session, log to journal, reset, git commit
- [x] /journal command — append timestamped entry to today's journal
- [x] /ask command — one-shot vault query via CLI
- [x] /status command — uptime and session count
- [x] Claude Code CLI spawning with per-session request queue
- [x] Session map with JSON persistence and crash recovery
- [x] Journal file creation and append with Chicago timezone
- [x] Git commit/push helpers
- [x] Telegram message chunking and typing indicators

## Phase 2: Knowledge Base Foundation

- [x] wiki-compiler agent definition
- [x] kb-query agent definition
- [x] KB engine orchestration layer (ingest, query, lint dispatch)
- [x] Ingestion pipeline — copy to raw/, spawn wiki-compiler agent
- [x] Query pipeline — search context + spawn kb-query agent
- [x] ripgrep-based full-text search across vault + wiki
- [x] Ingestion queue with JSON file persistence
- [x] KB schema definition (page templates, conventions, index/log format)
- [x] Vault file operations module (read, write, list, exists)

## Phase 3: KB Telegram Integration

- [x] /kb command — query, stats, recent subcommands
- [x] /ingest command — single source or process queue
- [x] /lint command with wiki-linter agent
- [x] wiki-linter agent definition
- [x] Updated /start help text with all commands

## Phase 4: Morning Prep + Scheduler Foundation

- [x] Extend `src/utils/time.ts` — add `getYesterdayFilename()` and `getDayOfWeek()`
- [x] Extend `src/vault/journal.ts` — add `writeMorningPrep(sections)` with idempotent `## Morning Prep` marker check
- [x] Extend `src/vault/journal.ts` — add `parseTag(content, tag)` to extract lines after `#tag` markers
- [x] Extend `src/ai/claude.ts` — add optional `timeoutMs` parameter to `execClaude`
- [x] Create `src/jobs/scheduler.ts` — register cron jobs via node-cron with `America/Chicago` timezone, export `startScheduler(bot)` / `stopScheduler()`
- [x] Create `src/jobs/morning-prep.ts` — gather data from vault (yesterday's #priorities, health/plan.md workout, study/syllabus.md + progress.json, writing/topics.md)
- [x] Morning prep: Claude synthesis prompt — pass gathered data to `askClaudeOneShot()`, fallback to raw formatting on failure
- [x] Morning prep: write structured journal section, git commit, send TG notification
- [x] Create `src/jobs/nudges.ts` — stub for review reminders (Friday + end-of-month)
- [x] Wire `startScheduler(bot)` into `src/index.ts` startup, `stopScheduler()` into shutdown
- [x] Add manual trigger for testing (HTTP endpoint `/morning-prep` or `/prep` bot command)
- [x] Test end-to-end: verify journal file created with correct sections, TG notification received

## Phase 5: Review Commands via Telegram

### Foundation

- [x] Extend `src/ai/claude.ts` — add `askClaudeWithContext(message, sessionId, systemPrompt)` using `--append-system-prompt` flag (preserves CLAUDE.md auto-loading)
- [x] Create `src/reviews/session.ts` — ReviewSession type, in-memory Map + JSON persistence (same pattern as vault/sessions.ts)
- [x] Create `src/reviews/orchestrator.ts` — shared state machine: phase transitions, `handleMessage(session, text, bot)` dispatch

### /daily command

- [x] Create `src/reviews/daily.ts` — daily orchestrator: read journal → identify tags → propose JSON updates → wait for approval → spawn json-updater agent → mark as processed
- [x] Create `src/bot/commands/daily.ts` — /daily [date] command handler, date resolution (MM/DD, YYYY-MM-DD, default today)
- [x] Wire /daily into `text.ts` command routing

### /weekly command (template for interview reviews)

- [x] Create `src/reviews/weekly.ts` — weekly orchestrator:
  - Prep: spawn journal-scanner (Sat-Fri, all focus areas) + system-scanner (health, study, psychology) in parallel
  - Interview: create Claude session with SKILL.md instructions + prep context via `--append-system-prompt`
  - Outline: detect outline in Claude response, store, prompt for approval
  - Write-up: spawn review-writer agent with approved outline + conversation context
  - Post: spawn project-updater, json-updater, psychology-updater agents as needed
- [x] Create `src/bot/commands/weekly.ts` — /weekly [date] command handler
- [x] Modify `src/bot/handlers/text.ts` — check for active review session before default conversation routing; if active, route to `orchestrator.handleMessage()`

### Remaining reviews

- [x] Create `src/reviews/monthly.ts` — monthly orchestrator (30-day journal scan, all systems, theme-based interview)
- [x] Create `src/reviews/quarterly.ts` — quarterly orchestrator (3x monthly journal scans in parallel, pattern-focused interview)
- [x] Create `src/reviews/yearly.ts` — yearly orchestrator (4x quarterly scans, 7 Questions framework)
- [x] Create command handlers for /monthly, /quarterly, /yearly
- [x] Update `/start` help text with all review commands

## Phase 6: Scheduled Automation + Nightly

- [x] Create `src/jobs/nightly.ts` — orchestrate: TG session capture → KB queue processing → /daily tag processing → lint (Sunday) → git commit
- [x] Flesh out `src/jobs/nudges.ts` — Friday 3pm weekly review nudge with week stats
- [x] Nudges: end-of-month review reminders with cadence logic (monthly vs quarterly vs yearly based on month)
- [x] Readwise file watcher — FSWatch on Readwise/Articles/, TG notify + add to ingestion queue

## Phase 7: Content Triage + Photos

- [x] Design content-triager agent — classify incoming URLs/text (KB-worthy, journal entry, Readwise save, action item) and route accordingly
- [x] content-triager agent definition
- [x] photo-classifier agent definition
- [x] URL handler — detect URLs in messages, fetch content, spawn triage agent
- [x] Photo handler — download photo, spawn classifier, route based on type
- [x] Readwise API client — save articles programmatically
- [x] Wire URL and photo handlers into Telegram message dispatch

## Phase 8: Whoop Integration

- [x] Whoop API client — OAuth2 with token refresh
- [x] macOS Keychain helpers — store/retrieve Whoop tokens
- [x] Whoop types (sleep, recovery, strain, workout, body measurement)
- [x] Sleep sync job — pull sleep + recovery data at 8am
- [x] Write daily JSON file (health/whoop/YYYY-MM-DD.json)
- [x] Generate trends.md with 7-day and 30-day averages

## Phase 9: Conversation-to-KB Pipeline

- [ ] Enhance /fresh to classify conversation as KB-worthy or not
- [ ] Copy worthy conversation summaries to knowledge/raw/conversations/
- [ ] Add to ingestion queue for nightly processing
- [ ] Test end-to-end: conversation → /fresh → raw source → nightly ingest → wiki pages

## Phase 10: CLI Interface

- [ ] CLI entry point (cli/jarvis.ts)
- [ ] query command — query KB from terminal
- [ ] ingest command — trigger ingestion from terminal
- [ ] lint command — run wiki health check
- [ ] status command — show system state
- [ ] search command — search vault + wiki

## Phase 11: Additional Vault Commands

### One-shot commands (no state machine)

- [ ] `/priorities` — extract #priorities from yesterday's journal
- [ ] `/workout` — today's prescription from health/plan.md
- [ ] `/study` — current progress, this week's assignments, overdue items
- [ ] `/family` — 14-day journal scan for Sam/Jude mentions, flag imbalance
- [ ] `/career` — active applications with staleness flags

### Session-based commands (reuse review session infrastructure)

- [ ] `/think [topic]` — thinking partner mode with think skill as system prompt
- [ ] `/health` — health coaching session with health skill
- [ ] `/blog [topic]` — interview-based blog writing session

### Library search commands

- [ ] `/lenny [topic]` — search Lenny's Podcast transcripts, synthesize with quotes
- [ ] `/pg [topic]` — search Paul Graham essays, synthesize with quotes

### Wiring

- [ ] Wire all new commands into `text.ts` command routing
- [ ] Update `/start` help text with all commands

## Phase 12: Mac Mini Deployment

- [ ] Mac Mini initial setup (iCloud account, Homebrew, Node 22+, git, jq)
- [ ] Install Claude Code CLI and authenticate
- [ ] Install Tailscale for remote access
- [ ] System settings (prevent sleep, auto-restart after power failure, SSH, auto-login)
- [ ] Install Obsidian (for Readwise plugin sync)
- [ ] Create ~/logs/ directory
- [ ] Create environment file (~/.pkms-env)
- [ ] Create launchd plist (KeepAlive + RunAtLoad)
- [ ] Run Whoop OAuth flow on device
- [ ] Verify iCloud vault sync
- [ ] Parallel run validation
- [ ] Kill DigitalOcean droplet, cancel Resend, archive old scripts
