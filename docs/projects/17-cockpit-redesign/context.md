# Project Context: Cockpit Redesign — Surface Rethink (Workstream A): a dev-focused, two-tier cockpit for working with Jarvis across all products

> Orchestration state for the `jarvis` project "Cockpit Redesign — Surface Rethink (Workstream A): a dev-focused, two-tier cockpit for working with Jarvis across all products".
> Owned by Jarvis's context curator — roles read a bounded slice and emit handoff
> notes; they do not author this file directly.

## Current State

Today the Jarvis web view is ~90% chat, ~10% cockpit. A separate workstream
(`16-claude-app-connector`) moves KB research and idea exploration into the Claude
App, and more MCP functions will continue pushing product/project *planning* there
over time. That migration is the unlock: with research-chat gone, the web view no
longer needs a chat box eating half the screen. The web view becomes a
**development-focused cockpit** for working *with Jarvis* across all products —
projects, bugs, ideas, runs, and the dev/planning chat that surrounds them.

## Key Decisions

- Primary objects fixed as Product, Project, Bug, Idea, Run, and Chat session — with states grounded in the existing system (run states reuse the work-run observability/finalizer vocabulary: running, parked, completed, no-op, partial, failed; bug open/done; idea open/promoted; project active/done).
- Bugs and ideas flow into projects through exactly two promotion paths: Plan (existing — opens a planning session, scaffolds a project on approval) and Fix (bugs only — triggers the PM/Tech-Lead scoping gate). No new promotion path is invented.
- One-click vs delegated split: one-click actions are Fix, open run logs, open the backlog drawer, switch product/view, and add a backlog item; everything requiring judgment (Plan, triage, scoping) is delegated to Jarvis via a planning/dev chat session.
- Home/per-product division: the home view is a read-mostly cross-product pulse (per-product cards: active-run status, open counts, most-recent-run outcome, attention signals like parked/failed/no-op runs); all working surfaces — projects, backlog, runs, logs, agents, chat — live on the per-product deep view.
- Claude App relationship (v1 position): the cockpit deep-links OUT to start KB-research/idea threads in the Claude App but does not render App threads inside the cockpit; items captured in the App flow back as bugs/ideas via the existing connector routing and simply appear in the cockpit backlog.
- Fix scope per this brief is the surface affordance + single-bug trigger + PM/Tech-Lead gating decision only; on an approved gate, Fix hands off to the cross-repo autorun fix-run path that is the separately-deferred idea (not built here).
- Realtime run view is assumed feasible on the existing observability substrate (persisted per-run transcript + surfaced worktree path + product-team role spawns), so 'see tasks/agents/logs update in realtime even when edits are in a separate worktree' reads off existing instrumentation rather than requiring new run-execution changes.
- Session-scoping change is treated as a product requirement of this surface: webview product chat gets an explicit product scope, while Telegram/global chat stays compatible; existing chat commands (/fresh, /fresh-full, /clear, etc.) are preserved verbatim and per-product chat search is broadened to the product repo + vault.
- Fix endpoint is async (202 + durable attempt state), not synchronous: the PM/TL scoping is a multi-minute LLM round-trip, so `POST .../fix` persists `gating` and returns `202 {attemptId}` immediately, mirroring the mutation-pipeline pattern; the decision is read back through the deep-view projection. A startup reconcile flips crash-stranded `gating` attempts to `interrupted` so a bug is never permanently wedged.
- The Phase 6 cutover carries an explicit migrate-or-retire pass (`operational-panels-cutover`) over every legacy sidebar panel: pending approvals (incl. parked-run release), restart-server, op/mutation cancel, and the planning panel must keep working homes (cross-product → Home operational rail, per-product → deep view); deliberate drops are recorded, never silent.
- `parked` is never a terminal outcome anywhere in the new contracts: it surfaces as `activeRun.state:'parked'` + a parked-run attention signal; `mostRecentRun.outcome` and `RunSummaryRow.outcome` are terminal-only (completed / no-op / partial / failed).

## Interfaces & Contracts

# Tech Spec — Cockpit Redesign: Surface Rethink (Workstream A)

## 0. Guiding constraints

