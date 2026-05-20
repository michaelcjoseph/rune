# Spaced Repetition Study — Tasks

Not started. See [spec.md](spec.md) for details and [test-plan.md](test-plan.md) for verification.

## Phase 1 — End-to-end manual quiz

> Goal: a working ad-hoc `/study` session against a hand-seeded pool, plus the syllabus rename. No cron, no wiki status field yet.

### Syllabus rename

- [x] Rename `src/bot/commands/study.ts` → `src/bot/commands/syllabus.ts`. Update the exported handler name + internal references.
- [x] Update `src/bot/handlers/text.ts` to route `/syllabus` to the renamed handler.
- [x] Update `src/bot/skill-registry.ts` `SLASH_COMMAND_METADATA` — remove `study` row (will be re-added for SR), add `syllabus` row with the old triggers.
- [x] Update `CLAUDE.md` Reference System note for `#study` — clarify the tag routes to `study/progress.json` via the renamed `/syllabus` command.
- [x] Update `CLAUDE.md` Claude Code Commands table — replace the `/study` row's "Current study progress…" description by moving it under `/syllabus`. Leave `/study` row blank for now (gets re-added in this phase below).
- [x] Update `study/index.md` to reflect the rename and document the upcoming `study/spaced-repetition.json` file.
- [x] Update `.claude/commands/study.md` (if it exists in the vault) → rename to `.claude/commands/syllabus.md`. Confirm `/daily` parsing notes do not need changes (still routes `#study` → syllabus progress).
- [x] `grep -r "/study" docs/ CLAUDE.md study/` and clean up any references the rename missed.

### State + helpers

- [x] Create `study/spaced-repetition.json` with empty `{ concepts: {}, meta: { last_session_at: null, last_session_summary: null } }`.
- [x] Add `src/study/sr-state.ts` exporting:
  - `readSRState()` / `writeSRState(state)`
  - `advanceRung(state, conceptPath, grade)` — pure function returning the next state given the ladder rules in spec Requirements #13–#18
  - `resetRung(state, conceptPath)` and `repeatRung(state, conceptPath)` helpers
- [x] Add `src/study/sr-pool.ts` exporting `readPool({ statusFilter = ['evergreen', 'active'] })` — Phase 1 reads from a hand-seeded JSON list (e.g., `study/sr-seed.json`) since wiki `status` is not yet present. Replaced in Phase 3 by a frontmatter walker.
- [x] Add `src/study/sr-select.ts` exporting `selectDueConcepts({ pool, today, cap })` — sort by most overdue first, then random, cap at N.
- [x] Vitest coverage for `sr-state.ts` (ladder transitions on each grade, edge cases at the 120d cap) and `sr-select.ts` (sort + cap behavior).

### Agents

- [x] Author `.claude/agents/sr-question-generator.md` in Jarvis (NOT vault). Frontmatter: name, description, triggers (none — invoked programmatically), tools allow-list (Read only). Body covers the rubric in spec Requirements #20–#23 and the structured output shape.
- [x] Author `.claude/agents/sr-grader.md` in Jarvis with the rubric in Requirements #24–#30 and the structured output shape (`{ grade, core_points, missed_points, explanation }`).
- [x] Add `evals/sr-question-generator.yaml` with at least three fixtures: (a) a content-rich concept producing a mechanism-focused question, (b) a content-thin concept producing a `skip` signal, (c) a concept with three prior questions where the new question must differ from all three.
- [x] Add `evals/sr-grader.yaml` with fixtures covering each of the four grades (again/hard/good/easy), each asserting both grade and a non-empty `missed_points` array when grade < `good`.

### Session orchestrator + command

- [x] Add `src/study/sr-session.ts` exporting `runSRSession({ source, cap, userId })`. Orchestrates: select due → for each concept, generate question → send via `MessageSender` → wait for reply (Phase 1: synchronous wait via existing conversation hook; 30-min timeout deferred to Phase 2) → grade → advance state → next.
- [x] Add `src/bot/commands/study.ts` (new file). Parse args: no arg → cap 5; integer arg → cap clamped to [1, 10]; `status` arg → status reply (Phase 2 will add lapse hotspots; Phase 1 returns pool size + due today only).
- [x] Register `/study` (and the `/study N`, `/study status` shapes) in `src/bot/handlers/text.ts` and `src/bot/skill-registry.ts` with triggers like "quiz me", "review wiki", "spaced repetition", "lunch review".
- [x] CLI: add `study` subcommand in `cli/jarvis.ts` so `npm run cli -- study [N]` runs a session and prints the question/answer cycle.

### Hand-seeded pool

- [ ] Curate ~20 non-stale concepts from `knowledge/wiki/concepts/` into `study/sr-seed.json` as `{ concepts: string[] }` (paths). Bias toward concepts Michael has touched in the last 60 days and toward playbook-derived ones.
- [ ] Document the seed approach in `study/index.md` and note it gets retired in Phase 3.

### Manual usage

- [ ] Run `/study` daily for at least one week. Capture rough sessions notes (paste in journals) on:
  - Question quality (too easy, too rote, repeating themselves)
  - Grading accuracy (over-harsh, over-lenient, missed-points relevance)
