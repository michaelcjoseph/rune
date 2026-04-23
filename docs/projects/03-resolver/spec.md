# Resolver & Self-Evolution Specification

## Overview

This project converts Jarvis from a command-driven tool into a **self-observing system that proposes its own upgrades**. Today, every Jarvis capability is reachable only via a hardcoded slash command, every cron job is a code change, and there is no telemetry that notices when the user asks for the same kind of thing twice. This project adds a **Resolver** that routes free-form Telegram messages to the right skill, an **Ask-Twice** loop that watches for repeated intents and proposes new skills/crons, **skill-frontmatter–driven cron** so new scheduled work doesn't require editing the scheduler, an **MVP eval framework** so agent regressions don't ship silently, deterministic **entity auto-linking** in KB ingest, **compilation checkpoints + source hierarchy** in wiki-compiler, and a **`/learn` institutional memory** that all agents auto-prepend.

The patterns here are drawn from a corpus of personal-AI tooling (Garry Tan's gstack/gbrain, Nikunj Kothari's llm-wiki, the "thin harness, fat skills" ethos). Jarvis already nails the "fat skills" half — 20+ markdown agents in `.claude/agents/`. What's missing is the thin harness, the resolver, and the compounding loop.

### Core Value Proposition

Free-form Telegram messages route to the right skill automatically; recurring intents become new skills or crons by proposal; agent regressions are caught by evals before they reach the user; the KB grows richer with every ingest via deterministic entity linking and better retrieval.

### Goals

1. **Primary:** Free-form Telegram messages route to the right skill via an LLM-classified Resolver, replacing the current hardcoded prefix-match dispatcher and absorbing the deferred Project-02 Phase 4 (KB-aware default chat) as one routed intent.
2. **Secondary:** Recurring intents are surfaced via "Ask-Twice" telemetry — the resolver writes a structured intent log; a weekly scan proposes new skills or crons in the same approval flow as playbook drafts.
3. **Tertiary:** New scheduled work ships by adding a `cron:` field to an agent's frontmatter — no scheduler code change.
4. **Quaternary:** Agents have an MVP eval framework (one YAML per agent, manual `npm run evals`) so behavior regressions are catchable.
5. **Quinary:** A `/learn` command appends to a runtime learnings store that all agents auto-prepend.
6. **Senary:** KB ingest auto-links to known entities (deterministic regex over `pages/{books,crm,places}.json` + `FAMILY_NAMES`); wiki-compiler processes the queue in source-priority order with mid-run checkpoints.

### Non-Goals

- **General-purpose Postgres job queue (gbrain "Minions" equivalent).** The two file-based queues are sufficient at single-user scale; adding Postgres is pure overhead.
- **gstack safety primitives (`/freeze`, `/careful`).** Those defend against an agent editing your code; Jarvis isn't a code-editing agent for itself.
- **gstack full sprint workflow (`/office-hours` → `/plan-ceo-review` → ...).** Jarvis's review system is tuned to your life, not to shipping software. Not replacing it.
- **Cross-model second-opinion loops (`/codex`-style).** Jarvis already gates everything on human approval; an adversarial second LLM is overkill.
- **Voice notes / Whisper integration.** Not currently used.
- **Skill marketplace / dynamic skill loading at runtime.** Skills remain markdown files in `.claude/agents/` (Jarvis or vault) loaded at startup.
- **Replacing slash commands.** Slash commands remain — they're the fast path. Resolver only handles non-slash messages.
- **CI gate for evals.** MVP is manual `npm run evals` only.

### Scale considerations

- **Resolver call cost:** one Haiku classification per non-slash, non-active-session message. Cap by skipping messages shorter than ~5 words. Estimated: dozens of calls per day at most.
- **Intent log volume:** one JSON line per resolved message. Hundreds per month. Trivial.
- **Ask-Twice scan:** weekly job that reads the last ~30 days of intent log + skill registry. Single Haiku call.
- **Skill cron registration:** zero runtime cost — scanned at startup.
- **Eval cost:** `npm run evals` invokes each agent against fixture inputs. ~$0.50 for a full run; manual cadence.

---

## User Journey

### Happy Path — Free-form message routes via Resolver

