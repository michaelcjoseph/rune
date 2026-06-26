# Writer Role — Compounding Memory — Tasks

See [spec.md](spec.md) for rationale and [test-plan.md](test-plan.md) for verification. Built
test-first: each phase opens with a **Tests (write first)** block, red before implementation.

## Phase 0 — Human seed-source prerequisite

- [x] Michael adds 20-50 seed links under `spec.md` → **Seed sources**. This is the only
      intentional human blocker; every later task is agent-runnable. (46 links present under
      Seed sources, within the 20-50 range — commit 93d3754.)

## Phase 1 — Writer role + seed + read path

**Tests (write first)**

- [x] Authority test: the composed call puts `SOUL.md` (+ voice) in `--append-system-prompt`
      and `memory.md` in the first user message; assert memory text is absent from the
      appended system prompt. (`src/writer/memory.test.ts` — authority-boundary group; red.)
- [x] Cold-start test: empty `memory.md` yields a valid prompt (SOUL + voice), no error.
      (`src/writer/memory.test.ts` — cold-start group; red.)
- [x] Budget test: a `memory.md` over `WRITER_MEMORY_CHAR_BUDGET` is truncated with a visible
      marker; under budget passes through whole. (`src/writer/memory.test.ts` — char-budget
      group; red.)
- [x] Path test: the loader reads SOUL/memory from `PROJECT_ROOT/agents/writer/`, not via
      `readVaultFile`. (`src/writer/memory.test.ts` — path-contract group; red.)
- [x] Seed parser test: when `spec.md` has 20-50 seed links, the seeding helper reads only
      those links and emits ≤20 provenance-stamped memory bullets; fewer than 20 link entries
      fails with a clear prerequisite error, more than 50 fails with a clear cap error, and
      unfetchable supplied URLs are skipped with a note. (`src/writer/seed.test.ts`; red.)

**Implementation**

- [x] Write `rune/agents/writer/SOUL.md` from this spec — charter referencing
      `writing/voice.md` (no duplication). (`agents/writer/SOUL.md`; contract pinned
      by `src/writer/soul.test.ts`.)
- [x] Build the loader returning `{ systemInstructions: SOUL (+ existing voice:true),
      referenceContext: fenced memory.md }`; read from `PROJECT_ROOT/agents/writer/`; enforce
      `WRITER_MEMORY_CHAR_BUDGET` (~12–16k) with a load-time truncation marker; do not delete
      old entries from `memory.md` to enforce the read budget. (`src/writer/memory.ts`
      `composeWriterContext`; 12 tests green. `voice:true` injection wired at the blog call
      site in the next task.)
- [x] Wire the loader into `src/reviews/blog.ts`; reference goes in the initial user turn, not
      `--append-system-prompt`; persisted session recovery keeps enough context to continue
      without putting memory in the system prompt. (`blogHandler.start` calls
      `composeWriterContext(buildBaseInstructions(topic))`; `systemInstructions` → system
      channel + `prepContext`, fenced `referenceContext` → first user turn; 4 wiring tests in
      `src/reviews/blog.test.ts`, 11 green.)
