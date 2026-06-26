# Spaced Repetition Study Specification

## Overview

The wiki under `knowledge/wiki/concepts/` is growing fast — every nightly ingestion pass compiles new pages, but nothing inside Rune nudges Michael back to concepts he learned a month ago. Foundational ideas (e.g., `processing-vs-extraction`, `critical-materials-prerequisite`, `ai-power-constraint`) get written down once and then drift out of working memory. The current `/study` command tracks a structured syllabus (books and reading plans) and does not reinforce wiki content.

This project adds a lightweight daily spaced-repetition (SR) loop on top of the wiki. Rune pings Michael at 12:00 CT with 5 open-ended questions drawn from non-stale wiki concepts, an `sr-question-generator` agent composes the questions, an `sr-grader` agent scores Michael's free-form answers against a rubric, and SR state advances on a fixed-interval ladder. The existing `/study` command is renamed `/syllabus` to free the name — `/syllabus` keeps the syllabus-tracking behavior, the `#study` tag continues to route there. The new `/study` is the SR session entry point.

The project also introduces a `status` field (`evergreen | active | stale`) on wiki concept frontmatter. `wiki-compiler` infers the status on new concepts and proposes (never directly applies) status changes on existing concepts via a `knowledge/status-proposals.json` queue, which `wiki-linter` surfaces for approval during `/weekly`. Other systems can consume the same field — the SR pool is the first consumer.

### Core Value Proposition

A small daily reinforcement loop (5 questions, ~5–10 minutes at lunch) that makes the wiki compound instead of decay — and a `status` model on wiki concepts that other systems can build on.

### Goals

1. **Primary:** Maintain retention of evergreen and currently-relevant wiki concepts via a daily 5-question open-ended quiz over Telegram, with a grading rubric that explains gaps.
2. **Secondary:** Surface forgotten or weak concepts so Michael can re-engage with them (lapse tracking and an eventual hotspot report).
3. **Tertiary:** Introduce a `status` field on wiki concepts (`evergreen | active | stale`) that the SR pool — and any future system — can consume.

### Non-Goals

- **Quizzing on stale wiki content.** Stale concepts are evicted from the SR pool; their state is preserved so they can rejoin if reclassified.
- **Manual flashcard authoring.** Content comes from the wiki. Never hand-written cards.
- **Replacing syllabus-based structured learning.** That moves to `/syllabus` and keeps the `#study` tag.
- **Heavy daily load.** Capped at 5 default, 10 max per session.
- **Auto-applying wiki status changes.** All status transitions on existing concepts go through Michael's approval in the next `/weekly`.
- **Tracking exposure separately from wiki authorship.** If a concept exists in the wiki, that's the exposure event — no second event log.

### Scale Considerations

- **Daily concept fan-out:** 5 (default) up to 10 (manual `/study N`). One question-gen and one grader call per concept. ~5–10 LLM calls per session.
- **Wiki size:** current `knowledge/wiki/concepts/` is on the order of dozens of files; pool grows monotonically as new concepts compile. Staleness is the hypothesized natural bound. If pool growth outpaces staleness, Phase 4 graduation rules kick in.
- **State file size:** `study/spaced-repetition.json` is one record per concept. Easily a few thousand bytes per entry, capped well under any concerning size.
- **No new env vars, no new MCP servers, no new cron beyond the 12:00 CT entry.**

---

## User Journey

### Happy Path — daily SR session at lunch

```
12:00 CT — Rune cron fires.
         ↓
selectDueConcepts() reads study/spaced-repetition.json,
filters to status ∈ {evergreen, active} AND next_due ≤ today,
sorts by most overdue first then random, caps at 5.
         ↓
If queue is empty: TG message "no reviews due today, enjoy lunch." Done.
         ↓
For each concept in the queue:
   sr-question-generator(concept_content, last_3_question_texts) → question
   TG: "Lunch review — q1 of 5: <question>"
   Wait up to 30 min for Michael's reply.
   sr-grader(concept_content, answer) → {grade, missed_points}
   TG: "<grade>. Concept: [[concept-slug]]. <missed_points if grade < good>"
   advance SR state per the interval ladder.
         ↓
End of session: TG summary "5/5 done — 2 good, 2 hard, 1 again. Next batch tomorrow."
         ↓
study/spaced-repetition.json persisted.
```

### Happy Path — manual ad-hoc session

```
Michael sends "/study" (or "/study 8") in TG at any time.
         ↓
Same selection + question/grade loop, default 5, max 10.
         ↓
Independent of the daily cron — does not advance "today's" run flag.
```

