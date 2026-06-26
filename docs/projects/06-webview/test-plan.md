# Webview Test Plan

Coverage checklist for the localhost webview chat surface, the transport abstraction it sits on, and the cockpit sidebar.

> See also: [Cross-cutting test plan](../../tech/test-plan.md) for shared guidelines, monitoring, and security checks.

## Priority Levels

- 🔴 **Critical**: Blocks user progress, requires immediate attention
- 🟡 **High**: Degrades experience significantly, should be handled gracefully
- 🟢 **Low**: Non-blocking, can fail silently with logging

## 1. Transport abstraction (Phase A)

### MessageSender parity

- [ ] 🔴 After Phase A refactor, sending a 3000-char Claude response over Telegram produces the same chunk boundaries as before (no regression in `sendLongMessage` behavior).
- [ ] 🔴 After Phase A refactor, sending a 5000-char response produces a multi-chunk send with newline-preferring splits identical to pre-refactor behavior.
- [ ] 🔴 `senders.tg.startTyping(userId)` begins the 4-second interval; `stopTyping(userId)` clears it. No leaked intervals across consecutive calls.
- [ ] 🟡 Calling `senders.send(userId, "")` (empty string) is a no-op in `TelegramSender` (matches Telegram API rejection behavior).
- [ ] 🟢 `MessageSender.name` reports `'telegram'` or `'webview'` correctly for diagnostic logging.

### Notification bus

- [ ] 🔴 `bus.publish({ userId, text })` fans out to all registered subscribers (TG + webview) in registration order.
- [ ] 🟡 A subscriber that throws inside its handler does NOT prevent the next subscriber from running; the error is logged with the subscriber's `name`.
- [ ] 🟡 Publish before any subscriber registers is silently dropped (no queuing — matches `EventEmitter` semantics).
- [ ] 🟢 A subscriber that subscribes mid-stream (e.g., webview connects after a publish) does NOT receive past messages — only future ones.

### Cron-job → bus integration

- [ ] 🔴 Morning prep delivery (`runMorningPrep`) reaches Telegram with the same message text as before the refactor.
- [ ] 🔴 Nightly summary delivery reaches Telegram with the same content.
- [ ] 🔴 Whoop sync delivery reaches Telegram with the same content.
- [ ] 🟡 Weekly nudge / review nudge messages reach Telegram on schedule.
- [ ] 🟡 Vault watcher (Readwise file detection) publishes notifications via the bus, no longer holds a direct `bot` reference.

## 2. HTTP / WebSocket server (Phase B)

### Auth gating

- [ ] 🔴 `GET /` without a `rune-auth` cookie shows the auth-required bootstrap page (not the chat shell).
- [ ] 🔴 `GET /api/state` without auth returns 401.
- [ ] 🔴 `WS /api/ws` upgrade without auth returns 401 (does not upgrade).
- [ ] 🔴 `GET /api/state` with `Authorization: Bearer $RUNE_HTTP_SECRET` returns 200.
- [ ] 🔴 `GET /api/state` with `rune-auth` cookie returns 200.
- [ ] 🔴 Any new endpoint with `Host` header (port stripped) not in `RUNE_ALLOWED_HOSTS` (default `localhost,127.0.0.1`) returns 403 (defense in depth on top of the listener binding).
- [ ] 🟡 With `RUNE_ALLOWED_HOSTS=localhost,127.0.0.1,mac-mini.tail-xxxx.ts.net`, a request whose `Host` header is `mac-mini.tail-xxxx.ts.net` is admitted; a request with `Host: evil.example.com` returns 403.
- [ ] 🟡 Host header carrying an explicit port (e.g., `localhost:3847`) is admitted (port stripped before comparison).
- [ ] 🟡 `?token=` URL handling: the token is consumed, exchanged for a cookie, and removed from the URL via redirect; reloading the page does not re-expose the token.
- [ ] 🟢 Auth failures are logged with the requesting `Host` and path (no sensitive data).

### Static-file handler

