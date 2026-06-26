# Phase 6 — Validation & Diagnosis Write-up

> Closes the spec's Phase 6 "write up the original silent-failure root cause"
> task. Sources: validation run `7b8410fb-669f-4ded-97a8-997ec3bbbfc3`
> (project 10, 2026-06-01), its `summary.json` + `transcript.jsonl`, and a
> code read of the live-display path.

## The validation run

On 2026-06-01 a Work run was dispatched from the cockpit against
`10-rune-identity-refactor` (run `7b8410fb`, branch `rune-work/7b8410fb`,
base `84d3ca5`). It ran 428s and classified:

```
outcome: noop
reason:  "no commits, no task transitions, clean tree"
workProduct: { commitCount: 0, tasksNewlyChecked: 0, tasksRemaining: 59, dirty: false }
```

**The instrumentation worked.** This is exactly the silent failure the project
was built to catch: a clean `exitCode: 0` that produced nothing. Under the old
code it would have reported `finished in 428s` as a success. Instead it was
correctly classified `noop`, the transcript (326 events), `summary.json`,
forensics (`bundle.git`), and the `index.jsonl` row were all persisted, and the
no-op alert fired. The core taxonomy + durability goals are validated on the
empty-run half.

## Root cause of the silent runs (the original 2026-05-30 failures)

The transcript explains *why* the run did nothing. The agent did the analysis,
then every mutation was refused by the harness permission gate. From its own
final turn:

> The Edit to `tasks.md` is being blocked by the permission gate (twice now),
> and the same gate blocked `npm`/`npx`/`git` mutations for both me and the
> test-specialist subagent ... that's an environmental block, not a
> task-logic problem.

The work-product facts corroborate: zero commits, zero task transitions, clean
tree. The agent could not `Edit`, could not `git commit`, could not run
`vitest` — so a clean exit with no work product was the only possible end
state. This is the same structural signature as the original `7828477a` /
`3b002b26` silent runs.

**This is a `/work` / sandbox problem, not a project-11 problem.** Project 11's
job was to make the no-op *visible and reconstructable* — it did. The fix for
the gate that blocks `--auto` mutations is a separate follow-on, filed in
`docs/projects/bugs.md`.

## Two observability gaps found during validation

Validating the run surfaced two defects in the *live* path (the durable
post-run path is fine). The cockpit right-side panel was **entirely blank**
during the run.

### Gap #1 — the display adapter drops error tool_results

`streamJsonToDisplay` (`src/jobs/work-run-transcript.ts:154`) converts only
`assistant` text, `assistant` `tool_use`, and `result` envelopes. The
`default` branch (`:184`) returns `null` for everything else, and the code is
explicit that `user`/`tool_result` frames "render nothing in the drawer"
(`:181`).

A permission-gate denial *is* a `tool_result` with `is_error: true`, arriving
as a `user` envelope. So the one signal that explains the no-op — writes were
refused — never becomes a display line in the card, drawer, or the
transcript-tail `lastOutput`. It survives only in the raw `transcript.jsonl`.

### Gap #2 — the cockpit projection only ever sees finished runs

`readWorkRunProjections` (`src/server/work-run-projection.ts:99`) is driven
entirely off `readRecentIndex(index.jsonl)`. Per spec req 15 the index row and
`summary.json` are written **only at termination**. So while a run is live
there is no index row for it, the projection has no entry for that project's
card, and the panel is blank until the run ends.

The live data exists the whole time — `lastOutput` reads the live
`transcript.jsonl` tail (`:128`) — but it is gated behind an index that doesn't
list the run until it's over. This directly violates spec req 24 ("WHEN a run
is active THEN the card shows the last N lines of output and elapsed"). Active
runs were never wired in; they must be merged into the projection from the
in-memory supervision store (`activeRuns` / `SupervisedRun`, which already
holds the ring buffer and `startedAt`), layered over the terminal index rows.

## Follow-ons filed

- **Fixes #1 + #2** — Phase 6 follow-on tasks in `tasks.md` (test-first).
- **`/work` permission gate blocks `--auto` mutations** — `docs/projects/bugs.md`.
