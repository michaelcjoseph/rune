# Projects

Build log for Rune — one numbered project per directory. The table below is the
at-a-glance index; the sections that follow give the full write-up, each linking to
its `spec.md`.

| Project | Status | Summary |
|---|---|---|
| [01-mvp](01-mvp/spec.md) | Done | The foundational always-on server. |
| [02-journal-kb](02-journal-kb/spec.md) | Done | Daily journals become first-class KB sources. |
| [03-resolver](03-resolver/spec.md) | Done | Free-form Telegram messages route themselves to skills. |
| [04-custom-workouts](04-custom-workouts/spec.md) | Done | On-demand daily workouts tailored to current context. |
| [05-library-into-kb](05-library-into-kb/spec.md) | Done | External reading library folded into the KB. |
| [06-webview](06-webview/spec.md) | Done | A localhost web chat surface mirroring Telegram. |
| [07-spaced-repetition](07-spaced-repetition/spec.md) | In Progress | A daily spaced-repetition quiz over the wiki. |
| [08-intent-layer](08-intent-layer/spec.md) | In Progress | Rune becomes an intent-layer orchestrator over multi-model sub-agents. |
| [09-expand-cockpit](09-expand-cockpit/spec.md) | Done | Per-product bugs and ideas in the cockpit, with one-click Plan to start a real planning session. |
| [10-rune-identity-refactor](10-rune-identity-refactor/spec.md) | Done | Symlink AGENTS.md → CLAUDE.md per repo (drift becomes impossible) and move Rune orchestrator identity out of pkms/CLAUDE.md into rune. Rescoped from a compiler build — see spec. |
| [11-work-run-observability](11-work-run-observability/spec.md) | Done | Make `/work --auto` runs observable: classify outcome on work product (not exit code), persist a durable transcript, retain forensics, and alert truthfully. |
| [12-writer-memory](12-writer-memory/spec.md) | Done | A content-writer role-agent (SOUL.md charter + accumulating memory.md) behind `/blog` that captures craft lessons from feedback and compounds them into the next piece. The smallest test of role-agent + memory. |
| [13-work-run-monitoring](13-work-run-monitoring/spec.md) | Done | Make automated `/work --auto` runs findable and testable: surface the worktree path, keep a parked run's worktree alive when a task needs a human, and release clean parked work back to the Project 15 finalizer. |
| [14-product-team-agents](14-product-team-agents/spec.md) | Done | Rune coordinates a simulated product team across a whole project: PM/tech-lead planning, QA-first per-task execution, bounded `context.md` handoff, reviewer/designer gates, Project 15 finalizer handoff, and feedback-driven role memory. Phases 1-9 DONE (live execution binding + planning critique — proof `live-acceptance-6abf35cf.md`). **Reopened 2026-06-14 — Phase 10 (observability + auto-merge)** and **Phase 11 (orchestration resilience):** Phase 10 makes codex AND claude role activity observable on the cockpit (and reuses the stream as the finalizer transcript so clean runs auto-merge); Phase 11 fixes two failure modes the overnight project-17 run exposed — gate rejections that discard their feedback (QA retried blindly, then blocked), and a server restart that orphans a run instead of resuming it. Phase 12 makes the team learn: reference exemplars of good output per role, and gate failures that write neutral-validated lessons into the counterpart's memory. |
| [15-work-run-finalizer](15-work-run-finalizer/spec.md) | Done | Make every `/work --auto` run reach a correct terminal state on its own — even when the agent emits `result: success` then never exits — and give plain work-runs one gated, resumable path onto `main`. Closes the six-defect "wedges open AGAIN" incident. |
| [16-claude-app-connector](16-claude-app-connector/spec.md) | Done | Make the Rune chat surface portable into the Claude App via a lean six-tool MCP connector, at zero cost to the vault → pipeline → KB funnel Rune still owns. |
| [17-cockpit-redesign](17-cockpit-redesign/spec.md) | Done | A dev-focused, two-tier cockpit (cross-product Home pulse + per-product deep view) for working with Rune across all products, with realtime run visibility and Fix as the headline bug action. |
| [18-rebrand-rune-to-rune](18-rebrand-rune-to-rune/spec.md) | Done | Cut the agent's public brand over to Rune across repo, runtime identity, env vars, and the local checkout, with behavior unchanged. |
| [19-rune-product-os](19-rune-product-os/spec.md) | Done | Cockpit becomes a product OS over internal + external products; standalone always-on MCP service, monitoring, knowledge freshness. Phase 6 (writer-as-product) extracted to the michaelcjoseph.com `01-rune-writing-product` project. |
| [20-pm-scoping-self-review](20-pm-scoping-self-review/spec.md) | Not Started | The PM runs the `/plan` interview directly and writes the spec; one approval, streamed downstream progress, and a fresh-context fix-it self-review for PM, Tech Lead, and Coder. |
| [21-parallel-product-chats](21-parallel-product-chats/spec.md) | Not Started | Turn the webview into a real parallel workspace: fire a turn in one product chat, switch, and fire in another — concurrent dispatch, scope-addressed responses, per-panel buffering with an unread cue, and cross-tab sync. |
---

## 01-mvp — Done

[Spec](01-mvp/spec.md)

The foundational always-on server.

- Telegram bot, knowledge base engine, and scheduled jobs in a single Node.js process.
- Deployed on a Mac Mini.

