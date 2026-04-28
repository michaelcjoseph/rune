# /review

Run the full review panel — `test-specialist`, `security-auditor`, `code-reviewer`, `code-simplifier`, and `architecture-reviewer` — in parallel against the current uncommitted working tree, then return one consolidated verdict.

Use this as a pre-commit gate, after exploratory work outside `/work`, or any time you want a comprehensive review of "what's on disk right now."

## Usage

```
/review
```

No arguments. The skill always operates on the current working tree (staged + unstaged + untracked).

## Scope

"Uncommitted changes" means everything that differs from `HEAD`:

- **Tracked changes** — `git diff HEAD --name-only` (covers both staged and unstaged)
- **Untracked files** — entries from `git status --porcelain` whose status code is `??`

If both lists are empty, exit immediately with "Nothing to review — working tree matches HEAD." Do not launch any agents.

## Constraints

- `/review` does not modify production code. The four reviewers (`security-auditor`, `code-reviewer`, `code-simplifier`, `architecture-reviewer`) are read-only. `test-specialist` is the one carve-out: it may add new test files and fix failures introduced by its own new tests — but never bootstrap test infra, modify unrelated tests, or touch non-test source. The user decides what to do with the verdict.
- If an agent errors out (timeout, missing definition, runtime failure, or returns an unparseable response the synthesizer can't extract a verdict and findings from), mark it `UNAVAILABLE` with a one-line reason in the per-agent results, do not retry, and compute the overall verdict from the remaining agents.

> **Why test-specialist is allowed to write (but not bootstrap):** the goal of `/review` is comprehensive pre-commit confidence, and "no test exists for the new code" is a gap the panel should close, not just report. Bootstrapping a test framework, in contrast, is a structural project decision (framework choice, layout, scripts) that belongs in `/work`, not as a side effect of a review pass. New test files are flagged under "Per-agent results" so the user knows they weren't themselves reviewed in this pass — they'll be on the next `/review` run.

## Instructions

### 1. Collect the change set and capture the diff

Run these in parallel:

```bash
git diff HEAD --name-only
git status --porcelain
git diff HEAD
```

Build two lists:

- `tracked_changes` — output of `git diff HEAD --name-only`
- `untracked` — paths from `git status --porcelain` lines that begin with `??`

Combine into `changed_files = tracked_changes + untracked`. If `changed_files` is empty, print "Nothing to review — working tree matches HEAD." and stop.

Capture the `git diff HEAD` output as `diff_text`. Then count its lines (equivalent to `git diff HEAD | wc -l`) and pick a mode:

- If line count **≤ 1500** → **inline mode**: embed `diff_text` verbatim in each prompt below.
- Otherwise → **fetch mode**: do not embed; tell each agent to run `git diff HEAD` itself.

> **Why the size guard:** issuing five `Agent` calls in one turn with the diff inlined puts five copies of it into the *parent* assistant's transcript. For small diffs that's negligible. For large refactors it can dominate parent context. In fetch mode, the diff lives only in each subagent's own context — where it would have lived anyway — at the price of five concurrent `git diff` runs (cheap; git is fast). Inline mode is preferred when affordable because it removes one tool round-trip per subagent and keeps prompts self-contained.

Untracked files never appear in `diff_text` regardless of mode; agents are told to read those directly.

Print a one-line scope summary, e.g. `Reviewing 7 files (5 tracked, 2 untracked) — diff embedded…` (or `…— agents will fetch diff…` in fetch mode), then proceed.

### 2. Launch all five agents in parallel

**All five `Agent` tool calls MUST be issued in a single assistant turn** so the harness runs them concurrently. Do not invoke them sequentially across turns — that defeats the point of the skill.

Each prompt carries the file lists and tells the agent to read `CLAUDE.md` for project rules. Each agent uses its **native verdict and severity vocabulary** — the skill normalizes these in step 3.

In every prompt below, the block

```
--- BEGIN DIFF ---
[diff_text]
--- END DIFF ---
```

is included verbatim **only in inline mode**. In **fetch mode**, replace that whole block with the single line:

```
Run `git diff HEAD` yourself to see the full diff for tracked changes.
```

> **Why the placeholder swap (not two full prompt copies):** the prompts otherwise differ only in this one block, and duplicating each agent prompt twice in the skill doubles the surface area to maintain.

**`Agent` with `subagent_type: "test-specialist"`**
- description: `Test uncommitted changes`
- prompt:
  ```
  Test the current uncommitted changes.
  Files changed (tracked): [list tracked_changes]
  Files added (untracked, read directly if needed): [list untracked]

  1. Read CLAUDE.md and the project manifest to identify the test
     framework and conventions. If no test framework is configured,
     stop and return UNAVAILABLE with reason: "no test framework —
     run /work to bootstrap test infra first". Do NOT bootstrap.
  2. Write tests for any uncovered behavior in the changed code.
     Match the project's existing test layout, assertion style, and
     mocking patterns. Do NOT modify unrelated existing tests, and do
     NOT modify non-test source files.
  3. Run the full test suite.
  4. If your new tests fail, fix bugs in the test code only (setup,
     imports, mock wiring, fixture data). NEVER weaken assertions
     to make a failing test pass — that's the failure mode this
     skill is trying to prevent. If a test still fails after 2 fix
     attempts, leave it failing: it's a real signal, either about
     the changed code or about the test's premise, and the user
     should see it. Do NOT modify pre-existing/unrelated failing
     tests at all.
  5. For each remaining failure, give:
     - file:line of the failing assertion
     - one-line cause
     - attribution: tag "caused-by-diff" UNLESS you can clearly
       articulate why this would have been failing on HEAD before
       the diff was applied (e.g., the failing test exercises code
       untouched by the diff and unrelated to its consumers — note
       that a failure in a test file outside the changed list can
       still be caused by the diff via transitive consumers). On
       uncertainty, default to "caused-by-diff": a false
       "pre-existing" tag means the user ships a regression
       unflagged, while a false "caused-by-diff" tag costs them a
       minute of investigation.
  6. Coverage summary: list — per function or feature in the
     changed code — which behaviors your new tests actually
     exercise and which remain uncovered. Do NOT write tests for
     the uncovered items; just list them. Naming what's untested
     forces honest accounting: a panel PASS verdict on a
     thinly-tested change is a known failure mode, and an explicit
     uncovered list is much harder to fudge than just emitting a
     passing test.

  Return:
  - PASS or FAIL with counts (N passing, M failing)
  - New test files created (paths only, or "none")
  - Coverage summary: per changed function/feature, behaviors
    covered vs uncovered
  - Remaining failures with attribution tags (or "none")
  ```

  > **Why the strict scope:** test-specialist is the only writer in the panel. Letting it touch unrelated tests or non-test source would silently expand `/review`'s blast radius beyond what the user expects from a review skill.

**`Agent` with `subagent_type: "security-auditor"`**
- description: `Security audit uncommitted changes`
- prompt:
  ```
  Audit the current uncommitted changes for security issues.
  Files changed (tracked): [list tracked_changes]
  Files added (untracked, read directly): [list untracked]

  For untracked files, read them directly. Read CLAUDE.md for the
  project's threat model.

  --- BEGIN DIFF ---
  [diff_text]
  --- END DIFF ---

  Use your standard audit checklist and output format. Use your native
  severity vocabulary (CRITICAL / WARNING / NOTE) and verdict line
  (PASS / PASS_WITH_WARNINGS / BLOCK).
  ```

**`Agent` with `subagent_type: "code-reviewer"`**
- description: `Code review uncommitted changes`
- prompt:
  ```
  Review the current uncommitted changes for bugs, type-safety issues,
  and convention violations.
  Files changed (tracked): [list tracked_changes]
  Files added (untracked, read directly): [list untracked]

  For untracked files, read them directly. Read CLAUDE.md for
  project conventions.

  --- BEGIN DIFF ---
  [diff_text]
  --- END DIFF ---

  Use your standard review checklist and output format. Use your native
  severity vocabulary (ERROR / WARNING / SUGGESTION) and verdict line
  (PASS / PASS_WITH_WARNINGS / BLOCK).
  ```

**`Agent` with `subagent_type: "code-simplifier"`**
- description: `Simplification check uncommitted changes`
- prompt:
  ```
  Check the current uncommitted changes for unnecessary complexity.
  Files changed (tracked): [list tracked_changes]
  Files added (untracked, read directly): [list untracked]

  For untracked files, read them directly. Read CLAUDE.md for
  intentional patterns and the project's abstraction philosophy.

  --- BEGIN DIFF ---
  [diff_text]
  --- END DIFF ---

  Use your standard output format with Quick Wins / Medium Effort /
  Structural sections. This is advisory — do NOT emit a verdict line
  and do NOT block on findings; simplifier output is never blocking.
  ```

**`Agent` with `subagent_type: "architecture-reviewer"`**
- description: `Architecture review uncommitted changes`
- prompt:
  ```
  Review the current uncommitted changes for architectural concerns.
  Files changed (tracked): [list tracked_changes]
  Files added (untracked, read directly): [list untracked]

  For untracked files, read them directly. Read CLAUDE.md for module
  boundaries and architectural rules.

  --- BEGIN DIFF ---
  [diff_text]
  --- END DIFF ---

  Use your standard checklist and output format. Use your native
  severity vocabulary (BLOCK / WARNING / SUGGESTION) and verdict line
  (PASS / PASS_WITH_WARNINGS / BLOCK).
  ```

### 3. Normalize, dedupe, synthesize

After all five agents return, normalize their **findings** into a unified `BLOCK / WARN / INFO` taxonomy using this map:

| Source signal | Maps to |
|---|---|
| security-auditor `CRITICAL` | **BLOCK** |
| code-reviewer `ERROR` | **BLOCK** |
| architecture-reviewer `BLOCK` | **BLOCK** |
| `test-specialist` failure tagged `caused-by-diff` | **BLOCK** (one finding per failing test) |
| `test-specialist` failure tagged `pre-existing` | **WARN** (one finding per failing test, prefixed `[pre-existing]`) |
| any agent `WARNING` | **WARN** |
| code-reviewer `SUGGESTION` | **INFO** |
| security-auditor `NOTE` | **INFO** |
| architecture-reviewer `SUGGESTION` | **INFO** |
| simplifier `Quick Win` | **INFO** |
| simplifier `Medium Effort` / `Structural` | listed separately under "Simplification suggestions (defer)" — never blocks, never warns |
| any agent `UNAVAILABLE` | noted in per-agent results; contributes no findings |

> **Why findings drive the verdict, not per-agent verdict lines:** an earlier draft also mapped each agent's verdict line (`BLOCK` / `PASS_WITH_WARNINGS`) into the overall verdict. That double-counted what the finding rows already produced and could conflict (e.g., agent says `verdict: BLOCK` but emitted no `BLOCK`-severity findings). Each agent's verdict line is now informational only — it appears in the per-agent results section, but does not influence the overall verdict.

> **Why pre-existing test failures are WARN, not BLOCK:** `/review` runs against the working tree, and the suite may have flaky or unrelated failures the user did not introduce. BLOCK-ing on those creates false negatives that train users to ignore the verdict. Surfacing them as WARN keeps them visible without gating clean changes.

> **Why a panel-authored test that still fails ends up as the panel's own BLOCK:** the new test file is part of the diff, so `caused-by-diff → BLOCK` applies as written. This is intentional: a test the panel itself wrote that won't pass after two fix attempts means either the changed code is broken or the test's premise is wrong. Either way the user needs to see it before committing — that's exactly what BLOCK is for.

**Dedupe**: if two or more agents report substantively the same concern at the same `file:line` (or `file` if no line is given), list it once and tag with all agent names: `[security-auditor + code-reviewer]`. Pick the most severe normalized severity across the duplicates. "Substantively the same" means same root cause: a null-deref and a shell-injection both at `foo.ts:42` are different concerns and stay as separate findings. When in doubt, keep them separate.

Compute the overall verdict from normalized findings only:

- **BLOCK** — at least one normalized BLOCK finding.
- **WARNINGS** — no BLOCKs, but at least one WARN finding.
- **PASS** — no BLOCKs, no WARNs. INFO and Simplification suggestions are allowed.

If `test-specialist` is `UNAVAILABLE`, the verdict is computed without it (per the constraints) — but tests then haven't been validated at all. In that case, prepend this bullet to **Next steps**: `Tests did not run — re-run manually before committing.`

> **Why surface this in Next steps:** an UNAVAILABLE test-specialist contributes no findings and so doesn't show up in the severity counts. Without an explicit nudge, a "WARNINGS" or even "PASS" verdict on a run where the suite never executed is misleading.

Print the report in this format:

```markdown
# /review summary

**Scope:** N changed files (X tracked, Y untracked)
**Verdict:** PASS | WARNINGS | BLOCK

## Findings by severity

**BLOCK (count)**
- [agent(s)] file:line — description

**WARN (count)**
- [agent(s)] file:line — description

**INFO (count)**
- [agent(s)] file:line — description

## Simplification suggestions (defer)

- [file:line] description (Medium / Structural)

## Per-agent results

> Each agent's native verdict line is shown here for reference only — it does not influence the overall verdict (which is computed from normalized findings in step 3). If an agent is UNAVAILABLE, replace its body with `UNAVAILABLE — <one-line reason>`.

### test-specialist — <PASS / FAIL>
- Suite: <N passing / M failing>
- New tests: <paths or "none"> *(not reviewed in this pass — will be on next `/review`)*
- Coverage: <N behaviors tested, M uncovered>
- Uncovered: <list of behaviors not exercised by tests, or "none">
- Failures: <list with attribution tags, or "none">

### security-auditor — <PASS / PASS_WITH_WARNINGS / BLOCK>
- <one-line summary; "Clean" if PASS>

### code-reviewer — <PASS / PASS_WITH_WARNINGS / BLOCK>
- <one-line summary>

### code-simplifier (advisory)
- Quick Wins: N | Medium: N | Structural: N

### architecture-reviewer — <PASS / PASS_WITH_WARNINGS / BLOCK>
- <one-line summary>

## Next steps
- <bulleted, ordered list of recommended actions; address BLOCKs first>
```
