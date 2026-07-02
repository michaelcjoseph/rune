# Truly Parallel Product Chats

## Product Value

The operator runs several product chats at once. Send a turn in product A, switch to B and send there while A is still working, and each response streams into its own panel with zero cross-contamination and no waiting on the other chat. Today the webview forces a fire-and-wait workflow: a turn in B is blocked behind A's turn, and a reply can even land in the wrong panel. This feature turns the webview into a real parallel workspace — fire in one chat, switch, fire in another, and track them independently.

## Goals

1. **Concurrent turns across products.** A turn in product B does not wait on a turn in product A. Different product chats make progress at the same time.
2. **Correct addressing.** Every response lands in the panel that owns it. No reply from A ever appears in B's transcript.
3. **Legible parallel state.** When output streams into a panel the operator is not currently viewing, it is buffered and shown intact on switch-back, and the operator is told — without switching — that the other chat has something new. The whole point is fire-and-switch, so the operator must know when a backgrounded chat has produced output.
4. **Same-chat safety preserved.** Two turns in the *same* product chat still serialize; the existing single-chat double-send guard stays intact.
5. **Global chat unaffected.** The non-product (global) chat continues to work exactly as before.
6. **Cross-tab sync.** If the operator has a chat open in more than one browser tab, all tabs for that chat stay in sync.

## Requirements

### Concurrency
- Turns for different product chats dispatch and run in parallel; one product's turn never blocks another's.
- Turns within a single product chat remain serialized in order; the operator cannot double-send the same chat.
- The global chat behaves as it does today.

### Addressing & routing
- Every turn-scoped response/status frame the operator receives carries the product scope it belongs to (global = no product scope). Any streaming `chunk` frames that enter the WS delivery path carry the same scope.
- The frontend routes each frame to the transcript for its scope. A frame for product X is never appended to product Y's or the global transcript.

### Buffering & switch-back
- Output that arrives for a scope the operator is not currently viewing is buffered in order and rendered in full when the operator switches to that scope.
- Buffered output preserves the order it streamed in.

### Activity / unread cue
- When a backgrounded product chat produces new output, the operator sees a visual cue in **two** places without switching to that chat:
  - on the other product's channel/switcher entry, and
  - in the home view (the main product-list/landing surface).
- The cue clears for a chat once the operator views that chat.
- The cue is browser-local UI state derived from scoped frames; it does not require a new persisted server/API state.

### Delivery model
- Responses are delivered by broadcasting scope-tagged frames to all of the operator's connected sockets, with the frontend filtering by scope. This keeps a chat consistent across multiple browser tabs. Delivery is not restricted to the origin socket.
- The WebSocket path is the concurrency and streaming path. The `/api/chat` REST fallback remains a scoped final-response fallback, but it is not required to provide parallel streaming or cross-tab synchronization.

## Non-Goals

- No new Telegram command or Telegram-facing behavior change.
- No change to the shared message-sender contract that Telegram also depends on. Per-turn product scoping must not alter behavior for other transports.
- No change to how sessions are stored or keyed; the session store is already correctly scoped per (product, transport, user).
- Not a redesign of the chat UI beyond the panels, routing, buffering, and the activity cue described above.
- A live "still thinking / working now" indicator on a backgrounded panel is a **later enhancement**, not part of the core ship (see Phasing).

## Phasing

**Phase 1 — delivers the feature.** Parallel dispatch across product chats; scope-tagged response frames; frontend routing, buffering, and switch-back; broadcast delivery of scope-tagged frames to all of the operator's connected sockets so a chat stays in sync across browser tabs; the unread/new-output activity cue on the sibling product channel and in the home view; same-chat serialization preserved; global chat preserved. This phase is the shippable unit and satisfies the definition of done.

**Phase 2 — separable polish.** A live activity/"working" indicator that reflects a backgrounded chat that is *currently* generating (not just "has new output"), attached to the correct panel. Deferrable without blocking Phase 1.

## Definition of Done

In production, the operator:

1. Opens two different product chats (A and B).
2. Sends a turn in A, switches to B, and sends a turn in B **while A is still working** — B's turn starts immediately, without waiting for A to finish.
3. Sees each response stream into its own panel, with no output from A appearing in B or vice versa.
4. While viewing one chat, sees the activity cue appear on the other product's channel **and** in the home view when that other chat produces output; the cue clears when they switch to it, and the buffered output is shown intact and in order.
5. Confirms the same product chat still refuses a double-send, and the global chat still works.
6. Opens the same product chat in a second browser tab and confirms both tabs stay in sync — a turn sent or a response streamed in one tab appears in the other.

Done is the operator completing this real fire-and-switch loop against live product chats at least once — not merely that the code paths are reachable or the test suite is green.

## Assumptions

1. Delivery model is broadcast-to-all-sockets-and-filter-in-frontend (cross-tab sync), not origin-socket-only. Flagged as settled in the brief; the operator confirmed it.
2. The activity cue in v1 signals "this backgrounded chat has new/finished output" (derivable from buffered frames arriving on an inactive scope). A live "currently working" state is Phase 2.
3. "Home view" means the webview's main product-list/landing surface where the operator picks or overviews product chats.
4. The activity cue clears for a given chat once the operator views that chat.
5. Buffered output for an inactive scope is replayed in the order it streamed.
6. Session storage/keying is out of scope because it is already correctly scoped per (product, transport, user); only dispatch and delivery change.
7. No behavior change for Telegram or any other transport that shares the message-sender contract.
8. Dispatch queue keys must reuse an exported session-scope helper from the session layer, not duplicate a hand-written key format in `webview.ts`.
9. The manual acceptance run is recorded in `docs/projects/21-parallel-product-chats/live-acceptance.md`.

## Provenance

Scaffolded by hand on 2026-07-02 from the operator-approved PM spec. The `/plan` downstream pipeline threw at the `pmReviewMatch` gate — correctly: the initial tech-lead breakdown verified the frontend only with WS-level and jsdom client tests, which this spec's Definition of Done explicitly rejects as "done." This scaffold folds the required manual live operator release-gate in as a first-class task (see tasks.md §DoD gate). The two failure-handling defects that made that pipeline throw silent and unrecoverable are filed in [bugs.md](../bugs.md).