## 02-journal-kb — Done

[Spec](02-journal-kb/spec.md)

Daily journals become first-class KB sources.

- Daily journals are auto-ingested into the KB.
- Reviews draw on KB-activity digests.
- Meeting notes auto-structure: attendees → CRM, decisions → Decisions Log.
- Wiki lint extended to catch content decay.

## 03-resolver — Done

[Spec](03-resolver/spec.md)

Free-form Telegram messages route themselves to the right skill.

- Resolver classifies free-form Telegram messages and dispatches them to skills.
- Ask-Twice telemetry proposes new skills and crons; cron schedules are driven by skill frontmatter.
- Adds an MVP eval framework, `/learn` for runtime learnings, deterministic entity auto-linking, and compilation checkpoints + source hierarchy.
- Hybrid KB search deferred to [ideas.md](ideas.md).

## 04-custom-workouts — Done

[Spec](04-custom-workouts/spec.md)

On-demand daily workouts tailored to current context.

- `/workout [home|gym] [focus]` generates a workout from goals, recent activity, Whoop recovery, available equipment, and an exercise-preference list (Preferred / Trying / Benched / Retired).
- `/done-workout` logs the session through the existing `#workout` journal-tag pipeline.

## 05-library-into-kb — Done

[Spec](05-library-into-kb/spec.md)

External reading library folded into the KB.

- Routes library files (Lenny posts, PG essays) into the KB ingestion pipeline.
- Lenny MCP integration: nightly sync plus an on-demand `/library-sync` command.
- `/lenny` and `/pg` decommissioned in favour of unified `/kb` queries.

## 06-webview — Done

[Spec](06-webview/spec.md)

A localhost web chat surface that mirrors the Telegram experience.

Chat UI at `http://127.0.0.1:3847/`, served from the existing HTTP server. It shares the
conversation and review session with Telegram via `TELEGRAM_USER_ID` — a `MessageSender`
abstraction wraps both transports, and cron jobs publish to a `NotificationBus`.

- **Core:** Vanilla HTML/JS frontend — renders markdown and syntax-highlighted code, makes `[[wikilinks]]` clickable `obsidian://` URIs, and streams Claude responses over WebSocket. Multi-line input with Cmd+Enter, up-arrow recall, and a model dropdown.
- **Phase C:** Light cockpit sidebar — active session, ingestion queue, recent agent runs, pending approvals.
- **Phase D:** Approval buttons for review flows; live agent-run events streamed to the sidebar.
- **Phase E:** Chat-driven mutation pipeline (`MutationDescriptor` + `MutationApplier` registry, `logs/mutations.jsonl` persistence, `mutation-event` bus channel) with a `/work --auto` runner that executes any project from a webview button — framing the webview as a self-update surface for future mutation kinds.

## 07-spaced-repetition — In Progress

[Spec](07-spaced-repetition/spec.md)

A daily spaced-repetition quiz over the wiki, delivered on Telegram. Runs at 12:00 CT
over non-stale wiki concepts.

- **Questions & grading:** `sr-question-generator` composes open-ended questions; `sr-grader` scores free-form answers on a four-grade rubric (again / hard / good / easy).
- **Scheduling:** SR state advances on a fixed-interval ladder — 1d → 3d → 7d → 14d → 30d → 60d → 120d.
- **Commands:** the old `/study` (syllabus tracking) is renamed `/syllabus`; `/study` becomes the SR entry point, with `/study N` and `/study status`.
- **Rollout:**
  - Phase 1 — ad-hoc manual session against a hand-seeded pool.
  - Phase 2 — daily cron and 30-minute lapse semantics.
  - Phase 3 — a `status: evergreen | active | stale` field on wiki concept frontmatter; `wiki-compiler` proposes (not applies) status changes via `knowledge/status-proposals.json` for weekly approval.
  - Phase 4 — polish (lapse hotspot report, graduation rule, revive-stale flow), deferred until usage data justifies.

## 08-intent-layer — In Progress

[Spec](08-intent-layer/spec.md)

Rune becomes an intent-layer orchestrator over multi-model sub-agents.

Evolves Rune from a reactive command-router into an orchestrator with a persistent intent
layer: it reasons about Michael's goals, discusses them into approved specs, then dispatches
and supervises sub-agents across multiple foundation models (Claude, Codex) and domains
(coding first). Extends the cockpit [06-webview](06-webview/spec.md) shipped, and widens
self-improvement to cover Rune's own operation.

- **Two regimes:** the reliability-first substrate (raw notes, KB, second-brain memory) stays heavy and propose-and-approve; project execution is a new, light, Amp-style regime that bets on model progress.
- **Federated memory:** vault holds raw thoughts, each product repo holds structured durable memory, a cockpit aggregates status across all of them and owns nothing.
- **Foundational tier:** a product/project registry, product registration that keeps the vault product files and registry honest, a per-product overlay index over the type-organized vault, model-agnostic agent definitions that compile to Claude/Codex/Gemini, and a declarative model selection policy (registry + capability tags + deterministic resolver) that picks the model per dispatch and updates as models change.
- **Five layers:** deliberative intent (Planner), Generator-Evaluator loop with cross-model adjudication (the existing `/work` and `/review` skills, made cross-model), supervision infrastructure (background dispatch around `/work --auto`), sandboxing and security, multi-model dispatch.
- **Three surfaces:** journal as passive intake, the webview cockpit, Telegram chat as dialogue.
- **v1 wedge:** take a coding idea, discuss it into a spec, dispatch Claude plus Codex to build and cross-review it in a sandbox, supervise, and report back — for the repo-backed products (Assay and Aura), git worktree per project, Relay repo out of scope.
- **Task breakdown & test plan:** see [tasks.md](08-intent-layer/tasks.md) and [test-plan.md](08-intent-layer/test-plan.md). Built test-first — every phase opens by writing the tests that mirror the test plan, then the implementation that makes them pass.

