# Custom Workouts Specification

## Overview

Today's `/workout` command is a static read: it opens `health/plan.md` and echoes the weekly prescription for the requested day. It knows nothing about recent workout history, current Whoop recovery/strain, the user's goals, what equipment is actually available, or which exercises are currently preferred vs benched. This project replaces the static prescription with a **dynamically generated daily workout** that consults all of those inputs at invocation time, and closes the loop with a `/done-workout` command that logs the workout back into the journal via the existing `#workout` tag pipeline.

The generator runs as a custom agent (`workout-generator`) that reads a fixed set of vault files, composes a tailored session (warmup → main → cooldown) with explicit sets/reps/load/rest, and returns it as Telegram-renderable markdown. Output is persisted to `logs/last-workout.json` so a follow-up `/done-workout` invocation can log it even after a restart.

### Core Value Proposition

The right workout for today — one that respects current recovery, goals, recent training load, available equipment, and exercise preferences — shows up in Telegram with one command, and logs itself with one more.

### Goals

1. **Primary:** `/workout [home|gym] [mobility|endurance|strength|speed|power]` (and CLI equivalent) returns a one-shot, fully generated workout tailored to goals + recent activity + Whoop recovery + available equipment + exercise preferences.
2. **Secondary:** `/done-workout` appends the generated workout to today's journal with a `#workout` tag so the existing nightly `/daily` → `json-updater` pipeline writes it into `health/workouts.json`.
3. **Tertiary:** A hand-edited `health/exercises.md` with four status bins (Preferred / Trying / Benched / Retired) gives the user a simple place to nudge the generator over time without touching code.
4. **Quaternary:** A hand-edited `health/equipment.md` becomes the source of truth for home vs gym inventory, replacing the equipment lines currently buried inside `plan.md`.

### Non-Goals

- **Replacing `#workout` journal parsing.** The existing daily-review + `json-updater` pipeline already writes `health/workouts.json`. We reuse it — `/done-workout` emits a journal block in a shape that pipeline already handles.
- **Workout tracking app features.** No rep-by-rep tracking, no rest timers, no video demos. Markdown output only.
- **Replacing Whoop.** We consume recovery/strain data; we don't generate it.
- **Multi-turn refinement session.** `/workout` is one-shot. If you don't like the output, run it again with different args. (Revisit in a later project if the re-run pattern is annoying.)
- **Structured JSON output in v1.** The generator emits markdown. Parsing into `workouts.json` is the existing nightly job's responsibility; we don't duplicate its parser.
- **Auto-logging the generated workout as "planned."** The user logs when they're actually done (`/done-workout`), reflecting what they actually did. Keeps "planned" and "performed" from diverging.
- **A `#exercise` tag / nightly parse for exercise-preference updates.** Hand-editing `exercises.md` is the v1 flow. Revisit after ~4 weeks of use.

### Scale considerations

- **Generator call cost:** one agent invocation per `/workout`. ~1× /day typical, 2–3× /day at most. Negligible.
- **Vault file reads:** ~6 small files (goals, equipment, exercises, trends.md, 3–7 Whoop JSONs, last 7–14 workouts.json entries). All local, fast.
- **`last-workout.json`:** single file, overwritten each generation. No rotation needed.
- **No new crons, no new HTTP endpoints, no new MCP tools.**

---

## User Journey

### Happy Path — Generate a workout, do it, log it

