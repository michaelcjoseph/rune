# Webview Specification

## Overview

Today, the only way to talk to Rune is Telegram. TG desktop is fine for chat — but it has hard limits that the rest of Rune doesn't: messages are chunked at 4096 chars (`src/integrations/telegram/client.ts`), code blocks render as plain monospace, `[[wikilinks]]` are dead text, and there is no view into Rune's internal state — the ingestion queue, pending playbook drafts, recent agent runs, the active review phase. All of that lives in JSON files under `logs/` or in in-memory maps and only surfaces if you remember to ask.

This project adds a localhost webview at `http://127.0.0.1:3847/` that talks to Rune through the existing single-process server. It is not a replacement for Telegram — TG remains the cross-device fallback — it is a richer desktop surface that **shares the same session** as TG via `TELEGRAM_USER_ID`. A message sent in either surface persists in the same Claude session; outbound notifications (morning prep, nightly summary, Whoop, nudges) fan out to both. The webview adds rendering fidelity (markdown, code highlight, wikilink click-through to Obsidian, streaming responses), interaction polish (multi-line input + Cmd+Enter, up-arrow recall, model dropdown), and a light cockpit sidebar that surfaces queues, recent agent runs, and pending approvals so internal state is ambient instead of hidden.

The implementation reuses the existing skill registry, resolver, review orchestrator, and Claude CLI plumbing without modification. The only structural change is a new `MessageSender` abstraction that sits between handlers/jobs and the wire — `TelegramSender` keeps current behavior, `WebviewSender` is the new transport — plus a `NotificationBus` that cron jobs publish to instead of holding a `bot` reference.

Phase E extends the webview from a read-mostly chat surface into a chat-driven *self-update* surface. A typed mutation pipeline (`MutationDescriptor` + `MutationApplier` registry) lets the webview drive Rune end-to-end actions without a review session in the loop — the first concrete applier is a `/work --auto` runner that picks any project under `docs/projects/*`, spawns Claude Code with the project's `spec.md`/`tasks.md` as context, and streams output back into the webview live. The pipeline is designed to absorb later mutation kinds (project-spec edits, proposal-queue approvals, agent-file edits, cron toggles) without each one re-inventing its own endpoint, persistence, or fan-out.

### Core Value Proposition

A localhost browser surface that shares a single conversation with Telegram, renders Claude's output the way it deserves to be rendered, and turns Rune's internal state into ambient signal — without forking the bot, replacing TG, or adding any infrastructure beyond a new endpoint on the existing http server.

### Goals

1. **Primary:** A vanilla-HTML webview chat surface served from `src/server/http.ts` at `http://127.0.0.1:3847/` that reaches feature parity with the Telegram bot — slash commands, conversation sessions, review sessions — sharing the same session map keyed by `TELEGRAM_USER_ID`.
2. **Secondary:** Rendering and interaction wins that TG cannot offer: client-side markdown rendering with code-block syntax highlighting, `[[wikilink]]` anchors that open Obsidian via `obsidian://`, streaming responses chunk-by-chunk over WebSocket, a multi-line textarea with Cmd+Enter to send, up-arrow recall of the previous message, and a model indicator + dropdown (Opus/Sonnet/Haiku) bound to the existing `/opus`-`/sonnet`-`/haiku` handlers.
3. **Tertiary:** A light cockpit sidebar (~280px) showing live state from existing JSON files and in-memory maps: active conversation/review session, ingestion queue depth, last 10 agent runs, pending playbook + proposal approvals, last morning-prep + nightly run timestamps. Polled via `GET /api/state` every 5s.
4. **Quaternary:** Approval buttons for review-session prompts (`/weekly` outline approval, `/blog` post drafts, etc.) plus live agent-run events streamed over the WebSocket into the sidebar's "running now" indicator. Achieved by emitting structured signals from `src/reviews/interview.ts` and instrumenting `runAgent()` in `src/ai/claude.ts` with bus events.
5. **Quinary:** A typed mutation pipeline that lets the webview drive Rune self-update from chat. Phase E ships the framework (`MutationDescriptor` + `MutationApplier` registry, `logs/mutations.jsonl` persistence, `mutation-event` bus channel) plus a `/work --auto` runner that executes any Rune dev project under `docs/projects/*` end-to-end. A new "Projects" cockpit panel surfaces status (from `index.md`) and progress (derived from `tasks.md` checkboxes) and exposes a per-project "Run /work --auto" button. Future mutation kinds (project-spec edits, proposal approvals, agent-file edits, cron toggles) plug into the registry without new endpoints.

### Non-Goals

