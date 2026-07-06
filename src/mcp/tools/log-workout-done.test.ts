/**
 * Test suite for `src/mcp/tools/log-workout-done.ts` — MCP monitoring and
 * health tools, Wave 1b.
 *
 * Pure handler tests: deps are plain vi.fn() fakes — no real fs, no vault, no
 * git. Covers the read gate (missing/corrupt), the confirm_stale staleness
 * gate, notes normalization, journal-append failure (file preserved),
 * best-effort clear, commit-failure durability wording, and block content.
 */

import { describe, it, expect, vi } from 'vitest';
import type { LastWorkout } from '../../health/last-workout.js';
import {
  logWorkoutDone,
  COMPLETION_NOTES_MAX_CHARS,
  type LogWorkoutDoneDeps,
} from './log-workout-done.js';

const NOW = Date.parse('2026-07-06T12:00:00.000Z');

function makeEntry(overrides?: Partial<LastWorkout>): LastWorkout {
  return {
    generated_at: new Date(NOW - 3_600_000).toISOString(), // 1h old — fresh
    location: 'gym',
    focus: 'strength',
    markdown: '## Workout\n\n1. Back squat 5x5',
    structured: {},
    ...overrides,
  };
}

function makeDeps(overrides?: Partial<LogWorkoutDoneDeps>): LogWorkoutDoneDeps {
  return {
    readLastWorkout: vi.fn().mockReturnValue({ status: 'ok', entry: makeEntry() }),
    formatBlock: vi.fn(
      (entry: LastWorkout) => `#workout\n\n**Generated workout** — ${entry.generated_at}\n\n${entry.markdown}`,
    ),
    appendToJournal: vi.fn().mockReturnValue('journal/2026_07_06.md'),
    clearLastWorkout: vi.fn(),
    nowMs: () => NOW,
    commitAndPush: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function staleEntry(hoursOld: number): LastWorkout {
  return makeEntry({ generated_at: new Date(NOW - hoursOld * 3_600_000).toISOString() });
}

describe('logWorkoutDone — read gate', () => {
  it('missing artifact → isError pointing at generate_workout, no append/clear/commit', async () => {
    const deps = makeDeps({ readLastWorkout: vi.fn().mockReturnValue({ status: 'missing' }) });

    const result = await logWorkoutDone({}, deps);

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toBe('Nothing to log — call generate_workout first.');
    expect(deps.appendToJournal).not.toHaveBeenCalled();
    expect(deps.clearLastWorkout).not.toHaveBeenCalled();
    expect(deps.commitAndPush).not.toHaveBeenCalled();
  });

  it('corrupt artifact → isError saying the file is corrupt, no append/clear/commit', async () => {
    const deps = makeDeps({ readLastWorkout: vi.fn().mockReturnValue({ status: 'corrupt' }) });

    const result = await logWorkoutDone({}, deps);

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/corrupt/i);
    expect(deps.appendToJournal).not.toHaveBeenCalled();
    expect(deps.clearLastWorkout).not.toHaveBeenCalled();
    expect(deps.commitAndPush).not.toHaveBeenCalled();
  });
});

describe('logWorkoutDone — staleness gate', () => {
  it('>48h old without confirm_stale → isError with ~age and the confirm_stale hint, nothing written', async () => {
    const deps = makeDeps({
      readLastWorkout: vi.fn().mockReturnValue({ status: 'ok', entry: staleEntry(50) }),
    });

    const result = await logWorkoutDone({}, deps);

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('~50h ago');
    expect(result.content[0]!.text).toContain('confirm_stale: true');
    expect(deps.appendToJournal).not.toHaveBeenCalled();
    expect(deps.clearLastWorkout).not.toHaveBeenCalled();
    expect(deps.commitAndPush).not.toHaveBeenCalled();
  });

  it('>48h old WITH confirm_stale: true → logs normally', async () => {
    const deps = makeDeps({
      readLastWorkout: vi.fn().mockReturnValue({ status: 'ok', entry: staleEntry(50) }),
    });

    const result = await logWorkoutDone({ confirm_stale: true }, deps);

    expect(result.isError).toBeFalsy();
    expect(deps.appendToJournal).toHaveBeenCalledOnce();
    expect(deps.clearLastWorkout).toHaveBeenCalledOnce();
    expect(deps.commitAndPush).toHaveBeenCalledOnce();
  });

  it('exactly 48h old is NOT stale — no confirm needed', async () => {
    const deps = makeDeps({
      readLastWorkout: vi.fn().mockReturnValue({ status: 'ok', entry: staleEntry(48) }),
    });

    const result = await logWorkoutDone({}, deps);

    expect(result.isError).toBeFalsy();
    expect(deps.appendToJournal).toHaveBeenCalledOnce();
  });
});

describe('logWorkoutDone — journal block', () => {
  it('appends exactly the formatBlock output when no notes are given', async () => {
    const entry = makeEntry();
    const deps = makeDeps({
      readLastWorkout: vi.fn().mockReturnValue({ status: 'ok', entry }),
    });

    await logWorkoutDone({}, deps);

    expect(deps.formatBlock).toHaveBeenCalledWith(entry);
    const expectedBlock = `#workout\n\n**Generated workout** — ${entry.generated_at}\n\n${entry.markdown}`;
    expect(deps.appendToJournal).toHaveBeenCalledWith(expectedBlock);
  });

  it('appends a Completion notes line when notes are given, single-lined', async () => {
    const deps = makeDeps();

    await logWorkoutDone({ notes: ' felt strong\r\nskipped cooldown\n\nRPE 8 ' }, deps);

    const appended = (deps.appendToJournal as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    expect(appended).toContain('**Completion notes:** felt strong skipped cooldown RPE 8');
    // Block body precedes the notes line.
    expect(appended.indexOf('#workout')).toBeLessThan(appended.indexOf('**Completion notes:**'));
  });

  it(`caps completion notes at ${COMPLETION_NOTES_MAX_CHARS} chars`, async () => {
    const deps = makeDeps();

    await logWorkoutDone({ notes: 'n'.repeat(COMPLETION_NOTES_MAX_CHARS + 300) }, deps);

    const appended = (deps.appendToJournal as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    expect(appended).toContain(`**Completion notes:** ${'n'.repeat(COMPLETION_NOTES_MAX_CHARS)}`);
    expect(appended).not.toContain('n'.repeat(COMPLETION_NOTES_MAX_CHARS + 1));
  });
});

describe('logWorkoutDone — failure paths', () => {
  it('journal-append failure → isError, last-workout NOT cleared, no commit', async () => {
    const deps = makeDeps({
      appendToJournal: vi.fn().mockRejectedValue(new Error('EACCES /vault/journal')),
      sanitizeError: vi.fn((msg: string) => msg.replace('/vault/journal', '<scrubbed>')),
    });

    const result = await logWorkoutDone({}, deps);

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('<scrubbed>');
    expect(result.content[0]!.text).not.toContain('/vault/journal');
    expect(deps.clearLastWorkout).not.toHaveBeenCalled();
    expect(deps.commitAndPush).not.toHaveBeenCalled();
  });

  it('clearLastWorkout failure → still a success result, with a warning appended', async () => {
    const deps = makeDeps({
      clearLastWorkout: vi.fn(() => {
        throw new Error('EPERM unlink');
      }),
    });

    const result = await logWorkoutDone({}, deps);

    expect(result.isError).toBeFalsy();
    expect(result.content[0]!.text).toMatch(/warning/i);
    expect(result.content[0]!.text).toMatch(/clear|duplicate|twice/i);
    // The log still commits — a stuck artifact must not block durability.
    expect(deps.commitAndPush).toHaveBeenCalledOnce();
  });

  it('commit failure → isError distinguishing "logged but NOT durable" from clean success', async () => {
    const deps = makeDeps({
      commitAndPush: vi.fn().mockRejectedValue(new Error('push failed')),
    });

    const result = await logWorkoutDone({}, deps);

    expect(result.isError).toBe(true);
    // The append DID happen; the error must say so and flag non-durability.
    expect(deps.appendToJournal).toHaveBeenCalledOnce();
    const text = result.content[0]!.text;
    expect(text).toMatch(/logged to the journal/i);
    expect(text).toMatch(/NOT durable/);
    expect(text).toMatch(/git|commit|push/i);
  });

  it('unexpected deps throw (readLastWorkout) → resolves to isError, never throws', async () => {
    const deps = makeDeps({
      readLastWorkout: vi.fn(() => {
        throw new Error('boom');
      }),
    });

    await expect(logWorkoutDone({}, deps)).resolves.toMatchObject({ isError: true });
  });
});

describe('logWorkoutDone — success', () => {
  it('names what was logged and mentions the nightly parse', async () => {
    const deps = makeDeps();

    const result = await logWorkoutDone({}, deps);

    expect(result.isError).toBeFalsy();
    const text = result.content[0]!.text;
    expect(text).toContain('gym / strength');
    expect(text).toContain('workouts.json');
    // Commit subject carries the short tag + date.
    const commitMsg = (deps.commitAndPush as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    expect(commitMsg).toMatch(/^log_workout_done: gym \/ strength \(\d{4}-\d{2}-\d{2}\)$/);
  });
});