```
User sends "what did I think about Lenny's pricing thread last month?" in TG
         ↓
Active review session? No → continue
Slash command? No → continue
Message length ≥ 5 words? Yes → run Resolver
         ↓
Resolver Haiku call: message + compact skill registry → {skill: "kb_query", confidence: 0.91}
         ↓
Confidence ≥ threshold? Yes → invoke kb_query with the message as args
         ↓
Result returned to user; intent logged to logs/intent-log.jsonl
         ↓
(Confidence < threshold → fall through to current freeform conversation handler)
```

### Happy Path — Ask-Twice proposal in weekly review

```
Over 3 weeks, user has asked twice/week: "summarize today's whoop strain vs last week"
         ↓
Saturday 3pm: ask-twice scanner runs, reads logs/intent-log.jsonl
         ↓
Detects 6 occurrences with similar shape → drafts proposal in logs/proposal-queue.json:
  { type: "skill_or_cron", title: "Weekly Whoop strain trend",
    rationale: "Asked 6 times in 3 weeks", suggested_skill: "...",
    suggested_cron: "0 9 * * 1" }
         ↓
Next /weekly review prep includes the queue alongside playbook drafts
         ↓
User approves → review post-agents create the skill file (and optionally register cron)
         ↓
Next time the user would have asked, the cron has already produced the answer
```

### Happy Path — Frontmatter-driven cron

```
User adds a new agent .claude/agents/sec-filings-watcher.md with:
  ---
  name: sec-filings-watcher
  cron: "0 7 * * 1"
  cron_chat: true        # post output to TG
  ---

Jarvis restart (or /reload-agents) → scheduler scans agents dir → registers cron job
         ↓
Monday 7am → runAgent("sec-filings-watcher") fires; output posted to TG
```

### Happy Path — Deterministic entity auto-linking

```
wiki-compiler ingests a Readwise article mentioning "Patrick Collison" and "Stripe"
         ↓
Compiler writes wiki page draft → returns
         ↓
NEW: entity-extract.ts loads alias map from pages/crm.json + FAMILY_NAMES
         ↓
Finds "Patrick Collison" → adds [[patrick-collison]] to related: frontmatter,
links inline mention in References section only
         ↓
No LLM cost. Reproducible.
```

### Happy Path — `/learn`

```
User: "/learn Don't summarize at the end of every reply — I read the diff."
         ↓
Appended as JSON line to vault/learnings.jsonl with timestamp
         ↓
Next runAgent() invocation prepends the last N learnings to the agent prompt
         ↓
Agent behavior shifts without code change
```

### Entry Points

- **Resolver**: every non-slash, non-session-bound TG message ≥ 5 words.
- **Ask-Twice**: weekly cron job.
- **Skill-cron**: agent file with `cron:` frontmatter.
- **Evals**: `npm run evals` manually.
- **`/learn`**: TG slash command.
- **Entity link, checkpoints**: triggered by KB ingest (transparent).

### Exit Points

- Resolver: message handled by routed skill OR falls through to freeform chat.
- Ask-Twice: proposal lands in weekly review prep.
- Skill-cron: agent runs at scheduled time.
- Evals: pass/fail report in terminal.
- `/learn`: confirmation reply.

---

## Requirements

### Resolver (Phase B)

1. WHEN a non-slash TG message arrives outside an active review session AND is ≥ 5 words THEN the Resolver classifies it against the skill registry.
2. WHEN the classifier confidence ≥ threshold (default 0.7) THEN the routed skill is invoked with the message as args; outcome is logged to `logs/intent-log.jsonl`.
3. WHEN confidence < threshold THEN the message falls through to the existing freeform conversation handler (no behavior change for low-confidence cases).
4. WHEN the routed skill fails THEN the user gets the existing freeform fallback response with a note that routing was attempted.
5. WHEN a slash command, short message (< 5 words), or active-session message arrives THEN the Resolver is skipped (no extra latency).
6. WHEN a new agent is added to `.claude/agents/` with `triggers:` frontmatter THEN it is automatically included in the resolver's skill registry on next startup.

### Ask-Twice telemetry (Phase A harness, Phase B scan)