- **Replacing Telegram.** TG remains the cross-device + mobile fallback. The webview is a desktop-only complement, not a migration.
- **Mobile-responsive UI.** v1 is laptop/desktop only. If you need to chat from the couch, use TG.
- **Multi-user support.** Rune is single-user. Auth is one shared bearer token (`RUNE_HTTP_SECRET`); session is keyed off `TELEGRAM_USER_ID`. Non-goal even at v2.
- **Voice / audio messages.** No transcription pipeline today; not adding one.
- **Browser push notifications outside the open tab.** Outbound notifications still go to TG (which has its own push); the webview only sees them when the tab is open and the WebSocket is connected. If you want a push from your laptop, TG desktop already does that.
- **Vault file browser.** Tempting, but a slippery slope toward duplicating Obsidian. Wikilinks resolve to Obsidian; we don't host the file viewer.
- **Message-history persistence across page refresh.** v1: refresh = empty chat, but the underlying Claude session is preserved (next message resumes). Adding a server-side message log is deferred to v1.1.
- **LAN access from the phone, or any off-tailnet device.** Listener stays bound to `127.0.0.1`. Laptop access in a headless Mac mini deployment is supported via a Tailscale Serve front-end that terminates TLS on the tailnet edge and proxies to `127.0.0.1:3847` (see **Deployment** below). Off-tailnet exposure — public internet, cellular, an arbitrary LAN device — would require real auth (not just a shared secret) and is out of scope.
- **Frontend build pipeline.** No Vite, no React, no node_modules for the frontend. `markdown-it` and `highlight.js` load from a CDN; everything else is hand-written HTML/JS/CSS.
- **Editing arbitrary vault files from the webview.** The Phase E mutation pipeline only writes through registered `MutationApplier` handlers; nothing writes outside what an applier declares as its target. No generic "edit any file" surface in v1.
- **Replacing the review-time post-agents.** `proposal-updater`, `project-updater`, `playbook-updater`, `worldview-updater`, `psychology-updater`, `json-updater`, `daily-content-updater` continue to run after reviews exactly as today. Phase E is a parallel surface for chat-driven mutations, not a migration of the review pipeline.
- **Multi-project coordinated `/work --auto` runs.** v1 caps concurrency at one `work-run` per project and two across all projects. Cross-project orchestration (dependency-ordered runs, fan-out) is out of scope.

### Scale Considerations

- **Connection count:** single user, typically one tab. Occasionally two (one tab per device, or a stale tab). The WS handler must tolerate multiple connections claiming the same `TELEGRAM_USER_ID` — fan out to all, but process inbound frames serially through the shared session.
- **Backlog while disconnected:** outbound bus fan-out to a disconnected webview is dropped (TG still gets it). When the tab reconnects, sidebar polls catch up the cockpit; chat history starts fresh. No server-side replay buffer in v1.
- **Bandwidth:** localhost. Free.
- **Static-asset size:** `index.html` + `app.js` + `app.css` aim for <50KB total before CDN deps. CDN deps add ~150KB of JS for `markdown-it` + `highlight.js`. Cached after first load.
- **No new env vars beyond `RUNE_HTTP_SECRET`** (already exists). One new optional config: `OBSIDIAN_VAULT_NAME` for building the `obsidian://` URI; defaults to the basename of `VAULT_DIR`.

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

### Happy Path — `/work --auto` from the projects panel (Phase E)

