# Webview Specification

## Overview

Today, the only way to talk to Jarvis is Telegram. TG desktop is fine for chat — but it has hard limits that the rest of Jarvis doesn't: messages are chunked at 4096 chars (`src/integrations/telegram/client.ts`), code blocks render as plain monospace, `[[wikilinks]]` are dead text, and there is no view into Jarvis's internal state — the ingestion queue, pending playbook drafts, recent agent runs, the active review phase. All of that lives in JSON files under `logs/` or in in-memory maps and only surfaces if you remember to ask.

This project adds a localhost webview at `http://127.0.0.1:3847/` that talks to Jarvis through the existing single-process server. It is not a replacement for Telegram — TG remains the cross-device fallback — it is a richer desktop surface that **shares the same session** as TG via `TELEGRAM_USER_ID`. A message sent in either surface persists in the same Claude session; outbound notifications (morning prep, nightly summary, Whoop, nudges) fan out to both. The webview adds rendering fidelity (markdown, code highlight, wikilink click-through to Obsidian, streaming responses), interaction polish (multi-line input + Cmd+Enter, up-arrow recall, model dropdown), and a light cockpit sidebar that surfaces queues, recent agent runs, and pending approvals so internal state is ambient instead of hidden.

The implementation reuses the existing skill registry, resolver, review orchestrator, and Claude CLI plumbing without modification. The only structural change is a new `MessageSender` abstraction that sits between handlers/jobs and the wire — `TelegramSender` keeps current behavior, `WebviewSender` is the new transport — plus a `NotificationBus` that cron jobs publish to instead of holding a `bot` reference.

### Core Value Proposition

A localhost browser surface that shares a single conversation with Telegram, renders Claude's output the way it deserves to be rendered, and turns Jarvis's internal state into ambient signal — without forking the bot, replacing TG, or adding any infrastructure beyond a new endpoint on the existing http server.

### Goals

1. **Primary:** A vanilla-HTML webview chat surface served from `src/server/http.ts` at `http://127.0.0.1:3847/` that reaches feature parity with the Telegram bot — slash commands, conversation sessions, review sessions — sharing the same session map keyed by `TELEGRAM_USER_ID`.
2. **Secondary:** Rendering and interaction wins that TG cannot offer: client-side markdown rendering with code-block syntax highlighting, `[[wikilink]]` anchors that open Obsidian via `obsidian://`, streaming responses chunk-by-chunk over WebSocket, a multi-line textarea with Cmd+Enter to send, up-arrow recall of the previous message, and a model indicator + dropdown (Opus/Sonnet/Haiku) bound to the existing `/opus`-`/sonnet`-`/haiku` handlers.
3. **Tertiary:** A light cockpit sidebar (~280px) showing live state from existing JSON files and in-memory maps: active conversation/review session, ingestion queue depth, last 10 agent runs, pending playbook + proposal approvals, last morning-prep + nightly run timestamps. Polled via `GET /api/state` every 5s.
4. **Quaternary:** Approval buttons for review-session prompts (`/weekly` outline approval, `/blog` post drafts, etc.) plus live agent-run events streamed over the WebSocket into the sidebar's "running now" indicator. Achieved by emitting structured signals from `src/reviews/interview.ts` and instrumenting `runAgent()` in `src/ai/claude.ts` with bus events.

### Non-Goals

- **Replacing Telegram.** TG remains the cross-device + mobile fallback. The webview is a desktop-only complement, not a migration.
- **Mobile-responsive UI.** v1 is laptop/desktop only. If you need to chat from the couch, use TG.
- **Multi-user support.** Jarvis is single-user. Auth is one shared bearer token (`JARVIS_HTTP_SECRET`); session is keyed off `TELEGRAM_USER_ID`. Non-goal even at v2.
- **Voice / audio messages.** No transcription pipeline today; not adding one.
- **Browser push notifications outside the open tab.** Outbound notifications still go to TG (which has its own push); the webview only sees them when the tab is open and the WebSocket is connected. If you want a push from your laptop, TG desktop already does that.
- **Vault file browser.** Tempting, but a slippery slope toward duplicating Obsidian. Wikilinks resolve to Obsidian; we don't host the file viewer.
- **Message-history persistence across page refresh.** v1: refresh = empty chat, but the underlying Claude session is preserved (next message resumes). Adding a server-side message log is deferred to v1.1.
- **LAN access from the phone.** Listener stays bound to `127.0.0.1`. Exposing it requires real auth (not just a shared secret) and is out of scope.
- **Frontend build pipeline.** No Vite, no React, no node_modules for the frontend. `markdown-it` and `highlight.js` load from a CDN; everything else is hand-written HTML/JS/CSS.