7. WHEN any message is resolved THEN one JSON line is appended to `logs/intent-log.jsonl`: `{ts, intent, args, confidence, outcome, skill_invoked}`.
8. WHEN the weekly ask-twice scanner runs (Saturday 3pm) THEN it reads the last 30 days of intent log and emits proposals to `logs/proposal-queue.json` with `status: 'pending'`.
9. WHEN proposals are pending THEN they appear in the next dynamic-review prep context alongside playbook drafts.
10. WHEN the user approves a proposal THEN the review post-agents create the skill file and (optionally) the cron entry.

### Skill-frontmatter cron (Phase A)

11. WHEN an agent file in `.claude/agents/` (Jarvis or vault) declares `cron: "<expression>"` THEN it is registered with the scheduler at startup.
12. WHEN `cron_chat: true` is set THEN the agent's stdout is posted to TG; otherwise output is only logged.
13. WHEN the cron schedule fires THEN `runAgent(name, cron_args ?? '')` is invoked; failures are logged but don't crash the scheduler.
14. WHEN an agent file's cron field changes THEN a Jarvis restart re-registers the schedule (no hot-reload required for v1).

### Skill evals — MVP (Phase A)

15. WHEN `evals/<agent-name>.yaml` exists THEN `npm run evals` invokes the agent with each fixture input and reports pass/fail.
16. WHEN an eval YAML declares assertions (substring match, JSON shape, citation present, length range) THEN each is checked against the agent's output.
17. WHEN any eval fails THEN the script exits non-zero with a per-eval breakdown.
18. WHEN `npm run evals -- <agent-name>` is invoked THEN only that agent's evals run.

### `/learn` (Phase A)

19. WHEN the user sends `/learn <text>` THEN the text + timestamp is appended to `vault/learnings.jsonl`.
20. WHEN any agent is invoked via `runAgent()` THEN the most recent N learnings (default 20) are prepended to the agent prompt under a `## Learnings` heading.
21. WHEN learnings exceed a token budget THEN the oldest are dropped from the prepend (file remains intact).
22. WHEN a `/learn-list` command is invoked THEN the current prepended learnings are echoed for inspection.

### Entity auto-linking (Phase C, post-Project-02)

23. WHEN `wiki-compiler` finishes a wiki page write THEN `entity-extract.ts` runs against the page's compiled content.
24. WHEN a known entity name (from `pages/crm.json`, `pages/books.json`, `pages/places.json`, `FAMILY_NAMES`) appears in the page THEN the entity's canonical wiki path is added to the page's `related:` frontmatter (deduped).
25. WHEN entity mentions appear in a "References" or "See also" fenced section THEN bare mentions are replaced with `[[wikilinks]]`. Prose mentions are NOT auto-rewritten (avoid mangling voice).
26. WHEN entity extraction finds zero matches THEN the page is unchanged.

### Compilation checkpoints + source hierarchy (Phase C, post-Project-02)

27. WHEN the KB ingestion queue is processed THEN sources are processed in priority order: `world-view` > `pages/playbook.md` > `journals/*` > `projects/*` > Readwise > conversations > notes.
28. WHEN every 15 ingestions complete THEN `wiki-linter` is invoked automatically and a checkpoint summary is appended to `knowledge/log.md`.
29. WHEN a checkpoint surfaces a quality issue (orphan, stale page, cramming) THEN it is logged to a checkpoint section the next nightly TG summary can include.

---

## Technical Implementation

### Phase A — Independent foundation (parallel-safe with Project 02)

