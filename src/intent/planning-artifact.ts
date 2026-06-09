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
 * Tasks carry an optional `phase` label from the tech lead; `sizedTasksToMarkdown`
 * groups them into milestone sections (first-seen order), each with its own
 * "Tests (write first)" block — the multi-phase `tasks.md` shape the legacy
 * single-shot planner produced. Unlabeled tasks collapse into a default phase.
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

/** Phase label for tasks the tech lead left unlabeled. */
const DEFAULT_PHASE = 'Phase 1';

/** Group tasks by their `phase` label, preserving first-seen phase order and
 *  task order within each phase. Unlabeled tasks collapse into {@link DEFAULT_PHASE}. */
function groupByPhase(tasks: readonly SizedTask[]): Array<{ phase: string; tasks: SizedTask[] }> {
  const order: string[] = [];
  const byPhase = new Map<string, SizedTask[]>();
  for (const t of tasks) {
    const phase = t.phase?.trim() || DEFAULT_PHASE;
    if (!byPhase.has(phase)) {
      byPhase.set(phase, []);
      order.push(phase);
    }
    byPhase.get(phase)!.push(t);
  }
  return order.map((phase) => ({ phase, tasks: byPhase.get(phase)! }));
}

/**
 * Render the sized tasks into a phased `tasks.md` body. Tasks are grouped by
 * their tech-lead `phase` label into milestone sections (first-seen order), each
 * opening with a "Tests (write first)" block listing that phase's
 * `code-tests-required` tasks, then an Implementation checklist annotated with
 * each task's test strategy and designer flag — the metadata the orchestrator's
 * QA-first and designer-routing gates read. The orchestration loop walks the
 * checklist linearly, so phase headings are organizational, not load-bearing.
 */
export function sizedTasksToMarkdown(tasks: readonly SizedTask[]): string {
  const lines: string[] = ['# Tasks', ''];

  for (const { phase, tasks: phaseTasks } of groupByPhase(tasks)) {
    lines.push(`## ${phase}`, '', '### Tests (write first)', '');
    const testFirst = phaseTasks.filter((t) => t.testStrategy === 'code-tests-required');
    if (testFirst.length > 0) {
      for (const t of testFirst) {
        lines.push(`- [ ] Tests for **${t.id}**: ${t.text}`);
      }
    } else {
      lines.push('- [ ] _No code-test-required tasks — see per-task strategy below._');
    }
    lines.push('', '### Implementation', '');

    for (const t of phaseTasks) {
      const designer = t.designerNeeded ? ' _(designer review)_' : '';
      lines.push(`- [ ] **${t.id}** — ${t.text}${designer}`);
      lines.push(`  - Test strategy: \`${t.testStrategy}\``);
      if (t.roles.length > 0) {
        lines.push(`  - Roles: ${t.roles.join(', ')}`);
      }
    }
    lines.push('');
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