```
User sends "/workout gym strength" in TG
         ↓
workout command parses args (location=gym, focus=strength)
         ↓
Reads: health/goals.md, health/equipment.md, health/exercises.md,
       health/workouts.json (last 14 days), health/whoop/*.json (last 7),
       health/whoop/trends.md, optional health/plan.md
         ↓
Invokes workout-generator agent with all inputs
         ↓
Agent returns markdown: warmup → main → cooldown with sets/reps/load/rest
         ↓
Write {generated_at, location, focus, markdown, structured} to
logs/last-workout.json
         ↓
Reply to TG with the markdown
         ↓
[User does the workout, probably at gym]
         ↓
User sends "/done-workout" in TG
         ↓
done-workout reads logs/last-workout.json
         ↓
Appends a #workout-tagged block to today's journal (natural-language summary
+ structured exercise lines the json-updater already parses)
         ↓
Clears logs/last-workout.json
         ↓
Reply: "Logged. Nightly /daily will parse into workouts.json."
         ↓
That night, /daily picks up the #workout tag and the json-updater agent
writes the entry into health/workouts.json — existing pipeline, unchanged.
```

### Happy Path — Smart-default generation with no args

```
User sends "/workout" (no args)
         ↓
Generator infers location from recent workouts (e.g., if last 3 were gym,
assume gym unless Whoop strain/recovery suggests a lighter home mobility
session), and infers focus from:
  - recent workout types in workouts.json (variety rotation)
  - recovery score (low recovery → mobility/endurance bias)
  - days since last strength session (push toward strength if overdue)
         ↓
Same output flow as explicit-args case.
```

### Happy Path — Args in either order

```
"/workout strength gym" and "/workout gym strength" produce the same result.
Location vocabulary: {home, gym}. Focus vocabulary: {mobility, endurance,
strength, speed, power}. Vocabularies don't overlap, so parse order-free.
```

### Entry Points

- **TG slash command**: `/workout` and `/done-workout` via `src/bot/handlers/text.ts`.
- **CLI**: `npm run cli -- workout [home|gym] [focus]` and `npm run cli -- done-workout` via `cli/jarvis.ts`.
- **Resolver**: free-form phrases like "give me a workout", "I'm at the gym what should I do", "workout done", "log my workout" classify to these skills via `src/bot/skill-registry.ts` triggers.

### Exit Points

- Workout markdown posted to TG (or printed to stdout via CLI).
- `logs/last-workout.json` written.
- On `/done-workout`: today's journal appended; `logs/last-workout.json` cleared.

---

## Requirements

### Command surface

1. WHEN `/workout` is invoked with no args THEN the generator picks location and focus automatically from recent history + recovery.
2. WHEN `/workout` is invoked with one or two args from the known vocabularies THEN they are parsed order-independently (`/workout gym strength` ≡ `/workout strength gym`).
3. WHEN an arg is outside the known vocabularies THEN the command replies with a usage line listing valid values and does not invoke the generator.
4. WHEN `/workout` succeeds THEN the full workout markdown is sent to TG (chunked if needed by the existing Telegram client) and persisted to `logs/last-workout.json`.
5. WHEN `/workout` is invoked while a prior `last-workout.json` exists THEN it is overwritten (one active prescription at a time).
6. WHEN the CLI is invoked with the same args THEN behavior is identical to TG, including write to `logs/last-workout.json`.

### Generator inputs

7. WHEN the generator runs THEN it reads `health/goals.md`, `health/equipment.md`, `health/exercises.md`, `health/workouts.json` (last 14 days), `health/whoop/*.json` (last 7 days), `health/whoop/trends.md`, and optionally `health/plan.md`.
8. WHEN `health/equipment.md` is missing or empty THEN the generator falls back to bodyweight-only and notes that in its output.
9. WHEN `health/exercises.md` is missing or empty THEN the generator proceeds with no preference bias — pure goals + equipment + recovery drive selection.
10. WHEN Whoop data is absent (sync failed, auth expired, no JSONs in window) THEN the generator proceeds without it and flags in the output that recovery data was unavailable.
11. WHEN `health/goals.md` is present THEN its content materially shapes focus defaults in the no-args path.

### Exercise-preference semantics

12. WHEN an exercise is in `## Preferred` THEN the generator favors it in main work.
13. WHEN an exercise is in `## Trying` THEN the generator incorporates at least one per session when reasonable.
14. WHEN an exercise is in `## Benched` THEN the generator avoids it unless no equipment-compatible alternative exists; if forced to include, the benched reason is surfaced in the output.
15. WHEN an exercise is in `## Retired` THEN the generator never suggests it.

