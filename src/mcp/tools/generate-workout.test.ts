/**
 * Test suite for `src/mcp/tools/generate-workout.ts` — MCP monitoring and
 * health tools, Wave 1b.
 *
 * Pure handler tests: deps are plain vi.fn() fakes — no real agent spawn, no
 * config, no fs. Covers arg re-guarding (enums + notes normalization),
 * success/error passthrough, sanitization, and the never-throws contract.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  generateWorkoutTool,
  NOTES_MAX_CHARS,
  type GenerateWorkoutDeps,
  type GenerateWorkoutInput,
} from './generate-workout.js';

function makeDeps(overrides?: Partial<GenerateWorkoutDeps>): GenerateWorkoutDeps {
  return {
    generate: vi.fn().mockResolvedValue({ markdown: '## Workout\n\nSquats.' }),
    ...overrides,
  };
}

describe('generateWorkoutTool — arg mapping', () => {
  it('passes valid location and focus enums through, notes → extra', async () => {
    const deps = makeDeps();
    await generateWorkoutTool(
      { location: 'gym', focus: 'strength', notes: '30min quick' },
      deps,
    );

    expect(deps.generate).toHaveBeenCalledOnce();
    expect(deps.generate).toHaveBeenCalledWith({
      location: 'gym',
      focus: 'strength',
      extra: '30min quick',
    });
  });

  it('omitted args → location null, focus null, extra ""', async () => {
    const deps = makeDeps();
    await generateWorkoutTool({}, deps);

    expect(deps.generate).toHaveBeenCalledWith({ location: null, focus: null, extra: '' });
  });

  it('invalid enum values (transport not trusted) → treated as null, not an error', async () => {
    const deps = makeDeps();
    const result = await generateWorkoutTool(
      { location: 'garage', focus: 'cardio' } as unknown as GenerateWorkoutInput,
      deps,
    );

    expect(result.isError).toBeFalsy();
    expect(deps.generate).toHaveBeenCalledWith({ location: null, focus: null, extra: '' });
  });

  it('collapses multi-line notes to a single trimmed line', async () => {
    const deps = makeDeps();
    await generateWorkoutTool(
      { notes: '  sore hamstrings\r\nno jumping\n\nkeep it short  ' },
      deps,
    );

    expect(deps.generate).toHaveBeenCalledWith({
      location: null,
      focus: null,
      extra: 'sore hamstrings no jumping keep it short',
    });
  });

  it(`caps notes at ${NOTES_MAX_CHARS} chars`, async () => {
    const deps = makeDeps();
    await generateWorkoutTool({ notes: 'x'.repeat(NOTES_MAX_CHARS + 200) }, deps);

    const call = (deps.generate as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      extra: string;
    };
    expect(call.extra).toHaveLength(NOTES_MAX_CHARS);
    expect(call.extra).toBe('x'.repeat(NOTES_MAX_CHARS));
  });
});

describe('generateWorkoutTool — results', () => {
  it('success → ok result whose text is the generated markdown verbatim', async () => {
    const markdown = '## Workout (gym / strength)\n\n1. Back squat 5x5';
    const deps = makeDeps({ generate: vi.fn().mockResolvedValue({ markdown }) });

    const result = await generateWorkoutTool({ location: 'gym' }, deps);

    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual([{ type: 'text', text: markdown }]);
  });

  it('pipeline {error} → isError result with the sanitizer applied', async () => {
    const deps = makeDeps({
      generate: vi.fn().mockResolvedValue({ error: 'agent failed at /Users/x/vault' }),
      sanitizeError: vi.fn((msg: string) => msg.replace('/Users/x/vault', '<scrubbed>')),
    });

    const result = await generateWorkoutTool({}, deps);

    expect(result.isError).toBe(true);
    const text = result.content[0]!.text;
    expect(text).toContain('<scrubbed>');
    expect(text).not.toContain('/Users/x/vault');
    expect(deps.sanitizeError).toHaveBeenCalledWith('agent failed at /Users/x/vault');
  });

  it('deps rejection → resolves to a sanitized isError result, never throws', async () => {
    const deps = makeDeps({
      generate: vi.fn().mockRejectedValue(new Error('spawn ENOENT /opt/claude')),
      sanitizeError: vi.fn((msg: string) => msg.replace('/opt/claude', '<scrubbed>')),
    });

    await expect(generateWorkoutTool({}, deps)).resolves.toMatchObject({ isError: true });
    const result = await generateWorkoutTool({}, deps);
    expect(result.content[0]!.text).toContain('<scrubbed>');
    expect(result.content[0]!.text).not.toContain('/opt/claude');
  });

  it('deps throwing a non-Error → still resolves to an isError result', async () => {
    const deps = makeDeps({
      generate: vi.fn().mockRejectedValue('string failure'),
    });

    const result = await generateWorkoutTool({}, deps);
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('string failure');
  });
});
