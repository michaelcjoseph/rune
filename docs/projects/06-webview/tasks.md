# Webview — Tasks

Not started. See [spec.md](spec.md) for details.

## Phase A — Transport abstraction + notification bus

> Server-side refactor only. No user-visible change. Independently shippable.

- [x] Create `src/transport/sender.ts`: `MessageSender` interface (`send`, `startTyping`, `stopTyping`), `SendOpts` type with optional `approval` sidecar, `createSenders(bot, bus)` factory.
- [x] Create `src/transport/notification-bus.ts`: typed wrapper over Node `EventEmitter` with `publish(event)` / `on(kind, handler)`.
- [x] Create `src/transport/telegram-sender.ts`: implements `MessageSender`; delegates `send` to `sendLongMessage(bot, …)` from `src/integrations/telegram/client.ts`; ignores `opts.approval`.
- [x] Create `src/transport/webview-sender.ts`: implements `MessageSender`; maintains `Map<userId, Set<WebSocket>>`; serializes outbound frames as `{ kind: 'message', text, approval? }` JSON; no-ops when no connection registered. (Phase A: register/unregister no-ops; Phase B wires real connections.)
- [x] Vitest: `src/transport/notification-bus.test.ts` — fan-out to multiple subscribers; one failing subscriber doesn't block the others.
- [x] Vitest: `src/transport/telegram-sender.test.ts` — chunking and newline-preferring splits match `sendLongMessage` parity for representative inputs (short, exactly 4096, multi-paragraph, no newlines).
- [ ] Modify `src/index.ts`: instantiate `bus`; create senders; pass them into the scheduler and bot init.
- [ ] Modify `src/jobs/scheduler.ts`: signature change — accept `{ bus, senders }` instead of `bot`. Cron job functions receive the bus.
- [ ] Refactor cron jobs to publish to bus instead of calling `bot.sendMessage`:
  - [ ] `src/jobs/morning-prep.ts`
  - [ ] `src/jobs/nightly.ts`
  - [ ] `src/jobs/whoop-sync.ts`
  - [ ] `src/jobs/nudges.ts`
  - [ ] `src/vault/watcher.ts`
  - [ ] `src/jobs/intent-scan.ts`
- [ ] Refactor handler / command / review callsites to use `senders.tg` instead of `bot.sendMessage`:
  - [ ] `src/bot/handlers/text.ts`
  - [ ] `src/bot/handlers/url.ts`
  - [ ] `src/bot/handlers/photo.ts`
  - [ ] `src/bot/commands/*.ts` (sweep all 25 files)
  - [ ] `src/reviews/orchestrator.ts`
  - [ ] `src/reviews/interview.ts`
  - [ ] `src/reviews/{daily,weekly,monthly,quarterly,yearly,think,health,blog}.ts`
- [ ] Refactor typing-indicator usage: replace inline `startTyping(bot, chatId)` with `senders.startTyping(chatId)` (sender chooses how to render).
- [ ] Update existing handler tests to inject a fake `MessageSender` instead of stubbing `bot.sendMessage`.
- [ ] Smoke test: run `npm run dev`, exchange a TG message, run morning-prep manually (`/prep`), confirm chunking and content unchanged.
- [ ] Update `CLAUDE.md` Project Structure section: add `src/transport/` row.

## Phase B — Webview chat surface

> Depends on: Phase A.

- [ ] Create `src/server/auth.ts`: `verifyAuth(req): { ok: true; userId } | { ok: false }`. Reads `jarvis-auth` cookie or `Authorization: Bearer …` header. Validates against `JARVIS_HTTP_SECRET`.
- [ ] Create `src/server/webview.ts`: `mountWebviewRoutes(server, bus, senders, deps)`. Wires:
  - `GET /` → serve `index.html` with server-rendered `<meta name="obsidian-vault" content="…">`.
  - `GET /static/*` → serve `src/server/static/*` with path-traversal guard.
  - `POST /api/chat` → auth check → dispatch via `webview-bootstrap.ts` → JSON `{ text, sessionId, model }`.
  - `WS /api/ws` upgrade → auth check → register on `WebviewSender`. On `message` frame → dispatch. On `close` → unregister.
  - `GET /api/state` → 503 if not ready, else 200 with `getStateSnapshot()` (Phase C wires this fully; Phase B returns a stub).
  - 401 on missing/invalid auth; 403 on Host header not in `JARVIS_ALLOWED_HOSTS` (port stripped before comparison).
