# Journal-KB Integration Specification

## Overview

Daily journals are about to grow significantly — meeting notes from project teams (Relay, Watt Data), thoughts on active projects, and reading/thinking notes will all land there. This project deepens the integration between the daily journal and the knowledge base so the KB becomes a living digest of consumed/produced content, and the review system uses that digest to drive richer interviews and write-ups.

### Core Value Proposition

What you write in the journal flows into the KB automatically; what's in the KB shapes how reviews interview you and what they write. A tight consumption → reflection → output loop with no manual ingestion.

### Goals

1. **Primary:** Every day's journal is auto-ingested into the KB nightly. New entities/concepts/topics extracted; existing pages updated additively.
2. **Secondary:** Reviews (weekly/monthly/quarterly/yearly) prep with a KB-activity digest of what changed in the wiki during the review window, and use that to drive interviews + write project summaries.
3. **Tertiary:** Meeting notes get first-class structure (attendees → CRM, decisions → project decisions log).
4. **Quaternary:** Default Telegram chat becomes KB-aware (auto-fetches relevant context).
5. **Quinary:** KB volume stays manageable as ingestion scales — `wiki-linter` extends to flag stale (`valid-until`) and orphaned pages; review-prep digests are summarized, not raw log dumps.

### Non-Goals

- **Confidentiality boundary** — this is a private vault; no `#confidential` filtering needed.
- **Citation back-fill in journals** (auto-creating wiki pages for new `[[wikilinks]]` written in journals) — out of scope; the wiki-compiler will create them on next ingest if warranted.
- **Cross-project synthesis** (`/synthesize` command) — out of scope; defer until daily ingestion has run for a few weeks and we can see the connection density.
- **KB-driven morning prep** — out of scope; morning prep stays as-is.
- **Calendar / pre-meeting briefings** — out of scope (no calendar integration in Rune).
- **External API for KB content** — out of scope; KB stays vault-internal.
- **Backfill of past journals** — going forward only. The KB starts learning from the day Phase 1 ships. A one-time backfill script can be added later if needed.
- **Action-item tracking** — meeting extraction in Phase 3 covers attendees and decisions, NOT action items. Action items live in the journal as plain text for now; if they grow into a real tracker, that's a future project.
- **KB-aware default chat (formerly Phase 4)** — deferred to [Project 03 (Resolver & Self-Evolution)](../03-resolver/spec.md), which will route the KB-query intent generally rather than via a single dedicated classifier. Phase 4's design assets (KB-shaped/non-KB example matrix and heuristic prompt) are preserved below under "Phase 4 — Deferred" and carried into Project 03's Resolver spec.

### Scale considerations

Rough volume estimates after Phase 1 + 2 ship (steady state):

- **Daily journal ingest:** 1 ingest/night.
- **Post-review enqueues** (existing flow): 0 most nights, 5-10 on weekly-review nights (Fridays).
- **Wiki growth:** ~10-30 new pages per week initially, asymptoting as the entity/concept space saturates.
- **6-month projection:** O(thousands) of wiki pages — at which point Phase 5 (lint + decay) becomes load-bearing.

`processIngestionQueue` (`src/kb/engine.ts:17-40`) runs ingests **serially** (`for ... await`). Each `wiki-compiler` invocation can take 30-60s. On weekly-review nights with the journal + 5-10 post-review enqueues, total nightly compile time could reach 10+ minutes. This is acceptable for v1; parallelism is a future optimization (out of scope) — flag if it becomes painful.

---

## User Journey

### Happy Path — Daily ingestion produces wiki updates

```
User writes meeting notes + project thoughts in today's journal
         ↓
Nightly job runs (after Daily Tags step)
         ↓
playbook-extract pulls #playbook drafts (existing)
         ↓
NEW: journal-ingest enqueues today's journal into knowledge/raw/journals/
         ↓
KB queue processes it via wiki-compiler (with journal-shaped guidance)
         ↓
Wiki entities updated (people from meetings get journal_refs;
project pages get new context; concepts from reading get added)
         ↓
TG nightly summary: "Journal ingested → 4 entities updated, 2 created."
```

### Happy Path — Weekly review uses KB-activity digest

