# Spaced Repetition Study Test Plan

Error-handling and behavior checklist for the syllabus rename, the SR state engine, the `sr-question-generator` and `sr-grader` agents, the daily cron + session semantics, and the wiki `status` proposal pipeline.

> See also: existing tests in `src/bot/handlers/text.test.ts`, `src/bot/skill-registry.test.ts`, `src/jobs/*` test files, and the eval framework under `evals/`.

## Priority Levels

- 🔴 **Critical**: Blocks the loop — wrong selection, lost state, agent crash, the rename breaks `#study` routing.
- 🟡 **High**: Degrades the workflow — bad questions, wrong grades, silent skips, missed proposal approvals.
- 🟢 **Low**: Cosmetic or rare — message formatting, edge-case logging.

## 1. Syllabus rename (Phase 1)

### Command + handler routing

- [ ] 🔴 `/syllabus` invokes the previous `/study` handler logic with identical behavior (progress summary, current assignments, overdue).
- [ ] 🔴 `/syllabus add <book>` (and any other previously-supported subcommands) routes correctly.
- [ ] 🔴 `/study` no longer routes to the syllabus handler. Sending `/study` invokes the new SR session command.
- [ ] 🟡 `/help` lists `/syllabus` (not `/study`) for the syllabus-tracking surface, and `/study` for SR.
- [ ] 🟡 `#study` tag in journals still routes to `study/progress.json` via the nightly `/daily` → `json-updater` pipeline (no behavior change beyond the command rename).
- [ ] 🟢 Resolver does not double-match "study" free-text to both `/study` and `/syllabus`.

### Docs cleanup

- [ ] 🔴 `CLAUDE.md` § Reference System: `#study` description updated to reference the renamed command path.
- [ ] 🔴 `CLAUDE.md` § Claude Code Commands: `/syllabus` and new `/study` rows both present and distinct.
- [ ] 🟡 `study/index.md` describes both `study/progress.json` and `study/spaced-repetition.json` and points each at the correct command.
- [ ] 🟡 `grep -r "/study" docs/ CLAUDE.md study/` shows no orphaned references to the old behavior.

## 2. SR state engine (Phase 1)

### `advanceRung` ladder

- [ ] 🔴 `good` advances one rung: `1d → 3d → 7d → 14d → 30d → 60d → 120d`. Cap holds at `120d`.
- [ ] 🔴 `easy` on first pass at a rung advances two rungs (e.g., `1d → 7d`). At the cap, holds at `120d`.
- [ ] 🔴 `easy` on a repeat pass at the same rung advances one rung (same as `good`).
- [ ] 🔴 `hard` keeps `current_rung` unchanged; `next_due` advances by the current rung's interval.
- [ ] 🔴 `again` resets `current_rung` to `1d` and increments `lapse_count`.
- [ ] 🔴 Every grade updates `last_reviewed` to today, increments `review_count`, sets `last_grade`, and appends to `last_questions` (cap at 3, oldest dropped).
- [ ] 🟡 Out-of-range grade strings (e.g., "ok") throw a typed error; state file untouched.
- [ ] 🟡 Concept missing from state on grade call → state engine seeds it (admit on first interaction), logs a warning.
- [ ] 🟢 State file write is atomic (write to temp + rename), tolerates a crash mid-write.

### `selectDueConcepts`

- [ ] 🔴 Returns only concepts with `next_due ≤ today`.
- [ ] 🔴 Sorts by most-overdue first; ties broken randomly with a stable seed for testability.
- [ ] 🔴 Caps at the requested N; never returns more.
- [ ] 🟡 With pool of size M < cap, returns all M and does not throw.
- [ ] 🟡 With empty pool, returns `[]`.
- [ ] 🟢 Concepts on disk but missing from state are treated as `next_due = admitted_date + 1d` for the first selection.

### `sr-pool` (Phase 1 seed source)

- [ ] 🔴 Reads `study/sr-seed.json`, returns paths that still exist on disk.
- [ ] 🟡 Path in seed but file missing → log a warning, exclude from pool.
- [ ] 🟡 Empty / missing `study/sr-seed.json` → pool is `[]`, `/study` replies "no concepts in the SR pool yet".

## 3. Agents (Phase 1)

### `sr-question-generator`

