# Project Context: Truly Parallel Product Chats

> Orchestration state for the `rune` project "Truly parallel product chats in the webview". Owned by Rune's context curator — roles read a bounded slice and emit handoff notes; they do not author this file directly.

## Current State

Scaffolded by hand on 2026-07-02 from the operator-approved PM spec, after the `/plan` downstream pipeline threw at the `pmReviewMatch` gate (correctly — the initial tech-lead breakdown verified the frontend only with jsdom + WS tests, which the spec's Definition of Done rejects). This scaffold folds the required manual live operator release-gate in as a first-class task. Nothing is implemented yet.

## Key Decisions

- Delivery is broadcast-to-all-sockets + frontend scope filter (cross-tab sync), not origin-socket-only (operator-confirmed).
- Session storage/keying is out of scope; it is already correctly scoped per (product, transport, user). Only dispatch and delivery change.
- Dispatch queue keying must reuse an exported session-scope helper (`sessionKeyForScope`) rather than duplicating the private session key format in `webview.ts`.
- No behavior change for Telegram or any transport sharing the `MessageSender` contract; per-turn scoping is done via a per-turn scoped-sender wrapper, not an interface change.
- The activity cue v1 signals "this backgrounded chat has new/finished output"; a live "working now" state is Phase 2.
- The unread/activity cue is browser-local state derived from scoped frames; no server-persisted unread API is part of Phase 1.
- The WS path is the concurrency and streaming path. `/api/chat` remains a scoped final-response fallback but is outside the parallel streaming/cross-tab guarantee.
- The DoD requires a real operator to complete the live fire-and-switch loop once; jsdom + WS tests are explicitly insufficient. The manual release-gate is required, not optional.

## Interfaces & Contracts

> Full contract in [tech-spec.md](tech-spec.md); bounded slice only here.

- **Dispatch** — export `sessionKeyForScope(userId, transport, scope)` from `src/vault/sessions.ts`; `dispatchQueues` re-keyed `userId` → `sessionKeyForScope(userId,'webview',scope)` (`src/server/webview.ts:2524-2538`).
- **Frame contract** — `product?: string` (absent = global) on turn-scoped `message`/`status` frames and any `chunk` frames entering the WS path (Phase 1), plus `op-event` (Phase 2).
- **Scoped sender** — per-turn wrapper around `WebviewSender` at `webview.ts:2517`; the shared `MessageSender` interface is unchanged.
- **Frontend** — per-scope transcript/streaming/pill; `app.js` ignores product-scoped frames for the global transcript; `product-deep-view.js` routes by `frame.product` into the matching product session even while another product is active; buffer inactive scopes; browser-local activity cue on sibling channel + home view.

## Known Risks

- Re-keying the dispatch queue must preserve the same-chat double-send guard (same scope still serializes).
- The current session key helper is private; exporting a single helper is mandatory to avoid a second, subtly different queue-key format.
- Broadcasting scope-tagged frames to all sockets requires the frontend to filter reliably, or a stray frame lands in the wrong panel — the §2/§3 addressing tests are the guard.
- Local unread state means cues are per-browser-tab UI state, while transcripts stay cross-tab because scoped frames are broadcast to all sockets.
- Phase 2 op-event scoping threads through the AI call path (`execClaude`); keep it separable so Phase 1 ships without it.
- The frontend half is only fully verifiable by the manual live gate; suite-green is explicitly not "done" for it.

## Next Task Handoff

- Implemented scoped websocket dispatch queues for webview messages. Dispatch is now serialized per session scope, so turns in the same product chat stay ordered while different product chats can run in parallel.
- Exported and reused sessionKeyForScope from src/vault/sessions.ts so dispatch queue keys match session storage and parser semantics.
- Added regression coverage in src/server/webview.test.ts and src/vault/sessions.test.ts for parallel product dispatch, same-product serialization, and shared session key parsing.
- Also fixed a path-scrubbing validation blocker in src/utils/sanitize-paths.ts: worktree checkouts now scrub the owning repo path as <project> too.
- Validation passed: npm run build; npm test.
- No tests removed.
