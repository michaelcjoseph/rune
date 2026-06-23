import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function loadStore(): Promise<any> {
  try {
    const mod = await import('./fix-attempt-store.js');
    for (const name of ['appendFixAttempt', 'readLatestFixAttempts', 'getLatestFixAttempt', 'reconcileInterruptedFixAttempts']) {
      expect(mod[name], `expected fix-attempt-store.ts to export ${name}`).toBeTypeOf('function');
    }
    return mod;
  } catch (err) {
    throw new Error(
      `fix-attempt-store module missing or invalid: expected src/jobs/fix-attempt-store.ts with append/read/reconcile exports (${(err as Error).message})`,
    );
  }
}

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fix-attempt-store-'));
  file = join(dir, 'fix-attempts.jsonl');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function attempt(overrides: Record<string, unknown>) {
  return {
    attemptId: 'attempt-1',
    product: 'aura',
    bugId: 'bug-1',
    state: 'gating',
    updatedAt: '2026-06-23T12:00:00.000Z',
    ...overrides,
  };
}

describe('fix-attempt-store - cockpit redesign Phase 3', () => {
  it('persists attempts append-only and returns the newest attempt per product+bug after reload', async () => {
    const { appendFixAttempt, readLatestFixAttempts, getLatestFixAttempt } = await loadStore();

    appendFixAttempt(file, attempt({ attemptId: 'older', state: 'gating', updatedAt: '2026-06-23T12:00:00.000Z' }));
    appendFixAttempt(file, attempt({
      attemptId: 'newer',
      state: 'declined',
      reason: 'pm-not-well-scoped',
      detail: 'No reproduction path.',
      updatedAt: '2026-06-23T12:01:00.000Z',
    }));
    appendFixAttempt(file, attempt({
      attemptId: 'other-bug',
      bugId: 'bug-2',
      state: 'proceeding',
      runId: 'run-accepted',
      updatedAt: '2026-06-23T12:02:00.000Z',
    }));

    expect(existsSync(file)).toBe(true);
    const latest = readLatestFixAttempts(file);
    expect(getLatestFixAttempt(latest, 'aura', 'bug-1')).toMatchObject({
      attemptId: 'newer',
      product: 'aura',
      bugId: 'bug-1',
      state: 'declined',
      reason: 'pm-not-well-scoped',
      detail: 'No reproduction path.',
    });
    expect(getLatestFixAttempt(latest, 'aura', 'bug-2')).toMatchObject({
      attemptId: 'other-bug',
      state: 'proceeding',
      runId: 'run-accepted',
    });
  });

  it('is torn-line tolerant and ignores malformed rows without dropping valid attempts', async () => {
    const { readLatestFixAttempts, getLatestFixAttempt } = await loadStore();
    writeFileSync(
      file,
      [
        JSON.stringify(attempt({ attemptId: 'valid-1', state: 'gating' })),
        '{"attemptId":',
        JSON.stringify(attempt({ attemptId: 'valid-2', bugId: 'bug-2', state: 'handoff-failed', reason: 'handoff-unavailable' })),
        '',
      ].join('\n'),
    );

    const latest = readLatestFixAttempts(file);

    expect(getLatestFixAttempt(latest, 'aura', 'bug-1')).toMatchObject({ attemptId: 'valid-1', state: 'gating' });
    expect(getLatestFixAttempt(latest, 'aura', 'bug-2')).toMatchObject({
      attemptId: 'valid-2',
      state: 'handoff-failed',
      reason: 'handoff-unavailable',
    });
  });

  it('reconciles crash-stranded gating attempts to interrupted so a bug is retryable after restart', async () => {
    const { appendFixAttempt, readLatestFixAttempts, getLatestFixAttempt, reconcileInterruptedFixAttempts } = await loadStore();
    appendFixAttempt(file, attempt({
      attemptId: 'stale-gate',
      state: 'gating',
      detail: 'PM/TL gate started before daemon restart.',
      updatedAt: '2026-06-23T12:00:00.000Z',
    }));
    appendFixAttempt(file, attempt({
      attemptId: 'already-terminal',
      bugId: 'bug-2',
      state: 'declined',
      reason: 'tech-lead-objection',
      detail: 'Needs migration.',
      updatedAt: '2026-06-23T12:00:05.000Z',
    }));

    const changed = reconcileInterruptedFixAttempts(file, { now: () => '2026-06-23T12:05:00.000Z' });
    const latest = readLatestFixAttempts(file);

    expect(changed).toEqual([
      expect.objectContaining({
        product: 'aura',
        bugId: 'bug-1',
        state: 'interrupted',
        detail: expect.stringContaining('stale-gate'),
      }),
    ]);
    expect(getLatestFixAttempt(latest, 'aura', 'bug-1')).toMatchObject({
      product: 'aura',
      bugId: 'bug-1',
      state: 'interrupted',
      updatedAt: '2026-06-23T12:05:00.000Z',
    });
    expect(getLatestFixAttempt(latest, 'aura', 'bug-2')).toMatchObject({
      attemptId: 'already-terminal',
      state: 'declined',
    });
    expect(readFileSync(file, 'utf8')).toContain('"state":"interrupted"');
  });
});
