# /work

Pick the next pending task from a project's task list and drive it through the full implementation cycle: plan, implement, test, review, fix, simplify, and mark complete.

## Usage

```
/work [project-name]
```

If no argument is given, list all projects in `docs/projects/` and ask the user which one to work on.

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
- Show the user which task you're picking up and confirm before proceeding.

---

## Phase 1: Plan (Plan Mode)

### 3. Enter Plan Mode

Call `EnterPlanMode` to switch into planning mode. This disables editing tools and
forces thorough exploration before committing to an approach.

### 4. Explore and Research

Read the project spec and reference materials. Use Read, Glob, Grep, and the
Explore agent to understand the codebase before designing the approach.

**Always read:**

- `docs/projects/[project]/spec.md` — focus on sections relevant to the current task
- `docs/projects/[project]/test-plan.md` (if it exists) — test scenarios for this task
- `CLAUDE.md` — project conventions, architecture, key patterns

**Explore the codebase:**

- Find existing files that will need changes
- Understand current patterns in the relevant modules
- Identify any dependencies or constraints

**Jarvis-specific patterns to check:**

- If the task touches AI operations, read `src/ai/claude.ts` for the spawning pattern
- If the task adds a new command, read `src/bot/handlers/text.ts` for routing pattern and an existing command in `src/bot/commands/` for structure
- If the task adds a cron job, read existing jobs in `src/jobs/` for the pattern
- If the task touches vault files, read `src/vault/files.ts` for the file operation API
- If the task adds an agent, read an existing agent in `.claude/agents/` for frontmatter and prompt conventions

### 5. Write the Plan

Write the implementation plan to the plan file. The plan should include:

- **Approach**: what you're going to do and why (mention alternatives considered if relevant)
- **Files to change**: list of existing files to modify and any new files needed
- **Sub-tasks**: ordered list of implementation steps with descriptions
- **Risks / open questions**: anything that might affect the approach

### 6. Exit Plan Mode

Call `ExitPlanMode` to present the plan for user approval. Do NOT proceed until the
user approves.

---

## Phase 2: Execute (Task Tracking)

### 7. Create Execution Tasks

After the user approves the plan, create `TaskCreate` items for each sub-task from
the plan:

- Use clear descriptions and `activeForm` labels
- Set up `blockedBy` dependencies where sub-tasks must be sequential

### 8. Implement

Work through the sub-tasks in order:

- Mark each sub-task `in_progress` via `TaskUpdate` before starting it
- Mark each sub-task `completed` when done
- Follow all conventions in `CLAUDE.md`
- Keep changes minimal and focused on the task

After implementation is complete, stage all changes but do NOT commit yet.
This ensures review agents can see the full diff via `git diff HEAD`.

### 9. Test — Round 1

Use the `Agent` tool with `subagent_type: "test-specialist"` to write and run tests:

```
Write tests for the changes just implemented for the [task name] task
in project [project]. The following files were changed: [list changed files].
If test infrastructure (vitest) is not yet configured, set it up first.
Run all tests and fix any failures. Focus on the test scenarios from the
test plan that relate to this task.
```

Wait for the agent to finish and confirm all tests pass before proceeding.

### 10. Review — Conditional, Parallel

Run `git diff HEAD --name-only` to get the list of changed files, then launch the applicable reviewers in parallel:

**Always run code-reviewer** (every change needs bug/security review):

Use the `Agent` tool with `subagent_type: "code-reviewer"`:

```
Review the changes made for the [task name] task. The following files were
changed: [list changed files]. Check for bugs, security issues, TypeScript
strict mode violations, and jarvis convention violations per CLAUDE.md.
```

**Always run security-auditor** (every change needs security & exposure review):

Use the `Agent` tool with `subagent_type: "security-auditor"`:

```
Audit the changes made for the [task name] task. The following files were
changed: [list changed files]. Check for: hardcoded secrets, personal info
exposure, vault content leaks, path traversal risks, unsanitized input in
shell commands, and anything unsafe for the public GitHub remote.
```

**Run architecture-reviewer when applicable:**

Use the `Agent` tool with `subagent_type: "architecture-reviewer"` **if** the task involves new modules, changes to `src/ai/claude.ts`, changes to session management, new cron jobs, changes to `src/index.ts` startup/shutdown, new agent definitions, or changes to vault file operation patterns.

**Architecture reviewer is always run for Phase 4+ tasks** (scheduler, reviews, vault commands, nightly automation) since these phases wire new subsystems into the main process.

```
Review the changes made for the [task name] task. The following files were
changed: [list changed files]. Check for: vault boundary violations,
Claude CLI spawning patterns, session management correctness, cron job
safety, module boundary violations, graceful shutdown gaps, and
single-process resource concerns.
```

If a reviewer is not applicable, skip it and note "N/A — no relevant changes" in the completion summary.

### 11. Fix Review Issues

Collect findings from all reviewers. Address issues in priority order:

1. **Critical / BLOCK / ERROR** — fix all of these, no exceptions
2. **Warnings** — fix unless there's a clear reason to skip (explain why if skipping)
3. **Suggestions** — apply easy wins (< 5 min effort); skip the rest

If no issues were found, skip to step 12.

If any reviewer returns a BLOCK verdict, or fixing issues requires fundamentally
changing the approach, stop and report to the user with blocking findings and
a proposed alternative. Do NOT proceed until the user confirms.

### 12. Test — Round 2

Use the `Agent` tool with `subagent_type: "test-specialist"`:

```
Run all tests to verify the review fixes for [task name] didn't break
anything. The following files were changed: [list changed files].
Fix any failures.
```

Skip this step if no code changes were made in step 11.

If tests fail after two fix attempts, stop and report the failures to the
user. Do not loop indefinitely.

### 13. Simplify

Use the `Agent` tool with `subagent_type: "code-simplifier"`:

```
Check the changes made for the [task name] task for dead code,
over-abstractions, duplication, and unnecessary complexity.
```

The code-simplifier is read-only — it reports findings but cannot edit files.
After it finishes, apply its recommendations yourself:

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

### 15. Sync Docs

Use the `Agent` tool with `subagent_type: "docs-sync"`:

```
Scan the codebase for structural changes and update CLAUDE.md and project
docs to reflect the current state. Focus on: project structure tree,
agents table, environment variables, and npm scripts.
```

Skip this step if the task only changed existing file internals without adding new modules, commands, agents, config values, or scripts.

### 16. Complete

Mark the task done in the project's `tasks.md` by changing `- [ ]` to `- [x]` for the completed task.

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

### Next Task

- [next unchecked task from tasks.md, or "All tasks complete!"]
```

After outputting the summary, check `tasks.md` for the next unchecked task (`- [ ]`):

- **If a next task exists**: ask the user "Ready to start the next task: **[task name]**?" and if they confirm, loop back to **step 3** (Enter Plan Mode) with that task.
- **If no tasks remain**: tell the user all tasks for the project are complete and stop.