- **Surface redesign, not a run-execution change.** Everything reads off existing
  instrumentation: `SupervisedRun` (supervision-store), `WorkRunSummary` +
  classified outcomes (work-run-store / `work-run-classify.ts`), persisted
  `transcript.jsonl`, deterministic worktree path, and `TaskRunRecord.rolesInvoked`
  (orch-run-record). `/work` execution, the finalizer, the backlog parser, and the
  v1 promotion machinery are untouched.
- **Stay vanilla JS.** The web view (`src/server/static/app.js`, `index.html`,
  `app.css`) is framework-free. A framework migration is out of scope; we add a
  thin client-side view/router module and split rendering, matching surrounding
  idiom. (If the design team later wants a framework, that is a separate project.)
- **One legitimate stub.** The cross-repo autorun execution behind a *proceeding*
  Fix gate is the separately-deferred idea. It sits behind a single hand-off
  interface. Everything else load-bearing — the realtime run feed and the PM/TL
  gate decision — must be real in the Phase 7 acceptance run. If the suite passes
  with the gate or the realtime feed stubbed, that stub is unfinished work.

## 1. Reused contracts (do NOT reinvent)

| Concern | Source of truth | Reuse |
|---|---|---|
| Product/project projection | `src/intent/cockpit.ts` (`CockpitProduct`, `CockpitProject`, `BacklogCounts`, `buildCockpitView`) | Fork the projection pattern; keep it a pure read. |
| Backlog parse + items | `src/intent/backlog-parser.ts` (`BacklogItem`), `backlog-reader.ts` (`FileWarning`, `computeBacklogCounts`) | Read as-is. |
| Plan action / disabled pattern | `src/server/backlog-actions.ts` (`computePlanAction`, `BacklogItemAction`, `BacklogDisabledReason`) | Extend, mirror precedence. |
| Plan promotion lifecycle | `src/intent/promotions.ts` state machine, `scaffold-approval.ts`, `backlog-mark-done.ts` | Untouched; Fix does not enter this path. |
| Repo safety | `backlog-write-lock.ts` (workspace containment, symlink guard, write-target allowlist, 1 MB cap, audit log) | Honor for any write. |
| Run facts | `SupervisedRun` (`src/intent/supervision.ts`), `WorkRunSummary` (`work-run-store.ts`), outcome taxonomy (`work-run-classify.ts`) | Read-only. |
| Transcript | `logs/work-runs/<id>/transcript.jsonl`, `GET /api/work-runs/:id/transcript`, `redactSecrets` | Reuse for "readable logs". |
| Agents-on-run | `TaskRunRecord.rolesInvoked` / `modelChoices` (`orch-run-record.ts`); legacy run = single agent | Read-only. |
| Gate pattern | `src/jobs/work-run-gate.ts` (`evaluateGate`, fail-closed, fact-ordered) | Template for the Fix gate. |
| PM/TL role flow | `agents/pm/SOUL.md`, `agents/tech-lead/SOUL.md`, `src/intent/planning-roles-wiring.ts` | Reuse seams for single-bug scoping. |
| Sessions | `src/vault/sessions.ts` (composite key), command handlers, state snapshot, `CONVERSATION_TOOLS` + `VAULT_SYSTEM_PROMPT_BASE` (`text.ts`) | Add product scopes while preserving legacy/global sessions + broaden search. |

## 2. Data contracts (new)