```
User opens the webview. Cockpit's "Projects" panel lists docs/projects/*
with status pills (Done / Spec / In Progress) and progress bars derived
from each tasks.md checkbox count.
         ↓
User clicks "Run /work --auto" on, say, 04-custom-workouts.
         ↓
Webview shows a one-shot confirmation modal:
  "Run /work --auto on 04-custom-workouts? Edits + commits without
   further confirmation. [Run] [Cancel]"
         ↓
User clicks Run. Frontend POSTs /api/mutations with
  { kind: 'work-run', payload: { projectSlug: '04-custom-workouts' } }.
         ↓
WorkRunApplier.validate passes (project exists, no other run for it,
under global concurrency cap). Server creates a MutationDescriptor,
appends it to logs/mutations.jsonl with status: 'running', and spawns
  claude --add-dir docs/projects/04-custom-workouts/
         -p '<spec.md + tasks.md + invoke /work --auto>'
from PROJECT_ROOT. Child registers in src/ai/claude.ts's activeProcesses.
         ↓
A run drawer slides open in the webview showing live stdout. The
"Mutations" cockpit panel shows the run under "Active" with a live
elapsed timer and the tail of the most recent output line.
         ↓
Stdout chunks publish on the bus as { kind: 'mutation-event', subKind:
'output', mutationId, data } and fan out to the webview WS as frames.
TG receives a single short text-fallback line ("started /work --auto for
04-custom-workouts") and stays quiet during the run.
         ↓
Claude Code finishes. Exit code 0 → applier emits 'completed';
status flips to 'completed' in the descriptor, the JSONL log gets a
final line, and the mutation moves from "Active" to "Recent" in the
cockpit. TG receives a one-line completion summary.
         ↓
User opens the project repo: a feature branch (work/04-custom-workouts-
<ts>) holds Claude's commits; tasks.md checkboxes reflect what /work
ticked off. User reviews, merges, deletes the branch. Project dashboard
status pill flips to "In Progress" or "Done" on next /api/state poll.
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

- **Browser**: `http://127.0.0.1:3847/`. Auth handled on first load via `RUNE_HTTP_SECRET` query param (`/?token=…`) which the page exchanges for a `rune-auth` cookie. Subsequent visits re-use the cookie.
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
| Frontend stack | **Vanilla HTML/JS/CSS**, served from `src/server/static/`. `markdown-it` + `highlight.js` from a CDN. No build step, no `node_modules` for the frontend. Matches Rune's no-build-step ethos. |
| Session key | Webview uses `TELEGRAM_USER_ID` as the `chatId` so the existing session map is shared verbatim. No schema change to `src/vault/sessions.ts`. |
| Auth | Shared bearer (`RUNE_HTTP_SECRET`). On first load, client supplies it as `?token=…`; server sets a `rune-auth` cookie (HttpOnly, SameSite=Strict). Cookie is checked on `/api/*` and the WS upgrade. Localhost + single-user — sufficient. |
| Listener binding | Stays at `127.0.0.1:3847` always — Rune itself never binds to a public interface. For the headless Mac mini deployment, a Tailscale Serve front-end terminates TLS at `https://<host>.tail-xxxx.ts.net` and proxies to `127.0.0.1:3847`; the laptop hits the tailnet origin. See **Deployment** below. |
| Cockpit data delivery | `GET /api/state` polled every 5s for the snapshot panels. Live agent-run events streamed over the WS as a separate frame `kind` (Phase D). Two channels because the snapshot is cheap and the live stream needs sub-second latency. |
| Approval-button signal shape | Sidecar field on the WS frame: `{ kind: 'message', text, approval?: { prompt, options } }`. Webview renders buttons when `approval` is present; TG ignores it (text fallback). |
| Static-asset hosting | Files on disk under `src/server/static/`, served by a small static-file handler in `src/server/webview.ts`. Path-traversal guard. Hot edit during dev = page refresh, no restart. |
| Wikilink resolution | Client-side regex in the markdown renderer. `[[Note Title]]` → `<a href="obsidian://open?vault=<OBSIDIAN_VAULT_NAME>&file=Note%20Title">Note Title</a>`. Vault name passed once on page load via a `<meta>` tag populated server-side from `OBSIDIAN_VAULT_NAME` env (default = `basename($VAULT_DIR)`). |
| Slash-command parity | No special-casing. Webview sends `{ kind: 'message', text: '/journal foo' }`; server routes through the same `handleTextMessage` switch chain as TG. |
| Model dropdown | Bound to existing `/opus` / `/sonnet` / `/haiku` handlers — selecting "Sonnet" sends `/sonnet` as the next message. No new server logic. |
| Mutation pipeline shape (Phase E) | Typed `MutationDescriptor { id, kind, source, target, preview, payload, createdAt, status }` + `MutationApplier { kind, autoApprove, validate, apply }` registry. `apply` returns an async iterable of `MutationEvent`s. Outbound events ride the existing `NotificationBus` as a new `'mutation-event'` kind so `WebviewSender` fans them out as `{ kind: 'mutation-event', … }` frames; `TelegramSender` receives a short text-fallback summary on `completed`/`failed` only. Persistent log: `logs/mutations.jsonl` (append-only). Active mutations held in an in-memory `Map<id, RunHandle>` for cancellation. v1 ships only the `work-run` applier; `project-edit` / `proposal-action` / `agent-edit` / `cron-toggle` are reserved kinds for later phases. |
| `/work --auto` runner spawn pattern (Phase E) | `claude --add-dir docs/projects/<slug>/ -p '<spec.md + tasks.md + invoke /work --auto>'` from `PROJECT_ROOT`. Reuses `src/ai/claude.ts`'s `activeProcesses` set and `waitForActiveProcesses()` so SIGTERM on shutdown is already handled. Stdout streamed line-buffered as `output` mutation events; exit 0 → `completed`, non-zero → `failed`. `autoApprove: true` (no server-side confirmation gate); the webview still shows a one-shot client-side modal to prevent stray clicks. Concurrency cap: one `work-run` per project, two across all projects (constants in `src/config.ts`). |
| Project dashboard source of truth (Phase E) | Status read from the `docs/projects/index.md` table cell. Progress derived from each `docs/projects/<slug>/tasks.md` by counting `- [x]` (done) vs total `- [ ]` + `- [x]`, grouped by `## Phase …` headers when present. No separate JSON store, no schema migration — the markdown is the schema. Spec link points at `obsidian://open?vault=<OBSIDIAN_VAULT_NAME>&file=docs/projects/<slug>/spec.md` when the vault registers the file, otherwise a plain file path. |

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
13. WHEN any `/api/*` endpoint or WS upgrade receives a request without a valid `rune-auth` cookie or `Authorization: Bearer <RUNE_HTTP_SECRET>` header THEN it returns 401.
14. WHEN any new endpoint receives a request whose `Host` header (port stripped) is not in `RUNE_ALLOWED_HOSTS` (default `localhost,127.0.0.1`) THEN it returns 403 (defense in depth on top of the listener binding). The allowlist is configurable so a Tailscale Serve front-end's MagicDNS hostname can be admitted in a headless Mac mini deployment without binding Rune to a public interface.
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

### Mutation pipeline (Phase E)

