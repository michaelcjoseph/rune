# [Project Name] Test Plan

Error handling checklist for [scope description].

This project is **test-first**: each numbered section below is covered by the matching
task's test strategy in [tasks.md](tasks.md). For `code-tests-required` tasks, QA authors
the tests before coder implementation and closeout requires the suite to be green.

> See also: [Cross-cutting test plan](../../tech/test-plan.md) for shared guidelines, monitoring, and security checks.

## Priority Levels

- 🔴 **Critical**: Blocks user progress, requires immediate attention
- 🟡 **High**: Degrades experience significantly, should be handled gracefully
- 🟢 **Low**: Non-blocking, can fail silently with logging

## [N]. [Feature Area]

### [Sub-area]

- [ ] 🔴 [Critical scenario — what fails and expected behavior]
- [ ] 🟡 [High-priority scenario]
- [ ] 🟢 [Low-priority scenario]
