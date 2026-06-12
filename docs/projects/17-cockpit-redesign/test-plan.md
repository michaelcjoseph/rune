# Cockpit Redesign — Surface Rethink (Workstream A) Test Plan

Error handling checklist for the two-tier dev cockpit: a cross-product Home pulse, a
per-product deep view, the realtime run feed, the Fix gate, and per-product chat/search.

This project is **test-first**: each numbered section below is written by a phase's
**Tests (write first)** task in [tasks.md](tasks.md), and those tests must fail (red)
before that phase's implementation tasks begin. A phase's implementation is done when its
test-plan sections pass.

> See also: [Cross-cutting test plan](../../tech/test-plan.md) for shared guidelines, monitoring, and security checks.

## Priority Levels

- 🔴 **Critical**: Blocks user progress, requires immediate attention
- 🟡 **High**: Degrades experience significantly, should be handled gracefully
- 🟢 **Low**: Non-blocking, can fail silently with logging

## 1. Data Contracts (HomePulse + ProductDeepView)

### Projections

- [ ] 🔴 `buildHomePulse` aggregates active-run status, open counts, backlog warnings, most-recent-run classified outcome, and attention signals per product from registry + supervision-store + work-run-store + backlog-reader without owning state.
- [ ] 🔴 `buildHomePulse` returns an explicit unavailable shape when the registry cannot be read, rather than throwing or returning a blank success.
- [ ] 🔴 A most-recent run reports its truthful classified outcome (completed / no-op / partial / failed / parked) and never reads a no-op or dirty run as success.
- [ ] 🟡 A store-read failure for one product degrades that product's card rather than failing the whole pulse.
- [ ] 🟡 `buildProductDeepView` returns the graceful `repoBacked:false` limited shape for a not-repo-backed product instead of throwing.
- [ ] 🟢 Projections are pure — given fixture stores they produce deterministic output with no I/O.

### Endpoints

- [ ] 🔴 `GET /api/products/:product` for an unknown product returns a typed 404 envelope (not a crash or 500).
- [ ] 🔴 `GET /api/products/:product` for a not-repo-backed product returns 200 with the limited shape, while backlog-specific endpoints keep their existing 409 behavior.
- [ ] 🟡 `GET /api/home` returns the full cross-product pulse; `/api/cockpit` stays alive during the transition.
- [ ] 🔴 `GET /api/home` and `GET /api/products/:product` reject unauthenticated requests (existing cookie auth + host guard).
- [ ] 🟢 Invalid product slug is VALID_SLUG-guarded at the route boundary.

## 2. Realtime Run Feed

### Event publish

- [ ] 🔴 Live run events (task-tally transitions, agents-on-run, log-tail, elapsed/state) publish onto the NotificationBus → webview-sender path during an active run.
- [ ] 🔴 `BusRunEvent` / `run-event` is a first-class typed bus/websocket frame, wired through `notification-bus.ts`, `sender.ts`, `webview-sender.ts`, and the client parser.
- [ ] 🔴 A run-feed publish failure does not affect `/work` run execution or finalization (surface plumbing is isolated).
- [ ] 🔴 Live log-tail lines are redacted with the persisted transcript display path before crossing the WebSocket.
- [ ] 🟡 An agent/Claude CLI failure mid-run surfaces as the run's classified outcome, not a swallowed event.

### Live snapshot

- [ ] 🔴 `GET /api/work-runs/:id/live` returns a snapshot (tasks N/M, active agents, elapsed, worktree path, last log lines) that rehydrates a mid-run reload.
- [ ] 🔴 The snapshot is reconstructable from transcript + supervision on cold start (no transcript ⇒ typed empty/404, never a blank hang).
- [ ] 🟡 A reconnecting subscription client rehydrates from `/live` and resumes event consumption without duplicate task transitions.
- [ ] 🟡 `GET /api/work-runs/:id/live` rejects unauthenticated requests, matching the transcript route.
- [ ] 🟢 Unknown run id on `/live` returns a typed 404.

## 3. Fix Gate

### Gate decision

- [ ] 🔴 `evaluateBugFixGate(facts)` is fail-closed and fact-ordered: a missing/ambiguous fact declines rather than proceeds.
- [ ] 🔴 An unparseable PM or Tech-Lead reply declines the gate with a reason instead of proceeding to a fix run.
- [ ] 🟡 `pm-techlead-bug-scoping` produces `BugScopingFacts` from the real PM + Tech-Lead role seams (no stubbed gate decision).

### Action states + endpoint

- [ ] 🔴 `POST /api/backlog/:product/items/:id/fix` validates, persists `gating`, returns `202 {attemptId}` immediately, and drives the real gate async to a real recorded decision: declined-with-reason OR proceeding — never a fabricated synchronous result.
- [ ] 🔴 The fix endpoint rejects unauthenticated requests (it spends LLM budget on every accepted call).
- [ ] 🔴 Fix attempt state is durable and reload-safe: gating, declined, handoff-failed, and proceeding(runId) states survive a page/server reload and drive `computeFixAction`.
- [ ] 🔴 A crash/restart mid-gate is reconciled at startup: an attempt stranded `gating` flips to `interrupted`, Fix renders available-again with the prior attempt's detail, and the same-bug concurrency guard never wedges the bug permanently.
- [ ] 🔴 On proceeding, the bug gains an associated fix run only after the hand-off returns an accepted run id; the autorun execution is reached through the single clean hand-off seam (the only legitimate stub).
- [ ] 🔴 A hand-off failure on a passing gate is reported, never faked as a started run.
- [ ] 🟡 `computeFixAction` greys Fix with a reason for an ineligible bug (done, promoted, parse warning), consistent with v1's disabled pattern.
- [ ] 🟡 A concurrent Fix click is guarded (button disabled, gating state) so it can't double-trigger.
- [ ] 🟡 A stale/deleted bug id ignores or tombstones old FixAttempt state rather than resurrecting an item in the deep view.
- [ ] 🟢 Fix is bug-only; ideas never expose Fix.