### Scale Considerations

- **Connection count:** single user, typically one tab. Occasionally two (one tab per device, or a stale tab). The WS handler must tolerate multiple connections claiming the same `TELEGRAM_USER_ID` — fan out to all, but process inbound frames serially through the shared session.
- **Backlog while disconnected:** outbound bus fan-out to a disconnected webview is dropped (TG still gets it). When the tab reconnects, sidebar polls catch up the cockpit; chat history starts fresh. No server-side replay buffer in v1.
- **Bandwidth:** localhost. Free.
- **Static-asset size:** `index.html` + `app.js` + `app.css` aim for <50KB total before CDN deps. CDN deps add ~150KB of JS for `markdown-it` + `highlight.js`. Cached after first load.
- **No new env vars beyond `JARVIS_HTTP_SECRET`** (already exists). One new optional config: `OBSIDIAN_VAULT_NAME` for building the `obsidian://` URI; defaults to the basename of `VAULT_DIR`.

---

## User Journey

### Happy Path — chat from the browser

```
User opens http://127.0.0.1:3847/ in browser
         ↓
Page loads index.html. JS opens WebSocket to /api/ws with the bearer cookie.
         ↓
WebviewSender registers the connection under TELEGRAM_USER_ID.
         ↓
Sidebar hits GET /api/state, paints panels.
         ↓
User types into the textarea, presses Cmd+Enter.
         ↓
Frontend sends { kind: 'message', text } over WS.
         ↓
Server dispatches to the SAME code path as TG text messages
(handleTextMessage), sharing the conversation/review session map.
         ↓
Claude CLI runs. Chunks stream back over WS to the frontend, which
re-renders the markdown live as tokens arrive.
         ↓
Code blocks highlight via highlight.js. [[wikilinks]] become clickable
obsidian:// anchors. Final message persists in the chat scroll.
         ↓
Sidebar's recent-runs panel updates within 5s (or live in Phase D).
```

### Happy Path — review session with approval buttons (Phase D)

```
User types /weekly in the webview (or in TG — same session).
         ↓
Review orchestrator starts a weekly-review session under TELEGRAM_USER_ID.
Prep agents run. Sidebar shows "weekly review · prep phase".
         ↓
Interview phase. Claude generates the outline; src/reviews/interview.ts
detects the outline marker AND emits a sidecar signal:
  { type: 'approval', prompt: 'Approve outline?', options: ['yes','edit','cancel'] }
         ↓
Webview renders the prompt prose followed by a row of three buttons.
TG receives the same signal but renders only the prose (text fallback).
         ↓
User clicks "yes" in the webview. Frontend sends { kind: 'message', text: 'yes' }.
         ↓
Review handler advances to writeup phase. Same path it'd take from a typed reply.
         ↓
review-writer agent runs. Sidebar's "running now" panel shows it (Phase D).
         ↓
Writeup completes. Post-agents (project-updater, etc.) run in parallel,
each surfacing as a row in the agent-runs panel.
         ↓
TG receives the same outbound messages via the bus, so if you switch
to TG mid-review the conversation continues there seamlessly.
```

### Happy Path — both surfaces open

```
User has the webview open AND TG desktop open.
         ↓
User types in TG: "what's on my plate today?"
         ↓
handleTextMessage fires. Resolver classifies, dispatches.
         ↓
Claude response is delivered via bus.publish to the registered senders.
TelegramSender writes the chunked reply to TG.
WebviewSender pushes the reply over WS — webview chat updates live.
         ↓
User can pivot to webview, type a follow-up, response goes to both.
There is one logical conversation, not two.
```

### Edge — webview disconnected mid-stream