- [ ] 🔴 Path-traversal attempt (`GET /static/../../etc/passwd`) returns 400 or 404, never reads outside `src/server/static/`.
- [ ] 🟡 `GET /static/app.js` returns the file with the correct `Content-Type: application/javascript`.
- [ ] 🟡 `GET /static/app.css` returns with `Content-Type: text/css`.
- [ ] 🟢 Missing static file returns 404, not 500.

### `/api/chat` (non-streaming fallback)

- [ ] 🔴 `POST /api/chat` with valid auth and `{ message: "hello" }` returns `{ text, sessionId, model }` and creates a session in the shared map.
- [ ] 🟡 `POST /api/chat` with malformed JSON body returns 400.
- [ ] 🟡 `POST /api/chat` with `{ message: "/weekly" }` starts a review session — same as TG.

### WebSocket connect / reconnect

- [ ] 🔴 WS connects, registers under `TELEGRAM_USER_ID`, receives outbound frames immediately.
- [ ] 🔴 WS sends `{ kind: 'message', text }` → server dispatches → response frames stream back.
- [ ] 🟡 WS dropped mid-stream: server completes the Claude call; TG continues to receive; webview's chunks are discarded; no orphaned typing-indicator interval.
- [ ] 🟡 WS reconnect after drop: re-registers cleanly; sidebar polls catch up state; chat scroll is empty (no replay buffer in v1).
- [ ] 🟢 Two browser tabs open simultaneously: both register, both receive outbound frames, inbound from either routes to the same shared session.

## 3. Frontend chat surface (Phase B)

### Markdown / code rendering

