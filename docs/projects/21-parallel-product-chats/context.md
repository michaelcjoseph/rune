# Project Context: Truly Parallel Product Chats

> Orchestration state for the `rune` project "Truly parallel product chats in the webview". Owned by Rune's context curator — roles read a bounded slice and emit handoff notes; they do not author this file directly.

## Current State

Scaffolded by hand on 2026-07-02 from the operator-approved PM spec, after the `/plan` downstream pipeline threw at the `pmReviewMatch` gate (correctly — the initial tech-lead breakdown verified the frontend only with jsdom + WS tests, which the spec's Definition of Done rejects). This scaffold folds the required manual live operator release-gate in as a first-class task. Nothing is implemented yet.

## Key Decisions

- Delivery is broadcast-to-all-sockets + frontend scope filter (cross-tab sync), not origin-socket-only (operator-confirmed).
- Session storage/keying is out of scope; it is already correctly scoped per (product, transport, user). Only dispatch and delivery change.
- No behavior change for Telegram or any transport sharing the `MessageSender` contract; per-turn scoping is done via a per-turn scoped-sender wrapper, not an interface change.
- The activity cue v1 signals "this backgrounded chat has new/finished output"; a live "working now" state is Phase 2.
- The DoD requires a real operator to complete the live fire-and-switch loop once; jsdom + WS tests are explicitly insufficient. The manual release-gate is required, not optional.

## Interfaces & Contracts

> Full contract in [tech-spec.md](tech-spec.md); bounded slice only here.

- **Dispatch** — `dispatchQueues` re-keyed `userId` → `sessionKey(userId,'webview',scope)` (`src/server/webview.ts:2524-2538`).
- **Frame contract** — `product?: string` (absent = global) on message/chunk/status (Phase 1) and op-event (Phase 2).
- **Scoped sender** — per-turn wrapper around `WebviewSender` at `webview.ts:2517`; the shared `MessageSender` interface is unchanged.
- **Frontend** — per-scope transcript/streaming/pill; route by `frame.product`; buffer inactive scopes; activity cue on sibling channel + home view.

## Known Risks

- Re-keying the dispatch queue must preserve the same-chat double-send guard (same scope still serializes).
- Broadcasting scope-tagged frames to all sockets requires the frontend to filter reliably, or a stray frame lands in the wrong panel — the §2/§3 addressing tests are the guard.
- Phase 2 op-event scoping threads through the AI call path (`execClaude`); keep it separable so Phase 1 ships without it.
- The frontend half is only fully verifiable by the manual live gate; suite-green is explicitly not "done" for it.

## Next Task Handoff

- Two product chats run concurrently; each response lands only in its own panel.
- Inactive-scope output buffers and renders intact/in-order on switch-back.
- The activity cue shows on the sibling channel + home view and clears on view.
- The manual live release-gate is completed and recorded before the project is called done.