39. WHEN a client `POST`s `/api/mutations` with `{ kind, payload }` and valid auth THEN the server resolves the registered `MutationApplier` for `kind`, calls `validate(payload)`, and returns 400 `{ error: <reason> }` on validation failure.
40. WHEN validation passes THEN the server constructs a `MutationDescriptor` with `id` (ulid), `createdAt`, `source: 'webview'`, `status: 'pending'`, appends it to `logs/mutations.jsonl`, and returns 200 with the descriptor JSON.
41. WHEN the descriptor's `kind` has `autoApprove: true` THEN the server transitions `status: 'running'` immediately, calls `applier.apply(descriptor, ctx)`, and begins consuming the resulting `AsyncIterable<MutationEvent>`.
42. WHEN a `MutationEvent` is yielded THEN the server publishes `{ kind: 'mutation-event', mutationId, subKind, ts, data }` on the `NotificationBus`; `WebviewSender` forwards to all WS connections for `TELEGRAM_USER_ID`; `TelegramSender` ignores `output` / `progress` / `log` and emits a short text summary only on `completed` / `failed`.
43. WHEN the applier yields its terminal event (`completed` or `failed`) THEN the server appends a final JSONL line with the resolved `status` and any `error` field, removes the entry from the in-memory active map, and stops fan-out for that `mutationId`.
44. WHEN a client `GET`s `/api/mutations` with valid auth THEN the server returns `{ active: MutationDescriptor[], recent: MutationDescriptor[] }` where `recent` is the last 50 terminal entries from `logs/mutations.jsonl`.
45. WHEN a client `POST`s `/api/mutations/:id/cancel` with valid auth THEN the server looks up the in-memory `RunHandle`, sends `SIGTERM` to the child, and the applier transitions `status: 'failed'` with `reason: 'cancelled'` on the next event tick. Cancelling an already-terminal mutation returns 409.
46. WHEN the bus publishes a `'mutation-event'` to a `WebviewSender` with no registered WS connection THEN the event is dropped (no replay buffer); the persisted JSONL log is the source of truth for late-joiners.
47. WHEN the server shuts down with active mutations THEN existing `killActiveProcesses()` + `waitForActiveProcesses()` paths in `src/ai/claude.ts` SIGTERM the children; on next boot, any descriptor still in `'running'` status is reconciled to `'failed'` with `reason: 'orphaned'` during startup recovery.
48. WHEN `getStateSnapshot()` is called THEN its returned object includes `mutations: { active, recent }` mirroring the `/api/mutations` shape, so the cockpit can render without a separate fetch.
49. WHEN `logs/mutations.jsonl` cannot be read or parsed THEN the affected line is skipped with a warning logged; subsequent lines are still consumed and the snapshot's `warnings` field surfaces the count.
50. WHEN no `MutationApplier` is registered for the requested `kind` THEN `POST /api/mutations` returns 400 `{ error: 'unknown mutation kind: <kind>' }`.

### Project dashboard (Phase E)

51. WHEN `getStateSnapshot()` is called THEN it includes a `projects: ProjectSummary[]` field where each entry has `{ slug, status, progress: { done, total, perPhase? }, specPath, lastModified }`.
52. WHEN parsing `docs/projects/index.md` THEN the table is read with the column order `Project | Status | Description`; rows whose first column does not match a `docs/projects/<slug>/spec.md` file are skipped.
53. WHEN parsing a `tasks.md` THEN every `- [ ]` and `- [x]` line is counted; checkboxes nested under blockquote (`>`) lines are still counted; lines containing only commentary (no checkbox) are ignored.
54. WHEN the `tasks.md` file is missing or malformed THEN the entry's `progress` is `{ done: 0, total: 0 }` and `warnings` carries a per-project entry; the panel renders a "—" placeholder.
55. WHEN the cockpit's Projects panel renders a row THEN it displays the slug, status pill, progress as `<done>/<total>` plus a thin progress bar, a spec link (resolved via `obsidian://` when `OBSIDIAN_VAULT_NAME` is set), and a "Run /work --auto" button.

### `/work --auto` runner (Phase E)

56. WHEN `WorkRunApplier.validate({ projectSlug })` is called THEN it returns `ok: false` if `docs/projects/<slug>/` does not exist, `spec.md` is missing, another `work-run` for the same slug is already in `running` status, or the global cap (default 2) is reached.
57. WHEN `WorkRunApplier.apply` runs THEN it spawns `claude` with `--add-dir docs/projects/<slug>/`, cwd = `PROJECT_ROOT`, and a `-p` prompt that concatenates the project's `spec.md` + `tasks.md` and ends with the literal `/work --auto` invocation; the spawned child is registered in `src/ai/claude.ts`'s `activeProcesses` set.
58. WHEN the child writes to stdout THEN each newline-delimited chunk is yielded as a `MutationEvent` `{ kind: 'output', data: { line } }`; stderr is yielded as `{ kind: 'log', data: { line, stream: 'stderr' } }`.
59. WHEN the child exits with code `0` THEN the applier yields `{ kind: 'completed', data: { exitCode: 0, durationMs } }`; non-zero exit yields `{ kind: 'failed', data: { exitCode, durationMs, error } }`. SIGTERM (code 143 or `signal: 'SIGTERM'`) is treated as `failed` with `reason: 'cancelled'` if the cancellation endpoint was called, else `'killed'`.
60. WHEN two webview tabs both POST a `work-run` for the same project within the same second THEN the first wins; the second's `validate` fails with `reason: 'already running for <slug>'`.
61. WHEN the cockpit's "Run /work --auto" button is clicked THEN the frontend renders a confirmation modal with the slug, the spawn command summary, and `[Run] [Cancel]`; only `Run` triggers `POST /api/mutations`. The modal is a UI affordance only; server-side `autoApprove: true` is unchanged.
62. WHEN a `work-run` mutation is `running` THEN the corresponding project row's button is disabled and shows "Running…" until the descriptor transitions to a terminal status.