- [x] Mine the filled seed-source list into a ≤20-bullet, provenance-stamped `memory.md`;
      source inputs may be 20-50 links, unfetchable supplied URLs are skipped, and there is no
      second manual approval gate. (Implemented the pure `seed.ts` helpers (26 writer tests
      green); mined the 46 spec links via parallel fetch agents — x.com/paywalled URLs skipped —
      into `agents/writer/memory.md`: 20 provenance-stamped abstract-craft bullets, opaque
      slugs, all matching `PROVENANCE_RE`, loaded into the writer's `referenceContext`.)

## Phase 2 — Feedback phase + lesson capture + auto-commit

> Depends on: Phase 1

**Tests (write first)** — RED suites + throwing `notImplemented()` scaffolds
(`src/writer/{sentinel,capture,commit}.ts`) landed together; suites stay red until
the Phase 2 implementation tasks below land. 27 red by design, Phase 1 + existing
blog tests stay green.

- [x] Sentinel test: when the writer emits the completion sentinel, `blogHandler` closes the
      session (phase → `done`, state cleared) and triggers capture; no reliance on literal
      assistant `/done`. (`src/reviews/blog.test.ts` — "completion sentinel (Phase 2)" group.)
- [x] Sentinel hygiene test: only a final-line `[[WRITER_MEMORY_COMPLETE]]` sentinel counts;
      the sentinel is stripped before sending the assistant reply and capture runs at most once.
      (`src/writer/sentinel.test.ts` + the blog "sends the sentinel-stripped reply" test.)
- [x] Capture test: given a feedback payload, `captureLessons()` emits ≥1 provenance-stamped
      craft lesson. (`src/writer/capture.test.ts` — captureLessons happy-path group.)
- [x] No-feedback test: no feedback supplied → no memory write. (`src/writer/capture.test.ts`
      — `feedbackSeen:false` → `skipReason:'no-feedback'`, no append, no commit.)
- [x] Candidate-parse test: `captureLessons()` accepts only a fenced
      `writer-memory-candidates` JSON block with `feedbackSeen`, `sourceSlug`, and `lessons`.
      (`src/writer/capture.test.ts` — parseCandidateBlock group.)
- [x] Dedup test: a candidate matching an existing entry is dropped. (`src/writer/capture.test.ts`
      — dedup test.)
- [x] Privacy test: a candidate containing a raw excerpt / private name is blocked or
      abstracted by the TS filter; source is an opaque slug matching the slug regex.
      (`src/writer/capture.test.ts` — `isLessonPrivacySafe` group + privacy integration +
      `SOURCE_SLUG_RE` slug assertions.)
- [x] Atomic-commit test (temp repo): the memory-scoped commit helper stages **only**
      `agents/writer/memory.md` and commits one batch as one commit with a clear message; it
      does not stage unrelated dirty files and does not require a push. (`src/writer/commit.test.ts`
      — real temp git repo.)

**Implementation**

- [x] Add the mandatory feedback checkpoint to the writer lifecycle in `SOUL.md`; the writer
      emits the final-line completion sentinel after feedback/revision. (`agents/writer/SOUL.md`
      "How you work" steps 4-5: mandatory feedback gate + close-out protocol emitting a fenced
      `writer-memory-candidates` block then the `[[WRITER_MEMORY_COMPLETE]]` sentinel; sentinel
      string / fence tag / fields verified to match `sentinel.ts` + `capture.ts`; soul.test.ts
      green.)
- [x] `blogHandler` detects the final-line sentinel → strips it → runs capture → sets phase
      `done` → clears state. (`detectCompletionSentinel` implemented in `src/writer/sentinel.ts`
      (final-line-only, trim-lenient); `blogHandler.handleMessage` sends the stripped reply,
      runs `captureLessons` fault-isolated (a capture failure never denies closure), then
      delete-then-`done` mirroring the `/done` path; sentinel + blog suites green, 20 tests. A
      `Promise.race` timeout around capture is deferred to the commit-impl task once git spawns.)
- [x] Build `captureLessons()`: parse the fenced candidate JSON; TS does no-feedback gating,
      dedupe, privacy filter, provenance-stamp, and append to `memory.md`. (`src/writer/capture.ts`:
      `parseCandidateBlock` + `isLessonPrivacySafe` (over-long / private-name unicode-aware /
      markdown+reference links / wikilinks / bare URLs / email / phone / long quotes) + async
      `captureLessons` (gate → filter → dedupe → stamp → append → commit seam). 23 capture tests
      green incl. hardening guards. Commit seam wiring is the next task.)
- [x] Build the memory-scoped commit helper (rune repo, stages only
      `agents/writer/memory.md`); call it from `captureLessons()`. Commit only, no approval
      gate and no push requirement. (`src/writer/commit.ts` `commitWriterMemory`: on-`main`
      guard, pathspec add+commit of only memory.md, no-op when unchanged, no push; called via
      `captureLessons`' default commit seam. Added a per-process capture mutex + a 20s
      `withTimeout` around capture in `blogHandler` (review-driven). 73 writer+blog tests green
      incl. pre-staged-isolation + off-main soft-fail.)

## Phase 3 — Loop-closure eval

> Depends on: Phase 1, 2

**Tests (write first)**

- [x] Closure test: a fixture lesson (with an observable marker) captured on piece N appears in
      the `referenceContext` loaded for piece N+1. (`src/writer/loop-closure.test.ts` — real
      `captureLessons` → temp `memory.md` → real `composeWriterContext`; marker round-trips into
      `referenceContext`, absent from `systemInstructions`. Green.)
- [x] No-subjective-gate test: the loop-closure verification does not require a real post,
      Telegram interaction, or judging whether a draft "feels" improved. (Same suite: pure
      string-membership over temp files with injected deps + a no-block negative control; no
      sender/bot/LLM.)

**Implementation**

- [x] Run an automated fixture flow that captures a lesson, then composes a second `/blog`
      start; confirm the lesson is loaded into N+1's `referenceContext`. (Satisfied by the
      automated `src/writer/loop-closure.test.ts` gate — green; uses the real capture→store→load
      path end-to-end.)
- [x] Record the loop-closure outcome in the project's index row. (docs/projects/index.md:
      project flipped to **Done** in both the table row and section header; an **Outcome (loop
      closes ✅)** bullet records the gate result and the shipped end-to-end flow.)

---

## Out of scope (recorded)

- Cross-product / per-product / global memory; typed schema; composer; conflict/expiry.
- The planning pipeline; additional roles; a general role-dispatch runtime.
- A quality A/B eval and engagement-driven lessons (`ideas.md`).
- An approval queue (capture auto-commits).
- A manual prose-quality acceptance check; v1 proves capture → store → load mechanically.
- An automated `git revert` test (atomic commits make manual revert possible after the fact).