## 09-expand-cockpit — Done

[Spec](09-expand-cockpit/spec.md)

Per-product bugs and ideas in the cockpit, with one-click Plan to start a real planning session.

Pulls each repo-backed product's `docs/projects/bugs.md` and `docs/projects/ideas.md` into a per-product backlog drawer in the cockpit and adds the minimum controls to move a bullet into a planning session in one click. v1 covers read + add + Plan; Fix autorun for bugs is deferred to a follow-on spec (`expand-cockpit-fix-autorun`).

- **Reader + parser:** strict line-regex parser with documented format (`docs/projects/BACKLOG-FORMAT.md`); rejected forms produce typed warnings surfaced in the cockpit; deterministic id per `(file, line, normalized-raw)`.
- **Drawer UI:** right-side drawer reusing the existing `mutation-drawer` pattern; tabs for Bugs/Ideas; one action button per open item (`Plan` in v1).
- **Add:** `+` chip with per-file mutex + temp-then-rename writes; security-canonicalized paths under `$WORKSPACE_ROOT`; audit log of every mutation.
- **Plan + promotion job:** durable JSONL job log (`state/promotions.jsonl`) drives the `planning-started → scaffolded → marked-source` chain across Rune restarts. Scaffold contract adds a structured `scaffold-result` JSON block from the agent, cross-checked against the existing repo-diff verification from `approve.ts`.
- **Provenance:** recovered from the 2026-05-26 `/plan` conversation; spec is the post-Codex-critique revision the user approved. See [`08-intent-layer/agent-lessons.md`](08-intent-layer/agent-lessons.md) Lessons 8–11.
- **Task breakdown & test plan:** see [tasks.md](09-expand-cockpit/tasks.md) and [test-plan.md](09-expand-cockpit/test-plan.md). Test-first per phase.

## 10-rune-identity-refactor — Done

[Spec](10-rune-identity-refactor/spec.md)

Two surgical edits: make `AGENTS.md` a symlink to `CLAUDE.md` per repo so the two can never drift, and move Rune's orchestrator identity out of `pkms/CLAUDE.md` into `rune/CLAUDE.md`. **Rescoped 2026-06-02** from a five-repo canonical-source compiler — see the spec's Scope change section.

- **Why rescoped:** no instruction will ever differ between CLAUDE.md and AGENTS.md (same instructions, different per-model prompts), so a compiler whose renderers must produce identical output is a copy with extra steps. A symlink delivers zero drift for zero machinery.
- **Drift fix:** `ln -s CLAUDE.md AGENTS.md`. Core repos rune + pkms (both currently drifted); best-effort assay + aura; relay has no instruction files.
- **Identity fix:** move the `## Rune` and `### How Reviews Work` sections from pkms to rune, leave a one-line pointer. The git diff is the proof of preservation.
- **Dropped:** the compiler, IR, renderers, manifest, `$RUNE_HOME` wrapper, inventory verifier, CI drift checks, and `per-repo-migration.md`. The persistent-role-agent / SOUL.md / per-agent-memory architecture is a separate project (ideas.md → "Better agentic systems").
- **Task breakdown & test plan:** see [tasks.md](10-rune-identity-refactor/tasks.md) and [test-plan.md](10-rune-identity-refactor/test-plan.md).

## 11-work-run-observability — Done

[Spec](11-work-run-observability/spec.md)

Make `/work --auto` runs observable, verifiable, and reconstructable end to end.

Two runs on project 10 (2026-05-30) exited clean, did nothing, and were still reported `completed` — with no trail to diagnose why. This project classifies the terminal state on the actual work product, persists the full event stream durably, retains the run branch and uncommitted evidence, surfaces truthful outcomes on the cockpit card, and alerts on the moments that matter. It does not change how `/work` executes.

- **Outcome over exit code:** classify on commits (`baseSha..branch`), `tasks.md` transitions, and working-tree state into `branch-complete | partial | noop | dirty-uncommitted | failed` — a distinct `outcome` field separate from the `MutationStatus` enum, so a no-op never reads as success.
- **Durable transcript:** spawn with `--output-format stream-json --verbose`; persist every event to `logs/work-runs/<id>/transcript.jsonl` via a backpressure-aware stream, independent of any open drawer.
- **Forensics + GC:** export a `git bundle` plus status/diff/untracked evidence before teardown; always destroy the single-occupant worktree; GC by count and bytes with an active-run protected set.
- **Alerts + cockpit:** failure / noop / dirty / partial / branch-complete alerts with an outcome summary, commit-driven progress, and a distinct quiet-run nudge; cockpit card shows live output, elapsed, outcome, and a transcript link.
- **Provenance:** three review rounds (Codex grounded ×2 + a Claude pass that empirically verified the git and `claude -p` stream-json behaviors). Pause detection, phase display, and a restart button were considered and cut.
- **Task breakdown & test plan:** see [tasks.md](11-work-run-observability/tasks.md) and [test-plan.md](11-work-run-observability/test-plan.md). Test-first per phase.