### Output format

16. WHEN the generator returns THEN the markdown has three sections: `## Warmup`, `## Main`, `## Cooldown`, each as a bulleted list.
17. WHEN a main-work item is strength or power THEN it includes sets × reps and load.
18. WHEN a main-work item is endurance, speed, or mobility THEN it includes duration or distance and intensity/pace guidance.
19. WHEN any exercise has rest-between-sets guidance THEN it is listed on the same bullet.
20. WHEN recovery was low (recovery < 40 or HRV trend materially down) THEN the output includes a one-line recovery note at the top and biases toward lighter work.

### `last-workout.json` persistence

21. WHEN a workout is generated THEN `logs/last-workout.json` is written with `{generated_at, location, focus, markdown, structured}` where `structured` is the agent's best-effort JSON decomposition (may be empty object in v1 if agent opts out).
22. WHEN `logs/last-workout.json` already exists THEN it is overwritten, not appended.
23. WHEN Jarvis restarts between `/workout` and `/done-workout` THEN the file persists and `/done-workout` still works.

### `/done-workout` behavior

24. WHEN `/done-workout` is invoked AND `logs/last-workout.json` exists THEN the file's contents are appended to today's journal in a `#workout`-tagged block that the existing `json-updater` parses.
25. WHEN `/done-workout` is invoked AND `logs/last-workout.json` is missing THEN the user gets a friendly "nothing to log — run `/workout` first" reply and no journal write occurs.
26. WHEN `logs/last-workout.json` is older than 48 hours THEN `/done-workout` warns before logging ("this workout was generated X hours ago — still want to log it?"); a second `/done-workout` call within 10 minutes confirms.
27. WHEN the journal append succeeds THEN `logs/last-workout.json` is deleted.
28. WHEN the journal append fails (filesystem error, permission) THEN `logs/last-workout.json` is preserved so a retry is possible.

### Resolver integration

