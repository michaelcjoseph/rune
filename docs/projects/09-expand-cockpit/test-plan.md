# Expand Cockpit — Test Plan

Error handling and behavior coverage for the backlog → planning flow.

> See also: cross-cutting jarvis test conventions in
> [`../templates/test-plan.md`](../templates/test-plan.md).

## §1 Parser

- Accepted forms round-trip exactly.
- Each rejected form produces a typed warning (`tab-indent`, `bad-bullet-glyph`, `numbered-list`, `nested-deeper-than-2`, `non-matching-line`, `bad-promotion-marker`).
- CRLF and no-final-newline tolerated.
- Strict slug regex: `→ foo-bar` (no digits) → NOT promoted; `→ 09-foo` → promoted; `→ 9-foo` → NOT promoted.
- Sub-bullet across blank line does NOT attach.

## §2 Identity

- Stable for same `(file, line, normalizedRaw)`; changes when any input changes.
- Two items with identical text at different positions have distinct ids.

## §3 Reader + security

- Roll-up per product; non-repo-backed flagged.
- Missing/unreadable file → empty + warning, others intact.
- Path canonicalization rejects symlink escapes.
- `repoPath` outside `$WORKSPACE_ROOT` rejected at read time.

## §4 Cockpit + drawer

- Sidebar one-liner with counts; warning count visible.
- Drawer fetches full data; tabs persist; per-item action availability matches view-model.
- Disabled actions show `disabledReason` in tooltip.
- Loop-filed ideas in their own section, no action button.
- Ideas body renders as nested list (no truncation).

## §5 Append

- Bugs and ideas insertion points correct; sentinel-missing fallbacks.
- Typed error responses; per-file mutex; temp-then-rename atomicity.
- Audit log written for every successful mutation.

## §6 Promotion job

- State machine transitions covered.
- Restart replay: a job in `scaffolded` retries mark-source.
- Backoff caps retry attempts at a configurable limit; terminal failure surfaces in `GET /api/promotions/:id`.
- Append-only log; concurrent writes don't tear.

## §7 Scaffold contract

- Agent message with valid `scaffold-result` block → captured.
- Missing block → fall back to repo diff; if exactly one new project dir → captured.
- Block slug disagrees with repo diff → `scaffold-error`.
- No new project dir → `scaffold-error` (this case is already covered by the directory-diff verification in `approve.ts` from commit `a5018e5`; this phase extends it with the JSON-block agreement check).

## §8 Mark-done

- Snapshot match wins over line number.
- Bugs: `[ ]` → `[x]` + suffix; `[x]` → idempotent suffix add.
- Ideas: suffix appended once.
- Ambiguous match → typed error, source untouched.
- Byte-equal on all unrelated lines (including sub-bullets and trailing whitespace).

## §9 Plan API

- `409 stale-item` when id no longer matches.
- `409 active-planning-session` with `activeSessionId`; cockpit shows resume/abandon dialog.
- `422 item-not-eligible` for loop-filed, done, already-promoted.
- E2E: full chain through to `marked-source`; `/approve` idempotent.

## §10 Cross-cutting

- All file mutations temp-then-rename and audit-logged.
- Every endpoint validates `product` and `kind`.
- Cockpit view payload size bounded (counts only, not full lists).
- Drawer fetch is per-open, not on every cockpit render.
- Restart between scaffold and mark-source recovers automatically without user action.
