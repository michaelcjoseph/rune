# Intent Layer Specification

## Overview

Jarvis today is a reactive command-router. A message arrives on Telegram, the resolver classifies it, a skill runs, and Jarvis goes quiet until the next message or the next cron tick. Nothing in Jarvis holds a model of what Michael is trying to accomplish across his products, reasons about it over time, or initiates work on its own. The nightly job processes raw notes into the wiki, but it does not act on the intent buried in those notes, and it does not improve how Jarvis itself operates.

This project evolves Jarvis from a command-router into an **orchestrator with a persistent intent layer**. The intent layer reasons about Michael's goals, discusses them with him to turn fuzzy ideas into approved specs, then dispatches and supervises sub-agents across multiple foundation models (Claude, Codex, and others) and multiple domains (coding first, content and marketing later). Jarvis stops being a thing Michael drives turn-by-turn and becomes a thing that carries goals forward between turns.

The project builds on two existing pieces of Jarvis. It **extends the cockpit** that [06-webview](../06-webview/spec.md) shipped: that localhost surface becomes the intent layer's web cockpit, one of its three I/O surfaces. And it **widens self-improvement**: today's self-improvement only compiles raw notes into the wiki, and this project extends it to improve how Jarvis itself runs, by detecting fixed bugs, repeated questions that should become commands, and recurring friction, then filing them as projects in Jarvis's own backlog.

This is a large project. The spec covers vision, architecture, and the v1 wedge. The phase-by-phase task breakdown lives in [tasks.md](tasks.md) and the verification checklist in [test-plan.md](test-plan.md); both follow this spec's phase structure, and the project is built test-first (each phase opens by writing its tests).

### Core Value Proposition

Jarvis holds a persistent model of what Michael is building across all his products, turns raw thoughts into scoped specs through conversation, and dispatches and supervises multi-model sub-agents to execute, so that starting and running a project costs a conversation instead of a context-switch.

### Goals

1. **Primary:** A deliberative intent layer that turns a fuzzy idea into an approved spec through conversation, then dispatches sub-agents (across Claude, Codex, and other models) to execute and cross-review the work in isolated sandboxes, supervises the runs, and reports back.
2. **Secondary:** A federated memory model and a product/project registry that give Jarvis a single, uniform picture of every product, its projects, and their status, spanning the vault and the individual product repos.
3. **Tertiary:** Operational self-improvement, where Jarvis observes its own friction (bugs, repeated questions, recurring pain) and files projects into its own backlog, treating itself as one of the products it orchestrates.

### Non-Goals

- **Replacing the reliable-substrate regime.** Daily raw-note processing, the knowledge base, and second-brain memory stay reliability-first, heavy, and propose-and-approve. This project adds a second regime alongside it; it does not fold one into the other.
- **A vault re-organization.** The vault stays organized by type. The product dimension is added as an overlay (a per-product manifest/index), not by moving files.
- **Touching the Relay repo.** Relay is the employer's product with a different authorization and security surface. v1 does not dispatch coding work against the Relay repo. Relay-repo access is explicitly future and out of scope.
- **Coding-style execution for products without a code repo.** Family and health (not code products) are tracked in the cockpit and registry and route raw notes in v1, but get no coding-style project execution.
- **Adopting OpenClaw or Hermes wholesale.** Jarvis keeps its own Node/TS spine. Patterns are borrowed; neither framework is taken on as a dependency.
- **A consensus-voting or ensemble model layer.** Cross-model review is adjudication (one model produces, a different model verifies), invoked deliberately. It is not a quorum of models on every call.
- **A new UI framework.** The cockpit is the existing webview surface (vanilla HTML/JS). The intent layer is an engine with I/O surfaces, not a UI project.

### Research Foundation

The architecture below is grounded in a survey of open-source personal-agent frameworks and current practice. The evidence base, referenced briefly where relevant:

