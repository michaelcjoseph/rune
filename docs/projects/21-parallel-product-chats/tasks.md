# Tasks: Truly Parallel Product Chats

> Test-first. Each phase opens by writing the tests that mirror [test-plan.md](test-plan.md), confirming red, then implementing. The manual live release-gate at the end is a required, non-automatable Definition-of-Done gate — a green suite does not satisfy it.

## Phase 1 — parallel chats + correct addressing (shippable unit)

### Tests first
- [ ] Write the test suite for **parallel-dispatch** — two product-scoped WS turns overlap (not queued); same-product turns serialize. test-plan.md §1.
- [ ] Write the test suite for **scoped-frames** — every outbound frame (message/chunk/status) carries the correct `product`; a frame for X never routes to Y; the shared `MessageSender` interface is unchanged. test-plan.md §2.
- [ ] Write the test suite for **frontend-routing-buffering** (jsdom) — a `product:X` frame renders into X's transcript while Y is active; inactive-scope output buffers and replays intact + in order on switch-back. test-plan.md §3.
- [ ] Write the test suite for **unread-activity-cue** (jsdom) — a backgrounded chat producing output raises the cue on the sibling channel and in the home view; the cue clears on view. test-plan.md §4.
- [ ] Confirm red before implementation.

### Implementation
- [ ] **parallel-dispatch** — Re-key `dispatchQueues` (`src/server/webview.ts:2524-2538`) from `userId` to `sessionKey(userId,'webview',scope)`, so different product chats dispatch concurrently while same-chat turns stay serialized (double-send guard preserved). Global chat unchanged.
- [ ] **scoped-frame-contract** — Add `product?: string` (absent = global) to the message/chunk/status WS frames, end to end, without altering the shared `MessageSender` interface.
- [ ] **scoped-sender** — At the WS inbound handler (`webview.ts:2517`), wrap `deps.webview` in a per-turn scoped sender that stamps `product` on `send`/`startTyping`/`stopTyping`; pass it to `handleWebviewMessage`. Broadcast stays all-sockets (cross-tab); scope rides on the frame.
- [ ] **frontend-scope-routing-buffering** — Make the webview transcript, streaming state, and status pill per-scope (`src/server/static/app.js`, `product-deep-view.js`). Route each inbound frame by `frame.product`; buffer inactive scopes and render intact + in arrival order on switch-back.
- [ ] **unread-activity-cue** — When a backgrounded scope produces output, raise a visual cue on the sibling product channel/switcher AND in the home view; clear it when the operator views that chat.

## Phase 2 — live activity indicator (separable polish)
- [ ] **op-event-scope** — Add `scope`/`product` to `InFlightOp` (`src/transport/in-flight.ts`), set at `registerOp`, threaded from the turn through `execClaude` (`src/ai/claude.ts`); `WebviewSender.onOpEvent` stamps `product`; the frontend attaches the "working now" pill to the correct panel.

## Definition-of-Done gate (required, manual/live — not automatable)
- [ ] **parallel-chat-live-release-gate** *(manual/live — not automatable)* — In the live webview with real models, an operator completes the full fire-and-switch loop once: open product chats A and B; send in A, switch to B and send **while A is still working** (B starts immediately); each response streams into its own panel with no cross-contamination; while viewing one chat, the activity cue appears on the other's channel AND in the home view, clears on view, and buffered output renders intact and in order on switch-back; the same chat still refuses a double-send and the global chat still works; open the same chat in a second tab and confirm both stay in sync at the rendered-transcript level. A green suite and reachable code paths do NOT satisfy this. Record the run as the acceptance artifact.
