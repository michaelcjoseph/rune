# Scoped Implementation Handoff

## Task

Implement the selected loader behavior only: make `composeRoleContext` include baseline
exemplars in the low-authority reference channel while keeping SOUL and base instructions
in `systemInstructions`.

## Good coder output

- Changes `src/roles/loader.ts` only where the loader assembles role context.
- Reuses the existing role directory and budget constants instead of introducing a new config
  surface.
- Leaves unrelated planning, orchestration, and memory-writing code untouched.
- Runs the targeted role loader test and reports the command/result in the handoff.

## Handoff note shape

Implemented baseline exemplar loading in `composeRoleContext`; exemplar text is fenced in
`referenceContext`, absent from `systemInstructions`, sorted deterministically, and truncated
with the existing visible marker style. Verified with the targeted loader test.
