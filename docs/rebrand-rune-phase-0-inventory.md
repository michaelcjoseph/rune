# Phase 0 Inventory and Allowlist

This artifact is intentionally grep-safe: the retired token is escaped as `j\u0061rvis` everywhere in this file. To reproduce the inventory, run the same commands with the literal retired token substituted for `<old-token>`.

## Source sweep

- Content command: `git grep -in -I <old-token>`.
- Occurrence command: `git grep -ino -I <old-token> | wc -l`.
- Pathname command: `git ls-files | rg -i <old-token>`.
- Tracked content result: 1996 matching lines, 2230 token occurrences, 383 files.
- Tracked pathname result: 11 paths.

## Classification summary

| Class | Token occurrences | Lines touched | Action |
| --- | ---: | ---: | --- |
| brand-rewrite | 850 | 785 | Rewrite prose, docs, prompts, comments, and user-facing brand text to Rune. |
| public-identifier | 1340 | 1203 | Rename or extract runtime/config/path/slug/CLI/MCP identifiers. |
| private-functional | 40 | 40 | Keep only where the exact launchd label appears. |
| excluded-filename | 0 | 0 | None in content. |

## Final acceptance allowlist

- Allow exactly the launchd label `com.j\u0061rvis.daemon` as a private functional identifier. Rationale: the launchd service label is machine-private and explicitly remains unchanged; only its path line changes during the disk cutover.
- Allow no committed `J\u0061RVIS_*` env-var names, no `j\u0061rvis-kb` MCP name, no CLI command or filename, no product slug, no branch prefix, no journal source label, and no hardcoded private checkout path.
- Excluded agent-definition filenames: none found.
- Acceptance rule: after the rewrite phases, any remaining tracked-content match for the retired token must contain the exact escaped form shown above when sanitized by this document. Any other match is a defect.

## Content inventory

Each row groups all token occurrences in one file that share the same class and rationale. One source line may appear in multiple rows when it contains both the kept launchd label and a separate token that must be rewritten or renamed.

