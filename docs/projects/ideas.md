# Project Ideas

User-authored ideas for future projects sit above the loop-filed marker;
the observation loop (project 08 Phase 5) appends machine-filed ideas
below it.

## User-authored

- Set up CLAUDE.md and AGENTS.md for repos that do not have them
- Improve design of MCP monitoring in cockpit
- Expand MCP functionality
- Install tools to improve agent performance
  - https://colbymchenry.github.io/codegraph/ (for each product repo)
  - https://github.com/cursor/plugins/blob/683cdbda983ea8be4b766ac3fe94b7b88e7f75ad/cursor-team-kit/agents/thermo-nuclear-code-quality-review.md (code review skill)
  - https://smartcommit.labrun.app/ (better commits)
  - code mode https://blog.cloudflare.com/code-mode-mcp/
  - https://www.rtk-ai.app/#install
  - https://browser-use.com
- Symlink mirror agents between .claude and .agents (dotagents.sentry.dev)
- As part of nightly processing, Rune should read vault notes and add items to ideas and bugs
- Engagement-driven writing lessons (extends project 12)
  - Once the writer role's feedback-driven memory loop (project 12) works, drive lessons from real content-engagement results, not just Michael's feedback. Pipe back performance signals the publishing channel exposes (views, reads, completion, shares, replies) so the wrap-up step proposes `memory.md` entries from outcomes, and the writer learns what actually landed with the audience rather than only what Michael corrected. Closes the loop from "Michael's taste" to "the audience's response." Accepted direction (not an open question); builds directly on project 12's SOUL + memory + wrap-up-write pattern.
- Research agent
  - Coud potentially be done via Claude Cowork writing to the pkms
  - quarterly and annual SEC reports ingestion of companies I'm following
  - Monitor and ingest research papers on topics of interest for my KB (quantum, space, AI, etc)
  - Monitor and ingest X posts for relevant topics and report them to me daily
- Socratic method interview agent to pair with writer
  - Interviews me as part of the writing process for any topic
  - Finished interviews lead to new writing content for the writing agent
  - Interviews can be multiple sessions. We can decide when a topic is done and ready to be written about
  - One session can also spin up new research tasks that feed into the next interview
- set up child developmental agent support to help with monitoring progress and planning weekly
- Default to an ELI5 / first-principles posture when I talk to Rune
  - **Premise:** When I talk to Rune it should default to an ELI5, first-principles posture — strip jargon and unnecessary detail, build the explanation up from fundamentals — so a conversation gets past surface complexity and reasons from the ground. Intended as always-on, every chat.
  - **Where it has to live:** the conversational system prompt, assembled in `src/bot/handlers/text.ts`. A note here in `ideas.md` does NOT change behavior — the posture only takes effect once it's written into that prompt. (Same dead-zone lesson as the agent-lessons → role-memory move: a behavior change parked in a doc nothing loads is inert.)
  - **To discuss before editing the prompt:**
      - How it reconciles with the existing "thinking partner / lean-Socratic" posture and the "be concise on mobile" guidance — first-principles explanation can run long, so the two need reconciling.
      - Always-on vs default-with-an-escape-hatch — a way to ask for the dense/expert version when wanted, since the user is often an expert who sometimes wants depth, not ELI5.
      - Whether it applies across all modes (tactical lookups vs strategic/reflective) or only when explaining/reasoning.
  - **Note:** seed for a working session on the system prompt itself; not a spec.
