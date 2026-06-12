# Project Context: Agent Activity Label

> Orchestration state for the `jarvis` project "Agent Activity Label".
> Owned by Jarvis's context curator — roles read a bounded slice and emit handoff
> notes; they do not author this file directly.

## Current State

Planning complete; no tasks executed yet. The sidebar panel heading at
`src/server/static/index.html:42` still reads "Claude Activity".

## Key Decisions

- Heading casing is Title Case ("Agent Activity") for consistency with sibling panel
  headings — the backlog bullet's lowercase "Agent activity" is treated as intent, not
  exact copy.

## Interfaces & Contracts

- `src/server/static/index.html` — `#panel-activity` section; only the `<h3>` text
  changes. Element ids and CSS classes are stable identifiers consumed by
  `src/server/static/app.js` and `app.css`; they must not change.

## Known Risks

- The execution worktree may lack `node_modules`; tests must be authored statically
  and not depend on a successful `npm install`.

## Next Task Handoff

First task: rename the heading in `index.html`, update the `app.css` comment wording,
and add a static fs-based test pinning "Agent Activity" present / "Claude Activity"
absent. Touch nothing else.