### Remote access (deployment)

63. WHEN the auth-bootstrap handler sets the `rune-auth` cookie THEN it sets `Secure` iff the request arrived with `X-Forwarded-Proto: https` AND the immediate peer (`req.socket.remoteAddress`) is `127.0.0.1` / `::1`. `HttpOnly` and `SameSite=Strict` are set unconditionally. Trusting `X-Forwarded-Proto` from any other peer would be a header-spoofing bug, so the proxy hop is only honoured for the localhost-loopback case (which is exactly the Tailscale Serve topology).
64. WHEN `RUNE_ALLOWED_HOSTS` is parsed at startup THEN the value is split on commas, each entry is trimmed and lower-cased, and the result is held as a `Set<string>` queried by the Host-header guard (requirement 14). An empty / unset env var falls back to `localhost,127.0.0.1`.
65. WHEN deploying behind Tailscale THEN the only supported front-end is `tailscale serve` bound to the tailnet. `tailscale funnel` (which publishes the origin to the public internet) is forbidden — it would bypass the tailnet trust boundary on which the single-shared-secret auth model depends. Verification at deploy time: `tailscale serve status` must show only `serve` entries, never `funnel`, and `lsof -iTCP:3847 -sTCP:LISTEN` must show only loopback (`127.0.0.1` / `::1`) for the Rune process.

---

## Deployment

### Headless Mac mini + laptop access (Tailscale Serve)

Goal: reach the webview from a laptop while Rune runs unattended on a Mac mini, without giving up the localhost-only listener binding and without standing up real OAuth.

**Why Tailscale Serve specifically:** Rune stays bound to `127.0.0.1`, so even if the macOS application firewall is off, port 3847 remains unreachable from the home LAN. Tailscale Serve listens on its own tailnet-only socket at `https://<host>.tail-xxxx.ts.net:443` and proxies inbound traffic to `127.0.0.1:3847` over the loopback interface on the same host. Port 3847 is never exposed beyond loopback — only members of the tailnet can reach the proxy, and only the proxy can reach port 3847. The wire between laptop and Mac mini is encrypted by WireGuard, and the browser hop is HTTPS, which lets the auth cookie carry the `Secure` flag.

**`tailscale serve` vs `tailscale funnel`:** Use `tailscale serve` only. `tailscale funnel` publishes the same origin to the public internet via Tailscale's edge infrastructure — that would bypass the tailnet trust boundary on which the single-shared-secret auth model depends and is explicitly out of scope for this deployment (see requirement 65 and "What's out of scope" below).

**On the Mac mini (one-time setup):**

```sh
brew install --cask tailscale
open -a Tailscale            # sign in to your tailnet
tailscale serve --bg --https=443 http://127.0.0.1:3847
```

Confirm the published origin with `tailscale serve status`.

**Configure Rune (`.env.local`):**

```
RUNE_ALLOWED_HOSTS=localhost,127.0.0.1,mac-mini.tail-xxxx.ts.net
```

(Replace `mac-mini.tail-xxxx.ts.net` with the actual MagicDNS name from `tailscale status`. Anything not in this list is rejected by requirement 14.)

**On the laptop:** install Tailscale, sign in to the same tailnet. First load: `https://mac-mini.tail-xxxx.ts.net/?token=<RUNE_HTTP_SECRET>` — the page exchanges the token for the `rune-auth` cookie (set with `Secure; HttpOnly; SameSite=Strict` because the request arrived over forwarded HTTPS from `127.0.0.1`). Subsequent visits drop the `?token` query.

**What stays the same:**

- Rune binds to `127.0.0.1:3847`. No code path opens a public listener.
- Auth is still the single shared `RUNE_HTTP_SECRET`; the tailnet is the trust boundary, the cookie is the session-level convenience.
- `requirement 14` (Host-header allowlist) enforces the tailnet hostname at the application layer in addition to the bind.

**Verification (run on the Mac mini after first setup):**

- `lsof -iTCP:3847 -sTCP:LISTEN` lists only `127.0.0.1` (and/or `::1`) — never `*`, a LAN address, or a tailnet address. If 3847 is bound externally, the listener invariant has been broken.
- `tailscale serve status` shows a single `serve` entry mapping `https://<host>.tail-xxxx.ts.net` → `http://127.0.0.1:3847`, with no `funnel` entry.

