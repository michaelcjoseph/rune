# Projects

Build log for Jarvis — one numbered project per directory. The table below is the
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
| [08-intent-layer](08-intent-layer/spec.md) | In Progress | Jarvis becomes an intent-layer orchestrator over multi-model sub-agents. |
| [09-expand-cockpit](09-expand-cockpit/spec.md) | Done | Per-product bugs and ideas in the cockpit, with one-click Plan to start a real planning session. |
| [10-jarvis-identity-refactor](10-jarvis-identity-refactor/spec.md) | Done | Symlink AGENTS.md → CLAUDE.md per repo (drift becomes impossible) and move Jarvis orchestrator identity out of pkms/CLAUDE.md into jarvis. Rescoped from a compiler build — see spec. |
| [11-work-run-observability](11-work-run-observability/spec.md) | Done | Make `/work --auto` runs observable: classify outcome on work product (not exit code), persist a durable transcript, retain forensics, and alert truthfully. |
| [12-writer-memory](12-writer-memory/spec.md) | Done | A content-writer role-agent (SOUL.md charter + accumulating memory.md) behind `/blog` that captures craft lessons from feedback and compounds them into the next piece. The smallest test of role-agent + memory. |
| [13-work-run-monitoring](13-work-run-monitoring/spec.md) | Done | Make automated `/work --auto` runs findable and testable: surface the worktree path, keep a parked run's worktree alive when a task needs a human, and release clean parked work back to the Project 15 finalizer. |
| [14-product-team-agents](14-product-team-agents/spec.md) | Done | Jarvis coordinates a simulated product team across a whole project: PM/tech-lead planning, QA-first per-task execution, bounded `context.md` handoff, reviewer/designer gates, Project 15 finalizer handoff, and feedback-driven role memory. |
| [15-work-run-finalizer](15-work-run-finalizer/spec.md) | Done | Make every `/work --auto` run reach a correct terminal state on its own — even when the agent emits `result: success` then never exits — and give plain work-runs one gated, resumable path onto `main`. Closes the six-defect "wedges open AGAIN" incident. |
| [16-claude-app-connector](16-claude-app-connector/spec.md) | Not Started | Make the Jarvis chat surface portable into the Claude App via a lean six-tool MCP connector, at zero cost to the vault → pipeline → KB funnel Jarvis still owns. |

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

Jarvis becomes an intent-layer orchestrator over multi-model sub-agents.

Evolves Jarvis from a reactive command-router into an orchestrator with a persistent intent
layer: it reasons about Michael's goals, discusses them into approved specs, then dispatches
and supervises sub-agents across multiple foundation models (Claude, Codex) and domains
(coding first). Extends the cockpit [06-webview](06-webview/spec.md) shipped, and widens
self-improvement to cover Jarvis's own operation.

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
- **Plan + promotion job:** durable JSONL job log (`state/promotions.jsonl`) drives the `planning-started → scaffolded → marked-source` chain across Jarvis restarts. Scaffold contract adds a structured `scaffold-result` JSON block from the agent, cross-checked against the existing repo-diff verification from `approve.ts`.
- **Provenance:** recovered from the 2026-05-26 `/plan` conversation; spec is the post-Codex-critique revision the user approved. See [`08-intent-layer/agent-lessons.md`](08-intent-layer/agent-lessons.md) Lessons 8–11.
- **Task breakdown & test plan:** see [tasks.md](09-expand-cockpit/tasks.md) and [test-plan.md](09-expand-cockpit/test-plan.md). Test-first per phase.

## 10-jarvis-identity-refactor — Done

[Spec](10-jarvis-identity-refactor/spec.md)

Two surgical edits: make `AGENTS.md` a symlink to `CLAUDE.md` per repo so the two can never drift, and move Jarvis's orchestrator identity out of `pkms/CLAUDE.md` into `jarvis/CLAUDE.md`. **Rescoped 2026-06-02** from a five-repo canonical-source compiler — see the spec's Scope change section.

