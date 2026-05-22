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
| [08-intent-layer](08-intent-layer/spec.md) | Planned | Jarvis becomes an intent-layer orchestrator over multi-model sub-agents. |

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

## 08-intent-layer — Planned

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