**What's out of scope here:**

- `tailscale funnel` — would expose the origin to the public internet, bypassing the tailnet trust boundary. Forbidden by requirement 65.
- Daemonising Rune itself on Mac mini boot (`launchd` plist) — separate concern; `tailscale serve --bg` already persists across reboots.
- Off-tailnet access (cellular, public internet, an arbitrary LAN device) — needs real auth, deliberately deferred.
- Self-signed certs / a local reverse proxy (nginx/Caddy) — Tailscale Serve already terminates TLS with a real `*.ts.net` cert.

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
- Manual smoke: `npm run dev`, browser to `http://127.0.0.1:3847/?token=$RUNE_HTTP_SECRET`, exchange a message, verify rendering, wikilink click.

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

### Phase E — Mutation pipeline + project dashboard + `/work --auto` runner

**New files:**

- `src/transport/mutations.ts`:
  ```typescript
  export type MutationKind = 'work-run' | 'project-edit' | 'proposal-action' | 'agent-edit' | 'cron-toggle';
  export type MutationStatus = 'pending' | 'approved' | 'running' | 'completed' | 'failed' | 'rejected';
  export interface MutationDescriptor<P = Record<string, unknown>> {
    id: string;
    kind: MutationKind;
    source: 'webview' | 'review' | 'cron' | 'cli';
    target: { type: string; ref: string };
    preview: { summary: string; details?: string };
    payload: P;
    createdAt: string;
    status: MutationStatus;
    error?: string;
  }
  export interface MutationEvent {
    mutationId: string;
    ts: string;
    kind: 'log' | 'progress' | 'output' | 'completed' | 'failed';
    data?: unknown;
  }
  export interface MutationApplier<P = Record<string, unknown>> {
    kind: MutationKind;
    autoApprove: boolean;
    validate(payload: P): { ok: true } | { ok: false; reason: string };
    apply(descriptor: MutationDescriptor<P>, ctx: ApplyContext): AsyncIterable<MutationEvent>;
  }
  export function registerApplier<P>(applier: MutationApplier<P>): void;
  export function getApplier(kind: MutationKind): MutationApplier | undefined;
  ```
  Plus `createMutation(kind, payload, source)` (validates + persists + starts apply when `autoApprove`), `cancelMutation(id)` (SIGTERM + status flip), and an in-memory `Map<id, RunHandle>` for active runs.
- `src/jobs/mutations-log.ts` — append-only `logs/mutations.jsonl` reader/writer. `appendMutationLine(descriptor)`, `readRecentMutations(n)`, `reconcileOrphans()` (called on boot to flip stale `running` rows to `failed` with `reason: 'orphaned'`).
- `src/jobs/work-runner.ts` — exports `workRunApplier: MutationApplier<{ projectSlug: string }>`. Implements `validate` (project dir + concurrency cap) and `apply` (spawn `claude` per the Architecture Decisions row, stream stdout/stderr as events). Reuses `activeProcesses` and `waitForActiveProcesses` from `src/ai/claude.ts` for graceful shutdown. Constants `WORK_RUN_PER_PROJECT_CAP = 1` and `WORK_RUN_GLOBAL_CAP = 2` live in `src/config.ts`.
- `src/server/projects-snapshot.ts` — `getProjectSummaries()` parses `docs/projects/index.md` + each `tasks.md`, returns `ProjectSummary[]`.

**Modified files:**

- `src/transport/notification-bus.ts` — extend the event union to include `'mutation-event'` alongside the existing `'message'` and Phase D `'agent-event'` kinds.
- `src/transport/webview-sender.ts` — forward `'mutation-event'` bus messages to connected WS as `{ kind: 'mutation-event', … }` frames; do not register them as send-failures when no WS is connected (drop silently).
- `src/transport/telegram-sender.ts` — on `'mutation-event'` with `subKind: 'completed' | 'failed'`, send a one-line text summary (`✅ /work --auto on <slug> finished in <duration>` / `❌ /work --auto on <slug> failed: <reason>`); ignore `output` / `progress` / `log` to avoid TG message floods.
- `src/server/webview.ts` — add three routes: `POST /api/mutations`, `GET /api/mutations`, `POST /api/mutations/:id/cancel`. All inherit the existing auth + non-localhost guard.
- `src/server/state-snapshot.ts` — add `projects: getProjectSummaries()` and `mutations: { active, recent: readRecentMutations(50) }` to the snapshot.
- `src/server/static/app.js` — add Projects cockpit panel (row per project, status pill, progress bar, "Run /work --auto" button); add Mutations cockpit panel (Active + Recent); add a slide-in run-detail drawer that subscribes to `mutation-event` frames matching its `mutationId`; add a confirmation modal for `work-run` clicks; reuse Phase D's chunk-render plumbing for the drawer's streaming output.
- `src/server/static/app.css` — drawer slide-in transition, modal overlay, progress bar, status pill colors (Done = green, Spec = grey, In Progress = blue, Failed = red).
- `src/config.ts` — add `WORK_RUN_PER_PROJECT_CAP` (default 1) and `WORK_RUN_GLOBAL_CAP` (default 2).
- `src/index.ts` — at boot, `registerApplier(workRunApplier)` and `reconcileOrphans()` before the bot starts polling.
- `CLAUDE.md` — new "Mutation pipeline" subsection under **Architecture**; **Project Structure** entries for `src/transport/mutations.ts`, `src/jobs/work-runner.ts`, `src/jobs/mutations-log.ts`, `src/server/projects-snapshot.ts`; **HTTP server** entries for the three new routes.

