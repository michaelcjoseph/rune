/**
 * generate_workout MCP tool — runs the workout-generator agent pipeline
 * (src/health/workout-generation.ts) from the Claude App surface.
 *
 * Wave 0 skeleton: the exported signature and the {@link GenerateWorkoutDeps}
 * contract are FINAL; Wave 1 replaces the stub body with the real
 * implementation + tests. Pure handler: config-free, deps-injected.
 */

import { err, type McpTextResult } from './types.js';

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

export async function generateWorkoutTool(
  input: GenerateWorkoutInput,
  deps: GenerateWorkoutDeps,
): Promise<McpTextResult> {
  void input;
  void deps;
  return err('generate_workout is not implemented yet');
}