### Happy Path — empty pool

```
selectDueConcepts() returns [].
         ↓
TG: "no reviews due today, enjoy lunch."
         ↓
No session is created. No state writes.
```

### Lapse path — Michael doesn't reply

```
TG sends question; no reply within 30 minutes.
         ↓
Session lapses. Unanswered concepts grade as `again`, reset to 1d.
Already-graded concepts in the session keep their grades.
         ↓
TG: "lapsed at q3/5. q1+q2 saved, q3-q5 marked `again`."
         ↓
state persisted.
```

### Wiki status proposal flow (weekly)

```
wiki-compiler runs nightly. For each existing concept whose signals
suggest a status change, append a proposal to knowledge/status-proposals.json.
         ↓
wiki-linter runs weekly. Reads the proposals queue, surfaces it
during /weekly review.
         ↓
Michael approves or rejects each proposal in the review outline.
         ↓
worldview-style updater applies approved status changes to concept
frontmatter; rejected proposals are dropped from the queue.
         ↓
Concepts flipping to `stale` leave the SR pool. SR state preserved.
Concepts flipping back to `active`/`evergreen` rejoin the pool with
preserved state — next_due may already be in the past, surfacing first.
```

### Entry Points

- 12:00 CT daily Rune cron (primary).
- `/study` slash in TG (ad-hoc, default 5 questions).
- `/study N` slash in TG (1 ≤ N ≤ 10).
- `/study status` slash in TG (pool size, due today, lapse hotspots).

### Exit Points

- Session summary line on completion or lapse.
- SR state persisted; next due dates computed.
- For Phase 3+: weekly lint output includes status proposals queued by the compiler.

---

## Requirements

### Wiki status field

1. WHEN `wiki-compiler` generates a new concept page, THEN it sets a `status` field in the concept's frontmatter (`evergreen | active | stale`).
2. WHEN the compiler infers status on a new concept, THEN it uses these signals:
   - Derived primarily from `knowledge/raw/playbook/*` or synthesizing across ≥ 3 long-lived sources → `evergreen` candidate.
   - Derived primarily from `knowledge/raw/articles/*` or `knowledge/raw/world-view/*` → `active`.
   - No new references in ≥ 180 days AND derived from time-sensitive sources → `stale` candidate.
3. WHEN the compiler would change an existing concept's status, THEN it appends a proposal to `knowledge/status-proposals.json` instead of editing the file directly.
4. WHEN `wiki-linter` runs weekly, THEN it surfaces pending proposals in the next `/weekly` review for approval.
5. WHEN Michael approves a proposal, THEN the concept's frontmatter `status` is updated and the proposal is removed from the queue.
6. WHEN Michael rejects a proposal, THEN the proposal is removed from the queue without changing the file.
7. WHEN Michael manually sets `status` in a concept's frontmatter, THEN the compiler treats the field as a locked override and stops proposing changes for that concept.

### SR pool admission and eviction

8. WHEN a wiki concept has `status` ∈ {`evergreen`, `active`}, THEN it is in the active SR pool.
9. WHEN a concept enters the pool for the first time, THEN its `next_due` is scheduled for 1 day after admission and `current_rung` is set to `1d`.
10. WHEN a concept's `status` flips to `stale`, THEN it is excluded from selection but its SR state in `study/spaced-repetition.json` is preserved.
11. WHEN a previously-stale concept's `status` flips back to `evergreen` or `active`, THEN it re-enters the pool with its preserved state (no reset).
12. WHEN no concepts are due AND the pool is non-empty, THEN the daily cron sends "no reviews due today, enjoy lunch" and creates no session.

### SR scheduling (fixed interval ladder)

13. WHEN a concept is graded, THEN its `current_rung` advances per the ladder: `1d → 3d → 7d → 14d → 30d → 60d → 120d (cap)`.
14. WHEN grade = `good`, THEN advance one rung.
15. WHEN grade = `easy` AND it is the concept's first pass at the current rung in this admission cycle, THEN advance two rungs.
16. WHEN grade = `easy` AND it is not the first pass, THEN advance one rung (same as `good`).
17. WHEN grade = `hard`, THEN repeat the current rung (no advance, no reset).
18. WHEN grade = `again`, THEN reset `current_rung` to `1d` and increment `lapse_count`.
19. WHEN selecting due concepts, THEN sort by most overdue first, then random, then cap at 5 (or N for manual sessions).

