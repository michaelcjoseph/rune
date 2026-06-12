# Cockpit Redesign — Surface Rethink (Workstream A) Specification

## Overview

Today the Jarvis web view is roughly 90% chat and 10% cockpit. A separate
workstream ([16-claude-app-connector](../16-claude-app-connector/spec.md)) moves KB
research and idea exploration into the Claude App, and more MCP functions will keep
pushing product/project planning there over time. That migration is the unlock:
with research-chat gone, the web view no longer needs a chat box eating half the
screen. The web view becomes a development-focused cockpit for working with Jarvis
across all products — projects, bugs, ideas, runs, and the dev/planning chat that
surrounds them.

This is not a chat-free surface. Dev work requires conversation (planning a project,
triaging a bug, scoping work) so per-product chat stays. What changes is that chat
becomes one panel inside a dev cockpit, not the cockpit itself.

This spec covers only the surface redesign (Workstream A). Two adjacent ideas are
explicitly out of scope and built separately: the cross-repo autorun plumbing that
executes a Fix, and the bug-to-bug autorun sweep.

It builds on top of [09-expand-cockpit](../09-expand-cockpit/spec.md) (v1), which
established the product card, the Bugs/Ideas backlog drawer, the Plan promotion path,
and the durable promotion job. The v1 backlog parser, promotion lifecycle, and
repo-safety contracts are retained. The v2 Fix affordance v1 deferred is now in scope
as a surface affordance.

### Core Value Proposition

A two-tier development cockpit — a cross-product Home pulse plus a per-product deep
view — that lets Michael make progress with Jarvis across all products without a chat
box dominating the screen, with realtime run visibility and Fix as the headline bug
action.

### Goals

1. **Primary — Two-tier information architecture.** A cross-product Home view (pulse)
   and a per-product deep view (where real work happens). Product-specific views are
   non-negotiable and must exist.
2. **Primary — Dev workflow over chat.** Reorganize the real estate around the dev
   workflow (projects / bugs / ideas / runs). Chat is present and per-product, but no
   longer dominates the screen.
3. **Primary — Fix as the headline bug action.** Fix is the highest-value action the
   surface exposes. Clicking Fix on a bug triggers a PM + Tech-Lead scoping gate; only
   a well-scoped bug proceeds to the single hand-off seam for a fix run.
4. **Primary — Realtime run visibility.** During an active work run, Michael can see
   project tasks update in realtime (even when edits live in a separate worktree), see
   which agents are working the run, and read the most-recent run's logs easily.
5. **Secondary — Per-product chat, better scoped.** Dev/planning chat stays, scoped
   per product, with search broadened to the product's repo + vault (not vault alone).
   All existing chat functionality is preserved.
6. **Secondary — Session scoping follows the product.** Sessions can be scoped to per
   product, while Telegram/global chat continues to work.

### Non-Goals

- **Cross-repo autorun plumbing behind Fix.** Separate, deferred idea. This spec needs
  only the single-bug trigger, the PM/Tech-Lead gating decision, and a clean hand-off
  point to that plumbing when it exists.
- **Bug-to-bug unattended sweep.** Separate, deferred idea.
- **KB research / idea-exploration chat in the web view.** That moves to the Claude
  App. The cockpit does not reproduce it.
- **Rendering Claude App threads inside the cockpit.** Out for v1; items captured in
  the App flow back via the existing connector.
- **Changing how `/work` executes**, run-finalization logic, or the backlog
  parser/promotion mechanics established in 09-expand-cockpit and the work-run projects
  (11/13/14/15). This is a surface redesign that reads off existing instrumentation.
- Non-repo-backed products get a graceful empty/limited state, not bespoke design.

---

## User Journey

### Happy Path

```
Home view (cross-product pulse) → select product → Per-product deep view
                                                          ↓
                          watch active run (tasks/agents/logs realtime)
                                                          ↓
                          triage a bug → click Fix → PM/TL gate
                                          ↓                    ↓
                                   declined (reason)      hand-off accepted/failed
```

1. **Home view** — Michael opens the web view and lands on a cross-product pulse: each
   product's active-run status, open counts, most-recent-run outcome, and any
   attention signal (a parked, failed, or no-op run, or backlog warnings).
