# Cockpit Redesign — Surface Rethink (Workstream A) — Tasks

Not started. See [spec.md](spec.md) for architecture and [test-plan.md](test-plan.md) for verification.

> **Test-first by default.** Every phase below opens with a **Tests (write first)** block.
> Those tests mirror the matching [test-plan.md](test-plan.md) sections and must fail (red)
> before any implementation task in the phase begins. A phase's implementation is done when
> its test-plan sections pass.
>
> Granularity here is the meaningful deliverable — not a granular sub-task. Per-task file
> layout, schemas, and signatures are settled in `/work`'s Plan phase, against the spec.

## Phase 1 — Data Contracts

> Depends on: nothing.

### Tests (write first)

- [x] Write the test suite for **HomePulse + ProductDeepView projections and endpoints** — test-plan.md §1.
- [x] Confirm every suite above fails (red) before starting the implementation blocks.

### Implementation

- [x] **home-pulse-projection** — Add a pure HomePulse projection (`buildHomePulse`) that aggregates, per product: active-run status, open project/bug/idea counts, backlog warnings, most-recent-run classified outcome, and attention signals (parked/failed/no-op run, parse warnings). Forks the pattern from `src/intent/cockpit.ts:buildCockpitView`; reads registry + supervision-store + work-run-store + backlog-reader and returns an unavailable shape when the registry cannot be read. No state owned.
- [x] **product-deepview-projection** — Add a pure ProductDeepView projection (`buildProductDeepView`) for one product: projects with live task progress (N/M), a backlog reference, run history (most-recent first), and the active-run detail descriptor (state, elapsed, worktree path, agents-on-run, transcript pointer). Reuses existing run/backlog readers; returns a `repoBacked:false` limited shape for not-repo-backed products.
- [ ] **home-and-product-endpoints** — Wire `GET /api/home` and `GET /api/products/:product` to the two projections with typed error envelopes for true errors (400 invalid slug, 404 unknown-product). A known not-repo-backed product returns 200 with the limited shape. Both endpoints sit behind the existing cookie auth + host guard (`verifyAuth`/`isAllowedHost`). Keep `/api/cockpit` alive during transition; stop the new UI depending on it at the Phase 6 cutover.

## Phase 2 — Realtime Run Feed

> Depends on: Phase 1.

### Tests (write first)

- [ ] Write the test suite for **run event publish, live snapshot, and subscription client** — test-plan.md §2.
- [ ] Confirm red before implementation.

### Implementation

- [ ] **run-event-bus-contract** — Add first-class `BusRunEvent` / `run-event` typing to `src/transport/notification-bus.ts`, subscribe it in `createSenders`, forward it through `WebviewSender`, and update the client frame parser. This pins the wire contract before publishers exist.
- [ ] **run-event-bus-publish** — Publish live run events (task-tally transitions, agents-on-run changes including which model each agent runs on — Claude/Codex/etc, redacted log-tail lines, elapsed/state) onto the NotificationBus → webview-sender path, sourced from the commit-poll, `orch-run-record` / role invocation records, transcript tails, and supervision heartbeats. This is the surface plumbing that makes existing instrumentation visible in the web view; no change to `/work` run execution.
- [ ] **live-run-state-snapshot** — Persist/derive a per-run live snapshot (tasks N/M, active agents, elapsed, worktree path, last log lines) and expose `GET /api/work-runs/:id/live` (auth-gated like the transcript route) so a mid-run page reload rehydrates without waiting for the next event. Snapshot is reconstructable from transcript + supervision on cold start.
- [ ] **webview-run-subscription-client** — Client-side run subscription module: listens to run events on the existing WebSocket, maintains per-run view state, and rehydrates from the `/live` snapshot on connect/reconnect. Pure state/wiring logic, no visual layout (the run panel UI consumes this in Phase 6).

## Phase 3 — Fix Gate

> Depends on: Phase 1.

### Tests (write first)

- [ ] Write the test suite for **bug-fix gate decision, PM/TL scoping, Fix action states, and the fix endpoint** — test-plan.md §3.
- [ ] Confirm red before implementation.

### Implementation

