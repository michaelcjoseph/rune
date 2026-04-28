# Webview — Tasks

Not started. See [spec.md](spec.md) for details.

## Phase A — Transport abstraction + notification bus

> Server-side refactor only. No user-visible change. Independently shippable.

- [ ] Create `src/transport/sender.ts`: `MessageSender` interface (`send`, `startTyping`, `stopTyping`), `SendOpts` type with optional `approval` sidecar, `createSenders(bot, bus)` factory.
- [ ] Create `src/transport/notification-bus.ts`: typed wrapper over Node `EventEmitter` with `publish(event)` / `on(kind, handler)`.
- [ ] Create `src/transport/telegram-sender.ts`: implements `MessageSender`; delegates `send` to `sendLongMessage(bot, …)` from `src/integrations/telegram/client.ts`; ignores `opts.approval`.
- [ ] Create `src/transport/webview-sender.ts`: implements `MessageSender`; maintains `Map<userId, Set<WebSocket>>`; serializes outbound frames as `{ kind: 'message', text, approval? }` JSON; no-ops when no connection registered. (Phase A: register/unregister no-ops; Phase B wires real connections.)
- [ ] Vitest: `src/transport/notification-bus.test.ts` — fan-out to multiple subscribers; one failing subscriber doesn't block the others.
- [ ] Vitest: `src/transport/telegram-sender.test.ts` — chunking and newline-preferring splits match `sendLongMessage` parity for representative inputs (short, exactly 4096, multi-paragraph, no newlines).
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
  - 401 on missing/invalid auth; 403 on non-localhost `Host`.
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
  - **Environment Variables** section: document `OBSIDIAN_VAULT_NAME`.

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

## Cross-cutting

- [ ] Decide on cookie vs URL token for WS auth (Open Question, Phase B).
- [ ] Decide on approval-signal sidecar shape (Open Question, Phase D).
- [ ] Confirm `OBSIDIAN_VAULT_NAME` default works for the user's actual vault registration; document override in CLAUDE.md.
- [ ] Add `OBSIDIAN_VAULT_NAME` to `.env.local.example` if one exists.
- [ ] Final docs sweep: grep for "Telegram-only" assumptions in CLAUDE.md and update where the webview now applies.