### 2.1 HomePulse (Phase 1)
```
HomePulse = { available: boolean, products: HomeProductPulse[], unavailableReason?: string }

HomeProductPulse = {
  name: string
  repoBacked: boolean
  activeRun?: {                 // present iff a run is live
    runId: string
    target: { kind: 'project' | 'bug', slug: string }
    state: 'running' | 'parked'
    elapsedMs: number
  }
  counts: { activeProjects: number, openBugs: number, openIdeas: number, backlogWarnings: number }
  mostRecentRun?: {             // truthful TERMINAL classified outcome, never exit code
    runId: string
    outcome: 'completed' | 'no-op' | 'partial' | 'failed'
    endedAt: string
  }
  attention: AttentionSignal[]  // ordered, most-urgent first
}

AttentionSignal =
  | { kind: 'parked-run', runId, target }
  | { kind: 'failed-run', runId, target }
  | { kind: 'noop-run', runId, target }
  | { kind: 'backlog-warning', count }
```
`buildHomePulse(deps)` is a pure projection over registry + supervision-store +
work-run-store + backlog-reader. A registry read failure returns
`{available:false, products:[], unavailableReason}` instead of throwing. Maps
`WorkRunSummary.outcome` (`branch-complete` → `completed`, `dirty-uncommitted` →
`partial`, `noop` → `no-op`) onto the spec's vocabulary. `parked` is not a terminal
outcome: it derives from the `blocked-on-human` supervision status (live worktree,
non-terminal) and surfaces exclusively as `activeRun.state: 'parked'` plus a
`parked-run` attention signal — never as `mostRecentRun.outcome`.

### 2.2 ProductDeepView (Phase 1)
```
ProductDeepView = {
  name: string
  repoBacked: boolean           // false → limited state, no working surfaces
  limitedReason?: string
  projects: DeepProject[]
  backlog: { bugs: BacklogItemWithActions[], ideas: BacklogItemWithActions[], warnings: FileWarning[] }
  runs: RunSummaryRow[]         // most-recent first
  activeRun?: ActiveRunDetail
}

DeepProject = { slug, lifecycle: 'active' | 'done', taskProgress: { done: number, total: number } }

RunSummaryRow = {                // sourced from logs/work-runs/index.jsonl (readRecentIndex)
  runId: string                  // + per-run summary.json; bounded by work-run GC
  target: { kind: 'project' | 'bug', slug: string }   // retention (default 3 runs), so
  outcome: 'completed' | 'no-op' | 'partial' | 'failed' // history is short by design
  endedAt: string
  transcriptUrl?: string         // present when the transcript artifact survived GC
}

ActiveRunDetail = {
  runId, target, state, startedAt, elapsedMs,
  worktreePath: string,         // surfaced from worktreePathFor(...)
  agents: AgentOnRun[],         // from rolesInvoked; legacy run = one entry
  transcriptUrl: string         // GET /api/work-runs/:id/transcript
}
AgentOnRun = { role: 'pm'|'tech-lead'|'coder'|'reviewer'|'qa'|'designer'|..., active: boolean }
```
`BacklogItemWithActions = BacklogItem & { plan: BacklogItemAction, fix?: FixAction }`.
Known non-repo-backed products return this same shape with `repoBacked:false`,
empty working surfaces, and `limitedReason`; they do not return a 409 from the
product endpoint. Backlog-specific endpoints keep their existing 409 behavior.

### 2.3 Realtime run events + live snapshot (Phase 2)
Publish onto the existing `NotificationBus` → `webview-sender` by adding a first-class
`BusRunEvent` to `notification-bus.ts`, `createSenders`, and `WebviewSender`:
```
RunEvent =
  | { kind: 'run-event', subKind: 'progress', runId, product, target, tasks: { done, total }, ts }
  | { kind: 'run-event', subKind: 'agents',   runId, product, target, agents: AgentOnRun[], ts }
  | { kind: 'run-event', subKind: 'log',      runId, product, target, lines: string[], ts }
  | { kind: 'run-event', subKind: 'state',    runId, product, target, state, elapsedMs, outcome?, ts }
```
`GET /api/work-runs/:id/live` → `LiveRunSnapshot` (tasks N/M, agents, elapsed,
worktreePath, last N log lines, state) — reconstructable from
`transcript.jsonl` + supervision on cold start so a mid-run reload rehydrates.
The client subscription module merges snapshot + streamed `RunEvent`s into per-run
view state; on reconnect it refetches `/live` then resumes the stream.
All live log lines pass through the same redaction path as persisted transcript
display lines.