2. **Select a product** — He clicks into a product and lands in its per-product deep
   view, which holds projects, backlog, runs, and per-product chat.
3. **Watch a run** — With a real work run active, he watches its tasks update in
   realtime (edits living in a separate worktree), sees which agents are working it,
   and reads the most-recent run's logs without special steps.
4. **Triage and Fix** — He triages a bug and clicks Fix. The PM + Tech-Lead gate runs
   on that bug and returns a real decision: declined with a visible reason, or accepted
   by the fix-run hand-off seam with an associated run id when that executor exists.
5. **Chat** — He holds a per-product dev/planning chat turn scoped to that product,
   with search reaching the product repo + vault, and `/fresh`, `/fresh-full`, and
   `/clear` still working.

### Entry Points

- The localhost web view at `http://127.0.0.1:3847/` now opens on the Home view.
- A live active-run indicator on a Home card deep-links straight into that product's
  deep view focused on the run.

### Exit Points

- Plan opens a planning session (delegated to conversation).
- Fix hands off to the deferred cross-repo autorun fix-run path on a passing gate.
- A deep-link out starts a KB-research/idea thread in the Claude App.

---

## Requirements

### Home view (cross-product pulse)

1. WHEN the web view loads THEN it shows the Home view: one card per product with name
   and repo-backed status.
2. WHEN a product has a live run THEN its card shows the active-run indicator
   (project/bug, state, elapsed, and a realtime running pulse).
3. WHEN Michael clicks a live active-run indicator THEN he enters that product's deep
   view focused on that run.
4. WHEN a product card renders THEN it shows counts: active projects, open bugs, open
   ideas, and backlog warnings.
5. WHEN a product's most recent run has terminated THEN the card shows its truthful
   classified outcome (completed / no-op / partial / failed), not exit code. A parked
   run is not terminated: it surfaces through the active-run indicator (state
   `parked`) and a parked-run attention signal, never as a terminal outcome.
6. WHEN a run is parked, failed, or no-op, or a backlog parse warning exists THEN the
   attention signal is surfaced prominently so "needs me" is impossible to miss.
7. WHEN on the Home view THEN there is no chat box, no logs, and no Fix button; it is
   the pulse and the router into deep views.

### Per-product deep view

8. WHEN Michael selects a product THEN he lands in its per-product deep view, which
   must exist for that product.
9. WHEN the deep view renders THEN all four working surfaces are reachable: Projects,
   Backlog (Bugs/Ideas), Runs, and per-product Chat.
10. WHEN a project is listed THEN it shows live task progress (N/M); selecting an
    active project shows its tasks updating in realtime during a run.
11. WHEN the chat panel renders THEN it is sized as one panel, not the dominant
    surface.
12. WHEN the product is not repo-backed THEN the deep view shows a graceful limited
    state from the product endpoint, consistent with v1, not an error page.

### Realtime run visibility

13. WHEN a work run is active THEN the Runs surface shows its tasks updating in
    realtime even when edits live in a separate worktree. "Realtime" means
    event-driven at the instrumentation's natural granularity — task tallies on
    commit-poll ticks (~10s, when a new commit lands), log lines from the transcript
    tail — not sub-second mirroring of uncommitted edits.
14. WHEN a run is active THEN it shows which product-team agents are working it (PM,
    tech lead, coder, reviewer, etc.). A legacy (single-agent) run truthfully renders
    its one executor; the full team roster appears only when an orchestrated run
    supplies role-invocation records — the surface never fabricates a team.
15. WHEN a run is active THEN it shows elapsed, live output, and the worktree path.
16. WHEN a run completes THEN it shows the classified outcome.
17. WHEN Michael opens the most-recent run THEN its logs are readable from the
    persisted transcript, not only while a drawer is open.
18. WHEN a mid-run page reload happens THEN the run view rehydrates from a live
    snapshot without waiting for the next event.

### Fix affordance and gating

19. WHEN a bug is open and Fix-eligible THEN the Fix action renders as available and is
    the headline action on the bug.
20. WHEN Michael clicks Fix THEN the surface shows a gating (in-progress) state while
    the PM + Tech-Lead assess scope on that bug.
