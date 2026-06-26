# Rune MVP Manual Test Plan

Full manual test plan covering all implementation phases (0-12).

> Prereqs: `TELEGRAM_BOT_TOKEN` and `TELEGRAM_USER_ID` set in `.env`. Vault directory exists. Server running via `npm run dev`.

## Priority Levels

- 🔴 **Critical**: Blocks user progress, requires immediate attention
- 🟡 **High**: Degrades experience significantly, should be handled gracefully
- 🟢 **Low**: Non-blocking, can fail silently with logging

---

# Phases 0-1: Server + Telegram Bot

## 1. Server Startup

- [x] 🔴 `npm run dev` starts without errors, logs show HTTP + Telegram bot initialized
- [x] 🔴 `curl http://localhost:3847/health` returns `{"status":"ok","uptime":...,"activeSessions":0}`
- [x] 🟡 Server recovers gracefully if vault directory doesn't exist (clear error, not crash)
- [x] 🟢 Logs are structured JSON with component tags

## 2. Telegram Bot — Auth & Basics

- [x] 🔴 Send a message from your authorized Telegram account — bot responds
- [ ] 🔴 Send a message from a different Telegram account — bot ignores it (no response)
- [x] 🔴 `/start` — bot replies with command help listing all available commands
- [x] 🟡 Bot shows typing indicator while processing

## 3. Multi-Turn Conversation

- [x] 🔴 Send a plain text message — bot creates a session and responds via Claude
- [x] 🔴 Send a follow-up message — bot remembers context from the first message (same session)
- [x] 🟡 Send a very long message (~4000+ chars) — bot responds without truncation issues
- [x] 🟡 Bot response that exceeds 4096 chars is split into multiple Telegram messages
- [x] 🟢 `/status` — shows `Active sessions: 1` after a conversation

## 4. /fresh — Session Logging

- [x] 🔴 Start a conversation, then send `/fresh` — bot summarizes the conversation
- [x] 🔴 Summary is appended to today's journal file (`journals/YYYY_MM_DD.md`)
- [x] 🔴 Session is reset — next message starts a new conversation
- [ ] 🟡 Git commit is created with message "TG conversation logged"
- [x] 🟡 `/fresh` with no active session — bot replies "No active conversation to summarize."
- [x] 🟢 Summary follows the format: `Topic: ... Prompt: ... Discussion: ... Conclusion: ...`

## 5. /journal — Quick Entries

- [x] 🔴 `/journal bought groceries` — bot replies "Logged to journal."
- [x] 🔴 Entry appears in today's journal as `HH:MM - [tg] bought groceries`
- [ ] 🟡 Git commit is created with message "TG journal entry"
- [x] 🟡 Multiple entries in a row append correctly (no missing newlines)

## 6. /ask — One-Shot Queries

- [ ] 🔴 `/ask what are my current priorities?` — bot returns a vault-aware answer
- [ ] 🟡 Response references actual vault content (not generic)
- [ ] 🟡 No session is created (does not appear in `/status` count)

## 7. Session Capture (HTTP endpoint)

- [ ] 🔴 Start a conversation, then `curl -X POST http://localhost:3847/capture-sessions` — sessions are summarized and logged to journal
- [ ] 🟡 Sessions are cleared after capture
- [ ] 🟡 Git commit with message "TG sessions captured (nightly)"
- [ ] 🟢 When `RUNE_HTTP_SECRET` is set, unauthenticated POST returns 401

## 8. Error Recovery

- [ ] 🔴 Kill and restart the server — sessions are restored from disk
- [ ] 🟡 Claude CLI timeout — bot sends error message, doesn't hang
- [ ] 🟡 Corrupt `tg-sessions.json` — server starts fresh instead of crashing
- [ ] 🟢 Git push fails — server logs error but continues operating

---

# Phases 2-3: Knowledge Base

## 9. KB Structure Setup