- [ ] 🔴 Produces a single open-ended question (≤ 200 chars) for a content-rich concept.
- [ ] 🔴 Question requires mechanism/reasoning/application — not "what is X?".
- [ ] 🔴 With `last_questions` containing 3 prior texts, the new question differs from each (case-insensitive trimmed compare).
- [ ] 🔴 For a content-thin concept, returns a structured `{ skip: true, reason }` signal.
- [ ] 🟡 Returns valid JSON (or whatever structured output contract we settle on) on every call; malformed output triggers one retry, then skip.
- [ ] 🟡 Eval fixtures in `evals/sr-question-generator.yaml` pass before any change merges.
- [ ] 🟢 Long concept bodies (> 4k tokens) are truncated to a reasonable window without breaking the rubric.

### `sr-grader`

- [ ] 🔴 Returns `{ grade, core_points, missed_points, explanation }` for every call.
- [ ] 🔴 `core_points` has 2–4 entries identified before grading.
- [ ] 🔴 Grade boundaries match Requirements #25–#28 (easy / good / hard / again).
- [ ] 🔴 When grade < `good`, `missed_points` is non-empty and `explanation` references specific points (not generic "you missed some").
- [ ] 🟡 When grade ≥ `good`, the explanation is short and includes the concept's wikilink.
- [ ] 🟡 Eval fixtures in `evals/sr-grader.yaml` cover all four grades and pass.
- [ ] 🟡 Malformed grader output → one retry; second failure defaults to `hard` with a flagged explanation, persists for review.
- [ ] 🟢 Grader does not penalize for wording — only for missing core points.

## 4. Session orchestrator + `/study` command (Phase 1)

### Arg parsing

- [ ] 🔴 `/study` (no args) runs a 5-question session.
- [ ] 🔴 `/study 3` runs a 3-question session.
- [ ] 🔴 `/study 12` clamps to 10 and replies with the clamp note.
- [ ] 🔴 `/study 0` and `/study -1` clamp to 1 and reply with the clamp note.
- [ ] 🟡 `/study status` returns pool size, due today, and (Phase 2+) lapse hotspots.
- [ ] 🟡 `/study foo` (unrecognized arg) replies with usage and does not crash.

### Session loop

- [ ] 🔴 Each question is sent to TG with the format `"q<i> of <N>: <question>"`.
- [ ] 🔴 Michael's reply is graded against the originating concept's content, not a different concept's.
- [ ] 🔴 After each grade, the response reveals the concept wikilink and (if grade < `good`) the missed points.
- [ ] 🔴 SR state is persisted after each concept, not only at session end (crash-safety).
- [ ] 🟡 End-of-session summary line has grade counts (e.g., "2 good, 2 hard, 1 again") and the total.
- [ ] 🟡 Skip from `sr-question-generator` causes the orchestrator to pick the next due concept, capped to the original N target.
- [ ] 🟢 If the pool can't fill N (fewer concepts due than N), session runs with the available count and reports it ("ran 3 of 5 requested — only 3 due").

### CLI parity

- [ ] 🔴 `npm run cli -- study 3` produces the same session loop in the terminal (prompts via stdin, prints grades/summary).
- [ ] 🟡 CLI session writes to `study/spaced-repetition.json` exactly like the TG flow.

## 5. Daily cron + session semantics (Phase 2)

### Cron entry

- [ ] 🔴 `runDailySR` fires at 12:00 CT (verified against the cron registration surface).
- [ ] 🔴 Empty pool branch: TG receives one line, no session is created, no state mutation.
- [ ] 🔴 Non-empty pool branch: cron triggers a session with cap 5.
- [ ] 🟡 Cron failure (e.g., session orchestrator throws) is logged + surfaced in the nightly-style summary; does not silently swallow.
- [ ] 🟢 Cron skips on days where another in-flight session already exists.

### 30-minute timeout