```
User sends a long message; Claude is mid-stream when the laptop sleeps.
         ↓
WS connection drops. Server detects the close, removes the connection from
WebviewSender's registry. Streaming continues to /dev/null (other senders
unaffected; TG, if open, still receives chunks).
         ↓
Laptop wakes. Browser reconnects the WS automatically.
         ↓
WebviewSender re-registers. The mid-stream response is GONE from the chat
scroll (no replay buffer in v1). The sidebar repopulates from /api/state.
         ↓
The Claude session is intact server-side. User's next message resumes
the same session. No data loss; just no replay.
```

### Edge — bot not yet ready

```
User opens the page during npm run dev startup, before the bot has
finished polling-mode initialization.
         ↓
GET /api/state returns 503 with { ready: false, reason: 'bot starting' }.
Sidebar shows a "starting up..." banner.
         ↓
WS upgrade returns 503. Frontend retries every 2s with exponential backoff.
         ↓
Once the bot fires its 'ready' event, /api/state flips to 200 and WS
upgrades succeed.
```

### Entry Points

- **Browser**: `http://127.0.0.1:3847/`. Auth handled on first load via `JARVIS_HTTP_SECRET` query param (`/?token=…`) which the page exchanges for a `jarvis-auth` cookie. Subsequent visits re-use the cookie.
- **No slash command, no resolver entry**: the webview surface is operator-facing, opened directly. The TG bot is unaware the webview exists.
- **No CLI**: the existing `npm run cli` is unchanged; webview is browser-only.

### Exit Points

- All of TG's exit points still apply (vault writes, KB ingestion, journal updates, etc.) — the webview reuses the same handlers.
- New: `obsidian://open?vault=…&file=…` URIs in rendered messages launch Obsidian with the corresponding file.
- New: cockpit sidebar paints state from `logs/playbook-queue.json`, `logs/proposal-queue.json`, the in-memory ingestion queue, the session map, and last-run timestamps from `logs/`.

---

## Architecture Decisions

| Decision | Choice |
|---|---|
| Transport abstraction | New `MessageSender` interface (`send`, `startTyping`, `stopTyping`). `TelegramSender` and `WebviewSender` implement it. ~70 scattered `bot.sendMessage()` callsites refactored to call the shared sender. |
| Outbound notification fan-out | New `NotificationBus` (Node `EventEmitter`). Cron jobs (`morning-prep`, `nightly`, `whoop-sync`, `nudges`, vault watcher) publish to the bus instead of holding a `bot` reference. Both senders subscribe. |
| Streaming protocol | **WebSocket** (bidirectional, supports cancellation, supports approval-button click-throughs as inbound frames). SSE rejected — unidirectional. Long-poll rejected — clunky. |
| Frontend stack | **Vanilla HTML/JS/CSS**, served from `src/server/static/`. `markdown-it` + `highlight.js` from a CDN. No build step, no `node_modules` for the frontend. Matches Jarvis's no-build-step ethos. |
| Session key | Webview uses `TELEGRAM_USER_ID` as the `chatId` so the existing session map is shared verbatim. No schema change to `src/vault/sessions.ts`. |
| Auth | Shared bearer (`JARVIS_HTTP_SECRET`). On first load, client supplies it as `?token=…`; server sets a `jarvis-auth` cookie (HttpOnly, SameSite=Strict). Cookie is checked on `/api/*` and the WS upgrade. Localhost + single-user — sufficient. |
| Listener binding | Stays at `127.0.0.1:3847`. No LAN exposure in v1. |
| Cockpit data delivery | `GET /api/state` polled every 5s for the snapshot panels. Live agent-run events streamed over the WS as a separate frame `kind` (Phase D). Two channels because the snapshot is cheap and the live stream needs sub-second latency. |
| Approval-button signal shape | Sidecar field on the WS frame: `{ kind: 'message', text, approval?: { prompt, options } }`. Webview renders buttons when `approval` is present; TG ignores it (text fallback). |
| Static-asset hosting | Files on disk under `src/server/static/`, served by a small static-file handler in `src/server/webview.ts`. Path-traversal guard. Hot edit during dev = page refresh, no restart. |
| Wikilink resolution | Client-side regex in the markdown renderer. `[[Note Title]]` → `<a href="obsidian://open?vault=<OBSIDIAN_VAULT_NAME>&file=Note%20Title">Note Title</a>`. Vault name passed once on page load via a `<meta>` tag populated server-side from `OBSIDIAN_VAULT_NAME` env (default = `basename($VAULT_DIR)`). |
| Slash-command parity | No special-casing. Webview sends `{ kind: 'message', text: '/journal foo' }`; server routes through the same `handleTextMessage` switch chain as TG. |
| Model dropdown | Bound to existing `/opus` / `/sonnet` / `/haiku` handlers — selecting "Sonnet" sends `/sonnet` as the next message. No new server logic. |