- [x] 🔴 After first ingestion, `knowledge/` directory exists with `schema.md`, `index.md`, `log.md`
- [x] 🔴 Directory tree created: `raw/{articles,conversations,notes}`, `wiki/{entities,concepts,topics,comparisons}`

## 10. Source Ingestion

- [ ] 🔴 Place a markdown file in the vault (e.g., `Readwise/test-article.md`)
- [ ] 🔴 `/ingest Readwise/test-article.md` — bot processes the source
- [ ] 🔴 Source is copied to `knowledge/raw/articles/test-article.md`
- [ ] 🔴 Wiki pages created/updated in `knowledge/wiki/`
- [ ] 🔴 `knowledge/index.md` updated with new entries
- [ ] 🟡 `knowledge/log.md` has an INGEST entry with timestamp
- [ ] 🟡 `/ingest Readwise/test-article.md -- focus on the main argument` — guidance reflected in wiki output
- [ ] 🟡 `/ingest nonexistent.md` — bot replies with "not found" error
- [ ] 🟢 Re-ingesting the same source updates rather than duplicates

## 11. Ingestion Queue

- [ ] 🟡 `/ingest` with no args and empty queue — bot says "Ingestion queue is empty"
- [ ] 🟢 Queue processing works when multiple sources are queued

## 12. KB Querying

- [ ] 🔴 `/kb what do I know about [topic from ingested article]?` — returns synthesized answer
- [ ] 🔴 Answer includes `[[wikilink]]` citations to wiki pages
- [ ] 🟡 `/kb query [topic]` — same behavior as bare `/kb [topic]`
- [ ] 🟡 `/kb stats` — shows page counts (entities, concepts, topics, comparisons, total)
- [ ] 🟡 `/kb recent` — shows recent log entries
- [ ] 🟡 `/kb` with no args — shows usage help

## 13. KB Linting

- [ ] 🔴 `/lint` — bot runs wiki health check and returns a report
- [ ] 🟡 Report identifies real issues (orphan pages, dead links, missing cross-refs)
- [ ] 🟡 `knowledge/log.md` has a LINT entry after running

---

# Phase 4: Morning Prep + Scheduler

## 14. Scheduler Infrastructure

- [ ] 🔴 Server logs show cron jobs registered at startup
- [ ] 🔴 Cron jobs use `America/Chicago` timezone
- [ ] 🟡 Server shutdown cleanly stops all cron jobs (no orphaned timers)

## 15. Morning Prep Job

- [ ] 🔴 Trigger morning prep manually (HTTP endpoint or command) — `## Morning Prep` section written to today's journal
- [ ] 🔴 Section includes yesterday's #priorities, today's workout, study assignments, writing topic
- [ ] 🔴 Git commit created after writing
- [ ] 🔴 Telegram notification: "Your journal is ready"
- [ ] 🟡 Missing data degrades gracefully per source (placeholder text, not failure)
- [ ] 🟡 Running twice on the same day is idempotent (skips if `## Morning Prep` already present)
- [ ] 🟢 `getYesterdayFilename()` and `getDayOfWeek()` return correct values in Chicago timezone

## 16. Review Nudge Stubs

- [ ] 🟢 Nudge module loads without errors (stubs for Phase 7)

---

# Phase 5: Review Commands

## 17. Review State Machine

- [ ] 🔴 Starting a review creates a ReviewSession with correct initial phase (`prep`)
- [ ] 🔴 Phase transitions: prep → interview → outline → approval → writeup → done
- [ ] 🔴 During active review, all non-command messages route to the review conversation
- [ ] 🟡 Starting a new review cancels any in-progress review for that chat
- [ ] 🟡 Review session persists to disk (survives restart)

## 18. /daily

- [ ] 🔴 `/daily` — reads today's journal, identifies tags, proposes JSON updates
- [ ] 🔴 User approval triggers json-updater agent, tags marked as processed
- [ ] 🟡 `/daily 2026-04-06` — processes a specific date's journal

## 19. /weekly

