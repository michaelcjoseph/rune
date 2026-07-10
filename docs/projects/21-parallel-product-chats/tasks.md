# Tasks: Truly Parallel Product Chats

> Test-first per task: QA authors the tests that pin each task's contract (mirroring [test-plan.md](test-plan.md)) before the coder implements it, and every task lands green at closeout — tests are not a separate up-front task list. The manual live release-gate at the end is a required, non-automatable Definition-of-Done gate — a green suite does not satisfy it.

## Phase 1 — parallel chats + correct addressing (shippable unit)

### Implementation
- [x] **session-scope-key-helper** — Export a small `sessionKeyForScope(userId, transport, scope)` helper from `src/vault/sessions.ts` that reuses the existing session-key semantics; use it from tests and `webview.ts` so dispatch and session storage cannot drift.
- [x] **parallel-dispatch** — Re-key `dispatchQueues` (`src/server/webview.ts:2524-2538`) from `Map<number, Promise<void>>` keyed by `userId` to `Map<string, Promise<void>>` keyed by `sessionKeyForScope(userId,'webview',scope)`, so different product chats dispatch concurrently while same-chat turns stay serialized (double-send guard preserved). Global chat unchanged.
- [x] **scoped-frame-contract** — Add `product?: string` (absent = global) to turn-scoped WS frames end to end: `message`, `status`, and any `chunk` frames emitted through the WS path. Do not alter the shared `MessageSender` interface.
- [x] **scoped-sender** — At the WS inbound handler (`webview.ts:2517`), wrap `deps.webview` in a per-turn scoped sender that stamps `product` on `send`/`startTyping`/`stopTyping`; pass it to `handleWebviewMessage`. Broadcast stays all-sockets (cross-tab); scope rides on the frame. If a separate chunk emitter is introduced or discovered, stamp scope at that emission point too.
- [x] **frontend-scope-routing-buffering** — Make the webview transcript, streaming state, and status pill per-scope (`src/server/static/app.js`, `product-deep-view.js`). Route each inbound frame by `frame.product`; `app.js` renders only global frames into the global transcript, and `product-deep-view.js` updates the matching product session even when another product is active. Buffer inactive scopes and render intact + in arrival order on switch-back.
- [x] **unread-activity-cue** — Maintain browser-local per-product unread/activity state. When a backgrounded scope produces output, raise a visual cue on the sibling product channel/switcher AND in the home view; clear it when the operator views that chat. No server-persisted unread API is introduced in this phase.

## Phase 2 — live activity indicator (separable polish)

### Implementation
- [x] **op-event-scope** — Add `scope`/`product` to `InFlightOp` (`src/transport/in-flight.ts`), set at `registerOp`, threaded from the turn through `execClaude` (`src/ai/claude.ts`); `WebviewSender.onOpEvent` stamps `product`; the frontend attaches the "working now" pill to the correct panel.

## Definition-of-Done gate (required, manual/live — not automatable)
- [ ] **parallel-chat-live-release-gate** *(manual/live — not automatable)* — In the live webview with real models, an operator completes the full fire-and-switch loop once: open product chats A and B; send in A, switch to B and send **while A is still working** (B starts immediately); each response streams into its own panel with no cross-contamination; while viewing one chat, the activity cue appears on the other's channel AND in the home view, clears on view, and buffered output renders intact and in order on switch-back; the same chat still refuses a double-send and the global chat still works; open the same chat in a second tab and confirm both stay in sync at the rendered-transcript level. A green suite and reachable code paths do NOT satisfy this. Record the run in `docs/projects/21-parallel-product-chats/live-acceptance.md` with timestamp, products used, steps, and observed outcome.