- **Why rescoped:** no instruction will ever differ between CLAUDE.md and AGENTS.md (same instructions, different per-model prompts), so a compiler whose renderers must produce identical output is a copy with extra steps. A symlink delivers zero drift for zero machinery.
- **Drift fix:** `ln -s CLAUDE.md AGENTS.md`. Core repos jarvis + pkms (both currently drifted); best-effort assay + aura; relay has no instruction files.
- **Identity fix:** move the `## Jarvis` and `### How Reviews Work` sections from pkms to jarvis, leave a one-line pointer. The git diff is the proof of preservation.
- **Dropped:** the compiler, IR, renderers, manifest, `$JARVIS_HOME` wrapper, inventory verifier, CI drift checks, and `per-repo-migration.md`. The persistent-role-agent / SOUL.md / per-agent-memory architecture is a separate project (ideas.md → "Better agentic systems").
- **Task breakdown & test plan:** see [tasks.md](10-jarvis-identity-refactor/tasks.md) and [test-plan.md](10-jarvis-identity-refactor/test-plan.md).

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

- **The role:** `jarvis/agents/writer/{SOUL.md, memory.md}` in the jarvis repo. `SOUL.md` (charter, system-prompt authority) references `writing/voice.md`; `memory.md` (accumulating craft lessons, low-authority reference) loads in the user turn, never the system prompt.
- **Read path:** a loader reading from `PROJECT_ROOT/agents/writer/` returns `{ systemInstructions, referenceContext }` so memory never gains command authority; char-budgeted with a truncation marker.
- **Write path:** after a mandatory feedback checkpoint the writer emits a completion sentinel; `blogHandler` closes the session and a TypeScript `captureLessons()` dedupes, privacy-filters, appends, and atomically commits to the jarvis repo. No approval gate; Michael reviews later.
- **Gate:** loop closure, not quality — a fixture lesson captured on piece N appears in piece N+1's reference context. Quality eval (engagement metrics) is a future phase in [ideas.md](ideas.md).
- **Outcome (loop closes ✅):** all three phases shipped. The automated gate `src/writer/loop-closure.test.ts` proves a marked lesson captured via the real `captureLessons` → temp `memory.md` → real `composeWriterContext` round-trips into piece N+1's `referenceContext` (and never the system channel). The blog flow runs the writer role end-to-end (SOUL on the system channel, seeded `memory.md` as user-turn reference, sentinel-driven server-owned closure, fault-isolated + timeout-bounded auto-commit of memory.md on `main` only). Seed baseline: 20 provenance-stamped craft bullets mined from 46 spec links.
- **Scope:** one role, jarvis repo only, no cross-product. The planning pipeline and engagement-driven lessons are separate ideas in [ideas.md](ideas.md).
- **Provenance:** planned 2026-06-02 from the top `ideas.md` bullet ("Better agentic systems"); three Codex critique rounds (over-engineering → adjust → architecture-fit) cut it from a five-role memory-substrate-plus-pipeline build down to this single-role wedge.
- **Task breakdown & test plan:** see [tasks.md](12-writer-memory/tasks.md) and [test-plan.md](12-writer-memory/test-plan.md). Test-first per phase.

## 13-work-run-monitoring — Done

[Spec](13-work-run-monitoring/spec.md)

Make an automated `/work --auto` run reachable and testable by a human when it needs one.

Today the runner executes in a worktree at a deterministic path that is not consistently surfaced as
an operator-actionable value. Project 15 now owns normal terminalization and gated merge, so this
project covers the remaining gap: when a run hits a step `--auto` can't do — the interactive Codex
check that stalled project 10 — Jarvis needs a durable parked state, a live worktree, and a clean
hand-back to the finalizer after the human acts.

- **Findability:** surface the (already-deterministic) worktree path + run id in notifications, on
  a local-operator field that stays un-scrubbed (the scrubber strips exactly the prefix you'd `cd`
  to).
- **Parked state:** a run that needs a human emits a durable `blocked-on-human` state, keeps its
  worktree alive, blocks finalizer teardown/merge, and holds the per-project slot — surviving a
  Jarvis restart.
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

