import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

const DEFAULT_TOOL_TIMEOUT_MS = 30_000;
const LATENCY_WINDOW_SIZE = 1_024;

/** Per-tool timeout overrides — tools whose legitimate runtime exceeds the
 *  global RUNE_MCP_TOOL_TIMEOUT_MS (e.g. agent-spawning tools). An entry here
 *  wins over the env var for that tool only. */
const TOOL_TIMEOUT_OVERRIDES_MS: Record<string, number> = {
  generate_workout: 240_000,
  kb_query: 180_000,
};

export interface McpToolLatencySnapshot {
  p50: number | null;
  p95: number | null;
  p99: number | null;
  sampleCount: number;
  windowSize: number;
}

export interface McpToolMetricsSnapshot {
  calls: number;
  errors: number;
  timeouts: number;
  latencyMs: McpToolLatencySnapshot;
}

export interface McpMetricsSnapshot {
  totals: {
    calls: number;
    errors: number;
    timeouts: number;
  };
  tools: Record<string, McpToolMetricsSnapshot>;
}

interface ToolMetrics {
  calls: number;
  errors: number;
  timeouts: number;
  latencies: number[];
  nextLatencyIndex: number;
}

export type McpToolCallback = (...args: unknown[]) => CallToolResult | Promise<CallToolResult>;

class TimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`MCP tool timed out after ${timeoutMs}ms`);
  }
}

const tools = new Map<string, ToolMetrics>();
const totals = {
  calls: 0,
  errors: 0,
  timeouts: 0,
};

function parseToolTimeoutMs(): number {
  const raw = process.env['RUNE_MCP_TOOL_TIMEOUT_MS'];
  if (raw === undefined) return DEFAULT_TOOL_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_TOOL_TIMEOUT_MS;
  return Math.floor(parsed);
}

function getToolMetrics(toolName: string): ToolMetrics {
  const existing = tools.get(toolName);
  if (existing) return existing;
  const created: ToolMetrics = {
    calls: 0,
    errors: 0,
    timeouts: 0,
    latencies: [],
    nextLatencyIndex: 0,
  };
  tools.set(toolName, created);
  return created;
}

function observeLatency(metrics: ToolMetrics, latencyMs: number): void {
  const sample = Math.max(0, Math.round(latencyMs));
  if (metrics.latencies.length < LATENCY_WINDOW_SIZE) {
    metrics.latencies.push(sample);
    return;
  }
  metrics.latencies[metrics.nextLatencyIndex] = sample;
  metrics.nextLatencyIndex = (metrics.nextLatencyIndex + 1) % LATENCY_WINDOW_SIZE;
}

function percentile(samples: number[], p: number): number | null {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index] ?? null;
}

function latencySnapshot(metrics: ToolMetrics): McpToolLatencySnapshot {
  return {
    p50: percentile(metrics.latencies, 50),
    p95: percentile(metrics.latencies, 95),
    p99: percentile(metrics.latencies, 99),
    sampleCount: metrics.latencies.length,
    windowSize: LATENCY_WINDOW_SIZE,
  };
}

function isToolErrorResult(result: CallToolResult): boolean {
  return result.isError === true;
}

function timeoutResult(timeoutMs: number): CallToolResult {
  return {
    content: [{ type: 'text', text: `Tool timed out after ${timeoutMs}ms` }],
    isError: true,
  };
}

export function instrumentMcpTool(toolName: string, callback: McpToolCallback): McpToolCallback {
  return async (...args: unknown[]): Promise<CallToolResult> => {
    const startedAt = performance.now();
    // Still resolved at call time so env/test changes keep applying.
    const timeoutMs = TOOL_TIMEOUT_OVERRIDES_MS[toolName] ?? parseToolTimeoutMs();
    let timer: NodeJS.Timeout | undefined;
    let timedOut = false;

    const execution = Promise.resolve().then(() => callback(...args));
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        reject(new TimeoutError(timeoutMs));
      }, timeoutMs);
      timer.unref();
    });

    try {
      const result = await Promise.race([execution, timeout]);
      recordMcpToolCall(toolName, {
        latencyMs: performance.now() - startedAt,
        error: isToolErrorResult(result),
        timeout: false,
      });
      return result;
    } catch (err) {
      if (err instanceof TimeoutError) {
        execution.catch(() => undefined);
        recordMcpToolCall(toolName, {
          latencyMs: performance.now() - startedAt,
          error: true,
          timeout: true,
        });
        return timeoutResult(err.timeoutMs);
      }
      recordMcpToolCall(toolName, {
        latencyMs: performance.now() - startedAt,
        error: true,
        timeout: timedOut,
      });
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
}

export function recordMcpToolCall(
  toolName: string,
  observation: { latencyMs: number; error: boolean; timeout: boolean },
): void {
  const metrics = getToolMetrics(toolName);
  metrics.calls += 1;
  totals.calls += 1;
  if (observation.error) {
    metrics.errors += 1;
    totals.errors += 1;
  }
  if (observation.timeout) {
    metrics.timeouts += 1;
    totals.timeouts += 1;
  }
  observeLatency(metrics, observation.latencyMs);
}

export function getMcpMetricsSnapshot(): McpMetricsSnapshot {
  const toolEntries = [...tools.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, metrics]) => [
      name,
      {
        calls: metrics.calls,
        errors: metrics.errors,
        timeouts: metrics.timeouts,
        latencyMs: latencySnapshot(metrics),
      },
    ] as const);

  return {
    totals: { ...totals },
    tools: Object.fromEntries(toolEntries),
  };
}