- [ ] Modify `src/config.ts`: add `JARVIS_ALLOWED_HOSTS` env var. Parsed at startup (split on `,`, trim + lower-case each entry) into a `Set<string>` exported alongside the rest of the config; default `localhost,127.0.0.1`.
- [ ] Wire `JARVIS_ALLOWED_HOSTS` into the Host-guard in `src/server/webview.ts` (requirement 14). The guard runs before auth so a misrouted request never advances to the secret-comparison codepath.
- [ ] In the `POST /api/auth-bootstrap` handler (cookie-set path): set `Secure` on the `jarvis-auth` cookie iff `req.headers['x-forwarded-proto'] === 'https'` AND `req.socket.remoteAddress` is `127.0.0.1` / `::1`. Always set `HttpOnly` and `SameSite=Strict`. (Requirement 63.)
- [ ] Create `src/server/webview-bootstrap.ts`: extracted dispatch entrypoint that mirrors `handleTextMessage` but takes a plain `{ userId, text }` instead of a TG `Message`. Handles slash-command branch, review-active branch, resolver branch, freeform branch.
- [ ] Modify `src/server/http.ts`: call `mountWebviewRoutes(...)` after the existing `/health`, `/capture-sessions`, `/oauth/whoop` routes.
- [ ] Wire `src/transport/webview-sender.ts` for real: `register(userId, ws)`, `unregister(userId, ws)`, per-user fan-out on bus events.
- [ ] Modify `src/config.ts`: add `OBSIDIAN_VAULT_NAME` (default = basename of `VAULT_DIR`).
- [ ] Create `src/server/static/index.html`:
  - Auth bootstrap script: read `?token=…` from URL, POST to `/api/auth-bootstrap`, set cookie, redirect to `/`.
  - Server-rendered `<meta name="obsidian-vault" content="…">`.
  - CDN deps: `markdown-it`, `highlight.js` + a default theme CSS.
  - Loads `app.js` and `app.css`.
- [ ] Create `src/server/static/app.js`:
  - WS connect with reconnect-with-backoff (2s, 4s, 8s, max 30s).
  - Textarea: Enter = newline; Cmd+Enter (Mac) / Ctrl+Enter (Linux/Win) = send.
  - In-memory ring buffer (last 20 user messages); Up-arrow on empty input → recall, Down-arrow → cycle forward.
  - Markdown render via `markdown-it`. Post-render pass:
    - `[[Note Title]]` → `<a href="obsidian://open?vault=…&file=…">Note Title</a>`.
    - `<pre><code>` blocks → `highlight.js` invocation.
  - Streaming chunk renderer: open a "tail" node, append text on each chunk frame, re-render the tail node's markdown each tick.
  - Auto-scroll with user-override detection (suspended if user scrolls up; resumed at bottom).
  - Model dropdown: bound to `/opus` / `/sonnet` / `/haiku` — selecting an option sends the slash command as the next message.
- [ ] Create `src/server/static/app.css`: minimal dark theme. Sidebar layout placeholder (Phase C fills it).
- [ ] Add `POST /api/auth-bootstrap` route: validates `?token=` body, sets `jarvis-auth` cookie (HttpOnly, SameSite=Strict).
- [ ] Vitest: `src/server/auth.test.ts` — 401 missing, 401 wrong, 200 cookie, 200 bearer, 403 non-localhost.
- [ ] Vitest: `src/server/webview.test.ts` — integration: stub Claude CLI, POST `/api/chat`, assert response shape; open WS, send a message frame, assert outbound chunks.
- [ ] Manual smoke: `npm run dev` → browser to `http://127.0.0.1:3847/?token=$JARVIS_HTTP_SECRET` → exchange a message → verify rendering and wikilink click opens Obsidian.
- [ ] Update `CLAUDE.md`:
  - **Architecture** section: mention webview as second transport sharing session via `TELEGRAM_USER_ID`.
  - **HTTP server** section: list new endpoints.
  - **Project Structure** section: add `src/server/static/`, `src/server/webview.ts`, `src/server/auth.ts`, `src/server/webview-bootstrap.ts`.
  - **Environment Variables** section: document `OBSIDIAN_VAULT_NAME` and `JARVIS_ALLOWED_HOSTS`.

### Phase B.5 — Tailscale Serve deployment for headless Mac mini

> Optional within Phase B; required before laptop access from a headless Mac mini. Acceptance: every step in the spec's **Deployment** subsection executes cleanly and the test-plan's "Remote access" tests pass.

