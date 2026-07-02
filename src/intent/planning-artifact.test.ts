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
  { id: 'p1-core', text: 'Streak core', phase: 'Phase 1 - Core', testStrategy: 'code-tests-required', designerNeeded: false, roles: ['qa', 'coder'] },
  { id: 'p2-card', text: 'Home card', phase: 'Phase 2 - UI', testStrategy: 'code-tests-required', designerNeeded: true, roles: ['designer'] },
  { id: 'p3-docs', text: 'README', phase: 'Phase 2 - UI', testStrategy: 'docs-or-config-only', designerNeeded: false, roles: ['coder'] },
  { id: 'p4-live-gate', text: 'Operator verifies the live streak card before release', phase: 'Phase 3 - Release', testStrategy: 'manual-live-gate', designerNeeded: false, roles: ['human'] },
];

const PLANNED: Extract<PlanningRolesOutcome, { kind: 'planned' }> = {
  kind: 'planned',
  title: 'Streak tracker',
  spec: 'Track daily streaks.\n\n## Assumptions\n\n- Resets at midnight.',
  assumptions: ['Resets at midnight'],
  techSpec: 'Pure core + REST + card.',
  tasks: TASKS,
  context: '# Project Context: Streak tracker\n\n## Current State\n\nPlanning complete.',
  codexCritiqueSkipped: false,
};

const QA_PROJECT_EXEMPLAR = [
  '# QA exemplar for Streak tracker',
  '',
  'Pin timezone edge cases with one failing assertion before implementation starts.',
].join('\n');

describe('sizedTasksToMarkdown', () => {
  it('emits a Tests (write first) block listing the code-tests-required tasks', () => {
    const md = sizedTasksToMarkdown(TASKS);
    expect(md).toContain('### Tests (write first)');
    expect(md).toContain('Tests for **p1-core**');
    expect(md).toContain('Tests for **p2-card**');
    // The docs-only task is not a write-first test target.
    expect(md).not.toContain('Tests for **p3-docs**');
    // The manual/live gate is not an automatable write-first test target.
    expect(md).not.toContain('Tests for **p4-live-gate**');
  });

  it('annotates each task with its test strategy and flags designer-needed', () => {
    const md = sizedTasksToMarkdown(TASKS);
    expect(md).toContain('**p1-core** — Streak core');
    expect(md).toContain('Test strategy: `docs-or-config-only`');
    expect(md).toContain('**p2-card** — Home card _(designer review)_');
    expect(md).toContain('**p4-live-gate** — Operator verifies the live streak card before release *(manual/live - not automatable)*');
    expect(md).toContain('Test strategy: `manual-live-gate`');
  });

  it('groups tasks into milestone sections by phase, in first-seen order', () => {
    const md = sizedTasksToMarkdown(TASKS);
    expect(md).toContain('## Phase 1 - Core');
    expect(md).toContain('## Phase 2 - UI');
    expect(md).toContain('## Phase 3 - Release');
    // Phase 1 heading comes before Phase 2.
    expect(md.indexOf('## Phase 1 - Core')).toBeLessThan(md.indexOf('## Phase 2 - UI'));
    // Each phase carries its own Tests (write first) block.
    expect((md.match(/### Tests \(write first\)/g) ?? []).length).toBe(3);
    // p2-card and p3-docs live under Phase 2, after the Phase 2 heading.
    expect(md.indexOf('**p2-card**')).toBeGreaterThan(md.indexOf('## Phase 2 - UI'));
    expect(md.indexOf('**p3-docs**')).toBeGreaterThan(md.indexOf('## Phase 2 - UI'));
  });

  it('collapses unlabeled tasks into a single default phase', () => {
    const flat: SizedTask[] = [
      { id: 'a', text: 'A', testStrategy: 'code-tests-required', designerNeeded: false, roles: [] },
      { id: 'b', text: 'B', testStrategy: 'docs-or-config-only', designerNeeded: false, roles: [] },
    ];
    const md = sizedTasksToMarkdown(flat);
    expect((md.match(/^## /gm) ?? []).length).toBe(1);
    expect(md).toContain('## Phase 1');
  });
});

describe('deriveTestPlan', () => {
  it('groups tasks by test strategy', () => {
    const plan = deriveTestPlan(TASKS);
    expect(plan).toContain('Tests required (write first)');
    expect(plan).toContain('Docs / config only');
    expect(plan).toContain('**p3-docs**: README');
    expect(plan).toContain('Manual/live release gates');
    expect(plan).toContain('**p4-live-gate**: Operator verifies the live streak card before release');
    expect(plan).toContain('Expected operator evidence');
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

  it('preserves per-project exemplars so scaffolding can persist them with the project', () => {
    const plannedWithExemplars = {
      ...PLANNED,
      perProjectExemplars: { qa: QA_PROJECT_EXEMPLAR },
    } as Extract<PlanningRolesOutcome, { kind: 'planned' }>;

    const artifact = plannedOutcomeToArtifact('aura', plannedWithExemplars);

    expect((artifact as any).perProjectExemplars).toMatchObject({ qa: QA_PROJECT_EXEMPLAR });
  });
});
