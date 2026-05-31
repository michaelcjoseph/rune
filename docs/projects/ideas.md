# Project Ideas

User-authored ideas for future projects sit above the loop-filed marker;
the observation loop (project 08 Phase 5) appends machine-filed ideas
below it.

## User-authored

- Better agentic systems
  - agents
    - product spec planning agent
      - adversarial interviewer
      - drafts product spec, self critiques using multiple models and fixes
      - should be human readable
    - tech spec planning agent
      - converts product spec into tech spec
      - named modules with file paths
      - explicit non-goals
      - dependency list
      - drafts product spec, self critiques using multiple models and fixes
    - tasks planning agent
      - break down tech spec into a task list
      - tasks should be as small as possible but still meaningful enough to be a commit
    - test plan planning agent
      - break down tech spec into a test plan
    - project wrap up agent
      - update projects index with final outcome of project
      - update agent memory
  - memory
    - agent lessons
      - track things the agent learned from mistakes / behaviors that had to be corrected so that they are not done again
    - decision log
      - One entry per non-obvious decision, with the context, the options considered, the choice, and crucially the reasoning and any expiration condition
      - The agents reads this before proposing approaches. Wrap-up agent proposes new entries based on what was decided mid-project.
    - patterns and anti-patterns library
    - gotchas registry
      - one liners are useful tidbits to keep in mind
    - architecture docs
    - glossary
    - product spec template
    - tech spec template
- Work-run visibility, observability & debugging in cockpit
  - **Motivation (learned the hard way, 2026-05-30).** Two `/work --auto` runs on project 10 — `7828477a` (05-30) and `3b002b26` (05-27) — produced zero commits and 0/59 tasks checked, yet `7828477a` was reported `completed` ("finished in 1188.4s") in both Telegram and the cockpit. We could not diagnose why, because a work run leaves almost no forensic trail. Goal: make `/work` runs observable, verifiable, and debuggable end to end.
  - **Root problems found in the current implementation:**
    - "Completed" means only `exitCode === 0` (`src/jobs/work-runner.ts:297`). Nothing checks the actual work product (commits on the run branch, `tasks.md` checkbox delta), so a clean-but-empty exit is indistinguishable from real success.
    - The child is spawned `claude -p <prompt>` with no `--output-format stream-json` and no `--verbose` (`work-runner.ts:165`); stdout is just the final result text, so there is no turn-by-turn transcript.
    - Per-line `output` events stream to the cockpit drawer only while it is open (`src/server/static/app.js:1116`) and are persisted nowhere. Close the drawer and the run goes dark.
    - `logs/mutations.jsonl` records only lifecycle transitions (pending → running → completed); it drops exitCode, durationMs, and all output. `jarvis.log` keeps a single `work-run finished {durationMs}` line. `supervised-runs.json` keeps status + heartbeats. That is the entire trail.
    - The worktree is torn down in a `finally` on every exit path (`work-runner.ts:190`), so the run's tree cannot be inspected after it ends.
    - A stuck run shows a stale `running` pill until stall-check times out; the failure reason never reaches the card.
  - **Outcome observability — verify the run actually did something:**
    - Classify the terminal state on work product, not just exit code: commits on `main..<run-branch>` plus `tasks.md` checkbox delta.
    - Add a distinct `completed-noop` (or `failed: no-work-product`) state for exit 0 with zero commits and zero task changes. This single check would have caught both silent runs.
    - Record per-run outcome facts in the run store: exit code, signal, duration, commit count, files changed, tasks newly checked, and a short reason string.
    - Snapshot the run branch's commit shas + diffstat before the worktree is destroyed, so the no-op-vs-real-work verdict survives teardown.
  - **Debugging & logs — make a run reconstructable after the fact:**
    - Spawn the child with `--output-format stream-json --verbose` so every turn (assistant text + tool calls) lands on stdout.
    - Persist the full event stream to a durable per-run file, e.g. `logs/work-runs/<run-id>.jsonl`, regardless of whether any cockpit drawer is open.
    - Capture the last N stdout lines and the stderr tail on the run record for quick triage without opening the full log.
    - On failure or no-op, retain the worktree (or a `git bundle` / patch of the run branch) for inspection instead of always destroying it.
    - Keep a rolling index of recent runs (id, project, status, outcome, duration, started/ended) at `logs/work-runs/index.jsonl`.
  - **Cockpit UX (keep all of the original polish):**
    - Stream the last N lines of agent output for active runs directly on the project card, not only in an opened drawer.
    - Surface the current step or phase the agent is on (parsed from the stream).
    - Show elapsed time alongside the run-status pill.
    - Surface the failure/no-op reason in the card when a run breaks (exit code + reason), instead of a stale `running` pill.
    - Link each card to its persisted `logs/work-runs/<id>.jsonl` for the full transcript.
    - Add a "restart" button to restart the server after changes land.
  - **Alerts:**
    - Telegram alert on run failure AND on no-op completion, carrying the reason and a one-line outcome summary (commits, tasks), not just "finished in Ns".
    - Telegram alerts when a run pauses midway
    - Telegram alerts when a task in the task list of a run is marked as complete
    - Telegram alerts when an entire project is completed
  - **Open questions to settle in planning:**
    - Whether the deeper bug is observability alone or also a structural mismatch — a one-shot `claude -p` may not sustain a multi-task `/work --auto` sweep across turns. The transcript persistence above is the prerequisite for diagnosing this on the next run; the fix, if confirmed, may belong to `/work` itself rather than to this project.
    - Build this slice by hand or in a watched run, not via fire-and-forget `/work --auto` — the failing mechanism can't be trusted to build its own safety net.