## 4. Sessions & Search

### Session scoping

- [ ] 🔴 Session keys support product scopes while preserving existing global `${transport}:${userId}` sessions; existing on-disk sessions migrate without being stranded.
- [ ] 🔴 Webview product chat, `POST /api/chat`, and WS message frames carry the active product through `handleConversation`; Telegram/global chat still works without product context.
- [ ] 🔴 `/fresh`, `/fresh-full`, `/clear`, `/journal`, model switching, and every existing chat command operate on the active product session when scoped and behave exactly as today for global/Telegram sessions.
- [ ] 🟡 Concurrent sessions for different products do not collide on the same key, and a product session does not erase a global Telegram session.
- [ ] 🟡 Nightly session capture and `GET /api/state` handle product-scoped keys: the `getAllSessions`/`parseSessionKey`/persist/restore round-trip survives the key-shape change.

### Search

- [ ] 🔴 Per-product chat search reaches the product repo + vault, not vault alone.
- [ ] 🟡 A repo-search seam failure falls back to vault search rather than failing the chat turn.
- [ ] 🟢 No regression to existing KB synthesis from the broadened search.

## 5. Home View UI

### View router

- [ ] 🔴 The client view-router switches home ↔ per-product and owns the active product/view selection both UI phases render against.
- [ ] 🟡 Back and deep-link behavior restores the correct view-state on reload.

### Home view

- [ ] 🔴 Each product card shows repo-backed status, live active-run indicator (state, elapsed, running pulse), open counts, most-recent-run outcome, and a prominent attention signal.
- [ ] 🔴 Clicking a live active-run indicator deep-links into that product's deep view focused on the run.
- [ ] 🟡 The Home view hosts no chat box, no logs, and no Fix button.
- [ ] 🟡 The Home view renders the `available:false` state clearly and does not poll or depend on `/api/cockpit`.
- [ ] 🟢 A not-repo-backed product card renders a graceful limited state.

## 6. Per-Product Deep View UI

### Layout

- [ ] 🔴 The deep view exists per product and all four working surfaces (Projects, Backlog, Runs, Chat) are reachable within it.
- [ ] 🔴 The chat panel is sized as one panel, not the dominant surface.

### Operational-panels cutover

- [ ] 🔴 After the legacy layout is removed, the pending-approvals inbox still works in the new IA — including a parked-run release (Approve → `requestWorkRunRelease`), intent proposals, and playbook/Ask-Twice entries.
- [ ] 🔴 The production restart-server button and in-flight op/mutation cancel remain reachable and functional post-cutover.
- [ ] 🟡 The planning-panel handoff and backlog add/Plan flows still work from the deep view's backlog surface.
- [ ] 🟡 Any deliberately-dropped legacy panel (activity/session/queue/review status) is recorded in the spec/decisions log, not silently absent.

### Realtime run panel

- [ ] 🔴 Tasks update in realtime even when edits live in a separate worktree; agents-on-run, elapsed, live output, worktree path, and classified outcome render.
- [ ] 🔴 The most-recent run's transcript is readable without special steps (persisted, not drawer-only).
- [ ] 🟡 A mid-run reload rehydrates the panel from the `/live` snapshot.

### Fix affordance

- [ ] 🔴 Fix renders all states: available, gating, declined (visible reason), handoff-failed (visible reason), proceeding (associated accepted run appears in Runs), disabled (greyed with reason). Plan retained on bugs and ideas.
- [ ] 🟡 Fix state survives reload because the UI reads persisted FixAttempt state through the product/backlog projection.

### Per-product chat panel

- [ ] 🔴 Chat is scoped to the active product, all existing commands preserved, search reaching repo + vault.
- [ ] 🟡 KB-research/idea chat is absent; a deep-link OUT starts App threads (App threads are not embedded).

## 7. Acceptance (stub-free, on a real product)

- [ ] 🔴 Home pulse truthful across products; deep view exists for the product.
- [ ] 🔴 A real work run shows tasks update in realtime with worktree edits, agents-on-run, and readable logs.
- [ ] 🔴 A real bug Fix runs the PM+TL gate and returns a real decision (decline-with-reason OR accepted/failed by the clean hand-off — the only permitted seam), with persisted state surviving reload.
- [ ] 🔴 A per-product chat turn with repo+vault search and working `/fresh`, `/fresh-full`, `/clear`.
- [ ] 🟡 No regression: the v1 Plan promotion path and backlog still work; KB-research chat is absent from the web view.
- [ ] 🟡 No regression: the operational rail survived the cutover — a parked-run release, the restart-server button, and op/mutation cancel each demonstrated once in the new IA.
