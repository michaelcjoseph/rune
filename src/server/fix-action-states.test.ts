import { describe, expect, it } from 'vitest';
import type { FixAttemptState } from '../jobs/fix-attempt-store.js';

async function loadActions(): Promise<any> {
  const mod = await import('./backlog-actions.js');
  expect(mod.computeFixAction, 'expected backlog-actions.ts to export computeFixAction').toBeTypeOf('function');
  return mod;
}

function item(overrides: Record<string, unknown> = {}) {
  return {
    id: 'bug-1',
    kind: 'bugs',
    text: 'Bug title',
    status: 'open',
    body: ['Repro steps'],
    section: 'user-authored',
    source: { file: 'docs/projects/bugs.md', lineNumber: 1, raw: '- [ ] Bug title' },
    warnings: [],
    ...overrides,
  };
}

describe('computeFixAction - cockpit redesign Phase 3', () => {
  it('returns available for an eligible open bug with no persisted attempt', async () => {
    const { computeFixAction } = await loadActions();
    expect(computeFixAction(item(), undefined)).toEqual({ kind: 'fix', state: 'available' });
  });

  it.each([
    ['bug-done', item({ status: 'done' })],
    ['already-promoted', item({ promotedTo: '17-cockpit-redesign' })],
    ['parse-warning', item({ warnings: ['bad-promotion-marker'] })],
  ])('disables an ineligible bug with %s using the v1 disabled reason pattern', async (reason, backlogItem) => {
    const { computeFixAction } = await loadActions();
    expect(
      computeFixAction(backlogItem, {
        attemptId: 'persisted-state-must-not-win',
        state: 'proceeding',
        runId: 'run-should-not-surface',
      }),
    ).toEqual({
      kind: 'fix',
      state: 'disabled',
      reason,
    });
  });

  it.each([
    ['already-promoted', item({ promotedTo: '17-cockpit-redesign', status: 'done' })],
    ['already-promoted', item({ promotedTo: '17-cockpit-redesign', warnings: ['bad-promotion-marker'] })],
    ['bug-done', item({ status: 'done', warnings: ['bad-promotion-marker'] })],
  ])('uses Plan precedence and returns %s when multiple bug-disabled reasons apply', async (reason, backlogItem) => {
    const { computeFixAction } = await loadActions();
    expect(computeFixAction(backlogItem, undefined)).toEqual({
      kind: 'fix',
      state: 'disabled',
      reason,
    });
  });

  it('is bug-only: ideas never expose an available Fix action', async () => {
    const { computeFixAction } = await loadActions();
    expect(
      computeFixAction(
        item({ id: 'idea-1', kind: 'ideas' }),
        { attemptId: 'attempt-on-wrong-kind', state: 'gating' },
      ),
    ).toEqual({ kind: 'fix', state: 'disabled', reason: 'not-a-bug' });
  });

  it.each([
    [{ attemptId: 'a1', state: 'gating' }, { kind: 'fix', state: 'gating' }],
    [
      { attemptId: 'a2', state: 'declined', reason: 'pm-not-well-scoped', detail: 'Needs repro.' },
      { kind: 'fix', state: 'declined', reason: 'pm-not-well-scoped', detail: 'Needs repro.' },
    ],
    [
      { attemptId: 'a3', state: 'handoff-failed', reason: 'handoff-unavailable', detail: 'startFixRun unavailable.' },
      { kind: 'fix', state: 'handoff-failed', reason: 'handoff-unavailable', detail: 'startFixRun unavailable.' },
    ],
    [
      { attemptId: 'a4', state: 'proceeding', runId: 'run-fix-1' },
      { kind: 'fix', state: 'proceeding', runId: 'run-fix-1' },
    ],
  ])('reflects persisted attempt state %j', async (attempt, expected) => {
    const { computeFixAction } = await loadActions();
    expect(computeFixAction(item(), attempt)).toEqual(expected);
  });

  it.each(['fixed', 'failed', 'parked-on-human'] as const)(
    'preserves the post-dispatch %s terminal, its diagnosis, and its transcript run id',
    async (state) => {
      const { computeFixAction } = await loadActions();
      const action = computeFixAction(item(), {
        attemptId: `${state}-attempt`,
        state: state as FixAttemptState,
        reason: `${state}-outcome`,
        detail: `${state}-detail`,
        runId: `${state}-run`,
      });
      expect(action).toEqual({
        kind: 'fix',
        state,
        reason: `${state}-outcome`,
        detail: `${state}-detail`,
        runId: `${state}-run`,
      });
    },
  );

  it('renders an interrupted attempt as available again with the prior attempt detail', async () => {
    const { computeFixAction } = await loadActions();
    expect(
      computeFixAction(item(), {
        attemptId: 'stale-gate',
        state: 'interrupted',
        detail: 'Previous gate was interrupted by restart.',
      }),
    ).toEqual({
      kind: 'fix',
      state: 'available',
      detail: 'Previous gate was interrupted by restart.',
    });
  });
});
