# Test Plan: Truly Parallel Product Chats

Legend: 🔴 must-pass automated · 🟡 edge/negative · 🟢 regression · 🧑 manual/live (operator).

## §1 Concurrency (dispatch)
- [ ] 🔴 The exported `sessionKeyForScope(userId, transport, scope)` helper produces distinct queue keys for global and each product scope, and the same key for repeated turns in the same scope.
- [ ] 🔴 Two product-scoped WS turns (A, B) overlap: with deferred test promises, B's dispatch begins before A's resolves.
- [ ] 🔴 Two turns in the SAME product chat serialize; the second waits for the first (double-send guard preserved).
- [ ] 🟢 Global (non-product) chat dispatch is unchanged.

## §2 Addressing (scoped frames)
- [ ] 🔴 Every outbound turn-scoped `message`/`status` frame, and any `chunk` frame entering the WS path, for a product turn carries that `product`; global turns carry no product.
- [ ] 🔴 A frame tagged product X is never delivered into product Y's or the global transcript.
- [ ] 🟢 The shared `MessageSender` interface is unchanged and Telegram behavior is unaffected (per-turn scoping is done by the wrapper, not the interface).

## §3 Frontend routing + buffering (jsdom)
- [ ] 🔴 `app.js` treats product-scoped frames as non-global and never appends them to the global transcript.
- [ ] 🔴 `product-deep-view.js` routes a `product:X` frame into X's product session while Y is the active panel.
- [ ] 🔴 Output for an inactive scope buffers and, on switch-back, renders in full and in arrival order.
- [ ] 🟡 Interleaved frames for A and B while a third scope is active each land in their own buffer.

## §4 Activity / unread cue (jsdom)
- [ ] 🔴 A backgrounded chat producing output raises the cue on the sibling channel AND in the home view.
- [ ] 🔴 The cue clears once the operator views that chat.
- [ ] 🟢 The cue is browser-local state derived from scoped frames; no server unread-state API is required or introduced.

## §5 Live acceptance (manual/operator — required by the DoD)
- [ ] 🧑 The operator completes the fire-and-switch loop once in the live webview with real models: concurrent A/B turns, per-panel streaming with no cross-contamination, the activity cue on the sibling channel + home view clearing on view, buffered switch-back rendering intact + in order, same-chat double-send refused, global chat intact, and two-tab rendered-transcript sync. Reachable code paths and a green suite explicitly do NOT satisfy this gate. Record the run in `docs/projects/21-parallel-product-chats/live-acceptance.md`.

## §6 Phase 2 op-event scope (automated + jsdom, separable)
- [ ] 🔴 Product-turn op-events carry the same `product` scope as the turn; global op-events carry no product.
- [ ] 🔴 The frontend attaches the "working now" pill to the matching product panel and never to sibling/global panels.
- [ ] 🟢 Phase 1 remains shippable if §6 is not implemented; transcripts, buffering, and unread cues are correct without op-event scope.

> Why §5 exists: §1–§4 verify frame ordering and client logic under WS/jsdom, not the real DOM buffer, the rendered activity cue, switch-back rendering, or rendered tab-sync. The product spec's Definition of Done rejects suite-green as "done" for the operator-facing behavior. §5 is the honored form of project 20's skipped `live-reachability-gate`, and the gap it covers is exactly what `pmReviewMatch` flagged when it refused the original breakdown.
