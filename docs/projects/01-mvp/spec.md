# Rune MVP Specification

## Overview

The Rune MVP is the first deployable version of the always-on second brain server. It combines the PKMS Agent Hub (Telegram bot, morning prep, health data, nightly processing) with Karpathy's LLM Knowledge Base pattern (raw sources compiled into a persistent, interlinked wiki) into a single TypeScript/Node.js server running on a Mac Mini.

### Core Value Proposition

A single always-available AI interface (Telegram) for your entire Obsidian vault — knowledge base, interview-based reviews, daily operations, morning prep, and automated workflows. Replaces the DigitalOcean droplet entirely.

### Goals

1. **Primary:** A working Telegram bot backed by Claude Code CLI that can chat, manage sessions, ingest sources into a knowledge base, and query across both the wiki and personal vault
2. **Secondary:** Full vault awareness — review commands (/daily, /weekly, /monthly, /quarterly, /yearly), tag processing, health coaching, and thinking tools work through Telegram, consolidating the vault's Claude Code skills into Rune
3. **Tertiary:** Automated daily workflows — morning journal prep, nightly processing, review nudges, Whoop health sync
4. **Quaternary:** Mac Mini deployment with launchd for always-on operation with crash recovery

### Non-Goals

- Apple Calendar integration
- Voice memo handling (using Whispr Flow on phone)
- Apple Shortcuts / Siri integration
- Investment portfolio auto-tracking
- Web UI or dashboard
- Vector database / embedding-based search (ripgrep + index.md is sufficient at this scale)
- Anthropic SDK / API key usage (all AI ops go through Claude Code CLI on Max subscription)

---

## User Journey

### Happy Path — Knowledge Ingestion

```
New article appears in Readwise
        ↓
File watcher detects it
        ↓
TG notification: "New article: [title]. Reply /ingest to process."
        ↓
User replies /ingest (with optional guidance)
        ↓
wiki-compiler agent processes source → wiki pages created/updated
        ↓
TG confirmation: "Ingested. Created 3 pages, updated 5."
```

### Happy Path — Knowledge Query

```
User sends /kb query "what do I know about onchain identity?"
        ↓
kb-query agent reads index.md → finds relevant pages → greps vault
        ↓
Synthesized answer with [[wikilink]] citations
```

### Happy Path — Daily Conversation

```
User sends message via Telegram
        ↓
Claude Code CLI responds with vault-aware context (multi-turn session)
        ↓
User sends /fresh
        ↓
Session summarized → logged to journal → git commit
        ↓
If conversation had KB-worthy insights → queued for ingestion
```

### Happy Path — Weekly Review via Telegram

```
User sends /weekly (or receives Friday nudge and sends /weekly)
        ↓
Rune: "Starting weekly review. Scanning journals..."
        ↓
Prep phase: journal-scanner + system-scanner agents run in parallel
        ↓
Interview phase: multi-turn conversation (Claude has prep context + skill instructions)
        ↓
Claude presents outline → user approves or edits
        ↓
Write-up: review-writer agent → appends to journal
        ↓
Post-interview: project-updater, json-updater, psychology-updater agents as needed
```

### Happy Path — Morning Journal Prep

```
5:30am CT — cron fires morning-prep job
        ↓
Gather: yesterday's #priorities, health/plan.md workout, study assignments, writing topic
        ↓
Claude synthesizes into morning section
        ↓
Write to journals/YYYY_MM_DD.md with structured header
        ↓
Git commit + Telegram notification: "Your journal is ready"
```

### Entry Points

- Telegram message (mobile, any time)
- Local CLI (at desk)
- Scheduled cron jobs (automated, no user action)

### Exit Points

- Telegram response delivered
- Journal entry written
- Wiki pages created/updated
- Health data synced to vault
- Git backup committed

---

## Requirements

### Telegram Bot