## 12-writer-memory — Done

[Spec](12-writer-memory/spec.md)

A content-writer role-agent that accumulates craft across pieces.

The smallest end-to-end test of the "better agentic systems" bet: a role-agent defined by a hand-authored charter (`SOUL.md`) plus a compounding memory (`memory.md`) beats a stateless one. Runs behind the existing `/blog` flow; v1 proves the loop closes, quality is judged later via engagement metrics.

- **The role:** `rune/agents/writer/{SOUL.md, memory.md}` in the rune repo. `SOUL.md` (charter, system-prompt authority) references `writing/voice.md`; `memory.md` (accumulating craft lessons, low-authority reference) loads in the user turn, never the system prompt.
- **Read path:** a loader reading from `PROJECT_ROOT/agents/writer/` returns `{ systemInstructions, referenceContext }` so memory never gains command authority; char-budgeted with a truncation marker.
- **Write path:** after a mandatory feedback checkpoint the writer emits a completion sentinel; `blogHandler` closes the session and a TypeScript `captureLessons()` dedupes, privacy-filters, appends, and atomically commits to the rune repo. No approval gate; Michael reviews later.
- **Gate:** loop closure, not quality — a fixture lesson captured on piece N appears in piece N+1's reference context. Quality eval (engagement metrics) is a future phase in [ideas.md](ideas.md).
- **Outcome (loop closes ✅):** all three phases shipped. The automated gate `src/writer/loop-closure.test.ts` proves a marked lesson captured via the real `captureLessons` → temp `memory.md` → real `composeWriterContext` round-trips into piece N+1's `referenceContext` (and never the system channel). The blog flow runs the writer role end-to-end (SOUL on the system channel, seeded `memory.md` as user-turn reference, sentinel-driven server-owned closure, fault-isolated + timeout-bounded auto-commit of memory.md on `main` only). Seed baseline: 20 provenance-stamped craft bullets mined from 46 spec links.
- **Scope:** one role, rune repo only, no cross-product. The planning pipeline and engagement-driven lessons are separate ideas in [ideas.md](ideas.md).
- **Provenance:** planned 2026-06-02 from the top `ideas.md` bullet ("Better agentic systems"); three Codex critique rounds (over-engineering → adjust → architecture-fit) cut it from a five-role memory-substrate-plus-pipeline build down to this single-role wedge.
- **Task breakdown & test plan:** see [tasks.md](12-writer-memory/tasks.md) and [test-plan.md](12-writer-memory/test-plan.md). Test-first per phase.

## 13-work-run-monitoring — Done

[Spec](13-work-run-monitoring/spec.md)

Make an automated `/work --auto` run reachable and testable by a human when it needs one.

Today the runner executes in a worktree at a deterministic path that is not consistently surfaced as
an operator-actionable value. Project 15 now owns normal terminalization and gated merge, so this
project covers the remaining gap: when a run hits a step `--auto` can't do — the interactive Codex
check that stalled project 10 — Rune needs a durable parked state, a live worktree, and a clean
hand-back to the finalizer after the human acts.

- **Findability:** surface the (already-deterministic) worktree path + run id in notifications, on
  a local-operator field that stays un-scrubbed (the scrubber strips exactly the prefix you'd `cd`
  to).
- **Parked state:** a run that needs a human emits a durable `blocked-on-human` state, keeps its
  worktree alive, blocks finalizer teardown/merge, and holds the per-project slot — surviving a
  Rune restart.
- **Release:** one explicit action (Telegram + cockpit) resumes the Project 15 finalizer for a
  clean parked worktree, or explicitly discards a dirty worktree after confirmation. Net-new, since
  today's `blocked-on-human` approval rows are intentionally non-actionable.
- **Provenance:** 2026-06-03 conversation — diagnosed from project 10, where the worktree was
  unreachable for a manual test. Scoped down from an original two-phase plan after a Codex critique
  (verdict RETHINK) found the durable-integration-branch topology invalid; that ambition is recorded
  as Deferred in the spec. Post-Project-15, Phase 1 needs no promotion plumbing: Project 15 owns
  gated merge; Project 13 only pauses that finalizer while human work is pending and resumes it on
  release.
- **Task breakdown & test plan:** see [tasks.md](13-work-run-monitoring/tasks.md) and [test-plan.md](13-work-run-monitoring/test-plan.md). Test-first per phase.

## 14-product-team-agents — Done (reopened 2026-06-14)

[Spec](14-product-team-agents/spec.md)

Rune coordinates a persistent product team across an entire project.

Generalizes the Project 12 role-agent pattern (`SOUL.md` charter + compounding `memory.md`)
from one writer to six roles — PM, tech lead, QA, coder, reviewer, designer — and folds in
the Rune-owned project orchestration idea formerly captured as project 16. The useful
product is not standalone role agents; it is Rune running the team task-by-task with
explicit context handoff.

- **The team:** fixed roles with fixed review edges. PM writes the spec and assumptions; tech
  lead breaks it into task-sized slices, role sizing, test strategy, and designer-needed
  flags; QA writes tests first; coder implements; reviewer (cross-model) and tech lead
  review; designer checks only tech-lead-flagged front-end/designer-needed work.