- [ ] On the Mac mini: install Tailscale (`brew install --cask tailscale`), sign in, run `tailscale serve --bg --https=443 http://127.0.0.1:3847`, capture the published origin from `tailscale serve status`.
- [ ] Set `JARVIS_ALLOWED_HOSTS` in `.env.local` to include the actual MagicDNS hostname.
- [ ] On the laptop: install Tailscale, sign in to the same tailnet, browse `https://<host>.tail-xxxx.ts.net/?token=$JARVIS_HTTP_SECRET`, confirm the page exchanges the token for a `Secure; HttpOnly; SameSite=Strict` cookie.
- [ ] Run the "Remote access (Tailscale Serve)" tests in `test-plan.md` end-to-end and check off each item there.

## Phase C — Cockpit sidebar

> Depends on: Phase B.

- [ ] Create `src/server/state-snapshot.ts`: `getStateSnapshot({ sessions, reviewSessions, queue, …})` returns:
  ```typescript
  {
    version: 1,
    ready: boolean,
    activeSession: { sessionId, model, messageCount } | null,
    activeReview: { type, phase, targetDate } | null,
    ingestionQueueDepth: number,
    recentAgentRuns: Array<{ agent, startedAt, durationMs, status }>,
    pendingApprovals: { playbook: number, proposal: number },
    lastMorningPrepAt: string | null,
    lastNightlyAt: string | null,
    warnings: string[]
  }
  ```
- [ ] Recent-runs source: append to `logs/agent-runs.jsonl` from `src/ai/claude.ts` `runAgent` (light-touch instrumentation in Phase C; Phase D adds live events).
- [ ] Vitest: `src/server/state-snapshot.test.ts` — fixture queue files, fixture sessions; assert snapshot shape and warnings on malformed inputs.
- [ ] Modify `src/server/webview.ts`: wire `GET /api/state` to `getStateSnapshot`; 503 with `{ ready: false, reason }` if bot not yet started.
- [ ] Modify `src/server/static/app.js`: poll `GET /api/state` every 5s; render five panels (Active Session, Ingestion Queue, Recent Agent Runs, Pending Approvals, Last Runs); diff-render to avoid flicker.
- [ ] Modify `src/server/static/app.css`: ~280px right rail, scrollable.
- [ ] Manual smoke: enqueue a fake playbook draft via `appendVaultFile('logs/playbook-queue.json', …)` (or wait for nightly); confirm sidebar count ticks up within 5s.
- [ ] Update `CLAUDE.md` Project Structure: add `src/server/state-snapshot.ts`; mention `logs/agent-runs.jsonl`.

## Phase D — Approval buttons + live agent-run events

> Depends on: Phase C.

- [ ] Modify `src/reviews/interview.ts`: at approval points (outline approval, dynamic-section approvals), call `sender.send(userId, prompt, { approval: { prompt, options } })`. Keep typed-text fallback as a universal path.
- [ ] Modify `src/reviews/orchestrator.ts`: same pattern wherever orchestrator-level approvals exist.
- [ ] Modify `src/transport/webview-sender.ts`: serialize `approval` sidecar into the outbound WS frame.
- [ ] Modify `src/transport/telegram-sender.ts`: ignore `approval` (text fallback unchanged).
- [ ] Modify `src/ai/claude.ts`: instrument `runAgent`. Emit `bus.publish({ kind: 'agent-event', subKind: 'start', agent, runId, userId, startedAt })` on entry; `agent-event` `subKind: 'end'` on exit with `durationMs` and `status`. Include `userId: TELEGRAM_USER_ID` for nightly batch runs.
- [ ] Modify `src/transport/webview-sender.ts`: forward `agent-event` bus messages to connected WS as `{ kind: 'agent-event', … }` frames.
- [ ] Modify `src/server/static/app.js`:
  - Render approval-bearing message frames as a button row below the message; click sends `{ kind: 'message', text: <option.value> }`.
  - Subscribe to `agent-event` frames; render a "running now" panel above the recent-runs list with agent name + live elapsed timer; remove from "running now" and prepend to recent-runs on `subKind: 'end'`.
- [ ] Vitest: `src/reviews/interview.test.ts` — assert approval emission shape on outline approval.
- [ ] Vitest: `src/transport/webview-sender.test.ts` — `approval` sidecar round-trips on the wire; `agent-event` frames forward.
- [ ] Manual smoke: run `/weekly` from the webview; click the outline-approval button; watch the writeup phase advance. Run `/think`, watch the agent show in "running now" while it works.
- [ ] (Optional) Add `surface: 'tg' | 'webview'` to `appendIntent()` calls so resolver telemetry distinguishes adoption per surface.
- [ ] Update `CLAUDE.md` § **Review → post-agent flow**: note the structured approval-signal channel; webview renders buttons, TG renders prose.

