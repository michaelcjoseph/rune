# Project Ideas

User-authored ideas for future projects sit above the loop-filed marker;
the observation loop (project 08 Phase 5) appends machine-filed ideas
below it.

## User-authored

- Expand cockpit → 09-expand-cockpit
  - Make bugs and ideas for each product visible in the cockpit. 
  - Add a "plan" button next to each idea, which kicks off a planning session to create a project with spec, task list and test plan.
  - Add a "fix" button next to each bug, which does an interview as well for context generation, spings up the coding agent planning mode, and executes the fix.
  - Each bug or idea gets turned into a project and follows the normal planning session.
  - Add a "+" button next to "bugs" and "ideas" to easily add a new item.
- Work-run visibility in cockpit
  - Stream the last N lines of agent output for active `/work` runs in the project card.
  - Surface the current step or phase the agent is on.
  - Show elapsed time alongside the run-status pill.
  - Surface failure reason in the card when a run breaks (exit code + error message). Currently buried in `logs/mutations.jsonl`; cockpit just shows a stale `running` pill until stall-check times out.
  - Optional Telegram alert on run failure.
  - Add "restart" button to cockpit to restart server after changes land
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
