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
`BusRunEvent` to `notification-bus.ts`, `createSenders`, and `WebviewSender` (the
WebSocket already broadcasts agent/mutation/op events; runs join it as `run-event`):
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
guards, and bug-to-run association. A stale missing bug causes the next projection to
ignore the attempt; it must not resurrect deleted backlog rows. A startup reconcile
(mirroring `reconcileOrphans` in `src/jobs/mutations-log.ts`) flips any attempt
stranded `gating` by a crash/restart to `interrupted` so the same-bug concurrency
guard can never wedge a bug permanently.

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
  | { kind: 'global' }                 // preserves current Telegram/global behavior
  | { kind: 'product', product: string }
```
`src/vault/sessions.ts` accepts an optional scope on get/create/update/delete/list
calls. The legacy key `${transport}:${userId}` remains the global key; product webview
chat uses `${product}:${transport}:${userId}`. WebSocket and `POST /api/chat` message
frames carry the active product for product chat. `/fresh`, `/fresh-full`, `/clear`,
`/journal`, model switching, state snapshot, and nightly/session capture all use the
same scope so command behavior remains exact inside a product chat and unchanged
outside one.

## 3. Endpoints (new / changed)

| Method | Path | Returns | Notes |
|---|---|---|---|
| GET | `/api/home` | `HomePulse` | Read-mostly pulse. |
| GET | `/api/products/:product` | `ProductDeepView` | 404 unknown-product; 200 limited shape if not repo-backed. |
| GET | `/api/work-runs/:id/live` | `LiveRunSnapshot` | Rehydrate mid-run. |
| POST | `/api/backlog/:product/items/:id/fix` | `202 {attemptId}` | Validates item, persists `gating`, runs PM/TL scoping + gate async (mirrors the mutation-pipeline pattern — a multi-minute LLM round-trip never blocks one HTTP request); the decision lands in the attempt store and is read back via `GET /api/products/:product` / run-fix events. On proceed calls hand-off and records accepted run or hand-off failure. |
| — | `/api/backlog/:product/items/:id/plan` | unchanged | v1 Plan path retained verbatim. |
| (WS) | `/api/ws` | adds `RunEvent` frames | Existing channel; runs join it. |
| GET | `/api/cockpit` | unchanged | Kept for compatibility; new UI stops depending on it at Phase 6 cutover. |

All errors use the existing typed envelope `{ error: { code, message, retryable? } }`.
All four new routes sit behind the existing cookie auth + host guard
(`verifyAuth`/`isAllowedHost`) — the fix POST especially, since it spends LLM budget.
`ActiveRunDetail.worktreePath` and the `/live` snapshot are local-operator surfaces;
the un-scrubbed worktree path follows the project 13 scrubbing exemption (same as the
cockpit WebSocket, localhost-bound and auth-gated).

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
  at this cutover, and every legacy sidebar panel is explicitly migrated or
  retired (`operational-panels-cutover`): the pending-approvals inbox (incl.
  parked-run release), restart-server button, op/mutation cancel, and planning
  panel keep working homes; deliberate drops (e.g. activity/session/queue/review
  status panels) are recorded, never silent.
- **Phase 7 (Acceptance)** proves the five DoD scenarios stub-free on Rune as the
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
