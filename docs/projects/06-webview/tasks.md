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
- [x] Modify `src/index.ts`: instantiate `bus`; create senders; pass them into the scheduler and bot init.
- [x] Modify `src/jobs/scheduler.ts`: signature change — accept `{ bus }` instead of `bot`. Cron job functions receive the bus.
- [x] Refactor cron jobs to publish to bus instead of calling `bot.sendMessage`:
  - [x] `src/jobs/morning-prep.ts`
  - [x] `src/jobs/nightly.ts`
  - [x] `src/jobs/whoop-sync.ts`
  - [x] `src/jobs/nudges.ts`
  - [x] `src/vault/watcher.ts`
  - [x] `src/jobs/intent-scan.ts`
- [x] Refactor handler / command / review callsites to use `senders.tg` instead of `bot.sendMessage`:
  - [x] `src/bot/handlers/text.ts`
  - [x] `src/bot/handlers/url.ts`
  - [x] `src/bot/handlers/photo.ts`
  - [x] `src/bot/commands/*.ts` (sweep all 25 files)
  - [x] `src/reviews/orchestrator.ts`
  - [x] `src/reviews/interview.ts`
  - [x] `src/reviews/{daily,weekly,monthly,quarterly,yearly,think,health,blog}.ts`
- [x] Refactor typing-indicator usage: replace inline `startTyping(bot, chatId)` with `senders.startTyping(chatId)` (sender chooses how to render).
- [x] Update existing handler tests to inject a fake `MessageSender` instead of stubbing `bot.sendMessage`.
- [ ] Smoke test: run `npm run dev`, exchange a TG message, run morning-prep manually (`/prep`), confirm chunking and content unchanged.
- [x] Update `CLAUDE.md` Project Structure section: add `src/transport/` row.

## Phase B — Webview chat surface

> Depends on: Phase A.

- [x] Create `src/server/auth.ts`: `verifyAuth(req): { ok: true; userId } | { ok: false }`. Reads `jarvis-auth` cookie or `Authorization: Bearer …` header. Validates against `JARVIS_HTTP_SECRET`.
- [x] Create `src/server/webview.ts`: `mountWebviewRoutes(server, bus, senders, deps)`. Wires:
  - `GET /` → serve `index.html` with server-rendered `<meta name="obsidian-vault" content="…">`.
  - `GET /static/*` → serve `src/server/static/*` with path-traversal guard.
  - `POST /api/chat` → auth check → dispatch via `webview-bootstrap.ts` → JSON `{ text, sessionId, model }`.
  - `WS /api/ws` upgrade → auth check → register on `WebviewSender`. On `message` frame → dispatch. On `close` → unregister.
  - `GET /api/state` → 503 if not ready, else 200 with `getStateSnapshot()` (Phase C wires this fully; Phase B returns a stub).
  - 401 on missing/invalid auth; 403 on Host header not in `JARVIS_ALLOWED_HOSTS` (port stripped before comparison).
- [x] Modify `src/config.ts`: add `JARVIS_ALLOWED_HOSTS` env var. Parsed at startup (split on `,`, trim + lower-case each entry) into a `Set<string>` exported alongside the rest of the config; default `localhost,127.0.0.1`.
- [x] Wire `JARVIS_ALLOWED_HOSTS` into the Host-guard in `src/server/webview.ts` (requirement 14). The guard runs before auth so a misrouted request never advances to the secret-comparison codepath.
- [x] In the `POST /api/auth-bootstrap` handler (cookie-set path): set `Secure` on the `jarvis-auth` cookie iff `req.headers['x-forwarded-proto'] === 'https'` AND `req.socket.remoteAddress` is `127.0.0.1` / `::1`. Always set `HttpOnly` and `SameSite=Strict`. (Requirement 63.)
- [x] Create `src/server/webview-bootstrap.ts`: extracted dispatch entrypoint that mirrors `handleTextMessage` but takes a plain `{ userId, text }` instead of a TG `Message`. Handles slash-command branch, review-active branch, resolver branch, freeform branch.
- [x] Modify `src/server/http.ts`: call `mountWebviewRoutes(...)` after the existing `/health`, `/capture-sessions`, `/oauth/whoop` routes.
- [x] Wire `src/transport/webview-sender.ts` for real: `register(userId, ws)`, `unregister(userId, ws)`, per-user fan-out on bus events.
- [x] Modify `src/config.ts`: add `OBSIDIAN_VAULT_NAME` (default = basename of `VAULT_DIR`).
- [x] Create `src/server/static/index.html`:
  - Auth bootstrap script: read `?token=…` from URL, POST to `/api/auth-bootstrap`, set cookie, redirect to `/`.
  - Server-rendered `<meta name="obsidian-vault" content="…">`.
  - CDN deps: `markdown-it`, `highlight.js` + a default theme CSS.
  - Loads `app.js` and `app.css`.