- **OpenClaw** (Node/TS) and **Hermes** (Python): open-source personal-agent frameworks that built the orchestration "plumbing" (chat gateway, multi-model routing, sandboxed sub-agents, skills and memory). Neither has a deliberative intent or planning layer. The plumbing is a solved pattern; the planning layer is the gap this project fills.
- **Anthropic, "Harness Design for Long-Running Agents":** a Planner / Generator / Evaluator split; a separate, skeptical evaluator (agents skew toward grading their own work positively); a preference for context resets with structured artifact handoffs over in-place compaction; harness layers built to be removable and stripped as models improve.
- **Amp (Sourcegraph):** bet on raw model power, keep the harness minimal, "kill unloved features." Subagents fire-and-forget. The Oracle pattern, a separate, deliberately-invoked second-opinion model. Memory as thread discipline for transient work.
- **shellbrain:** typed memory (procedural, semantic, episodic, associative) with hybrid retrieval (BM25 plus embeddings plus graph traversal).
- **everyinc compound-engineering-plugin:** "compound engineering," where each unit of work makes the next one easier (planning roughly 80%, execution roughly 20%); cross-model adjudication (one model finds, a different model verifies) rather than consensus voting; a "compound step" that persists learnings.
- **Personal-agent practitioners:** tiered file-based memory (raw daily plus curated long-term); policy files kept separate from state files; deterministic scripts for routine work and the LLM reserved for judgment; scheduled self-improvement loops; specialized sub-agents for context isolation; heartbeat check-ins; progressive trust with prompt-injection defense; APIs preferred over browser automation.

### Scale Considerations

- **Concurrency:** the design target is multiple projects running at once, across products (a global cap of N concurrent projects), each in its own isolated workspace. Parallelism here is cheap. The cost that scales is reconciliation (see Open Questions).
- **Model calls:** the deliberative intent layer is conversational and bounded by Michael's pace. The Generator-Evaluator loop is the call-heavy part, but it is invoked deliberately (Oracle-style), not on every dispatch.
- **Memory footprint:** the registry is an aggregating index, small. Per-product structured memory lives in each product repo and scales with that product's history, not with Jarvis. The vault's raw layer is unchanged.
- **Cost:** dispatching across multiple foundation models means dispatch cost is no longer a single subscription line. Cost visibility per project is an open question (see Open Questions).

---

## Vision: Jarvis as Intent-Layer Orchestrator

The shift is from **router** to **orchestrator**.

A router is stateless between turns. It maps each message to a handler and forgets. An orchestrator holds a persistent model of intent: it knows what projects are open across which products, what each one is blocked on, what was decided, and what comes next. It can be asked "what should I work on" and answer from that model. It can notice that a journal note implies a scope change and surface it. It can dispatch work, watch it run, and bring back a result without Michael holding the thread.

The intent layer is the component that holds that model. It is an **engine, not a UI**. It has three I/O surfaces (journal, cockpit, chat, detailed in **Three Surfaces** below), but its job is the same regardless of surface: take intent in, reason about it, dispatch and supervise work, report back.

Concretely, Jarvis gains the ability to:

- Hold a fuzzy idea and refine it into an approved spec through conversation, instead of requiring Michael to arrive with a fully-formed task.
- Dispatch that spec to sub-agents on the right foundation model for the job, run them in isolation, and have a different model cross-review the output.
- Run several such projects concurrently across several products, and keep a live picture of which are running and which are blocked on Michael.
- Treat itself as one of those products, observing its own friction and filing improvement projects into its own backlog.

The vision is not "Jarvis writes all the code." It is "Jarvis carries the goal." Execution quality rides on the foundation models and improves as they do. Jarvis's durable contribution is the intent layer (the planning, the memory, the supervision), which is the part the models do not provide.

---

## Two-Regime Model: Reliable Substrate vs Light Project Execution

Jarvis runs two regimes with different engineering philosophies. Conflating them is the main design risk this section heads off.

### Regime A: Reliable substrate

This is the existing Jarvis: daily raw-note processing, the knowledge base, second-brain memory, reviews, morning prep. It is **reliability-first**. It can carry a heavy harness because correctness and durability matter more than speed. Writes into it are **propose-and-approve**. A silent mistake here corrupts the second brain, so the harness exists precisely to prevent that.

This regime is not changed by this project, except that it gains a new intake path (the journal-to-intent flow, see **Three Surfaces**) which is itself propose-and-approve, consistent with the regime.

### Regime B: Light project execution

This is the new capability: kicking off and running coding projects (and, later, content and marketing projects). It is **Amp-style**. It bets on model progress and keeps the harness light. The guiding rule: do not over-build scaffolding that improving models will absorb. A failed execution run in this regime is cheap to discard and retry; it does not corrupt anything durable. So the harness is thin by design.

Thin does not mean ungated. Regime B execution writes to a **branch or worktree in the product repo and surfaces a diff**; landing that diff on the repo's main line is Michael's explicit action. This is a lighter gate than Regime A's propose-and-approve (the cost of a bad run here is a discarded branch, not a corrupted second brain), but it is still a human gate. Jarvis prepares the change; it does not merge it.

### Why the split matters