## Phase E — Mutation pipeline + project dashboard + `/work --auto` runner

> Depends on: Phase C (snapshot infrastructure) and Phase D (bus event fan-out plumbing).

### Mutation pipeline (framework)

- [ ] Create `src/transport/mutations.ts`: `MutationKind` union (`'work-run' | 'project-edit' | 'proposal-action' | 'agent-edit' | 'cron-toggle'`); `MutationStatus`, `MutationDescriptor<P>`, `MutationEvent`, `MutationApplier<P>`, `ApplyContext` types; `registerApplier`, `getApplier`, `createMutation`, `cancelMutation` functions; in-memory `Map<id, RunHandle>` for active runs.
- [ ] Create `src/jobs/mutations-log.ts`: append-only `logs/mutations.jsonl` reader/writer. `appendMutationLine`, `readRecentMutations(n)`, `reconcileOrphans()` (flip stale `running` → `failed` with `reason: 'orphaned'`).
- [ ] Modify `src/transport/notification-bus.ts`: extend the event union to include `'mutation-event'` alongside existing `'message'` and `'agent-event'`.
- [ ] Modify `src/transport/webview-sender.ts`: forward `'mutation-event'` bus messages to connected WS as `{ kind: 'mutation-event', mutationId, subKind, ts, data }` frames; drop silently when no WS registered.
- [ ] Modify `src/transport/telegram-sender.ts`: on `'mutation-event'` with `subKind: 'completed'` or `'failed'`, send a one-line summary; ignore `output` / `progress` / `log` to avoid TG floods.
- [ ] Modify `src/index.ts`: register `workRunApplier` at boot; call `reconcileOrphans()` before the bot starts polling.
- [ ] Vitest: `src/transport/mutations.test.ts` — descriptor lifecycle (`pending` → `running` → `completed`), unknown-kind rejection, applier validation failures, cancellation flips status with `reason: 'cancelled'`.
- [ ] Vitest: `src/jobs/mutations-log.test.ts` — append, read recent, skip corrupt line with warning, `reconcileOrphans` rewrites stale `running` rows.

### `/work --auto` runner

- [ ] Create `src/jobs/work-runner.ts`: exports `workRunApplier: MutationApplier<{ projectSlug: string }>`. Implements `validate` (project dir exists, `spec.md` present, no other run for slug, under global cap) and `apply` (spawns `claude --add-dir docs/projects/<slug>/ -p '<spec + tasks + /work --auto>'` from `PROJECT_ROOT`).
- [ ] Reuse `activeProcesses` and `waitForActiveProcesses` from `src/ai/claude.ts` for graceful shutdown (no signature changes needed).
- [ ] Implement stdout line-buffering: each newline-delimited chunk yields a `MutationEvent { kind: 'output', data: { line } }`; stderr yields `{ kind: 'log', data: { line, stream: 'stderr' } }`.
- [ ] Implement exit handling: code 0 → `completed`; non-zero → `failed`; SIGTERM → `failed` with `reason: 'cancelled'` if `cancelMutation` was called, else `'killed'`.
- [ ] Modify `src/config.ts`: add `WORK_RUN_PER_PROJECT_CAP` (default 1) and `WORK_RUN_GLOBAL_CAP` (default 2).
- [ ] Vitest: `src/jobs/work-runner.test.ts` — stubbed `spawn`: assert spawn args include `--add-dir` and `cwd: PROJECT_ROOT`; stdout chunks become `output` events; exit 0 → `completed`; exit non-zero → `failed`; second concurrent run for same slug rejected by `validate`.

### API endpoints

- [ ] Modify `src/server/webview.ts`: add `POST /api/mutations` (auth → resolve applier → validate → create descriptor → start apply when `autoApprove` → 200 with descriptor).
- [ ] Modify `src/server/webview.ts`: add `GET /api/mutations` (returns `{ active, recent }` from in-memory map + JSONL).
- [ ] Modify `src/server/webview.ts`: add `POST /api/mutations/:id/cancel` (SIGTERM via in-memory `RunHandle`; 409 if mutation is already terminal).
- [ ] Vitest: extend `src/server/webview.test.ts` — `POST /api/mutations` happy path; invalid `kind` → 400; unauthorized → 401; cancellation SIGTERMs within 5s in integration smoke; `GET /api/mutations` shape.

