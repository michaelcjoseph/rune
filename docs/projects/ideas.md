# Project Ideas

User-authored ideas for future projects sit above the loop-filed marker;
the observation loop (project 08 Phase 5) appends machine-filed ideas
below it.

## User-authored


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
- Per product loop where if Rune isn't working on something, it picks up the next scoped bug or project
  - **The actual gap — automated dispatch is rune-only and partly unwired.** Three layers, only the top one done:
      - *Layer A — manual trigger:* works (above).
      - *Layer B — the automated work-run dispatch isn't wired for any repo.* The nightly observation loop creates `gen-eval-loop` mutations hardcoded to `product: 'rune'` (`nightly.ts`), not `work-run`. `observation-dispatch.ts` documents routing self-generated dispatches through `work-run`, but that path is designed, not wired.
      - *Layer C — self-generated ideas carry no product (the design question).* `ProjectIdea` is `{ title, friction, id }`. Nothing attributes a detected friction to "this belongs in aura's repo." Auto-dispatch cross-repo needs product attribution — the sensor tagging its source product, a `product` field set at triage, or a registry lookup for friction that already maps to a known project (the registry maps slug→product; a brand-new self-generated project does not). A new project also needs scaffolding **in the target repo** (the scaffold-approval/promotion machinery), its own surface.
    - The hard parts are (1) the dispatch path + product attribution (Layer B/C) and (2) the cross-repo concurrency/branch/security model: per-product run caps, the stable `rune-work/<slug>` branch convention applied per repo, and whether a run in someone else's repo may push / what its egress allowlist permits. The egress + sandbox primitives exist (`sandbox-runtime.ts`, `egress-policy.ts`, per-product `egressAllowlist`); the policy decisions per product don't.
    - **Recommended first step:** a throwaway validation run in aura (trivial change) to prove credentials + worktree + egress + push actually work cross-repo before building the dispatch/UX on top. Treat the full thing as its own `/plan`, not an inline edit.
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

## Loop-filed

<!-- observation-loop appends `- **Title** — friction` bullets below this comment.
     The B4.2 reader (`readFiledIdeas` in src/intent/observation-ideas-io.ts)
     parses only the lines under this section header so user-authored ideas above
     never collide with loop-filed dedupe. -->

- **Make wiki-compiler robust to recurring failures** — wiki-compiler agent fails 7+ times in 7 days
- **Make observation-triage agent robust to failing inputs** — observation-triage agent fails 5+ times in 7d
- **Make lenny-sync robust to repeated failures** — lenny-sync agent fails 3 times in 7 days
- **Stabilize recurring agent-call failure bursts** — Agent-call failures recurring in bursts over 7 days
