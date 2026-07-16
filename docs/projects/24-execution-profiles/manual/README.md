# Manual runbooks — project 24

Every task in this project that requires operator (human) effort is split into two
tasks in [tasks.md](../tasks.md):

1. An **automatable runbook task** that authors a step-by-step document into this
   directory, detailing exactly what the operator must do and how to verify it.
2. A **`manual-live-gate` task** that assumes the runbook's steps are complete and
   closes only on persisted evidence from the real run — never on the runbook's
   existence, configuration presence, or fixture evidence.

No gate may be dispatched before its runbook task has landed.

## Expected documents (authored by their runbook tasks)

| Document | Authored by | Consumed by |
| --- | --- | --- |
| `brand-migration.md` | brand-migration-runbook (Phase 2) | brand-profile-migration |
| `host-prerequisites-python.md` | python-host-prereqs-runbook (Phase 3) | fixture-uv-roundtrip, assay tasks |
| `assay-migration.md` | assay-migration-runbook (Phase 3) | assay-profile-migration |
| `host-prerequisites-mobile.md` | mobile-host-prereqs-runbook (Phase 4) | fixture-expo-simulator-smoke, aura tasks, parallel-collision-acceptance |
| `aura-migration.md` | aura-migration-runbook (Phase 4) | aura-profile-acceptance-tiers |
| `production-release.md` | production-release-runbook (Phase 5) | production-release-gate |

Each runbook must contain: the ordered manual steps, the verification command or
observation per step, the evidence to retain (run IDs, evidence references, cockpit
captures), and the rollback procedure.