- [ ] Tune `sr-question-generator.md` and `sr-grader.md` based on the notes. Update eval fixtures to lock in the improvements.
- [ ] Documentation: update `CLAUDE.md` Agents table with `sr-question-generator` and `sr-grader` rows.
- [ ] Documentation: update `docs/projects/index.md` row for `07-spaced-repetition` from "Planned" → "In Progress (Phase 1)".

## Phase 2 — Daily cron + session semantics

> Depends on: Phase 1.

### Cron registration

- [ ] Add `src/jobs/sr-daily.ts` exporting `runDailySR()`. Calls `runSRSession({ source: 'cron', cap: 5, userId: TELEGRAM_USER_ID })`. Logs the session summary to the existing nightly-style log surface.
- [ ] Register the cron at 12:00 CT in the cron registration surface (same place morning-prep and nightly are wired). Confirm CT timezone handling matches existing crons.
- [ ] Tests: `runDailySR` calls `runSRSession` once with cap 5; empty pool sends the "enjoy lunch" line and creates no session; in-flight cron rejects a concurrent manual `/study`.

### 30-minute timeout

- [ ] Update `src/study/sr-session.ts` to implement a per-question 30-min reply timeout. On timeout, mark the current concept as `again`, persist state for completed concepts, and send a one-line lapse summary.
- [ ] Tests: no reply within window → `again`; reply during the window → graded normally; lapse during q3/5 leaves q1/q2 graded and q3/q4/q5 marked `again`.

### Empty-pool + status

- [ ] Implement the empty-pool branch in `runSRSession`: select returns [], send "no reviews due today, enjoy lunch", do not persist a session record.
- [ ] Extend `/study status`: pool size, due today, top 5 by `lapse_count`. Format as a compact TG reply.
- [ ] Tests: empty pool, fully reviewed pool, mid-day partial completion.

### Conflict handling

- [ ] Add an in-flight session guard (single-flight per `userId`) in `runSRSession`. Manual `/study` while cron session is active replies "a cron session is in flight — finish it first." Tests cover both directions.

## Phase 3 — Wiki freshness pipeline

> Depends on: Phase 2.

### Frontmatter + backfill

- [ ] Add `status: evergreen | active | stale` to the documented wiki concept frontmatter schema (in `knowledge/wiki/` index/README).
- [ ] Author `scripts/backfill-wiki-status.ts`. Default heuristic: playbook-derived → `evergreen`, articles/world-view-derived → `active`, everything else → `active` (conservative). Writes the field idempotently. Add an `npm run backfill-wiki-status` script.
- [ ] Run the backfill against the live vault; commit the result. Spot-check 5–10 concepts manually.

### `wiki-compiler` updates

- [ ] Update `.claude/agents/wiki-compiler.md` to (a) set `status` on new concept frontmatter using the spec Requirement #2 signals, (b) detect when an existing concept's signals suggest a different status, (c) write a proposal to `knowledge/status-proposals.json` instead of editing the file directly, (d) respect manual overrides (skip proposals for concepts whose `status` was last set by a human edit — detect via git blame or a frontmatter marker).
- [ ] Update the compiler's eval suite with fixtures covering: new evergreen, new active, proposed transition, locked override.

### Status-proposals plumbing

- [ ] Add `src/wiki/status-proposals.ts` exporting `readProposals()`, `appendProposal(p)`, `removeProposal(id)`, `applyProposal(id)`. Coverage with tests.
- [ ] Initialize `knowledge/status-proposals.json` with empty `{ proposals: [] }` if absent.

### `wiki-linter` integration

- [ ] Update `.claude/agents/wiki-linter.md` to read `knowledge/status-proposals.json` and emit a "Pending status proposals" section in the weekly lint output for `/weekly`.
- [ ] Update `src/reviews/interview.ts` (or wherever the weekly outline composes) to surface pending proposals in the outline for Michael's approval. Approved → `applyProposal`; rejected → `removeProposal`.

### Pool source swap

- [ ] Replace the Phase 1 `study/sr-seed.json` lookup in `src/study/sr-pool.ts` with a walker over `knowledge/wiki/concepts/*.md` that reads the `status` frontmatter and filters to `evergreen` ∪ `active`.
- [ ] Migrate any existing SR state for concepts that were in the seed but not yet in the wiki → either reconcile via path or drop with a logged note. Document the migration in `study/index.md`.
- [ ] Retire `study/sr-seed.json`. Remove references in `study/index.md`.

### Documentation

- [ ] Update `CLAUDE.md` Reference System for the new `status` field on wiki concepts (one sentence + pointer).
- [ ] Update `CLAUDE.md` Agents table with the wiki-compiler/linter behavior change (or expand existing rows).
- [ ] Update `docs/projects/index.md` row → "In Progress (Phase 3)" → "Done" once the pool swap is complete and a week of cron sessions runs cleanly.

## Phase 4 — Polish (deferred)

> Do not start unless usage data justifies it. Revisit after 2 months of Phase 3 in production.

- [ ] Lapse hotspot report in `/weekly`: top N concepts by `lapse_count` with their last 3 grades and dates.
- [ ] Graduation rule: 3 consecutive `easy` at the 120d rung graduates a concept out of the active pool into a `graduated` bucket (still in state, never selected unless re-admitted).
- [ ] Revive-stale flow: when a `stale` concept is re-referenced (new raw citation, new journal mention), `wiki-linter` proposes flipping back to `active`.
- [ ] Per-rung distribution in `/study status` if totals turn out to be insufficient.
