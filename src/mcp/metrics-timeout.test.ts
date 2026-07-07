/**
 * Behavioral tests for the per-tool timeout override in src/mcp/metrics.ts
 * (MCP monitoring and health tools, Wave 1b).
 *
 * The override map (TOOL_TIMEOUT_OVERRIDES_MS) is module-private, so these
 * tests pin its behavior through instrumentMcpTool with fake timers: a tool
 * with an override (generate_workout → 240s, kb_query → 180s) must survive
 * both the 30s global default and any RUNE_MCP_TOOL_TIMEOUT_MS env value,
 * while every other tool still times out at the global/env value.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { getMcpMetricsSnapshot, instrumentMcpTool } from './metrics.js';

const GLOBAL_DEFAULT_MS = 30_000;
const GENERATE_WORKOUT_OVERRIDE_MS = 240_000;
const KB_QUERY_OVERRIDE_MS = 180_000;

const ORIGINAL_ENV_TIMEOUT = process.env['RUNE_MCP_TOOL_TIMEOUT_MS'];

function neverSettles(): Promise<CallToolResult> {
  return new Promise<CallToolResult>(() => {});
}

function textOf(result: CallToolResult): string {
  const content = result.content as Array<{ type: string; text: string }>;
  expect(content).toHaveLength(1);
  return content[0]!.text;
}

/** Start the wrapped call and track settlement so tests can assert the
 *  promise is still PENDING after a given fake-time advance. */
function startTracked(pending: Promise<CallToolResult> | CallToolResult): {
  promise: Promise<CallToolResult>;
  isSettled: () => boolean;
} {
  let settled = false;
  const promise = Promise.resolve(pending);
  void promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  return { promise, isSettled: () => settled };
}

beforeEach(() => {
  vi.useFakeTimers();
  delete process.env['RUNE_MCP_TOOL_TIMEOUT_MS'];
});

afterEach(() => {
  vi.useRealTimers();
  if (ORIGINAL_ENV_TIMEOUT === undefined) {
    delete process.env['RUNE_MCP_TOOL_TIMEOUT_MS'];
  } else {
    process.env['RUNE_MCP_TOOL_TIMEOUT_MS'] = ORIGINAL_ENV_TIMEOUT;
  }
});

describe('per-tool timeout override (generate_workout)', () => {
  it('does NOT time out at the 30s global default, but does at 240s with an isError result', async () => {
    const wrapped = instrumentMcpTool('generate_workout', neverSettles);
    const call = startTracked(wrapped());

    await vi.advanceTimersByTimeAsync(GLOBAL_DEFAULT_MS);
    expect(call.isSettled()).toBe(false);

    // A comfortable margin past the default, still under the override.
    await vi.advanceTimersByTimeAsync(100_000);
    expect(call.isSettled()).toBe(false);

    await vi.advanceTimersByTimeAsync(GENERATE_WORKOUT_OVERRIDE_MS - GLOBAL_DEFAULT_MS - 100_000);
    const result = await call.promise;

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain(`timed out after ${GENERATE_WORKOUT_OVERRIDE_MS}ms`);

    const metrics = getMcpMetricsSnapshot().tools['generate_workout'];
    expect(metrics).toBeDefined();
    expect(metrics!.timeouts).toBeGreaterThanOrEqual(1);
    expect(metrics!.errors).toBeGreaterThanOrEqual(1);
  });

  it('wins over a shorter RUNE_MCP_TOOL_TIMEOUT_MS env value', async () => {
    process.env['RUNE_MCP_TOOL_TIMEOUT_MS'] = '50';

    const wrapped = instrumentMcpTool('generate_workout', neverSettles);
    const call = startTracked(wrapped());

    await vi.advanceTimersByTimeAsync(50);
    expect(call.isSettled()).toBe(false);
    await vi.advanceTimersByTimeAsync(GLOBAL_DEFAULT_MS);
    expect(call.isSettled()).toBe(false);

    // Drain the override timer so the test leaves no dangling fake timer.
    await vi.advanceTimersByTimeAsync(GENERATE_WORKOUT_OVERRIDE_MS);
    const result = await call.promise;
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain(`timed out after ${GENERATE_WORKOUT_OVERRIDE_MS}ms`);
  });

  it('passes a fast result through unchanged (override never delays success)', async () => {
    const success: CallToolResult = { content: [{ type: 'text', text: 'done' }] };
    const wrapped = instrumentMcpTool('generate_workout', () => success);

    const result = await wrapped();
    expect(result).toBe(success);
    expect(result.isError).toBeFalsy();
  });
});

