# [Project Name] Test Plan

Error handling checklist for [scope description].

This project is **test-first**: each numbered section below is written by a phase's
**Tests (write first)** task in [tasks.md](tasks.md), and those tests must fail (red)
before that phase's implementation tasks begin. A phase's implementation is done when its
test-plan sections pass.

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