### 2.4 Fix gate (Phase 3)
```
BugScopingFacts = {
  fieldsComplete: boolean       // bug has the minimum to act on
  pmAssessed: boolean
  pmWellScoped: boolean
  pmReason?: string             // populated when !pmWellScoped
  techLeadReviewed: boolean
  techLeadObjection?: string
  itemEligible: boolean         // open bug, not done/promoted, no parse warning
}

FixGateResult =
  | { decision: 'declined', reason: FixDeclineReason, detail?: string }
  | { decision: 'proceeding' }

FixDeclineReason = 'ineligible' | 'incomplete-fields' | 'pm-not-well-scoped' | 'tech-lead-objection'
```
`evaluateBugFixGate(facts)` is pure and fail-closed, fact-ordered like
`evaluateGate`: ineligible → incomplete → pm-not-assessed/declined → TL-objection →
`proceeding`. The PM/TL facts are produced by `pm-techlead-bug-scoping`, which
reuses the `planning-roles-wiring.ts` seams against the bug's title+body; an
unparseable role reply fails closed (declined, never proceeds).

### 2.5 Fix attempt state (Phase 3)
```
FixAttempt = {
  attemptId: string
  product: string
  bugId: string
  state: 'gating' | 'declined' | 'handoff-failed' | 'proceeding' | 'interrupted'
  reason?: string
  detail?: string
  runId?: string
  updatedAt: string
}
```
The durable store is append-only JSONL or an equivalently torn-line-tolerant local
store under `logs/`, keyed by `{product, bugId}` with newest attempt winning. It is
the source for reload-safe Fix UI state, `computeFixAction`, double-click/idempotency
guards, and bug-to-run association. A startup reconcile (mirroring `reconcileOrphans`
in `src/jobs/mutations-log.ts`) flips any attempt stranded `gating` by a crash/restart
to `interrupted` so the same-bug concurrency guard can never wedge a bug permanently;
`computeFixAction` renders `interrupted` as available-again with the prior attempt's
detail.

### 2.6 Fix action states (Phase 3)
`computeFixAction(item, gateState)` → `FixAction`:
```
FixAction = { kind: 'fix',
  state: 'available' | 'gating' | 'declined' | 'handoff-failed' | 'proceeding' | 'disabled',
  reason?: string,             // for declined / handoff-failed / disabled
  runId?: string }             // for proceeding
```
Precedence mirrors `computePlanAction`: `disabled` (done/promoted/parse-warning/
not-a-bug) wins first; otherwise `available`; `gating`/`declined`/`proceeding`
reflect the persisted attempt state for that item. An `interrupted` attempt renders
as `available` with the prior attempt's detail (retryable, never wedged).

### 2.7 Session scope (Phase 4)
```
SessionScope =
  | { kind: 'global' }
  | { kind: 'product', product: string }
```
The legacy key `${transport}:${userId}` remains the global key; product webview chat
uses `${product}:${transport}:${userId}`.

## 3. Endpoints (new / changed)

| Method | Path | Returns | Notes |
|---|---|---|---|
| GET | `/api/home` | `HomePulse` | Read-mostly pulse. |
| GET | `/api/products/:product` | `ProductDeepView` | 404 unknown-product; 200 limited shape if not repo-backed. |
| GET | `/api/work-runs/:id/live` | `LiveRunSnapshot` | Rehydrate mid-run. |
| POST | `/api/backlog/:product/items/:id/fix` | `202 {attemptId}` | Validates item, persists `gating`, runs PM/TL scoping + gate async (mirrors the mutation-pipeline pattern); decision lands in the attempt store, read back via `GET /api/products/:product`. On proceed calls hand-off and records accepted run or hand-off failure. |
| — | `/api/backlog/:product/items/:id/plan` | unchanged | v1 Plan path retained verbatim. |
| (WS) | `/api/ws` | adds `RunEvent` frames | Existing channel; runs join it. |
| GET | `/api/cockpit` | unchanged | Kept for compatibility; new UI stops depending on it at Phase 6 cutover. |

All errors use the existing typed envelope `{ error: { code, message, retryable? } }`.
All four new routes sit behind the existing cookie auth + host guard
(`verifyAuth`/`isAllowedHost`). `ActiveRunDetail.worktreePath` and the `/live`
snapshot are local-operator surfaces; the un-scrubbed worktree path follows the
project 13 scrubbing exemption (same as the cockpit WebSocket).