```
User runs /weekly Friday evening
         ↓
Prep agents run in parallel:
  - journal-scanner (existing)
  - system-scanner (existing)
  - NEW: kb-activity-scanner — summarizes wiki changes in [Sat..Fri] window
  - worldview-drift (existing)
  - playbook-queue (existing)
         ↓
Interview surfaces KB activity:
  "You added 5 entries about [partner X] — what's developing?"
  "Concept page on [framework Y] grew this week — applying it where?"
         ↓
Outline approval → post-agents run:
  - project-updater now KB-aware: queries kb_query for project-related
    entities/concepts before drafting weekly summary; cites specific pages
  - playbook-updater (existing)
  - worldview-updater (existing)
  - psychology-updater (existing)
```

### Happy Path — Meeting notes auto-structure (Phase 3)

```
User writes in journal:
  10:00 #meeting [[relay]] weekly sync. Attendees: [[alice]], [[bob]].
  Decision: ship X by Q2.
         ↓
Nightly journal-ingest runs
         ↓
Detected as meeting block → attendees added to pages/crm.json with journal_ref;
decision appended to projects/relay.md Decisions Log
         ↓
TG nightly summary lists: "1 meeting processed → 2 CRM updates, 1 decision logged"
```

### ~~Happy Path — KB-aware default chat (Phase 4)~~

> **Deferred to [Project 03](../03-resolver/spec.md).** The journey is preserved there as one of N intents the Resolver routes (KB-shaped messages → `kb_query`).

---

## Requirements

### Daily journal ingestion (Phase 1)

1. WHEN the nightly job runs THEN today's journal is enqueued for KB ingestion in `knowledge/raw/journals/`.
2. WHEN a journal is ingested THEN `wiki-compiler` extracts entities (people, companies, products), concepts (frameworks, mental models), and updates to existing project/topic pages — and SKIPS interstitial timestamps and casual asides.
3. WHEN the same journal is re-ingested (e.g., the user edited it later in the day) THEN the raw copy is overwritten and the wiki is updated additively (no duplicates).
4. WHEN journal ingestion completes THEN the nightly TG summary includes the count of entities created/updated.

### KB-activity scanner for reviews (Phase 2)

5. WHEN a dynamic review's prep runs THEN a `kb-activity-scanner` produces a digest of `knowledge/log.md` entries within the review window.
6. WHEN the digest is built THEN it is structured by category (entities created/updated, concepts, topics) with citation counts back to source journals — not a raw log dump.
7. WHEN the digest is non-empty THEN it is appended to the prep context so the interview prompt can surface KB activity to the user.

### Project-updater KB-awareness (Phase 2)

8. WHEN `project-updater` runs THEN, before drafting a weekly summary for a project, it calls `kb_query` (via MCP or direct `queryKB()`) for entities/concepts intersecting that project.
9. WHEN the query returns relevant pages THEN the weekly summary cites them with `[[wikilinks]]` and references KB-derived context (not just journal mentions).

### Meeting notes structure (Phase 3)

10. WHEN a journal contains a `#meeting` tag THEN `meeting-extract` identifies the meeting block (heading + attendees + decisions). Action items in the journal are left as plain text — out of scope for v1.
11. WHEN attendees are present THEN `json-updater` (or a focused helper) updates `pages/crm.json` with each attendee, appending the source journal to `journal_refs` (deduped if same date already present).
12. WHEN a decision is present and a project is tagged in the meeting block THEN the decision is appended to `projects/<slug>.md` Decisions Log via `project-updater` (or a focused helper).
13. WHEN multiple `#meeting` blocks appear in one journal THEN each is processed independently.

### ~~KB-aware default chat (Phase 4)~~

> **Deferred to [Project 03](../03-resolver/spec.md).** Requirements 14–15 are absorbed into the Resolver's `kb_query` intent.

### KB volume + decay (Phase 5)

16. WHEN `wiki-linter` runs (Sundays) THEN it flags pages whose `valid-until` has passed and lists them in the lint report.
17. WHEN `wiki-linter` runs THEN it flags orphaned pages (no inbound `[[wikilinks]]`).
18. WHEN the KB-activity digest grows large THEN it is summarized (not raw-log-dumped) before being appended to prep context.

---

## Technical Implementation

### Phase 1 — Daily journal ingestion

