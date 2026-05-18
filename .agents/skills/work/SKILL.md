# /work

Pick the next pending task from a project's task list and drive it through the full implementation cycle: plan, implement, test, review, fix, simplify, and mark complete.

## Usage

```
/work [project-name] [--auto]
```

If no argument is given, list all projects in `docs/projects/` and ask the user which one to work on.

**`--auto` (unattended mode)**: skips all user-interaction gates so one invocation sweeps the entire task list end-to-end. Specifically: step 2 skips the "confirm before proceeding" gate, Phase 1 skips Plan Mode entirely (still does exploration and writes the plan to the turn output for the transcript record, but does not call `EnterPlanMode`/`ExitPlanMode` since those require human approval), step 17 creates one git commit per completed task (using the release-notes agent to draft the message) without pausing for approval, and step 18 auto-continues to the next unchecked task without asking. Hard stops (step 2 empty list, step 11 BLOCK verdict, step 12 tests failing twice, step 17 commit still failing after one retry, step 18 empty list) still terminate the run — those are error/completion exits, not checkpoints.

Because `--auto` commits everything in the working tree at the end of each task, start from a clean working tree (no unrelated uncommitted changes). If `git status` is dirty at step 2 in `--auto` mode, stop and report to the user instead of sweeping those changes into a task commit.

**No discretionary pauses in `--auto`.** The hard stops listed above are the *only* valid reasons to stop or ask the user something mid-run. Do not invent additional checkpoints — do not pause to offer a commit, confirm direction, summarize progress, checkpoint a subsystem boundary, or ask whether to proceed between tasks. If a general instruction elsewhere (e.g., "only commit when the user asks" or "confirm risky actions") seems to conflict with `--auto`, resolve it by *not performing the action*, not by pausing. The user authorized an unattended sweep by passing `--auto`; interrupting that sweep for any reason outside the hard-stop list violates the contract.

## Instructions

### 1. Find the Project

Match the argument to a folder in `docs/projects/`:

- **Exact match**: argument matches the suffix after `NN-` (e.g., `mvp` → `01-mvp`)
- **Partial match**: argument is a substring of exactly one project name — use it
- **Ambiguous**: argument matches multiple projects — list the matches and ask the user to pick one
- **No match**: tell the user no project was found, list available projects, and stop

### 2. Read the Task List

Read `docs/projects/[project]/tasks.md`. Find the first unchecked task (`- [ ]`).

- If no unchecked tasks remain, tell the user all tasks are complete and stop.
- Announce which task you're picking up.
- **With `--auto`**: run `git status --porcelain` first. If the working tree is not clean, stop and report the dirty files to the user — do not proceed, because step 17 would otherwise sweep those unrelated changes into the task commit. Then proceed immediately.
- **Without `--auto`**: confirm with the user before proceeding. A dirty working tree is fine here since the user commits manually.

---

## Phase 1: Plan (Plan Mode)

### 3. Enter Plan Mode

**Without `--auto`**: Call `EnterPlanMode` to switch into planning mode. This disables editing tools and forces thorough exploration before committing to an approach.

**With `--auto`**: Do NOT call `EnterPlanMode` (it requires human approval to exit, which breaks unattended flow). Instead, still perform thorough exploration in steps 4–5 before any edits, and write the plan to the turn output so it's visible in the transcript. Skip step 6 entirely and proceed to Phase 2.

### 4. Explore and Research

Read the project spec and reference materials. Use Read, Glob, Grep, and the Explore agent to understand the codebase before designing the approach.

**Always read:**

- `docs/projects/[project]/spec.md` — focus on sections relevant to the current task
- `docs/projects/[project]/test-plan.md` (if it exists) — test scenarios for this task
- `AGENTS.md` — project conventions, architecture, key patterns

**Explore the codebase:**

- Find existing files that will need changes
- Understand current patterns in the relevant modules
- Identify any dependencies or constraints
- If `AGENTS.md` points to specific reference files for the kind of change you're making (e.g., "to add a new X, read Y for the pattern"), read those

### 5. Write the Plan

Write the implementation plan. The plan should include:

- **Approach**: what you're going to do and why (mention alternatives considered if relevant)
- **Files to change**: list of existing files to modify and any new files needed
- **Sub-tasks**: ordered list of implementation steps with descriptions
- **Risks / open questions**: anything that might affect the approach