### Question generation (`sr-question-generator` agent)

20. WHEN generating a question, THEN it must require explaining mechanism, reasoning, or application — not just defining a term.
21. WHEN generating a question, THEN it must be answerable from the concept's content alone.
22. WHEN generating a question for a concept that has been reviewed before, THEN the question text must differ from each of the last 3 question texts stored on that concept.
23. WHEN no acceptable question can be generated (concept content too thin, or all variants exhausted), THEN the generator returns a "skip" signal and the orchestrator picks the next due concept.

### Grading (`sr-grader` agent)

24. WHEN grading an answer, THEN the agent first identifies 2–4 core points the concept makes.
25. WHEN all core points are covered AND articulated clearly in Michael's own words, THEN grade = `easy`.
26. WHEN most core points are covered with minor gaps, THEN grade = `good`.
27. WHEN some core points are covered with significant gaps or hesitation, THEN grade = `hard`.
28. WHEN Michael did not recall the concept or was fundamentally wrong, THEN grade = `again`.
29. WHEN grade < `good`, THEN the response lists the specific missed points (not "you missed some").
30. WHEN grade ≥ `good`, THEN the response is a short confirmation (one to two sentences); the concept's wikilink is always included.

### Session semantics

31. WHEN Rune sends a question AND Michael does not reply within 30 minutes, THEN the session lapses: unanswered concepts grade as `again`, already-graded concepts keep their grades.
32. WHEN a session lapses, THEN Rune sends a one-line lapse summary and persists the partial state.
33. WHEN a session is in progress, THEN Rune does not send nudges. One reply window per prompt.
34. WHEN a session ends (complete or lapsed), THEN Rune sends a single summary line with grade counts and the concept count.

### Command surface

35. WHEN Michael sends `/study` (no args), THEN run an ad-hoc 5-question SR session.
36. WHEN Michael sends `/study N`, THEN run an N-question SR session where 1 ≤ N ≤ 10. Clamp out-of-range values, reply with the clamp.
37. WHEN Michael sends `/study status`, THEN reply with pool size, due-today count, and lapse hotspots (top 5 concepts by `lapse_count`).
38. WHEN Michael sends `/syllabus` (or sub-args), THEN execute the previous `/study` syllabus-tracking behavior.
39. WHEN nightly `/daily` processes `#study` tags, THEN it continues to route to syllabus progress (no behavior change).

---

## Technical Implementation

### New files

```
study/spaced-repetition.json          # per-concept SR state
knowledge/status-proposals.json       # pending wiki status changes queued by compiler
```

### `study/spaced-repetition.json` schema

```typescript
{
  concepts: {
    [conceptPath: string]: {
      concept_path: string;          // e.g., "knowledge/wiki/concepts/processing-vs-extraction.md"
      admitted_date: string;         // YYYY-MM-DD
      current_rung: "1d" | "3d" | "7d" | "14d" | "30d" | "60d" | "120d";
      next_due: string;              // YYYY-MM-DD
      last_reviewed: string | null;  // YYYY-MM-DD, null until first review
      last_grade: "again" | "hard" | "good" | "easy" | null;
      review_count: number;
      lapse_count: number;
      last_questions: string[];      // last 3 question texts, oldest first
    };
  };
  meta: {
    last_session_at: string | null;  // ISO timestamp
    last_session_summary: string | null;
  };
}
```

### `knowledge/status-proposals.json` schema

```typescript
{
  proposals: Array<{
    concept_path: string;
    current_status: "evergreen" | "active" | "stale";
    proposed_status: "evergreen" | "active" | "stale";
    reason: string;                  // one-line rationale from the compiler
    proposed_at: string;             // ISO
  }>;
}
```

### Rune agents (new, generic — Rune's `.claude/agents/`)

#### `sr-question-generator`

- **Input:** concept content (markdown body of the wiki page) and `last_questions` array.
- **Output:** one open-ended question (≤ 200 chars) OR a `{ skip: true, reason }` signal.
- **Rules:** must require mechanism/reasoning/application; must not repeat any of the last 3 question texts (case-insensitive trimmed compare).
- **Tunable independently from the grader** — separate prompt file, separate eval fixtures.

#### `sr-grader`

- **Input:** concept content and Michael's answer.
- **Output:** `{ grade: "again" | "hard" | "good" | "easy", core_points: string[], missed_points: string[], explanation: string }`.
- **Rules:** identify 2–4 core points before grading; explanation enumerates missed points when grade < `good`.
- **Tunable independently from generation.**