**Files to modify:**
- `src/kb/ingest.ts` — `determineRawDir()` adds `journals/*.md → knowledge/raw/journals/`; `isMutableSource()` includes `journals/`.
- `src/jobs/nightly.ts` — new `stepJournalIngest` between `Daily tags` and `Playbook extract`. Reads today's journal filename, calls `enqueue('journals/<filename>')`. The existing `KB queue` step (which runs *before* daily tags today) needs to be reordered so journal-ingest happens *before* KB queue, OR a second KB-queue pass added at the end. Cleanest: reorder so journal-ingest is just-in-time and KB queue processes everything together.
- `.claude/agents/wiki-compiler.md` — add a "Journal-shaped sources" subsection: skip timestamps and casual asides; focus on extracting people mentioned in meetings, decisions in project notes, concepts from reading; update existing entity/project pages additively.

**No new agents.** Reuse `wiki-compiler`.

**Coordination — `wiki-compiler` vs `project-updater`:**

`wiki-compiler` may create a wiki entry like `knowledge/wiki/entities/relay.md` *about* the relay project (entity-level summary, citations to recent journal mentions). `project-updater` writes to `projects/relay.md` (the living project log — status, thesis, decisions). Two different files, two different writers. Rules:

- `wiki-compiler` MUST NOT write to `projects/*.md` — its scope is `knowledge/` only (already enforced in `wiki-compiler.md`).
- `project-updater` should cite wiki entries via `[[wikilink]]` (e.g., `[[relay]]` or `[[knowledge/wiki/entities/relay]]`) rather than duplicating their content.
- The KB pages are the *summary* layer; the project files are the *living log*. They reference each other but each owns its own content.

This same boundary applies to Phase 3 (meeting decisions go to `projects/<slug>.md` Decisions Log, NOT to wiki).

### Phase 2 — KB-activity scanner + project-updater KB-awareness

**New files:**
- `src/reviews/kb-activity.ts` — exports `scanKBActivity(startDate, endDate): KBActivityDigest`. Reads `knowledge/log.md`, parses ingest entries, groups by category (entity/concept/topic/comparison) and direction (created/updated), counts citations back to journals/raw sources. Returns a structured digest object with a `format()` method that produces a markdown section for prep context.

**Files to modify:**
- `src/reviews/interview.ts` — in `start()`, after the existing prep sections (playbook drafts, drift flags), append the KB-activity digest for `postAgents === 'dynamic'` reviews.
- `src/reviews/weekly.ts`, `monthly.ts`, etc. — no change if interview.ts handles it generically.
- `.claude/agents/project-updater.md` — add a step before drafting weekly summary: "Run `kb_query` for entities/concepts tagged with this project's slug. Cite returned pages with `[[wikilinks]]` in the summary."
- `src/reviews/interview.ts` — when invoking `project-updater`, the prompt could pass a hint: "KB query suggested for project context."

**MCP / direct query:** `project-updater` runs as an agent with access to `kb-query` via MCP server (already registered). Confirm this works; otherwise pass a snapshot of relevant KB pages in the prompt.

**`knowledge/log.md` format reference:**

```
[YYYY-MM-DD HH:MM] [INGEST] <status>: <description...>
  Sources: [[link]], [[link]]
  Pages touched: [[link]], [[link]] | (none)
```

Observed status patterns:
- `Skipped (duplicate)` — source byte-identical or content already covered by existing pages
- `Skipped (image-only)` — source is a single image with no extractable text
- `Skipped (<other reason>)` — agent reasoning varies
- *Implicit success* when "Pages touched" is non-empty (no explicit "Success:" prefix in current logs)

The scanner should:
1. Parse top-level entries by `^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\] \[INGEST\]` regex.
2. Capture the status and the `Pages touched:` line for each.
3. Resolve `[[wikilink]]` paths to category (`entities/`, `concepts/`, `topics/`, `comparisons/`) by file path inspection.

**Skipped vs touched filtering:** The digest must distinguish "ingested with new content" (Pages touched non-empty) from "skipped duplicate" so the review doesn't surface noise. Default behavior: surface only entries with non-empty `Pages touched`; collapse skips into a count (e.g., "12 skips this week") at the bottom of the digest for awareness.

**Future-extension symmetry (out of scope for v1):** by the same logic that makes `project-updater` KB-aware, `psychology-updater` (concept pages on cognition/regulation) and `worldview-updater` (heavy ingest in a topic area = signal that worldview revisit may be due) could also benefit. Note for a future Phase 6.

### Phase 3 — Meeting notes structure

**Scope (v1):** attendees → CRM updates, decisions → project Decisions Log. **Action items are explicitly out of scope for v1** — they live in the journal as plain text and may become a future project if the manual approach proves insufficient.

