/**
 * Production wiring from the planner-role flow to the Phase 1 charter loader
 * (project 14, Phase 2).
 *
 * Kept SEPARATE from `planning-roles.ts` so the orchestration core stays
 * import-pure (no disk reads). These helpers turn a base instruction into the
 * PM / tech-lead role's two-channel prompt — SOUL → system-prompt authority,
 * `memory.md` → low-authority reference fence — via `composeRoleContext`, which
 * reads `agents/<role>/` from disk.
 *
 * The live Socratic planning loop builds its single-shot model dispatch (and the
 * reply parsing into `PmSpecResult` / `TechLeadResult`) on these in the planning
 * handler; Phase 2's required acceptance is the fixture-driven orchestration in
 * `planning-roles.ts`.
 */

import { composeRoleContext, type RoleContext } from '../roles/loader.js';

/** Build the PM-role two-channel prompt from the `agents/pm` charter. */
export function buildPmRolePrompt(baseInstructions: string): RoleContext {
  return composeRoleContext('pm', baseInstructions);
}

/** Build the tech-lead-role two-channel prompt from the `agents/tech-lead` charter. */
export function buildTechLeadRolePrompt(baseInstructions: string): RoleContext {
  return composeRoleContext('tech-lead', baseInstructions);
}