21. WHEN the gate declines THEN Fix does not proceed and the surface shows the reason.
22. WHEN the gate passes THEN the server invokes one clean fix-run hand-off seam,
    persists the attempt state, and either records the accepted run id or reports the
    hand-off failure; the surface must never fake a started run.
23. WHEN a bug is not eligible (done, promoted, parse warning) THEN Fix is greyed with
    a reason, consistent with v1's disabled-action pattern.
24. WHEN a gate passes and the hand-off accepts a run id THEN the bug gains an
    associated run and that run appears in the Runs surface with realtime
    tasks/agents/logs. The surface does not need to know the autorun internals.

### Chat and sessions

25. WHEN Michael chats in the web view THEN it is a per-product dev/planning chat tied
    to the active product, the only chat in the web view.
26. WHEN a webview product chat session is created THEN it is scoped by
    `{product, transport, user}`; existing Telegram and global chat/session behavior
    remains available for non-product conversations and commands.
27. WHEN Michael runs `/fresh`, `/fresh-full`, `/clear`, or any existing chat command
    THEN it behaves exactly as it does today.
28. WHEN chat search runs THEN it reaches the product repo + vault, not vault alone.

### Cutover and preserved operations

29. WHEN the Phase 6 cutover replaces the current layout THEN every operational
    affordance of today's webview keeps a working home in the new IA: the
    pending-approvals inbox (including parked-run release — the project 13
    Approve → `requestWorkRunRelease` path), the production restart-server button,
    in-flight op/mutation cancel, the planning-panel handoff, and the backlog
    add/Plan flows. Cross-product operational affordances (approvals, restart,
    global status) live on the Home view's operational rail; per-product
    affordances (run cancel, planning, backlog) live in the deep view. Exact
    placement is the design team's to detail; existence is not negotiable.
30. WHEN a panel of the current sidebar is deliberately dropped rather than
    migrated (e.g. the Claude Activity trace or the session/queue/review status
    panels) THEN the drop is recorded in this spec / the project decisions log,
    never silent.

---

## Technical Implementation

### Data contracts and projections

- **`buildHomePulse` (pure projection).** A new `HomePulse` projection forked from the
  `buildCockpitView` pattern in `src/intent/cockpit.ts`. Per product it aggregates
  active-run status, open project/bug/idea counts, backlog warnings, most-recent-run
  classified outcome, and attention signals (parked/failed/no-op run, parse warnings).
  Reads `registry` + `supervision-store` + `work-run-store` + `backlog-reader`. Owns no
  state and returns an explicit unavailable shape when the registry cannot be read.
- **`buildProductDeepView` (pure projection).** A `ProductDeepView` projection for one
  product: projects with live task progress (N/M), a backlog reference, run history
  (most-recent first), and the active-run detail descriptor (state, elapsed, worktree
  path, agents-on-run, transcript pointer). Reuses existing run/backlog readers.
  Returns a graceful `repoBacked:false` limited shape for not-repo-backed products.
- **Endpoints.** `GET /api/home` and `GET /api/products/:product` wire to the two
  projections using the existing typed error-envelope convention for true errors
  (400 invalid slug, 404 unknown-product). A known non-repo-backed product returns
  200 with the limited shape. `/api/cockpit` stays alive during the transition; the
  new UI stops depending on it at the Phase 6 cutover. All new endpoints
  (`/api/home`, `/api/products/:product`, `/api/work-runs/:id/live`,
  `POST .../fix`) sit behind the existing cookie auth + host guard
  (`verifyAuth`/`isAllowedHost`). The deep view and live snapshot are
  local-operator surfaces: the un-scrubbed worktree path they expose follows the
  project 13 scrubbing exemption (same as the cockpit WebSocket).

### Realtime run feed

- **`run-event-bus-publish`.** Publish live run events (task-tally transitions,
  agents-on-run changes, log-tail lines, elapsed/state) onto the existing
  NotificationBus → webview-sender path by adding a first-class `BusRunEvent` /
  `run-event` frame and sender subscription. Sourced from the commit-poll
  (`work-run-commit-poll.ts`), `orch-run-record` / role invocation records, transcript
  tails, and supervision heartbeats. Log lines use the same redaction as persisted
  transcripts. No change to `/work` run execution.
