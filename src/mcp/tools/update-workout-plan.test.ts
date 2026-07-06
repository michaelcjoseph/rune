/**
 * Tests for src/mcp/tools/update-workout-plan.ts — the pure handler with
 * fake deps.
 *
 * Config-free on purpose: imports the pure handler module only, never
 * ./update-workout-plan-deps.ts (which pulls src/config.ts at import).
 */

import { describe, it, expect, vi } from 'vitest';

import { updateWorkoutPlan, type UpdateWorkoutPlanDeps } from './update-workout-plan.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PLAN = [
  '# Weekly Plan',
  '',
  '## Monday',
  '- Back squat 5x5',
  '- RDL 3x8',
  '',
  '## Wednesday',
  '- Bench press 5x5',
].join('\n');

function makeDeps(overrides?: Partial<UpdateWorkoutPlanDeps>): UpdateWorkoutPlanDeps {
  return {
    readPlan: vi.fn().mockResolvedValue(null),
    writePlan: vi.fn().mockResolvedValue(undefined),
    getTodayDate: vi.fn().mockReturnValue('2026-07-06'),
    commitAndPush: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function writtenContent(deps: UpdateWorkoutPlanDeps): string {
  return vi.mocked(deps.writePlan).mock.calls[0]![0];
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

describe('updateWorkoutPlan — guards', () => {
  it('content shorter than 50 chars after trim → isError, no write, no commit', async () => {
    const deps = makeDeps();

    const result = await updateWorkoutPlan(
      { content: '# Plan\n- squats  ', reason: 'valid reason' },
      deps,
    );

    expect(result.isError).toBe(true);
    expect(deps.writePlan).not.toHaveBeenCalled();
    expect(deps.commitAndPush).not.toHaveBeenCalled();
  });

  it('content without any markdown heading → the exact no-heading error', async () => {
    const deps = makeDeps();

    const result = await updateWorkoutPlan(
      { content: 'just a long run of plain prose with no heading anywhere at all', reason: 'valid reason' },
      deps,
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toBe(
      'content must be a complete markdown plan document (no heading found)',
    );
    expect(deps.writePlan).not.toHaveBeenCalled();
    expect(deps.commitAndPush).not.toHaveBeenCalled();
  });

  it('reason too short or too long → isError, no write, no commit', async () => {
    const deps = makeDeps();

    const short = await updateWorkoutPlan({ content: PLAN, reason: 'ab' }, deps);
    expect(short.isError).toBe(true);

    const long = await updateWorkoutPlan({ content: PLAN, reason: 'x'.repeat(201) }, deps);
    expect(long.isError).toBe(true);

    expect(deps.writePlan).not.toHaveBeenCalled();
    expect(deps.commitAndPush).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Behavior
// ---------------------------------------------------------------------------

describe('updateWorkoutPlan — behavior', () => {
  it('identical submitted content (before footer handling) → no-op ok, no write, no commit', async () => {
    const deps = makeDeps({ readPlan: vi.fn().mockResolvedValue(PLAN) });

    const result = await updateWorkoutPlan({ content: PLAN, reason: 'no real change' }, deps);

    expect(result.isError).toBeFalsy();
    expect(result.content[0]!.text).toBe('No change — plan.md already matches.');
    expect(deps.writePlan).not.toHaveBeenCalled();
    expect(deps.commitAndPush).not.toHaveBeenCalled();
  });

  it('appends exactly one fresh footer to clean content', async () => {
    const deps = makeDeps();

    const result = await updateWorkoutPlan({ content: PLAN, reason: 'add wednesday bench' }, deps);

    expect(result.isError).toBeFalsy();
    const written = writtenContent(deps);
    expect(written.startsWith('# Weekly Plan')).toBe(true);
    expect(written.endsWith('\n\n> Updated 2026-07-06 via MCP: add wednesday bench\n')).toBe(true);
    expect(written.match(/^> Updated /gm)).toHaveLength(1);
  });

  it('strips round-tripped trailing footers before appending the fresh one (no accumulation)', async () => {
    const deps = makeDeps({ readPlan: vi.fn().mockResolvedValue('# Old plan\nstuff') });
    const roundTripped =
      PLAN +
      '\n\n> Updated 2026-06-20 via MCP: earlier tweak\n\n> Updated 2026-07-01 via MCP: another tweak\n';

    const result = await updateWorkoutPlan(
      { content: roundTripped, reason: 'swap RDLs for good mornings' },
      deps,
    );

    expect(result.isError).toBeFalsy();
    const written = writtenContent(deps);
    expect(written.match(/^> Updated /gm)).toHaveLength(1);
    expect(written).not.toContain('2026-06-20');
    expect(written).not.toContain('2026-07-01');
    expect(written.endsWith('\n\n> Updated 2026-07-06 via MCP: swap RDLs for good mornings\n')).toBe(
      true,
    );
    // Body preserved
    expect(written).toContain('- Bench press 5x5');
  });

  it('multi-line reason is collapsed in both the footer and the commit message', async () => {
    const deps = makeDeps();

    await updateWorkoutPlan({ content: PLAN, reason: 'line one\nline two' }, deps);

    expect(writtenContent(deps)).toContain('> Updated 2026-07-06 via MCP: line one line two');
    expect(deps.commitAndPush).toHaveBeenCalledExactlyOnceWith(
      'update_workout_plan: line one line two',
    );
  });

  it('writes before committing; commit is NOT called when the write throws', async () => {
    const deps = makeDeps({
      writePlan: vi.fn().mockRejectedValue(new Error('disk full')),
    });

    const result = await updateWorkoutPlan({ content: PLAN, reason: 'valid reason' }, deps);

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('disk full');
    expect(deps.commitAndPush).not.toHaveBeenCalled();
  });

  it('write-then-commit ordering on success', async () => {
    const deps = makeDeps();

    await updateWorkoutPlan({ content: PLAN, reason: 'valid reason' }, deps);

    const writeOrder = vi.mocked(deps.writePlan).mock.invocationCallOrder[0]!;
    const commitOrder = vi.mocked(deps.commitAndPush).mock.invocationCallOrder[0]!;
    expect(writeOrder).toBeLessThan(commitOrder);
  });

  it('commit failure → isError with the written-but-NOT-yet-durable wording', async () => {
    const deps = makeDeps({
      commitAndPush: vi.fn().mockRejectedValue(new Error('push failed')),
    });

    const result = await updateWorkoutPlan({ content: PLAN, reason: 'valid reason' }, deps);

    expect(result.isError).toBe(true);
    expect(deps.writePlan).toHaveBeenCalledOnce();
    expect(result.content[0]!.text).toMatch(/written .*NOT yet durable \(git commit failed\)/);
    expect(result.content[0]!.text).toContain('push failed');
  });

  it('success message reports old and new line counts + git recoverability', async () => {
    const deps = makeDeps({ readPlan: vi.fn().mockResolvedValue('a\nb\nc') });

    const result = await updateWorkoutPlan({ content: PLAN, reason: 'valid reason' }, deps);

    expect(result.isError).toBeFalsy();
    const nowLines = writtenContent(deps).split('\n').length;
    expect(result.content[0]!.text).toBe(
      `Plan updated (was 3 lines, now ${nowLines}). Previous version recoverable via vault git.`,
    );
  });

  it('absent current plan (null) → proceeds and reports was 0 lines', async () => {
    const deps = makeDeps();

    const result = await updateWorkoutPlan({ content: PLAN, reason: 'valid reason' }, deps);

    expect(result.isError).toBeFalsy();
    expect(result.content[0]!.text).toContain('(was 0 lines,');
  });
});