- [ ] **bug-fix-gate-decision** — Pure `evaluateBugFixGate(facts)` decision modeled on `src/jobs/work-run-gate.ts`: fail-closed, fact-ordered, returns a discriminated `FixGateResult` — `declined{reason, detail}` or `proceeding{}`. Defines `BugScopingFacts`. No I/O, fully unit-tested.
- [ ] **pm-techlead-bug-scoping** — Wire a single-bug PM + Tech-Lead scoping assessment that reuses the planning-roles seams (`agents/pm/SOUL.md`, `agents/tech-lead/SOUL.md`, `planning-roles-wiring.ts`) to produce the `BugScopingFacts` the gate consumes. PM judges well-scoped-enough with a reason; Tech-Lead reviews feasibility/scope. Fail-closed on unparseable replies.
- [ ] **fix-attempt-store** — Add a durable, torn-line-tolerant FixAttempt store keyed by `{product, bugId}` with `gating`, `declined`, `handoff-failed`, `proceeding {runId}`, and `interrupted` states. It is the reload-safe source for Fix action state, bug-to-run association, and same-bug idempotency/concurrency guards. Includes a startup reconcile (mirroring `reconcileOrphans`) that flips any attempt stranded `gating` by a crash/restart to `interrupted` so a bug is never permanently wedged behind a dead attempt.
- [ ] **fix-action-states** — Extend `src/server/backlog-actions.ts` with `computeFixAction`: states available / gating / declined(reason) / handoff-failed(reason) / proceeding(runId) / disabled(reason), mirroring `computePlanAction`'s precedence and the v1 disabled-with-reason contract. Fix is bug-only; ineligible mirrors Plan's disabled reasons plus done/promoted/parse-warning, and persisted attempt state wins after eligibility. An `interrupted` attempt renders as available-again with the prior attempt's detail.
- [ ] **fix-endpoint-and-handoff** — `POST /api/backlog/:product/items/:id/fix` (auth-gated): validates the item, serializes same-bug attempts, records `gating`, and returns `202 {attemptId}` immediately — the real PM/TL scoping + gate runs async (mirroring the mutation-pipeline pattern; a multi-minute LLM round-trip never blocks one HTTP request) and its real decision lands in the attempt store, surfaced via the deep-view projection. On declined, the reason is recorded and rendered. On proceeding, calls the single cross-repo autorun hand-off interface; an accepted run id is recorded and associated with the bug, while a hand-off failure is recorded and surfaced without faking a started run. The deferred-idea execution lives behind that seam — the seam is the ONLY legitimate stub in this project; the gate decision and attempt state are never stubbed.

## Phase 4 — Sessions & Search

> Depends on: Phase 1.

### Tests (write first)

- [ ] Write the test suite for **per-product session scoping and repo + vault chat search** — test-plan.md §4.
- [ ] Add a scheduler test asserting the raised global cap runs N products in parallel while the per-product cap of one holds, and that an env override of `WORK_RUN_GLOBAL_CAP` is honored — mirrors `src/intent/scheduler.test.ts`. Confirm red before implementation.
- [ ] Confirm red before implementation.

### Implementation

- [ ] **session-scope-core** — Extend `src/vault/sessions.ts` with an explicit `SessionScope` so legacy/global sessions keep `${transport}:${userId}` while product webview sessions use `${product}:${transport}:${userId}`. Update get/create/update/delete/list helpers, restore/persist migration, and tests so existing on-disk sessions are not stranded.
- [ ] **product-chat-routing-and-commands** — Thread product context through WS message frames, `POST /api/chat`, `handleWebviewMessage`, `handleConversation`, planning routing, state snapshot, command handlers that inspect/close sessions (`/fresh`, `/fresh-full`, `/clear`, `/journal`, model switching), and the nightly session-capture path (the `getAllSessions`/`parseSessionKey`/persist/restore round-trip must survive the key-shape change). Preserve every existing command verbatim in both product-scoped and global/Telegram sessions.
- [ ] **product-tailored-system-prompt** — Build the system prompt for a product-scoped chat session from THAT product's loaded context (its repo docs, project specs/tasks, and relevant worldview) so the session is grounded in the product instead of generic. Keys off the `SessionScope` from `session-scope-core`: a product-scoped session assembles the prompt from the product's context; legacy/global and Telegram sessions keep the existing generic prompt. Touches `src/vault/sessions.ts` and the conversation system-prompt assembly. No regression to global/Telegram chat.
- [ ] **repo-plus-vault-chat-search** — Broaden per-product dev/planning chat search from vault-alone to product repo + vault: add a repo-search seam alongside `src/kb/search.ts`, extend `CONVERSATION_TOOLS`, and update the conversation system prompt so a product chat's search/context is scoped to THAT product's repo plus the KB — code/project questions route to the product repo, concept/people questions to the KB. No regression to existing KB synthesis.
- [ ] **raise-global-concurrency-cap** — Raise the default `WORK_RUN_GLOBAL_CAP` in `src/config.ts` (currently `2`) so multiple products each run a project in parallel by default rather than queueing behind a cap of 2. Keep it env-configurable via the existing `parseNumericEnv` (`min: 1, integer: true`) path — no new hardcoded constant. The `schedule()` pass in `src/intent/scheduler.ts` already accepts `globalCap` and walks the queue FIFO, so no scheduler-logic change is needed; the per-product cap of one is preserved (see the Open Question on relaxing it). **Ownership:** the scheduler and its caps belong to project 08-intent-layer — the cap change lands in shared `config.ts`/the project-08 scheduler, not in a project-17-specific module; this task owns the surface assumption and the cross-reference. Verify the Home pulse and deep view render >1 concurrent product run truthfully (no projection change required).