- Autonomous bug-fix lane
  - Classify nightly observation-loop findings as bug vs idea, capture bugs as structured records that preserve bugs.md detail, and have the gen-eval-loop autonomously fix well-scoped bugs to a branch that auto-merges only when validation passes (Option A). No human start-gate for bugs; ideas stay human-planned via /plan. Detailed brief below; feed into /plan.
  - **Why:** the nightly observation loop finds real problems but has no path to fixing them. Three gaps compound.
  - Gap 1, no bug/idea distinction: every finding becomes a flat idea in ideas.md; a crashing agent and a speculative feature get equal weight, both gated behind a human start-approval.
  - Gap 2, the fix pipeline is built but dead-ends: cockpit Fix button, fail-closed scoping gate (evaluateBugFixGate), PM + Tech-Lead scoping (runPmTechLeadBugScoping), and a durable per-bug lifecycle store (fix-attempt-store.ts) all exist, but the executor startFixRun (fix-run-handoff.ts:23) is a stub that throws 'fix-run handoff unavailable'. Clicking Fix today runs the gate, records the attempt, and lands in handoff-failed.
  - Gap 3, the best bug detail is silently discarded: bugs.md holds rich structured reports, but the parser drops all sub-bullets (backlog-parser.ts:158-161, body:[] at :178), so the system only sees the title.
  - Net: bugs accumulate, the parked gen-eval runs can't be actioned, and the machinery to fix bugs autonomously is ~80% built but never wired end to end.
  - **Goal:** close the loop. Classify findings as bug or idea. Capture bugs as structured records preserving bugs.md detail. Have the gen-eval-loop autonomously fix well-scoped bugs to a branch that auto-merges only when validation passes, with no human start-gate. Ideas stay as-is (idea to /plan to scaffold).
  - **Non-goals:** no change to the idea path; no cross-model review and no change to the gen-eval decision core (gen-eval-loop.ts); no auto-merge of bugs that fail the validation gate (Option A means merge on green only, red holds on-branch and escalates); no new bug-tracker UI beyond the existing cockpit backlog drawer; not fixing the parked-gen-eval approve/reject UI bug here (separate, smaller; this project makes those rows obsolete for bugs).
  - **Reuse, do not rebuild:** backlog-parser.ts / backlog-reader.ts / backlog-append.ts / backlog-id.ts (backlog read/write/id); bug-fix-gate.ts evaluateBugFixGate (ordered fail-closed gate: eligible, fields-complete, PM-well-scoped, tech-lead-no-objection); pm-techlead-bug-scoping.ts runPmTechLeadBugScoping; fix-attempt-store.ts (per-bug lifecycle JSONL store, states, latest-wins, restart reconciliation); fix-run-handoff.ts startFixRun (executor seam to implement); gen-eval-loop-runner.ts + intent/gen-eval-loop.ts (Generator/Evaluator loop to adapt); work-run-finalizer.ts (Project 15 gated-merge finalizer, for Option A auto-merge-on-green); webview.ts fix handler (~1247-1318) + product-deep-view.js Fix button (cockpit surface, already wired); observation loop (observation-sensor-readers.ts, observation-triage.ts, observation-loop.ts, nightly.ts stepObservation).
  - **New, sensor enrichment** (observation-sensor-readers.ts): capture real failure detail (error, stack, input, call site), not just "agent=X N failures in 7d". Confirm agent-runs.jsonl records it; if not, richer failure logging is the true first step. Make-or-break: you cannot autonomously fix a bug you cannot reproduce.
  - **New, triage classification** (observation-triage.ts, verdict schema): add type bug|idea plus a structured bug report (symptom, repro, root-cause hypothesis, intended state, evidence). Fail closed: unsure goes to idea.
  - **New, bugs.json store:** structured source of truth for the fixer and lifecycle; bugs.md stays the human surface.
  - **New, rich bug parsing + reconciliation** (backlog-parser.ts + new scan): parse the Issue/Fix-options/evidence sub-structure the current parser drops, plus a scan that ingests bugs present in bugs.md but missing from bugs.json.
  - **New, implement startFixRun:** drive the gen-eval-loop with the structured bug report as the Generator prompt (no tasks.md, no scaffold), run to a branch, then gated auto-merge.
  - **New, extend FixAttemptState** with terminal states (on-branch/awaiting-merge, merged, escalated, needs-info); wire the gen-eval + finalizer results in.
  - **New, nightly bug-drain step** (nightly.ts): scan open bugs, skip in-flight/terminal per FixAttempt store, run the gate, hand proceeding ones to startFixRun. Auto-approve bugs (no human start-gate).
  - **New, docs:** update BACKLOG-FORMAT.md to formally support and preserve bug bodies.
  - **Data model, bugs.md:** human surface and entry point. Three writers: the human (direct), project/orchestrated runs (loop-filed/auto section), the nightly observation loop. Keeps rich detail. Checkbox flips [x] only on merge.
  - **Data model, bugs.json:** machine source of truth. Per bug: stable id, title, structured detail (issue, repro, intended state, evidence, fix-options), classification, confidence, provenance, status, branch/run links.
  - **Data model, FixAttempt store:** runtime lifecycle keyed product:bugId, latest-wins, restart-reconciled; extended with the new terminal states.
  - **Data model, reconciliation scan** (new requirement): walk bugs.md, and for any bug not yet in bugs.json (by stable id), ingest it and parse the full body. The observation loop may write both directly; the scan is the catch-all so human- and project-added bugs are picked up. Nightly + on-demand.
  - **Decision, Option A autonomy:** auto-start, auto-run to a branch, gated auto-merge on green via the Project 15 finalizer, hold on-branch + escalated on red. No human gate to start; the validation gate is the only merge authority. Crosses the "autonomously merge self-generated code to main" line the architecture currently refuses by design; explicitly approved.
  - **Decision, other:** classifier fails closed to idea; lifecycle lives in bugs.json + the FixAttempt store, never the bugs.md checkbox; executor is the gen-eval-loop with a bug-report prompt, not /work over a tasks.md.
  - **Open question, bug identity stability:** computeBacklogId keys on file+lineNumber+raw (backlog-parser.ts:174); line-based ids churn on edits/moves and would re-ingest everything. bugs.json needs a content-stable id.
  - **Open question, fix threshold:** does the gate require a machine-checkable repro, or is a well-scoped description enough for the Generator to write its own reproducing test?
  - **Open question, verifying a reliability fix:** "agent stops failing" is a runtime signal not a unit test, so what does "fixed" mean and how does the Evaluator confirm it?
  - **Open question, concurrency and cost:** how many bug-fix runs may run at once (reuse WORK_RUN_* caps?), and does the drain rate-limit per night?
  - **Open question, escalation surface:** when a bug hits the gen-eval bound (escalated) or holds red on the gate, where does it surface and what is the operator action?
  - **Risk, signal starvation (highest):** without enriched failure detail the lane fixes blind; validate in Phase 1 before building downstream.
  - **Risk, classifier misfire:** mitigated by fail-closed-to-idea and the PM/Tech-Lead gate before any execution.
  - **Risk, recurring re-dispatch:** the FixAttempt store plus stable ids must prevent re-running the same bug nightly.
  - **Risk, auto-merge trust:** bounded by the green-gate and branch-first landing, but a real trust escalation; per-product validation commands must be trustworthy.
  - **Phases (test-first):** (1) sensor enrichment + confirm failure detail is captured (de-risks everything); (2) bugs.json schema + rich bugs.md parser + reconciliation scan (stable ids); (3) triage classification (bug/idea, fail-closed) + structured bug authoring, route bugs to bugs.json/bugs.md, ideas unchanged; (4) implement startFixRun as the gen-eval bug executor (bug-report prompt) + extend FixAttemptState; (5) Option A gated auto-merge wiring + escalation surfacing; (6) nightly bug-drain step + auto-approve bugs, end-to-end acceptance (a real bugs.md bug fixed to a merged branch with no human start-gate).