1. WHEN a text message is received from the authorized user THEN route to multi-turn conversation via Claude Code CLI
2. WHEN /fresh is sent THEN summarize session, log to journal, reset session, git commit
3. WHEN /journal <text> is sent THEN append timestamped entry to today's journal
4. WHEN /ask <question> is sent THEN answer with one-shot vault query (no session)
5. WHEN /status is sent THEN show uptime, active sessions, and last job run times
6. WHEN a URL is shared THEN analyze and triage: update playbook, save to Readwise, or skip
7. WHEN a photo is shared THEN classify (book, receipt, whiteboard, etc.) and route
8. WHEN a message is received from an unauthorized user THEN ignore silently

### Knowledge Base

9. WHEN /ingest <path> is sent THEN copy source to raw/, run wiki-compiler agent, update index + log
10. WHEN /ingest is sent with no args THEN process all sources in the ingestion queue
11. WHEN /kb query <question> is sent THEN search index + wiki + vault, synthesize answer with citations
12. WHEN /kb stats is sent THEN show page counts by category
13. WHEN /kb recent is sent THEN show last 10 log entries
14. WHEN /lint is sent THEN run wiki-linter agent, report findings

### Vault Awareness — Review Commands

15. WHEN /daily [date] is sent THEN read journal, identify tags, propose JSON updates, wait for approval, run json-updater agent, mark as processed
16. WHEN /weekly [date] is sent THEN run prep agents (journal-scanner + system-scanner), conduct interview, present outline, write review on approval, run post-interview agents (project-updater, json-updater, psychology-updater)
17. WHEN /monthly [month] is sent THEN same interview flow as /weekly with monthly date range and focus
18. WHEN /quarterly [quarter] is sent THEN prep scans 3 months of journals, interview covers patterns + strategic decisions
19. WHEN /yearly [year] is sent THEN prep scans 12 months, interview uses 7 Questions framework
20. WHEN a review session is active THEN all non-command messages route to the review conversation instead of default handler
21. WHEN a review session is in outline phase THEN user approval/edits trigger write-up agents

### Vault Awareness — Additional Commands

22. WHEN /priorities is sent THEN extract #priorities from yesterday's journal
23. WHEN /workout is sent THEN show today's prescription from health/plan.md
24. WHEN /study is sent THEN show current progress, this week's assignments, overdue items
25. WHEN /family is sent THEN run 14-day journal scan focused on configured family-name mentions and balance
26. WHEN /career is sent THEN show active applications with staleness flags
27. WHEN /think [topic] is sent THEN start a thinking partner session using think skill
28. WHEN /health is sent THEN start a health coaching session using health skill
29. WHEN /blog [topic] is sent THEN start interview-based blog writing session
30. WHEN /lenny [topic] is sent THEN search Lenny's Podcast transcripts, synthesize with quotes
31. WHEN /pg [topic] is sent THEN search Paul Graham essays, synthesize with quotes

### Morning Prep

32. WHEN 5:30am CT THEN write morning prep section to today's journal (priorities, workout, study, writing topic), git commit, TG notification
33. WHEN morning prep data is missing THEN degrade gracefully per source (placeholder text, not failure)
34. WHEN journal already has morning prep section THEN skip (idempotent)

### Knowledge Base — Automated

35. WHEN a new file appears in Readwise/Articles/ THEN send TG notification and add to ingestion queue
36. WHEN nightly processing runs THEN process all queued sources
37. WHEN a conversation is /fresh'd with KB-worthy insights THEN queue summary for ingestion
38. WHEN Sunday nightly runs THEN include a weekly wiki lint

### Scheduled Jobs

39. WHEN 11:30pm CT THEN run nightly: TG capture → KB queue → /daily tag processing → lint (Sun) → git
40. WHEN Friday 3:00pm CT THEN send weekly review nudge via TG with week stats
41. WHEN last day of month 3:00pm CT THEN send appropriate review reminder (monthly/quarterly/yearly)
42. WHEN 8:00am CT THEN sync Whoop sleep/recovery data to health/whoop/ (when Whoop integration is built)