29. WHEN `workout` and `done-workout` command files are present THEN `src/bot/skill-registry.ts` includes them with descriptive triggers: for `workout` — "give me a workout", "what should I train today", "I'm at the gym"; for `done-workout` — "workout done", "mark workout complete", "log my workout".
30. WHEN the resolver classifies a free-form message to one of these skills with confidence ≥ threshold THEN it is invoked with the message as args (natural-language args are the generator's problem to interpret).

---

## Technical Implementation

### Phase A — Foundation

**New vault files (seed content; hand-edited thereafter):**

- `health/equipment.md` — two `## Home` / `## Gym` sections listing inventory with short notes. Seed from existing lines in `plan.md` (adjustable kettlebells, barbell + plates). Gym section can start with "[fill in after next gym visit]" as a placeholder.
- `health/exercises.md` — four sections: `## Preferred`, `## Trying`, `## Benched`, `## Retired`. Seed Preferred from exercises that appear ≥ 3× in the last 30 days of `workouts.json`. Benched entries carry a dated reason.

**New agent:**

- `.claude/agents/workout-generator.md` — custom agent with read access to the specific vault files listed in Requirement #7. Instruction body:
  - Parse location + focus from the user message (fall back to smart defaults).
  - Consume all inputs; explicitly honor the four-state exercise semantics (#12–#15).
  - Emit markdown per the output format (#16–#20).
  - At the end, emit a fenced JSON block with the `structured` decomposition (best-effort; empty object is OK in v1).

**New vault helpers:**

- `src/vault/equipment.ts` — `readEquipment(): { home: string; gym: string }`. Minimal parser; agent consumes raw markdown, so this can just split on `## Home` / `## Gym` headers.
- `src/vault/whoop-recent.ts` — `readRecentWhoopDays(n: number): WhoopDaily[]`. Reads `health/whoop/*.json` filenames in date-desc order, returns the last `n`. Fills the gap flagged during exploration.

### Phase B — Generator command

**Modified files:**

- `src/bot/commands/workout.ts` — replace the current `plan.md`-reading body:
  - Parse args order-independently (location keywords vs focus keywords have disjoint vocabularies).
  - Build the input bundle via `readVaultFile` + `readEquipment` + `readRecentWhoopDays` + reading `health/workouts.json` tail.
  - Invoke `workout-generator` via `runAgent` with the bundle as the prompt.
  - Write `logs/last-workout.json`.
  - Send result to TG.

**New file:**

- `logs/last-workout.json` — schema `{generated_at: ISO8601, location: "home"|"gym", focus: string, markdown: string, structured: object}`. Already gitignored (`logs/` is).

### Phase C — Logging + wiring

**New file:**

- `src/bot/commands/done-workout.ts` — reads `logs/last-workout.json`, composes a journal block (see below), appends via `appendVaultFile` using `src/vault/journal.ts` helpers, deletes the JSON file on success.

**Journal block shape** (designed to match the existing `json-updater` parser — natural language with a `#workout` tag that the nightly prompt already recognizes):

```
#workout

**Generated workout** (home / strength) — 2026-04-24 18:42

[full markdown body from last-workout.json]
```

Requirement #24 is satisfied: the nightly `/daily` prompt (`src/reviews/daily.ts:42`) already scans for `#workout` and routes to `json-updater`. The `json-updater` agent's instruction (`/Users/michaelcjoseph/workspace/jarvis/.claude/agents/json-updater.md:22`) knows how to turn this into a `workouts.json` entry with `{date, type, duration, exercises[], notes}`. No changes to that pipeline.

**Modified files:**

- `src/bot/handlers/text.ts` — register `/done-workout` (add to the slash dispatch table alongside `/workout`).
- `src/bot/skill-registry.ts` — add resolver triggers for both commands.
- `cli/jarvis.ts` — wire `workout` and `done-workout` CLI subcommands; reuse the same underlying functions as the TG handlers.

### Coordination notes

- **No new cron.** Both commands are user-triggered.
- **No MCP changes.** Generator is an agent invocation, not an MCP tool.
- **Existing `/workout` replacement.** The current `plan.md`-reading behavior is gone. If in the future we want "show me this week's plan", it belongs in a separate `/plan` command.
- **`health/plan.md` status.** Retained as an *optional* input the generator can consult for weekly high-level structure, but no longer the source of truth for daily prescription. Formal deprecation is an open question (see below).

---

## Implementation Phases

### Phase A — Foundation

> Seed data + generator agent. No command behavior changes yet.

- [ ] Create `health/equipment.md` in vault, seeded from existing `plan.md` equipment lines
- [ ] Create `health/exercises.md` in vault with four sections (Preferred / Trying / Benched / Retired), seeded from recent `workouts.json`
- [ ] Write `.claude/agents/workout-generator.md` honoring the four-state preference semantics and output format
- [ ] Add `src/vault/equipment.ts` with `readEquipment()`
- [ ] Add `src/vault/whoop-recent.ts` with `readRecentWhoopDays(n)`
- [ ] Unit tests for both vault helpers
- [ ] Eval fixture: `evals/workout-generator.yaml` with at least one fixture (home + strength, synthetic Whoop/goals/equipment inputs; assert warmup/main/cooldown sections present, no retired exercises, respects benched status)

### Phase B — Generator command

> Depends on: Phase A (agent + helpers + seed files must exist).

- [ ] Replace body of `src/bot/commands/workout.ts` to invoke `workout-generator` via `runAgent`
- [ ] Parse args in any order: location keywords + focus keywords
- [ ] Persist result to `logs/last-workout.json`
- [ ] Handle missing Whoop / equipment / exercises files per Requirements #8–#10
- [ ] Tests: arg parsing (both orders, invalid args), missing-data fallback, `last-workout.json` write shape

### Phase C — Logging + wiring

> Depends on: Phase B.

- [ ] Add `src/bot/commands/done-workout.ts`
- [ ] Register command in `src/bot/handlers/text.ts`
- [ ] Add resolver triggers in `src/bot/skill-registry.ts` for both commands
- [ ] Wire both commands into `cli/jarvis.ts`
- [ ] Tests: `/done-workout` with / without prior `/workout`, 48-hour stale warning + confirmation, journal append format, `logs/last-workout.json` cleared on success / preserved on failure
- [ ] Update `CLAUDE.md` `Agents` section with `workout-generator`
- [ ] Update `CLAUDE.md` `Project Structure` section with new files
- [ ] Update `docs/projects/index.md` status for this project

---

## Edge Cases & Error Handling

### Generator

- **All vault inputs missing** (fresh setup, empty health dir): reply with a one-liner pointing the user at the files to create. Don't generate a fake workout.
- **Conflicting inputs** (e.g., goals say "build strength" but Whoop recovery is 20): the recovery signal wins; output includes a note that today's session is lighter than usual because of recovery.
- **Agent invocation times out**: surface the error message to TG, leave `logs/last-workout.json` untouched.
- **Agent output malformed** (no Warmup/Main/Cooldown sections): fall back to returning the raw agent output with a warning header — don't swallow content.

### `/done-workout`

- **`logs/last-workout.json` corrupt JSON**: reply with the parse error; don't attempt a partial journal write.
- **Today's journal file doesn't exist yet**: `appendVaultFile` / journal helpers create it (existing behavior).
- **Two `/done-workout` calls in quick succession**: the first succeeds and deletes the file; the second sees a missing file and gets the "nothing to log" reply. Idempotent from the user's perspective.

### Args

- **Both location args passed** (`/workout home gym`): take the last one, note in reply.
- **Unknown focus arg** (`/workout cardio`): reply with valid focus list. Don't silently map to a near-match.
- **Extra args beyond two**: treat the third+ as natural-language context appended to the agent prompt (allows things like `/workout home 30min quick hit`).

### Exercise preferences

- **Benched exercise is the only equipment-compatible option** (e.g., you benched RDLs but the only posterior-chain option at home is a KB-RDL variant): generator includes the RDL variant with a one-line note citing the benched reason, so the user can swap or proceed mindfully.
- **Exercises.md has duplicate entries across sections** (e.g., same exercise in Preferred and Benched): treat the Benched entry as authoritative (safer default); surface the conflict in the generator output so the user fixes the file.
- **Every single main-work candidate is retired or benched**: generator falls back to goals-and-equipment-driven selection, ignoring preferences; output includes a one-line note explaining why.

### Resolver

- **Resolver routes `/workout` to the generator with unusual natural-language args** (e.g., "give me something light for my knees"): args are passed to the agent; agent is responsible for reading the freeform intent. Don't try to normalize in code.

---

## Open Questions

- [ ] Should `health/plan.md` be formally deprecated, or retained as an optional "weekly-template" input the generator may consult? Revisit after a few weeks of generator use.
- [ ] Should `/done-workout` accept an inline notes tail (e.g., `/done-workout skipped last set, knee tweak`) that's appended to the journal block? Defer to v1.1.
- [ ] Is hand-editing `health/exercises.md` low-friction enough long term, or will we want an `#exercise` journal tag + nightly parse (à la `#workout` / `#book`)? Revisit after ~4 weeks of use.
- [ ] Should the generator return a structured JSON block for future analytics (tracking tonnage, volume, etc.), or stay pure markdown with nightly parsing handling structure? v1 asks the agent for best-effort JSON but doesn't depend on it.
- [ ] Should two `/workout` invocations in rapid succession warn before overwriting the prior `last-workout.json`? Not in v1 — the cost of overwrite is just "re-issue `/done-workout` after the workout you actually did."
