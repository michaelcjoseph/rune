/**
 * Tests for `src/intent/planning-artifact.ts` — the serialization from a
 * planner-role `planned` outcome into a scaffoldable `SpecArtifact` (project 14).
 */

import { describe, it, expect } from 'vitest';

import {
  deriveTestPlan,
  plannedOutcomeToArtifact,
  sizedTasksToMarkdown,
} from './planning-artifact.js';
import type { PlanningRolesOutcome, SizedTask } from './planning-roles.js';

const TASKS: SizedTask[] = [
  { id: 'p1-core', text: 'Streak core', testStrategy: 'code-tests-required', designerNeeded: false, roles: ['qa', 'coder'] },
  { id: 'p2-card', text: 'Home card', testStrategy: 'code-tests-required', designerNeeded: true, roles: ['designer'] },
  { id: 'p3-docs', text: 'README', testStrategy: 'docs-or-config-only', designerNeeded: false, roles: ['coder'] },
];

const PLANNED: Extract<PlanningRolesOutcome, { kind: 'planned' }> = {
  kind: 'planned',
  title: 'Streak tracker',
  spec: 'Track daily streaks.\n\n## Assumptions\n\n- Resets at midnight.',
  assumptions: ['Resets at midnight'],
  techSpec: 'Pure core + REST + card.',
  tasks: TASKS,
  context: '# Project Context: Streak tracker\n\n## Current State\n\nPlanning complete.',
};

describe('sizedTasksToMarkdown', () => {
  it('emits a Tests (write first) block listing the code-tests-required tasks', () => {
    const md = sizedTasksToMarkdown(TASKS);
    expect(md).toContain('### Tests (write first)');
    expect(md).toContain('Tests for **p1-core**');
    expect(md).toContain('Tests for **p2-card**');
    // The docs-only task is not a write-first test target.
    expect(md).not.toContain('Tests for **p3-docs**');
  });

  it('annotates each task with its test strategy and flags designer-needed', () => {
    const md = sizedTasksToMarkdown(TASKS);
    expect(md).toContain('**p1-core** — Streak core');
    expect(md).toContain('Test strategy: `docs-or-config-only`');
    expect(md).toContain('**p2-card** — Home card _(designer review)_');
  });
});

describe('deriveTestPlan', () => {
  it('groups tasks by test strategy', () => {
    const plan = deriveTestPlan(TASKS);
    expect(plan).toContain('Tests required (write first)');
    expect(plan).toContain('Docs / config only');
    expect(plan).toContain('**p3-docs**: README');
  });

  it('omits a strategy section with no tasks', () => {
    const plan = deriveTestPlan(TASKS);
    expect(plan).not.toContain('Tests as deliverable');
  });
});

describe('plannedOutcomeToArtifact', () => {
  it('serializes the outcome into a full SpecArtifact with optional role fields', () => {
    const artifact = plannedOutcomeToArtifact('aura', PLANNED);
    expect(artifact.product).toBe('aura');
    expect(artifact.title).toBe('Streak tracker');
    expect(artifact.spec).toContain('## Assumptions');
    expect(artifact.tasks).toContain('**p1-core**');
    expect(artifact.testPlan).toContain('# Test Plan');
    expect(artifact.techSpec).toBe('Pure core + REST + card.');
    expect(artifact.context).toContain('# Project Context');
    expect(artifact.assumptions).toContain('Resets at midnight');
  });
});