- **Rune owns the project loop:** select first unchecked task, assemble bounded context,
  invoke the role workflow in a fresh execution context, record task evidence, update
  `docs/projects/<project>/context.md`, then advance/retry/block.
- **Context handoff:** `context.md` is Rune-owned orchestration state, not role memory and
  not a seventh role. It carries current state, key decisions, interfaces/contracts, known
  risks, and next-task handoff.
- **Objection classes are hard gates:** security, data integrity, concurrency, irreversibility,
  and cost/perf findings block task completion and PM cannot wave them through.
- **Finalizer handoff:** when no unchecked tasks remain, Rune hands branch/run facts to
  [15-work-run-finalizer](15-work-run-finalizer/spec.md); this project does not implement an
  independent merge path.
- **The learning loop:** explicit machine-readable feedback records drive a Rune-owned
  post-mortem that attributes the miss to a stage and writes one atomic lesson into that
  role's `memory.md`. Feedback-gated; "no lesson warranted" is allowed.
- **Gate:** loop closure, not quality — a deterministic fixture project goes from planning to
  at least two orchestrated task runs, updates `context.md` between them, and hands off to the
  finalizer with no live model call or human merge requirement.
- **Phase 10 — execution observability + auto-merge (reopened 2026-06-14):** orchestrated runs
  do real work but do it blind. The applier emits only a "starting" log and one terminal event
  (`orchestrated-work-runner.ts:347,373`), so codex/claude role activity never reaches the
  cockpit stream and the supervision heartbeat goes stale mid-run (it advances only on
  `output`/`activity` events the orchestrated path never emits — which also leaves a working run
  exposed to the quiet→cancel backstop). Phase 10 plumbs an event sink through the orchestration
  call stack, streams both executors (incremental `runCodex` + stream-json claude artifact
  path), and attributes every line by role/provider/model — first-class parity with the legacy
  `/work` runner. It then reuses that stream as the durable transcript so a clean orchestrated
  run produces the full finalizer substrate (`transcript.jsonl`, `summary.json`, work-product
  classification) and auto-merges through the Project 15 gated finalizer instead of holding for
  an operator (reversing the Phase 8 deliberate hold; merge stays gated, never self-merge).
  Triggered by the 2026-06-14 observation that "codex writing tests" showed nothing in the
  cockpit stream and didn't register for the heartbeat.
- **Phase 11 — orchestration resilience (reopened 2026-06-14):** the overnight project-17 run
  surfaced two structural failure modes. (A) Gate rejections discard the feedback that would fix
  them: QA fed already-redacted placeholders as test inputs, the tech-lead rejected with precise
  notes, and the orchestrator retried the whole workflow three times with identical inputs and
  no feedback (`team-task-workflow.ts:196`, `orch-attempt-cap.ts:50`) before blocking the entire
  run. (B) A server restart orphaned the run instead of resuming it: `reconcileOrphans`
  (`mutations-log.ts:45`) blindly flips a `running` mutation to `failed/orphaned`, the Phase 3
  `reconstructRun` is dead code, `TaskRunRecord`s are never persisted, and a double-terminal
  record results. Phase 11 threads rejection feedback into corrective retries (QA/coder revise
  *with* the notes), parks a genuinely-stuck task instead of killing the run, persists run state,
  and resumes a restarted run from durable state with exactly one terminal.
- **Phase 12 — role learning & exemplars (reopened 2026-06-14):** the same run exposed that the
  team has no memory and no model of "good" — all six role memories are cold-start, no role gets
  an exemplar of good output, and a gate block leaves zero durable lesson (the learning loop is
  nightly + explicit-feedback-only, `feedback-record.ts:5`). Phase 12 gives each role reference
  exemplars (a permanent `agents/<role>/examples/` baseline plus per-project exemplars the
  tech-lead emits at planning) and makes gate rejections teach: the rejecting role drafts a
  candidate lesson, a neutral Rune pass (`runPostMortem` model) validates/attributes it, and it
  lands in the counterpart's `memory.md` via `writeRoleLesson` at gate-time — making the learning
  loop gate-triggered, not just nightly, while keeping roles out of each other's memory directly.
- **Phase 13 — outcome gating (reopened 2026-06-16):** the 2026-06-15 Codex-stream run exposed
  that the review gate is effectively binary and unforgiving — severity is captured but unused (any
  objection hard-blocks), and a block maps to `failed` with the worktree destroyed instead of
  parking for a human. One reviewer objection (a redaction artifact, not a real defect) discarded a
  complete run. Phase 13 makes the four outcomes explicit (`pass` / `pass-with-warnings` / `fail` /
  `block`), drives them by severity (`critical`/`high`→block, `medium`→fail, `low`→warning), gives
  blocks one corrective coder round before parking `blocked-on-human` (worktree preserved), and adds
  an accept-with-rationale override. The `sk-` redaction collision that triggered it is already
  fixed on main (`fb2e2a0`); Phase 13 is the structural follow-up.
- **Provenance:** 2026-06-05 product-team design extending projects 08 and 12, merged with
  the 2026-06-07 Rune-orchestrated-work idea. The merged scope makes Rune the workflow
  owner rather than a launcher for one long `/work --auto` process.
