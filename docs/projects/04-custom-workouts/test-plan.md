# Custom Workouts Test Plan

Error handling checklist for the generator, `/workout` command, `/done-workout` command, exercise-preference handling, and resolver routing.

> See also: existing tests in `src/bot/handlers/text.test.ts`, `src/jobs/nightly.test.ts` (for `#workout` tag parsing), `src/reviews/daily.test.ts`.

## Priority Levels

- 🔴 **Critical**: Blocks the loop — command fails silently, journal write corrupts, existing pipeline breaks.
- 🟡 **High**: Degrades the workflow — wrong workout shape, missed preferences, stale-state bugs.
- 🟢 **Low**: Cosmetic or rare — log formatting, edge-case arg handling.

## 1. `/workout` command (Phase B)

### Arg parsing

- [ ] 🔴 `/workout` with no args invokes the generator with smart defaults (no error)
- [ ] 🔴 `/workout gym strength` parses to `{location: gym, focus: strength}`
- [ ] 🔴 `/workout strength gym` parses to the same result (order-independent)
- [ ] 🟡 `/workout home mobility` and `/workout mobility home` both parse correctly
- [ ] 🟡 `/workout cardio` (unknown focus) replies with valid focus list and does NOT invoke the generator
- [ ] 🟡 `/workout foo` (unknown token, not a location or focus) replies with usage hint and does NOT invoke the generator
- [ ] 🟡 `/workout home gym` (two locations) uses the last one and notes the disambiguation in reply
- [ ] 🟢 Extra tokens beyond location + focus are appended as natural-language context (e.g., `/workout home 30min quick` passes `30min quick` to the agent)

### Generation

- [ ] 🔴 Generator returns markdown with `## Warmup`, `## Main`, `## Cooldown` sections
- [ ] 🔴 Generator call is a single `runAgent("workout-generator", ...)` invocation; no MCP, no multi-turn
- [ ] 🔴 Successful generation writes `logs/last-workout.json` with `{generated_at, location, focus, markdown, structured}`
- [ ] 🟡 Strength / power exercises in output include sets × reps × load
- [ ] 🟡 Endurance / speed / mobility items include duration or distance and intensity guidance
- [ ] 🟡 Rest-between-sets guidance appears on relevant bullets
- [ ] 🟡 Low recovery (score < 40 or HRV trend materially down in recent Whoop data) produces a one-line note at the top of the output and biases toward lighter work
- [ ] 🟢 Agent `structured` JSON block, if present, is valid JSON (or absent — both acceptable in v1)

### Fallbacks

- [ ] 🔴 `health/equipment.md` missing → generator falls back to bodyweight-only; output includes a note
- [ ] 🔴 `health/exercises.md` missing → generator proceeds without preference bias; no error
- [ ] 🔴 No Whoop JSONs in window → generator proceeds without recovery data; output notes it
- [ ] 🟡 `health/goals.md` missing → generator still runs (goals are one input among many)
- [ ] 🟡 `health/workouts.json` missing or empty → generator runs, no recent-history bias
- [ ] 🟡 All vault inputs missing → user gets a pointed "create these files first" message, no fake workout
- [ ] 🟢 Agent timeout → error surfaced to TG, `logs/last-workout.json` unchanged

### Persistence

- [ ] 🔴 Two successive `/workout` calls → second overwrites the first in `logs/last-workout.json`
- [ ] 🔴 Jarvis restarts between `/workout` and `/done-workout` → `logs/last-workout.json` persists, `/done-workout` still works
- [ ] 🟢 `logs/last-workout.json` is gitignored (`logs/` already is)

## 2. Exercise-preference handling (generator agent)

- [ ] 🔴 Preferred exercises show up more often than non-preferred across 5 generations (sanity check, not a strict ratio)
- [ ] 🔴 Retired exercises NEVER appear in generated output
- [ ] 🟡 Benched exercises appear only when no equipment-compatible alternative exists; when they do, the output cites the benched reason
- [ ] 🟡 At least one `## Trying` exercise shows up per generation when the section is non-empty
- [ ] 🟡 Duplicate entries across sections (same exercise in Preferred and Benched): generator treats Benched as authoritative and flags the conflict in output
- [ ] 🟢 Empty `## Preferred` / `## Trying` sections: no crash, no bias, output reads clean

## 3. `/done-workout` command (Phase C)

### Happy path

- [ ] 🔴 `/done-workout` after `/workout` appends a `#workout` block to today's journal
- [ ] 🔴 Appended block shape: `#workout\n\n**Generated workout** (<location> / <focus>) — <timestamp>\n\n<markdown>` — matches what `json-updater` already parses
- [ ] 🔴 After successful append, `logs/last-workout.json` is deleted
- [ ] 🔴 Nightly `/daily` (already wired) parses the appended block into `health/workouts.json` via `json-updater` — unchanged existing pipeline
- [ ] 🟡 Today's journal file doesn't exist yet → helpers create it (existing behavior; no regression)

### Error cases

- [ ] 🔴 `/done-workout` with no prior `/workout` → friendly "nothing to log — run `/workout` first" reply; no journal writes
- [ ] 🔴 `logs/last-workout.json` corrupt JSON → parse error surfaced to user; no journal writes; file preserved
- [ ] 🟡 `logs/last-workout.json` older than 48h → warning reply; `logs/last-workout.json` NOT cleared yet; second `/done-workout` within 10 minutes confirms and logs
- [ ] 🟡 Journal append fails (filesystem error) → `logs/last-workout.json` preserved so retry is possible
- [ ] 🟢 Two `/done-workout` calls in quick succession → first logs, second sees missing file and replies idempotently

## 4. Resolver integration (Phase C)

- [ ] 🔴 "give me a workout" routes to `/workout` with confidence ≥ threshold
- [ ] 🔴 "workout done" routes to `/done-workout` with confidence ≥ threshold
- [ ] 🟡 "I'm at the gym what should I do" routes to `/workout` and passes "at the gym" as context the generator can use
- [ ] 🟡 "log my workout" routes to `/done-workout`
- [ ] 🟡 Ambiguous / low-confidence messages (e.g., "how was today") don't auto-route to workout skills
- [ ] 🟢 Triggers for both commands are present in `src/bot/skill-registry.ts` and surface in registry output

## 5. CLI parity (Phase C)

- [ ] 🔴 `npm run cli -- workout` invokes the same function as TG; writes `logs/last-workout.json`; prints markdown
- [ ] 🔴 `npm run cli -- workout gym strength` honors args identically to TG
- [ ] 🔴 `npm run cli -- done-workout` invokes the same function as TG; appends to today's journal; clears `logs/last-workout.json`
- [ ] 🟡 CLI and TG produce identical generator output given identical vault state (modulo Haiku non-determinism — accepted)
- [ ] 🟢 CLI unknown-arg behavior matches TG (usage hint, no invocation)

## 6. Integration with existing pipeline

- [ ] 🔴 `json-updater` successfully parses a `/done-workout`-authored journal block into `workouts.json` without changes to the agent
- [ ] 🔴 `src/reviews/daily.ts` prompt (line 42) recognizes `#workout` in the appended block — existing behavior, confirm no regression
- [ ] 🔴 All existing Jarvis tests pass after each phase ships
- [ ] 🟡 Weekly review's health-related prep (if any) reads `workouts.json` correctly with generator-authored entries mixed in with hand-logged ones
- [ ] 🟡 `health/plan.md` is no longer read by the command (retired from that role) — no stale reference in the codebase
- [ ] 🟢 Morning prep is unaffected (does not invoke workout generation)
