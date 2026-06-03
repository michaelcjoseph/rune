# Project Ideas

User-authored ideas for future projects sit above the loop-filed marker;
the observation loop (project 08 Phase 5) appends machine-filed ideas
below it.

## User-authored

- As part of nightly processing, Jarvis should read vault notes and add items to ideas and bugs
- Planning pipeline — specialized planning role-agents (its own project)
  - The pipeline that turns an approved product spec into a buildable plan, each stage a role-agent reusing project 08's Planner + `/work` + model-selection policy (retrofit, not a new runtime). The per-agent memory substrate is spun out to **project 12** (the writer-role compounding-memory wedge); this pipeline reuses that proven charter + memory + wrap-up-write pattern once it lands, rather than reinventing it.
  - Stages:
    - **product-spec agent** — the existing Planner, retrofit as the `pm` role-agent: adversarial interviewer, human-readable spec, multi-model self-critique (a different model critiques the draft, revise, repeat to a round cap).
    - **tech-spec agent** — product spec → tech spec: named modules with file paths, explicit non-goals, dependency list; same multi-model self-critique.
    - **tasks agent** — tech spec → task list; each task as small as possible but still a meaningful commit.
    - **test-plan agent** — tech spec → test plan, mirroring the tasks' test-first blocks.
    - **wrap-up agent** — update the projects index with the project's final outcome, and write durable memory (the compound step).
  - Per-product / code memory the pipeline will want (decision log, gotchas registry, architecture docs, glossary, product-spec + tech-spec templates) builds on project 12's role-memory pattern; deferred until that wedge proves out. Memory is whole-file markdown loaded as low-authority reference (not system-prompt authority); the typed-schema / cascade-composer / conflict-resolution machinery was cut as premature ceremony.
  - Open: does `tech-spec.md` become a required scaffold artifact (add a `techSpec` key to the Planner artifact + project 09's scaffold-result contract), or stay an optional stage output?
  - Dependency: best started after project 12 validates the charter + memory + wrap-up-write loop end to end (writer role, jarvis repo), so the pipeline inherits a proven pattern.
- Engagement-driven writing lessons (extends project 12)
  - Set up email, X, blog, and website for Jarvis
  - Once the writer role's feedback-driven memory loop (project 12) works, drive lessons from real content-engagement results, not just Michael's feedback. Pipe back performance signals the publishing channel exposes (views, reads, completion, shares, replies) so the wrap-up step proposes `memory.md` entries from outcomes, and the writer learns what actually landed with the audience rather than only what Michael corrected. Closes the loop from "Michael's taste" to "the audience's response." Accepted direction (not an open question); builds directly on project 12's SOUL + memory + wrap-up-write pattern.
- Agentic control surfaces — compile/cascade beyond prose
  - Premise: project 10 lifts category 1 (prose instructions: CLAUDE.md/AGENTS.md) to a canonical source and cascades it down. That's one of five agentic-control surfaces. The same "model-agnostic intent, model-specific encoding" pattern applies to the rest, which today are hand-set per-layer with no canonical home and real drift risk.
  - The five categories: (1) what the agent KNOWS — prose/context [project 10, separate]; (2) what it CAN DO — tools, MCP servers, permissions, --add-dir; (3) what it MUST/MUST NOT do — hooks/enforced behavior; (4) what it can INVOKE — skills, commands, sub-agent definitions; (5) what it RUNS IN — env, cwd, model, timeouts.
  - Scope for project 11: categories 2, 3, and 4. Category 1 is project 10; category 5 mostly already lives centralized in code (src/ai/claude.ts spawn) and is lowest priority — out of v1.
  - Category 2 (capabilities/permissions): today split awkwardly across .claude/settings.json (committed mcpServers), .claude/settings.local.json (permissions.allow), and code (claude.ts pins MCP config + --add-dir at spawn). Goal: one canonical capability/permission source per repo, cascaded to the model-specific settings files, drift-checked like project 10 does for prose.
  - Category 3 (enforced behavior / hooks): the non-response Stop hook (scripts/hooks/block-nonresponse.cjs, registered in global ~/.claude/settings.json, committed 3302938) is the FIRST concrete deliverable of this category and the seed of project 11. Built standalone now; project 11 gives it a canonical home so hook definitions cascade rather than being hand-registered per layer. Open question flagged: confirm whether Codex supports hooks at all, and whether --dangerously-skip-permissions (used by the daemon spawn) honors Stop hooks — both checkable, both gate the cascade design.
  - Category 4 (skills/commands/sub-agent defs): the biggest duplication surface — 30+ agent defs split between jarvis/.claude/agents (generic) and pkms/.claude/agents (personal-specifics), plus .claude/skills. Project 10 EXPLICITLY deferred this (its non-goal: "compiling .claude/agents/*.md"). Highest-effort, highest-payoff, likely the last phase.
  - Relationship to project 10: sibling, not child. Project 10 = "compile category 1." Project 11 = "compile/cascade categories 2-4." Keep 10 clean and shipping; do not expand it. Project 11 should reuse 10's compiler architecture (canonical source → model-specific renderers → CI drift check) where the surface is file-based config; categories that live in spawn code (parts of 2 and 5) need a different mechanism than a markdown compiler — design question for the spec.
  - Dependency: best started after project 10 ships, so the compiler/IR/renderer pattern exists to extend rather than reinvent.
- Use ampcode.com with Jarvis instead of Claude/Codex CLI
- quarterly and annual SEC reports ingestion of companies I'm following
- Monitor and ingest research papers on topics of interest for my KB (quantum, space, AI, etc)
- Monitor and ingest X posts for relevant topics and report them to me daily
- Integrate Granola MCP for Jarvis to better manage meeting transcription notes
- set up child developmental agent support to help with monitoring progress and planning weekly

## Loop-filed

<!-- observation-loop appends `- **Title** — friction` bullets below this comment.
     The B4.2 reader (`readFiledIdeas` in src/intent/observation-ideas-io.ts)
     parses only the lines under this section header so user-authored ideas above
     never collide with loop-filed dedupe. -->
