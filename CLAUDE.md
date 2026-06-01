# Jarvis

Always-on personal second brain server. TypeScript/Node.js.

## Architecture

Single Node.js process handles everything:
- **Telegram bot** (polling mode) — chat, commands, content triage, photos
- **HTTP server** (localhost:3847) — health endpoint, session capture for nightly; webview UI (Phase B) serves a vanilla HTML/JS chat interface at `/` with cookie auth, REST endpoints (`GET /api/cockpit`, `POST /api/mutations`, `POST /api/mutations/:id/cancel`, `POST /api/ops/:id/cancel`), and a WebSocket for real-time messaging; the cockpit sidebar panel polls `GET /api/cockpit` and renders each product's projects with lifecycle status, run-status, and per-project action buttons (start / continue / enter-planning-mode)
- **In-flight op tracking** — every `execClaude()` spawn registers an `InFlightOp` (`src/transport/in-flight.ts`) and emits `BusOpEvent` frames (start/progress/end). TG shows a tracker message ("🤔 agent · 12s · /cancel") that edits every ~10s and deletes on end; webview shows a cancellable pill. `cancelOp(id)` SIGTERMs the child. `/cancel [opId-prefix]` kills the user's most recent op (or by id). Classifier ops are filtered from senders to avoid resolver spam.
- **Mutation pipeline** — `src/transport/mutations.ts` is the central registry for autonomous codebase operations (MutationDescriptor, applier registry, createMutation/cancelMutation). `workRunApplier` in `src/jobs/work-runner.ts` is the first applier: spawns Claude CLI with `spec.md + tasks.md + /work --auto` for a project slug. `genEvalLoopApplier` in `src/jobs/gen-eval-loop-runner.ts` is the second applier (`autoApprove: false`): validates the `'gen-eval-loop'` payload and drives `runGenEvalLoop()` — per-round body is live (createWorktree → /work --auto → /review → recordRound → evaluateLoop → destroyWorktree). Mutations are logged append-only to `logs/mutations.jsonl`; orphaned `running` entries are flipped to `failed` at startup via `reconcileOrphans()`. Every mutation state transition also drives `src/jobs/supervision-store.ts`: `createMutation` seeds a `SupervisedRun` (`'running'` for autoApprove, `'blocked-on-human'` for pending-approval); `startApply` flips to `'running'`; `output` events refresh `lastHeartbeatAt` and advance `lastOutputAt` (both throttled to once per 30s — `lastOutputAt` is the LLM-output signal the quiet-run nudge keys on, distinct from `lastChildAliveAt`); non-output writes (keep-alive, terminal) thread the current `lastOutputAt` through so it is never reset to undefined; `completed`/`failed` and applier-crash paths flip terminal status. All supervision writes are wrapped in a safe try/catch — a disk failure logs a warning but does not interrupt the mutation flow (the audit source-of-truth remains `mutations.jsonl`).
- **Scheduled jobs** (node-cron) — morning prep, Whoop sync, nightly processing, review nudges
- **Review system** — multi-phase session-based reviews (daily/weekly/monthly/quarterly/yearly) + health/blog sessions + Planner conversations (`/plan <product>`). Free-form Telegram messages route to planning when a planning session is active (`getActivePlanningSession` → `handlePlanningTurn`), otherwise default to a multi-turn Socratic chat (`handleConversation`) — `/fresh` or `/clear` closes either thread.
- **Knowledge base engine** — Karpathy-style LLM wiki (raw sources → compiled wiki pages)

All AI operations use Claude Code CLI (Max subscription, no API key needed). Custom agents in `.claude/agents/` handle structured KB operations (wiki-compiler, kb-query, wiki-linter).

The server reads/writes to an Obsidian vault synced via iCloud. The vault has four distinct LLM-mutable content layers (knowledge/, world-view/, pages/playbook.md, projects/) plus JSON data stores and `pages/psychology.md`, each with its own write semantics and updater agent. See the **Vault Content Model** section below.

## Project Structure