- [x] Create `src/server/static/app.js`:
  - WS connect with reconnect-with-backoff (2s, 4s, 8s, max 30s).
  - Textarea: Enter = newline; Cmd+Enter (Mac) / Ctrl+Enter (Linux/Win) = send.
  - In-memory ring buffer (last 20 user messages); Up-arrow on empty input → recall, Down-arrow → cycle forward.
  - Markdown render via `markdown-it`. Post-render pass:
    - `[[Note Title]]` → `<a href="obsidian://open?vault=…&file=…">Note Title</a>`.
    - `<pre><code>` blocks → `highlight.js` invocation.
  - Streaming chunk renderer: open a "tail" node, append text on each chunk frame, re-render the tail node's markdown each tick.
  - Auto-scroll with user-override detection (suspended if user scrolls up; resumed at bottom).
  - Model dropdown: bound to `/opus` / `/sonnet` / `/haiku` — selecting an option sends the slash command as the next message.
- [x] Create `src/server/static/app.css`: minimal dark theme. Sidebar layout placeholder (Phase C fills it).
- [x] Add `POST /api/auth-bootstrap` route: validates `?token=` body, sets `jarvis-auth` cookie (HttpOnly, SameSite=Strict).
- [x] Vitest: `src/server/auth.test.ts` — 401 missing, 401 wrong, 200 cookie, 200 bearer, 403 non-localhost.
- [x] Vitest: `src/server/webview.test.ts` — integration: stub Claude CLI, POST `/api/chat`, assert response shape; open WS, send a message frame, assert outbound chunks.
- [x] Manual smoke: `npm run dev` → browser to `http://127.0.0.1:3847/?token=$JARVIS_HTTP_SECRET` → exchange a message → verify rendering and wikilink click opens Obsidian.
- [x] Update `CLAUDE.md`:
  - **Architecture** section: mention webview as second transport sharing session via `TELEGRAM_USER_ID`.
  - **HTTP server** section: list new endpoints.
  - **Project Structure** section: add `src/server/static/`, `src/server/webview.ts`, `src/server/auth.ts`, `src/server/webview-bootstrap.ts`.
  - **Environment Variables** section: document `OBSIDIAN_VAULT_NAME` and `JARVIS_ALLOWED_HOSTS`.

### Phase B.5 — Headless Mac mini deployment

> Optional within Phase B; required before laptop access from a headless Mac mini. Acceptance: Jarvis runs unattended on the mini, the laptop reaches the webview over Tailscale, and every step in the spec's **Deployment** subsection executes cleanly.

#### macOS basics

- [x] Sign in to Apple ID; finish OS setup
- [x] System Settings → Energy: enable "Prevent automatic sleeping when display is off" and "Start up automatically after a power failure"
- [x] System Settings → Users & Groups: set "Automatically log in as" to your user (lets launchd start Jarvis after reboot without manual unlock)
- [x] Decide on FileVault based on your threat model. Note that FileVault blocks auto-login until manual disk unlock at boot, which conflicts with the headless-restart goal; it has no effect on the remote/internet attack surface (at-rest encryption only).
- [x] System Settings → General → Software Update: enable automatic security updates
- [x] Enable 2FA on Apple ID (Find My can remote-wipe the mini; protect the account)
- [x] System Settings → General → Sharing: set a clean Local hostname (becomes part of the MagicDNS name)

#### Remote access (pre-Tailscale)

- [x] Enable Remote Login (System Settings → General → Sharing → Remote Login)
- [x] Copy laptop SSH pubkey into `~/.ssh/authorized_keys` on the mini 
- [x] Edit `/etc/ssh/sshd_config`: set `PasswordAuthentication no`, `ChallengeResponseAuthentication no`, `PermitRootLogin no`; reload with `sudo launchctl kickstart -k system/com.openssh.sshd`
- [x] Confirm SSH is not exposed to the public internet (no router port-forward on 22). Prefer Tailscale SSH for remote shell once Tailscale is installed.
- [x] Enable Screen Sharing temporarily for first-time GUI setup (Tailscale sign-in, etc.); disable when done
- [x] Verify no other macOS Sharing services are enabled beyond what's needed

#### Developer toolchain

- [x] Install Xcode CLI tools: `xcode-select --install`
- [x] Install Homebrew: `/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"`
- [x] `brew install node git`
- [x] Install Claude Code CLI per Anthropic's instructions; run `claude` once to authenticate