## 14-product-team-agents — Done

[Spec](14-product-team-agents/spec.md)

Jarvis coordinates a persistent product team across an entire project.

Generalizes the Project 12 role-agent pattern (`SOUL.md` charter + compounding `memory.md`)
from one writer to six roles — PM, tech lead, QA, coder, reviewer, designer — and folds in
the Jarvis-owned project orchestration idea formerly captured as project 16. The useful
product is not standalone role agents; it is Jarvis running the team task-by-task with
explicit context handoff.

- **The team:** fixed roles with fixed review edges. PM writes the spec and assumptions; tech
  lead breaks it into task-sized slices, role sizing, test strategy, and designer-needed
  flags; QA writes tests first; coder implements; reviewer (cross-model) and tech lead
  review; designer checks only tech-lead-flagged front-end/designer-needed work.
- **Jarvis owns the project loop:** select first unchecked task, assemble bounded context,
  invoke the role workflow in a fresh execution context, record task evidence, update
  `docs/projects/<project>/context.md`, then advance/retry/block.
- **Context handoff:** `context.md` is Jarvis-owned orchestration state, not role memory and
  not a seventh role. It carries current state, key decisions, interfaces/contracts, known
  risks, and next-task handoff.
- **Objection classes are hard gates:** security, data integrity, concurrency, irreversibility,
  and cost/perf findings block task completion and PM cannot wave them through.
- **Finalizer handoff:** when no unchecked tasks remain, Jarvis hands branch/run facts to
  [15-work-run-finalizer](15-work-run-finalizer/spec.md); this project does not implement an
  independent merge path.
- **The learning loop:** explicit machine-readable feedback records drive a Jarvis-owned
  post-mortem that attributes the miss to a stage and writes one atomic lesson into that
  role's `memory.md`. Feedback-gated; "no lesson warranted" is allowed.
- **Gate:** loop closure, not quality — a deterministic fixture project goes from planning to
  at least two orchestrated task runs, updates `context.md` between them, and hands off to the
  finalizer with no live model call or human merge requirement.
- **Provenance:** 2026-06-05 product-team design extending projects 08 and 12, merged with
  the 2026-06-07 Jarvis-orchestrated-work idea. The merged scope makes Jarvis the workflow
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
branch. The work only reached `main` because a Jarvis assistant session merged it by hand. Same
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

## 16-claude-app-connector — Not Started

[Spec](16-claude-app-connector/spec.md)

Make the Jarvis chat surface portable into the Claude App via a lean six-tool MCP connector, at zero cost to the vault → pipeline → KB funnel Jarvis still owns.

- **The bet:** the conversation surface was never the moat. Claude is the brain; the funnel (vault → pipeline → KB) is the asset. Port the surface into the Claude App, keep the funnel unchanged and Jarvis-owned. Dual-surface end state, not a Telegram retirement.
- **Six-tool surface:** `kb_query`, `vault_search`, `log_idea`, `crm_lookup`, `get_priorities`, `log_conversation` — exposed as a Claude App connector, kept deliberately lean. Ambient/health commands and Jarvis-pushed updates stay Telegram-only.
- **Write-back, no new stage:** `log_conversation` writes a finished thread into today's journal (summary or full reconstruction) and, when kb-worthy, into the KB raw-source queue. The nightly pipeline ingests it unchanged.
- **Routing:** `resolveProductTarget()` attributes captured ideas/bugs to the right product with an explicit inbox fallback — never dropped, never mis-attributed.
- **Transport + auth:** a shared `createJarvisMcpServer` factory, `StreamableHTTPServerTransport` at `/mcp`, single-user OAuth gated on `JARVIS_HTTP_SECRET`, and a Cloudflare Tunnel — single-user secure access into the live vault working tree.
- **Task breakdown & test plan:** see [tasks.md](16-claude-app-connector/tasks.md) and [test-plan.md](16-claude-app-connector/test-plan.md). Test-first per phase.