**New files:**
- `src/jobs/meeting-extract.ts` — exports `extractMeetings(journalContent, journalDate): Meeting[]`. Each `Meeting` has `{attendees: string[], project: string | null, decisions: string[]}`. Detection by `#meeting` tag; LLM call to parse the structure via `askClaudeOneShot` with a structured-output prompt.

**Files to modify:**
- `src/jobs/nightly.ts` — new `stepMeetingExtract` after `stepJournalIngest`.
- Attendees → enqueue CRM update via `json-updater` (append source journal to `pages/crm.json` `journal_refs`, dedup if same date already present).
- Decisions for tagged projects → append to `projects/<slug>.md` Decisions Log via `project-updater` (or a focused helper that writes directly).

**Meeting block boundaries:** A "meeting block" starts at a line containing `#meeting` and ends at one of:
- The next line that's clearly outside the meeting (next major heading, large time gap, unrelated topic), OR
- The next `#meeting` tag (start of a different meeting), OR
- End of journal.

For v1 use **LLM-based block detection** — pass the full journal to the extractor and let it identify blocks holistically. Regex-based boundary detection is too brittle for the user's interstitial-journaling format.

**Multiple meetings per journal:** `extractMeetings` returns an array. The nightly step iterates over the result; each meeting independently dispatches CRM updates and decision appends. If two meetings discuss the same project, decisions append in the order they appear in the journal.

**Open question:** is meeting extraction worth a dedicated agent file, or is `askClaudeOneShot` with a structured-output prompt sufficient? Lean toward the latter for v1.

### Phase 4 — Deferred (design assets carried into Project 03)

**Status:** Deferred to [Project 03 (Resolver & Self-Evolution)](../03-resolver/spec.md). Project 03's Resolver routes intent to N skills generally; `kb_query` becomes one of those routed intents rather than a single binary classifier wedged into `handleConversation()`. The thinking below is preserved as design seed for Project 03's Resolver and is referenced from `03-resolver/spec.md`'s "Phase 4 design assets carried over from Project 02" subsection.

**KB-shaped / non-KB example matrix (carried into Project 03 as resolver test fixtures):**

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

**Heuristic prompt (carried into Project 03 as the few-shot seed for the `kb_query` intent in the resolver registry):**

> "Below is a message from the user to a personal assistant that has read access to a personal knowledge base of the user's notes, beliefs, projects, and reading. Would looking up the knowledge base help answer this message? Answer YES or NO with no other text.
>
> Message: {message}"

**Performance note (carried over):** classifier-per-message has cost; skip for slash commands and messages < 5 words. Project 03's Resolver follows the same pattern.

### Phase 5 — KB volume + decay

**Files to modify:**
- `src/kb/lint.ts` — extend lint prompt / `wiki-linter` agent to:
  - Flag pages whose `valid-until` is past today's date.
  - Flag pages with zero inbound `[[wikilinks]]` (orphans).
- `src/reviews/kb-activity.ts` — when the digest exceeds a threshold (say 50 entries), pipe through a one-shot summarizer instead of raw output.
- `.claude/agents/wiki-linter.md` — update to require these checks in the report.

---

## Implementation Phases

### Phase 1: Daily journal ingestion

> Foundation. Nothing else works without this.

- [ ] `determineRawDir()` routes `journals/*.md` to `knowledge/raw/journals/`
- [ ] `isMutableSource()` marks `journals/` mutable
- [ ] Nightly `stepJournalIngest` enqueues today's journal
- [ ] `wiki-compiler.md` updated with journal-shaped guidance
- [ ] Tests: routing, mutable behavior, nightly step ordering, wiki-compiler instructions sanity-check
- [ ] Manual end-to-end: write a journal with a meeting + reading + project thought; trigger nightly; confirm KB updates

### Phase 2: KB-activity scanner + project-updater KB-aware

> Depends on: Phase 1 producing actual KB activity to scan

- [ ] `src/reviews/kb-activity.ts` (`scanKBActivity` + digest formatter)
- [ ] Interview integration via `extraPrepContext` or inline in `start()`
- [ ] `project-updater.md` extended with kb_query step + citation requirement
- [ ] Tests: log-parsing, digest categorization, integration with weekly prep
- [ ] Manual end-to-end: run `/weekly` after a week of journal ingestion; confirm interview surfaces KB activity and project summaries cite wiki pages