#### Repos + dependencies

- [x] `git clone` jarvis to `~/workspace/jarvis`
- [x] `cd ~/workspace/jarvis && npm install`
- [x] Verify directory structure matches Jarvis's `PROJECT_ROOT` / `VAULT_DIR` expectations

#### Secrets / `.env.local`

- [x] `scp` `.env.local` from laptop to mini (do NOT email or Slack secrets)
- [x] Update path-dependent vars (`VAULT_DIR`, `PROJECT_ROOT`, log paths) for mini paths
- [x] Verify all required vars are present: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_USER_ID`, `JARVIS_HTTP_SECRET`, Whoop OAuth (`WHOOP_CLIENT_ID`, `WHOOP_CLIENT_SECRET`, refresh token), Readwise token, `OBSIDIAN_VAULT_NAME` if overriding default.

#### Telegram handoff

- [x] Stop the laptop's Jarvis instance (one bot token = one polling client; running both produces dropped messages)
- [x] Commit to mini as permanent home, laptop as fallback only. Running both concurrently requires a second bot token, deferred.

#### Tailscale

- [x] Install Tailscale on mini: `brew install --cask tailscale`, sign in to your tailnet, enable 2FA on the Tailscale account
- [x] Run `tailscale serve --bg --https=443 http://127.0.0.1:3847`; capture the published origin from `tailscale serve status`
- [x] Verify port 3847 stays loopback-only: `lsof -iTCP:3847 -sTCP:LISTEN` must show `127.0.0.1` (and/or `::1`) only — never `*` or a LAN/tailnet address. Tailscale Serve listens on its own tailnet port and proxies inward over loopback; if 3847 itself becomes externally bound, the listener invariant has been broken.
- [x] Verify `tailscale serve status` shows only a `serve` entry, never `funnel` — funnel would push the origin to the public internet and bypass the tailnet trust boundary
- [x] Set `JARVIS_ALLOWED_HOSTS` in `.env.local` to include the actual MagicDNS hostname
- [x] On the laptop: install Tailscale, sign in to the same tailnet, browse `https://<host>.tail-xxxx.ts.net/?token=$JARVIS_HTTP_SECRET`, confirm the page exchanges the token for a `Secure; HttpOnly; SameSite=Strict` cookie
- [x] Do NOT enable `tailscale funnel` (would expose Jarvis to the public internet; spec rules this out)
- [x] Run the "Remote access (Tailscale Serve)" tests in `test-plan.md` end-to-end and check off each item there

#### Process management (launchd)

- [x] Write `~/Library/LaunchAgents/com.jarvis.daemon.plist` running `npm start` (or `npm run dev`) from `~/workspace/jarvis`, with `KeepAlive` true, stdout/stderr redirected to `~/Library/Logs/jarvis/`
- [x] `launchctl load ~/Library/LaunchAgents/com.jarvis.daemon.plist`
- [x] Reboot the mini; confirm Jarvis comes back up unattended and the webview is reachable via Tailscale

#### Monitoring

- [x] Confirm log access from laptop: `ssh mini "tail -f ~/Library/Logs/jarvis/stdout.log"`
- [x] Optional: periodic `/health` ping from laptop to catch silent failures

## Phase C — Cockpit sidebar

> Depends on: Phase B.

- [x] Create `src/server/state-snapshot.ts`: `getStateSnapshot({ sessions, reviewSessions, queue, …})` returns:
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
- [x] Recent-runs source: append to `logs/agent-runs.jsonl` from `src/ai/claude.ts` `runAgent` (light-touch instrumentation in Phase C; Phase D adds live events).
- [x] Vitest: `src/server/state-snapshot.test.ts` — fixture queue files, fixture sessions; assert snapshot shape and warnings on malformed inputs.
- [x] Modify `src/server/webview.ts`: wire `GET /api/state` to `getStateSnapshot`; 503 with `{ ready: false, reason }` if bot not yet started.
- [x] Modify `src/server/static/app.js`: poll `GET /api/state` every 5s; render five panels (Active Session, Ingestion Queue, Recent Agent Runs, Pending Approvals, Last Runs); diff-render to avoid flicker.
- [x] Modify `src/server/static/app.css`: ~280px right rail, scrollable.
- [ ] Manual smoke: enqueue a fake playbook draft via `appendVaultFile('logs/playbook-queue.json', …)` (or wait for nightly); confirm sidebar count ticks up within 5s.
- [x] Update `CLAUDE.md` Project Structure: add `src/server/state-snapshot.ts`; mention `logs/agent-runs.jsonl`.

## Phase D — Approval buttons + live agent-run events