## 4. Hand-off boundary (Fix → autorun)

On `decision: 'proceeding'`, `fix-endpoint-and-handoff` associates a fix-run with
the bug by writing `FixAttempt.state='proceeding'` with the accepted run id and calls
one interface — `startFixRun({ product, bugId, scope })` — whose implementation is
the deferred cross-repo autorun idea. If the interface is unavailable or rejects, the
attempt becomes `handoff-failed` with a visible reason; it must not fabricate a run
id. The cockpit never reaches into the autorun internals. This single seam is the only
place a stub is acceptable.

## 5. Sequencing & rationale

- **Phase 1 (Data Contracts)** lands the two projections + endpoints first so every
  later phase reads a stable contract. Pure reads, no behavior risk.
- **Phase 2 (Realtime Run Feed)** is load-bearing and front-loaded: publish run
  events onto the existing bus, add the `/live` snapshot, and a testable client
  subscription module — all before any pixels, so the data path is proven
  independent of design.
- **Phase 3 (Fix Gate)** delivers the real PM/TL decision (the project's other
  load-bearing capability), durable attempt state, and the clean autorun hand-off.
  Pure gate + role wiring + attempt store + action states + endpoint.
- **Phase 4 (Sessions & Search)** adds product-scoped webview sessions and broadens
  search to repo+vault while preserving legacy/global sessions and every command
  verbatim. Independent of the UI, so it can run in parallel with Phase 2/3 if
  capacity allows.
- **Phase 5 (Home View UI)** adds the client router (prerequisite for both UIs) and
  the read-mostly pulse. Interim: until Phase 6 lands, selecting a product from Home
  routes to the legacy cockpit layout so Home never dead-ends.
- **Phase 6 (Per-Product Deep View UI)** builds the deep-view shell, the realtime
  run panel (consuming Phase 2), the Fix affordance with all states, and the
  demoted per-product chat panel. The client no longer depends on `/api/cockpit`
  at this cutover, and every legacy sidebar panel is explicitly migrated or retired
  (`operational-panels-cutover`): the pending-approvals inbox (incl. parked-run
  release), restart-server button, op/mutation cancel, and planning panel keep
  working homes; deliberate drops are recorded, never silent.
- **Phase 7 (Acceptance)** proves the five DoD scenarios stub-free on Jarvis as the
  first real product, with the autorun hand-off as the only permitted seam.

## 6. Test strategy notes

- Projections, the gate, action-state computation, the realtime merge logic, and
  session scope computation are all pure or near-pure → `code-tests-required` with
  table tests over the existing fixtures.
- The realtime client module is tested as logic (snapshot + event merge,
  reconnect) without a DOM.
- UI tasks carry `designerNeeded: true`; their behavior (states rendered, chat not
  dominant, panels reachable) is asserted, with visual hierarchy owned by design.
- Phase 7 is `tests-as-deliverable`: a scripted real-product walkthrough that fails
  if the gate or realtime feed is stubbed.

## Known Risks

- **Agents-on-run has one live data source today.** The orchestrated runtime's role-spawn binding (`runTaskWorkflow` production wiring, project 14 Phase 5) is deferred, so until it lands the only real runs are legacy single-agent `work-run`s — the agents panel truthfully renders one executor. Acceptance must not require a multi-role roster from a legacy run, and the surface must never fabricate a team.
- **"Realtime" task tallies are commit-granularity.** The tally source is the parent-side commit poll (10s tick, fires on new commits) plus transcript tails — not file-watching the worktree. Spec requirement 13 defines realtime accordingly; don't re-litigate this during implementation.
- **Session key migration touches nightly capture.** `getAllSessions`/`parseSessionKey` feed nightly session capture and `/api/state`; a key-shape change that forgets those consumers strands or mangles persisted sessions. Covered in Phase 4 tasks/tests.

## Next Task Handoff

- er runner src/transport/sender.test.ts src/transport/webview-sender.test.ts src/server/static/run-feed-client.test.ts` passed: 58 tests.
- `git diff --check` passed.
- `npm run build` still has pre-existing branch-wide type errors, but no errors reference the touched files after the declaration fix.