- **Task breakdown & test plan:** see [tasks.md](14-product-team-agents/tasks.md) and [test-plan.md](14-product-team-agents/test-plan.md). Test-first per phase.

## 15-work-run-finalizer — Done

[Spec](15-work-run-finalizer/spec.md)

Make every `/work --auto` run reach a correct, durable terminal state on its own — even when the
agent emits `result: success` and then never exits — and give plain work-runs one gated path onto
`main`.

On 2026-06-06, run `d0679453` (project 12) emitted `result: success` at 04:38 and then sat `running`
until a human killed the process tree at 13:12 — ~8.5h. Hung background `vitest` tasks kept
`claude -p` alive; the keep-alive ticker made it look "quiet, not stalled"; the quiet nudge re-fired
every 30s; and the SIGTERM that finally killed it mis-classified the run `failed` despite a complete
branch. The work only reached `main` because a Rune assistant session merged it by hand. Same
symptom class as the 2026-06-04 wedge fix, different trigger (that fix assumed the process eventually
exits).

- **P0 — terminal correctness, no policy change.** A supervision-store field-merge so a heartbeat
  can't clear `quietNudgedAt`; a result-seen **watchdog** (bounded drain → conditional group reap →
  `reapedAfterTerminalResult` exit fact, never finalize-on-`result`); a classifier exit-fact taxonomy
  that calls an internal post-result reap of a clean branch `branch-complete` while a real
  user-cancel stays `failed`; and recovery that classifies/finalizes stale runs before the
  orphan-worktree sweep can race away the evidence.
- **P2 — backstops independent of agent cooperation.** A quiet→cancel actuator, a hard max-runtime
  ceiling the keep-alive ticker can't defeat, and a worktree-scoped process sweep for reparented
  grandchildren. Sequenced ahead of the policy change so an unattended sweep is safe.
- **P1 — gated auto-merge (decided policy change).** One shared, idempotent, phase-recorded
  `work-run-finalizer.ts` owning classify → gate → merge → push+verify → worktree remove → branch
  delete → terminal writes, resumable after a crash. The gate (tests green, clean tree, zero tasks
  remaining, no conflict, no concurrent owner) is the line between "autonomous" and "lands broken
  work on main," since runs use `--dangerously-skip-permissions`; the lock is per-product /
  per-base-branch; push happens before branch delete.
- **Self-reference:** Phase 4's regression suite reproduces the wedge trigger, so the watchdog and
  backstops land **attended** before any unattended `--auto` sweep of the later phases.
- **Provenance:** promoted 2026-06-06 from the `bugs.md` "`/work --auto` wedges open AGAIN" entry —
  two independent investigations (Claude + Codex) plus an adversarial Codex critique that converted
  an unsafe "finalize on `result`" proposal into the watchdog and flagged gated auto-merge as policy.
- **Task breakdown & test plan:** see [tasks.md](15-work-run-finalizer/tasks.md) and [test-plan.md](15-work-run-finalizer/test-plan.md). Test-first per phase.

## 16-claude-app-connector — Done

[Spec](16-claude-app-connector/spec.md)

Make the Rune chat surface portable into the Claude App via a lean six-tool MCP connector, at zero cost to the vault → pipeline → KB funnel Rune still owns. **Shipped 2026-06-10/11: live in the Claude App over a Tailscale Funnel; general/dev chat no longer requires Telegram.**

- **The bet:** the conversation surface was never the moat. Claude is the brain; the funnel (vault → pipeline → KB) is the asset. Port the surface into the Claude App, keep the funnel unchanged and Rune-owned. Dual-surface end state, not a Telegram retirement.
- **Six-tool surface:** `kb_query`, `vault_search`, `log_idea`, `crm_lookup`, `get_priorities`, `log_conversation` — exposed as a Claude App connector, kept deliberately lean. Built behind a shared `createRuneMcpServer` factory that splits the App-surface tools from the `kb_*` admin set (the admin tools are never remotely reachable). Ambient/health commands and Rune-pushed updates stay Telegram-only.
- **Write-back, no new stage:** `log_conversation` writes a finished thread into today's journal (summary or full reconstruction) and, when kb-worthy, into the KB raw-source queue; the nightly pipeline ingests it unchanged. The `summarizeSession` prompt + kb-worthy heuristic were ported verbatim into the App project instructions (the server is stateless to the App — no session lifecycle).
- **Routing:** `resolveProductTarget()` attributes captured ideas/bugs to the right product with an explicit inbox fallback — never dropped, never mis-attributed; loop-filed and App-filed ideas share one `product` attribution schema.
- **Transport + auth:** `StreamableHTTPServerTransport` at `/mcp` on the daemon HTTP server (host-allowlist → fail-closed bearer → SDK transport), and hand-rolled single-user OAuth 2.1 — DCR, a consent-form gate on `RUNE_HTTP_SECRET` (secret only ever in the POST body), PKCE S256-only, single-use codes, tokens bound to the one user id. Tokens are **persisted + never-expire** (`logs/mcp-oauth-store.json`, 0600) so the App authenticates once and survives daemon restarts; revoke by deleting the store + restarting.
- **Remote reachability:** a Tailscale Funnel exposes only `/mcp` + the OAuth-discovery paths at a stable `ts.net` hostname (TLS on-host, no inbound ports, the webview stays localhost-only). Chosen over Cloudflare Tunnel — no domain, no extra daemon, $0 — with the Cloudflare procedure kept as a documented fallback. See [tunnel-runbook.md](16-claude-app-connector/tunnel-runbook.md).
- **Provenance:** built test-first per phase (factory/routing/tool suites red → green; transport + OAuth suites red → green). Tunnel exposure, App connector registration, and the funnel-intact e2e acceptance test were operator-completed live; the repeatable acceptance procedure is [e2e-acceptance-test.md](16-claude-app-connector/e2e-acceptance-test.md). App project instructions: [app-project-instructions.md](16-claude-app-connector/app-project-instructions.md).
- **Task breakdown & test plan:** see [tasks.md](16-claude-app-connector/tasks.md) and [test-plan.md](16-claude-app-connector/test-plan.md). Test-first per phase.