> Depends on: Phase C.

- [x] Modify `src/reviews/interview.ts`: at approval points (outline approval, dynamic-section approvals), call `sender.send(userId, prompt, { approval: { prompt, options } })`. Keep typed-text fallback as a universal path.
- [x] Modify `src/reviews/orchestrator.ts`: same pattern wherever orchestrator-level approvals exist. (No approval messages in orchestrator.ts — N/A)
- [x] Modify `src/transport/webview-sender.ts`: serialize `approval` sidecar into the outbound WS frame. (Already done in Phase B)
- [x] Modify `src/transport/telegram-sender.ts`: ignore `approval` (text fallback unchanged). (Already done — TelegramSender.send ignores opts)
- [x] Modify `src/ai/claude.ts`: instrument `runAgent`. Emit `bus.publish({ kind: 'agent-event', subKind: 'start', agent, runId, userId, startedAt })` on entry; `agent-event` `subKind: 'end'` on exit with `durationMs` and `status`. Include `userId: TELEGRAM_USER_ID` for nightly batch runs.
- [x] Modify `src/transport/webview-sender.ts`: forward `agent-event` bus messages to connected WS as `{ kind: 'agent-event', … }` frames.
- [x] Modify `src/server/static/app.js`:
  - Render approval-bearing message frames as a button row below the message; click sends `{ kind: 'message', text: <option.value> }`.
  - Subscribe to `agent-event` frames; render a "running now" panel above the recent-runs list with agent name + live elapsed timer; remove from "running now" and prepend to recent-runs on `subKind: 'end'`.
- [x] Vitest: `src/reviews/interview.test.ts` — assert approval emission shape on outline approval.
- [x] Vitest: `src/transport/webview-sender.test.ts` — `approval` sidecar round-trips on the wire; `agent-event` frames forward.
- [ ] Manual smoke: run `/weekly` from the webview; click the outline-approval button; watch the writeup phase advance. Run `/think`, watch the agent show in "running now" while it works.
- [ ] (Optional) Add `surface: 'tg' | 'webview'` to `appendIntent()` calls so resolver telemetry distinguishes adoption per surface.
- [x] Update `CLAUDE.md` § **Review → post-agent flow**: note the structured approval-signal channel; webview renders buttons, TG renders prose.

## Phase E — Mutation pipeline + project dashboard + `/work --auto` runner

> Depends on: Phase C (snapshot infrastructure) and Phase D (bus event fan-out plumbing).

### Mutation pipeline (framework)

- [x] Create `src/transport/mutations.ts`: `MutationKind` union (`'work-run' | 'project-edit' | 'proposal-action' | 'agent-edit' | 'cron-toggle'`); `MutationStatus`, `MutationDescriptor<P>`, `MutationEvent`, `MutationApplier<P>`, `ApplyContext` types; `registerApplier`, `getApplier`, `createMutation`, `cancelMutation` functions; in-memory `Map<id, RunHandle>` for active runs.
- [x] Create `src/jobs/mutations-log.ts`: append-only `logs/mutations.jsonl` reader/writer. `appendMutationLine`, `readRecentMutations(n)`, `reconcileOrphans()` (flip stale `running` → `failed` with `reason: 'orphaned'`).
- [x] Modify `src/transport/notification-bus.ts`: extend the event union to include `'mutation-event'` alongside existing `'message'` and `'agent-event'`.
- [x] Modify `src/transport/webview-sender.ts`: forward `'mutation-event'` bus messages to connected WS as `{ kind: 'mutation-event', mutationId, subKind, ts, data }` frames; drop silently when no WS registered.
- [x] Modify `src/transport/telegram-sender.ts`: on `'mutation-event'` with `subKind: 'completed'` or `'failed'`, send a one-line summary; ignore `output` / `progress` / `log` to avoid TG floods.
- [x] Modify `src/index.ts`: register `workRunApplier` at boot; call `reconcileOrphans()` before the bot starts polling.
- [x] Vitest: `src/transport/mutations.test.ts` — descriptor lifecycle (`pending` → `running` → `completed`), unknown-kind rejection, applier validation failures, cancellation flips status with `reason: 'cancelled'`.
- [x] Vitest: `src/jobs/mutations-log.test.ts` — append, read recent, skip corrupt line with warning, `reconcileOrphans` rewrites stale `running` rows.

### `/work --auto` runner

