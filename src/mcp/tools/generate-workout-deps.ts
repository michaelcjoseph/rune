/**
 * Production dependency binding for the `generate_workout` MCP tool handler.
 *
 * Kept separate from ./generate-workout.ts (the pure handler) because this
 * module pulls src/config.ts (env-var-required at import) through the
 * workout-generation pipeline; src/mcp/server.ts imports THIS module lazily
 * (dynamic import inside the tool handler) so building the MCP server never
 * forces a config load.
 */

import {
  generateWorkout,
  FOCUSES,
  type Focus,
} from '../../health/workout-generation.js';
import { sanitizeMcpError } from './sanitize.js';
import type { GenerateWorkoutDeps } from './generate-workout.js';

/** Agent timeout for the MCP path: 210s leaves headroom under the 240s
 *  per-tool wrapper timeout (TOOL_TIMEOUT_OVERRIDES_MS in src/mcp/metrics.ts)
 *  so the agent's own timeout error surfaces instead of an opaque wrapper
 *  timeout. */
const MCP_AGENT_TIMEOUT_MS = 210_000;

/** Build the live deps bag: the shared workout-generation pipeline bound
 *  with MCP-safe options (not user-visible as an in-flight op; timeout under
 *  the tool wrapper budget). */
export function buildProductionGenerateWorkoutDeps(): GenerateWorkoutDeps {
  return {
    generate: ({ location, focus, extra }) =>
      generateWorkout(
        {
          location,
          // The handler already re-guarded focus against FOCUSES; narrow the
          // deps-contract `string | null` back to the pipeline's Focus type.
          focus: (FOCUSES as readonly string[]).includes(focus ?? '') ? (focus as Focus) : null,
          extra,
        },
        { userVisible: false, agentTimeoutMs: MCP_AGENT_TIMEOUT_MS },
      ),
    sanitizeError: sanitizeMcpError,
  };
}
