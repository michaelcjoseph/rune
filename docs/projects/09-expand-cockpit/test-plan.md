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
- Ideas before a recognized section heading default to `user-authored`.
- For ideas, valid promotion suffix means `status: done`; no suffix means `status: open`.

## §2 Identity

- Stable for same `(file, line, normalizedRaw)`; changes when any input changes.
- Two items with identical text at different positions have distinct ids.
- Ids are product-local; the Plan API's `:product` segment disambiguates identical bullets in different product repos.

## §3 Reader + security

- Roll-up per product; non-repo-backed flagged.
- Missing/unreadable file → empty + warning, others intact.
- Path canonicalization rejects symlink escapes.
- `repoPath` outside `$WORKSPACE_ROOT` rejected at read time.
- Source paths in API responses are repo-relative and never leak absolute host paths.

## §4 Cockpit + drawer

- Sidebar one-liner with counts; warning count visible.
- Drawer fetches full data; tabs persist; per-item action availability matches view-model.
- Disabled actions show `disabledReason` in tooltip.
- Loop-filed ideas render in their own section with no enabled action; if the disabled Plan action is shown, it carries `disabledReason: loop-filed`.
- Ideas body renders as nested list (no truncation).

## §5 Append

- Bugs and ideas insertion points correct; sentinel-missing fallbacks.
- Typed error responses; per-file mutex; temp-then-rename atomicity.
- Audit log written for every successful mutation.

## §6 Promotion job

- State machine transitions covered.
- Restart replay: a job in `scaffolded` retries mark-source.
- `mark-source-error` retries through `POST /api/promotions/:id/retry`; backoff caps retry attempts at a configurable/test-injectable limit; terminal failure surfaces in `GET /api/promotions/:id`.
- Linked planning abandonment advances `planning-started` to `planning-abandoned`; restart replay does not resume abandoned plans.
- Append-only log; concurrent writes don't tear.
- Promotion storage uses `config.PROMOTIONS_FILE` under `LOGS_DIR` by default, not a separate top-level `state/` directory.

## §7 Scaffold contract

- Agent message with valid `scaffold-result` block → captured.
- Missing block → fall back to repo diff; if exactly one new project dir → captured.
- Block slug disagrees with repo diff → `scaffold-error`.
- No new project dir → `scaffold-error` (this case is already covered by the directory-diff verification in `approve.ts` from commit `a5018e5`; this phase extends it with the JSON-block agreement check).
- Approval resolves the target product's canonical `repoPath` from `policies/products.json`; scaffolding for `aura` writes under Aura's repo, scaffolding for `jarvis` writes under Jarvis, non-repo-backed products are rejected before the setup writer runs, and the setup-writer spawn gets real write access to the target repo rather than only receiving the path in prompt text.
- `filesCreated` entries are repo-relative; absolute paths or paths escaping the target repo fail the scaffold-result validation.

## §8 Mark-done

- Snapshot match wins over line number.
- Bugs: `[ ]` → `[x]` + suffix; `[x]` → idempotent suffix add.
- Ideas: suffix appended once.
- Ambiguous match → typed error, source untouched.
- Byte-equal on all unrelated lines (including sub-bullets and trailing whitespace).

## §9 Plan API

- `POST /api/backlog/:product/items/:id/plan` returns `409 stale-item` when id no longer matches within that product.
- `409 active-planning-session` with `activeSessionId`; cockpit shows resume/abandon dialog.
- `422 item-not-eligible` for loop-filed, done, already-promoted.
- E2E: full chain through to `marked-source`; duplicate mark-source attempts are byte-equal no-ops.

## §10 Automated acceptance

- Tmpdir-backed HTTP/module smoke covers read drawer data, add bug, add idea, Plan, approve with stubbed setup writer, and final `marked-source` without touching real product repos.
- Docs check confirms `docs/projects/ideas.md` contains a promoted `Expand cockpit → 09-expand-cockpit` line.

## §11 Cross-cutting

- All file mutations temp-then-rename and audit-logged.
- Every endpoint validates `product` and `kind`.
- Cockpit view payload size bounded (counts only, not full lists).
- Drawer fetch is per-open, not on every cockpit render.
- Restart between scaffold and mark-source recovers automatically without user action.