The regimes have opposite cost functions. In Regime A, a heavy harness is correct, because the cost of an error is permanent and the cost of slowness is tolerable. In Regime B, a heavy harness is a liability, because the cost of an error is a discarded run and the cost of slowness compounds across many runs and across model upgrades that would have made the scaffolding redundant.

The two regimes meet at exactly one place, and the contact point is tightly controlled: the only write-back from Regime B into the reliability-critical vault is for **generalizable cross-product lessons**, promoted into the playbook or world-view. That single channel runs propose-and-approve, the Regime A way. Everything else in Regime B writes only to product repos, never to the vault.

---

## Federated Memory: Vault, Product Repos, Cockpit

Memory is federated across three locations, each with a defined role. There is no single store.

### The vault

The vault holds **raw thoughts**: cross-product thinking and the life-products (family, health) that have no code repo. It is the Regime A store, organized by type (journals, pages, world-view, and so on). It keeps its current structure.

Every product has a **vault product file** (`projects/<product>.md`, for example `projects/relay.md`). That file is the product's **canonical declaration**: a product is in the system because it has one. The repo is optional (it is what makes a product repo-backed and executable); the vault product file is not. The file's role is sharpened here: it holds **raw, cross-cutting thoughts** about the product, not the product's roadmap.

Keeping that representation honest is the intent layer's job, not an external chore. Not every product has a vault product file today, and the vault's hand-written product list can lag reality. **Product registration** (next) is the flow that creates a missing file and reconciles the list; the journal-to-intent flow then keeps each file current.

### Product registration

A product enters the system by being **registered**, and registration is an intent-layer action, not a manual chore. To register a product the intent layer:

1. Creates the **vault product file** `projects/<product>.md` if it is missing (the canonical declaration).
2. Adds the product to the **registry** so it surfaces in the cockpit.
3. Creates the product's **product-overlay manifest** so sub-agent retrieval can scope to it.
4. Links the **code repo** if the product has one. A repo marks a product repo-backed and executable; a product with no repo is still registered and tracked, just not executed.

Registration writes to the vault, so it is **Regime A, propose-and-approve**. It runs on two triggers. Explicitly, when Michael names a new product. And as a **reconciliation pass** that detects a product present as a repo, or referenced in journals, but missing its vault file or registry entry, and proposes the missing pieces. The reconciliation pass is what keeps the vault's product representation from drifting as products are added over time.

### The product repos

Each code-product gets structured durable memory **in its own repo**, living next to the code: project specs, the roadmap, and execution history. This is the Regime B store. It is fast: a project repo can move quickly without the propose-and-approve weight of the vault, because nothing in it is second-brain-critical.

### The bridge ("carry over")

The intent layer is the bridge between the two. The flow is one-directional for intent:

1. Michael drops raw notes about a product into the daily journal.
2. The journal-to-intent flow synthesizes those notes into that product's **vault file** (`projects/<product>.md`), keeping it current as a raw cross-cutting record.
3. The intent layer then **carries the actionable part over** into the right product repo's roadmap, as roadmap items.
4. Structured roadmap, specs, and execution history live in the **repo** from there on.

The one exception to one-directional flow is the generalizable-lesson channel from the **Two-Regime Model**: a lesson learned during execution in a repo can be promoted back into the vault (playbook or world-view), propose-and-approve.

### The cockpit

The cockpit is an **aggregating overlay**. It reads status across all product repos and all vault product files and presents one picture. It **indexes; it owns nothing**. No memory lives in the cockpit. If the cockpit were deleted, no state would be lost; it would be rebuilt by re-reading the repos and the vault.

### Summary of write rules

| From | To | Direction | Gate |
|---|---|---|---|
| New or detected product | Vault product file + registry + overlay manifest | Registered | Propose-and-approve |
| Journal raw notes | Vault product file | Synthesized in | Propose-and-approve |
| Vault product file (actionable part) | Product repo roadmap | Carried over | Propose-and-approve |
| Product repo | Cockpit | Read only | None (cockpit owns nothing) |
| Execution in a repo | Vault playbook / world-view | Promoted (generalizable lessons only) | Propose-and-approve |

---

## Foundational Tier: Registry, Overlay Index, Agent Definitions, Model Policy

Four pieces sit beneath the five layers as prerequisites. They are unglamorous plumbing, and they are likely the first things built.

### Product/project registry

There is no single data model today that ties products to projects to status. The vault has products-as-files; the Jarvis repo has projects-as-folders (`docs/projects/`); nothing connects them.

The registry is a uniform **product to projects to status** data model. It is an **aggregating index**: the cockpit reads it, and the intent layer writes it. It does not own the underlying truth (the repos and vault product files do); it is the layer that makes "show me every project across every product and its status" a single query.