- **`live-run-state-snapshot`.** Persist/derive a per-run live snapshot (tasks N/M,
  active agents, elapsed, worktree path, last log lines) and expose
  `GET /api/work-runs/:id/live` so a mid-run reload rehydrates. Reconstructable from
  transcript + supervision on cold start.
- **`webview-run-subscription-client`.** A client-side run subscription module that
  listens to run events on the existing WebSocket, maintains per-run view state, and
  rehydrates from the `/live` snapshot on connect/reconnect. Pure state/wiring logic,
  no visual layout.

### Fix gate

- **`evaluateBugFixGate(facts)` (pure).** A fail-closed, fact-ordered decision modeled
  on `src/jobs/work-run-gate.ts`. Returns a discriminated `FixGateResult`:
  `declined{reason, detail}` or `proceeding{}`. Defines `BugScopingFacts`. No I/O.
- **`pm-techlead-bug-scoping`.** A single-bug PM + Tech-Lead scoping assessment reusing
  the planning-roles seams (`agents/pm/SOUL.md`, `agents/tech-lead/SOUL.md`,
  `planning-roles-wiring.ts`) to produce the `BugScopingFacts` the gate consumes. PM
  judges well-scoped-enough with a reason; Tech-Lead reviews feasibility/scope.
  Fail-closed on unparseable replies.
- **`fix-attempt-store`.** A tiny durable state source for Fix attempts, keyed by
  `{product, bugId}` with an attempt id. It records `gating`, `declined`, `handoff-failed`,
  `proceeding {runId}`, and `interrupted` states, supports idempotency/concurrency
  guards, and is the source `computeFixAction` and `buildProductDeepView` read after
  reload. A startup reconcile (mirroring `reconcileOrphans` in
  `src/jobs/mutations-log.ts`) flips any attempt stranded `gating` by a crash or
  restart to `interrupted`, so the same-bug concurrency guard can never wedge a bug
  permanently; `computeFixAction` renders `interrupted` as available-again with the
  prior attempt's detail visible.
- **`computeFixAction`.** Extends `src/server/backlog-actions.ts` with the Fix action
  states: available / gating / declined(reason) / handoff-failed(reason) /
  proceeding(runId) / disabled(reason), mirroring `computePlanAction`'s precedence
  and the v1 disabled-with-reason contract. Fix is bug-only.
- **`POST /api/backlog/:product/items/:id/fix`.** Drives the real PM/TL scoping +
  gate to a real decision. It validates the product/item, writes the attempt's
  durable `gating` state, and returns `202 {attemptId}` immediately — the scoping
  runs async (a multi-minute PM/TL LLM round-trip never blocks one HTTP request),
  mirroring the mutation-pipeline pattern. The decision lands in the attempt store
  and reaches the client through the deep-view projection / run-fix events; the
  surface never fabricates a synchronous result. The endpoint serializes concurrent
  attempts for the same bug, surfaces declined reasons through the persisted state,
  and on proceeding calls the cross-repo autorun fix-run path through a single
  clean interface. That seam is the only legitimate stub in this project; the gate
  decision and attempt persistence are never stubbed.

### Sessions and search

- **`per-product-session-scoping`.** Extend session scoping in `src/vault/sessions.ts`
  from only `${transport}:${userId}` to an explicit `SessionScope`:
  global/Telegram-compatible sessions keep the legacy shape, while product webview chat
  uses `${product}:${transport}:${userId}`. Thread product context through WS frames,
  `POST /api/chat`, chat/planning routing (`src/bot/handlers/text.ts`), state snapshot,
  command handlers that close or inspect sessions, and the nightly session-capture
  path (the `getAllSessions` / `parseSessionKey` / persist / restore round-trip must
  survive the key-shape change). Preserve every existing command verbatim and migrate
  existing on-disk session keys without stranding them.
- **`repo-plus-vault-chat-search`.** Add a repo-search seam alongside
  `src/kb/search.ts`, extend `CONVERSATION_TOOLS`, and update the conversation system
  prompt to route code/project questions to the repo and concept/people questions to
  the KB. No regression to existing KB synthesis.