## 17-cockpit-redesign — Done

[Spec](17-cockpit-redesign/spec.md)

A dev-focused, two-tier cockpit (cross-product Home pulse + per-product deep view) for working with Rune across all products, with realtime run visibility and Fix as the headline bug action.

Reframes the web view from ~90% chat into a development cockpit, now that KB research and idea exploration move to the Claude App ([16-claude-app-connector](16-claude-app-connector/spec.md)). Builds on the v1 product card, backlog drawer, and Plan promotion from [09-expand-cockpit](09-expand-cockpit/spec.md), and reads off the existing work-run observability/finalizer instrumentation (projects 11/13/14/15).

- **Two-tier IA:** a cross-product Home view (read-mostly pulse + router) and a non-negotiable per-product deep view that holds projects, backlog, runs, and per-product chat.
- **Realtime run visibility:** tasks updating in realtime (even with edits in a separate worktree), which agents are working a run, elapsed/live output/worktree path, and the most-recent run's logs readable from the persisted transcript.
- **Fix as the headline bug action:** clicking Fix triggers a PM + Tech-Lead scoping gate that returns a real decision — declined-with-reason or proceeding — and on a pass hands off to the deferred cross-repo autorun fix-run path through one clean seam.
- **Chat & sessions:** per-product dev/planning chat is the only web-view chat; session scoping moves to per product + Telegram; search broadens to repo + vault; `/fresh`, `/fresh-full`, `/clear` preserved.
- **Scope boundary:** surface redesign only — the cross-repo autorun plumbing behind Fix and the bug-to-bug sweep are separate deferred ideas; `/work` execution, finalization, and the backlog parser/promotion mechanics are unchanged.
- **Task breakdown & test plan:** see [tasks.md](17-cockpit-redesign/tasks.md) and [test-plan.md](17-cockpit-redesign/test-plan.md). Test-first per phase.

## 18-rebrand-rune-to-rune — Done

[Spec](18-rebrand-rune-to-rune/spec.md)

Cut the agent's public brand over to Rune across repo, runtime identity, env vars, and the local checkout, with behavior unchanged.

The retired brand is not trademark-clean or distinctively ownable; **Rune** is the chosen name, with `@runeai` as the public handle and part of the brand-ownability premise. The cutover is complete only when the public repo is renamed, the local checkout runs from `~/workspace/rune/`, the handle is owned, old public brand references are gone, private paths no longer leak into committed code, and the launchd daemon is healthy after the move.

- **Inventory first:** a case-insensitive `rune` sweep classifies every hit (brand-rewrite / public-identifier / private-functional / excluded-filename) and outputs the explicit acceptance allowlist.
- **Path de-leak:** extract hardcoded `/Users/jarvis/workspace/rune/...` references behind `RUNE_*` env vars with computed defaults, rename `RUNE_LOGS_DIR` to `RUNE_LOGS_DIR`, and convert the known holdouts; lands and is verified before any disk move.
- **Brand + runtime sweep:** rewrite agent-name references across docs, metadata, CI, URLs, and agent-prompt prose, and rename public runtime identifiers (e.g. the `rune-kb` MCP server) with focused tests.
- **Repo, handle, cutover:** rename the GitHub repo to `rune` and claim `@runeai` (independent of the disk move), then move the checkout to `~/workspace/rune/` and reload the daemon (label stays `com.jarvis.daemon`).
- **Non-goals:** no macOS account/home rename, no launchd label rename, no agent-filename renames, no history rewrite, no visual identity, no compatibility alias.
- **Task breakdown & test plan:** see [tasks.md](18-rebrand-rune-to-rune/tasks.md) and [test-plan.md](18-rebrand-rune-to-rune/test-plan.md). Test-first per phase.

## 19-rune-product-os — Done

[Spec](19-rune-product-os/spec.md)

> Phases 1-5 + 7 merged to `main` 2026-06-29 (gate green). Phase 6 (Writing & Brand) was extracted to the michaelcjoseph.com `01-rune-writing-product` project — its deliverables live in a second repo that a single-repo orchestrated run can't write to. The rune-side writing engine (`/blog`, `/writing-critique`, pipeline) still landed here.

The cockpit becomes a product operating system: every product Rune touches — external (aura, assay, relay, writing, brand) and internal (Rune, Rune MCP) — is a first-class entity sharing one spine, with internal/external as a top-level UI distinction. Four workstreams. The prior "full-vault warm index" project was one slice of W1; it lands here as Phase 2.

