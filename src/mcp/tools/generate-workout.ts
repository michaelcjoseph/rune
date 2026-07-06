/**
 * generate_workout MCP tool — runs the workout-generator agent pipeline
 * (src/health/workout-generation.ts) from the Claude App surface.
 *
 * PURE MODULE: the pipeline call is injected via {@link GenerateWorkoutDeps};
 * the production binding lives in ./generate-workout-deps.ts. Never throws —
 * every failure path resolves to an `isError` result.
 */

import { errText, ok, err, type McpTextResult } from './types.js';

/** Enum allowlists re-validated here — never trust the transport layer to
 *  have enforced its schema (mirrors src/health/workout-generation.ts). */
const LOCATIONS = ['home', 'gym'] as const;
const FOCUSES = ['mobility', 'endurance', 'strength', 'speed', 'power'] as const;

/** Trust-boundary cap on the free-text notes arg (matches the z.string()
 *  max in the server registration). Truncated, not rejected — notes are
 *  advisory context for the generator, not an identity-bearing field. */
export const NOTES_MAX_CHARS = 500;

export interface GenerateWorkoutDeps {
  /** Runs the workout-generation pipeline (generateWorkout from
   *  src/health/workout-generation.ts, bound with MCP-safe opts:
   *  userVisible false + a timeout under the tool's 240s wrapper budget). */
  generate(args: {
    location: 'home' | 'gym' | null;
    focus: string | null;
    extra: string;
  }): Promise<{ markdown: string } | { error: string }>;
  sanitizeError?(msg: string): string;
}

export interface GenerateWorkoutInput {
  location?: 'home' | 'gym';
  focus?: 'mobility' | 'endurance' | 'strength' | 'speed' | 'power';
  notes?: string;
}

/** Collapse embedded newlines — the args line the generator prompt embeds is
 *  a single-line surface. */
function singleLine(text: string): string {
  return text.replace(/[\r\n]+/g, ' ').trim();
}

export async function generateWorkoutTool(
  input: GenerateWorkoutInput,
  deps: GenerateWorkoutDeps,
): Promise<McpTextResult> {
  const clean = deps.sanitizeError ?? ((s: string) => s);

  // Re-guard enums: an invalid value degrades to null ("infer it") rather
  // than erroring — the pipeline treats null as "not specified".
  const location = (LOCATIONS as readonly string[]).includes(input.location as string)
    ? (input.location as 'home' | 'gym')
    : null;
  const focus = (FOCUSES as readonly string[]).includes(input.focus as string)
    ? (input.focus as string)
    : null;
  const extra = typeof input.notes === 'string'
    ? singleLine(input.notes).slice(0, NOTES_MAX_CHARS)
    : '';

  try {
    const result = await deps.generate({ location, focus, extra });
    if ('error' in result) {
      return err(clean(result.error));
    }
    return ok(result.markdown);
  } catch (thrown) {
    return err(`generate_workout failed: ${clean(errText(thrown))}`);
  }
}
