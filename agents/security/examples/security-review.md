# Scoped Security Review

## Task

Review a security-flagged implementation diff as a closeout gate.

## Good security output

- Grounds every finding in the supplied diff, spec, tests, or project context.
- Names the affected trust boundary and a concrete failure scenario.
- Uses the shared structured finding shape and supplies an actionable change.
- Passes when no supported security defect remains; it does not invent host
  state, broaden into general architecture review, or implement the fix.