### Health Integration

43. WHEN Whoop sleep sync runs THEN write sleep, recovery, HRV to health/whoop/YYYY-MM-DD.json
44. WHEN Whoop activity sync runs THEN merge strain, workouts, steps into same file
45. WHEN either sync runs THEN update health/whoop/trends.md with 7-day and 30-day averages

### Infrastructure

46. WHEN the server process crashes THEN launchd restarts it automatically
47. WHEN the server restarts THEN restore sessions from ~/logs/tg-sessions.json
48. WHEN a git commit trigger fires THEN add all changes, commit with descriptive message, push

---

## Technical Implementation

### AI Runtime

All AI operations spawn Claude Code CLI as a child process:

```typescript
// Conversational (multi-turn with session)
askClaude(message: string, sessionId: string): Promise<ClaudeResult>

// One-shot (no session persistence)
askClaudeOneShot(message: string): Promise<ClaudeResult>

// Agent-based (structured KB operations)
runAgent(agentName: string, prompt: string): Promise<ClaudeResult>
```

Per-session request queues prevent concurrent CLI writes. Timeout: 120s.

### Knowledge Base Structure (inside Obsidian vault)

```
knowledge/
├── schema.md           — Rules for KB operations (read by all agents)
├── index.md            — Content catalog: one line per page with summary
├── log.md              — Append-only operation log
├── raw/                — Immutable source material
│   ├── articles/       — Readwise articles, web clips
│   ├── conversations/  — Captured TG session summaries
│   └── notes/          — User-shared notes and ideas
└── wiki/               — LLM-compiled pages
    ├── entities/       — People, companies, projects
    ├── concepts/       — Ideas, frameworks, mental models
    ├── topics/         — Broad topic syntheses
    └── comparisons/    — X vs Y analyses
```

### Agents

**Rune agents** (in `rune/.claude/agents/`):

| Agent | Purpose |
|---|---|
| wiki-compiler | Ingest raw sources → wiki pages |
| kb-query | Search + synthesize answers (read-only) |
| wiki-linter | Health-check wiki |

**Vault agents** (in `VAULT_DIR/.claude/agents/`, already exist):

| Agent | Purpose |
|---|---|
| journal-scanner | Read journals for date range → structured observations by focus area |
| system-scanner | Load vault system state (health, study, career, investments, psychology, writing) |
| review-writer | Write review to journal from approved outline + conversation context |
| json-updater | Update JSON data stores (books, crm, places, workouts, progress, investments) |
| project-updater | Update project pages with weekly summaries, thesis changes, risks |
| psychology-updater | Update psychology profile with observed patterns |

**Future agents** (to be created):

| Agent | Purpose |
|---|---|
| content-triager | URL triage decision |
| photo-classifier | Photo classification |
| readwise-scanner | Article relevance scoring |

### Review Session Architecture

Review commands use a state machine per chatId:

```
ReviewSession { id, chatId, type, targetDate, phase, claudeSessionId, prepContext, outline }
```

Phases: `prep → interview → outline → approval → writeup → updates → done`

- **prep**: Rune spawns vault agents (journal-scanner, system-scanner) in parallel via `runAgent()`. Output stored as `prepContext`.
- **interview**: New Claude session created with `--append-system-prompt` containing the vault skill's interview instructions + prep context. Multi-turn conversation via Telegram.
- **outline → approval**: Claude presents outline per skill instructions. User approves or edits.
- **writeup**: Spawns review-writer + additional agents (json-updater, project-updater, etc.).

One review at a time per chatId. Starting a new review cancels any in-progress one. `--append-system-prompt` preserves CLAUDE.md auto-loading from cwd.

### Search Strategy

Two-layer, no vector DB:
1. **index.md** — LLM reads one-line-per-page catalog to find relevant pages semantically
2. **ripgrep** — fast full-text search across entire vault for additional matches

### External APIs

