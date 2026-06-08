# Planning Retrospective — 14-product-team-agents

**Owner:** the project, written for the agent (or human) who plans the next one.
**Date:** 2026-06-08, after the Phase 6–7 sweep.

## Context

Project 14 was, by the 08-intent-layer standard, a **well-planned** project: every
phase opened with a test-first block, the substrate→wire phasing was explicit, and
each phase carried a `User-reachability` note that said exactly when the work would
become observable from a real surface. The Phase 5 trigger-surface + mode-visibility
tasks and the Phase 6 nightly-cron wiring meant the "pure core with no user surface"
trap that produced 08's 58-task retrofit did not recur here — the learning loop is
genuinely user-reachable (it runs as a nightly step; the user observes committed
`memory.md` diffs).

So the lessons below are not "the plan forgot the user surface." They are smaller,
sharper gaps that surfaced *during* the build — mostly around the true cost of two
task bullets ("wire into the nightly job", "implement the post-mortem") and the
review passes that caught real defects the happy-path test-plan did not enumerate.

---

## Lessons

### Lesson 1 — "Wire X into the nightly job" is a cross-cutting test change, not a one-liner

The Phase 6 task "Nightly job detects valid feedback records…" read as a single
registration. Registering `stepLearningLoop` in `executeNightly` broke, in lockstep:

- `nightly.test.ts`'s **exact step-count + step-name-list snapshot** — `toHaveLength(14)`
  in *six* places, plus the ordered `.toEqual([...])` array, plus a positional
  `result.steps[13]` index assertion that shifted to `[14]`.
- `nightly.nosleep.test.ts` failed to even register tests ("0 test") — it mocks
  `node:child_process` with **`spawn` only**, and the new step transitively imports
  `execFile` (via `roles/commit.ts`'s `promisify(execFileCb)` at module load). The
  whole `nightly.js` import threw, so every test in the file silently vanished.

The reality: a new nightly step = the step itself **+** the step-list snapshot
updates **+** a check of every nightly test that narrowly mocks `node:child_process`.
Budget it as a small multi-file change, not one line. The "0 test" failure mode is
especially sneaky — it reads as a passing file in a casual glance at the summary.

**Applied at:** this repo's `CLAUDE.md` (nightly orchestrator bullet) — added a
one-line caveat in the same commit that a new step requires updating the
`nightly.test.ts` step-list assertions and checking the `nightly.nosleep.test.ts`
`child_process` mock. Also queued in the planning-checklist `TODO(propagation)`
block as a general "snapshot-test + narrow-mock fan-out" decomposition prompt.

### Lesson 2 — An untrusted-input → LLM → tracked-file-commit path needs a trust-boundary review budget the happy-path test-plan misses

The learning-loop modules each passed their test-first suites, written from the
behavioral contract. The `code-reviewer` / `security-auditor` passes then surfaced a
cluster of real gaps the test-plan never enumerated, all on the same axis — *what
happens when the input is hostile or the volume is unbounded*:

- `createdAt` validated by an ISO regex whose `\.\d+` fractional group was
  **unbounded** — a 4000-digit "timestamp" cleared the gate (→ added a length cap).
- **No consumption marker:** the nightly step re-read every record and re-fired the
  post-mortem LLM call *every night forever* (idempotent only at the lesson-write
  dedup, so it burned tokens silently) → added a content-hash processed-id marker +
  a per-pass cap.
- **No per-record fault isolation:** one write/LLM throw aborted the whole pass →
  isolated each record at the seam.
- **No prompt-injection delimiter:** untrusted `issueSummary`/`evidence` (≤4000 chars
  each) were interpolated raw into the post-mortem prompt → wrapped in a labelled
  `<feedback-record>` block.

None of these were in `test-plan.md` §6, because the test-plan was written from the
*feature* contract, not the *threat/scale* contract. The general rule: when a
capability ingests external/untrusted records, calls an LLM, and commits to a tracked
(here: public) file, enumerate trust-boundary items **as test-plan rows up front** —
input length caps, exactly-once consumption (idempotent + bounded), injection
delimiting, and per-item fault isolation — rather than discovering them in review.

**Applied at:** queued in the planning-checklist `TODO(propagation)` block (a new
"trust-boundary / scale checklist for untrusted-input→LLM→persistent-write
capabilities" decomposition prompt), to be folded into the checklist's enumeration
guidance.

### Lesson 3 — Don't background a compound shell command whose tail restores critical state

While A/B-confirming that two unrelated test failures were pre-existing, I ran
`git stash -u && vitest … && git stash pop` as one command and let the harness
**background** it. The `vitest` run was slow, the turn moved on, and the
`git stash pop` tail never executed — leaving the session's uncommitted work sitting
in `stash@{0}` next to an unrelated pre-existing `feat/planning-recovery` stash.
Recovered by popping **`stash@{0}` by explicit ref** (never a bare `git stash pop`,
which could have grabbed the wrong stash).

Two compounding hazards: (a) a stash A/B test puts uncommitted work at risk, and
(b) backgrounding a command whose *restore* step is critical means the restore can
be silently skipped. Prefer committing a WIP checkpoint before any stash dance, and
never background a command whose tail is the thing that makes you whole again.

**Applied at:** the existing auto-memory
`git-stash-pop-resurrects-unrelated-stash.md` already captures the bare-pop hazard;
this lesson sharpens it with the "don't background the restore step" corollary. The
memory is the durable surface and already loads each session.

---

## What the task list got right (worth repeating)

- **Per-phase `User-reachability` notes.** Every phase stated when (and via which
  surface) the work becomes observable. This is the single highest-value habit from
  the 08 retrospective and it paid off — there was no false-done phase.
- **Substrate-then-wire phasing with honest "not yet wired" notes.** Pure cores
  (Phases 1–4) shipped under green tests with explicit "runtime wiring lands in
  Phase 5/6" annotations, so a green suite never masqueraded as a shipped feature.
- **Test-suite-as-deliverable phases.** The "Tests (write first)" blocks that stay
  red until their implementation lands made the red/green state of each phase legible
  and prevented implement-to-the-vibe.

## Propagation summary

| Lesson | Surface | Status |
|---|---|---|
| 1 — nightly-step cross-cutting test change | this repo's `CLAUDE.md` + checklist `TODO(propagation)` | folded into CLAUDE.md this commit; queued for checklist |
| 2 — trust-boundary review budget for untrusted→LLM→commit | planning-checklist `TODO(propagation)` | queued for checklist |
| 3 — don't background a state-restoring command; pop stash by ref | auto-memory `git-stash-pop-resurrects-unrelated-stash.md` | already propagated (sharpened here) |

## Related

- Spec: `docs/projects/14-product-team-agents/spec.md`
- Checklist: [`docs/projects/templates/planning-checklist.md`](../templates/planning-checklist.md)
- Precedent retrospective: [`08-intent-layer/agent-lessons.md`](../08-intent-layer/agent-lessons.md)
