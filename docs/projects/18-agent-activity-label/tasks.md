# Agent Activity Label — Tasks

See [spec.md](spec.md). One task: the orchestrated team-task workflow runs QA-first
test authoring, tech-lead test review, implementation, and independent review inside
the task — no separate test-first line is needed.

- [ ] Rename the cockpit sidebar panel heading "Claude Activity" to "Agent Activity" in `src/server/static/index.html`, update the stale "Claude Activity" wording in the `src/server/static/app.css` comment, and add a static test that pins the new heading text (reads index.html from disk and asserts "Agent Activity" is present and "Claude Activity" is gone).
