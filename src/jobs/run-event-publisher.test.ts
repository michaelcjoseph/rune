import { describe, expect, it } from 'vitest';

const BASE = {
  runId: 'run-live-001',
  product: 'aura',
  target: { kind: 'project' as const, slug: '01-mvp' },
  ts: '2026-06-23T12:01:05.000Z',
  userId: 42,
};

async function loadPublisher(): Promise<Record<string, unknown>> {
  return import('../transport/notification-bus.js');
}

describe('run-event publisher (cockpit redesign Phase 2)', () => {
  it('turns commit-poll task tallies into BusRun progress events', async () => {
    const mod = await loadPublisher();
    const build = mod['buildRunProgressEventFromCommitPoll'];
    expect(typeof build).toBe('function');
    if (typeof build !== 'function') return;

    expect(build({ ...BASE, tasks: { done: 4, total: 7 } })).toEqual({
      kind: 'run-event',
      subKind: 'progress',
      ...BASE,
      tasks: { done: 4, total: 7 },
    });
  });

  it('turns orchestrated role records into model-bearing agent events', async () => {
    const mod = await loadPublisher();
    const build = mod['buildRunAgentsEventFromTaskRecords'];
    expect(typeof build).toBe('function');
    if (typeof build !== 'function') return;

    expect(build({
      ...BASE,
      records: [{
        rolesInvoked: ['qa', 'coder', 'reviewer'],
        modelChoices: { qa: 'claude', coder: 'codex', reviewer: 'claude' },
      }],
    })).toEqual({
      kind: 'run-event',
      subKind: 'agents',
      ...BASE,
      agents: [
        { role: 'qa', active: true, model: 'claude' },
        { role: 'coder', active: true, model: 'codex' },
        { role: 'reviewer', active: true, model: 'claude' },
      ],
    });
  });

  it('turns transcript tails into redacted BusRun log events', async () => {
    const mod = await loadPublisher();
    const build = mod['buildRunLogEventFromTranscriptTail'];
    expect(typeof build).toBe('function');
    if (typeof build !== 'function') return;

    const rawToken = 'sk-runEventSecret0123456789';
    const event = build({
      ...BASE,
      lines: [`provider failed with token ${rawToken}`, 'coder edited src/server/webview.ts'],
    });

    expect(event).toMatchObject({
      kind: 'run-event',
      subKind: 'log',
      ...BASE,
    });
    expect(event.lines.join('\n')).not.toContain(rawToken);
    expect(event.lines.join('\n')).toMatch(/sk-<redacted-[0-9a-f]{6}>/);
    expect(event.lines).toContain('coder edited src/server/webview.ts');
  });

  it('turns supervision heartbeats into elapsed state events', async () => {
    const mod = await loadPublisher();
    const build = mod['buildRunStateEventFromSupervision'];
    expect(typeof build).toBe('function');
    if (typeof build !== 'function') return;

    expect(build({
      ...BASE,
      run: {
        id: BASE.runId,
        product: BASE.product,
        project: BASE.target.slug,
        status: 'blocked-on-human',
        startedAt: '2026-06-23T12:00:00.000Z',
        lastHeartbeatAt: '2026-06-23T12:01:00.000Z',
        lastChildAliveAt: '2026-06-23T12:01:04.000Z',
      },
      now: Date.parse(BASE.ts),
    })).toEqual({
      kind: 'run-event',
      subKind: 'state',
      ...BASE,
      state: 'parked',
      elapsedMs: 65_000,
    });
  });
});