- [ ] 🔴 `/weekly` — prep agents (journal-scanner + system-scanner) run in parallel
- [ ] 🔴 Interview phase starts with prep context injected via `--append-system-prompt`
- [ ] 🔴 Claude presents an outline — user can approve or request edits
- [ ] 🔴 On approval, review-writer agent writes review to journal
- [ ] 🟡 Post-interview agents run (project-updater, json-updater, psychology-updater)
- [ ] 🟡 `/weekly 2026-03-30` — uses a specific week's date range

## 20. /monthly, /quarterly, /yearly

- [ ] 🔴 `/monthly` — same interview flow as /weekly with monthly date range
- [ ] 🔴 `/quarterly` — prep scans 3 months, interview covers patterns + strategic decisions
- [ ] 🔴 `/yearly` — prep scans 12 months, interview uses 7 Questions framework
- [ ] 🟡 Each variant uses the correct date range and agent parameters
- [ ] 🟢 `/start` help text updated with all review commands

---

# Phase 6: Additional Vault Commands

## 21. One-Shot Commands

- [ ] 🔴 `/priorities` — extracts #priorities from yesterday's journal
- [ ] 🔴 `/workout` — shows today's prescription from `health/plan.md`
- [ ] 🔴 `/study` — shows current progress, this week's assignments, overdue items
- [ ] 🟡 `/family` — 14-day journal scan focused on configured family-name mentions and balance
- [ ] 🟡 `/career` — shows active applications with staleness flags

## 22. Session-Based Commands

- [ ] 🔴 `/think [topic]` — starts a thinking partner session using think skill
- [ ] 🔴 `/health` — starts a health coaching session using health skill
- [ ] 🔴 `/blog [topic]` — starts interview-based blog writing session
- [ ] 🟡 Session commands route follow-up messages to the skill session (not default handler)

## 23. Library Search Commands

- [ ] 🟡 `/lenny [topic]` — searches Lenny's Podcast transcripts, synthesizes with quotes
- [ ] 🟡 `/pg [topic]` — searches Paul Graham essays, synthesizes with quotes

## 24. Command Routing Update

- [ ] 🟡 All new commands appear in `/start` help text
- [ ] 🟢 All new commands wired into `text.ts` routing

---

# Phase 7: Scheduled Automation + Nightly

## 25. Nightly Processing

- [ ] 🔴 Trigger nightly manually — runs full pipeline: TG capture → KB queue → /daily tag processing → git
- [ ] 🔴 Active Telegram sessions are summarized and logged to journal
- [ ] 🔴 Ingestion queue is processed (all queued sources ingested)
- [ ] 🟡 Sunday nightly includes a weekly wiki lint
- [ ] 🟡 Git commit at end with descriptive message

## 26. Review Nudges

- [ ] 🟡 Friday 3:00pm CT — weekly review nudge sent via Telegram with week stats
- [ ] 🟡 Last day of month 3:00pm CT — monthly review reminder
- [ ] 🟡 End of quarter/year — quarterly/yearly review reminders with correct cadence logic
- [ ] 🟢 Nudges are skipped if a review was already completed this period

## 27. File Watcher (Readwise)

- [ ] 🟡 New file in `Readwise/Articles/` — Telegram notification sent
- [ ] 🟡 File automatically added to ingestion queue
- [ ] 🟢 Watcher handles rapid successive file additions without duplicates

---

# Phase 8: Content Triage + Photos

## 28. URL Handling

- [ ] 🔴 Send a URL via Telegram — bot detects it and spawns content-triager agent
- [ ] 🔴 Triage result routes correctly: update playbook, save to Readwise, or skip
- [ ] 🟡 Bot confirms the triage action taken
- [ ] 🟢 Malformed URLs handled gracefully

## 29. Photo Handling