| Class | File | Lines | Matched forms | Rationale |
| --- | --- | ---: | --- | --- |
| brand-rewrite | .claude/agents/architecture-reviewer.md | 16 | J\u0061rvis | agent or role prompt prose; edit body text only and preserve filenames unless listed in pathname inventory |
| brand-rewrite | .claude/agents/code-reviewer.md | 3 | J\u0061rvis | agent or role prompt prose; edit body text only and preserve filenames unless listed in pathname inventory |
| brand-rewrite | .claude/agents/code-simplifier.md | 16 | J\u0061rvis | agent or role prompt prose; edit body text only and preserve filenames unless listed in pathname inventory |
| brand-rewrite | .claude/agents/daily-content-updater.md | 13 | J\u0061rvis. | agent or role prompt prose; edit body text only and preserve filenames unless listed in pathname inventory |
| brand-rewrite | .claude/agents/docs-sync.md | 14, 16 | J\u0061rvis, J\u0061rvis. | agent or role prompt prose; edit body text only and preserve filenames unless listed in pathname inventory |
| brand-rewrite | .claude/agents/json-updater.md | 13 | J\u0061rvis. | agent or role prompt prose; edit body text only and preserve filenames unless listed in pathname inventory |
| brand-rewrite | .claude/agents/morning-prep.md | 12 | J\u0061rvis. | agent or role prompt prose; edit body text only and preserve filenames unless listed in pathname inventory |
| brand-rewrite | .claude/agents/observation-diarizer.md | 48 | J\u0061rvis | agent or role prompt prose; edit body text only and preserve filenames unless listed in pathname inventory |
| brand-rewrite | .claude/agents/observation-triage.md | 37, 48-49, 113 | J\u0061rvis | agent or role prompt prose; edit body text only and preserve filenames unless listed in pathname inventory |
| brand-rewrite | .claude/agents/playbook-proposer.md | 11 | J\u0061rvis. | agent or role prompt prose; edit body text only and preserve filenames unless listed in pathname inventory |
| brand-rewrite | .claude/agents/playbook-updater.md | 13 | J\u0061rvis. | agent or role prompt prose; edit body text only and preserve filenames unless listed in pathname inventory |
| brand-rewrite | .claude/agents/project-setup-writer.md | 3, 12, 33-34, 67 | J\u0061rvis, J\u0061rvis., non-J\u0061rvis | agent or role prompt prose; edit body text only and preserve filenames unless listed in pathname inventory |
| brand-rewrite | .claude/agents/project-updater.md | 14 | J\u0061rvis. | agent or role prompt prose; edit body text only and preserve filenames unless listed in pathname inventory |
| brand-rewrite | .claude/agents/proposal-updater.md | 13, 50, 108 | J\u0061rvis, J\u0061rvis. | agent or role prompt prose; edit body text only and preserve filenames unless listed in pathname inventory |
| brand-rewrite | .claude/agents/psychology-updater.md | 13 | J\u0061rvis. | agent or role prompt prose; edit body text only and preserve filenames unless listed in pathname inventory |
| brand-rewrite | .claude/agents/release-notes.md | 12 | J\u0061rvis. | agent or role prompt prose; edit body text only and preserve filenames unless listed in pathname inventory |
| brand-rewrite | .claude/agents/security-auditor.md | 16 | J\u0061rvis | agent or role prompt prose; edit body text only and preserve filenames unless listed in pathname inventory |
| brand-rewrite | .claude/agents/session-summarizer.md | 11 | J\u0061rvis. | agent or role prompt prose; edit body text only and preserve filenames unless listed in pathname inventory |
| brand-rewrite | .claude/agents/system-scanner.md | 11 | J\u0061rvis. | agent or role prompt prose; edit body text only and preserve filenames unless listed in pathname inventory |
| brand-rewrite | .claude/agents/test-specialist.md | 18 | J\u0061rvis | agent or role prompt prose; edit body text only and preserve filenames unless listed in pathname inventory |
| brand-rewrite | .claude/agents/workout-generator.md | 16 | J\u0061rvis. | agent or role prompt prose; edit body text only and preserve filenames unless listed in pathname inventory |
| brand-rewrite | .claude/agents/worldview-updater.md | 13 | J\u0061rvis. | agent or role prompt prose; edit body text only and preserve filenames unless listed in pathname inventory |
| brand-rewrite | .claude/skills/work/SKILL.md | 31 | J\u0061rvis | code comment, test description, or user-facing prose brand text |
| brand-rewrite | .codex/agents/architecture-reviewer.toml | 7 | J\u0061rvis | agent or role prompt prose; edit body text only and preserve filenames unless listed in pathname inventory |
| brand-rewrite | .codex/agents/code-reviewer.toml | 1 | J\u0061rvis | agent or role prompt prose; edit body text only and preserve filenames unless listed in pathname inventory |
| brand-rewrite | .codex/agents/code-simplifier.toml | 7 | J\u0061rvis | agent or role prompt prose; edit body text only and preserve filenames unless listed in pathname inventory |
| brand-rewrite | .codex/agents/daily-content-updater.toml | 3 | J\u0061rvis. | agent or role prompt prose; edit body text only and preserve filenames unless listed in pathname inventory |
| brand-rewrite | .codex/agents/docs-sync.toml | 3, 5 | J\u0061rvis, J\u0061rvis. | agent or role prompt prose; edit body text only and preserve filenames unless listed in pathname inventory |
| brand-rewrite | .codex/agents/json-updater.toml | 3 | J\u0061rvis. | agent or role prompt prose; edit body text only and preserve filenames unless listed in pathname inventory |
| brand-rewrite | .codex/agents/morning-prep.toml | 3 | J\u0061rvis. | agent or role prompt prose; edit body text only and preserve filenames unless listed in pathname inventory |
| brand-rewrite | .codex/agents/playbook-proposer.toml | 3 | J\u0061rvis. | agent or role prompt prose; edit body text only and preserve filenames unless listed in pathname inventory |
| brand-rewrite | .codex/agents/playbook-updater.toml | 3 | J\u0061rvis. | agent or role prompt prose; edit body text only and preserve filenames unless listed in pathname inventory |
| brand-rewrite | .codex/agents/project-setup-writer.toml | 1, 3, 5, 7 | J\u0061rvis | agent or role prompt prose; edit body text only and preserve filenames unless listed in pathname inventory |
| brand-rewrite | .codex/agents/project-updater.toml | 3 | J\u0061rvis. | agent or role prompt prose; edit body text only and preserve filenames unless listed in pathname inventory |
| brand-rewrite | .codex/agents/proposal-updater.toml | 3, 40, 98 | J\u0061rvis, J\u0061rvis. | agent or role prompt prose; edit body text only and preserve filenames unless listed in pathname inventory |
| brand-rewrite | .codex/agents/psychology-updater.toml | 3 | J\u0061rvis. | agent or role prompt prose; edit body text only and preserve filenames unless listed in pathname inventory |
| brand-rewrite | .codex/agents/release-notes.toml | 3 | J\u0061rvis. | agent or role prompt prose; edit body text only and preserve filenames unless listed in pathname inventory |
| brand-rewrite | .codex/agents/security-auditor.toml | 7 | J\u0061rvis | agent or role prompt prose; edit body text only and preserve filenames unless listed in pathname inventory |
| brand-rewrite | .codex/agents/session-summarizer.toml | 3 | J\u0061rvis. | agent or role prompt prose; edit body text only and preserve filenames unless listed in pathname inventory |
| brand-rewrite | .codex/agents/system-scanner.toml | 3 | J\u0061rvis. | agent or role prompt prose; edit body text only and preserve filenames unless listed in pathname inventory |
| brand-rewrite | .codex/agents/test-specialist.toml | 7 | J\u0061rvis | agent or role prompt prose; edit body text only and preserve filenames unless listed in pathname inventory |
| brand-rewrite | .codex/agents/workout-generator.toml | 3 | J\u0061rvis. | agent or role prompt prose; edit body text only and preserve filenames unless listed in pathname inventory |
| brand-rewrite | .codex/agents/worldview-updater.toml | 3 | J\u0061rvis. | agent or role prompt prose; edit body text only and preserve filenames unless listed in pathname inventory |
| brand-rewrite | .env.example | 5 | J\u0061rvis | code comment, test description, or user-facing prose brand text |
| brand-rewrite | agents/coder/SOUL.md | 3, 11, 47 | J\u0061rvis | agent or role prompt prose; edit body text only and preserve filenames unless listed in pathname inventory |
| brand-rewrite | agents/designer/SOUL.md | 3, 51 | J\u0061rvis | agent or role prompt prose; edit body text only and preserve filenames unless listed in pathname inventory |
| brand-rewrite | agents/pm/SOUL.md | 3, 63 | J\u0061rvis | agent or role prompt prose; edit body text only and preserve filenames unless listed in pathname inventory |
| brand-rewrite | agents/qa/SOUL.md | 3, 52 | J\u0061rvis | agent or role prompt prose; edit body text only and preserve filenames unless listed in pathname inventory |
| brand-rewrite | agents/reviewer/SOUL.md | 3, 50 | J\u0061rvis | agent or role prompt prose; edit body text only and preserve filenames unless listed in pathname inventory |
| brand-rewrite | agents/tech-lead/SOUL.md | 3, 66 | J\u0061rvis | agent or role prompt prose; edit body text only and preserve filenames unless listed in pathname inventory |
| brand-rewrite | CLAUDE.md | 1, 20, 22, 25, 29, 33, 47, 140, 160, 162, 164, 215, 232, 283, 314, 436, 465 | j\u0061rvis, J\u0061rvis, j\u0061rvis.ts | docs/prose/metadata brand text |
| brand-rewrite | cli/j\u0061rvis.test.ts | 110, 121, 130, 141 | J\u0061rvis | code comment, test description, or user-facing prose brand text |
| brand-rewrite | cli/j\u0061rvis.ts | 19 | J\u0061rvis | code comment, test description, or user-facing prose brand text |
| brand-rewrite | docs/index.md | 1, 5 | J\u0061rvis | docs/prose/metadata brand text |
| brand-rewrite | docs/projects/01-mvp/spec.md | 1, 5, 14, 238, 275 | J\u0061rvis, j\u0061rvis/.claude/agents/ | docs/prose/metadata brand text |
| brand-rewrite | docs/projects/01-mvp/tasks.md | 1 | J\u0061rvis | docs/prose/metadata brand text |
| brand-rewrite | docs/projects/01-mvp/test-plan.md | 1 | J\u0061rvis | docs/prose/metadata brand text |
| brand-rewrite | docs/projects/03-resolver/spec.md | 5, 7, 25-27, 29, 92, 163, 166, 378 | J\u0061rvis | docs/prose/metadata brand text |
| brand-rewrite | docs/projects/03-resolver/tasks.md | 28 | J\u0061rvis | docs/prose/metadata brand text |
| brand-rewrite | docs/projects/03-resolver/test-plan.md | 32, 69, 165 | J\u0061rvis | docs/prose/metadata brand text |
| brand-rewrite | docs/projects/04-custom-workouts/spec.md | 156 | J\u0061rvis | docs/prose/metadata brand text |
| brand-rewrite | docs/projects/04-custom-workouts/test-plan.md | 58, 109 | J\u0061rvis | docs/prose/metadata brand text |
| brand-rewrite | docs/projects/05-library-into-kb/spec.md | 31, 161 | J\u0061rvis | docs/prose/metadata brand text |
| brand-rewrite | docs/projects/05-library-into-kb/test-plan.md | 126 | J\u0061rvis | docs/prose/metadata brand text |
| brand-rewrite | docs/projects/06-webview/spec.md | 5, 7, 11, 15, 23, 29, 221, 224, 257, 332, 340, 342, 356, 368, 380, 628-629 | J\u0061rvis | docs/prose/metadata brand text |
| brand-rewrite | docs/projects/06-webview/tasks.md | 84, 90, 114, 116, 126, 137, 144 | j\u0061rvis, J\u0061rvis | docs/prose/metadata brand text |
| brand-rewrite | docs/projects/06-webview/test-plan.md | 186-187, 191-192 | J\u0061rvis, J\u0061rvis. | docs/prose/metadata brand text |
| brand-rewrite | docs/projects/07-spaced-repetition/spec.md | 5, 7, 44, 119, 184-187, 246, 266, 306, 329 | J\u0061rvis, J\u0061rvis. | docs/prose/metadata brand text |
| brand-rewrite | docs/projects/07-spaced-repetition/tasks.md | 33-34 | J\u0061rvis | docs/prose/metadata brand text |
| brand-rewrite | docs/projects/08-intent-layer/agent-lessons.md | 179 | J\u0061rvis | docs/prose/metadata brand text |
| brand-rewrite | docs/projects/08-intent-layer/egress-deferral.md | 49, 51-52 | J\u0061rvis | docs/prose/metadata brand text |
| brand-rewrite | docs/projects/08-intent-layer/spec.md | 5, 7, 9, 15, 20-21, 29, 48, 53, 61, 68, 74, 86, 156, 172, 178, 182, 188, 200, 206, 208, 224, 260, 363, 369, 422, 428, 500, 502, 508-510, 520, 532, 543, 553, 565, 569, 601, 626, 628 | j\u0061rvis, J\u0061rvis, J\u0061rvis. | docs/prose/metadata brand text |
| brand-rewrite | docs/projects/08-intent-layer/tasks.md | 64, 176, 183, 572-573 | J\u0061rvis | docs/prose/metadata brand text |
| brand-rewrite | docs/projects/08-intent-layer/test-plan.md | 214, 219, 273, 304-305, 309, 315, 336, 413 | J\u0061rvis | docs/prose/metadata brand text |
| brand-rewrite | docs/projects/09-expand-cockpit/spec.md | 30, 109, 139, 143, 166, 178 | j\u0061rvis, J\u0061rvis | docs/prose/metadata brand text |
| brand-rewrite | docs/projects/09-expand-cockpit/tasks.md | 85 | J\u0061rvis | docs/prose/metadata brand text |
| brand-rewrite | docs/projects/09-expand-cockpit/test-plan.md | 5 | j\u0061rvis | docs/prose/metadata brand text |
| brand-rewrite | docs/projects/10-j\u0061rvis-identity-refactor/spec.md | 1, 10, 13, 21, 34, 57, 59, 61, 75, 92-93, 100, 103, 127, 139, 143, 145-146, 162-163, 174, 177, 180, 192, 202, 214, 216, 226 | j\u0061rvis, J\u0061rvis, j\u0061rvis., j\u0061rvis/AGENTS.md, j\u0061rvis/bin/compile-instructions, j\u0061rvis/CLAUDE.md | docs/prose/metadata brand text |
| brand-rewrite | docs/projects/10-j\u0061rvis-identity-refactor/tasks.md | 1, 8, 32-34, 37, 39-40, 47, 61, 64, 89 | j\u0061rvis, J\u0061rvis, j\u0061rvis/CLAUDE.md | docs/prose/metadata brand text |
| brand-rewrite | docs/projects/10-j\u0061rvis-identity-refactor/test-plan.md | 1, 22, 25, 30, 38-39, 41, 49, 66, 68 | j\u0061rvis, J\u0061rvis, j\u0061rvis., j\u0061rvis/CLAUDE.md | docs/prose/metadata brand text |
| brand-rewrite | docs/projects/12-writer-memory/spec.md | 23, 33, 48, 65, 129, 291 | j\u0061rvis, j\u0061rvis/agents/writer/ | docs/prose/metadata brand text |
| brand-rewrite | docs/projects/12-writer-memory/tasks.md | 33, 108 | j\u0061rvis, j\u0061rvis/agents/writer/SOUL.md | docs/prose/metadata brand text |
| brand-rewrite | docs/projects/12-writer-memory/test-plan.md | 74 | j\u0061rvis | docs/prose/metadata brand text |
| brand-rewrite | docs/projects/13-work-run-monitoring/spec.md | 6, 11, 48, 68, 187, 456 | J\u0061rvis | docs/prose/metadata brand text |
| brand-rewrite | docs/projects/13-work-run-monitoring/tasks.md | 29 | J\u0061rvis | docs/prose/metadata brand text |
| brand-rewrite | docs/projects/13-work-run-monitoring/test-plan.md | 13, 65 | J\u0061rvis | docs/prose/metadata brand text |
| brand-rewrite | docs/projects/14-product-team-agents/autonomous-dispatch-deferral.md | 58 | J\u0061rvis | docs/prose/metadata brand text |
| brand-rewrite | docs/projects/14-product-team-agents/context.md | 4, 33 | J\u0061rvis | docs/prose/metadata brand text |
| brand-rewrite | docs/projects/14-product-team-agents/spec.md | 26, 31, 36, 53, 63, 150, 159, 201, 208, 223, 244, 248, 274, 298, 332, 464, 511, 515-516, 518, 521, 523, 526, 529, 531, 561, 567, 569, 607, 653, 662, 688, 732, 752, 769, 777, 806, 819, 831, 1160, 1245, 1357, 1401, 1404 | J\u0061rvis | docs/prose/metadata brand text |
| brand-rewrite | docs/projects/14-product-team-agents/tasks.md | 54, 110, 207, 216, 877, 912, 1111 | J\u0061rvis | docs/prose/metadata brand text |
| brand-rewrite | docs/projects/14-product-team-agents/test-plan.md | 34, 62, 75, 118, 230, 309, 373, 375, 378-379, 388 | J\u0061rvis | docs/prose/metadata brand text |
| brand-rewrite | docs/projects/15-work-run-finalizer/spec.md | 15, 69, 117, 227, 322, 427 | j\u0061rvis, J\u0061rvis | docs/prose/metadata brand text |
| brand-rewrite | docs/projects/15-work-run-finalizer/tasks.md | 16, 222, 315, 318, 395, 402 | j\u0061rvis, J\u0061rvis | docs/prose/metadata brand text |
| brand-rewrite | docs/projects/15-work-run-finalizer/test-plan.md | 15, 123 | J\u0061rvis | docs/prose/metadata brand text |
| brand-rewrite | docs/projects/16-claude-app-connector/app-project-instructions.md | 1, 5, 41 | J\u0061rvis | docs/prose/metadata brand text |
| brand-rewrite | docs/projects/16-claude-app-connector/context.md | 1, 4, 11, 20, 27, 30, 32-34, 36 | J\u0061rvis, j\u0061rvis/src/ai/claude.ts, j\u0061rvis/src/bot/commands/fresh.ts, j\u0061rvis/src/kb/queue.ts, j\u0061rvis/src/mcp/index.ts, j\u0061rvis/src/mcp/server.ts, j\u0061rvis/src/server/auth.ts, j\u0061rvis/src/server/http.ts, j\u0061rvis/src/vault/, j\u0061rvis/src/vault/sessions.ts | docs/prose/metadata brand text |
| brand-rewrite | docs/projects/16-claude-app-connector/e2e-acceptance-test.md | 8 | J\u0061rvis | docs/prose/metadata brand text |
| brand-rewrite | docs/projects/16-claude-app-connector/spec.md | 1, 9, 12, 18, 22-23, 29, 41, 71, 127 | J\u0061rvis | docs/prose/metadata brand text |
| brand-rewrite | docs/projects/16-claude-app-connector/tasks.md | 1 | J\u0061rvis | docs/prose/metadata brand text |
| brand-rewrite | docs/projects/16-claude-app-connector/tech-spec.md | 1, 4, 6-8, 10 | J\u0061rvis, j\u0061rvis/src/ai/claude.ts, j\u0061rvis/src/bot/commands/fresh.ts, j\u0061rvis/src/kb/queue.ts, j\u0061rvis/src/mcp/index.ts, j\u0061rvis/src/mcp/server.ts, j\u0061rvis/src/server/auth.ts, j\u0061rvis/src/server/http.ts, j\u0061rvis/src/vault/, j\u0061rvis/src/vault/sessions.ts | docs/prose/metadata brand text |
| brand-rewrite | docs/projects/16-claude-app-connector/test-plan.md | 1 | J\u0061rvis | docs/prose/metadata brand text |
| brand-rewrite | docs/projects/16-claude-app-connector/tunnel-runbook.md | 57, 79, 124-126, 129, 164 | J\u0061rvis, J\u0061rvis. | docs/prose/metadata brand text |
| brand-rewrite | docs/projects/17-cockpit-redesign/context.md | 1, 4, 9, 14, 21, 282, 305 | J\u0061rvis | docs/prose/metadata brand text |
| brand-rewrite | docs/projects/17-cockpit-redesign/spec.md | 5, 10, 31, 468, 488 | e2e-acceptance-on-j\u0061rvis, J\u0061rvis | docs/prose/metadata brand text |
| brand-rewrite | docs/projects/17-cockpit-redesign/tasks.md | 116 | e2e-acceptance-on-j\u0061rvis, J\u0061rvis | docs/prose/metadata brand text |
| brand-rewrite | docs/projects/17-cockpit-redesign/tech-spec.md | 258 | J\u0061rvis | docs/prose/metadata brand text |
| brand-rewrite | docs/projects/18-rebrand-j\u0061rvis-to-rune/context.md | 4, 20, 112 | j\u0061rvis, J\u0061rvis | docs/prose/metadata brand text |
| brand-rewrite | docs/projects/18-rebrand-j\u0061rvis-to-rune/examples/qa.md | 9 | j\u0061rvis | docs/prose/metadata brand text |
| brand-rewrite | docs/projects/18-rebrand-j\u0061rvis-to-rune/spec.md | 1, 20, 158, 300 | j\u0061rvis, J\u0061rvis | docs/prose/metadata brand text |
| brand-rewrite | docs/projects/18-rebrand-j\u0061rvis-to-rune/tasks.md | 1 | J\u0061rvis | docs/prose/metadata brand text |
| brand-rewrite | docs/projects/18-rebrand-j\u0061rvis-to-rune/tech-spec.md | 1, 93 | j\u0061rvis, J\u0061rvis | docs/prose/metadata brand text |
| brand-rewrite | docs/projects/18-rebrand-j\u0061rvis-to-rune/test-plan.md | 1, 3, 25 | j\u0061rvis, J\u0061rvis | docs/prose/metadata brand text |
| brand-rewrite | docs/projects/bugs.md | 4, 32, 105, 133, 215, 222 | j\u0061rvis, J\u0061rvis, j\u0061rvis., j\u0061rvis.log:45807 | docs/prose/metadata brand text |
| brand-rewrite | docs/projects/ideas.md | 18, 21, 28, 32, 34, 44, 56-57 | J\u0061rvis | docs/prose/metadata brand text |
| brand-rewrite | docs/projects/index.md | 3, 16, 18, 22, 24-26, 114, 116, 120, 141, 149, 152, 180, 182, 185, 198, 206, 222, 227, 234, 242, 282, 295, 311, 341, 356, 371 | j\u0061rvis, J\u0061rvis, j\u0061rvis., j\u0061rvis/agents/writer/, j\u0061rvis/CLAUDE.md | docs/prose/metadata brand text |
| brand-rewrite | docs/projects/templates/spec.md | 5, 9 | J\u0061rvis, J\u0061rvis.] | docs/prose/metadata brand text |
| brand-rewrite | evals/README.md | 1 | J\u0061rvis | docs/prose/metadata brand text |
| brand-rewrite | policies/escalation-policy.json | 2 | J\u0061rvis | code comment, test description, or user-facing prose brand text |
| brand-rewrite | README.md | 1, 11, 132, 154, 198, 220, 402, 410, 415, 436 | j\u0061rvis, J\u0061rvis | docs/prose/metadata brand text |
| brand-rewrite | src/ai/claude.ts | 46, 52, 255, 497, 504, 510-511, 555 | J\u0061rvis, j\u0061rvisPath | code comment, test description, or user-facing prose brand text |
| brand-rewrite | src/ai/codex.ts | 57, 191, 194 | J\u0061rvis | code comment, test description, or user-facing prose brand text |
| brand-rewrite | src/bot/commands/approve.ts | 63 | J\u0061rvis | code comment, test description, or user-facing prose brand text |
| brand-rewrite | src/bot/handlers/text.test.ts | 298-299, 409, 423, 1346, 1365 | j\u0061rvis, j\u0061rvis/i | code comment, test description, or user-facing prose brand text |
| brand-rewrite | src/bot/handlers/text.ts | 600, 602, 634 | J\u0061rvis | code comment, test description, or user-facing prose brand text |
| brand-rewrite | src/bot/handlers/url.ts | 64 | J\u0061rvis/1.0 | code comment, test description, or user-facing prose brand text |
| brand-rewrite | src/bot/skill-registry.test.ts | 104, 178 | J\u0061rvis | code comment, test description, or user-facing prose brand text |
| brand-rewrite | src/bot/skill-registry.ts | 158, 225 | J\u0061rvis | code comment, test description, or user-facing prose brand text |
| brand-rewrite | src/config.ts | 182 | j\u0061rvis | code comment, test description, or user-facing prose brand text |
| brand-rewrite | src/index.ts | 294 | J\u0061rvis | code comment, test description, or user-facing prose brand text |
| brand-rewrite | src/intent/agent-def.ts | 4, 42, 155 | J\u0061rvis | code comment, test description, or user-facing prose brand text |
| brand-rewrite | src/intent/backlog-id.test.ts | 119, 123, 135 | j\u0061rvis, j\u0061rvisItem | code comment, test description, or user-facing prose brand text |
| brand-rewrite | src/intent/backlog-reader.test.ts | 125-126, 130-132, 207-210, 228, 233, 252-253, 309, 312, 337, 339, 354-355, 358 | j\u0061rvis.bugs, j\u0061rvis.bugs.map, j\u0061rvis.bugs[1], j\u0061rvis.fileWarnings, j\u0061rvis.fileWarnings.map, j\u0061rvis.ideas, j\u0061rvis.ideas.map, j\u0061rvis.notRepoBacked | code comment, test description, or user-facing prose brand text |
| brand-rewrite | src/intent/backlog-write-lock.ts | 42 | J\u0061rvis | code comment, test description, or user-facing prose brand text |
| brand-rewrite | src/intent/escalation.ts | 2, 6 | J\u0061rvis | code comment, test description, or user-facing prose brand text |
| brand-rewrite | src/intent/finalizer-handoff.ts | 4 | J\u0061rvis | code comment, test description, or user-facing prose brand text |
| brand-rewrite | src/intent/gate-learning.test.ts | 6 | J\u0061rvis | code comment, test description, or user-facing prose brand text |
| brand-rewrite | src/intent/gate-learning.ts | 7, 26, 34, 58 | J\u0061rvis | code comment, test description, or user-facing prose brand text |
| brand-rewrite | src/intent/journal-intent-e2e.test.ts | 81 | j\u0061rvis | code comment, test description, or user-facing prose brand text |
| brand-rewrite | src/intent/observation-callbacks.test.ts | 120, 126 | J\u0061rvis | code comment, test description, or user-facing prose brand text |
| brand-rewrite | src/intent/observation-loop.test.ts | 10 | J\u0061rvis | code comment, test description, or user-facing prose brand text |
| brand-rewrite | src/intent/observation-loop.ts | 2 | J\u0061rvis | code comment, test description, or user-facing prose brand text |
| brand-rewrite | src/intent/observation-sensor-readers.ts | 193, 200 | J\u0061rvis | code comment, test description, or user-facing prose brand text |
| brand-rewrite | src/intent/observation-sensor.test.ts | 12 | J\u0061rvis | code comment, test description, or user-facing prose brand text |
| brand-rewrite | src/intent/observation-sensor.ts | 4, 9, 22 | J\u0061rvis | code comment, test description, or user-facing prose brand text |
| brand-rewrite | src/intent/orch-reconstruct.ts | 4 | J\u0061rvis | code comment, test description, or user-facing prose brand text |
| brand-rewrite | src/intent/orch-run-record.ts | 4 | J\u0061rvis | code comment, test description, or user-facing prose brand text |
| brand-rewrite | src/intent/planner.ts | 144, 168 | J\u0061rvis, J\u0061rvis. | code comment, test description, or user-facing prose brand text |
| brand-rewrite | src/intent/planning-critique.ts | 10 | J\u0061rvis | code comment, test description, or user-facing prose brand text |
| brand-rewrite | src/intent/planning-roles-wiring.test.ts | 141 | J\u0061rvis | code comment, test description, or user-facing prose brand text |
| brand-rewrite | src/intent/planning-roles-wiring.ts | 496 | J\u0061rvis | code comment, test description, or user-facing prose brand text |
| brand-rewrite | src/intent/planning-roles.test.ts | 12 | J\u0061rvis | code comment, test description, or user-facing prose brand text |
| brand-rewrite | src/intent/planning-roles.ts | 11 | J\u0061rvis | code comment, test description, or user-facing prose brand text |
| brand-rewrite | src/intent/postmortem.ts | 8, 66 | J\u0061rvis | code comment, test description, or user-facing prose brand text |
| brand-rewrite | src/intent/project-context.ts | 8, 105 | J\u0061rvis | code comment, test description, or user-facing prose brand text |
| brand-rewrite | src/intent/project-orchestrator.test.ts | 1398, 1471 | J\u0061rvis | code comment, test description, or user-facing prose brand text |
| brand-rewrite | src/intent/project-orchestrator.ts | 4 | J\u0061rvis | code comment, test description, or user-facing prose brand text |
| brand-rewrite | src/intent/promotions.test.ts | 10 | J\u0061rvis | code comment, test description, or user-facing prose brand text |
| brand-rewrite | src/intent/promotions.ts | 6 | J\u0061rvis | code comment, test description, or user-facing prose brand text |
| brand-rewrite | src/intent/registry.test.ts | 90, 100, 122 | j\u0061rvis, j\u0061rvis.projects.map | code comment, test description, or user-facing prose brand text |
| brand-rewrite | src/intent/sandbox.test.ts | 163 | J\u0061rvis | code comment, test description, or user-facing prose brand text |
| brand-rewrite | src/intent/sandbox.ts | 175 | J\u0061rvis | code comment, test description, or user-facing prose brand text |
| brand-rewrite | src/intent/scaffold-target.test.ts | 7, 12, 53, 59, 94, 97-98 | j\u0061rvis, J\u0061rvis, j\u0061rvis.cwd, j\u0061rvis.writableDirs | code comment, test description, or user-facing prose brand text |
| brand-rewrite | src/intent/scaffold-target.ts | 5, 10, 19, 82 | J\u0061rvis | code comment, test description, or user-facing prose brand text |
| brand-rewrite | src/intent/supervision-quiet.test.ts | 114 | j\u0061rvis/11-work-run-observability | code comment, test description, or user-facing prose brand text |
| brand-rewrite | src/intent/supervision.ts | 345 | J\u0061rvis | code comment, test description, or user-facing prose brand text |
| brand-rewrite | src/intent/team-task-workflow.test.ts | 12 | J\u0061rvis | code comment, test description, or user-facing prose brand text |
| brand-rewrite | src/intent/team-task-workflow.ts | 20, 253 | J\u0061rvis | code comment, test description, or user-facing prose brand text |
| brand-rewrite | src/jobs/__acceptance__/orchestrated-live.acceptance.ts | 186, 337, 342-343, 443 | J\u0061rvis, j\u0061rvis.local | code comment, test description, or user-facing prose brand text |
| brand-rewrite | src/jobs/credential-injector.ts | 14, 16, 142 | in-J\u0061rvis, J\u0061rvis | code comment, test description, or user-facing prose brand text |
| brand-rewrite | src/jobs/dispatch-runtime.ts | 11, 13, 24, 117, 230 | in-J\u0061rvis, J\u0061rvis | code comment, test description, or user-facing prose brand text |
| brand-rewrite | src/jobs/execution-agent.test.ts | 70, 320 | /tmp/test-j\u0061rvis, /tmp/test-j\u0061rvis/private/file.md | code comment, test description, or user-facing prose brand text |
| brand-rewrite | src/jobs/gen-eval-loop-runner.ts | 273 | j\u0061rvis | code comment, test description, or user-facing prose brand text |
| brand-rewrite | src/jobs/nightly.ts | 592 | j\u0061rvis | code comment, test description, or user-facing prose brand text |
| brand-rewrite | src/jobs/orchestrated-work-runner.ts | 356, 1118 | j\u0061rvis | code comment, test description, or user-facing prose brand text |
| brand-rewrite | src/jobs/recovery-finalize-runner.ts | 358 | j\u0061rvis | code comment, test description, or user-facing prose brand text |
| brand-rewrite | src/jobs/registry-rebuild.test.ts | 75-76 | j\u0061rvis.projectsIndex, j\u0061rvis.taskProgress | code comment, test description, or user-facing prose brand text |
| brand-rewrite | src/jobs/sandbox-fs.ts | 7 | J\u0061rvis | code comment, test description, or user-facing prose brand text |
| brand-rewrite | src/jobs/sandbox-runtime.test.ts | 262, 264, 266 | J\u0061rvis | code comment, test description, or user-facing prose brand text |
| brand-rewrite | src/jobs/sandbox-runtime.ts | 407 | J\u0061rvis | code comment, test description, or user-facing prose brand text |
| brand-rewrite | src/jobs/scaffold-approval.ts | 12 | j\u0061rvis | code comment, test description, or user-facing prose brand text |
| brand-rewrite | src/jobs/scheduler.test.ts | 232 | J\u0061rvis | code comment, test description, or user-facing prose brand text |
| brand-rewrite | src/jobs/scheduler.ts | 170 | J\u0061rvis | code comment, test description, or user-facing prose brand text |
| brand-rewrite | src/jobs/supervision-recovery.test.ts | 239 | J\u0061rvis | code comment, test description, or user-facing prose brand text |
| brand-rewrite | src/jobs/supervision-recovery.ts | 4 | J\u0061rvis | code comment, test description, or user-facing prose brand text |
| brand-rewrite | src/jobs/supervision-store.ts | 15, 73, 114 | J\u0061rvis | code comment, test description, or user-facing prose brand text |
| brand-rewrite | src/jobs/team-task-deps.postmortem-gate.test.ts | 4 | J\u0061rvis | code comment, test description, or user-facing prose brand text |
| brand-rewrite | src/jobs/work-run-classify.test.ts | 343 | J\u0061rvis | code comment, test description, or user-facing prose brand text |
| brand-rewrite | src/jobs/work-run-classify.ts | 54, 330 | J\u0061rvis | code comment, test description, or user-facing prose brand text |
| brand-rewrite | src/jobs/work-run-finalizer.ts | 505 | j\u0061rvis | code comment, test description, or user-facing prose brand text |
| brand-rewrite | src/jobs/work-run-gate-runtime.ts | 127, 155 | J\u0061rvis | code comment, test description, or user-facing prose brand text |
| brand-rewrite | src/jobs/work-run-gc.test.ts | 278, 310, 313, 315 | j\u0061rvis, j\u0061rvisPrune, run-j\u0061rvis | code comment, test description, or user-facing prose brand text |
| brand-rewrite | src/jobs/work-run-gc.ts | 51, 244 | j\u0061rvis | code comment, test description, or user-facing prose brand text |
| brand-rewrite | src/jobs/work-run-merge-lock.ts | 15-17, 21 | J\u0061rvis | code comment, test description, or user-facing prose brand text |
| brand-rewrite | src/jobs/work-run-release.ts | 506 | j\u0061rvis | code comment, test description, or user-facing prose brand text |
| brand-rewrite | src/jobs/work-runner.test.ts | 482, 1143 | J\u0061rvis, j\u0061rvis. | code comment, test description, or user-facing prose brand text |
| brand-rewrite | src/jobs/work-runner.ts | 416, 850 | j\u0061rvis, J\u0061rvis | code comment, test description, or user-facing prose brand text |
| brand-rewrite | src/mcp/server.ts | 59, 270, 277 | createJ\u0061rvisMcpServer:, J\u0061rvis | code comment, test description, or user-facing prose brand text |
| brand-rewrite | src/reviews/interview.ts | 136, 415, 417, 457 | J\u0061rvis | code comment, test description, or user-facing prose brand text |
| brand-rewrite | src/reviews/new-project.test.ts | 126, 160, 314 | J\u0061rvis | code comment, test description, or user-facing prose brand text |
| brand-rewrite | src/reviews/new-project.ts | 16, 43, 80, 97, 114 | J\u0061rvis | code comment, test description, or user-facing prose brand text |
| brand-rewrite | src/reviews/planning.ts | 9 | J\u0061rvis | code comment, test description, or user-facing prose brand text |
| brand-rewrite | src/roles/commit.ts | 6, 43 | j\u0061rvis | code comment, test description, or user-facing prose brand text |
| brand-rewrite | src/roles/loader.ts | 14, 45 | j\u0061rvis | code comment, test description, or user-facing prose brand text |
| brand-rewrite | src/server/__acceptance__/cockpit-real-product.acceptance.ts | 3, 16, 33, 152-153, 388, 394 | j\u0061rvis, J\u0061rvis, j\u0061rvisPulse, j\u0061rvisPulse.repoBacked, MUTATE_REAL_J\u0061RVIS | code comment, test description, or user-facing prose brand text |
| brand-rewrite | src/server/http.ts | 98 | J\u0061rvis | code comment, test description, or user-facing prose brand text |
| brand-rewrite | src/server/mcp-oauth.ts | 300, 302, 304 | J\u0061rvis | code comment, test description, or user-facing prose brand text |
| brand-rewrite | src/server/restart.ts | 10 | J\u0061rvis | code comment, test description, or user-facing prose brand text |
| brand-rewrite | src/server/static/app.css | 1 | J\u0061rvis | code comment, test description, or user-facing prose brand text |
| brand-rewrite | src/server/static/app.js | 1, 99, 214, 224 | J\u0061rvis, window.j\u0061rvisConnectionStatus, window.j\u0061rvisSendWebviewMessage | code comment, test description, or user-facing prose brand text |
| brand-rewrite | src/server/static/client-view.js | 120 | window.j\u0061rvisClientRouter | code comment, test description, or user-facing prose brand text |
| brand-rewrite | src/server/static/home-view-client.test.ts | 262, 280 | .window.j\u0061rvisConnectionStatus, j\u0061rvisConnectionStatus: | code comment, test description, or user-facing prose brand text |
| brand-rewrite | src/server/static/home-view.js | 221 | window.j\u0061rvisConnectionStatus | code comment, test description, or user-facing prose brand text |
| brand-rewrite | src/server/static/index.html | 8, 15, 71 | J\u0061rvis | code comment, test description, or user-facing prose brand text |
| brand-rewrite | src/server/static/product-deep-view-client.test.ts | 1578, 1595 | .window.j\u0061rvisSendWebviewMessage, j\u0061rvisSendWebviewMessage: | code comment, test description, or user-facing prose brand text |
| brand-rewrite | src/server/static/product-deep-view.js | 537-538 | window.j\u0061rvisSendWebviewMessage | code comment, test description, or user-facing prose brand text |
| brand-rewrite | src/server/webview.test.ts | 534, 536-537, 557, 560, 570, 581 | j\u0061rvis, j\u0061rvis.projects[0].taskProgress, non-j\u0061rvis | code comment, test description, or user-facing prose brand text |
| brand-rewrite | src/server/webview.ts | 234-236, 246, 252, 549 | j\u0061rvis, J\u0061rvis, j\u0061rvis.projects | code comment, test description, or user-facing prose brand text |
| brand-rewrite | src/transport/mutations.ts | 35, 293, 480 | J\u0061rvis | code comment, test description, or user-facing prose brand text |
| brand-rewrite | src/transport/op-labels.test.ts | 40 | j\u0061rvis | code comment, test description, or user-facing prose brand text |
| brand-rewrite | src/transport/sender.test.ts | 233 | j\u0061rvis/demo | code comment, test description, or user-facing prose brand text |
| brand-rewrite | src/transport/telegram-ux.test.ts | 71 | J\u0061rvis | code comment, test description, or user-facing prose brand text |
| brand-rewrite | src/utils/intent-log.test.ts | 115 | J\u0061rvis | code comment, test description, or user-facing prose brand text |
| brand-rewrite | src/utils/intent-log.ts | 35 | J\u0061rvis | code comment, test description, or user-facing prose brand text |
| brand-rewrite | src/utils/logger.test.ts | 57 | j\u0061rvis.log | code comment, test description, or user-facing prose brand text |
| brand-rewrite | src/utils/logger.ts | 9 | j\u0061rvis.log | code comment, test description, or user-facing prose brand text |
| brand-rewrite | src/utils/observation-log.ts | 13 | J\u0061rvis | code comment, test description, or user-facing prose brand text |
| brand-rewrite | src/utils/sanitize-paths.ts | 2 | J\u0061rvis | code comment, test description, or user-facing prose brand text |
| brand-rewrite | src/vault/sessions.test.ts | 186, 190-192, 194, 200, 238, 250-252, 264-265, 270, 274, 289, 291-293, 298-300, 304, 306, 313, 319, 344-345, 349, 361-362, 373, 386, 393 | ...j\u0061rvisContext, j\u0061rvis, J\u0061rvis, j\u0061rvis/i, j\u0061rvisContext, j\u0061rvisContext:, j\u0061rvisScope, j\u0061rvisWeb, j\u0061rvisWeb.sessionId | code comment, test description, or user-facing prose brand text |
| brand-rewrite | src/writer/capture.ts | 162 | J\u0061rvis | code comment, test description, or user-facing prose brand text |
| brand-rewrite | src/writer/commit.ts | 5, 38 | j\u0061rvis | code comment, test description, or user-facing prose brand text |
| brand-rewrite | src/writer/memory.ts | 13, 27 | j\u0061rvis | code comment, test description, or user-facing prose brand text |
| brand-rewrite | src/writer/soul.test.ts | 5 | j\u0061rvis | code comment, test description, or user-facing prose brand text |
| public-identifier | .agents/skills/work/SKILL.md | 263 | J\u0061rvis | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | .claude/agents/architecture-reviewer.md | 12 | J\u0061rvis | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | .claude/agents/code-reviewer.md | 12 | J\u0061rvis | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | .claude/agents/code-simplifier.md | 12 | J\u0061rvis | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | .claude/agents/intent-scan.md | 18, 21 | J\u0061RVIS_PROJECT_ROOT | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | .claude/agents/lenny-sync.md | 14, 18, 75, 116 | J\u0061RVIS_PROJECT_ROOT/logs/lenny-sync-state.json | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | .claude/agents/observation-diarizer.md | 48 | J\u0061rvis-internal | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | .claude/agents/project-setup-writer.md | 38 | J\u0061rvis | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | .claude/agents/project-updater.md | 11 | mcp__j\u0061rvis-kb__kb_query | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | .claude/agents/proposal-updater.md | 21 | J\u0061rvis-side | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | .claude/agents/security-auditor.md | 12, 47 | J\u0061rvis, J\u0061RVIS_HTTP_SECRET | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | .claude/agents/test-specialist.md | 14 | J\u0061rvis | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | .claude/settings.json | 3 | j\u0061rvis-kb | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | .claude/skills/work/SKILL.md | 36, 40, 274 | J\u0061rvis, J\u0061RVIS_WORK_RUN_SENTINEL | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | .codex/agents/architecture-reviewer.toml | 3 | J\u0061rvis | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | .codex/agents/code-reviewer.toml | 3 | J\u0061rvis | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | .codex/agents/code-simplifier.toml | 3 | J\u0061rvis | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | .codex/agents/intent-scan.toml | 11, 14 | J\u0061RVIS_PROJECT_ROOT | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | .codex/agents/lenny-sync.toml | 7, 11, 68, 109 | J\u0061RVIS_PROJECT_ROOT/logs/lenny-sync-state.json | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | .codex/agents/proposal-updater.toml | 11 | J\u0061rvis-side | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | .codex/agents/security-auditor.toml | 3, 38 | J\u0061rvis, J\u0061RVIS_HTTP_SECRET | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | .codex/agents/test-specialist.toml | 3 | J\u0061rvis | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | .env.example | 11, 13, 16 | J\u0061RVIS_ALLOWED_HOSTS, J\u0061RVIS_HTTP_SECRET, J\u0061rvis-owned | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | CLAUDE.md | 113, 239 | createJ\u0061rvisMcpServer | code-owned identifier or type name to rename |
| public-identifier | CLAUDE.md | 47, 114, 149, 154, 157, 159, 218, 220-221, 236-237, 409-410, 413, 416, 489 | https://j\u0061rvis-mcp.example.com, J\u0061RVIS_ALLOWED_HOSTS, J\u0061RVIS_HTTP_SECRET, J\u0061RVIS_WORK_RUN_SENTINEL, J\u0061RVIS_WORKSPACE_DIR, j\u0061rvis-gen-eval/, J\u0061rvis-internal, j\u0061rvis-kb, J\u0061rvis-owned, j\u0061rvis-work/ | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | cli/j\u0061rvis.test.ts | 73, 99, 104, 112, 173, 202, 302, 443 | ./j\u0061rvis.js, cli/j\u0061rvis, j\u0061rvis | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | cli/j\u0061rvis.ts | 20, 107, 135, 217, 266 | j\u0061rvis | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | docs/idea.md | 1 | J\u0061rvis: | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | docs/projects/01-mvp/spec.md | 77, 405 | cli/j\u0061rvis.ts, J\u0061rvis: | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | docs/projects/01-mvp/tasks.md | 130 | cli/j\u0061rvis.ts | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | docs/projects/01-mvp/test-plan.md | 66 | J\u0061RVIS_HTTP_SECRET | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | docs/projects/02-journal-kb/spec.md | 25 | J\u0061rvis | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | docs/projects/04-custom-workouts/spec.md | 104, 234, 282 | cli/j\u0061rvis.ts | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | docs/projects/04-custom-workouts/tasks.md | 79-80 | cli/j\u0061rvis.ts | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | docs/projects/05-library-into-kb/spec.md | 31, 161, 265 | j\u0061rvis-kb, J\u0061rvis-resident | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | docs/projects/05-library-into-kb/tasks.md | 47 | J\u0061rvis-resident | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | docs/projects/06-webview/spec.md | 29, 46, 202, 223, 256-257, 330-331, 359, 364, 369, 455, 567-568, 570 | J\u0061RVIS_ALLOWED_HOSTS, J\u0061RVIS_HTTP_SECRET, j\u0061rvis-auth | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | docs/projects/06-webview/tasks.md | 41, 48-51, 72, 75, 80, 114-115, 122, 135-136, 142, 148 | /Library/Logs/j\u0061rvis/, /Library/Logs/j\u0061rvis/stdout.log, /workspace/j\u0061rvis, J\u0061RVIS_ALLOWED_HOSTS, J\u0061RVIS_HTTP_SECRET, j\u0061rvis-auth | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | docs/projects/06-webview/test-plan.md | 42, 45-48, 169, 179, 183, 188, 192, 199 | J\u0061RVIS_ALLOWED_HOSTS, J\u0061RVIS_HTTP_SECRET, j\u0061rvis-auth, J\u0061rvis: | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | docs/projects/07-spaced-repetition/tasks.md | 43 | cli/j\u0061rvis.ts | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | docs/projects/08-intent-layer/agent-lessons.md | 397, 486 | /.claude/projects/-Users-j\u0061rvis-workspace-pkms/, J\u0061rvis-spawned | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | docs/projects/08-intent-layer/spec.md | 78, 318, 435, 440, 446, 482, 520 | /workspace/j\u0061rvis, J\u0061rvis: | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | docs/projects/08-intent-layer/tasks.md | 22, 43, 270, 316 | j\u0061rvis, J\u0061rvis, j\u0061rvis-gen-eval/ | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | docs/projects/08-intent-layer/test-plan.md | 160 | logs/j\u0061rvis.log | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | docs/projects/09-expand-cockpit/spec.md | 34, 160 | J\u0061rvis-only, J\u0061rvis-workspace | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | docs/projects/09-expand-cockpit/tasks.md | 61 | j\u0061rvis, J\u0061rvis | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | docs/projects/09-expand-cockpit/test-plan.md | 61 | j\u0061rvis, J\u0061rvis | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | docs/projects/10-j\u0061rvis-identity-refactor/spec.md | 11, 31, 48, 67, 73, 80, 190, 195, 201, 217 | j\u0061rvis, J\u0061RVIS_HOME, j\u0061rvis: | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | docs/projects/10-j\u0061rvis-identity-refactor/tasks.md | 19, 23-25, 28, 44, 48, 58, 83, 99 | 10-j\u0061rvis-identity-refactor, j\u0061rvis, J\u0061RVIS_HOME, J\u0061RVIS_WORKSPACE_DIR, J\u0061rvis-spawned, j\u0061rvis-work/2d0534db, j\u0061rvis: | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | docs/projects/10-j\u0061rvis-identity-refactor/test-plan.md | 36 | j\u0061rvis | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | docs/projects/11-work-run-observability/phase-6-diagnosis.md | 11 | 10-j\u0061rvis-identity-refactor, j\u0061rvis-work/7b8410fb | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | docs/projects/13-work-run-monitoring/spec.md | 43, 93, 299, 506-507, 509 | J\u0061RVIS_WORK_RUN_SENTINEL, j\u0061rvis-work/, refs/heads/j\u0061rvis-work/, refs/j\u0061rvis/integration/ | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | docs/projects/13-work-run-monitoring/tasks.md | 75, 124 | J\u0061RVIS_WORK_RUN_SENTINEL | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | docs/projects/13-work-run-monitoring/test-plan.md | 45, 67 | J\u0061rvis, J\u0061RVIS_WORK_RUN_SENTINEL | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | docs/projects/14-product-team-agents/context.md | 3, 34, 46 | j\u0061rvis, J\u0061rvis-owned | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | docs/projects/14-product-team-agents/live-acceptance-6abf35cf.md | 16, 36 | j\u0061rvis-work/live-accept-sum | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | docs/projects/14-product-team-agents/phase-10-active-harm-verification.md | 30 | J\u0061RVIS_HTTP_SECRET | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | docs/projects/14-product-team-agents/spec.md | 33, 39, 72, 130, 200, 206, 216, 459, 763, 837, 1286, 1403 | J\u0061rvis, J\u0061rvis-orchestrated-work, J\u0061rvis-owned, J\u0061rvis-Owned, J\u0061rvis-repo-specific | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | docs/projects/14-product-team-agents/tasks.md | 11, 140, 144, 238, 321-322, 605, 1173 | j\u0061rvis, J\u0061rvis-orchestrated, J\u0061rvis-owned, J\u0061rvis-repo-specific | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | docs/projects/14-product-team-agents/test-plan.md | 3, 147 | J\u0061rvis-orchestrated, J\u0061rvis-owned | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | docs/projects/15-work-run-finalizer/tasks.md | 226 | j\u0061rvis | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | docs/projects/16-claude-app-connector/context.md | 39, 93 | createJ\u0061rvisMcpServer | code-owned identifier or type name to rename |
| public-identifier | docs/projects/16-claude-app-connector/context.md | 3, 35-36, 47 | j\u0061rvis, J\u0061rvis, J\u0061RVIS_ALLOWED_HOSTS, J\u0061RVIS_HTTP_SECRET, j\u0061rvis/policies/products.json, j\u0061rvis/src/intent/observation-ideas-io.ts | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | docs/projects/16-claude-app-connector/e2e-acceptance-test.md | 15, 17-18, 93 | /workspace/j\u0061rvis, https://j\u0061rvis.tail6b86b9.ts.net, J\u0061RVIS_ALLOWED_HOSTS, J\u0061RVIS_HTTP_SECRET | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | docs/projects/16-claude-app-connector/spec.md | 164, 197, 231 | createJ\u0061rvisMcpServer | code-owned identifier or type name to rename |
| public-identifier | docs/projects/16-claude-app-connector/spec.md | 119, 200, 248 | J\u0061RVIS_HTTP_SECRET, J\u0061rvis-pushed | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | docs/projects/16-claude-app-connector/tasks.md | 28, 46 | createJ\u0061rvisMcpServer | code-owned identifier or type name to rename |
| public-identifier | docs/projects/16-claude-app-connector/tasks.md | 47-48 | https://j\u0061rvis.tail6b86b9.ts.net, J\u0061RVIS_HTTP_SECRET | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | docs/projects/16-claude-app-connector/tech-spec.md | 13 | createJ\u0061rvisMcpServer | code-owned identifier or type name to rename |
| public-identifier | docs/projects/16-claude-app-connector/tech-spec.md | 9-10, 21 | j\u0061rvis, J\u0061RVIS_ALLOWED_HOSTS, J\u0061RVIS_HTTP_SECRET, j\u0061rvis/policies/products.json, j\u0061rvis/src/intent/observation-ideas-io.ts | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | docs/projects/16-claude-app-connector/test-plan.md | 23 | createJ\u0061rvisMcpServer | code-owned identifier or type name to rename |
| public-identifier | docs/projects/16-claude-app-connector/test-plan.md | 83, 94 | J\u0061RVIS_HTTP_SECRET, J\u0061rvis-pushed | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | docs/projects/16-claude-app-connector/tunnel-runbook.md | 82, 85, 93, 124, 129, 144, 147, 150, 154, 157, 163-164, 167 | https://j\u0061rvis-mcp., J\u0061RVIS_ALLOWED_HOSTS, J\u0061RVIS_HTTP_SECRET, j\u0061rvis-mcp, j\u0061rvis-mcp. | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | docs/projects/17-cockpit-redesign/context.md | 3, 305 | j\u0061rvis, J\u0061rvis, J\u0061RVIS_ACCEPTANCE_MUTATE_REAL_J\u0061RVIS, J\u0061RVIS_HTTP_SECRET | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | docs/projects/18-rebrand-j\u0061rvis-to-rune/context.md | 1, 3, 9, 13, 15, 39, 51, 55, 98, 113, 124 | /Users/j\u0061rvis, /workspace/j\u0061rvis/, j\u0061rvis, J\u0061rvis, J\u0061RVIS_, J\u0061RVIS_LOGS_DIR, j\u0061rvis-kb, workspace/j\u0061rvis | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | docs/projects/18-rebrand-j\u0061rvis-to-rune/examples/qa.md | 3, 10 | /Users/j\u0061rvis, j\u0061rvis | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | docs/projects/18-rebrand-j\u0061rvis-to-rune/spec.md | 5, 27-28, 36, 60, 86, 97, 100, 104, 112, 123, 140, 162, 168, 170, 179, 190, 194, 210, 227, 236, 238, 247, 256, 280, 301, 312, 319, 345, 347 | /Users/j\u0061rvis, /Users/j\u0061rvis/workspace/j\u0061rvis/..., /workspace/j\u0061rvis, /workspace/j\u0061rvis/, github.com/.../j\u0061rvis, j\u0061rvis, J\u0061rvis, J\u0061RVIS_, J\u0061RVIS_LOGS_DIR, j\u0061rvis-kb, workspace/j\u0061rvis | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | docs/projects/18-rebrand-j\u0061rvis-to-rune/tasks.md | 16, 21-22, 24, 43, 45, 48-49, 62, 65, 69, 90, 140, 159-160 | /Users/j\u0061rvis, /Users/j\u0061rvis/workspace/j\u0061rvis/..., /workspace/j\u0061rvis/, github.com/.../j\u0061rvis, j\u0061rvis, J\u0061rvis, J\u0061RVIS_, J\u0061RVIS_LOGS_DIR, j\u0061rvis-inventory-and-allowlist, j\u0061rvis-kb, workspace/j\u0061rvis | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | docs/projects/18-rebrand-j\u0061rvis-to-rune/tech-spec.md | 20, 32, 36, 79, 94 | /Users/j\u0061rvis, /workspace/j\u0061rvis/, j\u0061rvis, J\u0061RVIS_, J\u0061RVIS_LOGS_DIR, workspace/j\u0061rvis | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | docs/projects/18-rebrand-j\u0061rvis-to-rune/test-plan.md | 24, 28, 38, 46-47, 53, 60, 66, 108, 110 | /Users/j\u0061rvis, j\u0061rvis, J\u0061rvis, J\u0061RVIS_, J\u0061RVIS_LOGS_DIR, j\u0061rvis-kb, workspace/j\u0061rvis | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | docs/projects/bugs.md | 42, 66, 70, 94, 118, 139, 172, 174, 176, 178, 181, 183, 200 | /.worktrees/j\u0061rvis/10-j\u0061rvis-identity-refactor, /j\u0061rvis, /j\u0061rvis/node_modules, J\u0061RVIS_WORK_RUN_SENTINEL, J\u0061rvis-initiated, j\u0061rvis-work/, j\u0061rvis-work/14-product-team-agents, j\u0061rvis-work/17-cockpit-redesign, j\u0061rvis-work/19cd198f | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | docs/projects/ideas.md | 22, 24, 26, 35, 45, 48-49, 55 | [[j\u0061rvis]], j\u0061rvis, J\u0061rvis, j\u0061rvis-kb, j\u0061rvis-only, j\u0061rvis-work/ | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | docs/projects/index.md | 344 | createJ\u0061rvisMcpServer | code-owned identifier or type name to rename |
| public-identifier | docs/projects/index.md | 18, 26, 145, 147, 153-155, 226, 237, 245, 295, 343-344, 347, 367, 369, 373, 375-377, 380 | [10-j\u0061rvis-identity-refactor], [18-rebrand-j\u0061rvis-to-rune], /Users/j\u0061rvis/workspace/j\u0061rvis/..., 10-j\u0061rvis-identity-refactor, 10-j\u0061rvis-identity-refactor/spec.md, 10-j\u0061rvis-identity-refactor/tasks.md, 10-j\u0061rvis-identity-refactor/test-plan.md, 18-rebrand-j\u0061rvis-to-rune, 18-rebrand-j\u0061rvis-to-rune/spec.md, 18-rebrand-j\u0061rvis-to-rune/tasks.md, 18-rebrand-j\u0061rvis-to-rune/test-plan.md, j\u0061rvis, J\u0061rvis, J\u0061RVIS_HOME, J\u0061RVIS_HTTP_SECRET, J\u0061RVIS_LOGS_DIR, j\u0061rvis-kb, J\u0061rvis-orchestrated-work, J\u0061rvis-owned, J\u0061rvis-owned., J\u0061rvis-pushed | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | docs/projects/templates/planning-checklist.md | 67 | J\u0061rvis-spawned | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | package-lock.json | 2, 8 | j\u0061rvis | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | package.json | 2, 9 | cli/j\u0061rvis.ts, j\u0061rvis | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | policies/products.json | 5, 17, 26-27, 30, 46 | /.config/j\u0061rvis/credentials/assay/.env, /.config/j\u0061rvis/credentials/aura/.env, /.config/j\u0061rvis/credentials/j\u0061rvis/.env, /.config/j\u0061rvis/credentials/relay/.env, /workspace/j\u0061rvis, j\u0061rvis | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | README.md | 42, 54, 132, 156, 219, 244, 246, 276, 398, 402 | https://github.com/yourusername/j\u0061rvis.git, J\u0061rvis, J\u0061RVIS_ALLOWED_HOSTS, J\u0061RVIS_HTTP_SECRET, j\u0061rvis-kb | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | scripts/dispatch-review.ts | 58, 63 | j\u0061rvis | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | scripts/hooks/block-nonresponse.cjs | 33, 38 | /Users/j\u0061rvis/workspace/j\u0061rvis/logs/hook-nonresponse-state.json, /Users/j\u0061rvis/workspace/j\u0061rvis/logs/hook-nonresponse.jsonl | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | scripts/run-evals.test.ts | 31 | J\u0061RVIS_HTTP_SECRET: | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | scripts/run-orchestrated-acceptance.ts | 8, 11, 39 | j\u0061rvis, J\u0061rvis-owned, j\u0061rvis-work/ | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/ai/claude-workspace.test.ts | 19, 79, 83, 86, 90 | /tmp/j\u0061rvis-nonexistent-model-policy.json, J\u0061RVIS_PROJECT_ROOT, J\u0061RVIS_WORKSPACE_DIR | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/ai/claude.test.ts | 933, 937 | J\u0061RVIS_WORKSPACE_DIR | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/ai/claude.ts | 47, 69-70, 260-261 | J\u0061RVIS_PROJECT_ROOT:, J\u0061RVIS_WORKSPACE_DIR:, j\u0061rvis-kb | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/ai/codex.ts | 192 | J\u0061RVIS_HTTP_SECRET | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/ai/tool-labels.test.ts | 58-59, 61-63 | j\u0061rvis-kb, mcp__j\u0061rvis-kb__kb_lint, mcp__j\u0061rvis-kb__kb_query, mcp__j\u0061rvis-kb__kb_search, mcp__j\u0061rvis-kb__kb_stats | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/ai/tool-labels.ts | 98-99 | mcp__j\u0061rvis-kb__ | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/bot/commands/approve.test.ts | 56, 59 | j\u0061rvis | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/bot/commands/clear.test.ts | 102, 125 | j\u0061rvis | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/bot/commands/done-workout.test.ts | 15 | j\u0061rvis-done-workout-logs- | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/bot/commands/fresh-full.test.ts | 116, 118, 174, 191, 205 | [[j\u0061rvis]], [J\u0061rvis] | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/bot/commands/fresh-full.ts | 19, 56 | [[j\u0061rvis]], J\u0061rvis | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/bot/commands/fresh.integration.test.ts | 7, 189 | [[j\u0061rvis]], j\u0061rvis-fresh-int- | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/bot/commands/fresh.test.ts | 203, 229, 243, 281, 349 | [[j\u0061rvis]], j\u0061rvis | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/bot/commands/fresh.ts | 69 | [[j\u0061rvis]] | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/bot/commands/journal.test.ts | 61, 72, 118 | [[j\u0061rvis]], j\u0061rvis | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/bot/commands/journal.ts | 19 | [[j\u0061rvis]] | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/bot/commands/learn-list.test.ts | 8 | j\u0061rvis-learn-list-test- | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/bot/commands/learn.test.ts | 7 | j\u0061rvis-learn-test- | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/bot/commands/plan.test.ts | 52, 137, 158 | j\u0061rvis | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/bot/commands/workout.test.ts | 15-16 | j\u0061rvis-workout-logs-, j\u0061rvis-workout-vault- | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/bot/handlers/text.test.ts | 22, 379, 398, 425, 445, 1169, 1196, 1249, 1353-1355 | j\u0061rvis, J\u0061rvis, j\u0061rvis-product-session, mcp__j\u0061rvis-kb__kb_query, mcp__j\u0061rvis-kb__kb_search, mcp__j\u0061rvis-kb__repo_search | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/bot/handlers/text.ts | 456-459 | mcp__j\u0061rvis-kb__kb_query, mcp__j\u0061rvis-kb__kb_search, mcp__j\u0061rvis-kb__kb_stats, mcp__j\u0061rvis-kb__repo_search | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/bot/skill-registry.ts | 227 | J\u0061rvis-first | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/config.ts | 50, 53, 61-62, 297 | https://j\u0061rvis-mcp.example.com, J\u0061RVIS_ALLOWED_HOSTS, J\u0061RVIS_ALLOWED_HOSTS:, J\u0061RVIS_HTTP_SECRET, J\u0061RVIS_HTTP_SECRET:, J\u0061rvis-owned | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/index-startup-recovery.test.ts | 16, 18-22, 27, 161-162 | /tmp/j\u0061rvis, /tmp/j\u0061rvis/logs, /tmp/j\u0061rvis/products.json, /tmp/j\u0061rvis/supervised-runs.json, /tmp/j\u0061rvis/work-runs, /tmp/j\u0061rvis/worktrees, J\u0061RVIS_HTTP_SECRET: | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/index.ts | 99, 254, 256, 258, 269 | config.J\u0061RVIS_HTTP_SECRET, J\u0061RVIS_HTTP_SECRET, j\u0061rvis-kb | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/integrations/whoop/keychain.test.ts | 33, 53, 57, 102 | j\u0061rvis-whoop | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/integrations/whoop/keychain.ts | 6 | j\u0061rvis-whoop | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/intent/agent-def.ts | 156 | J\u0061rvis-internal | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/intent/backlog-id.test.ts | 119 | /Users/x/workspace/j\u0061rvis | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/intent/backlog-reader.test.ts | 104, 115, 118, 124, 141, 144-145, 149, 158, 163, 166, 172, 198, 201-202, 206, 215, 222-223, 227, 231, 240, 246-247, 251, 262, 267, 272-273, 294, 303-304, 308, 310, 323, 331-332, 336, 338, 345, 348-349, 353, 356 | j\u0061rvis, j\u0061rvis: | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/intent/cockpit-dispatch-mode.test.ts | 20 | j\u0061rvis | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/intent/context-curator.test.ts | 2 | J\u0061rvis-owned | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/intent/context-curator.ts | 2 | J\u0061rvis-owned | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/intent/feedback-reader.test.ts | 44, 126, 144 | j\u0061rvis-feedback-, j\u0061rvis-feedback-proc- | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/intent/feedback-record.test.ts | 95, 98 | j\u0061rvis-14 | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/intent/finalizer-handoff.ts | 26 | j\u0061rvis-work/14-... | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/intent/home-pulse-deep-view.test.ts | 113, 139, 418, 560 | /tmp/j\u0061rvis-, /tmp/j\u0061rvis-aura-01-mvp, /tmp/j\u0061rvis-aura-b-open | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/intent/intent-proposal-queue.test.ts | 26 | /tmp/j\u0061rvis-test-intent-proposal-queue.json | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/intent/journal-intent-e2e.test.ts | 88, 295 | j\u0061rvis | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/intent/learning-loop.test.ts | 3 | J\u0061rvis-owned | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/intent/learning-loop.ts | 7, 42, 51, 90 | J\u0061rvis-owned | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/intent/model-policy.test.ts | 224 | /tmp/j\u0061rvis-nonexistent-model-policy.json | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/intent/observation-ideas-io.test.ts | 26 | j\u0061rvis-ideas-io-test- | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/intent/orch-execution.test.ts | 182-183, 187, 201, 216 | j\u0061rvis, j\u0061rvis-work/14-x | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/intent/orch-task-select.ts | 2 | J\u0061rvis-owned | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/intent/plan-e2e.test.ts | 51, 85 | j\u0061rvis | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/intent/planner.ts | 46, 147 | J\u0061rvis-seeded, J\u0061rvis-workspace-scoped | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/intent/planning-critique.test.ts | 9 | J\u0061rvis-owned | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/intent/planning-critique.ts | 9 | J\u0061rvis-owned | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/intent/planning-roles-wiring.test.ts | 217, 258, 284, 296, 307, 319, 336 | j\u0061rvis | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/intent/planning-roles-wiring.ts | 342, 610 | J\u0061rvis-owned | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/intent/planning-roles.ts | 113 | J\u0061rvis-owned | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/intent/postmortem.test.ts | 2, 9 | J\u0061rvis-owned, J\u0061RVIS-owned | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/intent/postmortem.ts | 2, 6, 139 | J\u0061rvis-owned, J\u0061RVIS-owned | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/intent/product-routing.test.ts | 36, 116, 184 | j\u0061rvis, J\u0061RVIS, j\u0061rvis-product-routing-test- | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/intent/project-14-closeout.test.ts | 105 | j\u0061rvis | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/intent/project-context.test.ts | 8 | J\u0061rvis-owned | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/intent/project-context.ts | 4 | J\u0061rvis-owned | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/intent/project-orchestrator.test.ts | 10, 100, 179, 199, 253, 335, 609, 642, 684, 765, 898, 993, 1043, 1280, 1342, 1680, 1691, 1699 | /tmp/j\u0061rvis-worktrees/aura/14-acceptance-recording-failure, /tmp/j\u0061rvis-worktrees/aura/14-closeout-checks, /tmp/j\u0061rvis-worktrees/aura/14-dirty-worktree, /tmp/j\u0061rvis-worktrees/aura/14-malformed-gate-output, /tmp/j\u0061rvis-worktrees/aura/14-non-reversible-terminal, /tmp/j\u0061rvis-worktrees/aura/14-recording-failure, /tmp/j\u0061rvis-worktrees/aura/14-x, /tmp/j\u0061rvis-worktrees/aura/14-x-, /tmp/j\u0061rvis-worktrees/aura/14-x-objection-open, J\u0061rvis-owned, j\u0061rvis-work/14-x | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/intent/project-orchestrator.ts | 10, 225 | J\u0061rvis-owned | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/intent/promotions.test.ts | 46, 62 | j\u0061rvis | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/intent/registry.test.ts | 23, 61, 73, 87, 92, 99, 110, 112, 121, 264 | /test/j\u0061rvis, j\u0061rvis, J\u0061RVIS_INDEX | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/intent/registry.ts | 42 | j\u0061rvis | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/intent/sandbox.test.ts | 26, 33, 74, 86, 91-92, 96, 101, 164 | /tmp/j\u0061rvis-worktrees, /tmp/j\u0061rvis-worktrees/aura/02-growth, /tmp/j\u0061rvis-worktrees/aura/02-growth-evil, /tmp/j\u0061rvis-worktrees/aura/02-growth-evil/x.ts, /tmp/j\u0061rvis-worktrees/aura/02-growth/../../../../etc/passwd, /tmp/j\u0061rvis-worktrees/aura/02-growth/src/app.ts, /tmp/j\u0061rvis-worktrees/relay/01-relay-core/src/index.ts, j\u0061rvis | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/intent/sandbox.ts | 83 | j\u0061rvis-work/ | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/intent/scaffold-target.test.ts | 29, 36, 54-55, 60-63, 96 | /custom/elsewhere/j\u0061rvis, /home/u/workspace/j\u0061rvis, j\u0061rvis, j\u0061rvis: | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/intent/scaffold-target.ts | 11, 78 | j\u0061rvis, J\u0061rvis | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/intent/supervision-max-runtime.test.ts | 38 | j\u0061rvis | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/intent/supervision-parked.test.ts | 39 | j\u0061rvis | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/intent/supervision-quiet-cancel.test.ts | 39 | j\u0061rvis | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/intent/supervision-quiet.test.ts | 33 | j\u0061rvis | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/jobs/capture.test.ts | 110, 132 | [[j\u0061rvis]], j\u0061rvis | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/jobs/capture.ts | 26 | [[j\u0061rvis]] | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/jobs/credential-injector.test.ts | 11, 71, 83, 218, 220, 273, 277 | __J\u0061RVIS_TEST_KEY_THAT_DOES_NOT_EXIST__, /.config/j\u0061rvis/credentials/, /tmp/j\u0061rvis-worktrees/, J\u0061RVIS_HTTP_SECRET, j\u0061rvis-cred-injector-test-, J\u0061rvis-specific | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/jobs/egress-policy.test.ts | 70, 92 | /tmp/j\u0061rvis-worktrees/, j\u0061rvis-egress-policy-test- | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/jobs/execution-agent.test.ts | 107 | j\u0061rvis | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/jobs/fix-attempt-store.test.ts | 91-92, 95, 107-109, 112 | j\u0061rvis, j\u0061rvis-proceeding, run-j\u0061rvis-fix | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/jobs/gen-eval-loop-runner.test.ts | 84, 270, 298, 536, 555, 679, 700, 820, 852, 871, 885-886, 893, 896, 920 | /tmp/j\u0061rvis-worktrees, /tmp/j\u0061rvis-worktrees/aura/01-growth, j\u0061rvis-gel-runner-test-, j\u0061rvis-gen-eval, j\u0061rvis-gen-eval/, j\u0061rvis-gen-eval/mut-1 | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/jobs/gen-eval-loop-runner.ts | 543 | j\u0061rvis-gen-eval/ | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/jobs/intent-scan.test.ts | 6 | j\u0061rvis-intent-scan-test- | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/jobs/morning-prep.integration.test.ts | 6 | j\u0061rvis-morning-prep-int- | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/jobs/morning-prep.test.ts | 464 | /Users/somebody/workspace/j\u0061rvis/node_modules/.bin/claude | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/jobs/mutations-log-recovery.test.ts | 32, 59 | j\u0061rvis | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/jobs/mutations-log.test.ts | 196, 202 | j\u0061rvis | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/jobs/nightly.ts | 527, 590 | j\u0061rvis, J\u0061rvis-owned | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/jobs/orchestrated-run-store.test.ts | 102, 104, 106, 274-275, 289, 296 | /tmp/j\u0061rvis-worktrees/j\u0061rvis/14-product-team-agents, j\u0061rvis, j\u0061rvis-work/14-product-team-agents, j\u0061rvis-work/demo, mut-orch-1:merge-success:j\u0061rvis-work/demo:pushed-not-deleted | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/jobs/orchestrated-work-recovery.test.ts | 34, 59, 61, 63 | /tmp/j\u0061rvis-worktrees/j\u0061rvis/14-product-team-agents, j\u0061rvis, j\u0061rvis-work/14-product-team-agents | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/jobs/orchestrated-work-runner.test.ts | 122, 147, 201-202, 360, 362, 379, 446-447, 699, 1068, 1174, 1396, 1401, 1414, 1419, 1664, 1704-1705, 1788-1789, 1848-1849, 1996, 2047, 2050, 2054, 2078, 2082, 2255, 2257, 2367, 2388-2389, 2414-2415, 2428, 2432, 2439-2440, 2453, 2553, 2563, 2571, 2573, 2623, 2688, 2798, 2864, 2882, 2894, 2909, 2917, 2929 | ..j\u0061rvis-work/demo, /tmp/j\u0061rvis-worktrees/j\u0061rvis/demo-non-reversible, gate-j\u0061rvis-, j\u0061rvis, j\u0061rvis-bugs-, J\u0061rvis-owned, j\u0061rvis-work/demo, j\u0061rvis-work/recovered-branch, j\u0061rvis-work/x, j\u0061rvis: | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/jobs/orchestrated-work-runner.ts | 4, 834, 986, 1619 | j\u0061rvis, J\u0061rvis-owned | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/jobs/planning-expiry.test.ts | 43, 183 | j\u0061rvis | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/jobs/playbook-extract.test.ts | 6 | j\u0061rvis-playbook-test- | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/jobs/recovery-finalize-runner.test.ts | 40, 113 | j\u0061rvis, j\u0061rvis-work/15-work-run-finalizer | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/jobs/registry-rebuild.test.ts | 27, 29-33, 35, 53, 69, 74 | j\u0061rvis, j\u0061rvis-registry-scan-, j\u0061rvis: | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/jobs/sandbox-fs.test.ts | 64, 82, 115, 120, 160, 266, 319, 361, 404 | /etc/__j\u0061rvis_test_should_not_exist__, j\u0061rvis-outside-, j\u0061rvis-sandbox-fs-probe-, j\u0061rvis-sandbox-fs-test-, j\u0061rvis-worktrees | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/jobs/sandbox-runtime.test.ts | 66, 106, 151, 273, 308, 409, 439, 454, 469, 491, 531, 573, 597, 610, 652, 746-747, 794, 868, 879-880, 885, 1032, 1083 | .config/j\u0061rvis/credentials/aura/.env, /.config/j\u0061rvis/credentials/aura/.env, /tmp/j\u0061rvis-worktrees-test, /tmp/j\u0061rvis-worktrees-test-evil/..., /tmp/j\u0061rvis-worktrees-test-evil/aura/x, /tmp/j\u0061rvis-worktrees-test/aura/01-growth, j\u0061rvis, j\u0061rvis-deps-repo-, j\u0061rvis-deps-wt-, j\u0061rvis-sandbox-test-, j\u0061rvis-work, j\u0061rvis-work/01-growth, j\u0061rvis-work/14-product-team-agents, j\u0061rvis-work/abc, j\u0061rvis-work/empty, j\u0061rvis-work/fail, j\u0061rvis-work/xyz | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/jobs/scaffold-approval.test.ts | 31, 34, 59, 68, 112-113, 134, 151, 159, 167, 172, 179, 192, 207, 221, 231, 263, 283, 294 | /elsewhere/j\u0061rvis, /ws/j\u0061rvis, /ws/j\u0061rvis/docs/projects/, /ws/j\u0061rvis/docs/projects/bugs.md, /ws/j\u0061rvis/docs/projects/ideas.md, j\u0061rvis, j\u0061rvis: | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/jobs/scaffold-approval.ts | 193, 317 | J\u0061rvis-owned, J\u0061rvis-seeded | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/jobs/scheduler.ts | 184 | J\u0061rvis-first | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/jobs/stall-check-runner.ts | 47 | j\u0061rvis | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/jobs/supervision-recovery.test.ts | 34 | j\u0061rvis-supervision-recovery-test- | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/jobs/supervision-store.test.ts | 254-255 | 10-j\u0061rvis-identity-refactor, j\u0061rvis | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/jobs/team-task-deps.gate-learning.test.ts | 149 | j\u0061rvis | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/jobs/team-task-deps.postmortem-gate.test.ts | 97 | j\u0061rvis | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/jobs/team-task-deps.test.ts | 65 | j\u0061rvis | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/jobs/work-dispatch.test.ts | 69, 72, 81, 84, 92, 94, 102, 112, 114 | /repo/j\u0061rvis, j\u0061rvis, j\u0061rvis: | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/jobs/work-dispatch.ts | 6 | J\u0061rvis-owned | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/jobs/work-run-classify.test.ts | 580, 618 | j\u0061rvis-gen-eval/mut-abc, j\u0061rvis-gen-eval/mut-xyz | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/jobs/work-run-finalizer.test.ts | 71-72, 194, 456, 458, 551, 557, 698-699, 822-823, 912 | :merge-success:j\u0061rvis-work/15-work-run-finalizer:pushed-not-deleted, j\u0061rvis, j\u0061rvis-project-done-branch-test-, j\u0061rvis-work/14-product-team-agents, j\u0061rvis-work/15-work-run-finalizer, j\u0061rvis-work/15-work-run-finalizer., j\u0061rvis-work/no-index | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/jobs/work-run-finalizer.ts | 146, 503 | J\u0061rvis, j\u0061rvis-work/15-... | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/jobs/work-run-forensics.test.ts | 82, 97, 123 | deadbeef1234567890abcdef1234567890abcdef..j\u0061rvis-work/abcd1234, j\u0061rvis-work/abcd1234 | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/jobs/work-run-gate-runtime.test.ts | 36, 78, 102 | j\u0061rvis, j\u0061rvis-gate-runtime-test-, j\u0061rvis-work/feature | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/jobs/work-run-gate-runtime.ts | 60 | j\u0061rvis-work/15- | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/jobs/work-run-gc-runner.ts | 28 | J\u0061rvis-global | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/jobs/work-run-gc.test.ts | 37, 126, 150, 155, 182, 192, 204, 215, 235, 242, 257, 264, 290-291, 303, 313-315, 322, 332, 356 | /repos/j\u0061rvis, j\u0061rvis, j\u0061rvis-work/, j\u0061rvis-work/03-mobile, j\u0061rvis-work/09-cockpit, j\u0061rvis-work/09-expand-cockpit, j\u0061rvis-work/run-0, j\u0061rvis:, run-j\u0061rvis | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/jobs/work-run-gc.ts | 52, 210, 239, 243, 245 | j\u0061rvis, j\u0061rvis-work/ | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/jobs/work-run-merge-lock.test.ts | 49, 51, 55, 59, 63, 72, 75, 88, 93, 112, 117, 131, 137, 142 | j\u0061rvis, j\u0061rvis:main | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/jobs/work-run-merge-lock.ts | 46 | j\u0061rvis | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/jobs/work-run-noop-e2e.test.ts | 56, 101-102, 117, 120 | /test/j\u0061rvis, /test/repo/j\u0061rvis, /test/worktrees/j\u0061rvis/06-webview, j\u0061rvis | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/jobs/work-run-reconciler.test.ts | 23, 54, 91, 99 | j\u0061rvis, j\u0061rvis-work-run-reconciler-test- | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/jobs/work-run-release.test.ts | 37, 43, 58 | /tmp/test-worktrees/j\u0061rvis/06-webview, j\u0061rvis | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/jobs/work-run-release.ts | 564 | j\u0061rvis | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/jobs/work-run-sentinel.ts | 8, 23, 56, 73 | J\u0061RVIS_WORK_RUN_SENTINEL | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/jobs/work-run-store.test.ts | 58, 77 | j\u0061rvis, j\u0061rvis-gen-eval/mut-test-001 | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/jobs/work-run-transcript.test.ts | 459 | nj\u0061rvis-work/7b8410fb | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/jobs/work-runner.test.ts | 37, 114-115, 157, 160, 317, 1072, 1091, 1096, 1140, 1608, 1679, 1962, 2176, 2250, 2279, 2293, 2342, 2344, 2358, 2367 | /test/j\u0061rvis, /test/repo/j\u0061rvis, /test/worktrees/j\u0061rvis/06-webview, /tmp/test-worktrees/j\u0061rvis/06-webview, j\u0061rvis, J\u0061RVIS_WORK_RUN_SENTINEL, j\u0061rvis-work/, j\u0061rvis-work/06-webview | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/jobs/work-runner.ts | 187, 218, 237, 286, 450-451, 498, 633 | j\u0061rvis, J\u0061RVIS_PROJECT_ROOT:, J\u0061RVIS_WORK_RUN_SENTINEL, J\u0061RVIS_WORKSPACE_DIR:, j\u0061rvis-on-j\u0061rvis | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/jobs/worktree-sweep.test.ts | 28, 45, 58, 107, 120 | /private/tmp/worktrees/j\u0061rvis/15-work-run-finalizer/sub, /tmp/worktrees/j\u0061rvis/15-work-run-finalizer, /tmp/worktrees/j\u0061rvis/99-other, /tmp/worktrees/j\u0061rvis/99-other-project | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/kb/engine.test.ts | 89 | projects/j\u0061rvis.md | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/kb/queue.test.ts | 6 | j\u0061rvis-test- | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/kb/search.test.ts | 100, 108, 118, 130 | /workspace/j\u0061rvis, /workspace/j\u0061rvis/docs/projects/17-cockpit-redesign/spec.md, /workspace/j\u0061rvis/src/server/webview.ts | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/mcp/server.test.ts | 8, 82, 84-86, 145, 149, 154-155, 160-162, 170, 182-184, 192, 263, 265-267, 271, 279-281, 284 | createJ\u0061rvisMcpServer, J\u0061rvisMcpFactory | code-owned identifier or type name to rename |
| public-identifier | src/mcp/server.ts | 9, 268, 294 | createJ\u0061rvisMcpServer | code-owned identifier or type name to rename |
| public-identifier | src/mcp/server.ts | 281 | j\u0061rvis-kb | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/mcp/tools/log-idea.test.ts | 90 | j\u0061rvis | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/reviews/interview.test.ts | 13-16 | /tmp/j\u0061rvis-test-logs, /tmp/j\u0061rvis-test-logs/playbook-queue.json, /tmp/j\u0061rvis-test-logs/review-sessions.json, /tmp/j\u0061rvis-test-logs/tg-sessions.json | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/reviews/monthly.test.ts | 9-12 | /tmp/j\u0061rvis-test-logs, /tmp/j\u0061rvis-test-logs/playbook-queue.json, /tmp/j\u0061rvis-test-logs/review-sessions.json, /tmp/j\u0061rvis-test-logs/tg-sessions.json | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/reviews/new-project.ts | 46 | J\u0061rvis] | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/reviews/planning-handler.test.ts | 56 | j\u0061rvis-planning-handler-test- | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/reviews/planning.test.ts | 54, 322, 329, 339, 355, 367, 376 | j\u0061rvis, j\u0061rvis-planning-store-test- | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/reviews/quarterly.test.ts | 9-12 | /tmp/j\u0061rvis-test-logs, /tmp/j\u0061rvis-test-logs/playbook-queue.json, /tmp/j\u0061rvis-test-logs/review-sessions.json, /tmp/j\u0061rvis-test-logs/tg-sessions.json | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/reviews/session.test.ts | 6 | j\u0061rvis-review-sessions-test- | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/reviews/weekly.test.ts | 11 | /tmp/j\u0061rvis-test-logs | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/reviews/yearly.test.ts | 9-12 | /tmp/j\u0061rvis-test-logs, /tmp/j\u0061rvis-test-logs/playbook-queue.json, /tmp/j\u0061rvis-test-logs/review-sessions.json, /tmp/j\u0061rvis-test-logs/tg-sessions.json | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/roles/memory-writer.test.ts | 322 | j\u0061rvis-test-role- | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/server/__acceptance__/cockpit-real-product.acceptance.ts | 6, 11-12, 15-18, 28-33, 388-389 | j\u0061rvis, J\u0061rvis, J\u0061RVIS_ACCEPTANCE_BASE_URL, J\u0061RVIS_ACCEPTANCE_MUTATE_REAL_J\u0061RVIS, J\u0061RVIS_ACCEPTANCE_PRODUCT, J\u0061RVIS_ACCEPTANCE_PROJECT, J\u0061RVIS_ACCEPTANCE_TIMEOUT_MS, J\u0061RVIS_HTTP_SECRET | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/server/auth.test.ts | 5, 7, 48-49, 53-54, 58-59, 63, 71 | J\u0061RVIS_ALLOWED_HOSTS:, J\u0061RVIS_HTTP_SECRET:, j\u0061rvis-auth | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/server/auth.ts | 26-27, 30, 33, 38-39, 48, 53 | config.J\u0061RVIS_ALLOWED_HOSTS.has, config.J\u0061RVIS_HTTP_SECRET, J\u0061RVIS_ALLOWED_HOSTS, J\u0061RVIS_HTTP_SECRET, j\u0061rvis-auth | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/server/backlog-append-api.test.ts | 82-83 | J\u0061RVIS_ALLOWED_HOSTS:, J\u0061RVIS_HTTP_SECRET: | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/server/backlog-drawer.test.ts | 35, 38 | J\u0061RVIS_ALLOWED_HOSTS:, J\u0061RVIS_HTTP_SECRET: | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/server/cockpit-backlog-counts.test.ts | 53, 56 | J\u0061RVIS_ALLOWED_HOSTS:, J\u0061RVIS_HTTP_SECRET: | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/server/cockpit-ux.test.ts | 62, 65, 190 | J\u0061RVIS_ALLOWED_HOSTS:, J\u0061RVIS_HTTP_SECRET:, j\u0061rvis-auth | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/server/fix-endpoint-api.test.ts | 36, 39 | J\u0061RVIS_ALLOWED_HOSTS:, J\u0061RVIS_HTTP_SECRET: | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/server/home-products-api.test.ts | 43, 46 | J\u0061RVIS_ALLOWED_HOSTS:, J\u0061RVIS_HTTP_SECRET: | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/server/http.test.ts | 10, 72 | J\u0061RVIS_HTTP_SECRET:, mockConfig.J\u0061RVIS_HTTP_SECRET | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/server/mcp-oauth.test.ts | 11, 28, 66-67, 423 | J\u0061RVIS_ALLOWED_HOSTS:, J\u0061RVIS_HTTP_SECRET, J\u0061RVIS_HTTP_SECRET: | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/server/mcp-oauth.ts | 7, 34, 307 | J\u0061RVIS_HTTP_SECRET | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/server/mcp-transport.test.ts | 65, 78 | createJ\u0061rvisMcpServer | code-owned identifier or type name to rename |
| public-identifier | src/server/mcp-transport.test.ts | 44-45, 53-54 | config.J\u0061RVIS_ALLOWED_HOSTS.has, J\u0061RVIS_ALLOWED_HOSTS, J\u0061RVIS_ALLOWED_HOSTS:, J\u0061RVIS_HTTP_SECRET: | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/server/mcp-transport.ts | 36, 82 | createJ\u0061rvisMcpServer | code-owned identifier or type name to rename |
| public-identifier | src/server/plan-button-api.test.ts | 25-26 | J\u0061RVIS_ALLOWED_HOSTS:, J\u0061RVIS_HTTP_SECRET: | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/server/planning-collision.test.ts | 24-25 | J\u0061RVIS_ALLOWED_HOSTS:, J\u0061RVIS_HTTP_SECRET: | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/server/state-snapshot.test.ts | 167, 175, 187, 211, 215 | j\u0061rvis, j\u0061rvis-webview | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/server/static/app.js | 113, 116, 225, 1347 | j\u0061rvis, j\u0061rvis-connection-status, j\u0061rvis-webview-frame | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/server/static/home-view-client.test.ts | 120, 281, 285, 348 | j\u0061rvis, j\u0061rvis-connection-status | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/server/static/home-view.js | 244, 315 | j\u0061rvis-connection-status | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/server/static/product-deep-view-client.test.ts | 195, 213, 432, 1106, 1122, 1138, 1179, 1219, 1260, 1601, 1605 | /Users/j\u0061rvis/workspace/j\u0061rvis/.worktrees/aura/17-cockpit-redesign, j\u0061rvis-webview-frame | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/server/static/product-deep-view.js | 554, 1229, 1286 | j\u0061rvis, j\u0061rvis-webview-frame | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/server/webview-bootstrap.test.ts | 22 | j\u0061rvis | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/server/webview.test.ts | 50, 53, 254, 341, 383, 535, 542, 559, 567, 579, 695, 861, 881 | ../j\u0061rvis, j\u0061rvis, J\u0061RVIS_ALLOWED_HOSTS:, J\u0061RVIS_HTTP_SECRET:, j\u0061rvis-auth, j\u0061rvis-local, mockConfig.J\u0061RVIS_HTTP_SECRET | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/server/webview.ts | 170, 182, 190, 244-245, 1481, 1760 | config.J\u0061RVIS_HTTP_SECRET, j\u0061rvis, j\u0061rvis-auth | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/server/work-run-cockpit.test.ts | 50, 92, 95, 235, 255 | /tmp/j\u0061rvis-test-work-run-cockpit-, J\u0061RVIS_ALLOWED_HOSTS:, J\u0061RVIS_HTTP_SECRET:, j\u0061rvis-auth, j\u0061rvis-work/02-growth | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/server/work-run-live-api.test.ts | 68, 71 | J\u0061RVIS_ALLOWED_HOSTS:, J\u0061RVIS_HTTP_SECRET: | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/test/setup-env.ts | 3-4 | /tmp/j\u0061rvis-test-vault, J\u0061RVIS_HTTP_SECRET | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/transport/mutations.test.ts | 391 | /tmp/worktrees/j\u0061rvis/demo | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/transport/mutations.ts | 34, 59, 131, 222 | j\u0061rvis, J\u0061rvis-owned | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/transport/op-labels.test.ts | 45 | J\u0061rvis-resident | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/transport/op-labels.ts | 7 | J\u0061rvis-resident | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/transport/sender.test.ts | 173, 222-223 | j\u0061rvis, j\u0061rvis-work/demo | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/transport/telegram-sender.test.ts | 325, 327, 449, 463, 499, 501, 541, 560 | /tmp/worktrees/j\u0061rvis/06-webview, /tmp/worktrees/j\u0061rvis/demo, j\u0061rvis, j\u0061rvis-work/demo | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/transport/telegram-sender.ts | 69 | J\u0061RVIS_ALLOWED_HOSTS | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/utils/intent-log.test.ts | 8 | j\u0061rvis-intent-log-test- | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/utils/logger.ts | 8 | process.env.J\u0061RVIS_LOGS_DIR | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/utils/observation-log.test.ts | 17 | j\u0061rvis-observation-log-test- | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/utils/task-progress.ts | 3 | j\u0061rvis-local | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/vault/equipment.test.ts | 6 | j\u0061rvis-equipment-test- | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/vault/files.test.ts | 6 | j\u0061rvis-vault-test- | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/vault/journal.test.ts | 6 | j\u0061rvis-journal-test- | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/vault/learnings.test.ts | 7 | j\u0061rvis-learnings-test- | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/vault/sessions.test.ts | 7, 141, 144, 181, 209, 215, 243, 258, 281, 291, 301, 312, 314-315, 396 | /j\u0061rvis, /workspace/j\u0061rvis, j\u0061rvis, j\u0061rvis-only, j\u0061rvis-sessions-test-, j\u0061rvis:webview:12, j\u0061rvis:webview:42, j\u0061rvisScope:, product:j\u0061rvis:webview:7 | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/vault/sessions.ts | 68, 83, 267 | [[j\u0061rvis]], J\u0061rvis, j\u0061rvis-kb | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/vault/voice.test.ts | 7 | j\u0061rvis-voice-test- | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/vault/watcher.test.ts | 5 | j\u0061rvis-watcher-test- | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/vault/whoop-recent.test.ts | 6 | j\u0061rvis-whoop-recent-test- | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| public-identifier | src/workspace/files.test.ts | 7-8 | j\u0061rvis-project-root-test-, j\u0061rvis-workspace-test- | runtime/config/path/slug/CLI/MCP identifier to rename or extract |
| private-functional | CLAUDE.md | 430 | com.j\u0061rvis.daemon | launchd service label is a private machine identifier kept by spec; only the plist path changes |
| private-functional | docs/projects/06-webview/tasks.md | 142-143 | /Library/LaunchAgents/com.j\u0061rvis.daemon.plist | launchd service label is a private machine identifier kept by spec; only the plist path changes |
| private-functional | docs/projects/18-rebrand-j\u0061rvis-to-rune/context.md | 15, 77, 100-101, 124 | com.j\u0061rvis.daemon, com.j\u0061rvis.daemon.plist | launchd service label is a private machine identifier kept by spec; only the plist path changes |
| private-functional | docs/projects/18-rebrand-j\u0061rvis-to-rune/examples/qa.md | 9 | com.j\u0061rvis.daemon | launchd service label is a private machine identifier kept by spec; only the plist path changes |
| private-functional | docs/projects/18-rebrand-j\u0061rvis-to-rune/spec.md | 15, 38, 117, 141-142, 161, 212, 281, 300 | com.j\u0061rvis.daemon, com.j\u0061rvis.daemon.plist | launchd service label is a private machine identifier kept by spec; only the plist path changes |
| private-functional | docs/projects/18-rebrand-j\u0061rvis-to-rune/tasks.md | 26, 67, 142 | com.j\u0061rvis.daemon, com.j\u0061rvis.daemon.plist | launchd service label is a private machine identifier kept by spec; only the plist path changes |
| private-functional | docs/projects/18-rebrand-j\u0061rvis-to-rune/tech-spec.md | 58, 81-82 | com.j\u0061rvis.daemon, com.j\u0061rvis.daemon.plist | launchd service label is a private machine identifier kept by spec; only the plist path changes |
| private-functional | docs/projects/18-rebrand-j\u0061rvis-to-rune/test-plan.md | 98, 109 | com.j\u0061rvis.daemon | launchd service label is a private machine identifier kept by spec; only the plist path changes |
| private-functional | docs/projects/index.md | 378 | com.j\u0061rvis.daemon | launchd service label is a private machine identifier kept by spec; only the plist path changes |
| private-functional | src/config.ts | 350 | com.j\u0061rvis.daemon | launchd service label is a private machine identifier kept by spec; only the plist path changes |
| private-functional | src/server/backlog-append-api.test.ts | 84 | com.j\u0061rvis.daemon | launchd service label is a private machine identifier kept by spec; only the plist path changes |
| private-functional | src/server/backlog-drawer.test.ts | 40 | com.j\u0061rvis.daemon | launchd service label is a private machine identifier kept by spec; only the plist path changes |
| private-functional | src/server/cockpit-backlog-counts.test.ts | 58 | com.j\u0061rvis.daemon | launchd service label is a private machine identifier kept by spec; only the plist path changes |
| private-functional | src/server/fix-endpoint-api.test.ts | 41 | com.j\u0061rvis.daemon | launchd service label is a private machine identifier kept by spec; only the plist path changes |
| private-functional | src/server/home-products-api.test.ts | 48 | com.j\u0061rvis.daemon | launchd service label is a private machine identifier kept by spec; only the plist path changes |
| private-functional | src/server/plan-button-api.test.ts | 27 | com.j\u0061rvis.daemon | launchd service label is a private machine identifier kept by spec; only the plist path changes |
| private-functional | src/server/planning-collision.test.ts | 26 | com.j\u0061rvis.daemon | launchd service label is a private machine identifier kept by spec; only the plist path changes |
| private-functional | src/server/restart.test.ts | 7, 28, 50 | /com.j\u0061rvis.daemon, com.j\u0061rvis.daemon | launchd service label is a private machine identifier kept by spec; only the plist path changes |
| private-functional | src/server/webview.test.ts | 55 | com.j\u0061rvis.daemon | launchd service label is a private machine identifier kept by spec; only the plist path changes |
| private-functional | src/server/work-run-live-api.test.ts | 73 | com.j\u0061rvis.daemon | launchd service label is a private machine identifier kept by spec; only the plist path changes |