- Agentic control surfaces — compile/cascade beyond prose (project 11)
  - Premise: project 10 lifts category 1 (prose instructions: CLAUDE.md/AGENTS.md) to a canonical source and cascades it down. That's one of five agentic-control surfaces. The same "model-agnostic intent, model-specific encoding" pattern applies to the rest, which today are hand-set per-layer with no canonical home and real drift risk.
  - The five categories: (1) what the agent KNOWS — prose/context [project 10, separate]; (2) what it CAN DO — tools, MCP servers, permissions, --add-dir; (3) what it MUST/MUST NOT do — hooks/enforced behavior; (4) what it can INVOKE — skills, commands, sub-agent definitions; (5) what it RUNS IN — env, cwd, model, timeouts.
  - Scope for project 11: categories 2, 3, and 4. Category 1 is project 10; category 5 mostly already lives centralized in code (src/ai/claude.ts spawn) and is lowest priority — out of v1.
  - Category 2 (capabilities/permissions): today split awkwardly across .claude/settings.json (committed mcpServers), .claude/settings.local.json (permissions.allow), and code (claude.ts pins MCP config + --add-dir at spawn). Goal: one canonical capability/permission source per repo, cascaded to the model-specific settings files, drift-checked like project 10 does for prose.
  - Category 3 (enforced behavior / hooks): the non-response Stop hook (scripts/hooks/block-nonresponse.cjs, registered in global ~/.claude/settings.json, committed 3302938) is the FIRST concrete deliverable of this category and the seed of project 11. Built standalone now; project 11 gives it a canonical home so hook definitions cascade rather than being hand-registered per layer. Open question flagged: confirm whether Codex supports hooks at all, and whether --dangerously-skip-permissions (used by the daemon spawn) honors Stop hooks — both checkable, both gate the cascade design.
  - Category 4 (skills/commands/sub-agent defs): the biggest duplication surface — 30+ agent defs split between jarvis/.claude/agents (generic) and pkms/.claude/agents (personal-specifics), plus .claude/skills. Project 10 EXPLICITLY deferred this (its non-goal: "compiling .claude/agents/*.md"). Highest-effort, highest-payoff, likely the last phase.
  - Relationship to project 10: sibling, not child. Project 10 = "compile category 1." Project 11 = "compile/cascade categories 2-4." Keep 10 clean and shipping; do not expand it. Project 11 should reuse 10's compiler architecture (canonical source → model-specific renderers → CI drift check) where the surface is file-based config; categories that live in spawn code (parts of 2 and 5) need a different mechanism than a markdown compiler — design question for the spec.
  - Dependency: best started after project 10 ships, so the compiler/IR/renderer pattern exists to extend rather than reinvent.
- quarterly and annual SEC reports ingestion of companies I'm following
- Monitor and ingest research papers on topics of interest for my KB (quantum, space, AI, etc)
- Monitor and ingest X posts for relevant topics and report them to me daily
- Integrate Granola MCP for Jarvis to better manage meeting transcription notes
- Multiple tabs for webview for different chat sessions
- Set up email, X, blog, and website for Jarvis
  - Self learning loops to identify what content generates engagement and what doesn't
- set up child developmental agent support to help with monitoring progress and planning weekly

## Loop-filed

<!-- observation-loop appends `- **Title** — friction` bullets below this comment.
     The B4.2 reader (`readFiledIdeas` in src/intent/observation-ideas-io.ts)
     parses only the lines under this section header so user-authored ideas above
     never collide with loop-filed dedupe. -->