## Phase 5 — Home View UI

> Depends on: Phase 1.

### Tests (write first)

- [ ] Write the test suite for **client view-router and the Home view UI** — test-plan.md §5.
- [ ] Confirm red before implementation.

### Implementation

- [ ] **client-view-router** — Introduce a minimal client-side view-state/router module in the vanilla-JS app (home ↔ per-product), since the SPA has no routing layer today. Owns the active product/view selection that both UI phases render against, with back/deep-link behavior. Prerequisite for the home and deep-view UIs. Interim: until Phase 6 lands, selecting a product from Home routes to the legacy cockpit layout — Home never dead-ends.
- [ ] **home-view-ui** — Build the cross-product Home view (read-mostly pulse): per-product cards with repo-backed status, live active-run indicator (state, elapsed, running pulse), open counts, most-recent-run classified outcome, and prominently-surfaced attention signals (parked/failed/no-op run, backlog warnings). No chat box, no logs, no Fix here — pulse + router into the deep view. Reads `GET /api/home`, handles the unavailable shape, and does not rely on `/api/cockpit`. _(designer review)_

## Phase 6 — Per-Product Deep View UI

> Depends on: Phases 2, 3, 4, 5.

### Tests (write first)

- [ ] Write the test suite for **deep-view layout, realtime run panel, Fix affordance, and per-product chat panel** — test-plan.md §6.
- [ ] Confirm red before implementation.

### Implementation

- [ ] **product-deepview-layout** — Build the per-product deep-view shell reorganized around the dev workflow: Projects, Backlog (Bugs/Ideas), Runs, and a per-product Chat panel — chat sized as ONE panel, not the dominant surface. All four working surfaces reachable within the view. Reads `GET /api/products/:product`. Non-negotiable: this view must exist per product. _(designer review)_
- [ ] **realtime-run-panel-ui** — Run panel inside the deep view: tasks updating in realtime (even when edits live in a separate worktree), which agents are working the run (PM/tech-lead/coder/reviewer/…) and which model each runs on (Claude/Codex/etc), elapsed + live output + worktree path + classified outcome on completion, and the most-recent run's transcript readable without special steps. The surface is labeled "Agent activity", not "Claude activity" (the old label wrongly assumed a single model). Consumes the Phase 2 subscription module + `/live` snapshot. _(designer review)_
- [ ] **fix-affordance-ui** — Fix as the headline bug action in the backlog surface, with all required states rendered: available, gating (in-progress), declined (with visible reason), handoff-failed (visible reason), proceeding (accepted run appears in Runs), disabled (greyed with reason, consistent with v1). Plan retained on bugs and ideas. Wires to `POST .../fix`, `computeFixAction`, and the persisted FixAttempt state. _(designer review)_
- [ ] **per-product-chat-panel-ui** — Per-product dev/planning chat panel: scoped to the active product, sized as one panel within the deep view, with all existing commands preserved in the UI and search reaching repo + vault. KB-research/idea chat is absent (it lives in the Claude App); provide a deep-link OUT to start App threads, do not embed them. _(designer review)_
- [ ] **operational-panels-cutover** — Explicit migrate-or-retire pass over every legacy sidebar panel at the moment the old layout is removed. Must keep working homes for: the pending-approvals inbox (including parked-run release — the project 13 Approve → `requestWorkRunRelease` path; note the v1 `app.js` ships this **disabled** — Approve/Reject greyed for `blocked-on-human`, Open a no-op — so the cutover must BUILD it working, not just carry it over), the production restart-server button, in-flight op/mutation cancel, the planning-panel handoff, and the backlog add/Plan flows. Cross-product affordances (approvals, restart, global status) land on the Home operational rail; per-product affordances (run cancel, planning, backlog) land in the deep view. Any deliberate drop (e.g. activity/session/queue/review status panels) is recorded in the spec/decisions log, never silent. _(designer review)_

## Phase 7 — Acceptance

> Depends on: Phase 6.

### Implementation

- [ ] **e2e-acceptance-on-jarvis** — Stub-free end-to-end acceptance on a real product (Jarvis itself): (1) home pulse truthful across products; (2) deep view exists for the product, including a non-repo-backed limited-state check if such a product is registered; (3) a real work run shows tasks update in realtime with worktree edits, agents-on-run, and readable logs; (4) a real bug Fix runs the PM+TL gate and returns a real decision (decline-with-reason OR accepted/failed by the clean hand-off) with the persisted state surviving reload; (5) a per-product chat turn with repo+vault search and working `/fresh`, `/fresh-full`, `/clear`; (6) the operational rail survived the cutover — pending approvals (including a parked-run release), the restart-server button, and op/mutation cancel all reachable and working in the new IA; plus no-regression on the v1 Plan path and backlog. The autorun hand-off is the only permitted seam.