**Skill evals (#7) — first, so Project 02 agents can adopt it at birth:**

New files:
- `evals/README.md` — eval YAML schema documentation.
- `evals/<agent-name>.yaml` — per-agent fixtures + assertions (start with 2–3 agents, e.g. `wiki-compiler`, `kb-query`, `content-triager`).
- `scripts/run-evals.ts` — loads YAML, invokes `runAgent`, runs assertions, prints results.
- `package.json` — add `"evals": "tsx scripts/run-evals.ts"`.

Eval YAML schema (MVP):
```yaml
agent: wiki-compiler
fixtures:
  - name: "Readwise highlight ingestion"
    input: "<sample raw source content>"
    assertions:
      - type: substring
        value: "knowledge/wiki/"
      - type: citation_present
        target: "[[source-name]]"
      - type: max_length_chars
        value: 4000
```

**`/learn` (#8):**

New files:
- `src/bot/commands/learn.ts` — `/learn <text>` handler, appends to `vault/learnings.jsonl`.
- `src/bot/commands/learn-list.ts` — echo current prepended learnings.

Modified files:
- `src/ai/claude.ts:runAgent` — prepend recent learnings (cap at N by token budget).
- `src/bot/handlers/text.ts` — register the new commands.

**Skill-frontmatter cron (#6):**

Modified files:
- `src/ai/claude.ts:loadAgentDef` — extend frontmatter parser to read optional `cron`, `cron_args`, `cron_chat`, `triggers` fields.
- `src/jobs/scheduler.ts` — at `startScheduler`, scan agent files for `cron:` and register a generic `runAgent` job per match.

**Ask-Twice telemetry harness (#2 part 1):**

New files:
- `src/utils/intent-log.ts` — `appendIntent(entry: IntentLogEntry): void` — JSONL append helper.

The scan job and proposal-queue surfacing land in Phase B (after the resolver exists to populate the log).

### Phase B — Resolver (after Phase A)

**Resolver (#1):**

New files:
- `src/bot/resolver.ts` — `classifyIntent(message, registry): { skill, args, confidence }`. Single Haiku call.
- `src/bot/skill-registry.ts` — builds the registry from agent files + slash command metadata + Phase 4 KB-query intent (carried over from Project 02 — see below).

Modified files:
- `src/bot/handlers/text.ts` — inject Resolver call between active-session check and freeform fallback. Wire to `appendIntent()` regardless of routing outcome.
- `src/ai/claude.ts` — add `classifyIntent` thin wrapper over Haiku.

**Phase 4 design assets carried over from Project 02:**

The `kb_query` intent uses the heuristic prompt and KB-shaped/non-KB matrix from Project 02's deferred Phase 4 as test fixtures and as the few-shot examples in the resolver classifier prompt.

KB-shaped/non-KB matrix:

| Example | KB-shaped? |
|---|---|
| "What did Fred Wilson say about glp-1?" | Yes |
| "What do I know about world models?" | Yes |
| "Who runs Stripe these days?" | Yes |
| "Remind me what we decided about Y last sprint?" | Yes |
| "What time is sunset?" | No |
| "Add this to my journal: 11am, called dad." | No |
| "Reply 'thanks' to that." | No |
| "How are you?" | No |

Heuristic prompt (becomes one of the few-shot intents in the resolver registry):

> "Below is a message from the user to a personal assistant that has read access to a personal knowledge base of the user's notes, beliefs, projects, and reading. Would looking up the knowledge base help answer this message? Answer YES or NO with no other text."

In the resolver, `kb_query` is one routed skill among many — the binary classifier expands to N-way classification. The matrix entries are direct test fixtures for the resolver.

**Ask-Twice scan job (#2 part 2):**

New files:
- `src/jobs/intent-scan.ts` — weekly job. Reads `logs/intent-log.jsonl` (last 30 days), groups by intent shape via Haiku, emits proposals to `logs/proposal-queue.json`.

Modified files:
- `src/jobs/scheduler.ts` — register the scan as `intent-scan` (Saturday 3pm) — or via skill-frontmatter cron once #6 is shipped (preferred — eat your own dogfood).
- `src/reviews/interview.ts` — extend prep context to include pending proposals (analogous to the existing playbook-queue surfacing).
- `src/reviews/<dynamic>.ts` post-agents — when proposals are approved, create the skill file or register the cron.

### Phase C — KB optimizations (must wait until Project 02 Phases 1–3 + 5 ship)

**Entity auto-linking (#3):**

New files:
- `src/kb/entity-extract.ts` — `linkEntities(pagePath, content): { related: string[], updatedContent: string }`. Loads alias map from `pages/{books,crm,places}.json` + `FAMILY_NAMES`. Case-aware regex pass over compiled content.

Modified files:
- `src/kb/ingest.ts` — call `linkEntities` after `wiki-compiler` returns; merge `related:` frontmatter; replace bare mentions inside fenced "References" / "See also" sections only.

Note: aware that after Project 02 ships, `knowledge/raw/journals/` is a source path and journals reference many entities. Entity-extract works on the *compiled* page (post-`wiki-compiler`) so source path doesn't matter.

**Compilation checkpoints + source hierarchy (#4):**

Modified files:
- `src/kb/queue.ts` — add `priority` field derivable from source path. Function `getPriority(sourcePath): number`.
- `src/kb/engine.ts:processIngestionQueue` — process in priority order; track ingestion count; every 15, invoke `wiki-linter` and append checkpoint summary to `knowledge/log.md`.

Note: After Project 02 ships, journals enter the queue alongside other sources. Hierarchy ranking puts journals at top alongside `world-view` (because journals are the freshest first-person source). KB-activity scanner from Project 02 Phase 2 may need a backward-compatible parser tweak to skip checkpoint-shaped entries — covered in Phase C tasks.

**~~Hybrid search (#5)~~ — deferred.** See `docs/projects/ideas.md`. Rationale: at current KB scale, ripgrep + the resolver's `kb_query` routing cover the observed query shape. Revisit when the wiki has 100+ pages across varied domains and synonym/paraphrase misses become a felt problem.

### Coordination notes

- **Eval framework lands first in Phase A** so any agent introduced in later phases (e.g., the resolver-classifier prompt itself, the ask-twice scanner output) ships with at least one eval.
- **Skill-frontmatter cron (Phase A) eats its own dogfood**: register the ask-twice scan via frontmatter rather than hardcoding it in `scheduler.ts`.
- **Resolver (Phase B) absorbs Project 02 Phase 4's design assets** — matrix and prompt — as test fixtures and few-shot examples. Document this carryover in the spec so the design lineage is clear.

---

## Implementation Phases

### Phase A — Independent foundation (parallel-safe with Project 02)

> Foundation. None of this touches code paths Project 02 modifies.

- [ ] Eval framework MVP (#7): `evals/` directory + YAML schema doc + `scripts/run-evals.ts` + `npm run evals` entry + 2–3 sample evals
- [ ] `/learn` + `/learn-list` (#8): `learn.ts` command, `runAgent` prepend, learnings file
- [ ] Skill-frontmatter cron (#6): extend `loadAgentDef` parser, scheduler scans agents and registers cron jobs
- [ ] Ask-Twice telemetry harness (#2 part 1): `src/utils/intent-log.ts` JSONL append helper (the scan job lands in Phase B)

### Phase B — Resolver

> Depends on: Phase A (intent-log harness must exist before Resolver can write to it; eval framework ready for resolver evals).

- [ ] Skill registry (`src/bot/skill-registry.ts`): pulls from agent frontmatter `triggers:` + slash command metadata + carried-forward `kb_query` intent
- [ ] Resolver (`src/bot/resolver.ts`): Haiku classifier with confidence threshold + intent-log write
- [ ] Wire into `src/bot/handlers/text.ts` between active-session check and freeform fallback
- [ ] Resolver eval (using the carried-forward KB-shaped matrix as direct fixture)
- [ ] Ask-Twice scan job (#2 part 2): `src/jobs/intent-scan.ts`, register via skill-frontmatter cron (dogfood)
- [ ] Proposal queue surfacing in dynamic-review prep (analogous to playbook queue)
- [ ] Post-review agent extension to create skill file / register cron when a proposal is approved

### Phase C — KB optimizations

> Depends on: Project 02 Phases 1–3 + 5 fully shipped. Do not start Phase C until journals are being ingested nightly and the KB-activity scanner is in production.

- [ ] Entity auto-link (#3): `src/kb/entity-extract.ts` + hook in `src/kb/ingest.ts`
- [ ] Source-priority queue (#4): extend `src/kb/queue.ts` with priority; `processIngestionQueue` orders by priority
- [ ] Mid-run checkpoints (#4): wiki-linter invoked every 15 ingests; checkpoint summary appended to `knowledge/log.md`
- [ ] KB-activity scanner backward-compat tweak (Project 02 Phase 2 deliverable) so checkpoint entries are skipped gracefully
- [ ] ~~Hybrid search (#5)~~ — deferred to `docs/projects/ideas.md`

---

## Edge Cases & Error Handling

### Resolver

- **Ambiguous intent, multiple high-confidence skills**: resolver returns the top match; if top two are within 0.05 confidence, fall through to freeform with a note "Couldn't tell if you meant /X or /Y".
- **Skill invocation fails**: log to intent-log with `outcome: 'failed'`; reply with the existing freeform fallback so the user is never silent-failed.
- **Active session message during conversation**: Resolver is skipped — session takes priority (existing behavior).
- **Very short messages (< 5 words)**: skipped to save Haiku cost; falls through.
- **Slash command typos** (e.g. `/wekly`): not resolver's job; existing slash-command handler reports unknown command.

### Ask-Twice scan

- **Empty intent log (no usage)**: scan returns no proposals; review prep section is suppressed.
- **High-volume intents that aren't actually repeated work** (e.g., the user just chats a lot): the proposer's prompt should explicitly distinguish "asked for the same kind of *thing*" from "chatted a lot." Cap proposals at 3 per scan.
- **Proposal duplicates a skill that already exists**: scanner is given the skill registry as input and instructed to dedupe; if it slips through, the user just rejects in review.
- **Proposal for a cron with bad syntax**: validate the cron expression before writing to proposal queue.

### Skill-frontmatter cron

- **Invalid cron expression**: log error at startup, skip registration, don't crash scheduler.
- **Agent file removed but cron still running**: scheduler is rebuilt at restart, so removed agents get unregistered next boot. Within a session, a missing agent during invocation logs an error and skips.
- **Two agents with the same name** (Jarvis + vault override): existing `loadAgentDef` precedence applies (project-first); cron uses whichever wins.
- **`cron_chat: true` but no TG bot wired**: log warning, fall back to log-only.

### Skill evals

- **Agent invocation times out**: mark eval as failed with timeout reason; continue to next eval.
- **Eval YAML malformed**: skip that file with a clear error; other evals continue.
- **Live API cost concern**: `npm run evals -- --dry-run` validates YAML and counts calls without invoking agents.

### `/learn`

- **Empty `/learn`**: reply with a usage hint, don't append.
- **Learnings file grows beyond token budget**: prepend caps at the most recent N entries; full file remains intact (audit trail).
- **Conflicting learnings** (e.g., two entries that contradict): no automatic resolution — user is responsible. `/learn-list` makes inspection easy.

### Entity auto-linking

- **Entity name appears as a substring of an unrelated word** (e.g., "Stripe" matching "stripes"): use word-boundary regex; case-insensitive but require capitalized first letter for personal names.
- **Same entity has multiple aliases** ("Patrick", "Patrick Collison"): alias map maintained per canonical page; matched in longest-first order to avoid partial substitution.
- **Compiler output is empty / write skipped**: entity-extract is a no-op.
- **Entity has no canonical wiki page yet**: skip (entity-extract only links to existing pages; creating new entity pages is `wiki-compiler`'s job).

### Compilation checkpoints

- **Linter fails mid-checkpoint**: log error, continue processing queue. Checkpoint failure is non-blocking.
- **Queue empty when scheduled**: skip silently.
- **Priority field missing on legacy queue entries**: default to lowest priority.

---

## Open Questions

- [ ] Resolver confidence threshold — start at 0.7 and tune via real usage, or instrument logging-only mode for a week first?
- [ ] Ask-Twice cadence — weekly is the suggested default, but if proposals start surfacing late, consider daily lightweight scan + weekly synthesis.
- [ ] Skill frontmatter triggers field — natural language phrases or structured (regex/keywords)? Lean natural language for the resolver's classifier prompt.
- [ ] `/learn` deletion — is `/forget <substring>` worth it, or is editing `learnings.jsonl` directly enough?
- [ ] When journals enter the KB queue (post-Project-02), should the entity-extract auto-link `[[wikilinks]]` *inside the journal page itself*, or only inside the compiled wiki pages? V1: only compiled wiki pages — journals are first-person source, leave voice intact.
- [ ] Should the resolver be allowed to chain skills (e.g., "summarize today's whoop and add to journal" → run two skills in sequence)? Out of scope for v1; single-skill routing only.
