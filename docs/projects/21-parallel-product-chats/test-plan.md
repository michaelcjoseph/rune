# Test Plan: Truly Parallel Product Chats

Legend: 🔴 must-pass automated · 🟡 edge/negative · 🟢 regression · 🧑 manual/live (operator).

## §1 Concurrency (dispatch)
- [ ] 🔴 Two product-scoped WS turns (A, B) overlap: B's dispatch begins before A's resolves.
- [ ] 🔴 Two turns in the SAME product chat serialize; the second waits for the first (double-send guard preserved).
- [ ] 🟢 Global (non-product) chat dispatch is unchanged.

## §2 Addressing (scoped frames)
- [ ] 🔴 Every outbound frame (message/chunk/status) for a product turn carries that `product`; global turns carry no product.
- [ ] 🔴 A frame tagged product X is never delivered into product Y's or the global transcript.
- [ ] 🟢 The shared `MessageSender` interface is unchanged and Telegram behavior is unaffected (per-turn scoping is done by the wrapper, not the interface).

## §3 Frontend routing + buffering (jsdom)
- [ ] 🔴 A `product:X` frame renders into X's transcript while Y is the active panel.
- [ ] 🔴 Output for an inactive scope buffers and, on switch-back, renders in full and in arrival order.
- [ ] 🟡 Interleaved frames for A and B while a third scope is active each land in their own buffer.

## §4 Activity / unread cue (jsdom)
- [ ] 🔴 A backgrounded chat producing output raises the cue on the sibling channel AND in the home view.
- [ ] 🔴 The cue clears once the operator views that chat.

## §5 Live acceptance (manual/operator — required by the DoD)
- [ ] 🧑 The operator completes the fire-and-switch loop once in the live webview with real models: concurrent A/B turns, per-panel streaming with no cross-contamination, the activity cue on the sibling channel + home view clearing on view, buffered switch-back rendering intact + in order, same-chat double-send refused, global chat intact, and two-tab rendered-transcript sync. Reachable code paths and a green suite explicitly do NOT satisfy this gate. Record the run.

> Why §5 exists: §1–§4 verify frame ordering and client logic under WS/jsdom, not the real DOM buffer, the rendered activity cue, switch-back rendering, or rendered tab-sync. The product spec's Definition of Done rejects suite-green as "done" for the operator-facing behavior. §5 is the honored form of project 20's skipped `live-reachability-gate`, and the gap it covers is exactly what `pmReviewMatch` flagged when it refused the original breakdown.