## Pathname inventory

| Class | Path | Matched forms | Rationale |
| --- | --- | --- | --- |
| public-identifier | cli/j\u0061rvis.test.ts | cli/j\u0061rvis.test.ts | CLI entrypoint filename should follow the renamed command |
| public-identifier | cli/j\u0061rvis.ts | cli/j\u0061rvis.ts | CLI entrypoint filename should follow the renamed command |
| public-identifier | docs/projects/10-j\u0061rvis-identity-refactor/spec.md | docs/projects/10-j\u0061rvis-identity-refactor/spec.md | committed project/document slug or path should be renamed or otherwise removed from final grep surface |
| public-identifier | docs/projects/10-j\u0061rvis-identity-refactor/tasks.md | docs/projects/10-j\u0061rvis-identity-refactor/tasks.md | committed project/document slug or path should be renamed or otherwise removed from final grep surface |
| public-identifier | docs/projects/10-j\u0061rvis-identity-refactor/test-plan.md | docs/projects/10-j\u0061rvis-identity-refactor/test-plan.md | committed project/document slug or path should be renamed or otherwise removed from final grep surface |
| public-identifier | docs/projects/18-rebrand-j\u0061rvis-to-rune/context.md | docs/projects/18-rebrand-j\u0061rvis-to-rune/context.md | committed project/document slug or path should be renamed or otherwise removed from final grep surface |
| public-identifier | docs/projects/18-rebrand-j\u0061rvis-to-rune/examples/qa.md | docs/projects/18-rebrand-j\u0061rvis-to-rune/examples/qa.md | committed project/document slug or path should be renamed or otherwise removed from final grep surface |
| public-identifier | docs/projects/18-rebrand-j\u0061rvis-to-rune/spec.md | docs/projects/18-rebrand-j\u0061rvis-to-rune/spec.md | committed project/document slug or path should be renamed or otherwise removed from final grep surface |
| public-identifier | docs/projects/18-rebrand-j\u0061rvis-to-rune/tasks.md | docs/projects/18-rebrand-j\u0061rvis-to-rune/tasks.md | committed project/document slug or path should be renamed or otherwise removed from final grep surface |
| public-identifier | docs/projects/18-rebrand-j\u0061rvis-to-rune/tech-spec.md | docs/projects/18-rebrand-j\u0061rvis-to-rune/tech-spec.md | committed project/document slug or path should be renamed or otherwise removed from final grep surface |
| public-identifier | docs/projects/18-rebrand-j\u0061rvis-to-rune/test-plan.md | docs/projects/18-rebrand-j\u0061rvis-to-rune/test-plan.md | committed project/document slug or path should be renamed or otherwise removed from final grep surface |
