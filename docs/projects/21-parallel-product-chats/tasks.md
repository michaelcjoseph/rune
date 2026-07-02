# Tasks: Truly Parallel Product Chats

> Test-first. Each phase opens by writing the tests that mirror [test-plan.md](test-plan.md), confirming red, then implementing. The manual live release-gate at the end is a required, non-automatable Definition-of-Done gate — a green suite does not satisfy it.

## Phase 1 — parallel chats + correct addressing (shippable unit)

### Tests first
- [ ] Write the test suite for **parallel-dispatch** — a shared exported session-scope key helper distinguishes global/product scopes; two product-scoped WS turns overlap using deferred promises (not clocks); same-product turns serialize. test-plan.md §1.
- [ ] Write the test suite for **scoped-frames** — every outbound turn-scoped `message`/`status` frame, and any `chunk` frame entering the WS path, carries the correct `product`; a frame for X never routes to Y; the shared `MessageSender` interface is unchanged. test-plan.md §2.
- [ ] Write the test suite for **frontend-routing-buffering** (jsdom) — `app.js` ignores product-scoped frames for the global transcript; `product-deep-view.js` routes `product:X` frames into X even while Y is active; inactive-scope output buffers and replays intact + in order on switch-back. test-plan.md §3.
- [ ] Write the test suite for **unread-activity-cue** (jsdom) — browser-local unread/activity state raises the cue on the sibling channel and in the home view when a backgrounded chat produces output; the cue clears on view. test-plan.md §4.
- [ ] Confirm red before implementation.

### Implementation
- [ ] **session-scope-key-helper** — Export a small `sessionKeyForScope(userId, transport, scope)` helper from `src/vault/sessions.ts` that reuses the existing session-key semantics; use it from tests and `webview.ts` so dispatch and session storage cannot drift.
- [ ] **parallel-dispatch** — Re-key `dispatchQueues` (`src/server/webview.ts:2524-2538`) from `Map<number, Promise<void>>` keyed by `userId` to `Map<string, Promise<void>>` keyed by `sessionKeyForScope(userId,'webview',scope)`, so different product chats dispatch concurrently while same-chat turns stay serialized (double-send guard preserved). Global chat unchanged.
- [ ] **scoped-frame-contract** — Add `product?: string` (absent = global) to turn-scoped WS frames end to end: `message`, `status`, and any `chunk` frames emitted through the WS path. Do not alter the shared `MessageSender` interface.
- [ ] **scoped-sender** — At the WS inbound handler (`webview.ts:2517`), wrap `deps.webview` in a per-turn scoped sender that stamps `product` on `send`/`startTyping`/`stopTyping`; pass it to `handleWebviewMessage`. Broadcast stays all-sockets (cross-tab); scope rides on the frame. If a separate chunk emitter is introduced or discovered, stamp scope at that emission point too.
- [ ] **frontend-scope-routing-buffering** — Make the webview transcript, streaming state, and status pill per-scope (`src/server/static/app.js`, `product-deep-view.js`). Route each inbound frame by `frame.product`; `app.js` renders only global frames into the global transcript, and `product-deep-view.js` updates the matching product session even when another product is active. Buffer inactive scopes and render intact + in arrival order on switch-back.
- [ ] **unread-activity-cue** — Maintain browser-local per-product unread/activity state. When a backgrounded scope produces output, raise a visual cue on the sibling product channel/switcher AND in the home view; clear it when the operator views that chat. No server-persisted unread API is introduced in this phase.

## Phase 2 — live activity indicator (separable polish)

### Tests first
- [ ] Write the test suite for **op-event-scope** — op-events carry product scope for product turns, no product for global turns, and the frontend attaches the "working now" pill to the matching product panel without polluting siblings. Confirm red before implementation.

### Implementation
- [ ] **op-event-scope** — Add `scope`/`product` to `InFlightOp` (`src/transport/in-flight.ts`), set at `registerOp`, threaded from the turn through `execClaude` (`src/ai/claude.ts`); `WebviewSender.onOpEvent` stamps `product`; the frontend attaches the "working now" pill to the correct panel.

## Definition-of-Done gate (required, manual/live — not automatable)
- [ ] **parallel-chat-live-release-gate** *(manual/live — not automatable)* — In the live webview with real models, an operator completes the full fire-and-switch loop once: open product chats A and B; send in A, switch to B and send **while A is still working** (B starts immediately); each response streams into its own panel with no cross-contamination; while viewing one chat, the activity cue appears on the other's channel AND in the home view, clears on view, and buffered output renders intact and in order on switch-back; the same chat still refuses a double-send and the global chat still works; open the same chat in a second tab and confirm both stay in sync at the rendered-transcript level. A green suite and reachable code paths do NOT satisfy this. Record the run in `docs/projects/21-parallel-product-chats/live-acceptance.md` with timestamp, products used, steps, and observed outcome.