```
src/
├── index.ts                 # Entry point: boots HTTP server, Telegram bot, scheduler; startup sequence: reconcileOrphans() → recoverSupervisedRuns() (flips stale supervised-run 'running' → 'unknown', fail-safe) → restorePlanningSessions() (reload persisted planning sessions, fail-safe) → cleanupOrphanWorktrees() (fire-and-forget, best-effort) → runWorkRunGc() (fire-and-forget, best-effort — prunes logs/work-runs/ artifacts over retention caps); calls startStallCheck(bus) and startPlanningExpiry() after startScheduler(); stopStallCheck() and stopPlanningExpiry() in the shutdown sequence; persistPlanningSessions() called on clean shutdown and uncaughtException paths
├── config.ts                # Typed env vars and constants
├── ai/claude.ts             # All Claude CLI spawning: askClaude, runAgent, summarizeSession; exports setBus(bus) — called from index.ts so runAgent() can emit BusAgentEvent frames (type-only NotificationBus import avoids circular dep); runAgent() appends {agent, startedAt, durationMs, status} to logs/agent-runs.jsonl after each invocation; exports CLAUDE_BIN (resolved binary path), registerActiveProcess/unregisterActiveProcess (for external spawners like work-runner); runAgent() resolves each agent's model through the model selection policy (src/intent/model-policy.ts) — pin → role-default → global-fallback — rather than the old hardcoded def.model ?? config.AGENT_MODEL
├── ai/codex.ts              # Codex CLI spawn primitive for Layer 5 multi-model dispatch: resolveCodexPath(), getCodexBin() (lazy — Jarvis boots without Codex installed), isCodexAvailable() (non-throwing probe), isCodexLoggedIn() (spawns `codex login status`, 10s hard timeout, stderr ignored to avoid pipe-buffer deadlock, returns Promise<boolean>), probeCodexProvider() (combined binary + login probe, returns ProviderAvailability discriminated union), runCodex(prompt, opts); types RunCodexOpts + CodexResult + CodexSandboxMode + ProviderAvailability; RunCodexOpts.env is the sandbox seam — sandbox callers (A5.2 dispatchToExecutor) must pass buildSandboxEnv(), default process.env is only safe for non-sandboxed Jarvis-internal runs; registers each child via registerActiveProcess/unregisterActiveProcess from claude.ts for unified graceful shutdown
├── bot/
│   ├── telegram.ts          # Bot init: createBot() factory + wireHandlers(bot, sender) wires message + callback_query events after senders are ready; callback_query handler (Phase 6 C6.2) auth-gates by TELEGRAM_USER_ID, acks the query, then routes composite-id payloads through dispatchApprovalStatus (shared with the cockpit inbox) or falls back to dispatchText for conversational values (slash-prefixed values are rejected to prevent inline buttons from triggering destructive commands)
│   ├── handlers/text.ts     # Command routing + multi-turn conversation handler; handleTextMessage(sender, msg) — no direct bot dependency; exports dispatchText(sender, userId, text) shared with webview; active-planning-session check takes routing priority over the default conversation handler — free-form text routes through routeToPlanning → handlePlanningTurn when a planning session is active; routeToPlanning appends "— spec proposed · /approve to scaffold · /clear to abandon" footer when the planning handler returns spec-proposed status; /approve is wired in dispatchText but intentionally excluded from SLASH_COMMAND_METADATA (approval is an explicit gate, not resolver-inferred)
│   ├── handlers/url.ts      # URL detection, fetch, content-triager agent, routing
│   ├── handlers/photo.ts    # Photo download, photo-classifier agent, routing
│   ├── skill-registry.ts    # Resolver skill registry: SkillEntry, SLASH_COMMAND_METADATA, buildSkillRegistry, getSkillRegistry (cached), reloadSkillRegistry
│   ├── resolver.ts          # Classify free-form TG messages against skill registry via Haiku; returns ClassifyResult {skill, args, confidence, second_skill, second_confidence, ambiguous}
│   └── commands/
│       ├── fresh.ts         # /fresh — summarize active chat, append to journal, optionally enqueue KB-worthy summary, commit, reset session; also abandons any active planning session. Exports `closeConversation` helper reused by /journal.
│       ├── fresh-full.ts    # /fresh-full — verbatim conversation transcript logging (no summarization)
│       ├── clear.ts         # /clear — discard active session without journaling; also abandons any active planning session
│       ├── journal.ts       # /journal — append literal entry to today's journal; if a chat session is active, also calls closeConversation (mirrors /fresh)
│       ├── ask.ts           # /ask — one-shot freeform Claude question (legacy escape hatch; no longer a resolver route)
│       ├── kb.ts            # /kb — one-shot knowledge base query (legacy escape hatch; no longer a resolver route)
│       ├── ingest.ts        # /ingest — enqueue vault file for KB ingestion
│       ├── status.ts        # /status — system health overview
│       ├── prep.ts          # /prep — trigger morning prep
│       ├── priorities.ts    # /priorities — review/set daily priorities
│       ├── daily.ts         # /daily — daily review session
│       ├── weekly.ts        # /weekly — weekly review session
│       ├── monthly.ts       # /monthly — monthly review session
│       ├── quarterly.ts     # /quarterly — quarterly review session
│       ├── yearly.ts        # /yearly — yearly review session
│       ├── health.ts        # /health — health review session
│       ├── blog.ts          # /blog — blog post drafting session
│       ├── workout.ts       # /workout — invoke workout-generator agent with goals/equipment/exercises/Whoop recovery; persist logs/last-workout.json; chunk-send markdown to TG; pre-syncs Whoop via ensureWhoopSyncedForToday()
│       ├── done-workout.ts  # /done-workout — append most recent generated workout to today's journal
│       ├── syllabus.ts      # /syllabus — current study syllabus progress and assignments
│       ├── study.ts         # /study — spaced-repetition session: quiz over due wiki concepts
│       ├── family.ts        # /family — family planning/review
│       ├── career.ts        # /career — career reflection/planning
│       ├── learn.ts         # /learn — append a runtime learning; auto-prepended to future agents
│       ├── learn-list.ts    # /learn-list — echo the current prepended learnings
│       ├── cancel.ts        # /cancel [opId-prefix] — SIGTERM an in-flight Claude op (most recent for user, or by id prefix)
│       ├── plan.ts          # /plan [product] — start a Planner (Layer 1) conversation scoped to a product; with a known slug creates a planning session and replies with the kickoff prompt; without args or with unknown slug lists registered products
│       ├── approve.ts       # /approve — approve a spec-proposed planning session and scaffold docs/projects/<NN-slug>/{spec.md,tasks.md,test-plan.md} via project-setup-writer; handles retry path for sessions already in `approved` state from a prior agent failure; not in SLASH_COMMAND_METADATA
│       ├── library-sync.ts  # /library-sync — trigger on-demand Lenny posts/podcasts sync via lenny-sync agent
│       └── seed.ts          # /seed — bulk-seed KB from vault files via seedAndProcess()
├── transport/
│   ├── sender.ts            # MessageSender interface, SendOpts (approval?: {prompt, options[]}) type, createSenders(bot, bus) factory; subscribes tg/webview to bus 'message', 'agent-event', 'mutation-event', and 'op-event'; returns { tg, webview, destroy }
│   ├── notification-bus.ts  # NotificationBus: typed event bus with publish/on/off; BusEvent = BusMessageEvent | BusAgentEvent | BusMutationEvent | BusOpEvent; BusOpEvent has subKind 'start'|'progress'|'end' with opKind 'agent'|'chat'|'one-shot'|'classifier'; fault-isolates failing subscribers
│   ├── mutations.ts         # Mutation pipeline: MutationDescriptor/MutationKind/MutationStatus types, applier registry, createMutation(), cancelMutation(), activeRuns map, setMutationBus(); autoApprove appliers start immediately; hooks into supervision-store at every state transition (seed on create, flip on startApply/completed/failed/crash, throttled heartbeat on output events); `buildSupervisedRun` carries both `lastChildAliveAt` and `lastOutputAt` params — output events advance `lastOutputAt` (LLM-output signal for quiet-run nudge), keep-alive/terminal writes thread the current value through so it is never reset; MutationDescriptor carries optional `outcome?: WorkOutcome` + `workProduct?: WorkProductFacts` (project 11 Phase 2) — populated by `applyOutcomeToDescriptor` in startApply's terminal branch (gated on `kind === 'work-run'`) BEFORE appendMutationLine, so the work-run verdict reaches mutations.jsonl/cockpit/bus
│   ├── in-flight.ts         # In-flight Claude-op registry: registerOp/unregisterOp/cancelOp/cancelMostRecentForUser/listOps; 5s heartbeat ticker emits op-event:progress; setInFlightBus(bus) wires bus emission; cancelled flag overrides exit status to 'cancelled'
│   ├── telegram-sender.ts   # TelegramSender implements MessageSender; delegates to sendLongMessage; per-user typing timer map; onMutationEvent() sends one-line TG summary on completed/failed (Phase 6 C5 specializes gen-eval-loop terminal events into structured ✅ merged / ⏸ blocked / 💥 failed messages with rounds + cross-model verdict + short id, via formatGenEvalLoopTerminal; project 11 adds `formatWorkRunTerminal` for work-run terminals — outcome-aware: ✅ branch-complete / 📊 partial / ⚠️ no-op / ⚠️ dirty-uncommitted / ❌ failed, so a noop never renders as success); project 11 Phase 4: also forwards `work-run` `progress` events (the throttled commit-poll ping) as a lightweight Telegram message — throttle lives at the poll level so this never spams; send() with opts.approval renders an inline keyboard (Phase 6 C6.1) — one button per option, callback_data = option.value; onOpEvent() sends/edits/deletes "🤔 label · Xs · /cancel" tracker messages (10s edit throttle, skips classifier ops); shutdown() drains timers
│   ├── webview-sender.ts    # WebviewSender implements MessageSender; register(userId, ws), unregister(userId, ws), per-user WS fan-out; onAgentEvent(), onMutationEvent(), and onOpEvent() forward bus frames to connected WS clients
│   └── approval-actions.ts  # Phase 6 C6: transport-agnostic approval-actioning module shared between the HTTP cockpit (POST /api/approvals/:id/{approve,reject}) and the Telegram callback_query handler. parseApprovalId(id) splits a composite `<source>:<payload>` id; dispatchApprovalStatus(id, status) routes to per-source queue mutators (intent-proposal-queue, playbook-queue, ask-twice proposal-queue) and returns three-valued 'ok'|'not-found'|'error' (HTTP maps 'error' to 500 so disk-write failures don't masquerade as 404). All writes wrapped in safeWrite so a sync throw can't crash the Telegram EventEmitter listener.
├── reviews/
│   ├── session.ts           # ReviewSession type, persistence, lifecycle management
│   ├── orchestrator.ts      # Review flow orchestrator: start, route messages, handler registry
│   ├── interview.ts         # Interactive interview phase for review sessions; review prep surfaces pending playbook drafts, Ask-Twice proposals, and journal-to-intent proposals for approval
│   ├── worldview-drift.ts   # Detect world-view changelog entries affecting active projects
│   ├── kb-activity.ts       # Scan knowledge/log.md INGEST entries → structured digest for review prep
│   ├── daily.ts             # Daily review handler
│   ├── weekly.ts            # Weekly review handler
│   ├── monthly.ts           # Monthly review handler
│   ├── quarterly.ts         # Quarterly review handler
│   ├── yearly.ts            # Yearly review handler
│   ├── health.ts            # Health review handler
│   ├── blog.ts              # Blog drafting handler
│   ├── planning.ts          # Planning session store: createPlanningSession, getPlanningSession, getActivePlanningSession, updatePlanningSession, deletePlanningSession, abandonActivePlanningSession (called by /clear and /fresh), persistPlanningSessions, restorePlanningSessions; sessions keyed by chatId, persisted to logs/planning-sessions.json; exports approveActivePlanningSession(chatId) → ApproveResult discriminated union (ok/no-session/wrong-status) for the spec-proposed → approved lifecycle transition
│   └── planning-handler.ts  # Multi-turn Socratic planning handler: handlePlanningTurn (drives one scoping turn through the defaultScopingTurn LLM call), ScopingResult/ScopingTurn/PlanningHandlerDeps types; injected ScopingTurn seam enables test doubles
├── server/
│   ├── http.ts              # HTTP server: health, session capture, Whoop OAuth callback; mounts webview routes when WebviewDeps provided
│   ├── auth.ts              # verifyAuth(req), isAllowedHost(req), safeCompare(a, b) — cookie + host-guard auth helpers
│   ├── webview.ts           # mountWebviewRoutes(server, deps): GET /, GET /static/*, POST /api/auth-bootstrap, POST /api/chat, GET /api/state, GET /api/cockpit, POST /api/mutations, POST /api/mutations/:id/cancel, POST /api/ops/:id/cancel, WS /api/ws; handleApiCockpit reads run-status via readCockpitRunStatus(config.SUPERVISED_RUNS_FILE) — not from in-memory activeRuns
│   ├── webview-bootstrap.ts # handleWebviewMessage(sender, userId, text) — thin adapter over dispatchText for webview
│   ├── projects-snapshot.ts # getProjectSummaries(): reads docs/projects/index.md + tasks.md per project; returns ProjectSummary[] with slug, status, task progress (done/total/perPhase), specPath, lastModified
│   ├── state-snapshot.ts    # StateSnapshot type + getStateSnapshot(): reads logs/agent-runs.jsonl, scheduler-state.json, active session/review, ingestion queue, playbook/proposal/intent counts (pendingApprovals.intent), project summaries, active+recent mutations, in-flight Claude ops; used by GET /api/state
│   ├── cockpit-run-status.ts # mapVisibilityToRunStatus(visibility): pure projection from supervision VisibilitySurface → RunStatusByProject; readCockpitRunStatus(filePath, now?) wraps readAllRuns + getVisibility + mapper; blocked-on-human wins over running for the same project
│   └── static/              # Webview frontend: index.html, app.js, app.css (vanilla HTML/JS/CSS); includes cockpit sidebar panel that polls GET /api/cockpit and renders products/projects with lifecycle status, run-status, per-project action buttons, the in-flight gen-eval-loop progress block (Phase 6 C3), and a static task-progress bar (done/total) per project sourced from `getProjectSummaries()`; the cockpit filters out lifecycle-`done` projects per product (keeping every product header so the lineup stays visible — an empty post-filter product shows an "all done" placeholder). Plan button dispatches `/plan <product>` via the chat WebSocket (data-product attribute on action buttons); the Pending Approvals panel (Phase 6 C2) polls GET /api/approvals and renders one row per pending entry with Approve / Reject / Open buttons (delegated click handler POSTs to /api/approvals/:id/{approve,reject}, mirroring the cockpit cancel pattern). The standalone Projects sidebar panel that predated the cockpit was removed once the cockpit subsumed its per-project progress display. Recent-runs panel (project 11 Phase 2) is outcome-aware: `branch-complete` → green `.run-ok`, `failed` → red `.run-error`, `partial`/`noop`/`dirty-uncommitted` → amber `.run-warn` so a no-op never renders as success. `index.html` is cached at mount time in production; the dev-mode path (NODE_ENV !== 'production') re-reads on each `GET /` so static-markup edits show up on a plain browser refresh without restarting `npm run dev` (tsx watch only restarts on .ts changes, not on static assets).
├── kb/
│   ├── engine.ts            # Orchestrates ingest/query/lint, processes ingestion queue
│   ├── init.ts              # KB directory scaffolding and schema initialization
│   ├── ingest.ts            # Copy source to raw/ → spawn wiki-compiler agent → entity-link touched pages
│   ├── entity-extract.ts    # linkEntities(): build alias map from JSON stores + FAMILY_NAMES, wikilink bare mentions in reference sections, append to related: frontmatter
│   ├── query.ts             # Build context → spawn kb-query agent → synthesized answer
│   ├── lint.ts              # Spawn wiki-linter agent → health report
│   ├── search.ts            # ripgrep-based full-text search across vault + wiki
│   ├── queue.ts             # JSON-file ingestion queue (enqueue/dequeue/clear)
│   ├── schema.ts            # Default schema.md content for new knowledge bases
│   └── seed.ts              # seedAndProcess(): enumerate vault files → enqueue new/mutable sources → process queue
├── jobs/
│   ├── scheduler.ts         # Cron job registration: startScheduler(bot), stopScheduler()
│   ├── morning-prep.ts      # Gather vault data → synthesize morning prep → write to journal
│   ├── nightly.ts           # Nightly orchestrator: capture → daily tags → birthday alerts → playbook extract → journal ingest → meeting extract → KB queue → whoop → lint → mark processed → commit
│   ├── capture.ts           # Session capture logic (used by HTTP endpoint + nightly job)
│   ├── whoop-sync.ts        # Whoop sleep sync (8am) + activity sync (nightly) + trends; ensureWhoopSyncedForToday() best-effort pre-sync for user-triggered handlers
│   ├── playbook-extract.ts  # Scan today's journal for #playbook tags → draft entries into playbook-queue.json
│   ├── meeting-extract.ts   # Scan today's journal for #meeting blocks → structured Meeting[] via askClaudeOneShot
│   ├── book-summarizer.ts   # Generate 1-2 sentence book summary via askClaudeOneShot (returns null on UNKNOWN)
│   ├── intent-scan.ts       # Weekly Ask-Twice scan: reads intent-log.jsonl (last 30 days), groups via Haiku, dedupes against skill registry + pending queue, writes up to 3 proposals to proposal-queue.json
│   ├── proposal-queue.ts    # Proposal queue types + CRUD (logs/proposal-queue.json)
│   ├── mutations-log.ts     # Append-only JSONL log for mutations (logs/mutations.jsonl): appendMutationLine, readRecentMutations, reconcileOrphans (flips stale 'running' entries to 'failed' at startup)
│   ├── work-runner.ts       # workRunApplier: MutationApplier for 'work-run' kind; spawns Claude CLI with `--output-format stream-json --verbose`; converts each stdout envelope into human-readable `output` MutationEvents via the stream-json→display adapter (malformed/non-envelope lines route to the log/stderr-tail path; blank lines skipped); enforces per-project and global concurrency caps; Phase 2 complete: tees raw envelopes to a per-run durable transcript sink, classifies on work product via `computeWorkProduct` + `finalizeWorkRun`, flushes transcript (awaits finish), writes `summary.json` atomically, appends a `WorkRunIndexRow` to `logs/work-runs/index.jsonl` (best-effort), augments the terminal event with `projectSlug`+`product` so TelegramSender's `formatWorkRunTerminal` and the cockpit can name the run — all BEFORE yielding the single terminal event; Phase 4: `streamProcess` runs a parent-side commit-poll ticker (10s, unref'd, re-entrancy-guarded) — each tick calls `git log baseSha..branch`, reads `tasks.md` tally via `parseTasks`, passes both to `planCommitProgress`, and enqueues a scrubbed throttled `progress` MutationEvent when a new commit lands; ticker cleared on close/error/finally alongside the keep-alive ticker; enabled only when `sandbox.baseSha` is present (null `CommitPollConfig` disables); `WorkRunRuntimeDeps` injection seam (`runGit`/`workRunsDir`/`workRunsIndexFile`/`createSink`/`writeSummary`/`appendIndexRow`/`runForensics`) with `__setWorkRunRuntimeForTest`/`__resetWorkRunRuntimeForTest`
│   ├── work-run-transcript.ts # Stream-json→display adapter + durable sink (Phase 1): `parseStreamJsonLine` (tolerant parse) + `streamJsonToDisplay` (converts envelopes to display text, reuses `formatToolUse`/`scrubPathsInText` from `src/ai/tool-labels.ts`); `redactSecrets` (best-effort redaction of credential URLs, Bearer/sk- tokens, Telegram bot tokens, GitHub PATs, AWS keys, JWTs); `createRingBuffer` (bounded last-N line store); `createTranscriptSink` (per-run WriteStream to `<baseDir>/<runId>/transcript.jsonl`, slug-validated runId, persistent error listener, backpressure-aware append, awaited finish, idempotent destroy) — wired into work-runner as of Phase 2
│   ├── work-run-classify.ts  # terminal-classification — `classifyOutcome(facts)` (rules 3-7 → branch-complete/partial/noop/dirty-uncommitted/failed), `parseTasks`/`computeTaskTransitions` (tasks.md delta), `computeWorkProduct` via injected GitRunner (commits/diffstat/status over baseSha..branch; scrubs host-absolute paths from diffstat/filesChanged before they reach mutations.jsonl/bus), `finalizeWorkRun` (crash-safe single terminal event emitter, scrubs host paths from classification-error reasons), `applyOutcomeToDescriptor` (stamps outcome+workProduct onto descriptor before persist); fully wired as of Phase 2; Phase 3 (forensics + GC) complete; Phase 4 (alerts) in progress — tests-first done, impl pending; Phases 5-6 (cockpit UX, validation) remain
│   ├── work-run-store.ts     # run-store — `writeSummary` (atomic temp-then-rename of per-run summary.json; mkdirs the run dir; best-effort, throws on disk failure so caller can degrade gracefully), `appendIndexRow` (one JSON row per line; mkdirs the containing dir on first run), `readRecentIndex` (torn-line-tolerant, missing file → []); both `writeSummary` and `appendIndexRow` wired into work-runner as of Phase 2
│   ├── work-run-forensics.ts # Phase 3 implemented + wired: `exportForensics(opts)` writes a reconstructable evidence bundle (diffstat.txt / status.txt / diff.patch / diff-staged.patch — git stdout redacted via `redactSecrets`; bundle.git via `git bundle create`; untracked.tar for non-clean runs — empty tar via fs when zero untracked files, real `tar` with `--` option-terminator + NUL-split `-z` hardening otherwise) to `logs/work-runs/<id>/` via injected GitRunner BEFORE the worktree is destroyed; best-effort by contract (each artifact captured independently, `finalizeWorkRun` wraps the call so a forensics failure never denies the terminal event); wired into work-runner via the `runForensics` seam in `WorkRunRuntimeDeps`
│   ├── work-run-gc.ts        # Phase 3 implemented: retention GC — `planGc` (pure: selects terminal, unprotected runs to delete oldest-first to satisfy count+bytes caps; protected set = activeRuns + non-terminal run-store + worktree-checked-out branches) + `gcWorkRuns` (effectful: Phase A gathers async inputs — discovers run dirs via readdirSync, sizes each with a flat dirBytes walk, reads summary.json per dir, runs `git worktree list --porcelain` parse for checked-out branch protection; Phase B builds protected set + planGc + rmSync deletes in a single synchronous run — same-tick discipline, no await between protected-set snapshot and last rmSync; Phase C prunes deleted runs' `jarvis-work/` branch refs via `git branch -D`, best-effort with per-branch warn; `isContainedIn` path-containment guard + branch-prefix guard before every destructive op)
│   ├── work-run-gc-runner.ts # Phase 3 runtime glue: `runWorkRunGc(product?)` gathers the live protected-set inputs (activeRuns from mutations.ts + non-terminal supervised runs from supervision-store) and calls gcWorkRuns with config.WORK_RUN_RETENTION_MAX_RUNS / WORK_RUN_RETENTION_MAX_BYTES; tolerates a missing/unregistered product (GC proceeds product-agnostically); swallows all errors — callers (index.ts startup + work-runner apply() completion finally) use fire-and-forget
│   ├── work-run-commit-poll.ts # Phase 4 implemented + wired into work-runner's streamProcess: `planCommitProgress(opts)` — parent-side throttle decision for the per-run commit-progress ping; exports `COMMIT_POLL_INTERVAL_MS` (10s) + `COMMIT_PING_THROTTLE_MS` (10s); state carries `{lastSeenSha, lastPingAt}` (new sha seen + throttle gap → `{ping:true, message, nextState}`; no new sha or within throttle window → `{ping:false, nextState}`); `SUBJECT_MAX_CHARS` (200) caps the rendered commit subject; message format: `📊 <subject> · X/Y tasks`
│   ├── gen-eval-loop-runner.ts # genEvalLoopApplier: MutationApplier for 'gen-eval-loop' kind; validates payload (VALID_SLUG product/project, product in products.json, optional positive-integer maxEvaluatorRounds); per-product concurrency cap of 1; autoApprove:false; also exports runGenEvalLoop(opts): orchestration core — emits a 'resolution' progress event at start (A7.1 — generator claude/sonnet, evaluator resolved via resolveModel(distinctFromProvider='anthropic')) → createWorktree on a deterministic `jarvis-gen-eval/<short-mut-id>` feature branch (A7.3) → loop rounds (injectable runWorkAuto → if tests pass: runReview → recordRound → evaluateLoop) → on 'on-branch' builds an Adjudication and runs evaluateMergeContract (A7.2); merge:true emits 'merge-ready' progress then calls mergeBranch (A7.3: `git merge --no-ff <branch>` + push in product repo, deletes branch after, redacts credential URLs from stderr) → completed; merge:false or merge-step failure → failed with the contract/git reason; escalated:failed / in-progress:continue → destroyWorktree in finally; LoopSpawners interface allows test injection (createWorktree/destroyWorktree/runWorkAuto/runReview/mergeBranch); defaults wire real Claude CLI spawns with buildSandboxEnv + getProjectMcpArgs() and real git spawns via runGitCmd; realRunReview parses VERDICT: PASS marker (absence = fail); cap defaults to 3
│   ├── sandbox-runtime.ts   # Runtime complement to src/intent/sandbox.ts: git worktree lifecycle (createWorktree/destroyWorktree/cleanupOrphanWorktrees); reads policies/products.json via readProductsConfig/getProductConfig; all git calls go through injectable GitRunner seam (`defaultRunGit` exported so runtime callers like work-runner reuse the single execFile wrapper); types ProductConfig and GitRunner
│   ├── credential-injector.ts # Spawn-time env map builder for sandboxed Regime B runs: readCredentials(path) (dotenv-style parser, missing file → {}), getBaseEnv(allowlist) (process.env filter), buildSandboxEnv(sandbox, opts) (merges base env + product credentials, asserts VALID_SLUG at boundary); DEFAULT_BASE_ENV_KEYS constant; enforces two invariants: only the run's own product credentials reach the child, and Jarvis's own secrets (TELEGRAM_BOT_TOKEN, etc.) never reach the child
│   ├── egress-policy.ts     # Runtime egress enforcement wrapper for sandboxed Regime B runs: checkEgress(sandbox, host, opts) delegates to isEgressAllowed and writes denied attempts via appendEgressDenialLog to logs/egress-denials.jsonl (config.EGRESS_DENIAL_LOG); exports EGRESS_ENFORCEMENT_MODE constant ('documented-gap' advisory today; flips to 'proxy-enforced' when the per-run proxy ships) and EgressEnforcementMode type
│   ├── sandbox-fs.ts        # In-process fs-write wrappers that enforce sandbox write boundaries: assertWritable(sandbox, targetPath) two-stage guard (lexical containment via isWriteAllowed, then symlink resolution via realpathSync on closest existing ancestor for macOS /var/folders→/private/var/folders parity); writeFileInSandbox, appendFileInSandbox, mkdirInSandbox, rmInSandbox delegate to matching fs.*Sync after the guard; child-process writes are A3's contract — this module only covers Jarvis's own writes on behalf of a sandboxed run
│   ├── lenny-sync.ts        # Exports runLibrarySync() + LibrarySyncResult; pulls new Lenny posts/podcasts via lenny-sync agent, updates logs/lenny-sync-state.json
│   ├── supervision-store.ts # Persistent JSON store for SupervisedRun[] state (from src/intent/supervision.ts): readAllRuns, writeAllRuns, upsertRun, removeRun; atomic temp-then-rename writes; corrupt/invalid entries dropped at read time with warn log; backed by logs/supervised-runs.json (config.SUPERVISED_RUNS_FILE)
│   ├── supervision-recovery.ts # Startup recovery for supervised runs: recoverSupervisedRuns(filePath) reads all SupervisedRuns, applies recoverRun (flips stale 'running' → 'unknown'), writes back only if anything changed; returns { transitioned, total }; called from index.ts after reconcileOrphans(), wrapped in try/catch so disk failures cannot crash boot
│   ├── stall-check.ts       # Pure stall-check core: checkStalledRuns(deps) returns newly-nudged-id set; formatStallNudge(run, now) builds the Telegram nudge string; exports TICK_INTERVAL_MS (30s), STALL_THRESHOLD_MS (5min), and QUIET_THRESHOLD_MS (5min, measured on lastOutputAt distinct from child liveness); formatQuietNudge(run, now) implemented (🔇 "Run quiet" wording distinguishes quiet-but-alive from child-dead stall); shared private ageMinLabel helper rounds age to minutes for both formatters
│   ├── dispatch-runtime.ts  # Orchestration adapter for Layer 5 multi-model dispatch: dispatchToExecutor(handoff, opts) branches by target (claude → runAgent, codex → probeCodexProvider() guard then compileToCodex + runCodex); probe failure short-circuits with a failed DispatchResult (failureReason: 'codex executor unavailable: <reason>') and still appends the log entry; maps result to DispatchResult, calls recordDispatch, appends to logs/dispatch-log.jsonl; VALID_SLUG-guards the agent name to prevent path traversal; enforces "text is null iff failed" invariant (Codex partial-stdout); truncates failureReason at 500 chars; logs trust-boundary warning for codex dispatches
│   ├── stall-check-runner.ts # setInterval glue: startStallCheck(bus) and stopStallCheck(); every 30s tick runs both checks on the same snapshot — checkStalledRuns (returns newly-nudged-id set) then planQuietNudges over the non-stalled remainder (distinct lastOutputAt/quietNudgedAt predicate); per-run: publishes formatQuietNudge to bus, persists quietNudgedAt via upsertRun (durable once-only survives restarts); per-run send and persist errors are individually caught so a failure on one run can't skip the rest; tick exceptions caught so a failure can't crash the server
│   ├── planning-expiry.ts   # Pure planning-session expiry core: findExpiredPlanningSessions(deps) returns chatIds whose lastActivity exceeds the TTL (status-agnostic, covers stranded approved sessions); exports PLANNING_EXPIRY_TTL_MS (7 days) and PLANNING_EXPIRY_TICK_INTERVAL_MS (1 hour); readSessions throwing returns [] rather than propagating; missing/unparseable lastActivity treated as expired (fail-toward-cleanup)
│   ├── planning-expiry-runner.ts # setInterval glue: startPlanningExpiry() and stopPlanningExpiry(); reads live in-memory state via getAllPlanningSessions, deletes via deletePlanningSession with per-item try/catch; timer is unref()'d so it doesn't keep the process alive; called from index.ts after startStallCheck()
│   └── nudges.ts            # Weekly and review nudge stubs
├── intent/
│   ├── registry.ts          # Product/project registry: buildRegistry, readRegistry/writeRegistry, getAllProjects; aggregating index (product → projects → lifecycle-status); buildRegistry takes pre-scanned RegistrySources (the caller scans repos + vault product files); persists to logs/registry.json (config.REGISTRY_FILE)
│   ├── registration.ts      # Product registration: planRegistration, planReconciliation, applyRegistration; propose-and-approve flow — planning is pure and never writes; applyRegistration drives effects via injected RegistrationEffects interface
│   ├── overlay.ts           # Product-overlay index: buildOverlayManifest, scopedRetrieval, findStalePointers; per-product pointer manifest into the type-organized vault — never re-orgs the vault, only points into it
│   ├── cockpit.ts           # buildCockpitView(registry, runStatus, taskProgress?): pure projection of registry + supervision run-status + optional task progress into CockpitView (CockpitProduct/CockpitProject with lifecycleStatus + runStatus + actions); null registry yields available:false; served by GET /api/cockpit — webview.ts feeds live RunStatusByProject from activeRuns (mutations.ts) so a project with an active work-run mutation shows runStatus:'running'. Phase 6 C3: `CockpitProject` carries an optional `progress: CockpitProgress` ({mutationId?, cap?, round, failedEvaluatorRounds, modelGen?, modelEval?, lastHeartbeatAt}); `RunStatusByProject` widened to a union of bare `CockpitRunStatus` (legacy) or an entry object carrying `{status, progress?}` (C3 callers), normalized inside `buildCockpitView`. Design tweak: `CockpitProject` also carries optional `taskProgress: {done, total}` populated from the optional third `buildCockpitView` arg (slug-keyed map sourced from `getProjectSummaries()` in `handleApiCockpit`).
│   ├── journal-intent.ts    # planJournalIntent(input): deterministic journal-to-intent planner; routes JournalNote + RoadmapCandidate into IntentProposal discriminated union (vault-intake / roadmap / register-product / disambiguation); pure — never writes; the propose half of propose-and-approve
│   ├── journal-intent-producer.ts # Phase 6 C7: scanJournalForIntent(content) extracts #product-tagged notes from a day's journal (skips well-known non-product tags like #playbook, #crm, #meeting, #diet, #books, etc.); runJournalIntentProducer({journalContent, registeredProducts, existingQueueEntries}) runs the full producer pipeline (scan → planJournalIntent → derive SHA-256 sourceNoteId per proposal → dedupe against existing queue → return entries to enqueue); pure — the nightly step caller does the queue I/O
│   ├── journal-intent-consumer.ts # Phase 6 C8: actionApprovedIntentProposal(proposal, deps) — dispatch core that turns an approved IntentProposal into a write side-effect via injected ConsumerDeps (invokeVaultUpdater / appendRoadmap / registerProduct); VALID_SLUG-guards the product at the boundary; compile-time exhaustive switch; disambiguation kind is a no-op (needs human pick first)
│   ├── journal-intent-actions.ts  # Phase 6 C8 wire-up: realConsumerDeps — vault-intake appends a journal-sourced bullet to projects/<product>.md (initializes the file if missing); appendRoadmap and registerProduct throw "wire-up deferred" with a clear message so an approved proposal of those kinds stays pending rather than silently no-op'ing (the throw bubbles up to dispatchApprovalStatus which returns 'error' and leaves the queue entry pending for retry)
│   ├── intent-proposal-queue.ts # Journal-to-intent proposal queue: QueuedIntentProposal CRUD over logs/intent-proposal-queue.json (config.INTENT_PROPOSAL_QUEUE_FILE); readIntentProposalQueue, appendIntentProposals, getPendingIntentProposals, clearApprovedIntentProposals; mirrors src/jobs/proposal-queue.ts
│   ├── agent-def.ts         # Model-agnostic agent definitions: NeutralAgentDef, parseClaudeAgent, compileToClaude, compileToCodex, compileToGemini (deferred stub — throws); compileToCodex emits a structured markdown agent document (delimited Role/Capabilities/Tools/Constraints/Instructions sections), names no model, sanitizes name against newline-injection; shared assertRequiredFields helper backs both implemented compilers; model key is dropped from the neutral format — which model runs is the policy's decision
│   ├── model-policy.ts      # Model selection policy: parsePolicy, loadModelPolicy, resolveModel; deterministic resolver (pin → role-default → global-fallback); policy loaded from policies/model-policy.json (config.MODEL_POLICY_FILE); cached per path — startup load warms cache
│   ├── escalation.ts        # Escalation policy: parseEscalationPolicy, decide, decideFailClosed; deterministic (no LLM); fail-closed — a missing or malformed policy escalates rather than falls open to auto-proceed
│   ├── planner.ts           # Planner (Layer 1): idea-to-spec lifecycle state machine — startPlanning/proposeSpec/approvePlan/abandonPlan/isScaffoldReady/buildSetupWriterBrief; approval-gated (nothing dispatched before approved); builds the project-setup-writer brief
│   ├── gen-eval-loop.ts     # Generator-Evaluator loop (Layer 2): single-model loop decision core — recordRound (enforces tests-failing rounds never reach Evaluator) and evaluateLoop (bounded loop: pass → on-branch, N failed Evaluator rounds → escalated)
│   ├── supervision.ts       # Supervision (Layer 3): visibility surface over long-running runs — isStalled, getVisibility (active/blocked/stalled), markCrashed (crash → terminal), recoverRun (restart → unknown), recordHeartbeat; pure over (runs, heartbeatIntervalMs, now); Phase 4 implemented: two optional SupervisedRun fields (`lastOutputAt?` — ISO-8601 of most recent Claude output event, distinct from lastHeartbeatAt/lastChildAliveAt; `quietNudgedAt?` — once-only quiet nudge send marker); `isQuietRun(run, quietThresholdMs, now)` (status===running + not already nudged + age from lastOutputAt-or-startedAt > threshold; soft-fail — unparseable baseline returns false rather than firing a spurious nudge); `planQuietNudges(runs, quietThresholdMs, now)` → `QuietNudgePlan` ({toNudge, updated} 1:1 stamped copies, never mutates inputs)
│   ├── sandbox.ts           # Sandboxing and security (Layer 4): sandbox boundary-policy core — worktreePathFor (per-project worktree path, slug-validated), isWriteAllowed (lexical containment, path-traversal safe, delegates to isContainedIn), isEgressAllowed (exact-match allowlist), canReachCredential (product-scoped); exports VALID_SLUG (shared slug regex) and isContainedIn(root, target) (lexical containment check, also used by destroyWorktree's guard)
│   ├── dispatch.ts          # Multi-model dispatch (Layer 5): DispatchTarget ('claude'|'codex'), DispatchProvider ('anthropic'|'openai'), DispatchHandoff (explicit structured handoff — target/agent/product/project/objective/context; context must never carry vault personal content when target is 'codex'), DispatchResult discriminated union (completed|failed+failureReason), DispatchLogEntry (adds target + ISO-8601 ts field — returned by recordDispatch), buildHandoff (validates handoff is self-contained; rejects empty objective/context), recordDispatch (builds log entry from handoff + result; accepts optional ts for deterministic tests)
│   ├── adjudication.ts      # Cross-model adjudication (Layer 2 upgrade): ReviewMode ('single-model'|'cross-model'), Adjudication (both models/providers + verdict), MergeOutcome discriminated union, resolveReviewMode (autonomous always cross-model; manual single-model unless --cross-model flag), isCrossModel (true when Evaluator/Generator providers differ), evaluateMergeContract (fail-closed, ordered gates — first failure wins: null adjudication → same-provider → verdict !== 'pass' → tests fail → escalation flag; only all-pass returns merge:true)
│   ├── scheduler.ts         # Concurrency scheduler: ScheduledProject ({product, project}), ScheduleResult ({started, running, queued}), schedule(running, queue, globalCap) — global cap + per-product cap of one, FIFO walk, queued projects never dropped; tightens work-runner's per-project cap into a per-product cap
│   ├── observation-loop.ts  # Observation loop core (§16): SensorSource ('vault'|'telemetry'|'interaction'), SensorSignal, ProjectIdea, TriageVerdict, LoopOutcome discriminated union (filed/discarded/duplicate/quiet); isDuplicate (id-equality dedupe); runObservationLoop(signals, existingIdeas, triage) — in-order triage walk with in-batch + cross-batch dedupe; empty batch returns [{kind:'quiet'}]
│   ├── observation-sensor.ts # Sensor-layer composer: SignalReader, SensorReaders bag, InteractionLogRecord (per-interaction log shape; JSDoc constraint: detail carries only structured metadata, never raw user content); readSensors fans three sources in stable order (vault → telemetry → interactions)
│   ├── observation-synthesis.ts # Synthesis stage: Diarizer callback type; synthesizeDigest(signals, diarize) — short-circuits on empty input without calling the LLM; otherwise returns the diarizer's output verbatim
│   ├── observation-triage.ts # Triage formatter: formatIdeasMarkdown(outcomes) — turns filed outcomes into markdown bullets for docs/projects/ideas.md; non-filed outcomes (discarded/duplicate/quiet) produce no line; pure, no I/O
│   ├── observation-dispatch.ts # Self-generated-project dispatch adapter: DispatchPlan union ('dispatch'|'await-approval'); planEngineDispatch(idea, decideEscalation) — escalate verdict holds for approval, proceed verdict derives projectSlug from idea.id; uses existing mutation pipeline (no new execution subsystem)
│   ├── observation-nightly.ts # Nightly observation composer: NightlyObservationDeps/NightlyObservationResult; runNightlyObservation(deps) wires sensors → synthesis → loop → triage/dispatch/format; every dep injected for testability
│   └── friction-detect.ts   # Friction-detection extension to Ask-Twice telemetry: FrictionSignal (category/id/description), AggregatedFriction (adds occurrences); aggregateFrictions(raw) — dedupe-by-id with occurrence count, sorted most-frequent-first; deterministic aggregation only, detection is upstream integration
├── mcp/
│   ├── server.ts            # MCP server: exposes KB tools (query, search, ingest, stats, lint)
│   └── index.ts             # Standalone stdio entry point for Claude Code
├── study/
│   ├── sr-state.ts          # Spaced-repetition state engine: read/write study/spaced-repetition.json, interval-ladder transitions (advanceRung, resetRung, repeatRung, admitConcept)
│   ├── sr-pool.ts           # SR pool source: Phase 1 readPool() reads the hand-seeded study/sr-seed.json
│   ├── sr-select.ts         # SR selection: selectDueConcepts() — due concepts, most-overdue first, capped at N
│   └── sr-session.ts        # SR session orchestrator: runSRSession()/handleSRMessage() — event-driven question→grade→advance loop
├── integrations/
│   ├── telegram/client.ts   # Message chunking, typing indicators
│   ├── whoop/types.ts       # Whoop API response types and daily data format
│   ├── whoop/keychain.ts    # macOS Keychain token storage via security CLI
│   ├── whoop/client.ts      # OAuth2 token management + Whoop API calls
│   └── readwise/client.ts   # Save articles to Readwise Reader API
├── workspace/
│   └── files.ts             # Read/write/append/list workspace files (assertWithinWorkspace-guarded); mirrors vault/files.ts but rooted at WORKSPACE_DIR ?? PROJECT_ROOT
├── vault/
│   ├── files.ts             # Read/write/append/list vault markdown files (assertWithinVault-guarded)
│   ├── journal.ts           # Journal file creation, append, writeMorningPrep, parseTag
│   ├── learnings.ts         # /learn-authored JSONL store + prompt-prepend builder for runAgent
│   ├── git.ts               # git add/commit/push helpers
│   ├── sessions.ts          # TG session Map with JSON persistence + crash recovery
│   ├── equipment.ts         # readEquipment() parses health/equipment.md into {home, gym} raw blocks
│   ├── whoop-recent.ts      # readRecentWhoopDays(n) returns last n parsed WhoopDailyData from health/whoop/
│   └── watcher.ts           # FSWatcher for Readwise article detection, TG notify + enqueue
└── utils/
    ├── time.ts              # America/Chicago timezone helpers (getTodayFilename, getYesterdayFilename, getTimestamp, getDayOfWeek, getRecentFilenames, etc.)
    ├── logger.ts            # Structured JSON logging with component tags
    ├── intent-log.ts        # Ask-Twice telemetry: appendIntent → logs/intent-log.jsonl
    ├── observation-log.ts   # Observation loop interaction writer: appendInteraction → logs/observation-interactions.jsonl; exports OBSERVATION_LOG_FILENAME, observationLogPath(), and re-exports InteractionLogRecord; mirrors intent-log.ts exactly — call sites that produce records land in B1.2–B1.5
    └── markdown.ts          # Markdown parsing utilities (future)
cli/
└── jarvis.ts                # CLI entry point for local interactive use
evals/
└── README.md                # YAML schema + authoring conventions for the MVP eval framework
scripts/
├── run-evals.ts             # Dev tool: parse eval YAMLs, invoke agents via runAgent(), report pass/fail
├── run-evals.test.ts        # Unit tests for the eval runner (vitest)
├── run-intent-scan.ts       # CLI entry point for intent-scan job (npm run intent-scan)
└── library-backfill.ts      # CLI entry point for bulk library-to-KB backfill (npm run library-backfill)
policies/
├── model-policy.json        # Declarative model registry + routing rules (aliases, providers, role-defaults, global-fallback); committed config, not runtime state — editing it is not a deploy
├── escalation-policy.json   # Declarative escalation rules (high-risk-change-class, run-exceeded-bounds, etc.); the escalation decision module (src/intent/escalation.ts) fails closed on a missing/malformed file — built and tested, not yet wired into a runtime caller (the engine arrives in a later phase)
└── products.json            # Per-product config: repo path, base branch, credentials file, egress allowlist; read by src/jobs/sandbox-runtime.ts via readProductsConfig/getProductConfig; exposed via config.PRODUCTS_CONFIG_FILE
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

### Writing voice

`writing/voice.md` is the user-authored source of truth for Jarvis's writing voice. `src/vault/voice.ts` exposes `buildVoicePromptSection()`, which re-reads the file on every call (no cache) so edits take effect without a restart; content is truncated at `VOICE_PROMPT_CHAR_BUDGET` (8000 chars) to bound prompt growth. The four Claude entry points in `src/ai/claude.ts` — `askClaude`, `askClaudeOneShot`, `runAgent`, and `askClaudeWithContext` (options-bag form: `{ voice: true }`) — each accept an optional `voice` flag (default `false`). When `true`, the block is appended to the system prompt (`--append-system-prompt`) so it persists across turns and carries system-level authority across all three call paths.

**Opted in** (prose the user reads): `handleConversation` (TG/webview chat), `/ask`, `summarizeSession` (/fresh + nightly capture), `morning-prep`, the blog/health/interview/new-project review sessions, the `review-writer` agent, `kb-query`, and the prose-writing post-agents `project-updater`, `worldview-updater`, and `psychology-updater`.

**Deliberately not opted in** (structured / classifier output): resolver Haiku, content-triager, photo-classifier, meeting/book extract, the review-routing one-shot JSON extract, wiki-compiler, wiki-linter, `json-updater`, `playbook-updater`, `proposal-updater`, and prep agents (journal-scanner, project-scanner, system-scanner). These stay deterministic.

### Review → post-agent flow

`src/reviews/interview.ts` drives review sessions. At outline-approval points the interview emits a structured approval signal via `sender.send(userId, text, { approval: { prompt, options } })`. On the webview this renders as clickable button rows; on Telegram the text is the fallback (the `opts` are ignored by TelegramSender). After the user approves the outline:
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
- `library/lenny/*` → `knowledge/raw/lenny/` (mutable — Lenny posts can be re-published upstream)
- `library/lennys-podcast/*` → `knowledge/raw/lenny/` (legacy folder; immutable — one-time backfill)
- `library/graham-essays/*` → `knowledge/raw/articles/` (immutable — one-time backfill)
- anything with `conversation` in the path → `knowledge/raw/conversations/`
- fallback → `knowledge/raw/notes/`

Mutable sources (world-view, playbook, active projects, journals, library/lenny) **overwrite** the `raw/` copy on every re-ingest (see `isMutableSource()`) so wiki citations reflect current content. Immutable sources (Readwise, conversations, library/lennys-podcast, library/graham-essays) are copied once.

## Key Conventions

- **TypeScript** with `tsx` runner — no build step needed for dev or prod
- **ESM** (`"type": "module"` in package.json) — all imports use `.js` extensions
- All timestamps use `America/Chicago` timezone
- Config reads from env vars; defaults in `src/config.ts`
- Claude CLI spawning is centralized in `src/ai/claude.ts` — never spawn `claude` directly elsewhere
- Message delivery uses the `MessageSender` interface (`src/transport/sender.ts`) — handlers and commands never import `TelegramBot` directly for sending; bot is only passed where needed for file downloads (photo handler)
- Session locks prevent concurrent CLI writes to the same session ID
- Git commits happen at key moments (morning prep, /fresh, nightly), not on timers
- Vault files use `readVaultFile` / `writeVaultFile` / `appendVaultFile` from `src/vault/files.ts` — paths are relative to vault root
- Workspace files use `readWorkspaceFile` / `writeWorkspaceFile` / `appendWorkspaceFile` from `src/workspace/files.ts` — paths are relative to `WORKSPACE_DIR` (falls back to `PROJECT_ROOT`)
- KB agents **must not** write outside `knowledge/`
- Wiki pages use YAML frontmatter for metadata (type, tags, related, created, last-verified, valid-until) — see `src/kb/schema.ts`
- Autonomous codebase operations go through the mutation pipeline (`src/transport/mutations.ts`) — register a `MutationApplier`, call `createMutation()`, never spawn Claude CLI for project work directly. `CLAUDE_BIN`, `registerActiveProcess`, and `unregisterActiveProcess` from `src/ai/claude.ts` keep binary resolution and shutdown tracking centralized for external spawners. The mutation pipeline is coupled to `src/jobs/supervision-store.ts`: every state transition (create → startApply → output → completed/failed/crash) upserts the corresponding `SupervisedRun` record; supervision writes are fail-safe (errors logged, never propagated to callers).
- Model selection is policy-driven: `src/intent/model-policy.ts` owns the resolver (`resolveModel`); which model runs an agent is declared in `policies/model-policy.json`, not hardcoded. `src/index.ts` loads and validates the policy at startup, failing fast on a malformed file. A missing file is tolerated — `runAgent()` then falls back to `def.model ?? config.AGENT_MODEL`, so a fresh clone without a policy file still runs.
- Escalation decisions are deterministic and auditable: `src/intent/escalation.ts` is pure over `(change, policy)` — no LLM call, no I/O. The escalation policy lives in `policies/escalation-policy.json` and fails closed (a missing or malformed policy escalates, never permits).
- Project work is **test-first**: the `/work` skill writes failing tests before implementation in every task cycle (plan → write failing tests → implement → review → fix → simplify). Project task breakdowns match this — every phase of a `docs/projects/*/tasks.md` opens with a **Tests (write first)** block whose tests must go red before that phase's implementation begins. See `docs/projects/templates/` for the standard shape.
- **User-reachability is the definition of done.** A project task is not complete when its tests pass against a pure module — it is complete when a user can trigger it from a real surface (cockpit, Telegram, cron, CLI) and observe its outcome. Phase boundaries in `docs/projects/*/tasks.md` should only be checked off after that bar is met. Before drafting `tasks.md` and `test-plan.md` for a new project (or a new phase), run through [`docs/projects/templates/planning-checklist.md`](docs/projects/templates/planning-checklist.md) — the pre-implementation decomposition pass that prevents pure-core / runtime / UI gaps. The 08-intent-layer retrospective at [`docs/projects/08-intent-layer/agent-lessons.md`](docs/projects/08-intent-layer/agent-lessons.md) is the case study that produced these rules.

## Running

```bash
npm run dev          # Development with tsx watch mode
npm run start        # Production
npm run cli          # Local CLI interface
npm run intent-scan       # Run Ask-Twice intent scan manually
npm run library-backfill  # Bulk-ingest library entries into the KB (project 05)
```

## Environment Variables

Loaded from `.env.local` via `--env-file-if-exists` in npm scripts (no dotenv dependency).

Required:
- `TELEGRAM_BOT_TOKEN` — from @BotFather
- `TELEGRAM_USER_ID` — numeric ID from @userinfobot
- `VAULT_DIR` — path to Obsidian vault

Optional:
- `FAMILY_NAMES` — comma-separated names scanned by `/family` (e.g. `Alice,Bob`). Empty disables the command.
- `IMPLICIT_CRM_NAMES` — comma-separated wikilink slugs (e.g. `sam,jude`) the nightly daily-tags analyzer treats as implicit CRM references — a journal mention like `[[sam]]` produces a CRM update for that contact even without an explicit `#crm` tag. Empty disables the rule (the implicit-CRM bullet is omitted from the analyzer prompt).
- `WHOOP_CLIENT_ID`, `WHOOP_CLIENT_SECRET` — Whoop OAuth credentials
- `READWISE_TOKEN` — Readwise Reader API
- `JARVIS_HTTP_SECRET` — shared secret for authenticated HTTP endpoints
- `RESOLVER_CONFIDENCE_THRESHOLD` — minimum confidence for resolver to dispatch a skill (default `0.7`)
- `RESOLVER_MIN_WORDS` — minimum word count before resolver runs (default `5`)
- `WORKSPACE_DIR` — path to workspace root (e.g. `~/workspace`). When set, agents receive it as context and as `JARVIS_WORKSPACE_DIR` env var so they can read project files outside the vault.
- `LENNY_MCP_TOKEN` — JWT Bearer token for the Lenny MCP server (`https://mcp.lennysdata.com/mcp`). Required for `/library-sync` and the nightly Library sync step.
- `OBSIDIAN_VAULT_NAME` — optional, defaults to basename of `VAULT_DIR`; injected into webview `<meta>` tag for Obsidian wikilink resolution
- `JARVIS_ALLOWED_HOSTS` — optional, defaults to `localhost,127.0.0.1`; host-guard allowlist for webview endpoints (`isAllowedHost`)
- `WORK_RUN_PER_PROJECT_CAP` — max concurrent `work-run` mutations per project slug (default `1`, min `1`)
- `WORK_RUN_GLOBAL_CAP` — max concurrent `work-run` mutations across all projects (default `2`, min `1`)
- `WORK_RUN_RETENTION_MAX_RUNS` — max terminal work-run artifact dirs to keep under `logs/work-runs/` (default `3`, min `1`); enforced by `gcWorkRuns` (project 11 Phase 3) at startup and on each run completion
- `WORK_RUN_RETENTION_MAX_BYTES` — max total bytes of terminal work-run artifact dirs under `logs/work-runs/` (default `200 MB`, min `1`); enforced alongside `WORK_RUN_RETENTION_MAX_RUNS` — pruning stops when both caps are satisfied
- `WORKTREE_ROOT` — directory where git worktrees are created per product/project (default `<project-root>/.worktrees`, gitignored); exposed via `config.WORKTREE_ROOT`

`LOGS_DIR` is hardcoded to `<project-root>/logs/` (gitignored). `logs/last-workout.json` (the most recent generated workout, written by `/workout` and consumed by `/done-workout`) is exposed via `config.LAST_WORKOUT_FILE`. `logs/agent-runs.jsonl` is a rolling JSONL log of every `runAgent()` invocation (`{agent, startedAt, durationMs, status}`), consumed by `getStateSnapshot()` in `src/server/state-snapshot.ts`. `logs/mutations.jsonl` is a rolling JSONL log of every `MutationDescriptor` state transition, written by `src/jobs/mutations-log.ts`. `logs/registry.json` is the intent-layer product/project registry, exposed via `config.REGISTRY_FILE`; it is always rebuildable (not source of truth). `logs/intent-proposal-queue.json` is the journal-to-intent proposal queue (project 08), exposed via `config.INTENT_PROPOSAL_QUEUE_FILE`; pending entries surface in the webview's Pending Approvals panel and in review prep. Approving an intent-proposal (from the cockpit inbox or a Telegram inline button) routes through `dispatchApprovalStatus`, which invokes `actionApprovedIntentProposal` (Phase 6 C8) before flipping queue status — vault-intake proposals append a journal-sourced bullet to `projects/<product>.md`; the roadmap and register-product paths throw "wire-up deferred" and leave the queue entry pending for retry. `policies/model-policy.json` is the declarative model selection policy, exposed via `config.MODEL_POLICY_FILE`; it is committed config (not runtime state) and lives under `policies/` rather than `LOGS_DIR`. `policies/products.json` is the per-product sandbox config (repo path, base branch, credentials file, egress allowlist), exposed via `config.PRODUCTS_CONFIG_FILE`; read at runtime by `src/jobs/sandbox-runtime.ts`. `config.WORKTREE_ROOT` defaults to `<project-root>/.worktrees` (gitignored, env-overridable via `WORKTREE_ROOT`) and is the root under which `createWorktree` creates per-product git worktrees. `logs/egress-denials.jsonl` is the append-only audit log of denied egress attempts written by `src/jobs/egress-policy.ts`, exposed via `config.EGRESS_DENIAL_LOG`; entries are advisory while `EGRESS_ENFORCEMENT_MODE` is `'documented-gap'` and become enforcement evidence when the per-run proxy ships. `logs/supervised-runs.json` is the persistent store for current `SupervisedRun[]` state, written by `src/jobs/supervision-store.ts`, exposed via `config.SUPERVISED_RUNS_FILE`; holds current state per run (not events) and is always rebuildable from in-flight mutations. `logs/observation-interactions.jsonl` is the append-only JSONL log of per-interaction signals written by `src/utils/observation-log.ts` via `appendInteraction()`; consumed by the observation sensor reader (`readInteractionSignals` in `src/intent/observation-sensor.ts`) to feed the nightly observation loop; `detail` must carry only structured metadata — never raw user content. `logs/dispatch-log.jsonl` is the append-only audit log of every multi-model dispatch attempt, written by `src/jobs/dispatch-runtime.ts` via `recordDispatch`, exposed via `config.DISPATCH_LOG_FILE`; each entry carries the full `DispatchLogEntry` (handoff + result + ts). `logs/planning-sessions.json` is the persistent store for active `StoredPlanningSession[]` entries, written by `src/reviews/planning.ts` via `persistPlanningSessions()` (called on clean shutdown and uncaughtException); exposed via `config.PLANNING_SESSIONS_FILE`; restored at startup via `restorePlanningSessions()` so in-progress `/plan` conversations survive restarts. `logs/work-runs/` is the root for per-work-run durable artifacts (project 11) — each run gets a `<id>/` subdir holding `transcript.jsonl` and `summary.json`; exposed via `config.WORK_RUNS_DIR`. `logs/work-runs/index.jsonl` is the rolling recent-work-runs index (one JSON row per terminated run, appended by `src/jobs/work-run-store.ts`'s `appendIndexRow`, read torn-line-tolerantly by `readRecentIndex`); exposed via `config.WORK_RUNS_INDEX_FILE`.

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
| proposal-updater | `.claude/agents/proposal-updater.md` | Post-review: action approved Ask-Twice proposals — creates new agent files under `.claude/agents/` and/or registers cron frontmatter on existing agents; marks actioned entries in `logs/proposal-queue.json` |
| worldview-updater | `.claude/agents/worldview-updater.md` | Post-review: apply approved diffs to world-view/*.md with changelog entry |
| psychology-updater | `.claude/agents/psychology-updater.md` | Post-review: apply scoped updates to pages/psychology.md |
| json-updater | `.claude/agents/json-updater.md` | Post-review / nightly: apply updates to JSON data stores |
| daily-content-updater | `.claude/agents/daily-content-updater.md` | Nightly daily-tags: apply updates to markdown content stores (`health/nutrition.md`, `projects/ideas.md`, `writing/topics.md`) |
| intent-scan | `.claude/agents/intent-scan.md` | Saturday 3pm cron: runs `npm run intent-scan` to process intent-log and write skill proposals |
| workout-generator | `.claude/agents/workout-generator.md` | Generates a one-shot daily workout (warmup → main → cooldown) tailored to goals, equipment, recent training load, Whoop recovery, and exercise preferences |
| lenny-sync | `.claude/agents/lenny-sync.md` | Pull new Lenny posts/podcasts via MCP into library/lenny/, update logs/lenny-sync-state.json |
| sr-question-generator | `.claude/agents/sr-question-generator.md` | Generate one open-ended spaced-repetition question from a wiki concept, or signal SKIP |
| sr-grader | `.claude/agents/sr-grader.md` | Grade a free-form spaced-repetition answer against the wiki concept — returns grade + core/missed points + explanation |

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