- **W1 — MCP re-architecture:** split the MCP into a standalone, always-on service so cockpit restarts never force the Claude App to re-authenticate (Phase 1); hold the full vault + an in-memory index warm so deep search answers without timeouts, no vector DB (Phase 2, the carried-forward warm-index work); add journal-range pulls, link-following, tag/date queries, and a live metrics endpoint (Phase 3).
- **W2 — Cockpit product-OS reframe:** make the existing three containers (projects/ideas/bugs; operations/runs; chat) product-aware, draw the internal/external line (Phase 4), and add a monitoring tab — internal-only (MCP call metrics + Rune run metrics read from the live endpoint), stubbed on external products (Phase 5).
- **W4 — Writing & Brand (Phase 6, EXTRACTED 2026-06-29):** moved to the michaelcjoseph.com `01-rune-writing-product` project — `michaelcjoseph.com` becomes a two-product repo (Brand + Writing `/rune/{topic}`), built as a separate writing-scoped run since a single-repo orchestrated run can't write a second repo. The rune-side engine (`/blog`, `/writing-critique`, writing pipeline) landed with this merge.
- **W3 — Knowledge freshness:** a Rune-nightly reconciliation step that supersedes curated facts contradicted by newer journal entries; the in-flight Jarvis→Rune drift is the canonical proof case (Phase 7, parallelizable).
- **Non-goals:** no vector DB, no external-product monitoring (stubs only), no migration of historical writing content.
- **Task breakdown & test plan:** see [tasks.md](19-rune-product-os/tasks.md) and [test-plan.md](19-rune-product-os/test-plan.md). Test-first per phase.

## 20-pm-scoping-self-review — Not Started

[Spec](20-pm-scoping-self-review/spec.md)

The PM runs the `/plan` interview directly and writes the spec; one approval, streamed downstream progress, and a fresh-context fix-it self-review for PM, Tech Lead, and Coder.

Removes the lossy Planner→PM brief handoff and the block-for-interview bounce: the PM conducts the full multi-turn scoping interview and writes the spec from first-hand context. Each artifact-producing role re-reads its own output cold and fixes issues before any downstream role sees it. A per-stage progress stream removes the dead air the moved approval boundary would otherwise create.

- **Merge the interview into the PM:** `defaultScopingTurn` composes the PM charter and runs the interview on the persistent planning-session id (the one intentional fresh-context exception), emitting the spec directly via a `pm-spec` fence; the planning-brief handoff is retired.
- **Retire the specified-enough gate** from `/plan` so no run can bounce the user into a second interview, with a regression test.
- **One durable approval gate:** the pending approval stores the revised PM spec plus enough state for `/approve` to resume the downstream pipeline (tech-lead breakdown → `pmReviewMatch` → Claude critique → Codex critique → context seed → scaffold) after a restart.
- **Progress streaming:** every downstream stage emits one informational line; terminal failures and final scaffold success (with the created identifier) are surfaced, human-gate count stays one.
- **Fix-it self-review:** a reusable `runSelfReview<A>` primitive gives PM (spec), Tech Lead (tech-spec + tasks), and Coder (code diff) one cold fix-pass each — corrected-or-confirmed artifact, no loop, no new gate.
- **Task breakdown & test plan:** see [tasks.md](20-pm-scoping-self-review/tasks.md) and [test-plan.md](20-pm-scoping-self-review/test-plan.md). Test-first per phase.

## 21-parallel-product-chats — Not Started

[Spec](21-parallel-product-chats/spec.md)

Turn the webview into a real parallel workspace instead of a fire-and-wait one.

Today a turn in product B is blocked behind product A's turn (a per-user dispatch queue), and a reply can even land in the wrong panel (responses broadcast by userId with no scope). This project makes different product chats dispatch and run concurrently, tags every response frame with its product scope, and routes/buffers each into its own transcript with an unread cue on the sibling channel and the home view — plus cross-tab sync. The session store is untouched (already scoped per product/transport/user); only dispatch and delivery change.

- **Phase 1 (shippable):** re-key the dispatch queue per scope using the shared session-scope key helper; scope-tag turn-scoped message/status frames and any chunk frames in the WS path; a per-turn scoped-sender wrapper (shared `MessageSender` interface unchanged, Telegram unaffected); frontend per-scope routing, buffering, switch-back, and the browser-local unread/activity cue.
- **Phase 2 (separable):** a live "working now" indicator on a backgrounded panel (op-event scope threaded through `execClaude`).
- **Definition of Done requires a live operator gate:** the operator completes the real fire-and-switch loop once in the browser — concurrent turns, per-panel streaming, the activity cue on the sibling channel + home view, buffered switch-back, and two-tab rendered sync. A green suite and reachable paths explicitly do not count. This is the honored form of project 20's skipped `live-reachability-gate`.
- **Provenance:** scaffolded by hand 2026-07-02 from the operator-approved PM spec after the `/plan` downstream pipeline threw at the `pmReviewMatch` gate — correctly, because the initial tech-lead breakdown verified the frontend only with jsdom + WS tests, which the spec's DoD rejects. The two failure-handling defects that made that throw silent and unrecoverable are filed in [bugs.md](bugs.md).
- **Task breakdown & test plan:** see [tasks.md](21-parallel-product-chats/tasks.md) and [test-plan.md](21-parallel-product-chats/test-plan.md). Test-first per phase; the live gate is required.
