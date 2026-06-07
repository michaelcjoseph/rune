/**
 * Project 15 P1.5 test suite for the hard merge gate decision core,
 * `evaluateGate` (src/jobs/work-run-gate.ts). test-plan.md §6 "Gate (each
 * condition stops at branch-complete)".
 *
 * Written TEST-FIRST: `evaluateGate` is a notImplemented scaffold, so every
 * test here is RED until the P1.5 implementation lands. Expected failure mode:
 * a `... not implemented` throw or a clean assertion — NEVER a
 * module-resolution / syntax error.
 *
 * The headline contract: the gate is the line between "autonomous" and "lands
 * broken work on main". It merges ONLY when EVERY condition holds; any single
 * failure returns the typed reason (ordered, first-failure-wins) so the
 * finalizer stops at branch-complete and alerts. Fail-closed: no
 * validationCommands → no merge.
 */

import { describe, it, expect } from 'vitest';
import { evaluateGate, type GateFacts } from './work-run-gate.js';

/** All-green facts: every individual test flips exactly one field to red. */
function greenFacts(over: Partial<GateFacts> = {}): GateFacts {
  return {
    hasValidationCommands: true,
    concurrentRun: false,
    tasksRemaining: 0,
    treeClean: true,
    testsGreen: true,
    validationTimedOut: false,
    mergeConflict: false,
    ...over,
  };
}

describe('evaluateGate — hard merge gate (P1.5)', () => {
  it('passes when every condition holds', () => {
    expect(evaluateGate(greenFacts())).toEqual({ ok: true });
  });

  it('fails closed with missing-validation-command when the product has none', () => {
    expect(evaluateGate(greenFacts({ hasValidationCommands: false }))).toEqual({
      ok: false,
      reason: 'missing-validation-command',
    });
  });

  it('fails with concurrent-run when another run owns the product/base branch', () => {
    expect(evaluateGate(greenFacts({ concurrentRun: true }))).toEqual({
      ok: false,
      reason: 'concurrent-run',
    });
  });

  it('fails with tasks-remaining when original tasks are still unchecked', () => {
    expect(evaluateGate(greenFacts({ tasksRemaining: 2 }))).toEqual({
      ok: false,
      reason: 'tasks-remaining',
    });
  });

  it('fails with dirty-tree when the integration worktree is dirty', () => {
    expect(evaluateGate(greenFacts({ treeClean: false }))).toEqual({
      ok: false,
      reason: 'dirty-tree',
    });
  });

  it('fails with validation-timeout when a validation command timed out', () => {
    expect(evaluateGate(greenFacts({ validationTimedOut: true }))).toEqual({
      ok: false,
      reason: 'validation-timeout',
    });
  });

  it('fails with tests-red when a validation command exited non-zero', () => {
    expect(evaluateGate(greenFacts({ testsGreen: false }))).toEqual({
      ok: false,
      reason: 'tests-red',
    });
  });

  it('fails with merge-conflict when the branch does not merge cleanly onto the base', () => {
    expect(evaluateGate(greenFacts({ mergeConflict: true }))).toEqual({
      ok: false,
      reason: 'merge-conflict',
    });
  });

  it('is ordered first-failure-wins: missing-validation-command precedes every other failure', () => {
    // Everything red at once — the fail-closed missing-command check wins.
    const allRed = greenFacts({
      hasValidationCommands: false,
      concurrentRun: true,
      tasksRemaining: 5,
      treeClean: false,
      testsGreen: false,
      validationTimedOut: true,
      mergeConflict: true,
    });
    expect(evaluateGate(allRed)).toEqual({ ok: false, reason: 'missing-validation-command' });
  });

  it('orders concurrent-run before the cheaper-to-fix conditions', () => {
    // A concurrent run is checked before tasks/tree/tests so two runs racing the
    // same main never both proceed to the expensive validation run.
    const facts = greenFacts({ concurrentRun: true, tasksRemaining: 3, testsGreen: false });
    expect(evaluateGate(facts)).toEqual({ ok: false, reason: 'concurrent-run' });
  });

  it('orders merge-conflict BEFORE the validation result (validating a conflicting branch is moot)', () => {
    // A conflicting branch can't be cleanly set up in the integration worktree,
    // so the conflict probe must win over tests-red / validation-timeout.
    const facts = greenFacts({ mergeConflict: true, testsGreen: false, validationTimedOut: true });
    expect(evaluateGate(facts)).toEqual({ ok: false, reason: 'merge-conflict' });
  });
});
