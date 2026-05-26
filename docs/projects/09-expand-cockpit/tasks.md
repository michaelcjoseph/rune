# Expand Cockpit — Tasks

Not started. See [spec.md](spec.md) for details.

Test commit lands before any implementation code per phase.

## Phase 1 — Reader + parser

**Tests (write first)**

- [ ] `backlog-parser.test.ts` — all accepted forms; all rejected forms produce typed warnings; CRLF and no-final-newline files; Unicode in bullet text; the strict slug suffix regex; ideas sub-bullet attachment across blank line (does NOT attach); sectioning before any heading defaults `user-authored`.
- [ ] `backlog-id.test.ts` — same line at same position → same id; line edit → different id; same line at different position → different id.
- [ ] `backlog-reader.test.ts` — registry roll-up; non-repo-backed → `not-repo-backed` flag; missing file → empty + no error; unreadable file → empty + file warning surfaces; symlink/path-escape rejection.

**Build**

- [ ] `src/intent/backlog-parser.ts` — `parseBugs`, `parseIdeas`, returning `{ items, fileWarnings }`.
- [ ] `src/intent/backlog-id.ts` — deterministic id helper.
- [ ] `src/intent/backlog-reader.ts` — `readBacklogs(registry, productsConfig)` with security checks.
- [ ] Extend `CockpitProduct` with optional `backlogCounts`.

## Phase 2 — Drawer + sidebar count line

> Depends on: Phase 1

**Tests (write first)**

- [ ] `cockpit-backlog-counts.test.ts` — sidebar one-liner reflects counts and warning count; clicking opens drawer; non-repo-backed product → drawer shows `not repo-backed`.
- [ ] `backlog-drawer.test.ts` — `GET /api/backlog/:product` returns parsed items + warnings; drawer renders Bugs/Ideas tabs; tab persists; disabled actions show tooltip with `disabledReason`; ideas body renders as nested list; source-file link constructed correctly.

**Build**

- [ ] `GET /api/backlog/:product` in `src/server/webview.ts`.
- [ ] New drawer HTML/JS/CSS in `index.html` / `app.js` / `app.css` (modeled on existing `mutation-drawer`).
- [ ] Sidebar one-liner replaces the placeholder sub-section.

## Phase 3 — Add

> Depends on: Phase 2

**Tests (write first)**

- [ ] `backlog-append.test.ts` — pure: bugs append `\n- [ ] <text>` at EOF (ensures trailing newline); ideas insert above Loop-filed sentinel inside User-authored, with sentinel-missing and section-missing fallbacks; empty/multiline rejected with typed errors.
- [ ] `backlog-append-api.test.ts` — endpoint happy + each typed error; per-file mutex serializes concurrent appends; temp-then-rename verified via mocked fs.
- [ ] `backlog-security.test.ts` — write paths outside the two allowed files → 500; symlink target outside repoPath → 500; write logged to `logs/backlog-mutations.jsonl`.

**Build**

- [ ] `src/intent/backlog-append.ts` (pure).
- [ ] `src/intent/backlog-write-lock.ts` (per-file mutex).
- [ ] `POST /api/backlog/:product/:kind`; integration with security checks + audit log.
- [ ] Drawer `+` chip with pending-state input.

## Phase 4 — Plan + promotion job + scaffold contract

> Depends on: Phase 3

**Tests (write first)**

- [ ] `scaffold-result-parser.test.ts` — extract `{ slug, filesCreated }` from agent message; malformed → undefined; cross-check against repo diff; mismatch → distinct error.
- [ ] `promotion-job.test.ts` — state transitions; restart-replay resumes a `scaffolded` promotion to `marked-source`; backoff on repeated `mark-source-error`; terminal states are not re-entered.
- [ ] `planning-collision.test.ts` — second Plan click while a planning session is active → `409 active-planning-session`; cockpit's resume/abandon dialog wired.
- [ ] `backlog-mark-done.test.ts` — match by snapshot, not line; `[x]` already-done is rewritten with suffix idempotently; ideas append suffix only once; ambiguous match → `mark-source-error`; surrounding bytes preserved (including sub-bullets).
- [ ] `plan-button-api.test.ts` — `POST /api/backlog-items/:id/plan` returns `{ planningSessionId, promotionId }`; stale id → `409 stale-item`; loop-filed → `422 item-not-eligible`.
- [ ] `plan-e2e.test.ts` (integration) — append idea → plan → approve → scaffold captured → bullet marked promoted → promotion `marked-source`. Retry of `/approve` is byte-equal no-op on the source file.

**Build**

- [ ] Update `project-setup-writer` agent prompt to emit `scaffold-result` JSON.
- [ ] `src/intent/scaffold-result.ts` parser + repo-diff cross-check (the directory-diff verification from `approve.ts` commit `a5018e5` is the existing fallback; this phase formalizes the JSON block as the primary signal).
- [ ] `src/intent/promotions.ts` — durable job log + restart replay.
- [ ] `src/intent/backlog-mark-done.ts` — pure rewriter returning `{ newText, matched }`.
- [ ] Extend `StoredPlanningSession` with optional `promotionId`.
- [ ] Extend approval path in `src/bot/commands/approve.ts` and webview approve route to drive the promotion job.
- [ ] `POST /api/backlog-items/:id/plan` and `GET /api/promotions/:id` in `webview.ts`.
- [ ] Drawer Plan button wiring + planning panel hand-off + collision dialog.

## Phase 5 — Polish

> Depends on: Phase 4

- [ ] Manual smoke against jarvis: read drawer, add bug, add idea, plan an idea end-to-end, observe `marked-source`.
- [ ] Add `docs/projects/BACKLOG-FORMAT.md` to the Jarvis repo (and a template for other product repos).
- [ ] Update `docs/projects/08-intent-layer/spec.md` cockpit section with a one-paragraph reference.
- [ ] Strike `Expand cockpit` at `docs/projects/ideas.md` as `- Expand cockpit → 09-expand-cockpit` (this scaffolding commit already does it; re-verify nothing has drifted).
- [ ] Open the follow-on spec `expand-cockpit-fix-autorun` and link it from `ideas.md`.