---

## Requirements

### Transport abstraction

1. WHEN any handler or job needs to send a user-facing message THEN it calls `sender.send(userId, text)` rather than `bot.sendMessage(chatId, text)` directly.
2. WHEN `TelegramSender.send(userId, text)` is invoked THEN it delegates to `sendLongMessage(bot, userId, text)` so chunking at `TG_MAX_MESSAGE_LENGTH` and newline-preferring splits behave exactly as today.
3. WHEN `TelegramSender.startTyping(userId)` is invoked THEN it begins the existing 4-second `sendChatAction('typing')` interval; `stopTyping` clears it.
4. WHEN a cron job needs to push an unsolicited notification THEN it calls `bus.publish({ userId, text, kind })` rather than holding a `bot` reference.
5. WHEN the `NotificationBus` receives a publish THEN it fans out to every registered sender; senders that fail (e.g., webview WS dropped) log the failure and do not block other senders.
6. WHEN startup completes THEN both `TelegramSender` and `WebviewSender` are registered on the bus before any cron job fires.
7. WHEN an existing TG-only flow runs after the Phase A refactor THEN observable behavior is unchanged — same chunking, same typing indicator, same content.

### HTTP / WS server

8. WHEN `GET /` is hit THEN the server responds with `src/server/static/index.html` (200, `text/html`).
9. WHEN `GET /static/*` is hit THEN the server serves the corresponding file under `src/server/static/`, with a path-traversal guard rejecting `..` segments and absolute paths.
10. WHEN `POST /api/chat` is hit with valid auth and body `{ message: string }` THEN the request is dispatched to the same code path as a TG text message and a JSON response `{ text, sessionId, model }` is returned. (Non-streaming fallback for clients that can't WS.)
11. WHEN a WS upgrade is requested at `/api/ws` with valid auth THEN the connection is registered with `WebviewSender` keyed by `TELEGRAM_USER_ID`.
12. WHEN `GET /api/state` is hit with valid auth THEN it returns the cockpit snapshot: `{ activeSession, activeReview, ingestionQueueDepth, recentAgentRuns, pendingApprovals: { playbook, proposal }, lastMorningPrepAt, lastNightlyAt, ready }`.
13. WHEN any `/api/*` endpoint or WS upgrade receives a request without a valid `jarvis-auth` cookie or `Authorization: Bearer <JARVIS_HTTP_SECRET>` header THEN it returns 401.
14. WHEN any new endpoint receives a request whose `Host` header is neither `localhost` nor `127.0.0.1` THEN it returns 403 (defense in depth on top of the listener binding).
15. WHEN multiple WS connections claim `TELEGRAM_USER_ID` simultaneously THEN all receive outbound frames; inbound frames are processed serially through the shared session (no extra locking — the existing `sessionLocks` map in `src/ai/claude.ts` already serializes Claude CLI calls).
16. WHEN the bot is not yet ready THEN `/api/state` returns 503 with `{ ready: false, reason }` and the WS upgrade returns 503.

### Frontend chat surface

17. WHEN a user types and presses Cmd+Enter (Mac) or Ctrl+Enter (Linux/Windows) THEN the message is sent.
18. WHEN a user presses Enter without modifier THEN a newline is inserted in the textarea.
19. WHEN a user presses Up-arrow with empty input THEN the previous user message is recalled into the textarea (in-memory ring buffer, last 20 messages).
20. WHEN a Claude response chunk arrives over WS THEN the partial markdown is re-rendered live, replacing the streaming-tail node.
21. WHEN a code block is rendered THEN it is syntax-highlighted via `highlight.js`; copy button is NOT in v1.
22. WHEN a `[[note title]]` wikilink appears in a response THEN it renders as an `<a>` whose href is `obsidian://open?vault=<OBSIDIAN_VAULT_NAME>&file=<encoded-title>`. The vault name is read from a server-rendered `<meta name="obsidian-vault" content="…">` in `index.html`.
23. WHEN the user picks a model from the dropdown THEN the next outbound message is preceded by `/opus`, `/sonnet`, or `/haiku` so the existing model-switch handlers run unchanged. The dropdown UI updates after the server confirms the model in the next response.
24. WHEN a slash command is typed (e.g., `/journal foo`, `/weekly`) THEN it is dispatched identically to the TG path; no special webview-side parsing.
25. WHEN a response exceeds the viewport during streaming THEN the chat auto-scrolls to follow the streamed tail; if the user has manually scrolled up, auto-scroll is suspended until they scroll back to the bottom.
26. WHEN the page is refreshed THEN message history is empty but the Claude session persists; the next message resumes the session.

### Sidebar / cockpit

27. WHEN the page loads THEN the sidebar fetches `GET /api/state` and renders five panels: Active Session, Ingestion Queue, Recent Agent Runs (last 10), Pending Approvals (playbook + proposal), Last Runs (morning-prep + nightly).
28. WHEN 5 seconds elapse THEN the sidebar re-fetches `GET /api/state` and diff-renders changes (no full rerender to avoid flicker).
29. WHEN an active conversation or review session exists for `TELEGRAM_USER_ID` THEN the Active Session panel shows session ID short-hash, model, message count, and (if a review is active) the review type, current phase, and target date.
30. WHEN a queue is empty THEN its panel shows a muted "0 pending" line rather than disappearing — the panel is always visible.
31. WHEN an agent run starts (Phase D) THEN a "running now" indicator appears at the top of the recent-runs panel with the agent name, start time, and a live elapsed timer; it disappears when the run completes and the run is added to the recent-runs list.

### Review integration (Phase D)

32. WHEN `src/reviews/interview.ts` reaches an approval point THEN it emits a structured signal via `sender.send(userId, text, { approval: { prompt, options } })`. The sender adapter chooses how to render it.
33. WHEN the webview receives an approval signal THEN it renders the prompt prose followed by a row of buttons, one per option.
34. WHEN the user clicks an approval button THEN the option's `value` is sent as a regular `{ kind: 'message', text }` frame — the review handler doesn't know which surface chose it.
35. WHEN Telegram receives the same approval signal THEN `TelegramSender` ignores the `approval` sidecar and renders only the prose (typed yes/no/cancel still works as today).

### Shared session

36. WHEN a TG message arrives THEN the resulting Claude response is delivered to all registered senders via the bus, so an open webview shows the same exchange in real time.
37. WHEN a webview message arrives THEN the response is delivered to TG too — there is one logical conversation, not two parallel ones.
38. WHEN a review session is active for `TELEGRAM_USER_ID` (started from either surface) THEN messages from the other surface route to the same review handler via `handleReviewMessage`.

---

## Technical Implementation

### Phase A — Transport abstraction + notification bus (server-side, no UI)

**New files:**

- `src/transport/sender.ts`:
  ```typescript
  export interface MessageSender {
    name: 'telegram' | 'webview';
    send(userId: number, text: string, opts?: SendOpts): Promise<void>;
    startTyping(userId: number): void;
    stopTyping(userId: number): void;
  }
  export interface SendOpts {
    approval?: { prompt: string; options: { value: string; label: string }[] };
  }
  export function createSenders(bot: TelegramBot, bus: NotificationBus):
    { tg: MessageSender; webview: MessageSender };
  ```
- `src/transport/telegram-sender.ts` — wraps `sendLongMessage`, `startTyping`, `stopTyping` from `src/integrations/telegram/client.ts`; ignores `opts.approval`.
- `src/transport/webview-sender.ts` — registers active WS connections in a `Map<userId, Set<WebSocket>>`; serializes frames as `{ kind: 'message', text, approval? }` JSON; no-ops when no connection is registered.
- `src/transport/notification-bus.ts` — small typed wrapper around Node's `EventEmitter`. Publishers call `bus.publish(event)`; senders subscribe with `bus.on('message', handler)`.

**Modified files:**

- `src/index.ts` — instantiate `bus`, create both senders, register them on the bus. Pass the bus + senders into the scheduler and bot handlers.
- `src/jobs/scheduler.ts` — accept `bus` and `senders` instead of just `bot`. Cron job functions receive the bus.
- `src/jobs/morning-prep.ts`, `src/jobs/nightly.ts`, `src/jobs/whoop-sync.ts`, `src/jobs/nudges.ts`, `src/vault/watcher.ts` — replace `bot.sendMessage(TELEGRAM_USER_ID, msg)` with `bus.publish({ userId: TELEGRAM_USER_ID, text: msg })`.
- `src/bot/handlers/text.ts`, `src/bot/handlers/url.ts`, `src/bot/handlers/photo.ts`, `src/bot/commands/*.ts`, `src/reviews/interview.ts`, `src/reviews/orchestrator.ts`, `src/reviews/{daily,weekly,monthly,quarterly,yearly,think,health,blog}.ts` — replace `bot.sendMessage(chatId, text)` with `senders.tg.send(chatId, text)` (Phase A is TG-only; sender selection happens in Phase B). Use `senders.startTyping(chatId)` / `senders.stopTyping(chatId)`.
- `src/integrations/telegram/client.ts` — unchanged; consumed by `TelegramSender`.

**Tests:**

- `src/transport/telegram-sender.test.ts` — vitest: stub `bot.sendMessage`, assert `TelegramSender.send` chunks at 4096 and respects newlines (parity with current `sendLongMessage`).
- `src/transport/notification-bus.test.ts` — vitest: publish, fan-out to multiple subscribers, one failing subscriber doesn't block the rest.
- Existing handler tests adjusted to inject a fake `MessageSender` instead of stubbing `bot.sendMessage`.

### Phase B — Webview chat surface

**New files:**

- `src/server/webview.ts`:
  - `mountWebviewRoutes(server, bus, getSenders, deps)` — wires `GET /`, `GET /static/*`, `POST /api/chat`, `WS /api/ws`, `GET /api/state` into the existing http server.
  - WS upgrade handler. Auth check (cookie or bearer). Calls `webviewSender.register(userId, ws)`. On `message` frame → calls the same dispatch entrypoint used by `handleTextMessage`. On `close` → unregisters.
- `src/server/static/index.html` — single-page shell. Auth bootstrap (read `?token=`, set cookie, redirect to `/`). Server-rendered `<meta name="obsidian-vault" content="…">`. Loads `app.js` and CDN deps (markdown-it, highlight.js).
- `src/server/static/app.js` — vanilla JS:
  - WS connect with reconnect-with-backoff.
  - Textarea with Enter = newline, Cmd/Ctrl+Enter = send.
  - In-memory ring buffer of last 20 user messages; Up-arrow on empty input → recall.
  - Markdown render via markdown-it; post-render pass for `[[wikilink]]` → `obsidian://` anchors and highlight.js on `pre code`.
  - Streaming chunk renderer: open a "tail" node, append text on each chunk, re-render markdown on the partial.
  - Auto-scroll with user-override detection.
  - Model dropdown component bound to `/opus` / `/sonnet` / `/haiku`.
- `src/server/static/app.css` — minimal stylesheet. Dark theme matching macOS dark mode by default.
- `src/server/auth.ts` — small helper: `verifyAuth(req): { ok: true; userId: number } | { ok: false }`. Reads cookie or bearer header.
- `src/server/webview-bootstrap.ts` — extracted dispatch entrypoint for inbound webview messages (calls into the same logic `handleTextMessage` uses, minus the TG-specific `msg` shape).

**Modified files:**

- `src/server/http.ts` — call `mountWebviewRoutes(server, bus, senders, …)` after the existing routes; existing endpoints stay verbatim.
- `src/transport/webview-sender.ts` — implement `register(userId, ws)` / `unregister(userId, ws)` and the per-user fan-out.
- `src/config.ts` — add `OBSIDIAN_VAULT_NAME` (default = basename of `VAULT_DIR`).
- `CLAUDE.md` — under **HTTP server** mention the new endpoints; under **Project Structure** add `src/transport/` and `src/server/static/` and `src/server/webview.ts`.

**Tests:**

- `src/server/webview.test.ts` — integration: spin up an in-process http server with a stubbed Claude CLI; POST `/api/chat`, assert response shape; open a WS, send a message frame, assert streaming chunks arrive.
- `src/server/auth.test.ts` — auth gating: 401 on missing token, 401 on wrong token, 200 on cookie + bearer, 403 on non-localhost Host.
- Manual smoke: `npm run dev`, browser to `http://127.0.0.1:3847/?token=$JARVIS_HTTP_SECRET`, exchange a message, verify rendering, wikilink click.

### Phase C — Cockpit sidebar

**New files:**

- `src/server/state-snapshot.ts` — `getStateSnapshot(deps)` returns the cockpit JSON: reads `logs/playbook-queue.json`, `logs/proposal-queue.json`, the in-memory ingestion queue (`src/kb/queue.ts`), the session map (`src/vault/sessions.ts`), the review session map (`src/reviews/session.ts`), and last-run timestamps from `logs/`.

**Modified files:**

- `src/server/webview.ts` — wire `GET /api/state` to call `getStateSnapshot`. 503 if bot not ready.
- `src/server/static/app.js` — add sidebar rendering: poll `/api/state` every 5s, diff-render five panels.
- `src/server/static/app.css` — sidebar layout (~280px right rail, scrollable when long).

**Tests:**

- `src/server/state-snapshot.test.ts` — vitest with fixture queue files; assert snapshot shape.
- Manual smoke: enqueue a fake playbook draft, watch sidebar count tick up within 5s.

### Phase D — Approval buttons + live agent-run events

**Modified files:**

- `src/reviews/interview.ts` — at approval points, call `sender.send(userId, prompt, { approval: { prompt, options } })`. Existing typed-text approval logic stays as the universal fallback.
- `src/reviews/orchestrator.ts` — same pattern wherever orchestrator-level approvals exist.
- `src/transport/webview-sender.ts` — serialize `approval` field into the WS frame.
- `src/transport/telegram-sender.ts` — ignore `approval` (text fallback).
- `src/ai/claude.ts` — instrument `runAgent`: emit `bus.publish({ kind: 'agent-start', agent, userId, runId })` and `agent-end` with duration. Emit only on calls that have a `userId` association (review-driven runs); nightly batch runs emit with `userId: TELEGRAM_USER_ID`.
- `src/server/static/app.js` — render `approval` frames as a button row; click sends a regular message frame with the option value. Subscribe to a `state` channel on the WS that pushes `agent-start`/`agent-end` events; render a "running now" panel above the recent-runs list.

**Tests:**

- `src/reviews/interview.test.ts` — assert approval emission shape.
- `src/transport/webview-sender.test.ts` — assert `approval` round-trips on the wire.
- Manual smoke: run `/weekly` from the webview, click the outline-approval button, watch the writeup phase advance.

### Coordination notes

- **Phase A is independently shippable.** Refactor only — no UI, no behavior change. Lands first; lets every later phase target the abstraction.
- **Phase B is the v1 milestone.** Chat parity with TG plus rendering + interaction wins. Cockpit and approval buttons are deferred but nothing blocks shipping B without them.
- **Phase C is read-only and decoupled.** It can ship without D.
- **Phase D is the largest cross-cutting change.** It edits review handlers and `runAgent`. Worth its own phase to bound the blast radius.
- **No new env vars required for v1** (one optional one: `OBSIDIAN_VAULT_NAME`). No new cron registrations. No new dependencies — `markdown-it` and `highlight.js` load from a CDN, no npm install.

---

## Edge Cases & Error Handling

### Auth

- **Missing or wrong bearer token on first load**: page renders a minimal "auth required — visit `/?token=$JARVIS_HTTP_SECRET`" message. No leakage of any other state.
- **Cookie expired**: not applicable in v1 — cookie has no expiry and is invalidated only by changing `JARVIS_HTTP_SECRET`.
- **Non-localhost Host header**: 403 even though the listener already binds to 127.0.0.1. Defense in depth.
- **Auth cookie present but `JARVIS_HTTP_SECRET` rotated**: cookie validation fails on every endpoint; user sees auth-required page; visits `/?token=…` again to re-bootstrap.

### Sender / bus

- **Webview WS dropped during a streaming response**: server completes the Claude call; chunks intended for the dropped WS are discarded. TG (and any other registered sender) continues to receive normally.
- **Bus publish to a sender that throws**: error is caught and logged; other senders proceed. The send doesn't bubble up to the publisher.
- **Multiple WS connections for the same user**: outbound frames fan out to all; inbound frames are processed FIFO by the shared session — the existing `sessionLocks` in `src/ai/claude.ts` prevents concurrent CLI invocations on the same session.

### Frontend

- **CDN unreachable** (markdown-it / highlight.js fail to load): chat still works with raw `<pre>`-rendered text. Rendering degrades gracefully.
- **Streaming chunk arrives out of order**: shouldn't happen on a single TCP WS, but if it does, the renderer just appends text — markdown is re-parsed on the full buffer each tick.
- **Very long messages**: no chunking on the webview side. Markdown-it handles arbitrarily long input. CSS `overflow: auto` on the chat container keeps scrolling smooth.
- **Page refresh mid-review**: chat scroll resets; sidebar repopulates from `/api/state`; the active review session is intact server-side — the next message routes to the same review handler.
- **User opens two tabs**: both register on the WS, both receive the same outbound frames. Inbound frames from either tab go to the same session. Surprising but correct.

### Cockpit

- **`logs/playbook-queue.json` missing or malformed**: snapshot returns `playbook: 0` with a `warnings` field; sidebar shows the warning subtly. No crash.
- **State snapshot is stale by up to 5s**: by design — the polling cadence is the latency floor. Live agent events (Phase D) cover the sub-5s case.
- **Sidebar polling during heavy nightly run**: snapshot reads are file I/O + map reads; no Claude CLI calls. Negligible cost.

### Review

- **Approval button click after the review has already advanced** (e.g., user clicks twice fast): the second message is just text "yes" arriving when the handler is already in writeup phase. Existing logic ignores stale yes/no inputs in non-approval phases. No special handling needed.
- **Phase D: approval signal received in webview but session was started in TG**: webview shows buttons; user clicks; the message routes to the same shared session. Works.

### Notifications

- **Cron job fires before bot ready**: existing scheduler-startup ordering already handles this. Bus subscribers register at boot before scheduler starts.
- **Outbound notification while no surface is connected**: bus fans out; TG still receives (push notifications continue to land); webview-sender no-ops. No queuing.

---

## Open Questions

- [ ] **Cookie vs URL token for WS auth.** Cookie keeps the URL clean and survives reconnects automatically. URL-query token is simpler but logs in browser history. Recommend cookie; pick during Phase B.
- [ ] **Static-asset hot reload during dev.** `tsx watch` doesn't reload static files. Probably fine — page refresh is enough — but if iteration friction shows up, add a `?cache-bust=<mtime>` to script tags.
- [ ] **`OBSIDIAN_VAULT_NAME` default.** Defaulting to `basename($VAULT_DIR)` works only if the Obsidian vault is registered with that exact name. If your registered vault name differs, set the env var explicitly. Document in CLAUDE.md.
- [ ] **Message-history persistence across refresh.** v1 says no (refresh = empty chat, session preserved). If the empty-chat-on-refresh experience is too jarring, v1.1 stores the last N exchanges per session in `logs/webview-history-<userId>.jsonl` and replays on connect.
- [ ] **Do we want a "send to TG too" hint on the webview?** Currently both surfaces always echo. If you ever want webview-only messages (e.g., debugging), add a toggle. Not in v1.
- [ ] **Approval-button signal shape — sidecar vs inline.** Sidecar (`{ text, approval }`) is cleaner; inline code-fence (`text` contains `<!--approval:…-->`) is grungier but doesn't require touching `MessageSender` typings. Recommend sidecar; pick during Phase D.
- [ ] **Agent-run event fanout granularity.** Phase D emits `agent-start`/`agent-end`. Should we also emit `agent-tool-call` (each tool the agent invokes) for deeper visibility? Costs more chatter; defer until the basic running-now indicator is in use and we know whether tool-level granularity is wanted.
- [ ] **Frontend telemetry.** Should `appendIntent()` (the existing intent-log pipeline) gain a `surface: 'tg' | 'webview'` field so we can measure adoption? Probably yes; one-line addition. Track in tasks.md.
- [ ] **Server-side rate limiting.** The webview is single-user on localhost. Rate limiting feels like overkill, but the auth endpoint that exchanges `?token=` for a cookie is the one place where a misconfigured bot or stale tab could spam. Worth a light rate cap?
- [ ] **`GET /api/state` schema versioning.** As panels evolve, the snapshot shape will change. Version the response envelope (`{ version: 1, … }`) from day one so the frontend can tolerate older servers during dev.
