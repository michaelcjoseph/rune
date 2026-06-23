import { describe, expect, it } from 'vitest';

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
    [item({ status: 'done' }), 'bug-done'],
    [item({ promotedTo: '17-cockpit-redesign' }), 'already-promoted'],
    [item({ warnings: ['bad-promotion-marker'] }), 'parse-warning'],
  ])('disables ineligible bugs with the v1 disabled reason pattern', async (backlogItem, reason) => {
    const { computeFixAction } = await loadActions();
    expect(computeFixAction(backlogItem, { state: 'gating', attemptId: 'ignored' })).toEqual({
      kind: 'fix',
      state: 'disabled',
      reason,
    });
  });

  it('is bug-only: ideas never expose an available Fix action', async () => {
    const { computeFixAction } = await loadActions();
    expect(computeFixAction(item({ id: 'idea-1', kind: 'ideas' }), undefined)).toEqual({
      kind: 'fix',
      state: 'disabled',
      reason: 'not-a-bug',
    });
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
