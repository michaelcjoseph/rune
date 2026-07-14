/** Shared product-chat diagnostic MCP handler adapter. */

import { createWorkRunDiagnostics } from '../../jobs/work-run-diagnostics.js';
import { buildProductionWorkRunDiagnosticsDeps } from './cockpit-runs-deps.js';
import { sanitizeMcpError } from './sanitize.js';
import { err, errText, ok, type McpTextResult } from './types.js';

export type CockpitRunAction = 'listRuns' | 'inspectRun' | 'activeRuns';

export async function callCockpitRunTool(
  product: string,
  action: CockpitRunAction,
  input: Record<string, unknown> = {},
): Promise<McpTextResult> {
  try {
    const service = createWorkRunDiagnostics(buildProductionWorkRunDiagnosticsDeps(), product);
    const result = action === 'listRuns'
      ? service.listRuns(input as { limit?: number })
      : action === 'inspectRun'
        ? service.inspectRun(input as { runId: string; transcriptLines?: number })
        : service.activeRuns();
    return ok(JSON.stringify(result));
  } catch (error) {
    return err(sanitizeMcpError(errText(error)));
  }
}