### Phase 3: Meeting notes structure

> Depends on: Phase 1 (journals being ingested)

- [ ] `src/jobs/meeting-extract.ts` with `extractMeetings()` (LLM block detection, returns array)
- [ ] Nightly `stepMeetingExtract` after journal ingest, iterates over all meetings in the journal
- [ ] CRM update wiring (existing `json-updater`, dedup `journal_refs` per source date)
- [ ] Decisions Log append wiring (via `project-updater` or focused helper)
- [ ] Tests: meeting detection, attendee extraction, decision routing, multi-meeting handling
- [ ] Manual end-to-end: write a `#meeting` block in journal with attendees + decisions; trigger nightly; confirm CRM update + project decision append

### ~~Phase 4: KB-aware default chat~~

> **Deferred to [Project 03 (Resolver & Self-Evolution)](../03-resolver/spec.md).** Phase 4's design assets (KB-shaped/non-KB matrix and heuristic prompt) are preserved above under "Phase 4 — Deferred" and carried into Project 03's Resolver spec. Phase numbering is left as-is for stability; there is no Phase 4 deliverable in this project.

### Phase 5: KB volume + decay

> Depends on: Phase 1 (some volume to manage)

- [ ] `wiki-linter` extended for `valid-until` expiry + orphan detection
- [ ] KB-activity digest summarization layer (when over threshold)
- [ ] Tests: lint flag conditions, summarization trigger
- [ ] Manual end-to-end: backdate a `valid-until` and run lint; confirm flag

---

## Edge Cases & Error Handling

### Date attribution in KB-activity digest
If the user edits Monday's journal on Tuesday and the nightly re-ingests it, the new `knowledge/log.md` entry timestamps Tuesday — but the underlying journal is for Monday. The "this week" filter in the KB-activity scanner uses the *log entry timestamp*, not the journal date. So a Tuesday digest of "Mon-Fri this week" will correctly include the re-ingest, but a Monday-night digest of "previous week" will *miss* edits made later. Acceptable for v1 — if it becomes painful, switch the digest filter to use the source journal's date instead of the log timestamp.

### Empty / sparse logs
If `knowledge/log.md` has no entries in the review window (quiet week, ingestion paused, etc.), the digest returns an empty section header. The interview prep should suppress empty sections (no header rendered).

### Malformed log entries
The scanner uses a regex to identify entry boundaries. Lines that don't match are skipped silently with a debug log. A single malformed entry doesn't abort the scan.

### Wiki-compiler journal hygiene
If wiki-compiler crashes mid-ingest, the journal stays in the queue (existing `processIngestionQueue` semantics — only successful ingests `dequeue`). Next nightly retries.

### Meeting-extraction false positives
`#meeting` could appear in a journal where the author is just *referencing* a meeting (not transcribing one). The extractor should be conservative: if a `#meeting` block has no attendees and no decisions, skip it (no CRM/decisions writes). Surface a count in the nightly TG summary so the user can spot pattern issues.

### CRM dedup
When meeting attendees are added to `pages/crm.json`, the `json-updater` must check whether the source-journal date already exists in the contact's `journal_refs`. Don't duplicate if same-day add.

## Open Questions

- [ ] Should `wiki-compiler` invocations for journal ingestion run with a **specialized journal-compiler agent** instead of the generic `wiki-compiler` with extra guidance? (Cleaner separation; more files to maintain.)
- [ ] What's the dedup strategy for entities mentioned across many journals? Should `wiki-compiler` consolidate aggressively, or accept some redundancy initially?
- [ ] For Phase 3 meeting extraction — `#meeting` tag, or LLM detection of meeting-shaped blocks even without a tag? (Tag is simpler; LLM detection is more flexible.)
- [ ] Phase 5 — what's the right `valid-until` policy by page type? (Entities decay slowly; price/role facts decay fast.)
- [ ] Should action-item tracking be added later as a separate project? (Skipped in v1; revisit if meeting notes accumulate uncloseable TODOs.)
- [ ] Should past journals be backfilled into the KB? (Out of scope for v1; revisit once Phase 1 is running and the user can see whether the historical context would add value.)
- [ ] When `processIngestionQueue` becomes a bottleneck (10+ minute nightlies), parallelize? Each ingest is independent — could run with `Promise.all` if rate-limit allows.
