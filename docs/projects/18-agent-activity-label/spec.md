# Agent Activity Label — Spec

> Promoted from the `docs/projects/bugs.md` backlog: *"Claude activity" in the cockpit
> nav should be updated to "Agent activity"*. Deliberately minimal: one user-visible
> rename plus a pinning test. This project is also the Project 14 Phase 8 live-acceptance
> target — the first non-fixture orchestrated run drives it end to end.

## Goal

The webview sidebar panel that traces in-flight tool calls is headed **"Claude Activity"**
(`src/server/static/index.html:42`). The panel shows activity from every agent/executor
Jarvis spawns — including non-Claude executors (Codex) — so the label is wrong. Rename it
to **"Agent Activity"**.

## Requirements

1. The sidebar panel heading in `src/server/static/index.html` reads `Agent Activity`
   (the `<h3>` inside `#panel-activity`). No other markup changes.
2. The stale "Claude Activity" wording in the `src/server/static/app.css` comment above
   the `#panel-activity` rules is updated to match the new heading.
3. A test pins the new heading: it reads `src/server/static/index.html` from disk
   (plain `node:fs`, no DOM machinery) and asserts the `Agent Activity` heading is
   present and the old `Claude Activity` heading is gone. Add it to the existing
   webview test file (`src/server/webview.test.ts`) or a small new test file under
   `src/server/` — either is acceptable.

## Assumptions

- **Casing:** the backlog bullet says "Agent activity", but every sibling panel heading
  is Title Case ("Recent Agent Runs", "Ingestion Queue", "Pending Approvals"), so the
  heading uses **"Agent Activity"**. The bug's intent is the Claude→Agent rename, not a
  casing change.
- CSS class names (`.activity-row`, `#panel-activity`, etc.) and element ids are
  internal identifiers, not user-visible copy — they stay unchanged.

## Constraints

- Touch only: `src/server/static/index.html`, the `src/server/static/app.css` comment,
  and one test file. Nothing else.
- The execution worktree may not have `node_modules` installed. Author the test so it
  is correct by inspection; do NOT block on running the full suite or on `npm install`.
  Review gates verify test intent.
- Do not commit — Jarvis owns task closeout.