describe('per-tool timeout override (kb_query — spawns the kb-query agent)', () => {
  it('does NOT time out at the 30s global default, but does at 180s with an isError result', async () => {
    const wrapped = instrumentMcpTool('kb_query', neverSettles);
    const call = startTracked(wrapped());

    await vi.advanceTimersByTimeAsync(GLOBAL_DEFAULT_MS);
    expect(call.isSettled()).toBe(false);

    // A comfortable margin past the default, still under the override.
    await vi.advanceTimersByTimeAsync(100_000);
    expect(call.isSettled()).toBe(false);

    await vi.advanceTimersByTimeAsync(KB_QUERY_OVERRIDE_MS - GLOBAL_DEFAULT_MS - 100_000);
    const result = await call.promise;

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain(`timed out after ${KB_QUERY_OVERRIDE_MS}ms`);

    const metrics = getMcpMetricsSnapshot().tools['kb_query'];
    expect(metrics).toBeDefined();
    expect(metrics!.timeouts).toBeGreaterThanOrEqual(1);
    expect(metrics!.errors).toBeGreaterThanOrEqual(1);
  });

  it('wins over a shorter RUNE_MCP_TOOL_TIMEOUT_MS env value', async () => {
    process.env['RUNE_MCP_TOOL_TIMEOUT_MS'] = '50';

    const wrapped = instrumentMcpTool('kb_query', neverSettles);
    const call = startTracked(wrapped());

    await vi.advanceTimersByTimeAsync(50);
    expect(call.isSettled()).toBe(false);
    await vi.advanceTimersByTimeAsync(GLOBAL_DEFAULT_MS);
    expect(call.isSettled()).toBe(false);

    // Drain the override timer so the test leaves no dangling fake timer.
    await vi.advanceTimersByTimeAsync(KB_QUERY_OVERRIDE_MS);
    const result = await call.promise;
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain(`timed out after ${KB_QUERY_OVERRIDE_MS}ms`);
  });
});

describe('non-overridden tools keep the global/env timeout', () => {
  it('a different tool name times out at the 30s global default', async () => {
    const wrapped = instrumentMcpTool('vault_search', neverSettles);
    const call = startTracked(wrapped());

    await vi.advanceTimersByTimeAsync(GLOBAL_DEFAULT_MS - 1);
    expect(call.isSettled()).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    const result = await call.promise;

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain(`timed out after ${GLOBAL_DEFAULT_MS}ms`);

    const metrics = getMcpMetricsSnapshot().tools['vault_search'];
    expect(metrics).toBeDefined();
    expect(metrics!.timeouts).toBeGreaterThanOrEqual(1);
  });

  it('a different tool name times out at the env value while generate_workout keeps its override', async () => {
    process.env['RUNE_MCP_TOOL_TIMEOUT_MS'] = '50';

    const other = startTracked(instrumentMcpTool('journal_range', neverSettles)());
    const gw = startTracked(instrumentMcpTool('generate_workout', neverSettles)());

    await vi.advanceTimersByTimeAsync(50);
    const otherResult = await other.promise;
    expect(otherResult.isError).toBe(true);
    expect(textOf(otherResult)).toContain('timed out after 50ms');
    expect(gw.isSettled()).toBe(false);

    // Drain the generate_workout override timer (started at t=0).
    await vi.advanceTimersByTimeAsync(GENERATE_WORKOUT_OVERRIDE_MS - 50);
    const gwResult = await gw.promise;
    expect(gwResult.isError).toBe(true);
    expect(textOf(gwResult)).toContain(`timed out after ${GENERATE_WORKOUT_OVERRIDE_MS}ms`);
  });
});