Two notions of "status" meet here and should not be conflated. The registry holds durable **lifecycle status** (planned / active / done), derived from each repo's project docs the way `docs/projects/index.md` already carries a Status column. Live **run-status** (running, blocked on Michael) is held by the supervision layer (Layer 3) and surfaced to the cockpit separately. The registry stays rebuildable because lifecycle status lives in the repos, not in the registry itself.

This is likely **the first thing built**, because every other layer assumes it exists.

### Product-overlay index

The vault is organized by type, not by product. Sub-agent retrieval needs to scope to one product (when planning an Aura project, do not pull in Relay context). The overlay index is a **per-product knowledge manifest** that points at the relevant slices across the type-organized vault: which journal entries, which pages, which world-view sections, which wiki concepts relate to that product.

It is an overlay, not a re-org. The vault does not move. A manifest points into it.

### Model-agnostic agent definitions

Jarvis's agents today are `.claude/agents/*.md`, which is Claude Code's format. To dispatch the same agent to Codex or Gemini, the system needs a **neutral representation** of an agent definition (its role, its tools, its constraints) that **compiles down** to the Claude format, the Codex format, and others. This is a prerequisite for Layer 5 (multi-model dispatch); without it, every model integration re-specifies every agent.

The choice of standard for this neutral representation is an open question (see **Open Questions**). Note the split of concern: this format settles *how* an agent is expressed for each provider; *which* model actually runs it is the **Model selection policy** below.

### Model selection policy

Several layers assume Jarvis can pick a foundation model: the Planner runs on one, the Generator on another, the Evaluator on a third and deliberately different one (Layer 2), and Layer 5 dispatches across Claude, Codex, and others. None of that works without an answer the rest of the spec leaves implicit: **what decides which model runs a given dispatch, and how that decision survives the models changing underneath it.**

The answer is a **declarative model policy**: a policy file kept separate from runtime state, consistent with the practitioner finding that policy files stay separate from state files. It is data, not code. Adding, swapping, or retiring a model is an edit to this file, not a deploy. The policy has three parts.

**1. A model registry.** The enumerable set of dispatchable models. Each entry carries a stable **alias** (not a pinned version ID), the **provider** and the agent-definition **format** it compiles to (Claude, Codex, Gemini), a set of **capability tags** (for example `coding`, `long-context`, `cheap-classify`, `vision`, `deep-reasoning`), a coarse **cost tier**, and a **status** (`preferred`, `active`, `deprecated`). Referencing models by alias rather than pinned ID matches how Jarvis already works: `config.ts` names model slots (`opus` / `sonnet` / `haiku`) and agent frontmatter overrides them with the same aliases, so a provider's alias upgrade is picked up for free.

**2. Role-to-capability binding.** Agent definitions do not name a model. They declare the **capabilities the role needs** (the Generator for a coding project needs `coding` plus `long-context`). The model-agnostic agent-definition format above carries this as a field. A model is never baked into an agent, which is what keeps the definitions genuinely model-agnostic; "this agent runs on Claude" is a policy decision, not an agent property.

**3. A deterministic resolver.** A small non-LLM router maps (role, declared capabilities, policy) to a concrete model at dispatch time. It is deterministic on purpose, per the practitioner finding that deterministic scripts handle routine work and the LLM is reserved for judgment, and it **logs which model it picked and which rule fired**, so every dispatch is auditable and cost-attributable.

Selection precedence, highest first, mirrors the `def.model ?? config.AGENT_MODEL` fallback already in Jarvis's `runAgent`:

1. **Explicit pin.** Michael, or the Planner during scoping, pins a model for this dispatch. Always wins.
2. **Role default.** The `preferred` model for that role whose capability tags satisfy the role's declared needs.
3. **Global fallback.** A single configured default when nothing else resolves.

**Cross-model adjudication is a policy constraint, not a hardcoded pair.** Layer 2 needs the Evaluator on a different model than the Generator. The policy expresses this as a constraint the resolver enforces (`evaluator.distinct_from: generator`, ideally across provider families, not just versions). So "Claude builds, Codex reviews" is the current *resolution* of a rule, not the rule itself; swap the preferred coding model and the adjudication pair re-resolves without touching Layer 2.

**Updating the policy as models change** is the property this design exists to provide:

- **A new model ships.** Add a registry entry with capability tags, cost tier, and status `active`. The resolver can select it for any role whose needs its tags satisfy. Flip it to `preferred` for a role to make it that role's default. No code change.
- **A model regresses or is retired.** Set status `deprecated`. The resolver stops selecting it and warns; a dispatch that explicitly pinned it fails loudly rather than silently rerouting.
- **The policy is itself a self-improvement target.** A model that keeps losing cross-model reviews, or a new model worth trialing, is exactly the friction signal the observation loop files as a project into Jarvis's own backlog (see Operational Self-Improvement). The policy is also the clearest case of the "build harness layers to be removable" principle (see Open Questions): as models converge, the role-to-capability bindings collapse toward one default and the policy file shrinks.

This settles the mechanism. Two judgment calls stay open and are listed in Open Questions: the capability-tag vocabulary, and whether the Planner may pin models or only recommend them.

---

## The Five Layers

The project-execution engine is five layers. They are numbered for reference, not strict build order: the **Phasing and Sequencing** section sequences them by dependency. Layer 2 is split across phases in particular: its single-model Generator-Evaluator loop is proven early (Phase 3), but its defining feature, cross-model adjudication, lands late (Phase 4) because that needs the multi-model dispatch of Layer 5 to exist first. The foundational tier above is assumed by all of them.

### Layer 1: Deliberative intent layer (the Planner)

Turns a fuzzy idea into an approved spec through conversation. This is the **Planner** in the Planner/Generator/Evaluator split. It is the deliberative core: it asks questions, surfaces assumptions, scopes, and produces a spec artifact that Michael approves before anything is dispatched. Once approved, the artifact is scaffolded into the project's `spec.md`, `tasks.md`, and `test-plan.md` (the existing `project-setup-writer` agent already does exactly this); the `tasks.md` task list is the unit the Generator consumes. Per the compound-engineering finding (planning roughly 80%, execution roughly 20%), this layer carries most of the project's value.

### Layer 2: Generator-Evaluator loop

Execution with review. A **separate, skeptical Evaluator**, because an agent grading its own output skews positive. Review uses **cross-model adjudication**: one model produces, a *different* model verifies ("is this reproducible and correct?"). The loop is **invoked deliberately, Oracle-style**, not forced on every dispatch. Trivial work does not need a second model's opinion; consequential work does. The loop is bounded: a run the Evaluator cannot bring to a passing verdict within a few rounds is not retried indefinitely, it is escalated to the blocked-on-Michael state (Layer 3) for a human decision.