- [ ] 🔴 A response containing fenced ``` ```python ``` ``` block renders as a syntax-highlighted code block via `highlight.js`.
- [ ] 🔴 A response with bold, italic, lists, and an inline link renders correctly via `markdown-it`.
- [ ] 🟡 A response with a markdown table renders as an HTML table.
- [ ] 🟢 A response with raw HTML in it does NOT execute scripts (markdown-it's default config disables inline HTML, or sanitizer is configured).

### Wikilink click-through

- [ ] 🔴 A response containing `[[Daily Note]]` renders as `<a href="obsidian://open?vault=…&file=Daily%20Note">Daily Note</a>`.
- [ ] 🔴 Clicking the wikilink launches Obsidian (manual test) — vault name resolves correctly from the `<meta name="obsidian-vault">` tag.
- [ ] 🟡 A response containing `[[Note With/Slash]]` URL-encodes the slash correctly.
- [ ] 🟢 A response containing nested-bracket text like `[[outer [[inner]]]]` renders something sensible (regex doesn't crash; inner-only or outer-only is acceptable).

### Input ergonomics

- [ ] 🔴 Cmd+Enter (Mac) sends the message; plain Enter inserts a newline.
- [ ] 🔴 Ctrl+Enter (Linux/Windows) sends the message.
- [ ] 🟡 Up-arrow on empty input recalls the previous user message; subsequent Up cycles backward; Down cycles forward.
- [ ] 🟡 Up-arrow on non-empty input does NOT trigger recall (cursor moves up in the textarea normally).
- [ ] 🟢 Pasting multi-line content into the textarea works; line breaks preserved.

### Streaming

- [ ] 🔴 During a real Claude call, tokens render token-by-token in the chat (visible incremental update — not just appearing all at once at the end).
- [ ] 🟡 Streaming markdown is re-parsed on each chunk; partial fences (e.g., an unfinished ``` ``` `python ``` `) render gracefully while streaming and resolve correctly when the closing fence arrives.
- [ ] 🟡 Highlight.js is invoked on each completed code block (post-stream); during streaming, the partial block is rendered as plain `<pre><code>` until complete.
- [ ] 🟢 Auto-scroll follows the streamed tail; if the user scrolls up mid-stream, auto-scroll suspends until they scroll back to the bottom.

### Model dropdown

- [ ] 🟡 Changing the dropdown to "Sonnet" sends `/sonnet` as the next outbound message.
- [ ] 🟡 The dropdown UI updates after the server confirms the model in the response.
- [ ] 🟢 Initial dropdown state on page load reflects the current session's model (read from `/api/state.activeSession.model`).

## 4. Shared session

- [ ] 🔴 Message sent in TG appears in the webview's chat scroll within ~1s (via the bus fan-out).
- [ ] 🔴 Message sent in webview appears in TG within ~1s.
- [ ] 🔴 A review session started in TG continues correctly when the user types in the webview (and vice versa) — there is one logical conversation.
- [ ] 🟡 Both surfaces open + user types in TG: webview's typing indicator is NOT triggered (TG-only animation), but the response IS delivered to webview when complete.
- [ ] 🟡 `/fresh` from either surface clears the shared session; the next message creates a new one.

## 5. Cockpit sidebar (Phase C)

### State snapshot

- [ ] 🟡 `GET /api/state` returns a snapshot whose `ingestionQueueDepth` matches the actual queue file length.
- [ ] 🟡 `pendingApprovals.playbook` matches the count of `status: 'pending'` entries in `logs/playbook-queue.json`.
- [ ] 🟡 `pendingApprovals.proposal` matches the count of pending entries in `logs/proposal-queue.json`.
- [ ] 🟡 `activeReview` reflects the current review session if one exists, else `null`.
- [ ] 🟡 `lastMorningPrepAt` and `lastNightlyAt` reflect actual last-run timestamps from `logs/`.
- [ ] 🟢 Malformed `logs/playbook-queue.json` returns `playbook: 0` with a warning in `warnings` rather than crashing the snapshot.

### Sidebar rendering

- [ ] 🟡 Sidebar paints all five panels on initial load (no missing panels even when zero items).
- [ ] 🟡 Sidebar diff-renders updates on the 5s poll cadence (no flicker; only changed nodes update).
- [ ] 🟢 Empty queue panels show a muted "0 pending" rather than disappearing.
- [ ] 🟢 Sidebar continues polling across browser tab idle states (visibility-change resume).

## 6. Review integration (Phase D)

### Approval buttons

- [ ] 🔴 During `/weekly` outline approval, the webview receives a frame with an `approval` sidecar and renders three buttons (yes / edit / cancel).
- [ ] 🔴 Clicking an approval button sends a regular `{ kind: 'message', text: <option.value> }` and the review handler advances correctly.
- [ ] 🔴 The same approval signal in TG renders only the prompt prose; typed `yes` / `cancel` still works as today.
- [ ] 🟡 Approval prompt during `/blog` post-draft review renders correctly with its specific options.
- [ ] 🟡 Clicking the approval button twice (fast) doesn't break the handler — second click arrives as a stray "yes" in a non-approval phase and is ignored.

### Live agent-run events

- [ ] 🔴 During `runAgent('wiki-compiler', …)`, the sidebar's "running now" indicator shows the agent name and a live elapsed timer.
- [ ] 🔴 On agent completion, the entry moves from "running now" to the top of the recent-runs list with `durationMs` and `status: 'ok'` (or `'error'`).
- [ ] 🟡 Multiple parallel agent runs (e.g., post-review fan-out) each show in "running now" simultaneously.
- [ ] 🟢 Nightly batch runs (no review attached) still emit `agent-event` frames with `userId: TELEGRAM_USER_ID` so the sidebar shows them.

## 7. Outbound notifications

- [ ] 🔴 8am morning prep: bus publishes once; both senders fan out (TG receives the message; webview, if open, receives it via WS).
- [ ] 🔴 Nightly summary: same pattern.
- [ ] 🔴 Whoop sleep + activity sync messages: same pattern.
- [ ] 🟡 Weekly review nudge (Friday): same pattern.
- [ ] 🟡 Vault watcher (new Readwise article) publishes a notification; webview shows it as a system-style message; TG receives the same.
- [ ] 🟢 Bot startup before any subscriber registers does NOT lose ordering of subsequent publishes.

## 8. Resilience

- [ ] 🔴 Server kills its child Claude process mid-stream: WS sends an end-of-stream frame with an error indicator; chat shows the error inline; sidebar's "running now" entry transitions to `status: 'error'`.
- [ ] 🟡 CDN unreachable (markdown-it / highlight.js fail to load): chat falls back to raw `<pre>` rendering; functionality preserved.
- [ ] 🟡 Browser refresh during a review: chat scroll resets; sidebar repopulates; the next message routes to the still-active review session.
- [ ] 🟡 Bot not yet ready on page load: `/api/state` returns 503 with `{ ready: false }`; sidebar shows "starting up..." banner; WS retries with backoff.
- [ ] 🟢 `RUNE_HTTP_SECRET` rotated while a tab is open: cookie validation fails on next request; tab redirects to auth-required page.

## 8.5. Remote access (Tailscale Serve, Phase B.5)

> Run on the actual headless Mac mini + laptop pair, not in CI. These verify that the **Deployment** subsection of `spec.md` works end-to-end without giving up the localhost-only listener invariant.

### Preconditions

- Mac mini has Tailscale installed and signed in; `tailscale serve --bg --https=443 http://127.0.0.1:3847` is active and `tailscale serve status` shows the `*.ts.net` origin.
- Laptop has Tailscale installed and signed in to the same tailnet.
- `.env.local` on the Mac mini contains `RUNE_ALLOWED_HOSTS=localhost,127.0.0.1,<actual-magic-dns-host>` and `RUNE_HTTP_SECRET` is set.

### Tests

- [ ] 🔴 First-load auth bootstrap: from the laptop, browse `https://<host>.tail-xxxx.ts.net/?token=$RUNE_HTTP_SECRET`. Page returns 200, redirects to `/` with the token stripped, sets the `rune-auth` cookie. DevTools shows the cookie with `Secure; HttpOnly; SameSite=Strict` (all three flags present).
- [ ] 🔴 Subsequent-visit cookie reuse: close the tab, reopen `https://<host>.tail-xxxx.ts.net/`, page loads chat shell without re-prompting for token.
- [ ] 🔴 End-to-end chat round-trip: type a message in the laptop tab; receive a streamed response identical in content to what TG would receive for the same input.
- [ ] 🔴 Localhost listener invariant intact: from another machine on the home LAN that is **not** on the tailnet, attempt `http://<mac-mini-LAN-IP>:3847/` and `http://<mac-mini-LAN-IP>:3847/api/state`. Both must fail (connection refused / unreachable). Rune must not be listening on a non-loopback interface.
- [ ] 🟡 Off-tailnet boundary: from the laptop with Tailscale toggled OFF (or via cellular), `https://<host>.tail-xxxx.ts.net/` must not resolve / not reach Rune.
- [ ] 🟡 Host-header guard rejects non-allowed origins reaching Rune: from the Mac mini itself, `curl -H "Host: evil.example.com" http://127.0.0.1:3847/api/state` returns 403; the same request with `Host: mac-mini.tail-xxxx.ts.net` returns 401 (auth required, but past the Host guard).
- [ ] 🟡 `Secure` cookie conditioning: against a local dev server reached via plain `http://localhost:3847/?token=…` (no Tailscale Serve in front), the cookie is set without `Secure` — confirming the flag is conditional on the trusted forwarded-HTTPS hop, not always-on.
- [ ] 🟡 X-Forwarded-Proto trust scoping: `curl -H "X-Forwarded-Proto: https" http://127.0.0.1:3847/api/auth-bootstrap …` from the Mac mini sets `Secure` (peer is loopback). The same header injected from the LAN (via a hypothetical second proxy) must NOT set `Secure` — the bootstrap handler only honours the header when the immediate peer is `127.0.0.1`/`::1`. Verify with a unit test in `src/server/auth.test.ts` covering both peer cases.
- [ ] 🟢 Reboot persistence: reboot the Mac mini; once Rune is back up, the laptop tab reconnects WS without re-bootstrapping auth (cookie still valid; `tailscale serve` config persists across reboots).
- [ ] 🟢 MagicDNS hostname rotation: if the user re-signs into a fresh tailnet and the MagicDNS hostname changes, updating `RUNE_ALLOWED_HOSTS` and restarting Rune is sufficient — no code change needed.

## 9. Documentation parity

- [ ] 🟡 After Phase B ships, `CLAUDE.md` Project Structure includes `src/transport/`, `src/server/static/`, `src/server/webview.ts`, `src/server/auth.ts`.
- [ ] 🟡 After Phase B ships, `CLAUDE.md` Architecture mentions the webview as a second transport sharing session via `TELEGRAM_USER_ID`.
- [ ] 🟡 `OBSIDIAN_VAULT_NAME` is documented in `CLAUDE.md` Environment Variables (optional, with default).
- [ ] 🟡 `RUNE_ALLOWED_HOSTS` is documented in `CLAUDE.md` Environment Variables alongside `RUNE_HTTP_SECRET`, with the headless-Mac-mini Tailscale Serve example.
- [ ] 🟢 `docs/projects/index.md` row for `06-webview` reflects the current shipped phase (`Spec` → `In Progress` → `Done`).
- [ ] 🟡 After Phase E ships, `CLAUDE.md` Architecture has a "Mutation pipeline" subsection covering `MutationDescriptor`, `MutationApplier`, `logs/mutations.jsonl`, and the registered kinds (`work-run` implemented; others reserved).
- [ ] 🟡 After Phase E ships, `CLAUDE.md` Project Structure includes `src/transport/mutations.ts`, `src/jobs/work-runner.ts`, `src/jobs/mutations-log.ts`, `src/server/projects-snapshot.ts`.
- [ ] 🟡 After Phase E ships, `CLAUDE.md` HTTP server lists `POST /api/mutations`, `GET /api/mutations`, `POST /api/mutations/:id/cancel`.

## 10. Mutation pipeline & `/work --auto` runner (Phase E)

### Mutation lifecycle

- [ ] 🔴 `POST /api/mutations` with `{ kind: 'work-run', payload: { projectSlug } }` and valid auth creates a descriptor with `status: 'running'` (because `autoApprove: true`), appends a row to `logs/mutations.jsonl`, and returns 200 with the descriptor JSON.
- [ ] 🔴 `POST /api/mutations` with an invalid payload (e.g., missing `projectSlug` or non-existent slug) returns 400 with the applier's `validate` reason as `{ error: <reason> }`.
- [ ] 🔴 `POST /api/mutations` with an unknown `kind` returns 400 `{ error: 'unknown mutation kind: <kind>' }`.
- [ ] 🔴 `POST /api/mutations` without auth returns 401.
- [ ] 🔴 A descriptor that completes successfully transitions `running` → `completed` and appends a final JSONL line with `status: 'completed'` and `durationMs`.
- [ ] 🟡 A descriptor whose applier yields `failed` transitions `running` → `failed` with the `error` field set; the JSONL final line carries the same.
- [ ] 🟢 Two consecutive `POST /api/mutations` calls produce monotonically increasing `id` values (ulid sort order).

### WorkRun execution

- [ ] 🔴 `WorkRunApplier.apply` spawns `claude` with `--add-dir docs/projects/<slug>/`, `cwd: PROJECT_ROOT`, and a `-p` prompt that contains the project's `spec.md` and `tasks.md` text plus the literal `/work --auto` invocation.
- [ ] 🔴 The spawned child is registered in `src/ai/claude.ts`'s `activeProcesses` set; SIGTERM via `killActiveProcesses()` (server shutdown path) terminates it cleanly.
- [ ] 🔴 Stdout chunks are line-buffered and yielded as `MutationEvent { kind: 'output', data: { line } }`; the WS receives `{ kind: 'mutation-event', subKind: 'output', mutationId, ts, data }` frames.
- [ ] 🔴 Exit code 0 yields `{ kind: 'completed', data: { exitCode: 0, durationMs } }` and transitions descriptor status to `completed`.
- [ ] 🔴 Exit code non-zero yields `{ kind: 'failed', data: { exitCode, durationMs, error } }` and transitions to `failed`.
- [ ] 🔴 `POST /api/mutations/:id/cancel` SIGTERMs the child within 5s; descriptor transitions to `failed` with `reason: 'cancelled'`.
- [ ] 🟡 A second `POST /api/mutations` for the same `projectSlug` while the first is `running` is rejected by `validate` with `reason: 'already running for <slug>'`; returns 400.
- [ ] 🟡 A third concurrent `work-run` across distinct projects is rejected when `WORK_RUN_GLOBAL_CAP = 2` with `reason: 'global concurrency cap reached'`.
- [ ] 🟢 Stderr lines yield `{ kind: 'log', data: { line, stream: 'stderr' } }` and do not flip status.
- [ ] 🟢 `claude` not in PATH at spawn time produces a `failed` event with `reason: 'claude CLI not found'` (ENOENT-shaped error caught in spawn `error` handler).

### Project dashboard

- [ ] 🟡 `getProjectSummaries()` returns one entry per `docs/projects/<slug>/spec.md` row in `index.md`; rows missing a corresponding directory are skipped.
- [ ] 🟡 Progress count matches a manual count of `- [ ]` + `- [x]` lines in `tasks.md` for a representative project (e.g., `06-webview` itself).
- [ ] 🟡 Status pill text matches the cell in the `index.md` table verbatim (`Done`, `Spec`, `In Progress`).
- [ ] 🟢 Missing `tasks.md` produces `progress: { done: 0, total: 0 }` and a `warnings` entry; the panel renders "—" rather than crashing.
- [ ] 🟢 Per-phase progress (`perPhase`) is populated when `tasks.md` contains `## Phase …` headers; otherwise it is omitted.

### Webview UI

- [ ] 🔴 Clicking "Run /work --auto" on a project row opens the confirmation modal with the slug in the prompt.
- [ ] 🔴 Clicking `Run` in the modal POSTs `/api/mutations` with the correct `kind` and `payload`; clicking `Cancel` closes the modal without a network call.
- [ ] 🔴 The run-detail drawer opens on click of an active or recent mutation row and renders streaming `output` events live.
- [ ] 🟡 The active mutation's elapsed timer in the cockpit panel updates each second.
- [ ] 🟡 The "Run /work --auto" button is disabled (and shows "Running…") for any project with a `running` mutation; re-enables on terminal status.
- [ ] 🟡 The drawer's Cancel button calls `POST /api/mutations/:id/cancel`; the drawer's status indicator updates within 5s.
- [ ] 🟢 Status pill colors render correctly (Done = green, Spec = grey, In Progress = blue, Failed = red) in cross-browser smoke (Safari + Chrome).

### Resilience

- [ ] 🔴 Server shutdown mid-run: `killActiveProcesses()` SIGTERMs `claude` children; `waitForActiveProcesses()` lets them exit; on next boot, `reconcileOrphans()` flips any `running` descriptor in the JSONL to `failed` with `reason: 'orphaned'`.
- [ ] 🟡 Two browser tabs both clicking Run within the same second: the second POST returns 400 with `'already running for <slug>'`; UI surfaces the error inline and re-syncs to the active run on next state poll.
- [ ] 🟡 Cancellation race (cancel arrives in same tick as `completed`): `cancelMutation` returns 409; UI re-syncs to terminal state on next poll.
- [ ] 🟡 `logs/mutations.jsonl` corrupt line: reader skips with a warning and a byte-offset log entry; subsequent lines parse correctly; snapshot's `warnings` carries the count.
- [ ] 🟢 Bus publishes `mutation-event` while no WS connection registered: drop silently (no error; no replay buffer); persisted JSONL is the source of truth for late-joiners.

### Telegram fallback

- [ ] 🟡 During a `/work --auto` run, TG receives exactly two messages — one on `completed` (✅ summary with duration) or one on `failed` (❌ summary with reason). No `output` / `progress` / `log` flood.
- [ ] 🟢 TG message format: `✅ /work --auto on <slug> finished in <duration>` or `❌ /work --auto on <slug> failed: <reason>`.