- [x] Create `src/jobs/work-runner.ts`: exports `workRunApplier: MutationApplier<{ projectSlug: string }>`. Implements `validate` (project dir exists, `spec.md` present, no other run for slug, under global cap) and `apply` (spawns `claude --add-dir docs/projects/<slug>/ -p '<spec + tasks + /work --auto>'` from `PROJECT_ROOT`).
- [x] Reuse `activeProcesses` and `waitForActiveProcesses` from `src/ai/claude.ts` for graceful shutdown (no signature changes needed).
- [x] Implement stdout line-buffering: each newline-delimited chunk yields a `MutationEvent { kind: 'output', data: { line } }`; stderr yields `{ kind: 'log', data: { line, stream: 'stderr' } }`.
- [x] Implement exit handling: code 0 → `completed`; non-zero → `failed`; SIGTERM → `failed` with `reason: 'cancelled'` if `cancelMutation` was called, else `'killed'`.
- [x] Modify `src/config.ts`: add `WORK_RUN_PER_PROJECT_CAP` (default 1) and `WORK_RUN_GLOBAL_CAP` (default 2).
- [x] Vitest: `src/jobs/work-runner.test.ts` — stubbed `spawn`: assert spawn args include `--add-dir` and `cwd: PROJECT_ROOT`; stdout chunks become `output` events; exit 0 → `completed`; exit non-zero → `failed`; second concurrent run for same slug rejected by `validate`.

### API endpoints

- [x] Modify `src/server/webview.ts`: add `POST /api/mutations` (auth → resolve applier → validate → create descriptor → start apply when `autoApprove` → 200 with descriptor).
- [x] Modify `src/server/webview.ts`: add `GET /api/mutations` — removed as dead code; mutation data embedded in `GET /api/state` via `getStateSnapshot()`.
- [x] Modify `src/server/webview.ts`: add `POST /api/mutations/:id/cancel` (SIGTERM via in-memory `RunHandle`; 409 if mutation is already terminal).
- [x] Vitest: extend `src/server/webview.test.ts` — `POST /api/mutations` happy path; invalid `kind` → 400; unauthorized → 401; cancellation 409 on non-existent id.

### Project dashboard / state snapshot extension

- [x] Create `src/server/projects-snapshot.ts`: `getProjectSummaries()` parses `docs/projects/index.md` (status + slug from table) and each `docs/projects/<slug>/tasks.md` (count `- [ ]` + `- [x]`, group by `## Phase …` headers). Returns `ProjectSummary[]` with `{ slug, status, progress: { done, total, perPhase? }, specPath, lastModified }`.
- [x] Modify `src/server/state-snapshot.ts`: add `projects: getProjectSummaries()` and `mutations: { active, recent: readRecentMutations(50) }` to the snapshot. Include per-project warnings in the snapshot's `warnings` field on parse failure.
- [x] Vitest: `src/server/projects-snapshot.test.ts` — fixture `index.md` + per-project `tasks.md`: progress matches manual count, missing `tasks.md` produces `—`, malformed table cell handled cleanly.

### Webview UI

- [x] Modify `src/server/static/app.js`: add Projects cockpit panel (row per project: slug + status pill + progress bar + spec link + "Run /work --auto" button); disable button when a `work-run` is `running` for that slug.
- [x] Modify `src/server/static/app.js`: add Mutations cockpit panel — Active (live elapsed timer + tail of last `output` line) and Recent (last 5 terminal entries).
- [x] Modify `src/server/static/app.js`: implement run-detail drawer that opens on click of an active or recent mutation row; subscribes to `mutation-event` frames matching its `mutationId`; reuses the chunk renderer from Phase D.
- [x] Modify `src/server/static/app.js`: implement confirmation modal triggered by "Run /work --auto" button click ("Run /work --auto on `<slug>`? Edits + commits without further confirmation. [Run] [Cancel]"); only `Run` POSTs to `/api/mutations`.
- [x] Modify `src/server/static/app.css`: drawer slide-in transition; modal overlay; progress bar; status pill colors (Done = green, Spec = grey, In Progress = blue, Failed = red).

### Smoke + docs

- [x] Update `CLAUDE.md`:
  - **Architecture** section: add a "Mutation pipeline" subsection describing the `MutationDescriptor` + `MutationApplier` shape, the `logs/mutations.jsonl` log, and the registered kinds (with `work-run` as the only implemented one in this phase).
  - **Project Structure** section: add `src/transport/mutations.ts`, `src/jobs/work-runner.ts`, `src/jobs/mutations-log.ts`, `src/server/projects-snapshot.ts`.
  - **HTTP server** section: list `POST /api/mutations`, `POST /api/mutations/:id/cancel` (`GET /api/mutations` was removed as dead code — data embedded in `GET /api/state`).
- [x] Update `docs/projects/index.md`: 06-webview row's status reflects shipped phase; description mentions the mutation pipeline + `/work --auto` runner.