### Client routing

- **`client-view-router`.** A minimal client-side view-state/router module in the
  vanilla-JS app (home ↔ per-product), since the SPA has no routing layer today. Owns
  the active product/view selection both UI phases render against, with back and
  deep-link behavior. Prerequisite for the Home and deep-view UIs.

---

## UI/UX Design

### Key Screens

#### Home view

- **Route (client view-state):** `home`
- **States:** product card with active run / idle; attention-signal banner present /
  absent; repo-backed / not-repo-backed.
- **Layout:** read-mostly grid of per-product cards. Each card shows name +
  repo-backed status, a live active-run indicator (state, elapsed, running pulse), open
  counts (projects / bugs / ideas / warnings), most-recent-run classified outcome, and
  a prominent attention signal. No chat box, no logs, no Fix button.

#### Per-product deep view

- **Route (client view-state):** `product/:product`
- **States:** project active / done; run running / parked / completed / no-op /
  partial / failed; chat active / archived; not-repo-backed limited state.
- **Layout:** the four working surfaces (Projects, Backlog, Runs, Chat) reachable
  within the view, chat sized as one panel and not dominant. Exact visual hierarchy is
  the design team's to detail against these requirements.

#### Fix affordance (in the backlog surface)

- **States rendered:** available, gating (in-progress), declined (with visible
  reason), handoff-failed (visible reason), proceeding (associated run appears in Runs
  when the hand-off accepts a run id), disabled (greyed with reason, consistent with
  v1). Plan retained on bugs and ideas.

### Visual Tokens

Reuse the existing vanilla HTML/JS/CSS cockpit styling (`src/server/static/`). The
recent-runs and work-run outcome classes (`.run-ok` / `.run-warn` / `.run-error`) are
reused so a no-op or dirty run never reads as success.

---

## Implementation Phases

> The phase-by-phase task breakdown lives in [tasks.md](tasks.md) and the verification
> checklist in [test-plan.md](test-plan.md); both follow the phase structure below. The
> project is built **test-first** — every phase in tasks.md opens with a **Tests (write
> first)** block whose tests must fail (red) before that phase's implementation begins.

### Phase 1: Data Contracts

- [ ] `buildHomePulse` pure HomePulse projection
- [ ] `buildProductDeepView` pure ProductDeepView projection
- [ ] `GET /api/home` and `GET /api/products/:product` endpoints (keep `/api/cockpit`)

### Phase 2: Realtime Run Feed

> Depends on: Phase 1

- [ ] `run-event-bus-contract` typed run events through bus and WebSocket
- [ ] `run-event-bus-publish` live run events onto NotificationBus → webview-sender
- [ ] `live-run-state-snapshot` + `GET /api/work-runs/:id/live`
- [ ] `webview-run-subscription-client` client-side run subscription module

### Phase 3: Fix Gate

> Depends on: Phase 1

- [ ] `evaluateBugFixGate(facts)` pure fail-closed decision
- [ ] `pm-techlead-bug-scoping` single-bug PM + Tech-Lead assessment
- [ ] `fix-attempt-store` durable gate/handoff state
- [ ] `computeFixAction` Fix action states in `backlog-actions.ts`
- [ ] `POST /api/backlog/:product/items/:id/fix` endpoint + clean hand-off seam

### Phase 4: Sessions & Search

> Depends on: Phase 1

- [ ] `session-scope-core` with product scopes plus legacy/global compatibility
- [ ] `product-chat-routing-and-commands` thread product scope through chat commands
- [ ] `repo-plus-vault-chat-search` repo + vault search seam

### Phase 5: Home View UI

> Depends on: Phase 1
>
> Interim: until Phase 6 lands, selecting a product from Home falls back to the
> legacy cockpit layout — Home never dead-ends.

- [ ] `client-view-router` minimal client-side view-state/router (home ↔ per-product)
- [ ] `home-view-ui` cross-product Home pulse (reads `GET /api/home`)

### Phase 6: Per-Product Deep View UI

> Depends on: Phases 2, 3, 4, 5