Jarvis already implements both halves of this loop as skills Michael drives directly: **`/work`** is the Generator (it takes a project's task list and drives each task through plan, implement, test, fix, and simplify), and **`/review`** is the Evaluator (a five-agent review panel that returns one consolidated verdict). Both stay, and both stay directly invokable by Michael. Today they run single-model. Layer 2 adds **cross-model adjudication**: the Evaluator resolves to a model from a different provider family than the Generator (see **Model selection policy**). When the engine runs a project autonomously, cross-model adjudication is the default. When Michael runs `/review` by hand, it stays single-model by default (fast and cheap for the everyday dev loop) and takes a **`--cross-model`** flag to opt into adjudication for a change that warrants it. Either way Layer 2 wraps the existing skills; it does not replace them.

The Generator works **test-first**. For each task it writes the tests that mirror the project's `test-plan.md`, watches them fail, then writes implementation until they pass. Fixing the contract before the code exists is what gives the Evaluator something objective to check and keeps the loop from grading vibes. This is the engine's default execution discipline, established early as a change to how `/work` runs and applied from the first phase onward. This project's own [tasks.md](tasks.md) is built the same way: every phase opens with its tests.

### Layer 3: Supervision infrastructure

Long-running work needs to be watched. This layer provides background dispatch for long-running runs, a **visibility surface** showing which agents are running and which are blocked on Michael, and **heartbeat check-ins** so a run that has gone quiet is noticed rather than silently stalled. The visibility surface feeds the cockpit.

Background dispatch already exists in embryo. **`/work --auto`** is the unattended execution mode: one invocation sweeps a task list end to end with no interaction gates (no plan-mode approval, no per-task confirmation, auto-commit per task), stopping only on hard errors. The work-runner already spawns `/work --auto` from a cockpit button (shipped in 06-webview). Layer 3 takes `/work --auto` as its unit of background work and adds the visibility surface, the blocked-on-Michael state, and heartbeats around it. `--auto` stays a mode Michael can trigger himself; Layer 3 is what lets the engine trigger it, and watch it, unattended.

### Layer 4: Sandboxing and security

Isolation and trust. Per-product-repo isolation via Docker and/or a git worktree per project, so concurrent projects cannot interfere. **Egress allowlists** and **scoped per-repo credentials**, so a run can reach only what it needs. Inbound content is treated as untrusted (**prompt-injection defense**), trust is granted **progressively**, and integrations prefer **APIs over browser automation**.

### Layer 5: Multi-model dispatch

Wire Codex and other foundation models as **dispatchable executors**. A dispatch carries an **explicit handoff message** (the structured artifact handoff from the harness-design research, preferred over in-place context compaction). This layer depends on the model-agnostic agent definitions from the foundational tier.

### Layer summary

| Layer | Role | Key principle |
|---|---|---|
| 1. Deliberative intent | Planner: idea to approved spec | Planning is most of the value |
| 2. Generator-Evaluator | Execution with cross-model review | Skeptical, separate evaluator; deliberate invocation |
| 3. Supervision | Background dispatch, visibility, heartbeats | A quiet run must be noticed |
| 4. Sandboxing & security | Isolation, scoped creds, untrusted inbound | Progressive trust, APIs over browsers |
| 5. Multi-model dispatch | Codex and others as executors | Explicit handoffs over compaction |

---

## Three Surfaces: Journal Intake, Cockpit, Chat Dialogue

The intent layer is an engine. It has three I/O surfaces. They are not three features; they are three ways the same engine takes intent in and reports out.

### Surface 1: Journal: passive intake

Michael keeps doing what he already does: dropping raw notes into the daily journal. Jarvis translates those notes into todos and scope changes for the right product or project. This is a **new flow** and it sits in **Regime A** (the reliable substrate). It is **lossy by nature** (raw notes are ambiguous), so it is **propose-and-approve** and never silently rewrites scope. Michael sees what Jarvis inferred and confirms it.

### Surface 2: Cockpit: the web view

A web surface showing every product, its projects, and their status, with the ability to start or continue a project and enter planning mode. This **extends the cockpit [06-webview](../06-webview/spec.md) shipped**. The webview's localhost surface, its session sharing with Telegram, and its cockpit sidebar are the starting point; this project extends that surface into the full product/project cockpit reading from the registry.

### Surface 3: Chat (Telegram): dialogue

When the intent layer needs to ask questions to scope or plan, it asks on Telegram. Chat is the **dialogue** surface: the Planner's conversation with Michael happens here (and, equivalently, in the cockpit's planning mode). Approvals for journal-intake proposals and for carried-over roadmap items also surface here.

### Surface summary

| Surface | Mode | Regime | Gate |
|---|---|---|---|
| Journal | Passive intake (notes to todos/scope) | A (substrate) | Propose-and-approve |
| Cockpit | Status view + start/continue/plan | Spans both | Per-action |
| Chat | Dialogue (scoping, planning, approvals) | Spans both | Conversational |

---

## Operational Self-Improvement

Self-improvement today is narrow: the nightly job compiles raw notes into the wiki. That is improvement of the *knowledge base*, not of *Jarvis*.

This project adds self-improvement about **how Jarvis itself operates**: detecting bugs that were fixed (so the fix becomes a remembered pattern), repeated user questions that should become commands, and recurring friction in how Jarvis is used.

One of these inputs already exists. The **Ask-Twice telemetry** from [03-resolver](../03-resolver/spec.md) already logs repeated intents and proposes new skills or crons. The observation loop generalizes that mechanism: it widens the signal from repeated questions to bugs and friction, and routes the output as full projects rather than only skill-or-cron proposals.

The key recursion: **Jarvis is itself a product.** It has a repo (`~/workspace/jarvis`) and a backlog (`docs/projects/ideas.md`). Operational self-improvement is **not a separate subsystem**. It is the project-execution engine (the five layers) pointed at the Jarvis product, fed by an **observation loop** that watches Jarvis's own operation and files friction, bugs, and repeated questions as projects in Jarvis's own backlog.

So the engine that takes "build feature X for Aura" from idea to shipped is the same engine that takes "Michael keeps asking the same thing, that should be a command" from observation to a filed project. The observation loop is the main new piece, and even it extends the existing Ask-Twice telemetry rather than starting fresh; everything downstream of it is the engine already being built.

---

## v1 Wedge: Scope, Concurrency, Isolation Model

The v1 wedge, stated as a single sentence:

> **Jarvis takes a coding idea, discusses it into a spec, dispatches Claude plus Codex to build and cross-review it in a sandbox, supervises the run, and reports back.**

### Scope constraints

