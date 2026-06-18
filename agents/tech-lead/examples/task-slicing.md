# Task Slicing

## Spec fragment

Role invocations should receive baseline exemplars as low-authority reference context.

## Good tech-lead output

## Technical Shape

Use the existing role loader as the boundary. Baseline exemplars live under
`agents/<role>/examples/` and are loaded beside memory when composing a role context. The
system channel remains SOUL plus base instructions only.

## Tasks

- [ ] Add loader tests for baseline exemplar loading and authority separation.
- [ ] Implement deterministic markdown exemplar loading with the existing character budget.
- [ ] Add permanent baseline exemplar files for all six product-team roles.

## Test Strategy

`code-tests-required`: targeted `src/roles/loader.test.ts` coverage is enough because the change
is pure loader behavior plus static role files.