- [ ] `product-deepview-layout` deep-view shell (Projects / Backlog / Runs / Chat)
- [ ] `realtime-run-panel-ui` run panel with realtime tasks/agents/logs
- [ ] `fix-affordance-ui` Fix headline action with all states
- [ ] `per-product-chat-panel-ui` per-product chat panel + deep-link out to App
- [ ] `operational-panels-cutover` explicit migrate-or-retire for every legacy
      sidebar panel (approvals incl. parked-run release, restart, op/mutation
      cancel, planning, activity/session/queue/review)

### Phase 7: Acceptance

> Depends on: Phase 6

- [ ] `e2e-acceptance-on-jarvis` stub-free end-to-end acceptance on a real product

---

## Success Metrics

### Core KPIs

| Metric | Target | How Measured |
| ------ | ------ | ------------ |
| Home pulse truthful | All products | Active-run status, counts, outcome, attention signal visible without drilling in |
| Per-product deep view exists | Every product | Projects, backlog, runs, chat reachable per product |
| Realtime run visibility | 1 real run | Tasks update with worktree edits, agents-on-run shown, logs readable |
| Fix gate renders real decision | 1 real bug | PM + TL gate declines-with-reason OR accepted/failed by the clean hand-off |
| Chat no regression | All commands | `/fresh`, `/fresh-full`, `/clear` work; chat is one panel, repo + vault search |

### Definition of Done

Done means Michael can do the real job on a real product, in production, at least once.
The first five Definition-of-Done items must each be demonstrated once on a real
product (Jarvis itself is an acceptable first product): a truthful home pulse, a deep
view that exists, a real run with realtime tasks/agents/logs, a real bug Fix that runs
the PM+TL gate and returns a real decision, and a per-product chat turn with repo+vault
search and working `/fresh`, `/fresh-full`, `/clear`. Plus no regression on the v1 Plan
path and backlog, no regression on the operational rail (pending approvals including
parked-run release, restart-server, op/mutation cancel), and KB-research chat absent
from the web view.

---

## Edge Cases & Error Handling

### Projections and endpoints

- Unknown product on `GET /api/products/:product` returns a typed 404; a not-repo-backed
  product returns a 200 graceful limited shape, never a crash or error page.
- `buildHomePulse` and `buildProductDeepView` are pure and read off existing stores; a
  store-read failure degrades that product's card rather than failing the whole view.
- `/api/cockpit` stays alive during the transition so a partial cutover never blanks the
  surface.

### Realtime run feed

- A mid-run page reload rehydrates from `GET /api/work-runs/:id/live`; the snapshot is
  reconstructable from transcript + supervision on cold start, so a missed event never
  leaves the run view blank.
- The run feed is surface plumbing only; a publish failure must not affect `/work` run
  execution or finalization.
- An agent/Claude CLI failure during a run is surfaced as the run's classified outcome,
  not swallowed.

### Fix gate

- The PM/TL scoping replies are fail-closed: an unparseable reply declines the gate
  with a reason rather than proceeding.
- An ineligible bug (done, promoted, parse warning) shows Fix disabled with a reason.
- The hand-off seam is the only stub; on a passing gate the surface hands off without
  needing the autorun internals, and a hand-off failure is reported, not faked as a
  started run.
- Fix attempt state is durable, so a reload after gating/decline/proceed/handoff-failure
  renders the same truth instead of resetting to available.
- A server crash or restart mid-gate is reconciled at startup: an attempt stranded
  `gating` flips to `interrupted` and Fix renders available again — a bug is never
  permanently wedged behind a dead attempt.
- A concurrent Fix click is guarded the same way v1 guards double-POSTs (disable the
  clicked button, gating state).

### Sessions and search

- Migrating session keys to support product scopes must not strand existing on-disk
  `${transport}:${userId}` sessions, and must not break Telegram/global chat.
- A repo-search seam failure falls back to vault search rather than failing the chat
  turn.
- Vault file not found or unwritable during a chat command degrades gracefully and is
  surfaced, not silent.

---

## Open Questions

- [ ] Surfacing logged Claude App conversations back into the cockpit (beyond bug/idea
  routing): a position worth taking later; v1 deep-links out only.
- [ ] Exact visual layout/hierarchy within the per-product deep view is the design
  team's to detail against these requirements.
