/**
 * Bridge from the PM + tech-lead planner-role outcome to the scaffoldable
 * `SpecArtifact` (project 14).
 *
 * `runPlannerRoles` returns structured outputs — a tech spec, a flat
 * `SizedTask[]` with per-task test strategy, a seeded `context.md`. The existing
 * scaffolding pipeline (`buildSetupWriterBrief` → project-setup-writer) consumes
 * a `SpecArtifact` with markdown `tasks` + `testPlan` strings. This module is the
 * pure, testable serialization between the two.
 *
 * KNOWN GAP (v1): `SizedTask[]` is FLAT — the tech-lead role does not yet emit
 * phase grouping, so `sizedTasksToMarkdown` renders a single-phase checklist with
 * a "Tests (write first)" block, not the multi-phase `tasks.md` the legacy
 * single-shot planner produced. Phasing is a tech-lead-output extension, tracked
 * for a follow-up.
 */

import type { SpecArtifact } from './planner.js';
import type { PlanningRolesOutcome, SizedTask, TestStrategy } from './planning-roles.js';

/** The `planned` arm of the planner-role outcome — the only one that scaffolds. */
type PlannedOutcome = Extract<PlanningRolesOutcome, { kind: 'planned' }>;

/** Human label for each test strategy, for the rendered task/test docs. */
const STRATEGY_LABEL: Record<TestStrategy, string> = {
  'code-tests-required': 'Tests required (write first)',
  'docs-or-config-only': 'Docs / config only (reviewed no-code-test rationale)',
  'tests-as-deliverable': 'Tests as deliverable',
};

/**
 * Render the sized tasks into a `tasks.md` body. v1 is a single phase whose
 * "Tests (write first)" block lists the `code-tests-required` tasks, followed by
 * the task checklist annotated with each task's test strategy and designer flag —
 * the metadata the orchestrator's QA-first and designer-routing gates read.
 */
export function sizedTasksToMarkdown(tasks: readonly SizedTask[]): string {
  const lines: string[] = ['# Tasks', ''];

  const testFirst = tasks.filter((t) => t.testStrategy === 'code-tests-required');
  lines.push('## Phase 1', '', '### Tests (write first)', '');
  if (testFirst.length > 0) {
    for (const t of testFirst) {
      lines.push(`- [ ] Tests for **${t.id}**: ${t.text}`);
    }
  } else {
    lines.push('- [ ] _No code-test-required tasks — see per-task strategy below._');
  }
  lines.push('', '### Implementation', '');

  for (const t of tasks) {
    const designer = t.designerNeeded ? ' _(designer review)_' : '';
    lines.push(`- [ ] **${t.id}** — ${t.text}${designer}`);
    lines.push(`  - Test strategy: \`${t.testStrategy}\``);
    if (t.roles.length > 0) {
      lines.push(`  - Roles: ${t.roles.join(', ')}`);
    }
  }

  return lines.join('\n').trimEnd() + '\n';
}

/**
 * Derive a `test-plan.md` body from the per-task test strategies. The role flow
 * carries test strategy per task rather than a standalone test plan, so this
 * groups the tasks by strategy into a plan the scaffolder writes to disk and the
 * QA role reads.
 */
export function deriveTestPlan(tasks: readonly SizedTask[]): string {
  const lines: string[] = [
    '# Test Plan',
    '',
    'Derived from the tech lead\'s per-task test strategy. Each task\'s tests are',
    'authored by QA before the coder starts (or its no-code-test rationale is',
    'recorded and reviewed), per the orchestrated team-task workflow.',
    '',
  ];

  const strategies: TestStrategy[] = [
    'code-tests-required',
    'tests-as-deliverable',
    'docs-or-config-only',
  ];
  for (const strategy of strategies) {
    const matching = tasks.filter((t) => t.testStrategy === strategy);
    if (matching.length === 0) continue;
    lines.push(`## ${STRATEGY_LABEL[strategy]}`, '');
    for (const t of matching) {
      lines.push(`- **${t.id}**: ${t.text}`);
    }
    lines.push('');
  }

  return lines.join('\n').trimEnd() + '\n';
}

/**
 * Serialize a completed planner-role outcome into the `SpecArtifact` the
 * scaffolding pipeline consumes. The tech spec and seeded context ride along as
 * the optional fields so the scaffolder can write `tech-spec.md` and (its own
 * deterministic) `context.md`.
 */
export function plannedOutcomeToArtifact(product: string, outcome: PlannedOutcome): SpecArtifact {
  return {
    product,
    title: outcome.title,
    spec: outcome.spec,
    tasks: sizedTasksToMarkdown(outcome.tasks),
    testPlan: deriveTestPlan(outcome.tasks),
    techSpec: outcome.techSpec,
    context: outcome.context,
    assumptions: outcome.assumptions,
  };
}