- [ ] 🔴 Send a photo via Telegram — bot downloads and spawns photo-classifier agent
- [ ] 🔴 Classification routes correctly (book, receipt, whiteboard, etc.)
- [ ] 🟡 Bot confirms what was classified and where it was routed
- [ ] 🟢 Large photos download without timeout

---

# Phase 9: Whoop Integration

## 30. OAuth & Setup

- [ ] 🔴 Whoop OAuth2 flow completes and tokens are stored in macOS Keychain
- [ ] 🔴 Token refresh works when access token expires
- [ ] 🟡 Missing or invalid tokens produce a clear error (not crash)

## 31. Sleep/Recovery Sync (8am daily)

- [ ] 🔴 Sleep, recovery, HRV written to `health/whoop/YYYY-MM-DD.json`
- [ ] 🟡 Data file format is consistent and parseable
- [ ] 🟢 Sync skips gracefully if Whoop API is down

## 32. Activity/Strain Sync (nightly)

- [ ] 🔴 Strain, workouts, steps merged into same day's JSON file
- [ ] 🟡 `health/whoop/trends.md` updated with 7-day and 30-day averages
- [ ] 🟢 Partial data (e.g., no workout today) doesn't break the sync

---

# Phase 10: Conversation-to-KB Pipeline

## 33. KB-Worthy Classification

- [ ] 🔴 `/fresh` on a conversation with KB-worthy insights — summary queued for ingestion
- [ ] 🔴 Queued summary appears in `knowledge/raw/conversations/` after nightly processing
- [ ] 🟡 Non-KB-worthy conversations (e.g., "what's the weather") are not queued
- [ ] 🟢 End-to-end: conversation → /fresh → raw/ → nightly ingest → wiki pages updated

---

# Phase 11: CLI Interface

## 34. Local CLI

- [ ] 🔴 `npm run cli -- query "what is X"` — returns KB answer
- [ ] 🔴 `npm run cli -- ingest path/to/file.md` — ingests source
- [ ] 🟡 `npm run cli -- lint` — runs wiki lint
- [ ] 🟡 `npm run cli -- status` — shows server status
- [ ] 🟡 `npm run cli -- search "term"` — searches vault
- [ ] 🟢 CLI exits with appropriate exit codes (0 success, 1 error)

---

# Phase 12: Mac Mini Deployment

## 35. System Setup

- [ ] 🔴 iCloud sync active, vault accessible at expected path
- [ ] 🔴 Node 22+, Claude Code CLI, and Tailscale installed
- [ ] 🟡 SSH access works via Tailscale IP

## 36. launchd Service

- [ ] 🔴 Single plist with `KeepAlive` + `RunAtLoad` — server starts on boot
- [ ] 🔴 Kill server process — launchd restarts it automatically within seconds
- [ ] 🔴 After restart, sessions are restored and cron jobs re-registered
- [ ] 🟡 Environment file (`~/.pkms-env`) is loaded correctly
- [ ] 🟡 Logs route to expected location

## 37. Parallel Run Validation

- [ ] 🔴 Run Mac Mini and dev machine simultaneously — no conflicts (polling bot on only one)
- [ ] 🟢 DigitalOcean droplet killed, Resend canceled, old scripts archived

---

# Cross-Cutting Concerns

## 38. Git Operations

- [ ] 🟡 Git conflicts — server checks status before commit, skips and TG-notifies on conflict
- [ ] 🟡 Git push failure — logged but doesn't block other operations
- [ ] 🟢 Commit messages are descriptive and consistent

## 39. Performance

- [ ] 🟡 TG text response time < 30s
- [ ] 🟡 KB query response time < 60s
- [ ] 🟡 KB ingestion < 2 minutes per source
- [ ] 🟢 Morning prep completes by 5:45am CT (15 min budget)

## 40. Resilience

- [ ] 🔴 Concurrent messages don't corrupt sessions (session lock serialization)
- [ ] 🟡 iCloud sync delay doesn't cause write conflicts (local-first)
- [ ] 🟢 Claude CLI crash mid-operation — partial state cleaned up