- [ ] 🔴 No reply for 30 minutes → current question's concept marked `again`; remaining unasked concepts are also marked `again`; already-graded concepts retain their grades.
- [ ] 🔴 Reply at minute 29 → graded normally.
- [ ] 🔴 Reply at minute 31 → ignored for SR state; lapse summary already sent.
- [ ] 🟡 Lapse summary is a single TG message with grade counts and an indication of where the session lapsed (e.g., "lapsed at q3/5").
- [ ] 🟡 Partial state is persisted before the lapse summary fires.
- [ ] 🟢 No nudges sent during the 30-minute window (Requirement #33).

### Conflict handling

- [ ] 🔴 Manual `/study` while a cron session is in flight → reject with "a cron session is in flight — finish it first."
- [ ] 🔴 Cron firing while a manual session is in flight → cron logs the conflict and skips. Does not enqueue a duplicate session.
- [ ] 🟡 `/study status` is callable any time, including mid-session, and reports correctly.

## 6. Wiki `status` pipeline (Phase 3)

### Frontmatter + backfill

- [ ] 🔴 `scripts/backfill-wiki-status.ts` writes `status` idempotently to every `knowledge/wiki/concepts/*.md`.
- [ ] 🔴 Re-running the backfill does not flip already-set values (idempotent for the conservative defaults).
- [ ] 🟡 Backfill script logs a per-file decision summary (counts of evergreen / active / stale).
- [ ] 🟢 Backfill runs cleanly on an empty `knowledge/wiki/concepts/` directory (no-op).

### `wiki-compiler` proposals

- [ ] 🔴 New concept compiled → frontmatter includes `status` set by the inference rules in Requirement #2.
- [ ] 🔴 Existing concept whose signals suggest a different status → proposal appended to `knowledge/status-proposals.json`; concept file unchanged.
- [ ] 🔴 Existing concept whose status is locked (manually set) → no proposal generated.
- [ ] 🟡 Compiler runs against a concept with content too thin to infer signals → defaults to `active` and notes the uncertainty in compile logs.
- [ ] 🟡 Proposals accumulate across nightly runs without duplicates (de-dupe on `concept_path` + `proposed_status`).
- [ ] 🟢 Proposals JSON file is created on first proposal if absent.

### `wiki-linter` + `/weekly` flow

- [ ] 🔴 `wiki-linter` surfaces pending proposals as a "Pending status proposals" section in the weekly lint output.
- [ ] 🔴 `/weekly` outline includes pending proposals for Michael's approval.
- [ ] 🔴 Approved proposal → concept frontmatter `status` updated; proposal removed from queue.
- [ ] 🔴 Rejected proposal → proposal removed; concept untouched.
- [ ] 🟡 Bulk approve / reject works for > 10 proposals without losing entries.
- [ ] 🟡 Approval applied but concept file edited concurrently → updater only touches the `status` frontmatter key.

### Pool swap

- [ ] 🔴 After Phase 3 swap, `readPool()` returns every concept whose frontmatter `status` is `evergreen` or `active`.
- [ ] 🔴 Concepts marked `stale` are excluded from selection but their SR state is preserved on disk.
- [ ] 🔴 Concept flipped back from `stale` → `active` rejoins the pool with preserved state, surfacing immediately if its `next_due` is already past.
- [ ] 🟡 SR state for concepts in `study/spaced-repetition.json` that no longer exist on disk → flagged in `meta` for cleanup at next session boundary, not dropped silently.

## 7. Integration

- [ ] 🔴 Phase 1 → Phase 2 transition: existing SR state survives the addition of the cron + timeout (no schema change required by Phase 2 alone).
- [ ] 🔴 Phase 2 → Phase 3 transition: existing SR state survives the pool source swap; concepts in the seed but not in the wiki are migrated or logged.
- [ ] 🔴 `/study` and `/syllabus` coexist without resolver conflicts in free-text inputs ("quiz me on X" vs "what's my study progress").
- [ ] 🟡 `/daily` continues to process `#study` tags through the renamed `/syllabus` path with no behavior change.
- [ ] 🟡 `/weekly` outline + post-agent flow accepts the new "status proposals" section without breaking existing sections (memories, work, learning, reflection, health).
- [ ] 🟢 Nothing in the morning prep, nightly, or any other cron references the SR system directly — the 12:00 CT cron is the only entry point besides slash commands.

## 8. Resilience

- [ ] 🔴 Agent failure (generator or grader returns malformed output twice) → orchestrator falls back per spec Edge Cases; session does not abort entirely.
- [ ] 🔴 TG send failure mid-session → state persists with an `incomplete: true` marker; next session resumes correctly.
- [ ] 🟡 State file corruption (e.g., truncated JSON) → state engine fails fast with a clear error; does not overwrite the corrupt file with empty state.
- [ ] 🟡 Cron firing during a planned outage (e.g., network down) → logs the failure, does not retry within the same day.
- [ ] 🟢 Disk write failure on state persist → orchestrator surfaces the error and keeps the in-memory state until a manual recovery.