### Project dashboard / state snapshot extension

- [ ] Create `src/server/projects-snapshot.ts`: `getProjectSummaries()` parses `docs/projects/index.md` (status + slug from table) and each `docs/projects/<slug>/tasks.md` (count `- [ ]` + `- [x]`, group by `## Phase …` headers). Returns `ProjectSummary[]` with `{ slug, status, progress: { done, total, perPhase? }, specPath, lastModified }`.
- [ ] Modify `src/server/state-snapshot.ts`: add `projects: getProjectSummaries()` and `mutations: { active, recent: readRecentMutations(50) }` to the snapshot. Include per-project warnings in the snapshot's `warnings` field on parse failure.
- [ ] Vitest: `src/server/projects-snapshot.test.ts` — fixture `index.md` + per-project `tasks.md`: progress matches manual count, missing `tasks.md` produces `—`, malformed table cell handled cleanly.

### Webview UI

- [ ] Modify `src/server/static/app.js`: add Projects cockpit panel (row per project: slug + status pill + progress bar + spec link + "Run /work --auto" button); disable button when a `work-run` is `running` for that slug.
- [ ] Modify `src/server/static/app.js`: add Mutations cockpit panel — Active (live elapsed timer + tail of last `output` line) and Recent (last 5 terminal entries).
- [ ] Modify `src/server/static/app.js`: implement run-detail drawer that opens on click of an active or recent mutation row; subscribes to `mutation-event` frames matching its `mutationId`; reuses the chunk renderer from Phase D.
- [ ] Modify `src/server/static/app.js`: implement confirmation modal triggered by "Run /work --auto" button click ("Run /work --auto on `<slug>`? Edits + commits without further confirmation. [Run] [Cancel]"); only `Run` POSTs to `/api/mutations`.
- [ ] Modify `src/server/static/app.css`: drawer slide-in transition; modal overlay; progress bar; status pill colors (Done = green, Spec = grey, In Progress = blue, Failed = red).

### Smoke + docs

- [ ] Manual smoke: create a throwaway `docs/projects/99-sandbox/` with a trivial `spec.md` and `tasks.md` (e.g., "create `hello.txt`"); click "Run /work --auto"; confirm modal; watch streaming output in the drawer; on completion, verify `hello.txt` exists on a `work/99-sandbox-<ts>` branch and the row's progress reflects ticked checkboxes.
- [ ] Manual smoke: kick off a long-running `work-run`, click Cancel; verify SIGTERM lands within 5s and the status flips to `failed` with `reason: 'cancelled'`.
- [ ] Manual smoke: kill `npm run dev` mid-run; restart; confirm `reconcileOrphans()` flips the orphaned descriptor to `failed` with `reason: 'orphaned'` and the recent panel surfaces it.
- [ ] Update `CLAUDE.md`:
  - **Architecture** section: add a "Mutation pipeline" subsection describing the `MutationDescriptor` + `MutationApplier` shape, the `logs/mutations.jsonl` log, and the registered kinds (with `work-run` as the only implemented one in this phase).
  - **Project Structure** section: add `src/transport/mutations.ts`, `src/jobs/work-runner.ts`, `src/jobs/mutations-log.ts`, `src/server/projects-snapshot.ts`.
  - **HTTP server** section: list `POST /api/mutations`, `GET /api/mutations`, `POST /api/mutations/:id/cancel`.
- [ ] Update `docs/projects/index.md`: 06-webview row's status reflects shipped phase; description mentions the mutation pipeline + `/work --auto` runner.

## Cross-cutting

- [ ] Decide on cookie vs URL token for WS auth (Open Question, Phase B).
- [ ] Decide on approval-signal sidecar shape (Open Question, Phase D).
- [ ] Confirm `OBSIDIAN_VAULT_NAME` default works for the user's actual vault registration; document override in CLAUDE.md.
- [ ] Add `OBSIDIAN_VAULT_NAME` to `.env.local.example` if one exists.
- [ ] Final docs sweep: grep for "Telegram-only" assumptions in CLAUDE.md and update where the webview now applies.
- [ ] (Phase E) Confirm whether the `/work` skill itself manages branching off `main`. If not, add branch creation/teardown to `WorkRunApplier`.
- [ ] (Phase E) Sketch design + risks for each future `MutationKind` (`project-edit`, `proposal-action`, `agent-edit`, `cron-toggle`) before opening the follow-on project.
