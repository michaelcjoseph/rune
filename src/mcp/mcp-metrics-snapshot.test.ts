/**
 * Project 19, W1 Phase 3: MCP metrics snapshot tool.
 *
 * TEST-FIRST contract suite for `mcp_metrics_snapshot`.
 *
 * These tests exercise the real MCP server factory through an in-memory MCP
 * client. Dependencies such as KB query and warm-index status are mocked, but
 * the metrics tool/registration itself is not. The suite is expected to be red
 * until the metrics snapshot tool and call instrumentation are implemented.
 */

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

const queryKBMock = vi.hoisted(() => vi.fn());
const ingestSourceMock = vi.hoisted(() => vi.fn());
const searchVaultMock = vi.hoisted(() => vi.fn());
const queryVaultIndexMock = vi.hoisted(() => vi.fn());
const getVaultIndexStatusMock = vi.hoisted(() => vi.fn());

vi.mock('../kb/engine.js', () => ({
  initKB: vi.fn(),
  queryKB: queryKBMock,
  ingestSource: ingestSourceMock,
  lintKB: vi.fn().mockResolvedValue({ report: 'ok', success: true }),
  getKBStats: vi.fn().mockReturnValue({
    totalPages: 0,
    entities: 0,
    concepts: 0,
    topics: 0,
    comparisons: 0,
    recentLog: [],
  }),
}));

vi.mock('../kb/search.js', () => ({
  searchVault: searchVaultMock,
  searchWithFilter: vi.fn().mockReturnValue([]),
  searchRepo: vi.fn().mockReturnValue([]),
}));

vi.mock('../kb/vault-index.js', () => ({
  buildVaultIndex: vi.fn(),
  refreshVaultIndex: vi.fn(),
  getVaultIndexStatus: getVaultIndexStatusMock,
  queryVaultIndex: queryVaultIndexMock,
}));

type RuntimeMcpFactory = (opts: {
  tools: string[];
  name?: string;
  getActiveSessionCount?: () => number;
}) => McpServer;

interface MetricsSnapshot {
  totals: {
    calls: number;
    errors: number;
    timeouts: number;
  };
  tools: Record<string, {
    calls: number;
    errors: number;
    timeouts: number;
    latencyMs: {
      p50: number | null;
      p95: number | null;
      p99: number | null;
      sampleCount: number;
      windowSize: number;
    };
  }>;
  activeSessions: number;
  warmIndex: {
    ready: boolean;
    status: string;
    ageMs: number | null;
    lastRebuild: {
      files: number;
      lines: number;
      bytes: number;
      heapUsed: number;
      buildMs: number;
    } | null;
  };
}

async function loadFactory(): Promise<RuntimeMcpFactory> {
  const mod = (await import('./server.js')) as Record<string, unknown>;
  const factory = mod.createRuneMcpServer;
  if (typeof factory !== 'function') {
    expect.fail('createRuneMcpServer is not exported - implementation pending');
  }
  return factory as RuntimeMcpFactory;
}