**Tests:**

- `src/transport/mutations.test.ts` — vitest: descriptor lifecycle (`pending` → `running` → `completed`), unknown-kind rejection, applier validation failures, cancellation flips status to `failed` with `reason: 'cancelled'`.
- `src/jobs/mutations-log.test.ts` — vitest: append, read recent, skip corrupt line with warning, `reconcileOrphans()` rewrites stale `running` rows.
- `src/jobs/work-runner.test.ts` — vitest with stubbed `spawn`: spawn args include `--add-dir` and `cwd: PROJECT_ROOT`, stdout chunks become `output` events, exit 0 → `completed`, exit non-zero → `failed`, second concurrent run for same slug rejected.
- `src/server/projects-snapshot.test.ts` — vitest with fixture `index.md` + per-project `tasks.md`: progress count matches manual count, missing `tasks.md` produces `—` placeholder, malformed table cell does not crash.
- `src/server/webview.test.ts` (extend) — `POST /api/mutations` with valid `work-run` payload returns 200 + descriptor; with invalid `kind` returns 400; `POST /api/mutations/:id/cancel` SIGTERMs within 5s in an integration smoke; `GET /api/mutations` returns active + recent.
- Manual smoke: create a throwaway `docs/projects/99-sandbox/spec.md` with a trivial "create a hello.txt" task; click Run; watch streaming output; confirm `hello.txt` exists on a `work/99-sandbox-<ts>` branch.

### Coordination notes

- **Phase A is independently shippable.** Refactor only — no UI, no behavior change. Lands first; lets every later phase target the abstraction.
- **Phase B is the v1 milestone.** Chat parity with TG plus rendering + interaction wins. Cockpit and approval buttons are deferred but nothing blocks shipping B without them.
- **Phase C is read-only and decoupled.** It can ship without D.
- **Phase D is the largest cross-cutting change.** It edits review handlers and `runAgent`. Worth its own phase to bound the blast radius.
- **Phase E builds on C + D.** It needs the snapshot infrastructure from C (extends it with `projects` and `mutations`) and the bus event-fan-out plumbing from D (adds a third event kind alongside `message` and `agent-event`). It does not touch review handlers, which keeps the review-time post-agent path untouched.
- **No new env vars required for v1** (one optional one: `OBSIDIAN_VAULT_NAME`). No new cron registrations. No new dependencies — `markdown-it` and `highlight.js` load from a CDN, no npm install.

---

## Edge Cases & Error Handling

### Auth

- **Missing or wrong bearer token on first load**: page renders a minimal "auth required — visit `/?token=$RUNE_HTTP_SECRET`" message. No leakage of any other state.
- **Cookie expired**: not applicable in v1 — cookie has no expiry and is invalidated only by changing `RUNE_HTTP_SECRET`.
- **Non-localhost Host header**: 403 even though the listener already binds to 127.0.0.1. Defense in depth.
- **Auth cookie present but `RUNE_HTTP_SECRET` rotated**: cookie validation fails on every endpoint; user sees auth-required page; visits `/?token=…` again to re-bootstrap.

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

### Mutations (Phase E)

- **Child process killed by the OS** (e.g., laptop sleeps and macOS reaps the `claude` child): the close handler fires with a non-zero exit; applier emits `failed` with `reason: 'killed'`; status reconciles correctly. No orphan in the active map because `close` always fires.
- **`claude` CLI not in PATH at spawn time**: `spawn` emits `error` event (ENOENT). Applier yields `failed` with `reason: 'claude CLI not found'`. The cockpit shows the failed mutation with a hint pointing at the install URL. Subsequent runs are not blocked — `validate` does not pre-check PATH (the spawn is the source of truth).
- **`tasks.md` malformed for a project**: `getProjectSummaries()` skips the bad file with a per-project warning; the panel renders the project row with `progress: —` rather than crashing the snapshot. Other projects remain visible.
- **Two browser tabs both clicking "Run" within the same second**: both POSTs hit the server; the first creates the descriptor and starts running; the second's `validate` fails with `reason: 'already running for <slug>'` and returns 400. The second tab's UI shows the error inline; refresh re-syncs to the active run.
- **Server shutdown mid-run**: `killActiveProcesses()` SIGTERMs the `claude` child (already wired); `waitForActiveProcesses()` lets it exit cleanly; the descriptor's last logged status remains `running`. On next boot, `reconcileOrphans()` flips it to `failed` with `reason: 'orphaned'` and surfaces it in the recent list.
- **`logs/mutations.jsonl` corrupt line**: reader skips the line, logs a warning with the byte offset, and continues. Snapshot's `warnings` field carries a count so the UI can surface it.
- **Cancellation race**: user clicks cancel in the same tick the applier yields `completed`. `cancelMutation(id)` returns 409 (`mutation already terminal`); the UI re-syncs to the terminal state on the next state-snapshot poll.
- **TG receives a flood of mutations**: `TelegramSender` only sends on `completed`/`failed`, never on `output` / `progress` / `log`, so a verbose `/work --auto` run produces exactly two TG messages.