- Expand autonomous bug fix lane to run in parallel for all product repos
- Multi-repo orchestrated project coordinator
  - **Goal:** support a single product/project plan whose deliverables span multiple product repositories by coordinating a sequence of existing single-repo orchestrated runs, one run per target product/repo, instead of forcing one run to silently operate inside the wrong worktree.
  - **Why:** orchestrated runs are currently bound to one product worktree. When a project includes tasks whose real deliverables live in another registered product repo, the run cannot write those files. The observed failure mode is that the team lands assertion tests in the current repo, marks tasks done, and the final gate is the first point that notices the target repo was never changed.
  - **Desired shape:** planning/dispatch identifies each task's target product/repo, partitions work into product-scoped child runs, and executes those child runs in dependency order. Cross-product dependencies become explicit ordering constraints rather than prose in `test-plan.md`.
  - **Reuse:** keep `createWorktree`, `runProjectOrchestration`, team-task workflow, validation commands, gated merge, supervision, and cockpit run state single-repo at the child-run level. Add a parent coordinator that owns partitioning, child-run sequencing, aggregate status, and cockpit visibility.
  - **Key decisions before implementation:** task metadata format for target product/repo; whether partitioning happens at planning time or dispatch time; how a parent run resumes if one child succeeds and a later child fails or parks; how task checkboxes are updated without a child run claiming tasks from another repo; merge ordering and rollback/hold policy across repos; cockpit display for parent versus child runs.
  - **Non-goal for the first guardrail fix:** do not make a single child run write to multiple repos. The safer capability is multi-run coordination over existing single-repo execution.

## Loop-filed

<!-- observation-loop appends `- **Title** — friction` bullets below this comment.
     The B4.2 reader (`readFiledIdeas` in src/intent/observation-ideas-io.ts)
     parses only the lines under this section header so user-authored ideas above
     never collide with loop-filed dedupe. -->

- **Make wiki-compiler robust to recurring failures** — wiki-compiler agent fails 7+ times in 7 days
- **Make observation-triage agent robust to failing inputs** — observation-triage agent fails 5+ times in 7d
- **Make lenny-sync robust to repeated failures** — lenny-sync agent fails 3 times in 7 days
- **Stabilize recurring agent-call failure bursts** — Agent-call failures recurring in bursts over 7 days

- **Make lenny-sync agent robust to sync failures** — lenny-sync agent fails repeatedly
- **Fix wiki-compiler recurring compile failures** — wiki-compiler fails 7 times in 7 days

- **Diagnose recurring wiki-compiler failures** — wiki-compiler agent fails repeatedly
- **Harden observation-triage against repeated failures** — observation-triage agent fails 5+ times in 7 days

- **Make wiki-compiler robust to recurring failures** — wiki-compiler agent fails 7+ times in 7d