- **Multiple products, not one.** v1 applies across multiple products and their projects from the start. It is not a single-product pilot.
- **Repo-backed products only.** v1 serves **Assay and Aura**, the side products that have code repos today (`~/workspace/assay`, `~/workspace/aura`).
- **Family and health: tracked, not executed.** Neither has a code repo and neither is a code product. Both are tracked in the cockpit and registry and route raw notes, but they do **not** get coding-style project execution in v1.
- **Relay repo untouched.** v1 does **not** touch the Relay repo. Relay is the employer's product with a different authorization and security surface. Relay-repo access is explicitly future and out of scope.

### Concurrency model

Jarvis must run **multiple projects concurrently**: a global cap of N projects across all products at once. The intent layer schedules within that cap. Concurrency is global, not per-product (two Aura projects and one Assay project is a valid state, subject to the global N).

The work-runner already enforces this shape at small scale: a global cap (`WORK_RUN_GLOBAL_CAP`) and a per-project cap (one run per project at a time). The intent layer's scheduler generalizes those caps; it does not introduce a new concurrency model.

### Isolation model

Per-project isolation via a **git worktree per project**. Each concurrent project gets its own worktree (and, where warranted, its own Docker container per Layer 4) so concurrent runs cannot interfere with each other's working tree, branches, or build state. Isolation is per-project, not per-product: two projects on the same product repo still get separate worktrees.

### Build-vs-adopt

Settled: **keep Jarvis's own Node/TS spine.** Borrow patterns from OpenClaw, Hermes, Amp, and the practitioner survey. Adopt **neither** OpenClaw nor Hermes wholesale as a framework. The plumbing patterns are well-understood; re-implementing them on Jarvis's existing spine is cheaper than absorbing a framework's worldview.

### Definition of done (v1 wedge)

The wedge is done when, for a repo-backed product, all of the following hold:

- A coding idea, raised in chat or surfaced from the journal, becomes an **approved spec** through conversation. Michael's only required inputs are answering scoping questions and approving the spec.
- The approved spec is **dispatched into a sandboxed run** (git worktree, scoped credentials), a **different model cross-reviews** the output, and the result returns as a **branch or PR** on the product repo, never a direct write to its main line.
- The cockpit shows, without Michael asking, **which projects are running and which are blocked on him.**
- **Merging the result is Michael's explicit action.** Jarvis prepares the change; it does not land it.
- Two projects running concurrently across two products do not corrupt either repo's working tree.

This is observable behavior, not a metric. [test-plan.md](test-plan.md) turns each line into a concrete check.

---

## Phasing and Sequencing

High-level sequencing only. The phase-by-phase task breakdown is in [tasks.md](tasks.md), and the verification checklist in [test-plan.md](test-plan.md).

The ordering principle: build the foundational tier first (everything depends on it), then the surfaces that make the engine usable, then the layers in dependency order, narrowing to the v1 wedge before broadening.

### Phase 1: Foundational tier

> Nothing else works without this.

- Product/project registry (the uniform product-to-projects-to-status data model). Built first.
- Product registration, including a first reconciliation pass over the current products: create a vault product file for every product that lacks one, seed the registry and overlay manifests, so the foundational tier starts from a complete and accurate product list.
- Product-overlay index (per-product knowledge manifests over the type-organized vault).
- Model-agnostic agent-definition format and a compiler to the Claude format (the Codex and other targets follow in Phase 4).
- Model selection policy: the model registry, role-to-capability bindings, and the deterministic resolver. The cross-model adjudication constraint is exercised in Phase 4, but the policy file and resolver are foundational and built here.

### Phase 2: Cockpit and journal intake

> Depends on: Phase 1 registry.

- Extend the cockpit. 06-webview shipped the cockpit's first version (the localhost surface, the Telegram session sharing, the light sidebar); this phase extends it into the full product/project cockpit reading the registry. 06-webview is **not** retired or folded in: it stays as the historical record of what it shipped. No project owns the cockpit. The cockpit is part of the Jarvis product; one project launched it, this one improves it, and later projects will too.
- Journal-to-intent flow: synthesize journal notes into vault product files, propose carried-over roadmap items, propose-and-approve.

### Phase 3: Deliberative intent layer and v1 wedge core

> Depends on: Phase 1, Phase 2.

- Layer 1 (Planner): idea-to-spec conversation, on chat and in the cockpit's planning mode.
- Layer 3 (supervision): background dispatch, visibility surface, heartbeats.
- Layer 4 (sandboxing): git worktree per project, per-repo scoped credentials, egress allowlists.
- Layer 2, single-model: the `/work` Generator and `/review` Evaluator running end to end on one model, against one repo-backed product, to prove the loop. Cross-model adjudication is added in Phase 4.

