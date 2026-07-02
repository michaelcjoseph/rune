# Tech Spec: Truly Parallel Product Chats

## The seam

Conversation **storage** is already correctly scoped: `sessionKey(userId, transport, scope)` produces `${transport}:${userId}` (global) and `${product}:${transport}:${userId}` (product) in `src/vault/sessions.ts:370`. Each (product, transport, user) has its own `Session` object and its own Claude session id. This layer is not touched.

Live **delivery** is keyed by `userId` alone. That mismatch is the whole bug, and it has two independent root causes.

## Root cause 1 — per-user dispatch serialization (blocks concurrency)

`src/server/webview.ts:2524-2538` chains every inbound WS turn through `dispatchQueues`, keyed by `userId`, explicitly to "serialise inbound frames for the same user." A turn for product B waits for product A's turn to fully finish.

**Fix:** re-key the queue by the session key (`sessionKey(userId, 'webview', scope)`, i.e. `${userId}:${product ?? 'global'}`). Different product chats dispatch concurrently; two turns in the same chat still serialize (the double-send guard is preserved). Safe because per-scope turns share no mutable state: separate `Session` objects, separate Claude child processes, separate session ids. The per-user queue is over-coarse, not load-bearing.

## Root cause 2 — scope-less broadcast frames (misroutes responses)

`WebviewSender.send` (`src/transport/webview-sender.ts:32-38`) emits `{kind:'message', text}` with no scope and `broadcast(userId, …)` to every socket; `startTyping`/`stopTyping`/`onOpEvent` are the same. Inbound frames carry `product` (`app.js:218`, read at `webview.ts:2523`); the response drops it. The frontend appends `message`/`chunk` frames to the active transcript (`app.js:122,140`) with no scope filter.

**Fix:**
- **Wire contract:** add `product?: string` (absent = global) to every server→browser frame — `message`, `chunk`, `status` (Phase 1) and `op-event` (Phase 2).
- **Server:** at the WS inbound handler (`webview.ts:2517`, which already has `scope`), wrap `deps.webview` in a per-turn **scoped sender** that stamps `product` on `send`/`startTyping`/`stopTyping`; pass it to `handleWebviewMessage`. Do **not** change the shared `MessageSender` interface — Telegram depends on it.
- **Frontend:** make the transcript, streaming state, and status pill **per-scope** (`app.js`, `product-deep-view.js`). Route each inbound frame by `frame.product`; buffer inactive scopes and render intact + in arrival order on switch-back; raise the unread/activity cue on the sibling product channel and the home view, clearing on view.

## Delivery model

Broadcast scope-tagged frames to all of the operator's sockets; the frontend filters by scope. Keeps a chat in sync across browser tabs. Not origin-socket-only (operator-confirmed).

## Phase 2 (separable) — op-event scope

`InFlightOp` (`src/transport/in-flight.ts:9`) carries `userId` but no scope, so op-events can't route to a panel. Add `scope`/`product`, set it at `registerOp`, threaded from the turn through the `execClaude` spawn (`src/ai/claude.ts`). `WebviewSender.onOpEvent` then stamps `product`, and the frontend attaches the "working now" pill to the correct panel. Deferrable — transcripts are correct without it.

## Verification note (why a manual release-gate is required)

The product spec's Definition of Done requires a real operator to complete the live fire-and-switch loop in the browser at least once and explicitly rejects "reachable code paths or a green test suite" as done. WS-level tests observe frame ordering, not the real DOM buffer, and jsdom client unit tests don't exercise the rendered activity cue, switch-back rendering, or rendered two-tab sync. So a designated **manual operator release-gate** is a first-class, required task (tasks.md §DoD gate), not optional polish. This is the same class of gate project 20 skipped (`live-reachability-gate`); here it is honored, and its absence is exactly why `pmReviewMatch` refused the original breakdown.