- **Telegram Bot API** — polling mode, no webhook
- **Whoop API** — OAuth2, macOS Keychain for token storage
- **Readwise API** — save articles programmatically

### Server

- Single Node.js process (TypeScript, tsx runner)
- HTTP on localhost:3847 (/health, /capture-sessions)
- node-cron for all scheduled jobs
- One launchd plist for Mac Mini deployment

---

## Implementation Phases

### Phase 0: Project Scaffold

- [x] TypeScript project setup (package.json, tsconfig.json, tsx)
- [x] Typed config from env vars
- [x] Utility modules (time, logger)
- [x] CLAUDE.md, .env.example, .gitignore

### Phase 1: Core Server + Telegram Bot

- [x] HTTP server with /health endpoint
- [x] Telegram bot with polling and message dispatch
- [x] Text handler with command routing
- [x] Commands: /fresh, /journal, /ask, /status, /start
- [x] Claude Code CLI spawning with session queue
- [x] Session persistence and crash recovery
- [x] Journal file operations
- [x] Git commit/push helpers
- [x] Telegram message chunking and typing indicators

### Phase 2: Knowledge Base Foundation

- [x] wiki-compiler and kb-query agent definitions
- [x] KB engine orchestration (ingest, query, lint)
- [x] Source ingestion pipeline (copy to raw/ → run agent)
- [x] Query pipeline (search + agent synthesis)
- [x] ripgrep-based vault search
- [x] Ingestion queue with JSON persistence
- [x] KB schema definition
- [x] Vault file operations module

### Phase 3: KB Telegram Integration

- [x] /kb command (query, stats, recent)
- [x] /ingest command (single source or queue)
- [x] /lint command with wiki-linter agent
- [x] Updated /start help text

### Phase 4: Morning Prep + Scheduler Foundation

- [ ] Extend `utils/time.ts` — `getYesterdayFilename()`, `getDayOfWeek()`
- [ ] Extend `vault/journal.ts` — `writeMorningPrep(sections)`, `parseTag(content, tag)`
- [ ] Extend `ai/claude.ts` — optional `timeoutMs` parameter on `execClaude`
- [ ] Create `jobs/scheduler.ts` — register cron jobs via node-cron with timezone
- [ ] Create `jobs/morning-prep.ts` — gather data (priorities, workout, study, writing), synthesize via Claude, write journal, git commit, TG notification
- [ ] Create `jobs/nudges.ts` — stub for review nudge messages
- [ ] Wire scheduler into `index.ts` startup/shutdown
- [ ] Manual trigger for testing (HTTP endpoint or command)

### Phase 5: Review Commands via Telegram

- [ ] Extend `ai/claude.ts` — `askClaudeWithContext(message, sessionId, systemPrompt)` using `--append-system-prompt`
- [ ] Create `reviews/session.ts` — ReviewSession interface, in-memory Map + JSON persistence
- [ ] Create `reviews/orchestrator.ts` — shared state machine (prep → interview → outline → approval → writeup → done)
- [ ] Create `reviews/daily.ts` — daily review orchestrator (no interview, tag-based)
- [ ] Create `reviews/weekly.ts` — weekly review orchestrator (template for all interview reviews)
- [ ] Create `reviews/monthly.ts`, `quarterly.ts`, `yearly.ts` — variants with different date ranges and agent params
- [ ] Create `bot/commands/daily.ts` — /daily command handler
- [ ] Create `bot/commands/weekly.ts` — /weekly command handler (+ monthly, quarterly, yearly)
- [ ] Modify `bot/handlers/text.ts` — review command routing + active review session dispatch
- [ ] Update `/start` help text with review commands

### Phase 6: Additional Vault Commands

- [ ] One-shot commands: `/priorities`, `/workout`, `/study`, `/family`, `/career`
- [ ] Session-based commands: `/think`, `/health`, `/blog`
- [ ] Library search commands: `/lenny`, `/pg`
- [ ] Wire all into text.ts command routing
- [ ] Update `/start` help text

### Phase 7: Scheduled Automation + Nightly