---

## Open Questions

- [ ] **Cookie vs URL token for WS auth.** Cookie keeps the URL clean and survives reconnects automatically. URL-query token is simpler but logs in browser history. Recommend cookie; pick during Phase B.
- [ ] **Static-asset hot reload during dev.** `node --watch` doesn't reload static files. Probably fine — page refresh is enough — but if iteration friction shows up, add a `?cache-bust=<mtime>` to script tags.
- [ ] **`OBSIDIAN_VAULT_NAME` default.** Defaulting to `basename($VAULT_DIR)` works only if the Obsidian vault is registered with that exact name. If your registered vault name differs, set the env var explicitly. Document in CLAUDE.md.
- [ ] **Message-history persistence across refresh.** v1 says no (refresh = empty chat, session preserved). If the empty-chat-on-refresh experience is too jarring, v1.1 stores the last N exchanges per session in `logs/webview-history-<userId>.jsonl` and replays on connect.
- [ ] **Do we want a "send to TG too" hint on the webview?** Currently both surfaces always echo. If you ever want webview-only messages (e.g., debugging), add a toggle. Not in v1.
- [ ] **Approval-button signal shape — sidecar vs inline.** Sidecar (`{ text, approval }`) is cleaner; inline code-fence (`text` contains `<!--approval:…-->`) is grungier but doesn't require touching `MessageSender` typings. Recommend sidecar; pick during Phase D.
- [ ] **Agent-run event fanout granularity.** Phase D emits `agent-start`/`agent-end`. Should we also emit `agent-tool-call` (each tool the agent invokes) for deeper visibility? Costs more chatter; defer until the basic running-now indicator is in use and we know whether tool-level granularity is wanted.
- [ ] **Frontend telemetry.** Should `appendIntent()` (the existing intent-log pipeline) gain a `surface: 'tg' | 'webview'` field so we can measure adoption? Probably yes; one-line addition. Track in tasks.md.
- [ ] **Server-side rate limiting.** The webview is single-user on localhost. Rate limiting feels like overkill, but the auth endpoint that exchanges `?token=` for a cookie is the one place where a misconfigured bot or stale tab could spam. Worth a light rate cap?
- [ ] **`GET /api/state` schema versioning.** As panels evolve, the snapshot shape will change. Version the response envelope (`{ version: 1, … }`) from day one so the frontend can tolerate older servers during dev.
- [ ] **(Phase E) Branching strategy for `/work --auto`.** Should the runner create a `work/<slug>-<ts>` branch off `main` before invoking `/work --auto`, then return to `main` on completion? Strong lean toward yes — keeps `main` clean if `/work` writes anything controversial — but the `/work` skill itself may already do this. Confirm during Phase E kickoff; if the skill handles branching, the runner stays a thin spawn.
- [ ] **(Phase E) Per-project lockfile vs in-memory only.** The concurrency cap currently lives in the in-memory active map. Single-process Rune is fine. If we ever run two Rune instances against the same repo (HA, dev + prod side-by-side), an `flock`-based lockfile under `logs/work-locks/<slug>` becomes necessary. Defer until that happens.
- [ ] **(Phase E) `tasks.md` checkbox feedback.** When `/work --auto` ticks off boxes mid-run, does it commit them, leave them dirty, or write to a separate progress log? Probably the `/work` skill handles its own progress-tracking semantics; Rune stays out of it. Surface a clear note in CLAUDE.md once observed behavior is confirmed.
- [ ] **(Phase E) Vault life projects in the dashboard.** `projects/*.md` (life projects) have a different schema and don't have a `/work --auto` story. UI shape supports a second tab cleanly if we later want to surface them; deferred for v1 to avoid muddying the "dev project" mental model.
- [ ] **(Phase E) Browseable mutation history.** Cockpit shows last 50 from `logs/mutations.jsonl`. If the user wants to scroll deeper, a paged `/api/mutations?cursor=<id>&limit=50` endpoint plus an "All mutations" view would land. Defer until last-50 feels insufficient.
- [ ] **(Phase E) Future mutation kinds.** `project-edit` (inline spec edits), `proposal-action` (approve/reject queued proposals from chat without a review session), `agent-edit` (modify `.claude/agents/*.md`), `cron-toggle` (enable/disable scheduled jobs) are all listed in the `MutationKind` enum but not implemented. Each is a follow-on project that plugs into the existing pipeline. Sketch the rough design + risks for each before opening the next webview project.