### Phase 4: Multi-model dispatch and cross-review

> Depends on: Phase 3.

- Layer 5: Codex wired as a dispatchable executor; explicit handoff messages; agent definitions compiling to the Codex target.
- Layer 2, cross-model upgrade: the Evaluator resolves to a different-provider model from the Generator (cross-model adjudication), invoked Oracle-style. Cross-model is the default for autonomous engine runs; manual `/review` gains a `--cross-model` opt-in flag.
- Concurrency: the global N-project scheduler across all repo-backed products.
- This phase completes the v1 wedge.

### Phase 5: Operational self-improvement

> Depends on: the engine from Phases 3 and 4.

- The observation loop: extend the existing Ask-Twice intent telemetry to also notice fixed bugs and recurring friction, and file all three as projects into `docs/projects/ideas.md`.
- Point the existing engine at the Jarvis product. No new execution subsystem.

### Later (out of v1)

- Content and marketing project execution (the engine generalized beyond coding).
- Repos for family and health, if and when they ever warrant code execution.
- Relay-repo access, contingent on resolving the separate authorization and security surface.

---

## Open Questions and Risks

- [ ] **Relay-repo access (deferred).** v1 explicitly does not touch the Relay repo. Bringing it in later means a different authorization model and a larger security surface (employer code, employer credentials). What conditions would have to be true to make Relay-repo execution safe, and is it ever worth it versus keeping Relay work fully manual?
- [ ] **Keeping the product-overlay index in sync.** The overlay index points at slices of a type-organized vault that grows every night. As the vault grows, the manifest drifts unless something maintains it. Is the index rebuilt on a schedule, updated incrementally on each ingest, or recomputed on demand at retrieval time? Each has a different staleness-versus-cost tradeoff.
- [ ] **The vault's hand-written product list.** The vault's `CLAUDE.md` carries a hand-curated "What I'm Working On" list, separate from the `projects/*.md` product files. Product registration keeps the product files and the registry honest. Should it also rewrite that hand-written list, or only flag drift between the list and the registry and leave the edit to Michael? Auto-rewriting touches the vault's identity file; flagging keeps it human-owned but lets it lag.
- [ ] **What counts as a "generalizable" lesson.** The one write-back channel from Regime B into the vault is for generalizable cross-product lessons (playbook or world-view). What is the criterion that separates a genuinely cross-product lesson from a project-specific detail that should stay in the product repo? Too loose and the playbook fills with noise; too strict and real lessons never compound.
- [ ] **Cost and reconciliation overhead at concurrency.** Running many projects at once is cheap (parallelism is cheap). Reconciling their outputs is not: merges, conflicting roadmap edits, cross-project dependencies surfacing late. How does the intent layer schedule and reconcile N concurrent projects without the reconciliation cost swamping the parallelism gain? What is a sane value for N?
- [ ] **Per-project cost visibility.** Dispatching across multiple foundation models means cost is no longer a single subscription line (see Scale Considerations). The model resolver logs the model per call, so per-project cost is computable, but the spec does not say where it surfaces. Does the cockpit show running cost per project, and is there a budget cap that pauses a project that overruns?
- [ ] **When and how to strip harness layers.** The harness-design research says build layers removable and strip them as models improve. What is the concrete signal that a given harness layer (an evaluator step, a scaffolding prompt) is now redundant, and what is the process for removing it without a regression?
- [ ] **Standard for model-agnostic agent definitions.** The neutral agent-definition representation must compile to Claude, Codex, and Gemini formats. Is there an existing standard to adopt, or is this a small bespoke schema? What is the minimum set of fields (role, tools, constraints) that survives translation to every target?
- [ ] **Capability vocabulary for the model registry.** The model selection policy routes by capability tags (`coding`, `long-context`, and so on). Too few tags and the resolver cannot tell a coding model from a classifier; too many and every new model needs a hand-assigned tag set that drifts from reality. What is the minimum viable tag vocabulary, and is it hand-maintained or derived from eval scores?
- [ ] **Who may pin a model.** Model selection precedence puts an explicit pin above the role default. Should the Planner be allowed to pin a model during scoping, given it holds the most context on the job, or is pinning reserved for Michael with the Planner only able to recommend?
- [ ] **Eventual structured store for the life-products.** Family and health are tracked but not executed in v1, and may never be code products. If they later warrant structured execution, do they get real code repos, or a different repo-shaped store for structured durable memory? The federated-memory model assumes "product repo" but family and health may never have code.
