# Module Reference

Per-file reference for every `src/` module, plus `cli/`, `scripts/`, and `policies/`. This is the deep detail extracted from `CLAUDE.md` — read it on demand when working in a given area. `CLAUDE.md` carries only the area-level module map; the per-file annotations and project-phase history live here.

The annotations preserve implementation invariants and the project-phase forensics ("project 13 Phase 1c", "project 15 P0.4", etc.) that explain *why* a given seam exists. Security/durability invariants that any change must preserve are also summarized in `CLAUDE.md` → Key Conventions → Invariants.

---

## Entry point & config

- **`src/index.ts`** — Entry point: boots HTTP server, Telegram bot, scheduler. Startup sequence: `reconcileOrphans()` → `await runRecoveryFinalize()` (project 15 P0.4 — drives stale `running` supervised runs to a real terminal state through the hold-mode finalizer, classified on work product, while their worktrees still exist; awaited BEFORE the sweep) → `recoverSupervisedRuns()` (fallback: flips any run that couldn't be finalized `running` → `unknown`, fail-safe) → `restorePlanningSessions()` (reload persisted planning sessions, fail-safe) → `cleanupOrphanWorktrees()` (fire-and-forget) → `runWorkRunGc()` (fire-and-forget — prunes `logs/work-runs/` artifacts over retention caps). Calls `startStallCheck(bus)` and `startPlanningExpiry()` after `startScheduler()`; `stopStallCheck()` and `stopPlanningExpiry()` in shutdown. `persistPlanningSessions()` called on clean shutdown and uncaughtException paths. Does not mount `/mcp`; the Claude App connector lives in the standalone MCP daemon. Registers all mutation appliers.
- **`src/config.ts`** — Typed env vars and constants.

## `src/ai/`

- **`claude.ts`** — All Claude CLI spawning: `askClaude`, `runAgent`, `summarizeSession`. Exports `setBus(bus)` (called from index.ts so `runAgent()` can emit `BusAgentEvent` frames; type-only `NotificationBus` import avoids circular dep). `runAgent()` appends `{agent, startedAt, durationMs, status}` to `logs/agent-runs.jsonl` after each invocation. Exports `CLAUDE_BIN` (resolved binary path), `registerActiveProcess`/`unregisterActiveProcess` (for external spawners like work-runner). `runAgent()` resolves each agent's model through the model selection policy (`src/intent/model-policy.ts`) — pin → role-default → global-fallback. Also accepts an optional `writeScope?: AgentWriteScope` (`{cwd, writableDirs}`) threaded into `execClaude` — overrides the default vault cwd and adds each `writableDir` via `--add-dir` so an agent (e.g. project-setup-writer scaffolding into a target product repo) gets real write access there; omitted = legacy vault-cwd behavior. The four entry points (`askClaude`, `askClaudeOneShot`, `runAgent`, `askClaudeWithContext`) each accept an optional `voice` flag (default false) — when true, the writing-voice block is appended via `--append-system-prompt`.
- **`codex.ts`** — Codex CLI spawn primitive for Layer 5 multi-model dispatch: `resolveCodexPath()`, `getCodexBin()` (lazy — Rune boots without Codex installed), `isCodexAvailable()` (non-throwing probe), `isCodexLoggedIn()` (spawns `codex login status`, 10s hard timeout, reads + drains BOTH stdout and stderr — the current Codex CLI prints the "Logged in" marker to stderr with stdout empty; returns `Promise<boolean>`), `probeCodexProvider()` (combined binary + login probe, returns `ProviderAvailability`), `runCodex(prompt, opts)`. Types `RunCodexOpts` + `CodexResult` + `CodexSandboxMode` + `ProviderAvailability`. `RunCodexOpts.env` is the sandbox seam — sandbox callers (A5.2 `dispatchToExecutor`) must pass `buildSandboxEnv()`; default `process.env` is only safe for non-sandboxed Rune-internal runs. Registers each child via `registerActiveProcess`/`unregisterActiveProcess` from claude.ts for unified graceful shutdown.
- **`tool-labels.ts`** — Friendly labels for streaming tool-use events; `formatToolUse`, `scrubPathsInText` (reused by work-run transcript adapter).

## `src/bot/`

- **`telegram.ts`** — Bot init: `createBot()` factory + `wireHandlers(bot, sender)` wires message + callback_query events after senders are ready. The callback_query handler (Phase 6 C6.2) auth-gates by `TELEGRAM_USER_ID`, acks the query, then routes composite-id payloads through `dispatchApprovalStatus` (shared with the cockpit inbox) or falls back to `dispatchText` for conversational values (slash-prefixed values are rejected to prevent inline buttons from triggering destructive commands).
- **`handlers/text.ts`** — Command routing + multi-turn conversation handler. `handleTextMessage(sender, msg)` — no direct bot dependency. Exports `dispatchText(sender, userId, text)` shared with webview. Active-planning-session check takes routing priority over the default conversation handler — free-form text routes through `routeToPlanning` → `handlePlanningTurn` when a planning session is active. `routeToPlanning` appends "— spec proposed · /approve to scaffold · /clear to abandon" footer when the planning handler returns spec-proposed status. `/approve` is wired in `dispatchText` but intentionally excluded from `SLASH_COMMAND_METADATA` (approval is an explicit gate, not resolver-inferred).
- **`handlers/url.ts`** — URL detection, fetch, content-triager agent, routing.
- **`handlers/photo.ts`** — Photo download, photo-classifier agent, routing.
- **`skill-registry.ts`** — Resolver skill registry: `SkillEntry`, `SLASH_COMMAND_METADATA`, `buildSkillRegistry`, `getSkillRegistry` (cached), `reloadSkillRegistry`.
- **`resolver.ts`** — Classify free-form TG messages against skill registry via Haiku; returns `ClassifyResult {skill, args, confidence, second_skill, second_confidence, ambiguous}`.
- **`work-run-release-callback.ts`** — Project 13 Phase 1c — Telegram release callback handler: `parseWorkRunReleaseCallback(data)` recognises `work-run-release:<id>` and `work-run-release-confirm:<id>` callback payloads; `dispatchTelegramWorkRunRelease(sender, userId, data)` delegates to the shared `requestWorkRunRelease` runtime (dirty-confirm path sets `{confirmDirty:true}`), replies with `formatReleaseRequestReply`.

### `src/bot/commands/`

One file per slash command:

- **`fresh.ts`** — `/fresh`: summarize active chat, append to journal, optionally enqueue KB-worthy summary, commit, reset session; also abandons any active planning session. Exports `closeConversation` helper reused by `/journal`.
- **`fresh-full.ts`** — `/fresh-full`: verbatim conversation transcript logging (no summarization).
- **`clear.ts`** — `/clear`: discard active session without journaling; also abandons any active planning session.
- **`journal.ts`** — `/journal`: append literal entry to today's journal; if a chat session is active, also calls `closeConversation` (mirrors `/fresh`).
- **`ask.ts`** — `/ask`: one-shot freeform Claude question (legacy escape hatch; no longer a resolver route).
- **`kb.ts`** — `/kb`: one-shot knowledge base query (legacy escape hatch; no longer a resolver route).
- **`ingest.ts`** — `/ingest`: enqueue vault file for KB ingestion.
- **`status.ts`** — `/status`: system health overview.
- **`prep.ts`** — `/prep`: trigger morning prep.
- **`priorities.ts`** — `/priorities`: review/set daily priorities.
- **`daily.ts`** / **`weekly.ts`** / **`monthly.ts`** / **`quarterly.ts`** / **`yearly.ts`** — review sessions.
- **`health.ts`** — `/health`: health review session.
- **`blog.ts`** — `/blog`: blog post drafting session.
- **`workout.ts`** — `/workout`: invoke workout-generator agent with goals/equipment/exercises/Whoop recovery; persist `logs/last-workout.json`; chunk-send markdown to TG; pre-syncs Whoop via `ensureWhoopSyncedForToday()`.
- **`done-workout.ts`** — `/done-workout`: append most recent generated workout to today's journal.
- **`syllabus.ts`** — `/syllabus`: current study syllabus progress and assignments.
- **`study.ts`** — `/study`: spaced-repetition session: quiz over due wiki concepts.
- **`family.ts`** — `/family`: family planning/review.
- **`career.ts`** — `/career`: career reflection/planning.
- **`learn.ts`** — `/learn`: append a runtime learning; auto-prepended to future agents.
- **`learn-list.ts`** — `/learn-list`: echo the current prepended learnings.
- **`cancel.ts`** — `/cancel [opId-prefix]`: SIGTERM an in-flight Claude op (most recent for user, or by id prefix).
- **`plan.ts`** — `/plan [product]`: start a PM-led scoping conversation scoped to a product; with a known slug creates a planning session and replies with the kickoff prompt; without args or with unknown slug lists registered products.
- **`approve.ts`** — `/approve`: approve the PM spec and run the automated downstream planning/scaffold pipeline; a thin orchestrator that gates (normal vs already-approved retry path), streams tech-lead breakdown → critique → context seed → scaffold progress, delegates the scaffold + linked-promotion drive to the shared `runScaffoldApproval` runtime (`src/jobs/scaffold-approval.ts`), maps outcomes to a chat reply (scrubAbsolutePaths-sanitized on failure), and uses a delete-on-success / leave-for-retry decision; not in `SLASH_COMMAND_METADATA`.
- **`library-sync.ts`** — `/library-sync`: trigger on-demand Lenny posts/podcasts sync via lenny-sync agent.
- **`seed.ts`** — `/seed`: bulk-seed KB from vault files via `seedAndProcess()`.
- **`cancel-review.ts`** — cancel an in-progress review session.
- **`active-context.ts`** — context listing/switching.

## `src/transport/`

- **`sender.ts`** — `MessageSender` interface, `SendOpts` (`approval?: {prompt, options[]}`) type, `createSenders(bot, bus)` factory; subscribes tg/webview to bus `message`, `agent-event`, `mutation-event`, and `op-event`; returns `{ tg, webview, destroy }`.
- **`notification-bus.ts`** — `NotificationBus`: typed event bus with publish/on/off. `BusEvent = BusMessageEvent | BusAgentEvent | BusMutationEvent | BusOpEvent`. `BusOpEvent` has subKind `start`/`progress`/`end` with opKind `agent`/`chat`/`one-shot`/`classifier`. `BusMutationEvent.subKind` widened with `start` (project 13 Phase 1a — carries the local-operator `operatorWorktreePath`). Fault-isolates failing subscribers.
- **`mutations.ts`** — Mutation pipeline: `MutationDescriptor`/`MutationKind`/`MutationStatus` types, applier registry, `createMutation()`, `cancelMutation()`, `activeRuns` map, `setMutationBus()`. AutoApprove appliers start immediately. Hooks into supervision-store at every state transition (seed on create, flip on startApply/completed/failed/crash, throttled heartbeat on output events). `buildSupervisedRun` carries both `lastChildAliveAt` and `lastOutputAt` params — output events advance `lastOutputAt` (LLM-output signal for quiet-run nudge), keep-alive/terminal writes thread the current value through so it is never reset. `MutationDescriptor` carries optional `outcome?: WorkOutcome` + `workProduct?: WorkProductFacts` (project 11 Phase 2) — populated by `applyOutcomeToDescriptor` in startApply's terminal branch (gated on `kind === 'work-run'`) BEFORE `appendMutationLine`. `MutationEvent.kind` union includes `start` (project 13 Phase 1a) — the `startApply` loop publishes it to the bus with NO supervision side effect and does NOT copy its data onto the descriptor (the un-scrubbed `operatorWorktreePath` it carries must never reach `mutations.jsonl`). Project 13 Phase 1b + AskUserQuestion: terminal supervision flip treats work-run/orchestrated events with `data.parked === true` as a supervision override and preserves `parkedQuestion` when present. `MutationKind` includes `work-run-release` and `work-run-answer`; `MutationApplier.supervised?: false` suppresses createMutation supervision seeding for these control mutations.
- **`in-flight.ts`** — In-flight Claude-op registry: `registerOp`/`unregisterOp`/`cancelOp`/`cancelMostRecentForUser`/`listOps`. 5s heartbeat ticker emits op-event:progress. `setInFlightBus(bus)` wires bus emission. Cancelled flag overrides exit status to `cancelled`.
- **`telegram-sender.ts`** — `TelegramSender` implements `MessageSender`; delegates to `sendLongMessage`; per-user typing timer map. `onMutationEvent()` sends one-line TG summary on completed/failed (gen-eval-loop terminals → structured ✅/⏸/💥 via `formatGenEvalLoopTerminal`; work-run terminals → outcome-aware `formatWorkRunTerminal`; project 15 Phase 3.5 specializes the branch-complete case by gated-merge disposition; project 13 Phase 1a `formatWorkRunStart`; parked-aware branch). Sentinel/manual parked runs render a Release inline button; `AskUserQuestion` parked runs render one answer button per option (`work-run-answer:<runId>:<optionId>`). The un-scrubbed `operatorWorktreePath` is delivered verbatim because Telegram (to `TELEGRAM_USER_ID`) is a local-operator surface — scrubbing exemption applies equally to the cockpit WebSocket (localhost-bound, auth-gated). `send()` with `opts.approval` renders an inline keyboard (one button per option, `callback_data = option.value`). `onOpEvent()` sends/edits/deletes "🤔 label · Xs · /cancel" tracker messages (10s edit throttle, skips classifier ops). `shutdown()` drains timers.
- **`webview-sender.ts`** — `WebviewSender` implements `MessageSender`; `register(userId, ws)`, `unregister(userId, ws)`, per-user WS fan-out; `onAgentEvent()`, `onMutationEvent()`, `onOpEvent()` forward bus frames to connected WS clients.
- **`approval-actions.ts`** — Phase 6 C6: transport-agnostic approval-actioning module shared between the HTTP cockpit (`POST /api/approvals/:id/{approve,reject}`) and the Telegram callback_query handler. `parseApprovalId(id)` splits a composite `<source>:<payload>` id; `dispatchApprovalStatus(id, status)` routes to per-source queue mutators and returns three-valued `ok`/`not-found`/`error` (HTTP maps `error` to 500). All writes wrapped in `safeWrite`. `blocked-on-human` Approve routes to `requestWorkRunRelease`; Reject dismisses the parked supervision row. `work-run-answer:<runId>:<optionId>` routes to `requestWorkRunAnswer`.

## `src/reviews/`

- **`session.ts`** — `ReviewSession` type, persistence, lifecycle management.
- **`orchestrator.ts`** — Review flow orchestrator: start, route messages, handler registry.
- **`interview.ts`** — Interactive interview phase for review sessions; review prep surfaces pending playbook drafts, Ask-Twice proposals, and journal-to-intent proposals for approval.
- **`worldview-drift.ts`** — Detect world-view changelog entries affecting active projects.
- **`kb-activity.ts`** — Scan `knowledge/log.md` INGEST entries → structured digest for review prep.
- **`daily.ts`** / **`weekly.ts`** / **`monthly.ts`** / **`quarterly.ts`** / **`yearly.ts`** — review handlers.
- **`health.ts`** — Health review handler.
- **`blog.ts`** — Blog drafting handler. Calls `composeWriterContext(buildBaseInstructions(topic))` before the first Claude turn (writer-role identity, project 12). Runs `detectCompletionSentinel` on every assistant turn; on a final-line sentinel strips it from the reply and runs `captureLessons` (fault-isolated, 20s timeout).
- **`planning.ts`** — Planning session store: `createPlanningSession`, `getPlanningSession`, `getActivePlanningSession`, `updatePlanningSession`, `deletePlanningSession`, `abandonActivePlanningSession`, `persistPlanningSessions`, `restorePlanningSessions`; sessions keyed by chatId, persisted to `logs/planning-sessions.json`. Exports `approveActivePlanningSession(chatId)` → `ApproveResult`. `StoredPlanningSession` carries an optional `promotionId` linking a backlog-Plan-opened session to its durable Promotion. `deletePlanningSession` is the single chokepoint every abandonment path funnels through, so it hosts `abandonLinkedPromotion`: when the deleted session has a `promotionId`, it advances the linked promotion to `planning-abandoned` (best-effort; a promotion-log failure never blocks session cleanup).
- **`planning-handler.ts`** — Multi-turn Socratic planning handler: `handlePlanningTurn` (drives one scoping turn through the `defaultScopingTurn` LLM call), `ScopingResult`/`ScopingTurn`/`PlanningHandlerDeps` types; injected `ScopingTurn` seam enables test doubles.

## `src/server/`

- **`http.ts`** — HTTP server: health, session capture, Whoop OAuth callback; mounts webview routes when `WebviewDeps` provided.
- **`auth.ts`** — `verifyAuth(req)`, `isAllowedHost(req)`, `safeCompare(a, b)` — cookie + host-guard auth helpers.
- **`mcp-transport.ts`** — `/mcp` Streamable HTTP route (project 16 Phase 2): `mountMcpRoute(opts?)` → handled-boolean handler with `closeAll()` teardown and `getActiveSessionCount()` status seam; gate order host-allowlist 403 → FAIL-CLOSED bearer 401 → SDK `StreamableHTTPServerTransport`; per-session `McpServer` instances (default `createRuneMcpServer(APP_SURFACE_TOOLS)`); sessions open only via initialize POST (1MB body cap), evicted on close/DELETE + 30-min idle timer.
- **`mcp-oauth.ts`** — Single-user OAuth 2.1 for `/mcp` (project 16 Phase 2): `createMcpOAuth({gateSecret, userId, now?, tokenTtlMs?, issuerBaseUrl?, loadState?, saveState?})` → `{handleOAuthRoute, verifyBearer}`. `tokenTtlMs` null=never-expire / undefined=1h / N=ms. `loadState`/`saveState` persistence seam keeps clients+tokens across restart. DCR (http/https redirect_uris only, MAX_CLIENTS=20 cap), consent-form gate, PKCE S256-only, codes single-use + redirect_uri/client-bound; tokens in-memory, userId-bound, expiry-checked per call; fail-closed `verifyBearer` never throws; serves RFC 8414 AS metadata + RFC 9728 protected-resource metadata (issuer pinned via `MCP_ISSUER_URL`, Host-header fallback local-only).
- **`mcp-oauth-store.ts`** — File persistence for `/mcp` OAuth state: `readOAuthStore(path)`/`writeOAuthStore(path, state)` over a caller-supplied path (web legacy store or standalone daemon store), 0600, atomic temp-then-rename. Holds bearer tokens; revoke all = delete the relevant store file + restart.
- **`read-body.ts`** — Shared bounded request-body reader (1MB default; destroys the socket on overflow, typed `BodyTooLargeError`).
- **`restart.ts`** — `restartServer()`: production-only daemon relaunch — fires a detached `launchctl kickstart -k gui/<uid>/$LAUNCHD_LABEL`; returns `RestartResult`; backs `POST /api/server/restart` and the cockpit "Restart server" button.
- **`webview.ts`** — `mountWebviewRoutes(server, deps)`: serves `GET /`, `GET /static/*`, the cockpit/home/backlog/planning REST API, `POST /api/mutations`, `POST /api/server/restart`, work-run routes, and `WS /api/ws`. `handleApiCockpit` reads run-status via `readCockpitRunStatus(config.SUPERVISED_RUNS_FILE)` (not in-memory `activeRuns`), layers `readWorkRunProjections` and per-product backlog counts, and feeds `buildCockpitView`. REST endpoints include `GET /api/cockpit`, `GET /api/backlog/:product`, `POST /api/backlog/:product/:kind`, `POST /api/backlog/:product/items/:id/plan`, `GET /api/promotions/:id`, `POST /api/promotions/:id/retry`, `POST /api/mutations/:id/cancel`, `POST /api/ops/:id/cancel`, `GET /api/work-runs/:id`, `GET /api/work-runs/:id/transcript`, `POST /api/work-runs/:id/release`. `loadIndexHtml` templates `__OBSIDIAN_VAULT_NAME__` and `__IS_PRODUCTION__` into index.html; `index.html` is cached at mount time in production, re-read per `GET /` in dev. See `subsystems.md` for the full endpoint/behavior catalog.
- **`backlog-actions.ts`** — Pure per-item action computation for `GET /api/backlog`: `computePlanAction`/`withActions` derive the plan action + `disabledReason` for each backlog item (precedence: planning-active > already-promoted > bug-done > loop-filed > parse-warning); types `BacklogItemAction`, `BacklogItemWithActions`, `BacklogDisabledReason`.
- **`webview-bootstrap.ts`** — `handleWebviewMessage(sender, userId, text)` — thin adapter over `dispatchText` for webview.
- **`projects-snapshot.ts`** — `getProjectSummaries()`: reads `docs/projects/index.md` + tasks.md per project; returns `ProjectSummary[]` with slug, status, task progress (done/total/perPhase), specPath, lastModified.
- **`state-snapshot.ts`** — `StateSnapshot` type + `getStateSnapshot()`: reads `logs/agent-runs.jsonl`, scheduler-state.json, active session/review, ingestion queue, playbook/proposal/intent counts, project summaries, active+recent mutations, in-flight Claude ops; used by `GET /api/state`.
- **`cockpit-run-status.ts`** — `mapVisibilityToRunStatus(visibility)`: pure projection from supervision `VisibilitySurface` → `RunStatusByProject`; `readCockpitRunStatus(filePath, now?)` wraps `readAllRuns` + `getVisibility` + mapper; blocked-on-human wins over running for the same project.
- **`work-run-projection.ts`** — `readWorkRunProjections(dir, indexFile, recent?, activeRuns?)`: reads `logs/work-runs/` index.jsonl + per-run summary.json (via `readWorkRunSummary`) + transcript.jsonl tail into a slug-keyed `WorkRunProjection` map; server-layer bridge between the jobs-layer store and the intent-layer cockpit view; best-effort. Holds the compile-time drift guard between jobs `WorkOutcome` and intent `WorkRunOutcome`. `transcriptUrl` points at `GET /api/work-runs/:id/transcript` when a transcript file exists.
- **`static/`** — Webview frontend (vanilla HTML/JS/CSS): index.html, app.js, app.css plus home-view.js, product-deep-view.js, run-feed-client.js, client-view.js, view-router.js. Cockpit sidebar, backlog drawer, planning panel, pending-approvals, product deep-view, real-time run-feed. See `subsystems.md` for the cockpit UX detail.

## `src/kb/`

- **`engine.ts`** — Orchestrates ingest/query/lint, processes ingestion queue.
- **`init.ts`** — KB directory scaffolding and schema initialization.
- **`ingest.ts`** — Copy source to raw/ → spawn wiki-compiler agent → entity-link touched pages. `determineRawDir()` routes by path (see `reviews-kb-vault.md` → KB raw-source routing).
- **`index-integrity.ts`** — Deterministic `knowledge/index.md` repair: scans `knowledge/wiki/**/*.md`, detects missing wiki links, and appends conservative summary lines under category headings without LLM calls.
- **`entity-extract.ts`** — `linkEntities()`: build alias map from JSON stores + `FAMILY_NAMES`, wikilink bare mentions in reference sections, append to `related:` frontmatter.
- **`query.ts`** — Build context → spawn kb-query agent → synthesized answer.
- **`lint.ts`** — Spawn wiki-linter agent → health report.
- **`search.ts`** — ripgrep-based full-text search across vault + wiki; `searchVault`'s `directory` option is containment-guarded against the vault root (defense-in-depth — `vault_search` made it remotely reachable, project 16).
- **`queue.ts`** — JSON-file ingestion queue (enqueue/dequeue/clear).
- **`schema.ts`** — Default schema.md content for new knowledge bases.
- **`seed.ts`** — `seedAndProcess()`: enumerate vault files → enqueue new/mutable sources → process queue.

## `src/jobs/`

- **`scheduler.ts`** — Cron job registration: `startScheduler(bot)`, `stopScheduler()`.
- **`morning-prep.ts`** — Gather vault data → synthesize morning prep → write to journal.
- **`nightly.ts`** — Nightly orchestrator (17 steps): capture → daily tags → birthday alerts → playbook extract → registry rebuild → journal-intent producer → journal ingest → meeting extract → library sync → KB queue → KB index repair → knowledge reconciliation → whoop activity → observation loop → learning loop → KB lint → mark processed → commit. `stepLearningLoop` reads machine-readable feedback records (`logs/feedback.jsonl`), applies a content-hash processed-marker (`logs/feedback-processed.json`), per-pass cap of 20, per-record 60s post-mortem timeout, per-record fault isolation; commits attributed lessons into `agents/<role>/memory.md`. **Dev rule:** when adding a nightly step, update `nightly.test.ts`'s step-count + ordered step-name snapshot (and any positional `steps[i]` index), and check `nightly.nosleep.test.ts`'s narrow `node:child_process` mock (it stubs `spawn` only — a step that transitively imports `execFile` makes the whole module fail to import as "0 test").
- **`capture.ts`** — Session capture logic (used by HTTP endpoint + nightly job).
- **`whoop-sync.ts`** — Whoop sleep sync (8am) + activity sync (nightly) + trends; `ensureWhoopSyncedForToday()` best-effort pre-sync for user-triggered handlers.
- **`playbook-extract.ts`** — Scan today's journal for `#playbook` tags → draft entries into `playbook-queue.json`.
- **`meeting-extract.ts`** — Scan today's journal for `#meeting` blocks → structured `Meeting[]` via `askClaudeOneShot`.
- **`book-summarizer.ts`** — Generate 1-2 sentence book summary via `askClaudeOneShot` (returns null on UNKNOWN).
- **`intent-scan.ts`** — Weekly Ask-Twice scan: reads `intent-log.jsonl` (last 30 days), groups via Haiku, dedupes against skill registry + pending queue, writes up to 3 proposals to `proposal-queue.json`.
- **`proposal-queue.ts`** — Proposal queue types + CRUD (`logs/proposal-queue.json`).
- **`mutations-log.ts`** — Append-only JSONL log for mutations (`logs/mutations.jsonl`): `appendMutationLine`, `readRecentMutations`, `reconcileOrphans` (flips stale `running` entries to `failed` at startup).
- **`work-runner.ts`** — `workRunApplier`: `MutationApplier` for `work-run` kind; spawns Claude CLI with `--output-format stream-json --verbose`. See `subsystems.md` → Work-run lifecycle for the full behavior (transcript tee, classification, finalizer, parked state, commit-poll). Stream scanning parks on either `RUNE_WORK_RUN_SENTINEL` or `AskUserQuestion` tool_use; user/system cancellation still takes precedence. `validate()` rejects when a `blocked-on-human` supervision record exists for the slug OR the worktree path exists. Re-exports `workBranchName` from `src/intent/sandbox.ts` for back-compat. `WorkRunRuntimeDeps` injection seam with `__setWorkRunRuntimeForTest`/`__resetWorkRunRuntimeForTest`.
- **`work-run-transcript.ts`** — Stream-json→display adapter + durable sink: `parseStreamJsonLine`, `streamJsonToDisplay`, `redactSecrets` (credential URLs, Bearer/sk- tokens, Telegram bot tokens, GitHub PATs, AWS keys, JWTs), `createRingBuffer` (bounded last-N line store), `createTranscriptSink` (per-run WriteStream to `<baseDir>/<runId>/transcript.jsonl`).
- **`work-run-classify.ts`** — Terminal classification: `classifyOutcome(facts)` (branch-complete/partial/noop/dirty-uncommitted/failed), `parseTasks`/`computeTaskTransitions` (tasks.md delta), `computeWorkProduct` via injected `GitRunner` (scrubs host-absolute paths before they reach `mutations.jsonl`/bus), `finalizeWorkRun` (crash-safe single terminal event emitter), `applyOutcomeToDescriptor`.
- **`work-run-store.ts`** — Run-store: `writeSummary` (atomic temp-then-rename of per-run summary.json), `appendIndexRow`, `readRecentIndex` (torn-line-tolerant), `readWorkRunSummary(dir, id)` (VALID_SLUG self-guard + shape guard), `recordWorkRunPhase`/`readLastWorkRunPhase` (durable per-run finalize-phase store for gated-merge crash-resume).
- **`work-run-forensics.ts`** — `exportForensics(opts)` writes a reconstructable evidence bundle (diffstat.txt / status.txt / diff.patch / diff-staged.patch — redacted; bundle.git via `git bundle create`; untracked.tar) to `logs/work-runs/<id>/` BEFORE the worktree is destroyed; best-effort by contract.
- **`work-run-gc.ts`** — Retention GC: `planGc` (pure: selects terminal, unprotected runs to delete oldest-first to satisfy count+bytes caps) + `gcWorkRuns` (effectful; same-tick discipline; `isContainedIn` + branch-prefix guards before every destructive op).
- **`work-run-gc-runner.ts`** — Runtime glue: `runWorkRunGc(product?)` gathers live protected-set inputs and calls `gcWorkRuns` with the retention caps; swallows all errors (fire-and-forget callers).
- **`work-run-commit-poll.ts`** — `planCommitProgress(opts)`: parent-side throttle decision for the per-run commit-progress ping; `COMMIT_POLL_INTERVAL_MS` (10s), `COMMIT_PING_THROTTLE_MS` (10s), `SUBJECT_MAX_CHARS` (200); message format `📊 <subject> · X/Y tasks`.
- **`work-run-sentinel.ts`** — `parseWorkRunSentinel(text)` parses the `RUNE_WORK_RUN_SENTINEL { version, pendingCheck, command?, reason? }` line a `/work --auto` run emits to PARK for a human; fail-closed; `SENTINEL_FIELD_MAX_CHARS=500`; PURE.
- **`work-run-release.ts`** — Shared work-run RELEASE runtime: `releasePreflight(id)`, `runWorkRunRelease(payload, deps)`, `requestWorkRunRelease(id, opts?)` (ONE shared entry point for all surfaces), `formatReleaseRequestReply`, `workRunReleaseApplier` (`work-run-release` `MutationApplier`, autoApprove, `supervised:false`).
- **`work-run-question.ts`** — Pure parser for Claude `AskUserQuestion` assistant `tool_use` blocks; accepts `options`/`choices`/`answers` arrays of strings or `{label,value,description}` objects, assigns stable short option ids, and returns a malformed fallback so a seen-but-unparseable tool call parks instead of silently classifying.
- **`work-run-answer.ts`** — Shared answer/resume runtime for question-parked work-runs: `requestWorkRunAnswer(runId, optionId)` validates the parked record/question/worktree and creates `work-run-answer`; `workRunAnswerApplier` (`autoApprove`, `supervised:false`) spawns Claude in the existing worktree with the selected answer injected, appends to the original transcript, parks again on another question, or drives the existing gated finalizer.
- **`gen-eval-loop-runner.ts`** — `genEvalLoopApplier`: `MutationApplier` for `gen-eval-loop` kind; validates payload, per-product concurrency cap of 1, autoApprove:false. Exports `runGenEvalLoop(opts)`: orchestration core (generator claude/sonnet, evaluator resolved distinct-from-provider) → createWorktree → loop rounds → evaluate merge contract → mergeBranch on pass. `LoopSpawners` interface allows test injection.
- **`scaffold-approval.ts`** — Shared scaffold-approval runtime: `runScaffoldApproval(session, deps?)` drives an APPROVED planning session → scaffolded project files (+ linked promotion). Called by BOTH `/approve` and the webview approve route. `defaultScaffoldApprovalDeps()` is a lazy FACTORY; every effect injected for the unit test.
- **`sandbox-runtime.ts`** — Runtime complement to `src/intent/sandbox.ts`: git worktree lifecycle (`createWorktree`/`destroyWorktree`/`cleanupOrphanWorktrees`); reads `policies/products.json` via `readProductsConfig`/`getProductConfig`; all git calls go through injectable `GitRunner` seam (`defaultRunGit` exported); types `ProductConfig` (includes optional `orchestratedMode?`) and `GitRunner`.
- **`credential-injector.ts`** — Spawn-time env map builder for sandboxed Regime B runs: `readCredentials(path)`, `getBaseEnv(allowlist)`, `buildSandboxEnv(sandbox, opts)`; `DEFAULT_BASE_ENV_KEYS`. **Invariant:** only the run's own product credentials reach the child, and Rune's own secrets (`TELEGRAM_BOT_TOKEN`, etc.) never reach the child.
- **`egress-policy.ts`** — Runtime egress enforcement wrapper: `checkEgress(sandbox, host, opts)` delegates to `isEgressAllowed` and writes denied attempts via `appendEgressDenialLog` to `logs/egress-denials.jsonl`. `EGRESS_ENFORCEMENT_MODE` (`documented-gap` advisory today; flips to `proxy-enforced` when the per-run proxy ships).
- **`sandbox-fs.ts`** — In-process fs-write wrappers enforcing sandbox write boundaries: `assertWritable` two-stage guard (lexical containment + symlink resolution for macOS /var/folders parity); `writeFileInSandbox`, `appendFileInSandbox`, `mkdirInSandbox`, `rmInSandbox`.
- **`lenny-sync.ts`** — Exports `runLibrarySync()` + `LibrarySyncResult`; pulls new Lenny posts/podcasts via lenny-sync agent, updates `logs/lenny-sync-state.json`.
- **`supervision-store.ts`** — Persistent JSON store for `SupervisedRun[]` state: `readAllRuns`, `writeAllRuns`, `upsertRun` (**field-merges** `{...current,...run}` by id — project 15 P0.1 — so a keep-alive heartbeat can't clear `quietNudgedAt`; clearing a field needs `writeAllRuns`), `removeRun`; atomic temp-then-rename writes; corrupt entries dropped at read time; backed by `logs/supervised-runs.json`.
- **`supervision-recovery.ts`** — Startup recovery: `recoverSupervisedRuns(filePath)` flips stale `running` → `unknown` (legacy fallback); `recoverAndFinalizeStaleRuns(deps)` (project 15 P0.4) is the pure core that drives each stale `running` run to a real terminal state via an injected `finalizeStaleRun`.
- **`work-run-finalizer.ts`** — Shared idempotent phase-recorded finalizer (project 15): `runFinalizer(input, effects)`. `hold` mode classifies → flush transcript → write summary/index → resolve worktree (branch left intact) → terminal supervision write; NEVER merges/pushes/deletes. `gated-merge` mode (live via `runGatedMerge`): classify → flush → summary → index → gate → merge → push → delete → terminal, with crash-resume via `readLastPhase()`. See `subsystems.md` → Gated-merge finalizer.
- **`worktree-sweep.ts`** — Worktree-scoped fallback reap (project 15 P2.7): `planWorktreeScopedReap` pure core selects pids whose cwd `isContainedIn` the worktree; `sweepWorktreeProcesses` SIGKILLs them — defense-in-depth for reparented grandchildren; injectable `SweepIO`; best-effort.
- **`recovery-finalize-runner.ts`** — Runtime glue (project 15 P0.4): `buildRecoveryFinalizeDeps(io?)` wires `recoverAndFinalizeStaleRuns` to config + real git/fs/stores; gated-merge crash-resume re-drives an interrupted push/branch-delete; `runRecoveryFinalize()` is the never-throws boot wrapper awaited in index.ts before the sweep.
- **`stall-check.ts`** — Pure stall-check core: `checkStalledRuns(deps)` returns newly-nudged-id set; `formatStallNudge`/`formatQuietNudge`/`formatParkedNudge`; `TICK_INTERVAL_MS` (30s), `STALL_THRESHOLD_MS` (5min), `QUIET_THRESHOLD_MS` (5min, on `lastOutputAt`).
- **`work-dispatch.ts`** — Work-run applier dispatch seam (project 14 Phase 5): `resolveWorkDispatch(input)` maps the `resolveDispatchMode` decision to a mutation kind (`ORCHESTRATED_WORK_KIND` or `LEGACY_WORK_KIND`); `readDispatchModeInput` reads the per-product `orchestratedMode` override from products.json; a fallback always carries a recorded reason.
- **`orchestrated-work-runner.ts`** — `orchestratedWorkApplier`: `MutationApplier` for `orchestrated-work` kind (autoApprove:true, project 14 Phase 5); creates a sandboxed worktree, drives `runProjectOrchestration` with real fs/git effects bound through `buildOrchestrationDeps`, maps the terminal `OrchestrationResult` to a single `MutationEvent` (finalized→completed, held→completed-flagged-held, blocked→failed). Shares per-project + global caps with work-run. `OrchestratedRuntimeDeps` injection seam. Orchestrated mode is OFF by default.
- **`team-task-deps.ts`** — Production `TeamTaskDeps` factory (project 14 Phase 8): `resolveTeamRoleModels` resolves the six product-team roles through `policies/model-policy.json` (reviewer resolved distinct-from coder.provider, fail-closed); `buildProductionTeamTaskDeps` binds all eight workflow seams; `createProductionTaskWorkflowRunner` is the `OrchestrationDeps.runTaskWorkflow` production binding.
- **`execution-agent.ts`** — Production artifact-role session runner (project 14 Phase 8): `runExecutionAgent(task, input, deps)` drives one coder/QA turn in a worktree-scoped CLI process; stage-then-diff capture; diff+errors scrubbed; returns structured `{ok:false}` on every failure path (never throws); injectable `{spawnAgent, runGit, buildEnv}` IO seam.
- **`stall-check-runner.ts`** — setInterval glue: `startStallCheck(bus)`/`stopStallCheck()`; every 30s tick runs `checkStalledRuns` then `planQuietNudges`, then project-15 P2.7 escalation passes (quiet→cancel, max-runtime ceiling) and the project-13 Phase 1b `planParkedNudges` pass. Per-run errors individually caught.
- **`planning-expiry.ts`** — Pure planning-session expiry core: `findExpiredPlanningSessions(deps)` returns chatIds whose `lastActivity` exceeds the TTL; `PLANNING_EXPIRY_TTL_MS` (7 days), `PLANNING_EXPIRY_TICK_INTERVAL_MS` (1 hour); fail-toward-cleanup.
- **`planning-expiry-runner.ts`** — setInterval glue: `startPlanningExpiry()`/`stopPlanningExpiry()`; reads live in-memory state via `getAllPlanningSessions`, deletes via `deletePlanningSession`; timer unref()'d.
- **`work-run-release.ts`**, **`recovery-finalize-runner.ts`** — (see above).
- **`nudges.ts`** — Weekly and review nudge stubs.
- **`__acceptance__/orchestrated-live.acceptance.ts`** — Project 14 Phase 8 LIVE acceptance harness (`npm run acceptance:orchestrated`): stub-free, zero-human-intervention proof that orchestrated `/work` does real work. See `subsystems.md` → Orchestrated work for the stage breakdown.

## `src/intent/`

- **`registry.ts`** — Product/project registry: `buildRegistry`, `readRegistry`/`writeRegistry`, `getAllProjects`; aggregating index (product → projects → lifecycle-status); persists to `logs/registry.json`.
- **`registration.ts`** — Product registration: `planRegistration`, `planReconciliation`, `applyRegistration`; propose-and-approve flow — planning is pure and never writes.
- **`overlay.ts`** — Product-overlay index: `buildOverlayManifest`, `scopedRetrieval`, `findStalePointers`; per-product pointer manifest into the type-organized vault.
- **`cockpit.ts`** — `buildCockpitView(registry, runStatus, taskProgress?, workRuns?, backlogCounts?, dispatchModes?)`: pure projection of registry + supervision run-status + optional task progress + work-run projections + backlog counts + dispatch modes into `CockpitView`. Null registry yields `available:false`. See `subsystems.md` for the full field catalog.
- **`journal-intent.ts`** — `planJournalIntent(input)`: deterministic journal-to-intent planner; routes into `IntentProposal` discriminated union (vault-intake / roadmap / register-product / disambiguation); pure.
- **`journal-intent-producer.ts`** — `scanJournalForIntent(content)` + `runJournalIntentProducer(...)`: scan → planJournalIntent → derive SHA-256 sourceNoteId → dedupe against existing queue; pure.
- **`journal-intent-consumer.ts`** — `actionApprovedIntentProposal(proposal, deps)`: dispatch core via injected `ConsumerDeps`; VALID_SLUG-guards the product; compile-time exhaustive switch.
- **`journal-intent-actions.ts`** — `realConsumerDeps`: vault-intake appends a journal-sourced bullet to `projects/<product>.md`; `appendRoadmap` and `registerProduct` throw "wire-up deferred".
- **`intent-proposal-queue.ts`** — Journal-to-intent proposal queue CRUD over `logs/intent-proposal-queue.json`.
- **`agent-def.ts`** — Model-agnostic agent definitions: `NeutralAgentDef`, `parseClaudeAgent`, `compileToClaude`, `compileToCodex`, `compileToGemini` (deferred stub). **Invariant:** `compileToCodex` names no model and sanitizes name against newline-injection.
- **`model-policy.ts`** — Model selection policy: `parsePolicy`, `loadModelPolicy`, `resolveModel`; deterministic resolver (pin → role-default → global-fallback); policy from `policies/model-policy.json`; cached per path.
- **`escalation.ts`** — Escalation policy: `parseEscalationPolicy`, `decide`, `decideFailClosed`; deterministic; **fail-closed** — a missing/malformed policy escalates.
- **`planner.ts`** — Planning state machine: PM-spec approval lifecycle — `startPlanning`/`proposeSpec`/`approvePlan`/`abandonPlan`/`isScaffoldReady`/`buildSetupWriterBrief`; the single human gate is approval of the PM spec.
- **`gen-eval-loop.ts`** — Generator-Evaluator loop (Layer 2): `recordRound` + `evaluateLoop` (bounded; pass → on-branch, N failed rounds → escalated).
- **`supervision.ts`** — Supervision (Layer 3): visibility surface — `isStalled`, `getVisibility`, `markCrashed`, `recoverRun`, `recordHeartbeat`. Two output fields (`lastOutputAt?`, `quietNudgedAt?`) + `isQuietRun`/`planQuietNudges`; project 13 Phase 1b `parkedNudgedAt?` + `isParkedRun`/`planParkedNudges`. `parkedQuestion?` carries durable `AskUserQuestion` metadata for question-parks. Parked predicates never fire on `running` runs.
- **`sandbox.ts`** — Sandboxing (Layer 4): `worktreePathFor` (slug-validated), `workBranchName` (deterministic branch name — moved here in project 13 Phase 1c so consumers like `work-run-release.ts` can import it without the Claude-CLI-spawn chain), `isWriteAllowed`, `isEgressAllowed` (exact-match allowlist), `canReachCredential`; exports `VALID_SLUG` and `isContainedIn(root, target)`.
- **`dispatch.ts`** — Multi-model dispatch (Layer 5): `DispatchTarget`, `DispatchProvider`, `DispatchHandoff`, `DispatchResult`, `DispatchLogEntry`, `buildHandoff`, `recordDispatch`. **Invariant:** handoff `context` must never carry vault personal content when target is `codex`.
- **`adjudication.ts`** — Cross-model adjudication: `ReviewMode`, `Adjudication`, `MergeOutcome`, `resolveReviewMode`, `isCrossModel`, `evaluateMergeContract` (fail-closed, ordered gates).
- **`scheduler.ts`** — Concurrency scheduler: `schedule(running, queue, globalCap)` — global cap + per-product cap of one, FIFO walk, queued projects never dropped.
- **`observation-*.ts`** — Observation loop (§16): `observation-loop.ts` (core, `LoopOutcome` discriminated union), `observation-sensor.ts` (sensor-layer composer; **invariant:** `detail` carries only structured metadata, never raw user content), `observation-synthesis.ts`, `observation-triage.ts`, `observation-dispatch.ts`, `observation-nightly.ts`. See `subsystems.md` → Observation loop.
- **`friction-detect.ts`** — `FrictionSignal`/`AggregatedFriction`; `aggregateFrictions(raw)` dedupe-by-id with occurrence count.
- **`product-routing.ts`** — Product routing for captured ideas/bugs (project 16 R3): `resolveProductTarget(candidate, loadKnownProducts)` — exact (never fuzzy) match, unresolved → reserved `INBOX_PRODUCT` (`inbox`) fallback with typed reason; never throws.
- **`backlog-id.ts`** — `computeBacklogId`, `normalizeBacklogRaw`, `BacklogKind` — pure.
- **`backlog-parser.ts`** — Strict pure parser for `docs/projects/{bugs,ideas}.md`: `parseBugs`, `parseIdeas` → `{ items, fileWarnings }`.
- **`backlog-reader.ts`** — Filesystem + security layer: `readBacklogs(...)` realpaths each repoPath + requires it under `$WORKSPACE_ROOT`, rejects symlink escapes, fd-based size-capped reads; `computeBacklogCounts`.
- **`backlog-append.ts`** — Pure append core for the drawer `+` add: `appendBug`/`appendIdea` → `{ ok, content }` | error.
- **`backlog-write-lock.ts`** — Backlog safe-write substrate: `withFileLock(key, fn)` per-key async mutex, `writeFileAtomic`, `assertBacklogWriteAllowed`, `appendBacklogMutationLog`.
- **`scaffold-target.ts`** — `resolveScaffoldTarget(product, registry, productsConfig)` → resolves a product's repoPath so project-setup-writer scaffolds into the TARGET product's repo; `scaffoldWriteScope(repoPath)`. Pure.
- **`scaffold-result.ts`** — `parseScaffoldResult(message)` + `crossCheckScaffold(parsed, newProjectDirs)` → `ScaffoldCheck`. Pure.
- **`planning-roles.ts`** — Downstream planning orchestration: `runDownstreamPlan(approvedSpec, deps)` turns the approved PM spec into tech-spec/tasks/test-plan/context through tech-lead breakdown, PM review match, Claude critique, Codex critique, and context seed; warnings/progress are streamed and no tech-spec/tasks approval gate is added.
- **`planning-critique.ts`** — Planning critique pass core (project 14 Phase 9): pure `runPlanningCritique(plan, deps)` — Rune-owned NEUTRAL cross-model hardening step; SEQUENTIAL (Claude then Codex compounds); fail-closed.
- **`planning-roles-wiring.ts`** — Thin production bridge: `buildPmRolePrompt`/`buildTechLeadRolePrompt`, `extractFencedJson`, `buildProductionCritiquePlan`, `parseCritiqueReply`, `defaultPlanningRoleDeps()`.
- **`project-context.ts`** — context.md section schema + planning-time seed: `CONTEXT_SECTIONS` (five required sections), `seedProjectContext`, `hasRequiredSections`, `escapeRegExp`. context.md is Rune-owned orchestration state, not role memory.
- **`context-curator.ts`** — Rune-owned context.md post-task updater (project 14 Phase 3): `applyContextUpdate(current, update)`; ordered gates; roles emit handoff notes threaded into Next Task Handoff. **The ONLY writer of context.md.** Pure.
- **`orch-task-select.ts`** — `selectNextTask(tasksMd)` returns first unchecked `- [ ]` with a TEXT-STABLE id via `computeTaskId`. Pure.
- **`orch-closeout.ts`** — `markSelectedTaskComplete(tasksMd, task)` ticks exactly the selected checkbox; refuses stale/ambiguous. Pure.
- **`orch-reconstruct.ts`** — `reconstructRun({tasksMd, records})` rebuilds partial run state from durable records; flags drift. Pure.
- **`orch-context-assembly.ts`** — `assembleTaskContext(input)` builds the fresh-context handoff bounded to `TASK_HANDOFF_MAX_CHARS` (24000). Pure.
- **`orch-run-record.ts`** — `TaskRunRecord` type + `buildTaskRunRecord`. Pure.
- **`orch-attempt-cap.ts`** — `decideAttemptOutcome(input)` → `AttemptAction`; precedence: open objection → blocked-on-human; success → proceed; below cap → retry; at cap → pm-wrapup. Pure.
- **`finalizer-handoff.ts`** — `FinalizerHandoff` payload + `buildFinalizerHandoff` + `runFinalizerHandoff(handoff, adapter)`; finalized → outcome, unavailable → held (no self-merge). Pure dispatch.
- **`orch-config.ts`** — `resolveDispatchMode(input)` → orchestrated | legacy with a `fallbackReason` on every legacy path. Pure.
- **`promotions.ts`** — Durable promotion job (09-expand-cockpit Phase 4): drives a backlog item through planning-started → scaffolded → marked-source | planning-abandoned | scaffold-error | mark-source-error. Pure state machine + append-only JSONL persistence at `config.PROMOTIONS_FILE`. **`appendPromotion` THROWS on disk failure** — this log is the restart-replay source of truth, not best-effort. `loadPromotions`/`resumablePromotions` for restart re-drive. **Invariant:** `snapshotRaw`/`errors` carry personal/agent text — never forward to client surfaces.
- **`backlog-mark-done.ts`** — `markBacklogItemDone(content, kind, snapshotRaw, slug)` → `MarkDoneResult`; matches by SNAPSHOT text (stable across edits); idempotent on retry; CRLF-tolerant; preserves every other byte. Pure.
- **`team-task-workflow.ts`** — Team-task workflow (project 14 Phase 4): pure orchestration over injected role seams (`TeamTaskDeps`). `runTeamTaskWorkflow(task, input, deps)` runs one task through role gates (reviewer-independence → QA-first → tech-lead test review → bounded coder→reviewer loop → objection gate → tech-lead diff review → designer IFF needed → PM wrap-up → `TaskEvidence`). Never writes tasks.md/context.md/merges — Rune owns closeout.
- **`project-orchestrator.ts`** — Multi-task project orchestrator loop (project 14 Phase 5): pure over injected `OrchestrationDeps` — `runProjectOrchestration(deps)` drives tasks to completion; never self-merges; `maxIterations` bound. See `subsystems.md` → Orchestrated work.
- **`feedback-record.ts`** — Feedback-record schema + validator (project 14 Phase 6): `FeedbackRecord`, `RoleStage`/`ROLE_STAGES`, `parseFeedbackRecord(raw)` → `FeedbackValidation` (fail-closed, durable skip reason; trust-boundary length caps). Pure.
- **`feedback-reader.ts`** — Production feedback reader: `readFeedbackRecords`, `feedbackRecordId` (SHA-256 content-hash), `readProcessedFeedbackIds`/`writeProcessedFeedbackIds` (JSON Set, atomic write).
- **`learning-loop.ts`** — Learning-loop composer (project 14 Phase 6): `runLearningLoop(deps)` pure orchestration over injected `{readFeedback, attribute, writeLesson}`; routes lesson/no-lesson attribution.
- **`postmortem.ts`** — Rune-owned post-mortem (project 14 Phase 6): `buildPostMortemPrompt`, `parsePostMortemResult` (fenced `postmortem` JSON; role/stage validated), `runPostMortem` (fails SAFE to no-lesson — never fabricates a lesson).

## `src/mcp/`

- **`daemon.ts`** — Standalone MCP daemon entrypoint (`npm run mcp:start`): starts a minimal HTTP server on `RUNE_MCP_HOST:RUNE_MCP_PORT` with daemon `/health`, OAuth metadata/register/authorize/token routes, and Streamable HTTP MCP at `/mcp`; does not boot Telegram, cockpit/webview routes, Whoop OAuth, scheduler, or watchers. Exports `startMcpDaemon(opts)` for lifecycle tests.
- **`server.ts`** — Shared MCP server factory (project 16): `createRuneMcpServer({tools, name?})` builds an independent `McpServer` per call from a `TOOL_REGISTRY`. Exports `APP_SURFACE_TOOLS` (six Claude-App tools: kb_query, vault_search, log_idea, crm_lookup, get_priorities, log_conversation) + `ADMIN_TOOLS` (`kb_query`, `kb_search`, `repo_search`, `kb_ingest`, `kb_stats`, `kb_lint`; admin-only) + content tools (`journal_range`, `follow_wikilinks`, `tag_date_query`) + utility tools (`refresh_vault_index`, `mcp_metrics_snapshot`) + `ToolName`. `createKBServer() = factory(ADMIN_TOOLS)`.
- **`metrics.ts`** — In-memory MCP call metrics: wraps tool handlers with call/error/timeout counters and bounded per-tool latency windows; `mcp_metrics_snapshot` reads this process-local state, so metrics reset on daemon restart.
- **`tools/`** — Per-tool handler modules, deps-injected. `types.ts` (shared `McpTextResult` + helpers, config-free), `sanitize.ts` (`sanitizeMcpError = redactSecrets∘scrubAbsolutePaths`), `log-idea.ts` (PURE), `log-conversation.ts` (PURE), `read-tools.ts` (PURE `vaultSearch`/`crmLookup`/`getPriorities`), `journal-range.ts` (inclusive journal date-range JSON, 31-day cap, cold fallback only while the index is warming), `follow-wikilinks.ts` (warm-index-only Obsidian link traversal, depth/result caps), `tag-date-query.ts` (warm-index tag/date filtering, 50-result cap), `vault-index-tools.ts` (`refresh_vault_index` status wrapper), `*-deps.ts` (production bindings — pull config, loaded only via dynamic import inside each handler).
- **`index.ts`** — Standalone stdio entry point for Claude Code; calls `initKB()` before `createKBServer()`.

## `src/study/`

- **`sr-state.ts`** — Spaced-repetition state engine: read/write `study/spaced-repetition.json`, interval-ladder transitions.
- **`sr-pool.ts`** — SR pool source: `readPool()` reads `study/sr-seed.json`.
- **`sr-select.ts`** — `selectDueConcepts()` — due concepts, most-overdue first, capped at N.
- **`sr-session.ts`** — SR session orchestrator: `runSRSession()`/`handleSRMessage()` — event-driven question→grade→advance loop.

## `src/integrations/`

- **`telegram/client.ts`** — Message chunking, typing indicators.
- **`whoop/types.ts`** — Whoop API response types and daily data format.
- **`whoop/keychain.ts`** — macOS Keychain token storage via `security` CLI.
- **`whoop/client.ts`** — OAuth2 token management + Whoop API calls.
- **`readwise/client.ts`** — Save articles to Readwise Reader API.

## `src/workspace/` & `src/vault/`

- **`workspace/files.ts`** — Read/write/append/list workspace files (`assertWithinWorkspace`-guarded); mirrors `vault/files.ts` but rooted at `WORKSPACE_DIR ?? PROJECT_ROOT`.
- **`vault/files.ts`** — Read/write/append/list vault markdown files (`assertWithinVault`-guarded).
- **`vault/journal.ts`** — Journal file creation, append, `writeMorningPrep`; also `saveConversationSource` (KB raw-source conversation writer); re-exports `parseTag` from journal-parse.ts.
- **`vault/journal-parse.ts`** — Pure CONFIG-FREE journal parsing: `parseTag` (extracted so pure modules like read-tools MCP handlers can reuse it without config.ts's env requirements).
- **`vault/learnings.ts`** — `/learn`-authored JSONL store + prompt-prepend builder for `runAgent`.
- **`vault/git.ts`** — git add/commit/push helpers; `gitCommitAndPush` (best-effort) and `gitCommitAndPushOrThrow` (strict — throws on not-on-main/commit/push failure; `nothing-to-commit` benign) share one core. **On-`main` branch guard at the single chokepoint.**
- **`vault/sessions.ts`** — TG session Map with JSON persistence + crash recovery.
- **`vault/equipment.ts`** — `readEquipment()` parses `health/equipment.md` into `{home, gym}` raw blocks.
- **`vault/whoop-recent.ts`** — `readRecentWhoopDays(n)` returns last n parsed `WhoopDailyData`.
- **`vault/watcher.ts`** — FSWatcher for Readwise article detection, TG notify + enqueue.
- **`vault/voice.ts`** — `buildVoicePromptSection()` re-reads `writing/voice.md` on every call (no cache); truncated at `VOICE_PROMPT_CHAR_BUDGET` (8000 chars).

## `src/writer/` & `src/roles/`

- **`writer/memory.ts`** — Writer-role memory loader (project 12): `composeWriterContext(baseInstructions)` reads SOUL.md (system-prompt authority) + memory.md (budget-trimmed, low-authority reference) from `PROJECT_ROOT/agents/writer/`; SOUL prepended on the system channel; memory rides the first user turn inside a `<writer-memory>` fence; `WRITER_MEMORY_CHAR_BUDGET` (14000).
- **`writer/seed.ts`** — Seed-mining contract (project 12): pure helpers for the one-time memory.md baseline mine.
- **`writer/sentinel.ts`** — Writer completion sentinel (project 12 Phase 2): `WRITER_COMPLETION_SENTINEL` `[[WRITER_MEMORY_COMPLETE]]` + `detectCompletionSentinel(text)`; only a FINAL-line sentinel counts.
- **`writer/capture.ts`** — TS-owned lesson capture (project 12 Phase 2): `parseCandidateBlock`, `isLessonPrivacySafe` (rejects private names / links / URLs / email / phone / long quotes), async `captureLessons` (feedback gate → privacy filter → dedupe → provenance-stamp → append → one atomic commit). Injection seams.
- **`writer/commit.ts`** — Memory-scoped commit helper (project 12 Phase 2): `commitWriterMemory({cwd?, message})` refuses to commit off `main`, pathspec-stages + commits ONLY `agents/writer/memory.md`; no push.
- **`roles/loader.ts`** — Product-team role loader (project 14 Phase 1): generalizes the writer loader to six fixed roles — `RoleName` (`pm`/`tech-lead`/`qa`/`coder`/`reviewer`/`designer`), `ROLES_ROOT` (=`<repo>/agents`), `composeRoleContext(role, baseInstructions, opts?)`; same two-channel authority boundary as writer/memory.ts.
- **`roles/memory-writer.ts`** — Role-memory lesson writer (project 14 Phase 6): `writeRoleLesson(input)` — privacy-filter → dedup → provenance-stamp → append → `commitRoleMemory`; serialized per-role via a `writeChains` Map.
- **`roles/commit.ts`** — Role-memory-scoped commit helper (project 14 Phase 6): `commitRoleMemory({role, message, cwd?})` stages ONLY `agents/<role>/memory.md`; refuses to commit off main; no push.

## `src/utils/`

- **`time.ts`** — America/Chicago timezone helpers (`getTodayFilename`, `getYesterdayFilename`, `getTimestamp`, `getDayOfWeek`, `getRecentFilenames`, etc.).
- **`logger.ts`** — Structured JSON logging with component tags.
- **`sanitize-paths.ts`** — `scrubAbsolutePaths(raw)`: replace `VAULT_DIR`/`PROJECT_ROOT`/`WORKSPACE_DIR` with `<vault>`/`<project>`/`<workspace>` placeholders before surfacing a message to a user (chat reply, HTTP error body). Reads config at call-time.
- **`intent-log.ts`** — Ask-Twice telemetry: `appendIntent` → `logs/intent-log.jsonl`.
- **`observation-log.ts`** — Observation loop interaction writer: `appendInteraction` → `logs/observation-interactions.jsonl`. **Invariant:** `detail` carries only structured metadata, never raw user content.
- **`markdown.ts`** — Markdown parsing utilities (future).

## `cli/`, `scripts/`, `policies/`

- **`cli/rune.ts`** — CLI entry point for local interactive use.
- **`scripts/run-evals.ts`** (+ `.test.ts`) — Dev tool: parse eval YAMLs, invoke agents via `runAgent()`, report pass/fail.
- **`scripts/register-ts.mjs`** (+ `.test.ts`) — Local Node runtime TypeScript loader using `module.registerHooks()`: resolves repo-local `.js` ESM imports to sibling `.ts`/`.tsx`/`.mts`/`.cts` files and transforms TypeScript through `esbuild` for app/script entrypoints.
- **`scripts/run-intent-scan.ts`** — CLI entry point for intent-scan job (`npm run intent-scan`).
- **`scripts/library-backfill.ts`** — CLI entry point for bulk library-to-KB backfill (`npm run library-backfill`).
- **`policies/model-policy.json`** — Declarative model registry + routing rules (aliases, providers, role-defaults, global-fallback). Committed config. Carries fable (anthropic/claude) and gpt-5.5 (openai/codex) with product-team roleDefaults: judgment roles → fable; artifact roles → gpt-5.5.
- **`policies/escalation-policy.json`** — Declarative escalation rules; the decision module fails closed on a missing/malformed file.
- **`policies/products.json`** — Per-product config: repo path, base branch, credentials file, egress allowlist, optional `orchestratedMode` boolean; read by `sandbox-runtime.ts`; exposed via `config.PRODUCTS_CONFIG_FILE`.