#### `sr-state-updater` (optional — may be a code module, not an agent)

- Pure code module preferred for SR state writes (`src/study/sr-state.ts`). Use the existing `json-updater` agent only if rubric updates need natural-language editing — not the case here.

### Rune code modules

```
src/study/sr-state.ts                 # read/write study/spaced-repetition.json,
                                      # advanceRung(), resetRung(), repeatRung()
src/study/sr-pool.ts                  # readPool() — walk wiki/concepts, filter by status
src/study/sr-select.ts                # selectDueConcepts({ pool, today, cap })
src/study/sr-session.ts               # orchestrate one session end-to-end
                                      # (gen → ask → wait → grade → persist)
src/bot/commands/study.ts             # NEW — SR entry point
src/bot/commands/syllabus.ts          # MOVED from old study.ts
src/jobs/sr-daily.ts                  # cron entry; invoked at 12:00 CT
```

### Wiki integration

- `wiki-compiler` agent: extend prompt to set `status` on new concept frontmatter; for existing concepts, propose changes to `knowledge/status-proposals.json` (read-modify-write, do not edit the concept file). Respect the locked-override rule (Requirement #7).
- `wiki-linter` agent: extend to read `knowledge/status-proposals.json` and emit a "pending status proposals" section in the weekly lint output for `/weekly`.
- Backfill `status` across existing `knowledge/wiki/concepts/*.md` as a Phase 3 deliverable.

### Cron entry (Phase 2)

- Daily at 12:00 CT → `src/jobs/sr-daily.ts` → `runSRSession({ source: "cron", cap: 5 })`.
- Wired in the same registration surface as existing crons (morning-prep, nightly, etc.).

### Command changes

- Move current `src/bot/commands/study.ts` → `src/bot/commands/syllabus.ts`. Register `/syllabus` in `src/bot/handlers/text.ts` and `src/bot/skill-registry.ts`.
- Add new `src/bot/commands/study.ts` for SR sessions. Register `/study` (no args), `/study N`, `/study status`.
- Update `CLAUDE.md` Reference System: `#study` still routes to `study/progress.json` (syllabus), unchanged.
- Update `study/index.md` to document both the syllabus progress file AND `study/spaced-repetition.json`.
- Update `/daily` parsing notes to refer to syllabus for `#study` tag handling (path moved but behavior is identical).

---

## Implementation Phases

### Phase 1 — End-to-end manual quiz

- [ ] Rename current `/study` → `/syllabus`; update `CLAUDE.md`, `study/index.md`, handler + registry wiring, and `/daily` notes.
- [ ] Add `sr-question-generator` agent (Rune `.claude/agents/`) with prompt, eval fixture, and the variation/skip rules.
- [ ] Add `sr-grader` agent with prompt, eval fixture, and the missed-points rubric.
- [ ] Add `src/study/sr-state.ts` + `study/spaced-repetition.json` (empty initial file). Cover read/write/advance helpers with tests.
- [ ] Add `src/bot/commands/study.ts` for ad-hoc sessions. Use a hand-seeded pool of ~20 non-stale concepts to start (curated from current `knowledge/wiki/concepts/`).
- [ ] Wire `/study`, `/study N`, `/study status` triggers in handlers + registry.
- [ ] Run manually for 1–2 weeks. Tune both agents based on the actual sessions.

### Phase 2 — Daily cron + session semantics

> Depends on: Phase 1.

- [ ] Add `src/jobs/sr-daily.ts` and register the 12:00 CT cron.
- [ ] Implement the 30-minute reply timeout in `src/study/sr-session.ts`. Unanswered → `again`; partial session persists.
- [ ] Implement empty-pool handling (single TG line, no session created).
- [ ] Implement `/study status` reply (pool size, due today, lapse hotspots).

### Phase 3 — Wiki freshness pipeline

> Depends on: Phase 2.

- [ ] Add `status` to wiki concept frontmatter schema (document in `knowledge/wiki/` index/README).
- [ ] Backfill `status` across all existing `knowledge/wiki/concepts/*.md` (one-time script; conservative defaults — playbook-derived → evergreen, articles/world-view-derived → active, the rest manually reviewed).
- [ ] Update `wiki-compiler` to infer status on new concepts and to write proposals (never direct edits) for existing concepts. Respect manual overrides.
- [ ] Add `knowledge/status-proposals.json` writer/reader helpers in Rune.
- [ ] Update `wiki-linter` to surface pending proposals during `/weekly`.
- [ ] Wire proposal approval into the `/weekly` outline → updater flow.
- [ ] Confirm the SR pool now auto-expands to all non-stale concepts; remove the hand-seeded list from Phase 1.

### Phase 4 — Polish (deferred)

> Only if needed after 2+ months of usage data.

- [ ] Lapse hotspot report surfaced in `/weekly`.
- [ ] Graduation rule for long-retained concepts (e.g., 3 consecutive `easy` at the 120d rung graduates out of the active pool).
- [ ] Revive-stale flow: when a `stale` concept is re-referenced (new raw source citation, new journal mention), propose flipping it back to `active`.
- [ ] Per-rung distribution in `/study status` (only if the total view turns out to be insufficient).

---

## Success Metrics

### Leading indicators (week 1+)

| Metric | Target | How Measured |
| --- | --- | --- |
| Adherence | ≥ 5 sessions/week, sustained 4+ weeks | count of completed sessions in `study/spaced-repetition.json.meta` |
| Pool coverage | each non-stale concept reviewed at least once within 90 days of Phase 3 launch | scan `last_reviewed` across the pool |

### Lagging indicators (month 2+)

| Metric | Target | How Measured |
| --- | --- | --- |
| Recall improvement | average grade trends from ~`hard` toward ~`good` over the first 8 weeks | rolling 4-week mean of grade ordinal |
| Lapse concentration | ≤ 10% of pool accounts for ≥ 50% of repeat-lapses | distribution of `lapse_count` across pool |

### Subjective (the real signal)

- Michael draws on wiki concepts more readily in `/think`, writing, and journals — and gets them right when he does.

---

## Edge Cases & Error Handling

### Pool / selection

- **Empty pool, zero concepts ever admitted:** `/study` replies "no concepts in the SR pool yet"; cron sends nothing.
- **Pool exists but nothing due:** TG "no reviews due today, enjoy lunch"; no session.
- **Concept missing from disk but present in state file (deleted wiki page):** drop from selection; flag in `study/spaced-repetition.json.meta` for cleanup at next session boundary.
- **Concept exists but content is empty / under a threshold:** `sr-question-generator` returns `skip`; orchestrator picks the next eligible concept until cap is met or queue is exhausted.

### Sessions

- **Michael replies after the 30-minute window closes:** reply is ignored for SR state; orchestrator may offer a one-line "session lapsed at <time>" if he sends a free-text message inside the same chat thread.
- **Michael sends `/study` mid-cron-session:** reject the manual invocation with "a cron session is in flight — finish it first." Single in-flight session per user.
- **Multiple lapses in a row (e.g., 3+ days of all-`again`):** no special handling in MVP; Phase 4 hotspot report surfaces the pattern.

### Wiki status pipeline

- **Compiler proposes a status change for a manually-overridden concept:** compiler skips the proposal entirely (locked override).
- **Status-proposals queue gets large between weekly reviews:** `wiki-linter` surfaces a one-line "N pending status proposals" summary; the review outline shows the top 10 with full reasons, the rest are bulk-approve/reject.
- **Approval applied but concept file was edited in the meantime:** updater diffs first, applies only the frontmatter `status` change, leaves body untouched.

### Agent failures

- **`sr-question-generator` returns malformed output:** retry once; on second failure, skip the concept.
- **`sr-grader` returns malformed grade:** retry once; on second failure, default to `hard` with a flagged explanation ("grader error, treating as hard"), persist for review.
- **Telegram send fails mid-session:** persist partial state with an `incomplete: true` marker; next session resumes the remaining concepts on the next eligible day, not immediately.

---

## Open Questions

- [ ] Pool growth vs. staleness rate is empirical. If the pool grows faster than staleness can prune it (so each concept is reviewed less than every 60 days), Phase 4 graduation rules become necessary. Decide after 2 months of real data.
- [ ] Should `/study status` show per-rung distribution (how many concepts at 1d, 3d, 7d, etc.) or just totals? Decide during Phase 2 once there is a real distribution to look at.
- [ ] Does the 30-minute lapse window need to vary by time of day (e.g., longer if cron fires while Michael is in a meeting)? Defer until enough lapses accumulate to see a pattern.
- [ ] How conservative should the Phase 3 backfill be? One option is to default everything to `active` and let the compiler propose `evergreen`/`stale` over the following weeks; another is to bulk-classify upfront. Decide just before Phase 3 starts.