function requireServerWithTools(factory: RuntimeMcpFactory, tools: string[], opts: {
  activeSessions?: number;
} = {}): McpServer {
  try {
    return factory({
      tools,
      name: 'rune-mcp',
      getActiveSessionCount: () => opts.activeSessions ?? 0,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    expect.fail(`${tools.join(', ')} must be registered MCP tools - ${message}`);
  }
}

async function connectClient(server: McpServer): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'mcp-metrics-test-client', version: '1.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

function textOf(result: Awaited<ReturnType<Client['callTool']>>): string {
  const content = result.content as Array<{ type: string; text: string }>;
  expect(result.isError).toBeFalsy();
  expect(content).toHaveLength(1);
  expect(content[0]).toMatchObject({ type: 'text' });
  expect(typeof content[0]?.text).toBe('string');
  return content[0]!.text;
}

async function readMetrics(client: Client): Promise<MetricsSnapshot> {
  const result = await client.callTool({
    name: 'mcp_metrics_snapshot',
    arguments: {},
  });
  return JSON.parse(textOf(result)) as MetricsSnapshot;
}

function expectLatencyShape(entry: MetricsSnapshot['tools'][string]): void {
  expect(entry.latencyMs).toEqual({
    p50: expect.any(Number),
    p95: expect.any(Number),
    p99: expect.any(Number),
    sampleCount: expect.any(Number),
    windowSize: expect.any(Number),
  });
  expect(entry.latencyMs.p50).toBeLessThanOrEqual(entry.latencyMs.p95!);
  expect(entry.latencyMs.p95).toBeLessThanOrEqual(entry.latencyMs.p99!);
  expect(entry.latencyMs.sampleCount).toBeLessThanOrEqual(entry.latencyMs.windowSize);
  expect(entry.latencyMs.windowSize).toBeGreaterThan(0);
  expect(entry.latencyMs.windowSize).toBeLessThanOrEqual(1_024);
}

function requireToolMetrics(
  snapshot: MetricsSnapshot,
  toolName: string,
): MetricsSnapshot['tools'][string] {
  const entry = snapshot.tools[toolName];
  if (!entry) {
    expect.fail(`Expected metrics entry for ${toolName}`);
  }
  return entry;
}

function setReadyWarmIndexStatus(): void {
  getVaultIndexStatusMock.mockReturnValue({
    ready: true,
    status: 'ready',
    lastRebuildAt: new Date(Date.now() - 42_000).toISOString(),
    lastRebuild: {
      files: 12,
      lines: 345,
      bytes: 67_890,
      heapUsed: 4_567_890,
      buildMs: 123,
    },
  });
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  process.env['RUNE_MCP_TOOL_TIMEOUT_MS'] = '5';
  queryKBMock.mockResolvedValue({ answer: 'mocked answer', success: true });
  ingestSourceMock.mockResolvedValue({ output: 'ok', success: true });
  searchVaultMock.mockReturnValue([]);
  queryVaultIndexMock.mockReturnValue([]);
  setReadyWarmIndexStatus();
});

afterEach(() => {
  delete process.env['RUNE_MCP_TOOL_TIMEOUT_MS'];
});

describe('mcp_metrics_snapshot MCP tool', () => {
  it('registers as a queryable MCP tool and returns the stable metrics/index/session shape', async () => {
    const factory = await loadFactory();
    const server = requireServerWithTools(factory, ['mcp_metrics_snapshot'], { activeSessions: 3 });
    const client = await connectClient(server);

    try {
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual(['mcp_metrics_snapshot']);

      const snapshot = await readMetrics(client);

      expect(snapshot).toEqual({
        totals: {
          calls: expect.any(Number),
          errors: expect.any(Number),
          timeouts: expect.any(Number),
        },
        tools: expect.any(Object),
        activeSessions: 3,
        warmIndex: {
          ready: true,
          status: 'ready',
          ageMs: expect.any(Number),
          lastRebuild: {
            files: 12,
            lines: 345,
            bytes: 67_890,
            heapUsed: 4_567_890,
            buildMs: 123,
          },
        },
      });
      expect(snapshot.warmIndex.ageMs).toBeGreaterThanOrEqual(0);
      expect(queryKBMock).not.toHaveBeenCalled();
      expect(searchVaultMock).not.toHaveBeenCalled();
      expect(queryVaultIndexMock).not.toHaveBeenCalled();
      expect(getVaultIndexStatusMock).toHaveBeenCalled();
    } finally {
      await client.close();
    }
  });

  it('instruments the metrics snapshot tool itself without touching vault or KB dependencies', async () => {
    const factory = await loadFactory();
    const server = requireServerWithTools(factory, ['mcp_metrics_snapshot']);
    const client = await connectClient(server);

    try {
      await readMetrics(client);
      const secondSnapshot = await readMetrics(client);

      const metricsTool = requireToolMetrics(secondSnapshot, 'mcp_metrics_snapshot');
      expect(metricsTool).toMatchObject({
        calls: expect.any(Number),
        errors: 0,
        timeouts: 0,
      });
      expect(metricsTool.calls).toBeGreaterThanOrEqual(1);
      expectLatencyShape(metricsTool);
      expect(secondSnapshot.totals.calls).toBeGreaterThanOrEqual(metricsTool.calls);
      expect(queryKBMock).not.toHaveBeenCalled();
      expect(searchVaultMock).not.toHaveBeenCalled();
      expect(queryVaultIndexMock).not.toHaveBeenCalled();
    } finally {
      await client.close();
    }
  });

  it('reports calls, tool-error results, and latency percentiles by tool', async () => {
    const factory = await loadFactory();
    const server = requireServerWithTools(factory, ['kb_query', 'mcp_metrics_snapshot']);
    const client = await connectClient(server);

    try {
      await client.callTool({
        name: 'kb_query',
        arguments: { question: 'successful call' },
      });
      queryKBMock.mockResolvedValueOnce({ answer: 'KB failed', success: false });
      const failed = await client.callTool({
        name: 'kb_query',
        arguments: { question: 'tool-error call' },
      });
      expect(failed.isError).toBe(true);

      const snapshot = await readMetrics(client);

      expect(snapshot.totals.calls).toBeGreaterThanOrEqual(2);
      expect(snapshot.totals.errors).toBeGreaterThanOrEqual(1);
      expect(snapshot.totals.timeouts).toBeGreaterThanOrEqual(0);
      const kbQueryMetrics = requireToolMetrics(snapshot, 'kb_query');
      expect(kbQueryMetrics).toMatchObject({
        calls: 2,
        errors: 1,
        timeouts: 0,
      });
      expectLatencyShape(kbQueryMetrics);
    } finally {
      await client.close();
    }
  });

  it('counts a thrown tool handler failure as an error for that tool', async () => {
    const factory = await loadFactory();
    const server = requireServerWithTools(factory, ['kb_query', 'mcp_metrics_snapshot']);
    const client = await connectClient(server);

    try {
      queryKBMock.mockRejectedValueOnce(new Error('upstream KB failed'));

      try {
        const result = await client.callTool({
          name: 'kb_query',
          arguments: { question: 'throwing call' },
        });
        expect(result.isError).toBe(true);
      } catch (err) {
        expect(err).toBeInstanceOf(Error);
      }

      const snapshot = await readMetrics(client);
      const kbQueryMetrics = requireToolMetrics(snapshot, 'kb_query');
      expect(kbQueryMetrics).toMatchObject({
        calls: 1,
        errors: 1,
        timeouts: 0,
      });
      expectLatencyShape(kbQueryMetrics);
    } finally {
      await client.close();
    }
  });

  it('counts a call exceeding RUNE_MCP_TOOL_TIMEOUT_MS as both an error and a timeout', async () => {
    const factory = await loadFactory();
    const server = requireServerWithTools(factory, ['kb_ingest', 'mcp_metrics_snapshot']);
    const client = await connectClient(server);

    try {
      ingestSourceMock.mockImplementationOnce(
        () => new Promise((resolve) => {
          setTimeout(() => resolve({ output: 'late ingest', success: true }), 20);
        }),
      );

      const timedOut = await client.callTool({
        name: 'kb_ingest',
        arguments: { sourcePath: 'library/slow-source.md' },
      });

      expect(timedOut.isError).toBe(true);
      const snapshot = await readMetrics(client);
      const kbIngestMetrics = requireToolMetrics(snapshot, 'kb_ingest');
      expect(kbIngestMetrics).toMatchObject({
        calls: 1,
        errors: 1,
        timeouts: 1,
      });
      expectLatencyShape(kbIngestMetrics);
    } finally {
      await client.close();
    }
  });

  it('kb_query outlives a shorter RUNE_MCP_TOOL_TIMEOUT_MS via its TOOL_TIMEOUT_OVERRIDES_MS entry', async () => {
    const factory = await loadFactory();
    const server = requireServerWithTools(factory, ['kb_query', 'mcp_metrics_snapshot']);
    const client = await connectClient(server);

    try {
      queryKBMock.mockImplementationOnce(
        () => new Promise((resolve) => {
          setTimeout(() => resolve({ answer: 'slow but real answer', success: true }), 20);
        }),
      );

      const result = await client.callTool({
        name: 'kb_query',
        arguments: { question: 'slow call' },
      });

      expect(result.isError).toBeFalsy();
      const snapshot = await readMetrics(client);
      const kbQueryMetrics = requireToolMetrics(snapshot, 'kb_query');
      expect(kbQueryMetrics).toMatchObject({
        calls: 1,
        errors: 0,
        timeouts: 0,
      });
      expectLatencyShape(kbQueryMetrics);
    } finally {
      await client.close();
    }
  });

  it('keeps per-tool latency samples bounded while call counters continue increasing', async () => {
    const factory = await loadFactory();
    const server = requireServerWithTools(factory, ['kb_query', 'mcp_metrics_snapshot']);
    const client = await connectClient(server);

    try {
      for (let i = 0; i < 1_050; i += 1) {
        await client.callTool({
          name: 'kb_query',
          arguments: { question: `bounded latency sample ${i}` },
        });
      }

      const snapshot = await readMetrics(client);
      const kbQueryMetrics = requireToolMetrics(snapshot, 'kb_query');
      expect(kbQueryMetrics.calls).toBe(1_050);
      expect(kbQueryMetrics.latencyMs.windowSize).toBeLessThan(kbQueryMetrics.calls);
      expect(kbQueryMetrics.latencyMs.sampleCount).toBeLessThanOrEqual(
        kbQueryMetrics.latencyMs.windowSize,
      );
      expectLatencyShape(kbQueryMetrics);
    } finally {
      await client.close();
    }
  });

  it('does not retain counters across a fresh process/module graph', async () => {
    let factory = await loadFactory();
    let server = requireServerWithTools(factory, ['kb_query', 'mcp_metrics_snapshot']);
    let client = await connectClient(server);

    try {
      await client.callTool({
        name: 'kb_query',
        arguments: { question: 'call before restart' },
      });
      const beforeRestart = await readMetrics(client);
      expect(beforeRestart.tools.kb_query?.calls).toBe(1);
    } finally {
      await client.close();
    }

    vi.resetModules();
    setReadyWarmIndexStatus();
    factory = await loadFactory();
    server = requireServerWithTools(factory, ['mcp_metrics_snapshot']);
    client = await connectClient(server);

    try {
      const afterRestart = await readMetrics(client);
      expect(afterRestart.tools.kb_query?.calls ?? 0).toBe(0);
      expect(afterRestart.totals.errors).toBe(0);
      expect(afterRestart.totals.timeouts).toBe(0);
      expect(afterRestart.totals.calls).toBeLessThanOrEqual(1);
    } finally {
      await client.close();
    }
  });
});
