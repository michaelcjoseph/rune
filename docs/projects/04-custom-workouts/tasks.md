# Custom Workouts — Tasks

Not started. See [spec.md](spec.md) for details.

## Phase A — Foundation

> Seed data + generator agent + read helpers. No command behavior changes yet. Parallel-safe with other work.

### Vault seed files

- [x] Create `health/equipment.md` in vault with `## Home` and `## Gym` sections. Seed Home from existing `plan.md` equipment lines (adjustable kettlebells, barbell + plates). Gym section can start empty or with a placeholder — hand-fill after next gym visit.
- [x] Create `health/exercises.md` in vault with four sections: `## Preferred`, `## Trying`, `## Benched`, `## Retired`. Seed `Preferred` from exercises that appear ≥ 3× in the last 30 days of `workouts.json`. Each bullet: `- <name> — <short note>` (benched entries include a dated reason).

### Vault read helpers

- [ ] Add `src/vault/equipment.ts` exporting `readEquipment(): { home: string; gym: string }`. Minimal parser — split on `## Home` / `## Gym` headers, return raw block content. Missing file → both sections empty strings.
- [ ] Add `src/vault/whoop-recent.ts` exporting `readRecentWhoopDays(n: number): WhoopDaily[]`. Lists `health/whoop/*.json`, sorts by date desc, returns the last `n`. Empty dir → empty array.
- [ ] Tests for both helpers: happy path, missing file, malformed content, fewer-than-n days available.

### Generator agent

- [ ] Write `.claude/agents/workout-generator.md` with:
  - Description and `triggers:` frontmatter
  - Instructions to read the six inputs (goals, equipment, exercises, recent workouts, recent Whoop, whoop trends) plus optional `plan.md`
  - Four-state exercise semantics (Preferred favor / Trying incorporate / Benched avoid-unless-forced / Retired never)
  - Output-format contract (Warmup / Main / Cooldown sections, sets×reps×load for strength, duration/intensity for endurance, rest guidance, low-recovery note at top if applicable)
  - Best-effort trailing fenced JSON block with `structured` decomposition
- [ ] Add `evals/workout-generator.yaml` with at least one fixture:
  - Input: synthetic `{goals, equipment, exercises, recent_workouts, recent_whoop}` bundle (home + strength focus, low recovery, RDL benched)
  - Assertions: `## Warmup` present, `## Main` present, `## Cooldown` present, no retired exercises, benched RDL either absent or surfaced with its reason, low-recovery note present

## Phase B — Generator command

> Depends on: Phase A complete.

### Command rewrite

- [ ] Replace body of `src/bot/commands/workout.ts`:
  - Parse args: split on whitespace, classify each token as location keyword (`home`/`gym`), focus keyword (`mobility`/`endurance`/`strength`/`speed`/`power`), or extra (appended as natural-language context)
  - Reject unknown tokens that match neither vocabulary — reply with valid options list
  - Build input bundle via `readVaultFile` + `readEquipment()` + `readRecentWhoopDays(7)` + tail of `health/workouts.json` (last 14 days)
  - Invoke `workout-generator` via `runAgent` with the bundle as the prompt
- [ ] Write `logs/last-workout.json` on success: `{generated_at, location, focus, markdown, structured}`
- [ ] Send markdown to TG using the existing chunking client
- [ ] Handle missing-input fallbacks per Requirements #8–#10 (bodyweight-only, no preference bias, Whoop absent note)
- [ ] Tests: arg parsing (both orders, invalid args, natural-language tail), missing-data fallbacks, `last-workout.json` write shape, agent-timeout path preserves no file

### Whoop pre-sync

- [ ] Add `ensureWhoopSyncedForToday()` to `src/jobs/whoop-sync.ts` and export it. Reads `health/whoop/{today}.json`; if missing or `recovery` absent, awaits `executeSleepSync()`. Catches and logs errors — never throws.
- [ ] Call `ensureWhoopSyncedForToday()` from `src/bot/commands/workout.ts` immediately after arg parsing, before building the input bundle for `runAgent`.
- [ ] Tests: pre-sync fires when today's Whoop file is missing; pre-sync fires when file exists but `recovery` field absent; pre-sync is a no-op when today's file has `recovery`; pre-sync failure (mocked sleep-sync throw) is swallowed and generation still completes with recovery-unavailable note.

## Phase C — Logging + wiring

> Depends on: Phase B complete.

### `/done-workout` command

- [ ] Add `src/bot/commands/done-workout.ts`:
  - Read `logs/last-workout.json`; missing → friendly "nothing to log" reply, no writes
  - If `generated_at` > 48h old → warn and require a second invocation within 10 minutes to confirm (simple timestamp compare, no session state)
  - Compose journal block: header line (`#workout\n\n**Generated workout** (<location> / <focus>) — <timestamp>`) followed by the stored `markdown`
  - Append via `appendVaultFile` using today's journal path (from `src/vault/journal.ts`)
  - On success: delete `logs/last-workout.json`
  - On append failure: preserve `logs/last-workout.json`, surface error to user
- [ ] Tests: no-prior-workout path, stale warning + confirm flow, journal format matches what `json-updater` expects (cross-check against `.claude/agents/json-updater.md`), file-cleared-on-success, file-preserved-on-failure

### Handler + registry wiring

- [ ] Register `/done-workout` in `src/bot/handlers/text.ts` alongside `/workout`
- [ ] Add triggers for both commands in `src/bot/skill-registry.ts`:
  - `workout`: "give me a workout", "what should I train today", "I'm at the gym what should I do", "design me a session"
  - `done-workout`: "workout done", "mark workout complete", "log my workout", "I finished my workout"
- [ ] Ensure existing `/workout` plan-reading behavior is fully removed (not gated behind a flag)

### CLI

- [ ] Wire `workout` subcommand in `cli/jarvis.ts`: `npm run cli -- workout [home|gym] [focus]` invokes the same function as the TG handler and prints the markdown
- [ ] Wire `done-workout` subcommand in `cli/jarvis.ts`: `npm run cli -- done-workout` invokes the same function and prints the journal append outcome

### Morning prep cleanup

- [ ] `src/jobs/morning-prep.ts`: drop `workout` field from `MorningData` interface
- [ ] `src/jobs/morning-prep.ts`: remove `gatherWorkout()` function and its call site in `gatherMorningData()`
- [ ] `src/jobs/morning-prep.ts`: remove `### Workout` from the fallback template (around line 82)
- [ ] `src/jobs/morning-prep.ts`: remove `**Today's Workout (${data.dayOfWeek}):**` line and `### Workout` directive from the Claude synthesis prompt
- [ ] `.claude/agents/morning-prep.md`: remove the "Today's Workout" data-source section
- [ ] `.claude/agents/morning-prep.md`: update frontmatter `description` to drop the stale "Whoop" mention and the workout responsibility
- [ ] Test: morning prep output (mock vault) renders all sections except `### Workout`
- [ ] Manual smoke: trigger `/prep` via Telegram on a dev run; confirm output renders correctly without the workout section

### Documentation

- [ ] Update `CLAUDE.md` `Agents` section: add `workout-generator` row under Runtime Agents
- [ ] Update `CLAUDE.md` `Project Structure` section: add `src/bot/commands/done-workout.ts`, `src/vault/equipment.ts`, `src/vault/whoop-recent.ts`
- [ ] Update `docs/projects/index.md`: add `04-custom-workouts` row with appropriate status
