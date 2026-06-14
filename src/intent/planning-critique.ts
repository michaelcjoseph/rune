/**
 * Planning critique pass (project 14, Phase 9) — the cross-model hardening step
 * that runs after the PM/tech-lead self-review and before the human approval
 * gate. The PM/tech-lead flow answers "is this internally coherent?"; the
 * critique answers the harder question the self-review can't (no role critiques
 * its own write-up): does the defined scope actually achieve the stated goal,
 * and does completing every task leave a project a real user can use?
 *
 * This is a Jarvis-owned NEUTRAL step, not a seventh role — like the
 * learning-loop post-mortem, Jarvis runs it over the role artifacts (PM-owned
 * spec + tech-lead-owned tasks together) rather than assigning it to one role.
 *
 * The pass is SEQUENTIAL and CROSS-MODEL, one pass per model:
 *   1. Claude (Opus 4.8) critiques + revises the assembled plan.
 *   2. Codex (GPT-5.5) critiques + revises CLAUDE's output.
 * Sequential, not parallel: the second model sees the first's work, so the two
 * critiques compound instead of colliding as two independent rewrites. One pass
 * each — the pass does not loop to convergence; the human approval gate catches
 * residue.
 *
 * Degrade to Claude alone when Codex is unavailable (binary missing or not
 * logged in); planning never blocks on the second model. Fail-closed on an
 * unparseable critic reply: that pass returns null and the orchestrator keeps
 * the pre-pass plan rather than dropping content. A no-op critique (no change)
 * is not an error — the plan returns unchanged.
 *
 * Pure over injected per-model seams so the flow is fixture-testable with no
 * live call. The production seam wiring (real Claude/Codex calls + prompt +
 * fenced-artifact parsing) lives in planning-roles-wiring.ts.
 */

import type { SizedTask } from './planning-roles.js';

/** The assembled plan artifacts the critique operates on. `test-plan.md` is
 *  out of scope (the setup-writer authors it at scaffold time). */
export interface PlanCritique {
  spec: string;
  techSpec: string;
  tasks: SizedTask[];
}

/** The injected per-model critique seams. A seam returns the revised plan, or
 *  `null` when its reply could not be parsed (fail-closed → keep the prior
 *  plan). `isCodexAvailable` gates the second pass (probeCodexProvider). */
export interface PlanningCritiqueDeps {
  /** Claude (Opus 4.8) critique + revise. */
  critiqueWithClaude: (plan: PlanCritique) => Promise<PlanCritique | null>;
  /** Codex (GPT-5.5) critique + revise over Claude's output. */
  critiqueWithCodex: (plan: PlanCritique) => Promise<PlanCritique | null>;
  /** Whether the Codex executor is reachable (binary present + logged in). */
  isCodexAvailable: () => Promise<boolean>;
}

/** Outcome of the critique pass. `plan` is the final revised plan; `codexSkipped`
 *  records that the second model did not run (so planning can surface it). */
export interface PlanningCritiqueResult {
  plan: PlanCritique;
  codexSkipped: boolean;
  /** Why Codex was skipped, when it was. */
  codexSkipReason?: string;
}

/**
 * Run the sequential Claude→Codex critique over the assembled plan.
 *
 * - Claude revises first; an unparseable reply (null) keeps the input plan.
 * - Codex revises Claude's output IFF available; an unparseable reply keeps the
 *   Claude-revised plan.
 * - Codex unavailable → degrade to the Claude pass alone, recorded as skipped.
 *
 * Never throws on a critic miss — every fail-closed branch keeps the most-recent
 * good plan, so the pass can only sharpen or no-op, never drop content.
 */
export async function runPlanningCritique(
  plan: PlanCritique,
  deps: PlanningCritiqueDeps,
): Promise<PlanningCritiqueResult> {
  // Pass 1 — Claude. Fail-closed: a null (unparseable) reply keeps `plan`.
  const claudeRevised = await deps.critiqueWithClaude(plan);
  const afterClaude = claudeRevised ?? plan;

  // Pass 2 — Codex, only when reachable. Degrade to Claude alone otherwise.
  const codexAvailable = await deps.isCodexAvailable();
  if (!codexAvailable) {
    return {
      plan: afterClaude,
      codexSkipped: true,
      codexSkipReason: 'codex executor unavailable (binary missing or not logged in)',
    };
  }

  // Codex critiques CLAUDE's output (sequential compounding). Fail-closed: a
  // null reply keeps the Claude-revised plan.
  const codexRevised = await deps.critiqueWithCodex(afterClaude);
  return {
    plan: codexRevised ?? afterClaude,
    codexSkipped: false,
  };
}