- [ ] Create `jobs/nightly.ts` — TG session capture → KB queue → /daily tag processing → lint (Sun) → git
- [ ] Flesh out `jobs/nudges.ts` — Friday weekly nudge, end-of-month review reminders with cadence logic
- [ ] Integrate /daily tag processing into nightly orchestrator
- [ ] Readwise file watcher — FSWatch on Articles/, TG notify + queue (if Readwise integration ready)

### Phase 8: Content Triage + Photos

- [ ] content-triager agent definition
- [ ] photo-classifier agent definition
- [ ] URL handler: detect URLs, fetch content, spawn triage agent
- [ ] Photo handler: download photo, spawn classifier agent, route result
- [ ] Readwise API client for saving articles

### Phase 9: Whoop Integration

- [ ] Whoop OAuth2 client with token refresh
- [ ] macOS Keychain helpers for token storage
- [ ] Sleep/recovery sync job (8am)
- [ ] Activity/strain sync (part of nightly)
- [ ] trends.md generation with 7-day and 30-day averages

### Phase 10: Conversation-to-KB Pipeline

- [ ] Enhance /fresh to classify KB-worthiness of conversations
- [ ] Auto-queue worthy conversation summaries for ingestion
- [ ] End-to-end: conversation → /fresh → raw/ → nightly ingest → wiki pages

### Phase 11: CLI Interface

- [ ] Local CLI entry point (cli/rune.ts)
- [ ] Commands: query, ingest, lint, status, search

### Phase 12: Mac Mini Deployment

- [ ] Mac Mini setup (iCloud, Homebrew, Node 22+, Claude Code, Tailscale)
- [ ] System settings (prevent sleep, auto-restart, SSH, auto-login)
- [ ] Single launchd plist (KeepAlive + RunAtLoad)
- [ ] Whoop OAuth flow on device
- [ ] Environment file (~/.pkms-env)
- [ ] Parallel run validation
- [ ] Kill DigitalOcean droplet, cancel Resend, archive old scripts

---

## Success Metrics

### Core KPIs

| Metric | Target | How Measured |
|---|---|---|
| TG response time | < 30s for text, < 60s for KB query | Timestamp diff in logs |
| Session recovery | 100% sessions survive restart | Kill/restart test |
| Morning prep | Appears in journal by 3:15am | Journal file check |
| Whoop sync | Data in vault by 8:15am / 11:45pm | File existence check |
| KB ingestion | Source → wiki pages in < 2 min | Log timestamps |
| Nightly completion | All sub-tasks finish by midnight | Log check |
| Uptime | > 99.5% monthly | launchd + /status |

---

## Edge Cases & Error Handling

### Ingestion

- Interrupted mid-way: transaction log pattern (INGEST-START/COMPLETE). Pages atomically overwritten. Re-run is idempotent.
- Source file missing: return error, don't create empty wiki pages
- Duplicate source: content hash check via .meta.json, skip if unchanged

### Wiki Scale

- Wiki grows past context window: index.md stays compact (1 line/page). Tiered retrieval (index → select pages → read → optional 2nd pass)
- Stale pages: lint flags pages >90 days without update

### External Services

- Whoop API down: log error, skip sync, retry at nightly
- Readwise plugin not syncing: nightly scan catches missed files
- Telegram API error: retry with exponential backoff (built into node-telegram-bot-api)

### Infrastructure

- iCloud sync delay: vault writes are local-first, sync is eventually consistent
- Git conflicts: check status before commit, skip and TG-notify on conflict
- Claude CLI timeout: 120s limit, return error to user

---

## Open Questions

- [ ] Should the CLI interface mirror all TG commands, or just KB operations?
- [ ] What is the right threshold for classifying a conversation as "KB-worthy" during /fresh?
- [ ] Should wiki pages have YAML frontmatter for Obsidian Dataview compatibility?
- [ ] When the wiki gets large, should we add qmd or sqlite-vss for search?