### 6. Exit Plan Mode

**Without `--auto`**: Call `ExitPlanMode` to present the plan for user approval. Do NOT proceed until the user approves.

**With `--auto`**: Skip this step (see step 3). Proceed directly to Phase 2.

---

## Phase 2: Execute (Task Tracking)

### 7. Create Execution Tasks

After the user approves the plan, create `TaskCreate` items for each sub-task from the plan:

- Use clear descriptions and `activeForm` labels
- Set up `blockedBy` dependencies where sub-tasks must be sequential

### 8. Implement

Work through the sub-tasks in order:

- Mark each sub-task `in_progress` via `TaskUpdate` before starting it
- Mark each sub-task `completed` when done
- Follow all conventions in `AGENTS.md`
- Keep changes minimal and focused on the task

After implementation is complete, stage all changes but do NOT commit yet. This ensures review agents can see the full diff via `git diff HEAD`.

### 9. Test — Round 1

Use the `Agent` tool with `subagent_type: "test-specialist"` to write and run tests:

```
Write tests for the changes just implemented for the [task name] task
in project [project]. The following files were changed: [list changed files].
If test infrastructure is not yet configured, set it up using the project's
idiomatic framework. Run all tests and fix any failures. Focus on the test
scenarios from the test plan that relate to this task.
```

Wait for the agent to finish and confirm all tests pass before proceeding.

### 10. Review — Conditional, Parallel

Run `git diff HEAD --name-only` to get the list of changed files, then launch the applicable reviewers in parallel:

**Always run code-reviewer** (every change needs bug/security review):

Use the `Agent` tool with `subagent_type: "code-reviewer"`:

```
Review the changes made for the [task name] task. The following files were
changed: [list changed files]. Check for bugs, security issues, type-safety
violations, and project convention violations per AGENTS.md.
```

**Always run security-auditor** (every change needs security & exposure review):

Use the `Agent` tool with `subagent_type: "security-auditor"`:

```
Audit the changes made for the [task name] task. The following files were
changed: [list changed files]. Check for hardcoded secrets, personal-info
exposure, sensitive content leaks, path traversal risks, unsanitized input
in shell commands, and anything unsafe to commit to the remote.
```

**Run architecture-reviewer when applicable:**

Use the `Agent` tool with `subagent_type: "architecture-reviewer"` **if** the task involves new modules, changes to centralized wrappers (config, logger, external-CLI/process spawning, I/O helpers), new background/scheduled work, changes to process startup/shutdown, new agent definitions, or changes that cross module boundaries.

```
Review the changes made for the [task name] task. The following files were
changed: [list changed files]. Check for module boundary violations,
resource lifecycle issues, centralization violations, graceful shutdown
gaps, concurrency hazards, and any project-specific architectural rules
in AGENTS.md.
```

If a reviewer is not applicable, skip it and note "N/A — no relevant changes" in the completion summary.

### 11. Fix Review Issues

Collect findings from all reviewers. Address issues in priority order:

1. **Critical / BLOCK / ERROR** — fix all of these, no exceptions
2. **Warnings** — fix unless there's a clear reason to skip (explain why if skipping)
3. **Suggestions** — apply easy wins (< 5 min effort); skip the rest

If no issues were found, skip to step 12.

If any reviewer returns a BLOCK verdict, or fixing issues requires fundamentally changing the approach, stop and report to the user with blocking findings and a proposed alternative. Do NOT proceed until the user confirms.

### 12. Test — Round 2

Use the `Agent` tool with `subagent_type: "test-specialist"`:

```
Run all tests to verify the review fixes for [task name] didn't break
anything. The following files were changed: [list changed files].
Fix any failures.
```

Skip this step if no code changes were made in step 11.

If tests fail after two fix attempts, stop and report the failures to the user. Do not loop indefinitely.

### 13. Simplify

Use the `Agent` tool with `subagent_type: "code-simplifier"`:

```
Check the changes made for the [task name] task for dead code,
over-abstractions, duplication, and unnecessary complexity.
```

The code-simplifier is read-only — it reports findings but cannot edit files. After it finishes, apply its recommendations yourself:

- **Quick Wins** — apply all
- **Medium Effort** — apply if clearly beneficial
- **Structural Changes** — do NOT apply; mention them to the user for future consideration

### 14. Test — Round 3

Use the `Agent` tool with `subagent_type: "test-specialist"` one final time:

```
Final test run after simplification for [task name]. The following files
were changed: [list changed files]. Run all tests and fix any failures.
```

Skip this step if step 13 made no code changes.

### 15. Evals — Conditional

If the task modified agent behavior in any of these ways, run the relevant evals:

- Any file under `.Codex/agents/` (Jarvis) or `$VAULT_DIR/.Codex/agents/` (vault-resident) changed
- The prompt strings, context assembly, or args passed to `runAgent()` changed in a source file (grep the diff for `runAgent(`)
- `AGENT_MODEL` / agent-loading logic in `src/ai/Codex.ts` changed

```bash
npm run evals -- <agent-name>     # single agent
npm run evals                     # all agents if multiple touched
npm run evals -- --dry-run        # validate YAML only (use if iterating on fixtures)
```

A non-zero exit from `npm run evals` is a failure — fix the failing fixture (or the agent prompt) before proceeding, or defer with explicit justification in the completion summary.

If no `evals/<agent-name>.yaml` exists for an affected agent yet, note it in the completion summary as a follow-up rather than blocking.

Skip this step if the task didn't touch agent behavior. MVP: no CI gate, manual cadence, pass/fail goes in the completion summary alongside test results.

### 16. Sync Docs

Use the `Agent` tool with `subagent_type: "docs-sync"`:

```
Scan the codebase for structural changes and update AGENTS.md and project
docs to reflect the current state. Focus on: project structure, agents
and skills tables, environment variables, and scripts.
```

Skip this step if the task only changed existing file internals without adding new modules, commands, agents, config values, or scripts.

### 17. Mark Task Done

Mark the task done in the project's `tasks.md` by changing `- [ ]` to `- [x]` for the completed task. This applies in both modes, and it happens **before** step 18 so the tasks.md update lands in the same commit as the task's code changes.

### 18. Commit (`--auto` only)

**Without `--auto`**: Skip this step. The user will review the diff and commit manually.

**With `--auto`**: Create one commit that captures everything done for this task (code, tests, docs, tasks.md update).

1. Run `git add -A` to stage all changes for the task. (Pre-existing dirty files should have been caught at step 2 — if any slipped through, stop and report rather than committing unknown work.)
2. Use the `Agent` tool with `subagent_type: "release-notes"` to draft the message:

   ```
   Generate a commit message (Mode B) for the currently staged changes, which
   complete the "[task name]" task in project [project]. Analyze the staged
   diff directly — do NOT use `git log`, these changes are not yet committed.
   Return only the raw message text (subject + optional body), no preamble.
   ```

3. Take the returned message and create the commit using a HEREDOC so formatting is preserved, appending the `Co-Authored-By` trailer:

   ```bash
   git commit -m "$(cat <<'EOF'
   <message returned by release-notes agent>

   Co-Authored-By: Codex <noreply@anthropic.com>
   EOF
   )"
   ```

4. Run `git status` to verify the commit landed and the tree is clean.
5. If the commit fails (pre-commit hook, signing issue, etc.), diagnose the failure, fix the underlying issue, re-stage with `git add -A`, and create a **new** commit with the same message — do not use `--amend` or `--no-verify`. If the retry also fails, stop and report to the user with the hook output; do not loop.

### 19. Report and Continue

Output a completion summary:

```markdown
## Task Complete: [task name]

**Project:** [project folder]
**Task:** [task description]

### Changes Made

- [bullet list of key files changed and what was done]

### Test Results

- Tests written: [N]
- Tests passing: [all/N of M]

### Review Summary

- Code: [PASS or N issues found, N fixed]
- Security: [PASS or N issues found, N fixed]
- Architecture: [PASS or N/A or N issues found, N fixed]

### Simplification

- [changes applied or "No changes needed"]

### Commit

- [commit SHA and subject, or "Not committed — run without --auto"]

### Next Task

- [next unchecked task from tasks.md, or "All tasks complete!"]
```

After outputting the summary, check `tasks.md` for the next unchecked task (`- [ ]`):

- **If a next task exists**:
  - **Without `--auto`**: ask the user "Ready to start the next task: **[task name]**?" and if they confirm, loop back to **step 3** with that task.
  - **With `--auto`**: loop back to **step 3** immediately with that task — do not ask.
- **If no tasks remain**: tell the user all tasks for the project are complete and stop.
